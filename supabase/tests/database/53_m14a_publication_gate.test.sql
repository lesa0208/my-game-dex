-- M14a: the physical-evidence gate on the individual publication path, and every way a pairing
-- could become public without it (20261210100400_m14a_physical_evidence_gate). The batch path
-- is in 50 and 51. One rolled-back transaction, with test 49's staff session harness.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

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
from unnest(array['e1', 'e2', 'e3', 'c4']) as s;
update public.profiles set handle = 'm14_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['e1', 'e2', 'e3', 'c4']) as s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('e2'), 'catalog_editor'), (pg_temp.u('e3'), 'catalog_editor');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated, anon;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
grant execute on function pg_temp.id(text) to authenticated, anon;
insert into ids values ('snes', (select id from public.platforms where slug = 'snes')), ('nes', (select id from public.platforms where slug = 'nes'));
create function pg_temp.rev() returns bigint language sql stable as $$ select revision from public.games where id = pg_temp.id('g') $$;
grant execute on function pg_temp.rev() to authenticated;
create function pg_temp.verify_pair(p_actor text, p_platform text, p_eligibility text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.verify_game_platform(%L, %L, %L::jsonb, 'Checked a copy', %s)::text$q$, pg_temp.id('g'), pg_temp.id(p_platform),
    jsonb_build_object('source', 'editor', 'reference', 'Cartridge and box photographed', 'physical_eligibility', p_eligibility)::text, pg_temp.rev())) $$;
create function pg_temp.publish(p_actor text, p_platform text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format($q$select public.publish_game_identity(%L, array[%L]::uuid[], 'Physical existence confirmed', %s)::text$q$,
    pg_temp.id('g'), pg_temp.id(p_platform), pg_temp.rev())) $$;

-- e1 creates the game and its SNES pairing; e2 verifies the game's identity.
insert into ids values ('g', pg_temp.as_user('e1', $$select public.create_game('Zqx Gate Quest', 'game', null, null, '1993-05-05', 'day', 'M14a test')::text$$)::uuid);
select pg_temp.as_user('e1', format($$select public.set_game_platform(%L, %L, 'M14a test')::text$$, pg_temp.id('g'), pg_temp.id('snes')));
select is(pg_temp.as_user('e2', format($$select public.verify_game(%L, 'Identity checked', %s)::text$$, pg_temp.id('g'), pg_temp.rev())), 'true', 'setup: e2 verifies the game''s identity');

-- Evidence: only "confirmed" counts, and only an authorized editor records it.
select is(pg_temp.verify_pair('e2', 'snes', 'inconclusive'), 'error: invalid changes', 'inconclusive evidence isn''t accepted as a verification');
select is(pg_temp.verify_pair('e2', 'snes', 'unsupported'), 'error: invalid changes', 'nor is negative evidence');
select is(pg_temp.verify_pair('c4', 'snes', 'confirmed'), 'error: not permitted', 'a collector can''t record evidence');
select is(pg_temp.publish('e2', 'snes'), 'error: pairing not verified', 'without confirmed evidence the identity can''t be published');
select is(pg_temp.verify_pair('e2', 'snes', 'confirmed'), 'true', 'an independent editor confirms the physical evidence');

-- Publication: never by the editor who confirmed the evidence, never by a collector or visitor.
select is(pg_temp.publish('e2', 'snes'), 'error: own record', 'the editor who confirmed the evidence can''t publish it');
select is(pg_temp.publish('c4', 'snes'), 'error: not permitted', 'a collector can''t publish it');
select is(pg_temp.publish(null, 'snes'), 'error: permission denied for function publish_game_identity', 'nor can a visitor');
select is(pg_temp.publish('e1', 'snes'), 'error: own record', 'nor the game''s creator');
select is(pg_temp.publish('e3', 'snes'), 'true', 'a second editor publishes it');
select ok((select g.status = 'published' and gp.status = 'published' and gp.verified_by = pg_temp.u('e2') from public.games g join public.game_platforms gp on gp.game_id = g.id
           where g.id = pg_temp.id('g') and gp.platform_id = pg_temp.id('snes')), 'the game and its SNES pairing are public, on e2''s evidence');
select is(pg_temp.publish('e3', 'snes'), 'error: pairing not verified',
  'publishing it again is refused: publication moved the game''s revision, so the earlier verification no longer counts (B1 I5)');
select is((select count(*)::integer from public.game_platforms where game_id = pg_temp.id('g') and status = 'published'), 1, 'still one public pairing');

-- A published game gains a new platform link: it stays out of sight until its own evidence.
select is(pg_temp.as_user('e1', format($$select public.set_game_platform(%L, %L, 'M14a test')::text$$, pg_temp.id('g'), pg_temp.id('nes'))), 'true', 'the published game is paired with the NES');
select ok((select status = 'under_review' and verified_at is null from public.game_platforms where game_id = pg_temp.id('g') and platform_id = pg_temp.id('nes'))
          and (select count(*) = 1 from public.game_platforms where game_id = pg_temp.id('g') and status = 'published'), 'the new pairing is under review, not public');
select is(pg_temp.publish('e3', 'nes'), 'error: pairing not verified', 'and can''t be published without its own confirmed evidence');

-- Directly, beneath the functions: a pairing without evidence can't be made public, and no
-- basis but "confirmed" can be stored.
set constraints all immediate;
select throws_ok(format($$update public.game_platforms set status = 'published' where game_id = %L and platform_id = %L$$, pg_temp.id('g'), pg_temp.id('nes')),
  '23514', null, 'a pairing with no release and no confirmed evidence can''t be published, whoever writes it');
set constraints all deferred;
select throws_ok(format($$update public.game_platforms set verified_at = now(), verified_by = %L, verified_game_revision = %s,
    verification_basis = '{"source": "editor", "reference": "Unclear photo", "physical_eligibility": "inconclusive"}' where game_id = %L and platform_id = %L$$,
    pg_temp.u('e2'), pg_temp.rev(), pg_temp.id('g'), pg_temp.id('nes')),
  '23514', null, 'an inconclusive basis can''t be stored, even by the database owner');
select is(pg_temp.as_user(null, format($$select string_agg(p.slug, ',' order by p.slug) from public.game_platforms gp join public.platforms p on p.id = gp.platform_id where gp.game_id = %L$$, pg_temp.id('g'))),
  'snes', 'a visitor sees only the evidenced SNES pairing');

select * from finish();
rollback;
