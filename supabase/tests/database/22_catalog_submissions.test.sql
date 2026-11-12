-- M7a: catalog submissions. A collector submits a missing physical release of a game,
-- or a new game with its first release, and can add their own copy at once; nobody
-- else sees it. Builds a fictional catalog through the editor functions. Races and the
-- API boundary are in db-submission-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(118);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated, anon;
create temp table ids (name text primary key, id uuid not null);
grant all on ids to authenticated, anon;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
grant execute on function pg_temp.id(text) to authenticated, anon;

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

-- submit_release as a user. Returns the outcome, or the error.
create function pg_temp.sub(p_actor text, p_game uuid, p_platform text, p_format text, p_region text,
  p_details text default '{}', p_pieces text default '[]', p_note text default null, p_physical boolean default true) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.submit_release(%L, %L, %L, %L, %L, %L, %L, %L)::text',
    p_game, p_platform, p_format, p_region, p_details, p_pieces, p_note, p_physical))
$$;
-- The same, naming the submission and its release from the result.
create function pg_temp.sub_as(p_name text, p_actor text, p_game uuid, p_platform text, p_format text, p_region text,
  p_details text default '{}', p_pieces text default '[]') returns text language plpgsql as $$
declare r text := pg_temp.sub(p_actor, p_game, p_platform, p_format, p_region, p_details, p_pieces);
begin
  if r like '{%' and (r::jsonb ->> 'outcome') = 'submitted' then
    insert into ids values (p_name, (r::jsonb ->> 'submission_id')::uuid), (p_name || '-r', (r::jsonb ->> 'release_id')::uuid);
    return 'submitted';
  end if;
  return r;
end $$;
create function pg_temp.mine(p_actor text) returns jsonb language sql as $$
  select nullif(pg_temp.as_user(p_actor, 'select public.my_catalog_submissions()::text'), '')::jsonb
$$;
create function pg_temp.one(p_actor text, p_sub text) returns jsonb language sql as $$
  select nullif(pg_temp.as_user(p_actor, format('select public.get_my_submission(%L)::text', pg_temp.id(p_sub))), '')::jsonb
$$;
create function pg_temp.upd(p_actor text, p_sub text, p_changes text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.update_my_submission(%L, %L)::text', pg_temp.id(p_sub), p_changes))
$$;
create function pg_temp.withdraw(p_actor text, p_sub text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.withdraw_my_submission(%L)::text', pg_temp.id(p_sub)))
$$;

-- A published game and release, and an editor's game that isn't published.
create function pg_temp.game(p_name text, p_title text, p_publish_on text default null) returns uuid language plpgsql as $$
declare v uuid; r uuid;
begin
  v := public.create_game(p_title, 'game', null, null, null, 'unknown', 'Submission tests');
  perform public.verify_game(v, 'Submission tests', (select revision from public.games where id = v));
  insert into ids values (p_name, v);
  if p_publish_on is not null then
    r := public.create_release(v, (select id from public.platforms where slug = p_publish_on), 'rom-cartridge', 'ntsc-uc',
      '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "product_code": "QZS-001"}', 'Submission tests');
    perform public.verify_release(r, 'Submission tests', (select revision from public.releases where id = r));
    perform public.publish_release(r, 'Submission tests', (select revision from public.releases where id = r));
    insert into ids values (p_name || '-pub', r);
  end if;
  return v;
end $$;
grant execute on function pg_temp.game(text, text, text) to authenticated;

-- a1: submitter. b2: another collector. c3: suspended. d4: no handle. e5: catalog
-- editor. f6: the rate limit.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'b2', 'c3', 'd4', 'e5', 'f6']) as s;
update public.profiles set handle = 'sub_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['a1', 'b2', 'c3', 'e5', 'f6']) as s);
update public.profiles set account_status = 'suspended' where id = pg_temp.u('c3');
insert into public.staff_roles (user_id, role) values (pg_temp.u('e5'), 'catalog_editor');

select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('e5'), 'role', 'authenticated')::text, true);
select set_config('role', 'authenticated', true);
select pg_temp.game('g', 'Qzs Lantern Keep', 'snes');
select pg_temp.game('hidden', 'Qzs Hidden Draft');
select set_config('role', 'none', true);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
select ok(pg_temp.sub(null, pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal') like 'error: permission denied%', 'a visitor can''t submit');
select is(pg_temp.sub('d4', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal'), 'error: account not active', 'an account without a handle can''t submit');
select is(pg_temp.sub('c3', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal'), 'error: account not active', 'a suspended account can''t submit');
select ok(not has_table_privilege('anon', 'public.catalog_change_requests', 'select,insert,update,delete'), 'visitors have no access to the review record');
select ok(not has_table_privilege('authenticated', 'public.catalog_change_requests', 'select,insert,update,delete')
          and not has_table_privilege('service_role', 'public.catalog_change_requests', 'select,insert,update,delete'), 'no client reads or writes it: submitters use the functions');
select ok(not has_column_privilege('authenticated', 'public.catalog_change_requests', 'created_pairing', 'select')
          and not has_column_privilege('authenticated', 'public.catalog_change_requests', 'reviewed_by', 'select'), 'so a reused pairing and a reviewer stay hidden');
select ok(not has_table_privilege('authenticated', 'public.releases', 'insert,update,delete')
          and not has_table_privilege('authenticated', 'public.games', 'insert,update,delete')
          and not has_table_privilege('authenticated', 'public.game_platforms', 'insert,update,delete')
          and not has_table_privilege('authenticated', 'public.release_components', 'insert,update,delete'), 'clients still can''t write the catalog');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('submit_release', 'submit_game', 'update_my_submission', 'withdraw_my_submission', 'my_catalog_submissions', 'get_my_submission', 'my_submission_for_release')
             and p.prosecdef and p.proconfig = array['search_path=""']), 7, 'the submission functions are definer functions with an empty search_path');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname in ('begin_submission', 'submission_details', 'set_submitted_pieces', 'submission_snapshot', 'create_submitted_release', 'submission_status', 'lock_open_submission')
             and has_function_privilege('authenticated', p.oid, 'execute')), 0, 'clients can''t call the helpers');

-- ---------------------------------------------------------------------------
-- What a submission may contain
-- ---------------------------------------------------------------------------
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{}', '[]', null, false), 'error: invalid submission', 'a physical release must be confirmed');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'no-such-platform', 'rom-cartridge', 'pal'), 'error: invalid submission', 'the platform must exist');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'cd-rom', 'pal'), 'error: invalid submission', 'the format must be one of the platform''s physical formats');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'xx'), 'error: invalid submission', 'the region must exist');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{"status": "published"}'), 'error: invalid submission', 'a submitter can''t set a status');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{"region_unknown_confirmed": true}'), 'error: invalid submission', 'or confirm an unknown region');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{"media_playability": "download_required"}'), 'error: invalid submission', 'or declare a download-only product');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{"verified_at": "2026-01-01"}'), 'error: invalid submission', 'or verify it');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{"barcode": "12AB"}'), 'error: invalid submission', 'a barcode is digits');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{"release_date": "not a date"}'), 'error: invalid submission', 'a date must be a date');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', format('{"release_date": "%s"}', current_date + 400)), 'error: invalid submission', 'a release date can''t be far in the future');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{"edition_name": {"x": 1}}'), 'error: invalid submission', 'a detail is text or a number');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{}', '[{"kind": "game_media", "label": "Disc 2"}]'), 'error: invalid submission', 'extra discs go in the media count, not the pieces');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{}', '[{"kind": "insert", "label": "Poster", "price": 3}]'), 'error: invalid submission', 'a piece has only a kind, a label and a quantity');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{}', '[{"kind": "insert", "label": "Poster"}, {"kind": "insert", "label": "Poster"}]'), 'error: invalid submission', 'a piece is listed once');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{}', '[]', repeat('n', 1001)), 'error: invalid submission', 'a note is at most 1,000 characters');

-- ---------------------------------------------------------------------------
-- Hidden records stay hidden
-- ---------------------------------------------------------------------------
select is(pg_temp.sub('a1', pg_temp.id('hidden'), 'snes', 'rom-cartridge', 'pal'), 'error: game unavailable', 'an unpublished game can''t be used');
select is(pg_temp.sub('a1', gen_random_uuid(), 'snes', 'rom-cartridge', 'pal'), 'error: game unavailable', 'and reads exactly like one that doesn''t exist');

-- ---------------------------------------------------------------------------
-- Submitting a release of a published game
-- ---------------------------------------------------------------------------
select is(pg_temp.sub_as('a', 'a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal',
  '{"edition_name": " Limited ", "edition_kind": "limited", "product_code": "QZS-002", "barcode": "0451234500017", "release_date": "1994-03-15", "release_date_precision": "year"}',
  '[{"kind": "insert", "label": "Poster"}, {"kind": "map", "label": "World map", "quantity": 2}]'), 'submitted', 'a missing release is submitted');
select is((select row(status, submitted_by = pg_temp.u('a1'), region_unknown_confirmed, media_playability, verified_at is null, edition_name, release_date, release_date_precision)::text
           from public.releases where id = pg_temp.id('a-r')),
          '(unverified,t,f,unknown,t,Limited,1994-01-01,year)', 'it''s unverified, the submitter''s, unconfirmed, and stored to the precision given');
select is((select string_agg(kind || ':' || label || 'x' || quantity, ',' order by label) from public.release_components where release_id = pg_temp.id('a-r')),
          'insert:Posterx1,map:World mapx2', 'its listed pieces are recorded');
select is((select row(request_type, status, submitted_by = pg_temp.u('a1'), created_game, physical_confirmed, details ->> 'title', details -> 'platform' ->> 'slug')::text from public.catalog_change_requests where id = pg_temp.id('a')),
          '(new_release,open,t,f,t,"Qzs Lantern Keep",snes)', 'the review record keeps who submitted what');
select is((select count(*)::int from private.audit_events where actor_id = pg_temp.u('a1') and action = 'catalog_submission_created' and metadata ->> 'request_id' = pg_temp.id('a')::text),
          1, 'and is audited');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{"edition_name": "Limited", "product_code": "QZS-002"}'), 'error: already submitted', 'the same release can''t be submitted twice');
select is(pg_temp.sub('a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'ntsc-uc', '{"edition_name": "Standard", "product_code": "QZS-001"}')::jsonb,
          jsonb_build_object('outcome', 'published_duplicate', 'release_id', pg_temp.id('g-pub')), 'a release that''s already published is pointed to, not submitted');
select is((select count(*)::int from public.catalog_change_requests where submitted_by = pg_temp.u('a1')), 1, 'and that isn''t a submission');
select is(pg_temp.sub_as('unknown', 'a1', pg_temp.id('g'), 'snes', 'rom-cartridge', 'unknown', '{"edition_name": "Unsure"}'), 'submitted', 'a region can be submitted as unknown');
select is((select row(region_code, region_unknown_confirmed)::text from public.releases where id = pg_temp.id('unknown-r')), '(unknown,f)', 'and stays unconfirmed for an editor');

-- ---------------------------------------------------------------------------
-- Submitting a new game
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('a1', 'select public.submit_game(''  '', ''game'', null, ''snes'', ''rom-cartridge'', ''pal'', ''{}'', ''[]'', null, true)::text'), 'error: invalid submission', 'a new game needs a title');
select is(pg_temp.as_user('a1', 'select public.submit_game(''Qzs Old'', ''game'', 1900, ''snes'', ''rom-cartridge'', ''pal'', ''{}'', ''[]'', null, true)::text'), 'error: invalid submission', 'a year must be plausible');
select is(pg_temp.as_user('a1', 'select public.submit_game(''Qzs Broken'', ''game'', null, ''snes'', ''rom-cartridge'', ''pal'', ''{}'', ''[{"kind": "sticker", "label": "x"}]'', null, true)::text'),
          'error: invalid submission', 'a submission that fails partway is refused');
select is((select count(*)::int from public.games where title = 'Qzs Broken'), 0, 'and leaves nothing behind');
create function pg_temp.new_game(p_name text, p_title text, p_kind text, p_year int) returns text language plpgsql as $$
declare r text := pg_temp.as_user('a1', format('select public.submit_game(%L, %L, %s, ''snes'', ''rom-cartridge'', ''pal'', ''{}'', ''[]'', ''A note'', true)::text', p_title, p_kind, coalesce(p_year::text, 'null')));
begin
  if r like '{%' then
    insert into ids values (p_name, (r::jsonb ->> 'submission_id')::uuid), (p_name || '-r', (r::jsonb ->> 'release_id')::uuid), (p_name || '-g', (r::jsonb ->> 'game_id')::uuid);
    return r::jsonb ->> 'outcome';
  end if;
  return r;
end $$;
select is(pg_temp.new_game('ng', 'Qzs Moon Anthology', 'compilation', null), 'submitted', 'a new game is submitted with its first release');
select is((select row(status, submitted_by = pg_temp.u('a1'), slug is null, kind, first_release_precision, verified_at is null)::text from public.games where id = pg_temp.id('ng-g')),
          '(unverified,t,t,compilation,unknown,t)', 'the game is unverified, has no public address, and an unknown year stays unknown');
select is((select row(status, submitted_by = pg_temp.u('a1'))::text from public.game_platforms where game_id = pg_temp.id('ng-g')), '(unverified,t)', 'and so is its platform pairing');
select is(pg_temp.sub_as('ng2', 'a1', pg_temp.id('ng-g'), 'nes', 'rom-cartridge', 'ntsc-j'), 'submitted', 'the submitter can add another release to their pending game');

-- ---------------------------------------------------------------------------
-- Only the submitter, and editors, see it
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('b2', format('select count(*)::text from public.releases where id in (%L, %L)', pg_temp.id('a-r'), pg_temp.id('ng-r'))), '0', 'another user can''t read the releases');
select is(pg_temp.as_user('b2', format('select count(*)::text from public.games where id = %L', pg_temp.id('ng-g'))), '0', 'or the new game');
select is(pg_temp.as_user('b2', format('select count(*)::text from public.release_components where release_id = %L', pg_temp.id('a-r'))), '0', 'or the pieces');
select is(pg_temp.as_user('b2', 'select count(*)::text from public.catalog_change_requests'), 'error: permission denied for table catalog_change_requests', 'or the review record');
select is(pg_temp.as_user(null, format('select count(*)::text from public.releases where id = %L', pg_temp.id('a-r'))), '0', 'and neither can a visitor');
select is(pg_temp.one('b2', 'a'), null, 'another user can''t open the submission');
select is(pg_temp.sub('b2', pg_temp.id('ng-g'), 'snes', 'rom-cartridge', 'ntsc-j'), 'error: game unavailable', 'or submit a release of someone else''s pending game');
select is(pg_temp.as_user('e5', format('select count(*)::text from public.releases where id = %L', pg_temp.id('a-r'))), '1', 'a catalog editor can read it');
select is(pg_temp.as_user('a1', format('select count(*)::text from public.releases where id = %L', pg_temp.id('a-r'))), '1', 'and so can the submitter');
select ok(pg_temp.as_user('a1', 'select public.search_catalog(''Qzs Moon Anthology'')::text') not like '%Moon Anthology%'
          and pg_temp.as_user(null, 'select public.search_catalog(''Qzs Moon Anthology'')::text') not like '%Moon Anthology%', 'search shows published records only, even to the submitter');
select ok(pg_temp.as_user(null, 'select public.search_catalog(''Qzs Lantern'')::text') not like '%Limited%'
          and pg_temp.as_user(null, 'select public.get_release_picker(''qzs-lantern-keep'')::text') not like '%QZS-002%', 'and the release picker shows no submitted release');

-- ---------------------------------------------------------------------------
-- Reading one's own submissions
-- ---------------------------------------------------------------------------
select is(pg_temp.one('a1', 'a') ->> 'status', 'submitted', 'the submitter sees it as submitted');
select is((pg_temp.one('a1', 'a') ->> 'editable')::boolean, true, 'and editable');
select is(jsonb_array_length(pg_temp.mine('a1') -> 'items'), 4, 'their list has each submission');
select is(pg_temp.mine('a1') -> 'allowance' ->> 'used', '4', 'and how many they''ve used today');
select is(pg_temp.as_user('a1', 'select created_pairing::text from public.catalog_change_requests limit 1'), 'error: permission denied for table catalog_change_requests', 'not even their own: a reused pairing can''t be detected');

-- ---------------------------------------------------------------------------
-- A shared platform pairing
-- ---------------------------------------------------------------------------
select is(pg_temp.sub_as('b', 'b2', pg_temp.id('g'), 'nes', 'rom-cartridge', 'ntsc-j'), 'submitted', 'another user submits a release on a new platform for the game');
select is(pg_temp.as_user('a1', format('select count(*)::text from public.game_platforms where game_id = %L and platform_id = (select id from public.platforms where slug = ''nes'')', pg_temp.id('g'))),
          '0', 'that pairing is hidden from the first user');
select is(pg_temp.sub_as('c', 'a1', pg_temp.id('g'), 'nes', 'rom-cartridge', 'pal'), 'submitted', 'who can still submit a release on that platform');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.sub('a1', pg_temp.id('g'), 'nes', 'rom-cartridge', 'ntsc-uc')::jsonb) k),
          array['game_id', 'outcome', 'release_id', 'submission_id'], 'with the same answer as for a pairing that didn''t exist');
select is((select created_pairing::text from public.catalog_change_requests where id = pg_temp.id('c')), 'false', 'the pairing was reused, which only the database knows');
select is(pg_temp.as_user('a1', format('select count(*)::text from public.game_platforms where game_id = %L and platform_id = (select id from public.platforms where slug = ''nes'')', pg_temp.id('g'))),
          '0', 'reading the pairing doesn''t tell the reuser it was there');
select is(pg_temp.as_user('b2', format('select count(*)::text from public.game_platforms where game_id = %L and platform_id = (select id from public.platforms where slug = ''nes'')', pg_temp.id('g'))),
          '0', 'because its maker can''t read it either');
select is(pg_temp.as_user('e5', format('select count(*)::text from public.game_platforms where game_id = %L and platform_id = (select id from public.platforms where slug = ''nes'')', pg_temp.id('g'))),
          '1', 'only catalog editors can');
select is(pg_temp.withdraw('b2', 'b'), 'true', 'the other user withdraws theirs');
select is((select count(*)::int from public.game_platforms where game_id = pg_temp.id('g') and platform_id = (select id from public.platforms where slug = 'nes')), 1,
          'and the shared pairing stays, because the first user''s release uses it');
select is((select count(*)::int from public.releases where id = pg_temp.id('c-r')), 1, 'with that release');

-- ---------------------------------------------------------------------------
-- A copy of a pending release
-- ---------------------------------------------------------------------------
insert into ids values ('copy', private.uuid_v7());
select ok(pg_temp.as_user('a1', format('select public.add_collection_item(%L, %L)::text', pg_temp.id('copy'), pg_temp.id('a-r'))) like '%"created": true%', 'the submitter adds their own copy of the pending release');
select is(pg_temp.as_user('a1', 'select (public.get_my_collection() -> ''items'' -> 0 ->> ''status'')'), 'pending', 'which counts as awaiting review');
insert into ids values ('copy2', private.uuid_v7());
select is(pg_temp.as_user('b2', format('select public.add_collection_item(%L, %L)::text', pg_temp.id('copy2'), pg_temp.id('a-r'))), 'error: release unavailable', 'another user can''t');

-- ---------------------------------------------------------------------------
-- Withdrawing
-- ---------------------------------------------------------------------------
select is(pg_temp.withdraw('b2', 'a'), 'error: submission unavailable', 'another user can''t withdraw it');
select is(pg_temp.withdraw('a1', 'a'), 'error: submission in use', 'a submission with a copy can''t be withdrawn');
select is((select count(*)::int from public.releases where id = pg_temp.id('a-r')), 1, 'and nothing is removed');
select is(pg_temp.one('a1', 'a') -> 'my_copies', '1'::jsonb, 'the submitter sees why');
select pg_temp.as_user('a1', format('select public.remove_collection_item(%L)::text', pg_temp.id('copy')));
select is(pg_temp.withdraw('a1', 'a'), 'true', 'without the copy it can be withdrawn');
select is((select count(*)::int from public.releases where id = pg_temp.id('a-r')) + (select count(*)::int from public.release_components where release_id = pg_temp.id('a-r')), 0, 'its release and pieces are gone');
select is((select count(*)::int from public.games where id = pg_temp.id('g')), 1, 'the published game isn''t touched');
select is(pg_temp.one('a1', 'a') ->> 'status', 'withdrawn', 'the submission says it was withdrawn');
select is(pg_temp.one('a1', 'a') -> 'details' ->> 'edition_name', 'Limited', 'and still shows what was submitted');
select is((select count(*)::int from private.audit_events where actor_id = pg_temp.u('a1') and action = 'catalog_submission_withdrawn'), 1, 'the withdrawal is audited');
select is(pg_temp.withdraw('a1', 'a'), 'error: submission unavailable', 'it can''t be withdrawn twice');
select is(pg_temp.withdraw('a1', 'ng2'), 'true', 'a release on the pending game is withdrawn');
select is((select count(*)::int from public.games where id = pg_temp.id('ng-g')), 1, 'and the game stays, because its first release uses it');
select is(pg_temp.withdraw('a1', 'ng'), 'true', 'then the game''s own submission is withdrawn');
select is((select count(*)::int from public.games where id = pg_temp.id('ng-g')) + (select count(*)::int from public.game_platforms where game_id = pg_temp.id('ng-g')), 0, 'and the game and its pairings go with it');

-- ---------------------------------------------------------------------------
-- Changing a submission
-- ---------------------------------------------------------------------------
select is(pg_temp.upd('a1', 'unknown', '{"region": "pal", "note": "Seen at a fair", "details": {"edition_name": "Unsure", "packaging": "Big box"}, "components": [{"kind": "artwork", "label": "Sticker sheet"}]}'), 'true', 'an unreviewed submission can be changed');
select is((select row(region_code, packaging, (select string_agg(label, ',') from public.release_components where release_id = r.id))::text from public.releases r where id = pg_temp.id('unknown-r')),
          '(pal,"Big box","Sticker sheet")', 'the release follows');
select is((select reason || ' / ' || (details ->> 'packaging') from public.catalog_change_requests where id = pg_temp.id('unknown')), 'Seen at a fair / Big box', 'and so does its history');
select is(pg_temp.upd('a1', 'unknown', '{"platform": "nes"}'), 'error: invalid submission', 'the platform can''t change');
select is(pg_temp.upd('a1', 'unknown', '{"title": "Renamed"}'), 'error: invalid submission', 'a release of an existing game can''t rename it');
select is(pg_temp.upd('a1', 'unknown', '{"note": "Changed", "media_format": "cd-rom"}'), 'error: invalid submission', 'a change that fails partway is refused');
select is((select reason from public.catalog_change_requests where id = pg_temp.id('unknown')), 'Seen at a fair', 'and none of it is applied');
select is(pg_temp.upd('a1', 'c', '{"region": "ntsc-uc"}'), 'error: already submitted', 'a change can''t make two of one''s submissions the same');
select is(pg_temp.upd('b2', 'unknown', '{"note": "Mine now"}'), 'error: submission unavailable', 'another user can''t change it');
-- What M7b's review does: the request and its release move on together.
update public.releases set status = 'under_review' where id = pg_temp.id('c-r');
update public.catalog_change_requests set status = 'in_review' where id = pg_temp.id('c');
select is(pg_temp.upd('a1', 'c', '{"note": "Late"}'), 'error: submission locked', 'once review starts it can''t change');
select is(pg_temp.withdraw('a1', 'c'), 'error: submission locked', 'or be withdrawn');
update public.releases set status = 'rejected' where id = pg_temp.id('c-r');
update public.catalog_change_requests set status = 'rejected' where id = pg_temp.id('c');
select is(pg_temp.one('a1', 'c') ->> 'status', 'rejected', 'a rejected submission says so');
select is(pg_temp.upd('a1', 'c', '{"note": "Again"}'), 'error: submission locked', 'and is read-only');

-- ---------------------------------------------------------------------------
-- The rate limit: 10 in any 24 hours, withdrawn ones included
-- ---------------------------------------------------------------------------
create function pg_temp.burst(p_actor text, p_from int, p_to int) returns int language plpgsql as $$
declare n int := 0;
begin
  for i in p_from..p_to loop
    if pg_temp.sub_as('rl' || i, p_actor, pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', format('{"edition_name": "Run %s"}', i)) = 'submitted' then n := n + 1; end if;
  end loop;
  return n;
end $$;
select is(pg_temp.burst('f6', 1, 10), 10, 'ten submissions in a day are accepted');
select is(pg_temp.sub('f6', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{"edition_name": "Run 11"}'), 'error: submission limit reached', 'the eleventh is refused');
select ok((pg_temp.mine('f6') -> 'allowance' ->> 'next_available_at') is not null, 'and the user is told when they can submit again');
select is(pg_temp.withdraw('f6', 'rl1'), 'true', 'withdrawing one');
select is(pg_temp.sub('f6', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{"edition_name": "Run 11"}'), 'error: submission limit reached', 'doesn''t make room');
select is(pg_temp.upd('f6', 'rl2', '{"note": "Edited"}'), 'true', 'edits aren''t limited');
update public.catalog_change_requests set created_at = now() - interval '25 hours' where id = pg_temp.id('rl1');
select is(pg_temp.sub('f6', pg_temp.id('g'), 'snes', 'rom-cartridge', 'pal', '{"edition_name": "Run 11"}')::jsonb ->> 'outcome', 'submitted', 'a submission older than 24 hours no longer counts');

select is((select status::text from public.catalog_change_requests where id = pg_temp.id('a')), 'withdrawn', 'a withdrawn request stays, as withdrawn');
select is(pg_temp.as_user('f6', format('select public.add_collection_item(%L, %L, ''{}'') ->> ''created''', (select private.uuid_v7()), pg_temp.id('rl2-r'))), 'true',
          'the submitter holds a copy of a pending release');
delete from auth.users where id = pg_temp.u('f6');
select is((select count(*)::int from public.catalog_change_requests where id = pg_temp.id('rl2') and submitted_by is null), 1, 'and the record outlives the submitter''s account');
select is((select row(status, submitted_by is null)::text from public.releases where id = pg_temp.id('rl2-r')), '(unverified,t)', 'its pending release stays unverified, with no submitter');
select is((select count(*)::int from public.collection_items where release_id = pg_temp.id('rl2-r')), 0, 'and the account''s copy went with the account');
select is(pg_temp.as_user('b2', format('select count(*)::text from public.releases where id = %L', pg_temp.id('rl2-r'))), '0', 'the unowned release stays hidden from other users');
select is(pg_temp.as_user('b2', format('select public.add_collection_item(%L, %L, ''{}'')::text', (select private.uuid_v7()), pg_temp.id('rl2-r'))), 'error: release unavailable',
          'who can''t attach a copy to it');
select is(pg_temp.as_user('e5', format('select count(*)::text from public.releases where id = %L', pg_temp.id('rl2-r'))), '1', 'while catalog editors still see it, for review');

select * from finish();
rollback;
