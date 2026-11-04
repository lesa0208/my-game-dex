-- M2: signup lifecycle, profile privacy and account deletion.
begin;
create extension if not exists pgtap with schema extensions;
select plan(82);

create function pg_temp.as_user(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

-- Metadata tries to claim a handle and staff access. Created the way Auth creates users.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, instance_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'a@example.test', now(), '{"role":"admin","handle":"admin","staff":true,"account_status":"active"}', '{"role":"admin"}', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'b@example.test', now(), '{}', '{}', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0000-0000000000c3', 'authenticated', 'authenticated', 'c@example.test', null, '{}', '{}', '00000000-0000-0000-0000-000000000000');

-- Signup trigger
select is((select count(*)::int from public.profiles), 3, 'every new user gets a profile');
select is((select count(*)::int from public.user_preferences), 3, 'every new user gets preferences');
select is((select count(*)::int from public.staff_roles), 0, 'signup never creates a staff role');
select is((select handle from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'), null, 'a handle in metadata is ignored');
select is((select prosecdef from pg_proc where oid = 'private.handle_new_user()'::regprocedure), true, 'the trigger function is SECURITY DEFINER');
select unalike(pg_get_functiondef('private.handle_new_user()'::regprocedure), '%raw_%meta_data%', 'the trigger function never reads metadata');

-- Private defaults
select is((select collection_visibility from public.profiles where id = '00000000-0000-0000-0000-0000000000b2'), 'private'::public.visibility_level, 'collection defaults to private');
select is((select allow_search_indexing from public.profiles where id = '00000000-0000-0000-0000-0000000000b2'), false, 'indexing defaults to off');
select is((select default_item_visibility from public.user_preferences where user_id = '00000000-0000-0000-0000-0000000000b2'), 'private'::public.visibility_level, 'items default to private');
select is((select default_shelf_visibility from public.user_preferences where user_id = '00000000-0000-0000-0000-0000000000b2'), 'private'::public.visibility_level, 'shelves default to private');
select hasnt_column('public', 'profiles', 'date_of_birth', 'no birth date column');
select is((select count(*)::int from information_schema.columns where table_schema = 'public' and table_name in ('profiles', 'user_preferences', 'staff_roles') and column_name ~* '(birth|dob|^age|identity_doc|passport)'), 0, 'no age or identity data is stored');

-- Atomic failure, with a generic message
savepoint before_dup;
select throws_ok(
  $$insert into auth.users (id, aud, role, email, instance_id) values ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'dup@example.test', '00000000-0000-0000-0000-000000000000')$$,
  '23505', null, 'a duplicate auth user fails'
);
rollback to before_dup;
create function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'secret internal detail'; end $$;
create trigger __boom before insert on public.user_preferences for each row execute function pg_temp.boom();
select throws_ok(
  $$insert into auth.users (id, aud, role, email, instance_id) values ('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'authenticated', 'd@example.test', '00000000-0000-0000-0000-000000000000')$$,
  'P0001', 'account could not be created', 'a trigger failure gives only a generic message'
);
drop trigger __boom on public.user_preferences;
select is((select count(*)::int from auth.users where id = '00000000-0000-0000-0000-0000000000d4'), 0, 'the failed signup left no auth user');
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-0000000000d4'), 0, 'the failed signup left no profile');

-- An unclaimed profile isn't public
set local role anon;
select is((select count(*)::int from public.profiles), 0, 'profiles without a handle are not public');
reset role;

-- Email verification before activation
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
set local role authenticated;
select throws_ok($$select public.claim_handle('unverified_user')$$, '42501', 'account not eligible', 'an unverified user can not claim a handle');
reset role;
select is((select handle from public.profiles where id = '00000000-0000-0000-0000-0000000000c3'), null, 'still no handle');

select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select is(public.claim_handle('collector_a'), 'collector_a', 'a verified user can claim a handle');
select is((select is_active from public.get_my_account()), true, 'a verified user with a handle is active');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
set local role authenticated;
select is(public.claim_handle('collector_b'), 'collector_b', 'a second user can claim a handle');
select is((select count(*)::int from public.get_my_account()), 1, 'an owner reads only their own account');
reset role;

-- A verified flag removed later makes the account inactive, even with a handle
update auth.users set email_confirmed_at = null where id = '00000000-0000-0000-0000-0000000000b2';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
set local role authenticated;
select is((select is_active from public.get_my_account()), false, 'without a verified email an account is inactive');
update public.profiles set display_name = 'x' where id = '00000000-0000-0000-0000-0000000000b2';
reset role;
select is((select display_name from public.profiles where id = '00000000-0000-0000-0000-0000000000b2'), null, 'an inactive account can not update its profile');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-0000000000b2';

-- Public card: only approved columns
select is(
  (select array_agg(column_name::text collate "C" order by column_name::text collate "C") from information_schema.column_privileges where table_schema = 'public' and table_name = 'profiles' and grantee = 'anon' and privilege_type = 'SELECT'),
  array['avatar_path', 'bio', 'country_code', 'display_name', 'handle', 'id'],
  'anon can select only the approved public columns'
);
select is(
  (select array_agg(column_name::text collate "C" order by column_name::text collate "C") from information_schema.column_privileges where table_schema = 'public' and table_name = 'profiles' and grantee = 'authenticated' and privilege_type = 'SELECT'),
  array['avatar_path', 'bio', 'country_code', 'display_name', 'handle', 'id'],
  'authenticated can select only the approved public columns'
);
set local role anon;
select is((select handle from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'), 'collector_a', 'anon reads a public handle');
select throws_ok($$select allow_search_indexing from public.profiles$$, '42501', null, 'anon can not read the indexing preference');
select throws_ok($$select follow_approval_required from public.profiles$$, '42501', null, 'anon can not read the follow setting');
select throws_ok($$select collection_visibility from public.profiles$$, '42501', null, 'anon can not read collection visibility');
select throws_ok($$select account_status from public.profiles$$, '42501', null, 'anon can not read account status');
select throws_ok($$select handle_changed_at from public.profiles$$, '42501', null, 'anon can not read handle history');
select throws_ok($$select handle_correction_until from public.profiles$$, '42501', null, 'anon can not read the correction allowance');
select throws_ok($$select * from public.profiles$$, '42501', null, 'anon can not select all columns');
select throws_ok($$select * from public.user_preferences$$, '42501', null, 'anon can not read preferences');
select throws_ok($$select * from public.staff_roles$$, '42501', null, 'anon can not read staff roles');
select throws_ok($$select public.get_my_account()$$, '42501', null, 'anon can not call get_my_account');
select throws_ok($$select public.claim_handle('anon_user')$$, '42501', null, 'anon can not call claim_handle');
select throws_ok($$update public.profiles set display_name = 'x'$$, '42501', null, 'anon can not update profiles');
reset role;
select hasnt_column('public', 'profiles', 'follower_count', 'follower counts wait for M3, when follows exist');
select hasnt_column('public', 'profiles', 'cover_path', 'no unapproved cover column');

-- A signed-in user sees the same card
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
set local role authenticated;
select is((select count(*)::int from public.profiles where handle = 'collector_a'), 1, 'a signed-in user reads another card');
select throws_ok($$select allow_search_indexing from public.profiles$$, '42501', null, 'a signed-in user can not read indexing preferences');
select throws_ok($$select follow_approval_required from public.profiles$$, '42501', null, 'a signed-in user can not read the follow setting');

-- Cross-user denial
update public.profiles set display_name = 'hacked' where id = '00000000-0000-0000-0000-0000000000a1';
update public.user_preferences set theme = 'dark' where user_id = '00000000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from public.user_preferences where user_id = '00000000-0000-0000-0000-0000000000a1'), 0, 'another user''s preferences are invisible');
select is((select count(*)::int from public.user_preferences), 1, 'a user sees only their own preferences');
reset role;
select is((select display_name from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'), null, 'another user''s profile is unchanged');
select is((select theme from public.user_preferences where user_id = '00000000-0000-0000-0000-0000000000a1'), 'system'::public.theme_preference, 'another user''s preferences are unchanged');

-- Own updates: allowed fields only
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select lives_ok($$update public.profiles set display_name = 'Collector A', bio = 'Hello', country_code = 'DE' where id = '00000000-0000-0000-0000-0000000000a1'$$, 'an owner updates their own card');
select lives_ok($$update public.profiles set allow_search_indexing = true, collection_visibility = 'public' where id = '00000000-0000-0000-0000-0000000000a1'$$, 'an owner explicitly changes private settings');
select is((select allow_search_indexing from public.get_my_account()), true, 'an owner reads their own indexing preference');
select lives_ok($$update public.user_preferences set theme = 'dark' where user_id = '00000000-0000-0000-0000-0000000000a1'$$, 'an owner updates their preferences');
select throws_ok($$update public.profiles set handle = 'other' where id = '00000000-0000-0000-0000-0000000000a1'$$, '42501', null, 'a handle can not be set directly');
select throws_ok($$update public.profiles set account_status = 'active' where id = '00000000-0000-0000-0000-0000000000a1'$$, '42501', null, 'account status can not be changed');
select throws_ok($$update public.profiles set avatar_path = 'x' where id = '00000000-0000-0000-0000-0000000000a1'$$, '42501', null, 'avatar_path can not be set directly');
select throws_ok($$update public.profiles set handle_changed_at = null where id = '00000000-0000-0000-0000-0000000000a1'$$, '42501', null, 'the handle cooldown can not be reset');
select throws_ok($$update public.profiles set handle_correction_until = now() + interval '1 year' where id = '00000000-0000-0000-0000-0000000000a1'$$, '42501', null, 'the correction allowance can not be changed');
select throws_ok($$select handle_correction_until from public.profiles$$, '42501', null, 'the correction allowance can not be read directly');
select throws_ok($$update public.profiles set id = '00000000-0000-0000-0000-0000000000b2' where id = '00000000-0000-0000-0000-0000000000a1'$$, '42501', null, 'a profile id can not change');
select throws_ok($$insert into public.profiles (id) values ('00000000-0000-0000-0000-0000000000e5')$$, '42501', null, 'profiles can not be inserted by a client');
select throws_ok($$delete from public.profiles$$, '42501', null, 'profiles can not be deleted by a client');
select throws_ok($$insert into public.user_preferences (user_id) values ('00000000-0000-0000-0000-0000000000e5')$$, '42501', null, 'preferences can not be inserted by a client');
select throws_ok($$update public.user_preferences set user_id = '00000000-0000-0000-0000-0000000000b2'$$, '42501', null, 'preferences can not move to another user');
reset role;

-- Text validation
select throws_ok($$update public.profiles set display_name = '' where handle = 'collector_a'$$, '23514', null, 'an empty display name is rejected');
select throws_ok($$update public.profiles set display_name = E'bad‮name' where handle = 'collector_a'$$, '23514', null, 'bidirectional control characters are rejected');
select throws_ok($$update public.profiles set display_name = 'MyGameDex Official' where handle = 'collector_a'$$, '23514', 'display name not allowed', 'a display name can not present as the platform');
select throws_ok($$update public.profiles set display_name = 'My Game D3x' where handle = 'collector_a'$$, '23514', 'display name not allowed', 'a lookalike display name is rejected');
select lives_ok($$update public.profiles set display_name = 'Lucía Ferrer' where handle = 'collector_a'$$, 'Unicode display names are allowed');
select throws_ok($$update public.profiles set country_code = 'XX' where handle = 'collector_a'$$, '23503', null, 'a country must be a known market');
select throws_ok(
  $$update public.profiles set avatar_path = '00000000-0000-0000-0000-0000000000b2/11111111-1111-1111-1111-111111111111.webp' where handle = 'collector_a'$$,
  '23514', null, 'an avatar path outside the owner''s folder is rejected'
);
select throws_ok(
  $$update public.profiles set avatar_path = '00000000-0000-0000-0000-0000000000a1/../x.webp' where handle = 'collector_a'$$,
  '23514', null, 'a path traversal in avatar_path is rejected'
);
select throws_ok(
  $$update public.profiles set avatar_path = '00000000-0000-0000-0000-0000000000a1/avatar.png' where handle = 'collector_a'$$,
  '23514', null, 'a predictable or non-WebP avatar name is rejected'
);

-- Suspension hides the card and stops writes
update public.profiles set account_status = 'suspended' where handle = 'collector_b';
set local role anon;
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-0000000000b2'), 0, 'a suspended profile is not public');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
set local role authenticated;
select is((select is_active from public.get_my_account()), false, 'a suspended account is inactive');
select throws_ok($$select public.claim_handle('new_name')$$, '42501', 'account not eligible', 'a suspended account can not change handle');
reset role;
update public.profiles set account_status = 'active' where handle = 'collector_b';

-- Account deletion
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
insert into public.staff_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000a1', 'moderator');
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'), 0, 'deleting a user removes the profile');
select is((select count(*)::int from public.user_preferences where user_id = '00000000-0000-0000-0000-0000000000a1'), 0, 'deleting a user removes preferences');
select is((select count(*)::int from public.staff_roles where user_id = '00000000-0000-0000-0000-0000000000a1'), 0, 'deleting a user removes staff roles');
select is((select kind from private.handle_holds where handle = 'collector_a'), 'released', 'the deleted account''s handle is held');
select ok((select expires_at between now() + interval '29 days' and now() + interval '31 days' from private.handle_holds where handle = 'collector_a'), 'the hold lasts 30 days');
select is((select count(*)::int from information_schema.columns where table_schema = 'private' and table_name = 'handle_holds' and column_name ~ '(user|profile|owner)'), 0, 'a hold has no link to the person');

select * from finish();
rollback;
