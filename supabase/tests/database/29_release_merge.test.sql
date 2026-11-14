-- M7b-2c: merging releases. Who may (an administrator for a published source, an
-- editor otherwise, never a submitter of either), what must match, every difference
-- acknowledged by name, what's kept on the copies, references and history, chains,
-- submissions and the games they created, exclusions, notifications and audit.
-- Concurrent calls are tested in scripts/db-merge-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(105);

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
create function pg_temp.commit_check() returns text language plpgsql as $t$
begin
  set constraints all immediate;
  set constraints all deferred;
  return 'ok';
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
-- A call's result as JSON, or {"error": ...}, so an assertion on it fails by name.
create function pg_temp.j(r text) returns jsonb language sql immutable as $$
  select case when r like '{%' or r like '[%' then r::jsonb else jsonb_build_object('error', r) end
$$;
create function pg_temp.preview(p_actor text, p_source text, p_target text) returns jsonb language sql as $$
  select pg_temp.j(pg_temp.as_user(p_actor, format('select public.get_merge_preview(%L, %L)::text', pg_temp.id(p_source), pg_temp.id(p_target))))
$$;
create function pg_temp.fields(p_source text, p_target text) returns text[] language sql as $$
  select coalesce(array_agg(d ->> 'field' order by d ->> 'field'), '{}') from jsonb_array_elements(pg_temp.preview('e5', p_source, p_target) -> 'differences') d
$$;
create function pg_temp.merge(p_actor text, p_source text, p_target text, p_token text default null, p_fields text[] default null,
                              p_copies boolean default true, p_reason text default 'Same release', p_note text default 'Your copy now points to the main record.')
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := pg_temp.j(pg_temp.as_user(p_actor, format('select public.merge_release(%L, %L, %L, %L, %L, %L, %L)::text', pg_temp.id(p_source), pg_temp.id(p_target),
         coalesce(p_token, pg_temp.preview('e5', p_source, p_target) ->> 'token'), p_reason, p_note,
         coalesce(p_fields, pg_temp.fields(p_source, p_target)), p_copies)));
  if r ? 'merge_id' then
    insert into ids values ('m-' || p_source, (r ->> 'merge_id')::uuid) on conflict (name) do update set id = excluded.id;
  end if;
  return r;
end $$;
create function pg_temp.err(r jsonb) returns text language sql immutable as $$ select r ->> 'error' $$;
create function pg_temp.blocking(p_source text, p_target text) returns text language sql as $$
  select coalesce(string_agg(b ->> 'kind', ',' order by b ->> 'kind'), '') from jsonb_array_elements(pg_temp.preview('e5', p_source, p_target) -> 'blocking') b
$$;
create function pg_temp.rel(p text) returns text language sql stable as $$ select status::text from public.releases where id = pg_temp.id(p) $$;
create function pg_temp.new_id(p text) returns void language sql as $$ insert into ids values (p, private.uuid_v7()) $$;
create function pg_temp.add(p_actor text, p_item text, p_release text, p_details text default '{}') returns text language plpgsql as $$
begin
  perform pg_temp.new_id(p_item);
  return pg_temp.as_user(p_actor, format('select public.add_collection_item(%L, %L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_release), p_details));
end $$;
-- Everything stored about a copy except the release it's on.
create function pg_temp.copy_state(p_item text) returns text language sql stable as $$
  select concat_ws(' | ',
    (select (to_jsonb(c) - 'release_id')::text from public.collection_items c where c.id = pg_temp.id(p_item)),
    (select to_jsonb(p)::text from public.collection_item_private p where p.item_id = pg_temp.id(p_item)),
    (select string_agg(to_jsonb(x)::text, ',' order by x.kind, x.label) from public.collection_item_components x where x.item_id = pg_temp.id(p_item)))
$$;
create function pg_temp.on_release(p_item text) returns uuid language sql stable as $$ select release_id from public.collection_items where id = pg_temp.id(p_item) $$;
create function pg_temp.req(p_release text) returns uuid language sql stable as $$
  select id from public.catalog_change_requests where release_id = pg_temp.id(p_release) order by id desc limit 1
$$;
create function pg_temp.start_review(p_release text) returns text language sql as $$
  select pg_temp.as_user('e5', format('select public.start_submission_review(%L, %L, ''Checking'')::text', pg_temp.req(p_release),
    (select version from public.catalog_change_requests where id = pg_temp.req(p_release))))
$$;

-- c1, c2: collectors. c3: a submitter. e5, e6: catalog editors. a7, a8: administrators.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['c1', 'c2', 'c3', 'e5', 'e6', 'a7', 'a8']) as s;
update public.profiles set handle = 'mg_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['c1', 'c2', 'c3', 'e5', 'e6', 'a7', 'a8']) s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('e5'), 'catalog_editor'), (pg_temp.u('e6'), 'catalog_editor'), (pg_temp.u('a7'), 'admin'), (pg_temp.u('a8'), 'admin');
-- A second physical format for SNES, so a format mismatch can be tested.
insert into public.platform_media_formats (platform_id, media_format_code)
select (select id from public.platforms where slug = 'snes'), (select code from public.media_formats where code <> 'rom-cartridge' order by code limit 1);

-- Catalog, made by e5:
--   g "Mrg Copper Hill" (SNES): pub (the target), dup, old, other (another format),
--     rx (excluded and restored), ex (excluded), pres (with a preserved copy)
--   g on NES: nesr
--   h "Mrg Far Coast": hr
--   imp: an unverified release of g with no submission, as an import leaves one
create function pg_temp.release(p_name text, p_game text, p_platform text, p_region text, p_code text, p_pieces text default '[{"kind": "insert", "label": "Manual"}]',
                                p_publish boolean default true, p_format text default 'rom-cartridge', p_edition text default null) returns void language plpgsql as $$
declare r uuid;
begin
  r := public.create_release(pg_temp.id(p_game), (select id from public.platforms where slug = p_platform), p_format, p_region,
    format('{"edition_name": "%s", "edition_kind": "standard", "media_count": 1, "product_code": "%s"}', coalesce(p_edition, 'Standard'), p_code)::jsonb, 'Merge tests');
  perform public.set_release_components(r, p_pieces::jsonb, 'Merge tests');
  if p_publish then
    perform public.verify_release(r, 'Merge tests', (select revision from public.releases where id = r));
    perform public.publish_release(r, 'Merge tests', (select revision from public.releases where id = r));
  end if;
  insert into ids values (p_name, r);
end $$;
create function pg_temp.game_of(p_name text, p_title text) returns void language plpgsql as $$
begin
  insert into ids select p_name, public.create_game(p_title, 'game', null, null, null, 'unknown', 'Merge tests');
  perform public.verify_game(pg_temp.id(p_name), 'Merge tests', (select revision from public.games where id = pg_temp.id(p_name)));
end $$;
grant execute on function pg_temp.release(text, text, text, text, text, text, boolean, text, text) to authenticated;
grant execute on function pg_temp.game_of(text, text) to authenticated;
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('e5'), 'role', 'authenticated')::text, true);
select set_config('role', 'authenticated', true);
select pg_temp.game_of('g', 'Mrg Copper Hill');
select pg_temp.release('pub', 'g', 'snes', 'ntsc-uc', 'MRG-1', '[{"kind": "insert", "label": "Manual"}, {"kind": "artwork", "label": "Poster"}]');
select pg_temp.release('dup', 'g', 'snes', 'ntsc-uc', 'MRG-1B', '[{"kind": "insert", "label": "Manual"}, {"kind": "insert", "label": "Registration card"}]', true, 'rom-cartridge', 'First Print');
select pg_temp.release('old', 'g', 'snes', 'ntsc-uc', 'MRG-1C', '[]', true, 'rom-cartridge', 'Old Print');
select pg_temp.release('rx', 'g', 'snes', 'pal', 'MRG-RX');
select pg_temp.release('ex', 'g', 'snes', 'ntsc-j', 'MRG-EX');
select pg_temp.release('pres', 'g', 'snes', 'pal', 'MRG-PRES', '[]', true, 'rom-cartridge', 'Preserved');
select pg_temp.release('nesr', 'g', 'nes', 'ntsc-uc', 'MRG-NES');
select pg_temp.game_of('h', 'Mrg Far Coast');
select pg_temp.release('hr', 'h', 'snes', 'ntsc-uc', 'MRG-H');
select pg_temp.release('imp', 'g', 'snes', 'ntsc-uc', 'MRG-IMP', '[]', false, 'rom-cartridge', 'Imported');
select pg_temp.release('imp2', 'g', 'snes', 'ntsc-j', 'MRG-IMP2', '[]', false, 'rom-cartridge', 'Imported');
select pg_temp.game_of('k', 'Mrg Lone Field');
select pg_temp.release('kr', 'k', 'snes', 'ntsc-uc', 'MRG-KR');
select set_config('role', 'none', true);
select pg_temp.release('other', 'g', 'snes', 'ntsc-uc', 'MRG-CD', '[]', false,
  (select code from public.media_formats where code <> 'rom-cartridge' order by code limit 1), 'Disc');
-- External references: imp and pub each have one from the same provider.
insert into private.external_references (provider_code, external_id, release_id) values
  ('wikidata', 'Q-MRG-IMP', pg_temp.id('imp')), ('wikidata', 'Q-MRG-PUB', pg_temp.id('pub'));
select is(pg_temp.commit_check(), 'ok', 'the fixture satisfies the publication rules');

-- c3's submissions: sp on g (open), ns as a new game duplicating g, esub by e6.
insert into ids select 'sp', (pg_temp.as_user('c3', format(
  'select public.submit_release(%L, ''snes'', ''rom-cartridge'', ''ntsc-uc'', ''{"product_code": "MRG-1"}'', ''[]'', null, true)::text', pg_temp.id('g')))::jsonb ->> 'release_id')::uuid;
insert into ids select 'ns', (pg_temp.as_user('c3',
  'select public.submit_game(''Mrg Copper Hil'', ''game'', null, ''snes'', ''rom-cartridge'', ''ntsc-uc'', ''{"product_code": "MRG-1"}'', ''[]'', ''A note'', true)::text')::jsonb ->> 'release_id')::uuid;
insert into ids select 'ns-g', game_id from public.releases where id = pg_temp.id('ns');
insert into ids select 'esub', (pg_temp.as_user('e6', format(
  'select public.submit_release(%L, ''snes'', ''rom-cartridge'', ''pal'', ''{"product_code": "MRG-E6"}'', ''[]'', null, true)::text', pg_temp.id('g')))::jsonb ->> 'release_id')::uuid;

-- Copies: c1 two of dup (one with everything recorded, and a piece pub doesn't list),
-- c2 one of dup, c1 one of pub; c3 one of each submission.
select pg_temp.add('c1', 'a', 'dup', '{"completeness": "complete", "box_condition": "good", "acquired_on": "2020-05-01", "purchase_price": "49.99", "currency": "EUR", "notes": "From a fair", "storage_location": "Shelf A", "components": [{"kind": "insert", "label": "Manual", "condition": "good"}, {"kind": "insert", "label": "Registration card", "condition": "fair"}]}');
select pg_temp.add('c1', 'b', 'dup', '{"notes": "Second copy"}');
select pg_temp.add('c2', 'c', 'dup');
select pg_temp.add('c1', 'd', 'pub');
select pg_temp.add('c1', 'x1', 'hr');
select pg_temp.add('c3', 'p', 'sp');
select pg_temp.add('c3', 'n', 'ns');
-- A copy preserved by an exclusion, on a published release: written without
-- triggers, as data from before (M7b-2a fixtures do the same).
select pg_temp.new_id('pc');
set local session_replication_role = replica;
insert into public.collection_items (id, owner_id, release_id, record_status, invalidated_at)
values (pg_temp.id('pc'), pg_temp.u('c2'), pg_temp.id('pres'), 'invalid_preserved', now());
set local session_replication_role = origin;
-- rx: excluded and restored. ex: excluded.
create function pg_temp.exclusion_token(p_release text) returns text language sql as $$
  select pg_temp.as_user('e5', format('select public.get_exclusion_preview(%L)::text', pg_temp.id(p_release)))::jsonb ->> 'token'
$$;
select pg_temp.as_user('e5', format('select public.exclude_release(%L, %L, ''not_physical_release'', ''Checking'', null, true, true)::text', pg_temp.id('rx'), pg_temp.exclusion_token('rx')));
insert into ids select 'x-rx', id from private.catalog_exclusions where release_id = pg_temp.id('rx');
select pg_temp.as_user('a7', format('select public.restore_exclusion(%L, %L, ''It was physical'')::text', pg_temp.id('x-rx'),
  (select version from private.catalog_exclusions where id = pg_temp.id('x-rx'))));
select pg_temp.as_user('e5', format('select public.exclude_release(%L, %L, ''not_physical_release'', ''Checking'', null, true, true)::text', pg_temp.id('ex'), pg_temp.exclusion_token('ex')));
select pg_temp.as_user('e5', format('select public.exclude_release(%L, %L, ''not_physical_release'', ''Checking'', null, true, true)::text', pg_temp.id('kr'), pg_temp.exclusion_token('kr')));
select is(pg_temp.rel('rx') || ' ' || pg_temp.rel('ex') || ' ' || (select status::text from public.games where id = pg_temp.id('k')), 'published excluded excluded',
  'rx was restored, ex is excluded, and so is game k with kr');
-- kd: an unverified release of game k. Exclusion refuses to strand one, so it's
-- written without triggers, as data from before; the merge must still refuse it.
select pg_temp.new_id('kd');
set local session_replication_role = replica;
insert into public.releases (id, game_id, platform_id, region_code, edition_name, edition_kind, media_format_code, media_count, product_code, status)
select pg_temp.id('kd'), r.game_id, r.platform_id, 'pal', r.edition_name, r.edition_kind, r.media_format_code, r.media_count, 'MRG-KD', 'unverified'
from public.releases r where r.id = pg_temp.id('kr');
set local session_replication_role = origin;

create temp table before as
  select name, pg_temp.copy_state(name) as state, (select updated_at from public.collection_items where id = pg_temp.id(name)) as updated_at
  from ids where name in ('a', 'b', 'c', 'd', 'p', 'n');
create temp table pub_before as select to_jsonb(r) as v from public.releases r where r.id = pg_temp.id('pub');
create temp table pub_pieces as select string_agg(to_jsonb(c)::text, ',' order by c.kind, c.label) as v from public.release_components c where c.release_id = pg_temp.id('pub');

-- ---------------------------------------------------------------------------
-- Who may merge
-- ---------------------------------------------------------------------------
select ok(pg_temp.err(pg_temp.preview(null, 'dup', 'pub')) like 'error: permission denied%', 'a visitor can''t preview a merge');
select is(pg_temp.err(pg_temp.preview('c1', 'dup', 'pub')), 'error: not permitted', 'nor can a collector');
select is(pg_temp.err(pg_temp.merge('c1', 'dup', 'pub', 'x', '{}')), 'error: not permitted', 'or merge');
select is(pg_temp.preview('e5', 'dup', 'pub') ->> 'requires_admin', 'true', 'a published source needs an administrator');
select is(pg_temp.err(pg_temp.merge('e5', 'dup', 'pub')), 'error: not permitted', 'so an editor can''t merge it');
select ok(not exists (
  select 1 from unnest(array['public.get_merge_preview(uuid,uuid)', 'public.get_merge_candidates(uuid)',
                             'public.merge_release(uuid,uuid,text,text,text,text[],boolean)', 'public.get_merges(uuid,integer)',
                             'public.get_merge(uuid)', 'public.get_my_merged_submission(uuid)']) f
  where has_function_privilege('anon', f, 'execute') or has_function_privilege('service_role', f, 'execute')
     or not has_function_privilege('authenticated', f, 'execute')), 'the new functions are for signed-in users only');
select ok((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc
           where oid in ('public.get_merge_preview(uuid,uuid)'::regprocedure, 'public.get_merge_candidates(uuid)'::regprocedure,
                         'public.merge_release(uuid,uuid,text,text,text,text[],boolean)'::regprocedure, 'public.get_merges(uuid,integer)'::regprocedure,
                         'public.get_merge(uuid)'::regprocedure, 'public.get_my_merged_submission(uuid)'::regprocedure)),
          'and run as their owner with an empty search path');
select ok(not exists (
  select 1 from unnest(array['private.catalog_merges', 'private.catalog_merge_copies', 'private.catalog_merge_references']) t
  where has_table_privilege('authenticated', t, 'select') or has_table_privilege('anon', t, 'select') or has_table_privilege('service_role', t, 'select')),
  'clients can''t read merge records');
select ok(not exists (
  select 1 from unnest(array['private.merge_plan(uuid,uuid)', 'private.merge_profiles(uuid,uuid,uuid)', 'private.lock_merge_records(uuid,uuid)',
                             'private.merge_involves(uuid,uuid,uuid)', 'private.merge_fields(uuid)', 'private.describe_merge(uuid,jsonb)']) f
  where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')), 'nor call the merge helpers');

-- ---------------------------------------------------------------------------
-- What must match, and what blocks
-- ---------------------------------------------------------------------------
select is(pg_temp.err(pg_temp.preview('e5', 'dup', 'dup')), 'error: target unavailable', 'a release can''t be merged into itself');
select is(pg_temp.err(pg_temp.preview('e5', 'dup', 'imp')), 'error: target unavailable', 'the target must be published');
select is(pg_temp.err(pg_temp.preview('e5', 'ex', 'pub')), 'error: release unavailable', 'an excluded release can''t be merged');
select is(pg_temp.err(pg_temp.preview('e5', 'dup', 'ex')), 'error: target unavailable', 'or merged into');
select is(pg_temp.blocking('nesr', 'pub'), 'platform', 'another platform always blocks');
select is(pg_temp.blocking('other', 'pub'), 'media_format', 'and another physical format');
select is(pg_temp.blocking('dup', 'hr'), 'other_game', 'a published source stays within its game');
select is(pg_temp.blocking('pres', 'pub'), 'preserved_copy', 'a preserved copy on the source blocks, so merging never reactivates one');
select is(pg_temp.blocking('sp', 'pub'), 'submission_not_in_review', 'a submission is merged only from review');
select is(pg_temp.blocking('kd', 'pub'), 'active_exclusion', 'a release whose game an active exclusion took blocks, until it''s restored');
select is(pg_temp.err(pg_temp.merge('a7', 'nesr', 'pub')), 'error: merge blocked', 'and a blocked merge is refused');

-- ---------------------------------------------------------------------------
-- Differences, each acknowledged
-- ---------------------------------------------------------------------------
select is(pg_temp.fields('dup', 'pub')::text, '{components,edition_name,product_code}', 'the preview lists every differing field');
select is((select string_agg(format('%s:%s', d ->> 'field', d ->> 'critical'), ',' order by d ->> 'field')
           from jsonb_array_elements(pg_temp.preview('e5', 'dup', 'pub') -> 'differences') d),
          'components:false,edition_name:true,product_code:true', 'flagging edition and product code');
select is((select (d ->> 'source') || ' / ' || (d ->> 'target') from jsonb_array_elements(pg_temp.preview('e5', 'dup', 'pub') -> 'differences') d where d ->> 'field' = 'product_code'),
          'MRG-1B / MRG-1', 'as they are');
select is(pg_temp.preview('e5', 'dup', 'pub') ->> 'copies', '3', 'and the copies affected');
select is(pg_temp.err(pg_temp.merge('a7', 'dup', 'pub', p_fields => '{components,edition_name}')), 'error: acknowledgement required', 'every difference must be acknowledged');
select is(pg_temp.err(pg_temp.merge('a7', 'dup', 'pub', p_fields => '{components,edition_name,product_code,barcode}')), 'error: acknowledgement required',
  'and only those');
select is(pg_temp.err(pg_temp.merge('a7', 'dup', 'pub', p_copies => false)), 'error: acknowledgement required', 'moving copies must be acknowledged');
select is(pg_temp.err(pg_temp.merge('a7', 'dup', 'pub', p_token => md5('old'))), 'error: preview stale', 'a stale preview is refused');
create temp table t_dup as select pg_temp.preview('e5', 'dup', 'pub') ->> 'token' as t;
update public.releases set local_title = 'Changed' where id = pg_temp.id('pub');
select is(pg_temp.err(pg_temp.merge('a7', 'dup', 'pub', p_token => (select t from t_dup), p_fields => '{components,edition_name,product_code}')),
  'error: preview stale', 'so is one taken before the target changed');
update public.releases set local_title = null where id = pg_temp.id('pub');
delete from pub_before;
insert into pub_before select to_jsonb(r) from public.releases r where r.id = pg_temp.id('pub');
select is(pg_temp.err(pg_temp.merge('a7', 'dup', 'pub', p_reason => ' ')), 'error: reason required', 'a staff reason is required');

-- ---------------------------------------------------------------------------
-- Candidates
-- ---------------------------------------------------------------------------
select is((select string_agg(e ->> 'product_code', ',' order by e ->> 'product_code')
           from jsonb_array_elements(pg_temp.j(pg_temp.as_user('e5', format('select public.get_merge_candidates(%L)::text', pg_temp.id('dup'))))) e),
          'MRG-1,MRG-1C,MRG-PRES,MRG-RX', 'candidates are published releases of the same game, platform and format');
select ok((select bool_or(e ->> 'product_code' = 'MRG-1') from jsonb_array_elements(pg_temp.j(pg_temp.as_user('e5', format('select public.get_merge_candidates(%L)::text', pg_temp.id('ns'))))) e),
  'a submission''s candidates include other games with the same product code');

-- ---------------------------------------------------------------------------
-- Merging a published duplicate, after old was merged into it
-- ---------------------------------------------------------------------------
select is(pg_temp.merge('a7', 'old', 'dup') ->> 'copies', '0', 'an administrator merges old into dup');
select is(pg_temp.merge('a7', 'dup', 'pub') - 'merge_id', '{"copies": 3, "owners": 2, "references": 0}'::jsonb, 'then dup into pub, moving 3 copies of 2 owners');
select is(pg_temp.commit_check(), 'ok', 'the publication rules hold');
select is((select row(status, merged_into_id = pg_temp.id('pub'), merged_publicly, submitted_by is null)::text from public.releases where id = pg_temp.id('dup')),
  '(merged,t,t,t)', 'dup is merged into pub, publicly, as it was published');
select is((select merged_into_id from public.releases where id = pg_temp.id('old')), pg_temp.id('pub'), 'old now points at pub directly: no chain');
select is(pg_temp.as_user(null, format('select public.resolve_merged_release(%L) ->> ''release_id''', pg_temp.id('old'))), pg_temp.id('pub')::text,
  'and both addresses redirect to pub');
select is((select to_jsonb(r) from public.releases r where r.id = pg_temp.id('pub')), (select v from pub_before), 'pub itself is unchanged');
select is((select string_agg(to_jsonb(c)::text, ',' order by c.kind, c.label) from public.release_components c where c.release_id = pg_temp.id('pub')),
  (select v from pub_pieces), 'with its pieces');
select is((select count(*) from public.release_components where release_id = pg_temp.id('dup')), 2::bigint, 'dup keeps its own pieces as history');
select is((select string_agg(name, ',' order by name) from ids where name in ('a', 'b', 'c') and pg_temp.on_release(name) = pg_temp.id('pub')), 'a,b,c',
  'its copies are on pub now');
select is((select count(*) from before b where b.name in ('a', 'b', 'c', 'd') and b.state = pg_temp.copy_state(b.name)), 4::bigint,
  'with everything about them unchanged: conditions, private details and every piece record');
select is((select count(*) from before b where b.name in ('a', 'b', 'c')
           and b.updated_at = (select updated_at from public.collection_items where id = pg_temp.id(b.name))), 3::bigint, 'including when they were last edited');
select is((select string_agg(x.label, ',' order by x.label) from public.collection_item_components x where x.item_id = pg_temp.id('a')),
  'Manual,Registration card', 'a piece pub doesn''t list is kept');
select is(pg_temp.as_user('c1', format('select public.get_my_collection_item(%L) -> ''release'' ->> ''id''', pg_temp.id('a'))), pg_temp.id('pub')::text,
  'and its owner reads it on pub');
select is((select count(*) from public.collection_items where owner_id = pg_temp.u('c1') and release_id = pg_temp.id('pub')), 3::bigint,
  'an owner''s copies of both are all kept, never merged into one');
select is(pg_temp.on_release('x1'), pg_temp.id('hr'), 'and their copy of another release is untouched');
select is((select string_agg(right(item_id::text, 0) || owner_id::text, ',' order by item_id) from private.catalog_merge_copies where merge_id = pg_temp.id('m-dup')),
  (select string_agg(owner_id::text, ',' order by id) from public.collection_items where id in (pg_temp.id('a'), pg_temp.id('b'), pg_temp.id('c'))),
  'the merge records exactly the copies it moved');
select is((select row(kind, previous_status, copies_moved, owners_affected, references_moved, staff_reason, owner_note, merged_by = pg_temp.u('a7'))::text
           from private.catalog_merges where id = pg_temp.id('m-dup')),
  '(published,published,3,2,0,"Same release","Your copy now points to the main record.",t)', 'with its kind, previous status, counts and reasons');
select is((select repointed_releases from private.catalog_merges where id = pg_temp.id('m-dup')), array[pg_temp.id('old')], 'and the releases it repointed');
select is((select jsonb_array_length(differences) from private.catalog_merges where id = pg_temp.id('m-dup')), 3, 'and every acknowledged difference');
select is((select string_agg(format('%s:%s:%s', right(recipient_id::text, 2), data ->> 'status', data ->> 'copies'), ',' order by recipient_id)
           from public.notifications where data ->> 'merge_id' = pg_temp.id('m-dup')::text and type = 'catalog_merge'),
  'c1:merged:2,c2:merged:1', 'each owner is notified once, with their number of copies');
select ok((select bool_and(actor_id is null and data - array['status', 'merge_id', 'copies'] = '{}'::jsonb) from public.notifications
           where data ->> 'merge_id' = pg_temp.id('m-dup')::text), 'never naming who merged it');
select throws_ok(format($q$insert into public.notifications (recipient_id, type, data) values (%L, 'catalog_merge', %L)$q$,
  pg_temp.u('c1'), jsonb_build_object('status', 'merged', 'merge_id', pg_temp.id('m-dup'), 'copies', 2)), '23505', null,
  'and a second notice of the same merge can''t be stored');
select is((select count(*) from private.audit_events where action = 'catalog_release_merged' and metadata ->> 'id' = pg_temp.id('dup')::text
           and actor_id = pg_temp.u('a7') and reason = 'Same release' and metadata ->> 'merge_id' = pg_temp.id('m-dup')::text
           and (metadata ->> 'copies')::int = 3 and not metadata::text like '%' || pg_temp.u('c1') || '%'), 1::bigint,
  'the audit row has the administrator, the reason and the counts, and no owner');
select is(pg_temp.err(pg_temp.preview('e5', 'dup', 'pub')), 'error: release unavailable', 'a merged release can''t be merged again');
select is(pg_temp.err(pg_temp.preview('e5', 'rx', 'dup')), 'error: target unavailable', 'or merged into');
select is(pg_temp.as_user('c1', format('select public.add_collection_item(%L, %L, ''{}'')::text', private.uuid_v7(), pg_temp.id('dup'))),
  'error: release unavailable', 'and no copy can be added to it');
select throws_ok(format($q$update private.catalog_merges set staff_reason = 'Changed' where id = %L$q$, pg_temp.id('m-dup')), 'P0001',
  'merge records can''t be changed', 'merge records can''t be changed');
select throws_ok(format($q$delete from private.catalog_merges where id = %L$q$, pg_temp.id('m-dup')), 'P0001', 'merge records can''t be changed', 'or deleted');
select throws_ok(format($q$update private.catalog_merge_copies set owner_id = %L where merge_id = %L$q$, pg_temp.u('c2'), pg_temp.id('m-dup')), 'P0001',
  'merge records can''t be changed', 'nor their copies');

-- A restored exclusion stays history, and can't undo a merge.
select is(pg_temp.merge('a7', 'rx', 'pub') ->> 'copies', '0', 'a release whose exclusion was restored can be merged');
select is((select restored_at is not null from private.catalog_exclusions where id = pg_temp.id('x-rx')), true, 'and its exclusion record stays as it was');
select is(pg_temp.as_user('a8', format('select public.restore_exclusion(%L, %L, ''Again'')::text', pg_temp.id('x-rx'),
  (select version from private.catalog_exclusions where id = pg_temp.id('x-rx')))), 'error: exclusion unavailable', 'which can''t be restored again');
select is(pg_temp.err(pg_temp.merge('a7', 'pres', 'pub')), 'error: merge blocked', 'a source with a preserved copy is refused');
select is((select record_status::text from public.collection_items where id = pg_temp.id('pc')), 'invalid_preserved', 'and the copy stays preserved, where it was');

-- ---------------------------------------------------------------------------
-- An unverified release with no submission, and its external reference
-- ---------------------------------------------------------------------------
select is(pg_temp.preview('e5', 'imp', 'pub') ->> 'requires_admin', 'false', 'an unpublished source needs only an editor');
select is((select string_agg(format('%s:%s', r ->> 'external_id', r ->> 'target_had_provider'), ',') from jsonb_array_elements(pg_temp.preview('e5', 'imp', 'pub') -> 'references') r),
  'Q-MRG-IMP:true', 'the preview lists the reference it reassigns, and that pub already has one from that provider');
select is(pg_temp.merge('e5', 'imp', 'pub') ->> 'references', '1', 'an editor merges it');
select is((select row(status, merged_publicly)::text from public.releases where id = pg_temp.id('imp')), '(merged,f)', 'it isn''t public as merged');
select is((select string_agg(external_id, ',' order by external_id) from private.external_references where release_id = pg_temp.id('pub')),
  'Q-MRG-IMP,Q-MRG-PUB', 'its reference now names pub, and pub keeps its own');
select is((select row(reference_id is not null, provider_code, entity_type, external_id, from_release_id = pg_temp.id('imp'), to_release_id = pg_temp.id('pub'), target_had_provider)::text
           from private.catalog_merge_references where merge_id = pg_temp.id('m-imp')),
  '(t,wikidata,release,Q-MRG-IMP,t,t,t)', 'the reassignment is recorded as it was');
select throws_ok(format($q$delete from private.catalog_merge_references where merge_id = %L$q$, pg_temp.id('m-imp')), 'P0001',
  'merge records can''t be changed', 'permanently');

-- ---------------------------------------------------------------------------
-- Submissions
-- ---------------------------------------------------------------------------
select pg_temp.start_review('sp');
select is(pg_temp.blocking('sp', 'pub'), '', 'once in review, a submission can be merged');
select is(pg_temp.preview('e5', 'sp', 'pub') ->> 'requires_admin', 'false', 'by an editor');
select pg_temp.start_review('esub');
select is(pg_temp.err(pg_temp.merge('e6', 'esub', 'pub')), 'error: own submission', 'but never by its submitter');
select is(pg_temp.preview('e6', 'esub', 'pub') ->> 'own_submission', 'true', 'which the preview says');
-- e6's earlier submission ej, approved by e5: published, its submitter cleared, so only
-- the permanent history says e6 submitted it.
insert into ids select 'ej', (pg_temp.as_user('e6', format(
  'select public.submit_release(%L, ''snes'', ''rom-cartridge'', ''ntsc-j'', ''{"product_code": "MRG-EJ", "edition_name": "Standard", "edition_kind": "standard", "media_count": 1}'', ''[]'', null, true)::text', pg_temp.id('g')))::jsonb ->> 'release_id')::uuid;
select pg_temp.start_review('ej');
select pg_temp.as_user('e5', format('select public.approve_submission(%L, %L, %L, %L, ''Checked'')::text', pg_temp.req('ej'),
  (select version from public.catalog_change_requests where id = pg_temp.req('ej')), (select revision from public.releases where id = pg_temp.id('ej')),
  (select revision from public.games where id = pg_temp.id('g'))));
select is((select row(status, submitted_by is null)::text from public.releases where id = pg_temp.id('ej')), '(published,t)', 'e6''s approved submission is published, its submitter cleared');
select is(pg_temp.err(pg_temp.merge('e6', 'imp2', 'ej')), 'error: own submission', 'so e6 can''t merge into it either: the history remembers');
select is(pg_temp.merge('e5', 'sp', 'pub') ->> 'copies', '1', 'an editor merges c3''s submission into pub');
select is((select row(status, merged_into_release_id = pg_temp.id('pub'), reviewed_by = pg_temp.u('e5'), reviewer_note)::text
           from public.catalog_change_requests where id = pg_temp.req('sp')),
  '(merged,t,t,"Your copy now points to the main record.")', 'the submission is merged, with the note to owners as the reviewer''s note');
select is((select row(status, merged_publicly, submitted_by is null)::text from public.releases where id = pg_temp.id('sp')), '(merged,f,t)',
  'the release is merged, not public, its submitter cleared as for publication');
select is((select row(request_id = pg_temp.req('sp'), previous_request ->> 'status')::text from private.catalog_merges where id = pg_temp.id('m-sp')), '(t,in_review)',
  'the merge keeps the submission''s fields before');
select is(pg_temp.on_release('p'), pg_temp.id('pub'), 'c3''s copy moved');
select is((select state from before where name = 'p'), pg_temp.copy_state('p'), 'unchanged');
select is((select string_agg(type || ':' || (data ->> 'status'), ',') from public.notifications where recipient_id = pg_temp.u('c3') and data ->> 'merge_id' = pg_temp.id('m-sp')::text),
  'catalog_submission:merged', 'c3 is notified once, by their submission');
select is(pg_temp.as_user('c3', format('select public.get_my_submission(%L) ->> ''status''', pg_temp.req('sp'))), 'merged', 'and reads it as merged');
select is(pg_temp.as_user('c3', format('select public.get_my_merged_submission(%L)::text', pg_temp.req('sp'))),
  format('{"game_slug": "mrg-copper-hill", "release_id": "%s"}', pg_temp.id('pub')), 'with where it went');
select is(pg_temp.as_user('c1', format('select coalesce(public.get_my_merged_submission(%L)::text, ''null'')', pg_temp.req('sp'))), 'null', 'which nobody else reads');
select is(pg_temp.as_user(null, format('select coalesce(public.resolve_merged_release(%L)::text, ''null'')', pg_temp.id('sp'))), 'null',
  'and its address doesn''t redirect');

-- A new game's submission, merged into another game's release.
select pg_temp.start_review('ns');
select is(pg_temp.blocking('ns', 'pub'), '', 'a submission may go to another game''s release');
select ok(pg_temp.fields('ns', 'pub') @> array['game'], 'which is a flagged difference');
select is(pg_temp.preview('e5', 'ns', 'pub') -> 'retire' ->> 'status', 'rejected', 'the game it created would be retired, as rejection does');
create temp table t_ns as select pg_temp.preview('e5', 'ns', 'pub') ->> 'token' as t, pg_temp.fields('ns', 'pub') as f;
update public.games set title = 'Mrg Copper Hill Renamed' where id = pg_temp.id('g');
select is(pg_temp.err(pg_temp.merge('e5', 'ns', 'pub', p_token => (select t from t_ns), p_fields => (select f from t_ns))), 'error: preview stale',
  'a preview is stale once a value it showed changes, even one no release''s revision covers');
update public.games set title = 'Mrg Copper Hill' where id = pg_temp.id('g');
select is(pg_temp.merge('e5', 'ns', 'pub') ->> 'copies', '1', 'an editor merges it');
select is((select status::text from public.games where id = pg_temp.id('ns-g')), 'rejected', 'its unused game is retired');
select is((select retired_game ->> 'previous_status' from private.catalog_merges where id = pg_temp.id('m-ns')), 'under_review', 'with its previous status recorded');
select is(pg_temp.as_user(null, format('select count(*)::text from public.games where id = %L', pg_temp.id('ns-g'))), '0', 'and stays private');
select is(pg_temp.commit_check(), 'ok', 'and the publication rules hold');

-- ---------------------------------------------------------------------------
-- Reading merges
-- ---------------------------------------------------------------------------
select is(pg_temp.j(pg_temp.as_user('e6', 'select public.get_merges(null, 50)::text')) -> 'items' -> 0 ->> 'id', pg_temp.id('m-ns')::text,
  'editors list merges, newest first');
select is(pg_temp.j(pg_temp.as_user('e6', format('select public.get_merge(%L)::text', pg_temp.id('m-dup')))) ->> 'merged_by', 'mg_a7', 'and read one');
select is(pg_temp.as_user('c1', 'select public.get_merges(null, 50)::text'), 'error: not permitted', 'collectors can''t');

select * from finish();
rollback;
