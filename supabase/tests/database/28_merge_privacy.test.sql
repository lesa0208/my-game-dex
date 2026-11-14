-- M7b-2c (D3, D14): a merged release is public only if it was published when merged.
-- Written before any merge function exists, so the merges here are made directly, as
-- merge_release will leave them: the submission first, then the release, its submitter
-- cleared. Every read path a collector or visitor has is checked: the release, its
-- pieces, markets and hardware, the picker, search, counts, adding and moving copies,
-- the submission reads, the redirect, and the errors they give.
begin;
create extension if not exists pgtap with schema extensions;
select plan(38);

-- M8b: staff privileges need a live aal2 session with a verified TOTP factor. These
-- rows have the shape GoTrue writes (31_auth_contract pins it down) and roll back with
-- the test; the check scripts and HTTP suites use real sessions from local GoTrue.
create function pg_temp.claims(p_user uuid) returns jsonb language plpgsql as $mfa$
begin
  if exists (select 1 from auth.users where id = p_user) then
    insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      select p_user, p_user, 'test session factor', 'totp', 'verified', now(), now()
      where not exists (select 1 from auth.mfa_factors where id = p_user);
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
      values (gen_random_uuid(), p_user, 'totp', now(), now()) on conflict do nothing;
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user);
end $mfa$;

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
    perform set_config('request.jwt.claims', pg_temp.claims(pg_temp.u(p_actor))::text, true);
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
-- How many rows of a release's table a caller sees, by release name.
create function pg_temp.seen(p_actor text, p_table text, p_release text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select count(*)::text from public.%I where %I = %L', p_table,
    case when p_table = 'releases' then 'id' else 'release_id' end, pg_temp.id(p_release)))
$$;
create function pg_temp.resolve(p_actor text, p_release uuid) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select coalesce(public.resolve_merged_release(%L)::text, ''null'')', p_release))
$$;

-- c1: a collector. c3: a submitter. e5: a catalog editor.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['c1', 'c3', 'e5']) as s;
update public.profiles set handle = 'mp_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['c1', 'c3', 'e5']) s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('e5'), 'catalog_editor');

-- Catalog, made by e5: g "Mrg Quiet Valley" with pub, dup and old (published, SNES).
create function pg_temp.release(p_name text, p_game text, p_region text, p_code text) returns void language plpgsql as $$
declare r uuid;
begin
  r := public.create_release(pg_temp.id(p_game), (select id from public.platforms where slug = 'snes'), 'rom-cartridge', p_region,
    format('{"edition_name": "Standard %s", "edition_kind": "standard", "media_count": 1, "product_code": "%s"}', p_name, p_code)::jsonb, 'Merge tests');
  perform public.set_release_components(r, '[{"kind": "insert", "label": "Manual"}]'::jsonb, 'Merge tests');
  perform public.verify_release(r, 'Merge tests', (select revision from public.releases where id = r));
  perform public.publish_release(r, 'Merge tests', (select revision from public.releases where id = r));
  insert into ids values (p_name, r);
end $$;
grant execute on function pg_temp.release(text, text, text, text) to authenticated;
select set_config('request.jwt.claims', pg_temp.claims(pg_temp.u('e5'))::text, true);
select set_config('role', 'authenticated', true);
insert into ids select 'g', public.create_game('Mrg Quiet Valley', 'game', null, null, null, 'unknown', 'Merge tests');
select public.verify_game(pg_temp.id('g'), 'Merge tests', (select revision from public.games where id = pg_temp.id('g')));
select pg_temp.release('pub', 'g', 'ntsc-uc', 'MRG-PUB');
select pg_temp.release('dup', 'g', 'pal', 'MRG-DUP');
select pg_temp.release('old', 'g', 'ntsc-j', 'MRG-OLD');
select set_config('role', 'none', true);
select is(pg_temp.commit_check(), 'ok', 'the fixture satisfies the publication rules');

-- c3 submits sub on g, with a piece, a market and a hardware requirement of its own,
-- and adds a copy; e5 starts the review.
insert into ids select 'sub', (pg_temp.as_user('c3', format(
  'select public.submit_release(%L, ''snes'', ''rom-cartridge'', ''pal'', ''{"product_code": "MRG-SECRET", "local_title": "Mrg Hidden Name"}'', ''[{"kind": "insert", "label": "Secret manual"}]'', null, true)::text',
  pg_temp.id('g')))::jsonb ->> 'release_id')::uuid;
insert into public.release_markets (release_id, market_code) values (pg_temp.id('sub'), (select code from public.markets order by code limit 1));
insert into public.release_hardware_requirements (release_id, requirement_code, level)
  values (pg_temp.id('sub'), (select code from public.hardware_requirements order by code limit 1), 'required');
insert into ids values ('cs', private.uuid_v7()), ('c1pub', private.uuid_v7());
select pg_temp.as_user('c3', format('select public.add_collection_item(%L, %L, ''{}'')::text', pg_temp.id('cs'), pg_temp.id('sub')));
select pg_temp.as_user('c1', format('select public.add_collection_item(%L, %L, ''{}'')::text', pg_temp.id('c1pub'), pg_temp.id('pub')));
insert into ids select 'req', id from public.catalog_change_requests where release_id = pg_temp.id('sub');
select pg_temp.as_user('e5', format('select public.start_submission_review(%L, %L, ''Checking'')::text', pg_temp.id('req'),
  (select version from public.catalog_change_requests where id = pg_temp.id('req'))));
select is(pg_temp.seen('c3', 'releases', 'sub'), '1', 'before the merge, the submitter sees their submission');
select is(pg_temp.seen(null, 'releases', 'sub'), '0', 'and a visitor doesn''t');
create temp table counts_before as select public.list_catalog_platforms()::text as v;
grant select on counts_before to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The constraint
-- ---------------------------------------------------------------------------
select throws_ok(format($q$update public.releases set merged_publicly = true where id = %L$q$, pg_temp.id('old')), '23514', null,
  'only a merged release can be marked as merged publicly');

-- ---------------------------------------------------------------------------
-- An unpublished submission merged into pub, as merge_release will leave it
-- ---------------------------------------------------------------------------
update public.catalog_change_requests set status = 'merged', merged_into_release_id = pg_temp.id('pub'),
  reviewed_by = pg_temp.u('e5'), reviewed_at = now() where id = pg_temp.id('req');
update public.collection_items set release_id = pg_temp.id('pub') where id = pg_temp.id('cs');
update public.releases set status = 'merged', merged_into_id = pg_temp.id('pub'), submitted_by = null where id = pg_temp.id('sub');
select is(pg_temp.commit_check(), 'ok', 'merging an unpublished submission keeps the publication rules');

select is(pg_temp.seen(null, 'releases', 'sub'), '0', 'a visitor can''t read a submission merged while unpublished');
select is(pg_temp.seen('c1', 'releases', 'sub'), '0', 'nor can a collector');
select is(pg_temp.seen('c3', 'releases', 'sub'), '0', 'nor its submitter, who follows it through their submission');
select is(pg_temp.seen('e5', 'releases', 'sub'), '1', 'catalog editors still can');
select is(pg_temp.seen(null, 'release_components', 'sub') || pg_temp.seen('c1', 'release_components', 'sub') || pg_temp.seen('c3', 'release_components', 'sub'),
  '000', 'its pieces are hidden from visitors, collectors and the submitter');
select is(pg_temp.seen(null, 'release_markets', 'sub') || pg_temp.seen('c1', 'release_markets', 'sub'), '00', 'and its markets');
select is(pg_temp.seen(null, 'release_hardware_requirements', 'sub') || pg_temp.seen('c1', 'release_hardware_requirements', 'sub'), '00', 'and its hardware requirements');
select is(pg_temp.seen('e5', 'release_components', 'sub'), '1', 'editors still see its pieces');
select is(pg_temp.as_user('c1', format('select count(*)::text from public.releases where merged_into_id = %L', pg_temp.id('pub'))), '0',
  'no one finds it by what it was merged into');

select is(pg_temp.resolve(null, pg_temp.id('sub')), 'null', 'its address doesn''t redirect');
select is(pg_temp.resolve('c3', pg_temp.id('sub')), 'null', 'not even for its submitter');
select is(pg_temp.resolve(null, pg_temp.id('sub')), pg_temp.resolve(null, private.uuid_v7()), 'exactly as for an id that doesn''t exist');
select is(pg_temp.as_user(null, format('select public.get_release_picker(''mrg-quiet-valley'', null, null, %L) -> ''selection'' ->> ''release_id''', pg_temp.id('sub'))),
  '', 'the game page doesn''t select it');
select ok(pg_temp.as_user(null, format('select public.get_release_picker(%L, null, null, null)::text', pg_temp.id('g'))) not like '%' || pg_temp.id('sub') || '%',
  'or list it');
select is(pg_temp.as_user(null, 'select jsonb_array_length(public.search_catalog(''MRG-SECRET'', null, 20, null) -> ''items'')::text'), '0',
  'search doesn''t find it by its product code');
select is(pg_temp.as_user(null, 'select jsonb_array_length(public.search_catalog(''Mrg Hidden Name'', null, 20, null) -> ''items'')::text'), '0',
  'or by its local title');
select is(pg_temp.as_user(null, 'select public.list_catalog_platforms()::text'), (select v from counts_before), 'and the catalog counts don''t change');

select is(pg_temp.as_user('c1', format('select public.add_collection_item(%L, %L, ''{}'')::text', private.uuid_v7(), pg_temp.id('sub'))),
  pg_temp.as_user('c1', format('select public.add_collection_item(%L, %L, ''{}'')::text', private.uuid_v7(), private.uuid_v7())),
  'adding a copy to it fails as for an id that doesn''t exist');
select is(pg_temp.as_user('c3', format('select public.add_collection_item(%L, %L, ''{}'')::text', private.uuid_v7(), pg_temp.id('sub'))),
  'error: release unavailable', 'even for its submitter');
select is(pg_temp.as_user('c1', format('select public.relink_my_copy(%L, %L)::text', pg_temp.id('c1pub'), pg_temp.id('sub'))),
  pg_temp.as_user('c1', format('select public.relink_my_copy(%L, %L)::text', pg_temp.id('c1pub'), private.uuid_v7())),
  'and so does moving a copy to it');
select is(pg_temp.as_user('c1', format('select coalesce(public.my_submission_for_release(%L)::text, ''null'')', pg_temp.id('sub'))), 'null',
  'a collector reads no submission for it');
select is(pg_temp.as_user('c1', format('select coalesce(public.get_my_release_copies(%L)::text, ''null'')', pg_temp.id('sub'))),
  pg_temp.as_user('c1', format('select coalesce(public.get_my_release_copies(%L)::text, ''null'')', private.uuid_v7())), 'nor any copies');
select is(pg_temp.as_user('c3', format('select public.get_my_submission(%L) ->> ''status''', pg_temp.id('req'))), 'merged',
  'its submitter reads their submission as merged');
select is(pg_temp.as_user('c3', format('select public.get_my_collection_item(%L) -> ''release'' ->> ''id''', pg_temp.id('cs'))), pg_temp.id('pub')::text,
  'and their copy on the release it was merged into');

-- ---------------------------------------------------------------------------
-- A published release merged into pub
-- ---------------------------------------------------------------------------
update public.releases set status = 'merged', merged_into_id = pg_temp.id('pub'), merged_publicly = true where id = pg_temp.id('dup');
select is(pg_temp.commit_check(), 'ok', 'merging a published duplicate keeps the publication rules');
select is(pg_temp.seen(null, 'releases', 'dup'), '1', 'a release that was published stays readable when merged');
select is(pg_temp.seen(null, 'release_components', 'dup'), '1', 'with its pieces');
select is(pg_temp.resolve(null, pg_temp.id('dup')), format('{"game_slug": "mrg-quiet-valley", "release_id": "%s"}', pg_temp.id('pub')),
  'and its address redirects to the release it was merged into');
select is(pg_temp.resolve(null, pg_temp.id('pub')), 'null', 'a published release doesn''t redirect');

-- A merged release is followed only through public steps, and only to a public release.
savepoint chain;
update public.releases set status = 'merged', merged_into_id = pg_temp.id('dup'), merged_publicly = true where id = pg_temp.id('old');
select is(pg_temp.resolve(null, pg_temp.id('old'))::jsonb ->> 'release_id', pg_temp.id('pub')::text, 'a merged release is followed through public steps');
rollback to savepoint chain;
update public.releases set status = 'merged', merged_into_id = pg_temp.id('sub'), merged_publicly = true where id = pg_temp.id('old');
select is(pg_temp.resolve(null, pg_temp.id('old')), 'null', 'but never through one merged while unpublished');
rollback to savepoint chain;

select ok(not has_column_privilege('anon', 'public.releases', 'merged_publicly', 'select')
          and not has_column_privilege('authenticated', 'public.releases', 'merged_publicly', 'select'),
          'clients aren''t granted the flag itself');
select ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'public.resolve_merged_release(uuid)'::regprocedure)
          and not has_function_privilege('service_role', 'public.resolve_merged_release(uuid)', 'execute'),
          'resolve_merged_release runs as its owner with an empty search path, for visitors and signed-in users');

select * from finish();
rollback;
