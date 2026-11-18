-- M11a-2 fixes to M11a-1 invitations: an address that already has an account must look,
-- to an administrator, exactly like one that doesn't (the answer, the list, the counts,
-- the limits, the audit log and every API response), and must never be sent an email.
-- The steps that depend on Auth are the server's only (service_role). claim_handle locks
-- the invitation before deciding (the concurrent orderings are tested in
-- scripts/db-invitation-checks.mjs, which needs two sessions).
-- Runs in one transaction that rolls back, on a local stack only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
-- A password session (aal1), as Auth creates one at sign-in: since the session-revocation
-- checkpoint, owner-scoped reads and writes need the token's session to exist.
create function pg_temp.plain(p_user uuid) returns jsonb language plpgsql as $plain$
declare v_session uuid := md5('plain:' || p_user::text)::uuid;
begin
  if exists (select 1 from auth.users where id = p_user) then
    insert into auth.sessions (id, user_id, aal, created_at, updated_at) values (v_session, p_user, 'aal1', now(), now()) on conflict (id) do nothing;
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1', 'session_id', v_session);
end $plain$;
create function pg_temp.session(p_user uuid) returns jsonb language plpgsql as $mfa$
begin
  insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    select p_user, p_user, 'Factor', 'totp', 'verified', now() - interval '3 days', now()
    where not exists (select 1 from auth.mfa_factors where id = p_user);
  if not exists (select 1 from auth.mfa_amr_claims where session_id = p_user) then
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at) values (gen_random_uuid(), p_user, 'totp', now(), now());
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user);
end $mfa$;
create function pg_temp.run(p_role text, p_claims jsonb, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', p_claims::text, true);
  perform set_config('role', p_role, true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.as_admin(p_actor text, p_sql text) returns text language sql as $$ select pg_temp.run('authenticated', pg_temp.session(pg_temp.u(p_actor)), p_sql) $$;
create function pg_temp.as_plain(p_actor text, p_sql text) returns text language sql as $$
  select pg_temp.run('authenticated', pg_temp.plain(pg_temp.u(p_actor)), p_sql) $$;
create function pg_temp.as_service(p_sql text) returns text language sql as $$ select pg_temp.run('service_role', '{"role": "service_role"}', p_sql) $$;
create function pg_temp.invitee(s text, p_email text) returns void language sql as $$
  insert into auth.users (id, aud, role, email, invited_at, instance_id)
  values (pg_temp.u(s), 'authenticated', 'authenticated', p_email, now(), '00000000-0000-0000-0000-000000000000') $$;
-- What an administrator's list says about an invitation, without what differs for any two
-- rows (id, masked address, time).
create function pg_temp.entry(p_id text) returns jsonb language sql as $$
  select x - 'id' - 'email' - 'created_at' - 'last_sent_at'
  from jsonb_array_elements((pg_temp.as_admin('a1', $q$select public.get_account_invitations()::text$q$))::jsonb -> 'invitations') x
  where x ->> 'id' = p_id $$;
-- What the administrators' audit log shows for the newest event of an action, without its id and time.
create function pg_temp.audit_seen(p_action text, p_offset int default 0) returns jsonb language sql as $$
  select x - 'id' - 'occurred_at'
  from jsonb_array_elements((pg_temp.as_admin('a1', $q$select public.get_audit_log(100, null, null, 'accounts')::text$q$))::jsonb) x
  where x ->> 'action' = p_action
  offset p_offset limit 1 $$;
create temp table t (name text primary key, id uuid);
grant select on t to authenticated, service_role;
create function pg_temp.keep(p_name text, p_result text) returns text language sql as $$
  insert into t values (p_name, (p_result::jsonb ->> 'id')::uuid) on conflict (name) do update set id = excluded.id returning p_result $$;
create function pg_temp.id(p_name text) returns text language sql as $$ select id::text from t where name = p_name $$;

-- a1, a3: administrators. c1: a collector with an account. f1..: invitees, as Auth creates them.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@staff.example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'a3', 'c1']) s;
update public.profiles set handle = 'pv_' || right(id::text, 2), handle_changed_at = now() where id in (pg_temp.u('a1'), pg_temp.u('a3'), pg_temp.u('c1'));
insert into public.staff_roles (user_id, role) values (pg_temp.u('a1'), 'admin'), (pg_temp.u('a3'), 'admin');

-- ---------------------------------------------------------------------------
-- 1. Who may call the server's steps
-- ---------------------------------------------------------------------------
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'authenticated', 'catalog_importer']) r,
  unnest(array['public.invitation_delivery_plan(uuid)', 'public.record_invitation_delivery(uuid,text,text)',
    'public.invitation_revocation_target(uuid)', 'public.reconcile_invitation(uuid)']) f), false,
  'no client role can execute the server''s steps');
select is((select bool_and(has_function_privilege('service_role', f, 'execute')) from
  unnest(array['public.invitation_delivery_plan(uuid)', 'public.record_invitation_delivery(uuid,text,text)',
    'public.invitation_revocation_target(uuid)', 'public.reconcile_invitation(uuid)']) f), true, 'the server''s secret key can');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'authenticated', 'service_role']) r,
  unnest(array['private.invitation_delivery_failing()', 'private.invitation_address_taken(text)',
    'private.finish_invitation_delivery(private.account_invitations,text,boolean,uuid)']) f), false, 'nor the new private helpers');
select is(to_regprocedure('public.record_invitation_delivery(uuid,text,boolean)'), null, 'the administrators'' version of recording a delivery is gone');
select is(pg_temp.as_admin('a1', $$select public.invitation_delivery_plan(gen_random_uuid())::text$$), 'error: permission denied for function invitation_delivery_plan', 'an administrator can''t ask whether an invitation is sent');
select is(pg_temp.as_admin('a1', $$select public.record_invitation_delivery(gen_random_uuid(), 'invite', 'sent')::text$$), 'error: permission denied for function record_invitation_delivery', 'nor record a delivery');
select is(pg_temp.as_admin('a1', $$select public.invitation_revocation_target(gen_random_uuid())::text$$), 'error: permission denied for function invitation_revocation_target', 'nor ask for the account to ban');
select is(pg_temp.as_admin('a1', $$select public.reconcile_invitation(gen_random_uuid())::text$$), 'error: permission denied for function reconcile_invitation', 'nor reconcile');

-- ---------------------------------------------------------------------------
-- 2. Creating: the same answer, row, count and audit row
-- ---------------------------------------------------------------------------
select is(pg_temp.as_admin('a1', $$select (public.get_account_invitations() -> 'limits' ->> 'mine')$$), '0', 'no invitations yet');
select is(pg_temp.keep('known', pg_temp.as_admin('a1', $$select public.create_account_invitation('c1@staff.example.test', 'Beta')::text$$))::jsonb - 'id',
  '{"ok": true, "result": "accepted"}', 'an address with an account is accepted');
select is(pg_temp.keep('new', pg_temp.as_admin('a1', $$select public.create_account_invitation('new@example.test', 'Beta')::text$$))::jsonb - 'id',
  '{"ok": true, "result": "accepted"}', 'exactly as an address without one');
select is((select count(*)::int from t where id is not null), 2, 'each with an id');
select is(pg_temp.as_admin('a1', $$select (public.get_account_invitations() -> 'limits' ->> 'mine')$$), '2', 'and each counted');
select is(pg_temp.entry(pg_temp.id('known')), pg_temp.entry(pg_temp.id('new')), 'the two list entries say the same');
select is(pg_temp.entry(pg_temp.id('known')) ->> 'status', 'sending', 'both waiting to be sent');
select is(pg_temp.audit_seen('account_invited', 0), pg_temp.audit_seen('account_invited', 1), 'the two audit rows read the same');
select is((select count(*)::int from private.audit_events where action = 'account_invited' and metadata ->> 'withheld' = 'true'), 1, 'only the database''s own record marks the withheld one');
select is(pg_temp.as_admin('a1', $$select public.get_audit_log(100, null, null, 'accounts')::text$$) ~ 'withheld|invitee|example\.test', false, 'and no page sees that mark, an account or an address');

-- ---------------------------------------------------------------------------
-- 3. Delivery: never an email for an account, and the same outcome
-- ---------------------------------------------------------------------------
select is(pg_temp.as_service(format($$select public.invitation_delivery_plan('%s')::text$$, pg_temp.id('known'))), '{"send": false, "email": "c1@staff.example.test"}', 'the server is told not to send to an address with an account');
select is(pg_temp.as_service(format($$select public.invitation_delivery_plan('%s') ->> 'send'$$, pg_temp.id('new'))), 'true', 'and to send to one without');
select pg_temp.invitee('f1', 'new@example.test');
select is(pg_temp.as_service(format($$select public.record_invitation_delivery('%s', 'invite', 'sent')::text$$, pg_temp.id('new'))), '{"ok": true, "result": "sent"}', 'Auth''s send is recorded');
select is(pg_temp.as_service(format($$select public.record_invitation_delivery('%s', 'invite', 'skipped')::text$$, pg_temp.id('known'))), '{"ok": true, "result": "sent"}', 'and the withheld one is recorded the same way');
select is(pg_temp.entry(pg_temp.id('known')), pg_temp.entry(pg_temp.id('new')), 'the list entries still say the same');
select is(pg_temp.audit_seen('account_invitation_delivery', 0), pg_temp.audit_seen('account_invitation_delivery', 1), 'and so do the delivery audit rows');
select is((select invited_user_id from private.account_invitations where id = pg_temp.id('known')::uuid), null, 'the withheld row is never linked to the account');
select is(pg_temp.as_plain('c1', $$select public.get_my_onboarding()::text$$), '{"invited": false, "revoked": false, "password_set": false}', 'whose owner isn''t treated as an invitee');
select is(pg_temp.as_plain('c1', $$select public.claim_handle('pv_c1')$$), 'pv_c1', 'and keeps their handle');

-- ---------------------------------------------------------------------------
-- 4. Resending: the same rules and answers, attributed to who asked
-- ---------------------------------------------------------------------------
update private.account_invitations set last_sent_at = now() - interval '11 minutes' where id in (pg_temp.id('known')::uuid, pg_temp.id('new')::uuid);
select is(pg_temp.as_admin('a3', format($$select public.request_invitation_resend('%s', 'Lost it')::text$$, pg_temp.id('known'))),
  pg_temp.as_admin('a3', format($$select public.request_invitation_resend('%s', 'Lost it')::text$$, pg_temp.id('new'))), 'a resend is answered the same way');
select is(pg_temp.as_admin('a3', format($$select public.request_invitation_resend('%s', 'Lost it')::text$$, pg_temp.id('known'))), '{"ok": false, "refusal": "resend_too_soon"}', 'and limited the same way');
select pg_temp.as_service(format($$select public.record_invitation_delivery('%s', 'resend', 'sent')::text$$, pg_temp.id('new')));
select pg_temp.as_service(format($$select public.record_invitation_delivery('%s', 'resend', 'skipped')::text$$, pg_temp.id('known')));
select is((select array_agg(distinct actor_id) from private.audit_events where action = 'account_invitation_delivery' and metadata ->> 'operation' = 'resend'), array[pg_temp.u('a3')],
  'the resend''s delivery is attributed to the administrator who asked for it');
select is(pg_temp.entry(pg_temp.id('known')), pg_temp.entry(pg_temp.id('new')), 'and the entries still match');

-- ---------------------------------------------------------------------------
-- 5. Delivery failures stay visible, and withheld rows follow them
-- ---------------------------------------------------------------------------
select pg_temp.keep('fail', pg_temp.as_admin('a1', $$select public.create_account_invitation('fail@example.test', 'Beta')::text$$));
select is(pg_temp.as_service(format($$select public.record_invitation_delivery('%s', 'invite', 'failed') ->> 'result'$$, pg_temp.id('fail'))), 'send_failed', 'a failed email shows as failed');
-- One transaction has one now(): place the failure after the earlier sends.
update private.account_invitations set last_failed_at = now() + interval '1 minute' where id = pg_temp.id('fail')::uuid;
select pg_temp.keep('known2', pg_temp.as_admin('a1', $$select public.create_account_invitation('c1@staff.example.test', 'Beta')::text$$));
select is(pg_temp.as_service(format($$select public.record_invitation_delivery('%s', 'invite', 'skipped') ->> 'result'$$, pg_temp.id('known2'))), 'send_failed', 'while emails are failing, a withheld one shows as failed too');
select pg_temp.keep('ok', pg_temp.as_admin('a1', $$select public.create_account_invitation('ok@example.test', 'Beta')::text$$));
select pg_temp.invitee('f2', 'ok@example.test');
select pg_temp.as_service(format($$select public.record_invitation_delivery('%s', 'invite', 'sent')::text$$, pg_temp.id('ok')));
update private.account_invitations set last_sent_at = now() + interval '2 minutes' where id = pg_temp.id('ok')::uuid;
select pg_temp.keep('known3', pg_temp.as_admin('a1', $$select public.create_account_invitation('c1@staff.example.test', 'Beta')::text$$));
select is(pg_temp.as_service(format($$select public.record_invitation_delivery('%s', 'invite', 'skipped') ->> 'result'$$, pg_temp.id('known3'))), 'sent', 'and as sent again once an email gets through');

-- ---------------------------------------------------------------------------
-- 6. An account made after the invitation was recorded
-- ---------------------------------------------------------------------------
select pg_temp.keep('late', pg_temp.as_admin('a1', $$select public.create_account_invitation('late@example.test', 'Beta')::text$$));
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id) values (pg_temp.u('f3'), 'authenticated', 'authenticated', 'late@example.test', now(), '00000000-0000-0000-0000-000000000000');
select is(pg_temp.as_service(format($$select public.record_invitation_delivery('%s', 'invite', 'unavailable') ->> 'result'$$, pg_temp.id('late'))), 'sent', 'Auth''s "already registered" is recorded as an ordinary send');
select is((select withheld and invited_user_id is null from private.account_invitations where id = pg_temp.id('late')::uuid), true, 'and the row becomes withheld, unlinked');
select pg_temp.keep('fake', pg_temp.as_admin('a1', $$select public.create_account_invitation('fake@example.test', 'Beta')::text$$));
select is(pg_temp.as_service(format($$select public.record_invitation_delivery('%s', 'invite', 'unavailable') ->> 'result'$$, pg_temp.id('fake'))), 'send_failed', 'but "already registered" without a confirmed account isn''t believed');

-- ---------------------------------------------------------------------------
-- 7. Revocation: the same answers, and the account is never touched
-- ---------------------------------------------------------------------------
select is(pg_temp.as_admin('a1', format($$select public.request_invitation_revocation('%s', 'Mistake')::text$$, pg_temp.id('known'))),
  pg_temp.as_admin('a1', format($$select public.request_invitation_revocation('%s', 'Mistake')::text$$, pg_temp.id('new'))), 'a revocation is answered the same way');
select is(pg_temp.as_service(format($$select public.invitation_revocation_target('%s')::text$$, pg_temp.id('known'))), '{"user_id": null}', 'there''s no account to ban for the withheld row');
select is(pg_temp.as_service(format($$select public.invitation_revocation_target('%s') ->> 'user_id'$$, pg_temp.id('new'))), pg_temp.u('f1')::text, 'only the invitee''s');
update auth.users set banned_until = now() + interval '100 years' where id = pg_temp.u('f1');
select is(pg_temp.as_service(format($$select public.reconcile_invitation('%s')::text$$, pg_temp.id('known'))),
  pg_temp.as_service(format($$select public.reconcile_invitation('%s')::text$$, pg_temp.id('new'))), 'both end revoked');
select is(pg_temp.entry(pg_temp.id('known')), pg_temp.entry(pg_temp.id('new')), 'and look the same in the list');
select is((select banned_until from auth.users where id = pg_temp.u('c1')), null, 'the account with that address was never banned');

-- ---------------------------------------------------------------------------
-- 8. claim_handle locks the invitation before deciding
-- ---------------------------------------------------------------------------
select ok((select position('for update' in prosrc) between 1 and position('invitation_onboarding_blocked' in prosrc)
  from pg_proc where oid = 'public.claim_handle(text)'::regprocedure), 'claim_handle takes the invitation''s row lock before it checks onboarding');

select * from finish();
rollback;
