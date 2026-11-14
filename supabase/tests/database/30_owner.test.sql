-- M8a: the Owner record, its protections, recovery infrastructure and the audit
-- foundation. Admin API paths and races are in db-owner-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(96);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated;

-- Runs a statement as a signed-in user, returning its result or the error as text.
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
-- Runs a statement as postgres, returning the error as text, or 'ok'.
create function pg_temp.try(p_sql text) returns text language plpgsql as $t$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.factor(p_user text, p_name text, p_age interval, p_status auth.factor_status default 'verified') returns void language sql as $$
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values (gen_random_uuid(), pg_temp.u(p_user), p_name, 'totp', p_status, now() - p_age, now())
$$;
create function pg_temp.owner() returns uuid language sql as $$ select user_id from private.platform_owner $$;
create function pg_temp.findings() returns text language sql as $$ select coalesce(string_agg(finding, '; ' order by finding), '') from private.owner_integrity() $$;
-- Audit rows are identified exactly: by the id a function returns, or by action and
-- reason, never by being the newest (UUIDv7 ids in one millisecond don't sort).
create function pg_temp.audit_of(p_id uuid) returns text language sql as $$
  select action::text || '/' || outcome from private.audit_events where id = p_id
$$;
create function pg_temp.audit_by(p_action text, p_reason text) returns text language sql as $$
  select string_agg(action::text || '/' || outcome, ', ') from private.audit_events where action::text = p_action and reason = p_reason
$$;
create function pg_temp.audit_meta(p_action text, p_reason text) returns jsonb language sql as $$
  select metadata from private.audit_events where action::text = p_action and reason = p_reason
$$;

-- f1: the future Owner. a2: another admin. b3: successor. c4: collector.
-- d5: no handle. e6: unverified email. d7: will be soft-deleted. b8: banned.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', case when s = 'e6' then null else now() end, '00000000-0000-0000-0000-000000000000'
from unnest(array['f1', 'a2', 'b3', 'c4', 'd5', 'e6', 'd7', 'b8']) as s;
update public.profiles set handle = 'owner_t_' || right(id::text, 2), handle_changed_at = now() where id <> pg_temp.u('d5');
insert into public.staff_roles (user_id, role) values (pg_temp.u('a2'), 'admin');
update auth.users set deleted_at = now() where id = pg_temp.u('d7');
update auth.users set banned_until = now() + interval '1 day' where id = pg_temp.u('b8');

-- 1. Schema and access
select has_table('private', 'platform_owner', 'the Owner record exists');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('private.platform_owner'::regclass, 'private.ownership_transfers'::regclass, 'private.owner_recoveries'::regclass)), 'RLS is on for the Owner, transfer and recovery records');
select ok(not exists (
  select 1 from unnest(array['private.platform_owner', 'private.ownership_transfers', 'private.owner_recoveries']) t, unnest(array['anon', 'authenticated', 'service_role']) r
  where has_table_privilege(r, t, 'select,insert,update,delete,truncate')), 'no client role can touch them');
select is(pg_temp.as_user('a2', 'select count(*)::text from private.platform_owner'), 'error: permission denied for schema private', 'an admin can''t read the Owner record');
-- Before anything in this transaction takes the staff lock (section 4 does).
select ok(not private.holds_staff_lock(), 'the staff lock isn''t held yet');
select is(pg_temp.try($$select private.record_refusal('$$ || pg_temp.u('a2') || $$', 'owner_protection_refused', '$$ || pg_temp.u('f1') || $$', 'owner_protected')$$), 'error: refusal recorded without the staff lock', 'a refusal needs the staff lock (D9)');
select private.lock_staff_changes();
select ok(private.holds_staff_lock(), 'holds_staff_lock sees it once taken');

-- 2. Audit outcome (D9)
select is(pg_temp.audit_of(private.record_audit(null, 'operator_action', null, 'Outcome check')), 'operator_action/operator', 'an operator action has outcome operator');
select is(pg_temp.audit_of(private.record_audit(null, 'catalog_import_run', null, 'Outcome check')), 'catalog_import_run/succeeded', 'an import, also with no actor, has outcome succeeded');
select is(pg_temp.audit_of(private.record_audit(pg_temp.u('a2'), 'owner_recovery_cancelled', null, 'Outcome check')), 'owner_recovery_cancelled/succeeded', 'a cancellation by someone in the app has outcome succeeded');
select is(pg_temp.audit_of(private.record_audit(null, 'owner_recovery_cancelled', null, 'Outcome check')), 'owner_recovery_cancelled/operator', 'a cancellation by an operator has outcome operator');
select is(pg_temp.audit_of(private.record_audit(pg_temp.u('a2'), 'staff_change_refused', null, 'Outcome check')), 'staff_change_refused/refused', 'a refusal has outcome refused');
select is(pg_temp.try($$update private.audit_events set reason = 'x' where true$$), 'error: audit events are append-only', 'the log stays append-only');

-- 3. Standing and factors
select is(private.account_standing(pg_temp.u('f1')), null, 'a verified, active account with a handle is in good standing');
select is(private.account_standing(pg_temp.u('d5')), 'no_handle', 'an account without a handle isn''t');
select is(private.account_standing(pg_temp.u('e6')), 'unverified', 'nor one with an unverified email');
select is(private.account_standing(pg_temp.u('d7')), 'deleted', 'nor a soft-deleted one');
select is(private.account_standing(pg_temp.u('b8')), 'banned', 'nor a banned one');
select is(private.account_standing('00000000-0000-0000-0000-000000000099'), 'missing', 'nor an unknown id');
select pg_temp.factor('f1', 'one', interval '2 days');
select pg_temp.factor('f1', 'pending', interval '2 days', 'unverified');
select is(private.totp_factor_count(pg_temp.u('f1')), 1, 'only verified factors count');
select pg_temp.factor('f1', 'two', interval '1 hour');
select is(private.totp_factor_count(pg_temp.u('f1')), 2, 'two verified factors');
select is(private.totp_factor_count(pg_temp.u('f1'), interval '24 hours'), 1, 'one of them at least 24 hours old (D13)');

-- 4. Assignment (D2)
select is(pg_temp.findings(), 'no owner assigned', 'before assignment, the report says so');
select is(pg_temp.try($$select private.assign_initial_owner('owner_t_a2', 'Approved for the test')$$), 'error: two verified TOTP factors required', 'an account with no factors can''t be assigned');
select is(pg_temp.try($$select private.assign_initial_owner('owner_t_e6', 'Approved for the test')$$), 'error: account not eligible: unverified', 'nor one not in good standing');
select is(pg_temp.try($$select private.assign_initial_owner('nobody_here', 'Approved for the test')$$), 'error: user unavailable', 'nor an unknown handle');
select is(private.assign_initial_owner('OWNER_T_F1', 'Approved for the test'), pg_temp.u('f1'), 'an eligible account with two factors is assigned, by handle in any case');
select is(pg_temp.audit_by('owner_assigned', 'Approved for the test'), 'owner_assigned/operator', 'with an operator audit row');
select ok(exists (select 1 from public.staff_roles where user_id = pg_temp.u('f1') and role = 'admin'), 'and the admin role');
select is((select metadata ->> 'admin_granted' from private.audit_events where action = 'owner_assigned'), 'true', 'which the audit row records');
select is(pg_temp.try($$select private.assign_initial_owner('owner_t_a2', 'Approved for the test')$$), 'error: an owner is already assigned', 'a second assignment is refused');
select ok(private.is_designated_owner(pg_temp.u('f1')) and not private.is_designated_owner(pg_temp.u('a2')) and not private.is_designated_owner(null), 'is_designated_owner names the Owner only');
select is(pg_temp.findings(), 'owner security changed in the last 24 hours', 'a factor under 24 hours old is reported');

-- 5. The record is permanent and singular
select is(pg_temp.try($$insert into private.platform_owner (id, user_id) values (true, '$$ || pg_temp.u('a2') || $$')$$), 'error: duplicate key value violates unique constraint "platform_owner_pkey"', 'a second Owner row is impossible');
select is(pg_temp.try($$insert into private.platform_owner (id, user_id) values (false, '$$ || pg_temp.u('a2') || $$')$$), 'error: new row for relation "platform_owner" violates check constraint "platform_owner_id_check"', 'with any key');
select is(pg_temp.try($$delete from private.platform_owner$$), 'error: the owner record is permanent', 'the record can''t be deleted');
select is(pg_temp.try($$truncate private.platform_owner$$), 'error: the owner record is permanent', 'or truncated');
select is(pg_temp.try($$update private.platform_owner set user_id = '$$ || pg_temp.u('a2') || $$'$$), 'error: ownership changes only by transfer or recovery', 'or given to someone else directly');
select is(pg_temp.try($$update private.platform_owner set version = 7$$), 'error: the owner record is permanent', 'and its version moves only with its holder');

-- 6. Protections (D12)
select is(pg_temp.try($$delete from public.profiles where id = '$$ || pg_temp.u('f1') || $$'$$), 'error: account protected', 'the Owner''s profile can''t be deleted');
select is(pg_temp.try($$delete from auth.users where id = '$$ || pg_temp.u('f1') || $$'$$), 'error: account protected', 'nor their Auth user, through the cascade');
select is(pg_temp.try($$alter table public.profiles disable trigger protect_owner_profile; delete from auth.users where id = '$$ || pg_temp.u('f1') || $$'$$),
  'error: account protected', 'with the profile trigger disabled, the cascade to the Owner''s admin role still refuses');
-- Each layer alone: without the admin-role trigger, only the profile trigger can
-- refuse before the foreign key, which would say so differently.
select is(pg_temp.try($$alter table public.staff_roles disable trigger protect_owner_admin_role; delete from public.profiles where id = '$$ || pg_temp.u('f1') || $$'$$),
  'error: account protected', 'with the admin-role trigger disabled, the profile trigger alone refuses');
select is(pg_temp.try($$alter table public.profiles disable trigger protect_owner_profile; alter table public.staff_roles disable trigger protect_owner_admin_role; delete from auth.users where id = '$$ || pg_temp.u('f1') || $$'$$),
  'error: update or delete on table "profiles" violates foreign key constraint "platform_owner_user_id_fkey" on table "platform_owner"', 'with both triggers disabled, the key still refuses');
select is(pg_temp.try($$truncate public.profiles cascade$$), 'error: account protected', 'profiles can''t be truncated');
select is(pg_temp.try($$update public.profiles set account_status = 'suspended' where id = '$$ || pg_temp.u('f1') || $$'$$), 'error: account protected', 'the Owner''s status can''t be changed directly');
select is(pg_temp.as_user('a2', $$select public.set_account_status('$$ || pg_temp.u('f1') || $$', 'suspended', 'Test')::text$$), 'error: account protected', 'nor by another admin');
select is(pg_temp.as_user('a2', $$select public.revoke_staff_role('$$ || pg_temp.u('f1') || $$', 'admin', 'Test')::text$$), 'error: account protected', 'another admin can''t remove the Owner''s admin role');
select is(pg_temp.try($$delete from public.staff_roles where user_id = '$$ || pg_temp.u('f1') || $$' and role = 'admin'$$), 'error: account protected', 'nor can SQL');
select is(pg_temp.try($$update public.staff_roles set role = 'moderator' where user_id = '$$ || pg_temp.u('f1') || $$' and role = 'admin'$$), 'error: account protected', 'or change it');
select is(pg_temp.try($$truncate public.staff_roles$$), 'error: account protected', 'staff roles can''t be truncated');
select is((select account_status::text from public.profiles where id = pg_temp.u('f1')), 'active', 'the Owner is still active, an admin and present')
  from (select 1) x where exists (select 1 from public.staff_roles where user_id = pg_temp.u('f1') and role = 'admin');
select ok(public.account_deletion_blocked(pg_temp.u('f1')) and not public.account_deletion_blocked(pg_temp.u('c4')), 'the deletion pre-check blocks the Owner only');
select is(pg_temp.as_user('c4', $$select public.account_deletion_blocked('$$ || pg_temp.u('f1') || $$')::text$$), 'error: permission denied for function account_deletion_blocked', 'clients can''t call it');

-- 7. Refusals (D9). This transaction holds the staff lock since section 4; the
-- check without it is in section 1.
select is(pg_temp.audit_of(private.record_refusal(pg_temp.u('a2'), 'owner_protection_refused', pg_temp.u('f1'), 'owner_protected', '{"op": "suspend"}')), 'owner_protection_refused/refused', 'with it, a refusal is recorded as a refused attempt');
select is((select metadata ->> 'code' || '/' || (metadata ->> 'op') from private.audit_events where action = 'owner_protection_refused' and reason = 'Refused: owner_protected'), 'owner_protected/suspend', 'with its code and details, once');
select is(private.record_refusal(pg_temp.u('a2'), 'owner_protection_refused', pg_temp.u('f1'), 'owner_protected'), null, 'the same refusal within 10 minutes isn''t recorded again');
select isnt(private.record_refusal(pg_temp.u('a2'), 'owner_protection_refused', pg_temp.u('f1'), 'owner_only'), null, 'a different code is');
select isnt(private.record_refusal(pg_temp.u('c4'), 'owner_protection_refused', pg_temp.u('f1'), 'owner_protected'), null, 'and so is another actor');
select is(pg_temp.try($$select private.record_refusal(null, 'staff_role_granted', null, 'x')$$), 'error: invalid refusal', 'only refusal actions are accepted');

-- 8. Recovery: factor reset (D6)
insert into private.ownership_transfers (from_user, to_user, expires_at) values (pg_temp.u('f1'), pg_temp.u('a2'), now() + interval '72 hours');
select is(pg_temp.try($$select private.begin_owner_recovery('factor_reset', null, 'Case 1', null, true)$$), 'error: a disputed recovery follows one the owner cancelled', 'a disputed recovery needs one the Owner cancelled');
select isnt(private.begin_owner_recovery('factor_reset', null, 'Case 1'), null, 'a factor reset opens');
select is((select status || '/' || cancel_cause from private.ownership_transfers), 'cancelled/recovery_started', 'cancelling the pending transfer');
select is(pg_temp.audit_by('owner_recovery_started', 'Case 1'), 'owner_recovery_started/operator', 'with an operator audit row');
select ok((select hold_until between now() + interval '71 hours 59 minutes' and now() + interval '72 hours 1 minute' from private.owner_recoveries), 'held for 72 hours (D17)');
select is(pg_temp.try($$select private.begin_owner_recovery('reassign', 'owner_t_b3', 'Case 2')$$), 'error: recovery pending', 'only one recovery at a time');
select is(pg_temp.try($$select private.complete_owner_recovery((select id from private.owner_recoveries), 'Case 1')$$), 'error: recovery hold not over', 'it can''t complete during the hold');
select is(pg_temp.findings(), 'owner security changed in the last 24 hours; recovery pending', 'the report shows it');
update private.owner_recoveries set hold_until = now() - interval '1 second', created_at = now() - interval '73 hours';
select is((private.complete_owner_recovery((select id from private.owner_recoveries), 'Case 1')) ->> 'owner_id', pg_temp.u('f1')::text, 'after the hold it completes, keeping the Owner');
select is(pg_temp.owner(), pg_temp.u('f1'), 'who is still the Owner');

-- 9. Recovery: reassign, with the succession document (D6a) and D6c
update private.platform_owner set succession_fingerprint = repeat('a', 64), succession_registered_at = now(), successor_id = pg_temp.u('b3');
select is(pg_temp.try($$select private.begin_owner_recovery('reassign', 'owner_t_b3', 'Case 3', repeat('b', 64))$$), 'error: succession document does not match', 'a different document is refused');
select is(pg_temp.try($$select private.begin_owner_recovery('reassign', 'owner_t_b3', 'Case 3')$$), 'error: succession document does not match', 'and so is none, when one is registered');
select is(pg_temp.try($$select private.begin_owner_recovery('reassign', 'owner_t_d7', 'Case 3', repeat('a', 64))$$), 'error: user unavailable', 'the target must be in good standing');
select is(pg_temp.try($$select private.begin_owner_recovery('reassign', 'owner_t_f1', 'Case 3', repeat('a', 64))$$), 'error: user unavailable', 'and not the Owner');
select isnt(private.begin_owner_recovery('reassign', 'owner_t_b3', 'Case 3', repeat('a', 64)), null, 'the matching document opens it');
select is((select m ->> 'fingerprint' || '/' || (m ->> 'designated_successor') from pg_temp.audit_meta('owner_recovery_started', 'Case 3') m), 'matched/true', 'recording the match and that the target is the designated successor');
update private.owner_recoveries set hold_until = now() - interval '1 second', created_at = now() - interval '73 hours' where status = 'pending';
select is(pg_temp.try($$select private.complete_owner_recovery((select id from private.owner_recoveries where status = 'pending'), 'Case 3')$$), 'error: target has not confirmed', 'it needs the target''s confirmation');
update private.owner_recoveries set confirmed_at = now() where status = 'pending';
select is(pg_temp.try($$select private.complete_owner_recovery((select id from private.owner_recoveries where status = 'pending'), 'Case 3')$$), 'error: two verified TOTP factors required', 'and two factors on the target');
select pg_temp.factor('b3', 'one', interval '2 days');
select pg_temp.factor('b3', 'two', interval '2 days');
select is(pg_temp.try($$select set_config('mygamedex.owner_change', 'on', true); update private.platform_owner set user_id = '$$ || pg_temp.u('a2') || $$';
  select private.complete_owner_recovery((select id from private.owner_recoveries where status = 'pending'), 'Case 3')$$),
  'error: owner changed since the recovery began', 'it refuses to complete if the Owner changed after it began');
select is((private.complete_owner_recovery((select id from private.owner_recoveries where status = 'pending'), 'Case 3')) ->> 'previous_owner_admin_revoked', 'true', 'then it completes, revoking the previous Owner''s admin role (D6c)');
select is(pg_temp.owner(), pg_temp.u('b3'), 'the target is the Owner');
select ok(exists (select 1 from public.staff_roles where user_id = pg_temp.u('b3') and role = 'admin')
  and not exists (select 1 from public.staff_roles where user_id = pg_temp.u('f1') and role = 'admin'), 'holding the admin role, which the previous Owner no longer has');
select is((select version || '/' || coalesce(successor_id::text, 'none') || '/' || coalesce(succession_fingerprint, 'none') from private.platform_owner), '2/none/none', 'the record''s version moved, and the old succession is cleared');
select is(pg_temp.try($$delete from public.profiles where id = '$$ || pg_temp.u('b3') || $$'$$), 'error: account protected', 'the new Owner is protected');
select is(pg_temp.try($$update public.profiles set account_status = 'suspended' where id = '$$ || pg_temp.u('f1') || $$'$$), 'ok', 'the previous Owner no longer is');

-- 10. Owner cancellation, then a disputed recovery (D6b), and an operator cancelling it
select private.begin_owner_recovery('factor_reset', null, 'Case 4');
update private.owner_recoveries set status = 'cancelled', decided_at = now(), cancelled_by_owner = true, cancel_cause = 'owner' where status = 'pending';
select isnt(private.begin_owner_recovery('factor_reset', null, 'Case 5', null, true), null, 'after the Owner cancels one, a disputed recovery can open');
select is((select disputed from private.owner_recoveries where status = 'pending'), true, 'marked disputed');
select private.cancel_owner_recovery_by_operator((select id from private.owner_recoveries where status = 'pending'), 'Resolved with the owner');
select is(pg_temp.audit_by('owner_recovery_cancelled', 'Resolved with the owner'), 'owner_recovery_cancelled/operator', 'an operator can cancel it, with an operator audit row');

-- 11. Operator status change, and protection while suspended
select is(private.operator_set_owner_status('suspended', 'Case 6'), true, 'an operator can suspend the Owner');
select is(pg_temp.audit_by('owner_status_set_by_operator', 'Case 6'), 'owner_status_set_by_operator/operator', 'with an operator audit row');
select is(pg_temp.try($$delete from public.profiles where id = '$$ || pg_temp.u('b3') || $$'$$), 'error: account protected', 'a suspended Owner is still protected');
select is(pg_temp.findings(), 'owner account: inactive', 'and the report says the account is inactive');
select is(private.operator_set_owner_status('active', 'Case 6'), true, 'an operator reinstates them');

-- 12. A deleted account closes what is pending for it
select private.begin_owner_recovery('reassign', 'owner_t_c4', 'Case 7');
delete from auth.users where id = pg_temp.u('c4');
select is((select status || '/' || cancel_cause from private.owner_recoveries order by created_at desc, id desc limit 1), 'cancelled/account_deleted', 'deleting a recovery''s target cancels it');

-- 13. The report, for a damaged Owner account
update auth.users set deleted_at = now() where id = pg_temp.u('b3');
select is(pg_temp.findings(), 'owner account: deleted', 'a soft-deleted Owner is reported');
select ok(private.is_designated_owner(pg_temp.u('b3')), 'and is still the designated Owner, so still protected');

select * from finish();
rollback;
