-- M5b: the catalog importer's role, gates, staging, matching and candidates.
-- This file calls the importer functions as their owner, so it covers their rules.
-- Logging in as catalog_importer, and concurrent runs, are in db-import-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(91);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
-- Runs a statement and returns its result, or the error, as text.
create function pg_temp.try(p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  execute p_sql into r;
  return coalesce(r, '');
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
create temp table ids (name text primary key, id uuid not null);
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
create function pg_temp.keep(p text, v text) returns text language plpgsql as $$
begin
  insert into ids values (p, v::uuid);
  return v;
exception when others then
  return 'error: ' || coalesce(v, 'null');
end $$;
create function pg_temp.platform(p text) returns uuid language sql stable as $$ select id from public.platforms where slug = p $$;
create function pg_temp.rec(p_provider text, p_external_id text) returns uuid language sql stable as $$
  select id from private.provider_records where provider_code = p_provider and external_id = p_external_id order by created_at desc, id desc limit 1 $$;
create function pg_temp.apply(p_run text, p_lease text, p_provider text, p_external_id text) returns text language sql as $$
  select pg_temp.try(format('select catalog_import.apply_record(%L, %L, %L, null)::text', pg_temp.id(p_run), pg_temp.u(p_lease), pg_temp.rec(p_provider, p_external_id))) $$;
create function pg_temp.outcome(p text) returns text language sql immutable as $$ select case when p like 'error%' then p else (p::jsonb ->> 'outcome') end $$;

-- ---------------------------------------------------------------------------
-- The role and its grants
-- ---------------------------------------------------------------------------
select is((select format('%s/%s/%s/%s/%s/%s/%s/%s', rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolconnlimit)
  from pg_roles where rolname = 'catalog_importer'), 'f/f/f/f/f/f/f/4', 'catalog_importer is a restricted role without login until an operator enables it');
select is((select count(*)::int from pg_auth_members m where m.member = 'catalog_importer'::regrole), 0, 'it is a member of no other role');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace,
    unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
  where c.relkind in ('r', 'v', 'm', 'p', 'f') and n.nspname in ('public', 'private', 'auth', 'storage', 'vault', 'catalog_import', 'realtime')
    and has_table_privilege('catalog_importer', c.oid, p)), 0, 'it has no privilege on any table');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'v', 'm', 'p', 'f') and n.nspname in ('public', 'private') and has_any_column_privilege('catalog_importer', c.oid, 'select')), 0, 'or on any column');
select is((select array_agg(nspname::text order by nspname) from pg_namespace where nspname in ('private', 'auth', 'storage', 'vault', 'extensions', 'graphql', 'realtime', 'catalog_import')
  and has_schema_privilege('catalog_importer', oid, 'usage')), array['catalog_import'], 'of the protected schemas, it can use only catalog_import');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'catalog_import') and has_function_privilege('catalog_importer', p.oid, 'execute')),
  array['apply_record', 'claim_run', 'finish_run', 'mark_record_failed', 'pending_records', 'run_report', 'stage_records', 'start_run'],
  'it can call only the import functions: never an editor, verification or publication function');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'catalog_import' and p.prosecdef and p.proconfig = array['search_path=""']), 8, 'each import function runs as its owner with an empty search_path');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r, pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'catalog_import' and has_function_privilege(r, p.oid, 'execute')), 0, 'no API role can call an import function');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r where has_schema_privilege(r, 'catalog_import', 'usage')), 0, 'or use the import schema');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r, pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and (p.proname like 'import\_%' or p.proname in ('record_provider_clearance', 'guard_provider_record')) and has_function_privilege(r, p.oid, 'execute')),
  0, 'no client role or the importer can call an import helper or clear a provider');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r
  where has_table_privilege(r, 'private.import_run_records', 'select')), 0, 'run entries are private');

-- ---------------------------------------------------------------------------
-- Commercial-use clearance (gate 1)
-- ---------------------------------------------------------------------------
select is((select string_agg(code || '/' || commercial_use_cleared, ',' order by code) from private.external_providers where code in ('wikidata', 'no-intro')),
  'no-intro/false,wikidata/false', 'the pilot sources exist, not cleared');
select is(pg_temp.try(format($$select catalog_import.start_run('wikidata', 'snes', 'w.json', %L, now(), %L, 'Pilot', %L)::text$$, repeat('a', 64), repeat('1', 64), pg_temp.u('f1'))),
  'error: provider not cleared', 'an uncleared source can''t be imported');
select is(pg_temp.try($$select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', repeat('1', 64), '')::text$$),
  'error: reason required', 'clearance needs a note');
select lives_ok($$select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', repeat('1', 64), 'CC0 data, terms reviewed')$$, 'an operator clears a source');
select is((select count(*)::int from private.audit_events where action = 'catalog_provider_cleared' and metadata ->> 'provider' = 'wikidata' and actor_id is null), 1, 'which is audited');
select is(pg_temp.try(format($$select catalog_import.start_run('wikidata', 'snes', 'w.json', %L, now(), %L, 'Pilot', %L)::text$$, repeat('a', 64), repeat('9', 64), pg_temp.u('f1'))),
  'error: terms not cleared', 'a run must cite the terms that were reviewed');
select is(pg_temp.try(format($$select catalog_import.start_run('wikidata', 'snes', 'w.json', %L, now(), %L, '', %L)::text$$, repeat('a', 64), repeat('1', 64), pg_temp.u('f1'))),
  'error: reason required', 'a run needs the operator''s reason');
select ok(pg_temp.keep('w1', pg_temp.try(format($$select catalog_import.start_run('wikidata', 'snes', 'w.json', %L, now(), %L, 'SNES pilot', %L)::text$$, repeat('a', 64), repeat('1', 64), pg_temp.u('f1'))))
  not like 'error%', 'a cleared source can be imported');
select is((select count(*)::int from private.audit_events where action = 'catalog_import_run' and metadata ->> 'event' = 'started' and metadata ->> 'run_id' = pg_temp.id('w1')::text and reason = 'SNES pilot'),
  1, 'the start is audited with the operator''s reason');

-- ---------------------------------------------------------------------------
-- One run per snapshot, one process per run (gate 3)
-- ---------------------------------------------------------------------------
select is(pg_temp.try(format($$select catalog_import.start_run('wikidata', 'snes', 'w.json', %L, now(), %L, 'Again', %L)::text$$, repeat('a', 64), repeat('1', 64), pg_temp.u('f2'))),
  'error: snapshot already running', 'the same snapshot can''t be run twice at once');
select throws_ok(format($$insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at) values ('wikidata', %L, 'x', %L, now())$$, pg_temp.platform('snes'), repeat('a', 64)),
  '23505', null, 'even past the function, by a unique index');
select is(pg_temp.try(format($$select catalog_import.stage_records(%L, %L, '[]', null)::text$$, pg_temp.id('w1'), pg_temp.u('f2'))), 'error: run in use', 'another process can''t work on a run it doesn''t hold');
select is(pg_temp.try(format($$select catalog_import.claim_run(%L, %L, %L)::text$$, pg_temp.id('w1'), pg_temp.u('f2'), repeat('a', 64))), 'error: run in use', 'or take it over while the lease is live');
update private.import_runs set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('w1');
select is(pg_temp.try(format($$select catalog_import.claim_run(%L, %L, %L)::text$$, pg_temp.id('w1'), pg_temp.u('f2'), repeat('e', 64))), 'error: snapshot differs', 'a run resumes only from its own snapshot');
select is(pg_temp.try(format($$select catalog_import.claim_run(%L, %L, %L)::text$$, pg_temp.id('w1'), pg_temp.u('f2'), repeat('a', 64))), '{}', 'an expired lease can be taken over, to resume');
select is(pg_temp.try(format($$select catalog_import.stage_records(%L, %L, '[]', null)::text$$, pg_temp.id('w1'), pg_temp.u('f1'))), 'error: run in use', 'and the old process is shut out');

-- ---------------------------------------------------------------------------
-- Staging and idempotency
-- ---------------------------------------------------------------------------
select is(pg_temp.try(format($$select catalog_import.stage_records(%L, %L, %L, '{"staged": 6}')::text$$, pg_temp.id('w1'), pg_temp.u('f2'), '[
  {"entity_type": "game", "external_id": "Q1", "payload": {"title": "Super Metroid", "titles": ["Super Metroid", "Metroid 3"]}},
  {"entity_type": "game", "external_id": "Q2", "payload": {"title": "Pilotwings"}},
  {"entity_type": "game", "external_id": "Q3", "payload": {"title": "F-Zero"}},
  {"entity_type": "game", "external_id": "Q4", "payload": {"title": "Axelay"}},
  {"entity_type": "game", "external_id": "Q5", "payload": {"title": "Doom"}},
  {"entity_type": "game", "external_id": "Q6", "payload": {"title": "Doom"}}]'))::jsonb ->> 'new', '6', 'six entries are staged');
select is(pg_temp.try(format($$select catalog_import.stage_records(%L, %L, %L, null)::text$$, pg_temp.id('w1'), pg_temp.u('f2'),
  '[{"entity_type": "game", "external_id": "Q2", "payload": {"title": "Pilotwings"}}]'))::jsonb ->> 'unchanged', '1', 'an entry staged again is found, not added');
select is((select count(*)::int from private.provider_records where provider_code = 'wikidata' and external_id = 'Q2'), 1, 'so it is stored once');
select is((select payload_sha256 = encode(sha256(convert_to(payload::text, 'UTF8')), 'hex') from private.provider_records where id = pg_temp.rec('wikidata', 'Q1')), true,
  'the database computes each entry''s hash');
select is(pg_temp.try(format($$select catalog_import.stage_records(%L, %L, %L, null)::text$$, pg_temp.id('w1'), pg_temp.u('f2'), '[{"entity_type": "game", "external_id": "Q9", "payload": {}, "status": "published"}]')),
  'error: invalid source entry', 'an entry can''t carry other fields');
select throws_ok(format($$update private.provider_records set payload = '{"title": "Other"}' where id = %L$$, pg_temp.rec('wikidata', 'Q1')), '23514', 'source records can''t be changed', 'a source record never changes');
select is((select string_agg(record_position::text, ',') from catalog_import.pending_records(pg_temp.id('w1'), pg_temp.u('f2'), -1, 100)), '0,1,2,3,4,5', 'every staged entry is pending, in source order');

-- ---------------------------------------------------------------------------
-- Game candidates
-- ---------------------------------------------------------------------------
-- An editor's game, on the platform, without a source id.
insert into public.games (id, title, sort_title, kind, status) values (pg_temp.u('a4'), 'Axelay', 'Axelay', 'game', 'under_review');
insert into public.game_platforms (game_id, platform_id, status) values (pg_temp.u('a4'), pg_temp.platform('snes'), 'under_review');

select is(pg_temp.outcome(pg_temp.apply('w1', 'f2', 'wikidata', 'Q1')), 'created', 'a new source entry creates a game candidate');
select ok(pg_temp.keep('g1', (select matched_game_id::text from private.provider_records where id = pg_temp.rec('wikidata', 'Q1'))) not like 'error%', 'linked to its record');
select is((select status || '/' || coalesce(verified_at::text, 'unverified') || '/' || kind from public.games where id = pg_temp.id('g1')), 'under_review/unverified/game', 'under review and unverified');
select is((select status::text from public.game_platforms where game_id = pg_temp.id('g1') and platform_id = pg_temp.platform('snes')), 'under_review', 'with an unpublished pairing');
select is((select count(*)::int from private.external_references where provider_code = 'wikidata' and external_id = 'Q1' and game_id = pg_temp.id('g1')), 1, 'and its source id');
select is((select count(*)::int from private.audit_events where action = 'catalog_record_created' and actor_id is null and reason = 'SNES pilot'
  and metadata ->> 'id' = pg_temp.id('g1')::text and metadata ->> 'import_run_id' = pg_temp.id('w1')::text), 1, 'the creation is audited, naming the run');
select is(pg_temp.outcome(pg_temp.apply('w1', 'f2', 'wikidata', 'Q1')), 'skipped', 'applying it again changes nothing');
select is(pg_temp.outcome(pg_temp.apply('w1', 'f2', 'wikidata', 'Q4')), 'ambiguous', 'a source game with the title of a game already on the platform isn''t created');
select is((select match_tier || '/' || status || '/' || (match_notes -> 'candidates' ->> 0) from private.provider_records where id = pg_temp.rec('wikidata', 'Q4')),
  'B/needs_review/' || pg_temp.u('a4'), 'it waits for review, naming the possible duplicate');
select is(pg_temp.outcome(pg_temp.apply('w1', 'f2', 'wikidata', 'Q5')) || ',' || pg_temp.outcome(pg_temp.apply('w1', 'f2', 'wikidata', 'Q6')), 'created,created',
  'two source entries with one title are two games, as the source says');
select is(pg_temp.outcome(pg_temp.apply('w1', 'f2', 'wikidata', 'Q2')) || ',' || pg_temp.outcome(pg_temp.apply('w1', 'f2', 'wikidata', 'Q3')), 'created,created', 'the rest are created');
select lives_ok(format($$select catalog_import.finish_run(%L, %L, 'completed')$$, pg_temp.id('w1'), pg_temp.u('f2')), 'the run finishes');
select is(pg_temp.try(format($$select catalog_import.stage_records(%L, %L, '[]', null)::text$$, pg_temp.id('w1'), pg_temp.u('f2'))), 'error: run unavailable', 'and takes no more entries');

-- A later snapshot: changed entries fill only empty, unlocked, unverified fields (gates 4 and 6).
select ok(pg_temp.keep('w2', pg_temp.try(format($$select catalog_import.start_run('wikidata', 'snes', 'w2.json', %L, now(), %L, 'SNES pilot, second snapshot', %L)::text$$, repeat('b', 64), repeat('1', 64), pg_temp.u('f3'))))
  not like 'error%', 'a later snapshot starts');
insert into private.catalog_field_locks (game_id, field_name) values ((select game_id from private.external_references where external_id = 'Q2'), 'first_release_date');
update public.games set verified_at = now() where id = (select game_id from private.external_references where external_id = 'Q3');
select is(pg_temp.try(format($$select catalog_import.stage_records(%L, %L, %L, null)::text$$, pg_temp.id('w2'), pg_temp.u('f3'), '[
  {"entity_type": "game", "external_id": "Q1", "payload": {"title": "Super Metroid", "titles": ["Super Metroid", "Metroid 3"], "first_release_date": "1994-03-19", "first_release_precision": "day"}},
  {"entity_type": "game", "external_id": "Q2", "payload": {"title": "Pilotwings", "first_release_date": "1990-12-21", "first_release_precision": "day"}},
  {"entity_type": "game", "external_id": "Q3", "payload": {"title": "F-Zero", "first_release_date": "1990-11-21", "first_release_precision": "day"}},
  {"entity_type": "game", "external_id": "Q5", "payload": {"title": "Doom"}}]'))::jsonb::text, '{"new": 3, "changed": 3, "ignored": 0, "repeated": 0, "unchanged": 1}', 'changed entries are new records, an unchanged one is found');
select is(pg_temp.outcome(pg_temp.apply('w2', 'f3', 'wikidata', 'Q1')), 'matched', 'a known source id resolves to its game, not a new one');
select is((select first_release_date::text from public.games where id = pg_temp.id('g1')), '1994-03-19', 'and fills its empty date');
select is((select count(*)::int from private.audit_events where action = 'catalog_record_updated' and actor_id is null and metadata ->> 'id' = pg_temp.id('g1')::text), 1, 'which is audited');
select is(pg_temp.outcome(pg_temp.apply('w2', 'f3', 'wikidata', 'Q2')), 'matched', 'a game with a locked field is matched');
select is(coalesce((select first_release_date::text from public.games g join private.external_references x on x.game_id = g.id where x.external_id = 'Q2'), 'empty'),
  'empty', 'and the editor''s field lock is honoured');
select is(pg_temp.outcome(pg_temp.apply('w2', 'f3', 'wikidata', 'Q3')), 'matched', 'a verified game is matched');
select is(coalesce((select first_release_date::text from public.games g join private.external_references x on x.game_id = g.id where x.external_id = 'Q3'), 'empty'),
  'empty', 'and never changed');
select is((select count(*)::int from public.games g join private.external_references x on x.game_id = g.id where x.provider_code = 'wikidata'), 5, 'still one game per source id');
select lives_ok(format($$select catalog_import.finish_run(%L, %L, 'completed')$$, pg_temp.id('w2'), pg_temp.u('f3')), 'the second run finishes');

-- ---------------------------------------------------------------------------
-- Release candidates
-- ---------------------------------------------------------------------------
select lives_ok($$select private.record_provider_clearance('no-intro', true, 'https://datomatic.no-intro.org/', repeat('2', 64), 'Metadata use reviewed')$$, 'an operator clears the release source');
select ok(pg_temp.keep('n1', pg_temp.try(format($$select catalog_import.start_run('no-intro', 'snes', 'snes.dat', %L, now(), %L, 'SNES release pilot', %L)::text$$, repeat('c', 64), repeat('2', 64), pg_temp.u('f4'))))
  not like 'error%', 'a release snapshot starts');
select is(pg_temp.try(format($$select catalog_import.stage_records(%L, %L, %L, null)::text$$, pg_temp.id('n1'), pg_temp.u('f4'), '[
  {"entity_type": "release", "external_id": "Super Metroid (USA)", "payload": {"title": "Super Metroid", "region_codes": ["ntsc-uc"], "languages": ["en"], "serial": "SNS-RI-USA"}},
  {"entity_type": "release", "external_id": "Super Metroid (Japan, USA)", "payload": {"title": "Super Metroid", "region_codes": ["ntsc-j", "ntsc-uc"]}},
  {"entity_type": "release", "external_id": "Super Metroid (USA) (Alt)", "payload": {"title": "Super Metroid", "region_codes": ["ntsc-uc"], "serial": "SNS-RI-USA"}},
  {"entity_type": "release", "external_id": "Metroid 3 (Europe)", "payload": {"title": "Metroid 3", "region_codes": ["pal"]}},
  {"entity_type": "release", "external_id": "Doom (USA)", "payload": {"title": "Doom", "region_codes": ["ntsc-uc"]}},
  {"entity_type": "release", "external_id": "Unknown Title (Japan)", "payload": {"title": "Unknown Title", "region_codes": ["ntsc-j"]}},
  {"entity_type": "release", "external_id": "Super Metroid (USA) (Proto)", "payload": {"title": "Super Metroid"}, "ignore_reason": "prototype"}]'))::jsonb ->> 'ignored', '1', 'release entries are staged, a prototype as ignored');
select is(pg_temp.outcome(pg_temp.apply('n1', 'f4', 'no-intro', 'Super Metroid (USA)')), 'created', 'an entry matching one game creates a release candidate');
select ok(pg_temp.keep('r1', (select matched_release_id::text from private.provider_records where id = pg_temp.rec('no-intro', 'Super Metroid (USA)'))) not like 'error%', 'linked to its record');
select is((select concat_ws('/', game_id = pg_temp.id('g1'), status, region_code, region_unknown_confirmed, coalesce(edition_name, '-'), coalesce(edition_kind::text, '-'), coalesce(media_count::text, '-'),
    coalesce(packaging, '-'), media_format_code, product_code, array_to_string(languages, ','), coalesce(verified_at::text, 'unverified'))
  from public.releases where id = pg_temp.id('r1')), 't/under_review/ntsc-uc/f/-/-/-/-/rom-cartridge/SNS-RI-USA/en/unverified',
  'only what the source states is stored: no edition, kind, medium count or packaging');
select is((select string_agg(field_name, ',' order by field_name) from private.release_evidence where release_id = pg_temp.id('r1')), 'languages,platform,product_code,region_code',
  'each stored field has its evidence');
select is(pg_temp.outcome(pg_temp.apply('n1', 'f4', 'no-intro', 'Super Metroid (Japan, USA)')), 'created', 'an entry for several regions is created');
select is((select region_code || '/' || region_unknown_confirmed || '/' || (select count(*) from private.release_evidence e where e.release_id = r.id and e.field_name = 'region_code')
  from public.releases r where id = (select matched_release_id from private.provider_records where id = pg_temp.rec('no-intro', 'Super Metroid (Japan, USA)'))),
  'unknown/false/0', 'with its region unknown and unconfirmed, never guessed');
select is(pg_temp.outcome(pg_temp.apply('n1', 'f4', 'no-intro', 'Super Metroid (USA) (Alt)')), 'created', 'a different entry with the same serial is a separate candidate');
select is((select match_notes -> 'serial_also_on' ->> 0 from private.provider_records where id = pg_temp.rec('no-intro', 'Super Metroid (USA) (Alt)')), pg_temp.id('r1')::text,
  'never merged by serial, but the shared serial is noted for review');
select is(pg_temp.outcome(pg_temp.apply('n1', 'f4', 'no-intro', 'Metroid 3 (Europe)')), 'created', 'an entry under another title of the game is created');
select is((select (game_id = pg_temp.id('g1'))::text from public.releases where id = (select matched_release_id from private.provider_records where id = pg_temp.rec('no-intro', 'Metroid 3 (Europe)'))),
  'true', 'because the game''s source record lists that title');
select is(pg_temp.outcome(pg_temp.apply('n1', 'f4', 'no-intro', 'Doom (USA)')), 'ambiguous', 'an entry matching several games creates nothing');
select is((select match_tier || status from private.provider_records where id = pg_temp.rec('no-intro', 'Doom (USA)')),
  'Bneeds_review', 'and waits for review');
select is(pg_temp.outcome(pg_temp.apply('n1', 'f4', 'no-intro', 'Unknown Title (Japan)')), 'unmatched', 'an entry matching no game creates nothing, not even a game');
select is((select match_tier || status from private.provider_records where id = pg_temp.rec('no-intro', 'Unknown Title (Japan)')),
  'Cneeds_review', 'and waits for review');
select is(pg_temp.outcome(pg_temp.apply('n1', 'f4', 'no-intro', 'Super Metroid (USA) (Proto)')), 'skipped', 'an ignored entry is never applied');
select is((select count(*)::int from public.releases r join private.external_references x on x.release_id = r.id where x.provider_code = 'no-intro'
  and (r.status <> 'under_review' or r.verified_at is not null)) + (select count(*)::int from public.games g join private.external_references x on x.game_id = g.id
  where g.status <> 'under_review' or (g.verified_at is not null and x.external_id <> 'Q3')), 0, 'nothing imported is verified or published');

-- Evidence consistency (gate 5)
select throws_ok(format($$insert into private.release_evidence (release_id, field_name, provider_record_id) values (%L, 'region_code', %L)$$,
    (select matched_release_id from private.provider_records where id = pg_temp.rec('no-intro', 'Metroid 3 (Europe)')), pg_temp.rec('no-intro', 'Super Metroid (USA)')),
  '23514', 'release evidence must come from a source record matched to that release', 'a source record can''t be evidence for another release');
select throws_ok(format($$update private.provider_records set matched_release_id = (select matched_release_id from private.provider_records where id = %L) where id = %L$$,
    pg_temp.rec('no-intro', 'Metroid 3 (Europe)'), pg_temp.rec('no-intro', 'Super Metroid (USA)')),
  '23514', 'a source record with evidence can''t be matched to another release', 'or be moved to another release once it is evidence');

-- Locks and verification on releases (gate 4), and resolving source ids (gate 6)
select lives_ok(format($$select catalog_import.finish_run(%L, %L, 'completed')$$, pg_temp.id('n1'), pg_temp.u('f4')), 'the release run finishes');
select ok(pg_temp.keep('n2', pg_temp.try(format($$select catalog_import.start_run('no-intro', 'snes', 'snes2.dat', %L, now(), %L, 'SNES release pilot, second snapshot', %L)::text$$, repeat('d', 64), repeat('2', 64), pg_temp.u('f5'))))
  not like 'error%', 'a later release snapshot starts');
insert into private.catalog_field_locks (release_id, field_name)
values ((select matched_release_id from private.provider_records where id = pg_temp.rec('no-intro', 'Super Metroid (Japan, USA)')), 'product_code');
update public.releases set verified_at = now(), edition_name = 'Standard', edition_kind = 'standard', media_count = 1
where id = (select matched_release_id from private.provider_records where id = pg_temp.rec('no-intro', 'Metroid 3 (Europe)'));
select is(pg_temp.try(format($$select catalog_import.stage_records(%L, %L, %L, null)::text$$, pg_temp.id('n2'), pg_temp.u('f5'), '[
  {"entity_type": "release", "external_id": "Super Metroid (Japan, USA)", "payload": {"title": "Super Metroid", "region_codes": ["ntsc-j", "ntsc-uc"], "serial": "SHVC-RI", "languages": ["en", "ja"]}},
  {"entity_type": "release", "external_id": "Metroid 3 (Europe)", "payload": {"title": "Metroid 3", "region_codes": ["pal"], "serial": "SNSP-RI-EUR"}},
  {"entity_type": "release", "external_id": "Bad (USA)", "payload": {"title": "Bad"}}]'))::jsonb ->> 'changed', '2', 'changed release entries are staged');
select is(pg_temp.try(format($$select catalog_import.apply_record(%L, %L, %L, null) -> 'filled'$$, pg_temp.id('n2'), pg_temp.u('f5'), pg_temp.rec('no-intro', 'Super Metroid (Japan, USA)'))),
  '["languages"]', 'a known release fills only unlocked empty fields');
select is((select coalesce(product_code, 'empty') from public.releases where id = (select matched_release_id from private.provider_records where id = pg_temp.rec('no-intro', 'Super Metroid (Japan, USA)'))),
  'empty', 'so the locked serial stays as the editor left it');
select is(pg_temp.outcome(pg_temp.apply('n2', 'f5', 'no-intro', 'Metroid 3 (Europe)')), 'matched', 'a verified release is matched');
select is(coalesce((select product_code from public.releases where id = (select matched_release_id from private.provider_records where id = pg_temp.rec('no-intro', 'Metroid 3 (Europe)'))), 'empty'),
  'empty', 'and never changed');
select is((select count(*)::int from private.external_references where provider_code = 'no-intro'), 4, 'and no source id gets a second release');

-- Failures and the report
select lives_ok(format($$select catalog_import.mark_record_failed(%L, %L, %L, 'parse error')$$, pg_temp.id('n2'), pg_temp.u('f5'), pg_temp.rec('no-intro', 'Bad (USA)')),
  'an entry that can''t be applied is marked failed');
select is((select status || '/' || (match_notes ->> 'error') from private.provider_records where id = pg_temp.rec('no-intro', 'Bad (USA)')), 'failed/parse error', 'with the error');
select is((select (r ->> 'source_records') || '/' || (r ->> 'releases_created') || '/' || (r ->> 'possible_duplicates') || '/' || (r -> 'releases_missing' ->> 'edition') || '/' || (r -> 'releases_missing' ->> 'region')
  || '/' || (r ->> 'shared_serials') || '/' || (r ->> 'published_or_verified') from (select catalog_import.run_report(pg_temp.id('n1')) r) s),
  '7/4/1/3/1/1/1', 'the run report counts records, candidates, ambiguity and missing metadata');
select is((select count(*)::int from private.audit_events where action = 'catalog_import_run' and metadata ->> 'event' = 'finished'), 3, 'each finished run is audited');

select * from finish();
rollback;
