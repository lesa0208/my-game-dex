-- M6b: physical copies, their owner-only details and pieces, and the collection
-- functions. Builds a fictional catalog through the editor functions; M7 states
-- (submissions, rejection, exclusion, merges) are set directly, as M7 will.
-- Races and the API boundary are in db-collection-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(174);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated, anon;

create temp table ids (name text primary key, id uuid not null);
grant all on ids to authenticated, anon;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
grant execute on function pg_temp.id(text) to authenticated, anon;

-- A UUIDv7 for a given time, made the way private.uuid_v7() makes one.
create function pg_temp.v7_at(p_at timestamptz) returns uuid language sql volatile as $$
  select encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing substring(int8send((extract(epoch from p_at) * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid
$$;
-- Names a fresh client id. Called as postgres, before acting as a user.
create function pg_temp.new_id(p text, p_at timestamptz default clock_timestamp()) returns uuid language plpgsql as $$
declare v uuid := pg_temp.v7_at(p_at);
begin
  insert into ids values (p, v) on conflict (name) do update set id = excluded.id;
  return v;
end $$;

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
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
-- add_collection_item as a user, with a named id.
create function pg_temp.add(p_actor text, p_item text, p_release text, p_details text default '{}') returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.add_collection_item(%L, %L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_release), p_details))
$$;
create function pg_temp.upd(p_actor text, p_item text, p_changes text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.update_collection_item(%L, %L)::text', pg_temp.id(p_item), p_changes))
$$;
create function pg_temp.mine(p_actor text, p_args text default '') returns jsonb language sql as $$
  select nullif(pg_temp.as_user(p_actor, format('select public.get_my_collection(%s)::text', p_args)), '')::jsonb
$$;
create function pg_temp.item(p_actor text, p_item text) returns jsonb language sql as $$
  select nullif(pg_temp.as_user(p_actor, format('select public.get_my_collection_item(%L)::text', pg_temp.id(p_item))), '')::jsonb
$$;
-- Every copy id, walking a sort's pages two at a time.
create function pg_temp.walk(p_actor text, p_sort text) returns text language plpgsql as $$
declare
  v_cursor text;
  v_page jsonb;
  v_ids text[] := '{}';
  v_pages int := 0;
begin
  loop
    v_page := pg_temp.mine(p_actor, format('p_sort => %L, p_limit => 2, p_cursor => %L', p_sort, v_cursor));
    v_ids := v_ids || array(select e ->> 'id' from jsonb_array_elements(v_page -> 'items') e);
    v_cursor := v_page ->> 'next_cursor';
    v_pages := v_pages + 1;
    exit when v_cursor is null or v_pages > 50;
  end loop;
  return array_to_string(v_ids, ',');
end $$;

-- A verified game and release, published unless p_publish is false.
create function pg_temp.game(p_name text, p_title text) returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.create_game(p_title, 'game', null, null, null, 'unknown', 'Collection tests');
  perform public.verify_game(v, 'Collection tests', (select revision from public.games where id = v));
  insert into ids values (p_name, v);
  return v;
end $$;
create function pg_temp.release(p_name text, p_game text, p_platform text, p_region text, p_details jsonb default '{}', p_publish boolean default true)
returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.create_release(pg_temp.id(p_game), (select id from public.platforms where slug = p_platform), 'rom-cartridge', p_region,
    '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}'::jsonb || p_details, 'Collection tests');
  perform public.verify_release(v, 'Collection tests', (select revision from public.releases where id = v));
  if p_publish then
    perform public.publish_release(v, 'Collection tests', (select revision from public.releases where id = v));
  end if;
  insert into ids values (p_name, v);
  return v;
end $$;
grant execute on function pg_temp.game(text, text), pg_temp.release(text, text, text, text, jsonb, boolean) to authenticated;

-- c1: owner. c2: another collector. d3: later suspended. b4: verified, no handle.
-- e5: catalog editor, who also gets no access to anyone's collection.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['c1', 'c2', 'd3', 'b4', 'e5']) as s;
update public.profiles set handle = 'col_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['c1', 'c2', 'd3', 'e5']) as s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('e5'), 'catalog_editor');

-- The catalog
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('e5'), 'role', 'authenticated')::text, true);
select set_config('role', 'authenticated', true);
select pg_temp.game('g', 'Qzc Lantern Keep');
select pg_temp.release('pub', 'g', 'snes', 'ntsc-uc', '{"local_title": "Qzc Lanterne"}');
select pg_temp.release('pub-eu', 'g', 'snes', 'pal');
select pg_temp.release('draft', 'g', 'snes', 'latam', '{}', false);
select public.set_release_components(pg_temp.id('pub'), '[{"kind": "insert", "label": "Poster"}, {"kind": "map", "label": "World map"}]', 'Collection tests');
select pg_temp.game('h', 'Qzcé Harbor Run');
select pg_temp.release('nes', 'h', 'nes', 'ntsc-uc');
select pg_temp.game('x', 'Qzc Excluded');
select pg_temp.release('excl', 'x', 'snes', 'ntsc-uc');
select pg_temp.game('m', 'Qzc Merged');
select pg_temp.release('merged', 'm', 'snes', 'ntsc-uc');
select set_config('role', 'none', true);

-- What M7 will do: submissions, rejection, exclusion and a merge.
with r as (
  insert into public.releases (game_id, platform_id, region_code, media_format_code, edition_name, status, submitted_by)
  values (pg_temp.id('g'), (select id from public.platforms where slug = 'snes'), 'ntsc-j', 'rom-cartridge', 'Submitted', 'unverified', pg_temp.u('c1'))
  returning id)
insert into ids select 'own-sub', id from r;
with r as (
  insert into public.releases (game_id, platform_id, region_code, media_format_code, edition_name, status, submitted_by)
  values (pg_temp.id('g'), (select id from public.platforms where slug = 'snes'), 'ntsc-k', 'rom-cartridge', 'Rejected one', 'rejected', pg_temp.u('c1'))
  returning id)
insert into ids select 'own-rej', id from r;
with r as (
  insert into public.releases (game_id, platform_id, region_code, media_format_code, edition_name, status, submitted_by)
  values (pg_temp.id('g'), (select id from public.platforms where slug = 'snes'), 'ntsc-j', 'rom-cartridge', 'Theirs', 'unverified', pg_temp.u('c2'))
  returning id)
insert into ids select 'other-sub', id from r;
update public.releases set status = 'excluded' where id = pg_temp.id('excl');
update public.releases set status = 'merged', merged_into_id = pg_temp.id('pub') where id = pg_temp.id('merged');

-- ---------------------------------------------------------------------------
-- Schema and access
-- ---------------------------------------------------------------------------
select has_table('public', 'collection_items', 'collection_items exists');
select has_table('public', 'collection_item_private', 'collection_item_private exists');
select has_table('public', 'collection_item_components', 'collection_item_components exists');
select ok(not has_table_privilege('anon', 'public.collection_items', 'select,insert,update,delete'), 'anon has no access to copies');
select ok(not has_table_privilege('anon', 'public.collection_item_private', 'select,insert,update,delete'), 'anon has no access to private details');
select ok(not has_table_privilege('anon', 'public.collection_item_components', 'select,insert,update,delete'), 'anon has no access to pieces');
select ok(not has_table_privilege('service_role', 'public.collection_items', 'select,insert,update,delete'), 'service_role has no access to copies');
select ok(not has_table_privilege('service_role', 'public.collection_item_private', 'select,insert,update,delete'), 'service_role has no access to private details');
select ok(not has_table_privilege('service_role', 'public.collection_item_components', 'select,insert,update,delete'), 'service_role has no access to pieces');
select ok(not has_any_column_privilege('service_role', 'public.collection_item_private', 'select'), 'service_role has no column access to private details');
select ok(not has_column_privilege('authenticated', 'public.collection_items', 'record_status', 'insert')
          and not has_column_privilege('authenticated', 'public.collection_items', 'visibility', 'insert')
          and not has_column_privilege('authenticated', 'public.collection_items', 'invalidated_at', 'insert'),
          'clients can''t set status, visibility or invalidation on a new copy');
select ok(not has_column_privilege('authenticated', 'public.collection_items', 'release_id', 'update')
          and not has_column_privilege('authenticated', 'public.collection_items', 'owner_id', 'update')
          and not has_column_privilege('authenticated', 'public.collection_items', 'id', 'update')
          and not has_column_privilege('authenticated', 'public.collection_items', 'visibility', 'update')
          and not has_column_privilege('authenticated', 'public.collection_items', 'record_status', 'update'),
          'clients can''t move, transfer, publish or un-preserve a copy');
select ok(not has_column_privilege('authenticated', 'public.collection_item_private', 'owner_id', 'update')
          and not has_column_privilege('authenticated', 'public.collection_item_private', 'item_id', 'update')
          and not has_column_privilege('authenticated', 'public.collection_item_components', 'item_id', 'update')
          and not has_column_privilege('authenticated', 'public.collection_item_components', 'owner_id', 'update'),
          'clients can''t move details or pieces to another copy');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('add_collection_item', 'update_collection_item', 'remove_collection_item', 'get_my_collection',
                                                        'get_my_collection_item', 'get_my_release_copies', 'get_my_collection_summary')
             and not p.prosecdef), 7, 'every collection function runs with the caller''s rights');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname in ('check_new_collection_item', 'guard_collection_item_update', 'drop_unlisted_components',
                                                         'check_collection_item_component', 'check_collection_item_private')
             and not p.prosecdef), 5, 'every collection trigger runs with the caller''s rights');
select ok(not has_function_privilege('anon', 'public.add_collection_item(uuid, uuid, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.get_my_collection(text, text, text, text, text, integer, text)', 'execute')
          and not has_function_privilege('service_role', 'public.get_my_collection_item(uuid)', 'execute'),
          'only signed-in users may call the collection functions');

-- ---------------------------------------------------------------------------
-- Adding copies
-- ---------------------------------------------------------------------------
select pg_temp.new_id('a1');
select is(pg_temp.add('c1', 'a1', 'pub', '{"completeness": "complete", "box_condition": "good", "acquired_on": "2020-05-01", "purchase_price": "49.99", "currency": "EUR", "storage_location": "Shelf A"}'),
          format('{"created": true, "item_id": "%s"}', pg_temp.id('a1')), 'a copy is added with its details');
select is(pg_temp.add('c1', 'a1', 'pub', '{"completeness": "loose"}'), format('{"created": false, "item_id": "%s"}', pg_temp.id('a1')), 'repeating the request returns the same copy');
select is((select count(*)::int from public.collection_items where owner_id = pg_temp.u('c1')), 1, 'a repeated request adds nothing');
select is((select completeness::text from public.collection_items where id = pg_temp.id('a1')), 'complete', 'a repeated request doesn''t apply its details again');
select is(pg_temp.add('c1', 'a1', 'pub', '{"completeness": "sealed", "box_condition": null, "acquired_on": "2001-01-01", "purchase_price": "1", "currency": "USD", "notes": "retry", "storage_location": null, "components": [{"kind": "map", "label": "World map"}]}'),
          format('{"created": false, "item_id": "%s"}', pg_temp.id('a1')), 'a repeat with different details still returns the same copy');
select is((select row(c.completeness, c.box_condition, p.acquired_on, p.purchase_price, p.currency, p.notes, p.storage_location)::text
           from public.collection_items c join public.collection_item_private p on p.item_id = c.id where c.id = pg_temp.id('a1')),
          '(complete,good,2020-05-01,49.9900,EUR,,"Shelf A")', 'a repeat with different details changes none of the saved details');
select is((select count(*)::int from public.collection_item_components where item_id = pg_temp.id('a1')), 0, 'a repeat with pieces records none');
select is(pg_temp.add('c1', 'a1', 'pub-eu'), 'error: request conflict', 'the same id for another release is a conflict');
select is(pg_temp.add('c2', 'a1', 'pub'), 'error: request conflict', 'another user can''t reuse an id');
select is((select owner_id from public.collection_items where id = pg_temp.id('a1')), pg_temp.u('c1'), 'another user''s attempt changes nothing');
select pg_temp.new_id('a2');
select is(pg_temp.add('c1', 'a2', 'pub'), format('{"created": true, "item_id": "%s"}', pg_temp.id('a2')), 'a second copy of the same release is added on purpose');
select is((select count(*)::int from public.collection_items where owner_id = pg_temp.u('c1') and release_id = pg_temp.id('pub')), 2, 'two copies are two rows');
select is((select completeness from public.collection_items where id = pg_temp.id('a2')), null, 'completeness stays unrecorded when not given');

select pg_temp.new_id('bad');
select is(pg_temp.add('c1', 'bad', 'draft'), 'error: release unavailable', 'an unpublished release can''t be used');
select is(pg_temp.add('c1', 'bad', 'excl'), 'error: release unavailable', 'an excluded release can''t be used');
select is(pg_temp.add('c1', 'bad', 'merged'), 'error: release unavailable', 'a merged release can''t be used');
select is(pg_temp.add('c1', 'bad', 'other-sub'), 'error: release unavailable', 'another user''s submission can''t be used');
select is(pg_temp.as_user('c1', format('select public.add_collection_item(%L, %L)::text', pg_temp.id('bad'), gen_random_uuid())), 'error: release unavailable', 'a release that doesn''t exist can''t be used');
select is((select count(*)::int from public.collection_items where id = pg_temp.id('bad')), 0, 'refused additions leave nothing');
select pg_temp.new_id('sub');
select is(pg_temp.add('c1', 'sub', 'own-sub') like '%"created": true%', true, 'the owner''s own submission can be used (M7)');
select pg_temp.new_id('rej');
select is(pg_temp.add('c1', 'rej', 'own-rej') like '%"created": true%', true, 'the owner''s own rejected submission can be used');

select is(pg_temp.as_user('c1', format('select public.add_collection_item(%L, %L)::text', gen_random_uuid(), pg_temp.id('pub'))), 'error: invalid item id', 'a random (v4) id is refused');
select pg_temp.new_id('old', now() - interval '2 days');
select is(pg_temp.add('c1', 'old', 'pub'), 'error: invalid item id', 'an id older than 24 hours is refused');
select pg_temp.new_id('future', now() + interval '1 hour');
select is(pg_temp.add('c1', 'future', 'pub'), 'error: invalid item id', 'an id from the future is refused');
select is(pg_temp.as_user('c1', 'select public.add_collection_item(null, null)::text'), 'error: invalid item id', 'an id is required');
select pg_temp.new_id('b4');
select is(pg_temp.add('b4', 'b4', 'pub'), 'error: account not active', 'an account without a handle can''t add');
select is(pg_temp.add(null, 'b4', 'pub'), 'error: permission denied for function add_collection_item', 'anon can''t add');

-- Direct writes meet the same rules.
select pg_temp.new_id('d1');
-- Without RETURNING, which would also apply the read policy and hide a broken insert policy.
select ok(pg_temp.as_user('c1', format('insert into public.collection_items (id, owner_id, release_id) values (%L, %L, %L)', pg_temp.id('d1'), pg_temp.u('c2'), pg_temp.id('pub'))) like 'error: new row violates row-level security policy%'
          and not exists (select 1 from public.collection_items where id = pg_temp.id('d1')), 'a copy can''t be added for someone else');
select ok(pg_temp.as_user('c1', format('insert into public.collection_items (id, owner_id, release_id) values (%L, %L, %L) returning id::text', pg_temp.id('d1'), pg_temp.u('c1'), pg_temp.id('draft'))) like 'error: new row violates row-level security policy%', 'a direct insert can''t use an unpublished release');
select ok(pg_temp.as_user('c1', format('insert into public.collection_items (id, owner_id, release_id, record_status) values (%L, %L, %L, ''active'') returning id::text', pg_temp.id('d1'), pg_temp.u('c1'), pg_temp.id('pub'))) like 'error: permission denied%', 'a client can''t set a copy''s status');
select is(pg_temp.as_user('c1', format('insert into public.collection_items (id, owner_id, release_id) values (%L, %L, %L) returning id::text', gen_random_uuid(), pg_temp.u('c1'), pg_temp.id('pub'))), 'error: invalid item id', 'a direct insert still needs a recent UUIDv7');

-- ---------------------------------------------------------------------------
-- The physical-copy rules
-- ---------------------------------------------------------------------------
select is(pg_temp.upd('c1', 'a2', '{"completeness": "loose", "box_condition": "good"}'), 'error: invalid details', 'a loose copy has no box');
select is(pg_temp.upd('c1', 'a2', '{"completeness": "loose", "manual_condition": "good"}'), 'error: invalid details', 'a loose copy has no manual');
select is(pg_temp.upd('c1', 'a2', '{"completeness": "complete", "box_condition": "not_included"}'), 'error: invalid details', 'a complete copy has its box');
select is(pg_temp.upd('c1', 'a2', '{"completeness": "sealed", "media_condition": "mint"}'), 'error: invalid details', 'a sealed copy''s medium isn''t assessed');
select is(pg_temp.upd('c1', 'a2', '{"media_condition": "not_included"}'), 'error: invalid details', 'a copy always has its medium');
select is(pg_temp.upd('c1', 'a2', '{"overall_condition": "not_included"}'), 'error: invalid details', 'the overall condition can''t be "not included"');
select is(pg_temp.upd('c1', 'a2', '{"completeness": "loose", "box_condition": "not_included", "media_condition": "good"}'), 'true', 'a consistent loose copy is accepted');
select is(pg_temp.upd('c1', 'a2', '{"completeness": null, "box_condition": "fair", "manual_condition": "good"}'), 'true', 'conditions can be recorded with completeness unrecorded');
select is(pg_temp.upd('c1', 'a2', '{"completeness": "boxed"}'), 'error: invalid details', 'an unknown completeness is refused');
select is(pg_temp.upd('c1', 'a2', '{"visibility": "public"}'), 'error: invalid details', 'visibility can''t be set (owner-only in M6)');
select is(pg_temp.upd('c1', 'a2', '{"release_id": "x"}'), 'error: invalid details', 'a copy can''t be moved to another release');
select is(pg_temp.upd('c1', 'a2', '[]'), 'error: invalid details', 'changes must be an object');

-- ---------------------------------------------------------------------------
-- Owner-only details
-- ---------------------------------------------------------------------------
select is(pg_temp.upd('c1', 'a2', '{"purchase_price": "10"}'), 'error: invalid details', 'a price needs a currency');
select is(pg_temp.upd('c1', 'a2', '{"purchase_price": "10.12345", "currency": "USD"}'), 'error: invalid details', 'a price has at most 4 decimal places');
select is(pg_temp.upd('c1', 'a2', '{"purchase_price": "-1", "currency": "USD"}'), 'error: invalid details', 'a price can''t be negative');
select is(pg_temp.upd('c1', 'a2', '{"purchase_price": "10", "currency": "usd"}'), 'error: invalid details', 'a currency is an uppercase ISO code');
select is(pg_temp.upd('c1', 'a2', format('{"acquired_on": "%s"}', current_date + 5)), 'error: invalid details', 'an acquisition date can''t be in the future');
select is(pg_temp.upd('c1', 'a2', '{"acquired_on": "1960-01-01"}'), 'error: invalid details', 'an acquisition date can''t predate video games');
select is(pg_temp.upd('c1', 'a2', '{"acquired_on": "not a date"}'), 'error: invalid details', 'an acquisition date must be a date');
select is(pg_temp.upd('c1', 'a2', format('{"notes": "%s"}', repeat('n', 5001))), 'error: invalid details', 'notes are at most 5,000 characters');
select is(pg_temp.upd('c1', 'a2', '{"purchase_price": "12.5", "currency": "JPY", "notes": "From a flea market", "storage_location": "  Box 3  "}'), 'true', 'details are saved');
select is((select row(purchase_price, currency, notes, storage_location)::text from public.collection_item_private where item_id = pg_temp.id('a2')),
          '(12.5000,JPY,"From a flea market","Box 3")', 'details are stored, with the location trimmed');
select is(pg_temp.upd('c1', 'a2', '{"purchase_price": null, "currency": null, "notes": null, "storage_location": null}'), 'true', 'details can be cleared');
select is((select count(*)::int from public.collection_item_private where item_id = pg_temp.id('a2')), 0, 'clearing every detail removes the row');

select is(pg_temp.as_user('c2', 'select count(*)::text from public.collection_items'), '0', 'another user sees none of the owner''s copies');
select is(pg_temp.as_user('c2', 'select count(*)::text from public.collection_item_private'), '0', 'another user sees none of the owner''s details');
select is(pg_temp.as_user('e5', 'select count(*)::text from public.collection_item_private'), '0', 'a catalog editor sees no one''s details');
select is(pg_temp.as_user('e5', 'select count(*)::text from public.collection_items'), '0', 'a catalog editor sees no one''s copies');
select is(pg_temp.item('c2', 'a1'), null, 'another user can''t open the owner''s copy');
select is(pg_temp.as_user('c2', format('update public.collection_item_private set notes = ''x'' where item_id = %L returning item_id::text', pg_temp.id('a1'))), '', 'another user can''t change the owner''s details');
select ok(pg_temp.as_user('c2', format('insert into public.collection_item_private (item_id, owner_id, notes) values (%L, %L, ''x'') returning item_id::text', pg_temp.id('a1'), pg_temp.u('c2'))) like 'error:%', 'another user can''t attach details to the owner''s copy');
-- a2 has no details now, so only the insert policy can stop this. No RETURNING, as above.
select ok(pg_temp.as_user('c2', format('insert into public.collection_item_private (item_id, owner_id, notes) values (%L, %L, ''x'')', pg_temp.id('a2'), pg_temp.u('c1'))) like 'error: new row violates row-level security policy%'
          and not exists (select 1 from public.collection_item_private where item_id = pg_temp.id('a2')),
          'another user can''t write details as the owner');
select is((select storage_location from public.collection_item_private where item_id = pg_temp.id('a1')), 'Shelf A', 'the owner''s details are unchanged');

-- ---------------------------------------------------------------------------
-- Pieces
-- ---------------------------------------------------------------------------
select is(pg_temp.upd('c1', 'a1', '[{"kind": "insert", "label": "Poster"}]'), 'error: invalid details', 'pieces go under "components"');
select is(pg_temp.upd('c1', 'a1', '{"components": [{"kind": "insert", "label": "Poster"}, {"kind": "map", "label": "World map", "condition": "not_included"}]}'), 'true', 'listed pieces are recorded');
select is(pg_temp.upd('c1', 'a1', '{"components": [{"kind": "insert", "label": "Sticker"}]}'), 'error: component unavailable', 'a piece the release doesn''t list is refused');
select is(pg_temp.upd('c1', 'a1', '{"components": [{"kind": "insert", "label": "Poster"}, {"kind": "insert", "label": "Poster"}]}'), 'error: invalid details', 'a piece is recorded once');
select is((select count(*)::int from public.collection_item_components where item_id = pg_temp.id('a1')), 2, 'a refused change keeps the recorded pieces');
select is(pg_temp.item('c1', 'a1') -> 'components',
          '[{"kind": "insert", "label": "Poster", "listed": true, "quantity": 1, "recorded": true, "condition": null}, {"kind": "map", "label": "World map", "listed": true, "quantity": 1, "recorded": true, "condition": "not_included"}]'::jsonb,
          'a copy shows its release''s pieces and what it has');
select ok(pg_temp.as_user('c2', format('insert into public.collection_item_components (item_id, owner_id, kind, label) values (%L, %L, ''insert'', ''Poster'') returning label', pg_temp.id('a1'), pg_temp.u('c2'))) like 'error:%', 'another user can''t add pieces to the owner''s copy');
select pg_temp.as_user('e5', format('select public.set_release_components(%L, ''[{"kind": "insert", "label": "Poster (reprint)"}, {"kind": "map", "label": "World map"}]'', ''Collection tests'')::text', pg_temp.id('pub')));
select is(pg_temp.item('c1', 'a1') -> 'components',
          '[{"kind": "insert", "label": "Poster (reprint)", "listed": true, "quantity": 1, "recorded": false, "condition": null}, {"kind": "map", "label": "World map", "listed": true, "quantity": 1, "recorded": true, "condition": "not_included"}, {"kind": "insert", "label": "Poster", "listed": false, "quantity": null, "recorded": true, "condition": null}]'::jsonb,
          'a piece the editor renamed is kept, and marked as no longer listed');

-- Records of pieces the release no longer lists (M6d follow-up). a1 records the old
-- "Poster", now unlisted. a2, a second copy of the same release, gets one too.
select pg_temp.as_user('e5', format('select public.set_release_components(%L, ''[{"kind": "insert", "label": "Poster"}, {"kind": "insert", "label": "Poster (reprint)"}, {"kind": "map", "label": "World map"}]'', ''Collection tests'')::text', pg_temp.id('pub')));
select is(pg_temp.upd('c1', 'a2', '{"components": [{"kind": "insert", "label": "Poster"}]}'), 'true', 'a second copy records the old poster while it is listed');
select pg_temp.as_user('e5', format('select public.set_release_components(%L, ''[{"kind": "insert", "label": "Poster (reprint)"}, {"kind": "map", "label": "World map"}]'', ''Collection tests'')::text', pg_temp.id('pub')));
select is(pg_temp.upd('c1', 'a1', '{"components": [{"kind": "map", "label": "World map", "condition": "good"}, {"kind": "insert", "label": "Poster (reprint)"}]}'), 'true', 'listed pieces can be changed');
select is((select coalesce(string_agg(label || '=' || coalesce(condition::text, '-'), ',' order by label), '') from public.collection_item_components where item_id = pg_temp.id('a1')), 'Poster=-,Poster (reprint)=-,World map=good', 'changing listed pieces keeps the record of an unlisted one');
select is(pg_temp.upd('c1', 'a1', '{"components": []}'), 'true', 'listed pieces can be cleared');
select is((select coalesce(string_agg(label || '=' || coalesce(condition::text, '-'), ',' order by label), '') from public.collection_item_components where item_id = pg_temp.id('a1')), 'Poster=-', 'clearing listed pieces keeps the record of an unlisted one');
select is(pg_temp.upd('c1', 'a1', '{"remove_components": {"kind": "insert", "label": "Poster"}}'), 'error: invalid details', 'removals are a list');
select is(pg_temp.upd('c1', 'a1', '{"remove_components": []}'), 'error: invalid details', 'an empty removal is refused');
select is(pg_temp.upd('c1', 'a1', '{"remove_components": [{"kind": "insert"}]}'), 'error: invalid details', 'a removal names the piece''s label');
select is(pg_temp.upd('c1', 'a1', '{"remove_components": [{"kind": "insert", "label": "Poster", "condition": null}]}'), 'error: invalid details', 'a removal has only a kind and a label');
select is(pg_temp.upd('c1', 'a1', '{"remove_components": [{"kind": "insert", "label": 7}]}'), 'error: invalid details', 'a removal''s label is text');
select is(pg_temp.upd('c1', 'a1', '{"remove_components": [{"kind": "sticker", "label": "Poster"}]}'), 'error: invalid details', 'a removal''s kind must exist');
select is(pg_temp.upd('c1', 'a1', '{"remove_components": [{"kind": "insert", "label": "Poster"}, {"kind": "insert", "label": "Poster"}]}'), 'error: invalid details', 'a piece is removed once');
select is(pg_temp.upd('c1', 'a1', '{"remove_components": [{"kind": "map", "label": "World map"}]}'), 'error: invalid details', 'a listed piece is changed through components, not removed');
select is(pg_temp.upd('c1', 'a1', '{"remove_components": [{"kind": "insert", "label": "Sticker"}]}'), 'error: component unavailable', 'only a recorded piece can be removed');
select is(pg_temp.upd('c1', 'a1', '{"remove_components": [{"kind": "insert", "label": "poster"}]}'), 'error: component unavailable', 'a removal names the piece exactly');
select is(pg_temp.upd('c1', 'a1', '{"completeness": "sealed", "remove_components": [{"kind": "insert", "label": "Poster"}], "components": [{"kind": "insert", "label": "Sticker"}]}'), 'error: component unavailable', 'a change that fails partway is refused');
select is((select completeness::text from public.collection_items where id = pg_temp.id('a1')) || ' ' || (select coalesce(string_agg(label || '=' || coalesce(condition::text, '-'), ',' order by label), '') from public.collection_item_components where item_id = pg_temp.id('a1')), 'complete Poster=-', 'and none of it is applied');
select is(pg_temp.upd('c2', 'a1', '{"remove_components": [{"kind": "insert", "label": "Poster"}]}'), 'error: item unavailable', 'another user can''t remove the owner''s records');
select is(pg_temp.as_user('c2', format('delete from public.collection_item_components where item_id = %L returning label', pg_temp.id('a1'))), '', 'or delete them directly');
select is((select coalesce(string_agg(label || '=' || coalesce(condition::text, '-'), ',' order by label), '') from public.collection_item_components where item_id = pg_temp.id('a1')), 'Poster=-', 'the owner''s record is kept');
select is(pg_temp.upd('c1', 'a1', '{"remove_components": [{"kind": "insert", "label": "Poster"}]}'), 'true', 'the owner can remove a record on purpose');
select is((select coalesce(string_agg(label || '=' || coalesce(condition::text, '-'), ',' order by label), '') from public.collection_item_components where item_id = pg_temp.id('a1')) || ' | ' || (select coalesce(string_agg(label || '=' || coalesce(condition::text, '-'), ',' order by label), '') from public.collection_item_components where item_id = pg_temp.id('a2')), ' | Poster=-', 'which removes it from that copy only');
select is(pg_temp.upd('c1', 'a2', '{"remove_components": [{"kind": "insert", "label": "Poster"}], "components": [{"kind": "map", "label": "World map"}]}'), 'true', 'a removal and a change of listed pieces can go together');
select is((select coalesce(string_agg(label || '=' || coalesce(condition::text, '-'), ',' order by label), '') from public.collection_item_components where item_id = pg_temp.id('a2')), 'World map=-', 'and both apply');

-- ---------------------------------------------------------------------------
-- Editing and removing
-- ---------------------------------------------------------------------------
select is(pg_temp.upd('c2', 'a1', '{"completeness": "loose"}'), 'error: item unavailable', 'another user can''t edit the owner''s copy');
select is(pg_temp.as_user('c2', format('update public.collection_items set completeness = ''loose'' where id = %L returning id::text', pg_temp.id('a1'))), '', 'a direct edit by another user changes no row');
select ok(pg_temp.as_user('c1', format('update public.collection_items set release_id = %L where id = %L returning id::text', pg_temp.id('pub-eu'), pg_temp.id('a1'))) like 'error: permission denied%', 'the owner can''t move a copy directly');
select ok(pg_temp.as_user('c1', format('update public.collection_items set owner_id = %L where id = %L returning id::text', pg_temp.u('c2'), pg_temp.id('a1'))) like 'error: permission denied%', 'the owner can''t give a copy away directly');
select is(pg_temp.as_user('c2', format('select public.remove_collection_item(%L)::text', pg_temp.id('a1'))), 'error: item unavailable', 'another user can''t remove the owner''s copy');
select is(pg_temp.as_user('c2', format('delete from public.collection_items where id = %L returning id::text', pg_temp.id('a1'))), '', 'a direct delete by another user removes nothing');
select is((select completeness::text from public.collection_items where id = pg_temp.id('a1')), 'complete', 'the owner''s copy is unchanged');

-- A suspended owner can read and remove, not add or edit.
select pg_temp.new_id('s1');
select pg_temp.new_id('s2');
select pg_temp.add('d3', 's1', 'pub', '{"notes": "mine"}');
select pg_temp.add('d3', 's2', 'nes');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('d3');
select pg_temp.new_id('s4');
select is(pg_temp.add('d3', 's4', 'pub'), 'error: account not active', 'a suspended account can''t add');
select is(pg_temp.upd('d3', 's1', '{"completeness": "loose"}'), 'error: account not active', 'a suspended account can''t edit');
select is(pg_temp.as_user('d3', format('update public.collection_item_private set notes = ''x'' where item_id = %L returning item_id::text', pg_temp.id('s1'))), '', 'a suspended account can''t edit details directly');
select is(jsonb_array_length(pg_temp.mine('d3') -> 'items'), 2, 'a suspended account can still read its copies');
select is(pg_temp.item('d3', 's1') ->> 'notes', 'mine', 'a suspended account can still read its details');
select is(pg_temp.as_user('d3', format('select public.remove_collection_item(%L)::text', pg_temp.id('s1'))), 'true', 'a suspended account can still remove a copy');
select is((select count(*)::int from public.collection_item_private where item_id = pg_temp.id('s1')), 0, 'removing a copy removes its details');

-- Account deletion removes everything, through the owner's cascade.
delete from auth.users where id = pg_temp.u('d3');
select is((select count(*)::int from public.collection_items where owner_id = pg_temp.u('d3')), 0, 'deleting an account deletes its copies');

-- ---------------------------------------------------------------------------
-- Preserved copies (what M7's exclusion does)
-- ---------------------------------------------------------------------------
select pg_temp.new_id('p1');
select pg_temp.add('c1', 'p1', 'pub', '{"completeness": "loose", "notes": "keep", "components": [{"kind": "map", "label": "World map"}]}');
update public.collection_items set record_status = 'invalid_preserved', invalidated_at = now() where id = pg_temp.id('p1');
select is(pg_temp.upd('c1', 'p1', '{"completeness": "incomplete"}'), 'error: item preserved', 'a preserved copy can''t be edited');
select ok(pg_temp.as_user('c1', format('update public.collection_items set completeness = ''incomplete'' where id = %L returning id::text', pg_temp.id('p1'))) like 'error: item preserved%', 'a preserved copy can''t be edited directly');
select ok(pg_temp.as_user('c1', format('update public.collection_item_private set notes = ''x'' where item_id = %L returning item_id::text', pg_temp.id('p1'))) like 'error: item preserved%', 'a preserved copy''s details can''t be edited');
select ok(pg_temp.as_user('c1', format('update public.collection_item_components set condition = ''poor'' where item_id = %L returning label', pg_temp.id('p1'))) like 'error: item preserved%', 'a preserved copy''s pieces can''t be edited');
select is(pg_temp.upd('c1', 'p1', '{"remove_components": [{"kind": "map", "label": "World map"}]}'), 'error: item preserved', 'a preserved copy''s records can''t be removed either');
select is(pg_temp.item('c1', 'p1') ->> 'status', 'invalid', 'a preserved copy shows as invalid');
update public.collection_items set release_id = pg_temp.id('pub-eu') where id = pg_temp.id('p1');
select is((select record_status::text || ' ' || coalesce(invalidated_at::text, 'none') from public.collection_items where id = pg_temp.id('p1')), 'active none', 'moving a preserved copy to a usable release clears the flag');
select is((select count(*)::int from public.collection_item_components where item_id = pg_temp.id('p1')), 0, 'moving a copy drops pieces its new release doesn''t list');
select is((select notes from public.collection_item_private where item_id = pg_temp.id('p1')), 'keep', 'moving a copy keeps its details');
update public.collection_items set record_status = 'invalid_preserved', invalidated_at = now() where id = pg_temp.id('p1');
select is(pg_temp.as_user('c1', format('select public.remove_collection_item(%L)::text', pg_temp.id('p1'))), 'true', 'the owner can remove a preserved copy');

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------
-- c1 now has: a1 (complete, pub), a2 (pub), sub (own submission), rej (own rejected).
select pg_temp.new_id('h1');
select pg_temp.add('c1', 'h1', 'nes', '{"completeness": "sealed", "acquired_on": "2021-02-03"}');
select pg_temp.new_id('o2a');
select pg_temp.add('c2', 'o2a', 'pub');

select is((select string_agg(e ->> 'id', ',' order by o) from jsonb_array_elements(pg_temp.mine('c1') -> 'items') with ordinality x(e, o)),
          concat_ws(',', pg_temp.id('h1'), pg_temp.id('rej'), pg_temp.id('sub'), pg_temp.id('a2'), pg_temp.id('a1')), 'copies are listed newest first');
select is(pg_temp.mine('c1') ->> 'next_cursor', null, 'one page has no cursor');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.mine('c1') -> 'items' -> 0) k),
          'acquired_on,added_at,completeness,conditions,copies_of_release,game,has_notes,id,price,release,status,storage_location,updated_at', 'a listed copy has exactly the expected fields');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.item('c1', 'a1')) k),
          'acquired_on,added_at,completeness,components,conditions,copies_of_release,game,id,notes,price,release,status,storage_location,updated_at', 'a full copy has exactly the expected fields');
select is((select string_agg(e ->> 'id', ',') from jsonb_array_elements(pg_temp.mine('c2') -> 'items') e), pg_temp.id('o2a')::text, 'each user lists only their own copies');
select is((select e -> 'copies_of_release' from jsonb_array_elements(pg_temp.mine('c1') -> 'items') e where e ->> 'id' = pg_temp.id('a1')::text), '2'::jsonb, 'a copy says how many of its release the owner has');
select is((select e -> 'price' from jsonb_array_elements(pg_temp.mine('c1') -> 'items') e where e ->> 'id' = pg_temp.id('a1')::text), '{"amount": "49.9900", "currency": "EUR"}'::jsonb, 'a price keeps its exact amount and currency');
select is((select string_agg(e ->> 'status', ',' order by o) from jsonb_array_elements(pg_temp.mine('c1') -> 'items') with ordinality x(e, o)), 'owned,not_approved,pending,owned,owned', 'each copy has its status');

select is(pg_temp.walk('c1', 'added'), concat_ws(',', pg_temp.id('h1'), pg_temp.id('rej'), pg_temp.id('sub'), pg_temp.id('a2'), pg_temp.id('a1')), 'pages by date added cover every copy once');
select is(pg_temp.walk('c1', 'title'), (select string_agg(e ->> 'id', ',' order by lower(e -> 'game' ->> 'title'), e ->> 'id') from jsonb_array_elements(pg_temp.mine('c1') -> 'items') e), 'pages by title cover every copy once, in order');
select is((select count(*)::int from unnest(string_to_array(pg_temp.walk('c1', 'platform'), ',')) x), 5, 'pages by platform cover every copy');
select is(split_part(pg_temp.walk('c1', 'acquired'), ',', 1), pg_temp.id('h1')::text, 'by acquisition, the latest date comes first');
select is(split_part(pg_temp.walk('c1', 'acquired'), ',', 2), pg_temp.id('a1')::text, 'by acquisition, unknown dates come last');
select is(pg_temp.as_user('c1', format('select public.get_my_collection(p_sort => ''title'', p_cursor => %L)::text',
            pg_temp.mine('c1', 'p_limit => 2') ->> 'next_cursor')), 'error: invalid cursor', 'a cursor from another sort is refused');
select is(pg_temp.as_user('c1', 'select public.get_my_collection(p_cursor => ''bm90IGEgY3Vyc29y'')::text'), 'error: invalid cursor', 'a made-up cursor is refused');
select is(pg_temp.as_user('c1', 'select public.get_my_collection(p_sort => ''price'')::text'), 'error: invalid filter', 'an unknown sort is refused');
select is(pg_temp.as_user('c1', format('select public.get_my_collection(p_query => %L)::text', repeat('q', 101))), 'error: query too long', 'a long query is refused');

select is(jsonb_array_length(pg_temp.mine('c1', 'p_platform => ''nes''') -> 'items'), 1, 'copies filter by platform');
select is(jsonb_array_length(pg_temp.mine('c1', 'p_completeness => ''not_recorded''') -> 'items'), 3, 'copies filter by unrecorded completeness');
select is(jsonb_array_length(pg_temp.mine('c1', 'p_status => ''pending''') -> 'items'), 1, 'copies filter by status');
select is((pg_temp.mine('c1', 'p_query => ''harbor''') -> 'items' -> 0 ->> 'id'), pg_temp.id('h1')::text, 'copies filter by title');
select is(jsonb_array_length(pg_temp.mine('c1', 'p_query => ''QZCE HARBOR''') -> 'items'), 1, 'a title search ignores case and accents');
select is(jsonb_array_length(pg_temp.mine('c1', 'p_query => ''lanterne''') -> 'items'), 2, 'a title search covers the release''s local title');

select is(pg_temp.as_user('c1', format('select public.get_my_release_copies(%L) ->> ''count''', pg_temp.id('pub'))), '2', 'the owner sees how many copies of a release they have');
select is(pg_temp.as_user('c2', format('select public.get_my_release_copies(%L) ->> ''count''', pg_temp.id('nes'))), '0', 'another user''s copies aren''t counted');
select is(pg_temp.as_user('c1', 'select public.get_my_collection_summary()::text')::jsonb - 'platforms',
          '{"total": 5, "owned": 3, "pending": 1, "not_approved": 1, "invalid": 0, "limit": 100000}'::jsonb, 'the summary counts copies by status');
select is(pg_temp.as_user('c1', 'select public.get_my_collection_summary()::text')::jsonb -> 'platforms',
          '[{"slug": "nes", "name": "Nintendo Entertainment System", "short_name": "NES", "count": 1}, {"slug": "snes", "name": "Super Nintendo Entertainment System", "short_name": "SNES", "count": 4}]'::jsonb, 'the summary counts copies by platform');

-- The copy list for a release stops at 100; the count doesn't.
insert into public.collection_items (id, owner_id, release_id) select pg_temp.v7_at(clock_timestamp()), pg_temp.u('c2'), pg_temp.id('nes') from generate_series(1, 101);
select is(pg_temp.as_user('c2', format('select public.get_my_release_copies(%L) ->> ''count''', pg_temp.id('nes'))), '101', 'the count of a release''s copies is exact past 100');
select is(pg_temp.as_user('c2', format('select jsonb_array_length(public.get_my_release_copies(%L) -> ''copies'')::text', pg_temp.id('nes'))), '100', 'the copies of a release are listed up to 100');

-- ---------------------------------------------------------------------------
-- What M7 will do, on the M6 schema
-- ---------------------------------------------------------------------------
-- Approval: a submission is published, and its copies become owned without changing.
update public.releases set status = 'published', submitted_by = null, verified_at = now(), edition_kind = 'standard', media_count = 1 where id = pg_temp.id('own-sub');
select is(pg_temp.item('c1', 'sub') ->> 'status', 'owned', 'an approved submission''s copy counts as owned');
-- Merge: a duplicate release is merged, and its copies move to the target.
select pg_temp.new_id('m1');
select pg_temp.add('c1', 'm1', 'pub-eu', '{"completeness": "loose", "notes": "merge me"}');
update public.releases set status = 'merged', merged_into_id = pg_temp.id('pub') where id = pg_temp.id('pub-eu');
select is(pg_temp.item('c1', 'm1') ->> 'status', 'pending', 'a copy on a release being merged isn''t counted as owned');
update public.collection_items set release_id = pg_temp.id('pub') where release_id = pg_temp.id('pub-eu');
select is(pg_temp.item('c1', 'm1') ->> 'status' || ' ' || (pg_temp.item('c1', 'm1') -> 'release' ->> 'id'), 'owned ' || pg_temp.id('pub'), 'a merged copy moves to the target release and counts again');
select is(pg_temp.item('c1', 'm1') ->> 'notes', 'merge me', 'a merged copy keeps its details');
select is(pg_temp.add('c1', 'm1', 'pub-eu'), 'error: request conflict', 'a repeat of the original request after the merge is a conflict, not a new copy');

-- ---------------------------------------------------------------------------
-- The limit, lowered for the test
-- ---------------------------------------------------------------------------
do $$ begin
  execute replace(pg_get_functiondef('private.check_new_collection_item()'::regprocedure), 'c_limit constant integer := 100000;', 'c_limit constant integer := 7;');
end $$;
select pg_temp.new_id('l1');
select pg_temp.new_id('l2');
select is(pg_temp.add('c1', 'l1', 'pub') like '%"created": true%', true, 'a copy below the limit is added');
select is(pg_temp.add('c1', 'l2', 'pub'), 'error: collection limit reached', 'a copy over the limit is refused');
select is(pg_temp.add('c1', 'l1', 'pub') like '%"created": false%', true, 'a repeat of an earlier request still works at the limit');

select * from finish();
rollback;
