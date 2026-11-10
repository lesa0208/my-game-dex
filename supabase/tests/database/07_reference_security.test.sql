-- M1: reference data is publicly readable and never client-writable.
begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

create temp table reference_tables as
  select unnest(array['region_codes', 'markets', 'platforms', 'platform_names', 'media_formats', 'platform_media_formats', 'hardware_requirements']) as t;
grant select on reference_tables to anon, authenticated, service_role;

-- Structure
select is((select count(*)::int from reference_tables r join pg_class c on c.relname = r.t and c.relnamespace = 'public'::regnamespace where c.relrowsecurity), 7, 'all 7 reference tables have RLS enabled');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename in (select t from reference_tables) and cmd = 'SELECT'),
  7, 'each reference table has one read policy'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename in (select t from reference_tables) and cmd <> 'SELECT'),
  0, 'no write policy exists on any reference table'
);
select is(
  (select count(*)::int from information_schema.role_table_grants where table_schema = 'public' and table_name in (select t from reference_tables) and grantee in ('anon', 'authenticated', 'service_role') and privilege_type <> 'SELECT'),
  0, 'no API role holds a write privilege, including service_role'
);
select is(
  (select count(*)::int from information_schema.role_table_grants where table_schema = 'public' and table_name in (select t from reference_tables) and grantee in ('anon', 'authenticated', 'service_role') and privilege_type = 'SELECT'),
  21, 'each API role holds SELECT on all 7 tables'
);

-- Hardware requirements can't become a hardware collection
select is(
  (select coalesce(array_agg(c.conrelid::regclass::text), '{}') from pg_constraint c where c.contype = 'f' and c.confrelid = 'public.hardware_requirements'::regclass),
  array['release_hardware_requirements'], 'only release requirements reference hardware_requirements, never a collection (M5a)'
);
select is(
  (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'hardware_requirements' and column_name ~ '(owner|user|profile|collection)'),
  0, 'hardware_requirements has no ownership column'
);
select is(
  (select count(*)::int from pg_tables where schemaname = 'public' and tablename ~ '(hardware_item|console_item|accessor|user_hardware|collection_hardware)'),
  0, 'no hardware collection table exists'
);

-- Anonymous
set local role anon;
select is((select count(*)::int from public.region_codes), 11, 'anon reads region codes');
select is((select count(*)::int from public.markets), 249, 'anon reads markets');
select is((select count(*)::int from public.platforms), 59, 'anon reads platforms');
select cmp_ok((select count(*)::int from public.platform_names), '>', 0, 'anon reads platform names');
select is((select count(*)::int from public.media_formats), 25, 'anon reads media formats');
select cmp_ok((select count(*)::int from public.platform_media_formats), '>=', 58, 'anon reads platform formats');
select is((select count(*)::int from public.hardware_requirements), 11, 'anon reads hardware requirements');
select throws_ok($$insert into public.region_codes (code, label, description, position) values ('x', 'X', 'x', 99)$$, '42501', null, 'anon can''t insert a region code');
select throws_ok($$insert into public.markets (code, name) values ('ZZ', 'Nowhere')$$, '42501', null, 'anon can''t insert a market');
select throws_ok($$update public.platforms set name = 'Hacked'$$, '42501', null, 'anon can''t update a platform');
select throws_ok($$delete from public.platform_names$$, '42501', null, 'anon can''t delete a platform name');
select throws_ok($$insert into public.media_formats (code, category, name, position) values ('x', 'cartridge', 'X', 99)$$, '42501', null, 'anon can''t insert a media format');
select throws_ok($$delete from public.platform_media_formats$$, '42501', null, 'anon can''t delete platform formats');
select throws_ok($$update public.hardware_requirements set label = 'Hacked'$$, '42501', null, 'anon can''t update a hardware requirement');
select throws_ok($$truncate public.markets$$, '42501', null, 'anon can''t truncate');
reset role;

-- Authenticated
set local role authenticated;
select is((select count(*)::int from public.platforms), 59, 'authenticated reads platforms');
select is((select count(*)::int from public.hardware_requirements), 11, 'authenticated reads hardware requirements');
select throws_ok($$insert into public.region_codes (code, label, description, position) values ('x', 'X', 'x', 99)$$, '42501', null, 'authenticated can''t insert a region code');
select throws_ok($$update public.markets set name = 'Hacked'$$, '42501', null, 'authenticated can''t update a market');
select throws_ok($$delete from public.platforms$$, '42501', null, 'authenticated can''t delete a platform');
select throws_ok($$insert into public.platform_names (platform_id, name) select id, 'Hacked' from public.platforms limit 1$$, '42501', null, 'authenticated can''t add an alias');
select throws_ok($$update public.media_formats set name = 'Hacked'$$, '42501', null, 'authenticated can''t update a media format');
select throws_ok($$insert into public.platform_media_formats (platform_id, media_format_code) select id, 'cd-rom' from public.platforms where slug = 'nes'$$, '42501', null, 'authenticated can''t add a platform format');
select throws_ok($$delete from public.hardware_requirements$$, '42501', null, 'authenticated can''t delete a hardware requirement');
reset role;

-- service_role reads, and doesn't write without an explicit grant
set local role service_role;
select is((select count(*)::int from public.platforms), 59, 'service_role reads platforms');
select throws_ok($$update public.platforms set name = 'Hacked'$$, '42501', null, 'service_role bypasses RLS but can''t write without a grant');
select throws_ok($$delete from public.markets$$, '42501', null, 'service_role can''t delete a market');
select throws_ok($$insert into public.hardware_requirements (code, platform_id, label, kind, description) select 'x', id, 'X', 'revision', 'x' from public.platforms limit 1$$, '42501', null, 'service_role can''t add a hardware requirement');
reset role;

-- Trigger functions stay private
select is(has_function_privilege('anon', 'private.prevent_slug_change()', 'execute'), false, 'anon can''t execute prevent_slug_change');
select is(has_function_privilege('authenticated', 'private.validate_platform_base()', 'execute'), false, 'authenticated can''t execute validate_platform_base');
select is(has_schema_privilege('anon', 'private', 'usage'), false, 'anon still has no usage on private');
select is(has_schema_privilege('authenticated', 'private', 'usage'), false, 'authenticated still has no usage on private');

select * from finish();
rollback;
