-- PROPOSAL (M12c-B1, B1-M1): independently verified pairings and identity-only publication.
-- Invariants I1 to I8 of the B1-M1 migration. Runs in one rolled-back transaction, with the
-- staff session harness of 16_catalog.test.sql.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

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
grant execute on function pg_temp.as_user(text, text) to authenticated, anon;

insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['e1', 'e2', 'c3']) as s;
update public.profiles set handle = 'b1_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['e1', 'e2', 'c3']) as s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('e2'), 'catalog_editor');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated, anon;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
grant execute on function pg_temp.id(text) to authenticated, anon;
insert into ids values ('snes', (select id from public.platforms where slug = 'snes'));

-- Editor e1 creates the game and its SNES pairing; e2 is the independent reviewer.
insert into ids values ('g', pg_temp.as_user('e1', $$select public.create_game('Zqx Identity Quest', 'game', null, null, '1993-05-05', 'day', 'B1 test')::text$$)::uuid);
select is(pg_temp.as_user('e1', format($$select public.set_game_platform(%L, %L, 'B1 test')::text$$, pg_temp.id('g'), pg_temp.id('snes'))), 'true', 'the creator pairs it with the SNES');
select is((select creator_id from private.catalog_pairing_origins where game_id = pg_temp.id('g')), pg_temp.u('e1'), 'the pairing''s creator is recorded');

create function pg_temp.basis() returns text language sql as $$
  select '{"source": "wikidata", "reference": "Q999001", "physical_eligibility": "confirmed"}' $$;
grant execute on function pg_temp.basis() to authenticated;
create function pg_temp.verify_pair(p_actor text, p_basis text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.verify_game_platform(%L, %L, %L::jsonb, 'Checked the source', %s)::text$q$,
    pg_temp.id('g'), pg_temp.id('snes'), p_basis, (select revision from public.games where id = pg_temp.id('g')))) $$;
create function pg_temp.publish(p_actor text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.publish_game_identity(%L, array[%L]::uuid[], 'Identity reviewed', %s)::text$q$,
    pg_temp.id('g'), pg_temp.id('snes'), (select revision from public.games where id = pg_temp.id('g')))) $$;

-- I4, I3, I5: verifying the pairing.
select is(pg_temp.verify_pair('e1', pg_temp.basis()), 'error: own record', 'the creator can''t verify the pairing (I4)');
select is(pg_temp.verify_pair('e2', '{"source": "wikidata", "reference": "Q999001"}'), 'error: invalid changes', 'provenance must confirm physical eligibility (I3)');
select is(pg_temp.verify_pair('e2', '{"source": "wikidata", "reference": "Q999001", "physical_eligibility": "assumed"}'), 'error: invalid changes', 'and nothing else counts as confirmation');
select is(pg_temp.as_user('e2', format($q$select public.verify_game_platform(%L, %L, %L::jsonb, 'Checked', 0)::text$q$, pg_temp.id('g'), pg_temp.id('snes'), pg_temp.basis())),
  'error: record changed', 'a stale game revision is refused (I5)');
select is(pg_temp.verify_pair('e2', pg_temp.basis()), 'true', 'an independent editor verifies it');
select ok((select verified_by = pg_temp.u('e2') and verified_game_revision = (select revision from public.games where id = pg_temp.id('g'))
           and verification_basis ->> 'physical_eligibility' = 'confirmed'
           from public.game_platforms where game_id = pg_temp.id('g')), 'the verification records who, the game revision and the provenance');

-- Publishing needs the game verified at its current revision, by someone else.
select is(pg_temp.publish('e2'), 'error: game not verified', 'the game must be verified first (I5)');
select is(pg_temp.as_user('e2', format($q$select public.verify_game(%L, 'Title and date checked', %s)::text$q$, pg_temp.id('g'),
  (select revision from public.games where id = pg_temp.id('g')))), 'true', 'e2 verifies the game');
select is(pg_temp.publish('e1'), 'error: own record', 'the creator can''t publish the identity (I4)');

-- An edit after the pairing's verification makes it stale (I5).
select is(pg_temp.as_user('e1', format($q$select public.update_game(%L, '{"summary": "Edited"}'::jsonb, 'Summary')::text$q$, pg_temp.id('g'))), 'true', 'the creator edits the game');
select is(pg_temp.as_user('e2', format($q$select public.verify_game(%L, 'Re-checked', %s)::text$q$, pg_temp.id('g'),
  (select revision from public.games where id = pg_temp.id('g')))), 'true', 'e2 verifies the edited game');
select is(pg_temp.publish('e2'), 'error: pairing not verified', 'the pairing''s verification of the earlier revision no longer counts');
select is(pg_temp.verify_pair('e2', pg_temp.basis()), 'true', 'e2 verifies the pairing again');
select is(pg_temp.publish('e2'), 'true', 'and publishes the identity');
select ok((select g.status = 'published' and g.slug is not null and gp.status = 'published'
           from public.games g join public.game_platforms gp on gp.game_id = g.id where g.id = pg_temp.id('g')),
  'the game and its pairing are published');
select is((select count(*)::integer from public.releases where game_id = pg_temp.id('g')), 0, 'with no release created (I7)');

-- I8: what collectors read.
select ok(pg_temp.as_user(null, $$select public.search_catalog('Zqx Identity Quest', null, 10, null)::text$$) like '%"release_count": 0%',
  'search lists it, with no verified physical release');
select ok(pg_temp.as_user(null, format($q$select (public.get_release_picker(%L, 'snes', null, null) -> 'releases')::text$q$,
  (select slug from public.games where id = pg_temp.id('g')))) = '[]', 'its page has the platform and no releases');
select ok(private.can_claim(pg_temp.id('g'), pg_temp.id('snes')), 'a collector can record an unidentified copy of it');
select is(pg_temp.as_user(null, $$select verification_basis::text from public.game_platforms limit 1$$),
  'error: permission denied for table game_platforms', 'nobody reads who verified a pairing, or its provenance');

-- I1, I2: the invariants still refuse a game or pairing published without a release or a
-- verified pairing.
insert into public.games (id, title, sort_title, kind, status) values ('00000000-0000-4000-8000-0000000b1001', 'Zqx Bare Title', 'Zqx Bare Title', 'game', 'under_review');
insert into public.game_platforms (game_id, platform_id, status) values ('00000000-0000-4000-8000-0000000b1001', pg_temp.id('snes'), 'under_review');
savepoint inv;
select throws_ok($$update public.games set status = 'published', slug = 'zqx-bare-title', verified_at = now() where id = '00000000-0000-4000-8000-0000000b1001'; set constraints all immediate$$,
  '23514', 'a game is published only with a published physical release', 'an unverified identity can''t be published (I2)');
rollback to savepoint inv;
insert into public.game_platforms (game_id, platform_id, status) values (pg_temp.id('g'), (select id from public.platforms where slug = 'nes'), 'under_review');
select throws_ok(format($$update public.game_platforms set status = 'published' where game_id = %L and platform_id = (select id from public.platforms where slug = 'nes'); set constraints all immediate$$, pg_temp.id('g')),
  '23514', 'a platform is published for a game only with a published release on it', 'a published identitys other, unverified pairing stays unpublished (I1)');
rollback to savepoint inv;

-- I6: without a recent second-factor verification, nothing is verified or published.
update auth.mfa_amr_claims set created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' where session_id = pg_temp.u('e2');
create function pg_temp.as_stale(p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.u('e2'), 'role', 'authenticated', 'aal', 'aal2', 'session_id', pg_temp.u('e2'))::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
select ok(pg_temp.as_stale(format($q$select public.verify_game_platform(%L, %L, %L::jsonb, 'Checked', %s)::text$q$, '00000000-0000-4000-8000-0000000b1001',
  pg_temp.id('snes'), pg_temp.basis(), (select revision from public.games where id = '00000000-0000-4000-8000-0000000b1001'))) like 'error:%',
  'verifying a pairing needs a recent verification (I6)');

select * from finish();
rollback;
