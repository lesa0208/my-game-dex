-- M18a: IGDB as an enrichment provider (migration 20261221100000). Its records are staged and
-- attached to existing published identities, never applied as games; the public read shows them
-- only for published games, with the provider cleared, and images only with media cleared.
-- Calls the importer functions as their owner, as 17_catalog_import does. Synthetic data.
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.try(p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  execute p_sql into r;
  return coalesce(r, '');
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
create temp table runs (name text primary key, id uuid not null);
create function pg_temp.run(p text) returns uuid language sql stable as $$ select id from runs where name = p $$;
create function pg_temp.g(p_slug text) returns uuid language sql stable as $$ select id from public.games where slug = p_slug $$;
create function pg_temp.meta(p_slug text) returns jsonb language sql stable as $$
  select to_jsonb(m) from public.get_game_provider_metadata(array[pg_temp.g(p_slug)]) m $$;

-- Two published games, one unpublished, each with a Wikidata record stating IGDB slugs.
insert into public.games (slug, title, sort_title, kind, status, first_release_date, first_release_precision, summary, verified_at) values
  ('zqx-star-voyage', 'Zqx Star Voyage', 'Zqx Star Voyage', 'game', 'published', '1992-04-01', 'day', null, now()),
  ('zqx-moon-patrol', 'Zqx Moon Patrol', 'Zqx Moon Patrol', 'game', 'published', '1993-05-01', 'day', 'The catalog''s own summary.', now()),
  ('zqx-hidden-game', 'Zqx Hidden Game', 'Zqx Hidden Game', 'game', 'under_review', '1994-01-01', 'year', null, null);
insert into public.game_platforms (game_id, platform_id, status)
select g.id, p.id, 'under_review' from public.games g, public.platforms p where g.slug like 'zqx-%' and p.slug = 'snes';
create temp table game_rows_before as select row(g.*)::text as r from public.games g where g.slug like 'zqx-%';

-- 1. The provider exists, uncleared, with its media gate closed.
select is((select commercial_use_cleared::text || '/' || media_cleared::text from private.external_providers where code = 'igdb'), 'false/false',
  'IGDB is a provider, neither cleared nor its media');
select is(pg_temp.try($$select catalog_import.start_enrichment_run('igdb', 'igdb.json', repeat('a', 64), now(), repeat('2', 64), 'M18a test', '00000000-0000-0000-0000-0000000000e1')::text$$),
  'error: provider not cleared', 'an enrichment run needs the provider cleared');
select is(pg_temp.try($$select private.record_provider_media('igdb', true, 'too early')::text$$), 'error: provider not cleared',
  'media can''t be cleared before the provider is');
select private.record_provider_clearance('igdb', true, 'https://api-docs.igdb.com/', repeat('2', 64), 'M18a test basis');

-- 2. Only an enrichment provider starts an enrichment run, and it has no platform.
select is(pg_temp.try($$select catalog_import.start_enrichment_run('wikidata', 'x.json', repeat('b', 64), now(), repeat('2', 64), 'M18a test', '00000000-0000-0000-0000-0000000000e2')::text$$),
  'error: invalid changes', 'Wikidata can''t start an enrichment run');
insert into runs values ('r1', catalog_import.start_enrichment_run('igdb', 'igdb.json', repeat('a', 64), now(), repeat('2', 64), 'M18a test', pg_temp.u('e1')));
select is((select platform_id from private.import_runs where id = pg_temp.run('r1')), null, 'an enrichment run spans games: no platform');

-- 3. The candidates read: published games only, with Wikidata's IGDB slugs.
insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, reason, finished_at)
select 'wikidata', p.id, 'wd.json', repeat('c', 64), now(), 'completed', 'M18a test', now() from public.platforms p where p.slug = 'snes';
insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
select 'wikidata', 'game', 'Q' || g.slug, jsonb_build_object('title', g.title, 'source', jsonb_build_object('external_ids', jsonb_build_object('igdb', jsonb_build_array(substr(g.slug, 5))))),
  encode(sha256(convert_to(g.slug, 'UTF8')), 'hex'), (select id from private.import_runs where source_name = 'wd.json'), 'promoted', g.id
from public.games g where g.slug like 'zqx-%';
insert into private.external_references (provider_code, external_id, game_id) select 'wikidata', 'Q' || g.slug, g.id from public.games g where g.slug like 'zqx-%';
select is((select string_agg(e ->> 'slug', ',' order by e ->> 'slug') from jsonb_array_elements(catalog_import.enrichment_candidates('igdb', array['zqx-star-voyage', 'zqx-moon-patrol', 'zqx-hidden-game', 'zqx-absent'])) e),
  'zqx-moon-patrol,zqx-star-voyage', 'candidates: published games only; an unknown slug is simply absent');
select is((select e -> 'wikidata_igdb' ->> 0 from jsonb_array_elements(catalog_import.enrichment_candidates('igdb', array['zqx-star-voyage'])) e), 'star-voyage',
  'with the IGDB slug Wikidata states');
select is(pg_temp.try($$select catalog_import.enrichment_candidates('wikidata', array['zqx-star-voyage'])::text$$), 'error: invalid changes',
  'only for an enrichment provider');

-- 4. Staging: one plain record, one held for review.
select catalog_import.stage_records(pg_temp.run('r1'), pg_temp.u('e1'), $$[
  {"entity_type": "game", "external_id": "1001", "payload": {"id": "1001", "slug": "star-voyage", "name": "Zqx Star Voyage", "url": "https://www.igdb.com/games/star-voyage",
    "summary": "A synthetic summary from the provider.", "genres": ["Shooter", "Arcade"], "themes": ["Science fiction"], "developers": ["Zqx Studio"], "publishers": ["Zqx Publishing"],
    "first_release_date": "1992-04-03", "platforms": ["Super Nintendo Entertainment System"], "platform_ids": [19, "x"], "cover": {"image_id": "co1zqx", "width": 264, "height": 374},
    "screenshots": [{"image_id": "sc1zqx", "width": 889, "height": 500}, {"image_id": "../etc/passwd"}], "fetched_at": "2026-11-26T00:00:00Z"}},
  {"entity_type": "game", "external_id": "1002", "payload": {"id": "1002", "slug": "moon-patrol", "name": "Zqx Moon Patrol"}, "review_reason": "IGDB match needs review: ambiguous"}
]$$::jsonb, null);
select is((select string_agg(external_id || ':' || status, ',' order by external_id) from private.provider_records where provider_code = 'igdb'), '1001:fetched,1002:needs_review',
  'staged as source claims: one fetched, one held');

-- 5. apply_record never applies an enrichment record (it would match or create a game).
select is(pg_temp.try(format($$select catalog_import.apply_record(%L, %L, (select id from private.provider_records where external_id = '1001' and provider_code = 'igdb'), null)::text$$, pg_temp.run('r1'), pg_temp.u('e1'))),
  'error: enrichment records are attached, never applied', 'apply_record refuses an enrichment run');
select is((select count(*)::int from public.games where title in ('Zqx Star Voyage', 'Zqx Moon Patrol')), 2, 'no game was created');

-- 6. Attaching: to an existing published game only, never a held record, one id per game and game per id.
select is(pg_temp.try(format($$select catalog_import.attach_game_record(%L, %L, '1001', %L, 'A', '{}', null) ->> 'outcome'$$, pg_temp.run('r1'), pg_temp.u('e1'), pg_temp.g('zqx-hidden-game'))),
  'error: game unavailable', 'never to an unpublished game');
select is(pg_temp.try(format($$select catalog_import.attach_game_record(%L, %L, '1002', %L, 'A', '{}', null) ->> 'outcome'$$, pg_temp.run('r1'), pg_temp.u('e1'), pg_temp.g('zqx-moon-patrol'))),
  'error: record unavailable', 'a held record can''t be attached');
select is(pg_temp.try(format($$select catalog_import.attach_game_record(%L, %L, '1001', %L, 'C', '{}', null) ->> 'outcome'$$, pg_temp.run('r1'), pg_temp.u('e1'), pg_temp.g('zqx-star-voyage'))),
  'error: invalid changes', 'only tier A or B');
select is(pg_temp.try(format($$select catalog_import.attach_game_record(%L, %L, '1001', %L, 'A', '{"matcher": "m18a-1"}', null) ->> 'outcome'$$, pg_temp.run('r1'), pg_temp.u('e1'), pg_temp.g('zqx-star-voyage'))),
  'attached', 'attached to its published game');
select is((select string_agg(provider_code || ':' || external_id, ',' order by provider_code) from private.external_references where game_id = pg_temp.g('zqx-star-voyage')),
  'igdb:1001,wikidata:Qzqx-star-voyage', 'the IGDB id is linked beside the Wikidata id, one identity');
select is((select status::text || '/' || match_tier || '/' || (match_notes ->> 'matcher') from private.provider_records where provider_code = 'igdb' and external_id = '1001'),
  'matched/A/m18a-1', 'the record is matched, with its tier and the matcher''s notes');
select is(pg_temp.try(format($$select catalog_import.attach_game_record(%L, %L, '1001', %L, 'A', '{}', null) ->> 'outcome'$$, pg_temp.run('r1'), pg_temp.u('e1'), pg_temp.g('zqx-star-voyage'))),
  'skipped', 'attaching again (resuming) is skipped');
-- Another staged record for the same IGDB id can't go to another game; another id can't go to a linked game.
select catalog_import.stage_records(pg_temp.run('r1'), pg_temp.u('e1'), $$[
  {"entity_type": "game", "external_id": "1001", "payload": {"id": "1001", "slug": "star-voyage", "name": "Zqx Star Voyage", "summary": "changed"}},
  {"entity_type": "game", "external_id": "1003", "payload": {"id": "1003", "slug": "star-voyage-remake", "name": "Zqx Star Voyage"}}
]$$::jsonb, null);
select is(pg_temp.try(format($$select catalog_import.attach_game_record(%L, %L, '1001', %L, 'A', '{}', null) ->> 'outcome'$$, pg_temp.run('r1'), pg_temp.u('e1'), pg_temp.g('zqx-moon-patrol'))),
  'error: identity conflict: the id is linked to another game', 'one game per IGDB id');
select is(pg_temp.try(format($$select catalog_import.attach_game_record(%L, %L, '1003', %L, 'A', '{}', null) ->> 'outcome'$$, pg_temp.run('r1'), pg_temp.u('e1'), pg_temp.g('zqx-star-voyage'))),
  'error: identity conflict: the game is linked to another id', 'one IGDB id per game');
select is((select array_agg(r order by r) from (select row(g.*)::text r from public.games g where g.slug like 'zqx-%') s), (select array_agg(r order by r) from game_rows_before),
  'no game''s own fields (title, summary, dates, status) changed');
select is((select count(*)::int from public.game_aliases a join public.games g on g.id = a.game_id where g.slug like 'zqx-%'), 0, 'no alias was added');
select catalog_import.finish_run(pg_temp.run('r1'), pg_temp.u('e1'), 'completed');

-- 7. The public read: provider metadata, labelled; no images until media are cleared.
select is(pg_temp.meta('zqx-star-voyage') ->> 'summary', 'A synthetic summary from the provider.', 'the provider''s summary, for a published game');
select is((pg_temp.meta('zqx-star-voyage') ->> 'provider') || '/' || (pg_temp.meta('zqx-star-voyage') ->> 'provider_name') || '/' || (pg_temp.meta('zqx-star-voyage') ->> 'url'),
  'igdb/IGDB/https://www.igdb.com/games/star-voyage', 'labelled with its provider and the IGDB page');
select is(pg_temp.meta('zqx-star-voyage') -> 'genres', '["Shooter", "Arcade"]'::jsonb, 'its genres');
select is(pg_temp.meta('zqx-star-voyage') -> 'platform_ids', '[19]'::jsonb, 'the IGDB platform ids it lists, an invalid one dropped');
select is(pg_temp.meta('zqx-star-voyage') ->> 'cover', null, 'no cover while media aren''t cleared');
select private.record_provider_media('igdb', true, 'M18a test: local display');
select is(pg_temp.meta('zqx-star-voyage') -> 'cover' ->> 'image_id', 'co1zqx', 'the cover once media are cleared');
select is(jsonb_array_length(pg_temp.meta('zqx-star-voyage') -> 'screenshots'), 1, 'screenshots, an invalid image id dropped');
select is((select count(*)::int from public.get_game_provider_metadata(array[pg_temp.g('zqx-moon-patrol'), pg_temp.g('zqx-hidden-game')])), 0,
  'nothing for a game with only a held record, or an unpublished game');
select private.record_provider_media('igdb', false, 'M18a test: withdrawn');
select is(pg_temp.meta('zqx-star-voyage') ->> 'cover', null, 'withdrawing media hides the images at once');
select private.record_provider_clearance('igdb', false, 'https://api-docs.igdb.com/', repeat('2', 64), 'M18a test: withdrawn');
select is((select count(*)::int from public.get_game_provider_metadata(array[pg_temp.g('zqx-star-voyage')])), 0, 'withdrawing the provider hides everything');

-- 8. Access.
-- 20261222100000: IGDB's records as stored are the app server's only (no redistribution through our API).
select is((select string_agg(r, ',' order by r) from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r
  where has_function_privilege(r, 'public.get_game_provider_metadata(uuid[])', 'execute')), 'service_role',
  'only the app server (service_role) may read provider metadata: no public client, signed in or not');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r
  where has_function_privilege(r, 'private.record_provider_media(text,boolean,text)', 'execute')), 0, 'no client role or the importer can clear media');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array[
    'catalog_import.start_enrichment_run(text,text,text,timestamp with time zone,text,text,uuid)',
    'catalog_import.enrichment_candidates(text,text[])',
    'catalog_import.attach_game_record(uuid,uuid,text,uuid,text,jsonb,jsonb)']) f
  where has_function_privilege(r, f, 'execute')), 0, 'no API role can run, read or attach an enrichment');

select * from finish();
rollback;
