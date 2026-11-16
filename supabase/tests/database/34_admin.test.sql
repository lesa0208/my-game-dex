-- M8d: the reads behind /admin and Settings → Security, the audit log's filters, the
-- otherwise unreachable recovery guard on accepting a transfer, and the review of how
-- factor registrations could be backdated. Runs in one transaction that rolls back,
-- on the local stack only; nothing here reaches hosted data.
begin;
create extension if not exists pgtap with schema extensions;
select plan(71);

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
-- As a signed-in user with no session or factor rows at all: an aal1 token.
create function pg_temp.as_aal1(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated', 'aal', 'aal1')::text, true);
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
create function pg_temp.two_factors(s text) returns void language plpgsql as $$
begin
  perform pg_temp.claims(pg_temp.u(s));
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values (gen_random_uuid(), pg_temp.u(s), 'second factor ' || gen_random_uuid(), 'totp', 'verified', now(), now());
end $$;
create function pg_temp.mature(s text) returns void language plpgsql as $$
begin
  delete from private.mfa_factor_registrations where user_id = pg_temp.u(s);
  insert into private.mfa_factor_registrations (factor_id, user_id, factor_created_at, registered_at)
  select f.id, f.user_id, f.created_at, now() - interval '25 hours' from auth.mfa_factors f where f.user_id = pg_temp.u(s) and f.status = 'verified';
end $$;
create function pg_temp.state() returns text language sql as $$
  select md5(coalesce((select string_agg(user_id || role::text, ',' order by user_id, role) from public.staff_roles), '')
    || coalesce((select string_agg(id || account_status::text, ',' order by id) from public.profiles), '')
    || coalesce((select string_agg(row(o.*)::text, ',') from private.platform_owner o), '')
    || coalesce((select string_agg(row(t.*)::text, ',' order by t.id) from private.ownership_transfers t), '')
    || coalesce((select string_agg(row(r.*)::text, ',' order by r.id) from private.owner_recoveries r), ''))
$$;

-- f1: the Owner. a2: an admin with two factors. d3: moderator. e4: catalog editor.
-- c5: collector. a6: an admin at aal1 only.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['f1', 'a2', 'd3', 'e4', 'c5', 'a6']) as s;
update public.profiles set handle = 'adm4_' || right(id::text, 2), handle_changed_at = now(), display_name = 'Person ' || right(id::text, 2);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('f1'), 'admin'), (pg_temp.u('a2'), 'admin'), (pg_temp.u('d3'), 'moderator'), (pg_temp.u('e4'), 'catalog_editor'), (pg_temp.u('a6'), 'admin');
insert into private.platform_owner (user_id) values (pg_temp.u('f1'));
select pg_temp.two_factors(s) from unnest(array['f1', 'a2']) s;
select pg_temp.claims(pg_temp.u(s)) from unnest(array['d3', 'e4', 'c5']) s;
select pg_temp.mature('f1');

-- ---------------------------------------------------------------------------
-- 1. What the caller may see in /admin (get_my_admin_access)
-- ---------------------------------------------------------------------------
create temporary table m8d_functions (fn text);
insert into m8d_functions values ('public.get_my_admin_access()'), ('public.get_staff_members()'), ('public.find_account_by_handle(text)'),
  ('public.get_ownership_status()'), ('public.get_my_factor_status()'), ('public.get_audit_events(integer,uuid,text,text,text,timestamptz,timestamptz)');
select is((select count(*)::int from m8d_functions f join pg_proc p on p.oid = f.fn::regprocedure
  where p.prosecdef and p.proconfig = array['search_path=""'] and p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres}'),
  6, 'each M8d read is SECURITY DEFINER with an empty search_path, and only authenticated may execute it');
select is((select count(*)::int from m8d_functions f, unnest(array['anon', 'service_role']) r where has_function_privilege(r, f.fn, 'execute')), 0, 'anon and service_role can execute none');
select is(pg_temp.as_user('c5', $$select (public.get_my_admin_access() - 'recent_mfa')::text$$),
  '{"mfa": true, "admin": false, "owner": false, "roles": [], "staff": false, "active": true, "editor": false, "moderator": false, "owner_authority": null, "recovery_pending": false, "transfer_offered": null, "recovery_to_confirm": null}',
  'a collector is told only that they are not staff');
select is(pg_temp.as_user('e4', $$select (public.get_my_admin_access() ->> 'staff') || '/' || (public.get_my_admin_access() ->> 'editor') || '/' || (public.get_my_admin_access() ->> 'admin') || '/' || (public.get_my_admin_access() ->> 'moderator')$$),
  'true/true/false/false', 'an editor is staff and an editor, nothing more');
select is(pg_temp.as_user('d3', $$select (public.get_my_admin_access() ->> 'moderator') || '/' || (public.get_my_admin_access() ->> 'editor')$$), 'true/false', 'a moderator is a moderator only');
select is(pg_temp.as_user('a2', $$select (public.get_my_admin_access() ->> 'admin') || '/' || (public.get_my_admin_access() ->> 'owner') || '/' || coalesce(public.get_my_admin_access() ->> 'owner_authority', 'none')$$),
  'true/false/none', 'an admin is an admin, not the Owner');
select is(pg_temp.as_user('f1', $$select (public.get_my_admin_access() ->> 'owner') || '/' || coalesce(public.get_my_admin_access() ->> 'owner_authority', 'none')$$), 'true/none', 'the Owner sees they hold Owner authority');
select is(pg_temp.as_aal1('a6', $$select (public.get_my_admin_access() ->> 'roles') || '/' || (public.get_my_admin_access() ->> 'staff') || '/' || (public.get_my_admin_access() ->> 'mfa')$$),
  '["admin"]/false/false', 'an admin at aal1 sees their own role, but isn''t staff until they verify');
select is(pg_temp.as_aal1('c5', $$select public.get_staff_members()::text$$), 'error: not permitted', 'and the staff reads refuse an aal1 session');
select set_config('request.jwt.claims', '', true);
select is(pg_temp.try($$select public.get_my_admin_access()$$), 'error: not permitted', 'nobody signed in, no answer');

-- ---------------------------------------------------------------------------
-- 2. Staff and accounts (get_staff_members, find_account_by_handle)
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('d3', $$select public.get_staff_members()::text$$), 'error: not permitted', 'a moderator can''t list the staff');
select is(pg_temp.as_user('e4', $$select public.get_staff_members()::text$$), 'error: not permitted', 'nor an editor');
select is(pg_temp.as_user('a2', $$select string_agg(x ->> 'handle' || ':' || (x -> 'roles')::text || ':' || (x ->> 'owner'), ', ' order by x ->> 'handle') from jsonb_array_elements(public.get_staff_members()) x$$),
  'adm4_a2:["admin"]:false, adm4_a6:["admin"]:false, adm4_d3:["moderator"]:false, adm4_e4:["catalog_editor"]:false, adm4_f1:["admin"]:true', 'an admin lists every staff member with their roles, the Owner marked');
select is(pg_temp.as_user('a2', $$select string_agg(distinct k, ',' order by k) from jsonb_array_elements(public.get_staff_members()) x, jsonb_object_keys(x) k$$),
  'account_status,display_name,handle,id,owner,roles,successor', 'and nothing else: no email');
select is(pg_temp.as_user('c5', $$select public.find_account_by_handle('adm4_e4')::text$$), 'error: not permitted', 'a collector can''t look anyone up');
select is(pg_temp.as_user('e4', $$select public.find_account_by_handle('adm4_c5')::text$$), 'error: not permitted', 'nor an editor');
select is(pg_temp.as_user('d3', $$select (public.find_account_by_handle('  ADM4_C5 ') - 'id')::text$$),
  '{"owner": false, "roles": [], "handle": "adm4_c5", "display_name": "Person c5", "account_status": "active"}', 'a moderator finds an account by its exact handle, with nothing private');
select is(pg_temp.as_user('d3', $$select coalesce(public.find_account_by_handle('adm4_c')::text, 'none')$$), 'none', 'a partial handle finds nothing (D11)');
select is(pg_temp.as_user('d3', $$select public.find_account_by_handle('c5@example.test')::text$$), 'error: invalid handle', 'an email isn''t a handle');
select is(pg_temp.as_user('d3', $$select (public.find_account_by_handle('adm4_f1') ->> 'owner')$$), 'true', 'the Owner is marked, so the page offers no action on them');

-- ---------------------------------------------------------------------------
-- 3. Ownership status, and the caller's own factors
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('d3', $$select public.get_ownership_status()::text$$), 'error: not permitted', 'only admins see the ownership status');
select is(pg_temp.as_user('a2', $$select (public.get_ownership_status() -> 'owner' ->> 'handle') || '/' || coalesce(public.get_ownership_status() ->> 'transfer', 'none') || '/' || coalesce(public.get_ownership_status() ->> 'recovery', 'none')$$),
  'adm4_f1/none/none', 'an admin sees who the Owner is, with nothing pending');
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.register_succession_document(repeat('ab', 32), 'Signed'))$$), 'changed', 'setup: the Owner registers a document');
select is(pg_temp.as_user('a2', $$select (public.get_ownership_status()::text like '%abab%')::text || '/' || (public.get_ownership_status() ->> 'document_registered_at' is not null)::text$$),
  'false/true', 'admins see that a document is registered, never its fingerprint');
select is(pg_temp.as_user('a2', $$select public.get_ownership_status() ->> 'security_changed'$$), 'true', 'and that the Owner''s factors changed in the last 24 hours (A1)');
select is(pg_temp.as_user('f1', $$select string_agg((x ->> 'status') || ':' || (x ->> 'mature'), ',' order by x ->> 'created_at') from jsonb_array_elements(public.get_my_factor_status()) x$$),
  'verified:true,verified:true', 'the Owner sees two verified, mature factors');
select is(pg_temp.as_user('f1', $$select string_agg(distinct k, ',' order by k) from jsonb_array_elements(public.get_my_factor_status()) x, jsonb_object_keys(x) k$$),
  'created_at,friendly_name,id,mature,matures_at,registered_at,status', 'and nothing else: no secret');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), pg_temp.u('a2'), 'unfinished', 'totp', 'unverified', now(), now());
select is(pg_temp.as_user('a2', $$select string_agg((x ->> 'status') || ':' || (x ->> 'mature') || ':' || coalesce(x ->> 'registered_at', 'unregistered'), ',' order by x ->> 'friendly_name') from jsonb_array_elements(public.get_my_factor_status()) x$$),
  'verified:false:unregistered,verified:false:unregistered,unverified:false:unregistered', 'an admin''s unregistered and unverified factors are shown as not mature');
select is(pg_temp.as_user('c5', $$select string_agg(x ->> 'friendly_name', ',') from jsonb_array_elements(public.get_my_factor_status()) x$$), 'test session factor', 'each caller sees only their own factors');

-- ---------------------------------------------------------------------------
-- 4. The audit log's filters (get_audit_events, replaced per A2)
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'Filter test'))$$), 'changed', 'setup: an audited grant');
select is(pg_temp.as_user('a2', $$select pg_temp.res(public.grant_staff_role(pg_temp.u('c5'), 'admin', 'Filter test'))$$), 'refused: owner_only', 'setup: and an audited refusal');
select is(pg_temp.as_user('a2', $$select string_agg(action || '/' || outcome || '/' || actor_handle || '/' || target_handle, ', ' order by action) from public.get_audit_events(100, null, null, 'adm4_a2')$$),
  'staff_change_refused/refused/adm4_a2/adm4_c5, staff_role_granted/succeeded/adm4_a2/adm4_c5', 'filtered by actor, with handles instead of ids');
select is(pg_temp.as_user('a2', $$select count(*)::text from public.get_audit_events(100, null, 'staff_role_granted', null, 'adm4_c5')$$), '1', 'by action and target');
select is(pg_temp.as_user('a2', $$select count(*)::text from public.get_audit_events(100, null, null, 'nobody_here')$$), '0', 'an unknown handle matches nothing');
select is(pg_temp.as_user('a2', $$select count(*)::text from public.get_audit_events(100, null, null, null, null, now() + interval '1 second')$$), '0', 'and a range in the future nothing');
select is(pg_temp.as_user('a2', $$select count(*)::text from public.get_audit_events(100, null, null, 'adm4_a2', null, now() - interval '1 minute', now() + interval '1 minute')$$),
  (select count(*)::text from private.audit_events where actor_id = pg_temp.u('a2')), 'a range around now finds what happened now');
select is(pg_temp.as_user('a2', $$select count(*)::text from public.get_audit_events(100, null, 'not_an_action')$$), 'error: invalid filter', 'an unknown action is refused');
select is(pg_temp.as_user('a2', $$select count(*)::text from public.get_audit_events(100, null, null, null, null, now(), now() - interval '1 day')$$), 'error: invalid filter', 'as is a range that ends before it starts');
select is(pg_temp.as_user('a2', $$select count(*)::text from public.get_audit_events(100, null, null, null, null, now() - interval '400 days', now())$$), 'error: invalid filter', 'or spans more than a year');
select is(pg_temp.as_user('a2', $$select count(*)::text from public.get_audit_events(100, null, null, repeat('x', 25))$$), 'error: invalid filter', 'or names a handle longer than any');
select is(pg_temp.as_user('a2', $$select count(*)::text from public.get_audit_events(101)$$), 'error: invalid page request', 'pages stay at 100 rows at most');
select is(pg_temp.as_user('d3', $$select count(*)::text from public.get_audit_events()$$), 'error: not permitted', 'a moderator still can''t read the log');
select is((select count(*)::int from pg_proc p where p.proname = 'get_audit_events'), 1, 'only the new get_audit_events exists');

-- ---------------------------------------------------------------------------
-- 5. The recovery guard on accepting a transfer (M8c risk, PO requirement 2).
--    Opening a recovery cancels every pending transfer, so this state can't arise
--    through the functions; postgres builds it directly, inside this transaction.
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('f1', $$select pg_temp.res(public.start_ownership_transfer(pg_temp.u('a2'), 'Isolated test'))$$), 'changed', 'setup: the Owner offers ownership to a2');
insert into private.owner_recoveries (kind, owner_id, target_id, case_ref, hold_until)
values ('factor_reset', pg_temp.u('f1'), pg_temp.u('f1'), 'Isolated recovery_pending test', now() + interval '72 hours');
select is((select count(*)::int from private.ownership_transfers where status = 'pending') || '/' || (select count(*) from private.owner_recoveries where status = 'pending'), '1/1',
  'setup: a pending transfer and a pending recovery at once, which the functions never produce');
create temporary table before_guard as
  select pg_temp.state() as state, (select row(r.*)::text from private.owner_recoveries r) as recovery, (select count(*) from private.audit_events) as audits;
create temporary table guard_result as
  select pg_temp.as_user('a2', format($f$select public.accept_ownership_transfer(%L)::text$f$, (select id from private.ownership_transfers where status = 'pending')))::jsonb as r;
select is((select pg_temp.res(r) from guard_result), 'refused: recovery_pending', 'accepting is refused with recovery_pending');
select is((select string_agg(k, ',' order by k) from guard_result, jsonb_object_keys(r) k), 'audit_id,ok,refusal', 'in the JSONB refusal contract (A4)');
select is((select right(user_id::text, 2) || '/' || version from private.platform_owner), 'f1/1', 'ownership is unchanged');
select is(pg_temp.state(), (select state from before_guard), 'no role, status, Owner record, transfer or recovery changed');
select is((select row(r.*)::text from private.owner_recoveries r), (select recovery from before_guard), 'the recovery record is exactly as it was');
select is((select count(*) from private.audit_events) - (select audits from before_guard), 1::bigint, 'the only write is one audit row');
select is((select action::text || '/' || outcome || '/' || reason || '/' || right(actor_id::text, 2) || '/' || (metadata ->> 'operation') from private.audit_events e, guard_result g where e.id = (g.r ->> 'audit_id')::uuid),
  'staff_change_refused/refused/Refused: recovery_pending/a2/accept_ownership_transfer', 'which is the refusal, by the target, naming the operation');
delete from private.owner_recoveries;
delete from private.ownership_transfers;

-- ---------------------------------------------------------------------------
-- 6. Backdating factor registrations (PO requirement 3). Only postgres can, as the
--    tests do; nothing an application can reach takes or writes a registration time.
-- ---------------------------------------------------------------------------
select is((select string_agg(p.oid::regprocedure::text, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+private\.mfa_factor_registrations'),
  'register_my_verified_factors()', 'one function writes registrations, and only by inserting');
select is((select pronargs::int from pg_proc where oid = 'public.register_my_verified_factors()'::regprocedure), 0, 'it takes no argument, so no client-supplied time');
select ok((select prosrc ~ 'f\.created_at, pg_catalog\.now\(\)' and prosrc !~ 'interval' from pg_proc where oid = 'public.register_my_verified_factors()'::regprocedure), 'and records the server''s now(), never an earlier time');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
  where has_table_privilege(r, 'private.mfa_factor_registrations', p)), 0, 'no API role has any privilege on the registrations');
select is(pg_temp.as_user('c5', $$select count(*)::text from private.mfa_factor_registrations$$), 'error: permission denied for schema private', 'a signed-in user can''t reach the table');
select is(pg_temp.as_user('c5', $$insert into private.mfa_factor_registrations values (gen_random_uuid(), (select auth.uid()), now(), now() - interval '2 days') returning 'inserted'$$),
  'error: permission denied for schema private', 'nor insert a backdated one');
select is(pg_temp.try($$update private.mfa_factor_registrations set registered_at = now() - interval '2 days'$$), 'error: factor registrations are permanent', 'even postgres can''t move a registration back: it''s immutable');
select is((select string_agg(tgname || '=' || tgenabled::text, ',') from pg_trigger where tgrelid = 'private.mfa_factor_registrations'::regclass and not tgisinternal), 'mfa_factor_registrations_immutable=O', 'the immutability trigger is enabled');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_temp' and n.nspname !~ '^pg_toast'
  and p.prosrc ~* 'mfa_factor_registrations' and p.prosrc ~* 'interval\s+''2[45] hours''' and p.prosrc ~* 'insert'), 0, 'no deployed function can insert a backdated registration');
select is(pg_temp.as_user('a2', $$select public.register_my_verified_factors()::text$$), '2', 'a2 registers their two verified factors');
select is((select count(*)::int from private.mfa_factor_registrations where user_id = pg_temp.u('a2') and registered_at = now()), 2, 'at the server''s time');
select is((select count(*)::int from private.mfa_factor_registrations r join auth.mfa_factors f on f.id = r.factor_id where f.status = 'unverified'), 0, 'the unverified factor isn''t registered');
-- Maturity is the database's, at 24 hours exactly, on live verified factors only.
create function pg_temp.registered_ago(p_fid uuid, p_age interval) returns void language sql as $$
  delete from private.mfa_factor_registrations where factor_id = p_fid;
  insert into private.mfa_factor_registrations (factor_id, user_id, factor_created_at, registered_at)
  select f.id, f.user_id, f.created_at, now() - p_age from auth.mfa_factors f where f.id = p_fid
$$;
select pg_temp.registered_ago(id, interval '23 hours 59 minutes') from auth.mfa_factors where user_id = pg_temp.u('a2') and status = 'verified';
select is(private.mature_totp_factor_count(pg_temp.u('a2')), 0, 'registered 23 h 59 min ago: not mature');
select pg_temp.registered_ago(id, interval '24 hours 1 minute') from auth.mfa_factors where user_id = pg_temp.u('a2') and status = 'verified';
select is(private.mature_totp_factor_count(pg_temp.u('a2')), 2, 'after 24 hours: mature');
update auth.mfa_factors set status = 'unverified' where user_id = pg_temp.u('a2') and id <> pg_temp.u('a2') and status = 'verified';
select is(private.mature_totp_factor_count(pg_temp.u('a2')), 1, 'a factor that is no longer verified doesn''t count, whatever its registration');
create temporary table removed_factor as select id, created_at from auth.mfa_factors where user_id = pg_temp.u('a2') and id <> pg_temp.u('a2') and friendly_name like 'second factor%';
delete from auth.mfa_factors where id in (select id from removed_factor);
select is((select count(*)::int from private.mfa_factor_registrations where factor_id in (select id from removed_factor)), 1, 'setup: a removed factor leaves its registration behind');
select is(private.mature_totp_factor_count(pg_temp.u('a2')), 1, 'which counts for nothing');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
select id, pg_temp.u('a2'), 'replacement', 'totp', 'verified', created_at + interval '1 second', now() from removed_factor;
select is(private.mature_totp_factor_count(pg_temp.u('a2')), 1, 'a replacement under the same id doesn''t inherit the old registration');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values (pg_temp.u('ee'), pg_temp.u('c5'), 'moved', 'totp', 'verified', now() - interval '3 days', now());
insert into private.mfa_factor_registrations (factor_id, user_id, factor_created_at, registered_at) values (pg_temp.u('ee'), pg_temp.u('a2'), now() - interval '3 days', now() - interval '2 days');
select is(private.mature_totp_factor_count(pg_temp.u('a2')) || '/' || private.mature_totp_factor_count(pg_temp.u('c5')), '1/0', 'a registration in another user''s name counts for neither');

select * from finish();
rollback;
