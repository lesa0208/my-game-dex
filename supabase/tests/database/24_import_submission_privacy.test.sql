-- M7b-1 follow-up: imports and private submissions. A source entry whose title matches a
-- collector's pending submission never matches it, changes it or takes it over;
-- published records and import-owned candidates are matched as before.
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated, anon;
create temp table ids (name text primary key, id uuid not null);
grant all on ids to authenticated, anon;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
grant execute on function pg_temp.id(text) to authenticated, anon;

create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
-- A new game submitted by a collector, naming its game and release.
create function pg_temp.subgame(p_name text, p_actor text, p_title text) returns void language plpgsql as $$
declare r jsonb := pg_temp.as_user(p_actor, format('select public.submit_game(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L)::text',
  p_title, 'game', null, 'snes', 'rom-cartridge', 'pal', '{}', '[]', null, true))::jsonb;
begin
  insert into ids values (p_name || '-g', (r ->> 'game_id')::uuid), (p_name || '-r', (r ->> 'release_id')::uuid);
end $$;

create function pg_temp.rec(p_external_id text) returns uuid language sql stable as $$
  select id from private.provider_records where provider_code = 'fixture-private' and external_id = p_external_id order by id desc limit 1 $$;
create function pg_temp.run() returns uuid language sql stable as $$ select id from private.import_runs where provider_code = 'fixture-private' and status = 'running' limit 1 $$;
create function pg_temp.apply(p_external_id text) returns jsonb language sql as $$
  select catalog_import.apply_record(pg_temp.run(), pg_temp.u('e9'), pg_temp.rec(p_external_id), null) $$;
create function pg_temp.stage(p jsonb) returns jsonb language sql as $$ select catalog_import.stage_records(pg_temp.run(), pg_temp.u('e9'), p, null) $$;
-- Everything about a game an import could change: its row, its releases, pairings,
-- title keys and source links.
create function pg_temp.footprint(p_game uuid) returns text language sql stable as $$
  select concat_ws('/', g.revision, g.status, g.first_release_precision,
    (select count(*) from public.releases r where r.game_id = g.id),
    (select count(*) from public.game_platforms gp where gp.game_id = g.id),
    (select count(*) from private.game_title_keys k where k.game_id = g.id),
    (select count(*) from private.external_references x where x.game_id = g.id),
    (select count(*) from private.provider_records pr where pr.matched_game_id = g.id))
  from public.games g where g.id = p_game $$;

-- a1, a2: collectors (a2's account is deleted later). e5: catalog editor.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'a2', 'e5']) as s;
update public.profiles set handle = 'imp_' || right(id::text, 2), handle_changed_at = now() where id in (pg_temp.u('a1'), pg_temp.u('a2'), pg_temp.u('e5'));
insert into public.staff_roles (user_id, role) values (pg_temp.u('e5'), 'catalog_editor');

-- Published and editor-made games, which imports keep matching.
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('e5'), 'role', 'authenticated')::text, true);
select set_config('role', 'authenticated', true);
insert into ids select 'pub', public.create_game('Zqp Harbor Run', 'game', null, null, null, 'unknown', 'Import privacy tests');
select public.verify_game(pg_temp.id('pub'), 'Import privacy tests', (select revision from public.games where id = pg_temp.id('pub')));
insert into ids select 'pub-r', public.create_release(pg_temp.id('pub'), (select id from public.platforms where slug = 'snes'), 'rom-cartridge', 'ntsc-uc',
  '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "product_code": "ZQP-PUB"}', 'Import privacy tests');
select public.verify_release(pg_temp.id('pub-r'), 'Import privacy tests', (select revision from public.releases where id = pg_temp.id('pub-r')));
select public.publish_release(pg_temp.id('pub-r'), 'Import privacy tests', (select revision from public.releases where id = pg_temp.id('pub-r')));
insert into ids select 'draft', public.create_game('Zqp Editor Draft', 'game', null, null, null, 'unknown', 'Import privacy tests');
select public.set_game_platform(pg_temp.id('draft'), (select id from public.platforms where slug = 'snes'), 'Import privacy tests');
select set_config('role', 'none', true);

-- Private submissions with titles an import will collide with.
select pg_temp.subgame('lantern', 'a1', 'Zqp Lantern Sails');
select pg_temp.subgame('copper', 'a1', 'Zqp Copper Harbor');
select pg_temp.subgame('moon', 'a1', 'Zqp Moon Saga');
select pg_temp.subgame('orphan', 'a2', 'Zqp Orphan Isle');
insert into ids select 'serial-r', (pg_temp.as_user('a1', format('select public.submit_release(%L, %L, %L, %L, %L, %L, %L, %L)::text',
  pg_temp.id('pub'), 'snes', 'rom-cartridge', 'pal', '{"product_code": "ZQP-SER"}', '[]', null, true))::jsonb ->> 'release_id')::uuid;
delete from auth.users where id = pg_temp.u('a2');
create temp table before as select name, pg_temp.footprint(id) as f from ids where name like '%-g';

select is((select submitted_by is null from public.games where id = pg_temp.id('orphan-g')), true, 'one submitter''s account is deleted, leaving an unowned submission');
select ok(not has_function_privilege('catalog_importer', 'private.import_private_game(public.games)', 'execute')
          and not has_function_privilege('authenticated', 'private.import_private_release(public.releases)', 'execute'), 'the new checks are private');

insert into private.external_providers (code, name) values ('fixture-private', 'Private submissions fixture');
select private.record_provider_clearance('fixture-private', true, null, repeat('6', 64), 'Import privacy test fixture');
select ok(catalog_import.start_run('fixture-private', 'snes', 'private.json', repeat('5', 64), now(), repeat('6', 64), 'Import privacy tests', pg_temp.u('e9')) is not null, 'an import starts');

-- ---------------------------------------------------------------------------
-- Games with a pending submission's title
-- ---------------------------------------------------------------------------
select is(pg_temp.stage('[
  {"entity_type": "game", "external_id": "ZP1", "payload": {"title": "Zqp Lantern Sails", "titles": ["Zqp Lantern Sails"]}},
  {"entity_type": "game", "external_id": "ZP2", "payload": {"title": "Zqp CopperHarbor", "titles": ["Zqp CopperHarbor"]}},
  {"entity_type": "game", "external_id": "ZP3", "payload": {"title": "Zqp Editor Draft", "titles": ["Zqp Editor Draft"]}}]') ->> 'new', '3', 'game entries are staged');
select is(pg_temp.apply('ZP1') ->> 'outcome', 'created', 'a game with a pending submission''s exact title gets its own candidate');
select isnt((select x.game_id from private.external_references x where x.provider_code = 'fixture-private' and x.external_id = 'ZP1'), pg_temp.id('lantern-g'),
            'not the submission');
select is((select status::text from public.games g join private.external_references x on x.game_id = g.id where x.provider_code = 'fixture-private' and x.external_id = 'ZP1'),
          'under_review', 'which waits for review like any candidate');
select is(pg_temp.apply('ZP2') ->> 'outcome', 'created', 'equal ignoring word breaks: also its own candidate');
select ok(not exists (select 1 from private.provider_records pr where pr.provider_code = 'fixture-private'
            and (pr.match_notes ->> 'candidates') like '%' || pg_temp.id('copper-g')::text || '%'), 'the submission is never named as a candidate');
select is(pg_temp.apply('ZP3') ->> 'outcome', 'ambiguous', 'an editor''s unpublished game is still found as a possible duplicate');

-- ---------------------------------------------------------------------------
-- Releases with a pending submission's title or serial
-- ---------------------------------------------------------------------------
select is(pg_temp.stage('[
  {"entity_type": "release", "external_id": "Zqp Lantern Sails (Japan)", "payload": {"title": "Zqp Lantern Sails", "region_codes": ["ntsc-j"]}},
  {"entity_type": "release", "external_id": "Zqp Orphan Isle (USA)", "payload": {"title": "Zqp Orphan Isle", "region_codes": ["ntsc-uc"]}},
  {"entity_type": "release", "external_id": "Zqp Moon Saga - The Return (Japan)", "payload": {"title": "Zqp Moon Saga - The Return", "region_codes": ["ntsc-j"]}},
  {"entity_type": "release", "external_id": "Zqp Harbor Run (Europe)", "payload": {"title": "Zqp Harbor Run", "region_codes": ["pal"], "serial": "ZQP-SER"}}]') ->> 'new', '4', 'release entries are staged');
select is(pg_temp.apply('Zqp Lantern Sails (Japan)') ->> 'game_id', (select x.game_id::text from private.external_references x where x.provider_code = 'fixture-private' and x.external_id = 'ZP1'),
          'a release titled like a submission goes on the import''s own game');
select is(pg_temp.apply('Zqp Orphan Isle (USA)') ->> 'outcome', 'unmatched', 'with only an unowned submission of that title, it matches nothing');
select is(pg_temp.apply('Zqp Moon Saga - The Return (Japan)') ->> 'outcome', 'unmatched', 'a submission is never suggested by its main title either');
select is(pg_temp.apply('Zqp Harbor Run (Europe)') ->> 'outcome', 'created', 'a release of a published game is created as before');
select is((select r.game_id from public.releases r join private.external_references x on x.release_id = r.id where x.provider_code = 'fixture-private' and x.external_id = 'Zqp Harbor Run (Europe)'),
          pg_temp.id('pub'), 'on the published game');
select ok(not ((select match_notes from private.provider_records where id = pg_temp.rec('Zqp Harbor Run (Europe)')) ? 'serial_also_on'),
          'and a pending submission with the same serial isn''t noted against it');

-- ---------------------------------------------------------------------------
-- The submissions are untouched
-- ---------------------------------------------------------------------------
select is((select string_agg(b.name || '=' || (b.f = pg_temp.footprint(pg_temp.id(b.name)))::text, ',' order by b.name) from before b),
          'copper-g=true,lantern-g=true,moon-g=true,orphan-g=true', 'no submitted game changed: no release, pairing, title key, source link or field added');
select is((select count(*)::int from private.release_evidence e where e.release_id in (pg_temp.id('lantern-r'), pg_temp.id('serial-r'), pg_temp.id('orphan-r'))), 0,
          'no source evidence is attached to a submitted release');
select is((select string_agg(status::text, ',' order by id) from public.catalog_change_requests where game_id in (pg_temp.id('lantern-g'), pg_temp.id('copper-g'), pg_temp.id('moon-g'), pg_temp.id('orphan-g'))),
          'open,open,open,open', 'and their review requests are still open');

-- ---------------------------------------------------------------------------
-- Once published, a submission is matched like any record
-- ---------------------------------------------------------------------------
-- The review table has no client grant, so its id and versions are read here, as a page would get them.
insert into ids select 'moon', id from public.catalog_change_requests where game_id = pg_temp.id('moon-g');
create function pg_temp.ver() returns integer language sql as $$ select version from public.catalog_change_requests where id = pg_temp.id('moon') $$;
select pg_temp.as_user('e5', format('select public.start_submission_review(%L, %L, %L)::text', pg_temp.id('moon'), pg_temp.ver(), 'Import privacy tests'));
select pg_temp.as_user('e5', format('select public.update_release(%L, %L, %L)::text', pg_temp.id('moon-r'),
  '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}', 'Import privacy tests'));
select pg_temp.as_user('e5', format('select public.approve_submission(%L, %L, %L, %L, %L, null)::text', pg_temp.id('moon'), pg_temp.ver(),
  (select revision from public.releases where id = pg_temp.id('moon-r')), (select revision from public.games where id = pg_temp.id('moon-g')), 'Import privacy tests'));
select is((select status::text from public.games where id = pg_temp.id('moon-g')), 'published', 'a submitted game is approved and published');
select is(pg_temp.stage('[{"entity_type": "release", "external_id": "Zqp Moon Saga (USA)", "payload": {"title": "Zqp Moon Saga", "region_codes": ["ntsc-uc"]}}]') ->> 'new', '1',
          'a release entry with its title is staged');
select is(pg_temp.apply('Zqp Moon Saga (USA)') ->> 'game_id', pg_temp.id('moon-g')::text, 'and now matches it, as a public game');

select * from finish();
rollback;
