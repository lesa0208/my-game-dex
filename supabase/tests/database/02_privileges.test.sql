-- M0: new application objects get no implicit access, whichever defaults the
-- environment ships with. Objects are created as `postgres`, the migration role.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

-- The migration role
select is(current_user::text, 'postgres', 'tests and migrations run as postgres');
select is((select rolsuper from pg_roles where rolname = 'postgres'), false, 'the migration role is not a superuser');

-- New objects, created the way a migration would
create table public.__t (id int primary key, secret text);
insert into public.__t values (1, 'marker');
create sequence public.__s;
create function public.__f() returns int language sql as 'select 1';
create table private.__pt (id int primary key);
create sequence private.__ps;
create function private.__pf() returns int language sql as 'select 1';
create schema __other;
create function __other.__of() returns int language sql as 'select 1';

-- Tables
select is(has_table_privilege('anon', 'public.__t', 'select,insert,update,delete,truncate,references,trigger'), false, 'anon has no privilege on a new public table');
select is(has_table_privilege('authenticated', 'public.__t', 'select,insert,update,delete,truncate,references,trigger'), false, 'authenticated has no privilege on a new public table');
select is(has_table_privilege('service_role', 'public.__t', 'select,insert,update,delete,truncate,references,trigger'), false, 'service_role has no privilege on a new public table');
select is((select count(*)::int from information_schema.role_table_grants where table_schema = 'public' and table_name = '__t' and grantee <> 'postgres'), 0, 'a new public table has no grantee except its owner');
select is(has_table_privilege('anon', 'private.__pt', 'select'), false, 'anon has no privilege on a new private table');
select is(has_table_privilege('authenticated', 'private.__pt', 'select'), false, 'authenticated has no privilege on a new private table');
select is(has_table_privilege('service_role', 'private.__pt', 'select'), false, 'service_role has no privilege on a new private table');

-- Sequences
select is(has_sequence_privilege('anon', 'public.__s', 'usage,select,update'), false, 'anon has no privilege on a new public sequence');
select is(has_sequence_privilege('authenticated', 'public.__s', 'usage,select,update'), false, 'authenticated has no privilege on a new public sequence');
select is(has_sequence_privilege('service_role', 'public.__s', 'usage,select,update'), false, 'service_role has no privilege on a new public sequence');
select is(has_sequence_privilege('anon', 'private.__ps', 'usage'), false, 'anon has no privilege on a new private sequence');

-- Functions
select is(has_function_privilege('anon', 'public.__f()', 'execute'), false, 'anon can not execute a new public function');
select is(has_function_privilege('authenticated', 'public.__f()', 'execute'), false, 'authenticated can not execute a new public function');
select is(has_function_privilege('service_role', 'public.__f()', 'execute'), false, 'service_role can not execute a new public function');
select is(has_function_privilege('anon', 'private.__pf()', 'execute'), false, 'anon can not execute a new private function');
select is(has_function_privilege('authenticated', 'private.__pf()', 'execute'), false, 'authenticated can not execute a new private function');
select is(has_function_privilege('service_role', 'private.__pf()', 'execute'), false, 'service_role can not execute a new private function');
select is(has_function_privilege('anon', '__other.__of()', 'execute'), false, 'PUBLIC does not get EXECUTE on a postgres function in any schema');

-- Schema rights
select is(has_schema_privilege('anon', 'public', 'create'), false, 'anon can not create in public');
select is(has_schema_privilege('authenticated', 'public', 'create'), false, 'authenticated can not create in public');
select is(has_schema_privilege('service_role', 'public', 'create'), false, 'service_role can not create in public');
select is(has_schema_privilege('anon', 'private', 'usage'), false, 'anon has no usage on private');
select is(has_schema_privilege('authenticated', 'private', 'usage'), false, 'authenticated has no usage on private');
select is(has_schema_privilege('service_role', 'private', 'usage'), false, 'service_role has no usage on private');

-- Enforced as the role itself, not just reported
set local role anon;
select throws_ok('select * from public.__t', '42501', null, 'anon is refused at runtime');
reset role;

-- RLS bypass is not a substitute for SQL privileges
set local role service_role;
select throws_ok('select * from public.__t', '42501', null, 'service_role bypasses RLS but is still refused without a grant');
reset role;
select is((select rolbypassrls from pg_roles where rolname = 'service_role'), true, 'service_role does bypass RLS, which is why its grants matter');

-- Granting is deliberate, and works
grant select on public.__t to service_role;
set local role service_role;
select is((select secret from public.__t where id = 1), 'marker', 'an explicit grant gives service_role access');
reset role;
revoke select on public.__t from service_role;

-- A grant alone does not expose rows once RLS is on
alter table public.__t enable row level security;
grant select on public.__t to anon;
set local role anon;
select is((select count(*)::int from public.__t), 0, 'with a grant, RLS and no policy, anon reads no rows');
reset role;
revoke select on public.__t from anon;

-- No default privilege for the migration role reaches the API roles in app schemas
select is(
  (select count(*)::int
     from pg_default_acl d
     join pg_namespace n on n.oid = d.defaclnamespace
     cross join lateral aclexplode(d.defaclacl) a
     left join pg_roles r on r.oid = a.grantee
    where pg_get_userbyid(d.defaclrole) = 'postgres'
      and n.nspname in ('public', 'private')
      and (r.rolname in ('anon', 'authenticated', 'service_role') or a.grantee = 0)),
  0, 'no postgres default privilege in app schemas reaches an API role'
);

-- Platform functionality is untouched
select is(has_function_privilege('anon', 'auth.uid()', 'execute'), true, 'anon can still execute auth.uid()');
select is(has_function_privilege('authenticated', 'auth.uid()', 'execute'), true, 'authenticated can still execute auth.uid()');
select is(has_function_privilege('authenticated', 'auth.jwt()', 'execute'), true, 'authenticated can still execute auth.jwt()');
select is(has_function_privilege('authenticated', 'storage.foldername(text)', 'execute'), true, 'authenticated can still execute storage.foldername()');
select is(pg_get_userbyid((select proowner from pg_proc where oid = 'auth.uid()'::regprocedure)), 'supabase_auth_admin', 'auth.uid() is still owned by its platform role');

select * from finish();
rollback;
