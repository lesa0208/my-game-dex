-- M5a: catalog schema, editor operations, verification, publication and access.
-- Races are in db-catalog-checks.mjs. Deferred publication rules are checked here
-- with SET CONSTRAINTS ALL IMMEDIATE, because this file runs in one transaction.
begin;
create extension if not exists pgtap with schema extensions;
select plan(139);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated, anon;

-- Runs a statement as a signed-in user, or as anon when p_actor is null, and returns
-- its result or the error as text.
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
  return 'error: ' || sqlerrm;
end $t$;

create temp table ids (name text primary key, id uuid not null);
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
create function pg_temp.keep(p text, v text) returns text language plpgsql as $$
begin
  insert into ids values (p, v::uuid);
  return v;
exception when others then
  return 'error: ' || coalesce(v, 'null');
end $$;
create function pg_temp.platform(p text) returns uuid language sql stable as $$ select id from public.platforms where slug = p $$;
create function pg_temp.audits(p text) returns int language sql as $$ select count(*)::int from private.audit_events where action::text = p $$;

-- e1: catalog editor. a2: admin. c3: ordinary user. d4: moderator. b5: editor, later
-- suspended. a6: editor, later revoked. f7: editor role but an unverified email.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', case when s = 'f7' then null else now() end, '00000000-0000-0000-0000-000000000000'
from unnest(array['e1', 'a2', 'c3', 'd4', 'b5', 'a6', 'f7']) as s;
update public.profiles set handle = 'cat_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['e1', 'a2', 'c3', 'd4', 'b5', 'a6', 'f7']) as s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('a2'), 'admin'), (pg_temp.u('d4'), 'moderator'),
  (pg_temp.u('b5'), 'catalog_editor'), (pg_temp.u('a6'), 'catalog_editor'), (pg_temp.u('f7'), 'catalog_editor');

-- ---------------------------------------------------------------------------
-- Schema and access
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('games', 'game_platforms', 'game_relations', 'releases', 'release_markets', 'release_components', 'release_hardware_requirements')
    and c.relrowsecurity), 7, 'the seven public catalog tables exist, with RLS');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['games', 'game_platforms', 'game_relations', 'releases', 'release_markets', 'release_components', 'release_hardware_requirements']) t,
    unnest(array['insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
  where has_table_privilege(r, 'public.' || t, p)), 0, 'no API role can write any catalog table');
select is((select count(*)::int from unnest(array['games', 'game_platforms', 'game_relations', 'releases', 'release_markets', 'release_components', 'release_hardware_requirements']) t
  where has_table_privilege('service_role', 'public.' || t, 'select') or has_any_column_privilege('service_role', 'public.' || t, 'select')), 0, 'service_role can''t read the catalog');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['external_providers', 'import_runs', 'provider_records', 'external_references', 'release_evidence', 'catalog_field_locks']) t,
    unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
  where has_table_privilege(r, 'private.' || t, p)), 0, 'no API role has any privilege on provenance tables');
select is((select count(*)::int from unnest(array['anon', 'authenticated']) r, unnest(array['public.games', 'public.releases']) t, unnest(array['submitted_by', 'verified_by']) c
  where has_column_privilege(r, t, c, 'select')), 0, 'clients can''t read who submitted or verified a record');
select is((select count(*)::int from unnest(array['anon', 'authenticated']) r where has_column_privilege(r, 'public.games', 'title', 'select') and has_column_privilege(r, 'public.releases', 'product_code', 'select')),
  2, 'clients can read the public columns');

create temp table editor_functions (sig text);
insert into editor_functions values
  ('public.create_game(text,public.game_kind,text,text,date,public.date_precision,text)'), ('public.update_game(uuid,jsonb,text)'), ('public.verify_game(uuid,text)'),
  ('public.set_game_platform(uuid,uuid,text)'), ('public.set_game_relation(uuid,uuid,public.game_relation_type,smallint,text,text)'),
  ('public.create_release(uuid,uuid,text,text,jsonb,text)'), ('public.update_release(uuid,jsonb,text)'), ('public.set_release_markets(uuid,text[],text)'),
  ('public.set_release_components(uuid,jsonb,text)'), ('public.set_release_requirements(uuid,jsonb,text)'), ('public.verify_release(uuid,text)'),
  ('public.publish_release(uuid,text)'), ('public.set_catalog_field_lock(text,uuid,text,boolean,text)');
select is((select count(*)::int from editor_functions f, unnest(array['anon', 'service_role']) r where has_function_privilege(r, f.sig, 'execute')), 0, 'anon and service_role can execute no editor function');
select is((select count(*)::int from editor_functions f where has_function_privilege('authenticated', f.sig, 'execute')), 13, 'signed-in users can call the 13 editor functions, which check the role');
select is((select count(*)::int from editor_functions f where (select p.prosrc from pg_proc p where p.oid = f.sig::regprocedure) not like '%v_me := private.begin_catalog_edit();%'),
  0, 'every editor function starts by locking and checking the caller');
select ok((select position('lock_catalog_edits' in prosrc) < position('require_active_staff' in prosrc) and position('require_active_staff' in prosrc) < position('for key share' in prosrc)
  from pg_proc where oid = 'private.begin_catalog_edit()'::regprocedure), 'the edit helper locks, then checks the caller, then locks the profile');
select ok((select prosrc like '%pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(''staff-changes'', 0))%' from pg_proc where oid = 'private.lock_catalog_edits()'::regprocedure)
  and (select prosrc like '%pg_advisory_xact_lock(pg_catalog.hashtextextended(''staff-changes'', 0))%' from pg_proc where oid = 'private.lock_staff_changes()'::regprocedure),
  'catalog edits share the staff lock that staff changes take exclusively');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array[
    'private.lock_catalog_edits()', 'private.begin_catalog_edit()', 'private.record_catalog_audit(uuid,private.audit_action,text,uuid,text,jsonb)',
    'private.change_keys(jsonb,text[])', 'private.assign_game_slug(text)', 'private.lock_release_for_edit(uuid,text)', 'private.clear_release_verification(uuid)',
    'private.check_catalog_publication()', 'private.game_has_published_release(uuid)', 'private.guard_published_catalog_row()', 'private.validate_release_evidence()']) f
  where has_function_privilege(r, f, 'execute')), 0, 'no API role can execute a catalog helper');

-- Neo Geo MVS
select is((select kind::text || '/' || family from public.platforms where slug = 'neo-geo-mvs'), 'other/Neo Geo', 'Neo Geo MVS is its own platform, of kind other');
select is((select array_agg(p.slug order by p.slug) from public.platform_media_formats m join public.platforms p on p.id = m.platform_id where m.media_format_code = 'neo-geo-mvs-cartridge'),
  array['neo-geo-mvs'], 'only MVS uses the MVS cartridge format');
select is((select array_agg(media_format_code order by media_format_code) from public.platform_media_formats where platform_id = pg_temp.platform('neo-geo-mvs')),
  array['neo-geo-mvs-cartridge'], 'MVS uses only its own cartridge format');
select is((select count(*)::int from public.platforms where slug = 'neo-geo-aes' and notes like '%out of scope%'), 0, 'the AES note no longer calls MVS out of scope');

-- ---------------------------------------------------------------------------
-- Who can edit
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('c3', $$select public.create_game('Gradius III', 'game', p_reason => 'Fixture')::text$$), 'error: not permitted', 'an ordinary user can''t create a game');
select is(pg_temp.as_user('d4', $$select public.create_game('Gradius III', 'game', p_reason => 'Fixture')::text$$), 'error: not permitted', 'a moderator can''t create a game');
select is(pg_temp.as_user('f7', $$select public.create_game('Gradius III', 'game', p_reason => 'Fixture')::text$$), 'error: not permitted', 'an editor without a verified email can''t create a game');
select is(pg_temp.as_user(null, $$select public.create_game('Gradius III', 'game', p_reason => 'Fixture')::text$$), 'error: permission denied for function create_game', 'anon can''t call editor functions');
select is(pg_temp.as_user('e1', $$select public.create_game('Gradius III', 'game')::text$$), 'error: reason required', 'an editor must give a reason to create a game');
select is(pg_temp.as_user('e1', $$select public.create_game('Gradius III', 'game', p_reason => '   ')::text$$), 'error: reason required', 'and a blank one isn''t a reason');
select is(pg_temp.audits('catalog_record_created'), 0, 'refused calls record nothing');
select ok(pg_temp.keep('g1', pg_temp.as_user('e1', $$select public.create_game('Super Metroid', 'game', null, null, '1994-03-19', 'day', p_reason => 'Fixture')::text$$)) not like 'error%', 'a catalog editor creates a game');
select ok(pg_temp.keep('g2', pg_temp.as_user('a2', $$select public.create_game('Pulstar', 'game', p_reason => 'Fixture')::text$$)) not like 'error%', 'an admin creates a game');
select is((select status::text || '/' || sort_title || '/' || coalesce(verified_at::text, 'unverified') from public.games where id = pg_temp.id('g1')),
  'under_review/Super Metroid/unverified', 'a new game is under review and unverified');

-- ---------------------------------------------------------------------------
-- Unpublished records are private
-- ---------------------------------------------------------------------------
select ok(pg_temp.keep('r1', pg_temp.as_user('e1', format($$select public.create_release(%L, %L, 'rom-cartridge', 'ntsc-uc', '{"product_code": "SNS-RI-USA", "languages": ["en"]}', p_reason => 'Fixture')::text$$,
  pg_temp.id('g1'), pg_temp.platform('snes')))) not like 'error%', 'an editor creates a release candidate');
select is(pg_temp.as_user('e1', format($$select public.set_release_markets(%L, array['US', 'CA'], p_reason => 'Fixture')::text$$, pg_temp.id('r1'))), 'true', 'an editor records its markets');
select is(pg_temp.as_user(null, format($$select count(*)::text from public.games where id = %L$$, pg_temp.id('g1'))), '0', 'anon can''t see an unpublished game');
select is(pg_temp.as_user(null, format($$select count(*)::text from public.releases where id = %L$$, pg_temp.id('r1'))), '0', 'anon can''t see an unpublished release');
select is(pg_temp.as_user(null, format($$select count(*)::text from public.release_markets where release_id = %L$$, pg_temp.id('r1'))), '0', 'anon can''t see its markets');
select is(pg_temp.as_user(null, format($$select count(*)::text from public.game_platforms where game_id = %L$$, pg_temp.id('g1'))), '0', 'anon can''t see the unpublished platform pairing');
select is(pg_temp.as_user('c3', format($$select count(*)::text from public.releases where id = %L$$, pg_temp.id('r1'))), '0', 'an ordinary user can''t see it');
select is(pg_temp.as_user('d4', format($$select count(*)::text from public.games where id = %L$$, pg_temp.id('g1'))), '0', 'a moderator can''t see it');
select is(pg_temp.as_user('e1', format($$select count(*)::text from public.release_markets where release_id = %L$$, pg_temp.id('r1'))), '2', 'an editor sees the candidate and its markets');
select is(pg_temp.as_user('a2', format($$select count(*)::text from public.releases where id = %L$$, pg_temp.id('r1'))), '1', 'an admin sees it');

-- ---------------------------------------------------------------------------
-- Nothing is invented, and physical identity is enforced
-- ---------------------------------------------------------------------------
select is((select concat_ws('/', coalesce(edition_name, '-'), coalesce(edition_kind::text, '-'), coalesce(media_count::text, '-'), media_playability, release_date_precision)
  from public.releases where id = pg_temp.id('r1')), '-/-/-/unknown/unknown', 'a candidate has no edition, kind or medium count unless given');
select ok(pg_temp.keep('r2', pg_temp.as_user('e1', format($$select public.create_release(%L, %L, 'rom-cartridge', p_reason => 'Fixture')::text$$, pg_temp.id('g1'), pg_temp.platform('snes')))) not like 'error%',
  'an editor creates a second candidate without a region');
select is((select region_code || '/' || region_unknown_confirmed from public.releases where id = pg_temp.id('r2')), 'unknown/false', 'an unstated region is unknown, and unconfirmed');
select ok(pg_temp.as_user('e1', format($$select public.create_release(%L, %L, 'neo-geo-mvs-cartridge', p_reason => 'Fixture')::text$$, pg_temp.id('g1'), pg_temp.platform('snes')))
  like 'error: %releases_platform_id_media_format_code_fkey%', 'a release can''t use a format its platform doesn''t have');
select ok(pg_temp.as_user('e1', format($$select public.create_release(%L, %L, 'neo-geo-mvs-cartridge', p_reason => 'Fixture')::text$$, pg_temp.id('g2'), pg_temp.platform('neo-geo-aes')))
  like 'error: %releases_platform_id_media_format_code_fkey%', 'an AES release can''t be on an MVS cartridge');
select ok(pg_temp.keep('r3', pg_temp.as_user('a2', format($$select public.create_release(%L, %L, 'neo-geo-mvs-cartridge', 'asia', p_reason => 'Fixture')::text$$, pg_temp.id('g2'), pg_temp.platform('neo-geo-mvs')))) not like 'error%',
  'an MVS release uses the MVS cartridge');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"slug": "x"}', p_reason => 'Fixture')::text$$, pg_temp.id('r1'))), 'error: invalid changes', 'an unknown field is refused');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"status": "published"}', p_reason => 'Fixture')::text$$, pg_temp.id('r1'))), 'error: invalid changes', 'status can''t be set through an edit');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"verified_at": "2026-01-01"}', p_reason => 'Fixture')::text$$, pg_temp.id('r1'))), 'error: invalid changes', 'verification can''t be set through an edit');
select ok(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"barcode": "ABC123456"}', p_reason => 'Fixture')::text$$, pg_temp.id('r1'))) like 'error: %releases_barcode_check%', 'a barcode must be digits');
select ok(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"languages": ["English"]}', p_reason => 'Fixture')::text$$, pg_temp.id('r1'))) like 'error: %releases_languages_check%', 'languages must be language tags');
select ok(pg_temp.as_user('e1', format($$select public.create_release(%L, %L, 'rom-cartridge', 'pal', '{"region_unknown_confirmed": true}', p_reason => 'Fixture')::text$$, pg_temp.id('g1'), pg_temp.platform('snes')))
  like 'error: %releases_region_confirmation%', 'only an unknown region can be confirmed as unknown');
select is(pg_temp.as_user('e1', format($$select public.verify_release(%L, 'Checked')::text$$, pg_temp.id('r1'))), 'error: release incomplete', 'a release without an edition can''t be verified');
select is(pg_temp.as_user('e1', format($$select public.verify_release(%L, '')::text$$, pg_temp.id('r1'))), 'error: reason required', 'verification needs a reason');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}', p_reason => 'Fixture')::text$$, pg_temp.id('r1'))),
  'true', 'an editor sets the edition and medium count');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}', p_reason => 'Fixture')::text$$, pg_temp.id('r1'))),
  'false', 'repeating the same edit changes nothing');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}', p_reason => 'Fixture')::text$$, pg_temp.id('r2'))),
  'true', 'the second candidate gets an edition too');
select is(pg_temp.as_user('e1', format($$select public.verify_release(%L, 'Checked')::text$$, pg_temp.id('r2'))), 'error: release incomplete', 'an unknown region needs explicit confirmation');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"region_unknown_confirmed": true}', p_reason => 'Fixture')::text$$, pg_temp.id('r2'))), 'true', 'an editor confirms the region is unknown');
select is(pg_temp.as_user('e1', format($$select public.verify_release(%L, 'Region genuinely unknown')::text$$, pg_temp.id('r2'))), 'true', 'then it can be verified');

-- ---------------------------------------------------------------------------
-- Verification, then publication
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('e1', format($$select public.publish_release(%L, 'Publish')::text$$, pg_temp.id('r1'))), 'error: release not verified', 'an unverified release can''t be published');
select is(pg_temp.as_user('e1', format($$select public.verify_release(%L, 'Serial and region checked')::text$$, pg_temp.id('r1'))), 'true', 'an editor verifies the release');
select is(pg_temp.as_user('e1', format($$select public.verify_release(%L, 'Again')::text$$, pg_temp.id('r1'))), 'false', 'verifying twice changes nothing');
select is((select status::text from public.releases where id = pg_temp.id('r1')), 'under_review', 'verification doesn''t publish');
select is(pg_temp.as_user('e1', format($$select public.publish_release(%L, '')::text$$, pg_temp.id('r1'))), 'error: reason required', 'publication needs a reason');
select is(pg_temp.as_user('e1', format($$select public.publish_release(%L, 'Publish')::text$$, pg_temp.id('r1'))), 'error: game not verified', 'a release can''t be published before its game is verified');
select is(pg_temp.as_user('e1', format($$select public.verify_game(%L, 'Title and date checked')::text$$, pg_temp.id('g1'))), 'true', 'an editor verifies the game');
select is((select status::text from public.games where id = pg_temp.id('g1')), 'under_review', 'a verified game stays unpublished until a release is');
select is(pg_temp.as_user('e1', format($$select public.publish_release(%L, 'First release published')::text$$, pg_temp.id('r1'))), 'true', 'the editor publishes the release');
select lives_ok('set constraints all immediate', 'the publication rules hold at commit');
set constraints all deferred;
select is((select g.status::text || '/' || g.slug || '/' || gp.status::text || '/' || r.status::text from public.games g
  join public.game_platforms gp on gp.game_id = g.id join public.releases r on r.game_id = g.id and r.platform_id = gp.platform_id
  where r.id = pg_temp.id('r1')), 'published/super-metroid/published/published', 'its game and platform were published with it, and the game has a slug');
select is((select count(*)::int from public.releases where id = pg_temp.id('r2') and status = 'published'), 0, 'other releases of the game stay unpublished');
select is(pg_temp.as_user('e1', format($$select public.publish_release(%L, 'Again')::text$$, pg_temp.id('r1'))), 'false', 'publishing twice changes nothing');
select is(pg_temp.as_user(null, format($$select count(*)::text from public.games g join public.releases r on r.game_id = g.id join public.release_markets m on m.release_id = r.id where r.id = %L$$, pg_temp.id('r1'))),
  '2', 'anon now sees the game, release and markets');
select is(pg_temp.as_user(null, format($$select count(*)::text from public.releases where id = %L$$, pg_temp.id('r2'))), '0', 'but not the unpublished candidate');

-- A second game with the same title gets a different slug
select ok(pg_temp.keep('g3', pg_temp.as_user('e1', $$select public.create_game('Super Metroid', 'game', p_reason => 'Fixture')::text$$)) not like 'error%', 'an editor creates a second game with the same title');
select ok(pg_temp.keep('r4', pg_temp.as_user('e1', format($$select public.create_release(%L, %L, 'rom-cartridge', 'ntsc-j', '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}', p_reason => 'Fixture')::text$$,
  pg_temp.id('g3'), pg_temp.platform('snes')))) not like 'error%', 'with a complete release');
select is(pg_temp.as_user('e1', format($$select public.verify_game(%L, 'Checked')::text || public.verify_release(%L, 'Checked')::text || public.publish_release(%L, 'Checked')::text$$,
  pg_temp.id('g3'), pg_temp.id('r4'), pg_temp.id('r4'))), 'truetruetrue', 'verified and published');
select is((select slug from public.games where id = pg_temp.id('g3')), 'super-metroid-2', 'its slug doesn''t collide');

-- ---------------------------------------------------------------------------
-- Edits after verification and after publication
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"packaging": "Cardboard box"}', p_reason => 'Fixture')::text$$, pg_temp.id('r2'))), 'true', 'an editor edits a verified, unpublished release');
select is((select verified_at is null and verified_by is null from public.releases where id = pg_temp.id('r2')), true, 'which clears its verification');
select is((select (metadata ->> 'verification_cleared')::boolean from private.audit_events where action = 'catalog_record_updated' and metadata ->> 'id' = pg_temp.id('r2')::text order by id desc limit 1),
  true, 'and the audit row says so');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"packaging": "Cardboard box"}')::text$$, pg_temp.id('r1'))), 'error: reason required', 'a published release needs a reason to change');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"packaging": "Cardboard box"}', 'Seen on the box')::text$$, pg_temp.id('r1'))), 'true', 'with a reason, it is corrected');
select is((select status::text || '/' || (verified_at is not null) from public.releases where id = pg_temp.id('r1')), 'published/true', 'and stays published and verified');
select is(pg_temp.as_user('e1', format($$select public.update_game(%L, '{"title": "Super Metroid (1994)"}', 'Disambiguation')::text$$, pg_temp.id('g1'))), 'true', 'a published game''s title can be corrected');
select is((select slug from public.games where id = pg_temp.id('g1')), 'super-metroid', 'without changing its slug');
select lives_ok('set constraints all immediate', 'a correction alone satisfies the publication rules at commit');
set constraints all deferred;
select throws_ok(format($$update public.games set slug = 'other' where id = %L$$, pg_temp.id('g1')), '23514', 'a published game''s slug can''t be changed', 'even the owner can''t change a published slug');
select throws_ok(format($$update public.releases set status = 'under_review' where id = %L$$, pg_temp.id('r1')), '23514', 'published catalog records can''t be unpublished', 'there''s no unpublishing');
select throws_ok(format($$update public.releases set verified_at = null where id = %L$$, pg_temp.id('r1')), '23514', null, 'a published release stays verified');

-- Only identity edits clear a verification
select is(pg_temp.as_user('e1', format($$select public.verify_release(%L, 'Box checked')::text$$, pg_temp.id('r2'))), 'true', 'an editor verifies the edited release again');
select is(pg_temp.as_user('e1', format($$select public.update_release(%L, '{"publisher_name": "Nintendo", "languages": ["en"], "release_date": "1994-04-18", "release_date_precision": "day"}', 'From the box')::text || public.set_release_markets(%L, array['GB'], 'From the box')::text || public.set_release_requirements(%L, '[]', 'None needed')::text$$,
  pg_temp.id('r2'), pg_temp.id('r2'), pg_temp.id('r2'))), 'truetruefalse', 'an editor edits only descriptive fields');
select is((select verified_at is not null from public.releases where id = pg_temp.id('r2')), true, 'which keeps the verification');
select is((select count(*)::int from private.audit_events where action = 'catalog_record_updated' and metadata ->> 'id' = pg_temp.id('r2')::text and (metadata ->> 'verification_cleared')::boolean),
  1, 'and the audit rows say nothing was cleared');
select is(pg_temp.as_user('e1', format($$select public.set_release_components(%L, '[{"kind": "map", "label": "Fold-out map"}]', 'From the box')::text$$, pg_temp.id('r2'))), 'true', 'an editor changes what''s in the box');
select is((select verified_at is null from public.releases where id = pg_temp.id('r2')), true, 'which is identity, and clears the verification');
select is(pg_temp.as_user('e1', format($$select public.verify_game(%L, 'Checked')::text || public.update_game(%L, '{"sort_title": "Pulstar"}', 'Description')::text$$, pg_temp.id('g2'), pg_temp.id('g2'))),
  'truefalse', 'a descriptive game edit that changes nothing returns false');
select is(pg_temp.as_user('e1', format($$select public.update_game(%L, '{"summary": "A side-scrolling shooter."}', 'Description')::text$$, pg_temp.id('g2'))), 'true', 'an editor describes a verified game');
select is((select verified_at is not null from public.games where id = pg_temp.id('g2')), true, 'which keeps its verification');
select is(pg_temp.as_user('e1', format($$select public.update_game(%L, '{"title": "Pulstar (Neo Geo)"}', 'Retitled')::text$$, pg_temp.id('g2'))), 'true', 'an editor retitles it');
select is((select verified_at is null from public.games where id = pg_temp.id('g2')), true, 'which clears it');

-- More releases for a game that is already published
select ok(pg_temp.keep('r5', pg_temp.as_user('e1', format($$select public.create_release(%L, %L, 'rom-cartridge', 'pal', '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}', 'From the box')::text$$,
  pg_temp.id('g1'), pg_temp.platform('snes')))) not like 'error%', 'an editor adds another release to a published game');
select is(pg_temp.as_user('e1', format($$select public.verify_release(%L, 'Checked')::text || public.publish_release(%L, 'Second release')::text$$, pg_temp.id('r5'), pg_temp.id('r5'))),
  'truetrue', 'and verifies and publishes it on its own');
select lives_ok('set constraints all immediate', 'the publication rules hold at commit without the game changing');
set constraints all deferred;
select ok(pg_temp.keep('r6', pg_temp.as_user('e1', format($$select public.create_release(%L, %L, 'rom-cartridge', 'ntsc-uc', '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}', 'From the box')::text$$,
  pg_temp.id('g1'), pg_temp.platform('nes')))) not like 'error%', 'an editor adds a release on a new platform for a published game');
select lives_ok('set constraints all immediate', 'a published game may have an unpublished pairing');
set constraints all deferred;
select is(pg_temp.as_user('e1', format($$select public.verify_release(%L, 'Checked')::text || public.publish_release(%L, 'New platform')::text$$, pg_temp.id('r6'), pg_temp.id('r6'))),
  'truetrue', 'and publishes it');
select lives_ok('set constraints all immediate', 'its pairing is published with it, at commit');
set constraints all deferred;
select is((select string_agg(gp.status::text, ',' order by p.slug) || '/' || g.slug || '/' || g.status from public.games g join public.game_platforms gp on gp.game_id = g.id join public.platforms p on p.id = gp.platform_id
  where g.id = pg_temp.id('g1') group by g.slug, g.status), 'published,published/super-metroid/published', 'both pairings are published, and the game keeps its slug');
select is((select count(*)::int from private.audit_events where action = 'catalog_record_published' and metadata ->> 'entity' = 'game' and metadata ->> 'id' = pg_temp.id('g1')::text),
  1, 'the game was published once, with its first release');

-- The publication rules, at commit
select throws_ok(format($$update public.releases set status = 'published', verified_at = now(), edition_name = 'Standard', edition_kind = 'standard', media_count = 1 where id = %L; set constraints all immediate$$, pg_temp.id('r3')),
  '23514', 'a release can be published only with its game and platform', 'a release can''t be published without its game');
set constraints all deferred;
select throws_ok(format($$update public.games set status = 'published', slug = 'pulstar', verified_at = now() where id = %L; set constraints all immediate$$, pg_temp.id('g2')),
  '23514', 'a game is published only with a published physical release', 'a game can''t be published without a physical release');
set constraints all deferred;
select throws_ok(format($$insert into public.releases (game_id, platform_id, region_code, edition_name, edition_kind, media_count, media_format_code, packaging, product_code, status, verified_at)
  select game_id, platform_id, region_code, edition_name, edition_kind, media_count, media_format_code, packaging, product_code, 'published', now() from public.releases where id = %L$$, pg_temp.id('r1')),
  '23505', null, 'two published releases can''t share a physical identity');
select throws_ok(format($$update public.releases set status = 'published', edition_name = null where id = %L$$, pg_temp.id('r2')), '23514', null, 'a release can''t be published without an edition');
select throws_ok(format($$update public.releases set status = 'published' where id = %L$$, pg_temp.id('r3')), '23514', null, 'a release can''t be published without verification');

-- ---------------------------------------------------------------------------
-- Relations, pairings and locks
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('e1', format($$select public.set_game_relation(%L, %L, 'contains', 1::smallint, null, 'Compilation contents')::text$$, pg_temp.id('g2'), pg_temp.id('g1'))),
  'error: only a compilation can contain other games', 'only a compilation can contain games');
select is(pg_temp.as_user('e1', format($$select public.set_game_relation(%L, %L, 'remake_of', null, null, '')::text$$, pg_temp.id('g3'), pg_temp.id('g1'))), 'error: reason required', 'classification needs a reason');
select is(pg_temp.as_user('e1', format($$select public.set_game_relation(%L, %L, 'remake_of', null, null, 'Rebuilt game')::text$$, pg_temp.id('g3'), pg_temp.id('g1'))), 'true', 'an editor records a remake');
select is(pg_temp.as_user(null, format($$select count(*)::text from public.game_relations where source_game_id = %L$$, pg_temp.id('g3'))), '1', 'a relation between published games is public');
select is(pg_temp.as_user('e1', format($$select public.set_game_platform(%L, %L, p_reason => 'Fixture')::text$$, pg_temp.id('g1'), pg_temp.platform('snes'))), 'false', 'an existing pairing isn''t added again');
select is(pg_temp.as_user('e1', format($$select public.set_catalog_field_lock('release', %L, 'product_code', true, 'From the label')::text$$, pg_temp.id('r1'))), 'true', 'an editor locks a field');
select is(pg_temp.as_user('e1', format($$select public.set_catalog_field_lock('release', %L, 'product_code', true, 'Again')::text$$, pg_temp.id('r1'))), 'false', 'locking twice changes nothing');
select is(pg_temp.as_user('e1', format($$select public.set_catalog_field_lock('release', %L, 'status', true, 'No')::text$$, pg_temp.id('r1'))), 'error: invalid changes', 'only editable fields can be locked');
select is(pg_temp.as_user('e1', format($$select public.set_catalog_field_lock('release', %L, 'product_code', false, 'Reopened')::text$$, pg_temp.id('r1'))), 'true', 'an editor unlocks it');

-- ---------------------------------------------------------------------------
-- Losing the role
-- ---------------------------------------------------------------------------
select ok(pg_temp.keep('g4', pg_temp.as_user('b5', $$select public.create_game('Axelay', 'game', p_reason => 'Fixture')::text$$)) not like 'error%', 'an editor works before being suspended');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('b5');
select is(pg_temp.as_user('b5', format($$select public.update_game(%L, '{"summary": "Shooter."}', p_reason => 'Fixture')::text$$, pg_temp.id('g4'))), 'error: not permitted', 'a suspended editor can''t edit');
select is(pg_temp.as_user('b5', format($$select count(*)::text from public.games where id = %L$$, pg_temp.id('g4'))), '0', 'or see unpublished records');
delete from public.staff_roles where user_id = pg_temp.u('a6');
select is(pg_temp.as_user('a6', $$select public.create_game('Axelay', 'game', p_reason => 'Fixture')::text$$), 'error: not permitted', 'a revoked editor can''t edit');

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
select is(pg_temp.audits('catalog_record_published'), 6, 'each publication is audited: two games and four releases');
select is((select count(*)::int from private.audit_events where action = 'catalog_record_verified' and reason = 'Serial and region checked' and actor_id = pg_temp.u('e1')
  and metadata ->> 'entity' = 'release' and metadata ->> 'id' = pg_temp.id('r1')::text), 1, 'verification records the editor, the reason and the release');
select is((select reason from private.audit_events where action = 'catalog_record_created' and metadata ->> 'id' = pg_temp.id('g1')::text), 'Fixture', 'the audit row keeps the editor''s own reason');
select is((select count(*)::int from private.audit_events where action::text like 'catalog_%' and reason = 'No reason given'), 0, 'no catalog audit row has a reason supplied for the editor');
select is((select count(*)::int from private.audit_events where action::text like 'catalog_%' and target_profile_id is not null), 0, 'catalog audit rows name no account as their target');

-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------
insert into private.external_providers (code, name) values ('fixture', 'Fixture source');
select throws_ok($$update private.external_providers set commercial_use_cleared = true where code = 'fixture'$$, '23514', null, 'commercial use can''t be cleared without recorded terms');
insert into private.import_runs (id, provider_code, source_name, source_sha256, source_fetched_at)
values (pg_temp.u('91'), 'fixture', 'fixture.dat', repeat('a', 64), now());
insert into private.provider_records (id, provider_code, entity_type, external_id, payload, payload_sha256, import_run_id) values
  (pg_temp.u('92'), 'fixture', 'game', 'Q1', '{"title": "Super Metroid"}', repeat('b', 64), pg_temp.u('91')),
  (pg_temp.u('93'), 'fixture', 'release', 'R1', '{"serial": "SNS-RI-USA"}', repeat('c', 64), pg_temp.u('91'));
select throws_ok(format($$insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id) values ('fixture', 'release', 'R1', '{}', %L, %L)$$, repeat('c', 64), pg_temp.u('91')),
  '23505', null, 'the same source entry is stored once');
select throws_ok(format($$insert into private.release_evidence (release_id, field_name, provider_record_id) values (%L, 'product_code', %L)$$, pg_temp.id('r1'), pg_temp.u('92')),
  '23514', 'release evidence must come from a release-level source record', 'game-level data never counts as release evidence');
select lives_ok(format($$insert into private.release_evidence (release_id, field_name, provider_record_id) values (%L, 'product_code', %L)$$, pg_temp.id('r1'), pg_temp.u('93')),
  'a release-level record can support a release field');
select throws_ok(format($$insert into private.external_references (provider_code, external_id, game_id, release_id) values ('fixture', 'Q1', %L, %L)$$, pg_temp.id('g1'), pg_temp.id('r1')),
  '23514', null, 'an external reference identifies one record');

-- ---------------------------------------------------------------------------
-- Attaching copies, for M6
-- ---------------------------------------------------------------------------
-- Policies call these helpers. Clients can't reach the private schema directly, so
-- call them as the owner with the user's claims.
do $$ begin perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('c3'), 'role', 'authenticated')::text, true); end $$;
select is(private.can_use_release(pg_temp.id('r1')), true, 'a published release can be used');
select is(private.can_use_release(pg_temp.id('r2')), false, 'an unpublished candidate can''t');
select is(private.can_read_release(pg_temp.id('r2')), false, 'and an ordinary user can''t read it');
select ok(has_function_privilege('authenticated', 'private.can_use_release(uuid)', 'execute') and not has_function_privilege('anon', 'private.can_use_release(uuid)', 'execute'),
  'only signed-in users can use the helper, through policies');

select * from finish();
rollback;
