-- M12a: flexible physical ownership. A copy is identified (it names a release) or
-- unidentified (a private claim on a game and platform, with region and edition each
-- optional). The two states can't mix, claims change only through the audited owner
-- function, and exclusions preserve and restore claims on the games they exclude.
-- Races between claims and exclusions are in db-ownership-claim-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(160);

-- Staff sessions are live aal2 sessions with a verified TOTP factor, as in 27.
create function pg_temp.claims(p_user uuid, p_session uuid default null) returns jsonb language plpgsql as $mfa$
begin
  if exists (select 1 from auth.users where id = p_user) and p_session is null then
    insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      select p_user, p_user, 'test session factor', 'totp', 'verified', now(), now()
      where not exists (select 1 from auth.mfa_factors where id = p_user);
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
      values (gen_random_uuid(), p_user, 'totp', now(), now()) on conflict do nothing;
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', coalesce(p_session, p_user));
end $mfa$;

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated, anon;
create temp table ids (name text primary key, id uuid not null);
grant all on ids to authenticated, anon;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
grant execute on function pg_temp.id(text) to authenticated, anon;
create function pg_temp.new_id(p text) returns uuid language sql as $$
  insert into ids values (p, private.uuid_v7()) on conflict (name) do update set id = excluded.id returning id
$$;

-- Runs a statement as a signed-in user (or with an ended session), returning its
-- result or the error as text.
create function pg_temp.run(p_claims jsonb, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', p_claims::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language sql as $$ select pg_temp.run(pg_temp.claims(pg_temp.u(p_actor)), p_sql) $$;
create function pg_temp.as_ended(p_actor text, p_sql text) returns text language sql as $$ select pg_temp.run(pg_temp.claims(pg_temp.u(p_actor), gen_random_uuid()), p_sql) $$;
create function pg_temp.j(r text) returns jsonb language sql immutable as $$
  select case when r like '{%' or r like '[%' then r::jsonb else jsonb_build_object('error', r) end
$$;

-- add_unidentified_copy as a user, with a fresh named id.
create function pg_temp.claim(p_actor text, p_item text, p_game text, p_platform text, p_region text default null,
                              p_kind text default null, p_name text default null, p_details text default '{}') returns text language plpgsql as $$
begin
  perform pg_temp.new_id(p_item);
  return pg_temp.as_user(p_actor, format('select public.add_unidentified_copy(%L, %L, %L, %L, %L, %L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_game),
    (select id from public.platforms where slug = p_platform), p_region, p_kind, p_name, p_details));
end $$;
-- The same call again, with the same id.
create function pg_temp.reclaim(p_actor text, p_item text, p_game text, p_platform text, p_region text default null,
                                p_kind text default null, p_name text default null) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.add_unidentified_copy(%L, %L, %L, %L, %L, %L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_game),
    (select id from public.platforms where slug = p_platform), p_region, p_kind, p_name, '{}'))
$$;
create function pg_temp.add(p_actor text, p_item text, p_release text, p_details text default '{}') returns text language plpgsql as $$
begin
  perform pg_temp.new_id(p_item);
  return pg_temp.as_user(p_actor, format('select public.add_collection_item(%L, %L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_release), p_details));
end $$;
create function pg_temp.ident(p_actor text, p_item text, p_identity jsonb) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.set_my_copy_identity(%L, %L)::text', pg_temp.id(p_item), p_identity)))
$$;
create function pg_temp.to_release(p text) returns jsonb language sql stable as $$ select jsonb_build_object('release_id', pg_temp.id(p)) $$;
create function pg_temp.to_claim(p_game text, p_platform text, p_region text default null, p_kind text default null, p_name text default null)
returns jsonb language sql stable as $$
  select jsonb_build_object('game_id', pg_temp.id(p_game), 'platform_id', (select id from public.platforms where slug = p_platform),
    'region_code', p_region, 'edition_kind', p_kind, 'edition_name', p_name)
$$;
create function pg_temp.row_of(p_item text) returns public.collection_items language sql stable as $$
  select c from public.collection_items c where c.id = pg_temp.id(p_item)
$$;
create function pg_temp.claim_of(p_item text) returns text language sql stable as $$
  select concat_ws('/', coalesce(c.release_id::text, '-'), coalesce((select slug from public.platforms where id = c.claimed_platform_id), '-'),
    coalesce(c.claimed_region_code, '-'), coalesce(c.claimed_edition_kind::text, '-'), coalesce(c.claimed_edition_name, '-'))
  from public.collection_items c where c.id = pg_temp.id(p_item)
$$;
create function pg_temp.status(p_item text) returns text language sql stable as $$
  select record_status::text from public.collection_items where id = pg_temp.id(p_item)
$$;
create function pg_temp.mine(p_actor text, p_args text default '') returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_my_collection(%s)::text', p_args)))
$$;
create function pg_temp.item(p_actor text, p_item text) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_my_collection_item(%L)::text', pg_temp.id(p_item))))
$$;
create function pg_temp.owns(p_actor text, p_game text) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_my_game_ownership(%L)::text', pg_temp.id(p_game))))
$$;
create function pg_temp.summary(p_actor text) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, 'select public.get_my_collection_summary()::text'))
$$;
create function pg_temp.history(p_actor text, p_item text) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_my_copy_history(%L)::text', pg_temp.id(p_item))))
$$;
-- Exclusion and restoration, as in 27.
create function pg_temp.exclude(p_actor text, p_release text) returns text language plpgsql as $$
declare r text;
begin
  r := pg_temp.as_user(p_actor, format('select public.exclude_release(%L, %L, ''no_game_data'', ''Holds no game'', ''Out of scope'', true, true)::text',
         pg_temp.id(p_release), pg_temp.as_user('e5', format('select public.get_exclusion_preview(%L) ->> ''token''', pg_temp.id(p_release)))));
  if r like '{%' then
    insert into ids values ('x-' || p_release, (r::jsonb ->> 'exclusion_id')::uuid) on conflict (name) do update set id = excluded.id;
  end if;
  return r;
end $$;
create function pg_temp.restore(p_actor text, p_release text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.restore_exclusion(%L, %L, %L)::text', pg_temp.id('x-' || p_release),
    (select version from private.catalog_exclusions where id = pg_temp.id('x-' || p_release)), 'Excluded by mistake'))
$$;

-- c1, c2: collectors. c3: a collector whose account is deleted. e5, e6: catalog
-- editors. a7: administrator. fe: the fixtures' editor (D2: nobody verifies, publishes
-- or excludes a record they created).
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['c1', 'c2', 'c3', 'e5', 'e6', 'a7', 'fe']) as s;
update public.profiles set handle = 'fo_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['c1', 'c2', 'c3', 'e5', 'e6', 'a7', 'fe']) s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('e5'), 'catalog_editor'), (pg_temp.u('e6'), 'catalog_editor'), (pg_temp.u('a7'), 'admin'), (pg_temp.u('fe'), 'catalog_editor');
select pg_temp.claims(pg_temp.u('fe')) is not null as fixture_editor_ready;
create function pg_temp.fx_on() returns void language plpgsql as $fx$
begin
  perform set_config('test.claims_before_fixture', coalesce(current_setting('request.jwt.claims', true), ''), true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.u('fe'), 'role', 'authenticated', 'aal', 'aal2', 'session_id', pg_temp.u('fe'))::text, true);
end $fx$;
create function pg_temp.fx_off() returns void language plpgsql as $fx$
begin
  perform set_config('request.jwt.claims', current_setting('test.claims_before_fixture', true), true);
end $fx$;
grant execute on function pg_temp.fx_on(), pg_temp.fx_off() to authenticated, anon;
-- A game (verified, published once it has a release) and its releases, on classified
-- packaging and the platform's own shells.
create function pg_temp.game_of(p_name text, p_title text) returns void language plpgsql as $$
begin
  perform pg_temp.fx_on();
  insert into ids select p_name, public.create_game(p_title, 'game', null, null, null, 'unknown', 'Ownership tests');
  perform pg_temp.fx_off();
  perform public.verify_game(pg_temp.id(p_name), 'Ownership tests', (select revision from public.games where id = pg_temp.id(p_name)));
end $$;
create function pg_temp.release(p_name text, p_game text, p_platform text, p_format text, p_region text, p_edition text, p_kind text) returns void language plpgsql as $$
declare r uuid;
begin
  perform pg_temp.fx_on();
  r := public.create_release(pg_temp.id(p_game), (select id from public.platforms where slug = p_platform), p_format, p_region,
    jsonb_build_object('edition_name', p_edition, 'edition_kind', p_kind, 'media_count', 1, 'packaging_code', 'cardboard-box', 'product_code', 'FLX-' || upper(p_name)), 'Ownership tests');
  perform pg_temp.fx_off();
  perform public.verify_release(r, 'Ownership tests', (select revision from public.releases where id = r));
  perform public.publish_release(r, 'Ownership tests', (select revision from public.releases where id = r));
  insert into ids values (p_name, r);
end $$;
grant execute on function pg_temp.release(text, text, text, text, text, text, text), pg_temp.game_of(text, text) to authenticated;

-- g "Flx Crash Coast": us (Standard), us-gh (Greatest Hits), eu (SNES). k "Flx Lone
-- Keep": lone, its only release. j "Flx Twin Peak": j1, j2. n: verified, never
-- published.
select set_config('request.jwt.claims', pg_temp.claims(pg_temp.u('e5'))::text, true);
select set_config('role', 'authenticated', true);
select pg_temp.game_of('g', 'Flx Crash Coast');
select pg_temp.release('us', 'g', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard');
select pg_temp.release('us-gh', 'g', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Greatest Hits', 'reprint');
select pg_temp.release('eu', 'g', 'snes', 'snes-cartridge-jp-pal', 'pal', 'Standard', 'standard');
select pg_temp.game_of('k', 'Flx Lone Keep');
select pg_temp.release('lone', 'k', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard');
select pg_temp.game_of('j', 'Flx Twin Peak');
select pg_temp.release('j1', 'j', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard');
select pg_temp.release('j2', 'j', 'snes', 'snes-cartridge-jp-pal', 'pal', 'Standard', 'standard');
select pg_temp.game_of('n', 'Flx Never Shown');
select set_config('role', 'none', true);

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------
select col_is_null('public', 'collection_items', 'release_id', 'a copy''s release may be null');
select has_column('public', 'collection_items', 'claimed_game_id', 'a claim names a game');
select has_column('public', 'collection_items', 'claimed_platform_id', 'and a platform');
select has_column('public', 'collection_items', 'claimed_region_code', 'and maybe a region');
select has_column('public', 'collection_items', 'claimed_edition_kind', 'and maybe an edition kind');
select has_column('public', 'collection_items', 'claimed_edition_name', 'and maybe an edition name');
select has_table('private', 'collection_item_identity_events', 'identity changes have a private history');
select is((select string_agg(privilege_type || ':' || column_name, ',' order by column_name) from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'collection_items' and grantee = 'authenticated' and privilege_type = 'UPDATE'),
          'UPDATE:box_condition,UPDATE:completeness,UPDATE:manual_condition,UPDATE:media_condition,UPDATE:overall_condition',
          'clients may update only a copy''s completeness and conditions, never its identity');
select is((select has_table_privilege('authenticated', 'private.collection_item_identity_events', 'select')), false, 'clients can''t read the history table');

-- ---------------------------------------------------------------------------
-- 2. The four combinations, and identified copies beside them
-- ---------------------------------------------------------------------------
select is(pg_temp.j(pg_temp.claim('c1', 'q1', 'g', 'snes', 'pal', 'reprint', 'Platinum')) ->> 'created', 'true', 'known region, known edition');
select is(pg_temp.j(pg_temp.claim('c1', 'q2', 'g', 'snes', 'pal')) ->> 'created', 'true', 'known region, unknown edition');
select is(pg_temp.j(pg_temp.claim('c1', 'q3', 'g', 'snes', null, 'reprint', 'Platinum')) ->> 'created', 'true', 'unknown region, known edition');
select is(pg_temp.j(pg_temp.claim('c1', 'q4', 'g', 'snes')) ->> 'created', 'true', 'unknown region, unknown edition');
select is(pg_temp.claim_of('q1'), '-/snes/pal/reprint/Platinum', 'the first is stored as claimed');
select is(pg_temp.claim_of('q2'), '-/snes/pal/-/-', 'the second keeps its region only');
select is(pg_temp.claim_of('q3'), '-/snes/-/reprint/Platinum', 'the third keeps its edition without a region');
select is(pg_temp.claim_of('q4'), '-/snes/-/-/-', 'the fourth names only game and platform');
select is(pg_temp.j(pg_temp.claim('c1', 'q5', 'g', 'snes', 'pal', 'reprint', 'Platinum')) ->> 'created', 'true', 'an independent second claim of the same kind is another copy');
select is((select count(*)::int from public.collection_items where owner_id = pg_temp.u('c1') and claimed_game_id = pg_temp.id('g')), 5, 'the owner has five claimed copies of the game');
select is(pg_temp.j(pg_temp.add('c1', 'i1', 'us')) ->> 'created', 'true', 'an identified copy is added as before');
select is(pg_temp.j(pg_temp.add('c1', 'i2', 'eu')) ->> 'created', 'true', 'and another edition is another copy');
select is((select release_id is not null and claimed_game_id is null and claimed_platform_id is null from public.collection_items where id = pg_temp.id('i1')),
          true, 'an identified copy stores only its release');
select is((select count(*)::int from public.releases where game_id = pg_temp.id('g')), 3, 'no release was created for a claim');
select is((select count(*)::int from public.game_platforms where game_id = pg_temp.id('g')), 1, 'nor a pairing');
-- A platform the catalog doesn't list for the game.
select is(pg_temp.j(pg_temp.claim('c1', 'qn', 'g', 'nes', 'ntsc-uc')) ->> 'created', 'true', 'a claim on a platform the catalog doesn''t list for the game is allowed');
select is((select count(*)::int from public.game_platforms where game_id = pg_temp.id('g')), 1, 'and still creates no pairing');

-- ---------------------------------------------------------------------------
-- 3. Retries, input and refusals
-- ---------------------------------------------------------------------------
select is(pg_temp.j(pg_temp.reclaim('c1', 'q1', 'g', 'snes', 'pal', 'reprint', 'Platinum')) ->> 'created', 'false', 'a retry of the same claim returns the same copy');
select is(pg_temp.reclaim('c1', 'q1', 'g', 'snes', 'pal', 'reprint', 'Platinum Edition'), 'error: request conflict', 'the same id with another claim conflicts');
select is(pg_temp.as_user('c1', format('select public.add_collection_item(%L, %L)::text', pg_temp.id('q1'), pg_temp.id('us'))), 'error: request conflict',
          'and so does the same id for a release');
select is(pg_temp.as_user('c1', format('select public.add_unidentified_copy(%L, %L, %L)::text', pg_temp.id('i1'), pg_temp.id('g'), (select id from public.platforms where slug = 'snes'))),
          'error: request conflict', 'an identified copy''s id can''t be reused for a claim');
select is((select count(*)::int from public.collection_items where owner_id = pg_temp.u('c1')), 8, 'retries added nothing');
select is(pg_temp.j(pg_temp.claim('c1', 'qt', 'g', 'snes', null, null, E'  Platinum   Edition ')) ->> 'created', 'true', 'an edition name with odd spacing is accepted');
select is(pg_temp.claim_of('qt'), '-/snes/-/-/Platinum Edition', 'and stored tidied: one space, trimmed, nothing else changed');
select is(pg_temp.j(pg_temp.claim('c1', 'qe', 'g', 'snes', null, null, E'Spécial')) ->> 'created', 'true', 'a decomposed accent is accepted');
select is((select claimed_edition_name = E'Spécial' from public.collection_items where id = pg_temp.id('qe')), true, 'and stored composed (NFC)');
select is(pg_temp.reclaim('c1', 'qe', 'g', 'snes', null, null, E'Spécial'), '{"created": false, "item_id": "' || pg_temp.id('qe') || '"}', 'the composed spelling is the same claim');
select is(pg_temp.claim('c1', 'qx', 'g', 'snes', null, null, repeat('x', 81)), 'error: invalid edition', 'an edition name over 80 characters is refused');
select is(pg_temp.claim('c1', 'qx', 'g', 'snes', null, null, E'Bad\u0007name'), 'error: invalid edition', 'and one with a control character');
select is(pg_temp.claim('c1', 'qx', 'g', 'snes', null, 'deluxe'), 'error: invalid edition', 'and an edition kind that doesn''t exist');
select is(pg_temp.claim('c1', 'qx', 'g', 'snes', 'unknown'), 'error: invalid region', 'the catalog''s "unknown" region isn''t a claim');
select is(pg_temp.claim('c1', 'qx', 'g', 'snes', 'zz'), 'error: invalid region', 'nor is a region that doesn''t exist');
select is(pg_temp.claim('c1', 'qx', 'n', 'snes'), 'error: game unavailable', 'a game that isn''t published can''t be claimed');
select is(pg_temp.as_user('c1', format('select public.add_unidentified_copy(%L, %L, %L)::text', pg_temp.new_id('qx'), pg_temp.id('g'), gen_random_uuid())),
          'error: platform unavailable', 'nor a platform that doesn''t exist');
select is(pg_temp.as_user('c1', format('select public.add_unidentified_copy(%L, %L, %L)::text', pg_temp.new_id('qx'), gen_random_uuid(), (select id from public.platforms where slug = 'snes'))),
          'error: game unavailable', 'nor a game that doesn''t exist');

-- ---------------------------------------------------------------------------
-- 4. The two states can't mix, and identity never changes directly
-- ---------------------------------------------------------------------------
select throws_ok(format($$insert into public.collection_items (id, owner_id, release_id, claimed_game_id, claimed_platform_id)
                          values (private.uuid_v7(), %L, %L, %L, %L)$$, pg_temp.u('c1'), pg_temp.id('us'), pg_temp.id('g'), (select id from public.platforms where slug = 'snes')),
                 '23514', null, 'a copy can''t name a release and a claim');
select throws_ok(format($$insert into public.collection_items (id, owner_id, release_id, claimed_region_code) values (private.uuid_v7(), %L, %L, 'pal')$$, pg_temp.u('c1'), pg_temp.id('us')),
                 '23514', null, 'nor a release and a claimed region');
select throws_ok(format($$insert into public.collection_items (id, owner_id, claimed_game_id) values (private.uuid_v7(), %L, %L)$$, pg_temp.u('c1'), pg_temp.id('g')),
                 'P0001', 'platform unavailable', 'a claim needs its platform (refused by the trigger before the check)');
select throws_ok(format($$insert into public.collection_items (id, owner_id) values (private.uuid_v7(), %L)$$, pg_temp.u('c1')),
                 'P0001', 'game unavailable', 'a copy needs a release or a claim');
select throws_ok(format($$insert into public.collection_items (id, owner_id, claimed_game_id, claimed_platform_id, claimed_edition_name)
                          values (private.uuid_v7(), %L, %L, %L, 'Two  spaces')$$, pg_temp.u('c1'), pg_temp.id('g'), (select id from public.platforms where slug = 'snes')),
                 '23514', null, 'an untidy edition name is refused even by a direct insert');
select throws_ok(format($$update public.collection_items set release_id = %L where id = %L$$, pg_temp.id('us'), pg_temp.id('q4')),
                 '23514', null, 'identifying a claim without clearing it is refused');
-- Each layer on its own: the policies' check, and the trigger, which also holds for
-- maintenance sessions the owner function never goes through.
select is(private.can_claim(pg_temp.id('n'), (select id from public.platforms where slug = 'snes')), false, 'the policy check refuses an unpublished game');
select is(private.can_claim(pg_temp.id('g'), (select id from public.platforms where slug = 'nes')), true, 'and allows a published one on any platform');
select throws_ok(format($$update public.collection_items set claimed_game_id = %L where id = %L$$, pg_temp.id('n'), pg_temp.id('q2')),
                 'P0001', 'game unavailable', 'even a maintenance update can''t move a claim onto an unpublished game');select is(pg_temp.as_user('c1', format($$update public.collection_items set claimed_region_code = 'pal' where id = %L returning 1$$, pg_temp.id('q4'))),
          'error: permission denied for table collection_items', 'the owner can''t change a claim directly');
select is(pg_temp.as_user('c1', format($$update public.collection_items set release_id = %L where id = %L returning 1$$, pg_temp.id('us'), pg_temp.id('q4'))),
          'error: permission denied for table collection_items', 'nor identify it directly');
select is(pg_temp.as_user('c1', format($$update public.collection_items set claimed_game_id = %L, claimed_platform_id = %L, release_id = null where id = %L returning 1$$,
            pg_temp.id('g'), (select id from public.platforms where slug = 'snes'), pg_temp.id('i1'))),
          'error: permission denied for table collection_items', 'nor unidentify a copy directly');
select is(pg_temp.as_user('c1', format($$insert into public.collection_items (id, owner_id, claimed_game_id, claimed_platform_id) values (%L, %L, %L, %L) returning 'ok'$$,
            pg_temp.new_id('qd'), pg_temp.u('c1'), pg_temp.id('g'), (select id from public.platforms where slug = 'snes'))),
          'ok', 'a direct insert of a valid claim passes the same rules as the function');
select is(pg_temp.as_user('c1', format($$insert into public.collection_items (id, owner_id, claimed_game_id, claimed_platform_id) values (%L, %L, %L, %L) returning 'ok'$$,
            pg_temp.new_id('qx'), pg_temp.u('c1'), pg_temp.id('n'), (select id from public.platforms where slug = 'snes'))),
          'error: game unavailable', 'and a direct insert on an unpublished game is refused');
select is(pg_temp.as_user('c1', format($$insert into public.collection_items (id, owner_id, claimed_game_id, claimed_platform_id) values (%L, %L, %L, %L) returning 'ok'$$,
            pg_temp.new_id('qx'), pg_temp.u('c2'), pg_temp.id('g'), (select id from public.platforms where slug = 'snes'))),
          'error: new row violates row-level security policy for table "collection_items"', 'nor a claim for someone else');

-- ---------------------------------------------------------------------------
-- 5. Owner isolation
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('c2', format('select count(*)::text from public.collection_items where id = %L', pg_temp.id('q1'))), '0', 'another collector can''t see a claim');
select is(pg_temp.item('c2', 'q1')::text, '{"error": ""}', 'nor read it');
select is(pg_temp.owns('c2', 'g') ->> 'owned', 'false', 'and doesn''t own the game');
select is(pg_temp.ident('c2', 'q1', pg_temp.to_claim('g', 'snes', 'ntsc-uc')) ->> 'error', 'error: item unavailable', 'nor change its identity');
select is(pg_temp.history('c2', 'q1')::text, '[]', 'nor read its history');
select is(pg_temp.as_user('e5', format('select count(*)::text from public.collection_items where id = %L', pg_temp.id('q1'))), '0', 'staff can''t see it either');
select is(pg_temp.as_ended('c1', format('select public.add_unidentified_copy(%L, %L, %L)::text', pg_temp.new_id('qx'), pg_temp.id('g'), (select id from public.platforms where slug = 'snes'))),
          'error: account not active', 'an ended session can''t add a claim');
select is(pg_temp.j(pg_temp.as_ended('c1', format('select public.set_my_copy_identity(%L, %L)::text', pg_temp.id('q4'), pg_temp.to_claim('g', 'snes', 'pal')))) ->> 'error',
          'error: account not active', 'nor change one');
select is(pg_temp.as_ended('c1', format('select public.get_my_game_ownership(%L) ->> ''copies''', pg_temp.id('g'))), '0', 'nor read ownership');
select is(pg_temp.as_ended('c1', format('select public.get_my_copy_history(%L)::text', pg_temp.id('q4'))), '[]', 'nor history');

-- ---------------------------------------------------------------------------
-- 6. Pieces and details on a claim
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('c1', format($$select public.update_collection_item(%L, '{"completeness": "loose", "notes": "Car boot sale"}')::text$$, pg_temp.id('q2'))), 'true',
          'a claim records completeness and private notes');
select is(pg_temp.as_user('c1', format($$select public.update_collection_item(%L, '{"components": [{"kind": "insert", "label": "Poster"}]}')::text$$, pg_temp.id('q2'))),
          'error: component unavailable', 'but no pieces: there''s no release to list them');
select is(pg_temp.j(pg_temp.claim('c1', 'qc', 'g', 'snes', 'ntsc-uc', null, null, '{"completeness": "complete", "box_condition": "good", "manual_condition": "fair"}')) ->> 'created', 'true',
          'details can be given when a claim is added');
select is((select completeness::text || '/' || box_condition::text from public.collection_items where id = pg_temp.id('qc')), 'complete/good', 'and are stored');

-- ---------------------------------------------------------------------------
-- 7. Changing identity, and its history
-- ---------------------------------------------------------------------------
select is(pg_temp.ident('c1', 'q4', pg_temp.to_claim('g', 'snes', 'pal')) ->> 'changed', 'true', 'the owner adds a region to a claim');
select is(pg_temp.claim_of('q4'), '-/snes/pal/-/-', 'which is stored');
select is(pg_temp.ident('c1', 'q4', pg_temp.to_claim('g', 'snes', 'pal')) ->> 'changed', 'false', 'the same identity again changes nothing');
select is(pg_temp.ident('c1', 'q4', pg_temp.to_release('eu')) - 'release_id', '{"changed": true, "identity": "release", "record_status": "active"}', 'and identifies it as a release');
select is((select release_id = pg_temp.id('eu') and claimed_game_id is null and claimed_region_code is null from public.collection_items where id = pg_temp.id('q4')),
          true, 'the claim is cleared');
select is(pg_temp.ident('c1', 'q4', pg_temp.to_claim('g', 'snes', null, 'standard', 'Black Label')) ->> 'identity', 'claim', 'an identified copy can be left unidentified');
select is(pg_temp.claim_of('q4'), '-/snes/-/standard/Black Label', 'with what the owner says');
select is(pg_temp.ident('c1', 'qn', pg_temp.to_release('us')) ->> 'error', 'error: other platform', 'the platform never changes');
select is(pg_temp.ident('c1', 'q4', pg_temp.to_claim('g', 'nes')) ->> 'error', 'error: other platform', 'not even between claims');
select is(pg_temp.ident('c1', 'q4', pg_temp.to_claim('n', 'snes')) ->> 'error', 'error: game unavailable', 'a claim can''t move to an unpublished game');
select is(pg_temp.ident('c1', 'q4', '{"release_id": "00000000-0000-0000-0000-000000000000"}') ->> 'error', 'error: release unavailable', 'nor to a release that doesn''t exist');
select is(pg_temp.ident('c1', 'q4', '{"release_id": "x"}') ->> 'error', 'error: invalid identity', 'a malformed identity is refused');
select is(pg_temp.ident('c1', 'q4', jsonb_build_object('release_id', pg_temp.id('us'), 'region_code', 'pal')) ->> 'error', 'error: invalid identity', 'and a release with claim fields');
select is(pg_temp.ident('c1', 'q4', pg_temp.to_claim('g', 'snes', 'unknown')) ->> 'error', 'error: invalid region', 'and a claim with the unknown region');
select is(pg_temp.as_user('c1', format('select public.relink_my_copy(%L, %L)::text', pg_temp.id('q3'), pg_temp.id('us-gh')))::jsonb - 'release_id',
          '{"moved": true, "record_status": "active"}', 'relink_my_copy identifies a claim too');
select is((select string_agg(e.source, ',' order by e.changed_at, e.id) from private.collection_item_identity_events e where e.item_id = pg_temp.id('q4')),
          'owner,owner,owner', 'each of the owner''s changes is in the history');
select is(jsonb_array_length(pg_temp.history('c1', 'q4')), 3, 'which the owner reads');
select is(pg_temp.history('c1', 'q4') -> 0 -> 'current' ->> 'edition_name', 'Black Label', 'newest first');
select is(pg_temp.history('c1', 'q4') -> 2 -> 'previous', jsonb_build_object('game_id', pg_temp.id('g'), 'platform_id', (select id from public.platforms where slug = 'snes'),
          'region_code', null, 'edition_kind', null, 'edition_name', null), 'and the oldest records what the copy was');
select is((select count(*)::int from private.collection_item_identity_events e where e.item_id = pg_temp.id('q1')), 0, 'a copy never changed has no history');

-- ---------------------------------------------------------------------------
-- 8. Reads: list, detail, summary, ownership
-- ---------------------------------------------------------------------------
select is((select string_agg(e ->> 'status', ',' order by e ->> 'status') from jsonb_array_elements(pg_temp.mine('c1', 'p_status => ''unidentified''') -> 'items') e),
          'unidentified,unidentified,unidentified,unidentified,unidentified,unidentified,unidentified,unidentified,unidentified', 'the list filters unidentified copies');
select is((select count(*)::int from jsonb_array_elements(pg_temp.mine('c1', 'p_query => ''crash coast''') -> 'items') e), 12, 'search finds claims by their game''s title');
select is((select string_agg(e -> 'claim' -> 'platform' ->> 'slug', ',') from jsonb_array_elements(pg_temp.mine('c1', 'p_platform => ''nes''') -> 'items') e), 'nes',
          'the platform filter finds a claim by its platform');
select is((select e -> 'claim' ->> 'catalog_pairing' from jsonb_array_elements(pg_temp.mine('c1', 'p_platform => ''nes''') -> 'items') e), 'false',
          'a claim on a platform the catalog doesn''t list says so');
select is((pg_temp.item('c1', 'q1') -> 'claim') - 'platform', '{"region": {"code": "pal", "label": "PAL"}, "edition_kind": "reprint", "edition_name": "Platinum", "catalog_pairing": true}',
          'a claim''s detail has its region, edition and verified pairing');
select is(pg_temp.item('c1', 'q1') ->> 'identity', 'claim', 'and says it''s a claim');
select is(pg_temp.item('c1', 'q1') ->> 'release', null, 'with no release');
select is(pg_temp.item('c1', 'q1') -> 'game' ->> 'title', 'Flx Crash Coast', 'and its game');
select is(pg_temp.item('c1', 'i1') ->> 'identity', 'release', 'an identified copy says so');
select is(pg_temp.item('c1', 'i1') ->> 'claim', null, 'and has no claim');
select is(pg_temp.summary('c1') - 'platforms', '{"total": 12, "owned": 3, "pending": 0, "not_approved": 0, "invalid": 0, "unidentified": 9, "limit": 100000}'::jsonb,
          'the summary keeps confirmed copies and unidentified ones apart');
select is((select string_agg((e ->> 'slug') || ':' || (e ->> 'count'), ',' order by e ->> 'slug') from jsonb_array_elements(pg_temp.summary('c1') -> 'platforms') e), 'nes:1,snes:11',
          'and groups both by platform');
select is(pg_temp.owns('c1', 'g') ->> 'owned', 'true', 'the owner owns the game');
select is(pg_temp.owns('c1', 'g') ->> 'copies', '12', 'with every copy counted');
select is((select string_agg((e ->> 'status') || ':' || coalesce(e -> 'region' ->> 'code', '?') || ':' || coalesce(e ->> 'edition_name', '?') || ':' || (e ->> 'count'), ',')
           from jsonb_array_elements(pg_temp.owns('c1', 'g') -> 'entries') e where e -> 'platform' ->> 'slug' = 'snes' and e ->> 'status' = 'unidentified' and e -> 'region' ->> 'code' = 'pal'),
          'unidentified:pal:Platinum:2,unidentified:pal:?:1', 'and what they own by region and edition, with copies of the same claim counted together');
select is(pg_temp.owns('c1', 'k') ->> 'owned', 'false', 'a game they have no copy of isn''t owned');
-- M12b-0: the pairing is the catalog's, for a copy of a release as for a claim.
select is((select string_agg(distinct e ->> 'catalog_pairing', ',') from jsonb_array_elements(pg_temp.owns('c1', 'g') -> 'entries') e where e ->> 'release_id' is not null), 'true',
          'a copy of a release is on a pairing the catalog publishes');
select is((select string_agg(distinct (e -> 'platform' ->> 'slug') || ':' || (e ->> 'catalog_pairing'), ',') from jsonb_array_elements(pg_temp.owns('c1', 'g') -> 'entries') e
           where e ->> 'release_id' is null), 'nes:false,snes:true', 'and a claim says whether its pairing is published');

-- ---------------------------------------------------------------------------
-- 9. Exclusions preserve claims on the game they exclude
-- ---------------------------------------------------------------------------
select pg_temp.claim('c1', 'k1', 'k', 'snes', 'ntsc-uc', null, null, '{"notes": "Mine"}');
select pg_temp.claim('c2', 'k2', 'k', 'snes');
select pg_temp.claim('c2', 'k3', 'k', 'nes', null, 'collector', 'Collector''s Edition');
select pg_temp.add('c1', 'kl', 'lone');
select pg_temp.claim('c1', 'j0', 'j', 'snes', 'pal');
select pg_temp.add('c1', 'jc', 'j1');
create temp table before as
  select name, (select to_jsonb(c) - array['record_status', 'invalidated_at', 'updated_at'] from public.collection_items c where c.id = ids.id) as copy,
         (select to_jsonb(p) from public.collection_item_private p where p.item_id = ids.id) as details
  from ids where name in ('k1', 'k2', 'k3', 'kl');
select is((select (private.exclusion_plan(pg_temp.id('lone')) ->> 'copies') || '/' || (private.exclusion_plan(pg_temp.id('lone')) ->> 'claimed_copies')), '4/3',
          'excluding a game''s last release counts the claims on it with its copies');
select is((select private.exclusion_plan(pg_temp.id('j1')) ->> 'claimed_copies'), '0', 'a release whose game stays published preserves no claim');
select is(pg_temp.exclude('e6', 'lone') like '{%', true, 'the last release is excluded, and its game with it');
select is((select status::text from public.games where id = pg_temp.id('k')), 'excluded', 'the game is excluded');
select is((select string_agg(pg_temp.status(n), ',' order by n) from unnest(array['k1', 'k2', 'k3', 'kl']) n), 'invalid_preserved,invalid_preserved,invalid_preserved,invalid_preserved',
          'its claims, on any platform, are preserved with the release''s copies');
select is((select count(*)::int from before b where b.copy = (select to_jsonb(c) - array['record_status', 'invalidated_at', 'updated_at'] from public.collection_items c where c.id = pg_temp.id(b.name))
           and b.details is not distinct from (select to_jsonb(p) from public.collection_item_private p where p.item_id = pg_temp.id(b.name))), 4,
          'nothing about them changes: game, platform, region, edition and private details stay');
select is((select string_agg(i.name || ':' || coalesce(ec.claimed_game_id = pg_temp.id('k'), false)::text, ',' order by i.name)
           from private.catalog_exclusion_copies ec join ids i on i.id = ec.item_id where ec.exclusion_id = pg_temp.id('x-lone')),
          'k1:true,k2:true,k3:true,kl:false', 'the exclusion records each claim it preserved, and for which game');
select is((select copies_preserved || '/' || owners_affected from private.catalog_exclusions where id = pg_temp.id('x-lone')), '4/2', 'and counts them');
select is((select count(*)::int from public.notifications where type = 'catalog_exclusion' and recipient_id = pg_temp.u('c2')), 1, 'the claim''s owner is told once');
select is((select count(*)::int from private.collection_item_identity_events e where e.item_id in (pg_temp.id('k1'), pg_temp.id('kl'))), 0,
          'preserving isn''t an identity change: the copies are what they were');
select is(pg_temp.item('c1', 'k1') ->> 'status', 'invalid', 'the owner sees the claim as preserved');
select is(pg_temp.j(pg_temp.as_user('c1', format('select public.get_my_preserved_claim(%L)::text', pg_temp.id('k1')))) -> 'game' ->> 'title', 'Flx Lone Keep',
          'with what was claimed');
select is(pg_temp.j(pg_temp.as_user('c1', format('select public.get_my_preserved_claim(%L)::text', pg_temp.id('k1')))) -> 'exclusion' ->> 'reason_code', 'no_game_data',
          'and why');
select is(pg_temp.as_user('c2', format('select coalesce(public.get_my_preserved_claim(%L)::text, ''null'')', pg_temp.id('k1'))), 'null', 'which nobody else reads');
select is((select string_agg(v -> 'platform' ->> 'slug', ',' order by v -> 'platform' ->> 'slug') from jsonb_each(pg_temp.j(pg_temp.as_user('c2', format(
            'select public.get_my_preserved_titles(array[%L, %L]::uuid[])::text', pg_temp.id('k2'), pg_temp.id('k3'))))) as t(k, v)),
          'nes,snes', 'the export names preserved claims too');
select is(pg_temp.owns('c1', 'k') ->> 'owned', 'false', 'a preserved copy doesn''t count as owned');
select is(jsonb_array_length(pg_temp.owns('c1', 'k') -> 'entries'), 2, 'but is still listed, claim and release copy');
select is(pg_temp.summary('c2') ->> 'invalid', '2', 'and counted as preserved');
-- M12b-0: preserved claims keep their claimed platform in the counts.
select is((select string_agg((e ->> 'slug') || ':' || (e ->> 'count'), ',' order by e ->> 'slug') from jsonb_array_elements(pg_temp.summary('c2') -> 'platforms') e), 'nes:1,snes:1',
          'preserved claims are counted on their claimed platforms');
select is(pg_temp.claim('c2', 'kx', 'k', 'snes'), 'error: game unavailable', 'no new claim can be made on the excluded game');
select is(pg_temp.ident('c2', 'k2', pg_temp.to_claim('k', 'snes', 'pal')) ->> 'error', 'error: game unavailable', 'nor can a preserved claim be changed on it');
select is(pg_temp.as_user('c2', format($$select public.update_collection_item(%L, '{"completeness": "loose"}')::text$$, pg_temp.id('k2'))), 'error: item preserved',
          'its details are kept as they are');
-- The owner moves one preserved claim on, then the exclusion is restored.
select is(pg_temp.ident('c1', 'k1', pg_temp.to_release('j1')) ->> 'record_status', 'active', 'the owner can identify a preserved claim as another release, which makes it active');
select is((select e.previous ->> 'game_id' from private.collection_item_identity_events e where e.item_id = pg_temp.id('k1')), pg_temp.id('k')::text,
          'and the history keeps what it was claimed as');
select is((pg_temp.j(pg_temp.as_user('a7', format('select public.get_exclusion(%L)::text', pg_temp.id('x-lone')))) -> 'copies') - 'removed', '{"moved": 1, "still_preserved": 3}',
          'the exclusion shows one copy moved and three still preserved');
-- M12b-0: a preserved claim made active where it is is no longer preserved, so it's
-- counted as moved. The owner can change a claim only while its game is published, so
-- the game is published again for this by maintenance, then excluded again.
update public.games set status = 'published' where id = pg_temp.id('k');
select is(pg_temp.ident('c2', 'k2', pg_temp.to_claim('k', 'snes', 'pal')) ->> 'record_status', 'active',
          'the owner gives a preserved claim a region, on the same game, which makes it active');
update public.games set status = 'excluded' where id = pg_temp.id('k');
select is((pg_temp.j(pg_temp.as_user('a7', format('select public.get_exclusion(%L)::text', pg_temp.id('x-lone')))) -> 'copies'), '{"moved": 2, "removed": 0, "still_preserved": 2}',
          'and the exclusion counts it as moved, not as still preserved');
select is((select count(*)::int from private.catalog_exclusion_copies where exclusion_id = pg_temp.id('x-lone')), 4, 'the exclusion''s record is unchanged');
select is(pg_temp.j(pg_temp.restore('a7', 'lone')) ->> 'copies', '2', 'restoring brings back only the copies still preserved by it');
select is(pg_temp.claim_of('k2'), '-/snes/pal/-/-', 'and leaves the changed claim as it is');
select is((select string_agg(pg_temp.status(n), ',' order by n) from unnest(array['k2', 'k3', 'kl']) n), 'active,active,active', 'they''re active again');
select is((select release_id = pg_temp.id('j1') from public.collection_items where id = pg_temp.id('k1')), true, 'the copy the owner moved stays where they put it');
select is(pg_temp.claim_of('k3'), '-/nes/-/collector/Collector''s Edition', 'and the restored claim is as it was');
select is(pg_temp.owns('c2', 'k') ->> 'owned', 'true', 'the claim''s owner owns the game again');

-- An identified copy on an excluded release is never turned into a claim, but the owner may.
select is(pg_temp.exclude('e6', 'j1') like '{%', true, 'a release whose game keeps another is excluded');
select is((select status::text from public.games where id = pg_temp.id('j')), 'published', 'its game stays published');
select is(pg_temp.status('j0'), 'active', 'so a claim on the game stays active');
select is((select release_id = pg_temp.id('j1') and record_status = 'invalid_preserved' from public.collection_items where id = pg_temp.id('jc')), true,
          'and the copy on the release is preserved on it, not converted');
select is(pg_temp.ident('c1', 'jc', pg_temp.to_claim('j', 'snes', 'ntsc-uc', 'standard', 'Standard')) ->> 'record_status', 'active',
          'the owner may leave it unidentified, which makes it active');
select is(pg_temp.j(pg_temp.restore('a7', 'j1')) ->> 'copies', '1', 'restoring brings back only the copy still preserved on the release');
select is(pg_temp.claim_of('jc'), '-/snes/ntsc-uc/standard/Standard', 'and leaves the owner''s choice alone');

-- ---------------------------------------------------------------------------
-- 10. Merges move identified copies, never claims
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', pg_temp.claims(pg_temp.u('e5'))::text, true);
select set_config('role', 'authenticated', true);
select pg_temp.release('dup', 'g', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard');
select set_config('role', 'none', true);
select pg_temp.add('c1', 'dc', 'dup');
select is((select count(*)::int from jsonb_array_elements(pg_temp.j(pg_temp.as_user('e5', format('select public.get_merge_preview(%L, %L)::text', pg_temp.id('dup'), pg_temp.id('us')))) -> 'blocking')), 0,
          'a published duplicate can be merged');
select is(pg_temp.j(pg_temp.as_user('a7', format('select public.merge_release(%L, %L, %L, %L, %L, %L, %L)::text', pg_temp.id('dup'), pg_temp.id('us'),
            pg_temp.j(pg_temp.as_user('e5', format('select public.get_merge_preview(%L, %L)::text', pg_temp.id('dup'), pg_temp.id('us')))) ->> 'token',
            'Same release', 'Your copy now points to the main record.',
            (select coalesce(array_agg(d ->> 'field' order by d ->> 'field'), '{}') from jsonb_array_elements(pg_temp.j(pg_temp.as_user('e5',
              format('select public.get_merge_preview(%L, %L)::text', pg_temp.id('dup'), pg_temp.id('us')))) -> 'differences') d), true))) ? 'merge_id', true,
          'and is merged');
select is((select release_id = pg_temp.id('us') from public.collection_items where id = pg_temp.id('dc')), true, 'its copy moves to the target');
select is((select source from private.collection_item_identity_events where item_id = pg_temp.id('dc')), 'catalog', 'and the history says the catalog moved it');
select is(pg_temp.claim_of('q1'), '-/snes/pal/reprint/Platinum', 'claims on the game are untouched');

-- ---------------------------------------------------------------------------
-- 11. Account deletion takes the claims and their history
-- ---------------------------------------------------------------------------
select pg_temp.claim('c3', 'z1', 'g', 'snes', 'pal');
select pg_temp.ident('c3', 'z1', pg_temp.to_claim('g', 'snes', 'ntsc-uc'));
select is((select count(*)::int from private.collection_item_identity_events where owner_id = pg_temp.u('c3')), 1, 'the collector has a claim with history');
delete from auth.users where id = pg_temp.u('c3');
select is((select count(*)::int from public.collection_items where owner_id = pg_temp.u('c3')), 0, 'deleting the account deletes the claim');
select is((select count(*)::int from private.collection_item_identity_events where owner_id = pg_temp.u('c3')), 0, 'and its history');

select * from finish();
rollback;
