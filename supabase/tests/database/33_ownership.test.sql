-- M8c: ownership transfer (D5), the successor and succession document (D14, D6a),
-- the app side of recovery (D6, D6b) and the absence of any Owner bypass. Each
-- refusal returns {"ok": false, ...} with a committed audit row and nothing else (A4).
-- Races, with real sessions from local GoTrue, are in db-ownership-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(126);

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
create function pg_temp.res(r jsonb) returns text language sql immutable as $$
  select case when (r ->> 'ok')::boolean then r ->> 'result' else 'refused: ' || (r ->> 'refusal') end
$$;
grant execute on function pg_temp.res(jsonb) to authenticated;
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
create function pg_temp.try(p_sql text) returns text language plpgsql as $t$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
-- Gives s a second verified factor (two in all, with its session's), unregistered.
create function pg_temp.two_factors(s text) returns void language plpgsql as $$
begin
  perform pg_temp.claims(pg_temp.u(s));
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values (gen_random_uuid(), pg_temp.u(s), 'second factor ' || gen_random_uuid(), 'totp', 'verified', now(), now());
end $$;
-- Registers every verified factor of s as 25 hours old, as only postgres can (D13).
create function pg_temp.mature(s text) returns void language plpgsql as $$
begin
  delete from private.mfa_factor_registrations where user_id = pg_temp.u(s);
  insert into private.mfa_factor_registrations (factor_id, user_id, factor_created_at, registered_at)
  select f.id, f.user_id, f.created_at, now() - interval '25 hours' from auth.mfa_factors f where f.user_id = pg_temp.u(s) and f.status = 'verified';
end $$;
create function pg_temp.stale(s text, p_stale boolean) returns void language sql as $$
  update auth.mfa_amr_claims set updated_at = case when p_stale then now() - interval '11 minutes' else now() end where session_id = pg_temp.u(s)
$$;
create function pg_temp.owner() returns text language sql as $$ select coalesce((select right(user_id::text, 2) from private.platform_owner), 'none') $$;
create function pg_temp.transfer() returns text language sql as $$
  select string_agg(right(from_user::text, 2) || '>' || right(to_user::text, 2) || ':' || status || coalesce('/' || cancel_cause, ''), ', ' order by id)
  from private.ownership_transfers
$$;
create function pg_temp.audit(p_action text, p_target text) returns text language sql as $$
  -- Sorted by text: UUIDv7 ids made in the same millisecond don't sort by time.
  select string_agg(x, ', ' order by x) from (
    select coalesce(right(actor_id::text, 2), 'op') || '/' || outcome || '/' || coalesce(metadata ->> 'code', metadata ->> 'by', metadata ->> 'cause', '-') as x
    from private.audit_events where action::text = p_action and target_profile_id is not distinct from pg_temp.u(p_target)
  ) t
$$;
create function pg_temp.state() returns text language sql as $$
  select md5(coalesce((select string_agg(user_id || role::text, ',' order by user_id, role) from public.staff_roles), '')
    || coalesce((select string_agg(id || account_status::text, ',' order by id) from public.profiles), '')
    || coalesce((select string_agg(row(o.*)::text, ',') from private.platform_owner o), '')
    || coalesce((select string_agg(row(t.*)::text, ',' order by t.id) from private.ownership_transfers t), '')
    || coalesce((select string_agg(row(r.*)::text, ',' order by r.id) from private.owner_recoveries r), ''))
$$;

-- f1: the Owner. a2: an admin with two factors. a3: an admin with one. d4: moderator.
-- c5: collector. a6: an admin with two factors, successor. a7: another admin.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['f1', 'a2', 'a3', 'd4', 'c5', 'a6', 'a7']) as s;
update public.profiles set handle = 'own3_' || right(id::text, 2), handle_changed_at = now();
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('f1'), 'admin'), (pg_temp.u('a2'), 'admin'), (pg_temp.u('a3'), 'admin'), (pg_temp.u('d4'), 'moderator'), (pg_temp.u('a6'), 'admin'), (pg_temp.u('a7'), 'admin');
insert into private.platform_owner (user_id) values (pg_temp.u('f1'));
select pg_temp.two_factors(s) from unnest(array['f1', 'a2', 'a6']) s;
select pg_temp.claims(pg_temp.u(s)) from unnest(array['a3', 'd4', 'c5', 'a7']) s;
select pg_temp.mature('f1');

-- ---------------------------------------------------------------------------
-- 1. Access
-- ---------------------------------------------------------------------------
create temporary table m8c_functions (fn text);
insert into m8c_functions values ('public.start_ownership_transfer(uuid,text)'), ('public.accept_ownership_transfer(uuid)'), ('public.cancel_ownership_transfer(uuid,text)'),
  ('public.set_owner_successor(uuid,text)'), ('public.register_succession_document(text,text)'), ('public.confirm_owner_recovery(uuid)'), ('public.cancel_owner_recovery(uuid,text)');
select is((select count(*)::int from m8c_functions f join pg_proc p on p.oid = f.fn::regprocedure
  where p.prosecdef and p.proconfig = array['search_path=""'] and p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres}' and pg_get_function_result(p.oid) = 'jsonb'),
  7, 'each M8c function is SECURITY DEFINER with an empty search_path, returns jsonb, and only authenticated may execute it');
select is((select count(*)::int from m8c_functions f, unnest(array['anon', 'service_role']) r where has_function_privilege(r, f.fn, 'execute')), 0, 'anon and service_role can execute none');
select is(pg_temp.as_user('c5', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a2'), 'x'))$$), 'error: not permitted', 'a collector can''t start a transfer');
select is(pg_temp.as_user('d4', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a2'), 'x'))$$), 'error: not permitted', 'nor a moderator');
select is(pg_temp.as_user('c5', $$select pg_temp.res(public.set_owner_successor(pg_temp.u('a2'), 'x'))$$), 'error: not permitted', 'nor name a successor');
select is(pg_temp.as_user('c5', $$select pg_temp.res(public.cancel_owner_recovery(gen_random_uuid(), 'x'))$$), 'error: not permitted', 'nor cancel a recovery');

-- ---------------------------------------------------------------------------
-- 2. Succession (D14, D6a)
-- ---------------------------------------------------------------------------
create temporary table before_succession as select pg_temp.state() as state;
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.set_owner_successor(pg_temp.u('a6'), 'x'))$$), 'refused: owner_only', 'only the Owner names a successor');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.set_owner_successor(pg_temp.u('f1'), 'x'))$$), 'refused: self_change', 'not themselves');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.set_owner_successor(pg_temp.u('c5'), 'x'))$$), 'refused: target_ineligible', 'and only an admin');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.set_owner_successor(gen_random_uuid(), 'x'))$$), 'error: user unavailable', 'an unknown account is an error, not recorded');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.register_succession_document(repeat('a', 64), 'x'))$$), 'refused: owner_only', 'only the Owner registers the succession document');
select is(pg_temp.state(), (select state from before_succession), 'the refusals changed nothing');
select is(pg_temp.audit('staff_change_refused', 'a6'), 'a2/refused/owner_only', 'and were audited');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.set_owner_successor(pg_temp.u('a6'), 'Named in the succession document'))$$), 'changed', 'the Owner names a6');
select is((select right(successor_id::text, 2) from private.platform_owner), 'a6', 'who is recorded as the successor');
select is(pg_temp.audit('owner_successor_set', 'a6'), 'f1/succeeded/-', 'audited as the Owner''s action');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.set_owner_successor(pg_temp.u('a6'), 'again'))$$), 'unchanged', 'naming them again changes nothing');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.register_succession_document('not-a-hash', 'x'))$$), 'error: invalid fingerprint', 'a fingerprint must be 64 hex digits');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.register_succession_document('  ' || repeat('AB', 32) || ' ', 'Signed 2026-11-15, two custodians'))$$), 'changed', 'the Owner registers the document''s SHA-256');
select is((select succession_fingerprint || '/' || (succession_registered_at = now())::text from private.platform_owner), repeat('ab', 32) || '/true', 'stored in lower case, with the time');
select is((select metadata ->> 'fingerprint' from private.audit_events where action = 'owner_succession_registered'), repeat('ab', 32), 'and audited with the fingerprint, which reveals nothing of the document');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.register_succession_document(repeat('ab', 32), 'again'))$$), 'unchanged', 'the same fingerprint changes nothing');
select pg_temp.stale('f1', true);
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.set_owner_successor(null, 'x'))$$), 'error: reauthentication required', 'succession changes need a recent verification');
select pg_temp.stale('f1', false);
delete from private.mfa_factor_registrations where user_id = pg_temp.u('f1') and factor_id <> pg_temp.u('f1');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.set_owner_successor(null, 'x'))$$), 'refused: owner_ineligible', 'and Owner authority: two mature factors');
select pg_temp.mature('f1');

-- ---------------------------------------------------------------------------
-- 3. Starting a transfer
-- ---------------------------------------------------------------------------
create temporary table before_start as select pg_temp.state() as state;
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a6'), 'x'))$$), 'refused: owner_only', 'an admin who isn''t the Owner can''t start a transfer');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('f1'), 'x'))$$), 'refused: self_change', 'the Owner can''t transfer to themselves');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('c5'), 'x'))$$), 'refused: target_ineligible', 'nor to someone who isn''t an admin');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a3'), 'x'))$$), 'refused: target_ineligible', 'nor to an admin with one factor (D13)');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.start_ownership_transfer(gen_random_uuid(), 'x'))$$), 'error: user unavailable', 'an unknown account is an error');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a2'), ' '))$$), 'error: reason required', 'a transfer needs a reason');
select pg_temp.stale('f1', true);
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a2'), 'x'))$$), 'error: reauthentication required', 'and a recent verification');
select pg_temp.stale('f1', false);
select is(pg_temp.state(), (select state from before_start), 'no refusal or error changed anything');
select is(pg_temp.audit('staff_change_refused', 'a3'), 'f1/refused/target_ineligible', 'the refusals are audited');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a2'), 'Handing over to a2'))$$), 'changed', 'the Owner offers ownership to a2');
select is(pg_temp.transfer(), 'f1>a2:pending', 'a pending transfer from f1 to a2');
select ok((select expires_at = now() + interval '72 hours' from private.ownership_transfers), 'expiring in 72 hours (D17)');
select is((select (metadata ->> 'transfer_id')::uuid from private.audit_events where action = 'ownership_transfer_started'), (select id from private.ownership_transfers), 'the audit row names the transfer');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a6'), 'x'))$$), 'refused: transfer_pending', 'only one transfer can be pending');
select is(pg_temp.owner(), 'f1', 'f1 is still the Owner');

-- ---------------------------------------------------------------------------
-- 4. Accepting
-- ---------------------------------------------------------------------------
create function pg_temp.pending() returns uuid language sql as $$ select id from private.ownership_transfers where status = 'pending' $$;
grant execute on function pg_temp.pending() to authenticated;
-- pending() is read as postgres, then passed in, since clients can't read the table.
create function pg_temp.accept(s text) returns text language sql as $$
  select pg_temp.as_user(s, format($f$select pg_temp.res(public.accept_ownership_transfer(%L))$f$, pg_temp.pending()))
$$;
select is(pg_temp.accept('a6'), 'error: transfer unavailable', 'someone else can''t accept it');
select is(pg_temp.accept('c5'), 'error: not permitted', 'nor a collector');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.accept_ownership_transfer(gen_random_uuid()))$$), 'error: transfer unavailable', 'an unknown transfer is an error');
select pg_temp.stale('a2', true);
select is(pg_temp.accept('a2'), 'error: reauthentication required', 'the target needs a recent verification too');
select pg_temp.stale('a2', false);
delete from auth.mfa_factors where user_id = pg_temp.u('a2') and id <> pg_temp.u('a2');
select is(pg_temp.accept('a2'), 'refused: target_ineligible', 'and still two verified factors, checked when accepting');
select is(pg_temp.transfer(), 'f1>a2:pending', 'which leaves the transfer pending');
select pg_temp.two_factors('a2');
select is(pg_temp.accept('a2'), 'changed', 'a2 accepts');
select is(pg_temp.owner() || '/' || (select version from private.platform_owner), 'a2/2', 'a2 is the Owner, and the record''s version moved on');
select is(pg_temp.transfer(), 'f1>a2:accepted', 'the transfer is accepted');
select is((select string_agg(right(user_id::text, 2), ',' order by user_id) from public.staff_roles where role = 'admin' and user_id in (pg_temp.u('f1'), pg_temp.u('a2'))), 'a2,f1', 'both stay admins: a voluntary transfer keeps the previous Owner''s role');
select is((select coalesce(successor_id::text, 'none') || '/' || coalesce(succession_fingerprint, 'none') from private.platform_owner), 'none/none', 'the previous Owner''s successor and document are cleared');
select is(pg_temp.audit('ownership_transfer_accepted', 'a2'), 'a2/succeeded/-', 'the acceptance is audited');
select is((select right(metadata ->> 'previous_owner_id', 2) from private.audit_events where action = 'ownership_transfer_accepted'), 'f1', 'naming the previous Owner');
select is(pg_temp.as_user('a2', format($$select pg_temp.res(public.accept_ownership_transfer(%L))$$, (select id from private.ownership_transfers))), 'unchanged', 'accepting again changes nothing');
select is(pg_temp.try($$delete from auth.users where id = '$$ || pg_temp.u('a2') || $$'$$), 'error: account protected', 'the new Owner is protected');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a6'), 'x'))$$), 'refused: owner_only', 'the previous Owner''s session has no Owner authority left');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'admin', 'x'))$$), 'refused: owner_only', 'not even to grant admin');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'admin', 'x'))$$), 'refused: owner_ineligible', 'the new Owner''s authority waits for their factors to mature (D13)');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'New moderator'))$$), 'changed', 'while ordinary admin work goes on');
select pg_temp.mature('a2');

-- ---------------------------------------------------------------------------
-- 5. Cancelling and declining
-- ---------------------------------------------------------------------------
create function pg_temp.cancel(s text, p_reason text) returns text language sql as $$
  select pg_temp.as_user(s, format($f$select pg_temp.res(public.cancel_ownership_transfer(%L, %L))$f$, pg_temp.pending(), p_reason))
$$;
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('f1'), 'Back to f1'))$$), 'changed', 'setup: a2 offers ownership to f1');
select is(pg_temp.cancel('a6', 'x'), 'error: transfer unavailable', 'a third admin can''t cancel it');
select is(pg_temp.cancel('f1', ''), 'error: reason required', 'declining needs a reason');
select pg_temp.stale('f1', true);
select is(pg_temp.cancel('f1', 'Not now'), 'changed', 'the target declines, with aal2 but no recent verification');
select pg_temp.stale('f1', false);
select is((select status || '/' || cancel_cause || '/' || right(decided_by::text, 2) from private.ownership_transfers where to_user = pg_temp.u('f1')), 'declined/target/f1', 'recorded as declined by the target');
select is(pg_temp.audit('ownership_transfer_cancelled', 'f1'), 'f1/succeeded/target', 'and audited');
select is(pg_temp.as_user('f1', format($$select pg_temp.res(public.cancel_ownership_transfer(%L, 'again'))$$, (select id from private.ownership_transfers where to_user = pg_temp.u('f1')))), 'unchanged', 'declining again changes nothing');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a6'), 'To a6'))$$), 'changed', 'setup: a2 offers ownership to a6');
select pg_temp.stale('a2', true);
select is(pg_temp.cancel('a2', 'Changed my mind'), 'error: reauthentication required', 'the Owner cancels only with a recent verification');
select pg_temp.stale('a2', false);
select is(pg_temp.cancel('a2', 'Changed my mind'), 'changed', 'the Owner cancels');
select is((select status || '/' || cancel_cause from private.ownership_transfers where to_user = pg_temp.u('a6')), 'cancelled/owner', 'recorded as cancelled by the Owner');

-- ---------------------------------------------------------------------------
-- 6. Expiry, lazily (D17)
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('f1'), 'Expiring'))$$), 'changed', 'setup: a transfer to f1');
update private.ownership_transfers set created_at = now() - interval '73 hours', expires_at = now() - interval '1 hour' where status = 'pending';
create temporary table before_expired as select pg_temp.state() as state;
select is(pg_temp.accept('f1'), 'refused: transfer_expired', 'an expired transfer can''t be accepted');
select is(pg_temp.state(), (select state from before_expired), 'and the refusal changes nothing: the transfer isn''t even marked');
select is(pg_temp.audit('staff_change_refused', 'f1'), 'f1/refused/self_change, f1/refused/transfer_expired', 'but is audited, beside f1''s earlier refusal');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a6'), 'After expiry'))$$), 'changed', 'an expired transfer doesn''t block a new one');
select is((select status from private.ownership_transfers where to_user = pg_temp.u('f1') and created_at < now() - interval '72 hours'), 'expired', 'which marks the old one expired');

-- ---------------------------------------------------------------------------
-- 7. What happens to a pending transfer when its target changes
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.set_account_status(pg_temp.u('a6'), 'suspended', 'Compromised'))$$), 'changed', 'the Owner suspends the target');
select is((select status || '/' || cancel_cause || '/' || right(decided_by::text, 2) from private.ownership_transfers where to_user = pg_temp.u('a6') and cancel_cause = 'target_suspended'), 'cancelled/target_suspended/a2', 'which cancels the transfer, in the same transaction');
select is(pg_temp.audit('ownership_transfer_cancelled', 'a6'), 'a2/succeeded/owner, a2/succeeded/target_suspended', 'audited with its cause');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.set_account_status(pg_temp.u('a6'), 'active', 'Recovered'))$$), 'changed', 'setup: a6 reinstated');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a6'), 'Again'))$$), 'changed', 'setup: a new transfer to a6');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.set_owner_successor(pg_temp.u('a6'), 'Successor'))$$), 'changed', 'setup: and a6 named successor');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.revoke_staff_role(pg_temp.u('a6'), 'admin', 'Left the team'))$$), 'changed', 'the Owner revokes the target''s admin role');
select is((select count(*)::int from private.ownership_transfers where status = 'pending'), 0, 'which cancels the transfer');
select is((select count(*)::int from private.ownership_transfers where to_user = pg_temp.u('a6') and status = 'cancelled' and cancel_cause = 'target_role_revoked'), 1, 'with that cause');
select is((select coalesce(successor_id::text, 'none') from private.platform_owner), 'none', 'and clears them as successor');
select is((select metadata ->> 'cause' from private.audit_events where action = 'owner_successor_set' and target_profile_id = pg_temp.u('a6') and metadata ->> 'successor_id' is null), 'target_role_revoked', 'audited too');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('a6'), 'admin', 'Back'))$$), 'changed', 'setup: a6 is an admin again');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('f1'), 'Before a recovery'))$$), 'changed', 'setup: a transfer to f1');
select isnt(private.begin_owner_recovery('factor_reset', null, 'Case T'), null, 'an operator opens a recovery');
select is((select count(*)::int || '/' || min(status) from private.ownership_transfers where to_user = pg_temp.u('f1') and cancel_cause = 'recovery_started'), '1/cancelled', 'which cancels the pending transfer (M8a)');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('f1'), 'x'))$$), 'refused: recovery_pending', 'and no transfer starts while it is pending');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.set_owner_successor(pg_temp.u('a6'), 'x'))$$), 'refused: recovery_pending', 'nor does the succession change');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.register_succession_document(repeat('cd', 32), 'x'))$$), 'refused: recovery_pending', 'or the document');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'catalog_editor', 'Catalog help'))$$), 'changed', 'while ordinary admin work goes on');
-- An operator ends this recovery.
select private.cancel_owner_recovery_by_operator((select id from private.owner_recoveries where status = 'pending'), 'Case T closed');

-- ---------------------------------------------------------------------------
-- 8. Recovery in the app (D6, D6b)
-- ---------------------------------------------------------------------------
create function pg_temp.recovery() returns uuid language sql as $$ select id from private.owner_recoveries where status = 'pending' $$;
create function pg_temp.confirm(s text) returns text language sql as $$
  select pg_temp.as_user(s, format($f$select pg_temp.res(public.confirm_owner_recovery(%L))$f$, pg_temp.recovery()))
$$;
create function pg_temp.cancel_recovery(s text) returns text language sql as $$
  select pg_temp.as_user(s, format($f$select pg_temp.res(public.cancel_owner_recovery(%L, 'I am here'))$f$, pg_temp.recovery()))
$$;
select isnt(private.begin_owner_recovery('reassign', 'own3_a6', 'Case R1'), null, 'an operator opens a reassignment to a6');
select is(pg_temp.confirm('c5'), 'error: recovery unavailable', 'only its target can confirm it');
select is(pg_temp.as_user('a6', $$select pg_temp.res(public.confirm_owner_recovery(gen_random_uuid()))$$), 'error: recovery unavailable', 'an unknown recovery is an error');
select pg_temp.stale('a6', true);
select is(pg_temp.confirm('a6'), 'error: reauthentication required', 'the target confirms only with a recent verification');
select pg_temp.stale('a6', false);
select is(pg_temp.confirm('a6'), 'changed', 'a6 confirms');
select ok((select confirmed_at = now() from private.owner_recoveries where status = 'pending'), 'the confirmation is recorded');
select is(pg_temp.audit('owner_recovery_confirmed', 'a6'), 'a6/succeeded/-', 'audited as a6''s own action, not an operator''s');
select is(pg_temp.confirm('a6'), 'unchanged', 'confirming again changes nothing');
select is(pg_temp.owner(), 'a2', 'confirming moves nothing: a2 is still the Owner');
select is(pg_temp.cancel_recovery('a7'), 'refused: owner_only', 'only the Owner can cancel a recovery');
select is((select count(*)::int from private.audit_events where action = 'staff_change_refused' and actor_id = pg_temp.u('a7') and target_profile_id = pg_temp.u('a6') and metadata ->> 'operation' = 'cancel_owner_recovery'), 1, 'and the attempt is audited');
delete from private.mfa_factor_registrations where user_id = pg_temp.u('a2') and factor_id <> pg_temp.u('a2');
select pg_temp.stale('a2', true);
select is(pg_temp.cancel_recovery('a2'), 'error: reauthentication required', 'the Owner cancels only with a recent verification');
select pg_temp.stale('a2', false);
select is(pg_temp.cancel_recovery('a2'), 'changed', 'and can cancel with one mature factor: no full authority needed (D6b)');
select is((select status || '/' || cancelled_by_owner || '/' || cancel_cause from private.owner_recoveries where case_ref = 'Case R1'), 'cancelled/true/owner', 'the recovery is cancelled by the Owner');
select is(pg_temp.audit('owner_recovery_cancelled', 'a6'), 'a2/succeeded/owner', 'audited as the Owner''s action');
select is(pg_temp.try(format('select private.complete_owner_recovery(%L, %L)', (select id from private.owner_recoveries where case_ref = 'Case R1'), 'Case R1')), 'error: recovery not pending', 'a cancelled recovery can''t complete');
select isnt(private.begin_owner_recovery('reassign', 'own3_a6', 'Case R2', null, true), null, 'after the Owner cancelled one, an operator may open a disputed recovery');
create temporary table before_dispute as select pg_temp.state() as state;
select is(pg_temp.cancel_recovery('a2'), 'refused: recovery_disputed', 'which the Owner can''t cancel from the app');
select is(pg_temp.state(), (select state from before_dispute), 'leaving it pending');
select is((select outcome || '/' || reason from private.audit_events where actor_id = pg_temp.u('a2') and metadata ->> 'code' = 'recovery_disputed'), 'refused/Refused: recovery_disputed', 'with the attempt audited');
select private.cancel_owner_recovery_by_operator(pg_temp.recovery(), 'Dispute resolved');
select isnt(private.begin_owner_recovery('factor_reset', null, 'Case R3'), null, 'setup: a factor reset');
update auth.users set banned_until = now() + interval '1 day' where id = pg_temp.u('a2');
select is(pg_temp.cancel_recovery('a2'), 'refused: owner_ineligible', 'a banned Owner can''t cancel with a session left over');
update auth.users set banned_until = null where id = pg_temp.u('a2');
select private.cancel_owner_recovery_by_operator(pg_temp.recovery(), 'Case R3 closed');
select pg_temp.mature('a2');

-- A reassignment completes only with the target's confirmation, and removes the
-- previous Owner's admin role with the ownership (D6c).
select isnt(private.begin_owner_recovery('reassign', 'own3_a6', 'Case R4'), null, 'an operator opens a reassignment');
select is(pg_temp.confirm('a6'), 'changed', 'a6 confirms');
update private.owner_recoveries set created_at = now() - interval '73 hours', hold_until = now() - interval '1 hour' where status = 'pending';
select is((select (private.complete_owner_recovery(pg_temp.recovery(), 'Case R4') ->> 'owner_id')::uuid), pg_temp.u('a6'), 'after the hold, the operator completes it');
select is(pg_temp.owner(), 'a6', 'a6 is the Owner');
select is((select count(*)::int from public.staff_roles where user_id = pg_temp.u('a2') and role = 'admin'), 0, 'and a2 is no longer an admin, in the same transaction');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'admin', 'x'))$$), 'error: not permitted', 'a2''s session has no staff ability left');

-- ---------------------------------------------------------------------------
-- 9. No Owner bypass: only the staff, protection and operator functions know the
--    Owner. No policy does, so collections, private details, the catalog and review
--    rules apply to the Owner exactly as to any other admin.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_policies where coalesce(qual, '') || coalesce(with_check, '') ~ 'is_designated_owner|platform_owner|owner_authority|can_exercise_owner|owner_candidate|role_change_refusal'),
  0, 'no RLS policy mentions the Owner');
select is((select array_agg(p.oid::regprocedure::text collate "C" order by p.oid::regprocedure::text collate "C") from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosrc ~ 'is_designated_owner|platform_owner|owner_authority|can_exercise_owner|owner_candidate|role_change_refusal'),
  array['accept_ownership_transfer(uuid)', 'account_deletion_blocked(uuid)', 'cancel_owner_recovery(uuid,text)', 'confirm_owner_recovery(uuid)', 'grant_staff_role(uuid,staff_role,text)',
    'private.assign_initial_owner(text,text)', 'private.begin_owner_recovery(text,text,text,text,boolean)', 'private.can_exercise_owner_authority()', 'private.close_owner_designations(uuid,uuid,text,text)',
    'private.complete_owner_recovery(uuid,text)', 'private.is_designated_owner(uuid)', 'private.operator_set_owner_status(account_status,text)', 'private.owner_authority_refusal()', 'private.owner_integrity()',
    'private.protect_owner_admin_role()', 'private.protect_owner_profile()', 'private.protect_owner_status()', 'private.role_change_refusal(uuid,uuid,staff_role)',
    'register_succession_document(text,text)', 'revoke_staff_role(uuid,staff_role,text)', 'set_account_status(uuid,account_status,text)', 'set_owner_successor(uuid,text)', 'start_ownership_transfer(uuid,text)'],
  'only the staff, protection and operator functions mention the Owner');
select is((select count(*)::int from pg_proc p where p.prosrc ~ 'is_designated_owner|owner_authority' and (p.prosrc ~ '(public|private)\.(collection|catalog|game|release|import|provider)')),
  0, 'none of them touches a collection, catalog, release or submission');

-- PostgREST sessions load safeupdate, which refuses an UPDATE or DELETE without a WHERE
-- clause, even inside a function or trigger. pgTAP can't load it, so this checks the
-- source instead; db-ownership-checks.mjs covers the same paths through the API.
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
    regexp_matches(p.prosrc, '((?:\mupdate\s+(?:only\s+)?[a-z_]+\.[a-z_]+|\mdelete\s+from\s+[a-z_]+\.[a-z_]+)[^;]*);', 'gi') as m
  where n.nspname in ('public', 'private') and m[1] !~* '\mwhere\M'),
  0, 'no function updates or deletes rows without a WHERE clause');

select * from finish();
rollback;
