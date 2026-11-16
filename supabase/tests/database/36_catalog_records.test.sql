-- M10b: catalog search, game and release records, and catalog-record history (D4).
-- Who may call each function, what each returns and never returns, that history is
-- only the requested record's allow-listed events, and that pages are bounded and
-- stable. Runs in one transaction that rolls back, on the local stack only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(84);

-- M8b: staff privileges need a live aal2 session with a verified TOTP factor. These
-- rows have the shape GoTrue writes (31_auth_contract pins it down) and roll back.
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
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.claims(pg_temp.u(p_actor))::text, true);
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
create function pg_temp.as_role(p_role text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', p_role, true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
-- A call's result as JSON, raising its error instead.
create function pg_temp.j(p_actor text, p_sql text) returns jsonb language plpgsql as $t$
declare r text := pg_temp.as_user(p_actor, p_sql);
begin
  if r like 'error:%' then raise exception '%', r; end if;
  return nullif(r, '')::jsonb;
end $t$;
create function pg_temp.keys(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(k, ',' order by k), '') from jsonb_object_keys(j) k
$$;
create function pg_temp.search(p_actor text, p_kind text, p_query text, p_platform text default null, p_status text default null, p_limit int default 25, p_cursor text default null)
returns jsonb language sql as $$
  select pg_temp.j(p_actor, format('select public.search_catalog_records(%L, %L, %L, %L, %L, %L)::text', p_kind, p_query, p_platform, p_status, p_limit, p_cursor))
$$;
create function pg_temp.history(p_actor text, p_entity text, p_id uuid, p_limit int default 25, p_before uuid default null)
returns jsonb language sql as $$
  select pg_temp.j(p_actor, format('select public.get_catalog_record_history(%L, %L, %L, %L)::text', p_entity, p_id, p_limit, p_before))
$$;
create function pg_temp.actions(h jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(e ->> 'action', ',' order by e ->> 'id'), '') from jsonb_array_elements(h -> 'items') e
$$;

-- a2: admin. d3: moderator. e4: catalog editor. c5: collector. a6: admin at aal1
-- only. e7: a suspended catalog editor. b8: a collector who submits.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a2', 'd3', 'e4', 'c5', 'a6', 'e7', 'b8']) as s;
update public.profiles set handle = 'rec_' || right(id::text, 2), handle_changed_at = now(), display_name = 'Person ' || right(id::text, 2)
where id in (select pg_temp.u(s) from unnest(array['a2', 'd3', 'e4', 'c5', 'a6', 'e7', 'b8']) s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('a2'), 'admin'), (pg_temp.u('d3'), 'moderator'), (pg_temp.u('e4'), 'catalog_editor'), (pg_temp.u('a6'), 'admin'), (pg_temp.u('e7'), 'catalog_editor');
select pg_temp.claims(pg_temp.u(s)) from unnest(array['a2', 'd3', 'e4', 'c5', 'e7', 'b8']) s;
update public.profiles set account_status = 'suspended' where id = pg_temp.u('e7');

-- ---------------------------------------------------------------------------
-- Fixture: an editor's game with an alias, a platform and a release with a locked
-- field; another game; three games to page through; a collector's submission.
-- ---------------------------------------------------------------------------
create temporary table ids (name text primary key, id uuid);
create function pg_temp.id(p text) returns uuid language sql as $$ select id from ids where name = p $$;
create function pg_temp.made(p_name text, p_result text) returns text language plpgsql as $$
begin
  if p_result ~ '^[0-9a-f-]{36}$' then insert into ids values (p_name, p_result::uuid); return 'ok'; end if;
  return p_result;
end $$;
select is(
  pg_temp.made('g', pg_temp.as_user('e4', format('select public.create_game(%L, %L, null, null, null, %L, %L)::text', 'Recfix Alpha Quest', 'game', 'unknown', 'Adding a game'))) || '/' ||
  pg_temp.made('g2', pg_temp.as_user('e4', format('select public.create_game(%L, %L, null, null, null, %L, %L)::text', 'Recfix Other World', 'game', 'unknown', 'Adding a game'))) || '/' ||
  pg_temp.made('p1', pg_temp.as_user('e4', format('select public.create_game(%L, %L, null, null, null, %L, %L)::text', 'Recfix Page One', 'game', 'unknown', 'Adding a game'))) || '/' ||
  pg_temp.made('p2', pg_temp.as_user('e4', format('select public.create_game(%L, %L, null, null, null, %L, %L)::text', 'Recfix Page Two', 'game', 'unknown', 'Adding a game'))) || '/' ||
  pg_temp.made('p3', pg_temp.as_user('e4', format('select public.create_game(%L, %L, null, null, null, %L, %L)::text', 'Recfix Page Three', 'game', 'unknown', 'Adding a game'))),
  'ok/ok/ok/ok/ok', 'setup: an editor adds five games');
select is(
  pg_temp.made('alias', pg_temp.as_user('e4', format('select public.add_game_alias(%L, %L, %L, null, null, %L)::text', pg_temp.id('g'), 'Recfix Aurora', 'alternate', 'Known as Aurora'))) || '/' ||
  pg_temp.as_user('e4', format('select public.set_game_platform(%L, %L, %L)::text', pg_temp.id('g'), (select id from public.platforms where slug = 'snes'), 'On the SNES')) || '/' ||
  pg_temp.made('r', pg_temp.as_user('e4', format('select public.create_release(%L, %L, %L, %L, %L, %L)::text', pg_temp.id('g'), (select id from public.platforms where slug = 'snes'),
    'rom-cartridge', 'pal', '{"edition_name": "Standard", "edition_kind": "standard", "product_code": "SNSP-RFXQ-EUR"}', 'The PAL cartridge'))) || '/' ||
  pg_temp.as_user('e4', format('select public.set_catalog_field_lock(%L, %L, %L, %L, %L)::text', 'release', pg_temp.id('r'), 'edition_name', true, 'Checked against the box')),
  'ok/true/ok/true', 'setup: an alias, a platform, a release and a locked field');
select is(
  (select r::jsonb ->> 'outcome' from (select pg_temp.as_user('b8', format('select public.submit_game(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L)::text',
    'Recfix Submitted Saga', 'game', null, 'snes', 'rom-cartridge', 'pal', '{}', '[]', null, true)) as r) x),
  'submitted', 'setup: a collector submits a game');
insert into ids select 'sg', id from public.games where title = 'Recfix Submitted Saga';
insert into ids select 'sr', id from public.releases where game_id = pg_temp.id('sg');
insert into ids select 'sub', id from public.catalog_change_requests where game_id = pg_temp.id('sg');
insert into ids values ('r2', gen_random_uuid());

-- Audit rows the functions above don't write: an unrelated action naming the game,
-- an import with internal keys, an exclusion and a merge with private details, and
-- an event on another game.
insert into private.audit_events (actor_id, action, reason, metadata) values
  (pg_temp.u('a2'), 'staff_role_granted', 'Granting a role', jsonb_build_object('entity', 'game', 'id', pg_temp.id('g'), 'role', 'catalog_editor')),
  (null, 'catalog_record_updated', 'Import run reason', jsonb_build_object('entity', 'game', 'id', pg_temp.id('g'), 'fields', array['summary'],
    'import_run_id', gen_random_uuid(), 'provider_record_id', gen_random_uuid(), 'copies', 5, 'owners', jsonb_build_array(pg_temp.u('b8')), 'email', 'b8@example.test')),
  (pg_temp.u('e4'), 'catalog_release_excluded', 'Private staff reason', jsonb_build_object('entity', 'release', 'id', pg_temp.id('r'),
    'exclusion_id', pg_temp.u('ee'), 'reason_code', 'download_code', 'previous_status', 'unverified', 'cascade', 1, 'copies', 3)),
  (pg_temp.u('e4'), 'catalog_release_merged', 'Same release', jsonb_build_object('entity', 'release', 'id', pg_temp.id('r2'), 'target_id', pg_temp.id('r'),
    'merge_id', pg_temp.u('ff'), 'kind', 'unpublished', 'copies', 2, 'references', 1, 'repointed', 0)),
  (pg_temp.u('e4'), 'catalog_record_updated', 'Another game', jsonb_build_object('entity', 'game', 'id', pg_temp.id('g2'), 'fields', array['title'])),
  (pg_temp.u('e4'), 'catalog_record_updated', 'Wrong entity', jsonb_build_object('entity', 'release', 'id', pg_temp.id('g'), 'fields', array['title']));
-- More than a page: 51 games, and 51 events on another game.
insert into public.games (title, sort_title) select 'Recfix Bulk ' || n, 'Recfix Bulk ' || lpad(n::text, 3, '0') from generate_series(1, 51) n;
insert into private.audit_events (actor_id, action, reason, metadata)
select pg_temp.u('e4'), 'catalog_record_updated', 'Bulk change ' || n, jsonb_build_object('entity', 'game', 'id', pg_temp.id('g2'), 'fields', array['summary'])
from generate_series(1, 51) n;

-- ---------------------------------------------------------------------------
-- 1. The functions and who may call them
-- ---------------------------------------------------------------------------
create temporary table fns (sig text, call text);
insert into fns values
  ('public.search_catalog_records(text, text, text, text, integer, text)', 'select public.search_catalog_records(''games'', ''recfix'')::text'),
  ('public.get_game_record(uuid)', format('select public.get_game_record(%L)::text', pg_temp.id('g'))),
  ('public.get_release_record(uuid)', format('select public.get_release_record(%L)::text', pg_temp.id('r'))),
  ('public.get_catalog_record_history(text, uuid, integer, uuid)', format('select public.get_catalog_record_history(''game'', %L)::text', pg_temp.id('g')));

select is((select count(*)::int from fns f join pg_proc p on p.oid = f.sig::regprocedure
  where p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""'] and p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres}'),
  4, 'all four are STABLE, SECURITY DEFINER with an empty search_path, and only authenticated may execute them');
select is((select count(*)::int from fns f, unnest(array['anon', 'service_role']) r where has_function_privilege(r, f.sig, 'execute')), 0,
  'anon and service_role can''t execute any of them');
select is((select count(*)::int from fns f where pg_temp.as_role('anon', f.call) like 'error: permission denied for function %'), 4, 'anon is refused by PostgreSQL');
select is((select count(*)::int from fns f where pg_temp.as_role('authenticated', f.call) = 'error: not permitted'), 4, 'an authenticated request with no user is refused');
select is((select count(*)::int from fns f where pg_temp.as_user('c5', f.call) = 'error: not permitted'), 4, 'a collector is refused');
select is((select count(*)::int from fns f where pg_temp.as_user('b8', f.call) = 'error: not permitted'), 4, 'so is the submitter, even for records about their own submission');
select is((select count(*)::int from fns f where pg_temp.as_user('d3', f.call) = 'error: not permitted'), 4, 'a moderator is refused');
select is((select count(*)::int from fns f where pg_temp.as_aal1('e4', f.call) = 'error: not permitted'), 4, 'a catalog editor at aal1 is refused');
select is((select count(*)::int from fns f where pg_temp.as_aal1('a6', f.call) = 'error: not permitted'), 4, 'an administrator at aal1 is refused');
select is((select count(*)::int from fns f where pg_temp.as_user('e7', f.call) = 'error: not permitted'), 4, 'a suspended catalog editor is refused, even at aal2');
select is((select count(*)::int from fns f where pg_temp.as_user('e4', f.call) not like 'error:%'), 4, 'a catalog editor may call all four');
select is((select count(*)::int from fns f where pg_temp.as_user('a2', f.call) not like 'error:%'), 4, 'and so may an administrator');
select is(pg_temp.as_user('e4', 'select count(*)::text from public.get_audit_events(5)'), 'error: not permitted', 'the full audit log stays administrators'' only');

-- ---------------------------------------------------------------------------
-- 2. Search
-- ---------------------------------------------------------------------------
select is(pg_temp.keys(pg_temp.search('e4', 'games', 'alpha')), 'items,next_cursor,status', 'a search returns status, items and a cursor');
select is((select string_agg(e ->> 'title', ',' order by e ->> 'title') from jsonb_array_elements(pg_temp.search('e4', 'games', 'alpha') -> 'items') e),
  'Recfix Alpha Quest', 'an unpublished game is found by a word inside its title');
select is((select string_agg(e ->> 'title', ',') from jsonb_array_elements(pg_temp.search('e4', 'games', 'aurora') -> 'items') e),
  'Recfix Alpha Quest', 'and by its alias');
select is((select string_agg(e ->> 'title', ',') from jsonb_array_elements(pg_temp.search('e4', 'games', pg_temp.id('g')::text) -> 'items') e),
  'Recfix Alpha Quest', 'and by its id');
select is((select string_agg(e ->> 'title', ',') from jsonb_array_elements(pg_temp.search('e4', 'games', 'submitted saga') -> 'items') e),
  'Recfix Submitted Saga', 'a collector''s pending submission is found too');
select is(pg_temp.keys(pg_temp.search('e4', 'games', 'alpha') -> 'items' -> 0),
  'first_release,id,kind,merged_into_id,platforms,releases,slug,status,title,verified', 'a game result has exactly its fields');
select is(pg_temp.keys(pg_temp.search('e4', 'releases', 'alpha') -> 'items' -> 0),
  'edition_name,format,game,id,merged_into_id,platform,product_code,region,status,variant_name,verified', 'a release result has exactly its fields');
select is(position(pg_temp.u('b8')::text in pg_temp.search('a2', 'games', 'recfix')::text) + position('rec_b8' in pg_temp.search('a2', 'games', 'recfix')::text)
  + position('@' in pg_temp.search('a2', 'releases', 'recfix')::text), 0, 'no result names the submitter, by id, handle or email');
select is((pg_temp.search('e4', 'games', 'alpha') -> 'items' -> 0 ->> 'status'), 'under_review', 'each result says where it stands');
select is(jsonb_array_length(pg_temp.search('e4', 'games', 'alpha', null, 'published') -> 'items'), 0, 'a status filter leaves out the other statuses');
select is(jsonb_array_length(pg_temp.search('e4', 'games', 'alpha', null, 'under_review') -> 'items'), 1, 'and keeps the status asked for');
select is(jsonb_array_length(pg_temp.search('e4', 'games', 'alpha', 'snes') -> 'items'), 1, 'a platform filter keeps games on that platform');
select is(jsonb_array_length(pg_temp.search('e4', 'games', 'alpha', 'nes') -> 'items'), 0, 'and leaves out the others');
select is(pg_temp.search('e4', 'games', 'alpha', 'no-such-platform') ->> 'status', 'unknown_platform', 'an unknown platform says so, with no results');
select is((select string_agg(e ->> 'product_code', ',') from jsonb_array_elements(pg_temp.search('e4', 'releases', 'snsp-rfxq-eur') -> 'items') e),
  'SNSP-RFXQ-EUR', 'a release is found by its product code, in any case');
select is((select string_agg(e ->> 'id', ',') from jsonb_array_elements(pg_temp.search('e4', 'releases', pg_temp.id('g')::text) -> 'items') e),
  pg_temp.id('r')::text, 'a release search for a game''s id lists that game''s releases');
select is(pg_temp.search('e4', 'games', 'a') ->> 'status', 'too_short', 'a one-letter query is too short');
select is(pg_temp.as_user('e4', format('select public.search_catalog_records(''games'', %L)::text', repeat('x', 101))), 'error: invalid filter', 'a query over 100 characters is refused');
select is(pg_temp.as_user('e4', 'select public.search_catalog_records(''accounts'', ''recfix'')::text'), 'error: invalid filter', 'an unknown kind is refused');
select is(pg_temp.as_user('e4', 'select public.search_catalog_records(''games'', ''recfix'', null, ''deleted'')::text'), 'error: invalid filter', 'an unknown status is refused');
select is(jsonb_array_length(pg_temp.search('e4', 'games', 'recfix bulk', null, null, 500) -> 'items'), 50, 'a page never has more than 50 results, however many are asked for');
select is((pg_temp.search('e4', 'games', 'recfix bulk', null, null, 500) ->> 'next_cursor') is not null, true, 'and the rest are on the next page');
-- Paging: the three page games, two then one, in sort order, without repeats.
select is((select string_agg(e ->> 'title', ',' order by o) from jsonb_array_elements(pg_temp.search('e4', 'games', 'recfix page', null, null, 2) -> 'items') with ordinality x(e, o)),
  'Recfix Page One,Recfix Page Three', 'the first page has the first two, in sort-title order');
select is((select string_agg(e ->> 'title', ',') from jsonb_array_elements(pg_temp.search('e4', 'games', 'recfix page', null, null, 2,
  pg_temp.search('e4', 'games', 'recfix page', null, null, 2) ->> 'next_cursor') -> 'items') e),
  'Recfix Page Two', 'the next page continues after them');
select is(pg_temp.search('e4', 'games', 'recfix page', null, null, 2, pg_temp.search('e4', 'games', 'recfix page', null, null, 2) ->> 'next_cursor') ->> 'next_cursor',
  null, 'and the last page has no cursor');
select is(pg_temp.as_user('e4', format('select public.search_catalog_records(''games'', ''recfix alpha'', null, null, 2, %L)::text',
  pg_temp.search('e4', 'games', 'recfix page', null, null, 2) ->> 'next_cursor')), 'error: invalid cursor', 'a cursor only works with the search it came from');
select is(pg_temp.as_user('e4', 'select public.search_catalog_records(''games'', ''recfix'', null, null, 2, ''bm90LWEtY3Vyc29y'')::text'), 'error: invalid cursor', 'a made-up cursor is refused');
select is(pg_temp.as_user('c5', 'select count(*)::text from public.games where title like ''Recfix%'''), '0',
  'the collector still can''t read the unpublished games directly');

-- ---------------------------------------------------------------------------
-- 3. Records
-- ---------------------------------------------------------------------------
select is(pg_temp.keys(pg_temp.j('e4', format('select public.get_game_record(%L)::text', pg_temp.id('g')))),
  'aliases,created_at,external_references,field_locks,first_release,id,kind,merged_into,platforms,relations,release_count,releases,revision,slug,sort_title,status,submissions,summary,title,updated_at,verified_at',
  'a game record has exactly its fields');
select is((select string_agg(e ->> 'title', ',') from jsonb_array_elements(pg_temp.j('e4', format('select public.get_game_record(%L)::text', pg_temp.id('g'))) -> 'aliases') e),
  'Recfix Aurora', 'with its alias');
select is((select string_agg(e ->> 'slug' || ':' || (e ->> 'status'), ',') from jsonb_array_elements(pg_temp.j('e4', format('select public.get_game_record(%L)::text', pg_temp.id('g'))) -> 'platforms') e),
  'snes:under_review', 'its platform pairing and that pairing''s status');
select is((select string_agg(e ->> 'id', ',') from jsonb_array_elements(pg_temp.j('e4', format('select public.get_game_record(%L)::text', pg_temp.id('g'))) -> 'releases') e),
  pg_temp.id('r')::text, 'and its releases');
select is(pg_temp.j('e4', format('select public.get_game_record(%L)::text', pg_temp.id('sg'))) -> 'submissions' -> 0 ->> 'id', pg_temp.id('sub')::text,
  'a submitted game links to its submission');
select is(pg_temp.keys(pg_temp.j('e4', format('select public.get_game_record(%L)::text', pg_temp.id('sg'))) -> 'submissions' -> 0), 'created_at,id,kind,status',
  'which says nothing about who submitted it');
select is(position(pg_temp.u('b8')::text in pg_temp.j('e4', format('select public.get_game_record(%L)::text', pg_temp.id('sg')))::text)
  + position(pg_temp.u('b8')::text in pg_temp.j('e4', format('select public.get_release_record(%L)::text', pg_temp.id('sr')))::text)
  + position('rec_b8' in pg_temp.j('e4', format('select public.get_release_record(%L)::text', pg_temp.id('sr')))::text), 0,
  'neither record of a submission names the submitter');
select is(pg_temp.keys(pg_temp.j('e4', format('select public.get_release_record(%L)::text', pg_temp.id('r')))),
  'components,created_at,edition,evidence,exclusions,external_references,field_locks,format,game,id,identifiers,languages,local_title,markets,media_count,media_playability,merged_into,merged_publicly,merges,packaging,pairing_status,platform,publisher_name,rating_labels,region,region_unknown_confirmed,release_date,requirements,revision,status,submissions,updated_at,variant_name,verified_at',
  'a release record has exactly its fields');
select is(pg_temp.j('e4', format('select public.get_release_record(%L)::text', pg_temp.id('r'))) -> 'field_locks' -> 0 ->> 'field', 'edition_name', 'with its locked field');
select is(pg_temp.keys(pg_temp.j('e4', format('select public.get_release_record(%L)::text', pg_temp.id('r'))) -> 'field_locks' -> 0), 'field,locked_at',
  'and not who locked it');
select is(jsonb_typeof(pg_temp.j('e4', format('select public.get_release_record(%L)::text', pg_temp.id('r'))) -> 'exclusions'), 'null', 'an editor doesn''t get the exclusions');
select is(jsonb_typeof(pg_temp.j('a2', format('select public.get_release_record(%L)::text', pg_temp.id('r'))) -> 'exclusions'), 'array', 'an administrator does');
select is(pg_temp.as_user('e4', format('select public.get_game_record(%L)::text', gen_random_uuid())), '', 'an unknown game is null');
select is(pg_temp.as_user('e4', format('select public.get_release_record(%L)::text', gen_random_uuid())), '', 'and so is an unknown release');

-- ---------------------------------------------------------------------------
-- 4. History (D4)
-- ---------------------------------------------------------------------------
select is((select string_agg(e ->> 'action', ',' order by e ->> 'action') from jsonb_array_elements(pg_temp.history('e4', 'game', pg_temp.id('g')) -> 'items') e),
  'catalog_alias_added,catalog_record_created,catalog_record_created,catalog_record_updated',
  'a game''s history is its own events: created, alias, platform pairing, an import''s update');
select is(position('staff_role_granted' in pg_temp.history('a2', 'game', pg_temp.id('g'))::text), 0,
  'an unrelated action naming the game never appears, even for an administrator');
select is(position('Another game' in pg_temp.history('e4', 'game', pg_temp.id('g'))::text), 0, 'nor another game''s event');
select is(position('Wrong entity' in pg_temp.history('a2', 'game', pg_temp.id('g'))::text), 0, 'nor a release''s event that happens to carry the game''s id');
select is(pg_temp.keys(pg_temp.history('e4', 'game', pg_temp.id('g')) -> 'items' -> 0), 'action,actor,details,id,occurred_at,reason', 'each event has exactly its fields');
select is((select e -> 'actor' ->> 'kind' from jsonb_array_elements(pg_temp.history('e4', 'game', pg_temp.id('g')) -> 'items') e where e -> 'actor' ->> 'kind' = 'import'),
  'import', 'an import is shown as an import');
select is((select pg_temp.keys(e -> 'details') || '|' || coalesce(e ->> 'reason', 'no reason') from jsonb_array_elements(pg_temp.history('e4', 'game', pg_temp.id('g')) -> 'items') e
  where e -> 'actor' ->> 'kind' = 'import'),
  'entity,fields,record_id|no reason', 'with only its allowed details: no run, provider entry, copies, owners or email, and no run reason');
select is((select e -> 'actor' ->> 'handle' from jsonb_array_elements(pg_temp.history('e4', 'game', pg_temp.id('g')) -> 'items') e where e ->> 'action' = 'catalog_alias_added'),
  'rec_e4', 'a staff action names the staff member by handle');
select is((select e ->> 'reason' from jsonb_array_elements(pg_temp.history('e4', 'game', pg_temp.id('g')) -> 'items') e where e ->> 'action' = 'catalog_alias_added'),
  'Known as Aurora', 'with the reason they gave');
select is((select string_agg(e ->> 'action', ',' order by e ->> 'action') from jsonb_array_elements(pg_temp.history('e4', 'release', pg_temp.id('r')) -> 'items') e),
  'catalog_field_locked,catalog_record_created,catalog_release_excluded,catalog_release_merged',
  'a release''s history: created, a locked field, an exclusion, and a merge into it');
select is((select coalesce(e ->> 'reason', 'no reason') || '|' || pg_temp.keys(e -> 'details') from jsonb_array_elements(pg_temp.history('e4', 'release', pg_temp.id('r')) -> 'items') e
  where e ->> 'action' = 'catalog_release_excluded'),
  'no reason|entity,previous_status,reason_code,record_id', 'an exclusion shows its code, not the staff reason, the copies or the cascade, and no exclusion id to an editor');
select is((select e -> 'details' ->> 'exclusion_id' from jsonb_array_elements(pg_temp.history('a2', 'release', pg_temp.id('r')) -> 'items') e
  where e ->> 'action' = 'catalog_release_excluded'), pg_temp.u('ee')::text, 'an administrator gets the exclusion id, to open it');
select is((select pg_temp.keys(e -> 'details') from jsonb_array_elements(pg_temp.history('e4', 'release', pg_temp.id('r')) -> 'items') e
  where e ->> 'action' = 'catalog_release_merged'),
  'entity,merge_id,merge_kind,record_id,target_id', 'a merge shows the merge and both releases, not the copies or references');
select is(pg_temp.actions(pg_temp.history('e4', 'release', pg_temp.id('sr'))), 'catalog_submission_created',
  'a submitted release''s history is its submission');
select is((select e -> 'actor' from jsonb_array_elements(pg_temp.history('e4', 'release', pg_temp.id('sr')) -> 'items') e where e ->> 'action' = 'catalog_submission_created'),
  '{"kind": "submitter"}'::jsonb, 'a submitter is shown as one, never by name');
select is((select pg_temp.keys(e -> 'details') || '|' || coalesce(e ->> 'reason', 'no reason') from jsonb_array_elements(pg_temp.history('e4', 'release', pg_temp.id('sr')) -> 'items') e
  where e ->> 'action' = 'catalog_submission_created'), 'game_id,release_id,request_id|no reason', 'with the submission it belongs to');
select is(position(pg_temp.u('b8')::text in pg_temp.history('a2', 'release', pg_temp.id('sr'))::text) + position('rec_b8' in pg_temp.history('a2', 'game', pg_temp.id('sg'))::text)
  + position('@' in pg_temp.history('a2', 'game', pg_temp.id('g'))::text), 0, 'no history names the submitter or holds an email');
-- Paging: two, then the rest, newest first, without repeats.
select is(jsonb_array_length(pg_temp.history('e4', 'game', pg_temp.id('g'), 2) -> 'items'), 2, 'a history page holds the number asked for');
select is((select count(*)::int from jsonb_array_elements(pg_temp.history('e4', 'game', pg_temp.id('g'), 2) -> 'items') a
  join jsonb_array_elements(pg_temp.history('e4', 'game', pg_temp.id('g'), 2, (pg_temp.history('e4', 'game', pg_temp.id('g'), 2) ->> 'next_before')::uuid) -> 'items') b on a ->> 'id' = b ->> 'id'),
  0, 'the next page starts after it, with nothing repeated');
select is(jsonb_array_length(pg_temp.history('e4', 'game', pg_temp.id('g'), 2, (pg_temp.history('e4', 'game', pg_temp.id('g'), 2) ->> 'next_before')::uuid) -> 'items'), 2,
  'and holds the rest');
select is(pg_temp.history('e4', 'game', pg_temp.id('g'), 4) ->> 'next_before', null, 'the last page has no cursor');
select is((select bool_and((a ->> 'id') > (b ->> 'id')) from jsonb_array_elements(pg_temp.history('e4', 'game', pg_temp.id('g')) -> 'items') with ordinality x(a, o)
  join jsonb_array_elements(pg_temp.history('e4', 'game', pg_temp.id('g')) -> 'items') with ordinality y(b, p) on p = o + 1), true, 'events are newest first');
select is(jsonb_array_length(pg_temp.history('e4', 'game', pg_temp.id('g2'), 1000) -> 'items'), 50, 'a page never has more than 50 events, however many are asked for');
select is(pg_temp.as_user('e4', format('select public.get_catalog_record_history(''profile'', %L)::text', pg_temp.id('g'))), 'error: invalid filter', 'only games and releases have a history');
select is(pg_temp.as_user('e4', format('select public.get_catalog_record_history(''game'', %L)::text', pg_temp.id('r'))), 'error: record unavailable',
  'a release''s id isn''t a game''s history');
select is(pg_temp.as_user('e4', format('select public.get_catalog_record_history(''release'', %L)::text', pg_temp.id('r2'))), 'error: record unavailable',
  'and an id that is no record has none, even if events name it');

select * from finish();
rollback;
