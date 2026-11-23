-- PROPOSAL (M12c-B1, B1-M2): regression tests for the independent SQL review of 62267d6
-- (findings 2 to 7; finding 1, concurrency, needs two sessions and is tested by
-- tests/concurrency/b1_concurrency_check.mjs). One rolled-back transaction.
begin;
create extension if not exists pgtap with schema extensions;
select plan(45);

-- Sessions: aal2 with a recent TOTP verification, unless told otherwise.
create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.claims(p_user uuid, p_aal text) returns jsonb language plpgsql as $mfa$
begin
  insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    select p_user, p_user, 'test session factor', 'totp', 'verified', now(), now()
    where not exists (select 1 from auth.mfa_factors where id = p_user);
  if not exists (select 1 from auth.mfa_amr_claims where session_id = p_user) then
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at) values (gen_random_uuid(), p_user, 'totp', now(), now());
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

insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['e1', 'e2', 'e3']) as s;
update public.profiles set handle = 'bh_' || right(id::text, 2), handle_changed_at = now() where id in (select pg_temp.u(s) from unnest(array['e1', 'e2', 'e3']) as s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('e2'), 'catalog_editor'), (pg_temp.u('e3'), 'catalog_editor');

select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', encode(digest('terms', 'sha256'), 'hex'), 'B1 test clearance');
create function pg_temp.snes() returns uuid language sql stable as $$ select id from public.platforms where slug = 'snes' $$;
create function pg_temp.assessment(p_id text, p_snapshot text, p_flags jsonb) returns jsonb language sql stable as $f$
  select jsonb_build_object('contract', 'mgd-risk-assessment', 'version', 1, 'assessor', 'b1-test', 'assessor_version', '1',
    'source', jsonb_build_object('provider', 'wikidata', 'external_id', p_id, 'revision', 1, 'snapshot_sha256', p_snapshot),
    'flags', p_flags,
    'critical', coalesce((select jsonb_agg(distinct private.review_critical_signal(f)) from jsonb_array_elements_text(p_flags) f
                          where private.review_critical_signal(f) is not null), '[]'))
$f$;

-- A run, and members added to it: an existing game (by id) or a new one, with a payload whose
-- risk assessment can be replaced (p_assessment) to test the contract.
create temp table runs (tag text primary key, id uuid);
create temp table b (tag text primary key, id uuid);
create function pg_temp.run(p_tag text) returns uuid language sql stable as $$ select id from runs where tag = p_tag $$;
create function pg_temp.b(p_tag text) returns uuid language sql stable as $$ select id from b where tag = p_tag $$;
create function pg_temp.g(p_title text) returns uuid language sql stable as $$ select id from public.games where title = p_title $$;
create function pg_temp.new_run(p_tag text) returns uuid language plpgsql as $f$
declare v_run uuid;
begin
  insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, status, finished_at, reason)
  values ('wikidata', pg_temp.snes(), 'b1h-' || p_tag, encode(digest('h' || p_tag, 'sha256'), 'hex'), now(), encode(digest('terms', 'sha256'), 'hex'), 'completed', now(), 'B1 hardening test')
  returning id into v_run;
  insert into runs values (p_tag, v_run);
  return v_run;
end $f$;
create function pg_temp.add(p_tag text, p_title text, p_game uuid default null, p_flags jsonb default '[]', p_assessment jsonb default null,
                            p_payload_extra jsonb default '{}') returns uuid language plpgsql as $f$
declare
  v_game uuid := p_game;
  v_run uuid := pg_temp.run(p_tag);
  v_id text := 'Q8' || abs(hashtext(p_tag || p_title));
  v_record uuid;
  v_pos integer;
begin
  if v_game is null then
    insert into public.games (title, sort_title, kind, status, first_release_date, first_release_precision)
    values (p_title, p_title, 'game', 'under_review', '1993-03-03', 'day') returning id into v_game;
    insert into public.game_platforms (game_id, platform_id, status) values (v_game, pg_temp.snes(), 'under_review');
  end if;
  insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
  values ('wikidata', 'game', v_id,
          jsonb_build_object('title', p_title, 'source', '{}'::jsonb,
            'risk_assessment', coalesce(p_assessment, pg_temp.assessment(v_id, encode(digest('h' || p_tag, 'sha256'), 'hex'), p_flags))) || p_payload_extra,
          encode(digest(p_tag || p_title || coalesce(p_assessment::text, '') || p_payload_extra::text, 'sha256'), 'hex'), v_run, 'promoted', v_game)
  returning id into v_record;
  select coalesce(max(position), 0) + 1 into v_pos from private.import_run_records where import_run_id = v_run;
  insert into private.import_run_records (import_run_id, provider_record_id, position) values (v_run, v_record, v_pos);
  return v_game;
end $f$;
create function pg_temp.batch(p_tag text, p_actor text default 'e1') returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.create_review_batch(%L, %L, 'Hardening batch')::text$q$, pg_temp.run(p_tag), pg_temp.snes())) $$;
create function pg_temp.outcome(p_actor text, p_tag text, p_game uuid, p_outcome text, p_critical text, p_note text default null) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.record_batch_outcome(%L, %L, %L, %L, %L)::text$q$, pg_temp.b(p_tag), p_game, p_outcome, p_critical,
    -- M14c-1: a correct outcome carries the reviewer's evidence note unless a test gives its own.
    coalesce(p_note, case when p_outcome = 'correct' then 'Cartridge and box photographed; label checked against the listing' end))) $$;
create function pg_temp.approve(p_actor text, p_tag text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.approve_review_batch(%L, 'Reviewed')::text$q$, pg_temp.b(p_tag))) $$;

-- ---------------------------------------------------------------------------
-- Finding 2: no self-review of a member, with three independent editors.
-- ---------------------------------------------------------------------------
-- e3 creates one game (catalog record origin: staff, e3) and adds the SNES pairing of another
-- (pairing origin: staff, e3). e1 creates the batch; e2 is independent of everything.
select pg_temp.new_run('own');
insert into b values ('own-game', pg_temp.as_user('e3', $q$select public.create_game('Zqx Own Game', 'game', null, null, '1993-01-01', 'day', 'Created by e3')::text$q$)::uuid);
insert into public.game_platforms (game_id, platform_id, status) values (pg_temp.g('Zqx Own Game'), pg_temp.snes(), 'under_review');
insert into public.games (title, sort_title, kind, status, first_release_date, first_release_precision)
values ('Zqx Own Pairing', 'Zqx Own Pairing', 'game', 'under_review', '1993-01-02', 'day');
select pg_temp.as_user('e3', format($q$select public.set_game_platform(%L, %L, 'Paired by e3')::text$q$, pg_temp.g('Zqx Own Pairing'), pg_temp.snes()));
update public.game_platforms set status = 'under_review' where game_id = pg_temp.g('Zqx Own Pairing');
update public.games set status = 'under_review' where id = pg_temp.g('Zqx Own Game');
select pg_temp.add('own', 'Zqx Own Game', pg_temp.g('Zqx Own Game'), '["mul_label_only"]');
select pg_temp.add('own', 'Zqx Own Pairing', pg_temp.g('Zqx Own Pairing'), '["mul_label_only"]');
select ok(private.created_by(pg_temp.u('e3'), null, array[pg_temp.g('Zqx Own Game')])
          and private.pairing_created_by(pg_temp.u('e3'), pg_temp.g('Zqx Own Pairing'), pg_temp.snes())
          and not private.created_by(pg_temp.u('e3'), null, array[pg_temp.g('Zqx Own Pairing')]),
  'setup: e3 created one game, and only the pairing of the other');
insert into b values ('own', pg_temp.batch('own')::uuid);
select ok(pg_temp.b('own') is not null, 'e1 creates the batch');
select is(pg_temp.outcome('e3', 'own', pg_temp.g('Zqx Own Game'), 'correct', null), 'error: own record',
  'the creator of a member''s game can''t record its outcome, though someone else created the batch (B13)');
select is(pg_temp.outcome('e3', 'own', pg_temp.g('Zqx Own Pairing'), 'correct', null), 'error: own record',
  'nor can the creator of a member''s pairing (B13)');
select is(pg_temp.outcome('e3', 'own', pg_temp.g('Zqx Own Game'), 'excluded', null), 'error: own record', 'not even a conservative outcome');
select is(pg_temp.outcome('e2', 'own', pg_temp.g('Zqx Own Game'), 'correct', null), 'true', 'an independent editor records it');
select is(pg_temp.outcome('e2', 'own', pg_temp.g('Zqx Own Pairing'), 'correct', null), 'true', 'and the other');
select is(pg_temp.approve('e3', 'own'), 'error: own record', 'e3 can''t approve either');
select is(pg_temp.approve('e2', 'own'), '{"status": "approved", "published": 0, "awaiting_physical_evidence": 0, "awaiting_independent_publication": 2}', 'the independent editor approves; members they reviewed themselves await another editor''s publication (M14a)');

-- ---------------------------------------------------------------------------
-- Finding 3: an outcome needs aal2 and a recent verification.
-- ---------------------------------------------------------------------------
select pg_temp.new_run('mfa');
select pg_temp.add('mfa', 'Zqx Mfa One', null, '["mul_label_only"]');
insert into b values ('mfa', pg_temp.batch('mfa')::uuid);
select is(pg_temp.as_aal('e2', 'aal1', format($q$select public.record_batch_outcome(%L, %L, 'correct', null, null)::text$q$, pg_temp.b('mfa'), pg_temp.g('Zqx Mfa One'))),
  'error: not permitted', 'an aal1 session records no outcome');
update auth.mfa_amr_claims set created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' where session_id = pg_temp.u('e2');
select is(pg_temp.outcome('e2', 'mfa', pg_temp.g('Zqx Mfa One'), 'correct', null), 'error: reauthentication required',
  'an aal2 session without a recent verification records none (B13)');
update auth.mfa_amr_claims set created_at = now(), updated_at = now() where session_id = pg_temp.u('e2');
select is(pg_temp.outcome('e2', 'mfa', pg_temp.g('Zqx Mfa One'), 'correct', null), 'true', 'a recently verified aal2 session records it');

-- ---------------------------------------------------------------------------
-- Finding 4: a rejected cohort can't be resampled without a verifiable change.
-- ---------------------------------------------------------------------------
select pg_temp.new_run('shop');
select pg_temp.add('shop', 'Zqx Shop One');
select pg_temp.add('shop', 'Zqx Shop Two');
insert into b values ('shop', pg_temp.batch('shop')::uuid);
select pg_temp.outcome('e2', 'shop', g, case when n = 1 then 'incorrect' else 'correct' end, null) from (
  select game_id as g, row_number() over (order by game_id) as n from private.catalog_review_batch_items where batch_id = pg_temp.b('shop') and sampled) x;
select is(pg_temp.approve('e2', 'shop'), 'error: sample failed', 'the sample fails');
select is(pg_temp.as_user('e2', format($q$select public.reject_review_batch(%L, 'Sample failed')::text$q$, pg_temp.b('shop'))), 'true', 'the batch is rejected');
select is(pg_temp.batch('shop'), 'error: unchanged since rejection',
  'the same unchanged cohort can''t be batched again with a new seed (B14)');
update public.games set summary = 'Corrected after the failed sample' where id = pg_temp.g('Zqx Shop One');
insert into b values ('shop2', pg_temp.batch('shop')::uuid);
select ok((select item_count = 1 from private.catalog_review_batches where id = pg_temp.b('shop2'))
          and exists (select 1 from private.catalog_review_batch_items where batch_id = pg_temp.b('shop2') and game_id = pg_temp.g('Zqx Shop One')),
  'after an audited edit, only the changed member joins a new batch');
select is((select (metadata ->> 'unchanged_since_rejection')::integer from private.audit_events
           where action = 'catalog_batch_created' and metadata ->> 'batch_id' = pg_temp.b('shop2')::text), 1,
  'the unchanged member left out is recorded in the audit row');

-- ---------------------------------------------------------------------------
-- Finding 5: the risk-assessment contract.
-- ---------------------------------------------------------------------------
select is(private.review_flag_kind('other_instance_of'), 'exception', 'a parser exception flag is known');
select is(private.review_flag_kind('many_platforms'), 'info', 'an info flag is known');
select is(private.review_flag_kind('made_up_flag'), null, 'an unknown flag has no kind');
create function pg_temp.bad(p_tag text, p_assessment jsonb, p_extra jsonb default '{}') returns text language plpgsql as $f$
begin
  perform pg_temp.new_run(p_tag);
  perform pg_temp.add(p_tag, 'Zqx Risk ' || p_tag, null, '[]', p_assessment, p_extra);
  return pg_temp.batch(p_tag);
end $f$;
create function pg_temp.ok_assessment(p_tag text, p_flags jsonb default '[]') returns jsonb language sql stable as $$
  select pg_temp.assessment('Q8' || abs(hashtext(p_tag || 'Zqx Risk ' || p_tag)), encode(digest('h' || p_tag, 'sha256'), 'hex'), p_flags) $$;
select is(pg_temp.bad('r-missing', 'null'::jsonb), 'error: risk assessment invalid', 'a missing assessment refuses the batch (B15)');
select is(pg_temp.bad('r-version', pg_temp.ok_assessment('r-version') || '{"version": 2}'), 'error: risk assessment invalid', 'an unknown contract version');
select is(pg_temp.bad('r-unknown', pg_temp.ok_assessment('r-unknown', '["made_up_flag"]')), 'error: risk assessment invalid', 'an unknown flag');
select is(pg_temp.bad('r-omit', pg_temp.ok_assessment('r-omit') || '{"flags": ["other_instance_of"]}'), 'error: risk assessment invalid',
  'a critical flag whose critical signal was omitted');
select is(pg_temp.bad('r-flags', pg_temp.ok_assessment('r-flags') || '{"flags": "other_instance_of"}'), 'error: risk assessment invalid', 'malformed flags');
select is(pg_temp.bad('r-snap', pg_temp.ok_assessment('r-snap') || jsonb_build_object('source', jsonb_build_object('provider', 'wikidata',
  'external_id', 'Q8' || abs(hashtext('r-snap' || 'Zqx Risk r-snap')), 'revision', 1, 'snapshot_sha256', encode(digest('another snapshot', 'sha256'), 'hex')))),
  'error: risk assessment invalid', 'an assessment from another snapshot');
select is(pg_temp.bad('r-rev', pg_temp.ok_assessment('r-rev') || jsonb_build_object('source', jsonb_build_object('provider', 'wikidata',
  'external_id', 'Q8' || abs(hashtext('r-rev' || 'Zqx Risk r-rev')), 'snapshot_sha256', encode(digest('hr-rev', 'sha256'), 'hex')))),
  'error: risk assessment invalid', 'an assessment without the source revision');
select is(pg_temp.bad('r-detail', pg_temp.ok_assessment('r-detail'), '{"source": null}'), 'error: risk assessment invalid',
  'a record without full source detail');
select is((select private.review_risk_problems(pr) from private.provider_records pr where pr.import_run_id = pg_temp.run('r-omit')),
  array['critical signals don''t match the flags'], 'the validator names the problem');

-- Info flags are kept, and don't make a member flagged.
select pg_temp.new_run('info');
select pg_temp.add('info', 'Zqx Info One', null, '["many_platforms"]');
insert into b values ('info', pg_temp.batch('info')::uuid);
select ok((select flags = '{}' and info_flags = '{many_platforms}' and critical_flags = '{}' from private.catalog_review_batch_items where batch_id = pg_temp.b('info')),
  'an info flag is recorded apart from the review flags');

-- End to end: a critical parser flag stays blocking through staging (the M5b importer's own
-- functions), batch creation and approval. The payload below is the parser's output for the
-- fixture entity Q1005 (scripts/fixtures/wikidata-b1/entities-response.json) with
-- withRiskAssessment(); scripts/catalog-b1.test.mjs checks the two stay equal.
-- BEGIN parser-payload
create function pg_temp.parser_payload() returns jsonb language sql immutable as $j$ select $p${"title":"Zqx Copper Gate","titles":["Zqx Copper Gate"],"first_release_date":"1989-04-04","first_release_precision":"day","source":{"revision":2005,"label_language":"en","instance_of":["Q7889","Q999101"],"platforms":["Q183259"],"platform_first_release":{"value":"1989-04-04","precision":"day"},"release_dates":[{"value":"1989-04-04","precision":"day","platforms":["Q183259"],"places":[]}],"developers":[],"publishers":[],"genres":[],"distribution_formats":[],"distribution":[],"external_ids":{"igdb":[],"mobygames":[],"mobygames_former":[]}},"risk_assessment":{"contract":"mgd-risk-assessment","version":1,"assessor":"mgd-wikidata-entities","assessor_version":"1","source":{"provider":"wikidata","external_id":"Q1005","revision":2005,"snapshot_sha256":"5b1e2d0a3c4f69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"},"flags":["other_instance_of","platform_date_before_launch"],"critical":["wrong_identity_or_type","wrong_platform"]}}$p$::jsonb $j$;
-- END parser-payload
create temp table e2e (k text primary key, v text);
insert into e2e values ('run', catalog_import.start_run('wikidata', 'snes', 'b1-e2e-entities.json', '5b1e2d0a3c4f69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  now(), encode(digest('terms', 'sha256'), 'hex'), 'B1 end-to-end test', '00000000-0000-0000-0000-00000000e2e0')::text);
select catalog_import.stage_records((select v::uuid from e2e where k = 'run'), '00000000-0000-0000-0000-00000000e2e0',
  jsonb_build_array(jsonb_build_object('entity_type', 'game', 'external_id', 'Q1005', 'payload', pg_temp.parser_payload())), '{}');
select catalog_import.apply_record((select v::uuid from e2e where k = 'run'), '00000000-0000-0000-0000-00000000e2e0',
  (select id from private.provider_records where import_run_id = (select v::uuid from e2e where k = 'run')), '{}');
select catalog_import.finish_run((select v::uuid from e2e where k = 'run'), '00000000-0000-0000-0000-00000000e2e0', 'completed');
select ok((select status = 'promoted' and payload -> 'risk_assessment' = pg_temp.parser_payload() -> 'risk_assessment'
           from private.provider_records where import_run_id = (select v::uuid from e2e where k = 'run')),
  'staged through the importer, the record keeps the parser''s assessment verbatim');
insert into runs values ('e2e', (select v::uuid from e2e where k = 'run'));
insert into b values ('e2e', pg_temp.batch('e2e')::uuid);
select ok((select 'other_instance_of' = any (flags) and critical_flags = '{wrong_identity_or_type,wrong_platform}' and not sampled
           from private.catalog_review_batch_items where batch_id = pg_temp.b('e2e')),
  'in the batch, the member is flagged with its critical signal and never sampled');
select is(pg_temp.approve('e2', 'e2e'), 'error: batch not reviewed', 'approval waits for its individual outcome');
select is(pg_temp.outcome('e2', 'e2e', pg_temp.g('Zqx Copper Gate'), 'correct', null, 'looks fine'), 'error: evidence required',
  'overriding the critical signal without evidence is refused (B17)');
select is(pg_temp.outcome('e2', 'e2e', pg_temp.g('Zqx Copper Gate'), 'incorrect', 'wrong_identity_or_type', 'Typed as a compilation in the source'), 'true',
  'the reviewer confirms the critical error');
select is(pg_temp.approve('e2', 'e2e'), 'error: critical errors unresolved', 'and the critical error blocks approval');
select is((select count(*)::integer from public.games where title = 'Zqx Copper Gate' and status = 'published'), 0, 'nothing was published');

-- ---------------------------------------------------------------------------
-- Finding 6: the right to publish, rechecked at approval.
-- ---------------------------------------------------------------------------
select pg_temp.new_run('lic');
select pg_temp.add('lic', 'Zqx Licence One');
insert into b values ('lic', pg_temp.batch('lic')::uuid);
select pg_temp.outcome('e2', 'lic', game_id, 'correct', null) from private.catalog_review_batch_items where batch_id = pg_temp.b('lic') and sampled;
savepoint licence;
select private.record_provider_clearance('wikidata', false, null, null, 'Clearance withdrawn after staging');
select is(pg_temp.approve('e2', 'lic'), 'error: provider not cleared', 'clearance withdrawn between staging and approval stops it (B16)');
select pg_temp.new_run('lic2');
select pg_temp.add('lic2', 'Zqx Licence Two');
select is(pg_temp.batch('lic2', 'e3'), 'error: provider not cleared', 'and no new batch can be created from the source');
rollback to savepoint licence;
savepoint terms;
select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', encode(digest('new terms', 'sha256'), 'hex'), 'Cleared against new terms');
select is(pg_temp.approve('e2', 'lic'), 'error: provider not cleared', 'records imported under terms no longer cleared aren''t published');
rollback to savepoint terms;
select throws_ok($$select private.record_provider_rights('wikidata', true, encode(digest('other terms', 'sha256'), 'hex'), 'Not the cleared terms')$$,
  'P0001', 'terms not cleared', 'surviving rights are recorded only for the terms that are cleared');
select private.record_provider_rights('wikidata', true, encode(digest('terms', 'sha256'), 'hex'), 'CC0 1.0: the public-domain dedication is irrevocable');
select private.record_provider_clearance('wikidata', false, null, null, 'Partnership ended');
select is(pg_temp.approve('e3', 'lic'), '{"status": "approved", "published": 1, "awaiting_physical_evidence": 0, "awaiting_independent_publication": 0}',
  'rights recorded as surviving for those terms keep the records publishable after clearance ends');

-- ---------------------------------------------------------------------------
-- Item 7: RLS and the content hash.
-- ---------------------------------------------------------------------------
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'private' and c.relrowsecurity
             and c.relname in ('catalog_review_policy', 'catalog_review_batches', 'catalog_review_batch_items', 'catalog_review_batch_approvals',
                               'catalog_pairing_origins', 'catalog_pairing_withdrawals')), 6, 'RLS is enabled on the six new private tables');
select is((select count(*)::integer from pg_policies where schemaname = 'private'
           and tablename in ('catalog_review_policy', 'catalog_review_batches', 'catalog_review_batch_items', 'catalog_review_batch_approvals',
                             'catalog_pairing_origins', 'catalog_pairing_withdrawals')), 0, 'with no policies: no client role reaches them');
select is((select content_sha256 from private.catalog_review_batches where id = pg_temp.b('info')),
  (select encode(extensions.digest('mgd-review-batch:2|run:' || pg_temp.run('info')::text || '|platform:' || pg_temp.snes()::text || '|' ||
     string_agg(concat_ws(':', i.game_id::text, i.frozen_game_revision::text, 'under_review', pr.id::text, pr.payload_sha256,
       md5((pr.payload -> 'risk_assessment')::text), array_to_string(i.flags, ','), array_to_string(i.info_flags, ',')), '|' order by i.game_id), 'sha256'), 'hex')
   from private.catalog_review_batch_items i join private.provider_records pr on pr.id = i.provider_record_id where i.batch_id = pg_temp.b('info')),
  'the content hash covers run, platform, revision, pairing status, source record, payload, risk assessment and flags (B18)');

select * from finish();
rollback;
