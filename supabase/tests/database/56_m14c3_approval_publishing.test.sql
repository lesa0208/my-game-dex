-- M14c-3: approving, rejecting and publishing from the admin panel
-- (20261213100000_m14c3_publication_reads). The approval preview and the publication queue,
-- each compared with what approve_review_batch and publish_game_identity actually do; single and
-- multiple approvals; rejection; separation of duties; a published game with another pairing to
-- publish; stale and outdated evidence; withdrawn rights; who may read. One rolled-back
-- transaction with synthetic accounts and records; no savepoints (see 54).
begin;
create extension if not exists pgtap with schema extensions;
select plan(106);

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

-- Synthetic accounts, for this transaction only: e1 creates batches, e2 reviews, e3 and e4
-- approve, e5 is an editor who did neither, c6 a collector.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['e1', 'e2', 'e3', 'e4', 'e5', 'c6']) as s;
update public.profiles set handle = 'ap_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['e1', 'e2', 'e3', 'e4', 'e5', 'c6']) as s);
insert into public.staff_roles (user_id, role) select pg_temp.u(s), 'catalog_editor' from unnest(array['e1', 'e2', 'e3', 'e4', 'e5']) as s;
update private.catalog_review_policy set tolerable_error = 0.45, confidence = 0.8;
select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', encode(digest('terms', 'sha256'), 'hex'), 'M14c-3 test clearance');

create temp table b (tag text primary key, id uuid);
create function pg_temp.b(p_tag text) returns uuid language sql stable as $$ select id from b where tag = p_tag $$;
create function pg_temp.g(p_title text) returns uuid language sql stable as $$ select id from public.games where title = p_title $$;
create function pg_temp.platform(p_slug text) returns uuid language sql stable as $$ select id from public.platforms where slug = p_slug $$;
create function pg_temp.make_run(p_tag text, p_titles text[], p_flagged text default null) returns uuid language plpgsql as $f$
declare
  v_run uuid; v_game uuid; v_record uuid; t text; i integer := 0; v_flags jsonb;
begin
  insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, status, finished_at, reason)
  values ('wikidata', pg_temp.platform('snes'), 'm14c3-test-' || p_tag, encode(digest(p_tag, 'sha256'), 'hex'), now(),
          encode(digest('terms', 'sha256'), 'hex'), 'completed', now(), 'M14c-3 test') returning id into v_run;
  foreach t in array p_titles loop
    i := i + 1;
    v_flags := case when t = p_flagged then '["mul_label_only"]'::jsonb else '[]'::jsonb end;
    insert into public.games (title, sort_title, kind, status, first_release_date, first_release_precision)
    values (t, t, 'game', 'under_review', ('1994-01-01'::date + i), 'day') returning id into v_game;
    insert into public.game_platforms (game_id, platform_id, status) values (v_game, pg_temp.platform('snes'), 'under_review');
    insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
    values ('wikidata', 'game', 'Q6' || p_tag || i,
            jsonb_build_object('title', t, 'source', jsonb_build_object('revision', 1), 'risk_assessment', jsonb_build_object('contract', 'mgd-risk-assessment', 'version', 1,
              'assessor', 'm14c3-test', 'assessor_version', '1',
              'source', jsonb_build_object('provider', 'wikidata', 'external_id', 'Q6' || p_tag || i, 'revision', 1, 'snapshot_sha256', encode(digest(p_tag, 'sha256'), 'hex')),
              'flags', v_flags, 'critical', '[]'::jsonb)),
            encode(digest(p_tag || i, 'sha256'), 'hex'), v_run, 'promoted', v_game) returning id into v_record;
    insert into private.import_run_records (import_run_id, provider_record_id, position) values (v_run, v_record, i);
  end loop;
  return v_run;
end $f$;
create function pg_temp.make_batch(p_tag text) returns uuid language plpgsql as $f$
declare v text;
begin
  v := pg_temp.as_user('e1', format($q$select public.create_review_batch(%L, %L, 'M14c-3 test batch')::text$q$,
         (select id from private.import_runs where source_name = 'm14c3-test-' || p_tag), pg_temp.platform('snes')));
  insert into b values (p_tag, v::uuid);
  return v::uuid;
end $f$;
create function pg_temp.outcome(p_actor text, p_tag text, p_game uuid, p_outcome text, p_note text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.record_batch_outcome(%L, %L, %L, null, %L)::text$q$, pg_temp.b(p_tag), p_game, p_outcome, p_note)) $$;
-- Every member that needs an outcome, reviewed by e2, found correct with evidence.
create function pg_temp.review_all(p_tag text) returns void language plpgsql as $r$
declare g uuid;
begin
  for g in select game_id from private.catalog_review_batch_items where batch_id = pg_temp.b(p_tag) and (sampled or cardinality(flags) > 0) order by game_id loop
    perform pg_temp.outcome('e2', p_tag, g, 'correct', 'Cartridge and box photographed; label checked against the listing');
  end loop;
end $r$;
create function pg_temp.approve(p_actor text, p_tag text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.approve_review_batch(%L, 'Approved with evidence')::text$q$, pg_temp.b(p_tag))) $$;
create function pg_temp.reject(p_actor text, p_tag text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.reject_review_batch(%L, 'Rejected for the test')::text$q$, pg_temp.b(p_tag))) $$;
create function pg_temp.preview(p_actor text, p_tag text) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_batch_approval_preview(%L)::text', pg_temp.b(p_tag)))) $$;
create function pg_temp.queue(p_actor text, p_state text) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.list_publication_queue(%L, null, null, null, null, 100)::text', p_state))) $$;
create function pg_temp.publish(p_actor text, p_game uuid, p_platform text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.publish_game_identity(%L, array[%L]::uuid[], 'Published for the test', %s)::text$q$,
         p_game, pg_temp.platform(p_platform), (select revision from public.games where id = p_game))) $$;
-- A queue item, by game and platform.
create function pg_temp.item(p_actor text, p_state text, p_game uuid, p_platform text) returns jsonb language sql as $$
  select e from jsonb_array_elements(pg_temp.queue(p_actor, p_state) -> 'items') e
  where (e -> 'game' ->> 'id')::uuid = p_game and e -> 'platform' ->> 'slug' = p_platform $$;
create function pg_temp.n(p_tag text, p_where text) returns integer language plpgsql as $n$
declare r integer;
begin
  execute format('select count(*)::int from private.catalog_review_batch_items where batch_id = %L and %s', pg_temp.b(p_tag), p_where) into r;
  return r;
end $n$;

-- Batches: s (single approval, approved by e3, not its reviewer), r (approved by its own
-- reviewer e2), x (rejected), m (two approvals), y (rejected while waiting for reviews).
select pg_temp.make_run('s', array['Sole A', 'Sole B', 'Sole C', 'Sole D', 'Sole E', 'Sole F', 'Sole G', 'Sole H'], 'Sole A');
select pg_temp.make_batch('s');
select pg_temp.make_run('r', array['Rev A', 'Rev B', 'Rev C', 'Rev D', 'Rev E', 'Rev F'], 'Rev A');
select pg_temp.make_batch('r');
select pg_temp.make_run('x', array['Rejected A', 'Rejected B']);
select pg_temp.make_batch('x');
update private.catalog_review_policy set second_approval_above = 1;
select pg_temp.make_run('m', array['Multi A', 'Multi B', 'Multi C', 'Multi D', 'Multi E'], 'Multi A');
select pg_temp.make_batch('m');
update private.catalog_review_policy set second_approval_above = 1000;
select pg_temp.make_run('y', array['Yet A', 'Yet B', 'Yet C'], 'Yet A');
select pg_temp.make_batch('y');

-- ---------------------------------------------------------------------------
-- Who may read.
-- ---------------------------------------------------------------------------
select is(pg_temp.as_anon(format('select public.get_batch_approval_preview(%L)::text', pg_temp.b('s'))), 'error: permission denied for function get_batch_approval_preview', 'visitors can''t preview an approval');
select is(pg_temp.as_anon('select public.list_publication_queue()::text'), 'error: permission denied for function list_publication_queue', 'nor read the publication queue');
select is(pg_temp.as_user('c6', format('select public.get_batch_approval_preview(%L)::text', pg_temp.b('s'))), 'error: not permitted', 'a collector can''t preview an approval');
select is(pg_temp.as_user('c6', 'select public.list_publication_queue()::text'), 'error: not permitted', 'nor read the queue');
select is(pg_temp.as_aal('e3', 'aal1', format('select public.get_batch_approval_preview(%L)::text', pg_temp.b('s'))), 'error: not permitted', 'nor an editor without a verified second factor');
select is(pg_temp.as_aal('e3', 'aal1', 'select public.list_publication_queue()::text'), 'error: not permitted', 'who can''t read the queue either');
select ok(not has_function_privilege('service_role', 'public.get_batch_approval_preview(uuid, integer)', 'execute')
          and not has_function_privilege('service_role', 'public.list_publication_queue(text, text, timestamptz, uuid, uuid, integer)', 'execute')
          and not has_function_privilege('authenticated', 'private.identity_publication_block(public.games, public.game_platforms)', 'execute')
          and not has_function_privilege('authenticated', 'private.identity_publication_own(uuid, uuid, uuid, uuid)', 'execute'),
          'the service role can''t run them, and the helpers are owner only');
select is((select array_agg(distinct p.provolatile::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('get_batch_approval_preview', 'list_publication_queue')), array['s'], 'both are read-only (stable)');

-- ---------------------------------------------------------------------------
-- A single-approval batch, approved by an editor who isn't its reviewer.
-- ---------------------------------------------------------------------------
select is(pg_temp.preview('e3', 's') -> 'counts' ->> 'pending', pg_temp.n('s', '(sampled or cardinality(flags) > 0)')::text, 'before its reviews, every member needing an outcome is pending');
select is(pg_temp.approve('e3', 's'), 'error: batch not reviewed', 'and approval is refused, as the preview implies');
select pg_temp.review_all('s');
create temp table pv_s as select pg_temp.preview('e3', 's') as p;
select is((select p -> 'counts' from pv_s), jsonb_build_object(
  'publish', pg_temp.n('s', 'outcome = ''correct'''), 'await_publication', 0, 'reviewer_gone', 0, 'confirm', 0,
  'identity_only', pg_temp.n('s', 'outcome is null and not sampled and cardinality(flags) = 0'), 'not_accepted', 0, 'pending', 0),
  'reviewed: members found correct would be published, the rest only verified as identities');
select is((select (p ->> 'final') || ' ' || (p -> 'approvals')::text || ' ' || (p -> 'sources')::text from pv_s),
          'true {"recorded": 0, "required": 1} [{"cleared": true, "provider": "wikidata", "provider_name": "Wikidata"}]',
          'this approval would be the final one, from a cleared source');
select is((select jsonb_array_length(p -> 'members') from pv_s), 8, 'every member is listed with its effect');
select is(pg_temp.preview('e2', 's') -> 'counts' ->> 'await_publication', (select (p -> 'counts' ->> 'publish') from pv_s),
          'for its reviewer as approver, the same members would wait for another editor to publish them');
select is(pg_temp.approve('e1', 's'), 'error: own record', 'its creator may not approve it');
create temp table ap_s as select pg_temp.approve('e3', 's')::jsonb as r;
select is((select r from ap_s), jsonb_build_object('status', 'approved', 'published', (select (p -> 'counts' ->> 'publish')::int from pv_s),
            'awaiting_physical_evidence', (select (p -> 'counts' ->> 'identity_only')::int from pv_s), 'awaiting_independent_publication', 0),
          'approval did exactly what the preview said');
select is((select count(*)::int from public.game_platforms gp join private.catalog_review_batch_items i on i.game_id = gp.game_id and i.platform_id = gp.platform_id
           where i.batch_id = pg_temp.b('s') and i.outcome is null and (gp.status = 'published' or gp.verified_at is not null)), 0,
          'its unsampled members stay unconfirmed and unpublished');
select is((select count(*)::int from public.releases r join private.catalog_review_batch_items i on i.game_id = r.game_id where i.batch_id = pg_temp.b('s')), 0,
          'and no physical release was created for any member');
select is((pg_temp.preview('e3', 's') ->> 'final'), 'false', 'an approved batch previews nothing to approve');
select is(pg_temp.approve('e4', 's'), 'error: record unavailable', 'and can''t be approved again');
select is(pg_temp.reject('e4', 's'), 'error: record unavailable', 'or rejected');

-- ---------------------------------------------------------------------------
-- Approved by its own reviewer: confirmed, awaiting independent publication.
-- ---------------------------------------------------------------------------
select pg_temp.review_all('r');
create temp table pv_r as select pg_temp.preview('e2', 'r') as p;
create temp table ap_r as select pg_temp.approve('e2', 'r')::jsonb as r;
select is((select r from ap_r), jsonb_build_object('status', 'approved', 'published', 0,
            'awaiting_physical_evidence', (select (p -> 'counts' ->> 'identity_only')::int from pv_r),
            'awaiting_independent_publication', (select (p -> 'counts' ->> 'await_publication')::int from pv_r)),
          'approved by its reviewer: nothing published, the confirmed members wait, as the preview said');
create temp table rev as select i.game_id from private.catalog_review_batch_items i where i.batch_id = pg_temp.b('r') and i.outcome = 'correct' order by i.game_id;
create function pg_temp.rev(p_n integer) returns uuid language sql stable as $$ select game_id from rev order by game_id offset p_n - 1 limit 1 $$;
select ok((select count(*) >= 2 from rev), 'at least two members were confirmed (setup)');
select is(pg_temp.item('e5', 'ready', pg_temp.rev(1), 'snes') ->> 'you', null, 'the queue lists a confirmed member as ready, and another editor may publish it');
select is(pg_temp.item('e2', 'ready', pg_temp.rev(1), 'snes') ->> 'you', 'you_confirmed', 'its reviewer, who confirmed the evidence, may not');
select is(pg_temp.publish('e2', pg_temp.rev(1), 'snes'), 'error: own record', 'as publish_game_identity says');
select is((pg_temp.item('e5', 'ready', pg_temp.rev(1), 'snes') -> 'physical') - 'verified_at' - 'batch_id', jsonb_build_object(
  'source', 'wikidata', 'reference', (select external_id from private.provider_records where matched_game_id = pg_temp.rev(1)),
  'note', 'Cartridge and box photographed; label checked against the listing', 'current', true,
  'verifier', jsonb_build_object('handle', (select handle from public.profiles where id = pg_temp.u('e2')), 'you', false)),
  'with its evidence, the record checked, and its verifier by handle');
-- Every ready item of the batch another editor may publish is accepted, each tried alone.
select is((select array_agg(pg_temp.then_undo('select 1', format($q$select pg_temp.publish('e5', %L, 'snes')$q$, e -> 'game' ->> 'id')) order by e -> 'game' ->> 'id')
           from jsonb_array_elements(pg_temp.queue('e5', 'ready') -> 'items') e where e ->> 'you' is null and (e -> 'game' ->> 'id')::uuid in (select game_id from rev)),
          (select array_agg('true'::text order by game_id::text) from rev), 'every member the queue calls ready is published when another editor asks');
select is(pg_temp.publish('e5', pg_temp.rev(1), 'snes'), 'true', 'an independent editor publishes one');
select is((select g.status::text || '/' || (select gp.status::text from public.game_platforms gp where gp.game_id = g.id and gp.platform_id = pg_temp.platform('snes')) from public.games g where g.id = pg_temp.rev(1)),
          'published/published', 'its game and pairing are public');
select is(pg_temp.item('e5', 'published', pg_temp.rev(1), 'snes') ->> 'state', 'published', 'and the queue lists it as published');
select is((select count(*)::int from public.releases where game_id = pg_temp.rev(1)), 0, 'still no release: an identity is never a release');

-- Unsampled members wait for physical evidence.
select is((select count(*)::int from jsonb_array_elements(pg_temp.queue('e5', 'awaiting_evidence') -> 'items') e
           where (e -> 'game' ->> 'id')::uuid in (select game_id from private.catalog_review_batch_items where batch_id in (pg_temp.b('s'), pg_temp.b('r')) and outcome is null)),
          pg_temp.n('s', 'outcome is null') + pg_temp.n('r', 'outcome is null'), 'every unsampled member of an approved batch awaits physical evidence');
select is(pg_temp.publish('e5', (select game_id from private.catalog_review_batch_items where batch_id = pg_temp.b('r') and outcome is null order by game_id limit 1), 'snes'),
          'error: pairing not verified', 'and publish_game_identity refuses one');

-- An edited game, and a verifier who is gone.
select is(pg_temp.then_undo(format('update public.games set revision = revision + 1 where id = %L', pg_temp.rev(2)),
          format($q$select (pg_temp.item('e5', 'blocked', %L, 'snes') ->> 'reason') || ' ' || pg_temp.publish('e5', %L, 'snes')$q$, pg_temp.rev(2), pg_temp.rev(2))),
          'game_not_verified error: game not verified', 'an edited unpublished game is blocked until verified again, as publication says');
select is(pg_temp.then_undo(format('update public.game_platforms set verified_by = null where game_id = %L', pg_temp.rev(2)),
          format($q$select (pg_temp.item('e5', 'verifier_gone', %L, 'snes') ->> 'state') || ' ' || pg_temp.publish('e5', %L, 'snes')$q$, pg_temp.rev(2), pg_temp.rev(2))),
          'verifier_gone error: pairing not verified', 'a pairing whose verifier is gone must be confirmed again, as publication says');

-- A published game with another platform to publish: confirmed by e2, published by e5.
insert into public.game_platforms (game_id, platform_id, status) values (pg_temp.rev(1), pg_temp.platform('nes'), 'under_review');
select is(pg_temp.as_user('e2', format($q$select public.verify_game_platform(%L, %L, '{"source": "editor", "reference": "NES cartridge in hand", "physical_eligibility": "confirmed", "note": "NES cartridge and box photographed; label checked"}', 'Confirmed for the test', %s)::text$q$,
          pg_temp.rev(1), pg_temp.platform('nes'), (select revision from public.games where id = pg_temp.rev(1)))), 'true', 'a published game gets a second platform confirmed with evidence');
select is(pg_temp.item('e5', 'ready', pg_temp.rev(1), 'nes') ->> 'state', 'ready', 'which the queue lists as ready to publish');
select is(pg_temp.item('e2', 'ready', pg_temp.rev(1), 'nes') ->> 'you', 'you_confirmed', 'not by whoever confirmed it');
select is(pg_temp.then_undo(format('update public.games set revision = revision + 1 where id = %L', pg_temp.rev(1)),
          format($q$select (pg_temp.item('e5', 'evidence_outdated', %L, 'nes') ->> 'state') || ' ' || pg_temp.publish('e5', %L, 'nes')$q$, pg_temp.rev(1), pg_temp.rev(1))),
          'evidence_outdated error: pairing not verified', 'evidence for an earlier revision is outdated, as publication says');
select is(pg_temp.as_user('e5', format($q$select public.publish_game_identity(%L, array[%L]::uuid[], 'Published for the test', %s)::text$q$,
          pg_temp.rev(1), pg_temp.platform('nes'), (select revision from public.games where id = pg_temp.rev(1)) - 1)), 'error: record changed', 'a stale expected revision is refused');
select is(pg_temp.publish('e5', pg_temp.rev(1), 'nes'), 'true', 'and the second platform is published by another editor');
select is((select status::text from public.game_platforms where game_id = pg_temp.rev(1) and platform_id = pg_temp.platform('nes')), 'published', 'it is public');

-- ---------------------------------------------------------------------------
-- Two approvals.
-- ---------------------------------------------------------------------------
select is((select required_approvals from private.catalog_review_batches where id = pg_temp.b('m')), 2, 'this batch needs two approvals');
select pg_temp.review_all('m');
select is((pg_temp.preview('e3', 'm') ->> 'final') || ' ' || (pg_temp.preview('e3', 'm') -> 'counts' ->> 'confirm'), 'false ' || pg_temp.n('m', 'outcome = ''correct'''),
          'the first approval is not the final one: members found correct are only marked to confirm');
select is(pg_temp.approve('e3', 'm')::jsonb, '{"status": "awaiting_approval", "approvals": 1, "required": 2}'::jsonb, 'the first approval is recorded, and waits');
select is((select status from private.catalog_review_batches where id = pg_temp.b('m')), 'open', 'the batch is still open, not approved');
select is((select count(*)::int from public.games g join private.catalog_review_batch_items i on i.game_id = g.id where i.batch_id = pg_temp.b('m') and (g.verified_at is not null or g.status = 'published')),
          0, 'nothing is verified or published by it');
select is(pg_temp.approve('e3', 'm'), 'error: already approved', 'the same editor can''t approve twice');
select is(pg_temp.j(pg_temp.as_user('e2', format('select public.get_review_batch_overview(%L)::text', pg_temp.b('m')))) -> 'approvals' ->> 'recorded', '1', 'the overview counts it');
select is(pg_temp.outcome('e2', 'm', (select game_id from private.catalog_review_batch_items where batch_id = pg_temp.b('m') and (sampled or cardinality(flags) > 0) order by game_id limit 1), 'excluded', null),
          'error: batch approval started', 'outcomes are locked once an approval is recorded');
select is((pg_temp.preview('e4', 'm') ->> 'final') || ' ' || (pg_temp.preview('e4', 'm') -> 'counts' ->> 'publish'), 'true ' || pg_temp.n('m', 'outcome = ''correct'''),
          'for a second editor, the approval would be final, and publish the members found correct');
select is(pg_temp.approve('e1', 'm'), 'error: own record', 'the creator still can''t approve');
select is(pg_temp.approve('e4', 'm')::jsonb ->> 'published', pg_temp.n('m', 'outcome = ''correct''')::text, 'the final approval publishes them');
select is((select status from private.catalog_review_batches where id = pg_temp.b('m')), 'approved', 'and only then is the batch approved');
select is((select array_agg(action::text order by occurred_at, id) from private.audit_events where action::text like 'catalog_batch_approv%' and metadata ->> 'batch_id' = pg_temp.b('m')::text),
          array['catalog_batch_approval_recorded', 'catalog_batch_approved'], 'both approvals are in the audit log');
select is(pg_temp.then_undo(format($q$update private.catalog_review_batch_approvals set reason = 'changed' where batch_id = %L$q$, pg_temp.b('m')), 'select 1::text'),
          'error: approvals are kept as recorded', 'and an approval can''t be changed afterwards');

-- ---------------------------------------------------------------------------
-- Rejection.
-- ---------------------------------------------------------------------------
select is(pg_temp.reject('e3', 'x'), 'true', 'a batch is rejected');
select is((select status || ' ' || (decision_reason is not null) from private.catalog_review_batches where id = pg_temp.b('x')), 'rejected true', 'with its reason');
select is(pg_temp.reject('e4', 'x'), 'error: record unavailable', 'a rejected batch can''t be rejected again');
select is(pg_temp.approve('e4', 'x'), 'error: record unavailable', 'or approved');
select is(pg_temp.outcome('e2', 'x', pg_temp.g('Rejected A'), 'excluded', null), 'error: record unavailable', 'or take outcomes');
select is((select count(*)::int from public.games where title in ('Rejected A', 'Rejected B') and status = 'under_review'), 2, 'its games are kept, still in review');
select is((select count(*)::int from private.provider_records where matched_game_id in (pg_temp.g('Rejected A'), pg_temp.g('Rejected B'))), 2, 'and so are their source records');
select is(pg_temp.as_user('e1', format($q$select public.create_review_batch(%L, %L, 'again')::text$q$, (select id from private.import_runs where source_name = 'm14c3-test-x'), pg_temp.platform('snes'))),
          'error: unchanged since rejection', 'unchanged, they can''t be batched again');
select is(pg_temp.approve('e3', 'y'), 'error: batch not reviewed', 'a batch waiting for reviews isn''t approved');
select is(pg_temp.reject('e4', 'y'), 'true', 'but can be rejected');
select pg_temp.make_run('z', array['Zed A', 'Zed B', 'Zed C']);
update private.catalog_review_policy set second_approval_above = 1;
select pg_temp.make_batch('z');
update private.catalog_review_policy set second_approval_above = 1000;
select pg_temp.review_all('z');
select is(pg_temp.approve('e3', 'z')::jsonb ->> 'status', 'awaiting_approval', 'another batch gets its first approval');
select is(pg_temp.reject('e4', 'z'), 'true', 'and is rejected after approval began, as the rules allow');
select is((select count(*)::int from private.catalog_review_batch_approvals where batch_id = pg_temp.b('z')), 1, 'its recorded approval is kept');
select is((select count(*)::int from public.games g join private.catalog_review_batch_items i on i.game_id = g.id where i.batch_id = pg_temp.b('z') and (g.verified_at is not null or g.status = 'published')),
          0, 'and nothing of it was verified or published');

-- ---------------------------------------------------------------------------
-- Withdrawn rights.
-- ---------------------------------------------------------------------------
select pg_temp.make_run('w', array['Rights A', 'Rights B', 'Rights C']);
select pg_temp.make_batch('w');
select pg_temp.review_all('w');
select is(pg_temp.then_undo($$update private.external_providers set commercial_use_cleared = false where code = 'wikidata'$$,
          $$select (pg_temp.preview('e3', 'w') -> 'sources' -> 0 ->> 'cleared') || ' ' || pg_temp.approve('e3', 'w')$$),
          'false error: provider not cleared', 'a source no longer cleared: the preview says so, and approval refuses');

-- ---------------------------------------------------------------------------
-- The queue's pages and bounds.
-- ---------------------------------------------------------------------------
create temp table qpaged as
  with recursive p(page, n) as (
    select pg_temp.j(pg_temp.as_user('e5', 'select public.list_publication_queue(null, null, null, null, null, 2)::text')), 1
    union all
    select pg_temp.j(pg_temp.as_user('e5', format('select public.list_publication_queue(null, null, %L, %L, %L, 2)::text',
             page -> 'next_after' ->> 'at', page -> 'next_after' ->> 'game', page -> 'next_after' ->> 'platform'))), n + 1
    from p where jsonb_typeof(page -> 'next_after') = 'object' and n < 100)
  select n, page from p;
select is((select array_agg((e -> 'game' ->> 'id') || '/' || (e -> 'platform' ->> 'slug') order by n, k) from qpaged, jsonb_array_elements(page -> 'items') with ordinality x(e, k)),
          (select array_agg((e -> 'game' ->> 'id') || '/' || (e -> 'platform' ->> 'slug') order by k) from jsonb_array_elements(pg_temp.queue('e5', null) -> 'items') with ordinality x(e, k)),
          'two at a time, the pages hold the whole queue once, in the same order');
select is((select (page -> 'counts') from qpaged where n = 1), pg_temp.queue('e5', null) -> 'counts', 'every page carries the same counts');
select is((pg_temp.queue('e5', 'ready') -> 'counts' ->> 'ready')::int, jsonb_array_length(pg_temp.queue('e5', 'ready') -> 'items'), 'the ready count is the ready list');
select is(pg_temp.as_user('e5', 'select public.list_publication_queue(''nonsense'')::text'), 'error: invalid changes', 'an unknown state is refused');
select is(pg_temp.as_user('e5', 'select public.list_publication_queue(null, null, null, null, null, 101)::text'), 'error: invalid changes', 'as is a page of more than 100');
select is(pg_temp.as_user('e5', format('select public.list_publication_queue(null, null, now(), %L, null, 10)::text', gen_random_uuid())), 'error: invalid changes', 'and a partial cursor');
select is(pg_temp.j(pg_temp.as_user('e5', 'select public.list_publication_queue(null, ''no-such-platform'')::text')) ->> 'status', 'unknown_platform', 'an unknown platform lists nothing, and says so');
select ok(pg_temp.queue('e5', null)::text !~ '@example\.test' and pg_temp.preview('e3', 'w')::text !~ '@example\.test', 'no email address appears');
select is(pg_temp.as_user('e5', 'select public.get_batch_approval_preview(gen_random_uuid())::text'), '', 'an unknown batch has no preview');
select is(pg_temp.as_user('e5', format('select public.get_batch_approval_preview(%L, 0)::text', pg_temp.b('w'))), 'error: invalid changes', 'and a preview lists 1 to 200 members of each effect');

-- The queue's reasons agree with get_game_pairing_evidence's for every pairing it lists.
select is((select count(*)::int from jsonb_array_elements(pg_temp.queue('e5', null) -> 'items') e,
             lateral (select x from jsonb_array_elements(pg_temp.j(pg_temp.as_user('e5', format('select public.get_game_pairing_evidence(%L)::text', e -> 'game' ->> 'id'))) -> 'pairings') x
                      where x -> 'platform' ->> 'slug' = e -> 'platform' ->> 'slug') ev
           where (ev.x -> 'publication' ->> 'reason') is distinct from (e ->> 'reason')), 0,
          'every listed pairing''s reason is the game record''s');

-- ---------------------------------------------------------------------------
-- Deciding and publishing what the editor saw (the _as_seen wrappers).
-- ---------------------------------------------------------------------------
select is(pg_temp.as_anon(format($q$select public.approve_review_batch_as_seen(%L, 'x', 0)::text$q$, pg_temp.b('w'))), 'error: permission denied for function approve_review_batch_as_seen', 'visitors can''t approve');
select is(pg_temp.as_user('c6', format($q$select public.approve_review_batch_as_seen(%L, 'x', 0)::text$q$, pg_temp.b('w'))), 'error: not permitted', 'nor collectors');
select is(pg_temp.as_aal('e3', 'aal1', format($q$select public.approve_review_batch_as_seen(%L, 'x', 0)::text$q$, pg_temp.b('w'))), 'error: not permitted', 'nor editors without a verified factor');
select is(pg_temp.as_user('c6', format($q$select public.publish_game_identity_as_seen(%L, array[%L]::uuid[], 'x', 1, array[now()])::text$q$, pg_temp.rev(2), pg_temp.platform('snes'))),
          'error: not permitted', 'and collectors can''t publish');
select ok(not has_function_privilege('anon', 'public.publish_game_identity_as_seen(uuid, uuid[], text, bigint, timestamptz[])', 'execute')
          and not has_function_privilege('service_role', 'public.approve_review_batch_as_seen(uuid, text, integer)', 'execute')
          and not has_function_privilege('service_role', 'public.publish_game_identity_as_seen(uuid, uuid[], text, bigint, timestamptz[])', 'execute'),
          'neither visitors nor the service role can run the wrappers');

-- Two editors who each saw no approval yet: the first records, the second is refused.
select pg_temp.make_run('v', array['Seen A', 'Seen B', 'Seen C', 'Seen D'], 'Seen A');
update private.catalog_review_policy set second_approval_above = 1;
select pg_temp.make_batch('v');
update private.catalog_review_policy set second_approval_above = 1000;
select pg_temp.review_all('v');
create function pg_temp.approve_seen(p_actor text, p_tag text, p_seen integer) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.approve_review_batch_as_seen(%L, 'Approved as seen', %s)::text$q$, pg_temp.b(p_tag), p_seen)) $$;
select is(pg_temp.approve_seen('e3', 'v', 0)::jsonb ->> 'status', 'awaiting_approval', 'the first editor, who saw no approval, records the first');
select is(pg_temp.approve_seen('e4', 'v', 0), 'error: batch changed', 'the second, who also saw none, is refused: their approval would have been the final one');
select is((select count(*)::int from public.games g join private.catalog_review_batch_items i on i.game_id = g.id where i.batch_id = pg_temp.b('v') and (g.verified_at is not null or g.status = 'published')),
          0, 'and nothing was verified or published by the refused call');
select is(pg_temp.approve_seen('e4', 'v', -1), 'error: invalid changes', 'a negative count is refused');
select is(pg_temp.approve_seen('e4', 'v', 1)::jsonb ->> 'status', 'approved', 'seeing the first approval, the second editor makes the final one');
select is(pg_temp.as_user('e4', format($q$select public.approve_review_batch_as_seen(%L, 'x', 0)::text$q$, gen_random_uuid())), 'error: record unavailable', 'an unknown batch is unavailable');
select is(pg_temp.approve_seen('e3', 's', 0), 'error: batch changed', 'a decided batch with other approvals than seen: changed');
select is(pg_temp.approve_seen('e4', 's', 2), 'error: batch changed', 'every wrong count is refused before the writer runs');
select is(pg_temp.approve_seen('e5', 's', (select count(*)::int from private.catalog_review_batch_approvals where batch_id = pg_temp.b('s'))), 'error: record unavailable',
          'and with the right count, approve_review_batch itself still decides (a decided batch is unavailable)');

-- Publishing at the evidence seen: a pairing confirmed again since is refused.
create function pg_temp.publish_seen(p_actor text, p_game uuid, p_platform text, p_at timestamptz) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.publish_game_identity_as_seen(%L, array[%L]::uuid[], 'Published as seen', %s, array[%L]::timestamptz[])::text$q$,
         p_game, pg_temp.platform(p_platform), (select revision from public.games where id = p_game), p_at)) $$;
create temp table seen_at as select verified_at as at from public.game_platforms where game_id = pg_temp.rev(2) and platform_id = pg_temp.platform('snes');
select is(pg_temp.then_undo(format($q$update public.game_platforms set verified_at = verified_at + interval '1 second', verification_basis = verification_basis || '{"note": "A different, later note about the cartridge"}' where game_id = %L and platform_id = %L$q$, pg_temp.rev(2), pg_temp.platform('snes')),
          format($q$select pg_temp.publish_seen('e5', %L, 'snes', %L)$q$, pg_temp.rev(2), (select at from seen_at))),
          'error: record changed', 'evidence confirmed again after the editor read it: refused, though the game''s revision is the same');
select is(pg_temp.as_user('e5', format($q$select public.publish_game_identity_as_seen(%L, array[%L, %L]::uuid[], 'x', 1, array[now()])::text$q$, pg_temp.rev(2), pg_temp.platform('snes'), pg_temp.platform('nes'))),
          'error: invalid changes', 'platforms and times must pair up');
select is(pg_temp.publish_seen('e2', pg_temp.rev(2), 'snes', (select at from seen_at)), 'error: own record', 'the evidence''s verifier is still refused by publish_game_identity');
select is(pg_temp.publish_seen('e5', pg_temp.rev(2), 'snes', (select at from seen_at)), 'true', 'at the evidence seen, another editor publishes');

-- A reviewer whose account is gone, and a correct outcome without evidence.
select pg_temp.make_run('d', array['Gone A', 'Gone B', 'Gone C', 'Gone D'], 'Gone A');
select pg_temp.make_batch('d');
select pg_temp.review_all('d');
create temp table gone as select game_id from private.catalog_review_batch_items where batch_id = pg_temp.b('d') and outcome = 'correct' order by game_id limit 1;
select is(pg_temp.then_undo(format($q$update private.catalog_review_batch_items set reviewed_by = null where batch_id = %L and game_id = %L$q$, pg_temp.b('d'), (select game_id from gone)),
          $$select (pg_temp.preview('e3', 'd') -> 'counts' ->> 'reviewer_gone') || ' ' || (pg_temp.preview('e3', 'd') -> 'counts' ->> 'publish') || ' '
                   || (pg_temp.approve('e3', 'd')::jsonb ->> 'awaiting_independent_publication') || ' '
                   || (select coalesce(gp.verified_by::text, 'none') from public.game_platforms gp where gp.game_id = (select game_id from gone)) || ' '
                   || pg_temp.publish('e5', (select game_id from gone), 'snes')$$),
          '1 ' || (pg_temp.n('d', 'outcome = ''correct''') - 1) || ' 1 none error: pairing not verified',
          'a member whose reviewer is gone: the preview says it can''t be published, approval leaves it without a verifier, and publication refuses it');
select is(pg_temp.then_undo(format($q$update private.catalog_review_batch_items set note = null where batch_id = %L and game_id = %L$q$, pg_temp.b('d'), (select game_id from gone)),
          $$select (pg_temp.preview('e3', 'd') ->> 'evidence_missing') || ' ' || pg_temp.approve('e3', 'd')$$),
          '1 error: evidence required', 'a correct outcome without evidence: the preview counts it, and approval refuses');

-- The queue agrees with the game record on who may publish, filters by platform, and drops
-- pairings that left review.
select is((select count(*)::int from (values ('e2'), ('e5')) a(actor), jsonb_array_elements(pg_temp.queue(a.actor, 'ready') -> 'items') e,
             lateral (select x from jsonb_array_elements(pg_temp.j(pg_temp.as_user(a.actor, format('select public.get_game_pairing_evidence(%L)::text', e -> 'game' ->> 'id'))) -> 'pairings') x
                      where x -> 'platform' ->> 'slug' = e -> 'platform' ->> 'slug') ev
           where (ev.x -> 'publication' ->> 'your_reason') is distinct from (e ->> 'you')
              or ((ev.x -> 'publication' ->> 'you_may_publish')::boolean) is distinct from (e ->> 'you' is null)), 0,
          'for every ready item, who may publish it is the game record''s answer, for its verifier and for another editor');
select ok((select bool_and(e -> 'platform' ->> 'slug' = 'nes') and count(*) >= 1
           from jsonb_array_elements(pg_temp.j(pg_temp.as_user('e5', 'select public.list_publication_queue(null, ''nes'', null, null, null, 100)::text')) -> 'items') e),
          'filtered to a platform, the queue lists only its pairings');
select is(pg_temp.then_undo(format($q$update public.game_platforms set status = 'excluded' where game_id = %L and platform_id = %L$q$, pg_temp.rev(3), pg_temp.platform('snes')),
          format($q$select count(*)::text from jsonb_array_elements(pg_temp.queue('e5', null) -> 'items') e where (e -> 'game' ->> 'id')::uuid = %L and e -> 'platform' ->> 'slug' = 'snes'$q$, pg_temp.rev(3))),
          '0', 'a pairing that left review is no longer in the queue');

select * from finish();
rollback;
