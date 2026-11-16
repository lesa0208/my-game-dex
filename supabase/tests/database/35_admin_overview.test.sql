-- M10a: the /admin overview's counts (get_admin_overview). Who may call it, which
-- sections each role gets, that it returns aggregate numbers only, and that each
-- count counts what it says. Runs in one transaction that rolls back, on the local
-- stack only; nothing here reaches hosted data.
begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

-- M8b: staff privileges need a live aal2 session with a verified TOTP factor. These
-- rows have the shape GoTrue writes (31_auth_contract pins it down) and roll back.
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
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.claims(pg_temp.u(p_actor))::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
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
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.as_role(p_role text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', p_role, true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
-- The overview as one person sees it.
create function pg_temp.overview(p_actor text) returns jsonb language plpgsql as $t$
declare r text := pg_temp.as_user(p_actor, 'select public.get_admin_overview()::text');
begin
  if r like 'error:%' then raise exception '%', r; end if;
  return r::jsonb;
end $t$;
create function pg_temp.keys(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(k, ',' order by k), '') from jsonb_object_keys(j) k
$$;

-- a2: admin. d3: moderator. e4: catalog editor. c5: collector. a6: admin at aal1
-- only. e7: a suspended catalog editor. b8 and b9: collectors who submit.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a2', 'd3', 'e4', 'c5', 'a6', 'e7', 'b8', 'b9']) as s;
update public.profiles set handle = 'ovw_' || right(id::text, 2), handle_changed_at = now(), display_name = 'Person ' || right(id::text, 2)
where id in (select pg_temp.u(s) from unnest(array['a2', 'd3', 'e4', 'c5', 'a6', 'e7', 'b8', 'b9']) s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('a2'), 'admin'), (pg_temp.u('d3'), 'moderator'), (pg_temp.u('e4'), 'catalog_editor'), (pg_temp.u('a6'), 'admin'), (pg_temp.u('e7'), 'catalog_editor');
select pg_temp.claims(pg_temp.u(s)) from unnest(array['a2', 'd3', 'e4', 'c5', 'e7', 'b8', 'b9']) s;
update public.profiles set account_status = 'suspended' where id = pg_temp.u('e7');

-- ---------------------------------------------------------------------------
-- 1. The function and who may call it
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_proc p where p.oid = 'public.get_admin_overview()'::regprocedure
  and p.prosecdef and p.proconfig = array['search_path=""'] and p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres}'),
  1, 'the overview is SECURITY DEFINER with an empty search_path, and only authenticated may execute it');
select is((select count(*)::int from unnest(array['anon', 'service_role']) r where has_function_privilege(r, 'public.get_admin_overview()', 'execute')), 0,
  'anon and service_role can''t execute it');
select is(pg_temp.as_role('anon', 'select public.get_admin_overview()::text'), 'error: permission denied for function get_admin_overview', 'anon is refused by PostgreSQL');
select is(pg_temp.as_role('authenticated', 'select public.get_admin_overview()::text'), 'error: not permitted', 'an authenticated request with no user is refused');
select is(pg_temp.as_user('c5', 'select public.get_admin_overview()::text'), 'error: not permitted', 'a collector is refused, with the generic message');
select is(pg_temp.as_aal1('e4', 'select public.get_admin_overview()::text'), 'error: not permitted', 'a catalog editor at aal1 is refused');
select is(pg_temp.as_aal1('a6', 'select public.get_admin_overview()::text'), 'error: not permitted', 'so is an administrator at aal1');
select is(pg_temp.as_user('e7', 'select public.get_admin_overview()::text'), 'error: not permitted', 'and a suspended catalog editor, even at aal2');

-- ---------------------------------------------------------------------------
-- 2. Each role gets only its own sections
-- ---------------------------------------------------------------------------
select is(pg_temp.keys(pg_temp.overview('e4')), 'accounts,administration,cap,catalog', 'the result always has the same four keys');
select is((pg_temp.overview('e4') -> 'catalog') is not null and jsonb_typeof(pg_temp.overview('e4') -> 'catalog') = 'object', true, 'a catalog editor gets the catalog counts');
select is(jsonb_typeof(pg_temp.overview('e4') -> 'accounts'), 'null', 'but not the account counts');
select is(jsonb_typeof(pg_temp.overview('e4') -> 'administration'), 'null', 'nor the administration counts');
select is(jsonb_typeof(pg_temp.overview('d3') -> 'accounts'), 'object', 'a moderator gets the account counts');
select is(jsonb_typeof(pg_temp.overview('d3') -> 'catalog'), 'null', 'but not the catalog counts');
select is(jsonb_typeof(pg_temp.overview('d3') -> 'administration'), 'null', 'nor the administration counts');
select is(jsonb_typeof(pg_temp.overview('a2') -> 'catalog') || '/' || jsonb_typeof(pg_temp.overview('a2') -> 'accounts') || '/' || jsonb_typeof(pg_temp.overview('a2') -> 'administration'),
  'object/object/object', 'an administrator gets every section');

-- ---------------------------------------------------------------------------
-- 3. Aggregate numbers only: fixed keys, and nothing but numbers (and one time)
-- ---------------------------------------------------------------------------
select is(pg_temp.keys(pg_temp.overview('a2') -> 'catalog'),
  'games_unpublished,merges_30_days,oldest_waiting_at,reclassifications_open,releases_unpublished,submissions_changes_requested,submissions_in_review,submissions_open',
  'the catalog section has exactly its counts');
select is(pg_temp.keys(pg_temp.overview('a2') -> 'accounts'), 'suspended', 'the accounts section has exactly its count');
select is(pg_temp.keys(pg_temp.overview('a2') -> 'administration'), 'exclusions_active,refusals_7_days,staff_admins,staff_catalog_editors,staff_moderators',
  'the administration section has exactly its counts');
select is((select count(*)::int from jsonb_each(pg_temp.overview('a2') -> 'catalog') e where e.key <> 'oldest_waiting_at' and jsonb_typeof(e.value) <> 'number')
  + (select count(*)::int from jsonb_each(pg_temp.overview('a2') -> 'accounts') e where jsonb_typeof(e.value) <> 'number')
  + (select count(*)::int from jsonb_each(pg_temp.overview('a2') -> 'administration') e where jsonb_typeof(e.value) <> 'number'),
  0, 'every value is a number, except the oldest waiting time');
select is((pg_temp.overview('a2') ->> 'cap')::int, 10000, 'counts stop at a cap of 10,000');

-- ---------------------------------------------------------------------------
-- 4. Each count counts what it says
-- ---------------------------------------------------------------------------
create temporary table ids (name text primary key, id uuid);
create function pg_temp.id(p text) returns uuid language sql as $$ select id from ids where name = p $$;
create function pg_temp.subgame(p_name text, p_actor text, p_title text) returns text language plpgsql as $$
declare r text := pg_temp.as_user(p_actor, format('select public.submit_game(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L)::text',
  p_title, 'game', null, 'snes', 'rom-cartridge', 'pal', '{}', '[]', null, true));
begin
  if r like '{%' and (r::jsonb ->> 'outcome') = 'submitted' then
    insert into ids values (p_name, (r::jsonb ->> 'submission_id')::uuid);
    return 'submitted';
  end if;
  return r;
end $$;
create function pg_temp.ver(p text) returns integer language sql as $$ select version from public.catalog_change_requests where id = pg_temp.id(p) $$;
create function pg_temp.start(p text) returns text language sql as $$
  select pg_temp.as_user('e4', format('select public.start_submission_review(%L, %L, %L)::text', pg_temp.id(p), pg_temp.ver(p), 'Checking the evidence'))
$$;

-- Before: what the counts are without this test's rows.
create temporary table before as
select (select count(*) from public.catalog_change_requests where status = 'open') as open,
       (select count(*) from public.catalog_change_requests where status = 'in_review') as in_review,
       (select count(*) from public.catalog_change_requests where status = 'changes_requested') as changes,
       (select count(*) from public.games where status in ('unverified', 'under_review')) as games,
       (select count(*) from public.releases where status in ('unverified', 'under_review')) as releases,
       (select count(*) from public.profiles where account_status = 'suspended') as suspended,
       (select count(*) from private.audit_events where outcome = 'refused' and occurred_at > now() - interval '7 days') as refusals,
       (select count(*) from public.staff_roles where role = 'admin') as admins;

-- Four submissions: one left open, one in review, one sent back, one rejected.
select is(pg_temp.subgame('o1', 'b8', 'Ovw Open') || pg_temp.subgame('r1', 'b8', 'Ovw Reviewing') || pg_temp.subgame('c1', 'b9', 'Ovw Changes') || pg_temp.subgame('x1', 'b9', 'Ovw Rejected'),
  'submittedsubmittedsubmittedsubmitted', 'setup: four new-game submissions');
create function pg_temp.st(p text) returns text language sql as $$ select status::text from public.catalog_change_requests where id = pg_temp.id(p) $$;
select pg_temp.start('r1'), pg_temp.start('c1'), pg_temp.start('x1');
select is(pg_temp.st('r1') || '/' || pg_temp.st('c1') || '/' || pg_temp.st('x1'), 'in_review/in_review/in_review', 'setup: three are taken into review');
select pg_temp.as_user('e4', format('select public.request_submission_changes(%L, %L, %L, %L)::text', pg_temp.id('c1'), pg_temp.ver('c1'), 'Needs the edition', 'Asking for the edition'));
select pg_temp.as_user('e4', format('select public.reject_submission(%L, %L, %L, %L)::text', pg_temp.id('x1'), pg_temp.ver('x1'), 'No evidence it exists', null));
select is(pg_temp.st('o1') || '/' || pg_temp.st('c1') || '/' || pg_temp.st('x1'), 'open/changes_requested/rejected', 'setup: one stays open, one is sent back, one rejected');
-- One refusal now, one eight days ago, and one ordinary event now.
insert into private.audit_events (actor_id, action, reason, metadata, occurred_at) values
  (pg_temp.u('a2'), 'staff_change_refused', 'Overview test refusal', '{"code": "owner_only"}', now()),
  (pg_temp.u('a2'), 'staff_change_refused', 'Overview test old refusal', '{"code": "owner_only"}', now() - interval '8 days'),
  (pg_temp.u('a2'), 'account_suspended', 'Overview test change', '{}', now());

select is((pg_temp.overview('e4') -> 'catalog' ->> 'submissions_open')::int, (select open + 1 from before)::int, 'open submissions count only the open one');
select is((pg_temp.overview('e4') -> 'catalog' ->> 'submissions_in_review')::int, (select in_review + 1 from before)::int, 'in review counts only the one being reviewed');
select is((pg_temp.overview('e4') -> 'catalog' ->> 'submissions_changes_requested')::int, (select changes + 1 from before)::int, 'changes requested counts only the one sent back');
select is((pg_temp.overview('e4') -> 'catalog' ->> 'oldest_waiting_at')::timestamptz,
  (select min(created_at) from public.catalog_change_requests where status in ('open', 'in_review')), 'the oldest waiting time is the oldest open or in-review submission');
select is((pg_temp.overview('e4') -> 'catalog' ->> 'games_unpublished')::int, (select count(*) from public.games where status in ('unverified', 'under_review'))::int,
  'unpublished games count unverified and under-review games only');
select is((select games + 3 from before)::int, (select count(*) from public.games where status in ('unverified', 'under_review'))::int,
  'which here is three more: the rejected submission''s game isn''t counted');
select is((pg_temp.overview('e4') -> 'catalog' ->> 'releases_unpublished')::int, (select releases + 3 from before)::int, 'and the same for releases');
select is((pg_temp.overview('d3') -> 'accounts' ->> 'suspended')::int, (select suspended from before)::int, 'suspended accounts count suspended accounts only');
select is((pg_temp.overview('a2') -> 'administration' ->> 'refusals_7_days')::int, (select refusals + 1 from before)::int,
  'refusals count refused events from the last seven days only');
select is((pg_temp.overview('a2') -> 'administration' ->> 'staff_admins')::int || '/' || (pg_temp.overview('a2') -> 'administration' ->> 'staff_moderators')
  || '/' || (pg_temp.overview('a2') -> 'administration' ->> 'staff_catalog_editors'),
  (select admins from before)::text || '/' || (select count(*) from public.staff_roles where role = 'moderator')::text || '/' || (select count(*) from public.staff_roles where role = 'catalog_editor')::text,
  'staff counts are per role');

select * from finish();
rollback;
