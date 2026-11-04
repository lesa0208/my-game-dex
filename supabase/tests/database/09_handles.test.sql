-- M2: handle rules, including bypass attempts. now() is fixed within this
-- transaction, so the 24-hour and 30-day boundaries are tested exactly.
-- Concurrent requests are tested in scripts/db-identity-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(149);

create function pg_temp.as_user(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select ('00000000-0000-0000-0000-0000000000' || s)::uuid, 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'a7', 'a8']) as s;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;

-- Format
select throws_ok($$select public.claim_handle('ab')$$, '22023', 'invalid handle', 'too short');
select throws_ok($$select public.claim_handle('a234567890123456789012345')$$, '22023', 'invalid handle', '25 characters is too long');
select throws_ok($$select public.claim_handle('pokémon')$$, '22023', 'invalid handle', 'accented letters are rejected');
select throws_ok($$select public.claim_handle('аdmin')$$, '22023', 'invalid handle', 'a Cyrillic lookalike is rejected');
select throws_ok(format('select public.claim_handle(%L)', E'Kelvin'), '22023', 'invalid handle', 'the Kelvin sign, which lowercases to k, is rejected');
select throws_ok(format('select public.claim_handle(%L)', E'ſtaff'), '22023', 'invalid handle', 'the long s is rejected');
select throws_ok(format('select public.claim_handle(%L)', E'admİn'), '22023', 'invalid handle', 'a dotted capital I is rejected');
select throws_ok($$select public.claim_handle('has space')$$, '22023', 'invalid handle', 'spaces are rejected');
select throws_ok($$select public.claim_handle('has-dash')$$, '22023', 'invalid handle', 'dashes are rejected');
select throws_ok($$select public.claim_handle('a.b.c')$$, '22023', 'invalid handle', 'dots are rejected');
select throws_ok($$select public.claim_handle(null)$$, '22023', 'invalid handle', 'null is rejected');
select throws_ok(E'select public.claim_handle(''trailing\n'')', '22023', 'invalid handle', 'a trailing newline is rejected');

-- Reserved names and brand terms: normalization applies here, including case
select throws_ok(format('select public.claim_handle(%L)', h), 'P0001', 'handle unavailable', 'blocked: ' || h)
from unnest(array[
  'admin', 'ADMIN', 'Admin', 'adm1n', 'ADM1N', 'admln', 'adm_in', 'a_d_m_i_n', 'A_D_M_I_N', '4dmin', '4dm1n', '_admin_', 'admin_', 'support', 'supp0rt', '5upport', '5UPPORT', 's_u_p_p_o_r_t',
  'moderator', 'm0derator', 'm0d3rat0r', 'official', '0fficial', 'of_fi_cial', 'staff', 'st4ff', '5t4ff', 'system', 'syst3m', '5y5t3m',
  'mygamedex', 'MyGameDex', 'my_game_dex', 'MY_GAME_DEX', 'myg4med3x', 'my_g4m3_d3x', 'mygamedex_fan', 'the_mygamedex', 'official_gamedex', 'gamedex', 'g4m3d3x',
  'settings', 's3tt1ngs', 'api', '4p1', 'root', 'r00t', 'null', 'nu11'
]) as h;

reset role;

-- Ordinary names aren't caught by the reserved list
select ok(not private.handle_is_held(h), 'allowed: ' || h)
from unnest(array['badminton', 'b4dminton', 'badminton_fan', 'bad_minton', 'admiral', 'adminer', 'administrators_fan', 'gamer_mod', 'modern_collector', 'support_group', 'teamwork', 'homer', 'rootbeer', 'lily', 'mike_1985', 'mike1985', 'game_dev', 'dexter']) as h;

-- Reserved enforcement doesn't depend on any index on profiles
select is((select count(*)::int from pg_indexes where schemaname = 'public' and tablename = 'profiles' and indexdef ~ 'handle_skeleton'), 0, 'no index on profiles uses the skeleton');
select is(has_function_privilege('authenticated', 'private.handle_skeleton(text)', 'execute'), false, 'clients have no EXECUTE on the skeleton function');
select is(has_function_privilege('authenticated', 'private.lock_handle(text)', 'execute'), false, 'clients have no EXECUTE on the handle lock');

-- Case refers to one canonical handle
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select is(public.claim_handle('Marko'), 'marko', 'a mixed-case claim stores the lowercase handle');
select is(public.claim_handle('MARKO'), 'marko', 'the same handle in another case is a no-op');
select is(public.claim_handle('marko'), 'marko', 'claiming your own handle again is a no-op');
reset role;
select is((select handle from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'), 'marko', 'the stored handle is lowercase');
select ok((select handle_correction_until from public.profiles where id = '00000000-0000-0000-0000-0000000000a1') is not null, 'a no-op doesn''t use the correction');

select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
set local role authenticated;
select throws_ok(format('select public.claim_handle(%L)', h), 'P0001', 'handle unavailable', 'taken, in any case: ' || h)
from unnest(array['marko', 'Marko', 'MARKO', 'mArKo']) as h;
reset role;

-- Ordinary uniqueness is by exact spelling
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
set local role authenticated;
select is(public.claim_handle('mike_1985'), 'mike_1985', 'mike_1985 can be claimed');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
set local role authenticated;
select is(public.claim_handle('mike1985'), 'mike1985', 'mike1985 can coexist with mike_1985');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
set local role authenticated;
select is(public.claim_handle('badminton'), 'badminton', 'badminton is a valid handle');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e5');
set local role authenticated;
select is(public.claim_handle('b4dminton'), 'b4dminton', 'b4dminton can coexist with badminton');
reset role;
select throws_ok($$update public.profiles set handle = 'marko' where handle = 'badminton'$$, '23505', null, 'the database constraint enforces uniqueness');
select throws_ok($$update public.profiles set handle = 'Badminton' where handle = 'badminton'$$, '23514', null, 'the database constraint enforces lowercase');
select throws_ok($$update public.profiles set handle = null where handle = 'badminton'$$, '23514', null, 'a handle can''t be set without its timestamp matching');

-- The first correction
select is((select handle_correction_until from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'), now() + interval '24 hours', 'the correction lasts 24 hours from the first claim');
select is((select handle_changed_at from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'), now(), 'the first claim starts the cooldown clock');

-- Failed attempts don't use it
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
set local role authenticated;
select throws_ok($$select public.claim_handle('admin')$$, 'P0001', 'handle unavailable', 'a reserved name is still refused during the correction window');
select throws_ok($$select public.claim_handle('marko')$$, 'P0001', 'handle unavailable', 'a taken name is still refused during the correction window');
select throws_ok($$select public.claim_handle('x')$$, '22023', 'invalid handle', 'an invalid name is still refused during the correction window');
reset role;
select ok((select handle_correction_until is not null and handle = 'mike_1985' from public.profiles where id = '00000000-0000-0000-0000-0000000000b2'), 'failed attempts don''t use the correction');

-- One correction, then the normal cooldown
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select is(public.claim_handle('marko_two'), 'marko_two', 'one immediate correction works');
select throws_ok($$select public.claim_handle('marko_three')$$, 'P0001', 'handle change not available yet', 'a second correction is refused');
select throws_ok($$select public.claim_handle('marko')$$, 'P0001', 'handle change not available yet', 'a correction can''t be undone straight away');
reset role;
select is((select handle_correction_until from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'), null, 'the correction is used up');
select is((select handle_changed_at from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'), now(), 'the correction restarts the 30-day cooldown');

-- A correction still holds the released handle, by exact spelling
select is((select kind from private.handle_holds where handle = 'marko'), 'released', 'the corrected handle is held');
select is((select expires_at from private.handle_holds where handle = 'marko'), now() + interval '30 days', 'the hold lasts exactly 30 days');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f6');
set local role authenticated;
select throws_ok(format('select public.claim_handle(%L)', h), 'P0001', 'handle unavailable', 'held: ' || h)
from unnest(array['marko', 'Marko', 'MARKO']) as h;
select is(public.claim_handle('mark0'), 'mark0', 'a different spelling isn''t held');
reset role;
select is((select count(*)::int from private.handle_holds where kind = 'released' and handle = 'mark0'), 0, 'no hold was created by that claim');

-- Boundaries of the 24-hour window. Only d4 and e5 are adjusted, and only as an operator.
update public.profiles set handle_correction_until = now() where handle = 'badminton';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
set local role authenticated;
select throws_ok($$select public.claim_handle('badminton_two')$$, 'P0001', 'handle change not available yet', 'exactly 24 hours after the claim, the correction has ended');
reset role;
update public.profiles set handle_correction_until = now() + interval '1 microsecond' where handle = 'b4dminton';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e5');
set local role authenticated;
select is(public.claim_handle('b4dminton_two'), 'b4dminton_two', 'just inside 24 hours, the correction works');
reset role;

-- An unused correction: the cooldown counts from the first claim
update public.profiles set handle_correction_until = now() - interval '1 second', handle_changed_at = now() - interval '24 hours 1 second' where handle = 'badminton';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
set local role authenticated;
select throws_ok($$select public.claim_handle('badminton_two')$$, 'P0001', 'handle change not available yet', 'after an unused window, the cooldown applies');
reset role;
update public.profiles set handle_changed_at = now() - interval '30 days' + interval '1 microsecond' where handle = 'badminton';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
set local role authenticated;
select throws_ok($$select public.claim_handle('badminton_two')$$, 'P0001', 'handle change not available yet', 'just under 30 days is still refused');
reset role;
update public.profiles set handle_changed_at = now() - interval '30 days' where handle = 'badminton';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
set local role authenticated;
select is(public.claim_handle('badminton_two'), 'badminton_two', 'exactly 30 days later, a change works');
select throws_ok($$select public.claim_handle('badminton_three')$$, 'P0001', 'handle change not available yet', 'a later change never grants another correction');
reset role;
select is((select handle_correction_until from public.profiles where id = '00000000-0000-0000-0000-0000000000d4'), null, 'no allowance remains after a regular change');
select is((select handle_changed_at from public.profiles where id = '00000000-0000-0000-0000-0000000000d4'), now(), 'a regular change restarts the cooldown');

-- After a used correction, the full 30 days apply from the correction
update public.profiles set handle_changed_at = now() - interval '29 days 23 hours' where handle = 'marko_two';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select throws_ok($$select public.claim_handle('marko_three')$$, 'P0001', 'handle change not available yet', 'just under 30 days after a correction is refused');
reset role;
update public.profiles set handle_changed_at = now() - interval '30 days 1 hour' where handle = 'marko_two';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select is(public.claim_handle('marko_three'), 'marko_three', 'after 30 days a change works');
select throws_ok($$select public.claim_handle('marko_four')$$, 'P0001', 'handle change not available yet', 'and the correction doesn''t come back');
reset role;

-- A new first claim is the only thing that grants the correction
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
set local role authenticated;
select is(public.claim_handle('fresh_name'), 'fresh_name', 'a first claim works');
reset role;
select is((select handle_correction_until from public.profiles where id = '00000000-0000-0000-0000-0000000000a7'), now() + interval '24 hours', 'and grants one correction');

-- Hold expiry takes effect immediately, and only tidying removes the row
update private.handle_holds set expires_at = now() + interval '1 microsecond' where handle = 'marko';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a8');
set local role authenticated;
select throws_ok($$select public.claim_handle('marko')$$, 'P0001', 'handle unavailable', 'just before expiry, the hold applies');
reset role;
update private.handle_holds set expires_at = now() where handle = 'marko';
set local role authenticated;
select is(public.claim_handle('marko'), 'marko', 'at expiry, the hold no longer applies');
reset role;
select is(private.purge_expired_handle_holds(), 1, 'tidying removes the expired hold');
select is((select count(*)::int from private.handle_holds where handle = 'marko'), 0, 'the expired hold is gone');
select is((select count(*)::int from private.handle_holds where kind = 'reserved' and handle = 'admin'), 1, 'tidying never removes reserved names');
select cmp_ok((select count(*)::int from auth.users), '>=', 8, 'tidying never touches accounts');

-- A release can't overwrite a reserved name's hold
select is((select count(*)::int from private.handle_holds where kind = 'reserved'), (select count(*)::int from private.handle_holds where kind = 'reserved' and expires_at is null), 'reserved names never expire');

-- Skeleton, directly
select is(private.handle_skeleton('a_d_m_1_n'), private.handle_skeleton('admin'), 'underscores and digit substitutions normalize alike');
select is(private.handle_skeleton('ADMIN'), private.handle_skeleton('admin'), 'case normalizes alike');
select isnt(private.handle_skeleton('badminton'), private.handle_skeleton('admin'), 'badminton is not admin');

-- Clients can't manipulate holds or locks
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select throws_ok($$select * from private.handle_holds$$, '42501', null, 'a client can not read holds');
select throws_ok($$delete from private.handle_holds$$, '42501', null, 'a client can not delete holds');
select throws_ok($$insert into private.handle_holds (handle, kind) values ('x', 'reserved')$$, '42501', null, 'a client can not add holds');
select throws_ok($$select private.purge_expired_handle_holds()$$, '42501', null, 'a client can not purge holds');
select throws_ok($$select private.handle_is_held('admin')$$, '42501', null, 'a client can not probe holds directly');
select throws_ok($$select private.lock_handle('admin')$$, '42501', null, 'a client can not take a handle lock');
select throws_ok($$select private.handle_skeleton('admin')$$, '42501', null, 'a client can not call the skeleton function');
reset role;
select is(has_table_privilege('authenticated', 'private.handle_holds', 'select'), false, 'authenticated has no privilege on holds');
select is(has_table_privilege('service_role', 'private.handle_holds', 'select'), false, 'service_role has no privilege on holds');
select is(has_table_privilege('anon', 'private.handle_holds', 'select'), false, 'anon has no privilege on holds');

select * from finish();
rollback;
