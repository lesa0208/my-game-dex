-- M7b-2b: restoring an exclusion. Only another administrator, who submitted none of
-- it; exactly the previous statuses; only the copies that exclusion preserved and that
-- are still on the release and still preserved by it; never over records changed since,
-- or against the publication rules. Concurrent calls are tested in
-- scripts/db-exclusion-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

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
create function pg_temp.token(p_release text) returns text language sql as $$
  select pg_temp.as_user('e5', format('select public.get_exclusion_preview(%L) ->> ''token''', pg_temp.id(p_release)))
$$;
create function pg_temp.exclude(p_actor text, p_release text) returns text language plpgsql as $$
declare r text;
begin
  r := pg_temp.as_user(p_actor, format('select public.exclude_release(%L, %L, ''no_game_data'', ''Holds no game'', ''Out of scope'', true, true)::text',
         pg_temp.id(p_release), pg_temp.token(p_release)));
  if r like '{%' then
    insert into ids values ('x-' || p_release, (r::jsonb ->> 'exclusion_id')::uuid) on conflict (name) do update set id = excluded.id;
  end if;
  return r;
end $$;
create function pg_temp.version(p_release text) returns integer language sql stable as $$
  select version from private.catalog_exclusions where id = pg_temp.id('x-' || p_release)
$$;
create function pg_temp.restore(p_actor text, p_release text, p_version integer default null, p_reason text default 'Excluded by mistake') returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.restore_exclusion(%L, %L, %L)::text', pg_temp.id('x-' || p_release),
    coalesce(p_version, pg_temp.version(p_release)), p_reason))
$$;
create function pg_temp.new_id(p text) returns void language sql as $$ insert into ids values (p, private.uuid_v7()) $$;
create function pg_temp.add(p_actor text, p_item text, p_release text, p_details text default '{}') returns text language plpgsql as $$
begin
  perform pg_temp.new_id(p_item);
  return pg_temp.as_user(p_actor, format('select public.add_collection_item(%L, %L, %L)::text', pg_temp.id(p_item), pg_temp.id(p_release), p_details));
end $$;
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

-- c1, c2: collectors. c3: a submitter. e5, e6: catalog editors. a7, a8: administrators
-- (a8 also submits).
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['c1', 'c2', 'c3', 'e5', 'e6', 'a7', 'a8']) as s;
update public.profiles set handle = 'rs_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['c1', 'c2', 'c3', 'e5', 'e6', 'a7', 'a8']) s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('e5'), 'catalog_editor'), (pg_temp.u('e6'), 'catalog_editor'), (pg_temp.u('a7'), 'admin'), (pg_temp.u('a8'), 'admin');

create function pg_temp.release(p_name text, p_game text, p_platform text, p_region text, p_pieces text) returns void language plpgsql as $$
declare r uuid;
begin
  r := public.create_release(pg_temp.id(p_game), (select id from public.platforms where slug = p_platform), 'rom-cartridge', p_region,
    format('{"edition_name": "Standard %s", "edition_kind": "standard", "media_count": 1, "product_code": "RST-%s"}', p_name, upper(p_name))::jsonb, 'Restore tests');
  perform public.set_release_components(r, p_pieces::jsonb, 'Restore tests');
  perform public.verify_release(r, 'Restore tests', (select revision from public.releases where id = r));
  perform public.publish_release(r, 'Restore tests', (select revision from public.releases where id = r));
  insert into ids values (p_name, r);
end $$;
create function pg_temp.game_of(p_name text, p_title text) returns void language plpgsql as $$
begin
  insert into ids select p_name, public.create_game(p_title, 'game', null, null, null, 'unknown', 'Restore tests');
  perform public.verify_game(pg_temp.id(p_name), 'Restore tests', (select revision from public.games where id = pg_temp.id(p_name)));
end $$;
grant execute on function pg_temp.release(text, text, text, text, text) to authenticated;
grant execute on function pg_temp.game_of(text, text) to authenticated;
-- g "Rst Copper Coast": us, eu (SNES), nes. k "Rst Wide Field": k1, k2 (SNES). h: lone.
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('e5'), 'role', 'authenticated')::text, true);
select set_config('role', 'authenticated', true);
select pg_temp.game_of('g', 'Rst Copper Coast');
select pg_temp.release('us', 'g', 'snes', 'ntsc-uc', '[{"kind": "insert", "label": "Manual"}]');
select pg_temp.release('eu', 'g', 'snes', 'pal', '[{"kind": "insert", "label": "Manual"}]');
select pg_temp.release('nes', 'g', 'nes', 'ntsc-uc', '[]');
select pg_temp.game_of('k', 'Rst Wide Field');
select pg_temp.release('k1', 'k', 'snes', 'ntsc-uc', '[]');
select pg_temp.release('k2', 'k', 'snes', 'pal', '[]');
select pg_temp.game_of('h', 'Rst Lone Star');
select pg_temp.release('lone', 'h', 'snes', 'ntsc-uc', '[]');
select set_config('role', 'none', true);

create function pg_temp.submit(p_actor text, p_name text, p_region text, p_code text) returns void language sql as $$
  insert into ids select p_name, (pg_temp.as_user(p_actor, format('select public.submit_release(%L, ''snes'', ''rom-cartridge'', %L, %L, ''[]'', null, true)::text',
    pg_temp.id('g'), p_region, json_build_object('product_code', p_code)::text))::jsonb ->> 'release_id')::uuid
$$;
select pg_temp.submit('c3', 'pend', 'ntsc-j', 'RST-C3P');
select pg_temp.submit('c3', 'rej', 'unknown', 'RST-C3R');
select pg_temp.as_user('e6', format('select public.start_submission_review(%L, %L, %L)::text', pg_temp.req('rej'), pg_temp.req_version('rej'), 'Checking'));
select pg_temp.as_user('e6', format('select public.reject_submission(%L, %L, %L, %L)::text', pg_temp.req('rej'), pg_temp.req_version('rej'), 'No evidence', 'Please add a photo'));
select pg_temp.submit('a8', 'asub', 'ntsc-j', 'RST-A8');

-- Copies on us: a (everything recorded) and b of c1, c of c2. Others elsewhere.
select pg_temp.add('c1', 'a', 'us', '{"completeness": "complete", "notes": "From a fair", "purchase_price": "20", "currency": "EUR", "components": [{"kind": "insert", "label": "Manual", "condition": "good"}]}');
select pg_temp.add('c1', 'b', 'us', '{"notes": "Second", "components": [{"kind": "insert", "label": "Manual", "condition": "fair"}]}');
select pg_temp.add('c2', 'c', 'us');
select pg_temp.add('c1', 'm', 'us');
select pg_temp.add('c3', 'p', 'pend', '{"notes": "Mine"}');
select pg_temp.add('c3', 'r', 'rej');
select pg_temp.add('c1', 'kc', 'k1');
create temp table before as select name, pg_temp.copy_state(name) as state from ids where name in ('a', 'b', 'p');

-- ---------------------------------------------------------------------------
-- An exclusion, then owners act
-- ---------------------------------------------------------------------------
select is(pg_temp.exclude('e5', 'us')::jsonb ->> 'copies', '4', 'an editor excludes a release with 4 copies');
select is(pg_temp.as_user('c1', format('select public.relink_my_copy(%L, %L) ->> ''release_id''', pg_temp.id('a'), pg_temp.id('eu'))), pg_temp.id('eu')::text,
          'one owner then relinks a copy to another release');
select is(pg_temp.as_user('c2', format('select public.remove_collection_item(%L)::text', pg_temp.id('c'))), 'true', 'another removes theirs');
-- m is preserved again later by something else, and q was preserved before this exclusion.
select pg_temp.new_id('q');
set local session_replication_role = replica;
update public.collection_items set invalidated_at = invalidated_at + interval '1 second' where id = pg_temp.id('m');
insert into public.collection_items (id, owner_id, release_id, record_status, invalidated_at) values (pg_temp.id('q'), pg_temp.u('c1'), pg_temp.id('us'), 'invalid_preserved', '2020-01-01');
set local session_replication_role = origin;
create temp table before_a as select pg_temp.copy_state('a') as state;

-- ---------------------------------------------------------------------------
-- Who may restore
-- ---------------------------------------------------------------------------
select ok(pg_temp.restore(null, 'us') like 'error: permission denied%', 'a visitor can''t restore');
select is(pg_temp.restore('c1', 'us'), 'error: not permitted', 'nor a collector');
select is(pg_temp.restore('e5', 'us'), 'error: not permitted', 'nor a catalog editor, though they excluded it');
select is(pg_temp.as_user('e6', 'select public.get_exclusions()::text'), 'error: not permitted', 'editors can''t list exclusions');
select is(pg_temp.exclude('a7', 'lone')::jsonb ->> 'copies', '0', 'an administrator excludes a release');
select is(pg_temp.restore('a7', 'lone'), 'error: own exclusion', 'and can''t restore their own exclusion (D5)');
select is(pg_temp.restore('a8', 'lone')::jsonb ->> 'copies', '0', 'another administrator can');
select is(pg_temp.exclude('e5', 'asub')::jsonb ->> 'copies', '0', 'an editor excludes an administrator''s submission');
select is(pg_temp.restore('a8', 'asub'), 'error: own submission', 'which that administrator can''t restore (D5)');

-- ---------------------------------------------------------------------------
-- What restoring would do, and the call's checks
-- ---------------------------------------------------------------------------
create temp table ex_us as select pg_temp.as_user('a7', format('select public.get_exclusion(%L)::text', pg_temp.id('x-us')))::jsonb as v;
select is((select row(v -> 'copies' ->> 'still_preserved', v -> 'copies' ->> 'moved', v -> 'copies' ->> 'removed', v ->> 'blocker', v ->> 'own_exclusion', v ->> 'staff_reason', v ->> 'version')::text from ex_us),
          '(1,1,1,,false,"Holds no game",1)', 'an administrator sees what restoring would do: one copy still preserved, one moved, one removed');
select is((select string_agg(i -> 'release' ->> 'product_code', ',' order by i ->> 'id') from jsonb_array_elements(pg_temp.as_user('a7', 'select public.get_exclusions(''active'')::text')::jsonb -> 'items') i),
          'RST-US,RST-A8', 'and lists the active exclusions');
select is(pg_temp.restore('a7', 'us', p_version => 7), 'error: request conflict', 'a stale version is refused');
select is(pg_temp.restore('a7', 'us', p_reason => ''), 'error: reason required', 'a reason is required');

-- ---------------------------------------------------------------------------
-- Restoring
-- ---------------------------------------------------------------------------
select is(pg_temp.restore('a7', 'us'), '{"copies": 1}', 'restoring reactivates the one copy still preserved by this exclusion');
select is(pg_temp.rel('us'), 'published', 'the release is published again');
select is(pg_temp.status('b'), 'active', 'its copy is active');
select is((select state from before where name = 'b'), pg_temp.copy_state('b'), 'with every field, private detail and piece record unchanged, updated_at included');
select is((select release_id from public.collection_items where id = pg_temp.id('a')), pg_temp.id('eu'), 'the relinked copy stays where its owner moved it');
select is((select state from before_a), pg_temp.copy_state('a'), 'untouched');
select is((select count(*) from public.collection_items where id = pg_temp.id('c')), 0::bigint, 'the removed copy stays removed');
select is(pg_temp.status('m'), 'invalid_preserved', 'a copy preserved again since isn''t reactivated');
select is(pg_temp.status('q'), 'invalid_preserved', 'nor one this exclusion didn''t preserve');
select is((select string_agg(format('%s:%s', right(recipient_id::text, 2), data ->> 'copies'), ',' order by recipient_id)
           from public.notifications where type = 'catalog_exclusion' and data ->> 'status' = 'restored' and data ->> 'exclusion_id' = pg_temp.id('x-us')::text),
          'c1:1', 'only the owner whose copy came back is notified, once');
select is((select row(restored_by = pg_temp.u('a7'), restore_reason, copies_restored, version)::text from private.catalog_exclusions where id = pg_temp.id('x-us')),
          '(t,"Excluded by mistake",1,2)', 'the exclusion is kept as history, restored');
select is((select count(*) from private.audit_events where action = 'catalog_exclusion_restored' and actor_id = pg_temp.u('a7') and metadata ->> 'exclusion_id' = pg_temp.id('x-us')::text),
          1::bigint, 'with an audit row');
select is(pg_temp.restore('a8', 'us'), 'error: exclusion unavailable', 'it can''t be restored twice');
select is(pg_temp.commit_check(), 'ok', 'the publication rules hold');
select is(pg_temp.exclude('e5', 'us')::jsonb ->> 'copies', '1', 'and the release can be excluded again, as a new event');

-- ---------------------------------------------------------------------------
-- Changed since, and the publication rules
-- ---------------------------------------------------------------------------
select is(pg_temp.exclude('e5', 'nes')::jsonb ->> 'copies', '0', 'excluding the last NES release takes its pairing');
savepoint changed;
update public.game_platforms set status = 'published' where game_id = pg_temp.id('g') and platform_id = (select id from public.platforms where slug = 'nes');
select is(pg_temp.restore('a7', 'nes'), 'error: exclusion changed', 'restoring is refused once a cascaded record changed');
rollback to savepoint changed;
select is(pg_temp.restore('a7', 'nes')::jsonb ->> 'copies', '0', 'otherwise it restores');
select is((select status::text from public.game_platforms where game_id = pg_temp.id('g') and platform_id = (select id from public.platforms where slug = 'nes')),
          'published', 'with the pairing');

select is(pg_temp.exclude('e5', 'k1')::jsonb ->> 'copies', '1', 'one of a game''s two releases is excluded');
select is(pg_temp.exclude('e5', 'k2')::jsonb ->> 'copies', '0', 'then the other');
select is(pg_temp.game('k'), 'excluded', 'with the game');
select is(pg_temp.restore('a7', 'k1'), 'error: restore blocked', 'the first can''t come back while its game is excluded');
select is(pg_temp.rel('k1') || ' ' || pg_temp.status('kc'), 'excluded invalid_preserved', 'and nothing changed');
select is(pg_temp.restore('a7', 'k2')::jsonb ->> 'copies', '0', 'restoring the second brings the game back');
select is(pg_temp.restore('a7', 'k1')::jsonb ->> 'copies', '1', 'then the first restores');
select is(pg_temp.game('k') || ' ' || pg_temp.status('kc'), 'published active', 'with its copy');
select is(pg_temp.commit_check(), 'ok', 'and the publication rules hold');

-- ---------------------------------------------------------------------------
-- Submissions come back as they were
-- ---------------------------------------------------------------------------
create temp table req_before as select status, reviewed_by, reviewed_at, reviewer_note from public.catalog_change_requests where id = pg_temp.req('pend');
select is(pg_temp.exclude('e5', 'pend')::jsonb ->> 'copies', '1', 'an open submission is excluded');
select is(pg_temp.restore('a7', 'pend')::jsonb ->> 'copies', '1', 'and restored');
select is((select row(r.status, s.status, s.reviewed_by, s.reviewed_at, s.reviewer_note)::text from public.releases r join public.catalog_change_requests s on s.release_id = r.id
           where r.id = pg_temp.id('pend') and s.id = pg_temp.req('pend')),
          (select row('unverified'::public.catalog_status, b.status, b.reviewed_by, b.reviewed_at, b.reviewer_note)::text from req_before b),
          'to exactly its previous status, with its request as it was');
select is((select state from before where name = 'p'), pg_temp.copy_state('p'), 'the submitter''s copy is active, unchanged');
select is(pg_temp.status('p'), 'active', 'and counted again');
select is((select string_agg(type || ':' || (data ->> 'status'), ',' order by id) from public.notifications where recipient_id = pg_temp.u('c3') and data ->> 'exclusion_id' = pg_temp.id('x-pend')::text),
          'catalog_submission:excluded,catalog_exclusion:restored', 'the submitter is told of both, once each');
select is(pg_temp.as_user('c3', format('select public.get_my_submission(%L) ->> ''status''', pg_temp.req('pend'))), 'submitted', 'and sees their submission open again');

select is(pg_temp.exclude('e5', 'rej')::jsonb ->> 'copies', '1', 'a rejected submission is excluded');
delete from auth.users where id = pg_temp.u('e6');
select is(pg_temp.restore('a7', 'rej')::jsonb ->> 'copies', '1', 'and restored after its reviewer''s account is deleted');
select is((select row(r.status, s.status, s.reviewed_by is null, s.reviewer_note)::text from public.releases r join public.catalog_change_requests s on s.release_id = r.id
           where r.id = pg_temp.id('rej') and s.id = pg_temp.req('rej')),
          '(rejected,rejected,t,"Please add a photo")', 'rejected again, with its note, and no reviewer that no longer exists');

select * from finish();
rollback;
