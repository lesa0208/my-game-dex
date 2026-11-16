-- M10c: creator provenance and no self-review (D2, D-1 to D-4), recent MFA for
-- sensitive catalog work (D3, D-5, D-6, D-8), and verification bound to the revision
-- it attested (D-7). Runs in one transaction that rolls back, on the local stack only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(117);

-- Staff need a live aal2 session with a verified TOTP factor (M8b). claims() makes one
-- whose TOTP verification is fresh; stale() one verified 11 minutes ago.
create function pg_temp.session(p_user uuid, p_verified timestamptz) returns jsonb language plpgsql as $mfa$
begin
  insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    select p_user, p_user, 'test session factor', 'totp', 'verified', now(), now()
    where not exists (select 1 from auth.mfa_factors where id = p_user);
  if not exists (select 1 from auth.mfa_amr_claims where session_id = p_user) then
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values (gen_random_uuid(), p_user, 'totp', p_verified, p_verified);
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user);
end $mfa$;
create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
-- e6 and a7 are only ever stale; everyone else is fresh.
create function pg_temp.claims(p text) returns jsonb language sql as $$
  select pg_temp.session(pg_temp.u(p), case when p in ('e6', 'a7') then now() - interval '11 minutes' else now() end) $$;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.claims(p_actor)::text, true);
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
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  perform set_config('role', 'anon', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;

create temp table ids (name text primary key, id uuid not null);
grant all on ids to authenticated, anon;
create function pg_temp.keep(p text, v text) returns text language plpgsql as $$
begin
  if v like 'error%' then raise exception 'setup failed for %: %', p, v; end if;
  insert into ids values (p, v::uuid);
  return v;
end $$;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
create function pg_temp.grev(p text) returns bigint language sql stable as $$ select revision from public.games where id = pg_temp.id(p) $$;
create function pg_temp.rrev(p text) returns bigint language sql stable as $$ select revision from public.releases where id = pg_temp.id(p) $$;
-- A record's provenance: origin/creator, where the creator is the test user's two
-- letters, 'removed' or '-'.
create function pg_temp.origin(p text) returns text language sql stable as $$
  select o.origin || '/' || case when o.creator_id is not null then right(o.creator_id::text, 2) when o.creator_removed then 'removed' else '-' end
  from private.catalog_record_origins o where o.game_id = pg_temp.id(p) or o.release_id = pg_temp.id(p) $$;
create function pg_temp.status(p text) returns text language sql stable as $$
  select coalesce((select status::text from public.games where id = pg_temp.id(p)), (select status::text from public.releases where id = pg_temp.id(p))) $$;
create function pg_temp.ver(p text) returns int language sql stable as $$ select version from public.catalog_change_requests where id = pg_temp.id(p) $$;
create function pg_temp.verified(p text) returns boolean language sql stable as $$
  select coalesce((select verified_at is not null from public.games where id = pg_temp.id(p)), (select verified_at is not null from public.releases where id = pg_temp.id(p))) $$;

-- Each call, by name.
create function pg_temp.game(p_actor text, p_name text, p_title text, p_kind text default 'game') returns text language sql as $$
  select pg_temp.keep(p_name, pg_temp.as_user(p_actor, format('select public.create_game(%L, %L, null, null, null, ''unknown'', ''Provenance tests'')::text', p_title, p_kind))) $$;
create function pg_temp.release(p_actor text, p_name text, p_game text, p_region text, p_code text) returns text language sql as $$
  select pg_temp.keep(p_name, pg_temp.as_user(p_actor, format('select public.create_release(%L, (select id from public.platforms where slug = ''snes''), ''rom-cartridge'', %L, %L, ''Provenance tests'')::text',
    pg_temp.id(p_game), p_region, jsonb_build_object('edition_name', 'Standard', 'edition_kind', 'standard', 'media_count', 1, 'product_code', p_code)))) $$;
create function pg_temp.verify_game(p_actor text, p text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.verify_game(%L, ''Checked'', %s)::text', pg_temp.id(p), pg_temp.grev(p))) $$;
create function pg_temp.verify_release(p_actor text, p text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.verify_release(%L, ''Checked'', %s)::text', pg_temp.id(p), pg_temp.rrev(p))) $$;
create function pg_temp.publish(p_actor text, p text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.publish_release(%L, ''Published'', %s)::text', pg_temp.id(p), pg_temp.rrev(p))) $$;
create function pg_temp.exclude(p_actor text, p text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.exclude_release(%1$L, public.get_exclusion_preview(%1$L) ->> 'token', 'no_game_data', 'Provenance tests', null, true, true)::text$q$, pg_temp.id(p))) $$;
create function pg_temp.restore(p_actor text, p text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.restore_exclusion(%L, %s, ''Provenance tests'')::text', e.id, e.version))
  from private.catalog_exclusions e where e.release_id = pg_temp.id(p) and e.restored_at is null $$;
create function pg_temp.merge(p_actor text, p_source text, p_target text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.merge_release(%1$L, %2$L, p ->> 'token', 'Provenance tests', null,
      array(select d ->> 'field' from jsonb_array_elements(p -> 'differences') d), true)::text
    from (select public.get_merge_preview(%1$L, %2$L) as p) x$q$, pg_temp.id(p_source), pg_temp.id(p_target))) $$;

-- e1, e2: catalog editors. a3, a4: admins. c5: a collector who submits. e6: an editor
-- whose TOTP verification is 11 minutes old. a7: such an admin. e8: an editor whose
-- account is deleted.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['e1', 'e2', 'a3', 'a4', 'c5', 'e6', 'a7', 'e8']) as s;
update public.profiles set handle = 'prv_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['e1', 'e2', 'a3', 'a4', 'c5', 'e6', 'a7', 'e8']) s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('e2'), 'catalog_editor'), (pg_temp.u('a3'), 'admin'), (pg_temp.u('a4'), 'admin'),
  (pg_temp.u('e6'), 'catalog_editor'), (pg_temp.u('a7'), 'admin'), (pg_temp.u('e8'), 'catalog_editor');

-- Writes as the signed-in caller through a definer path, as a function would, to show
-- what the triggers do whichever function is used.
create function pg_temp.definer_insert_game(p_title text) returns text language plpgsql security definer as $$
begin
  insert into public.games (title, sort_title, kind, status) values (p_title, p_title, 'game', 'under_review');
  return 'inserted';
end $$;
create function pg_temp.definer_verify_game(p_game uuid) returns text language plpgsql security definer as $$
begin
  update public.games set verified_at = now(), verified_by = (select auth.uid()) where id = p_game;
  return 'verified';
end $$;
create function pg_temp.definer_publish_pairing(p_game uuid) returns text language plpgsql security definer as $$
begin
  update public.game_platforms set status = 'published' where game_id = p_game;
  return 'published';
end $$;
grant execute on function pg_temp.definer_insert_game(text), pg_temp.definer_verify_game(uuid), pg_temp.definer_publish_pairing(uuid) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 1. Schema and access
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_tables where schemaname = 'private' and tablename in ('catalog_record_origins', 'catalog_verifications')), 2,
  'provenance and verifications are private tables');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r,
             unnest(array['private.catalog_record_origins', 'private.catalog_verifications']) t,
             unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
           where has_table_privilege(r, t, p)), 0, 'no client role, nor the importer, has any privilege on them');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r, unnest(array[
    'private.legacy_catalog_origin(text,uuid)', 'private.record_origin(text,uuid)', 'private.verification_current(text,uuid,bigint,timestamptz)',
    'private.created_by(uuid,uuid[],uuid[])', 'private.cascade_games(jsonb)', 'private.provenance_note(text,uuid)', 'private.release_verification_ends(uuid)',
    'private.record_review(text,uuid,public.catalog_status,bigint,timestamptz,uuid)', 'private.record_catalog_origin()', 'private.guard_catalog_record_origin()',
    'private.sync_catalog_verification()', 'private.bump_game_revision()', 'private.guard_pairing_publication()']) f
  where has_function_privilege(r, f, 'execute')), 0, 'and none can execute the new helpers');
select is((select string_agg(c.relname || '.' || t.tgname, ',' order by c.relname, t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where t.tgname in ('record_catalog_origin', 'sync_catalog_verification', 'guard_catalog_record_origin', 'guard_pairing_publication', 'bump_game_revision') and not t.tgisinternal),
  'catalog_record_origins.guard_catalog_record_origin,game_aliases.bump_game_revision,game_platforms.guard_pairing_publication,game_relations.bump_game_revision,games.record_catalog_origin,games.sync_catalog_verification,releases.record_catalog_origin,releases.sync_catalog_verification',
  'the triggers are in place');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r where has_schema_privilege(r, 'private', 'usage')), 0,
  'the private schema isn''t usable by any client role');

-- ---------------------------------------------------------------------------
-- 2. Provenance, from trusted context
-- ---------------------------------------------------------------------------
select pg_temp.game('e1', 'g', 'Prv Lantern Path');
select pg_temp.release('e1', 'r', 'g', 'ntsc-uc', 'PRV-1');
select is(pg_temp.origin('g'), 'staff/e1', 'a game an editor creates records them as its creator');
select is(pg_temp.origin('r'), 'staff/e1', 'and so does a release');
select pg_temp.keep('sub', pg_temp.as_user('c5', $$select public.submit_game('Prv Member Quest', 'game', null, 'snes', 'rom-cartridge', 'pal', '{"product_code": "PRV-S1"}', '[]', null, true) ->> 'submission_id'$$));
insert into ids select 'sg', game_id from public.catalog_change_requests where id = pg_temp.id('sub');
insert into ids select 'sr', release_id from public.catalog_change_requests where id = pg_temp.id('sub');
select is(pg_temp.origin('sg') || ' ' || pg_temp.origin('sr'), 'submission/c5 submission/c5', 'a member''s submission records them as the creator of its game and release');
insert into public.games (title, sort_title, kind, status) values ('Prv Operator Entry', 'Prv Operator Entry', 'game', 'under_review');
insert into ids select 'sys', id from public.games where title = 'Prv Operator Entry';
select is(pg_temp.origin('sys'), 'system/-', 'a maintenance session''s record is the system''s, with no creator');
select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', repeat('7', 64), 'Provenance tests') is null as cleared;
-- An import run, as the importer's own role. The test may set that role only for this
-- transaction, which rolls back.
grant catalog_importer to postgres with set true;
-- The importer has no signed-in user.
select set_config('request.jwt.claims', '', true) is not null as signed_out;
grant execute on function pg_temp.u(text), pg_temp.id(text), pg_temp.keep(text, text) to catalog_importer;
grant all on ids to catalog_importer;
set local role catalog_importer;
select pg_temp.keep('run', (select catalog_import.start_run('wikidata', 'snes', 'prv.json', repeat('d', 64), now(), repeat('7', 64), 'Provenance tests', pg_temp.u('f1'))::text));
select (catalog_import.stage_records(pg_temp.id('run'), pg_temp.u('f1'), '[{"entity_type": "game", "external_id": "QPRV1", "payload": {"title": "Prv Imported Dawn"}}]', null)) is not null as staged;
reset role;
insert into ids select 'prec', id from private.provider_records where external_id = 'QPRV1';
set local role catalog_importer;
select (catalog_import.apply_record(pg_temp.id('run'), pg_temp.u('f1'), pg_temp.id('prec'), null)) is not null as applied;
reset role;
insert into ids select 'imp', matched_game_id from private.provider_records where external_id = 'QPRV1';
select is(pg_temp.origin('imp'), 'import/-', 'the importer''s record is an import, with no creator');
select is((select count(*)::int from unnest(array['authenticator', 'anon', 'authenticated', 'service_role']) r where pg_has_role(r, 'catalog_importer', 'member')), 0, 'no client role can become the importer');
select is(pg_temp.as_user('c5', $$select pg_temp.definer_insert_game('Prv Smuggled')$$), 'error: not permitted', 'a client who is neither staff nor the submitter can''t create a record, whatever the path');
select is(pg_temp.as_anon($$select pg_temp.definer_insert_game('Prv Smuggled')$$), 'error: not permitted', 'nor can anon');
select is(pg_temp.as_user('e1', $$select pg_temp.definer_insert_game('Prv Direct')$$), 'inserted', 'a staff member''s insert by any path');
select is((select o.origin || '/' || right(o.creator_id::text, 2) from private.catalog_record_origins o join public.games g on g.id = o.game_id where g.title = 'Prv Direct'), 'staff/e1',
  'is still recorded as theirs');

-- ---------------------------------------------------------------------------
-- 3. Provenance can't be changed
-- ---------------------------------------------------------------------------
select throws_ok(format($$update private.catalog_record_origins set origin = 'import' where game_id = %L$$, pg_temp.id('g')), 'P0001', 'provenance is permanent', 'its origin can''t be changed, even by the owner');
select throws_ok(format($$update private.catalog_record_origins set creator_id = %L where game_id = %L$$, pg_temp.u('e2'), pg_temp.id('g')), 'P0001', 'provenance is permanent', 'nor its creator');
select throws_ok(format($$update private.catalog_record_origins set creator_id = null where game_id = %L$$, pg_temp.id('g')), 'P0001', 'provenance is permanent', 'nor cleared while the creator''s account exists');
select throws_ok(format($$delete from private.catalog_record_origins where game_id = %L$$, pg_temp.id('g')), 'P0001', 'provenance is permanent', 'and it can''t be removed while its record exists');
select is(pg_temp.as_user('e1', 'select count(*)::text from private.catalog_record_origins'), 'error: permission denied for schema private', 'the creator can''t read or reach it');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"origin": "import"}', 'Provenance tests')::text$$, pg_temp.id('r'))), 'error: invalid changes', 'nor write it through an edit');
select is(pg_temp.as_user('e1', format($$select public.update_game(%L, '{"submitted_by": null, "verified_by": null}', 'Provenance tests')::text$$, pg_temp.id('g'))), 'error: invalid changes', 'or change who submitted or verified a record');

-- ---------------------------------------------------------------------------
-- 4. No self-review (D2), with no administrator bypass
-- ---------------------------------------------------------------------------
select is(pg_temp.verify_game('e1', 'g'), 'error: own record', 'the creator can''t verify their game');
select is(pg_temp.verify_release('e1', 'r'), 'error: own record', 'or their release');
select pg_temp.game('a3', 'ga', 'Prv Admin Atlas');
select pg_temp.release('a3', 'ra', 'ga', 'ntsc-uc', 'PRV-A1');
select is(pg_temp.verify_game('a3', 'ga'), 'error: own record', 'an administrator can''t verify their own record either');
select is(pg_temp.verify_game('e2', 'g') || pg_temp.verify_release('e2', 'r'), 'truetrue', 'another editor verifies them');
select is(pg_temp.publish('e1', 'r'), 'error: own record', 'the creator can''t publish their release, verified by someone else');
-- Indirect publication: e2 creates a release of e1's unpublished game, e1 verifies it.
select pg_temp.release('e2', 'r2', 'g', 'pal', 'PRV-2');
select is(pg_temp.verify_release('e1', 'r2'), 'true', 'the game''s creator may verify someone else''s release of it');
select is(pg_temp.publish('e1', 'r2'), 'error: own record', 'but not publish it, as that would publish their own game');
select is(pg_temp.status('g') || '/' || pg_temp.status('r2'), 'under_review/under_review', 'and nothing was published');
select is(pg_temp.publish('e2', 'r2'), 'error: own record', 'nor can the release''s own creator');
select is(pg_temp.publish('a3', 'r2'), 'true', 'someone who created neither publishes it');
select is(pg_temp.status('g') || '/' || pg_temp.status('r2'), 'published/published', 'with its game');
select is(pg_temp.publish('e2', 'r'), 'true', 'then e1''s own release, by another editor');
select is(pg_temp.verify_game('e2', 'ga') || pg_temp.verify_release('e2', 'ra') || pg_temp.publish('e2', 'ra'), 'truetruetrue', 'and the administrator''s record, by someone else');
-- A record its creator verified before M10c.
select pg_temp.release('e1', 'r3', 'g', 'ntsc-j', 'PRV-3');
update public.releases set verified_at = now(), verified_by = pg_temp.u('e1') where id = pg_temp.id('r3');
select is(pg_temp.publish('e2', 'r3'), 'error: verification required', 'a record its creator verified can''t be published by anyone');
delete from private.catalog_verifications where release_id = pg_temp.id('r3');
select is(pg_temp.verify_release('e2', 'r3') || pg_temp.publish('e2', 'r3'), 'truetrue', 'until someone else verifies it');
-- A verification by someone whose account is gone.
select pg_temp.release('e1', 'r4', 'g', 'asia', 'PRV-4');
select is(pg_temp.verify_release('e2', 'r4'), 'true', 'a release is verified');
update public.releases set verified_by = null where id = pg_temp.id('r4');
select is(pg_temp.publish('e2', 'r4'), 'error: verification required', 'a verifier who can''t be known doesn''t count');
select is(pg_temp.as_user('e1', $$select pg_temp.definer_verify_game((select id from public.games where title = 'Prv Direct'))$$), 'error: own record',
  'the database refuses the creator, whichever function verifies');
-- Submissions keep their rule.
insert into public.staff_roles (user_id, role) values (pg_temp.u('c5'), 'catalog_editor');
select is(pg_temp.as_user('c5', format('select public.start_submission_review(%L, %s, ''Own'')::text', pg_temp.id('sub'), pg_temp.ver('sub'))),
  'error: own submission', 'a member who becomes staff still can''t review their own submission');
delete from public.staff_roles where user_id = pg_temp.u('c5');

-- ---------------------------------------------------------------------------
-- 5. Unknown provenance fails closed (D-2)
-- ---------------------------------------------------------------------------
select pg_temp.game('e1', 'gu', 'Prv Unknown Origin');
select pg_temp.release('e1', 'ru', 'gu', 'ntsc-uc', 'PRV-U1');
set local session_replication_role = replica;
delete from private.catalog_record_origins where game_id = pg_temp.id('gu') or release_id = pg_temp.id('ru');
set local session_replication_role = origin;
insert into private.catalog_record_origins (game_id, origin) values (pg_temp.id('gu'), 'unknown');
select is(pg_temp.verify_game('e2', 'gu'), 'error: provenance unknown', 'an editor can''t verify a record of unknown provenance');
select is(pg_temp.verify_release('e2', 'ru'), 'error: provenance unknown', 'nor one with no provenance at all');
select is(pg_temp.verify_game('a3', 'gu') || pg_temp.verify_release('a3', 'ru'), 'truetrue', 'an administrator may');
select is((select metadata ->> 'provenance' from private.audit_events where action = 'catalog_record_verified' and metadata ->> 'id' = pg_temp.id('gu')::text), 'unknown',
  'and the audit row says the provenance was unknown');
select is(pg_temp.publish('a3', 'ru'), 'error: independent review required', 'but not also publish what they verified');
select is(pg_temp.publish('e2', 'ru'), 'error: provenance unknown', 'nor can an editor publish it');
select is(pg_temp.publish('a4', 'ru'), 'true', 'a second administrator publishes it');
select is((select count(*)::int from private.audit_events where action = 'catalog_record_published' and metadata ->> 'provenance' = 'unknown'
  and metadata ->> 'id' in (pg_temp.id('gu')::text, pg_temp.id('ru')::text)), 2, 'both publications are audited as unknown provenance');

-- ---------------------------------------------------------------------------
-- 6. Legacy records: what the backfill finds
-- ---------------------------------------------------------------------------
insert into public.games (id, title, sort_title, kind, status) values
  (pg_temp.u('d1'), 'Prv Legacy Staff', 'Prv Legacy Staff', 'game', 'under_review'),
  (pg_temp.u('d2'), 'Prv Legacy Gone', 'Prv Legacy Gone', 'game', 'under_review'),
  (pg_temp.u('d3'), 'Prv Legacy Import', 'Prv Legacy Import', 'game', 'under_review'),
  (pg_temp.u('d4'), 'Prv Legacy Bare', 'Prv Legacy Bare', 'game', 'under_review'),
  (pg_temp.u('d5'), 'Prv Legacy Nobody', 'Prv Legacy Nobody', 'game', 'under_review');
insert into private.audit_events (actor_id, action, reason, metadata) values
  (pg_temp.u('e2'), 'catalog_record_created', 'Legacy', jsonb_build_object('entity', 'game', 'id', pg_temp.u('d1'))),
  (pg_temp.u('99'), 'catalog_record_created', 'Legacy', jsonb_build_object('entity', 'game', 'id', pg_temp.u('d2'))),
  (null, 'catalog_record_created', 'Legacy', jsonb_build_object('entity', 'game', 'id', pg_temp.u('d3'), 'import_run_id', pg_temp.u('98'))),
  (null, 'catalog_record_created', 'Legacy', jsonb_build_object('entity', 'game', 'id', pg_temp.u('d4')));
select is((select string_agg(o.origin || ':' || coalesce(right(o.creator_id::text, 2), '-') || ':' || o.creator_removed, ',' order by x.id)
  from unnest(array[pg_temp.u('d1'), pg_temp.u('d2'), pg_temp.u('d3'), pg_temp.u('d4'), pg_temp.u('d5')]) x(id)
  cross join lateral private.legacy_catalog_origin('game', x.id) o),
  'staff:e2:false,staff:-:true,import:-:false,unknown:-:false,unknown:-:false',
  'a staff creator, a staff creator since deleted, an import with its run, and no evidence (twice) are told apart');
select is((select string_agg(o.origin || ':' || coalesce(right(o.creator_id::text, 2), '-') || ':' || o.creator_removed, ',')
  from private.legacy_catalog_origin('release', pg_temp.id('sr')) o), 'submission:c5:false', 'a submission is found from its request');
update public.catalog_change_requests set submitted_by = null where id = pg_temp.id('sub');
select is((select string_agg(o.origin || ':' || coalesce(right(o.creator_id::text, 2), '-') || ':' || o.creator_removed, ',')
  from private.legacy_catalog_origin('game', pg_temp.id('sg')) o), 'submission:c5:false', 'or from its audit row, when the request no longer names the submitter');

-- ---------------------------------------------------------------------------
-- 7. Merges and exclusions of the caller's own records (D-4)
-- ---------------------------------------------------------------------------
select is(pg_temp.exclude('e1', 'r'), 'error: own record', 'the creator can''t exclude their release');
select ok(pg_temp.exclude('e2', 'r3') like '{%', 'another editor can');
select is(pg_temp.restore('e1', 'r3'), 'error: not permitted', 'only an administrator restores');
select pg_temp.release('e2', 'rb', 'ga', 'pal', 'PRV-A2');
select is(pg_temp.verify_release('e1', 'rb') || pg_temp.publish('e1', 'rb'), 'truetrue', 'a second release of the administrator''s game is published');
select is(pg_temp.merge('a3', 'rb', 'ra'), 'error: own record', 'an administrator can''t merge into a release they created');
select is(pg_temp.merge('a3', 'ra', 'rb'), 'error: own record', 'or merge it away');
select ok(pg_temp.merge('a4', 'rb', 'ra') like '{%', 'another administrator can');
select pg_temp.release('a3', 'rc', 'ga', 'ntsc-j', 'PRV-A3');
select is(pg_temp.verify_release('e2', 'rc') || pg_temp.publish('e2', 'rc'), 'truetrue', 'another of the administrator''s releases is published');
select ok(pg_temp.exclude('e1', 'rc') like '{%', 'an editor excludes it');
select is(pg_temp.restore('a3', 'rc'), 'error: own record', 'and its creator can''t restore it');
select ok(pg_temp.restore('a4', 'rc') like '{%', 'another administrator can');

-- ---------------------------------------------------------------------------
-- 8. A verification is bound to the revision it attested (D-7)
-- ---------------------------------------------------------------------------
select pg_temp.game('e1', 'g2', 'Prv Second Wind');
select pg_temp.release('e1', 'r5', 'g2', 'ntsc-uc', 'PRV-5');
select is(pg_temp.verify_game('e2', 'g2') || pg_temp.verify_release('e2', 'r5'), 'truetrue', 'a game and release are verified');
select is((select revision from private.catalog_verifications where release_id = pg_temp.id('r5')), pg_temp.rrev('r5'), 'the verification keeps the revision it attested');
select is(pg_temp.verify_release('e2', 'r5'), 'false', 'verifying again changes nothing while it''s current');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"publisher_name": "Lumen Works"}', 'Provenance tests')::text$$, pg_temp.id('r5'))), 'true', 'a descriptive edit');
select is(pg_temp.verified('r5'), false, 'ends the release''s verification');
select is((select (metadata ->> 'verification_cleared')::boolean from private.audit_events where action = 'catalog_record_updated' and metadata ->> 'id' = pg_temp.id('r5')::text order by id desc limit 1),
  true, 'and the audit row says so');
select is(pg_temp.verify_release('e2', 'r5') || pg_temp.as_user('e1', format($$select public.set_release_markets(%L, array['US'], 'Provenance tests')::text$$, pg_temp.id('r5'))), 'truetrue', 'markets are recorded after a new verification');
select is(pg_temp.verified('r5'), false, 'which ends it too');
select is(pg_temp.as_user('e1', format($$select (public.add_game_alias(%L, 'Prv Second Breath', 'alternate', null, null, 'Provenance tests') is not null)::text$$, pg_temp.id('g2'))), 'true', 'an alias is added to the verified game');
select is(pg_temp.verified('g2'), false, 'which ends the game''s verification');
select pg_temp.game('e1', 'g3', 'Prv Second Wind Again');
select is(pg_temp.verify_game('e2', 'g2') || pg_temp.verify_game('e2', 'g3'), 'truetrue', 'two games are verified');
select is(pg_temp.as_user('e1', format($$select public.set_game_relation(%L, %L, 'remake_of', null, null, 'Provenance tests')::text$$, pg_temp.id('g3'), pg_temp.id('g2'))), 'true', 'a relation between them');
select is(pg_temp.verified('g2')::text || pg_temp.verified('g3')::text, 'falsefalse', 'ends both verifications');
select is(pg_temp.verify_game('e2', 'g2') || pg_temp.verify_game('e2', 'g3') || pg_temp.verify_release('e2', 'r5'), 'truetruetrue', 'they''re verified again');
-- A change of status raises the revision without ending the verification.
update public.releases set status = 'unverified' where id = pg_temp.id('r5');
update public.releases set status = 'under_review' where id = pg_temp.id('r5');
select is(pg_temp.verified('r5'), true, 'a status change keeps the verification');
select is(pg_temp.publish('e2', 'r5'), 'error: verification stale', 'but it no longer matches the revision, so publication is refused');
select is(pg_temp.verify_release('e2', 'r5'), 'true', 'a stale verification is replaced, not taken as current');
select is(pg_temp.publish('e2', 'r5'), 'true', 'then the release and its game are published');
select is(pg_temp.verify_release('e2', 'r5'), 'false', 'a published record isn''t verified again');
select is(pg_temp.as_user('e2', format($$select count(*)::text from private.catalog_verifications where release_id = %L$$, pg_temp.id('r5'))), 'error: permission denied for schema private',
  'no client can read or write a verification''s revision');

-- ---------------------------------------------------------------------------
-- 9. Recent MFA (D3): e6 and a7 verified TOTP 11 minutes ago
-- ---------------------------------------------------------------------------
select pg_temp.game('e1', 'g4', 'Prv Fresh Check');
select pg_temp.release('e1', 'r7', 'g4', 'ntsc-uc', 'PRV-7');
select is(pg_temp.verify_game('e6', 'g4'), 'error: reauthentication required', 'verifying a game needs a recent TOTP verification');
select is(pg_temp.verify_release('e6', 'r7'), 'error: reauthentication required', 'so does verifying a release');
select is(pg_temp.verify_game('e2', 'g4') || pg_temp.verify_release('e2', 'r7'), 'truetrue', 'which a recent one allows');
select is(pg_temp.publish('e6', 'r7'), 'error: reauthentication required', 'publishing needs one too');
-- Each function asks first, before its own checks, not only the guard at the update.
select pg_temp.keep('r8', pg_temp.as_user('e1', format('select public.create_release(%L, (select id from public.platforms where slug = ''snes''), ''rom-cartridge'', ''pal'', ''{}'', ''Provenance tests'')::text', pg_temp.id('g4'))));
select is(pg_temp.verify_release('e6', 'r8'), 'error: reauthentication required', 'verification asks before finding the release incomplete');
select is(pg_temp.publish('e6', 'r8'), 'error: reauthentication required', 'publication asks before finding it unverified');
select is(pg_temp.as_user('e6', format('select public.approve_submission(%L, 999, %s, %s, ''Approved'', null)::text', pg_temp.id('sub'), pg_temp.rrev('sr'), pg_temp.grev('sg'))),
  'error: reauthentication required', 'approval asks before checking the submission''s version');
select is(pg_temp.status('r7'), 'under_review', 'and nothing changed');
select is(pg_temp.as_aal1('e2', format('select public.verify_release(%L, ''Checked'', %s)::text', pg_temp.id('r7'), pg_temp.rrev('r7'))), 'error: not permitted', 'without MFA at all, a staff member has no staff access');
select is(pg_temp.as_user('e2', format('select public.start_submission_review(%L, %s, ''Review'')::text', pg_temp.id('sub'), pg_temp.ver('sub'))) ~ '^[0-9]+$', true,
  'starting a review needs only a live session');
select is(pg_temp.as_user('e6', format('select public.approve_submission(%L, %s, %s, %s, ''Approved'', null)::text',
  pg_temp.id('sub'), pg_temp.ver('sub'), pg_temp.rrev('sr'), pg_temp.grev('sg'))), 'error: reauthentication required', 'approving a submission needs a recent TOTP verification');
select is(pg_temp.as_user('e6', format($$select public.update_game(%L, '{"summary": "Unpublished edit."}', 'Provenance tests')::text$$, pg_temp.id('g4'))), 'true', 'editing an unpublished game needs only a live session');
select is(pg_temp.as_user('e6', format($$select public.update_game(%L, '{"summary": "Published edit."}', 'Provenance tests')::text$$, pg_temp.id('g'))), 'error: reauthentication required', 'editing a published game needs a recent one');
select is(pg_temp.as_user('e6', format($$select public.update_release(%L, '{"publisher_name": "Lumen Works"}', 'Provenance tests')::text$$, pg_temp.id('r'))), 'error: reauthentication required', 'so does editing a published release');
select is(pg_temp.as_user('e6', format($$select public.set_release_markets(%L, array['US'], 'Provenance tests')::text$$, pg_temp.id('r'))), 'error: reauthentication required', 'its markets');
select is(pg_temp.as_user('e6', format($$select public.set_release_components(%L, '[{"kind": "insert", "label": "Manual"}]', 'Provenance tests')::text$$, pg_temp.id('r'))), 'error: reauthentication required', 'its pieces');
select is(pg_temp.as_user('e6', format($$select public.set_release_requirements(%L, '[]', 'Provenance tests')::text$$, pg_temp.id('r'))), 'error: reauthentication required', 'its requirements');
select is(pg_temp.as_user('e6', format($$select public.add_game_alias(%L, 'Prv Lantern Road', 'alternate', null, null, 'Provenance tests')::text$$, pg_temp.id('g'))), 'error: reauthentication required', 'a published game''s aliases');
select pg_temp.keep('alias', pg_temp.as_user('e2', format($$select public.add_game_alias(%L, 'Prv Lantern Road', 'alternate', null, null, 'Provenance tests')::text$$, pg_temp.id('g'))));
select is(pg_temp.as_user('e6', format($$select public.remove_game_alias(%L, 'Provenance tests')::text$$, pg_temp.id('alias'))), 'error: reauthentication required', 'removing one');
select is(pg_temp.as_user('e6', format($$select public.set_game_relation(%L, %L, 'remake_of', null, null, 'Provenance tests')::text$$, pg_temp.id('g'), pg_temp.id('ga'))), 'error: reauthentication required', 'and a relation between published games');
select is(pg_temp.as_user('e6', format($$select public.set_game_relation(%L, %L, 'remake_of', null, null, 'Provenance tests')::text$$, pg_temp.id('g4'), pg_temp.id('g3'))), 'true', 'but not one between unpublished games');
select is(pg_temp.exclude('e6', 'r2'), 'error: reauthentication required', 'excluding a published release needs a recent TOTP verification (D-5)');
select is(pg_temp.restore('a7', 'r3'), 'error: reauthentication required', 'so does restoring one as published');
select ok(pg_temp.restore('a3', 'r3') like '{%', 'which a recent one allows');
select is(pg_temp.as_user('e6', format('select pg_temp.definer_verify_game(%L)', pg_temp.id('g4'))), 'error: reauthentication required', 'the database refuses a stale verification, whichever function makes it (D-8)');
select is(pg_temp.as_user('e6', format('select pg_temp.definer_publish_pairing(%L)', pg_temp.id('g4'))), 'error: reauthentication required', 'and a stale publication of a platform pairing');

-- ---------------------------------------------------------------------------
-- 10. A creator's account is deleted
-- ---------------------------------------------------------------------------
select pg_temp.game('e8', 'gd', 'Prv Departed');
select lives_ok(format('delete from auth.users where id = %L', pg_temp.u('e8')), 'the creator''s account can be deleted');
select is(pg_temp.origin('gd'), 'staff/removed', 'the record keeps that a staff member created it, without their id');
select is(pg_temp.verify_game('e2', 'gd'), 'true', 'and another editor can review it');
select is((select count(*)::int from private.audit_events where actor_id = pg_temp.u('e8') and action = 'catalog_record_created'), 1, 'the audit log keeps its plain id, as for every account (M4-D10)');
select lives_ok(format('delete from public.games where id = %L', pg_temp.id('sys')), 'a record can still be deleted by maintenance');
select is((select count(*)::int from private.catalog_record_origins where game_id = pg_temp.id('sys')), 0, 'and its provenance goes with it');

-- ---------------------------------------------------------------------------
-- 11. The record pages' review flags name nobody
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('e1', format('select (public.get_game_record(%L) -> ''review'')::text', pg_temp.id('g4'))),
  '{"origin": "staff", "you_created": true, "you_verified": false, "verification_current": false}', 'the creator sees that they created the record, and that its verification ended with the last edit');
select is(pg_temp.as_user('e2', format('select (public.get_release_record(%L) -> ''review'')::text', pg_temp.id('r7'))),
  '{"origin": "staff", "you_created": false, "you_verified": true, "verification_current": true}', 'the verifier sees that they verified it, and nothing about anyone else');

select * from finish();
rollback;
