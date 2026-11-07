-- Schema guards. They inspect whatever exists, so they keep protecting every
-- later migration. Each one also has a negative test proving it detects a breach.
--
-- Later steps add deliberate access by extending the approved lists below.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

-- Approved grants to API roles: object name, role.
create temp table approved_relation_grants (relation text, grantee text);
-- M1: reference data is publicly readable. Test 07 confirms it's SELECT only.
insert into approved_relation_grants
  select t, r from unnest(array['region_codes', 'markets', 'platforms', 'platform_names', 'media_formats', 'platform_media_formats', 'hardware_requirements']) as t
  cross join unnest(array['anon', 'authenticated', 'service_role']) as r;
-- M2: test 08 asserts the exact columns. service_role has no table access here.
insert into approved_relation_grants values
  ('profiles', 'anon'), ('profiles', 'authenticated'),
  ('user_preferences', 'authenticated'), ('staff_roles', 'authenticated');
create temp table approved_function_grants (fn text, grantee text);
insert into approved_function_grants values
  ('claim_handle(text)', 'authenticated'),
  ('get_my_account()', 'authenticated'),
  ('set_avatar_path(uuid,text)', 'service_role'),
  ('private.is_active_user()', 'authenticated'),
  -- M3: clients act only through these. follows and blocked_users have no client grants.
  ('request_follow(uuid)', 'authenticated'),
  ('cancel_follow_request(uuid)', 'authenticated'),
  ('unfollow(uuid)', 'authenticated'),
  ('accept_follow_request(uuid)', 'authenticated'),
  ('reject_follow_request(uuid)', 'authenticated'),
  ('remove_follower(uuid)', 'authenticated'),
  ('block_user(uuid)', 'authenticated'),
  ('unblock_user(uuid)', 'authenticated'),
  ('get_follow_state(uuid)', 'authenticated'),
  ('get_followers(uuid,integer,timestamp with time zone,uuid)', 'authenticated'),
  ('get_following(uuid,integer,timestamp with time zone,uuid)', 'authenticated'),
  ('get_profile_counts(uuid)', 'authenticated'),
  ('get_received_follow_requests(integer,timestamp with time zone,uuid)', 'authenticated'),
  ('get_sent_follow_requests(integer,timestamp with time zone,uuid)', 'authenticated'),
  ('get_my_blocks(integer,timestamp with time zone,uuid)', 'authenticated'),
  ('grant_staff_role(uuid,staff_role,text)', 'authenticated'),
  ('revoke_staff_role(uuid,staff_role,text)', 'authenticated'),
  ('set_account_status(uuid,account_status,text)', 'authenticated'),
  ('get_audit_events(integer,uuid)', 'authenticated'),
  -- M4b: notifications have no client grants; clients use only these.
  ('get_my_notifications(integer,uuid)', 'authenticated'),
  ('get_unread_notification_count()', 'authenticated'),
  ('mark_notifications_read(uuid)', 'authenticated'),
  ('delete_notification(uuid)', 'authenticated'),
  -- M3: called by policies during reads. No role has USAGE on private.
  ('private.block_peers()', 'authenticated'),
  ('private.is_blocked_between(uuid)', 'anon'), ('private.is_blocked_between(uuid)', 'authenticated'),
  ('private.is_accepted_follower(uuid)', 'anon'), ('private.is_accepted_follower(uuid)', 'authenticated'),
  ('private.can_view_level(uuid,visibility_level)', 'anon'), ('private.can_view_level(uuid,visibility_level)', 'authenticated'),
  ('private.can_view_collection(uuid)', 'anon'), ('private.can_view_collection(uuid)', 'authenticated');
create temp table approved_schema_usage (schema_name text, grantee text);

-- Public tables without RLS
create temp view guard_rls_missing as
  select c.oid::regclass::text as object
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;

-- Application objects owned by a role other than the migration role. Default
-- privileges apply per creating role, so another owner would escape them.
create temp view guard_foreign_owner as
  select c.oid::regclass::text as object
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
     and pg_get_userbyid(c.relowner) <> 'postgres'
  union all
  select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and pg_get_userbyid(p.proowner) <> 'postgres';

-- Unapproved table, view, sequence and column privileges for API roles or PUBLIC
create temp view guard_relation_grants as
  with entries as (
    select c.oid::regclass::text as relation, a.grantee as grantee_oid
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) a
     where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    union all
    select c.oid::regclass::text, a.grantee
      from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(att.attacl) a
     where n.nspname in ('public', 'private') and att.attacl is not null
  )
  select distinct e.relation, coalesce(r.rolname, 'PUBLIC') as grantee
    from entries e left join pg_roles r on r.oid = e.grantee_oid
   where (e.grantee_oid = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
     and not exists (select 1 from approved_relation_grants x where x.relation = regexp_replace(e.relation, '^public\.', '') and x.grantee = coalesce(r.rolname, 'PUBLIC'));

-- Unapproved EXECUTE for API roles or PUBLIC
create temp view guard_function_grants as
  select distinct p.oid::regprocedure::text as fn, coalesce(r.rolname, 'PUBLIC') as grantee
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    left join pg_roles r on r.oid = a.grantee
   where n.nspname in ('public', 'private') and a.privilege_type = 'EXECUTE'
     and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
     and not exists (select 1 from approved_function_grants x where x.fn = p.oid::regprocedure::text and x.grantee = coalesce(r.rolname, 'PUBLIC'));

-- SECURITY DEFINER functions must pin search_path to empty
create temp view guard_definer_search_path as
  select p.oid::regprocedure::text as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prosecdef
     and not coalesce(p.proconfig @> array['search_path=""'], false);

-- Every application function should pin search_path
create temp view guard_function_search_path as
  select p.oid::regprocedure::text as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) s where s like 'search_path=%');

-- Views must run with the caller's rights, or they silently bypass RLS
create temp view guard_views_definer as
  select c.oid::regclass::text as object
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and not coalesce(c.reloptions @> array['security_invoker=true'], false);

-- Unapproved USAGE on the private schema
create temp view guard_private_usage as
  select r.rolname as grantee
    from unnest(array['anon', 'authenticated', 'service_role']) as r(rolname)
   where has_schema_privilege(r.rolname, 'private', 'usage')
     and not exists (select 1 from approved_schema_usage x where x.schema_name = 'private' and x.grantee = r.rolname);

-- The live schema passes every guard
select is_empty('select * from guard_rls_missing', 'every public table has RLS enabled');
select is_empty('select * from guard_foreign_owner', 'every application object is owned by the migration role');
select is_empty('select * from guard_relation_grants', 'no unapproved table, sequence or column privileges');
select is_empty('select * from guard_function_grants', 'no unapproved function EXECUTE');
select is_empty('select * from guard_definer_search_path', 'every SECURITY DEFINER function pins an empty search_path');
select is_empty('select * from guard_function_search_path', 'every application function pins search_path');
select is_empty('select * from guard_views_definer', 'every public view uses security_invoker');
select is_empty('select * from guard_private_usage', 'no unapproved usage on private');

-- Negative tests: each guard catches a real breach

create table public.__no_rls (id int primary key);
select isnt_empty('select * from guard_rls_missing', 'guard detects a public table without RLS');
alter table public.__no_rls enable row level security;

grant select on public.__no_rls to anon;
select isnt_empty('select * from guard_relation_grants', 'guard detects an unapproved table grant');
revoke select on public.__no_rls from anon;

grant select (id) on public.__no_rls to authenticated;
select isnt_empty('select * from guard_relation_grants', 'guard detects an unapproved column grant');
revoke select (id) on public.__no_rls from authenticated;

create function public.__bad_definer() returns int language sql security definer as 'select 1';
select isnt_empty('select * from guard_definer_search_path', 'guard detects SECURITY DEFINER without a fixed search_path');
drop function public.__bad_definer();

create function public.__bad_definer() returns int language sql security definer set search_path = public as 'select 1';
select isnt_empty('select * from guard_definer_search_path', 'guard rejects a SECURITY DEFINER search_path that is not empty');
drop function public.__bad_definer();

create function public.__no_path() returns int language sql as 'select 1';
select isnt_empty('select * from guard_function_search_path', 'guard detects a function with no search_path');
grant execute on function public.__no_path() to public;
select isnt_empty('select * from guard_function_grants', 'guard detects EXECUTE granted to PUBLIC');
drop function public.__no_path();

create view public.__bad_view as select id from public.__no_rls;
select isnt_empty('select * from guard_views_definer', 'guard detects a view without security_invoker');
drop view public.__bad_view;

grant usage on schema private to anon;
select isnt_empty('select * from guard_private_usage', 'guard detects unapproved usage on private');
revoke usage on schema private from anon;

-- A platform role can't be the owner of application objects. postgres can't
-- impersonate supabase_admin here, so reassign ownership of a throwaway to a role
-- postgres does control.
create role __guard_owner;
grant __guard_owner to postgres;
grant create on schema public to __guard_owner;
create table public.__foreign (id int primary key);
alter table public.__foreign enable row level security;
alter table public.__foreign owner to __guard_owner;
select isnt_empty('select * from guard_foreign_owner', 'guard detects an object owned by another role');
alter table public.__foreign owner to postgres;
drop table public.__foreign;
revoke create on schema public from __guard_owner;
revoke __guard_owner from postgres;
drop role __guard_owner;

select * from finish();
rollback;
