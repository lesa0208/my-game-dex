-- M2: staff escalation, SECURITY DEFINER functions and avatar database rules.
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

create function pg_temp.as_user(p_id uuid, p_extra jsonb default '{}') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', (jsonb_build_object('sub', p_id, 'role', 'authenticated') || p_extra)::text, true);
end $$;

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, instance_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'a@example.test', now(), '{"role":"admin","staff_role":"admin"}', '{"role":"admin","staff_role":"admin"}', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'b@example.test', now(), '{}', '{}', '00000000-0000-0000-0000-000000000000');

select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select lives_ok($$select public.claim_handle('user_a')$$, 'setup: user claims a handle');
reset role;

-- Escalation attempts
select is(private.has_staff_role('admin'), false, 'metadata saying admin gives no staff role');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', '{"app_metadata":{"role":"admin"},"user_metadata":{"role":"admin"},"staff_role":"admin","is_admin":true}');
select is(private.has_staff_role('admin'), false, 'JWT claims saying admin give no staff role');
select is(private.has_staff_role('moderator'), false, 'JWT claims give no moderator role either');
set local role authenticated;
select throws_ok($$insert into public.staff_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000a1', 'admin')$$, '42501', null, 'a user can not grant themselves a role');
select throws_ok($$update public.staff_roles set role = 'admin'$$, '42501', null, 'a user can not change a role');
select throws_ok($$delete from public.staff_roles$$, '42501', null, 'a user can not delete roles');
select throws_ok($$select private.has_staff_role('admin')$$, '42501', null, 'a client can not call has_staff_role directly');
select throws_ok($$select private.is_active_user()$$, '42501', null, 'a client can not call is_active_user directly');
select throws_ok($$update public.profiles set account_status = 'active'$$, '42501', null, 'a profile update can not touch status');
reset role;
set local role anon;
select throws_ok($$insert into public.staff_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000a1', 'admin')$$, '42501', null, 'anon can not grant a role');
reset role;
set local role service_role;
select throws_ok($$insert into public.staff_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000a1', 'admin')$$, '42501', null, 'service_role can not grant a role, despite bypassing RLS');
select throws_ok($$select * from public.profiles$$, '42501', null, 'service_role has no table access to profiles');
select throws_ok($$select * from public.user_preferences$$, '42501', null, 'service_role has no table access to preferences');
reset role;
select is((select count(*)::int from public.staff_roles), 0, 'no staff role exists after every attempt');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'staff_roles' and cmd <> 'SELECT'), 0, 'staff_roles has no write policy');

-- The documented operator procedure works, and the helper reads only the table
insert into public.staff_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000a1', 'catalog_editor');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select is(private.has_staff_role('catalog_editor'), true, 'an operator-assigned role is recognized');
select is(private.has_staff_role('moderator'), false, 'other roles aren''t implied');
insert into public.staff_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000a1', 'admin');
select is(private.has_staff_role('moderator'), true, 'admin satisfies lower roles');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select is(private.has_staff_role('admin'), false, 'another user has no role');
set local role authenticated;
select is((select count(*)::int from public.staff_roles), 0, 'a user can not read another user''s roles');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select is((select count(*)::int from public.staff_roles), 2, 'a user reads their own roles');
reset role;
delete from public.staff_roles;

-- SECURITY DEFINER functions
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prosecdef and not coalesce(p.proconfig @> array['search_path=""'], false)),
  0, 'every SECURITY DEFINER function pins an empty search_path'
);
select is(
  (select array_agg(p.oid::regprocedure::text collate "C" order by p.oid::regprocedure::text collate "C") from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prosecdef),
  array[
    'accept_follow_request(uuid)', 'add_game_alias(uuid,text,game_alias_kind,text,text,text)', 'approve_submission(uuid,integer,bigint,bigint,text,text)', 'block_user(uuid)', 'can_review_submissions()', 'cancel_follow_request(uuid)', 'claim_handle(text)',
    'create_game(text,game_kind,text,text,date,date_precision,text)', 'create_release(uuid,uuid,text,text,jsonb,text)', 'delete_notification(uuid)', 'get_audit_events(integer,uuid)', 'get_catalog_review_queue(integer)',
    'get_follow_state(uuid)', 'get_followers(uuid,integer,timestamp with time zone,uuid)', 'get_following(uuid,integer,timestamp with time zone,uuid)', 'get_my_account()',
    'get_my_blocks(integer,timestamp with time zone,uuid)', 'get_my_notifications(integer,uuid)', 'get_my_submission(uuid)', 'get_profile_counts(uuid)', 'get_received_follow_requests(integer,timestamp with time zone,uuid)', 'get_release_picker(text,text,text,uuid)',
    'get_sent_follow_requests(integer,timestamp with time zone,uuid)', 'get_submission_queue(text,uuid,integer)', 'get_submission_review(uuid)', 'get_unread_notification_count()', 'grant_staff_role(uuid,staff_role,text)', 'list_catalog_platforms()', 'mark_notifications_read(uuid)', 'my_catalog_submissions(uuid,integer)', 'my_submission_for_release(uuid)',
    'private.block_peers()', 'private.can_read_release(uuid)', 'private.can_use_release(uuid)', 'private.can_view_collection(uuid)',
    'private.can_view_connections(uuid)', 'private.can_view_level(uuid,visibility_level)', 'private.check_catalog_publication()', 'private.handle_new_user()',
    'private.has_staff_role(staff_role)', 'private.hold_handle_on_delete()', 'private.is_accepted_follower(uuid)', 'private.is_active_user()',
    'private.is_blocked_between(uuid)', 'private.is_catalog_editor()', 'private.notify_follow_change()', 'private.require_active_user()',
    'private.require_verified_user()', 'private.validate_display_name()', 'publish_release(uuid,text,bigint)', 'reject_follow_request(uuid)', 'reject_submission(uuid,integer,text,text)',
    'remove_follower(uuid)', 'remove_game_alias(uuid,text)', 'request_follow(uuid)', 'request_submission_changes(uuid,integer,text,text)', 'resolve_catalog_review(uuid,text)', 'resubmit_my_submission(uuid,text)', 'revoke_staff_role(uuid,staff_role,text)', 'search_catalog(text,text[],integer,text)', 'set_account_status(uuid,account_status,text)',
    'set_avatar_path(uuid,text)', 'set_catalog_field_lock(text,uuid,text,boolean,text)', 'set_game_platform(uuid,uuid,text)', 'set_game_relation(uuid,uuid,game_relation_type,smallint,text,text)',
    'set_release_components(uuid,jsonb,text)', 'set_release_markets(uuid,text[],text)', 'set_release_requirements(uuid,jsonb,text)', 'start_submission_review(uuid,integer,text)', 'submit_game(text,game_kind,integer,text,text,text,jsonb,jsonb,text,boolean)', 'submit_release(uuid,text,text,text,jsonb,jsonb,text,boolean)', 'unblock_user(uuid)',
    'unfollow(uuid)', 'update_game(uuid,jsonb,text)', 'update_my_submission(uuid,jsonb)', 'update_release(uuid,jsonb,text)', 'verify_game(uuid,text,bigint)',
    'verify_release(uuid,text,bigint)', 'withdraw_my_submission(uuid)'
  ],
  'only the expected functions are SECURITY DEFINER'
);
select is(has_function_privilege('anon', 'public.claim_handle(text)', 'execute'), false, 'anon can not execute claim_handle');
select is(has_function_privilege('anon', 'public.get_my_account()', 'execute'), false, 'anon can not execute get_my_account');
select is(has_function_privilege('anon', 'public.set_avatar_path(uuid,text)', 'execute'), false, 'anon can not execute set_avatar_path');
select is(has_function_privilege('authenticated', 'public.set_avatar_path(uuid,text)', 'execute'), false, 'authenticated can not execute set_avatar_path');
select is(has_function_privilege('service_role', 'public.set_avatar_path(uuid,text)', 'execute'), true, 'service_role can execute set_avatar_path');
select is(has_function_privilege('service_role', 'public.claim_handle(text)', 'execute'), false, 'service_role can not claim handles');
select is(has_function_privilege('authenticated', 'private.handle_new_user()', 'execute'), false, 'nobody can call the signup trigger function');
select is(has_function_privilege('authenticated', 'private.has_staff_role(public.staff_role)', 'execute'), false, 'has_staff_role isn''t executable until a policy needs it');
select is(has_schema_privilege('anon', 'private', 'usage'), false, 'anon has no usage on private');
select is(has_schema_privilege('authenticated', 'private', 'usage'), false, 'authenticated has no usage on private');
select is(has_schema_privilege('service_role', 'private', 'usage'), false, 'service_role has no usage on private');

-- A function can't be tricked through search_path
set local search_path = pg_temp, public, extensions;
create table pg_temp.profiles (id uuid, handle text, account_status text);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select ok(public.claim_handle('search_path_user') = 'search_path_user', 'claim_handle uses the real tables, whatever the caller''s search_path');
select is((select handle from public.profiles where id = '00000000-0000-0000-0000-0000000000b2'), 'search_path_user', 'the real profile was changed');
reset search_path;

-- Avatars: database rules
select is((select public from storage.buckets where id = 'avatars'), true, 'the avatars bucket is public for reads');
select is((select file_size_limit::int from storage.buckets where id = 'avatars'), 2097152, 'the bucket limit is 2 MB');
select is((select allowed_mime_types from storage.buckets where id = 'avatars'), array['image/webp'], 'the bucket stores only WebP');
select is(
  (select count(*)::int from pg_policies where schemaname = 'storage' and tablename in ('objects', 'buckets') and (qual ~ 'avatars' or with_check ~ 'avatars')),
  0, 'no policy gives clients access to the avatars bucket'
);
set local role service_role;
select throws_ok(
  $$select public.set_avatar_path('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1/11111111-1111-1111-1111-111111111111.webp')$$,
  'P0002', 'avatar file not found', 'a path must point to a file that exists'
);
select throws_ok(
  $$select public.set_avatar_path('00000000-0000-0000-0000-0000000000e5', null)$$,
  'P0002', 'account not found', 'an unknown account is rejected'
);
reset role;
insert into storage.objects (bucket_id, name) values
  ('avatars', '00000000-0000-0000-0000-0000000000a1/11111111-1111-1111-1111-111111111111.webp'),
  ('avatars', '00000000-0000-0000-0000-0000000000b2/22222222-2222-2222-2222-222222222222.webp'),
  ('avatars', '00000000-0000-0000-0000-0000000000a1/bad-name.webp');
set local role service_role;
select is(public.set_avatar_path('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1/11111111-1111-1111-1111-111111111111.webp'), null, 'a valid file is recorded, returning no previous path');
select throws_ok(
  $$select public.set_avatar_path('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2/22222222-2222-2222-2222-222222222222.webp')$$,
  '23514', null, 'another user''s existing file can not be recorded'
);
select throws_ok(
  $$select public.set_avatar_path('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1/bad-name.webp')$$,
  '23514', null, 'a file with a predictable name can not be recorded'
);
select is(public.set_avatar_path('00000000-0000-0000-0000-0000000000a1', null), '00000000-0000-0000-0000-0000000000a1/11111111-1111-1111-1111-111111111111.webp', 'clearing returns the previous path, for removal');
reset role;
update public.profiles set account_status = 'suspended' where id = '00000000-0000-0000-0000-0000000000a1';
set local role service_role;
select throws_ok(
  $$select public.set_avatar_path('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1/11111111-1111-1111-1111-111111111111.webp')$$,
  '42501', 'account not eligible', 'a suspended account can not set an avatar'
);
select is(public.set_avatar_path('00000000-0000-0000-0000-0000000000a1', null), null, 'a suspended account''s avatar can still be cleared');
reset role;

select * from finish();
rollback;
