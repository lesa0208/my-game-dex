-- M15 catalog UX: get_game_source_facts. Who may call it, and that it returns a game's own source
-- records and the held records that may duplicate it, and nothing else. One rolled-back
-- transaction, on a disposable local stack only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.claims(p_user uuid) returns jsonb language plpgsql as $mfa$
begin
  insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    select p_user, p_user, 'test session factor', 'totp', 'verified', now(), now() where not exists (select 1 from auth.mfa_factors where id = p_user);
  insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at) values (gen_random_uuid(), p_user, 'totp', now(), now()) on conflict do nothing;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user);
end $mfa$;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.claims(pg_temp.u(p_actor))::text, true);
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
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'anon', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;

-- e4: catalog editor. c5: collector.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000' from unnest(array['e4', 'c5']) s;
update public.profiles set handle = 'uxf_' || right(id::text, 2), handle_changed_at = now() where id in (pg_temp.u('e4'), pg_temp.u('c5'));
insert into public.staff_roles (user_id, role) values (pg_temp.u('e4'), 'catalog_editor');

-- Two games, one import run, and four source records: A's own, a held look-alike of A, a held
-- record with another title, and B's own.
create temporary table ids (name text primary key, id uuid);
with x as (insert into public.games (title, sort_title, kind) values ('Zqu Lantern Quest', 'Zqu Lantern Quest', 'game') returning id) insert into ids select 'a', id from x;
with x as (insert into public.games (title, sort_title, kind) values ('Zqu Other Game', 'Zqu Other Game', 'game') returning id) insert into ids select 'b', id from x;
with x as (
  insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, finished_at)
  values ('wikidata', (select id from public.platforms where slug = 'snes'), 'zqu-snapshot.json', repeat('a', 64), now(), 'completed', now()) returning id)
insert into ids select 'run', id from x;
insert into private.provider_records (provider_code, entity_type, external_id, payload, import_run_id, status, matched_game_id, review_reason, payload_sha256)
values
  ('wikidata', 'game', 'Q900000001', jsonb_build_object('title', 'Zqu Lantern Quest', 'titles', jsonb_build_array('Zqu Lantern Quest', 'Zqu Chochin Bouken'), 'ja_titles', jsonb_build_array('ズクちょうちん'),
     'source', jsonb_build_object('revision', 42, 'developers', jsonb_build_array('Q170420'), 'publishers', '[]'::jsonb),
     'risk_assessment', jsonb_build_object('flags', jsonb_build_array('external_ids_multiple'), 'critical', jsonb_build_array('conflicting_identifiers'))),
   (select id from ids where name = 'run'), 'promoted', (select id from ids where name = 'a'), null, repeat('1', 64)),
  ('wikidata', 'game', 'Q900000002', jsonb_build_object('title', 'Zqu Lantern Quest'), (select id from ids where name = 'run'), 'needs_review', null, 'Editorial hold (duplicate_item): a second item', repeat('2', 64)),
  ('wikidata', 'game', 'Q900000003', jsonb_build_object('title', 'Zqu Something Else'), (select id from ids where name = 'run'), 'needs_review', null, 'Editorial hold (non_retail): not retail', repeat('3', 64)),
  ('wikidata', 'game', 'Q900000004', jsonb_build_object('title', 'Zqu Other Game'), (select id from ids where name = 'run'), 'promoted', (select id from ids where name = 'b'), null, repeat('4', 64));
select private.import_add_title_keys((select id from ids where name = 'a'), pr) from private.provider_records pr where pr.external_id = 'Q900000001';

create function pg_temp.facts(p_actor text, p_game uuid) returns jsonb language sql as $$
  select nullif(pg_temp.as_user(p_actor, format('select public.get_game_source_facts(%L)::text', p_game)), '')::jsonb
$$;

-- Who may call it
select ok(pg_temp.as_user('c5', format('select public.get_game_source_facts(%L)::text', (select id from ids where name = 'a'))) like 'error:%', 'a collector is refused');
select ok(pg_temp.as_anon(format('select public.get_game_source_facts(%L)::text', (select id from ids where name = 'a'))) like 'error:%', 'an anonymous caller is refused');
select is(pg_temp.as_user('e4', format('select public.get_game_source_facts(%L)::text', gen_random_uuid())), '', 'an unknown game is null');
-- An editor without a verified second factor in this session (aal1) is refused, as on every staff read.
select ok(pg_temp.as_aal1('e4', format('select public.get_game_source_facts(%L)::text', (select id from ids where name = 'a'))) like 'error:%', 'an editor without a recent second factor is refused');

-- What it returns
select is(jsonb_array_length(pg_temp.facts('e4', (select id from ids where name = 'a')) -> 'sources'), 1, 'one source record: the game''s own');
select is(pg_temp.facts('e4', (select id from ids where name = 'a')) -> 'sources' -> 0 ->> 'external_id', 'Q900000001', 'with its external id');
select is(pg_temp.facts('e4', (select id from ids where name = 'a')) -> 'sources' -> 0 -> 'source' -> 'developers', '["Q170420"]'::jsonb, 'with the developers the source names');
select is(pg_temp.facts('e4', (select id from ids where name = 'a')) -> 'sources' -> 0 -> 'critical', '["conflicting_identifiers"]'::jsonb, 'and its critical signals');
select is(pg_temp.facts('e4', (select id from ids where name = 'a')) -> 'sources' -> 0 ->> 'source_name', 'zqu-snapshot.json', 'and the import file it came from');
select is((select string_agg(e ->> 'external_id', ',') from jsonb_array_elements(pg_temp.facts('e4', (select id from ids where name = 'a')) -> 'held_lookalikes') e),
  'Q900000002', 'only the held record with the same title is a look-alike');
select is(jsonb_array_length(pg_temp.facts('e4', (select id from ids where name = 'b')) -> 'held_lookalikes'), 0, 'another game has none');

-- search_catalog_records finds a game by its source records' other titles, Latin and Japanese
select is((select string_agg(e ->> 'title', ',') from jsonb_array_elements(nullif(pg_temp.as_user('e4', 'select public.search_catalog_records(''games'', ''Chochin Bouken'')::text'), '')::jsonb -> 'items') e),
  'Zqu Lantern Quest', 'a source record''s other title finds the game');
select is((select string_agg(e ->> 'title', ',') from jsonb_array_elements(nullif(pg_temp.as_user('e4', 'select public.search_catalog_records(''games'', ''ズクちょうちん'')::text'), '')::jsonb -> 'items') e),
  'Zqu Lantern Quest', 'and so does its Japanese title');

-- Read only
select is((select provolatile from pg_proc where oid = 'public.get_game_source_facts(uuid)'::regprocedure), 's', 'it is stable: it writes nothing');
select ok(not has_function_privilege('anon', 'public.get_game_source_facts(uuid)', 'execute'), 'anon has no execute privilege');

select * from finish();
rollback;
