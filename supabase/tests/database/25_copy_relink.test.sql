-- M7b-2a: copies keep their piece records when their release changes, the late release
-- check, and owners moving their own copies. Concurrent status changes are tested in
-- scripts/db-relink-checks.mjs, where two sessions really overlap.
begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated, anon;
create temp table ids (name text primary key, id uuid not null);
grant all on ids to authenticated, anon;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
grant execute on function pg_temp.id(text) to authenticated, anon;

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
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.new_id(p text) returns void language sql as $$ insert into ids values (p, private.uuid_v7()) $$;
create function pg_temp.add(p_actor text, p_item text, p_release text, p_details text default '{}') returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.add_collection_item(%L, %L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_release), p_details))
$$;
create function pg_temp.relink(p_actor text, p_item text, p_release text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.relink_my_copy(%L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_release)))
$$;
-- Everything stored about a copy except which release it's on and when it changed.
create function pg_temp.copy_state(p_item text) returns text language sql stable as $$
  select concat_ws(' | ',
    (select (to_jsonb(c) - array['release_id', 'updated_at', 'record_status', 'invalidated_at'])::text from public.collection_items c where c.id = pg_temp.id(p_item)),
    (select to_jsonb(p)::text from public.collection_item_private p where p.item_id = pg_temp.id(p_item)),
    (select string_agg(to_jsonb(x)::text, ',' order by x.kind, x.label) from public.collection_item_components x where x.item_id = pg_temp.id(p_item)))
$$;
create function pg_temp.on_release(p_item text) returns uuid language sql stable as $$ select release_id from public.collection_items where id = pg_temp.id(p_item) $$;

-- c1: owner. c2: another collector. c3: suspended later. e5: catalog editor.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['c1', 'c2', 'c3', 'e5']) as s;
update public.profiles set handle = 'rl_' || right(id::text, 2), handle_changed_at = now() where id in (select pg_temp.u(s) from unnest(array['c1', 'c2', 'c3', 'e5']) s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('e5'), 'catalog_editor');

-- A published game with releases on SNES (two published, one excluded later, one an
-- editor's draft) and on NES.
create function pg_temp.release(p_name text, p_platform text, p_region text, p_pieces text, p_publish boolean default true) returns void language plpgsql as $$
declare r uuid;
begin
  r := public.create_release(pg_temp.id('g'), (select id from public.platforms where slug = p_platform), 'rom-cartridge', p_region,
    format('{"edition_name": "Standard %s", "edition_kind": "standard", "media_count": 1}', p_name)::jsonb, 'Relink tests');
  perform public.set_release_components(r, p_pieces::jsonb, 'Relink tests');
  if p_publish then
    perform public.verify_release(r, 'Relink tests', (select revision from public.releases where id = r));
    perform public.publish_release(r, 'Relink tests', (select revision from public.releases where id = r));
  end if;
  insert into ids values (p_name, r);
end $$;
grant execute on function pg_temp.release(text, text, text, text, boolean) to authenticated;
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('e5'), 'role', 'authenticated')::text, true);
select set_config('role', 'authenticated', true);
insert into ids select 'g', public.create_game('Rlk Copper Coast', 'game', null, null, null, 'unknown', 'Relink tests');
select public.verify_game(pg_temp.id('g'), 'Relink tests', (select revision from public.games where id = pg_temp.id('g')));
select pg_temp.release('us', 'snes', 'ntsc-uc', '[{"kind": "insert", "label": "Manual"}, {"kind": "artwork", "label": "Poster"}]');
select pg_temp.release('eu', 'snes', 'pal', '[{"kind": "insert", "label": "Manual"}, {"kind": "map", "label": "World map"}]');
select pg_temp.release('jp', 'snes', 'ntsc-j', '[]');
select pg_temp.release('nes', 'nes', 'ntsc-uc', '[]');
select pg_temp.release('draft', 'snes', 'unknown', '[]', false);
select set_config('role', 'none', true);
-- Pending submissions by c1 and by c2.
insert into ids select 'mine', (pg_temp.as_user('c1', format('select public.submit_release(%L, ''snes'', ''rom-cartridge'', ''pal'', ''{"product_code": "RLK-C1"}'', ''[]'', null, true)::text', pg_temp.id('g')))::jsonb ->> 'release_id')::uuid;
insert into ids select 'theirs', (pg_temp.as_user('c2', format('select public.submit_release(%L, ''snes'', ''rom-cartridge'', ''pal'', ''{"product_code": "RLK-C2"}'', ''[]'', null, true)::text', pg_temp.id('g')))::jsonb ->> 'release_id')::uuid;

-- c1's copy, with everything recorded.
select pg_temp.new_id('a');
select pg_temp.add('c1', 'a', 'us', '{"completeness": "complete", "box_condition": "good", "media_condition": "very_good", "acquired_on": "2020-05-01", "purchase_price": "49.99", "currency": "EUR", "notes": "From a fair", "storage_location": "Shelf A", "components": [{"kind": "insert", "label": "Manual", "condition": "good"}, {"kind": "artwork", "label": "Poster", "condition": "fair"}]}');
create temp table before_a as select pg_temp.copy_state('a') as state, (select updated_at from public.collection_items where id = pg_temp.id('a')) as updated_at;

-- ---------------------------------------------------------------------------
-- Who can relink
-- ---------------------------------------------------------------------------
select ok(pg_temp.relink(null, 'a', 'eu') like 'error: permission denied%', 'a visitor can''t');
select is(pg_temp.relink('c2', 'a', 'eu'), 'error: item unavailable', 'another collector can''t move someone''s copy');
select is(pg_temp.on_release('a'), pg_temp.id('us'), 'which stays where it was');
select ok(not has_column_privilege('authenticated', 'public.collection_items', 'release_id', 'update'), 'clients still can''t change a copy''s release');
select ok(pg_temp.as_user('c1', format('update public.collection_items set release_id = %L where id = %L returning id::text', pg_temp.id('eu'), pg_temp.id('a'))) like 'error: permission denied%',
          'not even the owner, directly');
select ok(pg_temp.as_user('c1', format('update public.collection_items set record_status = ''active'', owner_id = %L where id = %L returning id::text', pg_temp.u('c2'), pg_temp.id('a'))) like 'error: permission denied%',
          'or any other column the function sets');
select ok((select prosecdef from pg_proc where oid = 'public.relink_my_copy(uuid, uuid)'::regprocedure)
          and (select proconfig from pg_proc where oid = 'public.relink_my_copy(uuid, uuid)'::regprocedure) = array['search_path=""'], 'relinking runs as its owner with an empty search path');
select ok(not has_function_privilege('anon', 'public.relink_my_copy(uuid, uuid)', 'execute') and not has_function_privilege('service_role', 'public.relink_my_copy(uuid, uuid)', 'execute'),
          'only signed-in users may call it');

-- ---------------------------------------------------------------------------
-- Which releases it can move to
-- ---------------------------------------------------------------------------
select is(pg_temp.relink('c1', 'a', 'nes'), 'error: other platform', 'not to another platform');
select is(pg_temp.relink('c1', 'a', 'theirs'), 'error: release unavailable', 'not to someone else''s pending submission');
select is(pg_temp.as_user('c1', format('select public.relink_my_copy(%L, %L)::text', pg_temp.id('a'), private.uuid_v7())), 'error: release unavailable',
          'which reads exactly like a release that doesn''t exist');
select is(pg_temp.relink('c1', 'a', 'draft'), 'error: release unavailable', 'nor to an editor''s unpublished release');
update public.releases set status = 'excluded' where id = pg_temp.id('jp');
select is(pg_temp.relink('c1', 'a', 'jp'), 'error: release unavailable', 'nor to an excluded release');
select is(pg_temp.copy_state('a'), (select state from before_a), 'a refused move changes nothing');

-- ---------------------------------------------------------------------------
-- Moving keeps everything
-- ---------------------------------------------------------------------------
select is(pg_temp.relink('c1', 'a', 'eu')::jsonb, jsonb_build_object('moved', true, 'release_id', pg_temp.id('eu'), 'record_status', 'active'), 'the owner moves their copy to another release of the platform');
select is(pg_temp.on_release('a'), pg_temp.id('eu'), 'it''s on the new release');
select is(pg_temp.copy_state('a'), (select state from before_a), 'its id, conditions, private details and every piece record are unchanged');
select is((select string_agg(label || '=' || condition, ',' order by label) from public.collection_item_components where item_id = pg_temp.id('a')), 'Manual=good,Poster=fair',
          'including the poster, which the new release doesn''t list');
select ok((select updated_at from public.collection_items where id = pg_temp.id('a')) >= (select updated_at from before_a), 'its change time moves on');
select is(pg_temp.as_user('c1', format('select public.get_my_collection_item(%L)::text', pg_temp.id('a')))::jsonb ->> 'status', 'owned', 'and it still counts as owned');
create temp table after_move as select updated_at from public.collection_items where id = pg_temp.id('a');
select is(pg_temp.relink('c1', 'a', 'eu')::jsonb ->> 'moved', 'false', 'moving it to the release it''s on changes nothing');
select is((select updated_at from public.collection_items where id = pg_temp.id('a')), (select updated_at from after_move), 'not even its change time');
select is(pg_temp.as_user('c1', format('select public.update_collection_item(%L, %L)::text', pg_temp.id('a'), '{"remove_components": [{"kind": "artwork", "label": "Poster"}]}')), 'true',
          'only the owner removes the record of an unlisted piece');
select is(pg_temp.as_user('c1', format('select public.update_collection_item(%L, %L)::text', pg_temp.id('a'), '{"components": [{"kind": "map", "label": "World map"}, {"kind": "insert", "label": "Manual", "condition": "good"}]}')), 'true',
          'and can record a piece the new release lists');
select is(pg_temp.as_user('c1', format('select public.update_collection_item(%L, %L)::text', pg_temp.id('a'), '{"components": [{"kind": "artwork", "label": "Sticker"}]}')), 'error: component unavailable',
          'but still not one it doesn''t');
select is(pg_temp.relink('c1', 'a', 'mine')::jsonb ->> 'moved', 'true', 'a copy can move to the owner''s own pending submission');
select is(pg_temp.as_user('c1', format('select public.get_my_collection_item(%L)::text', pg_temp.id('a')))::jsonb ->> 'status', 'pending', 'where it waits for review');

-- A copy of a submission that wasn't approved.
select pg_temp.new_id('b');
select pg_temp.add('c1', 'b', 'mine', '{"notes": "Mine"}');
update public.releases set status = 'rejected' where id = pg_temp.id('mine');
select is(pg_temp.relink('c1', 'b', 'us')::jsonb ->> 'moved', 'true', 'a not-approved copy moves to a published release');
select is((select notes from public.collection_item_private where item_id = pg_temp.id('b')), 'Mine', 'with its details');

-- Preserved copies.
select pg_temp.new_id('p');
select pg_temp.add('c1', 'p', 'us', '{"notes": "Preserved", "components": [{"kind": "artwork", "label": "Poster"}]}');
-- As an exclusion will do it: the copy is on the release, then the release is excluded.
update public.releases set status = 'published' where id = pg_temp.id('jp');
update public.collection_items set release_id = pg_temp.id('jp') where id = pg_temp.id('p');
update public.releases set status = 'excluded' where id = pg_temp.id('jp');
update public.collection_items set record_status = 'invalid_preserved', invalidated_at = now() where id = pg_temp.id('p');
select is(pg_temp.relink('c1', 'p', 'draft'), 'error: release unavailable', 'a preserved copy can''t move to a release it can''t use');
select is((select record_status::text from public.collection_items where id = pg_temp.id('p')), 'invalid_preserved', 'and stays preserved');
select is(pg_temp.relink('c1', 'p', 'eu')::jsonb, jsonb_build_object('moved', true, 'release_id', pg_temp.id('eu'), 'record_status', 'active'), 'moving it to a usable release recovers it');
select is((select row(record_status, invalidated_at is null)::text from public.collection_items where id = pg_temp.id('p')), '(active,t)', 'it''s active again');
select is((select notes from public.collection_item_private where item_id = pg_temp.id('p')) || '/' || (select string_agg(label, ',') from public.collection_item_components where item_id = pg_temp.id('p')),
          'Preserved/Poster', 'with its details and piece records');

-- A suspended owner.
select pg_temp.new_id('s');
select pg_temp.add('c3', 's', 'us');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('c3');
select is(pg_temp.relink('c3', 's', 'eu'), 'error: account not active', 'a suspended owner can''t move copies');

-- ---------------------------------------------------------------------------
-- The late check: whatever the caller, a copy is only ever on a release its owner may use
-- ---------------------------------------------------------------------------
select ok((select bool_and(prosecdef) from pg_proc where oid in ('private.check_new_copy_release()'::regprocedure, 'private.check_moved_copy_release()'::regprocedure,
          'private.lock_usable_release(uuid, uuid)'::regprocedure)) and not has_function_privilege('authenticated', 'private.lock_usable_release(uuid, uuid)', 'execute'),
          'the release checks run as their owner, and clients can''t call them');
select is((select count(*)::int from pg_trigger where tgname in ('check_copy_release', 'check_copy_release_move') and tgenabled = 'O'), 2, 'on adding and on moving a copy');
select is((select count(*)::int from pg_trigger where tgname = 'drop_unlisted_components'), 0, 'and nothing drops piece records any more');
select pg_temp.new_id('x');
select throws_ok(format('insert into public.collection_items (id, owner_id, release_id) values (%L, %L, %L)', pg_temp.id('x'), pg_temp.u('c1'), pg_temp.id('theirs')),
                 'P0001', 'release unavailable', 'a copy can''t be put on someone else''s pending release, even bypassing the policies');
select throws_ok(format('update public.collection_items set release_id = %L where id = %L', pg_temp.id('jp'), pg_temp.id('b')),
                 'P0001', 'release unavailable', 'or moved to an excluded one');
select throws_ok(format('update public.collection_items set release_id = %L where id = %L', pg_temp.id('draft'), pg_temp.id('b')),
                 'P0001', 'release unavailable', 'or to an editor''s unpublished release, which has no submitter to compare');
update public.releases set status = 'merged', merged_into_id = pg_temp.id('us') where id = pg_temp.id('draft');
select throws_ok(format('update public.collection_items set release_id = %L where id = %L', pg_temp.id('draft'), pg_temp.id('b')),
                 'P0001', 'release unavailable', 'or a merged one');
select lives_ok(format('update public.collection_items set release_id = %L where id = %L', pg_temp.id('eu'), pg_temp.id('b')),
                'moving copies to a published release, as a merge will, passes');

select * from finish();
rollback;
