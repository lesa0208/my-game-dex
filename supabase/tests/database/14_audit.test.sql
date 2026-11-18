-- M4a: the audit log, audited staff functions, suspension and admin audit access.
-- M8c: the same functions under the staff authority matrix and the JSONB contract
-- (A4): refusals return {"ok": false, ...} with a committed audit row. Races are in
-- db-audit-checks.mjs; transfers and recovery in 33_ownership.
begin;
create extension if not exists pgtap with schema extensions;
select plan(121);

-- M8b: staff privileges need a live aal2 session with a verified TOTP factor. These
-- rows have the shape GoTrue writes (31_auth_contract pins it down) and roll back with
-- the test; the check scripts and HTTP suites use real sessions from local GoTrue.
create function pg_temp.claims(p_user uuid) returns jsonb language plpgsql as $mfa$
begin
  if exists (select 1 from auth.users where id = p_user) then
    insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      select p_user, p_user, 'test session factor', 'totp', 'verified', now(), now()
      where not exists (select 1 from auth.mfa_factors where id = p_user);
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
      values (gen_random_uuid(), p_user, 'totp', now(), now()) on conflict do nothing;
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user);
end $mfa$;

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated;
-- A staff function's result, as text: changed, unchanged or 'refused: <code>' (A4).
create function pg_temp.res(r jsonb) returns text language sql immutable as $$
  select case when (r ->> 'ok')::boolean then r ->> 'result' else 'refused: ' || (r ->> 'refusal') end
$$;
grant execute on function pg_temp.res(jsonb) to authenticated;

-- Runs a statement as a signed-in user and returns its result, or the error as text,
-- so an unexpected error fails the named assertion instead of aborting the file.
-- A failure rolls the role back with it.
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.claims(pg_temp.u(p_actor))::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  return 'error: ' || sqlerrm;
end $t$;

create function pg_temp.audits() returns int language sql as $$ select count(*)::int from private.audit_events $$;
create function pg_temp.status(s text) returns text language sql as $$ select account_status::text from public.profiles where id = pg_temp.u(s) $$;
-- Everything a staff function could change, so a refusal can be shown to change none of it.
create function pg_temp.state() returns text language sql as $$
  select md5(coalesce((select string_agg(user_id || role::text, ',' order by user_id, role) from public.staff_roles), '')
    || coalesce((select string_agg(id || account_status::text, ',' order by id) from public.profiles), '')
    || coalesce((select string_agg(row(o.*)::text, ',') from private.platform_owner o), '')
    || coalesce((select string_agg(row(t.*)::text, ',' order by t.id) from private.ownership_transfers t), '')
    || coalesce((select string_agg(row(r.*)::text, ',' order by r.id) from private.owner_recoveries r), ''))
$$;
create function pg_temp.refusal(p_actor text, p_code text) returns text language sql as $$
  select string_agg(action::text || '/' || outcome || '/' || reason, ', ') from private.audit_events
  where actor_id = pg_temp.u(p_actor) and metadata ->> 'code' = p_code
$$;
-- Owner authority needs two verified TOTP factors, registered at least 24 hours ago
-- (D13). Only postgres can backdate a registration; the function always uses now().
create function pg_temp.mature(s text) returns void language plpgsql as $$
begin
  perform pg_temp.claims(pg_temp.u(s));
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values (gen_random_uuid(), pg_temp.u(s), 'second factor ' || gen_random_uuid(), 'totp', 'verified', now(), now());
  delete from private.mfa_factor_registrations where user_id = pg_temp.u(s);
  insert into private.mfa_factor_registrations (factor_id, user_id, factor_created_at, registered_at)
  select f.id, f.user_id, f.created_at, now() - interval '25 hours' from auth.mfa_factors f where f.user_id = pg_temp.u(s);
end $$;

-- a1: the Owner. a2, a9: future admins. d3: moderator. c4, c5: ordinary users.
-- e6: catalog editor. b7: no handle. f8: unverified email.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', case when s = 'f8' then null else now() end, '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'a2', 'a9', 'd3', 'c4', 'c5', 'e6', 'b7', 'f8']) as s;
update public.profiles set handle = 'user_' || right(id::text, 2), handle_changed_at = now() where id <> pg_temp.u('b7');

-- Schema and access
select has_table('private', 'audit_events', 'audit_events exists in private');
select is((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'audit_action'),
  'staff_role_granted,staff_role_revoked,account_suspended,account_reinstated,operator_action,catalog_record_created,catalog_record_updated,catalog_record_verified,catalog_record_published,catalog_field_locked,catalog_field_unlocked,catalog_import_run,catalog_provider_cleared,catalog_record_withdrawn,catalog_review_queued,catalog_review_resolved,catalog_alias_added,catalog_alias_removed,catalog_submission_created,catalog_submission_updated,catalog_submission_withdrawn,catalog_submission_review_started,catalog_submission_approved,catalog_submission_changes_requested,catalog_submission_rejected,catalog_submission_resubmitted,catalog_release_excluded,catalog_exclusion_restored,catalog_release_merged,owner_assigned,owner_recovery_started,owner_recovery_completed,owner_status_set_by_operator,owner_recovery_confirmed,owner_recovery_cancelled,ownership_transfer_started,ownership_transfer_accepted,ownership_transfer_cancelled,owner_successor_set,owner_succession_registered,owner_protection_refused,staff_change_refused,account_invited,account_invitation_delivery,account_invitation_resent,account_invitation_revoke_requested,account_invitation_revoked', 'the M4, M5a, M5b, M5c, M7a, M7b-1, M7b-2b, M8a and M11a-1 audit actions exist');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
  where has_table_privilege(r, 'private.audit_events', p)), 0, 'no API role has any privilege on audit_events');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array[
    'private.record_audit(uuid,private.audit_action,uuid,text,jsonb)', 'private.record_operator_action(uuid,text,jsonb)', 'private.lock_staff_changes()',
    'private.require_active_staff(public.staff_role)', 'private.require_reason(text)', 'private.other_active_admins(uuid)', 'private.audit_events_append_only()',
    'private.staff_result(uuid,jsonb)', 'private.staff_refusal(uuid,uuid,text,jsonb)', 'private.role_change_refusal(uuid,uuid,public.staff_role)',
    'private.owner_candidate_ok(uuid)', 'private.close_owner_designations(uuid,uuid,text,text)']) f
  where has_function_privilege(r, f, 'execute')), 0, 'no API role can execute an audit or authority helper');
select is((select count(*)::int from unnest(array['anon', 'service_role']) r, unnest(array[
    'public.grant_staff_role(uuid,public.staff_role,text)', 'public.revoke_staff_role(uuid,public.staff_role,text)',
    'public.set_account_status(uuid,public.account_status,text)', 'public.get_audit_log(integer,uuid,text,text,text,text,text,timestamptz,timestamptz)']) f
  where has_function_privilege(r, f, 'execute')), 0, 'anon and service_role can execute no staff function');
select is((select count(*)::int from unnest(array[
    'public.grant_staff_role(uuid,public.staff_role,text)', 'public.revoke_staff_role(uuid,public.staff_role,text)',
    'public.set_account_status(uuid,public.account_status,text)', 'public.get_audit_log(integer,uuid,text,text,text,text,text,timestamptz,timestamptz)']) f
  where has_function_privilege('authenticated', f, 'execute')), 4, 'signed-in users can call the staff functions, which check the role');
select is(pg_temp.as_user('c4', 'select count(*)::text from private.audit_events'), 'error: permission denied for schema private', 'a signed-in user can''t reach the table');
set local role service_role;
select throws_ok('select * from private.audit_events', '42501', 'permission denied for schema private', 'service_role can''t reach the table');
reset role;

-- M8c (A2): the replaced functions return the JSONB contract, keep their definer
-- safety and privileges, and no boolean version remains under any schema.
select is((select string_agg(p.proname || ':' || pg_get_function_result(p.oid), ',' order by p.proname) from pg_proc p where p.proname in ('grant_staff_role', 'revoke_staff_role', 'set_account_status')),
  'grant_staff_role:jsonb,revoke_staff_role:jsonb,set_account_status:jsonb', 'each staff function exists once, returning jsonb');
select is((select count(*)::int from pg_proc p where p.proname in ('get_audit_events', 'get_staff_members')), 0,
  'get_audit_events and get_staff_members (M8d) are retired under every schema (M10 integration review)');
select is((select count(*)::int from pg_proc p where p.proname in ('grant_staff_role', 'revoke_staff_role', 'set_account_status', 'get_audit_log')
  and p.prosecdef and p.proconfig = array['search_path=""'] and p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres}' and pg_get_userbyid(p.proowner) = 'postgres'),
  4, 'all four are SECURITY DEFINER with an empty search_path, owned by postgres, executable by authenticated only');
select is((select count(*)::int from pg_proc p where p.proname in ('grant_staff_role', 'revoke_staff_role', 'set_account_status') and pg_get_function_result(p.oid) = 'boolean'),
  0, 'no boolean-returning staff function is left');

-- The documented operator procedure records the first administrator, a1, who is also
-- made the Owner here directly (the operator's assign_initial_owner is tested in 30_owner).
select ok(private.record_operator_action(pg_temp.u('a1'), 'First administrator, approved by the product owner', '{"role": "admin"}') is not null, 'the operator records the assignment');
insert into public.staff_roles (user_id, role) values (pg_temp.u('a1'), 'admin');
insert into private.platform_owner (user_id) values (pg_temp.u('a1'));
select pg_temp.mature('a1');
select is((select actor_id from private.audit_events where action = 'operator_action'), null, 'an operator action has no actor');
select is((select target_profile_id from private.audit_events where action = 'operator_action'), pg_temp.u('a1'), 'and names its target');

-- Append-only, for every role that doesn't disable the trigger
select throws_ok('update private.audit_events set reason = ''changed''', 'P0001', 'audit events are append-only', 'even the owner can''t update a row');
select throws_ok('delete from private.audit_events', 'P0001', 'audit events are append-only', 'or delete one');
select throws_ok('truncate private.audit_events', 'P0001', 'audit events are append-only', 'or truncate the table');
select is((select string_agg(tgname || '=' || tgenabled::text, ',' order by tgname) from pg_trigger where tgrelid = 'private.audit_events'::regclass and not tgisinternal),
  'audit_events_no_truncate=O,audit_events_no_update_or_delete=O', 'both append-only triggers are enabled');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and (p.prosrc ~* 'update\s+private\.audit_events' or p.prosrc ~* 'delete\s+from\s+private\.audit_events' or p.prosrc ~* 'truncate[^;]*audit_events')),
  0, 'no function changes or removes audit rows');
select throws_ok('select private.record_audit(null, ''operator_action'', null, ''  '')', '22023', 'reason required', 'every audit row needs a reason');

-- Who may grant
select is(pg_temp.as_user('c4', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x'))$$), 'error: not permitted', 'an ordinary user can''t grant a role');
insert into public.staff_roles (user_id, role) values (pg_temp.u('d3'), 'moderator');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x'))$$), 'error: not permitted', 'a moderator can''t grant a role');
insert into public.staff_roles (user_id, role) values (pg_temp.u('b7'), 'admin'), (pg_temp.u('f8'), 'admin');
select is(pg_temp.as_user('b7', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x'))$$), 'error: not permitted', 'an admin without a handle can''t act');
select is(pg_temp.as_user('f8', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x'))$$), 'error: not permitted', 'an unverified admin can''t act');
delete from public.staff_roles where user_id in (pg_temp.u('b7'), pg_temp.u('f8'));
delete from public.staff_roles where user_id = pg_temp.u('d3');
select is(pg_temp.audits(), 1, 'refused grants record nothing');

-- Granting
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('d3'), 'moderator', '  New moderator for the launch team  '))$$), 'changed', 'an admin grants a role');
select is((select granted_by from public.staff_roles where user_id = pg_temp.u('d3') and role = 'moderator'), pg_temp.u('a1'), 'the grant records who granted it');
select is((select row(actor_id, action, target_profile_id, reason, metadata)::text from private.audit_events where action = 'staff_role_granted'),
  row(pg_temp.u('a1'), 'staff_role_granted'::private.audit_action, pg_temp.u('d3'), 'New moderator for the launch team', '{"role": "moderator"}'::jsonb)::text,
  'the audit row names the actor, target, trimmed reason and role');
select is(pg_temp.as_user('a1', $$select (public.grant_staff_role(pg_temp.u('d3'), 'moderator', 'again') - 'audit_id')::text || (public.grant_staff_role(pg_temp.u('d3'), 'moderator', 'again') -> 'audit_id')::text$$),
  '{"ok": true, "result": "unchanged"}null', 'granting a held role changes nothing, with no audit row');
select is(pg_temp.audits(), 2, 'and records nothing');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', '   '))$$), 'error: reason required', 'a blank reason is refused');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', null))$$), 'error: reason required', 'a missing reason is refused');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', repeat('x', 501)))$$), 'error: reason required', 'a reason over 500 characters is refused');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), null, 'x'))$$), 'error: invalid role', 'a missing role is refused');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('b7'), 'moderator', 'x'))$$), 'error: user unavailable', 'an account without a handle can''t hold a role');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('f8'), 'moderator', 'x'))$$), 'error: user unavailable', 'an unverified account can''t hold a role');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('ff'), 'moderator', 'x'))$$), 'error: user unavailable', 'an unknown account can''t hold a role');
select is((select count(*)::int from public.staff_roles where user_id = pg_temp.u('c5')), 0, 'no refused grant created a role');
select is(pg_temp.audits(), 2, 'and invalid requests record nothing');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('a2'), 'admin', 'Second administrator'))$$), 'changed', 'the Owner grants admin (D4)');
create temporary table editor_grant as
  select pg_temp.as_user('a2', $$select public.grant_staff_role(pg_temp.u('e6'), 'catalog_editor', 'Catalog team')::text$$)::jsonb as r;
select is((select r - 'audit_id' from editor_grant), '{"ok": true, "result": "changed"}'::jsonb, 'another admin grants catalog_editor');
select is((select (r ->> 'audit_id')::uuid from editor_grant), (select id from private.audit_events where action = 'staff_role_granted' and target_profile_id = pg_temp.u('e6')),
  'the result names the audit row of the change (A4)');

-- The authority matrix: refusals are returned, audited and change nothing else
create temporary table before_refusals as select pg_temp.state() as state, pg_temp.audits() as audits;
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'admin', 'x'))$$), 'refused: owner_only', 'an admin who isn''t the Owner can''t grant admin (D4)');
select is(pg_temp.refusal('a2', 'owner_only'), 'staff_change_refused/refused/Refused: owner_only', 'the refusal is audited as refused, with its code');
select is((select metadata from private.audit_events where actor_id = pg_temp.u('a2') and metadata ->> 'code' = 'owner_only'),
  '{"code": "owner_only", "role": "admin", "operation": "grant_staff_role"}'::jsonb, 'naming the operation and role, never the reason given');
select is(pg_temp.as_user('a2', $$select public.grant_staff_role(pg_temp.u('c5'), 'admin', 'x') -> 'audit_id'$$), 'null', 'the same refusal again within 10 minutes isn''t recorded twice');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('a2'), 'moderator', 'x'))$$), 'refused: self_change', 'an admin can''t give themselves a role (D7)');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('a1'), 'moderator', 'x'))$$), 'refused: owner_protected', 'or give the Owner one');
select is(pg_temp.refusal('a2', 'owner_protected'), 'owner_protection_refused/refused/Refused: owner_protected', 'an attempt on the Owner is audited as an Owner-protection refusal (D9)');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('a1'), 'catalog_editor', 'x'))$$), 'refused: self_change', 'the Owner can''t change their own roles either');
select is(pg_temp.state(), (select state from before_refusals), 'no refusal changed any role, account, Owner record, transfer or recovery');
select is(pg_temp.audits() - (select audits from before_refusals), 4, 'each one left exactly one audit row, the repeat none');

-- Revoking
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('e6'), 'catalog_editor', 'x'))$$), 'error: not permitted', 'a moderator can''t revoke a role');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('c5'), 'moderator', 'x'))$$), 'unchanged', 'revoking a role that isn''t held changes nothing');
select is((select count(*)::int from private.audit_events where action = 'staff_role_revoked'), 0, 'and records nothing');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('e6'), 'catalog_editor', 'Moved team'))$$), 'changed', 'an admin revokes an editor''s role');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('e6'), 'catalog_editor', 'Back again'))$$), 'changed', 'setup: e6 is an editor again');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('a9'), 'admin', 'Third administrator'))$$), 'changed', 'setup: the Owner grants a9 admin');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('a9'), 'admin', 'x'))$$), 'refused: owner_only', 'an admin who isn''t the Owner can''t revoke admin (D4)');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('a1'), 'admin', 'x'))$$), 'refused: owner_protected', 'or the Owner''s admin role');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('a9'), 'admin', 'No longer needed'))$$), 'changed', 'the Owner revokes another admin');
select is((select metadata from private.audit_events where action = 'staff_role_revoked' and target_profile_id = pg_temp.u('a9')), '{"role": "admin"}'::jsonb, 'the revocation is audited with the role');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('a1'), 'admin', 'Stepping down'))$$), 'refused: self_change', 'the Owner can''t step down as administrator: the Owner always is one');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('a2'), 'admin', 'Stepping down'))$$), 'refused: self_change', 'and no admin removes their own role (D7)');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('a2');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x'))$$), 'error: not permitted', 'a suspended admin can''t act');
update public.profiles set account_status = 'active' where id = pg_temp.u('a2');

-- Owner authority (A1, D13): needed for admin changes, separate from being the Owner
delete from private.mfa_factor_registrations where user_id = pg_temp.u('a1') and factor_id <> pg_temp.u('a1');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('a9'), 'admin', 'x'))$$), 'refused: owner_ineligible', 'an Owner with one mature factor can''t grant admin');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'Interim moderator'))$$), 'changed', 'but keeps ordinary admin abilities');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('a1'), 'admin', 'x'))$$), 'refused: owner_protected', 'and stays protected (A1)');
select pg_temp.mature('a1');
insert into private.owner_recoveries (kind, owner_id, target_id, case_ref, hold_until) values ('factor_reset', pg_temp.u('a1'), pg_temp.u('a1'), 'Test case', now() + interval '72 hours');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('a9'), 'admin', 'x'))$$), 'refused: recovery_pending', 'a pending recovery freezes Owner authority (D6)');
delete from private.owner_recoveries;
update auth.mfa_amr_claims set updated_at = now() - interval '11 minutes' where session_id = pg_temp.u('a1');
create temporary table before_stale as select pg_temp.audits() as audits;
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('a9'), 'admin', 'x'))$$), 'error: reauthentication required', 'without a verification in the last 10 minutes, the Owner must reauthenticate (D3)');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('c5'), 'moderator', 'x'))$$), 'error: reauthentication required', 'for any role change');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.set_account_status(pg_temp.u('c5'), 'suspended', 'x'))$$), 'error: reauthentication required', 'or status change');
select is(pg_temp.audits(), (select audits from before_stale), 'which records nothing');
update auth.mfa_amr_claims set updated_at = now() where session_id = pg_temp.u('a1');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('c5'), 'moderator', 'Interim over'))$$), 'changed', 'setup: c5 is an ordinary user again');

-- Suspension
select is(pg_temp.as_user('c4', $$select pg_temp.res(public.set_account_status(pg_temp.u('c5'), 'suspended', 'x'))$$), 'error: not permitted', 'an ordinary user can''t suspend');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('c4'), 'suspended', 'Spam reports'))$$), 'changed', 'a moderator suspends an ordinary account');
select is(pg_temp.status('c4'), 'suspended', 'the account is suspended');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c4'), 'moderator', 'x'))$$), 'error: user unavailable', 'a suspended account can''t receive a role');
select is((select metadata from private.audit_events where action = 'account_suspended'), '{"to": "suspended", "from": "active"}'::jsonb, 'the suspension is audited with before and after');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('c4'), 'suspended', 'again'))$$), 'unchanged', 'suspending a suspended account changes nothing');
select is((select count(*)::int from private.audit_events where action = 'account_suspended'), 1, 'and records nothing');
select is(pg_temp.as_user('c4', $$select public.request_follow(pg_temp.u('c5'))$$), 'error: account not eligible', 'a suspended user''s existing session can''t follow');
select is(pg_temp.as_user('c4', $$select public.block_user(pg_temp.u('c5'))::text$$), '', 'but can still block (D6)');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('c4'), 'active', 'Appeal accepted'))$$), 'changed', 'a moderator reinstates the account');
select is((select count(*)::int from private.audit_events where action = 'account_reinstated' and target_profile_id = pg_temp.u('c4')), 1, 'the reinstatement is audited');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('d3'), 'suspended', 'x'))$$), 'refused: self_change', 'nobody can suspend themselves');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.set_account_status(pg_temp.u('a2'), 'suspended', 'x'))$$), 'refused: self_change', 'not even an admin');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('e6'), 'suspended', 'x'))$$), 'refused: admin_required', 'a moderator can''t suspend staff');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('a2'), 'suspended', 'x'))$$), 'refused: owner_only', 'or an admin');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('a1'), 'suspended', 'x'))$$), 'refused: owner_protected', 'or the Owner');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.set_account_status(pg_temp.u('e6'), 'suspended', 'Compromised account'))$$), 'changed', 'an admin suspends staff');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.set_account_status(pg_temp.u('e6'), 'active', 'Recovered'))$$), 'changed', 'and reinstates them');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('a9'), 'moderator', 'Moderation help'))$$), 'changed', 'setup: a9 is a moderator');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('a9'), 'admin', 'Administrator again'))$$), 'changed', 'setup: and an admin again');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.set_account_status(pg_temp.u('a9'), 'suspended', 'x'))$$), 'refused: owner_only', 'an admin who isn''t the Owner can''t suspend an admin (D4)');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.set_account_status(pg_temp.u('a1'), 'suspended', 'x'))$$), 'refused: owner_protected', 'or the Owner');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.set_account_status(pg_temp.u('a9'), 'suspended', 'Compromised account'))$$), 'changed', 'the Owner suspends an admin');
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.set_account_status(pg_temp.u('a9'), 'active', 'Recovered'))$$), 'changed', 'and reinstates them');
select is(pg_temp.status('a1'), 'active', 'the Owner is still active');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('c5'), 'deactivated', 'x'))$$), 'error: invalid status', 'deactivation isn''t managed here');
update public.profiles set account_status = 'deactivated' where id = pg_temp.u('c5');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('c5'), 'active', 'x'))$$), 'error: user unavailable', 'a deactivated account can''t be changed here');
update public.profiles set account_status = 'active' where id = pg_temp.u('c5');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('ff'), 'suspended', 'x'))$$), 'error: user unavailable', 'an unknown account is refused');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(null, 'suspended', 'x'))$$), 'error: not permitted', 'and no account at all');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('c5'), 'suspended', ''))$$), 'error: reason required', 'a suspension needs a reason');
select is(pg_temp.status('c5'), 'active', 'no refused call changed the account');

-- Atomicity: if the audit row can't be written, neither the action nor its refusal happens
create function pg_temp.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'audit storage failed'; end $$;
create trigger fail_audit before insert on private.audit_events for each row execute function pg_temp.fail_audit();
select is(pg_temp.as_user('a1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x'))$$), 'error: audit storage failed', 'a failed audit write fails the grant');
select is((select count(*)::int from public.staff_roles where user_id = pg_temp.u('c5')), 0, 'and no role was granted');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('c5'), 'suspended', 'x'))$$), 'error: audit storage failed', 'a failed audit write fails the suspension');
select is(pg_temp.status('c5'), 'active', 'and the account stays active');
select is(pg_temp.as_user('d3', $$select pg_temp.res(public.set_account_status(pg_temp.u('a9'), 'suspended', 'x'))$$), 'error: audit storage failed', 'a refusal whose audit row fails isn''t returned as a quiet refusal: it fails');
select is(pg_temp.status('a9'), 'active', 'and changes nothing');
drop trigger fail_audit on private.audit_events;

-- Reading the log (get_audit_log, which replaced get_audit_events in the M10 integration review)
select is(pg_temp.as_user('a1', 'select jsonb_array_length(public.get_audit_log(100))::text'), (select least(count(*), 100)::text from private.audit_events), 'an admin reads every row, a page at a time');
select is(pg_temp.as_user('a1', $$select public.get_audit_log(1) -> 0 ->> 'id'$$), (select id::text from private.audit_events order by id desc limit 1), 'newest first');
select is(pg_temp.as_user('a1', format($$select string_agg(x ->> 'id', ',' order by x ->> 'id' desc) from jsonb_array_elements(public.get_audit_log(3, %L)) x$$, (select id from (select id from private.audit_events order by id desc limit 3) t order by id limit 1))),
  (select string_agg(id::text, ',' order by id desc) from (select id from private.audit_events order by id desc offset 3 limit 3) t), 'the next page continues without overlap');
select is(pg_temp.as_user('a1', $$select string_agg(distinct x ->> 'outcome', ',' order by x ->> 'outcome') from jsonb_array_elements(public.get_audit_log(100)) x$$), 'operator,refused,succeeded', 'rows carry their outcome (D9)');
select is((select count(*)::int from private.audit_events where outcome = 'refused' and action not in ('owner_protection_refused', 'staff_change_refused')), 0, 'only refusal actions have the refused outcome');
select is(pg_temp.as_user('a1', 'select jsonb_array_length(public.get_audit_log(0))::text'), '1', 'a page holds at least one row');
select is(pg_temp.as_user('a1', 'select (jsonb_array_length(public.get_audit_log(101)) <= 100)::text'), 'true', 'and at most 100');
select is(pg_temp.as_user('d3', 'select public.get_audit_log()::text'), 'error: not permitted', 'a moderator can''t read the log (D2)');
select is(pg_temp.as_user('c4', 'select public.get_audit_log()::text'), 'error: not permitted', 'an ordinary user can''t read the log');

select * from finish();
rollback;
