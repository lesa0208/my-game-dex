-- M16: an unchanged source record seen by another platform's run adds that platform's pairing
-- (migration 20261220100000). Calls the importer functions as their owner, as 17_catalog_import does.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

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
create function pg_temp.start(p_name text, p_platform text, p_lease text) returns void language plpgsql as $$
begin
  insert into runs values (p_name, catalog_import.start_run('wikidata', p_platform, p_name || '.json', pg_catalog.md5(p_name) || pg_catalog.md5(p_name), now(), repeat('1', 64), 'M16 cross-platform test', pg_temp.u(p_lease)));
end $$;
create function pg_temp.stage(p_name text, p_lease text, p_entries jsonb) returns jsonb language sql as $$
  select catalog_import.stage_records(pg_temp.run(p_name), pg_temp.u(p_lease), p_entries, null) $$;
-- Applies every record the run offers, as the import tool does; returns the outcomes, in order.
create function pg_temp.apply_all(p_name text, p_lease text) returns text language plpgsql as $$
declare
  r record;
  v_out text[] := '{}';
begin
  for r in select * from catalog_import.pending_records(pg_temp.run(p_name), pg_temp.u(p_lease), -1, 500) loop
    v_out := v_out || (catalog_import.apply_record(pg_temp.run(p_name), pg_temp.u(p_lease), r.provider_record_id, null) ->> 'outcome');
  end loop;
  return pg_catalog.array_to_string(v_out, ',');
end $$;
create function pg_temp.game() returns uuid language sql stable as $$
  select game_id from private.external_references where provider_code = 'wikidata' and entity_type = 'game' and external_id = 'Q99000001' $$;
create function pg_temp.pairing(p_platform text) returns text language sql stable as $$
  select gp.status::text from public.game_platforms gp join public.platforms p on p.id = gp.platform_id where gp.game_id = pg_temp.game() and p.slug = p_platform $$;

select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', repeat('1', 64), 'CC0 data, terms reviewed');

-- The same record, byte for byte, for every platform: a game whose source states no platform-specific date.
create temp table entry as select '[{"entity_type": "game", "external_id": "Q99000001", "payload": {"title": "Cross Platform Probe", "first_release_date": "1993-06-01", "first_release_precision": "month"}}]'::jsonb as e;

-- 1. The SNES run creates the game and its SNES pairing.
select pg_temp.start('snes-run', 'snes', 'a1');
select pg_temp.stage('snes-run', 'a1', (select e from entry));
select is(pg_temp.apply_all('snes-run', 'a1'), 'created', 'the first platform''s run creates the game');
select is(pg_temp.pairing('snes'), 'under_review', 'with its pairing, under review');
create temp table game_before as select row(g.*)::text as g from public.games g where g.id = pg_temp.game();

-- 2. The Mega Drive run stages the identical record: unchanged, yet its pairing is made.
select pg_temp.start('md-run', 'mega-drive', 'b1');
select is((pg_temp.stage('md-run', 'b1', (select e from entry)) ->> 'unchanged')::int, 1, 'the second platform''s run finds the record unchanged');
select is(pg_temp.apply_all('md-run', 'b1'), 'paired', 'and still pairs the game with its platform');
select is(pg_temp.pairing('mega-drive'), 'under_review', 'the Mega Drive pairing, under review');
select is((select count(*)::int from public.games g join private.external_references x on x.game_id = g.id where x.external_id = 'Q99000001'), 1, 'one game for both platforms');
select is((select row(g.*)::text from public.games g where g.id = pg_temp.game()), (select g from game_before), 'the game itself is unchanged');
select is((select status::text from private.provider_records where external_id = 'Q99000001'), 'promoted', 'and so is the record''s status');
select is(pg_temp.apply_all('md-run', 'b1'), '', 'once paired, the record isn''t offered again');

-- 3. A pairing an editor excluded is never brought back.
insert into public.game_platforms (game_id, platform_id, status) select pg_temp.game(), id, 'excluded' from public.platforms where slug = 'game-boy';
select pg_temp.start('gb-run', 'game-boy', 'c1');
select pg_temp.stage('gb-run', 'c1', (select e from entry));
select is(pg_temp.apply_all('gb-run', 'c1'), '', 'an excluded pairing isn''t offered');
select is(pg_temp.pairing('game-boy'), 'excluded', 'and stays excluded');

-- 4. A rejected game is never paired.
select pg_temp.start('nes-run', 'nes', 'd1');
update public.games set status = 'rejected' where id = pg_temp.game();
select pg_temp.stage('nes-run', 'd1', (select e from entry));
select is(pg_temp.apply_all('nes-run', 'd1'), '', 'a rejected game isn''t offered');
select is(pg_temp.pairing('nes'), null, 'and gets no pairing');

-- 5. catalog_importer gains no function.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'import_pair_unchanged' and has_function_privilege('catalog_importer', p.oid, 'execute')),
  0,
  'the new private function is executable only through apply_record'
);

select * from finish();
rollback;
