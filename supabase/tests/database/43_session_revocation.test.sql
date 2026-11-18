-- M11a session revocation: owner-scoped reads and writes need the token's session to be
-- one Auth still has (private.session_is_live). Public reads don't. The real sign-out,
-- reset and change flows, concurrency and the catalog are tested against Auth in
-- scripts/db-session-checks.mjs. Runs in one transaction that rolls back, on a local stack only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.sid(s text) returns uuid language sql immutable as $$ select ('5e550000-0000-4000-8000-0000000000' || s)::uuid $$;
-- Runs p_sql as signed-in p_user with the given claims; the error text if it raises.
create function pg_temp.run(p_claims jsonb, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', p_claims::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.claims(p_user text, p_session text) returns jsonb language sql as $$
  select jsonb_build_object('sub', pg_temp.u(p_user), 'role', 'authenticated', 'aal', 'aal1', 'session_id', pg_temp.sid(p_session)) $$;
create function pg_temp.as_live(p_sql text) returns text language sql as $$ select pg_temp.run(pg_temp.claims('a1', 'a1'), p_sql) $$;
create function pg_temp.as_ended(p_sql text) returns text language sql as $$ select pg_temp.run(pg_temp.claims('a1', 'a2'), p_sql) $$;

insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', 'rev-' || s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'b1']) s;
update public.profiles set handle = 'rev_' || right(id::text, 2), handle_changed_at = now(), display_name = 'Rev ' || right(id::text, 2) where id in (pg_temp.u('a1'), pg_temp.u('b1'));
insert into public.staff_roles (user_id, role) values (pg_temp.u('a1'), 'moderator');
-- a1 has two devices; the second's session is then ended, as Auth does (it deletes the row).
insert into auth.sessions (id, user_id, aal, created_at, updated_at) values
  (pg_temp.sid('a1'), pg_temp.u('a1'), 'aal1', now(), now()),
  (pg_temp.sid('a2'), pg_temp.u('a1'), 'aal1', now(), now()),
  (pg_temp.sid('a3'), pg_temp.u('a1'), 'aal1', now(), now()),
  (pg_temp.sid('b1'), pg_temp.u('b1'), 'aal1', now(), now());
delete from auth.sessions where id = pg_temp.sid('a2');
update auth.sessions set not_after = now() - interval '1 minute' where id = pg_temp.sid('a3');

-- 1. The check itself.
select is(pg_temp.as_live('select private.session_is_live()::text'), 'error: permission denied for schema private', 'clients can''t call the check directly');
select is((select prosecdef and proconfig = array['search_path=""'] and provolatile = 's' from pg_proc where oid = 'private.session_is_live()'::regprocedure), true, 'a stable definer with an empty search_path');
select ok(not has_table_privilege('authenticated', 'auth.sessions', 'select') and not has_table_privilege('anon', 'auth.sessions', 'select'), 'API roles still can''t read Auth''s sessions');
create function pg_temp.live(p_claims jsonb) returns boolean language plpgsql as $l$
begin
  perform set_config('request.jwt.claims', p_claims::text, true);
  return private.session_is_live();
end $l$;
select ok(pg_temp.live(pg_temp.claims('a1', 'a1')), 'a session Auth has is live');
select ok(not pg_temp.live(pg_temp.claims('a1', 'a2')), 'an ended session (its row deleted) isn''t');
select ok(not pg_temp.live(pg_temp.claims('a1', 'a3')), 'nor one past its not_after');
select ok(not pg_temp.live(pg_temp.claims('a1', 'b1')), 'nor another person''s session');
select ok(not pg_temp.live(jsonb_build_object('sub', pg_temp.u('a1'), 'role', 'authenticated')), 'nor a token without a session_id');
select ok(not pg_temp.live(jsonb_build_object('sub', pg_temp.u('a1'), 'role', 'authenticated', 'session_id', 'not-a-uuid')), 'nor a malformed one');
select ok(not pg_temp.live(jsonb_build_object('role', 'authenticated', 'session_id', pg_temp.sid('a1'))), 'nor a session without a user');
select ok(not pg_temp.live('{"role": "anon"}'), 'nor anon');

-- 2. The shared guards.
select is(pg_temp.as_live('select private.is_active_user()::text'), 'error: permission denied for schema private', 'setup: the guards are called by functions and policies, not clients');
select is(pg_temp.as_live($$select (public.get_my_account()).is_active::text$$), 'true', 'a live session''s account is active');
select is(pg_temp.as_ended($$select count(*)::text from public.get_my_account()$$), '0', 'an ended session reads no account at all');
select is(pg_temp.as_ended($$select public.block_user('00000000-0000-0000-0000-0000000000b1')::text$$), 'error: account not eligible', 'an ended session can''t block (require_verified_user)');
select pg_temp.as_live($$select public.block_user('00000000-0000-0000-0000-0000000000b1')::text$$);
select is((select count(*)::int from public.blocked_users where blocker_id = pg_temp.u('a1')), 1, 'a live one can');
select is(pg_temp.as_ended($$select public.unblock_user('00000000-0000-0000-0000-0000000000b1')::text$$), 'error: account not eligible', 'nor unblock');
select is(pg_temp.as_ended($$select public.get_my_notifications(10, null)::text$$), 'error: account not eligible', 'nor read notifications');
select is(pg_temp.as_ended($$select public.request_follow('00000000-0000-0000-0000-0000000000b1')::text$$), 'error: account not eligible', 'nor follow (require_active_user)');

-- 3. Owner-only tables and the profile.
select is(pg_temp.as_live($$select count(*)::text from public.user_preferences$$), '1', 'a live session reads its preferences');
select is(pg_temp.as_ended($$select count(*)::text from public.user_preferences$$), '0', 'an ended one doesn''t');
select is(pg_temp.as_ended($$select count(*)::text from public.staff_roles$$), '0', 'nor its staff roles');
select is(pg_temp.as_ended($$with u as (update public.user_preferences set locale = 'de' where user_id = '00000000-0000-0000-0000-0000000000a1' returning 1) select count(*)::text from u$$), '0', 'nor changes its preferences');
select is(pg_temp.as_ended($$with u as (update public.profiles set bio = 'from an ended session' where id = '00000000-0000-0000-0000-0000000000a1' returning 1) select count(*)::text from u$$), '0', 'nor its profile');
select is((select bio from public.profiles where id = pg_temp.u('a1')), null, 'which is unchanged');
select is(pg_temp.as_live($$with u as (update public.profiles set bio = 'live' where id = '00000000-0000-0000-0000-0000000000a1' returning 1) select count(*)::text from u$$), '1', 'while a live session changes it');
select is(pg_temp.as_ended($$select string_agg(handle, ',' order by handle) from public.profiles where handle = 'rev_a1'$$), 'rev_a1', 'public profile cards stay readable, as they are signed out');

-- 4. Owner-scoped functions.
select is(pg_temp.as_ended($$select public.take_request_slot('data_export')::text$$), 'error: not permitted', 'an ended session takes no request slot');
select is(pg_temp.as_ended($$select public.claim_handle('rev_new')$$), 'error: account not eligible', 'nor claims a handle');
select is(pg_temp.as_ended($$select public.my_catalog_submissions(null, 10)::text$$), 'error: not permitted', 'nor lists its submissions');
select is(pg_temp.as_ended($$select coalesce(public.get_my_submission(gen_random_uuid())::text, 'null')$$), 'null', 'nor reads one');
select is(pg_temp.as_ended($$select public.get_my_factor_status()::text$$), 'error: not permitted', 'nor its authenticators');
select is(pg_temp.as_ended($$select public.get_my_onboarding()::text$$), 'error: not permitted', 'nor its onboarding state');
select is(pg_temp.as_ended($$select public.get_my_preserved_titles(array[gen_random_uuid()])::text$$), '{}', 'nor its preserved copies');
select is(pg_temp.as_ended($$select (public.get_my_collection()) ->> 'items'$$), '[]', 'and its collection reads as empty');
-- M11a-5: a function that only computes the guards as flags passes the source-text rule
-- below while still returning data, so functions that do that are checked by behaviour.
select is(pg_temp.as_ended($$select public.get_my_admin_access()::text$$), 'error: not permitted', 'an ended session reads none of its staff, Owner, transfer or recovery state (M11a-5)');
select is(pg_temp.as_live($$select public.get_my_admin_access() -> 'roles' ->> 0$$), 'moderator', 'a live session still reads its roles');

-- 5. Coverage: every owner-only policy, and every owner-scoped function a signed-in user
-- can run, reaches a session check (directly or through a guard), or reads under RLS.
select is(
  (select coalesce(string_agg(tablename || '.' || policyname, ', ' order by 1), '') from pg_policies
   where schemaname = 'public' and 'authenticated' = any (roles)
     and coalesce(qual, '') || coalesce(with_check, '') ~ 'auth\.uid\(\)'
     and coalesce(qual, '') || coalesce(with_check, '') !~ 'session_is_live|is_active_user'),
  '', 'every policy naming the caller checks the session (or is_active_user)');
select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by 1), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
     and p.prosrc ~ 'auth\.uid\(\)'
     and p.prosrc !~ 'session_is_live|is_active_user|require_verified_user|require_active_user|mfa_session_ok|require_mfa|require_active_staff|begin_catalog_edit|begin_submission|get_my_account'),
  '', 'every owner-scoped definer function checks the session');
select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by 1), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.prosecdef and p.prosrc ~ 'auth\.uid\(\)' and p.proname in ('is_active_user', 'require_verified_user', 'can_read_release', 'can_use_release', 'my_preserved_releases')
     and p.prosrc !~ 'session_is_live'),
  '', 'the shared guards and the own-submission catalog rules check it');
select is((select count(*)::int from pg_policies where schemaname = 'public' and policyname in (
    'collection_items_read_own', 'collection_items_delete_own', 'collection_item_private_read_own', 'collection_item_private_delete_own',
    'collection_item_components_read_own', 'collection_item_components_delete_own', 'user_preferences_read_own', 'staff_roles_read_own',
    'games_read_authenticated', 'releases_read_authenticated') and qual ~ 'session_is_live'), 10, 'the ten policies changed here name it');
select ok((select qual !~ 'session_is_live' from pg_policies where policyname = 'profiles_read_authenticated'), 'public profile cards don''t');

select * from finish();
rollback;
