-- M16: a platform's game count includes games published without a release (migration 20261219100000).
--
-- Rows are inserted directly in this rolled-back transaction: the publication invariants are
-- checked at commit (private.check_publication_of), which never comes, so this tests only what the
-- count reads. Published records can't be unpublished, so each case is its own row.

begin;
select plan(6);

create temp table n64 as select id from public.platforms where slug = 'nintendo-64';
create temp table basis as select '{"source": "test", "reference": "pgTAP 62", "physical_eligibility": "confirmed", "note": "pgTAP probe: a verified pairing without a release"}'::jsonb as b;
create temp table before as
  select (x ->> 'game_count')::int as games, (x ->> 'release_count')::int as releases
  from jsonb_array_elements(public.list_catalog_platforms()) x where x ->> 'slug' = 'nintendo-64';

-- 1. A published game, public on the Nintendo 64 through a verified pairing, with no release.
insert into public.games (id, title, sort_title, slug, kind, status, verified_at)
values ('00000000-0000-4000-8000-0000000c0de1', 'Count Probe', 'Count Probe', 'count-probe', 'game', 'published', now());
insert into public.game_platforms (game_id, platform_id, status, verified_at, verified_game_revision, verification_basis)
select '00000000-0000-4000-8000-0000000c0de1', id, 'published', now(), 1, (select b from basis) from n64;
-- 2. A game whose pairing isn't published: never counted.
insert into public.games (id, title, sort_title, slug, kind, status)
values ('00000000-0000-4000-8000-0000000c0de2', 'Count Probe Two', 'Count Probe Two', 'count-probe-two', 'game', 'under_review');
insert into public.game_platforms (game_id, platform_id, status) select '00000000-0000-4000-8000-0000000c0de2', id, 'under_review' from n64;
-- 3. A published, verified pairing of a game that isn't published: never counted.
insert into public.games (id, title, sort_title, slug, kind, status, verified_at)
values ('00000000-0000-4000-8000-0000000c0de3', 'Count Probe Three', 'Count Probe Three', 'count-probe-three', 'game', 'under_review', now());
insert into public.game_platforms (game_id, platform_id, status, verified_at, verified_game_revision, verification_basis)
select '00000000-0000-4000-8000-0000000c0de3', id, 'published', now(), 1, (select b from basis) from n64;

create temp table after as
  select (x ->> 'game_count')::int as games, (x ->> 'release_count')::int as releases
  from jsonb_array_elements(public.list_catalog_platforms()) x where x ->> 'slug' = 'nintendo-64';

select is((select games from after), (select games from before) + 1,
  'a game published through a verified pairing, without a release, counts on its platform; an unpublished pairing or game does not');
select is((select releases from after), (select releases from before), 'and no release is added to the count');
select is(
  (select count(*)::int from jsonb_array_elements(public.list_catalog_platforms()) x where (x ->> 'game_count')::int < 0),
  0,
  'no platform has a negative count'
);

select is(
  (select proacl::text from pg_proc where oid = 'public.list_catalog_platforms()'::regprocedure),
  '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres}',
  'the function keeps its grants: anyone may read the public catalog''s platforms'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.list_catalog_platforms()'::regprocedure),
  'and its security definer and empty search path'
);
select ok(
  (select bool_and(x ? 'game_count' and x ? 'release_count' and x ? 'names' and x ? 'family') from jsonb_array_elements(public.list_catalog_platforms()) x),
  'every platform keeps the same fields'
);

select * from finish();
rollback;
