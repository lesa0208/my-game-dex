-- M14c-2: the staff reads behind the review-batch pages (20261212100000_m14c2_review_batch_reads).
-- Who may read them, bounded and stable pagination, filters and cursors, provenance, flags and
-- progress, the allow-listed source fields, and that each assessment agrees with what
-- record_batch_outcome and approve_review_batch actually do. One rolled-back transaction, with
-- synthetic accounts and records only; no savepoints (see 54).
begin;
create extension if not exists pgtap with schema extensions;
select plan(115);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.claims(p_user uuid, p_aal text) returns jsonb language plpgsql as $mfa$
begin
  if exists (select 1 from auth.users where id = p_user) then
    insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      select p_user, p_user, 'test session factor', 'totp', 'verified', now(), now()
      where not exists (select 1 from auth.mfa_factors where id = p_user);
    if not exists (select 1 from auth.mfa_amr_claims where session_id = p_user) then
      insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at) values (gen_random_uuid(), p_user, 'totp', now(), now());
    end if;
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal, 'session_id', p_user);
end $mfa$;
create function pg_temp.as_aal(p_actor text, p_aal text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.claims(pg_temp.u(p_actor), p_aal)::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language sql as $$ select pg_temp.as_aal(p_actor, 'aal2', p_sql) $$;
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
create function pg_temp.then_undo(p_change text, p_probe text) returns text language plpgsql as $u$
declare r text;
begin
  begin
    execute p_change;
    execute p_probe into r;
    raise exception 'undo' using errcode = 'P0U01';
  exception when sqlstate 'P0U01' then null;
  end;
  return coalesce(r, '');
exception when others then
  return 'error: ' || sqlerrm;
end $u$;
create function pg_temp.j(r text) returns jsonb language sql immutable as $$
  select case when r like '{%' or r like '[%' then r::jsonb else jsonb_build_object('error', r) end $$;

-- Synthetic accounts, for this transaction only: e1 creates the batches, e2 reviews, e3 is a
-- third editor, c4 a collector.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['e1', 'e2', 'e3', 'c4']) as s;
update public.profiles set handle = 'rb_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['e1', 'e2', 'e3', 'c4']) as s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('e2'), 'catalog_editor'), (pg_temp.u('e3'), 'catalog_editor');
-- A small sample, so a few members are sampled and the rest aren't.
update private.catalog_review_policy set tolerable_error = 0.45, confidence = 0.8;

select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', encode(digest('terms', 'sha256'), 'hex'), 'M14c-2 test clearance');
create temp table b (tag text primary key, id uuid);
create function pg_temp.b(p_tag text) returns uuid language sql stable as $$ select id from b where tag = p_tag $$;
create function pg_temp.g(p_title text) returns uuid language sql stable as $$ select id from public.games where title = p_title $$;
create function pg_temp.platform(p_slug text) returns uuid language sql stable as $$ select id from public.platforms where slug = p_slug $$;
-- An import run of unpublished games on a platform, each with its source record. p_flags gives
-- each title's validator flags; their critical signals follow, as the parser writes them.
-- Payload fields a title's source record carries beyond the minimum (source records can't change later).
create temp table extra (title text primary key, payload jsonb);
insert into extra values
  ('Pilot Bravo', jsonb_build_object(
    'titles', jsonb_build_array('Pilot Bravo', 'Pilot Bravo: Director''s Cut', E'Tab\there', repeat('x', 301), 42, '<script>alert(1)</script>', E'Bravo \u202Eecruos'),
    'ja_titles', '["パイロット・ブラボー"]'::jsonb,
    'first_release_date', '1993-02-03', 'first_release_precision', 'day',
    'secret_marker', 'M14C2-RAW-PAYLOAD',
    'source', jsonb_build_object('revision', 2569010217, 'platforms', '["Q183259", "Q172742"]'::jsonb, 'developers', '["M14C2-RAW-DEVELOPER"]'::jsonb,
      'distribution_formats', '["Q633454", "javascript:alert(1)", "Q0"]'::jsonb, 'instance_of', '["Q7889"]'::jsonb,
      'platform_first_release', '{"value": "1993-02-03", "precision": "day"}'::jsonb,
      'external_ids', '{"igdb": ["pilot-bravo", "has space", "<b>x</b>"], "mobygames": ["1234"]}'::jsonb))),
  ('Pilot Echo', '{"source": {"revision": 1005, "external_ids": {"igdb": ["pilot-bravo"]}}}'::jsonb);
create function pg_temp.make_run(p_tag text, p_platform text, p_titles text[], p_flags text[][] default null) returns uuid language plpgsql as $f$
declare
  v_run uuid;
  v_game uuid;
  v_record uuid;
  v_flags jsonb;
  t text;
  i integer := 0;
begin
  insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, status, finished_at, reason)
  values ('wikidata', pg_temp.platform(p_platform), 'm14c2-test-' || p_tag, encode(digest(p_tag, 'sha256'), 'hex'), now(),
          encode(digest('terms', 'sha256'), 'hex'), 'completed', now(), 'M14c-2 test')
  returning id into v_run;
  foreach t in array p_titles loop
    i := i + 1;
    v_flags := case when p_flags is null then '[]'::jsonb
                    else (select coalesce(jsonb_agg(f), '[]'::jsonb) from unnest(p_flags[i:i]) f where f <> '') end;
    insert into public.games (title, sort_title, kind, status, first_release_date, first_release_precision)
    values (t, t, 'game', 'under_review', ('1993-01-01'::date + i), 'day') returning id into v_game;
    insert into public.game_platforms (game_id, platform_id, status) values (v_game, pg_temp.platform(p_platform), 'under_review');
    insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
    values ('wikidata', 'game', 'Q9' || p_tag || i,
            coalesce((select x.payload from extra x where x.title = t), '{}'::jsonb) ||
            jsonb_build_object('title', t, 'source', coalesce((select x.payload -> 'source' from extra x where x.title = t), jsonb_build_object('revision', 1000 + i)),
              'risk_assessment', jsonb_build_object('contract', 'mgd-risk-assessment', 'version', 1,
              'assessor', 'm14c2-test', 'assessor_version', '1',
              'source', jsonb_build_object('provider', 'wikidata', 'external_id', 'Q9' || p_tag || i, 'revision', 1000 + i, 'snapshot_sha256', encode(digest(p_tag, 'sha256'), 'hex')),
              'flags', v_flags,
              'critical', (select coalesce(jsonb_agg(distinct s), '[]'::jsonb) from (select private.review_critical_signal(f) s from jsonb_array_elements_text(v_flags) f) x where s is not null))),
            encode(digest(p_tag || i, 'sha256'), 'hex'), v_run, 'promoted', v_game)
    returning id into v_record;
    insert into private.import_run_records (import_run_id, provider_record_id, position) values (v_run, v_record, i);
    insert into private.external_references (provider_code, external_id, game_id) values ('wikidata', 'Q9' || p_tag || i, v_game);
  end loop;
  return v_run;
end $f$;
create function pg_temp.make_batch(p_tag text, p_run uuid, p_platform text) returns uuid language plpgsql as $f$
declare v text;
begin
  v := pg_temp.as_user('e1', format($q$select public.create_review_batch(%L, %L, 'M14c-2 test batch')::text$q$, p_run, pg_temp.platform(p_platform)));
  insert into b values (p_tag, v::uuid);
  return v::uuid;
end $f$;
create function pg_temp.outcome(p_actor text, p_tag text, p_game uuid, p_outcome text, p_critical text, p_note text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.record_batch_outcome(%L, %L, %L, %L, %L)::text$q$, pg_temp.b(p_tag), p_game, p_outcome, p_critical, p_note)) $$;
create function pg_temp.list(p_actor text, p_status text, p_platform text, p_after uuid, p_limit integer) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.list_review_batches(%L, %L, %L, %s)::text', p_status, p_platform, p_after, coalesce(p_limit::text, 'null')))) $$;
create function pg_temp.overview(p_actor text, p_tag text) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_review_batch_overview(%L)::text', pg_temp.b(p_tag)))) $$;
create function pg_temp.members(p_actor text, p_tag text, p_filter text, p_after uuid, p_limit integer) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.list_review_batch_members(%L, %L, %L, %s)::text', pg_temp.b(p_tag), p_filter, p_after, coalesce(p_limit::text, 'null')))) $$;
create function pg_temp.member(p_actor text, p_tag text, p_game uuid) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_review_batch_member(%L, %L)::text', pg_temp.b(p_tag), p_game))) $$;
create function pg_temp.ids(p jsonb) returns uuid[] language sql immutable as $$
  select coalesce(array_agg((e -> 'game' ->> 'id')::uuid order by n), '{}') from jsonb_array_elements(p -> 'items') with ordinality x(e, n) $$;
create function pg_temp.approve(p_actor text, p_tag text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.approve_review_batch(%L, 'Reviewed with evidence')::text$q$, pg_temp.b(p_tag))) $$;
create function pg_temp.first_blocker(p_actor text, p_tag text) returns text language sql as $$
  select coalesce(pg_temp.overview(p_actor, p_tag) -> 'blockers' -> 0 ->> 'code', 'none') $$;

-- The batches: p (SNES, eleven members: a critical, a flagged and an info-only member, and
-- eight unflagged, some sampled), n (NES, one member), x (SNES, rejected), a (SNES, approved).
select pg_temp.make_run('p', 'snes', array['Pilot Alpha', 'Pilot Bravo', 'Pilot Charlie', 'Pilot Delta', 'Pilot Echo', 'Pilot Foxtrot',
                                           'Pilot Golf', 'Pilot Hotel', 'Pilot India', 'Pilot Juliet', 'Pilot Kilo'],
                        array[['other_instance_of'], ['mul_label_only'], ['many_platforms'], [''], [''], [''], [''], [''], [''], [''], ['']]);
select pg_temp.make_batch('p', (select id from private.import_runs where source_name = 'm14c2-test-p'), 'snes');
select pg_temp.make_run('n', 'nes', array['Nes Lone']);
select pg_temp.make_batch('n', (select id from private.import_runs where source_name = 'm14c2-test-n'), 'nes');
select pg_temp.make_run('x', 'snes', array['Rejected One', 'Rejected Two']);
select pg_temp.make_batch('x', (select id from private.import_runs where source_name = 'm14c2-test-x'), 'snes');
select pg_temp.as_user('e2', format($q$select public.reject_review_batch(%L, 'M14c-2 test rejection')::text$q$, pg_temp.b('x')));
select pg_temp.make_run('a', 'snes', array['Approved Solo']);
select pg_temp.make_batch('a', (select id from private.import_runs where source_name = 'm14c2-test-a'), 'snes');
select pg_temp.outcome('e2', 'a', pg_temp.g('Approved Solo'), 'correct', null, 'Cartridge and box photographed; label checked against the listing');
select pg_temp.approve('e3', 'a');

create temp table item as select i.* from private.catalog_review_batch_items i where i.batch_id = pg_temp.b('p');
create function pg_temp.sampled_game(p_n integer) returns uuid language sql stable as $$
  select game_id from item where sampled order by game_id offset p_n - 1 limit 1 $$;
create function pg_temp.unsampled_game() returns uuid language sql stable as $$
  select game_id from item where not sampled and cardinality(flags) = 0 order by game_id limit 1 $$;
create temp table expect as select
  (select count(*) from item) as items,
  (select count(*) from item where cardinality(critical_flags) > 0) as critical,
  (select count(*) from item where cardinality(flags) > 0) as flagged,
  (select count(*) from item where sampled) as sampled,
  (select count(*) from item where not sampled and cardinality(flags) = 0) as unsampled;

-- ---------------------------------------------------------------------------
-- Who may read.
-- ---------------------------------------------------------------------------
select is(pg_temp.as_anon('select public.list_review_batches()::text'), 'error: permission denied for function list_review_batches', 'visitors can''t list batches');
select is(pg_temp.as_anon(format('select public.get_review_batch_overview(%L)::text', pg_temp.b('p'))), 'error: permission denied for function get_review_batch_overview', 'nor read one');
select is(pg_temp.as_anon(format('select public.list_review_batch_members(%L)::text', pg_temp.b('p'))), 'error: permission denied for function list_review_batch_members', 'nor its members');
select is(pg_temp.as_anon(format('select public.get_review_batch_member(%L, %L)::text', pg_temp.b('p'), pg_temp.g('Pilot Alpha'))), 'error: permission denied for function get_review_batch_member', 'nor one member');
select is(pg_temp.as_user('c4', 'select public.list_review_batches()::text'), 'error: not permitted', 'a collector can''t list batches');
select is(pg_temp.as_user('c4', format('select public.get_review_batch_overview(%L)::text', pg_temp.b('p'))), 'error: not permitted', 'nor read one');
select is(pg_temp.as_user('c4', format('select public.list_review_batch_members(%L)::text', pg_temp.b('p'))), 'error: not permitted', 'nor its members');
select is(pg_temp.as_user('c4', format('select public.get_review_batch_member(%L, %L)::text', pg_temp.b('p'), pg_temp.g('Pilot Alpha'))), 'error: not permitted', 'nor one member');
select is(pg_temp.as_aal('e2', 'aal1', 'select public.list_review_batches()::text'), 'error: not permitted', 'an editor without a verified second factor can''t list batches');
select is(pg_temp.as_aal('e2', 'aal1', format('select public.get_review_batch_overview(%L)::text', pg_temp.b('p'))), 'error: not permitted', 'nor read one');
select is(pg_temp.as_aal('e2', 'aal1', format('select public.list_review_batch_members(%L)::text', pg_temp.b('p'))), 'error: not permitted', 'nor its members');
select is(pg_temp.as_aal('e2', 'aal1', format('select public.get_review_batch_member(%L, %L)::text', pg_temp.b('p'), pg_temp.g('Pilot Alpha'))), 'error: not permitted', 'nor one member');
select is(pg_temp.then_undo(format($$delete from public.staff_roles where user_id = %L$$, pg_temp.u('e3')),
                            'select pg_temp.as_user(''e3'', ''select public.list_review_batches()::text'')'),
          'error: not permitted', 'nor an editor whose role was removed');
select ok(not has_function_privilege('service_role', 'public.list_review_batches(text, text, uuid, integer)', 'execute')
          and not has_function_privilege('service_role', 'public.get_review_batch_overview(uuid)', 'execute')
          and not has_function_privilege('service_role', 'public.list_review_batch_members(uuid, text, uuid, integer)', 'execute')
          and not has_function_privilege('service_role', 'public.get_review_batch_member(uuid, uuid)', 'execute'),
          'the service role can''t run any of them');
select ok(not has_function_privilege('authenticated', 'private.review_source_summary(jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'private.review_person(uuid, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'private.json_safe_strings(jsonb, text, integer, integer)', 'execute')
          and not has_function_privilege('authenticated', 'private.review_member_rank(boolean, text[], text[])', 'execute')
          and not has_function_privilege('authenticated', 'private.review_external_keys(jsonb)', 'execute'),
          'the private helpers are owner only');
select is((select array_agg(distinct p.provolatile::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('list_review_batches', 'get_review_batch_overview', 'list_review_batch_members', 'get_review_batch_member')),
          array['s'], 'all four are read-only (stable)');

-- ---------------------------------------------------------------------------
-- Listing batches.
-- ---------------------------------------------------------------------------
create temp table all_batches as
  select id, row_number() over (order by created_at desc, id desc) as n from private.catalog_review_batches where id in (select id from b);
select is((select array_agg((e ->> 'id')::uuid order by n) from jsonb_array_elements(pg_temp.list('e2', null, null, null, null) -> 'items') with ordinality x(e, n)
           where (e ->> 'id')::uuid in (select id from b)),
          (select array_agg(id order by n) from all_batches), 'every batch is listed, newest first (ties by id)');
select is(jsonb_array_length(pg_temp.list('e2', null, null, null, 2) -> 'items'), 2, 'a page holds as many as asked for');
select is((pg_temp.list('e2', null, null, null, 2) ->> 'next_after')::uuid,
          ((pg_temp.list('e2', null, null, null, 2) -> 'items' -> 1) ->> 'id')::uuid, 'and points to its last batch when more follow');
create temp table paged as
  with recursive p(page, after, n) as (
    select pg_temp.list('e2', null, null, null, 1), null::uuid, 1
    union all
    select pg_temp.list('e2', null, null, (page ->> 'next_after')::uuid, 1), (page ->> 'next_after')::uuid, n + 1 from p
    where page ->> 'next_after' is not null and n < 50)
  select n, (page -> 'items' -> 0 ->> 'id')::uuid as id, page ->> 'next_after' as next from p;
select is((select array_agg(id order by n) from paged where id in (select id from b)),
          (select array_agg(id order by n) from all_batches), 'one at a time, the pages hold every batch once, in the same order');
select is((select next from paged order by n desc limit 1), null, 'and the last page says nothing follows');
select is((select count(*)::integer from jsonb_array_elements(pg_temp.list('e2', 'open', null, null, null) -> 'items') e where (e ->> 'id')::uuid in (select id from b)), 2, 'two of them are open');
select is((select array_agg(e ->> 'status') from jsonb_array_elements(pg_temp.list('e2', 'rejected', null, null, null) -> 'items') e where (e ->> 'id')::uuid in (select id from b)), array['rejected'], 'one rejected');
select is((select array_agg(e ->> 'status') from jsonb_array_elements(pg_temp.list('e2', 'approved', null, null, null) -> 'items') e where (e ->> 'id')::uuid in (select id from b)), array['approved'], 'and one approved');
select is((select array_agg((e ->> 'id')::uuid) from jsonb_array_elements(pg_temp.list('e2', null, 'nes', null, null) -> 'items') e where (e ->> 'id')::uuid in (select id from b)),
          array[pg_temp.b('n')], 'by platform: only the NES batch');
select is(pg_temp.list('e2', null, 'no-such-platform', null, null), '{"items": [], "status": "unknown_platform", "next_after": null}'::jsonb, 'an unknown platform lists nothing, and says so');
select is(pg_temp.list('e2', 'pending', null, null, null) ->> 'error', 'error: invalid changes', 'an unknown status is refused');
select is(pg_temp.list('e2', null, null, null, 0) ->> 'error', 'error: invalid changes', 'as is an empty page');
select is(pg_temp.list('e2', null, null, null, 101) ->> 'error', 'error: invalid changes', 'and a page of more than 100');
select is(pg_temp.list('e2', null, null, gen_random_uuid(), null) ->> 'error', 'error: invalid cursor', 'a cursor that is no batch is refused');
create temp table lp as select e from jsonb_array_elements(pg_temp.list('e2', 'open', 'snes', null, null) -> 'items') e where (e ->> 'id')::uuid = pg_temp.b('p');
select is((select e - 'id' - 'created_at' - 'source' - 'creator' - 'platform' from lp), jsonb_build_object(
  'status', 'open', 'decided_at', null, 'items', (select items from expect), 'flagged', (select flagged from expect), 'sampled', (select sampled from expect),
  'required', (select flagged + sampled from expect), 'recorded', 0, 'pending', (select flagged + sampled from expect),
  'critical_signals', (select critical from expect), 'critical_errors', 0, 'approvals', '{"recorded": 0, "required": 1}'::jsonb),
  'a listed batch counts its members, its required reviews, their progress, critical signals and approvals');
select is((select (e -> 'source') - 'fetched_at' from lp), '{"name": "m14c2-test-p", "provider": "wikidata", "provider_name": "Wikidata"}'::jsonb, 'and names its source run and provider');
select is((select e -> 'creator' from lp), jsonb_build_object('handle', (select handle from public.profiles where id = pg_temp.u('e1')), 'you', false), 'and its creator, by handle');
select is((select e -> 'creator' ->> 'you' from jsonb_array_elements(pg_temp.list('e1', 'open', 'snes', null, null) -> 'items') e where (e ->> 'id')::uuid = pg_temp.b('p')), 'true', 'which is "you" for the creator');
select ok((select count(*) = 1 from jsonb_array_elements(pg_temp.list('e2', 'approved', null, null, null) -> 'items') e
           where (e ->> 'id')::uuid = pg_temp.b('a') and e ->> 'recorded' = '1' and e ->> 'pending' = '0' and e -> 'approvals' = '{"recorded": 1, "required": 1}'), 'the approved batch: reviewed and approved');
select ok(pg_temp.list('e2', null, null, null, 100)::text !~ '@example\.test' and position(pg_temp.u('e1')::text in pg_temp.list('e2', null, null, null, 100)::text) = 0,
          'no email address or account id appears in the list');

-- ---------------------------------------------------------------------------
-- One batch.
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('e2', format('select public.get_review_batch_overview(%L)::text', gen_random_uuid())), '', 'an unknown batch is nothing');
create temp table ov as select pg_temp.overview('e2', 'p') as o;
select is((select o -> 'counts' from ov), jsonb_build_object(
  'items', (select items from expect), 'critical', (select critical from expect), 'flagged', (select flagged from expect),
  'sampled', (select sampled from expect), 'unsampled', (select unsampled from expect), 'with_info_flags', 1,
  'required', (select flagged + sampled from expect), 'pending', (select flagged + sampled from expect), 'recorded', 0,
  'correct', 0, 'incorrect', 0, 'excluded', 0, 'critical_errors', 0, 'sample_errors', 0), 'its counts, by review category and progress');
select is((select (o -> 'counts' ->> 'critical')::int + ((o -> 'counts' ->> 'flagged')::int - (o -> 'counts' ->> 'critical')::int)
                  + (o -> 'counts' ->> 'sampled')::int + (o -> 'counts' ->> 'unsampled')::int from ov), (select items::int from expect),
          'every member is in exactly one category');
-- Alpha's flag is critical; Bravo and Echo share an IGDB id, which the batch flags as critical
-- for both; Bravo also has a flag of its own.
select ok((select expect.critical = 3 and expect.flagged = 3 and expect.sampled between 1 and 8 from expect), 'the fixture has critical, flagged and sampled members');
select is((select array_agg(g.title || ':' || array_to_string(i.flags, ',') order by g.title) from item i join public.games g on g.id = i.game_id where cardinality(i.flags) > 0),
          array['Pilot Alpha:other_instance_of', 'Pilot Bravo:external_id_shared_in_batch,mul_label_only', 'Pilot Echo:external_id_shared_in_batch'],
          'with the flags the batch froze, its own checks included');
select is((select (o -> 'source') - 'run_id' - 'fetched_at' - 'finished_at' from ov), jsonb_build_object(
  'provider', 'wikidata', 'provider_name', 'Wikidata', 'name', 'm14c2-test-p',
  'snapshot_sha256', encode(digest('p', 'sha256'), 'hex'), 'terms_sha256', encode(digest('terms', 'sha256'), 'hex')), 'its source run, with its snapshot hash');
select is((select (o ->> 'content_sha256') || (o -> 'sampling')::text from ov),
          (select content_sha256 || jsonb_build_object('sample_size', sample_size, 'acceptance_number', acceptance_number, 'tolerable_error', tolerable_error, 'confidence', confidence)::text
           from private.catalog_review_batches where id = pg_temp.b('p')), 'its frozen content hash and sampling policy');
select is((select o -> 'blockers' from ov), jsonb_build_array(jsonb_build_object('code', 'pending_outcomes', 'count', (select flagged + sampled from expect))), 'it waits for its reviews');
select is((select o ->> 'ready' from ov), 'false', 'so it isn''t ready');
select is(pg_temp.approve('e3', 'p'), 'error: batch not reviewed', 'as approval says');
select is((select o -> 'you' from ov), '{"review": null, "approve": null}'::jsonb, 'the reviewer may review and approve it');
select is(pg_temp.overview('e1', 'p') -> 'you', '{"review": "you_created_batch", "approve": "you_created_batch"}'::jsonb, 'its creator may do neither');
select is(pg_temp.overview('e2', 'x') -> 'you', '{"review": "not_open", "approve": "not_open"}'::jsonb, 'nobody reviews a rejected batch');
select is(pg_temp.overview('e2', 'x') -> 'blockers', '[]'::jsonb, 'which has no blockers to show');
select is(pg_temp.overview('e2', 'a') -> 'approvals' -> 'by' -> 0 -> 'person', jsonb_build_object('handle', (select handle from public.profiles where id = pg_temp.u('e3')), 'you', false), 'an approval names its approver by handle');
select ok(pg_temp.overview('e2', 'p')::text !~ '@example\.test', 'no email address appears');

-- Every reviewed member found correct, with evidence: ready, and approval agrees.
create function pg_temp.review_all(p_outcome_for_first_sampled text) returns void language plpgsql as $r$
declare g uuid;
begin
  for g in select game_id from item where sampled or cardinality(flags) > 0 order by game_id loop
    perform pg_temp.outcome('e2', 'p', g, case when g = pg_temp.sampled_game(1) then p_outcome_for_first_sampled else 'correct' end, null,
                            'Cartridge and box photographed; label checked against the listing');
  end loop;
end $r$;
select is(pg_temp.then_undo('select pg_temp.review_all(''correct'')',
          $$select (pg_temp.overview('e2', 'p') ->> 'ready') || ' ' || (pg_temp.overview('e2', 'p') -> 'blockers')::text || ' ' || (pg_temp.approve('e3', 'p')::jsonb ->> 'status')$$),
          'true [] approved', 'reviewed with evidence: ready, and approval succeeds');
select is(pg_temp.then_undo('select pg_temp.review_all(''incorrect'')',
          $$select pg_temp.first_blocker('e2', 'p') || ' ' || pg_temp.approve('e3', 'p')$$),
          'sample_failed error: sample failed', 'a sampled member found incorrect: the sample failed, as approval says');
select is(pg_temp.then_undo('select pg_temp.review_all(''excluded'')',
          $$select pg_temp.first_blocker('e2', 'p') || ' ' || pg_temp.approve('e3', 'p')$$),
          'sample_failed error: sample failed', 'a sampled member excluded is a sample error too, as approval says');
select is(pg_temp.then_undo($$
            update private.catalog_review_batch_items set outcome = case when cardinality(critical_flags) > 0 then 'incorrect' else 'correct' end,
              critical_error = case when cardinality(critical_flags) > 0 then 'wrong_identity_or_type' end,
              note = 'Cartridge and box photographed; label checked against the listing', reviewed_by = pg_temp.u('e2'), recorded_at = clock_timestamp()
            where batch_id = pg_temp.b('p') and (sampled or cardinality(flags) > 0)$$,
          $$select pg_temp.first_blocker('e2', 'p') || ' ' || pg_temp.approve('e3', 'p')$$),
          'critical_errors_unresolved error: critical errors unresolved', 'a critical error marked incorrect: unresolved, as approval says');
select is(pg_temp.then_undo($$select pg_temp.review_all('correct');
            update private.catalog_review_batch_items set note = null where batch_id = pg_temp.b('p') and game_id = pg_temp.sampled_game(1)$$,
          $$select pg_temp.first_blocker('e2', 'p') || ' ' || pg_temp.approve('e3', 'p')$$),
          'evidence_missing error: evidence required', 'an older correct outcome without evidence: missing, as approval says');
select is(pg_temp.then_undo($$select pg_temp.review_all('correct'); update public.games set revision = revision + 1 where id = pg_temp.unsampled_game()$$,
          $$select pg_temp.first_blocker('e2', 'p') || ' ' || pg_temp.approve('e3', 'p')$$),
          'stale error: batch stale', 'a member changed after freezing: stale, as approval says');
select is(pg_temp.then_undo($$select pg_temp.review_all('correct'); update private.external_providers set commercial_use_cleared = false where code = 'wikidata'$$,
          $$select pg_temp.first_blocker('e2', 'p') || ' ' || pg_temp.approve('e3', 'p')$$),
          'publication_rights error: provider not cleared', 'a source no longer cleared: rights, as approval says');
-- (Record origins are permanent, so "created" is shown with the game's submitter.)
select is(pg_temp.then_undo($$select pg_temp.review_all('correct'); update public.games set submitted_by = pg_temp.u('e3') where id = pg_temp.unsampled_game()$$,
          $$select (pg_temp.overview('e3', 'p') -> 'you' ->> 'approve') || ' ' || pg_temp.approve('e3', 'p')$$),
          'you_created_member error: own record', 'an approver who created a member may not approve, as approval says');
select is(pg_temp.then_undo($$update public.games set revision = revision + 1 where id = pg_temp.unsampled_game();
                              update private.external_providers set commercial_use_cleared = false where code = 'wikidata'$$,
          $$select string_agg(e ->> 'code', ',' order by n) from jsonb_array_elements(pg_temp.overview('e2', 'p') -> 'blockers') with ordinality x(e, n)$$),
          'pending_outcomes,stale,publication_rights', 'several blockers at once are all listed, in approval''s order');
select is(pg_temp.then_undo($$insert into private.catalog_review_batch_approvals (batch_id, approver_id, reason) values (pg_temp.b('p'), pg_temp.u('e3'), 'first of two')$$,
          $$select (pg_temp.overview('e3', 'p') -> 'you' ->> 'approve') || ' ' || pg_temp.approve('e3', 'p')$$),
          'you_already_approved error: already approved', 'an editor who already approved may not again, as approval says');

-- ---------------------------------------------------------------------------
-- Its members.
-- ---------------------------------------------------------------------------
create temp table mall as select pg_temp.members('e2', 'p', 'all', null, 100) as m;
select is((select jsonb_array_length(m -> 'items') from mall), (select items::int from expect), 'all members, on one page of 100');
select is((select array_agg(e ->> 'category' order by n) from mall, jsonb_array_elements(m -> 'items') with ordinality x(e, n)),
          (select array_agg(c order by r, t, id) from (select (array['critical', 'flagged', 'sampled', 'unsampled'])[private.review_member_rank(i.sampled, i.flags, i.critical_flags) + 1] c,
                                                             private.review_member_rank(i.sampled, i.flags, i.critical_flags) r, g.title t, i.game_id id
                                                      from item i join public.games g on g.id = i.game_id) s),
          'critical first, then flagged, sampled and unsampled, each by title');
select is((select pg_temp.ids(m) from mall),
          (select array_agg(i.game_id order by private.review_member_rank(i.sampled, i.flags, i.critical_flags), g.title, i.game_id) from item i join public.games g on g.id = i.game_id),
          'in that exact order');
select is((select e -> 'source' from mall, jsonb_array_elements(m -> 'items') e where e -> 'game' ->> 'title' = 'Pilot Alpha'),
          '{"provider": "wikidata", "external_id": "Q9p1"}'::jsonb, 'each with its source record');
select is((select e - 'game' - 'source' from mall, jsonb_array_elements(m -> 'items') e where e -> 'game' ->> 'title' = 'Pilot Alpha'), jsonb_build_object(
  'pairing_status', 'under_review', 'category', 'critical', 'sampled', false, 'flags', '["other_instance_of"]'::jsonb, 'info_flags', '[]'::jsonb,
  'critical_flags', '["wrong_identity_or_type"]'::jsonb, 'requires_outcome', true, 'outcome', null, 'critical_error', null, 'note', null,
  'recorded_at', null, 'reviewer', null, 'stale', false), 'its flags, critical signals, category and progress');
select is((select e -> 'info_flags' from mall, jsonb_array_elements(m -> 'items') e where e -> 'game' ->> 'title' = 'Pilot Charlie'), '["many_platforms"]'::jsonb, 'an info flag is shown');
select is((select e ->> 'requires_outcome' from mall, jsonb_array_elements(m -> 'items') e where e -> 'game' ->> 'title' = 'Pilot Charlie'),
          (select sampled::text from item where game_id = pg_temp.g('Pilot Charlie')), 'but needs no review unless sampled');
select is((select array[jsonb_array_length(pg_temp.members('e2', 'p', 'needs_review', null, 100) -> 'items'),
                        jsonb_array_length(pg_temp.members('e2', 'p', 'critical', null, 100) -> 'items'),
                        jsonb_array_length(pg_temp.members('e2', 'p', 'flagged', null, 100) -> 'items'),
                        jsonb_array_length(pg_temp.members('e2', 'p', 'sampled', null, 100) -> 'items'),
                        jsonb_array_length(pg_temp.members('e2', 'p', 'unsampled', null, 100) -> 'items'),
                        jsonb_array_length(pg_temp.members('e2', 'p', 'reviewed', null, 100) -> 'items')]),
          (select array[(flagged + sampled)::int, critical::int, flagged::int, sampled::int, unsampled::int, 0] from expect),
          'each filter holds what the overview counts');
select is(pg_temp.members('e2', 'p', 'needs_review', null, null) ->> 'filter', 'needs_review', 'the filter is echoed');
create temp table mpaged as
  with recursive p(page, n) as (
    select pg_temp.members('e2', 'p', 'all', null, 3), 1
    union all
    select pg_temp.members('e2', 'p', 'all', (page ->> 'next_after')::uuid, 3), n + 1 from p where page ->> 'next_after' is not null and n < 20)
  select n, page from p;
select is((select array_agg(x order by n, k) from mpaged, unnest(pg_temp.ids(page)) with ordinality u(x, k)), (select pg_temp.ids(m) from mall),
          'three at a time, the pages hold every member once, in the same order');
select is((select page ->> 'next_after' from mpaged order by n desc limit 1), null, 'and the last says nothing follows');
-- Reviewing while paging: the last member of the first page is reviewed; the next page, from it,
-- still holds every member that was after it, so none pending is skipped.
create temp table first_page as select pg_temp.members('e2', 'p', 'needs_review', null, 3) as p, pg_temp.ids(pg_temp.members('e2', 'p', 'needs_review', null, 100)) as before;
select is((select pg_temp.outcome('e2', 'p', (pg_temp.ids(p))[3], 'correct', null, 'Cartridge and box photographed; label checked against the listing') from first_page), 'true',
          'the last member on the first page is reviewed');
select is((select pg_temp.ids(pg_temp.members('e2', 'p', 'needs_review', (pg_temp.ids(p))[3], 100)) from first_page),
          (select before[4:] from first_page),
          'the next page, from it, holds every member that followed it: none is skipped');
select is((select pg_temp.then_undo(format($$update public.games set title = 'AAA Renamed First' where id = %L;
                                             update public.games set title = 'AAA Renamed Second' where id = %L$$, (pg_temp.ids(p))[3], before[array_length(before, 1)]),
                                      format($$select pg_temp.ids(pg_temp.members('e2', 'p', 'needs_review', %L, 100))::text$$, (pg_temp.ids(p))[3]))
           from first_page),
          (select before[4:]::text from first_page),
          'renaming the cursor and a later member while paging skips and repeats nothing');
select is((select e ->> 'note' from jsonb_array_elements(pg_temp.members('e2', 'p', 'reviewed', null, null) -> 'items') e),
          'Cartridge and box photographed; label checked against the listing', 'a reviewed member shows its note');
select is((select e -> 'reviewer' ->> 'you' from jsonb_array_elements(pg_temp.members('e2', 'p', 'reviewed', null, null) -> 'items') e), 'true', 'and its reviewer, "you" for the reviewer');
select is((select e -> 'reviewer' ->> 'handle' from jsonb_array_elements(pg_temp.members('e3', 'p', 'reviewed', null, null) -> 'items') e),
          (select handle from public.profiles where id = pg_temp.u('e2')), 'by handle for others');
select is(pg_temp.then_undo('update public.games set revision = revision + 1 where id = pg_temp.unsampled_game()',
          $$select e ->> 'stale' from jsonb_array_elements(pg_temp.members('e2', 'p', 'unsampled', null, 100) -> 'items') e where (e -> 'game' ->> 'id')::uuid = pg_temp.unsampled_game()$$),
          'true', 'a member changed after freezing is stale');
select is((select e ->> 'stale' from jsonb_array_elements(pg_temp.members('e2', 'x', 'all', null, null) -> 'items') e limit 1), null, 'staleness is shown only for an open batch');
select is(pg_temp.members('e2', 'p', 'pending', null, null) ->> 'error', 'error: invalid changes', 'an unknown filter is refused');
select is(pg_temp.members('e2', 'p', 'all', null, 101) ->> 'error', 'error: invalid changes', 'as is a page of more than 100');
select is(pg_temp.members('e2', 'p', 'all', pg_temp.g('Nes Lone'), null) ->> 'error', 'error: invalid cursor', 'a cursor from another batch is refused');
select is(pg_temp.as_user('e2', format('select public.list_review_batch_members(%L)::text', gen_random_uuid())), '', 'an unknown batch has no members');

-- ---------------------------------------------------------------------------
-- One member.
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('e2', format('select public.get_review_batch_member(%L, %L)::text', pg_temp.b('p'), pg_temp.g('Nes Lone'))), '', 'a game that isn''t a member is nothing');
select is((pg_temp.member('e2', 'p', pg_temp.g('Pilot Alpha')) -> 'member') - 'frozen_game_revision', jsonb_build_object(
  'category', 'critical', 'sampled', false, 'flags', '["other_instance_of"]'::jsonb, 'info_flags', '[]'::jsonb, 'critical_flags', '["wrong_identity_or_type"]'::jsonb,
  'requires_outcome', true, 'outcome', null, 'critical_error', null, 'note', null, 'recorded_at', null, 'reviewer', null, 'stale', false), 'a member, as frozen');
select is(pg_temp.member('e2', 'p', pg_temp.g('Pilot Alpha')) -> 'pairing', '{"status": "under_review", "releases": {"total": 0, "published": 0}, "physical_confirmed": false}'::jsonb,
          'its pairing: no physical existence confirmed, no release');
select is((pg_temp.member('e2', 'p', pg_temp.g('Pilot Alpha')) -> 'source') - 'record', jsonb_build_object(
  'provider', 'wikidata', 'provider_name', 'Wikidata', 'external_id', 'Q9p1', 'payload_sha256', encode(digest('p1', 'sha256'), 'hex'),
  'snapshot_sha256', encode(digest('p', 'sha256'), 'hex'), 'assessment', '{"problems": [], "assessor": "m14c2-test", "assessor_version": "1"}'::jsonb),
  'its source record, hashes and valid risk assessment');
select is(pg_temp.member('e2', 'p', pg_temp.g('Pilot Alpha')) -> 'you', '{"record": null, "options": ["correct", "incorrect", "excluded"], "keep_critical_error": null}'::jsonb,
          'the reviewer may record any outcome');
select is(pg_temp.member('e1', 'p', pg_temp.g('Pilot Alpha')) -> 'you' ->> 'record', 'you_created_batch', 'the batch''s creator may not');
select is(pg_temp.outcome('e1', 'p', pg_temp.g('Pilot Alpha'), 'excluded', null, null), 'error: own record', 'as record_batch_outcome says');
select is(pg_temp.member('e2', 'p', pg_temp.unsampled_game()) -> 'you' ->> 'record', 'not_required', 'an unsampled member takes no outcome');
select is(pg_temp.outcome('e2', 'p', pg_temp.unsampled_game(), 'excluded', null, null), 'error: record unavailable', 'as record_batch_outcome says');
select is(pg_temp.then_undo($$update public.games set submitted_by = pg_temp.u('e2') where id = pg_temp.g('Pilot Alpha')$$,
          $$select (pg_temp.member('e2', 'p', pg_temp.g('Pilot Alpha')) -> 'you' ->> 'record') || ' ' || pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'excluded', null, null)$$),
          'you_created_record error: own record', 'nor one who created the game, as record_batch_outcome says');
select is(pg_temp.then_undo($$update public.game_platforms set submitted_by = pg_temp.u('e2') where game_id = pg_temp.g('Pilot Alpha')$$,
          $$select (pg_temp.member('e2', 'p', pg_temp.g('Pilot Alpha')) -> 'you' ->> 'record') || ' ' || pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'excluded', null, null)$$),
          'you_created_record error: own record', 'nor one who submitted its pairing, as record_batch_outcome says');
select is(pg_temp.then_undo($$select pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'incorrect', null, 'Looks wrong')$$,
          $$select (pg_temp.member('e2', 'p', pg_temp.g('Pilot Alpha')) -> 'you')::text$$),
          '{"record": null, "options": ["excluded"], "keep_critical_error": null}', 'found incorrect without a critical error, it may only be excluded, with any critical error');
-- (Two statements: a query reads the rows as they were when it started.)
select is(pg_temp.then_undo($$select pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'incorrect', null, 'Looks wrong');
                              select pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'excluded', 'wrong_platform', null)$$,
          $$select outcome || ' ' || critical_error from private.catalog_review_batch_items where batch_id = pg_temp.b('p') and game_id = pg_temp.g('Pilot Alpha')$$),
          'excluded wrong_platform', 'and excluding it with one is recorded, as record_batch_outcome allows');
select is(pg_temp.then_undo($$select pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'incorrect', 'wrong_identity_or_type', 'Not a game: a cartridge-based utility')$$,
          $$select (pg_temp.member('e2', 'p', pg_temp.g('Pilot Alpha')) -> 'you')::text$$),
          '{"record": null, "options": ["excluded"], "keep_critical_error": "wrong_identity_or_type"}', 'found incorrect, it may only be excluded, keeping its critical error');
select is(pg_temp.then_undo($$select pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'incorrect', 'wrong_identity_or_type', 'Not a game: a cartridge-based utility');
                              select pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'excluded', 'wrong_identity_or_type', 'Excluded: not a game')$$,
          $$select (pg_temp.member('e2', 'p', pg_temp.g('Pilot Alpha')) -> 'you' ->> 'record') || ' ' || pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'excluded', 'wrong_identity_or_type', null)$$),
          'outcome_final error: outcome recorded', 'excluded, its outcome is final, as record_batch_outcome says');
select is(pg_temp.then_undo($$select pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'incorrect', 'wrong_identity_or_type', 'Not a game: a cartridge-based utility');
                              select pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'excluded', 'wrong_identity_or_type', 'Excluded: not a game')$$,
          $$select string_agg((e ->> 'outcome') || ':' || (e ->> 'note') || ':' || (e -> 'person' ->> 'you'), ' | ' order by n)
            from jsonb_array_elements(pg_temp.member('e3', 'p', pg_temp.g('Pilot Alpha')) -> 'trail') with ordinality x(e, n)$$),
          'incorrect:Not a game: a cartridge-based utility:false | excluded:Excluded: not a game:false', 'its outcome trail, oldest first');
select is(pg_temp.then_undo($$insert into private.catalog_review_batch_approvals (batch_id, approver_id, reason) values (pg_temp.b('p'), pg_temp.u('e3'), 'first of two')$$,
          $$select (pg_temp.member('e2', 'p', pg_temp.g('Pilot Alpha')) -> 'you' ->> 'record') || ' ' || (pg_temp.overview('e2', 'p') -> 'you' ->> 'review') || ' '
                   || pg_temp.outcome('e2', 'p', pg_temp.g('Pilot Alpha'), 'excluded', null, null)$$),
          'approval_started approval_started error: batch approval started', 'once an approval is recorded, outcomes are locked, as record_batch_outcome says');
select is(pg_temp.member('e2', 'x', pg_temp.g('Rejected One')) -> 'you' ->> 'record', 'not_open', 'a rejected batch''s members take no outcome');
select is(pg_temp.member('e2', 'p', pg_temp.g('Pilot Bravo')) -> 'batches', (select jsonb_build_array(jsonb_build_object(
            'id', pg_temp.b('p'), 'status', 'open', 'created_at', b.created_at, 'decided_at', null, 'sampled', false, 'flagged', true,
            'outcome', null, 'critical_error', null, 'recorded_at', null)) from private.catalog_review_batches b where b.id = pg_temp.b('p')),
          'its batches: this one');

-- The source record's fields (Pilot Bravo's payload, above), allow-listed: odd or hostile values
-- are left out, never shown raw.
select is(pg_temp.member('e2', 'p', pg_temp.g('Pilot Bravo')) -> 'source' -> 'record', jsonb_build_object(
  'title', 'Pilot Bravo',
  'titles', jsonb_build_array('Pilot Bravo', 'Pilot Bravo: Director''s Cut', '<script>alert(1)</script>'),
  'ja_titles', '["パイロット・ブラボー"]'::jsonb,
  'first_release', '{"value": "1993-02-03", "precision": "day"}'::jsonb,
  'revision', 2569010217,
  'platform_first_release', '{"value": "1993-02-03", "precision": "day"}'::jsonb,
  'distribution_formats', '["Q633454"]'::jsonb, 'instance_of', '["Q7889"]'::jsonb, 'platforms', 2,
  'external_ids', '{"igdb": ["pilot-bravo"], "mobygames": ["1234"]}'::jsonb,
  'detail', true),
  'only allow-listed fields of a fixed shape and length (markup stays text for the page to escape)');
select ok(pg_temp.member('e2', 'p', pg_temp.g('Pilot Bravo'))::text !~ 'M14C2-RAW-(PAYLOAD|DEVELOPER)', 'nothing else of the payload is returned');
select is(pg_temp.member('e2', 'p', pg_temp.g('Pilot Bravo')) -> 'source' -> 'assessment' -> 'problems', '[]'::jsonb, 'its assessment is still valid');

-- Possible duplicates and conflicts.
-- Another catalog game with the same title key, paired with the SNES, now holding the member's source id.
insert into public.games (title, sort_title, kind, status) values ('PILOT BRAVO', 'PILOT BRAVO', 'game', 'under_review');
insert into public.game_platforms (game_id, platform_id, status) values (pg_temp.g('PILOT BRAVO'), pg_temp.platform('snes'), 'under_review');
update private.external_references set game_id = pg_temp.g('PILOT BRAVO') where provider_code = 'wikidata' and external_id = 'Q9p2';
select is(pg_temp.member('e2', 'p', pg_temp.g('Pilot Bravo')) -> 'conflicts' -> 'same_title',
          jsonb_build_array(jsonb_build_object('id', pg_temp.g('PILOT BRAVO'), 'title', 'PILOT BRAVO', 'status', 'under_review', 'on_platform', true, 'in_batch', false)),
          'a catalog game with the same title key, on the same platform');
select is(pg_temp.member('e2', 'p', pg_temp.g('Pilot Bravo')) -> 'conflicts' -> 'shared_ids', jsonb_build_array(jsonb_build_object('id', pg_temp.g('Pilot Echo'), 'title', 'Pilot Echo')),
          'a member sharing an IGDB id');
select is(pg_temp.member('e2', 'p', pg_temp.g('Pilot Bravo')) -> 'conflicts' -> 'linked_elsewhere',
          jsonb_build_array(jsonb_build_object('id', pg_temp.g('PILOT BRAVO'), 'title', 'PILOT BRAVO', 'status', 'under_review')),
          'and another game linked to its source id');
select is(pg_temp.member('e2', 'p', pg_temp.g('Pilot Delta')) -> 'conflicts', '{"same_title": [], "shared_ids": [], "linked_elsewhere": []}'::jsonb, 'none, when there are none');

-- The app's evidence check (src/features/batches/batches.test.mjs) is tested on these same notes;
-- the database must decide each the same way.
select is((select array_agg(private.evidence_note_ok(v) order by n) from unnest(array[
            null, '', '                         ', E'\t\n  \r\n\t   \n\t\t  \n', 'Cartridge photo ok.', 'Cartridge photo ok!!', '   short note    here   ',
            '!!!!!!!!!!....------,,,,,', 'a.b.c.d.e.f.g.h.i.....', 'a.b.c.d.e.f.g.h.i.j...', repeat('x', 500), repeat('x', 501),
            E'Line one of the evidence\nline two of it', 'カートリッジと箱を確認しました。ラベルは一覧と一致しています。',
            'Cartridge and box photographed; label checked against the listing']::text[]) with ordinality u(v, n)),
          array[false, false, false, false, false, true, false, false, false, true, true, false, true, true, true],
          'the database decides the app''s evidence cases as the app does');

-- The review rules are unchanged.
select is(pg_temp.outcome('e2', 'p', pg_temp.sampled_game(1), 'correct', null, null), 'error: evidence required', 'a correct outcome still needs evidence');
select is(pg_temp.outcome('e2', 'p', pg_temp.sampled_game(1), 'correct', 'wrong_platform', 'Cartridge and box photographed; label checked against the listing'),
          'error: invalid changes', 'and no critical error');
select is((select count(*)::integer from public.game_platforms gp join item i on i.game_id = gp.game_id and i.platform_id = gp.platform_id where gp.verified_at is not null or gp.status = 'published'),
          0, 'reading changed nothing: no member of the open batch is verified or published');

select * from finish();
rollback;
