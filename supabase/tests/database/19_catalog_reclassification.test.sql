-- M5b: reclassifying imported candidates, and the editor review queue.
-- Uses its own provider, titles and accounts, so it runs beside existing catalog data.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated, anon;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  if p_actor is null then
    perform set_config('request.jwt.claims', '{"role": "anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.run() returns uuid language sql stable as $$ select id from private.import_runs where provider_code = 'fixture-reclass' and status = 'running' limit 1 $$;
create function pg_temp.rec(p text) returns uuid language sql stable as $$
  select id from private.provider_records where provider_code = 'fixture-reclass' and external_id = p order by id desc limit 1 $$;
create function pg_temp.rel(p text) returns uuid language sql stable as $$
  select release_id from private.external_references where provider_code = 'fixture-reclass' and external_id = p $$;
create function pg_temp.stage(p jsonb) returns jsonb language sql as $$ select catalog_import.stage_records(pg_temp.run(), pg_temp.u('d9'), p, null) $$;
-- An error is returned as the outcome, so the assertion that expected another outcome fails by name.
create function pg_temp.apply(p text) returns jsonb language plpgsql as $t$
begin
  return catalog_import.apply_record(pg_temp.run(), pg_temp.u('d9'), pg_temp.rec(p), null);
exception when others then
  return jsonb_build_object('outcome', 'error: ' || sqlerrm);
end $t$;
create function pg_temp.start(p_sha text) returns uuid language sql as $$
  select catalog_import.start_run('fixture-reclass', 'snes', 'reclass.json', p_sha, now(), repeat('6', 64), 'Reclassification tests', pg_temp.u('d9')) $$;
create function pg_temp.finish() returns void language sql as $$ select catalog_import.finish_run(pg_temp.run(), pg_temp.u('d9'), 'completed') $$;
create function pg_temp.entry(p_id text, p_extra jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('entity_type', 'release', 'external_id', p_id, 'payload', jsonb_build_object('title', 'Zrx Alpha', 'region_codes', jsonb_build_array('ntsc-uc'), 'name', p_id)) || p_extra $$;

-- A catalog editor and an ordinary user.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@reclass.example.test', now(), '00000000-0000-0000-0000-000000000000' from unnest(array['c1', 'c2']) s;
update public.profiles set handle = 'rcl_' || right(id::text, 2), handle_changed_at = now() where id in (pg_temp.u('c1'), pg_temp.u('c2'));
insert into public.staff_roles (user_id, role) values (pg_temp.u('c1'), 'catalog_editor');

-- ---------------------------------------------------------------------------
-- Candidates, created by a first import
-- ---------------------------------------------------------------------------
insert into private.external_providers (code, name) values ('fixture-reclass', 'Reclassification fixture'), ('fixture-other', 'Other fixture');
select private.record_provider_clearance('fixture-reclass', true, null, repeat('6', 64), 'Reclassification test fixture');
select ok(pg_temp.start(repeat('1', 64)) is not null, 'a first import starts');
select is(pg_temp.stage(jsonb_build_array(jsonb_build_object('entity_type', 'game', 'external_id', 'ZRG', 'payload', jsonb_build_object('title', 'Zrx Alpha'))))
  ->> 'new', '1', 'with a game');
select is(pg_temp.apply('ZRG') ->> 'outcome', 'created', 'which is created');
select is(pg_temp.stage(jsonb_build_array(pg_temp.entry('R-untouched'), pg_temp.entry('R-verified'), pg_temp.entry('R-locked'), pg_temp.entry('R-edited'),
    pg_temp.entry('R-other-source'), pg_temp.entry('R-held'), pg_temp.entry('R-odd-reason'), pg_temp.entry('R-excluded'), pg_temp.entry('R-flipback'))) ->> 'new', '9',
  'nine release entries are staged');
select is((select string_agg(pg_temp.apply(x) ->> 'outcome', ',') from unnest(array['R-untouched', 'R-verified', 'R-locked', 'R-edited', 'R-other-source', 'R-held', 'R-odd-reason', 'R-excluded', 'R-flipback']) x),
  'created,created,created,created,created,created,created,created,created', 'and become nine candidates');
select pg_temp.finish();

-- What editors and other sources did to some of them.
update public.releases set verified_at = now(), edition_name = 'Standard', edition_kind = 'standard', media_count = 1 where id = pg_temp.rel('R-verified');
insert into private.catalog_field_locks (release_id, field_name) values (pg_temp.rel('R-locked'), 'packaging');
select private.record_catalog_audit(pg_temp.u('c1'), 'catalog_record_updated', 'release', pg_temp.rel('R-edited'), 'Editor correction', '{"fields": ["packaging"]}');
update public.releases set status = 'excluded' where id = pg_temp.rel('R-excluded');
insert into private.import_runs (id, provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, finished_at)
values (pg_temp.u('a7'), 'fixture-other', (select id from public.platforms where slug = 'snes'), 'other.json', repeat('2', 64), now(), 'completed', now());
insert into private.provider_records (id, provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_release_id)
values (pg_temp.u('a8'), 'fixture-other', 'release', 'OTHER-1', '{"title": "Zrx Alpha"}', repeat('3', 64), pg_temp.u('a7'), 'matched', pg_temp.rel('R-other-source'));
insert into private.release_evidence (release_id, field_name, provider_record_id) values (pg_temp.rel('R-other-source'), 'region_code', pg_temp.u('a8'));
-- A release an editor made, linked to a source id without an import creating it.
insert into public.releases (id, game_id, platform_id, region_code, media_format_code, status)
select pg_temp.u('a9'), game_id, platform_id, 'pal', media_format_code, 'under_review' from public.releases where id = pg_temp.rel('R-untouched');
insert into private.external_references (provider_code, external_id, release_id) values ('fixture-reclass', 'R-editor-made', pg_temp.u('a9'));

create temp table before_counts as select (select count(*) from public.releases) releases, (select count(*) from private.provider_records) records,
  (select count(*) from private.release_evidence) evidence, (select count(*) from private.external_references) refs, (select count(*) from private.audit_events) audits;

-- ---------------------------------------------------------------------------
-- A later snapshot reclassifies them
-- ---------------------------------------------------------------------------
select ok(pg_temp.start(repeat('4', 64)) is not null, 'a later import starts');
select is(pg_temp.stage(jsonb_build_array(
    pg_temp.entry('R-untouched', '{"ignore_reason": "digital release"}'), pg_temp.entry('R-verified', '{"ignore_reason": "digital release"}'),
    pg_temp.entry('R-locked', '{"ignore_reason": "digital release"}'), pg_temp.entry('R-edited', '{"ignore_reason": "digital release"}'),
    pg_temp.entry('R-other-source', '{"ignore_reason": "digital release"}'), pg_temp.entry('R-held', '{"review_reason": "Nintendo Power flash release"}'),
    pg_temp.entry('R-odd-reason', '{"ignore_reason": "no English label"}'), pg_temp.entry('R-excluded', '{"ignore_reason": "digital release"}'),
    pg_temp.entry('R-editor-made', '{"ignore_reason": "digital release"}'))) ->> 'changed', '8', 'the reclassified entries are staged as changed');
select is((select count(*)::int from catalog_import.pending_records(pg_temp.run(), pg_temp.u('d9'), -1, 500)), 9, 'every reclassified entry with a candidate is pending once');
select is(pg_temp.apply('R-untouched') ->> 'outcome', 'withdrawn', 'an untouched imported candidate the source now rejects is withdrawn');
select is((select status::text from public.releases where id = pg_temp.rel('R-untouched')), 'rejected', 'by marking it rejected');
select is(pg_temp.apply('R-verified') -> 'blockers', '["verified"]', 'a verified candidate is queued for an editor instead');
select is((select status::text || '/' || (verified_at is not null) from public.releases where id = pg_temp.rel('R-verified')), 'under_review/true', 'and left as it was');
select is(pg_temp.apply('R-locked') -> 'blockers', '["field locked"]', 'so is a candidate with a field lock');
select is(pg_temp.apply('R-edited') -> 'blockers', '["changed by an editor"]', 'and one an editor changed');
select is(pg_temp.apply('R-other-source') -> 'blockers', '["supported by another source entry"]', 'and one another source supports');
select is(pg_temp.apply('R-held') -> 'blockers', '["held for review, not rejected"]', 'a held entry is never enough to withdraw');
select is(pg_temp.apply('R-odd-reason') -> 'blockers', '["reason needs an editor"]', 'nor a reason without explicit evidence');
select is(pg_temp.apply('R-excluded') -> 'blockers', '["status excluded"]', 'nor is a candidate no longer under review withdrawn');
select is(pg_temp.apply('R-editor-made') -> 'blockers', '["not created by an import"]', 'and a release an import didn''t create is never withdrawn');
select is((select string_agg(status::text, ',' order by external_id) from public.releases r join private.external_references x on x.release_id = r.id
  where x.provider_code = 'fixture-reclass' and x.external_id <> 'R-untouched'), 'under_review,under_review,excluded,under_review,under_review,under_review,under_review,under_review,under_review',
  'no other candidate changed');
select is((select count(*)::int from catalog_import.pending_records(pg_temp.run(), pg_temp.u('d9'), -1, 500)), 0, 'nothing is pending again');
select is(pg_temp.apply('R-untouched') ->> 'outcome', 'skipped', 'and applying an entry again changes nothing');

-- Provenance and history
select is((select (select count(*) from public.releases) = releases and (select count(*) from private.provider_records) = records + 9
    and (select count(*) from private.release_evidence) = evidence and (select count(*) from private.external_references) = refs from before_counts), true,
  'nothing is deleted: releases, source records, evidence and source ids all stay');
select is((select count(*)::int from private.audit_events where action = 'catalog_record_withdrawn' and actor_id is null and reason = 'Reclassification tests'
  and metadata ->> 'id' = pg_temp.rel('R-untouched')::text and metadata ->> 'reason' = 'digital release'), 1, 'the withdrawal is audited with its reason and run');
select is((select count(*)::int from private.audit_events where action = 'catalog_review_queued' and actor_id is null and metadata ->> 'import_run_id' = pg_temp.run()::text), 8,
  'each queued candidate is audited');
select is((select count(*)::int from private.catalog_reclassifications where import_run_id = pg_temp.run() and action = 'queued'), 8, 'and is in the review queue');
select is((select (r ->> 'withdrawn') || '/' || (r ->> 'queued_for_review') from (select catalog_import.run_report(pg_temp.run()) r) s), '1/8', 'the run report counts both');

-- A withdrawn candidate stays withdrawn
select pg_temp.finish();
select ok(pg_temp.start(repeat('5', 64)) is not null, 'a third import starts');
select is(pg_temp.stage(jsonb_build_array(pg_temp.entry('R-untouched', '{"payload": {"title": "Zrx Alpha", "region_codes": ["ntsc-uc"], "name": "back"}}'))) ->> 'changed', '1',
  'with the withdrawn entry as a candidate again');
select is(pg_temp.apply('R-untouched') ->> 'outcome', 'matched', 'it resolves to the withdrawn candidate');
select is((select status::text from public.releases where id = pg_temp.rel('R-untouched')), 'rejected', 'which an import never restores');
select pg_temp.finish();

-- ---------------------------------------------------------------------------
-- The editor review queue
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user(null, $$select count(*)::text from public.get_catalog_review_queue(50)$$), 'error: permission denied for function get_catalog_review_queue', 'anon can''t read the queue');
select is(pg_temp.as_user('c2', $$select count(*)::text from public.get_catalog_review_queue(50)$$), 'error: not permitted', 'nor can an ordinary user');
select is(pg_temp.as_user('c1', format($$select count(*)::text from public.get_catalog_review_queue(200) q where q.release_id in (select release_id from private.catalog_reclassifications where provider_record_id in (select id from private.provider_records where provider_code = 'fixture-reclass'))$$)),
  'error: permission denied for schema private', 'an editor reads the queue only through the function');
select is((select count(*)::int from private.catalog_reclassifications c where c.action = 'queued' and c.resolved_at is null
  and c.release_id in (select release_id from private.external_references where provider_code = 'fixture-reclass')), 8, 'eight items are open');
select is(pg_temp.as_user('c1', format($$select public.resolve_catalog_review(%L, 'Checked: a legitimate cartridge')::text$$,
  (select id from private.catalog_reclassifications where release_id = pg_temp.rel('R-verified')))), 'true', 'an editor resolves an item, with a reason');
select is((select count(*)::int from private.audit_events where action = 'catalog_review_resolved' and actor_id = pg_temp.u('c1') and metadata ->> 'id' = pg_temp.rel('R-verified')::text), 1,
  'which is audited');

select * from finish();
rollback;
