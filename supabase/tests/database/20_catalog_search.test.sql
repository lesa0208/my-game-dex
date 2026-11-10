-- M5c: catalog search, the release picker, the platform list, and aliases.
-- Builds its own fictional catalog through the editor functions. Every title starts
-- with "Qzv", so results don't depend on other data, such as the dev fixture.
begin;
create extension if not exists pgtap with schema extensions;
select plan(129);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated, anon;

create temp table ids (name text primary key, id uuid not null);
grant all on ids to authenticated;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
grant execute on function pg_temp.id(text) to authenticated, anon;

-- Acts as anon (null), or as a signed-in user.
create function pg_temp.act(p_actor text) returns void language plpgsql as $t$
begin
  if p_actor is null then
    perform set_config('request.jwt.claims', '{"role": "anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end $t$;

-- Each returns the function's result, or {"error": message}.
create function pg_temp.search(p_actor text, p_query text, p_platforms text[] default null, p_limit int default 20, p_cursor text default null)
returns jsonb language plpgsql as $t$
declare r jsonb;
begin
  perform pg_temp.act(p_actor);
  r := public.search_catalog(p_query, p_platforms, p_limit, p_cursor);
  perform set_config('role', 'none', true);
  return r;
exception when others then
  perform set_config('role', 'none', true);
  return jsonb_build_object('error', sqlerrm);
end $t$;
create function pg_temp.picker(p_actor text, p_game text, p_platform text default null, p_region text default null, p_release uuid default null)
returns jsonb language plpgsql as $t$
declare r jsonb;
begin
  perform pg_temp.act(p_actor);
  r := public.get_release_picker(p_game, p_platform, p_region, p_release);
  perform set_config('role', 'none', true);
  return r;
exception when others then
  perform set_config('role', 'none', true);
  return jsonb_build_object('error', sqlerrm);
end $t$;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform pg_temp.act(p_actor);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;

-- The titles of a result's games, in order. Only this file's games count, so similar
-- titles elsewhere in the database, such as the dev fixture's, don't matter.
create function pg_temp.titles(p jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(e -> 'game' ->> 'title', '|' order by o), '') from jsonb_array_elements(p -> 'items') with ordinality x(e, o)
  where e -> 'game' ->> 'title' ~ '^(The )?Qzv' $$;
create function pg_temp.keys(p jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(k, ',' order by k), '') from jsonb_object_keys(p) k $$;

-- A verified game, and a verified release, published unless p_publish is false.
create function pg_temp.game(p_name text, p_title text, p_date date default null, p_precision public.date_precision default 'unknown')
returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.create_game(p_title, 'game', null, null, p_date, p_precision, 'Search tests');
  perform public.verify_game(v, 'Search tests', (select revision from public.games where id = v));
  insert into ids values (p_name, v);
  return v;
end $$;
create function pg_temp.release(p_name text, p_game text, p_platform text, p_format text, p_region text, p_details jsonb default '{}', p_publish boolean default true)
returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.create_release(pg_temp.id(p_game), (select id from public.platforms where slug = p_platform), p_format, p_region,
    '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}'::jsonb || p_details, 'Search tests');
  perform public.verify_release(v, 'Search tests', (select revision from public.releases where id = v));
  if p_publish then
    perform public.publish_release(v, 'Search tests', (select revision from public.releases where id = v));
  end if;
  insert into ids values (p_name, v);
  return v;
end $$;
grant execute on function pg_temp.game(text, text, date, public.date_precision), pg_temp.release(text, text, text, text, text, jsonb, boolean) to authenticated;

-- e1: catalog editor. c2: ordinary user. b3: a user with a submission of their own.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['e1', 'c2', 'b3']) as s;
update public.profiles set handle = 'srch_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['e1', 'c2', 'b3']) as s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('e1'), 'catalog_editor');

-- ---------------------------------------------------------------------------
-- The test catalog, made by the editor
-- ---------------------------------------------------------------------------
select pg_temp.act('e1');
select pg_temp.game('star', 'Qzv Starlight Saga', '1993-11-19', 'day');
select pg_temp.release('star-us', 'star', 'snes', 'rom-cartridge', 'ntsc-uc', '{"product_code": "QZV-1001", "barcode": "9990001000017", "packaging": "Box", "release_date": "1993-11-19", "release_date_precision": "day"}');
select pg_temp.release('star-eu', 'star', 'snes', 'rom-cartridge', 'pal', '{"release_date": "1994-01-01", "release_date_precision": "year"}');
select pg_temp.release('star-jp', 'star', 'snes', 'rom-cartridge', 'ntsc-j', '{"product_code": "QZV-1001-J", "local_title": "クズブ スターライト", "release_date": "1993-08-01", "release_date_precision": "month"}');
select pg_temp.release('star-nes', 'star', 'nes', 'rom-cartridge', 'ntsc-uc', '{"product_code": "QZV-1001-N", "local_title": "Qzv Unpublished Local"}', false);
-- Unpublished, on a published pairing, so only the release's own status hides it.
select pg_temp.release('star-draft', 'star', 'snes', 'rom-cartridge', 'latam', '{"product_code": "QZV-1001-D"}', false);
select pg_temp.game('star2', 'Qzv Starlight Saga II');
select pg_temp.release('star2-us', 'star2', 'snes', 'rom-cartridge', 'ntsc-uc');
select pg_temp.game('warden', 'The Qzv Warden');
select pg_temp.release('warden-us', 'warden', 'mega-drive', 'rom-cartridge', 'ntsc-uc');
select pg_temp.game('accent', 'Qzvé Rangers');
select pg_temp.release('accent-us', 'accent', 'game-boy', 'game-boy-game-pak', 'ntsc-uc');
select pg_temp.game('clay', 'QzvBoxer Turbo');
select pg_temp.release('clay-us', 'clay', 'snes', 'rom-cartridge', 'ntsc-uc');
select pg_temp.game('twin-a', 'Qzv Twin Harbor', '1991-01-01', 'year');
select pg_temp.release('twin-a-us', 'twin-a', 'snes', 'rom-cartridge', 'ntsc-uc');
select pg_temp.game('twin-b', 'Qzv Twin Harbor', '2004-01-01', 'year');
select pg_temp.release('twin-b-jp', 'twin-b', 'pc-engine', 'hucard', 'ntsc-j');
select pg_temp.game('hidden', 'Qzv Hidden Quest');
select pg_temp.release('hidden-us', 'hidden', 'snes', 'rom-cartridge', 'ntsc-uc', '{"product_code": "QZV-HIDDEN"}', false);
select pg_temp.game('rejected', 'Qzv Rejected Racer');
select pg_temp.game('merged-pub', 'Qzv Starlite Saga');
select pg_temp.release('merged-pub-us', 'merged-pub', 'snes', 'rom-cartridge', 'ntsc-uc');
select pg_temp.game('merged-hidden', 'Qzv Shadow Copy');
select pg_temp.release('merged-hidden-us', 'merged-hidden', 'snes', 'rom-cartridge', 'ntsc-uc');
select pg_temp.game('merged-never', 'Qzv Never Public');
select pg_temp.game('excluded', 'Qzv Excluded Epic');
select pg_temp.release('excluded-us', 'excluded', 'snes', 'rom-cartridge', 'ntsc-uc', '{"product_code": "QZV-EXCL"}');
select pg_temp.game('page' || lpad(n::text, 2, '0'), 'Qzv Page ' || lpad(n::text, 2, '0')) from generate_series(1, 55) n;
select pg_temp.release('page' || lpad(n::text, 2, '0') || '-r', 'page' || lpad(n::text, 2, '0'), 'vectrex', 'rom-cartridge', 'ntsc-uc') from generate_series(1, 55) n;
select set_config('role', 'none', true);

-- What M7 will do: reject, exclude and merge.
update public.games set status = 'rejected', verified_at = null, verified_by = null where id = pg_temp.id('rejected');
update public.releases set status = 'excluded' where id = pg_temp.id('excluded-us');
update public.games set status = 'excluded' where id = pg_temp.id('excluded');
update public.releases set status = 'merged', merged_into_id = pg_temp.id('star-us') where id = pg_temp.id('merged-pub-us');
update public.games set status = 'merged', merged_into_id = pg_temp.id('star') where id = pg_temp.id('merged-pub');
update public.releases set status = 'merged', merged_into_id = pg_temp.id('hidden-us') where id = pg_temp.id('merged-hidden-us');
update public.games set status = 'merged', merged_into_id = pg_temp.id('hidden') where id = pg_temp.id('merged-hidden');
update public.games set status = 'merged', merged_into_id = pg_temp.id('star') where id = pg_temp.id('merged-never');
update public.game_platforms set status = 'excluded' where game_id in (pg_temp.id('excluded'), pg_temp.id('merged-pub'), pg_temp.id('merged-hidden'));

-- A user's own submission, which the read policies show them but search never does.
insert into public.games (id, title, sort_title, kind, status, submitted_by) values (pg_temp.u('d0'), 'Qzv Own Submission', 'Qzv Own Submission', 'game', 'unverified', pg_temp.u('b3'));
insert into public.game_platforms (game_id, platform_id, status, submitted_by) values (pg_temp.u('d0'), (select id from public.platforms where slug = 'snes'), 'unverified', pg_temp.u('b3'));
insert into public.releases (game_id, platform_id, region_code, media_format_code, status, submitted_by)
values (pg_temp.u('d0'), (select id from public.platforms where slug = 'snes'), 'ntsc-uc', 'rom-cartridge', 'unverified', pg_temp.u('b3'));

-- ---------------------------------------------------------------------------
-- Schema and access
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.game_aliases'::regclass), 'game_aliases has RLS');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
  where has_table_privilege(r, 'public.game_aliases', p)), 0, 'no API role can write aliases');
select is((select string_agg(f || '=' || has_function_privilege('anon', f, 'execute') || '/' || has_function_privilege('authenticated', f, 'execute') || '/' || has_function_privilege('service_role', f, 'execute'), ' ' order by f)
  from unnest(array['public.search_catalog(text, text[], integer, text)', 'public.get_release_picker(text, text, text, uuid)', 'public.list_catalog_platforms()']) f),
  'public.get_release_picker(text, text, text, uuid)=true/true/false public.list_catalog_platforms()=true/true/false public.search_catalog(text, text[], integer, text)=true/true/false',
  'anon and signed-in users can search, service_role can''t');
select is((select count(*)::int from unnest(array['public.add_game_alias(uuid, text, public.game_alias_kind, text, text, text)', 'public.remove_game_alias(uuid, text)']) f
  where has_function_privilege('anon', f, 'execute') or has_function_privilege('service_role', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')), 0,
  'only signed-in users can call the alias functions, which then check the role');
select is((select count(*)::int from pg_proc p where p.proname like 'catalog\_%' and p.pronamespace = 'private'::regnamespace
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0, 'no private search helper is reachable from the API');
select is((select string_agg(p.proname || ':' || p.provolatile::text || ':' || p.prosecdef::text, ',' order by p.proname) from pg_proc p
  where p.oid in ('public.search_catalog(text, text[], integer, text)'::regprocedure, 'public.get_release_picker(text, text, text, uuid)'::regprocedure, 'public.list_catalog_platforms()'::regprocedure)),
  'get_release_picker:s:true,list_catalog_platforms:s:true,search_catalog:s:true', 'the search functions are STABLE, so they can''t write');
select is((select count(*)::int from pg_indexes where schemaname = 'public' and tablename in ('games', 'releases') and indexname like '%search%' and indexdef not like '%status = ''published''%'), 0,
  'every game and release search index is partial on published');
select is((select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges where table_schema = 'public' and table_name = 'game_aliases' and grantee = 'anon' and privilege_type = 'SELECT'),
  'created_at,game_id,id,kind,language_code,region_code,title,updated_at', 'anon reads only the alias fields');

-- ---------------------------------------------------------------------------
-- Aliases
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('c2', format($$select public.add_game_alias(%L, 'Qzv Nope', 'alternate', null, null, 'x')::text$$, pg_temp.id('star'))), 'error: not permitted', 'an ordinary user can''t add an alias');
select is(pg_temp.as_user(null, format($$select public.add_game_alias(%L, 'Qzv Nope', 'alternate', null, null, 'x')::text$$, pg_temp.id('star'))), 'error: permission denied for function add_game_alias', 'nor can anon');
select is(pg_temp.as_user('e1', format($$select public.add_game_alias(%L, 'Qzv Nope', 'alternate')::text$$, pg_temp.id('star'))), 'error: reason required', 'an editor needs a reason');
select ok(pg_temp.as_user('e1', format($$select public.add_game_alias(%L, 'Qzv Hoshi Monogatari', 'romanized', 'ja-Latn', 'ntsc-j', 'Romanized Japanese title')::text$$, pg_temp.id('star')))
  ~ '^[0-9a-f-]{36}$', 'an editor adds an alias');
insert into ids select 'alias-star', id from public.game_aliases where title = 'Qzv Hoshi Monogatari';
select is((select count(*)::int from private.audit_events where action = 'catalog_alias_added' and actor_id = pg_temp.u('e1') and reason = 'Romanized Japanese title'
  and metadata ->> 'id' = pg_temp.id('star')::text and metadata ->> 'title' = 'Qzv Hoshi Monogatari' and metadata ->> 'language_code' = 'ja-Latn'), 1, 'with an audit row');
select is(pg_temp.as_user('e1', format($$select public.add_game_alias(%L, 'QZV  hoshi monogatari', 'romanized', 'ja-Latn', 'ntsc-j', 'Again')::text$$, pg_temp.id('star'))),
  pg_temp.id('alias-star')::text, 'the same alias again returns it');
select is((select count(*)::int from private.audit_events where action = 'catalog_alias_added' and reason = 'Again'), 0, 'and records nothing');
select is(pg_temp.as_user('e1', format($$select public.add_game_alias(%L, 'The Qzv Starlight Saga', 'alternate', null, null, 'Same')::text$$, pg_temp.id('star'))),
  'error: alias repeats the title', 'an alias that only repeats the title is refused');
select ok(pg_temp.as_user('e1', format($$select public.add_game_alias(%L, 'Qzv Region Alias', 'regional', null, 'unknown', 'Unknown')::text$$, pg_temp.id('star'))) like 'error:%',
  'an alias can''t claim the unknown region');
select ok(pg_temp.as_user('e1', format($$select public.add_game_alias(%L, 'Qzv Merged Alias', 'alternate', null, null, 'Merged')::text$$, pg_temp.id('merged-pub'))) = 'error: record unavailable',
  'nor be added to a merged game');
select ok(pg_temp.as_user('e1', format($$select public.add_game_alias(%L, 'Qzv Secret Alias', 'alternate', null, null, 'Hidden game alias')::text$$, pg_temp.id('hidden'))) ~ '^[0-9a-f-]{36}$',
  'an unpublished game can have an alias');
select ok(pg_temp.as_user('e1', format($$select public.add_game_alias(%L, 'Qzv Removable', 'alternate', null, null, 'To remove')::text$$, pg_temp.id('star'))) ~ '^[0-9a-f-]{36}$', 'another alias');
select is(pg_temp.as_user('c2', format($$select public.remove_game_alias((select id from public.game_aliases where title = 'Qzv Removable'), 'x')::text$$)), 'error: not permitted', 'an ordinary user can''t remove one');
select is(pg_temp.as_user('e1', $$select public.remove_game_alias((select id from public.game_aliases where title = 'Qzv Removable'), 'Not a real title')::text$$), 'true', 'an editor removes it');
select is((select count(*)::int from private.audit_events where action = 'catalog_alias_removed' and actor_id = pg_temp.u('e1') and reason = 'Not a real title' and metadata ->> 'title' = 'Qzv Removable'), 1,
  'the audit row keeps what it was');
select is(pg_temp.as_user('e1', format($$select public.remove_game_alias(%L, 'Again')::text$$, pg_temp.u('ff'))), 'false', 'removing an unknown alias changes nothing');
select is(pg_temp.as_user(null, $$select count(*)::text from public.game_aliases where title like 'Qzv%'$$), '1', 'anon reads only aliases of published games');
select is(pg_temp.as_user('e1', $$select count(*)::text from public.game_aliases where title like 'Qzv%'$$), '2', 'editors read them all');

-- ---------------------------------------------------------------------------
-- Matching
-- ---------------------------------------------------------------------------
-- First search in this session, on purpose: an empty first page once failed on a
-- fresh connection.
select is(pg_temp.search(null, 'qzv no such title anywhere'), '{"items": [], "status": "ok", "platforms": [], "next_cursor": null}', 'a search with no results is empty, not an error');
select is(pg_temp.titles(pg_temp.search(null, 'Qzv Starlight Saga')), 'Qzv Starlight Saga|Qzv Starlight Saga II', 'an exact title first, then titles it begins');
select is((select string_agg(e ->> 'match', ',' order by o) from jsonb_array_elements(pg_temp.search(null, 'Qzv Starlight Saga') -> 'items') with ordinality x(e, o)), 'exact,prefix', 'each says how it matched');
select is(pg_temp.search(null, 'qzv starlight saga 2') -> 'items' -> 0 -> 'game' ->> 'title', 'Qzv Starlight Saga II', 'a Roman numeral matches a digit');
select is(pg_temp.titles(pg_temp.search(null, 'saga qzv')), 'Qzv Starlight Saga|Qzv Starlight Saga II', 'every word, in any order');
select is((pg_temp.search(null, 'saga qzv') -> 'items' -> 0 ->> 'match'), 'words', 'is a words match');
select is(pg_temp.titles(pg_temp.search(null, 'qzv warden')), 'The Qzv Warden', 'a leading article is ignored');
select is(pg_temp.titles(pg_temp.search(null, 'Qzv Warden, The')), 'The Qzv Warden', 'and so is a trailing one');
select is(pg_temp.titles(pg_temp.search(null, 'qzve rangers')), 'Qzvé Rangers', 'accents are ignored');
select is(pg_temp.search(null, 'qzv boxer turbo') -> 'items' -> 0 ->> 'match', 'exact', 'word breaks are ignored for an exact match');
select is(pg_temp.search(null, 'qzv hoshi') -> 'items' -> 0 -> 'matched', '{"title": "Qzv Hoshi Monogatari", "source": "alias"}', 'an alias matches, and says so');
select is(pg_temp.search(null, 'クズブ') -> 'items' -> 0 -> 'matched', '{"title": "クズブ スターライト", "source": "local_title"}', 'a Japanese local title matches');
select is(pg_temp.search(null, 'ク') ->> 'status', 'ok', 'one character of a non-Latin script is enough');
select is(pg_temp.search(null, 'qzv starlihgt saga') -> 'items' -> 0 ->> 'match', 'similar', 'a typo still finds the game');
select is(pg_temp.titles(pg_temp.search(null, 'qzv starlihgt saga')) like 'Qzv Starlight Saga%', true, 'the closest first');
-- The trigram thresholds are the function's, whatever the session sets, and the
-- session's own values come back afterwards.
select set_config('pg_trgm.similarity_threshold', '0.95', true), set_config('pg_trgm.word_similarity_threshold', '0.95', true);
select is(pg_temp.titles(pg_temp.search(null, 'qzv starlihgt saga')) like 'Qzv Starlight Saga%', true, 'a strict session setting doesn''t hide a typo match');
select is(current_setting('pg_trgm.similarity_threshold') || '/' || current_setting('pg_trgm.word_similarity_threshold'), '0.95/0.95', 'and the session''s settings are restored');
select set_config('pg_trgm.similarity_threshold', '0.05', true), set_config('pg_trgm.word_similarity_threshold', '0.05', true);
select is(pg_temp.titles(pg_temp.search(null, 'qzv hiden quest')), '', 'a lenient session setting doesn''t add weak matches');
select set_config('pg_trgm.similarity_threshold', '0.3', true), set_config('pg_trgm.word_similarity_threshold', '0.6', true);
select is(pg_temp.titles(pg_temp.search(null, 'qzv twin harbor')), 'Qzv Twin Harbor|Qzv Twin Harbor', 'two games with the same title are two results');
select is((select string_agg(e -> 'game' -> 'first_release' ->> 'value', ',' order by o) from jsonb_array_elements(pg_temp.search(null, 'qzv twin harbor') -> 'items') with ordinality x(e, o) where e -> 'game' ->> 'title' ~ '^Qzv') in ('1991,2004', '2004,1991'),
  true, 'told apart by year');
select is(pg_temp.search(null, 'qzv-1001') -> 'items' -> 0 ->> 'kind', 'release', 'an exact product code is the release');
select is(pg_temp.search(null, 'qzv-1001') -> 'items' -> 0 -> 'release' ->> 'id', pg_temp.id('star-us')::text, 'the right one');
select is(pg_temp.search(null, '999 0001 000017') -> 'items' -> 0 ->> 'matched_identifier', 'barcode', 'a barcode, typed with spaces, too');
select is(pg_temp.search(null, 'qzv starlight saga') = pg_temp.search(null, 'qzv starlight saga'), true, 'the same query gives the same result');

-- ---------------------------------------------------------------------------
-- Only published, verified records, for everyone
-- ---------------------------------------------------------------------------
select is(pg_temp.titles(pg_temp.search('c2', 'Qzv Starlight Saga')), 'Qzv Starlight Saga|Qzv Starlight Saga II', 'signed-in users get the same results');
select is(pg_temp.titles(pg_temp.search('e1', 'qzv hidden quest')), '', 'an unpublished game isn''t found, even by an editor');
select is(pg_temp.titles(pg_temp.search(null, 'qzv hidden quest')), '', 'nor by anon');
select is(pg_temp.titles(pg_temp.search(null, 'qzv hiden quest')), '', 'nor by a similar title');
select is(pg_temp.titles(pg_temp.search(null, 'qzv secret alias')), '', 'an unpublished game''s alias doesn''t match');
select is(pg_temp.titles(pg_temp.search('b3', 'qzv own submission')), '', 'a user''s own submission isn''t found by them');
select is(pg_temp.titles(pg_temp.search(null, 'qzv rejected racer')), '', 'a rejected game isn''t found');
select is(pg_temp.titles(pg_temp.search(null, 'qzv excluded epic')), '', 'nor an excluded one');
select is(pg_temp.titles(pg_temp.search(null, 'qzv starlite saga')) not like '%Starlite%', true, 'nor a merged one');
select is(pg_temp.titles(pg_temp.search(null, 'qzv shadow copy')), '', 'nor one merged into an unpublished game');
select is(pg_temp.titles(pg_temp.search(null, 'qzv-hidden')), '', 'an unpublished release''s code isn''t found');
select is(pg_temp.titles(pg_temp.search(null, 'qzv-excl')), '', 'nor an excluded release''s');
select is(pg_temp.titles(pg_temp.search(null, 'qzv-1001-n')), '', 'nor that of a release not yet published for a published game');
select is(pg_temp.titles(pg_temp.search(null, 'qzv unpublished local')), '', 'an unpublished release''s local title doesn''t match');
select is(pg_temp.search(null, 'qzv starlight saga') -> 'items' -> 0 -> 'platforms', '[{"name": "Super Nintendo Entertainment System", "slug": "snes", "short_name": "SNES", "release_count": 3}]',
  'a result counts only published releases, on published platforms');
select is(pg_temp.titles(pg_temp.search(null, 'qzv starlight saga', array['nes'])), '', 'a platform with only an unpublished release doesn''t match the filter');
select is(pg_temp.titles(pg_temp.search(null, 'qzv twin harbor', array['pc-engine'])), 'Qzv Twin Harbor', 'the platform filter keeps games released on it');
select is(pg_temp.titles(pg_temp.search(null, 'qzv twin harbor', array['no-such-platform'])), '', 'an unknown platform matches nothing');
select is(pg_temp.search(null, 'qzv twin harbor', array['pc-engine', 'no-such-platform']) -> 'platforms', '["pc-engine"]', 'the response gives the filter it applied');

-- ---------------------------------------------------------------------------
-- What a response contains
-- ---------------------------------------------------------------------------
select is(pg_temp.keys(pg_temp.search(null, 'qzv starlight')), 'items,next_cursor,platforms,status', 'a search response has only its fields');
select is(pg_temp.keys(pg_temp.search(null, 'qzv starlight') -> 'items' -> 0), 'game,kind,match,matched,platforms', 'a game result has only its fields');
select is(pg_temp.keys(pg_temp.search(null, 'qzv starlight') -> 'items' -> 0 -> 'game'), 'first_release,id,kind,slug,title', 'and so does its game');
select is(pg_temp.keys(pg_temp.search(null, 'qzv-1001') -> 'items' -> 0), 'game,kind,match,matched_identifier,release', 'a release result has only its fields');
select is(pg_temp.keys(pg_temp.search(null, 'qzv-1001') -> 'items' -> 0 -> 'release'), 'edition_name,id,identifiers,platform,region,variant_name', 'and so does its release');
select is(pg_temp.keys(pg_temp.picker(null, (select slug from public.games where id = pg_temp.id('star')))), 'game,platforms,regions,releases,selection', 'a picker response has only its fields');
select is(pg_temp.keys(pg_temp.picker(null, (select slug from public.games where id = pg_temp.id('star'))) -> 'game'), 'aliases,first_release,id,kind,slug,title', 'and so does its game');
select is(pg_temp.keys(pg_temp.picker(null, (select slug from public.games where id = pg_temp.id('star'))) -> 'releases' -> 0),
  'components,edition,format,id,identifiers,languages,local_title,markets,media_count,media_playability,packaging,platform,publisher_name,rating_labels,region,release_date,requirements,variant_name',
  'and each of its releases');
select is((select count(*)::int from (values (pg_temp.search(null, 'qzv starlight')::text), (pg_temp.search(null, 'qzv-1001')::text),
    (pg_temp.picker(null, (select slug from public.games where id = pg_temp.id('star')))::text), (public.list_catalog_platforms()::text)) v(t)
  where t like '%' || pg_temp.u('e1') || '%' or t ~ '(verified|submitted)_(by|at)|revision|provider|evidence|audit|"(published|under_review|unverified|rejected|excluded|merged)"'), 0,
  'no response names an editor, a verification, a revision, provenance or a review status');

-- ---------------------------------------------------------------------------
-- Pages and limits
-- ---------------------------------------------------------------------------
create temp table pages as
  with p1 as (select pg_temp.search(null, 'qzv page', null, 20) r),
       p2 as (select pg_temp.search(null, 'qzv page', null, 20, (select r ->> 'next_cursor' from p1)) r),
       p3 as (select pg_temp.search(null, 'qzv page', null, 20, (select r ->> 'next_cursor' from p2)) r)
  select 1 n, r from p1 union all select 2, r from p2 union all select 3, r from p3;
select is((select string_agg(jsonb_array_length(r -> 'items')::text, ',' order by n) from pages), '20,20,15', 'pages of twenty, twenty and fifteen');
select is((select string_agg(pg_temp.titles(r), '|' order by n) from pages), (select string_agg('Qzv Page ' || lpad(n::text, 2, '0'), '|' order by n) from generate_series(1, 55) n),
  'in order, with nothing repeated or missed');
select is((select r -> 'next_cursor' from pages where n = 3), 'null', 'the last page has no cursor');
select is(pg_temp.search(null, 'qzv starlight', null, 10, (select r ->> 'next_cursor' from pages where n = 1)) ->> 'error', 'invalid cursor', 'a cursor only continues its own query');
select is(pg_temp.search(null, 'qzv page', array['vectrex'], 10, (select r ->> 'next_cursor' from pages where n = 1)) ->> 'error', 'invalid cursor', 'and its own filter');
select is(pg_temp.search(null, 'qzv page', null, 10, 'bm90IGEgY3Vyc29y') ->> 'error', 'invalid cursor', 'something that isn''t a cursor is refused');
select is(pg_temp.search(null, 'qzv page', null, 10, 'not a cursor!') ->> 'error', 'invalid cursor', 'as is anything with other characters');
select is(pg_temp.search(null, 'qzv page', null, 10, private.catalog_cursor_encode(jsonb_set((select private.catalog_cursor_decode(r ->> 'next_cursor') from pages where n = 1), '{0}', '"000000000000"'))) ->> 'error',
  'invalid cursor', 'and one altered by hand');
select is(jsonb_array_length(pg_temp.search(null, 'qzv page', null, 10, private.catalog_cursor_encode(jsonb_set((select private.catalog_cursor_decode(r ->> 'next_cursor') from pages where n = 1), '{1}', '199'))) -> 'items'), 1,
  'results stop at 200');
select is(pg_temp.search(null, 'qzv page', null, 10, private.catalog_cursor_encode(jsonb_set((select private.catalog_cursor_decode(r ->> 'next_cursor') from pages where n = 1), '{1}', '199'))) -> 'next_cursor', 'null',
  'with no cursor after them');
select is(pg_temp.search(null, 'qzv page', null, 10, private.catalog_cursor_encode(jsonb_set((select private.catalog_cursor_decode(r ->> 'next_cursor') from pages where n = 1), '{1}', '200'))) ->> 'error',
  'invalid cursor', 'and no page past them');
select is(jsonb_array_length(pg_temp.search(null, 'qzv page', null, 500) -> 'items'), 50, 'a large limit is capped at 50');
select is(pg_temp.titles(pg_temp.search(null, 'qzv twin harbor', null, 1)) || '|' || pg_temp.titles(pg_temp.search(null, 'qzv twin harbor', null, 1, pg_temp.search(null, 'qzv twin harbor', null, 1) ->> 'next_cursor')),
  'Qzv Twin Harbor|Qzv Twin Harbor', 'games with the same title are paged one at a time, not skipped');
select is(jsonb_array_length(pg_temp.search(null, 'qzv page', null, 0) -> 'items'), 1, 'a limit below one is one');
select is(pg_temp.search(null, repeat('q', 101)) ->> 'error', 'query too long', 'a query has at most 100 characters');
select is(pg_temp.search(null, 'qzv', array['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']) ->> 'error', 'too many platforms', 'and at most ten platforms');
select is(pg_temp.search(null, '  ') ->> 'status', 'empty', 'an empty query is empty');
select is(pg_temp.search(null, 'q') ->> 'status', 'too_short', 'one Latin letter is too short');
select is(pg_temp.search(null, '!!') ->> 'status', 'too_short', 'and punctuation alone');
select is(pg_temp.titles(pg_temp.search(null, null, array['vectrex'], 3)), 'Qzv Page 01|Qzv Page 02|Qzv Page 03', 'a platform with no query lists its games by title');
select is(pg_temp.search(null, null, array['vectrex'], 3) -> 'items' -> 0 ->> 'match', 'browse', 'as a browse');

-- ---------------------------------------------------------------------------
-- The release picker
-- ---------------------------------------------------------------------------
create temp table star as select slug from public.games where id = pg_temp.id('star');
select is(pg_temp.picker(null, (select slug from star)) -> 'game' ->> 'id', pg_temp.id('star')::text, 'a public game, by slug');
select is(pg_temp.picker('c2', pg_temp.id('star')::text) -> 'game' ->> 'slug', (select slug from star), 'or by id, for a signed-in user too');
select is(jsonb_array_length(pg_temp.picker(null, (select slug from star)) -> 'releases'), 3, 'with its published releases only');
select is(pg_temp.picker(null, (select slug from star)) -> 'platforms', '[{"name": "Super Nintendo Entertainment System", "slug": "snes", "short_name": "SNES", "release_count": 3}]',
  'on published platforms only');
select is(pg_temp.picker(null, (select slug from star)) -> 'game' -> 'aliases', '[{"kind": "romanized", "title": "Qzv Hoshi Monogatari", "region_code": "ntsc-j", "language_code": "ja-Latn"}]', 'and its aliases');
select is(pg_temp.picker(null, (select slug from star)) -> 'selection', '{"region": null, "platform": "snes", "release_id": null}', 'a game on one platform has it selected');
select is((select string_agg(e -> 'region' ->> 'code', ',' order by o) from jsonb_array_elements(pg_temp.picker(null, (select slug from star)) -> 'releases') with ordinality x(e, o)),
  'ntsc-uc,ntsc-j,pal', 'releases in region order');
select is(pg_temp.picker(null, (select slug from star), null, 'pal') -> 'releases' -> 0 ->> 'id', pg_temp.id('star-eu')::text, 'a region filter');
select is(jsonb_array_length(pg_temp.picker(null, (select slug from star), null, 'latam') -> 'releases'), 3, 'a region with no release is ignored');
select is(pg_temp.picker(null, (select slug from star), 'nes') -> 'selection' ->> 'platform', 'snes', 'and so is a platform with no public release');
select is(pg_temp.picker(null, (select slug from star), null, null, pg_temp.id('star-jp')) -> 'selection',
  jsonb_build_object('region', 'ntsc-j', 'platform', 'snes', 'release_id', pg_temp.id('star-jp')), 'a selected release sets its platform and region');
select is(pg_temp.picker(null, (select slug from star), null, null, pg_temp.id('star-nes')) -> 'selection' -> 'release_id', 'null', 'an unpublished release can''t be selected');
select is(pg_temp.picker(null, (select slug from star), null, null, pg_temp.id('twin-a-us')) -> 'selection' -> 'release_id', 'null', 'nor another game''s');
select is(pg_temp.picker(null, (select slug from star), null, 'pal') -> 'releases' -> 0 -> 'release_date', '{"value": "1994", "precision": "year"}', 'a date only to its precision');
select is(pg_temp.picker(null, (select slug from star), null, 'ntsc-j') -> 'releases' -> 0 -> 'release_date', '{"value": "1993-08", "precision": "month"}', 'by month');
select is(pg_temp.picker(null, (select slug from star), null, 'pal') -> 'releases' -> 0 -> 'packaging', 'null', 'unknown packaging stays unknown');
select is(pg_temp.picker(null, (select slug from star), null, 'pal') -> 'releases' -> 0 -> 'identifiers', '{"barcode": null, "product_code": null}', 'and so do unknown identifiers');
select is(pg_temp.picker(null, (select slug from star), null, 'pal') -> 'releases' -> 0 -> 'media_playability', 'null', 'and an unknown playability');
select is(pg_temp.picker(null, (select slug from public.games where id = pg_temp.id('merged-pub'))) -> 'game' ->> 'id', pg_temp.id('star')::text, 'a merged game resolves to the public game it was merged into');
select is(pg_temp.picker(null, (select slug from public.games where id = pg_temp.id('merged-hidden'))), null, 'but not to an unpublished one');
select is(pg_temp.picker(null, pg_temp.id('merged-never')::text), null, 'and a merged game that was never public resolves to nothing');
select is((select count(*)::int from (values (pg_temp.picker(null, pg_temp.id('hidden')::text)), (pg_temp.picker('e1', pg_temp.id('hidden')::text)), (pg_temp.picker(null, pg_temp.id('rejected')::text)),
    (pg_temp.picker(null, pg_temp.id('excluded')::text)), (pg_temp.picker('b3', pg_temp.u('d0')::text)), (pg_temp.picker(null, 'no-such-game')), (pg_temp.picker(null, pg_temp.u('ff')::text))) v(r)
  where r is not null), 0, 'unpublished, rejected, excluded, a user''s own and unknown games are all just null, for everyone');

-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- Revisions with stored search keys (the M5b trigger, replaced in M5c)
-- ---------------------------------------------------------------------------
-- The keys are generated columns, which a BEFORE trigger sees without a value. Only
-- content changes may raise a revision.
select pg_temp.act('e1');
select pg_temp.game('rev', 'Qzv Revision Test');
select pg_temp.release('rev-us', 'rev', 'snes', 'rom-cartridge', 'ntsc-uc', '{"local_title": "Qzv Revision Local"}', false);
select set_config('role', 'none', true);
create temp table rev_seen as select (select revision from public.games where id = pg_temp.id('rev')) g, (select revision from public.releases where id = pg_temp.id('rev-us')) r;
update public.games set updated_at = now() + interval '1 minute' where id = pg_temp.id('rev');
update public.releases set updated_at = now() + interval '1 minute' where id = pg_temp.id('rev-us');
select is((select revision from public.games where id = pg_temp.id('rev')) || '/' || (select revision from public.releases where id = pg_temp.id('rev-us')), (select g || '/' || r from rev_seen),
  'an update that changes no content raises no revision, game or release');
update public.games set verified_at = now(), verified_by = pg_temp.u('e1') where id = pg_temp.id('rev');
select is((select revision from public.games where id = pg_temp.id('rev')), (select g from rev_seen), 'nor does verifying a game');
update public.games set title = 'Qzv Revision Renamed', sort_title = 'Qzv Revision Renamed' where id = pg_temp.id('rev');
select is((select revision || '/' || search_key from public.games where id = pg_temp.id('rev')), ((select g from rev_seen) + 1) || '/qzv revision renamed', 'a new title raises the revision once, and its key follows');
update public.releases set local_title = 'Qzv Local Renamed' where id = pg_temp.id('rev-us');
select is((select revision || '/' || local_title_key from public.releases where id = pg_temp.id('rev-us')), ((select r from rev_seen) + 1) || '/qzv local renamed', 'so does a new local title');
select is(pg_temp.as_user('e1', format($$select public.verify_game(%L, 'Checked', %s)::text$$, pg_temp.id('rev'), (select g from rev_seen))), 'error: record changed', 'verifying the title reviewed before the rename is refused');
select is(pg_temp.as_user('e1', format($$select public.verify_release(%L, 'Checked', %s)::text$$, pg_temp.id('rev-us'), (select r from rev_seen))), 'error: record changed', 'and so is the release reviewed before its change');

-- Platforms
-- ---------------------------------------------------------------------------
select is(jsonb_array_length(public.list_catalog_platforms()), (select count(*)::int from public.platforms), 'every platform is listed');
select is((select (e ->> 'game_count') || '/' || (e ->> 'release_count') from jsonb_array_elements(public.list_catalog_platforms()) e where e ->> 'slug' = 'snes'),
  (select count(distinct r.game_id) || '/' || count(*) from public.releases r join public.platforms p on p.id = r.platform_id
   join public.games g on g.id = r.game_id and g.status = 'published' where p.slug = 'snes' and r.status = 'published'),
  'counting only published releases of published games');

select * from finish();
rollback;
