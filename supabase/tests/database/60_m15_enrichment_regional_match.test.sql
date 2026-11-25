-- M15 submission enrichment, regional titles and an editor's confirmation: graded candidates
-- (one likely match is "single_match", with weaker ones beside it), the game's own view of its
-- lookup, catalog games found by the match's other titles, and decide_submission_enrichment:
-- editors only (with MFA and a reason), confirm stores the shown record as the game's Wikidata
-- source with audit, only while Wikidata is cleared, never over another game's source, and changes
-- nothing else; reject is audited. One rolled-back transaction, on a disposable local stack only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(50);

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
create function pg_temp.game(p text) returns uuid language sql stable as $$ select game_id from public.catalog_change_requests where id = pg_temp.id(p) $$;
create function pg_temp.claim(p_sub text) returns uuid language plpgsql as $$
begin
  perform pg_temp.as_role('service', format('select public.claim_submission_enrichments(%L, 1)::text', pg_temp.id(p_sub)));
  return (pg_temp.row(p_sub)).claim_id;
end $$;
create function pg_temp.record(p_sub text, p_result jsonb) returns text language sql as $$
  select pg_temp.as_role('service', format('select public.record_submission_enrichment(%L, %L, %L)::text', pg_temp.id(p_sub), pg_temp.claim(p_sub), p_result))
$$;
-- A graded candidate, as the server makes it (match.ts), with the importer's payload when p_payload.
create function pg_temp.cand(p_qid text, p_title text, p_titles jsonb, p_match text, p_likely boolean, p_payload boolean default true) returns jsonb language sql immutable as $$
  select jsonb_build_object('provider', 'wikidata', 'external_id', p_qid, 'url', 'https://www.wikidata.org/wiki/' || p_qid, 'revision', 2570591457, 'retrieved_at', '2026-11-25T10:00:00Z',
    'licence', 'Wikidata structured data, CC0 1.0', 'title', p_title, 'titles', p_titles, 'ja_titles', '[]'::jsonb, 'title_matches', p_match in ('exact', 'regional_title'),
    'match', p_match, 'matched_title', p_titles ->> 1, 'likely', p_likely,
    'release_dates', jsonb_build_array(jsonb_build_object('value', '1994-02-18', 'precision', 'day', 'places', jsonb_build_array('Q17')),
                                       jsonb_build_object('value', '1995-11-01', 'precision', 'month', 'places', jsonb_build_array('Q46'))),
    'developers', jsonb_build_array('Q1172213'), 'publishers', '[]'::jsonb, 'flags', '[]'::jsonb)
  || case when p_payload then jsonb_build_object('payload', jsonb_build_object('title', p_title, 'titles', p_titles, 'ja_titles', '[]'::jsonb,
       'first_release_date', '1994-02-18', 'first_release_precision', 'day',
       'source', jsonb_build_object('revision', 2570591457, 'developers', jsonb_build_array('Q1172213'), 'publishers', '[]'::jsonb, 'platforms', jsonb_build_array('Q183259'),
         'release_dates', jsonb_build_array(jsonb_build_object('value', '1995-11-01', 'precision', 'month', 'platforms', jsonb_build_array('Q183259'), 'places', jsonb_build_array('Q46'))))))
     else '{}'::jsonb end
$$;
create function pg_temp.result(p_status text, p_candidates jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('status', p_status, 'title', 'Zqf Caveman 3', 'platform', 'snes', 'retrieved_at', '2026-11-25T10:00:00Z',
    'candidates', p_candidates, 'labels', jsonb_build_object('Q1172213', 'Zqf East', 'Q46', 'Europe'))
$$;
create function pg_temp.decide(p_actor text, p_sub text, p_qid text, p_decision text, p_reason text default 'Same game: European title', p_aal text default 'aal2') returns text language sql as $$
  select pg_temp.as_role(p_actor, format('select public.decide_submission_enrichment(%L, %L, %L, %L)::text', pg_temp.id(p_sub), p_qid, p_decision, p_reason), p_aal)
$$;

-- c1: a collector. e4: a catalog editor.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000' from unnest(array['c1', 'e4']) s;
update public.profiles set handle = 'rgm_' || right(id::text, 2), handle_changed_at = now() where id in (pg_temp.u('c1'), pg_temp.u('e4'));
insert into public.staff_roles (user_id, role) values (pg_temp.u('e4'), 'catalog_editor');
update private.external_providers set commercial_use_cleared = false where code = 'wikidata';

-- An unpublished catalog game whose title is the likely match's main title, from another item.
with x as (insert into public.games (title, sort_title, kind) values ('Zqf Caveman 2: Lost', 'Zqf Caveman 2: Lost', 'game') returning id) insert into ids select 'catalog', id from x;
with x as (
  insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, finished_at)
  values ('wikidata', (select id from public.platforms where slug = 'snes'), 'zqf.json', repeat('e', 64), now(), 'completed', now()) returning id)
insert into ids select 'run', id from x;
insert into private.provider_records (provider_code, entity_type, external_id, payload, import_run_id, status, matched_game_id, payload_sha256)
values ('wikidata', 'game', 'Q900000201', jsonb_build_object('title', 'Zqf Caveman 2: Lost', 'titles', jsonb_build_array('Zqf Caveman 2: Lost')), pg_temp.id('run'), 'promoted', pg_temp.id('catalog'), repeat('6', 64));

-- 1. A PAL copy, typed without its subtitle
select ok(pg_temp.as_role('c1', $$select public.submit_game('Zqf Caveman 3', 'game', null, 'snes', 'rom-cartridge', 'pal', '{}', '[]', null, true)::text$$) like '%submitted%',
  'a collector submits "Zqf Caveman 3", PAL, shell not known');
insert into ids select 'sub', s.id from public.catalog_change_requests s where s.submitted_by = pg_temp.u('c1') and s.request_type = 'new_game' and s.details ->> 'title' = 'Zqf Caveman 3';
create temporary table before_game as select md5(row(g.*)::text) g, (select md5(row(r.*)::text) from public.releases r where r.game_id = g.id) r from public.games g where g.id = pg_temp.game('sub');
select is(pg_temp.as_role('service', format('select public.claim_submission_enrichments(%L, 1) -> 0 ->> %L', pg_temp.id('sub'), 'region')), 'pal', 'the claim gives the server the copy''s region');
update private.submission_enrichments set claim_id = null, claimed_at = null, attempts = 0 where submission_id = pg_temp.id('sub');

-- 2. Graded results
create temporary table c as select
  pg_temp.cand('Q900000301', 'Zqf Caveman 2: Lost', '["Zqf Caveman 2: Lost", "Zqf Caveman 3: Lost"]', 'main_title', true) likely,
  pg_temp.cand('Q900000302', 'Zqf Cave Story', '["Zqf Cave Story"]', 'partial', false) weak,
  pg_temp.cand('Q900000201', 'Zqf Caveman 2: Lost', '["Zqf Caveman 2: Lost", "Zqf Caveman 3: Lost"]', 'main_title', true) taken;
select ok(pg_temp.record('sub', pg_temp.result('single_match', jsonb_build_array((select likely from c), (select likely from c) || '{"external_id": "Q900000303"}'))) like 'error:%invalid enrichment%',
  'a single match with two likely candidates is refused');
select ok(pg_temp.record('sub', pg_temp.result('ambiguous', jsonb_build_array((select likely from c), (select weak from c)))) like 'error:%invalid enrichment%',
  'ambiguous with exactly one likely candidate is refused: that is a match');
select ok(pg_temp.record('sub', pg_temp.result('single_match', jsonb_build_array((select likely from c) || '{"match": "close"}'))) like 'error:%invalid enrichment%',
  'an unknown match kind is refused');
select ok(pg_temp.record('sub', pg_temp.result('single_match', jsonb_build_array(jsonb_set((select likely from c), '{payload,title}', '"Something else"')))) like 'error:%invalid enrichment%',
  'a stored record for another title is refused');
select is(pg_temp.record('sub', pg_temp.result('single_match', jsonb_build_array((select likely from c), (select weak from c)))), 'true',
  'one likely match with a weaker possibility is recorded as a single match');
select is((pg_temp.row('sub')).status, 'single_match', 'stored as a single match');

-- 3. What editors see, from the submission and from the game
create function pg_temp.facts(p_actor text, p_aal text default 'aal2') returns text language sql as $$
  select pg_temp.as_role(p_actor, format('select public.get_submission_enrichment(%L)::text', pg_temp.id('sub')), p_aal)
$$;
select is(pg_temp.facts('e4')::jsonb ->> 'region', 'pal', 'an editor reads the copy''s region');
select is((pg_temp.facts('e4')::jsonb ->> 'game_id')::uuid, pg_temp.game('sub'), 'and its game');
select ok(not exists (select 1 from jsonb_array_elements(pg_temp.facts('e4')::jsonb -> 'candidates') x where x ? 'payload'), 'candidates come without their stored record');
select is(pg_temp.facts('e4')::jsonb -> 'candidates' -> 0 -> 'release_dates' -> 1 ->> 'value', '1995-11-01', 'with their release dates by place');
select ok(pg_temp.facts('e4')::jsonb -> 'title_matches' @> jsonb_build_array(jsonb_build_object('game_id', pg_temp.id('catalog'), 'via_match', true)),
  'the unpublished catalog game with the match''s main title is found, through the match''s titles');
select is(pg_temp.facts('e4')::jsonb -> 'decisions', '{}'::jsonb, 'nothing is decided yet');
create function pg_temp.game_view(p_actor text) returns text language sql as $$
  select pg_temp.as_role(p_actor, format('select public.get_game_enrichment(%L)::text', pg_temp.game('sub')))
$$;
select is((pg_temp.game_view('e4')::jsonb ->> 'submission_id')::uuid, pg_temp.id('sub'), 'the game''s record reads the lookup of the submission that created it');
select ok(pg_temp.game_view('c1') like 'error:%', 'a collector can''t read it from the game');
select ok(pg_temp.game_view(null) like 'error:%', 'nor can anon');
select is(pg_temp.as_role('e4', format('select public.get_game_enrichment(%L)::text', pg_temp.id('catalog'))), '', 'a game no submission created has none');

-- 4. Who may decide
select ok(pg_temp.decide('c1', 'sub', 'Q900000301', 'confirm') like 'error:%', 'a collector can''t confirm a match');
select ok(pg_temp.decide(null, 'sub', 'Q900000301', 'confirm') like 'error:%', 'nor can anon');
select ok(pg_temp.decide('e4', 'sub', 'Q900000301', 'confirm', 'Same game', 'aal1') like 'error:%', 'nor an editor without MFA');
select ok(pg_temp.decide('e4', 'sub', 'Q900000301', 'confirm', '  ') like 'error:%reason required%', 'confirming needs the editor''s own reason');
select ok(pg_temp.decide('e4', 'sub', 'Q900000301', 'approve') like 'error:%invalid decision%', 'only confirm or reject');
select ok(pg_temp.decide('e4', 'sub', 'Q900000999', 'confirm') like 'error:%unknown candidate%', 'only a candidate of this lookup');
select ok(pg_temp.decide('e4', 'sub', 'Q900000301', 'confirm') like 'error:%source not cleared%', 'nothing is stored from Wikidata while it isn''t cleared for use');
update private.external_providers set terms_sha256 = repeat('a', 64), terms_reviewed_at = now(), cleared_note = 'Test clearance (rolled back)', commercial_use_cleared = true where code = 'wikidata';

-- 5. Confirming
select is(pg_temp.decide('e4', 'sub', 'Q900000301', 'confirm')::jsonb ->> 'decision', 'confirmed', 'an editor confirms the likely match');
select is((select count(*)::int from private.external_references where provider_code = 'wikidata' and external_id = 'Q900000301' and game_id = pg_temp.game('sub')), 1,
  'the game is linked to the Wikidata item');
select is((select payload from private.provider_records where external_id = 'Q900000301' and matched_game_id = pg_temp.game('sub') and status = 'promoted'),
  (select likely -> 'payload' from c), 'its source record is exactly the record the editor was shown');
select ok((select ir.source_name like 'submission-lookup:' || pg_temp.id('sub') || ':Q900000301' and ir.status = 'completed' and ir.reason = 'Same game: European title'
           from private.provider_records pr join private.import_runs ir on ir.id = pr.import_run_id where pr.external_id = 'Q900000301'),
  'with an import run naming the submission, and the editor''s reason');
select ok(exists (select 1 from private.game_title_keys k where k.game_id = pg_temp.game('sub') and k.origin = 'source' and k.title_key = private.import_title_key('Zqf Caveman 3: Lost')),
  'its titles become the game''s title keys');
select ok(exists (select 1 from private.audit_events a where a.action = 'catalog_source_confirmed' and a.actor_id = pg_temp.u('e4') and a.metadata ->> 'entity' = 'game'
                  and (a.metadata ->> 'id')::uuid = pg_temp.game('sub') and a.metadata ->> 'external_id' = 'Q900000301' and a.reason = 'Same game: European title'),
  'the confirmation is audited on the game');
select is(pg_temp.as_role('e4', format('select public.get_game_source_facts(%L) -> %L -> 0 ->> %L', pg_temp.game('sub'), 'sources', 'external_id')), 'Q900000301',
  'the game''s record now shows it as its source');
select ok((select g = md5(row(x.*)::text) from before_game, public.games x where x.id = pg_temp.game('sub')), 'the game itself is unchanged: title, status, verification');
select ok((select r = (select md5(row(y.*)::text) from public.releases y where y.game_id = pg_temp.game('sub')) from before_game), 'and its release is unchanged');
select is((select status::text from public.catalog_change_requests where id = pg_temp.id('sub')), 'open', 'the submission still waits for its review');
select is((select (pg_temp.game_view('e4')::jsonb -> 'decisions' -> 'Q900000301') - 'at'), '{"decision": "confirmed"}'::jsonb, 'the decision is shown, never who made it');
select is(pg_temp.game_view('e4')::jsonb ->> 'linked_external_id', 'Q900000301', 'and the game''s link');

-- 6. After a confirmation; rejecting
select ok(pg_temp.decide('e4', 'sub', 'Q900000301', 'confirm') like 'error:%already decided%', 'a match is decided once');
select ok(pg_temp.decide('e4', 'sub', 'Q900000302', 'confirm') like 'error:%already decided%', 'and only one is confirmed');
select is(pg_temp.decide('e4', 'sub', 'Q900000302', 'reject', 'A different game')::jsonb ->> 'decision', 'rejected', 'the weaker possibility is rejected');
select ok(exists (select 1 from private.audit_events a where a.action = 'catalog_source_rejected' and a.metadata ->> 'external_id' = 'Q900000302' and a.reason = 'A different game'),
  'the rejection is audited');
select is((select count(*)::int from private.provider_records where external_id = 'Q900000302'), 0, 'a rejected match stores nothing');

-- 7. Another game's item; a lookup from before this migration
select ok(pg_temp.as_role('c1', $$select public.submit_game('Zqf Caveman Again', 'game', null, 'snes', 'rom-cartridge', 'pal', '{}', '[]', null, true)::text$$) like '%submitted%', 'a second submission');
insert into ids select 'sub2', s.id from public.catalog_change_requests s where s.submitted_by = pg_temp.u('c1') and s.details ->> 'title' = 'Zqf Caveman Again';
select is(pg_temp.record('sub2', pg_temp.result('single_match', jsonb_build_array((select taken from c)))), 'true', 'its likely match is the catalog game''s own item');
select ok(pg_temp.decide('e4', 'sub2', 'Q900000201', 'confirm') like 'error:%already the source of another game%', 'it can''t become a second game''s source: merge them instead');
select ok(pg_temp.as_role('c1', $$select public.submit_game('Zqf Caveman Legacy', 'game', null, 'snes', 'rom-cartridge', 'pal', '{}', '[]', null, true)::text$$) like '%submitted%', 'a third submission');
insert into ids select 'sub3', s.id from public.catalog_change_requests s where s.submitted_by = pg_temp.u('c1') and s.details ->> 'title' = 'Zqf Caveman Legacy';
select is(pg_temp.record('sub3', pg_temp.result('single_match', jsonb_build_array(pg_temp.cand('Q900000304', 'Zqf Caveman Legacy', '["Zqf Caveman Legacy"]', 'exact', true, false) - 'likely' - 'match' - 'matched_title' - 'release_dates'))),
  'true', 'a result in the earlier shape (one candidate, ungraded) is still accepted');
select ok(pg_temp.decide('e4', 'sub3', 'Q900000304', 'confirm') like 'error:%look up again%', 'but a candidate without its stored record must be looked up again first');

-- 8. A changed title forgets the old candidates' decisions, not the confirmation
update public.catalog_change_requests set details = details || '{"title": "Zqf Caveman Three"}' where id = pg_temp.id('sub');
select is((pg_temp.row('sub')).decisions - 'Q900000301', '{}'::jsonb, 'a changed title drops the rejection');
select ok((pg_temp.row('sub')).decisions ? 'Q900000301', 'and keeps the confirmation: the game keeps its source');

select * from finish();
rollback;
