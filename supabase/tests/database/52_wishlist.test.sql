-- M12 W1: the physical wishlist. Four levels of want pointing at the catalog, one entry
-- per exact target, owner-only through a live session, written only through its
-- functions, and catalog changes (merges, exclusions, restorations) resolved when read.
-- Races between adds and catalog changes, and the limit under concurrency, are in
-- db-wishlist-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(193);

-- Sessions and helpers, as in 46.
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
create function pg_temp.pl(p text) returns uuid language sql stable as $$ select id from public.platforms where slug = p $$;

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
create function pg_temp.run_anon(p_sql text) returns text language plpgsql as $t$
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
create function pg_temp.as_user(p_actor text, p_sql text) returns text language sql as $$ select pg_temp.run(pg_temp.claims(pg_temp.u(p_actor)), p_sql) $$;
create function pg_temp.as_ended(p_actor text, p_sql text) returns text language sql as $$ select pg_temp.run(pg_temp.claims(pg_temp.u(p_actor), gen_random_uuid()), p_sql) $$;
create function pg_temp.j(r text) returns jsonb language sql immutable as $$
  select case when r like '{%' or r like '[%' then r::jsonb else jsonb_build_object('error', r) end
$$;

-- Targets, by fixture name.
create function pg_temp.t_release(p text) returns jsonb language sql stable as $$ select jsonb_build_object('release_id', pg_temp.id(p)) $$;
create function pg_temp.t_game(p_game text, p_platform text default null, p_region text default null) returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object('game_id', pg_temp.id(p_game), 'platform_id', pg_temp.pl(p_platform), 'region_code', p_region))
$$;
-- add_wishlist_item as a user, with a fresh named id; again with the same id.
create function pg_temp.want(p_actor text, p_item text, p_target jsonb, p_details jsonb default '{}') returns jsonb language plpgsql as $$
begin
  perform pg_temp.new_id(p_item);
  return pg_temp.j(pg_temp.as_user(p_actor, format('select public.add_wishlist_item(%L, %L, %L)::text', pg_temp.id(p_item), p_target, p_details)));
end $$;
create function pg_temp.rewant(p_actor text, p_item text, p_target jsonb, p_details jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.add_wishlist_item(%L, %L, %L)::text', pg_temp.id(p_item), p_target, p_details)))
$$;
create function pg_temp.edit(p_actor text, p_item text, p_changes jsonb) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.update_wishlist_item(%L, %L)::text', pg_temp.id(p_item), p_changes)))
$$;
create function pg_temp.drop_item(p_actor text, p_item text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.remove_wishlist_item(%L)::text', pg_temp.id(p_item)))
$$;
create function pg_temp.list(p_actor text, p_args text default '') returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_my_wishlist(%s)::text', p_args)))
$$;
create function pg_temp.entry(p_actor text, p_item text) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_my_wishlist_item(%L)::text', pg_temp.id(p_item))))
$$;
create function pg_temp.for_game(p_actor text, p_game text) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_my_wishlist_for_game(%L)::text', pg_temp.id(p_game))))
$$;
-- The ids of a list's items, as fixture names, in order.
create function pg_temp.names(p_list jsonb) returns text language sql stable as $$
  select coalesce(string_agg(coalesce((select name from ids where id = (i ->> 'id')::uuid and name not like 'x-%'), '?'), ',' order by n), '')
  from jsonb_array_elements(p_list -> 'items') with ordinality as t(i, n)
$$;
create function pg_temp.target_of(p_item text) returns text language sql stable as $$
  select concat_ws('/', coalesce((select name from ids where id = w.release_id), '-'), coalesce((select name from ids where id = w.game_id), '-'),
    coalesce((select slug from public.platforms where id = w.platform_id), '-'), coalesce(w.region_code, '-'))
  from public.wishlist_items w where w.id = pg_temp.id(p_item)
$$;

-- Copies, exclusion, restoration, as in 46.
create function pg_temp.add(p_actor text, p_item text, p_release text, p_details text default '{}') returns text language plpgsql as $$
begin
  perform pg_temp.new_id(p_item);
  return pg_temp.as_user(p_actor, format('select public.add_collection_item(%L, %L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_release), p_details));
end $$;
create function pg_temp.claim(p_actor text, p_item text, p_game text, p_platform text, p_region text default null, p_details text default '{}') returns text language plpgsql as $$
begin
  perform pg_temp.new_id(p_item);
  return pg_temp.as_user(p_actor, format('select public.add_unidentified_copy(%L, %L, %L, %L, null, null, %L)::text', pg_temp.id(p_item), pg_temp.id(p_game),
    pg_temp.pl(p_platform), p_region, p_details));
end $$;
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

-- c1, c2: collectors. c3: a collector whose account is deleted. b4: a collector who is
-- suspended. e5, e6: catalog editors. a7: administrator. fe: the fixtures' editor.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['c1', 'c2', 'c3', 'b4', 'e5', 'e6', 'a7', 'fe']) as s;
update public.profiles set handle = 'wl_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['c1', 'c2', 'c3', 'b4', 'e5', 'e6', 'a7', 'fe']) s);
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
create function pg_temp.game_of(p_name text, p_title text) returns void language plpgsql as $$
begin
  perform pg_temp.fx_on();
  insert into ids select p_name, public.create_game(p_title, 'game', null, null, null, 'unknown', 'Wishlist tests');
  perform pg_temp.fx_off();
  perform public.verify_game(pg_temp.id(p_name), 'Wishlist tests', (select revision from public.games where id = pg_temp.id(p_name)));
end $$;
create function pg_temp.release(p_name text, p_game text, p_platform text, p_format text, p_region text, p_edition text, p_kind text,
                                p_publish boolean default true) returns void language plpgsql as $$
declare r uuid;
begin
  perform pg_temp.fx_on();
  r := public.create_release(pg_temp.id(p_game), (select id from public.platforms where slug = p_platform), p_format, p_region,
    jsonb_build_object('edition_name', p_edition, 'edition_kind', p_kind, 'media_count', 1, 'packaging_code', 'cardboard-box', 'product_code', 'WSH-' || upper(p_name)), 'Wishlist tests');
  perform pg_temp.fx_off();
  if p_publish then
    perform public.verify_release(r, 'Wishlist tests', (select revision from public.releases where id = r));
    perform public.publish_release(r, 'Wishlist tests', (select revision from public.releases where id = r));
  end if;
  insert into ids values (p_name, r);
end $$;
grant execute on function pg_temp.release(text, text, text, text, text, text, text, boolean), pg_temp.game_of(text, text) to authenticated;

-- g "Wsh Chrono Pulse": us (SNES NTSC-U Standard), gh (SNES NTSC-U Greatest Hits), eu
-- (SNES PAL), nu (NES NTSC-U), dup (a duplicate of us, merged later), up (never
-- published). k "Wsh Lone Keep": lone, its only release. m "Wsh Merged Away": mr; the
-- game is merged into g later. h "Wsh Accented Héros": hr. n: verified, never published.
select set_config('request.jwt.claims', pg_temp.claims(pg_temp.u('e5'))::text, true);
select set_config('role', 'authenticated', true);
select pg_temp.game_of('g', 'Wsh Chrono Pulse');
select pg_temp.release('us', 'g', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard');
select pg_temp.release('gh', 'g', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Greatest Hits', 'reprint');
select pg_temp.release('eu', 'g', 'snes', 'snes-cartridge-jp-pal', 'pal', 'Standard', 'standard');
select pg_temp.release('nu', 'g', 'nes', 'nes-game-pak', 'ntsc-uc', 'Standard', 'standard');
select pg_temp.release('dup', 'g', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard');
select pg_temp.release('up', 'g', 'snes', 'snes-cartridge-jp-pal', 'ntsc-j', 'Standard', 'standard', false);
select pg_temp.game_of('k', 'Wsh Lone Keep');
select pg_temp.release('lone', 'k', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard');
select pg_temp.game_of('m', 'Wsh Merged Away');
select pg_temp.release('mr', 'm', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard');
select pg_temp.game_of('h', 'Wsh Accented Héros');
select pg_temp.release('hr', 'h', 'snes', 'snes-cartridge-jp-pal', 'pal', 'Standard', 'standard');
select pg_temp.game_of('n', 'Wsh Never Shown');
select set_config('role', 'none', true);

-- ---------------------------------------------------------------------------
-- 1. Schema and access
-- ---------------------------------------------------------------------------
select has_table('public', 'wishlist_items', 'the wishlist has its own table');
select is((select relrowsecurity from pg_class where oid = 'public.wishlist_items'::regclass), true, 'RLS is on');
select is((select string_agg(policyname || ':' || cmd, ',') from pg_policies where schemaname = 'public' and tablename = 'wishlist_items'),
          'wishlist_items_read_own:SELECT', 'one policy, for reading');
select is((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'wishlist_items' and grantee = 'authenticated'), 'SELECT',
          'clients may only read the table: every write goes through the functions');
select is((select count(*)::int from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'wishlist_items' and grantee in ('anon', 'service_role', 'PUBLIC')), 0,
          'visitors and the service role have no access');
select is((select count(*)::int from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'wishlist_items' and grantee = 'authenticated' and privilege_type <> 'SELECT'), 0,
          'and no column grant to write');
select hasnt_column('public', 'wishlist_items', 'visibility', 'no visibility yet: entries are private');
select is((select count(*)::int from pg_proc p where p.proname in ('add_wishlist_item', 'update_wishlist_item', 'remove_wishlist_item', 'get_my_wishlist',
             'get_my_wishlist_for_game', 'get_my_wishlist_item') and p.pronamespace = 'public'::regnamespace
             and has_function_privilege('anon', p.oid, 'execute')), 0, 'visitors can call none of the functions');
select is((select count(*)::int from pg_proc p where p.proname in ('add_wishlist_item', 'update_wishlist_item', 'remove_wishlist_item', 'get_my_wishlist',
             'get_my_wishlist_for_game', 'get_my_wishlist_item') and p.pronamespace = 'public'::regnamespace
             and has_function_privilege('authenticated', p.oid, 'execute') and p.prosecdef and p.proconfig @> array['search_path=""']), 6,
          'signed-in users can call all six, each a definer with an empty search_path');
select is((select count(*)::int from pg_trigger where tgrelid = 'public.wishlist_items'::regclass and not tgisinternal), 3, 'three triggers guard the table');

-- ---------------------------------------------------------------------------
-- 2. The four levels of want, and several entries for one game
-- ---------------------------------------------------------------------------
select is(pg_temp.want('c1', 'w-any', pg_temp.t_game('g')) ->> 'created', 'true', 'A: a game, any version');
select is(pg_temp.want('c1', 'w-snes', pg_temp.t_game('g', 'snes')) ->> 'created', 'true', 'B: the game on a platform');
select is(pg_temp.want('c1', 'w-snes-pal', pg_temp.t_game('g', 'snes', 'pal'), '{"priority": 1, "completeness": "complete"}') ->> 'created', 'true',
          'B+: the game on a platform in a region, with details');
select is(pg_temp.want('c1', 'w-us', pg_temp.t_release('us'), '{"note": "Want the box"}') ->> 'created', 'true', 'C: one exact release');
select is(pg_temp.want('c1', 'w-nes-us', pg_temp.t_game('g', 'nes', 'ntsc-uc')) ->> 'created', 'true', 'another platform and region of the same game');
select is(pg_temp.want('c1', 'w-gh', pg_temp.t_release('gh')) ->> 'created', 'true', 'and another release of the same game');
select is(pg_temp.target_of('w-any'), '-/g/-/-', 'A stores the game only');
select is(pg_temp.target_of('w-snes'), '-/g/snes/-', 'B stores the game and platform');
select is(pg_temp.target_of('w-snes-pal'), '-/g/snes/pal', 'B+ stores the game, platform and region');
select is(pg_temp.target_of('w-us'), 'us/-/-/-', 'C stores the release only, nothing copied from it');
select is((select priority || '/' || coalesce(completeness::text, '-') || '/' || coalesce(note, '-') from public.wishlist_items where id = pg_temp.id('w-snes-pal')),
          '1/complete/-', 'the details are stored');
select is((select priority from public.wishlist_items where id = pg_temp.id('w-any')), 2::smallint, 'priority defaults to normal');
select is((select count(*)::int from public.wishlist_items where owner_id = pg_temp.u('c1')), 6, 'six entries for one game coexist');
select is((select count(*)::int from public.releases where game_id = pg_temp.id('g')), 6, 'no release was created');
select is((select count(*)::int from public.game_platforms where game_id = pg_temp.id('g')), 2, 'nor a pairing');
select is(pg_temp.want('c2', 'w2-us', pg_temp.t_release('us')) ->> 'created', 'true', 'another collector wants the same release on their own wishlist');

-- ---------------------------------------------------------------------------
-- 3. Retries and duplicates
-- ---------------------------------------------------------------------------
select is(pg_temp.rewant('c1', 'w-us', pg_temp.t_release('us')), jsonb_build_object('item_id', pg_temp.id('w-us'), 'created', false),
          'a retry of the same request returns the same entry');
select is(pg_temp.rewant('c1', 'w-us', pg_temp.t_release('us'), '{"priority": 3}') ->> 'created', 'false', 'a retry with other details returns it too');
select is((select priority from public.wishlist_items where id = pg_temp.id('w-us')), 2::smallint, 'and doesn''t change it');
select is(pg_temp.want('c1', 'w-us-again', pg_temp.t_release('us')), jsonb_build_object('item_id', pg_temp.id('w-us'), 'created', false),
          'the same release under a new id returns the existing entry');
select is(pg_temp.want('c1', 'w-any-again', pg_temp.t_game('g')) ->> 'item_id', pg_temp.id('w-any')::text, 'and so does the same game, any version');
select is(pg_temp.want('c1', 'w-snes-pal-again', pg_temp.t_game('g', 'snes', 'pal')) ->> 'item_id', pg_temp.id('w-snes-pal')::text,
          'and the same platform and region');
select is((select count(*)::int from public.wishlist_items where owner_id = pg_temp.u('c1')), 6, 'no duplicate entry was made');
select is(pg_temp.rewant('c1', 'w-us', pg_temp.t_release('eu')) ->> 'error', 'error: request conflict', 'the same id with another target conflicts');
select is(pg_temp.rewant('c2', 'w-us', pg_temp.t_release('us')) ->> 'error', 'error: request conflict', 'another collector''s id conflicts, revealing nothing');
select is(pg_temp.want('c1', 'w-reg', jsonb_build_object('game_id', pg_temp.id('g'), 'platform_id', pg_temp.pl('snes'), 'region_code', '  ntsc-j ')) ->> 'created', 'true',
          'a region the game has no release in is allowed, trimmed');
select is(pg_temp.target_of('w-reg'), '-/g/snes/ntsc-j', 'and stored as its code');

-- ---------------------------------------------------------------------------
-- 4. Input and refusals
-- ---------------------------------------------------------------------------
select is(pg_temp.want('c1', 'bad', '[]'::jsonb) ->> 'error', 'error: invalid target', 'a target must be an object');
select is(pg_temp.want('c1', 'bad', '{}'::jsonb) ->> 'error', 'error: invalid target', 'and name something');
select is(pg_temp.want('c1', 'bad', pg_temp.t_release('us') || jsonb_build_object('platform_id', pg_temp.pl('snes'))) ->> 'error', 'error: invalid target',
          'a release can''t be narrowed');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('g') || '{"edition": "Platinum"}') ->> 'error', 'error: invalid target', 'unknown keys are refused');
select is(pg_temp.want('c1', 'bad', '{"game_id": "not a uuid"}') ->> 'error', 'error: invalid target', 'a malformed id is refused');
select is(pg_temp.want('c1', 'bad', jsonb_build_object('game_id', pg_temp.id('g'), 'region_code', 'pal')) ->> 'error', 'error: invalid target',
          'a region needs a platform');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('g', 'snes', 'unknown')) ->> 'error', 'error: invalid region', '"unknown" isn''t a region preference');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('g', 'snes', 'moon')) ->> 'error', 'error: invalid region', 'nor is a code the catalog doesn''t list');
select is(pg_temp.want('c1', 'bad', jsonb_build_object('game_id', pg_temp.id('g'), 'platform_id', 7)) ->> 'error', 'error: invalid target', 'ids are strings');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('g', 'playstation')) ->> 'error', 'error: platform unavailable', 'a platform the catalog doesn''t list for the game is refused');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('n')) ->> 'error', 'error: game unavailable', 'a game never published is refused');
select is(pg_temp.want('c1', 'bad', jsonb_build_object('game_id', gen_random_uuid())) ->> 'error', 'error: game unavailable', 'and one that doesn''t exist reads the same');
select is(pg_temp.want('c1', 'bad', pg_temp.t_release('up')) ->> 'error', 'error: release unavailable', 'a release never published is refused');
select is(pg_temp.want('c1', 'bad', jsonb_build_object('release_id', gen_random_uuid())) ->> 'error', 'error: release unavailable', 'and one that doesn''t exist reads the same');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('k'), '{"priority": 0}') ->> 'error', 'error: invalid details', 'priority is 1 to 3');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('k'), '{"priority": "1"}') ->> 'error', 'error: invalid details', 'as a number');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('k'), '{"priority": 1.5}') ->> 'error', 'error: invalid details', 'a whole one');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('k'), '{"completeness": "mint"}') ->> 'error', 'error: invalid details', 'completeness is one of the catalog''s values');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('k'), '{"price": 40}') ->> 'error', 'error: invalid details', 'and there''s no price');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('k'), jsonb_build_object('note', repeat('a', 501))) ->> 'error', 'error: invalid details', 'a note is at most 500 characters');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('k'), jsonb_build_object('note', E'tab\there')) ->> 'error', 'error: invalid details', 'without control characters');
select is((select count(*)::int from public.wishlist_items where id = pg_temp.id('bad')), 0, 'nothing refused was stored');
select is(pg_temp.want('c1', 'w-k', pg_temp.t_game('k'), jsonb_build_object('note', E'  Café\r\nboxed only \n ')) ->> 'created', 'true', 'a note is tidied');
select is((select note from public.wishlist_items where id = pg_temp.id('w-k')), E'Café\nboxed only', 'to NFC, \n line breaks, trimmed');
select is(pg_temp.want('c1', 'w-k2', pg_temp.t_game('k', 'snes'), '{"note": "   "}') ->> 'created', 'true', 'a blank note');
select is((select note is null from public.wishlist_items where id = pg_temp.id('w-k2')), true, 'is no note');
select is(pg_temp.as_user('c1', format('select public.add_wishlist_item(%L, %L)::text', gen_random_uuid(), pg_temp.t_game('h'))), 'error: invalid item id',
          'an id must be a UUIDv7');
select is(pg_temp.as_user('c1', format('select public.add_wishlist_item(%L, %L)::text',
            overlay(private.uuid_v7()::text placing '0000' from 1 for 4), pg_temp.t_game('h'))), 'error: invalid item id', 'made recently');
select is(pg_temp.as_user('c1', format('select public.add_wishlist_item(null, %L)::text', pg_temp.t_game('h'))), 'error: invalid item id', 'and given');

-- ---------------------------------------------------------------------------
-- 5. Privacy: owner-only, through a live session
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('c2', 'select count(*)::text from public.wishlist_items'), '1', 'a collector reads only their own rows');
select is(pg_temp.as_user('c2', format('select count(*)::text from public.wishlist_items where owner_id = %L', pg_temp.u('c1'))), '0', 'never another''s');
select is((pg_temp.list('c2') ->> 'total')::int, 1, 'their wishlist holds only their entry');
select is(pg_temp.as_user('c2', format('select public.get_my_wishlist_item(%L)::text', pg_temp.id('w-us'))), '', 'another''s entry by id reads as nothing');
select is(pg_temp.for_game('c2', 'g') -> 'items' -> 0 ->> 'id', pg_temp.id('w2-us')::text, 'and the game''s entries are only their own');
select is(pg_temp.edit('c2', 'w-us', '{"priority": 1}') ->> 'error', 'error: item unavailable', 'nobody else can change an entry');
select is(pg_temp.drop_item('c2', 'w-us'), 'error: item unavailable', 'or remove it');
select is(pg_temp.as_user('c2', format('update public.wishlist_items set priority = 1 where id = %L', pg_temp.id('w2-us'))) like 'error: permission denied%', true,
          'even the owner can''t update the table directly');
select is(pg_temp.as_user('c2', format('delete from public.wishlist_items where id = %L', pg_temp.id('w2-us'))) like 'error: permission denied%', true,
          'or delete from it');
select is(pg_temp.as_user('c2', format('insert into public.wishlist_items (id, owner_id, game_id) values (%L, %L, %L)', private.uuid_v7(), pg_temp.u('c2'), pg_temp.id('n'))) like 'error: permission denied%', true,
          'or insert into it, which would skip the published check');
select is(pg_temp.run_anon('select count(*)::text from public.wishlist_items') like 'error: permission denied%', true, 'a visitor can''t read the table');
select is(pg_temp.run_anon('select public.get_my_wishlist()::text') like 'error: permission denied%', true, 'or call the reads');
select is(pg_temp.run_anon(format('select public.add_wishlist_item(%L, %L)::text', private.uuid_v7(), pg_temp.t_game('g'))) like 'error: permission denied%', true,
          'or the writes');
select is(pg_temp.run(jsonb_build_object('role', 'authenticated'), 'select public.get_my_wishlist()::text'), 'error: not permitted', 'a token without a user is refused');
select is(pg_temp.as_ended('c1', 'select count(*)::text from public.wishlist_items'), '0', 'an ended session reads no rows');
select is(pg_temp.as_ended('c1', 'select public.get_my_wishlist()::text'), 'error: not permitted', 'and can''t read the wishlist');
select is(pg_temp.as_ended('c1', format('select public.get_my_wishlist_for_game(%L)::text', pg_temp.id('g'))), 'error: not permitted', 'or a game''s entries');
select is(pg_temp.as_ended('c1', format('select public.get_my_wishlist_item(%L)::text', pg_temp.id('w-us'))), 'error: not permitted', 'or an entry');
select is(pg_temp.as_ended('c1', format('select public.add_wishlist_item(%L, %L)::text', private.uuid_v7(), pg_temp.t_game('h'))), 'error: not permitted', 'or add');
select is(pg_temp.as_ended('c1', format('select public.update_wishlist_item(%L, ''{"priority": 1}'')::text', pg_temp.id('w-us'))), 'error: not permitted', 'or edit');
select is(pg_temp.as_ended('c1', format('select public.remove_wishlist_item(%L)::text', pg_temp.id('w-us'))), 'error: not permitted', 'or remove');
-- A suspended collector keeps their entries and may remove them, but not add or edit.
select is(pg_temp.want('b4', 's-a', pg_temp.t_game('g')) ->> 'created', 'true', 'a collector adds an entry');
select is(pg_temp.want('b4', 's-b', pg_temp.t_game('k')) ->> 'created', 'true', 'and another');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('b4');
select is(pg_temp.want('b4', 's-c', pg_temp.t_game('h')) ->> 'error', 'error: account not active', 'once suspended, they can''t add');
select is(pg_temp.rewant('b4', 's-a', pg_temp.t_game('g')) ->> 'created', 'false', 'though a retry of an earlier add still answers');
select is(pg_temp.edit('b4', 's-a', '{"priority": 1}') ->> 'error', 'error: account not active', 'or edit');
select is((pg_temp.list('b4') ->> 'total')::int, 2, 'they still see their wishlist');
select is(pg_temp.drop_item('b4', 's-b'), 'true', 'and can remove an entry');
-- Account deletion takes the entries.
select is(pg_temp.want('c3', 'd-a', pg_temp.t_release('us')) ->> 'created', 'true', 'a collector who will leave has an entry');
delete from auth.users where id = pg_temp.u('c3');
select is((select count(*)::int from public.wishlist_items where owner_id = pg_temp.u('c3')), 0, 'deleting the account deletes their entries');

-- ---------------------------------------------------------------------------
-- 6. Reading: filters, sorts and pages
-- ---------------------------------------------------------------------------
select pg_temp.want('c1', 'w-h', pg_temp.t_release('hr'), '{"priority": 3}');
-- Everything here runs in one transaction, so now() is the same for every entry. Give
-- them the order they were made in, a second apart (past the guard, which keeps
-- created_at as it was made).
set local session_replication_role = replica;
update public.wishlist_items w set created_at = now() - interval '1 hour' + o.n * interval '1 second'
from unnest(array['w-any', 'w-snes', 'w-snes-pal', 'w-us', 'w-nes-us', 'w-gh', 'w-reg', 'w-k', 'w-k2', 'w-h']) with ordinality as o(name, n)
where w.id = pg_temp.id(o.name);
set local session_replication_role = origin;
select is(pg_temp.names(pg_temp.list('c1', 'p_sort => ''added''')), 'w-h,w-k2,w-k,w-reg,w-gh,w-nes-us,w-us,w-snes-pal,w-snes,w-any', 'added: newest first');
select is(pg_temp.names(pg_temp.list('c1')), 'w-snes-pal,w-k2,w-k,w-reg,w-gh,w-nes-us,w-us,w-snes,w-any,w-h', 'priority (the default): high first, then newest');
select is(pg_temp.names(pg_temp.list('c1', 'p_sort => ''title''')) like 'w-h,%', true, 'title: by the game''s sort title');
select is((pg_temp.list('c1') ->> 'total')::int, 10, 'the total counts every entry');
select is(pg_temp.names(pg_temp.list('c1', 'p_platform => ''nes''')), 'w-nes-us', 'by platform: a game entry''s platform');
select is(pg_temp.names(pg_temp.list('c1', 'p_platform => ''snes'', p_sort => ''added''')), 'w-h,w-k2,w-reg,w-gh,w-us,w-snes-pal,w-snes',
          'and a release''s, never an entry that names none');
select is(pg_temp.names(pg_temp.list('c1', 'p_region => ''pal'', p_sort => ''added''')), 'w-h,w-snes-pal', 'by region: the release''s or the entry''s');
select is(pg_temp.names(pg_temp.list('c1', 'p_priority => 3')), 'w-h', 'by priority');
select is(pg_temp.names(pg_temp.list('c1', 'p_query => ''HEROS''')), 'w-h', 'by title, ignoring case and accents');
select is(pg_temp.list('c1', 'p_sort => ''price''') ->> 'error', 'error: invalid filter', 'an unknown sort is refused');
select is(pg_temp.list('c1', 'p_priority => 4') ->> 'error', 'error: invalid filter', 'and an impossible priority');
select is(pg_temp.list('c1', format('p_query => %L', repeat('a', 101))) ->> 'error', 'error: query too long', 'and a long query');
-- Pages of three, in each sort, add up to the whole list in order.
create function pg_temp.all_pages(p_actor text, p_sort text) returns text language plpgsql as $$
declare v_page jsonb; v_cursor text; v_names text := ''; v_n int := 0;
begin
  loop
    v_page := pg_temp.list(p_actor, format('p_sort => %L, p_limit => 3, p_cursor => %L', p_sort, v_cursor));
    v_names := v_names || case when v_names = '' or pg_temp.names(v_page) = '' then '' else ',' end || pg_temp.names(v_page);
    v_cursor := v_page ->> 'next_cursor';
    v_n := v_n + 1;
    exit when v_cursor is null or v_n > 10;
  end loop;
  return v_names;
end $$;
select is(pg_temp.all_pages('c1', 'priority'), pg_temp.names(pg_temp.list('c1', 'p_sort => ''priority''')), 'pages sorted by priority add up to the list');
select is(pg_temp.all_pages('c1', 'added'), pg_temp.names(pg_temp.list('c1', 'p_sort => ''added''')), 'and by added');
select is(pg_temp.all_pages('c1', 'title'), pg_temp.names(pg_temp.list('c1', 'p_sort => ''title''')), 'and by title');
select is(pg_temp.list('c1', format('p_sort => ''added'', p_cursor => %L', pg_temp.list('c1', 'p_limit => 3') ->> 'next_cursor')) ->> 'error', 'error: invalid cursor',
          'a cursor belongs to its sort and filters');
select is(pg_temp.list('c1', 'p_cursor => ''bm90IGEgY3Vyc29y''') ->> 'error', 'error: invalid cursor', 'and a made-up one is refused');
-- What an entry says.
select is(pg_temp.entry('c1', 'w-us') - array['id', 'added_at', 'updated_at', 'release', 'game'],
          '{"kind": "release", "note": "Want the box", "owned": {"copies": 0, "meeting_completeness": 0}, "state": "available", "merged": false, "region": {"code": "ntsc-uc", "label": "NTSC-U/C"}, "platform": {"name": "Super Nintendo Entertainment System", "slug": "snes", "short_name": "SNES"}, "priority": 2, "duplicate": false, "completeness": null}'::jsonb,
          'a release entry shows the release''s own platform and region');
select is(pg_temp.entry('c1', 'w-us') -> 'release' ->> 'product_code', 'WSH-US', 'and its details, from the catalog');
select is(pg_temp.entry('c1', 'w-us') -> 'game', jsonb_build_object('id', pg_temp.id('g'), 'title', 'Wsh Chrono Pulse', 'slug', (select slug from public.games where id = pg_temp.id('g'))),
          'and its game, with the slug for its page');
select is(pg_temp.entry('c1', 'w-any') ->> 'platform', null, 'an "any version" entry names no platform');
select is(pg_temp.entry('c1', 'w-any') ->> 'release', null, 'and no release');
select is(pg_temp.names(pg_temp.for_game('c1', 'g')), 'w-snes-pal,w-reg,w-gh,w-nes-us,w-us,w-snes,w-any', 'a game''s page lists its entries, high priority first');

-- ---------------------------------------------------------------------------
-- 7. Owned copies and completeness: never removed, counted
-- ---------------------------------------------------------------------------
select pg_temp.add('c1', 'cp-sealed', 'us', '{"completeness": "sealed"}');
select pg_temp.add('c1', 'cp-loose', 'us', '{"completeness": "loose"}');
select pg_temp.add('c1', 'cp-none', 'us');
select pg_temp.add('c1', 'cp-eu', 'eu', '{"completeness": "complete"}');
select pg_temp.claim('c1', 'cp-claim', 'g', 'snes', 'pal', '{"completeness": "incomplete"}');
select pg_temp.claim('c1', 'cp-claim-any', 'g', 'snes');
select is(pg_temp.edit('c1', 'w-us', '{"completeness": "complete"}') ->> 'changed', 'true', 'the collector wants the release complete at least');
select is(pg_temp.entry('c1', 'w-us') -> 'owned', '{"copies": 3, "meeting_completeness": 1}', 'three copies of it, and only the sealed one is complete or better');
select is(pg_temp.edit('c1', 'w-us', '{"completeness": "loose"}') ->> 'changed', 'true', 'loose is the lowest');
select is(pg_temp.entry('c1', 'w-us') -> 'owned', '{"copies": 3, "meeting_completeness": 2}', 'every recorded completeness meets it; an unrecorded one doesn''t');
select is(pg_temp.edit('c1', 'w-us', '{"completeness": "sealed"}') ->> 'changed', 'true', 'sealed');
select is(pg_temp.entry('c1', 'w-us') -> 'owned' ->> 'meeting_completeness', '1', 'is met only by sealed');
select is(pg_temp.edit('c1', 'w-us', '{"completeness": null}') ->> 'changed', 'true', 'with no minimum');
select is(pg_temp.entry('c1', 'w-us') -> 'owned', '{"copies": 3, "meeting_completeness": 3}', 'every copy meets it');
select is(pg_temp.entry('c1', 'w-any') -> 'owned', '{"copies": 6, "meeting_completeness": 6}', 'any version counts every copy of the game, unidentified ones too');
select is(pg_temp.entry('c1', 'w-snes-pal') -> 'owned', '{"copies": 2, "meeting_completeness": 1}',
          'SNES PAL counts the PAL release''s copy and the PAL claim, not a claim of no region; only the complete one meets "complete"');
select is(pg_temp.entry('c1', 'w-nes-us') -> 'owned', '{"copies": 0, "meeting_completeness": 0}', 'NES NTSC-U counts none');
select is((select count(*)::int from public.wishlist_items where owner_id = pg_temp.u('c1')), 10, 'owning copies removed no entry');
select is(pg_temp.drop_item('c1', 'w-gh'), 'true', 'the collector removes an entry');
select is(pg_temp.drop_item('c1', 'w-gh'), 'error: item unavailable', 'once');
select is((select count(*)::int from public.collection_items where owner_id = pg_temp.u('c1')), 6, 'removing an entry leaves the collection alone');

-- ---------------------------------------------------------------------------
-- 8. Editing
-- ---------------------------------------------------------------------------
select is(pg_temp.edit('c1', 'w-any', '{"priority": 1, "note": "Any cart"}'), jsonb_build_object('item_id', pg_temp.id('w-any'), 'changed', true), 'priority and note change');
select is(pg_temp.edit('c1', 'w-any', '{"priority": 1, "note": "Any cart"}') ->> 'changed', 'false', 'the same again changes nothing');
select is(pg_temp.edit('c1', 'w-any', '{"note": null}') ->> 'changed', 'true', 'a note is cleared with null');
select is((select priority || '/' || coalesce(note, '-') from public.wishlist_items where id = pg_temp.id('w-any')), '1/-', 'and the rest is kept');
select is(pg_temp.edit('c1', 'w-snes', jsonb_build_object('target', pg_temp.t_game('g', 'nes'))) ->> 'changed', 'true', 'the level of want can change: another platform');
select is(pg_temp.target_of('w-snes'), '-/g/nes/-', 'stored');
select is(pg_temp.edit('c1', 'w-snes', jsonb_build_object('target', pg_temp.t_release('eu'))) ->> 'changed', 'true', 'or an exact release');
select is(pg_temp.target_of('w-snes'), 'eu/-/-/-', 'stored, its platform cleared');
select is(pg_temp.edit('c1', 'w-snes', jsonb_build_object('target', pg_temp.t_game('g'))) ->> 'error', 'error: already on wishlist', 'not a target another entry has');
select is(pg_temp.edit('c1', 'w-snes', jsonb_build_object('target', pg_temp.t_release('up'))) ->> 'error', 'error: release unavailable', 'nor an unpublished one');
select is(pg_temp.edit('c1', 'w-snes', jsonb_build_object('target', pg_temp.t_game('g', 'snes', 'unknown'))) ->> 'error', 'error: invalid region', 'nor an invalid region');
select is(pg_temp.edit('c1', 'w-snes', '{"owner_id": "00000000-0000-0000-0000-0000000000c2"}') ->> 'error', 'error: invalid details', 'nothing else can change');
select is(pg_temp.edit('c1', 'w-snes', 'null') ->> 'error', 'error: invalid details', 'and changes are an object');
select is(pg_temp.target_of('w-snes'), 'eu/-/-/-', 'the refusals changed nothing');
select ok((select updated_at >= created_at from public.wishlist_items where id = pg_temp.id('w-snes')), 'updated_at is kept');
select throws_ok(format('update public.wishlist_items set owner_id = %L where id = %L', pg_temp.u('c2'), pg_temp.id('w-snes')), '23514', null,
                 'an entry never changes hands, even for the database owner');

-- ---------------------------------------------------------------------------
-- 9. Catalog changes, resolved when read
-- ---------------------------------------------------------------------------
-- Exclusion and restoration of a release whose game stays.
select is(pg_temp.exclude('e6', 'hr') like '{%', true, 'an editor excludes a game''s only release (and so the game)');
select is(pg_temp.entry('c1', 'w-h') ->> 'state', 'unavailable', 'the release entry is unavailable');
select is(pg_temp.entry('c1', 'w-h') -> 'game' ->> 'title', 'Wsh Accented Héros', 'shown with the title the owner saw');
select is(pg_temp.entry('c1', 'w-h') -> 'game' ->> 'slug', null, 'and no link: the game left the catalog');
select is(pg_temp.entry('c1', 'w-h') -> 'release' ->> 'product_code', 'WSH-HR', 'with the release''s details as they were');
select is((select release_id = pg_temp.id('hr') from public.wishlist_items where id = pg_temp.id('w-h')), true, 'the entry itself is unchanged');
select is(pg_temp.want('c1', 'bad', pg_temp.t_release('hr')) ->> 'error', 'error: release unavailable', 'an excluded release can''t be added');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('h')) ->> 'error', 'error: game unavailable', 'nor its excluded game');
select is(pg_temp.edit('c1', 'w-h', '{"note": "If it comes back"}') ->> 'changed', 'true', 'the entry can still be edited');
select is(pg_temp.j(pg_temp.restore('a7', 'hr')) ? 'copies', true, 'an administrator restores it');
select is(pg_temp.entry('c1', 'w-h') ->> 'state', 'available', 'and the entry is available again');
select is(pg_temp.entry('c1', 'w-h') -> 'game' ->> 'slug' is not null, true, 'with its link');
-- A platform leaving a game that stays published.
select is(pg_temp.exclude('e6', 'nu') like '{%', true, 'an editor excludes the game''s only NES release, and its NES pairing with it');
select is((select status::text from public.game_platforms where game_id = pg_temp.id('g') and platform_id = pg_temp.pl('nes')), 'excluded', 'the pairing is excluded');
select is(pg_temp.entry('c1', 'w-nes-us') ->> 'state', 'platform_unavailable', 'an entry for the game on NES says the platform is no longer listed');
select is(pg_temp.entry('c1', 'w-any') ->> 'state', 'available', 'while "any version" is still available');
select is(pg_temp.want('c1', 'bad', pg_temp.t_game('g', 'nes')) ->> 'error', 'error: platform unavailable', 'and NES can''t be added again');
-- A game excluded with its only release.
select is(pg_temp.exclude('e6', 'lone') like '{%', true, 'an editor excludes a game with its only release');
select is(pg_temp.entry('c1', 'w-k') ->> 'state', 'unavailable', 'the game entry is unavailable');
select is(pg_temp.entry('c1', 'w-k2') ->> 'state', 'unavailable', 'and so is its platform entry');
select is(pg_temp.entry('c1', 'w-k') -> 'game' ->> 'title', 'Wsh Lone Keep', 'shown as the owner saw it');
-- A release merged into another.
select is(pg_temp.want('c1', 'w-dup', pg_temp.t_release('dup')) ->> 'created', 'true', 'the collector wants a release that turns out to be a duplicate');
select is(pg_temp.j(pg_temp.as_user('a7', format('select public.merge_release(%L, %L, %L, %L, %L, %L, %L)::text', pg_temp.id('dup'), pg_temp.id('us'),
            pg_temp.j(pg_temp.as_user('e5', format('select public.get_merge_preview(%L, %L)::text', pg_temp.id('dup'), pg_temp.id('us')))) ->> 'token',
            'Same release', 'Merged into the main record.',
            (select coalesce(array_agg(d ->> 'field' order by d ->> 'field'), '{}') from jsonb_array_elements(pg_temp.j(pg_temp.as_user('e5',
              format('select public.get_merge_preview(%L, %L)::text', pg_temp.id('dup'), pg_temp.id('us')))) -> 'differences') d), true))) ? 'merge_id', true,
          'an administrator merges it into the main release');
select is((select release_id = pg_temp.id('dup') from public.wishlist_items where id = pg_temp.id('w-dup')), true, 'the entry isn''t rewritten');
select is(pg_temp.entry('c1', 'w-dup') -> 'release' ->> 'id', pg_temp.id('us')::text, 'it shows the release it was merged into');
select is(pg_temp.entry('c1', 'w-dup') ->> 'merged', 'true', 'and says so');
select is(pg_temp.entry('c1', 'w-dup') ->> 'duplicate', 'true', 'and that another entry now wants the same release');
select is(pg_temp.entry('c1', 'w-us') ->> 'duplicate', 'true', 'as does that one');
select is(pg_temp.entry('c1', 'w-dup') -> 'owned' ->> 'copies', '3', 'its copies are the merged release''s');
select is(pg_temp.want('c1', 'bad', pg_temp.t_release('dup')) ->> 'error', 'error: release unavailable', 'a merged release can''t be added');
-- A game merged into another (no function does this yet: as a game merge would leave it).
select is(pg_temp.want('c1', 'w-m', pg_temp.t_game('m', 'snes')) ->> 'created', 'true', 'the collector wants a game on SNES');
select is(pg_temp.want('c1', 'w-mr', pg_temp.t_release('mr')) ->> 'created', 'true', 'and one of its releases');
update public.releases set status = 'merged', merged_into_id = pg_temp.id('us') where id = pg_temp.id('mr');
update public.game_platforms set status = 'excluded' where game_id = pg_temp.id('m');
update public.games set status = 'merged', merged_into_id = pg_temp.id('g') where id = pg_temp.id('m');
select is(pg_temp.entry('c1', 'w-m') -> 'game' ->> 'id', pg_temp.id('g')::text, 'a game entry shows the game it was merged into');
select is(pg_temp.entry('c1', 'w-m') ->> 'state' || '/' || (pg_temp.entry('c1', 'w-m') ->> 'merged'), 'available/true', 'available, and merged');
select is(pg_temp.names(pg_temp.for_game('c1', 'g')) like '%w-m%', true, 'it''s listed on that game''s page');
select is(pg_temp.entry('c1', 'w-mr') -> 'release' ->> 'id', pg_temp.id('us')::text, 'and the release entry the release it was merged into');
-- Nothing a wishlist references can be deleted; the entries go with their owner.
select is((select string_agg(a.attname || ':' || c.confdeltype::text, ',' order by a.attname) from pg_constraint c
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
           where c.conrelid = 'public.wishlist_items'::regclass and c.contype = 'f'),
          'game_id:r,owner_id:c,platform_id:r,region_code:r,release_id:r', 'the catalog''s foreign keys restrict; the owner''s cascades');
delete from public.collection_items where release_id = pg_temp.id('eu');
select throws_ok(format('delete from public.releases where id = %L', pg_temp.id('eu')), '23503',
                 'update or delete on table "releases" violates foreign key constraint "wishlist_items_release_id_fkey" on table "wishlist_items"',
                 'a wanted release can''t be deleted, even with no copy on it');
select is((select count(*)::int from public.wishlist_items where owner_id = pg_temp.u('c1') and (release_id is not null or game_id is not null)),
          (select count(*)::int from public.wishlist_items where owner_id = pg_temp.u('c1')), 'every entry still names its record');

-- ---------------------------------------------------------------------------
-- 10. The limit of 10,000
-- ---------------------------------------------------------------------------
set local session_replication_role = replica;
insert into public.wishlist_items (id, owner_id, release_id)
select private.uuid_v7(), pg_temp.u('c2'), gen_random_uuid() from generate_series(1, 9998);
set local session_replication_role = origin;
select is((select count(*)::int from public.wishlist_items where owner_id = pg_temp.u('c2')), 9999, 'a collector has 9,999 entries');
select is(pg_temp.want('c2', 'l-1', pg_temp.t_game('g')) ->> 'created', 'true', 'the 10,000th is added');
select is(pg_temp.want('c2', 'l-2', pg_temp.t_game('g', 'snes')) ->> 'error', 'error: wishlist limit reached', 'the next is refused');
select is(pg_temp.want('c1', 'l-3', pg_temp.t_game('g', 'snes')) ->> 'created', 'true', 'the limit is per collector');

select * from finish();
rollback;
