-- PROPOSAL (M12c-B1, B1-M2): frozen review batches, risk-based validation, reproducible
-- sampling, human approval and audit (invariants B1 to B8). One rolled-back transaction.
begin;
create extension if not exists pgtap with schema extensions;
select plan(51);

create function pg_temp.claims(p_user uuid) returns jsonb language plpgsql as $mfa$
begin
  if exists (select 1 from auth.users where id = p_user) then
    insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      select p_user, p_user, 'test session factor', 'totp', 'verified', now(), now()
      where not exists (select 1 from auth.mfa_factors where id = p_user);
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
      values (gen_random_uuid(), p_user, 'totp', now(), now()) on conflict do nothing;
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user);
end $mfa$;
create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
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

insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['e1', 'e2', 'e3', 'c4']) as s;
update public.profiles set handle = 'bb_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['e1', 'e2', 'e3', 'c4']) as s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('e2'), 'catalog_editor'), (pg_temp.u('e3'), 'catalog_editor');

-- An import run with game candidates, as the importer leaves them: unpublished, unverified,
-- paired with the SNES, each with its source record (payload.source present; review_flags
-- carry the parser's flags).
create temp table runs (tag text primary key, id uuid);
create function pg_temp.run(p_tag text) returns uuid language sql stable as $$ select id from runs where tag = p_tag $$;
create function pg_temp.g(p_title text) returns uuid language sql stable as $$ select id from public.games where title = p_title $$;
create function pg_temp.make_run(p_tag text, p_games jsonb) returns uuid language plpgsql as $f$
declare
  v_run uuid;
  v_game uuid;
  v_record uuid;
  e jsonb;
  i integer := 0;
begin
  insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, status, finished_at, reason)
  values ('wikidata', (select id from public.platforms where slug = 'snes'), 'b1-test-' || p_tag, encode(digest(p_tag, 'sha256'), 'hex'), now(),
          encode(digest('terms', 'sha256'), 'hex'), 'completed', now(), 'B1 batch test')
  returning id into v_run;
  insert into runs values (p_tag, v_run);
  for e in select * from jsonb_array_elements(p_games) loop
    i := i + 1;
    insert into public.games (title, sort_title, kind, status, first_release_date, first_release_precision)
    values (e ->> 'title', e ->> 'title', 'game', 'under_review', (e ->> 'date')::date, coalesce(e ->> 'precision', case when e ? 'date' then 'day' else 'unknown' end)::public.date_precision)
    returning id into v_game;
    insert into public.game_platforms (game_id, platform_id, status) values (v_game, (select id from public.platforms where slug = 'snes'), 'under_review');
    insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
    values ('wikidata', 'game', 'Q9' || p_tag || i, jsonb_build_object('title', e ->> 'title', 'source', '{}'::jsonb, 'review_flags', coalesce(e -> 'flags', '[]')),
            encode(digest(p_tag || i, 'sha256'), 'hex'), v_run, 'promoted', v_game)
    returning id into v_record;
    insert into private.import_run_records (import_run_id, provider_record_id, position) values (v_run, v_record, i);
    insert into private.external_references (provider_code, external_id, game_id) values ('wikidata', 'Q9' || p_tag || i, v_game);
  end loop;
  return v_run;
end $f$;

select pg_temp.make_run('a', '[
  {"title": "Zqx Batch Undated"},
  {"title": "Zqx Batch Twin", "date": "1993-01-01"},
  {"title": "Zqx Batch Twin", "date": "1994-01-01"},
  {"title": "Zqx Batch Odd Kind", "date": "1995-01-01", "flags": ["other_instance_of"]},
  {"title": "Zqx Batch Clean One", "date": "1992-01-02"},
  {"title": "Zqx Batch Clean Two", "date": "1992-01-03"},
  {"title": "Zqx Batch Clean Three", "date": "1992-01-04"},
  {"title": "Zqx Batch Clean Four", "date": "1992-01-05"}]');

-- B2: the sample size is the exact hypergeometric plan for the actual lot.
select is(private.review_sample_size(1279, 0.02, 0.95, 0), 138, '1,279 unflagged, no errors allowed: 138');
select is(private.review_sample_size(1279, 0.02, 0.95, 1), 216, 'one error allowed: 216');
select is(private.review_sample_size(10000, 0.02, 0.95, 0), 148, '10,000 unflagged: 148');
select is(private.review_sample_size(4, 0.02, 0.95, 0), 4, 'a small lot is reviewed in full');
select is(private.review_critical_signal('distribution_format_unclassified'), 'physical_eligibility_unsupported',
  'an unclassified distribution format may mean the game isn''t eligible: a critical signal');

create temp table b (tag text primary key, id uuid);
create function pg_temp.b(p_tag text) returns uuid language sql stable as $$ select id from b where tag = p_tag $$;
insert into b values ('a', pg_temp.as_user('e1', format($$select public.create_review_batch(%L, (select id from public.platforms where slug = 'snes'), 'First batch')::text$$, pg_temp.run('a')))::uuid);
select ok(pg_temp.b('a') is not null, 'an editor creates a batch from the run');
select ok((select item_count = 8 and flagged_count = 4 and sample_size = 4 and required_approvals = 1 and content_sha256 ~ '^[0-9a-f]{64}$'
           from private.catalog_review_batches where id = pg_temp.b('a')), 'eight members, four flagged, the rest sampled, one approver');
select is((select flags from private.catalog_review_batch_items where batch_id = pg_temp.b('a') and game_id = pg_temp.g('Zqx Batch Undated')),
  '{no_release_date}'::text[], 'no date is flagged');
select is((select count(*)::integer from private.catalog_review_batch_items where batch_id = pg_temp.b('a') and 'title_collision_in_batch' = any (flags)), 2,
  'both twins are flagged as a collision');
select is((select critical_flags from private.catalog_review_batch_items where batch_id = pg_temp.b('a') and game_id = pg_temp.g('Zqx Batch Odd Kind')),
  '{wrong_identity_or_type}'::text[], 'a source flag that may be critical is marked');
select is((select count(*)::integer from private.catalog_review_batch_items where batch_id = pg_temp.b('a') and sampled), 4, 'only unflagged members are sampled');

-- B1: membership is frozen.
savepoint frozen;
select throws_ok(format($$update private.catalog_review_batch_items set flags = '{}' where batch_id = %L$$, pg_temp.b('a')),
  '23514', 'a batch''s membership is frozen', 'flags can''t be changed');
select throws_ok(format($$delete from private.catalog_review_batch_items where batch_id = %L$$, pg_temp.b('a')),
  '23514', 'review batches are kept', 'members can''t be removed');
rollback to savepoint frozen;

-- B3, B4: independence and completeness.
create function pg_temp.outcome(p_actor text, p_title text, p_outcome text, p_critical text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.record_batch_outcome(%L, %L, %L, %L, 'B1 test')::text$q$,
    pg_temp.b('a'), pg_temp.g(p_title), p_outcome, p_critical)) $$;
create function pg_temp.approve(p_actor text, p_batch uuid) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.approve_review_batch(%L, 'Reviewed')::text$q$, p_batch)) $$;
select is(pg_temp.approve('e2', pg_temp.b('a')), 'error: batch not reviewed', 'approval waits for every flagged and sampled outcome');
select is(pg_temp.outcome('e1', 'Zqx Batch Undated', 'correct', null), 'error: own record', 'the batch''s creator records no outcome');
select pg_temp.outcome('e2', t, 'correct', null)
from unnest(array['Zqx Batch Undated', 'Zqx Batch Clean One', 'Zqx Batch Clean Two', 'Zqx Batch Clean Three', 'Zqx Batch Clean Four']) t;
select is(pg_temp.as_user('e2', format($q$select public.record_batch_outcome(%L, %L, 'correct', null, 'one twin')::text$q$, pg_temp.b('a'),
  (select id from public.games where title = 'Zqx Batch Twin' order by first_release_date limit 1))), 'true', 'one twin is the game');
select is(pg_temp.as_user('e2', format($q$select public.record_batch_outcome(%L, %L, 'incorrect', 'conflicting_duplicate_identities', 'duplicate item')::text$q$, pg_temp.b('a'),
  (select id from public.games where title = 'Zqx Batch Twin' order by first_release_date desc limit 1))), 'true', 'the other is a duplicate: a critical error');
select is(pg_temp.outcome('e2', 'Zqx Batch Odd Kind', 'excluded', 'wrong_identity_or_type'), 'true', 'the odd kind is excluded, with its critical error');
select is(pg_temp.approve('e2', pg_temp.b('a')), 'error: critical errors unresolved', 'an unresolved critical error blocks approval');
select is(pg_temp.as_user('e2', format($q$select public.record_batch_outcome(%L, %L, 'excluded', null, 'left out')::text$q$, pg_temp.b('a'),
  (select id from public.games where title = 'Zqx Batch Twin' order by first_release_date desc limit 1))), 'error: outcome recorded',
  'a recorded critical error can''t be cleared (B9)');
select is(pg_temp.as_user('e2', format($q$select public.record_batch_outcome(%L, %L, 'excluded', 'conflicting_duplicate_identities', 'left out')::text$q$, pg_temp.b('a'),
  (select id from public.games where title = 'Zqx Batch Twin' order by first_release_date desc limit 1))), 'true', 'the duplicate is excluded from the batch');

-- B4: revision invalidation.
savepoint stale;
update public.games set summary = 'changed after freezing' where id = pg_temp.g('Zqx Batch Clean One');
select is(pg_temp.approve('e2', pg_temp.b('a')), 'error: batch stale', 'a member changed after freezing invalidates the batch');
rollback to savepoint stale;

select is(pg_temp.approve('e1', pg_temp.b('a')), 'error: own record', 'the batch''s creator can''t approve it');
select is(pg_temp.approve('e2', pg_temp.b('a')), '{"status": "approved", "published": 6}', 'an independent editor approves: six identities published');
select ok((select count(*) = 6 from public.games where title like 'Zqx Batch %' and status = 'published')
          and (select count(*) = 2 from public.games where title like 'Zqx Batch %' and status <> 'published'),
  'the excluded duplicate and odd kind stay unpublished');
select is((select count(*)::integer from public.releases r join public.games g on g.id = r.game_id where g.title like 'Zqx Batch %'), 0, 'no release is created (B7)');
select ok((select bool_and(gp.verification_basis ->> 'batch_id' = pg_temp.b('a')::text and gp.verified_game_revision = i.frozen_game_revision)
           from public.game_platforms gp join private.catalog_review_batch_items i on i.game_id = gp.game_id and i.batch_id = pg_temp.b('a')
           where gp.status = 'published'),
  'each published pairing records the batch and the revision it attests');
select ok((select metadata ->> 'published' = '6' and metadata ->> 'content_sha256' = (select content_sha256 from private.catalog_review_batches where id = pg_temp.b('a'))
           and metadata ? 'seed' and metadata ? 'sample_size' and actor_id = pg_temp.u('e2')
           from private.audit_events where action = 'catalog_batch_approved'), 'the approval''s audit row names the editor, content, seed, sample and result (B8)');
select is(pg_temp.outcome('e2', 'Zqx Batch Undated', 'incorrect', null), 'error: record unavailable', 'a decided batch takes no more outcomes');

-- B5: a failed sample is never accepted.
select pg_temp.make_run('f', '[{"title": "Zqx Fail One", "date": "1992-02-01"}, {"title": "Zqx Fail Two", "date": "1992-02-02"}]');
insert into b values ('f', pg_temp.as_user('e1', format($$select public.create_review_batch(%L, (select id from public.platforms where slug = 'snes'), 'Second batch')::text$$, pg_temp.run('f')))::uuid);
select pg_temp.as_user('e2', format($q$select public.record_batch_outcome(%L, %L, 'correct', null, null)::text$q$, pg_temp.b('f'), pg_temp.g('Zqx Fail One')));
select pg_temp.as_user('e2', format($q$select public.record_batch_outcome(%L, %L, 'incorrect', null, 'wrong date')::text$q$, pg_temp.b('f'), pg_temp.g('Zqx Fail Two')));
select is(pg_temp.approve('e2', pg_temp.b('f')), 'error: sample failed', 'an incorrect sampled member beyond the acceptance number fails the sample');
select is(pg_temp.as_user('e2', format($q$select public.reject_review_batch(%L, 'Sample failed')::text$q$, pg_temp.b('f'))), 'true', 'the batch is rejected');
select is(pg_temp.approve('e3', pg_temp.b('f')), 'error: record unavailable', 'and can never be approved afterwards');

-- B6: above the policy's size, a second, different approver.
update private.catalog_review_policy set second_approval_above = 1;
select pg_temp.make_run('s', '[{"title": "Zqx Pair One", "date": "1992-03-01"}, {"title": "Zqx Pair Two", "date": "1992-03-02"}]');
insert into b values ('s', pg_temp.as_user('e1', format($$select public.create_review_batch(%L, (select id from public.platforms where slug = 'snes'), 'Third batch')::text$$, pg_temp.run('s')))::uuid);
select pg_temp.as_user('e2', format($q$select public.record_batch_outcome(%L, %L, 'correct', null, null)::text$q$, pg_temp.b('s'), g)) from unnest(array[pg_temp.g('Zqx Pair One'), pg_temp.g('Zqx Pair Two')]) g;
select is(pg_temp.approve('e2', pg_temp.b('s')), '{"status": "awaiting_approval", "required": 2, "approvals": 1}', 'a large batch waits for a second approver');
select is(pg_temp.approve('e2', pg_temp.b('s')), 'error: already approved', 'the same editor can''t be the second approver (B6)');
select is(pg_temp.as_user('e3', format($q$select public.record_batch_outcome(%L, %L, 'excluded', null, 'late change')::text$q$, pg_temp.b('s'), pg_temp.g('Zqx Pair One'))),
  'error: batch approval started', 'once an approval is recorded, the findings can''t change (B9)');
select is(pg_temp.approve('e3', pg_temp.b('s')), '{"status": "approved", "published": 2}', 'a different editor completes the approval');


-- B9 to B11. A policy that samples part of a small lot: 45% tolerable error at 80% confidence
-- gives a sample of 2 for 6 unflagged members.
update private.catalog_review_policy set second_approval_above = 1000, tolerable_error = 0.45, confidence = 0.8;
create function pg_temp.sampled(p_tag text) returns uuid[] language sql stable as $$
  select array_agg(game_id order by game_id) from private.catalog_review_batch_items where batch_id = pg_temp.b(p_tag) and sampled $$;
create function pg_temp.outcome_in(p_actor text, p_tag text, p_game uuid, p_outcome text, p_critical text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.record_batch_outcome(%L, %L, %L, %L, null)::text$q$, pg_temp.b(p_tag), p_game, p_outcome, p_critical)) $$;
create function pg_temp.as_stale_actor(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated', 'aal', 'aal2', 'session_id', pg_temp.u(p_actor))::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;

-- B10: a withdrawn (excluded) pairing never joins a batch.
select pg_temp.make_run('p', '[{"title": "Zqx Lot One", "date": "1992-04-01"}, {"title": "Zqx Lot Two", "date": "1992-04-02"},
  {"title": "Zqx Lot Three", "date": "1992-04-03"}, {"title": "Zqx Lot Four", "date": "1992-04-04"}, {"title": "Zqx Lot Five", "date": "1992-04-05"},
  {"title": "Zqx Lot Six", "date": "1992-04-06"}, {"title": "Zqx Lot Withdrawn", "date": "1992-04-07"}]');
update public.game_platforms set status = 'excluded' where game_id = pg_temp.g('Zqx Lot Withdrawn');
insert into b values ('p', pg_temp.as_user('e1', format($$select public.create_review_batch(%L, (select id from public.platforms where slug = 'snes'), 'Lot batch')::text$$, pg_temp.run('p')))::uuid);
select ok((select item_count = 6 and flagged_count = 0 and sample_size = 2 from private.catalog_review_batches where id = pg_temp.b('p'))
          and not exists (select 1 from private.catalog_review_batch_items where batch_id = pg_temp.b('p') and game_id = pg_temp.g('Zqx Lot Withdrawn')),
  'the withdrawn pairing isn''t a member: six members, two sampled (B10)');

-- B9: findings only become more conservative, and a sampled member that isn't correct fails the sample.
select is(pg_temp.outcome_in('e2', 'p', (pg_temp.sampled('p'))[1], 'correct', null), 'true', 'the first sampled member is correct');
select is(pg_temp.outcome_in('e2', 'p', (pg_temp.sampled('p'))[2], 'incorrect', null), 'true', 'the second is incorrect');
select is(pg_temp.outcome_in('e2', 'p', (pg_temp.sampled('p'))[2], 'correct', null), 'error: outcome recorded', 'an incorrect finding can''t become correct (B9)');
select is(pg_temp.outcome_in('e2', 'p', (pg_temp.sampled('p'))[1], 'excluded', null), 'error: outcome recorded', 'nor can a recorded correct finding be changed (B9)');
select is(pg_temp.outcome_in('e2', 'p', (pg_temp.sampled('p'))[2], 'excluded', null), 'true', 'an incorrect member can still be excluded');
select is(pg_temp.approve('e2', pg_temp.b('p')), 'error: sample failed', 'an excluded sampled member is still a sample error (B4, B9)');

-- B4, B10, B11: a passing batch, its stale and unauthorized approvals, and its provenance.
select pg_temp.make_run('q', '[{"title": "Zqx Good One", "date": "1992-05-01"}, {"title": "Zqx Good Two", "date": "1992-05-02"},
  {"title": "Zqx Good Three", "date": "1992-05-03"}, {"title": "Zqx Good Four", "date": "1992-05-04"}, {"title": "Zqx Good Five", "date": "1992-05-05"},
  {"title": "Zqx Good Six", "date": "1992-05-06"}]');
insert into b values ('q', pg_temp.as_user('e1', format($$select public.create_review_batch(%L, (select id from public.platforms where slug = 'snes'), 'Good batch')::text$$, pg_temp.run('q')))::uuid);
select pg_temp.outcome_in('e2', 'q', g, 'correct', null) from unnest(pg_temp.sampled('q')) g;

savepoint withdrawn;
select ok(pg_temp.as_user('e3', format($q$select public.withdraw_game_platform(%L, (select id from public.platforms where slug = 'snes'), 'Not an SNES game', %s)::text$q$,
  (pg_temp.sampled('q'))[1], (select revision from public.games where id = (pg_temp.sampled('q'))[1]))) ~ '^[0-9a-f-]{36}$', 'another editor withdraws a member''s pairing');
select is(pg_temp.approve('e2', pg_temp.b('q')), 'error: batch stale', 'a member withdrawn after freezing makes the batch stale (B4, B10)');
rollback to savepoint withdrawn;

update auth.mfa_amr_claims set created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' where session_id = pg_temp.u('e2');
select is(pg_temp.as_stale_actor('e2', format($q$select public.approve_review_batch(%L, 'Reviewed')::text$q$, pg_temp.b('q'))), 'error: reauthentication required',
  'approval needs a recent verification (B4)');
update auth.mfa_amr_claims set created_at = now(), updated_at = now() where session_id = pg_temp.u('e2');
select is(pg_temp.approve('c4', pg_temp.b('q')), 'error: not permitted', 'a collector can''t approve a batch');
select is(pg_temp.approve('e2', pg_temp.b('q')), '{"status": "approved", "published": 6}', 'an independent editor approves it');
select ok((select bool_and(gp.verification_basis ->> 'physical_eligibility' = 'confirmed'
                           and gp.verification_basis ->> 'reference' = pr.external_id and gp.verification_basis ->> 'snapshot_sha256' = pr.payload_sha256)
           from private.catalog_review_batch_items i
           join public.game_platforms gp on gp.game_id = i.game_id and gp.platform_id = i.platform_id
           join private.provider_records pr on pr.id = i.provider_record_id
           where i.batch_id = pg_temp.b('q') and i.sampled),
  'a member a person found correct is confirmed, with its source record''s id and hash (B11)');
select ok((select count(*) = 4 and bool_and(gp.verification_basis ->> 'physical_eligibility' = 'batch_accepted')
           from private.catalog_review_batch_items i
           join public.game_platforms gp on gp.game_id = i.game_id and gp.platform_id = i.platform_id
           where i.batch_id = pg_temp.b('q') and not i.sampled),
  'an unsampled member is recorded as accepted with the batch, not as individually confirmed (B11)');
select is(pg_temp.approve('e3', pg_temp.b('q')), 'error: record unavailable', 'a decided batch can''t be approved again');

select * from finish();
rollback;
