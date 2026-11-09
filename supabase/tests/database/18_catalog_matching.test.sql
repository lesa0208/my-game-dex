-- M5b: title matching, held entries and suggestions, after the SNES pilot.
-- Uses its own provider and titles, so it runs beside existing catalog data.
begin;
create extension if not exists pgtap with schema extensions;
select plan(39);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.try(p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  execute p_sql into r;
  return coalesce(r, '');
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.rec(p_external_id text) returns uuid language sql stable as $$
  select id from private.provider_records where provider_code = 'fixture-match' and external_id = p_external_id order by id desc limit 1 $$;
create function pg_temp.apply(p_external_id text) returns jsonb language sql as $$
  select catalog_import.apply_record((select id from private.import_runs where provider_code = 'fixture-match' and status = 'running' limit 1), pg_temp.u('e9'), pg_temp.rec(p_external_id), null) $$;
create function pg_temp.run() returns uuid language sql stable as $$ select id from private.import_runs where provider_code = 'fixture-match' and status = 'running' limit 1 $$;
create function pg_temp.stage(p jsonb) returns jsonb language sql as $$ select catalog_import.stage_records(pg_temp.run(), pg_temp.u('e9'), p, null) $$;

-- ---------------------------------------------------------------------------
-- The title index
-- ---------------------------------------------------------------------------
select is((select relrowsecurity from pg_class where oid = 'private.game_title_keys'::regclass), true, 'title keys are private, with RLS');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r, unnest(array['select', 'insert', 'update', 'delete']) p
  where has_table_privilege(r, 'private.game_title_keys', p)), 0, 'no client role or the importer can use them directly');
select ok(exists (select 1 from pg_indexes where schemaname = 'private' and tablename = 'game_title_keys' and indexdef like '%(title_key)%'), 'they are indexed by key');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r,
    unnest(array['private.import_main_title_key(text)', 'private.sync_game_title_key()', 'private.import_add_title_keys(uuid,private.provider_records)', 'private.import_games_by_key(uuid,text)']) f
  where has_function_privilege(r, f, 'execute')), 0, 'and their helpers are private');

-- ---------------------------------------------------------------------------
-- Comparable titles
-- ---------------------------------------------------------------------------
select is(private.import_title_key('Clay Fighter 2: Judgment Clay'), private.import_title_key('Clay Fighter 2 - Judgment Clay'), 'separators don''t matter');
select is(private.import_title_key('Mask, The'), private.import_title_key('The Mask'), 'a trailing or leading article doesn''t matter');
select is(private.import_title_key('Breath of Fire II'), private.import_title_key('Breath of Fire 2'), 'roman numerals II to IX are numbers');
select is(private.import_title_key('Jurassic Park Part 2'), private.import_title_key('Jurassic Park 2'), 'so is "Part N"');
select is(private.import_title_key('David Crane’s Amazing Tennis') || '/' || private.import_title_key('Tom & Jerry'), 'david-cranes-amazing-tennis/tom-and-jerry', 'apostrophes and ampersands are normalized');
select isnt(private.import_title_key('Mega Man X'), private.import_title_key('Mega Man 10'), 'X stays a letter');
select isnt(private.import_title_key('A.S.P. Air Strike Patrol'), private.import_title_key('S.P. Air Strike Patrol'), 'a leading "A" initial isn''t an article');
select is(private.import_title_key('スーパーメトロイド'), null, 'a Japanese-script title has no comparable key');
select is(private.import_main_title_key('Breath of Fire II - Shimei no Ko') || '/' || coalesce(private.import_main_title_key('Super Metroid'), 'none'), 'breath-of-fire-2/none', 'the main title is the part before a subtitle');

-- ---------------------------------------------------------------------------
-- Keys follow games
-- ---------------------------------------------------------------------------
insert into public.games (id, title, sort_title, kind, status) values (pg_temp.u('f1'), 'Zqx Editor Title', 'Zqx Editor Title', 'game', 'under_review');
select is((select string_agg(title_key || ':' || origin, ',') from private.game_title_keys where game_id = pg_temp.u('f1')), 'zqx-editor-title:title', 'a new game''s title is indexed');
update public.games set title = 'Zqx Editor Title II' where id = pg_temp.u('f1');
select is((select string_agg(title_key || ':' || origin, ',') from private.game_title_keys where game_id = pg_temp.u('f1')), 'zqx-editor-title-2:title', 'and follows a change of title');

-- ---------------------------------------------------------------------------
-- An import with held entries, normalized matches, suggestions and ambiguity
-- ---------------------------------------------------------------------------
insert into private.external_providers (code, name) values ('fixture-match', 'Matching fixture');
select private.record_provider_clearance('fixture-match', true, null, repeat('7', 64), 'Matching test fixture');
select ok(catalog_import.start_run('fixture-match', 'snes', 'match.json', repeat('8', 64), now(), repeat('7', 64), 'Matching tests', pg_temp.u('e9')) is not null, 'a run starts');
select is(pg_temp.stage('[
  {"entity_type": "game", "external_id": "ZQ1", "payload": {"title": "Zqx Clay Fighter 2: Judgment Clay", "titles": ["Zqx Clay Fighter 2: Judgment Clay"]}},
  {"entity_type": "game", "external_id": "ZQ2", "payload": {"title": "Zqx Breath of Fire II", "titles": ["Zqx Breath of Fire II"]}},
  {"entity_type": "game", "external_id": "ZQ3", "payload": {"title": "Zqx Twin II", "titles": ["Zqx Twin II"]}},
  {"entity_type": "game", "external_id": "ZQ4", "payload": {"title": "Zqx Twin 2", "titles": ["Zqx Twin 2"]}},
  {"entity_type": "game", "external_id": "ZQ5", "payload": {"title": "Zqx Daisuki", "titles": ["Zqx Daisuki", "Zqx Baiku Daisuki Hashiriya"]}}]') ->> 'new', '5', 'game entries are staged');
select is((select string_agg(pg_temp.apply(x) ->> 'outcome', ',' order by x) from unnest(array['ZQ1', 'ZQ2', 'ZQ3', 'ZQ4', 'ZQ5']) x), 'created,created,created,created,created',
  'two source entries whose titles only compare equal are still two games');
select is((select count(*)::int from private.game_title_keys k join private.external_references x on x.game_id = k.game_id
  where x.provider_code = 'fixture-match' and x.external_id = 'ZQ5' and k.origin = 'source'), 2, 'every title the source lists is indexed');
select is(pg_temp.stage('[
  {"entity_type": "release", "external_id": "Zqx Clay Fighter 2 - Judgment Clay (USA)", "payload": {"title": "Zqx Clay Fighter 2 - Judgment Clay", "region_codes": ["ntsc-uc"]}},
  {"entity_type": "release", "external_id": "Zqx Baiku Daisuki Hashiriya (Japan)", "payload": {"title": "Zqx Baiku Daisuki Hashiriya", "region_codes": ["ntsc-j"]}},
  {"entity_type": "release", "external_id": "Zqx Breath of Fire II - Shimei no Ko (Japan)", "payload": {"title": "Zqx Breath of Fire II - Shimei no Ko", "region_codes": ["ntsc-j"]}},
  {"entity_type": "release", "external_id": "Zqx Twin II (USA)", "payload": {"title": "Zqx Twin II", "region_codes": ["ntsc-uc"]}},
  {"entity_type": "release", "external_id": "Zqx Daisuki (Japan) (NP)", "payload": {"title": "Zqx Daisuki", "region_codes": ["ntsc-j"]}, "review_reason": "Nintendo Power flash release"}]') ->> 'new', '5',
  'release entries are staged, one held for an editor');
select is(pg_temp.try($$select pg_temp.stage('[{"entity_type": "release", "external_id": "Zqx Bad", "payload": {"title": "x"}, "ignore_reason": "a", "review_reason": "b"}]')::text$$),
  'error: invalid source entry', 'an entry is either ignored or held, not both');
select is((select status || '/' || review_reason from private.provider_records where id = pg_temp.rec('Zqx Daisuki (Japan) (NP)')), 'needs_review/Nintendo Power flash release',
  'a held entry waits for review with its reason');
select is((select count(*)::int from catalog_import.pending_records(pg_temp.run(), pg_temp.u('e9'), -1, 500) p where p.provider_record_id = pg_temp.rec('Zqx Daisuki (Japan) (NP)')), 0,
  'and is never pending');
select is(pg_temp.apply('Zqx Daisuki (Japan) (NP)') ->> 'outcome', 'held', 'applying it directly still creates nothing');
select is(pg_temp.apply('Zqx Clay Fighter 2 - Judgment Clay (USA)') ->> 'outcome', 'created', 'a title that differs only in its separator matches');
select is(pg_temp.apply('Zqx Baiku Daisuki Hashiriya (Japan)') ->> 'outcome', 'created', 'so does an alternate title the game''s source lists, such as a romanization');
select is(pg_temp.apply('Zqx Breath of Fire II - Shimei no Ko (Japan)') ->> 'outcome', 'suggested', 'a match only by main title is suggested');
select is((select match_tier || '/' || status || '/' || (select count(*) from private.external_references x where x.provider_code = 'fixture-match' and x.entity_type = 'release'
    and x.external_id = 'Zqx Breath of Fire II - Shimei no Ko (Japan)')
  from private.provider_records where id = pg_temp.rec('Zqx Breath of Fire II - Shimei no Ko (Japan)')), 'B/needs_review/0', 'and waits for review, with nothing created');
select is(pg_temp.apply('Zqx Twin II (USA)') ->> 'outcome', 'ambiguous', 'two games with equal titles are never merged or picked');
-- Word breaks, and the false positives they must not create
insert into public.games (id, title, sort_title, kind, status) values
  (pg_temp.u('f2'), 'Zqx Pop N Twin', 'Zqx Pop N Twin', 'game', 'under_review'), (pg_temp.u('f3'), 'Zqx PopN Twin', 'Zqx PopN Twin', 'game', 'under_review'),
  (pg_temp.u('f4'), 'Zq Ab', 'Zq Ab', 'game', 'under_review'), (pg_temp.u('f5'), 'Zqx NES Only Game', 'Zqx NES Only Game', 'game', 'under_review'),
  (pg_temp.u('f6'), 'Zqx Mega Lo Mania', 'Zqx Mega Lo Mania', 'game', 'under_review');
insert into public.game_platforms (game_id, platform_id, status)
select g, (select id from public.platforms where slug = 'snes'), 'under_review'::public.catalog_status from unnest(array[pg_temp.u('f2'), pg_temp.u('f3'), pg_temp.u('f4'), pg_temp.u('f6')]) g
union all select pg_temp.u('f5'), (select id from public.platforms where slug = 'nes'), 'under_review';
select is(pg_temp.stage('[
  {"entity_type": "game", "external_id": "ZQ6", "payload": {"title": "Zqx ClayFighter Two", "titles": ["Zqx ClayFighter Two"]}},
  {"entity_type": "game", "external_id": "ZQ7", "payload": {"title": "Zqx Megalomania", "titles": ["Zqx Megalomania"]}},
  {"entity_type": "release", "external_id": "Zqx Clay Fighter Two (USA)", "payload": {"title": "Zqx Clay Fighter Two", "region_codes": ["ntsc-uc"]}},
  {"entity_type": "release", "external_id": "Zqx Po Pn Twin (USA)", "payload": {"title": "Zqx Po Pn Twin", "region_codes": ["ntsc-uc"]}},
  {"entity_type": "release", "external_id": "Zq A B (USA)", "payload": {"title": "Zq A B", "region_codes": ["ntsc-uc"]}},
  {"entity_type": "release", "external_id": "Zqx NESOnly Game (USA)", "payload": {"title": "Zqx NESOnly Game", "region_codes": ["ntsc-uc"]}}]') ->> 'new', '6', 'word-break cases are staged');
select is(pg_temp.apply('ZQ6') ->> 'outcome', 'created', 'a game is created');
select is(pg_temp.apply('ZQ7') ->> 'outcome', 'ambiguous', 'a source game equal to an editor''s game ignoring word breaks waits as a possible duplicate');
select is(pg_temp.apply('Zqx Clay Fighter Two (USA)') ->> 'outcome', 'created', 'a release matching one game on the platform ignoring word breaks is created');
select is((select match_notes ->> 'match' from private.provider_records where id = pg_temp.rec('Zqx Clay Fighter Two (USA)')), 'matched ignoring word breaks', 'and says how it matched');
select is(pg_temp.apply('Zqx Po Pn Twin (USA)') ->> 'outcome', 'ambiguous', 'two games equal ignoring word breaks are never picked');
select is(pg_temp.apply('Zq A B (USA)') ->> 'outcome', 'unmatched', 'a short title is never matched ignoring word breaks');
select is(pg_temp.apply('Zqx NESOnly Game (USA)') ->> 'outcome', 'unmatched', 'nor is a game on another platform');
select throws_ok(format($$update private.provider_records set review_reason = null where id = %L$$, pg_temp.rec('Zqx Daisuki (Japan) (NP)')), '23514', 'source records can''t be changed',
  'a held entry can''t be released by editing its record');
select is((select (r ->> 'suggested') || '/' || (r -> 'held_reasons' ->> 'Nintendo Power flash release') || '/' || (r ->> 'releases_created') from (select catalog_import.run_report(pg_temp.run()) r) s),
  '1/1/3', 'the report counts suggestions and held entries with their reasons');

select * from finish();
rollback;
