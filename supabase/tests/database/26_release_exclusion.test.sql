-- M7b-2b: excluding releases. Who may, what it preserves, the cascade and its
-- acknowledgement, what blocks it, the publication rules in both directions, the
-- notifications and audit, and what owners of preserved copies may read. Concurrent
-- calls are tested in scripts/db-exclusion-checks.mjs, where sessions really overlap.
begin;
create extension if not exists pgtap with schema extensions;
select plan(89);

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
-- Runs the commit-time checks now, as a commit would, and reports what they raise.
create function pg_temp.commit_check() returns text language plpgsql as $t$
begin
  set constraints all immediate;
  set constraints all deferred;
  return 'ok';
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.preview(p_actor text, p_release text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.get_exclusion_preview(%L)::text', pg_temp.id(p_release)))
$$;
create function pg_temp.token(p_release text) returns text language sql as $$
  select pg_temp.preview('e5', p_release)::jsonb ->> 'token'
$$;
create function pg_temp.exclude(p_actor text, p_release text, p_cascade boolean default true, p_copies boolean default true,
                                p_token text default null, p_code text default 'game_key_card', p_reason text default 'A key card, not a game',
                                p_note text default 'This product holds no game.') returns text language plpgsql as $$
declare r text;
begin
  r := pg_temp.as_user(p_actor, format('select public.exclude_release(%L, %L, %L, %L, %L, %L, %L)::text', pg_temp.id(p_release),
         coalesce(p_token, pg_temp.token(p_release)), p_code, p_reason, p_note, p_cascade, p_copies));
  if r like '{%' then
    insert into ids values ('x-' || p_release, (r::jsonb ->> 'exclusion_id')::uuid) on conflict (name) do update set id = excluded.id;
  end if;
  return r;
end $$;
create function pg_temp.new_id(p text) returns void language sql as $$ insert into ids values (p, private.uuid_v7()) $$;
create function pg_temp.add(p_actor text, p_item text, p_release text, p_details text default '{}') returns text language plpgsql as $$
begin
  perform pg_temp.new_id(p_item);
  return pg_temp.as_user(p_actor, format('select public.add_collection_item(%L, %L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_release), p_details));
end $$;
-- Everything stored about a copy except its preservation status and time.
create function pg_temp.copy_state(p_item text) returns text language sql stable as $$
  select concat_ws(' | ',
    (select (to_jsonb(c) - array['record_status', 'invalidated_at'])::text from public.collection_items c where c.id = pg_temp.id(p_item)),
    (select to_jsonb(p)::text from public.collection_item_private p where p.item_id = pg_temp.id(p_item)),
    (select string_agg(to_jsonb(x)::text, ',' order by x.kind, x.label) from public.collection_item_components x where x.item_id = pg_temp.id(p_item)))
$$;
create function pg_temp.status(p_item text) returns text language sql stable as $$
  select record_status::text from public.collection_items where id = pg_temp.id(p_item)
$$;
create function pg_temp.rel(p text) returns text language sql stable as $$ select status::text from public.releases where id = pg_temp.id(p) $$;
create function pg_temp.game(p text) returns text language sql stable as $$ select status::text from public.games where id = pg_temp.id(p) $$;
create function pg_temp.req(p_release text) returns uuid language sql stable as $$
  select id from public.catalog_change_requests where release_id = pg_temp.id(p_release) order by id desc limit 1
$$;
create function pg_temp.req_version(p_release text) returns integer language sql stable as $$
  select version from public.catalog_change_requests where id = pg_temp.req(p_release)
$$;

-- c1, c2: collectors. c3: a submitter. e5, e6: catalog editors (e6 also collects).
-- a7: an administrator. e9: an editor suspended later.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['c1', 'c2', 'c3', 'e5', 'e6', 'a7', 'e9']) as s;
update public.profiles set handle = 'ex_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['c1', 'c2', 'c3', 'e5', 'e6', 'a7', 'e9']) s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('e5'), 'catalog_editor'), (pg_temp.u('e6'), 'catalog_editor'), (pg_temp.u('a7'), 'admin'), (pg_temp.u('e9'), 'catalog_editor');

-- Catalog, made by e5:
--   g "Exc Copper Coast": us, eu (SNES), nes (its only NES release)
--   h "Exc Lone Star": lone, its only release
--   comp, a compilation's only release, containing t, which has none of its own
--   k "Exc Wide Field": kr, with c3's pending submission kp
create function pg_temp.release(p_name text, p_game text, p_platform text, p_region text, p_pieces text, p_publish boolean default true) returns void language plpgsql as $$
declare r uuid;
begin
  r := public.create_release(pg_temp.id(p_game), (select id from public.platforms where slug = p_platform), 'rom-cartridge', p_region,
    format('{"edition_name": "Standard %s", "edition_kind": "standard", "media_count": 1, "product_code": "EXC-%s"}', p_name, upper(p_name))::jsonb, 'Exclusion tests');
  perform public.set_release_components(r, p_pieces::jsonb, 'Exclusion tests');
  if p_publish then
    perform public.verify_release(r, 'Exclusion tests', (select revision from public.releases where id = r));
    perform public.publish_release(r, 'Exclusion tests', (select revision from public.releases where id = r));
  end if;
  insert into ids values (p_name, r);
end $$;
create function pg_temp.game_of(p_name text, p_title text, p_kind text default 'game') returns void language plpgsql as $$
begin
  insert into ids select p_name, public.create_game(p_title, p_kind::public.game_kind, null, null, null, 'unknown', 'Exclusion tests');
  perform public.verify_game(pg_temp.id(p_name), 'Exclusion tests', (select revision from public.games where id = pg_temp.id(p_name)));
end $$;
grant execute on function pg_temp.release(text, text, text, text, text, boolean) to authenticated;
grant execute on function pg_temp.game_of(text, text, text) to authenticated;
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('e5'), 'role', 'authenticated')::text, true);
select set_config('role', 'authenticated', true);
select pg_temp.game_of('g', 'Exc Copper Coast');
select pg_temp.release('us', 'g', 'snes', 'ntsc-uc', '[{"kind": "insert", "label": "Manual"}, {"kind": "artwork", "label": "Poster"}]');
select pg_temp.release('eu', 'g', 'snes', 'pal', '[{"kind": "insert", "label": "Manual"}]');
select pg_temp.release('nes', 'g', 'nes', 'ntsc-uc', '[]');
select pg_temp.game_of('h', 'Exc Lone Star');
select pg_temp.release('lone', 'h', 'snes', 'ntsc-uc', '[]');
select pg_temp.game_of('comp-g', 'Exc Twin Pack', 'compilation');
select pg_temp.game_of('t', 'Exc Hidden Gem');
select public.set_game_relation(pg_temp.id('comp-g'), pg_temp.id('t'), 'contains', null, null, 'Exclusion tests');
select pg_temp.release('comp', 'comp-g', 'snes', 'ntsc-uc', '[]');
select pg_temp.game_of('k', 'Exc Wide Field');
select pg_temp.release('kr', 'k', 'snes', 'ntsc-uc', '[]');
select pg_temp.release('draft', 'g', 'snes', 'ntsc-j', '[]', false);
select set_config('role', 'none', true);
-- t is cataloged only through the compilation, as an import can leave it.
update public.games set status = 'published', slug = 'exc-hidden-gem' where id = pg_temp.id('t');
select is(pg_temp.commit_check(), 'ok', 'the fixture satisfies the publication rules');

-- c3's submissions: pending (open) on g, pending on k, and one rejected by e6.
create function pg_temp.submit(p_actor text, p_name text, p_game text, p_region text, p_code text) returns void language sql as $$
  insert into ids select p_name, (pg_temp.as_user(p_actor, format('select public.submit_release(%L, ''snes'', ''rom-cartridge'', %L, %L, ''[]'', null, true)::text',
    pg_temp.id(p_game), p_region, json_build_object('product_code', p_code)::text))::jsonb ->> 'release_id')::uuid
$$;
select pg_temp.submit('c3', 'pend', 'g', 'ntsc-j', 'EXC-C3P');
select pg_temp.submit('c3', 'kp', 'k', 'pal', 'EXC-C3K');
select pg_temp.submit('c3', 'rej', 'g', 'pal', 'EXC-C3R');
select pg_temp.as_user('e6', format('select public.start_submission_review(%L, %L, %L)::text', pg_temp.req('rej'), pg_temp.req_version('rej'), 'Checking'));
select pg_temp.as_user('e6', format('select public.reject_submission(%L, %L, %L, %L)::text', pg_temp.req('rej'), pg_temp.req_version('rej'), 'No evidence', 'Please add a photo'));
select pg_temp.submit('e6', 'esub', 'g', 'unknown', 'EXC-E6');

-- Copies: c1 has two of us (one with everything recorded), c2 one; c1 one of eu, lone,
-- nes and comp; c3 one of each of their submissions.
select pg_temp.add('c1', 'a', 'us', '{"completeness": "complete", "box_condition": "good", "acquired_on": "2020-05-01", "purchase_price": "49.99", "currency": "EUR", "notes": "From a fair", "storage_location": "Shelf A", "components": [{"kind": "insert", "label": "Manual", "condition": "good"}, {"kind": "artwork", "label": "Poster", "condition": "fair"}]}');
select pg_temp.add('c1', 'b', 'us', '{"notes": "Second copy"}');
select pg_temp.add('c2', 'c', 'us');
select pg_temp.add('c1', 'd', 'eu');
select pg_temp.add('c1', 'l', 'lone');
select pg_temp.add('c1', 'n', 'nes');
select pg_temp.add('c1', 'cp', 'comp');
select pg_temp.add('c3', 'p', 'pend');
select pg_temp.add('c3', 'r', 'rej');
create temp table before as select name, pg_temp.copy_state(name) as state from ids where name in ('a', 'b', 'c', 'd', 'p', 'r');

-- ---------------------------------------------------------------------------
-- Who may exclude
-- ---------------------------------------------------------------------------
select ok(pg_temp.preview(null, 'us') like 'error: permission denied%', 'a visitor can''t preview an exclusion');
select is(pg_temp.preview('c1', 'us'), 'error: not permitted', 'nor can a collector');
select is(pg_temp.exclude('c1', 'us', p_token => 'x'), 'error: not permitted', 'or exclude');
select is(pg_temp.exclude('a7', 'draft', p_token => 'x'), 'error: preview stale', 'an administrator may, as an editor');
select ok((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc
           where oid in ('public.get_exclusion_preview(uuid)'::regprocedure, 'public.exclude_release(uuid,text,text,text,text,boolean,boolean)'::regprocedure,
                         'public.restore_exclusion(uuid,integer,text)'::regprocedure, 'public.get_exclusions(text,uuid,integer)'::regprocedure,
                         'public.get_exclusion(uuid)'::regprocedure, 'public.get_my_preserved_release(uuid)'::regprocedure,
                         'public.get_my_preserved_titles(uuid[])'::regprocedure)),
          'every new function runs as its owner with an empty search path');
select ok(not exists (
  select 1 from unnest(array['public.get_exclusion_preview(uuid)', 'public.exclude_release(uuid,text,text,text,text,boolean,boolean)',
                             'public.restore_exclusion(uuid,integer,text)', 'public.get_exclusions(text,uuid,integer)', 'public.get_exclusion(uuid)',
                             'public.get_my_preserved_release(uuid)', 'public.get_my_preserved_titles(uuid[])']) f
  where has_function_privilege('anon', f, 'execute') or has_function_privilege('service_role', f, 'execute')), 'and only signed-in users may call them');
select ok(not has_table_privilege('authenticated', 'private.catalog_exclusions', 'select')
          and not has_table_privilege('authenticated', 'private.catalog_exclusion_copies', 'select'), 'clients can''t read exclusion records');

-- ---------------------------------------------------------------------------
-- The preview, and what the call requires
-- ---------------------------------------------------------------------------
create temp table p_us as select pg_temp.preview('e5', 'us')::jsonb as p;
grant select on p_us to authenticated;
select is((select row(p ->> 'copies', p ->> 'owners', p -> 'cascade', p -> 'blocking', p ->> 'own_submission', p -> 'release' -> 'game' ->> 'title')::text from p_us),
          '(3,2,[],[],false,"Exc Copper Coast")', 'the preview counts copies and owners, with no cascade while another release keeps the game and pairing');
select is(pg_temp.exclude('e5', 'us', p_code => 'digital'), 'error: invalid exclusion', 'the reason must be one of the fixed codes');
select is(pg_temp.exclude('e5', 'us', p_reason => ' '), 'error: reason required', 'a staff reason is required');
select is(pg_temp.exclude('e5', 'us', p_note => repeat('x', 1001)), 'error: invalid exclusion', 'an owner note is at most 1,000 characters');
select is(pg_temp.exclude('e5', 'us', p_token => md5('old')), 'error: preview stale', 'a stale preview is refused');
select is(pg_temp.exclude('e5', 'us', p_copies => false), 'error: acknowledgement required', 'affecting copies must be acknowledged');
select is(pg_temp.rel('us'), 'published', 'and nothing changes until it is');
update public.releases set local_title = 'Changed' where id = pg_temp.id('us');
select is(pg_temp.exclude('e5', 'us', p_token => (select p ->> 'token' from p_us)), 'error: preview stale', 'a change to the release since the preview is refused');
update public.releases set local_title = null where id = pg_temp.id('us');

-- ---------------------------------------------------------------------------
-- Excluding a published release
-- ---------------------------------------------------------------------------
select is((pg_temp.exclude('e5', 'us')::jsonb - 'exclusion_id')::text, '{"copies": 3, "owners": 2}', 'an editor excludes the release, preserving 3 copies of 2 owners');
select is(pg_temp.rel('us'), 'excluded', 'it''s excluded');
select is((select string_agg(pg_temp.status(n), ',' order by n) from unnest(array['a', 'b', 'c']) n), 'invalid_preserved,invalid_preserved,invalid_preserved', 'its copies are preserved');
select ok((select bool_and(c.invalidated_at = e.excluded_at) from public.collection_items c, private.catalog_exclusions e
           where c.id in (pg_temp.id('a'), pg_temp.id('b'), pg_temp.id('c')) and e.id = pg_temp.id('x-us')), 'at the exclusion''s time');
select is((select count(*) from before b where b.name in ('a', 'b', 'c') and b.state = pg_temp.copy_state(b.name)), 3::bigint,
          'every other field, private detail and piece record is unchanged, updated_at included');
select is(pg_temp.status('d') || ' ' || ((select state from before where name = 'd') = pg_temp.copy_state('d'))::text, 'active true', 'a copy of another release is untouched');
select is((select count(*) from private.catalog_exclusion_copies where exclusion_id = pg_temp.id('x-us')), 3::bigint, 'the exclusion records exactly the copies it preserved');
select is((select row(copies_preserved, owners_affected, previous_status, reason_code, owner_note, excluded_by = pg_temp.u('e5'))::text from private.catalog_exclusions where id = pg_temp.id('x-us')),
          '(3,2,published,game_key_card,"This product holds no game.",t)', 'with the previous status and both reasons');
select is((select string_agg(format('%s:%s:%s', right(recipient_id::text, 2), data ->> 'status', data ->> 'copies'), ',' order by recipient_id)
           from public.notifications where data ->> 'exclusion_id' = pg_temp.id('x-us')::text and type = 'catalog_exclusion'),
          'c1:excluded:2,c2:excluded:1', 'each owner is notified once, with their number of copies');
select ok((select bool_and(actor_id is null and data - array['status', 'exclusion_id', 'copies'] = '{}'::jsonb) from public.notifications where data ->> 'exclusion_id' = pg_temp.id('x-us')::text),
          'never naming who excluded it');
select throws_ok(format($q$insert into public.notifications (recipient_id, type, data) values (%L, 'catalog_exclusion', %L)$q$,
                        pg_temp.u('c1'), json_build_object('status', 'excluded', 'exclusion_id', pg_temp.id('x-us'), 'copies', 2)),
                 '23505', null, 'and a second notice of the same event can''t be stored');
select is((select row(actor_id = pg_temp.u('e5'), target_profile_id is null, metadata ->> 'exclusion_id' = pg_temp.id('x-us')::text, metadata ->> 'copies', reason)::text
           from private.audit_events where action = 'catalog_release_excluded' and metadata ->> 'id' = pg_temp.id('us')::text),
          '(t,t,t,3,"A key card, not a game")', 'the audit row has the editor, the staff reason and counts, and no owner');
select is(pg_temp.commit_check(), 'ok', 'the publication rules hold');
select is(pg_temp.preview('e5', 'us'), 'error: release unavailable', 'an excluded release can''t be excluded again');
select is(pg_temp.add('c2', 'z1', 'us'), 'error: release unavailable', 'no copy can be added to it');
select is(pg_temp.as_user('c1', format('select public.relink_my_copy(%L, %L)::text', pg_temp.id('d'), pg_temp.id('us'))), 'error: release unavailable', 'or moved to it');
select is(pg_temp.as_user('c1', format('select public.update_collection_item(%L, ''{"notes": "Edited"}'')::text', pg_temp.id('a'))), 'error: item preserved',
          'a preserved copy stays read-only, private notes included (D9)');
select is((select count(*) from public.releases where id = pg_temp.id('us')), 1::bigint, 'and nothing is deleted');

-- ---------------------------------------------------------------------------
-- Cascades
-- ---------------------------------------------------------------------------
select is((select string_agg(e ->> 'entity' || ':' || (e ->> 'platform'), ',') from jsonb_array_elements(pg_temp.preview('e5', 'nes')::jsonb -> 'cascade') e),
          'pairing:Nintendo Entertainment System', 'excluding the last NES release takes the NES pairing, not the game');
select is(pg_temp.exclude('e5', 'nes', p_cascade => false), 'error: acknowledgement required', 'which must be acknowledged');
select is(pg_temp.exclude('e5', 'nes')::jsonb ->> 'copies', '1', 'then it''s excluded');
select is((select status::text from public.game_platforms where game_id = pg_temp.id('g') and platform_id = (select id from public.platforms where slug = 'nes')) || ' ' || pg_temp.game('g'),
          'excluded published', 'with the pairing; the game keeps its other releases');
select is((select string_agg(e ->> 'entity', ',' order by e ->> 'entity') from jsonb_array_elements(pg_temp.preview('e5', 'lone')::jsonb -> 'cascade') e),
          'game,pairing', 'excluding a game''s last release takes the game and its pairing');
select is(pg_temp.exclude('e5', 'lone')::jsonb ->> 'copies', '1', 'acknowledged, it''s excluded');
select is(pg_temp.game('h'), 'excluded', 'and the game with it');
select is(pg_temp.as_user('c1', format('select count(*)::text from public.games where id = %L', pg_temp.id('h'))), '0', 'which collectors can no longer read');
select is((select string_agg(format('%s:%s', e ->> 'entity', coalesce(e ->> 'contained', '-')), ',' order by e ->> 'entity', e ->> 'contained')
           from jsonb_array_elements(pg_temp.preview('e5', 'comp')::jsonb -> 'cascade') e),
          'game:false,game:true,pairing:-', 'a compilation''s last release takes it, its pairing, and the game cataloged only through it');
select is(pg_temp.exclude('e5', 'comp')::jsonb ->> 'copies', '1', 'acknowledged, it''s excluded');
select is(pg_temp.game('comp-g') || ' ' || pg_temp.game('t'), 'excluded excluded', 'with both games');
select is(pg_temp.commit_check(), 'ok', 'and the publication rules hold');

-- ---------------------------------------------------------------------------
-- What blocks an exclusion
-- ---------------------------------------------------------------------------
select is((select string_agg(b ->> 'kind', ',') from jsonb_array_elements(pg_temp.preview('e5', 'kr')::jsonb -> 'blocking') b),
          'submission', 'excluding a game''s last release is blocked while a submission of that game would be stranded');
select is(pg_temp.exclude('e5', 'kr'), 'error: exclusion blocked', 'and refused');
select is(pg_temp.rel('kr') || ' ' || pg_temp.game('k'), 'published published', 'leaving both as they were');
select pg_temp.as_user('e5', format('select public.create_release(%L, %L, ''rom-cartridge'', ''ntsc-j'', ''{"edition_name": "Dup", "edition_kind": "standard", "media_count": 1}'', ''Exclusion tests'')::text',
  pg_temp.id('g'), (select id from public.platforms where slug = 'snes')));
update public.releases set status = 'merged', merged_into_id = pg_temp.id('eu') where game_id = pg_temp.id('g') and edition_name = 'Dup';
select ok((select bool_or(b ->> 'kind' = 'merged_release') from jsonb_array_elements(pg_temp.preview('e5', 'eu')::jsonb -> 'blocking') b),
          'a release others were merged into can''t be excluded (D10)');
select is(pg_temp.exclude('e5', 'eu'), 'error: exclusion blocked', 'and is refused');
select is(pg_temp.preview('e6', 'esub')::jsonb ->> 'own_submission', 'true', 'an editor''s own submission is flagged');
select is(pg_temp.exclude('e6', 'esub'), 'error: own submission', 'and they can''t exclude it');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('e9');
select is(pg_temp.exclude('e9', 'pend', p_token => 'x'), 'error: not permitted', 'a suspended editor can''t exclude');

-- ---------------------------------------------------------------------------
-- Excluding submissions
-- ---------------------------------------------------------------------------
create temp table req_pend as select * from public.catalog_change_requests where id = pg_temp.req('pend');
select is(pg_temp.exclude('e5', 'pend', p_code => 'download_code')::jsonb ->> 'copies', '1', 'an open submission can be excluded');
select is((select row(r.status, s.status, s.reviewer_note, s.reviewed_by = pg_temp.u('e5'))::text
           from public.releases r join public.catalog_change_requests s on s.release_id = r.id where r.id = pg_temp.id('pend') and s.id = (select id from req_pend)),
          '(excluded,excluded,"This product holds no game.",t)', 'closing its request with the owner note');
select is((select previous_request ->> 'status' from private.catalog_exclusions where id = pg_temp.id('x-pend')), 'open', 'and recording the request as it was');
select is((select string_agg(type || ':' || (data ->> 'status'), ',') from public.notifications where recipient_id = pg_temp.u('c3') and data ->> 'exclusion_id' = pg_temp.id('x-pend')::text),
          'catalog_submission:excluded', 'the submitter is told once, by their submission, though they own the copy');
select is(pg_temp.as_user('c3', format('select public.resubmit_my_submission(%L, null)::text', (select id from req_pend))), 'error: submission unavailable', 'an excluded submission can''t be resubmitted');
select is(pg_temp.as_user('c3', format('select public.withdraw_my_submission(%L)::text', (select id from req_pend))), 'error: submission locked', 'or withdrawn');
select is(pg_temp.as_user('c3', format('select public.get_my_submission(%L) ->> ''status''', (select id from req_pend))), 'excluded', 'and its submitter sees it''s excluded');
select is(pg_temp.exclude('e5', 'rej')::jsonb ->> 'copies', '1', 'a rejected submission can be excluded');
select is((select status::text from public.catalog_change_requests where id = pg_temp.req('rej')) || ' ' || pg_temp.status('r'), 'excluded invalid_preserved',
          'closing it for good and preserving its copy');
select is((select previous_request ->> 'reviewer_note' from private.catalog_exclusions where id = pg_temp.id('x-rej')), 'Please add a photo', 'the earlier reviewer note is recorded');
select is((select count(*) from before b where b.name in ('p', 'r') and b.state = pg_temp.copy_state(b.name)), 2::bigint, 'the submitter''s copies are unchanged');

-- A new game submitted with its first release.
insert into ids select 'ng', (pg_temp.as_user('c3', 'select public.submit_game(''Exc New Moon'', ''game'', null, ''snes'', ''rom-cartridge'', ''pal'', ''{}'', ''[]'', ''A note'', true)::text')::jsonb ->> 'release_id')::uuid;
insert into ids select 'ng-g', game_id from public.releases where id = pg_temp.id('ng');
select is((select string_agg(e ->> 'entity' || ':' || (e ->> 'previous_status'), ',') from jsonb_array_elements(pg_temp.preview('e5', 'ng')::jsonb -> 'cascade') e),
          'game:unverified', 'excluding a new game''s only submission takes the game it made');
select is(pg_temp.exclude('e5', 'ng')::jsonb ->> 'copies', '0', 'which is excluded');
select is(pg_temp.game('ng-g'), 'excluded', 'with its game');
select is(pg_temp.commit_check(), 'ok', 'and the publication rules hold');

-- ---------------------------------------------------------------------------
-- Publication rules, both directions (D2)
-- ---------------------------------------------------------------------------
savepoint rules;
update public.game_platforms set status = 'excluded' where game_id = pg_temp.id('g') and platform_id = (select id from public.platforms where slug = 'snes');
select is(pg_temp.commit_check(), 'error: a release can be published only with its game and platform', 'a pairing can''t leave publication under a published release');
rollback to savepoint rules;
update public.games set status = 'excluded' where id = pg_temp.id('k');
select is(pg_temp.commit_check(), 'error: a release can be published only with its game and platform', 'nor a game');
rollback to savepoint rules;
update public.games set status = 'published', slug = 'exc-hidden-gem-2' where id = pg_temp.id('t');
select is(pg_temp.commit_check(), 'error: a game is published only with a published physical release', 'a contained game can''t stay published once its compilation''s releases are gone');
rollback to savepoint rules;
update public.releases set status = 'excluded' where id = pg_temp.id('kr');
select is(pg_temp.commit_check(), 'error: a platform is published for a game only with a published release on it', 'and excluding a last release without its cascade fails at commit');
rollback to savepoint rules;

-- ---------------------------------------------------------------------------
-- What owners of preserved copies may read (D3)
-- ---------------------------------------------------------------------------
create temp table mine as select pg_temp.as_user('c1', format('select public.get_my_preserved_release(%L)::text', pg_temp.id('a')))::jsonb as v;
grant select on mine to authenticated;
select is((select row(v -> 'game' ->> 'title', v -> 'game' ->> 'slug', v -> 'release' -> 'platform' ->> 'slug', v -> 'release' -> 'identifiers' ->> 'product_code',
                      v -> 'exclusion' ->> 'reason_code', v -> 'exclusion' ->> 'note', jsonb_array_length(v -> 'components'))::text from mine),
          '("Exc Copper Coast",exc-copper-coast,snes,EXC-US,game_key_card,"This product holds no game.",2)',
          'the owner reads the release, its game, platform and pieces, and why it was excluded');
select is((select string_agg(k, ',' order by k) from mine, jsonb_object_keys(v) k) || ' | ' || (select string_agg(k, ',' order by k) from mine, jsonb_object_keys(v -> 'release') k)
          || ' | ' || (select string_agg(k, ',' order by k) from mine, jsonb_object_keys(v -> 'exclusion') k),
          'components,exclusion,game,release | edition_name,format,id,identifiers,local_title,media_count,packaging,platform,region,variant_name | excluded_at,note,reason_code',
          'and only the approved fields: no submitter, verifier, staff, evidence or staff reason');
select is(pg_temp.as_user('c2', format('select coalesce(public.get_my_preserved_release(%L)::text, ''none'')', pg_temp.id('a'))), 'none', 'another owner of the same release can''t read through someone else''s copy');
select is(pg_temp.as_user('e5', format('select coalesce(public.get_my_preserved_release(%L)::text, ''none'')', pg_temp.id('a'))), 'none', 'nor can an editor, through this function');
select is(pg_temp.as_user('c1', format('select coalesce(public.get_my_preserved_release(%L)::text, ''none'')', pg_temp.id('d'))), 'none', 'an active copy has nothing to read here');
select is(pg_temp.as_user('c1', format('select coalesce(public.get_my_preserved_release(%L)::text, ''none'')', private.uuid_v7())), 'none', 'nor does a copy that doesn''t exist');
select ok(pg_temp.as_user(null, format('select public.get_my_preserved_release(%L)::text', pg_temp.id('a'))) like 'error: permission denied%', 'nor a visitor');
select is(pg_temp.as_user('c1', format('select count(*)::text from public.releases where id = %L', pg_temp.id('us'))), '0', 'catalog RLS is unchanged: the owner still can''t read the release row');
select is(pg_temp.as_user('c1', format('select public.get_my_preserved_titles(array[%L, %L, %L]::uuid[])::text', pg_temp.id('a'), pg_temp.id('c'), pg_temp.id('d')))::jsonb ?| array[pg_temp.id('c')::text, pg_temp.id('d')::text],
          false, 'listing titles returns the caller''s preserved copies only');
select is(pg_temp.as_user('c1', format('select public.get_my_preserved_titles(array[%L]::uuid[]) -> %L ->> ''title''', pg_temp.id('a'), pg_temp.id('a'))), 'Exc Copper Coast', 'with their titles');
select is(pg_temp.as_user('c1', 'select public.get_my_preserved_titles(array_fill(gen_random_uuid(), array[101]))::text'), 'error: too many items', 'at most 100 at a time');
select is(pg_temp.as_user('c1', format('select public.relink_my_copy(%L, %L) ->> ''record_status''', pg_temp.id('a'), pg_temp.id('eu'))), 'active', 'the owner relinks the copy');
select is(pg_temp.as_user('c1', format('select coalesce(public.get_my_preserved_release(%L)::text, ''none'')', pg_temp.id('a'))), 'none', 'and can no longer read the excluded release through it');
select is(pg_temp.as_user('c1', format('select public.remove_collection_item(%L)::text', pg_temp.id('b'))), 'true', 'the owner removes another preserved copy');
select is(pg_temp.as_user('c1', format('select coalesce(public.get_my_preserved_release(%L)::text, ''none'')', pg_temp.id('b'))), 'none', 'which reads like nothing too');
select is((select count(*) from private.catalog_exclusion_copies where item_id = pg_temp.id('b')), 0::bigint, 'and leaves no record behind');

select * from finish();
rollback;
