-- M11a-1: invitations and the invitee's onboarding. Who may call each function, what it
-- returns and never returns, the limits, resending, revocation and reconciliation (which
-- read Auth's own records), the password marker and the onboarding gate in claim_handle.
-- Runs in one transaction that rolls back, on a local stack only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(87);

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
-- A TOTP-verified session for p_user, verified p_age ago (fresh: zero; stale: 20 minutes).
create function pg_temp.session(p_user uuid, p_age interval) returns jsonb language plpgsql as $mfa$
begin
  insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    select p_user, p_user, 'Factor', 'totp', 'verified', now() - interval '3 days', now()
    where not exists (select 1 from auth.mfa_factors where id = p_user);
  if not exists (select 1 from auth.mfa_amr_claims where session_id = p_user) then
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values (gen_random_uuid(), p_user, 'totp', now() - p_age, now() - p_age);
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user);
end $mfa$;
create function pg_temp.as_at(p_actor text, p_age interval, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.session(pg_temp.u(p_actor), p_age)::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language sql as $$ select pg_temp.as_at(p_actor, interval '0', p_sql) $$;
-- A plain password session (aal1, no MFA), as an invitee or collector has.
create function pg_temp.as_plain(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.plain(pg_temp.u(p_actor))::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.as_anon(p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  perform set_config('role', 'anon', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
-- The server's secret key (service_role), as features/auth-admin/server does.
create function pg_temp.as_service(p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  perform set_config('role', 'service_role', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.res(j text) returns text language sql as $$
  select case when j like 'error:%' then j else coalesce((j::jsonb ->> 'result'), 'refused: ' || (j::jsonb ->> 'refusal')) end $$;
create function pg_temp.inv(p_email text) returns private.account_invitations language sql as $$ select * from private.account_invitations where email = p_email and not withheld $$;

-- a1: administrator. a2: administrator whose verification is 20 minutes old. b1: moderator.
-- e1: catalog editor. c1: collector. Invitees d1..d4 are created as Auth does for an invite.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@staff.example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'a2', 'b1', 'e1', 'c1']) s;
update public.profiles set handle = 'inv_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['a1', 'a2', 'b1', 'e1', 'c1']) s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('a1'), 'admin'), (pg_temp.u('a2'), 'admin'), (pg_temp.u('b1'), 'moderator'), (pg_temp.u('e1'), 'catalog_editor');
create function pg_temp.invitee(s text, p_email text) returns void language sql as $$
  insert into auth.users (id, aud, role, email, invited_at, instance_id)
  values (pg_temp.u(s), 'authenticated', 'authenticated', p_email, now(), '00000000-0000-0000-0000-000000000000') $$;

-- ---------------------------------------------------------------------------
-- 1. Definitions and grants
-- ---------------------------------------------------------------------------
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r, unnest(array['select', 'insert', 'update', 'delete']) p
  where has_table_privilege(r, 'private.account_invitations', p)), 0, 'no API role has any privilege on the ledger');
select is((select relrowsecurity from pg_class where oid = 'private.account_invitations'::regclass), true, 'and it has RLS on');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  and p.proname in ('create_account_invitation', 'record_invitation_delivery', 'request_invitation_resend', 'request_invitation_revocation',
    'retry_invitation_revocation', 'reconcile_invitation', 'get_account_invitations', 'get_my_onboarding', 'complete_my_password_setup',
    'invitation_delivery_plan', 'invitation_revocation_target')
  and p.prosecdef and p.proconfig = array['search_path=""']), 11, 'the eleven functions are SECURITY DEFINER with an empty search_path');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'service_role', 'catalog_importer']) r,
  unnest(array['public.create_account_invitation(text,text)', 'public.request_invitation_resend(uuid,text)',
    'public.request_invitation_revocation(uuid,text)', 'public.retry_invitation_revocation(uuid)',
    'public.get_account_invitations(integer,uuid)', 'public.get_my_onboarding()', 'public.complete_my_password_setup()']) f), false,
  'anon, service_role and the importer can execute none of the session functions (the server''s steps are separate, M11a-2)');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'authenticated', 'service_role']) r,
  unnest(array['private.mask_email(text)', 'private.invitation_for_user(uuid)', 'private.invitation_onboarding_blocked(uuid)',
    'private.outstanding_invitations(uuid)', 'private.normalize_invitation_email(text)']) f), false, 'and none of the private helpers');

-- ---------------------------------------------------------------------------
-- 2. Who may call
-- ---------------------------------------------------------------------------
select is(pg_temp.as_anon($$select public.create_account_invitation('x@example.test', 'r')::text$$), 'error: permission denied for function create_account_invitation', 'anon is refused by the grant');
select is(pg_temp.as_user('c1', $$select public.create_account_invitation('x@example.test', 'r')::text$$), 'error: not permitted', 'a collector can''t invite');
select is(pg_temp.as_user('e1', $$select public.create_account_invitation('x@example.test', 'r')::text$$), 'error: not permitted', 'nor a catalog editor');
select is(pg_temp.as_user('b1', $$select public.create_account_invitation('x@example.test', 'r')::text$$), 'error: not permitted', 'nor a moderator');
select is(pg_temp.as_plain('a1', $$select public.create_account_invitation('x@example.test', 'r')::text$$), 'error: not permitted', 'nor an administrator without a verified session');
select is(pg_temp.as_at('a2', interval '20 minutes', $$select public.create_account_invitation('x@example.test', 'r')::text$$), 'error: reauthentication required', 'and an administrator verified 20 minutes ago must verify again');
select is(pg_temp.as_at('a2', interval '20 minutes', $$select public.request_invitation_resend(gen_random_uuid(), 'r')::text$$), 'error: reauthentication required', 'to resend');
select is(pg_temp.as_at('a2', interval '20 minutes', $$select public.request_invitation_revocation(gen_random_uuid(), 'r')::text$$), 'error: reauthentication required', 'and to revoke');
select is(pg_temp.as_at('a2', interval '20 minutes', $$select jsonb_typeof(public.get_account_invitations() -> 'invitations')$$), 'array', 'reading the list needs only a live verified session');
select is(pg_temp.as_user('b1', $$select public.get_account_invitations()::text$$), 'error: not permitted', 'which a moderator doesn''t get');
select is(pg_temp.as_anon($$select public.get_my_onboarding()::text$$), 'error: permission denied for function get_my_onboarding', 'anon has no onboarding to read');

-- ---------------------------------------------------------------------------
-- 3. Creating
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('a1', $$select public.create_account_invitation('not-an-address', 'Beta')::text$$), 'error: invalid email', 'an address must look like one');
select is(pg_temp.as_user('a1', $$select public.create_account_invitation('one@example.test', '  ')::text$$), 'error: reason required', 'and needs a reason');
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.create_account_invitation('  One@Example.TEST ', 'Beta tester')::text$$)), 'accepted', 'an administrator invites');
select is((pg_temp.inv('one@example.test')).state, 'pending', 'recorded as pending, before anything is sent, with the address normalized');
select is((pg_temp.inv('one@example.test')).invited_by, pg_temp.u('a1'), 'and who invited');
select is((select metadata ->> 'status' from private.audit_events where action = 'account_invited' order by id desc limit 1), 'pending', 'audited');
select is((select count(*)::int from private.audit_events where action::text like 'account_invit%' and (reason || metadata::text) ~ 'example\.test'), 0, 'and no audit row holds an address');
select is(pg_temp.as_user('a1', $$select (public.create_account_invitation('one@example.test', 'Again') ?| array['id'])::text$$), 'true', 'a second invitation to an open address gets the same answer, with an id (M11a-2)');
select is((select count(*)::int from private.account_invitations where email = 'one@example.test' and withheld), 1, 'as a withheld row, for which nothing is sent');
select is(pg_temp.as_user('a1', $$select (public.create_account_invitation('c1@staff.example.test', 'Existing') ->> 'result')$$), 'accepted', 'an address with an account gets the same answer too');
select is((select count(*)::int from private.account_invitations where email = 'c1@staff.example.test' and withheld), 1, 'and a withheld row');
select is((select metadata - 'withheld' from private.audit_events where action = 'account_invited' order by id desc limit 1), '{"status": "pending"}'::jsonb, 'audited like any invitation, the withheld mark kept from pages');

-- ---------------------------------------------------------------------------
-- 4. Delivery: the server's report is checked against Auth
-- ---------------------------------------------------------------------------
create temp table ids as select (pg_temp.inv('one@example.test')).id as one;
grant select on ids to authenticated, service_role;
create temp table inv_ids (email text primary key, id uuid);
grant select on inv_ids to authenticated, service_role;
create function pg_temp.remember(p_email text) returns void language sql as $$
  insert into inv_ids select p_email, (pg_temp.inv(p_email)).id on conflict (email) do update set id = excluded.id $$;
select is(pg_temp.res(pg_temp.as_service($$select public.record_invitation_delivery((select one from ids), 'invite', 'sent')::text$$)), 'send_failed', 'a claimed send with no invited account in Auth is recorded as failed');
select pg_temp.invitee('d1', 'one@example.test');
select is(pg_temp.res(pg_temp.as_service($$select public.record_invitation_delivery((select one from ids), 'invite', 'sent')::text$$)), 'sent', 'once Auth holds the invited account, the send is recorded');
select is((pg_temp.inv('one@example.test')).invited_user_id, pg_temp.u('d1'), 'and the account is linked, found by the database, not given by the server');
select is(pg_temp.as_service($$select public.record_invitation_delivery((select one from ids), 'other', 'sent')::text$$), 'error: invalid invitation', 'an unknown operation is refused');

-- ---------------------------------------------------------------------------
-- 5. Resending
-- ---------------------------------------------------------------------------
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.request_invitation_resend((select one from ids), 'Lost it')::text$$)), 'refused: resend_too_soon', 'not within 10 minutes of the last email');
update private.account_invitations set last_sent_at = now() - interval '11 minutes' where email = 'one@example.test';
select is(pg_temp.as_user('a1', $$select public.request_invitation_resend((select one from ids), 'Lost it')::text$$), '{"ok": true, "result": "resend"}', 'after 10 minutes it''s allowed, with nothing about the address (the server asks for it, M11a-2)');
select is((pg_temp.inv('one@example.test')).resend_count, 1, 'counted when asked');
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.request_invitation_resend((select one from ids), 'Again')::text$$)), 'refused: resend_too_soon', 'and asking again at once is refused');
update private.account_invitations set last_sent_at = now() - interval '1 hour', last_resend_requested_at = now() - interval '1 hour', resend_count = 5 where email = 'one@example.test';
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.request_invitation_resend((select one from ids), 'Again')::text$$)), 'refused: resend_limit', 'five resends at most');
update private.account_invitations set resend_count = 0 where email = 'one@example.test';
update auth.users set email_confirmed_at = now() where id = pg_temp.u('d1');
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.request_invitation_resend((select one from ids), 'Again')::text$$)), 'refused: already_accepted', 'and none once the invitation is accepted');
select is((select metadata ->> 'resend' from private.audit_events where action = 'account_invitation_resent' order by id desc limit 1), '1', 'a resend is audited');

-- ---------------------------------------------------------------------------
-- 6. The invitee's onboarding and the password marker
-- ---------------------------------------------------------------------------
select is(pg_temp.as_plain('d1', $$select public.get_my_onboarding()::text$$), '{"invited": true, "revoked": false, "password_set": false}', 'the invitee sees their own onboarding state');
select is(pg_temp.as_plain('c1', $$select public.get_my_onboarding()::text$$), '{"invited": false, "revoked": false, "password_set": false}', 'an account that wasn''t invited isn''t an invitee');
select is(pg_temp.as_plain('d1', $$select public.claim_handle('invitee_one')$$), 'error: account not eligible', 'an invitee can''t claim a handle before setting a password');
select is(pg_temp.res(pg_temp.as_plain('d1', $$select public.complete_my_password_setup()::text$$)), 'refused: password_not_set', 'the marker needs Auth''s record of a password change');
insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), json_build_object('action', 'user_updated_password', 'actor_id', pg_temp.u('d1')), now() - interval '1 day', '');
select is(pg_temp.res(pg_temp.as_plain('d1', $$select public.complete_my_password_setup()::text$$)), 'refused: password_not_set', 'a change from before the invitation was accepted doesn''t count');
insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), json_build_object('action', 'user_updated_password', 'actor_id', pg_temp.u('c1')), now(), '');
select is(pg_temp.res(pg_temp.as_plain('d1', $$select public.complete_my_password_setup()::text$$)), 'refused: password_not_set', 'nor someone else''s');
select is(pg_temp.res(pg_temp.as_plain('c1', $$select public.complete_my_password_setup()::text$$)), 'refused: not_invited', 'and that someone has no invitation to mark');
insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), json_build_object('action', 'user_updated_password', 'actor_id', pg_temp.u('d1')), now(), '');
select is(pg_temp.res(pg_temp.as_plain('d1', $$select public.complete_my_password_setup()::text$$)), 'recorded', 'after Auth records the invitee''s own change, the marker is set');
select is(pg_temp.res(pg_temp.as_plain('d1', $$select public.complete_my_password_setup()::text$$)), 'unchanged', 'and repeating it changes nothing');
select is((pg_temp.inv('one@example.test')).password_set_at is not null, true, 'the marker is on the ledger, where only this function writes it');
select is(pg_temp.as_plain('d1', $$select public.claim_handle('invitee_one')$$), 'invitee_one', 'then the handle can be claimed');
select is(pg_temp.as_plain('c1', $$select public.get_my_onboarding() ->> 'password_set'$$), 'false', 'and no one else''s state moved');

-- ---------------------------------------------------------------------------
-- 7. Revocation
-- ---------------------------------------------------------------------------
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.request_invitation_revocation((select one from ids), 'Mistake')::text$$)), 'refused: already_active', 'an invitee with a handle has an account: suspend it instead');
select pg_temp.as_user('a1', $$select public.create_account_invitation('two@example.test', 'Beta')::text$$);
select pg_temp.invitee('d2', 'two@example.test');
select pg_temp.remember('two@example.test');
select pg_temp.as_service($$select public.record_invitation_delivery((select id from inv_ids where email = 'two@example.test'), 'invite', 'sent')::text$$);
create temp view two as select id from private.account_invitations where email = 'two@example.test';
grant select on two to authenticated, service_role;
select is(pg_temp.as_user('a1', $$select public.request_invitation_revocation((select id from two), 'Wrong person')::text$$),
  '{"ok": true, "result": "revoke_pending"}', 'revocation is recorded first, returning nothing about the account');
select is(pg_temp.as_service($$select public.invitation_revocation_target((select id from two)) ->> 'user_id'$$), pg_temp.u('d2')::text, 'which only the server''s step names, for banning');
select is((select metadata ->> 'status' from private.audit_events where action = 'account_invitation_revoke_requested' order by id desc limit 1), 'revoke_pending', 'and audited before anything changes in Auth');
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.request_invitation_revocation((select id from two), 'Again')::text$$)), 'unchanged', 'asking again changes nothing');
select is(pg_temp.res(pg_temp.as_service($$select public.reconcile_invitation((select id from two))::text$$)), 'revoke_pending', 'without a ban in Auth, it stays pending');
select is(pg_temp.as_user('a1', $$select public.retry_invitation_revocation((select id from two))::text$$), '{"ok": true, "result": "revoke_pending"}', 'and it can be retried, again naming no account');
-- Meanwhile the invitee accepts with a token issued before the ban, and sets a password.
update auth.users set email_confirmed_at = now() where id = pg_temp.u('d2');
insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), json_build_object('action', 'user_updated_password', 'actor_id', pg_temp.u('d2')), now() + interval '1 second', '');
select is(pg_temp.res(pg_temp.as_plain('d2', $$select public.complete_my_password_setup()::text$$)), 'refused: invitation_revoked', 'a revoke-pending invitee can''t record a password');
select is(pg_temp.as_plain('d2', $$select public.claim_handle('invitee_two')$$), 'error: account not eligible', 'nor claim a handle, so onboarding can''t finish');
select is(pg_temp.as_plain('d2', $$select public.get_my_onboarding() ->> 'revoked'$$), 'true', 'and is told it was revoked');
update auth.users set banned_until = now() + interval '100 years' where id = pg_temp.u('d2');
select is(pg_temp.res(pg_temp.as_service($$select public.reconcile_invitation((select id from two))::text$$)), 'revoked_after_acceptance', 'with the ban in Auth, an invitee who accepted first is recorded as revoked after acceptance');
select is((select count(*)::int from auth.users where id = pg_temp.u('d2')), 1, 'and the account isn''t deleted');
select is((select metadata ->> 'status' from private.audit_events where action = 'account_invitation_revoked' order by id desc limit 1), 'revoked_after_acceptance', 'the outcome is audited');
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.retry_invitation_revocation((select id from two))::text$$)), 'refused: invitation_closed', 'a completed revocation can''t be retried');
-- An invitee who never accepted.
select pg_temp.as_user('a1', $$select public.create_account_invitation('three@example.test', 'Beta')::text$$);
select pg_temp.remember('three@example.test');
select pg_temp.invitee('d3', 'three@example.test');
select pg_temp.as_service($$select public.record_invitation_delivery((select id from inv_ids where email = 'three@example.test'), 'invite', 'sent')::text$$);
select pg_temp.as_user('a1', $$select public.request_invitation_revocation((select id from inv_ids where email = 'three@example.test'), 'No longer needed')::text$$);
update auth.users set banned_until = now() + interval '100 years' where id = pg_temp.u('d3');
select is(pg_temp.res(pg_temp.as_service($$select public.reconcile_invitation((select id from inv_ids where email = 'three@example.test'))::text$$)), 'revoked', 'an unaccepted, banned invitee is revoked');
-- An invitation never sent.
select pg_temp.as_user('a1', $$select public.create_account_invitation('four@example.test', 'Beta')::text$$);
select pg_temp.remember('four@example.test');
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.request_invitation_revocation((select id from inv_ids where email = 'four@example.test'), 'Not sent')::text$$)), 'revoke_pending', 'a revocation with no Auth account answers the same way');
select is(pg_temp.res(pg_temp.as_service($$select public.reconcile_invitation((select id from inv_ids where email = 'four@example.test'))::text$$)), 'revoked', 'and completes at reconciliation, with nothing to ban');
-- The server sent it anyway, while the revocation was recorded.
select pg_temp.invitee('d4', 'four@example.test');
select is(pg_temp.as_service($$select public.record_invitation_delivery((select id from inv_ids where email = 'four@example.test'), 'invite', 'sent') ->> 'user_id'$$), pg_temp.u('d4')::text,
  'a send that lands after the revocation returns the new account for banning');
select is((pg_temp.inv('four@example.test')).state, 'revoke_pending', 'and the revocation goes back to pending until that ban is confirmed');
select is(pg_temp.as_plain('d4', $$select public.claim_handle('invitee_four')$$), 'error: account not eligible', 'meanwhile that account can''t onboard');
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.request_invitation_resend((select id from inv_ids where email = 'three@example.test'), 'Again')::text$$)), 'refused: invitation_closed', 'a revoked invitation can''t be resent');
-- An invitee who set a password but hasn't chosen a handle, then is revoked.
select pg_temp.as_user('a1', $$select public.create_account_invitation('five@example.test', 'Beta')::text$$);
select pg_temp.remember('five@example.test');
select pg_temp.invitee('d5', 'five@example.test');
select pg_temp.as_service($$select public.record_invitation_delivery((select id from inv_ids where email = 'five@example.test'), 'invite', 'sent')::text$$);
update auth.users set email_confirmed_at = now() where id = pg_temp.u('d5');
insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), json_build_object('action', 'user_updated_password', 'actor_id', pg_temp.u('d5')), now() + interval '1 second', '');
select is(pg_temp.res(pg_temp.as_plain('d5', $$select public.complete_my_password_setup()::text$$)), 'recorded', 'an invitee sets a password');
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.request_invitation_revocation((select id from inv_ids where email = 'five@example.test'), 'Changed our minds')::text$$)), 'revoke_pending',
  'and is revoked before choosing a handle');
select is(pg_temp.as_plain('d5', $$select public.claim_handle('invitee_five')$$), 'error: account not eligible', 'a password doesn''t let a revoked invitee claim a handle');

-- ---------------------------------------------------------------------------
-- 8. The list
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('a1', $$select string_agg(x ->> 'email', ',' order by x ->> 'email') from jsonb_array_elements(public.get_account_invitations() -> 'invitations') x$$),
  'c***@s***.test,f***@e***.test,f***@e***.test,o***@e***.test,o***@e***.test,t***@e***.test,t***@e***.test', 'addresses are masked');
select is(pg_temp.as_user('a1', $$select public.get_account_invitations()::text$$) ~ '@example\.test|Beta tester|Wrong person', false, 'no address or reason appears');
select is(pg_temp.as_user('a1', $$select string_agg(distinct k, ',' order by k) from jsonb_array_elements(public.get_account_invitations() -> 'invitations') x, jsonb_object_keys(x) k$$),
  'created_at,email,id,invited_by,last_sent_at,next_resend_at,resends_left,revoked_at,status', 'each entry has fixed keys: no account id');
select is(pg_temp.as_user('a1', $$select string_agg(x ->> 'status', ',' order by x ->> 'id') from jsonb_array_elements(public.get_account_invitations() -> 'invitations') x$$),
  'active,sending,sending,revoked_after_acceptance,revoked,revoke_pending,revoke_pending', 'each with its status, from the ledger and Auth');
update private.account_invitations set state = 'sent', last_sent_at = now() - interval '2 hours' where email = 'three@example.test';
update auth.users set banned_until = null where id = pg_temp.u('d3');
select is(pg_temp.as_user('a1', $$select x ->> 'status' from jsonb_array_elements(public.get_account_invitations() -> 'invitations') x where x ->> 'email' = 't***@e***.test' and x ->> 'status' in ('sent', 'expired')$$),
  'expired', 'an unaccepted invitation older than an hour shows as expired');
select is(pg_temp.as_user('a1', $$select (public.get_account_invitations() -> 'limits')::text$$), '{"mine": 4, "total": 4, "mine_max": 20, "total_max": 200}', 'with the open counts and limits');

-- ---------------------------------------------------------------------------
-- 9. Limits
-- ---------------------------------------------------------------------------
insert into private.account_invitations (email, invited_by, reason)
select 'bulk' || g || '@example.test', pg_temp.u('a1'), 'Bulk' from generate_series(1, 16) g;
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.create_account_invitation('over@example.test', 'One too many')::text$$)), 'refused: invitation_limit', '20 open invitations per administrator');
insert into private.account_invitations (email, invited_by, reason)
select 'many' || g || '@example.test', pg_temp.u('a2'), 'Bulk' from generate_series(1, 190) g;
update private.account_invitations set state = 'revoked' where email like 'bulk1%';
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.create_account_invitation('c1@staff.example.test', 'Existing')::text$$)), 'refused: invitation_limit_total', 'an address with an account meets the same limits (M11a-2)');
select is(pg_temp.res(pg_temp.as_user('a1', $$select public.create_account_invitation('over@example.test', 'One too many')::text$$)), 'refused: invitation_limit_total', 'and 200 in all');
select is(pg_temp.as_user('a1', $$select (public.get_account_invitations(1000) -> 'invitations') is not null and jsonb_array_length(public.get_account_invitations(1000) -> 'invitations') <= 100$$), 'true', 'a page holds at most 100');

-- ---------------------------------------------------------------------------
-- 10. The audit log shows invitations under accounts, with allow-listed details
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('a1', $$select count(*)::text from jsonb_array_elements(public.get_audit_log(100, null, null, 'accounts')) x where x ->> 'action' like 'account_invit%'$$) <> '0', true, 'invitation events are in the accounts kind');
select is(pg_temp.as_user('a1', $$select public.get_audit_log(100, null, null, 'accounts')::text$$) ~ 'example\.test', false, 'and carry no address');

select * from finish();
rollback;
