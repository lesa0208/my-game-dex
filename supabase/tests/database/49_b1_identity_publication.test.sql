-- PROPOSAL (M12c-B1, B1-M1): independently verified pairings and identity-only publication.
-- Invariants I1 to I8 of the B1-M1 migration. Runs in one rolled-back transaction, with the
-- staff session harness of 16_catalog.test.sql.
begin;
create extension if not exists pgtap with schema extensions;
select plan(59);

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
from unnest(array['e1', 'e2', 'e3', 'c3']) as s;
update public.profiles set handle = 'b1_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['e1', 'e2', 'e3', 'c3']) as s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('e2'), 'catalog_editor'), (pg_temp.u('e3'), 'catalog_editor');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated, anon;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
grant execute on function pg_temp.id(text) to authenticated, anon;
insert into ids values ('snes', (select id from public.platforms where slug = 'snes'));

-- Editor e1 creates the game and its SNES pairing; e2 is the independent reviewer; e3 another editor.
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
select is(pg_temp.publish('e2'), 'error: own record', 'but the editor who confirmed the evidence can''t publish it (M14a)');
select is(pg_temp.publish('e3'), 'true', 'another editor publishes the identity');
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

-- W1 to W9: withdrawing an incorrect pairing without excluding the game. The game gets a second
-- verified, published pairing (NES), and a collector claims it on the SNES.
insert into ids values ('nes', (select id from public.platforms where slug = 'nes'));
create function pg_temp.rev() returns bigint language sql stable as $$ select revision from public.games where id = pg_temp.id('g') $$;
select is(pg_temp.as_user('e1', format($$select public.set_game_platform(%L, %L, 'B1 test')::text$$, pg_temp.id('g'), pg_temp.id('nes'))), 'true', 'the creator pairs it with the NES too');
select is(pg_temp.as_user('e2', format($q$select public.verify_game_platform(%L, %L, %L::jsonb, 'Checked', %s)::text$q$,
  pg_temp.id('g'), pg_temp.id('nes'), pg_temp.basis(), pg_temp.rev())), 'true', 'e2 verifies the NES pairing');
select is(pg_temp.as_user('e3', format($q$select public.publish_game_identity(%L, array[%L]::uuid[], 'NES identity', %s)::text$q$,
  pg_temp.id('g'), pg_temp.id('nes'), pg_temp.rev())), 'true', 'and e3 publishes it');
insert into ids values ('claim', private.uuid_v7());
insert into public.collection_items (id, owner_id, claimed_game_id, claimed_platform_id) values (pg_temp.id('claim'), pg_temp.u('c3'), pg_temp.id('g'), pg_temp.id('snes'));
create temp table claim_before as select md5(to_jsonb(c)::text) as h from public.collection_items c where c.id = pg_temp.id('claim');

create function pg_temp.withdraw(p_actor text, p_platform text, p_reason text, p_revision bigint) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.withdraw_game_platform(%L, %L, %L, %s)::text$q$,
    pg_temp.id('g'), pg_temp.id(p_platform), p_reason, coalesce(p_revision::text, 'null'))) $$;
create function pg_temp.preview(p_platform text) returns jsonb language sql as $$
  select pg_temp.as_user('e3', format($q$select public.get_pairing_withdrawal_preview(%L, %L)::text$q$, pg_temp.id('g'), pg_temp.id(p_platform)))::jsonb $$;

select ok((select p ->> 'can_withdraw' = 'true' and p ->> 'last_platform' = 'false' and p ->> 'claimed_copies' = '1' and p -> 'blocking' = '[]'
           and p ->> 'verified' = 'true' from (select pg_temp.preview('snes') as p) x),
  'the preview: withdrawable, another platform keeps the game, one collector claim that stays');
select is(pg_temp.as_user(null, format($q$select public.withdraw_game_platform(%L, %L, 'x', 1)::text$q$, pg_temp.id('g'), pg_temp.id('snes'))),
  'error: permission denied for function withdraw_game_platform', 'anon can''t withdraw a pairing (W1)');
select is(pg_temp.withdraw('c3', 'snes', 'Wrong platform', pg_temp.rev()), 'error: not permitted', 'nor can a collector (W1)');
select is(pg_temp.withdraw('e3', 'snes', ' ', pg_temp.rev()), 'error: reason required', 'a withdrawal needs a reason (W1)');
select is(pg_temp.withdraw('e3', 'snes', 'Wrong platform', pg_temp.rev() - 1), 'error: record changed', 'a stale game revision is refused (W2)');

-- W1: without a recent second-factor verification, nothing is withdrawn.
create function pg_temp.as_stale_actor(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated', 'aal', 'aal2', 'session_id', pg_temp.u(p_actor))::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
update auth.mfa_amr_claims set created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' where session_id = pg_temp.u('e3');
select is(pg_temp.as_stale_actor('e3', format($q$select public.withdraw_game_platform(%L, %L, 'Wrong platform', %s)::text$q$, pg_temp.id('g'), pg_temp.id('snes'), pg_temp.rev())),
  'error: reauthentication required', 'a withdrawal needs a recent verification (W1)');
update auth.mfa_amr_claims set created_at = now(), updated_at = now() where session_id = pg_temp.u('e3');

-- W3 and W9: a release on the pairing blocks the withdrawal; excluding a release keeps a verified
-- pairing and its game. (Fixtures, rolled back.)
savepoint releases;
insert into public.releases (id, game_id, platform_id, region_code, media_format_code, status)
values ('00000000-0000-4000-8000-0000000b1e01', pg_temp.id('g'), pg_temp.id('nes'), 'pal', 'nes-game-pak', 'under_review');
select ok((select p -> 'blocking' = jsonb_build_array(jsonb_build_object('kind', 'release', 'id', '00000000-0000-4000-8000-0000000b1e01', 'status', 'under_review'))
           and p ->> 'can_withdraw' = 'false' from (select pg_temp.preview('nes') as p) x), 'the preview names the release under review on the pairing');
select is(pg_temp.withdraw('e3', 'nes', 'Wrong platform', pg_temp.rev()), 'error: withdrawal blocked', 'a release under review blocks the withdrawal (W3)');
set local session_replication_role = replica;
update public.releases set status = 'published', verified_at = now(), edition_name = 'Standard', edition_kind = 'standard', media_count = 1
where id = '00000000-0000-4000-8000-0000000b1e01';
set local session_replication_role = origin;
select is(pg_temp.withdraw('e3', 'nes', 'Wrong platform', pg_temp.rev()), 'error: withdrawal blocked', 'and so does a published release (W3)');
select is(private.exclusion_plan('00000000-0000-4000-8000-0000000b1e01') -> 'cascade', '[]'::jsonb,
  'excluding that last release would keep the verified pairing and the game (W9)');
rollback to savepoint releases;

-- The withdrawal.
insert into ids values ('w', (pg_temp.withdraw('e3', 'snes', 'Wrong platform: no SNES release', pg_temp.rev()))::uuid);
select ok(pg_temp.id('w') is not null, 'an editor withdraws the SNES pairing');
select ok((select gp.status = 'excluded' and gp.verified_at is null and gp.verified_by is null and gp.verification_basis is null
           from public.game_platforms gp where gp.game_id = pg_temp.id('g') and gp.platform_id = pg_temp.id('snes')),
  'the pairing is kept, excluded, its verification cleared (W6)');
select ok((select g.status = 'published' and g.revision = w.game_revision + 1
           from public.games g join private.catalog_pairing_withdrawals w on w.game_id = g.id where w.id = pg_temp.id('w')),
  'the game stays published, and its revision moves on (W2)');
select ok((select w.withdrawn_by = pg_temp.u('e3') and w.previous_status = 'published' and w.claimed_copies = 1
           and w.previous_verification ->> 'verified_by' = pg_temp.u('e2')::text
           and w.previous_verification -> 'verification_basis' ->> 'physical_eligibility' = 'confirmed'
           from private.catalog_pairing_withdrawals w where w.id = pg_temp.id('w')),
  'the withdrawal records who, the previous status and the verification it cleared (W6)');
select is((select md5(to_jsonb(c)::text) from public.collection_items c where c.id = pg_temp.id('claim')), (select h from claim_before),
  'the collector''s claim is exactly as it was (W5)');
select ok((select actor_id = pg_temp.u('e3') and reason = 'Wrong platform: no SNES release' and metadata ->> 'withdrawal_id' = pg_temp.id('w')::text
           and metadata ->> 'previous_status' = 'published'
           from private.audit_events where action = 'catalog_pairing_withdrawn'), 'an audit event names the editor, the reason and the withdrawal (W6)');
select is((select string_agg(e ->> 'slug', ',') from jsonb_array_elements(private.catalog_game_platforms_json(pg_temp.id('g'))) e), 'nes',
  'collectors see only the NES now');
select is(pg_temp.as_user('e1', format($$select public.set_game_platform(%L, %L, 'again')::text$$, pg_temp.id('g'), pg_temp.id('snes'))), 'false',
  'pairing it again doesn''t bring it back (W7)');
select is(pg_temp.as_user('e2', format($q$select public.verify_game_platform(%L, %L, %L::jsonb, 'Checked', %s)::text$q$,
  pg_temp.id('g'), pg_temp.id('snes'), pg_temp.basis(), pg_temp.rev())), 'error: record unavailable', 'nor does verifying it (W7)');
select throws_ok(format($$update private.catalog_pairing_withdrawals set reason = 'rewritten' where id = %L$$, pg_temp.id('w')),
  '23514', 'a withdrawal is kept as recorded', 'a withdrawal can''t be rewritten (W6)');
select throws_ok(format($$delete from private.catalog_pairing_withdrawals where id = %L$$, pg_temp.id('w')),
  '23514', 'withdrawals are kept', 'nor deleted (W6)');

-- W4: the last listed platform of a published game isn't a pairing decision.
select ok((select p ->> 'last_platform' = 'true' and p ->> 'can_withdraw' = 'false' from (select pg_temp.preview('nes') as p) x),
  'the preview says the NES is now the game''s last platform');
select is(pg_temp.withdraw('e2', 'nes', 'Wrong platform', pg_temp.rev()), 'error: last platform', 'so withdrawing it is refused (W4)');

-- W7: restoration by a different editor, back to review only.
create function pg_temp.restore(p_actor text, p_revision bigint) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.restore_game_platform(%L, 'Withdrawn in error', %s)::text$q$, pg_temp.id('w'), p_revision)) $$;
select is(pg_temp.restore('e3', pg_temp.rev()), 'error: own record', 'the editor who withdrew it can''t restore it (W7)');
select is(pg_temp.restore('e2', pg_temp.rev() - 1), 'error: record changed', 'a stale revision is refused');
select is(pg_temp.restore('e2', pg_temp.rev()), 'true', 'a different editor restores it');
select ok((select gp.status = 'under_review' and gp.verified_at is null from public.game_platforms gp
           where gp.game_id = pg_temp.id('g') and gp.platform_id = pg_temp.id('snes')), 'back to review, unverified: not published (W7)');
select ok((select restored_by = pg_temp.u('e2') and restore_reason = 'Withdrawn in error' from private.catalog_pairing_withdrawals where id = pg_temp.id('w'))
          and exists (select 1 from private.audit_events where action = 'catalog_pairing_restored' and actor_id = pg_temp.u('e2')),
  'the restoration is recorded and audited');
select is(pg_temp.restore('e1', pg_temp.rev()), 'error: record unavailable', 'a withdrawal is restored once');
select is(pg_temp.publish('e2'), 'error: pairing not verified', 'publishing it again needs a new independent verification (W7)');

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
select is(pg_temp.as_stale(format($q$select public.verify_game_platform(%L, %L, %L::jsonb, 'Checked', %s)::text$q$, pg_temp.id('g'),
  pg_temp.id('snes'), pg_temp.basis(), pg_temp.rev())), 'error: reauthentication required',
  'verifying a pairing needs a recent verification (I6)');

select * from finish();
rollback;
