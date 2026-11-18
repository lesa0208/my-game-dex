-- M11b-1a: NES/Famicom and SNES/Super Famicom cartridge formats.
-- Reference data, the platform-to-format key, legacy rom-cartridge records, and the
-- importer: nes and snes release entries are held for an editor, because each platform
-- now has several formats, and a PlayStation entry is still created on cd-rom.
-- Synthetic provider, titles and serials only. Calls the import functions as their owner.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.try(p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  execute p_sql into r;
  return coalesce(r, '');
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.platform(p text) returns uuid language sql stable as $$ select id from public.platforms where slug = p $$;
create function pg_temp.formats(p text) returns text language sql stable as $$
  select string_agg(m.media_format_code, ',' order by m.media_format_code) from public.platform_media_formats m where m.platform_id = pg_temp.platform(p) $$;
create function pg_temp.run(p text) returns uuid language sql stable as $$
  select id from private.import_runs where provider_code = 'fixture-shell' and platform_id = pg_temp.platform(p) and status = 'running' limit 1 $$;
create function pg_temp.rec(p_external_id text) returns private.provider_records language sql stable as $$
  select * from private.provider_records where provider_code = 'fixture-shell' and external_id = p_external_id order by id desc limit 1 $$;
create function pg_temp.stage(p text, entries jsonb) returns jsonb language sql as $$
  select catalog_import.stage_records(pg_temp.run(p), pg_temp.u('d1'), entries, null) $$;
create function pg_temp.apply(p text, p_external_id text) returns jsonb language sql as $$
  select catalog_import.apply_record(pg_temp.run(p), pg_temp.u('d1'), (pg_temp.rec(p_external_id)).id, null) $$;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
select is((select string_agg(format('%s/%s/%s/%s', code, category, name, position), ',' order by position) from public.media_formats
  where code in ('famicom-cartridge', 'nes-game-pak', 'snes-cartridge-jp-pal', 'snes-game-pak-na')),
  'famicom-cartridge/cartridge/Famicom Cartridge/80,nes-game-pak/cartridge/NES Game Pak/81,snes-cartridge-jp-pal/cartridge/Super Famicom / PAL SNES Cartridge/82,snes-game-pak-na/cartridge/North American SNES Game Pak/83',
  'the four approved cartridge formats exist, with their approved codes and names, as cartridges');
select is((select count(*)::int from public.media_formats where code in ('famicom-cartridge', 'nes-game-pak', 'snes-cartridge-jp-pal', 'snes-game-pak-na') and description is not null),
  4, 'each says what physically distinguishes it');
select is(pg_temp.formats('nes'), 'famicom-cartridge,nes-game-pak,rom-cartridge', 'nes has the Famicom and NES shells, and keeps rom-cartridge for unclassified records');
select is(pg_temp.formats('snes'), 'rom-cartridge,snes-cartridge-jp-pal,snes-game-pak-na', 'snes has both SNES shells, and keeps rom-cartridge');
select is(pg_temp.formats('famicom-disk-system'), 'famicom-disk-card', 'the Disk System is unchanged');
select is(pg_temp.formats('playstation'), 'cd-rom', 'PlayStation is unchanged');
select is((select string_agg(m.media_format_code || '>' || p.slug, ',' order by m.media_format_code) from public.platform_media_formats m join public.platforms p on p.id = m.platform_id
  where m.media_format_code in ('famicom-cartridge', 'nes-game-pak', 'snes-cartridge-jp-pal', 'snes-game-pak-na')),
  'famicom-cartridge>nes,nes-game-pak>nes,snes-cartridge-jp-pal>snes,snes-game-pak-na>snes', 'each new format belongs to exactly one platform');
select is((select count(*)::int from public.platforms), 59, 'no platform was added: Famicom and Super Famicom stay names of nes and snes');
select is((select string_agg(name || ':' || region_code, ',' order by name) from public.platform_names where platform_id = pg_temp.platform('nes') and region_code = 'ntsc-j'),
  'Famicom:ntsc-j,Family Computer:ntsc-j', 'Famicom is still a Japanese name of nes');
select is((select string_agg(name, ',') from public.platform_names where platform_id = pg_temp.platform('snes') and region_code = 'ntsc-j'), 'Super Famicom', 'and Super Famicom of snes');
select throws_ok($$insert into public.media_formats (code, category, name, position) values ('famicom-cartridge', 'cartridge', 'Duplicate', 99)$$,
  '23505', null, 'a code can''t be reused');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r, unnest(array['insert', 'update', 'delete']) p,
    unnest(array['public.media_formats', 'public.platform_media_formats']) t where has_table_privilege(r, t, p)),
  0, 'no client role or the importer can change formats or their platforms');

-- ---------------------------------------------------------------------------
-- Correct and incorrect format assignments
-- ---------------------------------------------------------------------------
insert into public.games (id, title, sort_title, kind, status) values
  (pg_temp.u('a1'), 'Zqs Shell Plumber', 'Zqs Shell Plumber', 'game', 'under_review'),
  (pg_temp.u('a2'), 'Zqs Shell Quest', 'Zqs Shell Quest', 'game', 'under_review'),
  (pg_temp.u('a3'), 'Zqs Shell Disc', 'Zqs Shell Disc', 'game', 'under_review');
insert into public.game_platforms (game_id, platform_id, status) values
  (pg_temp.u('a1'), pg_temp.platform('nes'), 'under_review'),
  (pg_temp.u('a2'), pg_temp.platform('snes'), 'under_review'),
  (pg_temp.u('a3'), pg_temp.platform('playstation'), 'under_review'),
  (pg_temp.u('a1'), pg_temp.platform('famicom-disk-system'), 'under_review');

create function pg_temp.add(p_id text, p_game text, p_platform text, p_format text, p_region text default 'unknown') returns text language sql as $$
  select pg_temp.try(format($q$insert into public.releases (id, game_id, platform_id, region_code, media_format_code, status) values (%L, %L, %L, %L, %L, 'under_review') returning id::text$q$,
    pg_temp.u(p_id), pg_temp.u(p_game), pg_temp.platform(p_platform), p_region, p_format)) $$;

select is(pg_temp.add('b1', 'a1', 'nes', 'famicom-cartridge', 'ntsc-j'), pg_temp.u('b1')::text, 'an nes release can be a Famicom cartridge');
select is(pg_temp.add('b2', 'a1', 'nes', 'nes-game-pak', 'ntsc-uc'), pg_temp.u('b2')::text, 'or an NES Game Pak');
select is(pg_temp.add('b3', 'a2', 'snes', 'snes-cartridge-jp-pal', 'pal'), pg_temp.u('b3')::text, 'an snes release can have the Super Famicom / PAL shell');
select is(pg_temp.add('b4', 'a2', 'snes', 'snes-game-pak-na', 'ntsc-uc'), pg_temp.u('b4')::text, 'or the North American shell');
select is(pg_temp.add('b5', 'a1', 'nes', 'nes-game-pak', 'ntsc-j'), pg_temp.u('b5')::text,
  'the shell is never derived from the region: an editor may record a Japanese-classified NES Game Pak');
select matches(pg_temp.add('c1', 'a1', 'nes', 'snes-game-pak-na'), 'releases_platform_id_media_format_code_fkey', 'an nes release can''t use an SNES shell');
select matches(pg_temp.add('c2', 'a2', 'snes', 'famicom-cartridge'), 'releases_platform_id_media_format_code_fkey', 'an snes release can''t use a Famicom cartridge');
select matches(pg_temp.add('c3', 'a1', 'famicom-disk-system', 'famicom-cartridge'), 'releases_platform_id_media_format_code_fkey', 'a Disk System release can''t be a cartridge');
select matches(pg_temp.add('c4', 'a3', 'playstation', 'nes-game-pak'), 'releases_platform_id_media_format_code_fkey', 'a PlayStation release can''t be a cartridge');
select matches(pg_temp.try(format($$update public.releases set media_format_code = 'snes-cartridge-jp-pal' where id = %L returning id::text$$, pg_temp.u('b2'))),
  'releases_platform_id_media_format_code_fkey', 'and a format can''t be changed to another platform''s');
select is(pg_temp.try(format($$update public.releases set media_format_code = 'famicom-cartridge' where id = %L returning media_format_code$$, pg_temp.u('b5'))),
  'famicom-cartridge', 'but can be corrected to another shell of the same platform');
select matches(pg_temp.try(format($$insert into public.release_components (release_id, kind, label, media_format_code, platform_id) values (%L, 'game_media', 'Bonus cartridge', 'famicom-cartridge', %L) returning id::text$$,
  pg_temp.u('b4'), pg_temp.platform('snes'))), 'release_components_platform_id_media_format_code_fkey', 'an additional game piece must use a format of its stated platform');
select unalike(pg_temp.try(format($$insert into public.release_components (release_id, kind, label, media_format_code, platform_id) values (%L, 'game_media', 'Bonus cartridge', 'famicom-cartridge', %L) returning id::text$$,
  pg_temp.u('b4'), pg_temp.platform('nes'))), 'error%', 'such as a Famicom cartridge for nes');

-- ---------------------------------------------------------------------------
-- Legacy rom-cartridge records
-- ---------------------------------------------------------------------------
select is(pg_temp.add('d2', 'a1', 'nes', 'rom-cartridge'), pg_temp.u('d2')::text, 'an unclassified nes record can still use rom-cartridge');
select is(pg_temp.add('d3', 'a2', 'snes', 'rom-cartridge'), pg_temp.u('d3')::text, 'and an snes one');
select is(pg_temp.try(format($$update public.releases set media_format_code = 'snes-game-pak-na' where id = %L returning media_format_code$$, pg_temp.u('d3'))),
  'snes-game-pak-na', 'a legacy record can be classified to a shell by a later correction');
select ok('media_format_code' = any (private.release_identity_fields()), 'the format stays an identity field, so a correction ends a verification');
select throws_ok($$delete from public.platform_media_formats where media_format_code = 'rom-cartridge' and platform_id = (select id from public.platforms where slug = 'nes')$$,
  '23503', null, 'rom-cartridge can''t be unlinked from nes while a record uses it');

-- ---------------------------------------------------------------------------
-- Importer: nes and snes release entries are held, PlayStation is unchanged
-- ---------------------------------------------------------------------------
insert into private.external_providers (code, name) values ('fixture-shell', 'Cartridge shell fixture');
select private.record_provider_clearance('fixture-shell', true, null, repeat('5', 64), 'Synthetic test fixture');
select ok(catalog_import.start_run('fixture-shell', 'nes', 'nes.dat', repeat('a', 64), now(), repeat('5', 64), 'Shell tests (nes)', pg_temp.u('d1')) is not null, 'an nes run starts');
select ok(catalog_import.start_run('fixture-shell', 'snes', 'snes.dat', repeat('b', 64), now(), repeat('5', 64), 'Shell tests (snes)', pg_temp.u('d1')) is not null, 'an snes run starts');
select ok(catalog_import.start_run('fixture-shell', 'playstation', 'psx.dat', repeat('c', 64), now(), repeat('5', 64), 'Shell tests (playstation)', pg_temp.u('d1')) is not null, 'a PlayStation run starts');

select is(pg_temp.stage('nes', '[
  {"entity_type": "release", "external_id": "Zqs Shell Plumber (Japan)", "payload": {"name": "Zqs Shell Plumber (Japan)", "title": "Zqs Shell Plumber", "region_tag": "Japan", "region_codes": ["ntsc-j"], "serial": "HVC-ZQ"}},
  {"entity_type": "release", "external_id": "Zqs Shell Plumber (USA)", "payload": {"name": "Zqs Shell Plumber (USA)", "title": "Zqs Shell Plumber", "region_tag": "USA", "region_codes": ["ntsc-uc"], "serial": "NES-ZQ-USA"}},
  {"entity_type": "release", "external_id": "Zqs Shell Plumber (Famicom Cartridge)", "payload": {"name": "Zqs Shell Plumber (Famicom Cartridge)", "title": "Zqs Shell Plumber", "region_codes": ["unknown"], "media_format": "famicom-cartridge"}}]') ->> 'new',
  '3', 'nes release entries are staged');
select is(pg_temp.stage('snes', '[
  {"entity_type": "release", "external_id": "Zqs Shell Quest (Japan)", "payload": {"name": "Zqs Shell Quest (Japan)", "title": "Zqs Shell Quest", "region_codes": ["ntsc-j"], "serial": "SHVC-ZQ"}},
  {"entity_type": "release", "external_id": "Zqs Shell Quest (USA)", "payload": {"name": "Zqs Shell Quest (USA)", "title": "Zqs Shell Quest", "region_codes": ["ntsc-uc"], "serial": "SNS-ZQ-USA"}},
  {"entity_type": "release", "external_id": "Zqs Shell Quest (Europe)", "payload": {"name": "Zqs Shell Quest (Europe)", "title": "Zqs Shell Quest", "region_codes": ["pal"], "serial": "SNSP-ZQ-EUR"}}]') ->> 'new',
  '3', 'snes release entries are staged');
select is(pg_temp.stage('playstation', '[
  {"entity_type": "release", "external_id": "Zqs Shell Disc (USA)", "payload": {"name": "Zqs Shell Disc (USA)", "title": "Zqs Shell Disc", "region_codes": ["ntsc-uc"], "serial": "SLUS-99999", "languages": ["en"]}}]') ->> 'new',
  '1', 'a PlayStation release entry is staged');

create temp table before_apply as select id, payload_sha256, payload from private.provider_records where provider_code = 'fixture-shell';

select is((select string_agg(pg_temp.apply('nes', x) ->> 'outcome', ',' order by x) from unnest(array['Zqs Shell Plumber (Famicom Cartridge)', 'Zqs Shell Plumber (Japan)', 'Zqs Shell Plumber (USA)']) x),
  'needs_review,needs_review,needs_review', 'every nes entry is held for an editor: the region tag, serial pattern and title choose no shell');
select is((select string_agg(pg_temp.apply('snes', x) ->> 'outcome', ',' order by x) from unnest(array['Zqs Shell Quest (Europe)', 'Zqs Shell Quest (Japan)', 'Zqs Shell Quest (USA)']) x),
  'needs_review,needs_review,needs_review', 'every snes entry is held, including Japanese, North American and PAL ones');
select is((select string_agg(format('%s/%s/%s/%s', status, match_tier, match_notes ->> 'reason', (matched_game_id = pg_temp.u('a1') or matched_game_id = pg_temp.u('a2'))), ',')
  from private.provider_records where provider_code = 'fixture-shell' and import_run_id in (pg_temp.run('nes'), pg_temp.run('snes'))),
  'needs_review/A/format unknown/t,needs_review/A/format unknown/t,needs_review/A/format unknown/t,needs_review/A/format unknown/t,needs_review/A/format unknown/t,needs_review/A/format unknown/t',
  'each is held as "format unknown", with its matched game for the editor');
select is((select count(*)::int from private.provider_records where provider_code = 'fixture-shell' and matched_release_id is not null and import_run_id in (pg_temp.run('nes'), pg_temp.run('snes'))),
  0, 'none is matched to a release');
select is((select count(*)::int from public.releases where game_id in (pg_temp.u('a1'), pg_temp.u('a2')) and id not in (pg_temp.u('b1'), pg_temp.u('b2'), pg_temp.u('b3'), pg_temp.u('b4'), pg_temp.u('b5'), pg_temp.u('d2'), pg_temp.u('d3'))),
  0, 'no nes or snes release candidate is created');
select is((select count(*)::int from private.external_references where provider_code = 'fixture-shell' and entity_type = 'release'), 0, 'no source id is linked to a release for a held entry');
select is((select count(*)::int from private.release_evidence e join private.provider_records r on r.id = e.provider_record_id
  where r.provider_code = 'fixture-shell' and r.import_run_id in (pg_temp.run('nes'), pg_temp.run('snes'))), 0, 'and no evidence is written for a held entry');

select is((pg_temp.apply('playstation', 'Zqs Shell Disc (USA)')) ->> 'outcome', 'created', 'a PlayStation entry is still created automatically: cd-rom is its only format');
select is((select format('%s/%s/%s/%s/%s/%s/%s/%s', r.status, r.region_code, r.media_format_code, r.product_code, coalesce(r.edition_name, '-'), coalesce(r.edition_kind::text, '-'),
    coalesce(r.media_count::text, '-'), coalesce(r.packaging, '-'))
  from public.releases r join private.external_references x on x.release_id = r.id where x.provider_code = 'fixture-shell' and x.external_id = 'Zqs Shell Disc (USA)'),
  'under_review/ntsc-uc/cd-rom/SLUS-99999/-/-/-/-', 'with only what the source states: no edition, kind, disc count or packaging');
select is((select string_agg(e.field_name, ',' order by e.field_name) from private.release_evidence e
  join private.external_references x on x.release_id = e.release_id where x.provider_code = 'fixture-shell' and x.external_id = 'Zqs Shell Disc (USA)'),
  'languages,platform,product_code,region_code', 'and its evidence, as before');
select is((select count(*)::int from private.catalog_record_origins o join private.external_references x on x.release_id = o.release_id
  where x.provider_code = 'fixture-shell' and o.origin in ('import', 'system') and o.creator_id is null), 1,
  'no person is its creator (system here, because this file runs the import functions as their owner; import under the importer login, in db-import-checks)');

select is((select count(*)::int from private.provider_records p join before_apply b on b.id = p.id where p.payload_sha256 = b.payload_sha256 and p.payload = b.payload),
  7, 'applying changed no source record''s content: provenance is unchanged');
select throws_ok(format($$update private.provider_records set payload = '{"title": "x"}' where id = %L$$, (pg_temp.rec('Zqs Shell Plumber (Japan)')).id),
  '23514', null, 'and a held record still can''t be rewritten');
select is((select count(*)::int from private.audit_events where action = 'catalog_record_created' and metadata ->> 'import_run_id' in (pg_temp.run('nes')::text, pg_temp.run('snes')::text)),
  0, 'no catalog record is audited as created for a held entry');

-- ---------------------------------------------------------------------------
-- The importer gained nothing
-- ---------------------------------------------------------------------------
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'catalog_import') and has_function_privilege('catalog_importer', p.oid, 'execute')),
  array['apply_record', 'claim_run', 'finish_run', 'mark_record_failed', 'pending_records', 'run_report', 'stage_records', 'start_run'],
  'the importer can still call only the import functions');
select is((select count(*)::int from unnest(array['public.verify_release(uuid,text,bigint)', 'public.publish_release(uuid,text,bigint)', 'public.verify_game(uuid,text,bigint)',
    'public.update_release(uuid,jsonb,text)', 'public.create_release(uuid,uuid,text,text,jsonb,text)']) f where has_function_privilege('catalog_importer', f, 'execute')),
  0, 'and can''t create, edit, verify or publish a release through the editor functions');
select is((select count(*)::int from public.releases r join private.external_references x on x.release_id = r.id
  where x.provider_code = 'fixture-shell' and (r.status = 'published' or r.verified_at is not null)), 0, 'nothing it created is verified or published');

select * from finish();
rollback;
