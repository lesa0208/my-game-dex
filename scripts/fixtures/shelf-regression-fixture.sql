-- Shelf regression add-on (synthetic): the three published releases the shelf suite
-- (scripts/app-shelf-checks.mjs) reads from the test stack's own catalog, which no fixture
-- makes: a North American SNES Game Pak and a PAL SNES cartridge of one game, and a
-- Japanese PlayStation disc. Each is shaped like its test-stack record (platform, region,
-- format, standard edition, one medium, packaging recorded as unknown), under a fictional
-- title, so the suite can run on the scratch stack with the same checks.
--
-- Scratch only: the shelf suite installs it after the catalog search fixture, and only
-- when MGD_STACK=scratch. It makes its records as the search fixture's editor and
-- reviewer, so removeFixture (scripts/catalog-fixture.mjs) removes them with the rest.
-- Refuses to run without the search fixture. Idempotent.

\set ON_ERROR_STOP on
begin;
\o /dev/null

select not exists (select 1 from public.staff_roles where user_id = 'f1c5f1c5-0000-4000-8000-00000000c5c5') as missing \gset
\if :missing
  \echo 'The shelf regression add-on needs the catalog search fixture installed first.'
  rollback;
  \quit
\endif
select exists (select 1 from public.games where title = 'Fixture Shelf World' and merged_into_id is null) as installed \gset
\if :installed
  \echo 'Shelf regression add-on is already installed.'
  rollback;
  \quit
\endif

create temp table fx (name text primary key, id uuid not null);
grant all on fx to authenticated;
create function pg_temp.fx_id(p text) returns uuid language sql stable as $$ select id from fx where name = p $$;

-- Acts as the fixture editor ('editor') or the reviewer ('reviewer'): a creator never reviews their own record.
create function pg_temp.fx_as(p text) returns void language sql as $$
  select set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', u, 'role', 'authenticated', 'aal', 'aal2', 'session_id', u)::text, true)
  from (select case p when 'reviewer' then 'f1c5f1c5-0000-4000-8000-00000000c5c6' else 'f1c5f1c5-0000-4000-8000-00000000c5c5' end as u) x
$$;

create function pg_temp.fx_game(p_name text, p_title text, p_year date)
returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.create_game(p_title, 'game', null, null, p_year, 'year', 'Shelf regression fixture (synthetic)');
  perform pg_temp.fx_as('reviewer');
  perform public.verify_game(v, 'Shelf regression fixture (synthetic)', (select revision from public.games where id = v));
  perform pg_temp.fx_as('editor');
  insert into fx values (p_name, v);
  return v;
end $$;

-- A verified, published release of the standard edition on one medium, packaging recorded as unknown.
create function pg_temp.fx_release(p_name text, p_game text, p_platform text, p_format text, p_region text)
returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.create_release(pg_temp.fx_id(p_game), (select id from public.platforms where slug = p_platform), p_format, p_region,
    jsonb_build_object('edition_name', 'Standard', 'edition_kind', 'standard', 'media_count', 1, 'packaging_code', 'unknown'),
    'Shelf regression fixture (synthetic)');
  perform pg_temp.fx_as('reviewer');
  perform public.verify_release(v, 'Shelf regression fixture (synthetic)', (select revision from public.releases where id = v));
  perform public.publish_release(v, 'Shelf regression fixture (synthetic)', (select revision from public.releases where id = v));
  perform pg_temp.fx_as('editor');
  insert into fx values (p_name, v);
  return v;
end $$;

grant execute on function pg_temp.fx_id(text), pg_temp.fx_as(text), pg_temp.fx_game(text, text, date),
  pg_temp.fx_release(text, text, text, text, text) to authenticated;

select pg_temp.fx_as('editor');
set local role authenticated;

-- In place of the test stack's Super Mario World: its two published SNES releases.
select pg_temp.fx_game('world', 'Fixture Shelf World', '1990-01-01');
select pg_temp.fx_release('world-us', 'world', 'snes', 'snes-game-pak-na', 'ntsc-uc');
select pg_temp.fx_release('world-eu', 'world', 'snes', 'snes-cartridge-jp-pal', 'pal');

-- In place of the test stack's Crash Bandicoot: its published Japanese PlayStation release.
select pg_temp.fx_game('bandit', 'Fixture Shelf Bandit', '1996-01-01');
select pg_temp.fx_release('bandit-jp', 'bandit', 'playstation', 'cd-rom', 'ntsc-j');

reset role;
select count(*) as fixture_records from fx \gset
\o
\echo 'Shelf regression add-on installed:' :fixture_records 'records.'
commit;
