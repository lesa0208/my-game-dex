-- M14c-1: physical-evidence notes are mandatory, travel into the pairing's verification basis,
-- and are readable only by catalog staff (20261211100000_m14c1_physical_evidence_notes).
-- One rolled-back transaction, with the B1 tests' staff session and batch harness. No
-- savepoints: a rollback to one would also undo pgTAP's record of a failure inside it.
begin;
create extension if not exists pgtap with schema extensions;
select plan(84);

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
-- Runs a change and reads a probe, then undoes the change by raising inside its own block (not a
-- savepoint the test controls), so a failed assertion is never undone with it.
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

-- Synthetic accounts, for this transaction only: e1 creates the batches (editor A), e2 reviews
-- (editor B), e3 is a third editor, c4 a collector with no staff role.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['e1', 'e2', 'e3', 'c4']) as s;
update public.profiles set handle = 'ev_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['e1', 'e2', 'e3', 'c4']) as s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('e2'), 'catalog_editor'), (pg_temp.u('e3'), 'catalog_editor');

-- Import runs as the B1 importer leaves them (test 50's fixture): unpublished games paired with
-- the SNES, each with its cleared Wikidata record.
select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', encode(digest('terms', 'sha256'), 'hex'), 'M14c-1 test clearance');
create temp table runs (tag text primary key, id uuid);
create temp table b (tag text primary key, id uuid);
create function pg_temp.run(p_tag text) returns uuid language sql stable as $$ select id from runs where tag = p_tag $$;
create function pg_temp.b(p_tag text) returns uuid language sql stable as $$ select id from b where tag = p_tag $$;
create function pg_temp.g(p_title text) returns uuid language sql stable as $$ select id from public.games where title = p_title $$;
create function pg_temp.snes() returns uuid language sql stable as $$ select id from public.platforms where slug = 'snes' $$;
create function pg_temp.make_run(p_tag text, p_titles text[]) returns uuid language plpgsql as $f$
declare
  v_run uuid;
  v_game uuid;
  v_record uuid;
  t text;
  i integer := 0;
begin
  insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, status, finished_at, reason)
  values ('wikidata', pg_temp.snes(), 'm14c1-test-' || p_tag, encode(digest(p_tag, 'sha256'), 'hex'), now(),
          encode(digest('terms', 'sha256'), 'hex'), 'completed', now(), 'M14c-1 test')
  returning id into v_run;
  insert into runs values (p_tag, v_run);
  foreach t in array p_titles loop
    i := i + 1;
    insert into public.games (title, sort_title, kind, status, first_release_date, first_release_precision)
    values (t, t, 'game', 'under_review', ('1993-01-01'::date + i), 'day') returning id into v_game;
    insert into public.game_platforms (game_id, platform_id, status) values (v_game, pg_temp.snes(), 'under_review');
    insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
    values ('wikidata', 'game', 'Q8' || p_tag || i,
            jsonb_build_object('title', t, 'source', '{}'::jsonb, 'risk_assessment', jsonb_build_object('contract', 'mgd-risk-assessment', 'version', 1,
              'assessor', 'm14c1-test', 'assessor_version', '1',
              'source', jsonb_build_object('provider', 'wikidata', 'external_id', 'Q8' || p_tag || i, 'revision', 1, 'snapshot_sha256', encode(digest(p_tag, 'sha256'), 'hex')),
              'flags', '[]'::jsonb, 'critical', '[]'::jsonb)),
            encode(digest(p_tag || i, 'sha256'), 'hex'), v_run, 'promoted', v_game)
    returning id into v_record;
    insert into private.import_run_records (import_run_id, provider_record_id, position) values (v_run, v_record, i);
    insert into private.external_references (provider_code, external_id, game_id) values ('wikidata', 'Q8' || p_tag || i, v_game);
  end loop;
  return v_run;
end $f$;
create function pg_temp.outcome(p_actor text, p_tag text, p_game uuid, p_outcome text, p_note text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.record_batch_outcome(%L, %L, %L, null, %L)::text$q$, pg_temp.b(p_tag), p_game, p_outcome, p_note)) $$;
create function pg_temp.approve(p_actor text, p_tag text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.approve_review_batch(%L, 'Reviewed with evidence')::text$q$, pg_temp.b(p_tag))) $$;
create function pg_temp.evidence(p_actor text, p_game uuid) returns jsonb language sql as $$
  select case when r like '{%' then r::jsonb else jsonb_build_object('error', r) end
  from pg_temp.as_user(p_actor, format('select public.get_game_pairing_evidence(%L)::text', p_game)) r $$;
create function pg_temp.pairing(p_actor text, p_game uuid) returns jsonb language sql as $$
  select e from jsonb_array_elements(pg_temp.evidence(p_actor, p_game) -> 'pairings') e where e -> 'platform' ->> 'slug' = 'snes' $$;

-- ---------------------------------------------------------------------------
-- What counts as an evidence note.
-- ---------------------------------------------------------------------------
select is(private.evidence_note_ok(null), false, 'no note is no evidence');
select is(private.evidence_note_ok(''), false, 'an empty note is no evidence');
select is(private.evidence_note_ok('                         '), false, 'nor is one of spaces only');
select is(private.evidence_note_ok(E'\t\n  \r\n\t   \n\t\t  \n'), false, 'nor one of tabs and line breaks');
select is(private.evidence_note_ok('Cartridge photo ok.'), false, 'nineteen characters are too few');
select is(private.evidence_note_ok('Cartridge photo seen'), true, 'twenty characters are enough');
select is(private.evidence_note_ok('     Cartridge photo s     '), false, 'surrounding whitespace doesn''t count toward the twenty');
select is(private.evidence_note_ok('Box' || repeat(' ', 30) || 'seen'), false, 'nor does whitespace padding between words');
select is(private.evidence_note_ok(repeat('.', 40)), false, 'nor punctuation: at least ten letters or digits');
select is(private.evidence_note_ok(repeat('Cartridge ', 50)), true, 'five hundred characters fit');
select is(private.evidence_note_ok(repeat('Cartridge ', 50) || 'x'), false, 'five hundred and one don''t: a basis note holds 500');
select is(private.evidence_note_ok(E'Cartridge and box\nphotographed, both sides'), true, 'a note over several lines is evidence');

-- ---------------------------------------------------------------------------
-- Negative outcomes keep their rules: a note is optional, and may be up to 1,000 characters.
-- ---------------------------------------------------------------------------
-- Small lots under the default policy are reviewed in full.
select pg_temp.make_run('n', array['Zqm Neg One', 'Zqm Neg Two', 'Zqm Neg Three']);
insert into b values ('n', pg_temp.as_user('e1', format($$select public.create_review_batch(%L, %L, 'Negative outcomes')::text$$, pg_temp.run('n'), pg_temp.snes()))::uuid);
select is(pg_temp.outcome('e2', 'n', pg_temp.g('Zqm Neg One'), 'incorrect', null), 'true', 'an incorrect outcome needs no note');
select is(pg_temp.outcome('e2', 'n', pg_temp.g('Zqm Neg Two'), 'excluded', null), 'true', 'nor does an excluded one');
select is(pg_temp.outcome('e2', 'n', pg_temp.g('Zqm Neg Three'), 'incorrect', repeat('Wrong date. ', 75)), 'true', 'and a negative note may be up to 1,000 characters');
select ok((select bool_and(gp.verified_at is null and gp.verification_basis is null and gp.status = 'under_review')
           from public.game_platforms gp where gp.game_id in (pg_temp.g('Zqm Neg One'), pg_temp.g('Zqm Neg Two'), pg_temp.g('Zqm Neg Three'))),
  'negative outcomes verify nothing');

-- ---------------------------------------------------------------------------
-- An outcome recorded before the rule, found correct without evidence, holds its batch.
-- ---------------------------------------------------------------------------
select pg_temp.make_run('l', array['Zqm Legacy One']);
insert into b values ('l', pg_temp.as_user('e1', format($$select public.create_review_batch(%L, %L, 'Recorded before M14c-1')::text$$, pg_temp.run('l'), pg_temp.snes()))::uuid);
-- As the B1 stack's open batch has them: written by the earlier record_batch_outcome, no note.
update private.catalog_review_batch_items set outcome = 'correct', reviewed_by = pg_temp.u('e2'), note = null, recorded_at = now()
where batch_id = pg_temp.b('l');
select is(pg_temp.approve('e3', 'l'), 'error: evidence required', 'a batch with a correct outcome that carries no evidence can''t be approved');
select ok((select g.verified_at is null and g.status = 'under_review' and gp.verified_at is null and gp.status = 'under_review'
           from public.games g join public.game_platforms gp on gp.game_id = g.id where g.id = pg_temp.g('Zqm Legacy One')),
  'and nothing of its member is verified or published');

-- ---------------------------------------------------------------------------
-- Positive outcomes need evidence. A policy that samples part of a small lot (test 50's).
-- ---------------------------------------------------------------------------
update private.catalog_review_policy set tolerable_error = 0.45, confidence = 0.8;
select pg_temp.make_run('p', array['Zqm Lot One', 'Zqm Lot Two', 'Zqm Lot Three', 'Zqm Lot Four', 'Zqm Lot Five', 'Zqm Lot Six']);
insert into b values ('p', pg_temp.as_user('e1', format($$select public.create_review_batch(%L, %L, 'Positive outcomes')::text$$, pg_temp.run('p'), pg_temp.snes()))::uuid);
create temp table s as select game_id, row_number() over (order by game_id) as n from private.catalog_review_batch_items where batch_id = pg_temp.b('p') and sampled;
create temp table un as select game_id, row_number() over (order by game_id) as n from private.catalog_review_batch_items where batch_id = pg_temp.b('p') and not sampled;
create function pg_temp.s(p_n integer) returns uuid language sql stable as $$ select game_id from s where n = p_n $$;
create function pg_temp.un(p_n integer) returns uuid language sql stable as $$ select game_id from un where n = p_n $$;
select ok((select count(*) from s) between 1 and 4 and (select count(*) from un) >= 2, 'the batch samples some members and leaves at least two unsampled');

select is(pg_temp.outcome('e2', 'p', pg_temp.s(1), 'correct', null), 'error: evidence required', 'a correct outcome without a note is refused');
select is(pg_temp.outcome('e2', 'p', pg_temp.s(1), 'correct', ''), 'error: evidence required', 'with an empty note');
select is(pg_temp.outcome('e2', 'p', pg_temp.s(1), 'correct', E'   \t  \n   '), 'error: evidence required', 'with a whitespace-only note');
select is(pg_temp.outcome('e2', 'p', pg_temp.s(1), 'correct', 'Looks right'), 'error: evidence required', 'with a note under twenty characters');
select is(pg_temp.outcome('e2', 'p', pg_temp.s(1), 'correct', 'Box' || repeat(' ', 25) || 'ok'), 'error: evidence required', 'with a note padded with spaces');
select is(pg_temp.outcome('e2', 'p', pg_temp.s(1), 'correct', repeat('Cartridge ', 50) || 'x'), 'error: invalid changes',
  'with a note over 500 characters, which the pairing''s basis couldn''t hold');
select ok((select outcome is null and note is null and reviewed_by is null from private.catalog_review_batch_items where batch_id = pg_temp.b('p') and game_id = pg_temp.s(1)),
  'a refused outcome records nothing');
select is(pg_temp.outcome('e2', 'p', pg_temp.s(1), 'correct', '  Cartridge and box photographed; label matches the SNES listing  '), 'true',
  'a correct outcome with the reviewer''s evidence is recorded');
select is((select note from private.catalog_review_batch_items where batch_id = pg_temp.b('p') and game_id = pg_temp.s(1)),
  'Cartridge and box photographed; label matches the SNES listing', 'the note is kept with the outcome, trimmed');
select ok((select e.metadata ->> 'note' = 'Cartridge and box photographed; label matches the SNES listing' and e.actor_id = pg_temp.u('e2')
           from private.audit_events e where e.action = 'catalog_batch_outcome_recorded' and e.metadata ->> 'game_id' = pg_temp.s(1)::text),
  'and audited with the outcome');
select is(pg_temp.approve('e3', 'p'), 'error: batch not reviewed', 'every sampled member still needs its outcome');
select pg_temp.outcome('e2', 'p', game_id, 'correct', 'Manual and cartridge photographed; PCB checked') from s where n > 1;

-- ---------------------------------------------------------------------------
-- Approval carries each reviewer's note into the pairing's basis.
-- ---------------------------------------------------------------------------
-- A third editor approves (the reviewer-approves path is M14a's, tested in 50).
select is(pg_temp.approve('e3', 'p'),
  format('{"status": "approved", "published": %s, "awaiting_physical_evidence": %s, "awaiting_independent_publication": 0}', (select count(*) from s), (select count(*) from un)),
  'an independent editor approves: each confirmed member is published, the unsampled ones await evidence');
select ok((select bool_and(gp.verification_basis = jsonb_build_object('source', 'wikidata', 'reference', pr.external_id, 'snapshot_sha256', pr.payload_sha256,
             'physical_eligibility', 'confirmed', 'batch_id', pg_temp.b('p')::text, 'note', i.note))
           from s join private.catalog_review_batch_items i on i.batch_id = pg_temp.b('p') and i.game_id = s.game_id
           join private.provider_records pr on pr.id = i.provider_record_id
           join public.game_platforms gp on gp.game_id = s.game_id and gp.platform_id = i.platform_id),
  'each confirmed pairing''s basis names the record checked, its snapshot, the batch, confirmed eligibility and the reviewer''s own note');
select ok((select bool_and(gp.verification_basis ->> 'note' = 'Cartridge and box photographed; label matches the SNES listing')
           from public.game_platforms gp where gp.game_id = pg_temp.s(1)),
  'the note in the basis is the one the reviewer wrote, nothing generated');
select ok((select bool_and(gp.verified_by = pg_temp.u('e2') and gp.verified_game_revision = i.frozen_game_revision)
           from s join private.catalog_review_batch_items i on i.batch_id = pg_temp.b('p') and i.game_id = s.game_id
           join public.game_platforms gp on gp.game_id = s.game_id),
  'recorded as verified by the reviewer who confirmed the evidence, at the revision they reviewed');
select ok((select count(*) = (select count(*) from s) and bool_and(e.metadata -> 'basis' = (select gp.verification_basis from public.game_platforms gp where gp.game_id = (e.metadata ->> 'id')::uuid and gp.platform_id = (e.metadata ->> 'platform_id')::uuid) and e.metadata ->> 'confirmed_by' = pg_temp.u('e2')::text)
           from private.audit_events e where e.action = 'catalog_record_verified' and e.metadata ->> 'entity' = 'game_platform'
             and e.metadata ->> 'batch_id' = pg_temp.b('p')::text),
  'each pairing''s verification is audited with its whole basis');
select ok((select bool_and(g.verified_at is not null and g.status = 'under_review' and gp.verified_at is null and gp.verification_basis is null and gp.status = 'under_review')
           from un join public.games g on g.id = un.game_id join public.game_platforms gp on gp.game_id = un.game_id),
  'unsampled members get a verified identity and nothing else: their pairings stay unverified and unpublished');
select is(pg_temp.as_anon(format($$select count(*)::text from public.games where id = any (%L::uuid[])$$, (select array_agg(game_id) from un))), '0',
  'and no visitor can see them');
select is((select count(*)::integer from public.releases where game_id in (select game_id from s union all select game_id from un)), 0,
  'approval creates no physical release: an identity is not a release');

-- ---------------------------------------------------------------------------
-- The individual path: verify_game_platform needs the same evidence.
-- ---------------------------------------------------------------------------
create function pg_temp.verify(p_actor text, p_game uuid, p_basis jsonb) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.verify_game_platform(%L, %L, %L::jsonb, 'Checked a copy', %s)::text$q$,
    p_game, pg_temp.snes(), p_basis, (select revision from public.games where id = p_game))) $$;
select is(pg_temp.verify('e2', pg_temp.un(1), '{"source": "editor", "reference": "Collector photo set", "physical_eligibility": "confirmed"}'),
  'error: invalid changes', 'a basis without a note is refused');
select is(pg_temp.verify('e2', pg_temp.un(1), '{"source": "editor", "reference": "Collector photo set", "physical_eligibility": "confirmed", "note": "Seen it"}'),
  'error: invalid changes', 'as is one with a note under twenty characters');
select is(pg_temp.verify('e2', pg_temp.un(1), '{"source": "editor", "reference": "Collector photo set", "physical_eligibility": "confirmed", "note": 12345678901234567890}'),
  'error: invalid changes', 'and one whose note isn''t text');
select is(pg_temp.verify('e2', pg_temp.un(1), '{"source": "editor", "reference": "Collector photo set", "physical_eligibility": "assumed", "note": "Cartridge, box and manual photographed"}'),
  'error: invalid changes', 'a note doesn''t replace confirmed eligibility');
select is(pg_temp.verify('e2', pg_temp.un(1), '{"source": "editor", "reference": "Collector photo set", "physical_eligibility": "confirmed", "note": "Cartridge, box and manual photographed"}'),
  'true', 'with the editor''s evidence, the pairing is verified');
select is((select verification_basis ->> 'note' from public.game_platforms where game_id = pg_temp.un(1)), 'Cartridge, box and manual photographed', 'and its basis keeps the note');

-- ---------------------------------------------------------------------------
-- The table itself refuses a basis without evidence, whoever writes it.
-- ---------------------------------------------------------------------------
select throws_ok(format($$update public.game_platforms set verified_at = now(), verified_by = %L, verified_game_revision = 1,
    verification_basis = '{"source": "editor", "reference": "Photo", "physical_eligibility": "confirmed"}' where game_id = %L$$, pg_temp.u('e2'), pg_temp.un(2)),
  '23514', 'new row for relation "game_platforms" violates check constraint "game_platforms_physical_evidence_note"', 'a confirmed basis with no note can''t be stored');
select throws_ok(format($$update public.game_platforms set verified_at = now(), verified_by = %L, verified_game_revision = 1,
    verification_basis = '{"source": "editor", "reference": "Photo", "physical_eligibility": "confirmed", "note": "   "}' where game_id = %L$$, pg_temp.u('e2'), pg_temp.un(2)),
  '23514', 'new row for relation "game_platforms" violates check constraint "game_platforms_physical_evidence_note"', 'nor one with a blank note');
select throws_ok(format($$update public.game_platforms set verified_at = now(), verified_by = %L, verified_game_revision = 1,
    verification_basis = '{"source": "editor", "reference": "Photo", "physical_eligibility": "confirmed", "note": null}' where game_id = %L$$, pg_temp.u('e2'), pg_temp.un(2)),
  '23514', 'new row for relation "game_platforms" violates check constraint "game_platforms_physical_evidence_note"', 'nor one whose note is JSON null');
select is(pg_temp.then_undo(format($$update public.game_platforms set verified_at = now(), verified_by = %L, verified_game_revision = 1,
    verification_basis = '{"source": "editor", "reference": "Photo", "physical_eligibility": "confirmed", "note": "Cartridge and box photographed"}' where game_id = %L$$, pg_temp.u('e2'), pg_temp.un(2)),
    format($$select verification_basis ->> 'note' from public.game_platforms where game_id = %L$$, pg_temp.un(2))),
  'Cartridge and box photographed', 'a confirmed basis with evidence is accepted');

-- ---------------------------------------------------------------------------
-- Publication rules are unchanged: an unverified pairing is never published, and whoever
-- confirmed the evidence never publishes it.
-- ---------------------------------------------------------------------------
create function pg_temp.publish(p_actor text, p_game uuid) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.publish_game_identity(%L, array[%L]::uuid[], 'Physical existence confirmed', %s)::text$q$,
    p_game, pg_temp.snes(), (select revision from public.games where id = p_game))) $$;
select is(pg_temp.publish('e3', pg_temp.un(2)), 'error: pairing not verified', 'an unsampled member with no physical evidence can''t be published');
select is(pg_temp.publish('e2', pg_temp.un(1)), 'error: own record', 'the editor who confirmed the evidence can''t publish it');

-- ---------------------------------------------------------------------------
-- What staff see.
-- ---------------------------------------------------------------------------
select ok((pg_temp.pairing('e3', pg_temp.un(2)) ->> 'state') = 'unconfirmed'
          and pg_temp.pairing('e3', pg_temp.un(2)) -> 'physical' = 'null'::jsonb
          and (pg_temp.pairing('e3', pg_temp.un(2)) -> 'publication') = '{"eligible": false, "reason": "physical_evidence_unconfirmed", "you_may_publish": false, "your_reason": null}'::jsonb,
  'an unsampled member: physical existence unconfirmed, no evidence, not eligible for publication');
select ok((select e -> 'sampled' = 'false'::jsonb and e ->> 'outcome' is null and e ->> 'status' = 'approved' and e ->> 'id' = pg_temp.b('p')::text
           from jsonb_array_elements(pg_temp.pairing('e3', pg_temp.un(2)) -> 'batches') e),
  'its batch is shown: approved, the member unsampled, with no outcome of its own');
select ok((pg_temp.pairing('e3', pg_temp.un(1)) ->> 'state') = 'confirmed'
          and (pg_temp.pairing('e3', pg_temp.un(1)) -> 'physical' ->> 'note') = 'Cartridge, box and manual photographed'
          and (pg_temp.pairing('e3', pg_temp.un(1)) -> 'physical' ->> 'source') = 'editor'
          and (pg_temp.pairing('e3', pg_temp.un(1)) -> 'physical' ->> 'reference') = 'Collector photo set'
          and (pg_temp.pairing('e3', pg_temp.un(1)) -> 'physical' -> 'current') = 'true'::jsonb,
  'a pairing confirmed individually: its source, reference and note, current for the game''s revision');
select is(pg_temp.pairing('e3', pg_temp.un(1)) -> 'physical' -> 'verifier', '{"you": false, "handle": "ev_e2"}'::jsonb,
  'its verifier is named by handle only');
select is(pg_temp.pairing('e3', pg_temp.un(1)) -> 'publication', '{"eligible": true, "reason": null, "you_may_publish": true, "your_reason": null}'::jsonb,
  'another editor sees that they may publish it');
select is(pg_temp.pairing('e2', pg_temp.un(1)) -> 'publication', '{"eligible": true, "reason": null, "you_may_publish": false, "your_reason": "you_confirmed"}'::jsonb,
  'the editor who confirmed it sees that they may not');
select ok((pg_temp.pairing('e3', pg_temp.s(1)) ->> 'state') = 'published_identity'
          and (pg_temp.pairing('e3', pg_temp.s(1)) -> 'physical' ->> 'note') = 'Cartridge and box photographed; label matches the SNES listing'
          and (pg_temp.pairing('e3', pg_temp.s(1)) -> 'physical' ->> 'batch_id') = pg_temp.b('p')::text
          and (pg_temp.pairing('e3', pg_temp.s(1)) -> 'physical' ->> 'source') = 'wikidata'
          and (pg_temp.pairing('e3', pg_temp.s(1)) -> 'publication' ->> 'reason') = 'published'
          and (pg_temp.pairing('e3', pg_temp.s(1)) -> 'releases') = '{"total": 0, "published": 0}'::jsonb,
  'a member confirmed in review and published: identity public with no verified release, its reviewer''s note and batch');
select ok((select e -> 'sampled' = 'true'::jsonb and e ->> 'outcome' = 'correct' and e ->> 'recorded_at' is not null
           from jsonb_array_elements(pg_temp.pairing('e3', pg_temp.s(1)) -> 'batches') e),
  'and its own reviewed outcome in that batch');
select is(pg_temp.publish('e3', pg_temp.un(1)), 'true', 'a third editor publishes the individually confirmed identity');
select is(pg_temp.pairing('e1', pg_temp.un(1)) ->> 'state', 'published_identity', 'which is now a published identity');

-- An exact physical release still needs its own verification and publication.
create function pg_temp.release(p_game uuid) returns uuid language plpgsql as $f$
declare v uuid;
begin
  perform set_config('request.jwt.claims', pg_temp.claims(pg_temp.u('e1'), 'aal2')::text, true);
  v := public.create_release(p_game, pg_temp.snes(), 'snes-game-pak-na', 'ntsc-uc',
    '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "packaging_code": "cardboard-box", "product_code": "SNS-ZQM-USA"}'::jsonb, 'M14c-1 test');
  return v;
end $f$;
create temp table rel as select pg_temp.release(pg_temp.un(1)) as id;
select is(pg_temp.pairing('e3', pg_temp.un(1)) -> 'releases', '{"total": 1, "published": 0}'::jsonb,
  'a new release isn''t counted as verified: the identity stays published without a verified release');
select is(pg_temp.as_user('e3', format($q$select public.verify_release(%L, 'Release checked', %s)::text$q$, (select id from rel), (select revision from public.releases where id = (select id from rel)))), 'true',
  'the release is verified separately');
select is(pg_temp.as_user('e3', format($q$select public.publish_release(%L, 'Release published', %s)::text$q$, (select id from rel), (select revision from public.releases where id = (select id from rel)))), 'true',
  'and published separately');
select ok((pg_temp.pairing('e3', pg_temp.un(1)) ->> 'state') = 'published_with_release'
          and (pg_temp.pairing('e3', pg_temp.un(1)) -> 'releases') = '{"total": 1, "published": 1}'::jsonb,
  'then the pairing is a published identity with a verified release');

-- The read's other refusals, each as publish_game_identity decides it.
select is(pg_temp.pairing('e3', pg_temp.g('Zqm Legacy One')) -> 'publication' ->> 'reason', 'game_not_verified',
  'a game whose identity isn''t verified: not eligible, for that reason');
create function pg_temp.nes() returns uuid language sql stable as $$ select id from public.platforms where slug = 'nes' $$;
create function pg_temp.nes_pairing(p_actor text) returns jsonb language sql as $$
  select e from jsonb_array_elements(pg_temp.evidence(p_actor, pg_temp.un(1)) -> 'pairings') e where e -> 'platform' ->> 'slug' = 'nes' $$;
select is(pg_temp.as_user('e1', format($q$select public.set_game_platform(%L, %L, 'Also on the NES')::text$q$, pg_temp.un(1), pg_temp.nes())), 'true',
  'an editor pairs the published game with another platform');
select is(pg_temp.as_user('e2', format($q$select public.verify_game_platform(%L, %L, %L::jsonb, 'Checked a copy', %s)::text$q$, pg_temp.un(1), pg_temp.nes(),
    '{"source": "editor", "reference": "NES photo set", "physical_eligibility": "confirmed", "note": "カートリッジと箱の写真を確認しました、ラベルも一致"}',
    (select revision from public.games where id = pg_temp.un(1)))), 'true',
  'an evidence note in Japanese counts: letters are letters in any script');
select is(pg_temp.nes_pairing('e1') -> 'publication', '{"eligible": true, "reason": null, "you_may_publish": false, "your_reason": "you_created"}'::jsonb,
  'the editor who created the pairing sees that they may not publish it');
select is(pg_temp.as_user('e1', format($q$select public.update_game(%L, '{"sort_title": "Zqm Lot Edited"}', 'Sort title')::text$q$, pg_temp.un(1))), 'true',
  'the game is edited after its NES evidence was recorded');
select ok((pg_temp.nes_pairing('e3') ->> 'state') = 'confirmed' and (pg_temp.nes_pairing('e3') -> 'physical' -> 'current') = 'false'::jsonb
          and (pg_temp.nes_pairing('e3') -> 'publication' ->> 'reason') = 'evidence_outdated' and (pg_temp.nes_pairing('e3') -> 'publication' -> 'eligible') = 'false'::jsonb,
  'its evidence is now for an earlier revision: not eligible, for that reason');
select is(pg_temp.as_user('e3', format($q$select public.publish_game_identity(%L, array[%L]::uuid[], 'Physical existence confirmed', %s)::text$q$,
    pg_temp.un(1), pg_temp.nes(), (select revision from public.games where id = pg_temp.un(1)))), 'error: pairing not verified',
  'and publish_game_identity agrees: the pairing must be confirmed again');

-- Who may read it.
select is(has_function_privilege('anon', 'public.get_game_pairing_evidence(uuid)', 'execute'), false, 'visitors can''t call the evidence read');
select is(has_function_privilege('service_role', 'public.get_game_pairing_evidence(uuid)', 'execute'), false, 'nor can the service role');
select is(pg_temp.evidence('c4', pg_temp.un(1)), '{"error": "error: not permitted"}'::jsonb, 'a collector is refused');
select is((select r from pg_temp.as_aal('e3', 'aal1', format('select public.get_game_pairing_evidence(%L)::text', pg_temp.un(1))) r), 'error: not permitted',
  'staff without their second factor are refused');
select is(pg_temp.as_user('e3', format('select public.get_game_pairing_evidence(%L)::text', gen_random_uuid())), '', 'an unknown game returns nothing');
select ok(position('@example.test' in pg_temp.evidence('e3', pg_temp.un(1))::text) = 0
          and position(pg_temp.u('e2')::text in pg_temp.evidence('e3', pg_temp.un(1))::text) = 0,
  'no email address or account id of the verifier is disclosed');
select is(has_column_privilege('anon', 'public.game_platforms', 'verification_basis', 'select') or has_column_privilege('authenticated', 'public.game_platforms', 'verification_basis', 'select'),
  false, 'no client can read a basis from the table');
select is(has_table_privilege('authenticated', 'private.catalog_review_batch_items', 'select'), false, 'nor review outcomes and their notes');
select is(pg_temp.as_anon(format($$select coalesce(string_agg(gp::text, ','), '') from public.game_platforms gp where gp.game_id = %L$$, pg_temp.un(1))),
  'error: permission denied for table game_platforms', 'a visitor reading whole pairing rows is refused: the basis isn''t among their columns');

-- ---------------------------------------------------------------------------
-- Collections and wishlists see only what is published.
-- ---------------------------------------------------------------------------
select ok(private.can_claim(pg_temp.s(1), pg_temp.snes()), 'a collector can record an unidentified copy of a published identity');
select ok(not private.can_claim(pg_temp.un(2), pg_temp.snes()), 'but not of an unsampled member');
select ok((pg_temp.as_user('c4', format($q$select public.add_wishlist_item(%L, %L)::text$q$, private.uuid_v7(),
    jsonb_build_object('game_id', pg_temp.s(1), 'platform_id', pg_temp.snes()))))::jsonb ->> 'created' = 'true',
  'a collector can wish for a published identity on its platform');
select is(pg_temp.as_user('c4', format($q$select public.add_wishlist_item(%L, %L)::text$q$, private.uuid_v7(),
    jsonb_build_object('game_id', pg_temp.un(2), 'platform_id', pg_temp.snes()))), 'error: game unavailable',
  'but not for an unsampled member');

select * from finish();
rollback;
