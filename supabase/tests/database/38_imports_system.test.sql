-- M10d: import monitoring and the system view (get_import_providers, get_import_runs,
-- get_import_run, get_import_run_records, get_system_status), for administrators only
-- (D7, D8), and the existing reclassification resolution (resolve_catalog_review),
-- which M10d puts in the app: who may use it, what it records, and that it changes no
-- catalog record. Runs in one transaction that rolls back, on the local stack only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(83);

-- Staff need a live aal2 session with a verified TOTP factor (M8b). e6 is an editor
-- whose verification is 11 minutes old; everyone else's is fresh.
create function pg_temp.session(p_user uuid, p_verified timestamptz) returns jsonb language plpgsql as $mfa$
begin
  insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    select p_user, p_user, 'test session factor', 'totp', 'verified', now(), now()
    where not exists (select 1 from auth.mfa_factors where id = p_user);
  if not exists (select 1 from auth.mfa_amr_claims where session_id = p_user) then
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values (gen_random_uuid(), p_user, 'totp', p_verified, p_verified);
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user);
end $mfa$;
create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.session(pg_temp.u(p_actor), case when p_actor = 'e6' then now() - interval '11 minutes' else now() end)::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
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

-- a1: administrator. a2: a suspended administrator. e1, e6: catalog editors. b1: a
-- moderator. c1: a collector.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'a2', 'e1', 'e6', 'b1', 'c1']) as s;
update public.profiles set handle = 'imp_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['a1', 'a2', 'e1', 'e6', 'b1', 'c1']) s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('a1'), 'admin'), (pg_temp.u('a2'), 'admin'), (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('e6'), 'catalog_editor'), (pg_temp.u('b1'), 'moderator');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('a2');

-- Import history, written as the importer would leave it: three runs of no-intro, one
-- still running with a live lease and one whose lease expired, one of wikidata.
create temp table ids (name text primary key, id uuid not null);
grant all on ids to authenticated, anon;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
insert into ids values ('run1', '01900000-0000-7000-8000-000000000001'), ('run2', '01900000-0000-7000-8000-000000000002'),
  ('run3', '01900000-0000-7000-8000-000000000003'), ('run4', '01900000-0000-7000-8000-000000000004');
insert into private.import_runs (id, provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, status, checkpoint, stats, started_at, finished_at, reason, lease_id, lease_expires_at)
values
  (pg_temp.id('run1'), 'no-intro', (select id from public.platforms where slug = 'snes'), 'Imp SNES snapshot 1.dat', repeat('a', 64), now() - interval '3 days', repeat('c', 64),
   'completed', '{"after": "secret-position"}', '{"staged_new": 3, "staged_ignored": 1, "note": "not a number"}', now() - interval '3 days', now() - interval '3 days' + interval '1 hour', 'Imp pilot', null, null),
  (pg_temp.id('run2'), 'no-intro', (select id from public.platforms where slug = 'snes'), 'Imp SNES snapshot 2.dat', repeat('b', 64), now() - interval '2 days', repeat('c', 64),
   'failed', '{}', '{}', now() - interval '2 days', now() - interval '2 days' + interval '5 minutes', 'Imp second', null, null),
  (pg_temp.id('run3'), 'no-intro', (select id from public.platforms where slug = 'snes'), 'Imp SNES snapshot 3.dat', repeat('d', 64), now() - interval '1 day', repeat('c', 64),
   'running', '{}', '{}', now() - interval '1 hour', null, 'Imp running', '0190aaaa-0000-7000-8000-00000000beef', now() + interval '5 minutes'),
  (pg_temp.id('run4'), 'wikidata', (select id from public.platforms where slug = 'nes'), 'Imp Wikidata snapshot.json', repeat('e', 64), now() - interval '1 day', null,
   'running', '{}', '{}', now() - interval '30 minutes', null, 'Imp stalled', '0190aaaa-0000-7000-8000-00000000cafe', now() - interval '1 minute');

-- run1's entries, in source order: a candidate it created, one failed, one held, one ignored.
select pg_temp.as_user('e1', 'select public.create_game(''Imp Harbor Lights'', ''game'', null, null, null, ''unknown'', ''Import tests'')::text') is not null;
insert into ids select 'game', id from public.games where title = 'Imp Harbor Lights';
insert into ids select 'release', pg_temp.as_user('e1', format('select public.create_release(%L, (select id from public.platforms where slug = ''snes''), ''rom-cartridge'', ''ntsc-uc'', ''{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "product_code": "IMP-1"}'', ''Import tests'')::text', pg_temp.id('game')))::uuid;
insert into ids select 'release2', pg_temp.as_user('e1', format('select public.create_release(%L, (select id from public.platforms where slug = ''snes''), ''rom-cartridge'', ''pal'', ''{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "product_code": "IMP-2"}'', ''Import tests'')::text', pg_temp.id('game')))::uuid;
insert into private.provider_records (id, provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, match_tier, match_notes, matched_game_id, matched_release_id, review_reason)
values
  ('01900000-0000-7000-8000-0000000000a1', 'no-intro', 'release', 'imp-1', '{"title": "Imp Harbor Lights", "secret_field": "payload only"}', repeat('1', 64), pg_temp.id('run1'), 'promoted', 'A', '{"candidates": ["x"]}', pg_temp.id('game'), pg_temp.id('release'), null),
  ('01900000-0000-7000-8000-0000000000a2', 'no-intro', 'release', 'imp-2', '{"title": "Imp Broken Entry"}', repeat('2', 64), pg_temp.id('run1'), 'failed', null, '{"error": "unknown medium"}', null, null, null),
  ('01900000-0000-7000-8000-0000000000a3', 'no-intro', 'release', 'imp-3', '{"title": "Imp Held Entry"}', repeat('3', 64), pg_temp.id('run1'), 'needs_review', null, '{"serial_also_on": ["y"]}', null, null, 'nintendo power flash'),
  ('01900000-0000-7000-8000-0000000000a4', 'no-intro', 'release', 'imp-4', '{"title": "Imp Prototype"}', repeat('4', 64), pg_temp.id('run1'), 'ignored', null, '{"ignored": "prototype"}', null, null, null),
  ('01900000-0000-7000-8000-0000000000a5', 'no-intro', 'release', 'imp-5', '{"title": "Imp Second Candidate"}', repeat('5', 64), pg_temp.id('run1'), 'promoted', 'B', '{}', pg_temp.id('game'), pg_temp.id('release2'), null);
insert into private.import_run_records (import_run_id, provider_record_id, position)
select pg_temp.id('run1'), id, row_number() over (order by id) - 1 from private.provider_records where import_run_id = pg_temp.id('run1');
-- A later run reconsidered both candidates: one queued for an editor, one withdrawn.
insert into private.catalog_reclassifications (id, release_id, provider_record_id, import_run_id, action, reason)
values ('01900000-0000-7000-8000-0000000000c1', pg_temp.id('release'), '01900000-0000-7000-8000-0000000000a1', pg_temp.id('run2'), 'queued', 'Source now tags it a prototype; an editor changed it'),
       ('01900000-0000-7000-8000-0000000000c2', pg_temp.id('release2'), '01900000-0000-7000-8000-0000000000a5', pg_temp.id('run2'), 'withdrawn', 'Source now tags it a prototype');

-- ---------------------------------------------------------------------------
-- 1. Grants and definitions
-- ---------------------------------------------------------------------------
select is(
  (select string_agg(p.proname || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ','), ''), ' ' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('get_import_providers', 'get_import_runs', 'get_import_run', 'get_import_run_records', 'get_system_status')),
  'get_import_providers:true:search_path="" get_import_run:true:search_path="" get_import_run_records:true:search_path="" get_import_runs:true:search_path="" get_system_status:true:search_path=""',
  'each read is SECURITY DEFINER with an empty search_path');
select is(
  (select string_agg(f || '=' || has_function_privilege('authenticated', f, 'execute') || '/' || has_function_privilege('anon', f, 'execute')
     || '/' || has_function_privilege('service_role', f, 'execute') || '/' || has_function_privilege('catalog_importer', f, 'execute'), ' ' order by f collate "C")
   from unnest(array['public.get_import_providers()', 'public.get_import_runs(integer, uuid, text, text)', 'public.get_import_run(uuid)',
                     'public.get_import_run_records(uuid, text, integer, integer)', 'public.get_system_status()']) f),
  'public.get_import_providers()=true/false/false/false public.get_import_run(uuid)=true/false/false/false public.get_import_run_records(uuid, text, integer, integer)=true/false/false/false public.get_import_runs(integer, uuid, text, text)=true/false/false/false public.get_system_status()=true/false/false/false',
  'only authenticated may execute them: not anon, service_role or the importer');
select is(
  (select bool_or(has_function_privilege(r, 'private.import_run_summary(private.import_runs)', 'execute')) from unnest(array['authenticated', 'anon', 'service_role', 'catalog_importer']) r),
  false, 'the private run summary is reachable by no API role or the importer');

-- ---------------------------------------------------------------------------
-- 2. Administrators only (D8)
-- ---------------------------------------------------------------------------
create temp table calls (name text, sql text);
grant select on calls to authenticated, anon;
insert into calls values
  ('providers', 'select public.get_import_providers()::text'),
  ('runs', 'select public.get_import_runs()::text'),
  ('run', format('select public.get_import_run(%L)::text', pg_temp.id('run1'))),
  ('records', format('select public.get_import_run_records(%L)::text', pg_temp.id('run1'))),
  ('system', 'select public.get_system_status()::text');
select is((select string_agg(c.name || '=' || pg_temp.as_anon(c.sql), ' ' order by c.name) from calls c),
  'providers=error: permission denied for function get_import_providers records=error: permission denied for function get_import_run_records run=error: permission denied for function get_import_run runs=error: permission denied for function get_import_runs system=error: permission denied for function get_system_status',
  'anon is refused by PostgreSQL itself');
select is((select string_agg(distinct pg_temp.as_user('c1', c.sql), ' ') from calls c), 'error: not permitted', 'a collector is refused');
select is((select string_agg(distinct pg_temp.as_user('e1', c.sql), ' ') from calls c), 'error: not permitted', 'a catalog editor is refused (D8)');
select is((select string_agg(distinct pg_temp.as_user('b1', c.sql), ' ') from calls c), 'error: not permitted', 'a moderator is refused');
select is((select string_agg(distinct pg_temp.as_user('a2', c.sql), ' ') from calls c), 'error: not permitted', 'a suspended administrator is refused');
select is((select string_agg(distinct pg_temp.as_aal1('a1', c.sql), ' ') from calls c), 'error: not permitted', 'an administrator without a verified session is refused');
create temp table audit_before as select count(*) as n from private.audit_events;
select is((select count(*)::int from calls c where pg_temp.as_user('a1', c.sql) like 'error%'), 0, 'an administrator with a verified session reads each');
select is((select count(*) from private.audit_events) - (select n from audit_before), 0::bigint, 'reading writes nothing to the audit log');

-- ---------------------------------------------------------------------------
-- 3. Providers
-- ---------------------------------------------------------------------------
create function pg_temp.providers() returns jsonb language sql as $$ select pg_temp.as_user('a1', 'select public.get_import_providers()::text')::jsonb $$;
select is((select string_agg(p ->> 'code', ',') from jsonb_array_elements(pg_temp.providers()) p), 'no-intro,wikidata', 'every source, by name');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.providers() -> 0) k),
  'cleared_note,code,commercial_use_cleared,last_run_at,name,runs,runs_running,source_records,terms_reviewed_at,terms_sha256,terms_url,updated_at', 'with fixed keys');
select is((select p ->> 'runs' || '/' || (p ->> 'runs_running') || '/' || (p ->> 'source_records') || '/' || (p ->> 'commercial_use_cleared')
           from jsonb_array_elements(pg_temp.providers()) p where p ->> 'code' = 'no-intro'), '3/1/5/false', 'its runs, those running, its entries and its clearance');

-- ---------------------------------------------------------------------------
-- 4. Runs
-- ---------------------------------------------------------------------------
create function pg_temp.runs(p_args text default '') returns jsonb language sql as $$ select pg_temp.as_user('a1', 'select public.get_import_runs(' || p_args || ')::text')::jsonb $$;
select is((select string_agg(r ->> 'reason', ',') from jsonb_array_elements(pg_temp.runs()) r where r ->> 'reason' like 'Imp%'), 'Imp stalled,Imp running,Imp second,Imp pilot', 'runs, newest first');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.runs() -> 0) k),
  'finished_at,id,lease_expires_at,lease_live,platform,provider_code,provider_name,reason,source_fetched_at,source_name,source_sha256,started_at,stats,status,terms_sha256',
  'with fixed keys: no lease id or checkpoint');
select is((select count(*)::int from jsonb_array_elements(pg_temp.runs()) r where r::text like '%beef%' or r::text like '%cafe%' or r::text like '%secret-position%'), 0, 'and neither appears anywhere in the result');
select is((select r -> 'stats' from jsonb_array_elements(pg_temp.runs()) r where r ->> 'id' = pg_temp.id('run1')::text), '{"staged_new": 3, "staged_ignored": 1}'::jsonb, 'stats keeps only numbers');
select is((select string_agg(r ->> 'reason' || '=' || (r ->> 'lease_live'), ',') from jsonb_array_elements(pg_temp.runs()) r where r ->> 'status' = 'running'), 'Imp stalled=false,Imp running=true', 'a running run shows whether its lease is live');
select is((select r -> 'platform' ->> 'slug' from jsonb_array_elements(pg_temp.runs()) r where r ->> 'id' = pg_temp.id('run1')::text), 'snes', 'and its platform');
select is(jsonb_array_length(pg_temp.runs('1')), 1, 'a page of one');
select is(jsonb_array_length(pg_temp.runs('0')), 1, 'a limit under 1 is 1');
select is(pg_temp.as_user('a1', 'select public.get_import_runs(100000)::text') like 'error%', false, 'a limit over 100 is allowed, and capped');
select is((select string_agg(r ->> 'reason', ',') from jsonb_array_elements(pg_temp.runs(format('25, %L', pg_temp.id('run3')))) r where r ->> 'reason' like 'Imp%'), 'Imp second,Imp pilot', 'older runs page by id');
select is((select string_agg(r ->> 'reason', ',') from jsonb_array_elements(pg_temp.runs('25, null, ''wikidata''')) r where r ->> 'reason' like 'Imp%'), 'Imp stalled', 'by source');
select is((select string_agg(r ->> 'reason', ',') from jsonb_array_elements(pg_temp.runs('25, null, null, ''failed''')) r where r ->> 'reason' like 'Imp%'), 'Imp second', 'by status');
select is(pg_temp.as_user('a1', 'select public.get_import_runs(25, null, null, ''deleted'')::text'), 'error: invalid filter', 'an unknown status is refused');
select is(pg_temp.as_user('a1', 'select public.get_import_runs(25, null, ''No Intro!'')::text'), 'error: invalid filter', 'so is a malformed source code');
select is(pg_temp.as_user('a1', format('select count(*)::text from public.get_import_runs(100) r, jsonb_array_elements(r) x')) ~ '^[0-9]+$', true, 'the result is an array');
select is(pg_temp.as_user('a1', 'select jsonb_array_length(public.get_import_runs(25, null, ''steam''))::text'), '0', 'a source without runs has none');
-- A hundred more runs: the read still returns at most 100.
insert into private.import_runs (provider_code, source_name, source_sha256, source_fetched_at, status, started_at, finished_at)
select 'wikidata', 'Imp bulk ' || i, repeat('f', 64), now(), 'completed', now() - interval '4 days', now() - interval '4 days' from generate_series(1, 105) i;
select is(jsonb_array_length(pg_temp.runs('500')), 100, 'a page never holds more than 100');

-- ---------------------------------------------------------------------------
-- 5. One run
-- ---------------------------------------------------------------------------
create function pg_temp.run(p text) returns jsonb language sql as $$ select pg_temp.as_user('a1', format('select public.get_import_run(%L)::text', pg_temp.id(p)))::jsonb $$;
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.run('run1')) k), 'failed,needs_review,reclassifications,reclassifications_total,report,run', 'a run has fixed keys');
select is(pg_temp.run('run1') -> 'run' ->> 'reason', 'Imp pilot', 'its summary');
select is(pg_temp.run('run1') -> 'report' ? 'run', false, 'and its report, without a second copy of the run');
select is((pg_temp.run('run1') -> 'report' ->> 'source_records')::int, 5, 'which counts its entries');
select is((pg_temp.run('run1') -> 'report' ->> 'releases_created')::int, 2, 'and the candidates it created');
select is(pg_temp.run('run1') ->> 'failed' || '/' || (pg_temp.run('run1') ->> 'needs_review'), '1/1', 'one failed, one waiting for review');
select is(pg_temp.run('run1') -> 'report' -> 'ignored_reasons', '{"prototype": 1}'::jsonb, 'ignored entries by reason');
select is(pg_temp.run('run1') -> 'report' -> 'held_reasons', '{"nintendo power flash": 1}'::jsonb, 'held entries by reason');
select is((select string_agg(c ->> 'action', ',' order by c ->> 'action') from jsonb_array_elements(pg_temp.run('run2') -> 'reclassifications') c), 'queued,withdrawn', 'the run that reconsidered candidates lists them');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.run('run2') -> 'reclassifications' -> 0) k), 'action,created_at,id,reason,release_id,resolution,resolved_at', 'each with fixed keys: nobody named');
select is((pg_temp.run('run2') ->> 'reclassifications_total')::int, 2, 'and how many there are');
select is(pg_temp.as_user('a1', 'select coalesce(public.get_import_run(gen_random_uuid())::text, ''none'')'), 'none', 'an unknown run is null');
select is((select count(*)::int from jsonb_each_text(pg_temp.run('run3') -> 'run') e where e.value like '%beef%'), 0, 'a running run''s lease id never appears');

-- ---------------------------------------------------------------------------
-- 6. Staged entries
-- ---------------------------------------------------------------------------
create function pg_temp.records(p_args text) returns jsonb language sql as $$ select pg_temp.as_user('a1', format('select public.get_import_run_records(%L%s)::text', pg_temp.id('run1'), p_args))::jsonb $$;
select is((select string_agg(r ->> 'external_id', ',') from jsonb_array_elements(pg_temp.records('')) r), 'imp-1,imp-2,imp-3,imp-4,imp-5', 'entries in source order');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.records('') -> 0) k),
  'entity_type,error,external_id,id,ignored,match_tier,matched_game_id,matched_release_id,position,possible_duplicate,review_reason,shared_serial,status,title',
  'with fixed keys: no raw payload or match notes');
select is((select count(*)::int from jsonb_array_elements(pg_temp.records('')) r where r::text like '%payload only%'), 0, 'nothing else from the payload appears');
select is((select r ->> 'error' from jsonb_array_elements(pg_temp.records('')) r where r ->> 'external_id' = 'imp-2'), 'unknown medium', 'a failure shows its error');
select is((select (r ->> 'review_reason') || '/' || (r ->> 'shared_serial') from jsonb_array_elements(pg_temp.records('')) r where r ->> 'external_id' = 'imp-3'), 'nintendo power flash/true', 'a held entry its reason and a shared serial');
select is((select (r ->> 'ignored') || '/' || (r ->> 'status') from jsonb_array_elements(pg_temp.records('')) r where r ->> 'external_id' = 'imp-4'), 'prototype/ignored', 'an ignored one why');
select is((select (r ->> 'possible_duplicate') || '/' || (r ->> 'matched_release_id') from jsonb_array_elements(pg_temp.records('')) r where r ->> 'external_id' = 'imp-1'), 'true/' || pg_temp.id('release'), 'a created candidate links to its release');
select is((select string_agg(r ->> 'external_id', ',') from jsonb_array_elements(pg_temp.records(', ''failed''')) r), 'imp-2', 'by status');
select is((select string_agg(r ->> 'external_id', ',') from jsonb_array_elements(pg_temp.records(', null, 2')) r), 'imp-1,imp-2', 'a page of two');
select is((select string_agg(r ->> 'external_id', ',') from jsonb_array_elements(pg_temp.records(', null, 2, 1')) r), 'imp-3,imp-4', 'the next page, after a position');
select is(jsonb_array_length(pg_temp.records(', null, 0')), 1, 'a limit under 1 is 1');
select is(pg_temp.as_user('a1', format('select public.get_import_run_records(%L, ''deleted'')::text', pg_temp.id('run1'))), 'error: invalid filter', 'an unknown status is refused');
select is(pg_temp.as_user('a1', 'select public.get_import_run_records(gen_random_uuid())::text'), '[]', 'an unknown run has no entries');
insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status)
select 'wikidata', 'game', 'imp-bulk-' || i, jsonb_build_object('title', 'Imp bulk ' || i), lpad(to_hex(i), 64, '0'), pg_temp.id('run4'), 'fetched' from generate_series(1, 120) i;
insert into private.import_run_records (import_run_id, provider_record_id, position)
select pg_temp.id('run4'), id, row_number() over (order by id) from private.provider_records where import_run_id = pg_temp.id('run4');
select is(pg_temp.as_user('a1', format('select jsonb_array_length(public.get_import_run_records(%L, null, 1000))::text', pg_temp.id('run4'))), '100', 'a page never holds more than 100');

-- ---------------------------------------------------------------------------
-- 7. The system view (D7)
-- ---------------------------------------------------------------------------
create function pg_temp.system() returns jsonb language sql as $$ select pg_temp.as_user('a1', 'select public.get_system_status()::text')::jsonb $$;
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.system()) k), 'cap,catalog,checked_at,importer,migrations,providers,reference', 'fixed keys');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.system() -> 'importer') k), 'last_run_at,leases_expired,login_enabled,runs_running', 'the importer: only its state');
select is(pg_temp.system() -> 'importer' ->> 'login_enabled', (select rolcanlogin::text from pg_roles where rolname = 'catalog_importer'), 'whether the importer can log in, as the role says');
select is(pg_temp.system() -> 'importer' ->> 'runs_running' || '/' || (pg_temp.system() -> 'importer' ->> 'leases_expired'), '2/1', 'runs in progress, and those stopped with an expired lease');
select is(pg_temp.system() -> 'migrations' ->> 'latest', (select max(version) from supabase_migrations.schema_migrations), 'the latest migration');
select is((pg_temp.system() -> 'migrations' ->> 'applied')::int, (select count(*)::int from supabase_migrations.schema_migrations), 'and how many are applied');
select is(pg_temp.system() -> 'providers', '{"total": 2, "cleared": 0}'::jsonb, 'sources, and those cleared');
select is((pg_temp.system() -> 'reference' ->> 'platforms')::int, (select count(*)::int from public.platforms), 'reference data counts');
select is(pg_temp.system() ? 'owner_assigned', false, 'nothing from the Owner record, which get_ownership_status covers');
select is((select count(*)::int from jsonb_each_text(pg_temp.system()) e
           where e.value ~* '(postgres(ql)?://|password|secret|service_role|jwt|apikey|supabase\.co|localhost|127\.0\.0\.1)'), 0, 'no address, key or credential');

-- ---------------------------------------------------------------------------
-- 8. Resolving a reclassification item (resolve_catalog_review, M5b)
-- ---------------------------------------------------------------------------
-- The queue and its resolution are catalog editors' work, as in M5b; nothing about
-- them changed in M10d.
select is(pg_temp.as_user('e1', 'select string_agg(id::text, '','') from public.get_catalog_review_queue(200)'), '01900000-0000-7000-8000-0000000000c1', 'an editor reads the open item, not the withdrawn one');
select is(pg_temp.as_user('b1', 'select count(*)::text from public.get_catalog_review_queue(200)'), 'error: not permitted', 'a moderator can''t');
select is(pg_temp.as_user('c1', 'select public.resolve_catalog_review(''01900000-0000-7000-8000-0000000000c1'', ''Checked'')::text'), 'error: not permitted', 'a collector can''t resolve');
select is(pg_temp.as_user('b1', 'select public.resolve_catalog_review(''01900000-0000-7000-8000-0000000000c1'', ''Checked'')::text'), 'error: not permitted', 'nor a moderator');
select is(pg_temp.as_aal1('e1', 'select public.resolve_catalog_review(''01900000-0000-7000-8000-0000000000c1'', ''Checked'')::text'), 'error: not permitted', 'nor an editor without a verified session');
select is(pg_temp.as_anon('select public.resolve_catalog_review(''01900000-0000-7000-8000-0000000000c1'', ''Checked'')::text'), 'error: permission denied for function resolve_catalog_review', 'nor anon');
select is(pg_temp.as_user('e1', 'select public.resolve_catalog_review(''01900000-0000-7000-8000-0000000000c1'', ''  '')::text'), 'error: reason required', 'a resolution needs a reason');
select is(pg_temp.as_user('e1', 'select public.resolve_catalog_review(''01900000-0000-7000-8000-0000000000c2'', ''Checked'')::text'), 'error: record unavailable', 'a withdrawn item can''t be resolved');
create temp table release_before as select id, revision, status, verified_at, updated_at from public.releases where id = pg_temp.id('release');
select is(pg_temp.as_user('e6', 'select public.resolve_catalog_review(''01900000-0000-7000-8000-0000000000c1'', ''Checked: the editor''''s changes stand'')::text'), 'true',
  'an editor resolves it with a live session: a recent verification isn''t needed, as no catalog record changes (D3)');
select is((select resolved_by::text || '/' || resolution from private.catalog_reclassifications where id = '01900000-0000-7000-8000-0000000000c1'),
  pg_temp.u('e6')::text || '/Checked: the editor''s changes stand', 'the item records who resolved it and how');
select is((select count(*)::int from public.releases r join release_before b using (id)
           where (r.revision, r.status, r.verified_at, r.updated_at) is not distinct from (b.revision, b.status, b.verified_at, b.updated_at)), 1, 'the release didn''t change');
select is((select a.reason || '/' || (a.metadata ->> 'review_id') || '/' || (a.metadata ->> 'id') from private.audit_events a
           where a.action = 'catalog_review_resolved' and a.actor_id = pg_temp.u('e6')),
  'Checked: the editor''s changes stand/01900000-0000-7000-8000-0000000000c1/' || pg_temp.id('release'), 'the resolution is audited, with its reason, item and release');
select is(pg_temp.as_user('e1', 'select public.resolve_catalog_review(''01900000-0000-7000-8000-0000000000c1'', ''Again'')::text'), 'error: record unavailable', 'it can''t be resolved twice');
select is(pg_temp.as_user('e1', 'select count(*)::text from public.get_catalog_review_queue(200)'), '0', 'and it leaves the queue');
select is((pg_temp.run('run2') -> 'reclassifications' -> 0 ->> 'resolution'), 'Checked: the editor''s changes stand', 'the run shows the resolution to administrators');

select * from finish();
rollback;
