-- M12b: fast collecting. get_my_owned_games answers "Owned" for a page of search
-- results in one owner-scoped call, with the same rule as get_my_game_ownership; and a
-- collector who submits a game the catalog doesn't have tracks their copy at once,
-- through every outcome of the review. The submission, review, merge and exclusion
-- rules themselves are in 22, 23, 26, 27 and 29; this file checks what the collector's
-- ownership says through them.
begin;
create extension if not exists pgtap with schema extensions;
select plan(84);

-- Staff sessions are live aal2 sessions with a verified TOTP factor, as in 46.
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
create function pg_temp.j(r text) returns jsonb language sql immutable as $$
  select case when r like '{%' or r like '[%' then r::jsonb else jsonb_build_object('error', r) end
$$;

create function pg_temp.add(p_actor text, p_item text, p_release text, p_details text default '{}') returns text language plpgsql as $$
begin
  perform pg_temp.new_id(p_item);
  return pg_temp.as_user(p_actor, format('select public.add_collection_item(%L, %L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_release), p_details));
end $$;
create function pg_temp.claim(p_actor text, p_item text, p_game text, p_platform text, p_region text default null) returns text language plpgsql as $$
begin
  perform pg_temp.new_id(p_item);
  return pg_temp.as_user(p_actor, format('select public.add_unidentified_copy(%L, %L, %L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_game),
    (select id from public.platforms where slug = p_platform), p_region));
end $$;
-- get_my_owned_games for named games, as text: "{}" or the object.
create function pg_temp.owned(p_actor text, variadic p_games text[]) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.get_my_owned_games(%L::uuid[])::text', (select array_agg(pg_temp.id(g)) from unnest(p_games) g)))
$$;
-- The count for one game in that answer, 0 when it's left out.
create function pg_temp.owned_count(p_actor text, p_game text) returns int language sql as $$
  select coalesce((pg_temp.j(pg_temp.owned(p_actor, p_game)) ->> pg_temp.id(p_game)::text)::int, 0)
$$;
create function pg_temp.owns(p_actor text, p_game text) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_my_game_ownership(%L)::text', pg_temp.id(p_game))))
$$;
-- The standings of a user's copies of a game, as get_my_game_ownership lists them.
create function pg_temp.standings(p_actor text, p_game text) returns text language sql as $$
  select coalesce(string_agg((e ->> 'status') || ':' || (e ->> 'count'), ',' order by e ->> 'status'), '')
  from jsonb_array_elements(pg_temp.owns(p_actor, p_game) -> 'entries') e
$$;

-- Submitting and reviewing, as in 23. Submissions are on the SNES PAL shell, with
-- classified packaging, so they meet the publication rules (M11b-1b).
create function pg_temp.subgame(p_name text, p_actor text, p_title text) returns text language plpgsql as $$
declare r text := pg_temp.as_user(p_actor, format('select public.submit_game(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L)::text',
  p_title, 'game', null, 'snes', 'snes-cartridge-jp-pal', 'pal', '{"packaging_code": "cardboard-box"}', '[]', null, true));
begin
  if r like '{%' and (r::jsonb ->> 'outcome') = 'submitted' then
    insert into ids values (p_name, (r::jsonb ->> 'submission_id')::uuid), (p_name || '-r', (r::jsonb ->> 'release_id')::uuid),
      (p_name || '-g', (r::jsonb ->> 'game_id')::uuid);
    return 'submitted';
  end if;
  return r;
end $$;
create function pg_temp.subrel(p_name text, p_actor text, p_game text) returns text language plpgsql as $$
declare r text := pg_temp.as_user(p_actor, format('select public.submit_release(%L, %L, %L, %L, %L, %L, %L, %L)::text',
  pg_temp.id(p_game), 'snes', 'snes-cartridge-jp-pal', 'pal', '{"packaging_code": "cardboard-box", "edition_name": "Player''s Choice", "edition_kind": "reprint"}', '[]', null, true));
begin
  if r like '{%' and (r::jsonb ->> 'outcome') = 'submitted' then
    insert into ids values (p_name, (r::jsonb ->> 'submission_id')::uuid), (p_name || '-r', (r::jsonb ->> 'release_id')::uuid);
    return 'submitted';
  end if;
  return r;
end $$;
create function pg_temp.ver(p text) returns integer language sql as $$ select version from public.catalog_change_requests where id = pg_temp.id(p) $$;
create function pg_temp.rrev(p text) returns bigint language sql as $$ select revision from public.releases where id = pg_temp.id(p || '-r') $$;
create function pg_temp.grev(p text) returns bigint language sql as $$
  select g.revision from public.games g join public.releases r on r.game_id = g.id where r.id = pg_temp.id(p || '-r') $$;
create function pg_temp.st(p text) returns text language sql as $$ select status::text from public.catalog_change_requests where id = pg_temp.id(p) $$;
create function pg_temp.start(p_actor text, p text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.start_submission_review(%L, %L, %L)::text', pg_temp.id(p), pg_temp.ver(p), 'Checking the evidence'))
$$;
create function pg_temp.fix(p_actor text, p text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.update_release(%L, %L, %L)::text', pg_temp.id(p || '-r'),
    '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}', 'Completing from the photos'))
$$;
create function pg_temp.approve(p_actor text, p text, p_game_rev bigint default null) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.approve_submission(%L, %L, %L, %L, %L, %L)::text',
    pg_temp.id(p), pg_temp.ver(p), pg_temp.rrev(p), p_game_rev, 'Matches the box and cartridge', null))
$$;
create function pg_temp.changes(p_actor text, p text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.request_submission_changes(%L, %L, %L, %L)::text', pg_temp.id(p), pg_temp.ver(p), 'Add a photo of the label', 'Needs evidence'))
$$;
create function pg_temp.reject(p_actor text, p text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.reject_submission(%L, %L, %L, %L)::text', pg_temp.id(p), pg_temp.ver(p), 'No evidence it exists', null))
$$;
create function pg_temp.resubmit(p_actor text, p text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.resubmit_my_submission(%L)::text', pg_temp.id(p)))
$$;
-- Exclusion, as in 46.
create function pg_temp.exclude(p_actor text, p_release text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.exclude_release(%L, %L, ''no_game_data'', ''Holds no game'', ''Out of scope'', true, true)::text',
    pg_temp.id(p_release), pg_temp.as_user('e5', format('select public.get_exclusion_preview(%L) ->> ''token''', pg_temp.id(p_release)))))
$$;

-- c1, c2: collectors. e5, e6: catalog editors. fe: the fixtures' editor.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['c1', 'c2', 'e5', 'e6', 'fe']) as s;
update public.profiles set handle = 'fc_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['c1', 'c2', 'e5', 'e6', 'fe']) s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('e5'), 'catalog_editor'), (pg_temp.u('e6'), 'catalog_editor'), (pg_temp.u('fe'), 'catalog_editor');
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
create function pg_temp.game_of(p_name text, p_title text) returns void language plpgsql as $$
begin
  perform pg_temp.fx_on();
  insert into ids select p_name, public.create_game(p_title, 'game', null, null, null, 'unknown', 'Fast collecting tests');
  perform pg_temp.fx_off();
  perform public.verify_game(pg_temp.id(p_name), 'Fast collecting tests', (select revision from public.games where id = pg_temp.id(p_name)));
end $$;
create function pg_temp.release(p_name text, p_game text, p_format text, p_region text, p_edition text, p_kind text) returns void language plpgsql as $$
declare r uuid;
begin
  perform pg_temp.fx_on();
  r := public.create_release(pg_temp.id(p_game), (select id from public.platforms where slug = 'snes'), p_format, p_region,
    jsonb_build_object('edition_name', p_edition, 'edition_kind', p_kind, 'media_count', 1, 'packaging_code', 'cardboard-box', 'product_code', 'FCS-' || upper(p_name)), 'Fast collecting tests');
  perform pg_temp.fx_off();
  perform public.verify_release(r, 'Fast collecting tests', (select revision from public.releases where id = r));
  perform public.publish_release(r, 'Fast collecting tests', (select revision from public.releases where id = r));
  insert into ids values (p_name, r);
end $$;
grant execute on function pg_temp.release(text, text, text, text, text, text), pg_temp.game_of(text, text) to authenticated;

-- g "Fcs Star Harbor": us (NTSC-U/C Standard), gh (NTSC-U/C Greatest Hits), eu (PAL
-- Standard). k "Fcs Lone Tower": lone, its only release. h: a published game nobody owns.
select set_config('request.jwt.claims', pg_temp.claims(pg_temp.u('e5'))::text, true);
select set_config('role', 'authenticated', true);
select pg_temp.game_of('g', 'Fcs Star Harbor');
select pg_temp.release('us', 'g', 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard');
select pg_temp.release('gh', 'g', 'snes-game-pak-na', 'ntsc-uc', 'Greatest Hits', 'reprint');
select pg_temp.release('eu', 'g', 'snes-cartridge-jp-pal', 'pal', 'Standard', 'standard');
select pg_temp.game_of('k', 'Fcs Lone Tower');
select pg_temp.release('lone', 'k', 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard');
select pg_temp.game_of('h', 'Fcs Quiet Hill');
select pg_temp.release('hu', 'h', 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard');
select set_config('role', 'none', true);

-- ---------------------------------------------------------------------------
-- 1. get_my_owned_games: one call, the owner's own copies, the same rule
-- ---------------------------------------------------------------------------
select is(has_function_privilege('anon', 'public.get_my_owned_games(uuid[])', 'execute'), false, 'visitors can''t call it');
select is(has_function_privilege('authenticated', 'public.get_my_owned_games(uuid[])', 'execute'), true, 'signed-in users can');
select is((select prosecdef from pg_proc where oid = 'public.get_my_owned_games(uuid[])'::regprocedure), true, 'it''s a definer, as get_my_game_ownership is');
select is((select proconfig from pg_proc where oid = 'public.get_my_owned_games(uuid[])'::regprocedure), array['search_path=""'], 'with an empty search path');

select pg_temp.add('c1', 'a', 'us');
select pg_temp.add('c1', 'b', 'gh');
select pg_temp.add('c1', 'b2', 'gh');
select pg_temp.claim('c1', 'q', 'g', 'snes', 'pal');
select pg_temp.claim('c1', 'qn', 'g', 'nes');
select pg_temp.add('c1', 'l', 'lone');
select pg_temp.claim('c1', 'kq', 'k', 'snes', 'pal');
select is(pg_temp.owned('c1', 'g', 'k', 'h'), jsonb_build_object(pg_temp.id('g'), 5, pg_temp.id('k'), 2)::text,
          'the owner''s copies per game: releases, several of one edition and unidentified copies all count; an unowned game is left out');
select is(pg_temp.owned_count('c1', 'g'), (pg_temp.owns('c1', 'g') ->> 'copies')::int, 'it agrees with get_my_game_ownership');
select is(pg_temp.owned('c2', 'g', 'k', 'h'), '{}', 'another collector owns none of them, and reads none of the first one''s');
select is(pg_temp.as_ended('c1', format('select public.get_my_owned_games(array[%L]::uuid[])::text', pg_temp.id('g'))), '{}', 'an ended session reads nothing');
select is(pg_temp.as_anon(format('select public.get_my_owned_games(array[%L]::uuid[])::text', pg_temp.id('g'))) like 'error: permission denied%', true,
          'nor does a visitor');
select is(pg_temp.as_user('c1', 'select public.get_my_owned_games(array(select gen_random_uuid() from generate_series(1, 51)))::text'), 'error: too many games',
          'more than one page of games is refused, not cut short');
select is(pg_temp.as_user('c1', 'select public.get_my_owned_games(array(select gen_random_uuid() from generate_series(1, 50)))::text'), '{}', 'fifty is allowed');
select is(pg_temp.as_user('c1', 'select public.get_my_owned_games(null)::text'), 'error: too many games', 'and nothing named is refused too');
select is(pg_temp.as_user('c1', 'select public.get_my_owned_games(''{}''::uuid[])::text'), '{}', 'an empty page reads nothing');
select is(pg_temp.as_user('c1', format('select public.get_my_owned_games(array[%L, %L]::uuid[])::text', pg_temp.id('g'), pg_temp.id('us'))),
          jsonb_build_object(pg_temp.id('g'), 5)::text, 'an id that isn''t a game matches nothing');

-- A preserved copy is listed on the game's page but doesn't count, here or there.
select is(pg_temp.exclude('e6', 'lone') like '{%', true, 'the only release of k is excluded, and k with it');
select is((select record_status::text from public.collection_items where id = pg_temp.id('kq')), 'invalid_preserved', 'the unidentified copy of k is preserved too');
select is(pg_temp.owned_count('c1', 'k'), 0, 'neither preserved copy counts, with or without a release');
select is(pg_temp.owns('c1', 'k') ->> 'owned', 'false', 'as on the game''s page');
select is(pg_temp.standings('c1', 'k'), 'invalid:1,invalid:1', 'which still lists both');

-- ---------------------------------------------------------------------------
-- 2. A game the catalog doesn't have: submitted, and tracked at once
-- ---------------------------------------------------------------------------
select is(pg_temp.subgame('m', 'c1', 'Fcs Missing Quest'), 'submitted', 'the collector submits the missing game with its release');
select is(pg_temp.j(pg_temp.add('c1', 'mc', 'm-r', '{"completeness": "complete", "notes": "From a fair", "purchase_price": "15", "currency": "EUR"}')) ->> 'created', 'true', 'and adds their copy at once, on their own pending release');
select is((pg_temp.j(pg_temp.as_user('c1', format('select public.add_collection_item(%L, %L, ''{}'')::text', pg_temp.id('mc'), pg_temp.id('m-r')))) ->> 'created'), 'false',
          'adding it again with the same id gets the same copy back');
select is((select count(*)::int from public.collection_items where release_id = pg_temp.id('m-r')), 1, 'so there is one copy');
select is(pg_temp.owned_count('c1', 'm-g'), 1, 'it counts towards "Owned" straight away');
select is(pg_temp.standings('c1', 'm-g'), 'pending:1', 'as a copy awaiting catalog approval, not a confirmed one');
select is(pg_temp.j(pg_temp.as_user('c1', 'select public.get_my_collection_summary()::text')) ->> 'pending', '1', 'and the summary counts it as pending');
select is(pg_temp.add('c2', 'mx', 'm-r'), 'error: release unavailable', 'nobody else can add a copy of the pending release');
select is(pg_temp.claim('c2', 'mq', 'm-g', 'snes'), 'error: game unavailable', 'or claim the unpublished game');
select is(pg_temp.owned_count('c2', 'm-g'), 0, 'or reads anything about it');
select is(pg_temp.as_user('c1', format('select public.withdraw_my_submission(%L)::text', pg_temp.id('m'))), 'error: submission in use',
          'the submission can''t be withdrawn while the copy is on it');

-- Changes requested, then approved.
select ok(pg_temp.start('e5', 'm') ~ '^[0-9]+$', 'an editor starts the review');
select ok(pg_temp.changes('e5', 'm') ~ '^[0-9]+$', 'and asks for changes');
select is(pg_temp.standings('c1', 'm-g'), 'pending:1', 'the copy is still awaiting approval');
select is(pg_temp.owned_count('c1', 'm-g'), 1, 'and still counts');
select ok(pg_temp.resubmit('c1', 'm') like '{%' and pg_temp.st('m') = 'open', 'the collector sends it back');
select ok(pg_temp.start('e6', 'm') ~ '^[0-9]+$', 'another editor reviews it');
select is(pg_temp.fix('e6', 'm'), 'true', 'completes it');
select is(pg_temp.approve('e6', 'm', pg_temp.grev('m')) like '{%', true, 'and approves it');
select is(pg_temp.standings('c1', 'm-g'), 'owned:1', 'the copy is now a confirmed copy of a catalog release');
select is((select row(c.release_id = pg_temp.id('m-r'), c.completeness, p.notes, p.purchase_price::text)::text
           from public.collection_items c join public.collection_item_private p on p.item_id = c.id where c.id = pg_temp.id('mc')),
          '(t,complete,"From a fair",15.0000)', 'with everything the collector recorded');
select is(pg_temp.j(pg_temp.as_user('c1', 'select public.get_my_collection_summary()::text')) ->> 'pending', '0', 'and nothing is pending any more');

-- A missing release of a game the catalog has, rejected.
select is(pg_temp.subrel('pc', 'c1', 'g'), 'submitted', 'the collector submits a release of g the catalog doesn''t have');
select is(pg_temp.j(pg_temp.add('c1', 'pcc', 'pc-r')) ->> 'created', 'true', 'and adds their copy of it');
select is(pg_temp.owned_count('c1', 'g'), 6, 'which counts with their other copies of g');
select ok(pg_temp.start('e5', 'pc') ~ '^[0-9]+$', 'an editor reviews it');
select ok(pg_temp.reject('e5', 'pc') ~ '^[0-9]+$', 'and rejects it');
select is((select record_status::text from public.collection_items where id = pg_temp.id('pcc')), 'active', 'the copy stays in the collection');
select is((select string_agg(e ->> 'status', ',') from jsonb_array_elements(pg_temp.owns('c1', 'g') -> 'entries') e where e ->> 'release_id' = pg_temp.id('pc-r')::text),
          'not_approved', 'shown as not approved');
select is(pg_temp.owned_count('c1', 'g'), 6, 'and still counts as one the collector owns, as on the game''s page');
select is(pg_temp.as_user('c1', format('select public.set_my_copy_identity(%L, %L)::text', pg_temp.id('pcc'),
            jsonb_build_object('game_id', pg_temp.id('g'), 'platform_id', (select id from public.platforms where slug = 'snes'), 'region_code', 'pal', 'edition_name', 'Player''s Choice')))::jsonb ->> 'identity',
          'claim', 'the collector can keep it as an unidentified copy with what they know');
select is(pg_temp.owned_count('c1', 'g'), 6, 'which counts the same');

-- A missing game, rejected. Its game isn't published, so the copy can't be kept without
-- a release of it (can_claim takes published games only, and isn't loosened for this):
-- it stays, not approved, until its owner moves it to a release the catalog has.
select is(pg_temp.subgame('n', 'c1', 'Fcs Never Was'), 'submitted', 'the collector submits a game the catalog doesn''t have');
select is(pg_temp.j(pg_temp.add('c1', 'ncc', 'n-r', '{"notes": "Boxed, from a fair"}')) ->> 'created', 'true', 'and adds their copy of it');
select ok(pg_temp.start('e5', 'n') ~ '^[0-9]+$', 'an editor reviews it');
select ok(pg_temp.reject('e5', 'n') ~ '^[0-9]+$', 'and rejects it');
select is((select status::text from public.games where id = pg_temp.id('n-g')), 'rejected', 'the game is rejected with its release');
select is((select record_status::text || '/' || release_id::text from public.collection_items where id = pg_temp.id('ncc')), 'active/' || pg_temp.id('n-r'),
          'the copy stays in the collection, on the rejected release');
select is(pg_temp.standings('c1', 'n-g'), 'not_approved:1', 'shown as not approved on the owner''s view of the game');
select is(pg_temp.owned_count('c1', 'n-g'), 1, 'and counted, as a copy the collector has');
select is(pg_temp.as_user('c1', format('select public.set_my_copy_identity(%L, %L)::text', pg_temp.id('ncc'),
            jsonb_build_object('game_id', pg_temp.id('n-g'), 'platform_id', (select id from public.platforms where slug = 'snes'), 'region_code', 'pal'))),
          'error: game unavailable', 'it can''t become an unidentified copy of the rejected game');
select is(pg_temp.as_user('c1', format('select public.add_unidentified_copy(%L, %L, %L, %L)::text', gen_random_uuid(), pg_temp.id('n-g'),
            (select id from public.platforms where slug = 'snes'), 'pal')),
          'error: game unavailable', 'nor can a new one be added to it');
select is((select release_id from public.collection_items where id = pg_temp.id('ncc')), pg_temp.id('n-r'), 'and the copy is unchanged by either refusal');
select is(pg_temp.j(pg_temp.as_user('c1', format('select public.relink_my_copy(%L, %L)::text', pg_temp.id('ncc'), pg_temp.id('us')))) ->> 'release_id',
          pg_temp.id('us')::text, 'the owner moves it to a published release of the game it really is');
select is((select c.release_id::text || '/' || p.notes from public.collection_items c join public.collection_item_private p on p.item_id = c.id where c.id = pg_temp.id('ncc')),
          pg_temp.id('us')::text || '/Boxed, from a fair', 'keeping what they recorded');
select is(pg_temp.owned_count('c1', 'n-g'), 0, 'and the rejected game no longer counts it');

-- ---------------------------------------------------------------------------
-- 3. A submission form sent again makes no second submission (submit_*_once)
-- ---------------------------------------------------------------------------
create function pg_temp.once_game(p_actor text, p_request text, p_title text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.submit_game_once(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)::text',
    pg_temp.id(p_request), p_title, 'game', null, 'snes', 'snes-cartridge-jp-pal', 'pal', '{"packaging_code": "cardboard-box"}', '[]', null, true))
$$;
create function pg_temp.once_release(p_actor text, p_request text, p_game text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.submit_release_once(%L, %L, %L, %L, %L, %L, %L, %L, %L)::text',
    pg_temp.id(p_request), pg_temp.id(p_game), 'snes', 'snes-cartridge-jp-pal', 'pal',
    '{"packaging_code": "cardboard-box", "edition_name": "Classics", "edition_kind": "reprint"}', '[]', null, true))
$$;
create function pg_temp.subs(p_actor text) returns int language sql as $$
  select count(*)::int from public.catalog_change_requests where submitted_by = pg_temp.u(p_actor)
$$;

select is(has_function_privilege('anon', 'public.submit_game_once(uuid,text,game_kind,integer,text,text,text,jsonb,jsonb,text,boolean)', 'execute')
          or has_function_privilege('anon', 'public.submit_release_once(uuid,uuid,text,text,text,jsonb,jsonb,text,boolean)', 'execute'), false, 'visitors can''t submit once either');
select is(has_function_privilege('authenticated', 'public.submit_game_once(uuid,text,game_kind,integer,text,text,text,jsonb,jsonb,text,boolean)', 'execute')
          and has_function_privilege('authenticated', 'public.submit_release_once(uuid,uuid,text,text,text,jsonb,jsonb,text,boolean)', 'execute'), true, 'signed-in users can');
select is(has_function_privilege('authenticated', 'private.repeated_submission(uuid)', 'execute')
          or has_function_privilege('authenticated', 'private.record_submission_request(uuid,jsonb)', 'execute'), false, 'but not the private helpers');
select is(has_table_privilege('authenticated', 'private.submission_requests', 'select'), false, 'nor read the requests');

select pg_temp.new_id('rq1');
select is(pg_temp.subs('c2'), 0, 'the second collector has submitted nothing yet');
select is(pg_temp.j(pg_temp.once_game('c2', 'rq1', 'Fcs Only Once')) ->> 'outcome', 'submitted', 'a new game is submitted');
select is(pg_temp.subs('c2'), 1, 'once');
select is(pg_temp.j(pg_temp.once_game('c2', 'rq1', 'Fcs Only Once')) ->> 'repeated', 'true', 'sent again, the request is answered with what it made');
select is(pg_temp.j(pg_temp.once_game('c2', 'rq1', 'Fcs Only Twice')) ->> 'submission_id',
          (select id::text from public.catalog_change_requests where submitted_by = pg_temp.u('c2')), 'even with a field changed: the same submission');
select is(pg_temp.subs('c2') || '/' || (select count(*) from public.games where title like 'Fcs Only %'), '1/1', 'and no second submission or game');
select is(pg_temp.once_game('c1', 'rq1', 'Fcs Only Once'), 'error: request conflict', 'another user can''t send it as theirs');
select is(pg_temp.as_ended('c2', format('select public.submit_game_once(%L, %L, %L, %L, %L, %L, %L)::text', pg_temp.id('rq1'), 'Fcs Only Once', 'game', null, 'snes', 'snes-cartridge-jp-pal', 'pal')),
          'error: not permitted', 'nor can an ended session');
select is(pg_temp.as_user('c2', 'select public.submit_game_once(null, ''Fcs Nothing'', ''game'', null, ''snes'', ''snes-cartridge-jp-pal'', ''pal'')::text'),
          'error: invalid submission', 'a request needs an id');
select pg_temp.new_id('rq2');
select is(pg_temp.j(pg_temp.once_release('c2', 'rq2', 'g')) ->> 'outcome', 'submitted', 'a release of a catalog game is submitted');
select is(pg_temp.j(pg_temp.once_release('c2', 'rq2', 'g')) ->> 'repeated', 'true', 'and sent again, answered as made, not refused as already submitted');
select is(pg_temp.subs('c2'), 2, 'still one submission each');
select pg_temp.new_id('rq3');
select is(pg_temp.once_release('c2', 'rq3', 'g'), 'error: already submitted', 'a new request for the same release is still refused, as before');
select is((select count(*)::int from private.submission_requests where request_id = pg_temp.id('rq3')), 0, 'and records nothing');
delete from public.catalog_change_requests where submitted_by = pg_temp.u('c2') and request_type = 'new_release';
select is((select count(*)::int from private.submission_requests where request_id = pg_temp.id('rq2')), 0, 'a request goes with its submission');

select * from finish();
rollback;
