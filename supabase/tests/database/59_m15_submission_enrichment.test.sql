-- M15 submission enrichment: a new-game submission waits for its lookup from the moment it
-- exists; only the server (service_role) claims and records lookups, once per claim; failures back
-- off and stop after 5 attempts; a changed title looks up again and drops a late answer; editors
-- read the result with the catalog games it may duplicate; collectors see only their own status.
-- Nothing changes a catalog record. One rolled-back transaction, on a disposable local stack only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.claims(p_user uuid, p_aal text) returns jsonb language plpgsql as $mfa$
begin
  if p_aal = 'aal2' then
    insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      select p_user, p_user, 'test session factor', 'totp', 'verified', now(), now() where not exists (select 1 from auth.mfa_factors where id = p_user);
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at) values (gen_random_uuid(), p_user, 'totp', now(), now()) on conflict do nothing;
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal, 'session_id', p_user);
end $mfa$;
-- Runs p_sql as a signed-in user (aal2 unless p_aal says otherwise), as anon (p_actor null), or as
-- service_role (p_actor 'service'), and returns its result or the error as text.
create function pg_temp.as_role(p_actor text, p_sql text, p_aal text default 'aal2') returns text language plpgsql as $t$
declare r text;
begin
  if p_actor is null then
    perform set_config('request.jwt.claims', '{"role": "anon"}', true);
    perform set_config('role', 'anon', true);
  elsif p_actor = 'service' then
    perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
    perform set_config('role', 'service_role', true);
  else
    perform set_config('request.jwt.claims', pg_temp.claims(pg_temp.u(p_actor), p_aal)::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;

create temporary table ids (name text primary key, id uuid);
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
create function pg_temp.row(p text) returns private.submission_enrichments language sql stable as $$ select * from private.submission_enrichments where submission_id = pg_temp.id(p) $$;
create function pg_temp.claim(p_sub text default null) returns jsonb language sql as $$
  select nullif(pg_temp.as_role('service', format('select public.claim_submission_enrichments(%L, 5)::text', pg_temp.id(p_sub))), '')::jsonb
$$;
create function pg_temp.record(p_sub text, p_claim uuid, p_result jsonb) returns text language sql as $$
  select pg_temp.as_role('service', format('select public.record_submission_enrichment(%L, %L, %L)::text', pg_temp.id(p_sub), p_claim, p_result))
$$;
create function pg_temp.cand(p_qid text, p_title text) returns jsonb language sql immutable as $$
  select jsonb_build_object('provider', 'wikidata', 'external_id', p_qid, 'url', 'https://www.wikidata.org/wiki/' || p_qid, 'revision', 7, 'retrieved_at', '2026-11-25T10:00:00Z',
    'licence', 'Wikidata structured data, CC0 1.0', 'title', p_title, 'titles', jsonb_build_array(p_title), 'ja_titles', '[]'::jsonb, 'title_matches', true,
    'developers', jsonb_build_array('Q170420'), 'publishers', '[]'::jsonb, 'flags', '[]'::jsonb)
$$;
create function pg_temp.result(p_status text, p_candidates jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('status', p_status, 'title', 'Zqe Tetsu no Suisei', 'platform', 'snes', 'retrieved_at', '2026-11-25T10:00:00Z',
    'candidates', p_candidates, 'labels', jsonb_build_object('Q170420', 'Zqe Studio'))
$$;

-- c1, c2: collectors. e4: catalog editor.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000' from unnest(array['c1', 'c2', 'e4']) s;
update public.profiles set handle = 'enr_' || right(id::text, 2), handle_changed_at = now() where id in (pg_temp.u('c1'), pg_temp.u('c2'), pg_temp.u('e4'));
insert into public.staff_roles (user_id, role) values (pg_temp.u('e4'), 'catalog_editor');

-- A catalog game imported from Wikidata item Q900000101, whose source lists the title the
-- collector will type.
with x as (insert into public.games (title, sort_title, kind) values ('Zqe Iron Comet', 'Zqe Iron Comet', 'game') returning id) insert into ids select 'catalog', id from x;
with x as (
  insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, finished_at)
  values ('wikidata', (select id from public.platforms where slug = 'snes'), 'zqe.json', repeat('e', 64), now(), 'completed', now()) returning id)
insert into ids select 'run', id from x;
insert into private.provider_records (provider_code, entity_type, external_id, payload, import_run_id, status, matched_game_id, payload_sha256)
values ('wikidata', 'game', 'Q900000101', jsonb_build_object('title', 'Zqe Iron Comet', 'titles', jsonb_build_array('Zqe Iron Comet', 'Zqe Tetsu no Suisei')),
        pg_temp.id('run'), 'promoted', pg_temp.id('catalog'), repeat('5', 64));
create temporary table before_catalog as select (select count(*) from public.games) games, (select count(*) from public.releases) releases,
  (select count(*) from public.games where status = 'published') published;

-- 1. Submitting queues the lookup
select ok(pg_temp.as_role('c1', $$select public.submit_game('Zqe Tetsu no Suisei', 'game', null, 'snes', 'rom-cartridge', 'unknown', '{}', '[]', null, true)::text$$) like '%submitted%',
  'a collector submits a new game with the cartridge shell not known (the unclassified format) and the region unknown');
insert into ids select 'sub', s.id from public.catalog_change_requests s where s.submitted_by = pg_temp.u('c1') and s.request_type = 'new_game';
select is((pg_temp.row('sub')).status, 'pending', 'its lookup waits from the moment it exists');
select is((select media_format_code || '/' || status from public.releases where id = (select release_id from public.catalog_change_requests where id = pg_temp.id('sub'))),
  'rom-cartridge/unverified', 'its release records the shell as not classified, unverified');
select ok(not exists (select 1 from public.platform_media_formats f join public.platforms p on p.id = f.platform_id where p.slug = 'snes' and f.media_format_code = 'rom-cartridge' and f.accepts_new_publications),
  'and that format can''t be published on SNES until an editor names the shell');

-- 2. Only the server claims and records
select ok(pg_temp.as_role('c1', 'select public.claim_submission_enrichments(null, 1)::text') like 'error:%', 'a collector can''t claim lookups');
select ok(pg_temp.as_role(null, 'select public.claim_submission_enrichments(null, 1)::text') like 'error:%', 'nor can anon');
select ok(pg_temp.as_role('e4', 'select public.claim_submission_enrichments(null, 1)::text') like 'error:%', 'nor an editor');
select ok(pg_temp.as_role('c1', format('select public.record_submission_enrichment(%L, gen_random_uuid(), %L)::text', pg_temp.id('sub'), pg_temp.result('no_match', '[]'))) like 'error:%',
  'a collector can''t write a source claim');
select is(jsonb_array_length(pg_temp.claim('sub')), 1, 'the server claims it');
insert into ids values ('claim1', (pg_temp.row('sub')).claim_id);
select is(((pg_temp.row('sub')).attempts), 1, 'one attempt');
select is(jsonb_array_length(pg_temp.claim('sub')), 0, 'a lookup in flight isn''t claimed twice');
select is(pg_temp.record('sub', gen_random_uuid(), pg_temp.result('no_match', '[]')), 'false', 'an answer to another claim is dropped');
select ok(pg_temp.record('sub', pg_temp.id('claim1'), pg_temp.result('ambiguous', jsonb_build_array(jsonb_build_object('provider', 'wikidata', 'external_id', 'not-a-qid', 'title', 'x')))) like 'error:%invalid enrichment%',
  'a malformed candidate is refused');
select ok(pg_temp.record('sub', pg_temp.id('claim1'), pg_temp.result('single_match', jsonb_build_array(pg_temp.cand('Q900000101', 'Zqe Iron Comet'), pg_temp.cand('Q900000102', 'Zqe Iron Comet II')))) like 'error:%',
  'a single match with two candidates is refused');
select ok(pg_temp.record('sub', pg_temp.id('claim1'), pg_temp.result('no_match', jsonb_build_array(pg_temp.cand('Q900000101', 'Zqe Iron Comet')))) like 'error:%',
  'no match with candidates is refused');
select is(pg_temp.record('sub', pg_temp.id('claim1'), pg_temp.result('ambiguous', jsonb_build_array(pg_temp.cand('Q900000101', 'Zqe Iron Comet'), pg_temp.cand('Q900000102', 'Zqe Tetsu no Suisei')))),
  'true', 'the server records two possible matches');
select is(((pg_temp.row('sub')).status), 'ambiguous', 'stored as ambiguous: nothing is chosen');
select is(pg_temp.record('sub', pg_temp.id('claim1'), pg_temp.result('no_match', '[]')), 'false', 'recording the same claim again does nothing');
select is(jsonb_array_length(pg_temp.claim('sub')), 0, 'a finished lookup isn''t claimed again');

-- 3. What editors see
create function pg_temp.facts(p_actor text, p_aal text default 'aal2') returns text language sql as $$
  select pg_temp.as_role(p_actor, format('select public.get_submission_enrichment(%L)::text', pg_temp.id('sub')), p_aal)
$$;
select is(jsonb_array_length(pg_temp.facts('e4')::jsonb -> 'candidates'), 2, 'an editor reads both candidates');
select is(pg_temp.facts('e4')::jsonb -> 'labels' ->> 'Q170420', 'Zqe Studio', 'with the developer''s name');
select is((select string_agg(e ->> 'external_id' || ' ' || (e ->> 'title'), ',') from jsonb_array_elements(pg_temp.facts('e4')::jsonb -> 'catalog_items') e),
  'Q900000101 Zqe Iron Comet', 'and the catalog game that already uses one of those Wikidata items');
select is((select string_agg((e ->> 'title') || ' ' || (e ->> 'via'), ',') from jsonb_array_elements(pg_temp.facts('e4')::jsonb -> 'title_matches') e),
  'Zqe Iron Comet source title', 'and the catalog game that has the submitted title among its source titles');
select ok(pg_temp.facts('e4', 'aal1') like 'error:%', 'an editor without a recent second factor is refused');
select ok(pg_temp.facts('c1') like 'error:%', 'the submitter can''t read the candidates or duplicates');
select ok(not has_function_privilege('anon', 'public.get_submission_enrichment(uuid)', 'execute'), 'anon has no execute privilege on it');
select is(pg_temp.as_role('e4', format('select public.get_submission_enrichment(%L)::text', gen_random_uuid())), '', 'no lookup for an unknown submission');

-- 4. What the submitter sees
select is(pg_temp.as_role('c1', format('select public.my_submission_enrichment(%L)::text', pg_temp.id('sub')))::jsonb,
  jsonb_build_object('status', 'ambiguous', 'found', true, 'retrieved_at', (pg_temp.row('sub')).retrieved_at), 'the submitter sees only the status');
select is(pg_temp.as_role('c2', format('select public.my_submission_enrichment(%L)::text', pg_temp.id('sub'))), '', 'another collector sees nothing');
select ok((select prosrc from pg_proc where oid = 'public.my_submission_enrichment(uuid)'::regprocedure) ~ 'session_is_live', 'and only from a live session (M11a)');

-- 5. Asking again, failures and back-off
select ok(pg_temp.as_role('c1', format('select public.request_submission_enrichment(%L)::text', pg_temp.id('sub'))) like 'error:%', 'a collector can''t ask for a new lookup');
select is(pg_temp.as_role('e4', format('select public.request_submission_enrichment(%L)::text', pg_temp.id('sub'))), 'true', 'an editor can');
select is((pg_temp.row('sub')).status || ' ' || jsonb_array_length((pg_temp.row('sub')).candidates), 'pending 2', 'it waits again, keeping the earlier answer until a new one arrives');
insert into ids select 'claim2', (pg_temp.claim('sub') -> 0 ->> 'claim_id')::uuid;
select is(pg_temp.record('sub', pg_temp.id('claim2'), pg_temp.result('failed', '[]')), 'true', 'Wikidata didn''t answer: recorded as failed');
select is(jsonb_array_length(pg_temp.claim('sub')), 0, 'a failed lookup waits before it is tried again');
update private.submission_enrichments set last_attempt_at = now() - interval '16 minutes' where submission_id = pg_temp.id('sub');
select is(jsonb_array_length(pg_temp.claim('sub')), 1, 'and is tried again 15 minutes later');
update private.submission_enrichments set attempts = 5, claim_id = null, claimed_at = null, last_attempt_at = now() - interval '1 hour' where submission_id = pg_temp.id('sub');
select is(jsonb_array_length(pg_temp.claim('sub')), 0, 'never more than 5 attempts, until an editor asks again');

-- 6. A changed title looks up again, and a late answer for the old title is dropped
update private.submission_enrichments set attempts = 0, last_attempt_at = null where submission_id = pg_temp.id('sub');
insert into ids select 'claim3', (pg_temp.claim('sub') -> 0 ->> 'claim_id')::uuid;
select is(pg_temp.as_role('c1', format('select public.update_my_submission(%L, %L)::text', pg_temp.id('sub'), '{"title": "Zqe Iron Comet Turbo"}')), 'true', 'the collector changes the title');
select is((pg_temp.row('sub')).status || ' ' || (pg_temp.row('sub')).attempts || ' ' || jsonb_array_length((pg_temp.row('sub')).candidates), 'pending 0 0', 'the lookup waits again, from scratch');
select is(pg_temp.record('sub', pg_temp.id('claim3'), pg_temp.result('no_match', '[]')), 'false', 'the answer for the old title is dropped');
select is(pg_temp.claim('sub') -> 0 ->> 'title', 'Zqe Iron Comet Turbo', 'the next lookup is for the new title');

-- 7. Nothing in the catalog changed
select is((select row(count(*), (select count(*) from public.releases), count(*) filter (where status = 'published'))::text from public.games),
  (select row(games + 1, releases + 1, published)::text from before_catalog), 'the lookups changed no catalog record: only the submission''s own game and release exist');

select * from finish();
rollback;
