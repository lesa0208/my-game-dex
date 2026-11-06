-- M3: blocks, the visibility matrix through real policies, and client permissions.
begin;
create extension if not exists pgtap with schema extensions;
select plan(203);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;

create function pg_temp.call(p_actor text, p_fn text, p_target text) returns text language plpgsql as $$
declare r text; v_sql text;
begin
  v_sql := format('select public.%I(%L)::text', p_fn, pg_temp.u(p_target));
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute v_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
end $$;

create function pg_temp.rows(p_actor text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute format('select coalesce(jsonb_agg(t), ''[]'') from (%s) t', p_sql) into r;
  perform set_config('role', 'none', true);
  return r;
end $$;

create function pg_temp.anon_rows(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
  execute format('select coalesce(jsonb_agg(t), ''[]'') from (%s) t', p_sql) into r;
  perform set_config('role', 'none', true);
  return r;
end $$;

create function pg_temp.st(p_from text, p_to text) returns text language sql as $$
  select coalesce((select f.status::text from public.follows f where f.follower_id = pg_temp.u(p_from) and f.followee_id = pg_temp.u(p_to)), 'none')
$$;

-- o1 is the owner, public to follow. The others have the relationship their name says.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'b1', 'b2', 'b3', 'b4']) as s;
update public.profiles set handle = 'user_' || right(id::text, 2), handle_changed_at = now();

-- a1 owner, a2 stranger, a3 pending, a4 accepted, a5 blocked by owner, a6 blocked the owner,
-- a7 suspended accepted follower, a8 no handle, a9 moderator, b1 admin, b2 unverified follower,
-- b3 accepted follower who is deactivated, b4 a blocked accepted follower
update public.profiles set follow_approval_required = true where id = pg_temp.u('a1');
select is(pg_temp.call('a3', 'request_follow', 'a1'), 'requested', 'setup: a3 pending');
select is(pg_temp.call('a4', 'request_follow', 'a1'), 'requested', 'setup: a4 requests');
select is(pg_temp.call('a7', 'request_follow', 'a1'), 'requested', 'setup: a7 requests');
select is(pg_temp.call('b2', 'request_follow', 'a1'), 'requested', 'setup: b2 requests');
select is(pg_temp.call('b3', 'request_follow', 'a1'), 'requested', 'setup: b3 requests');
select is(pg_temp.call('b4', 'request_follow', 'a1'), 'requested', 'setup: b4 requests');
select is(pg_temp.call('a1', 'accept_follow_request', 'a4'), '', 'setup: a4 accepted');
select is(pg_temp.call('a1', 'accept_follow_request', 'a7'), '', 'setup: a7 accepted');
select is(pg_temp.call('a1', 'accept_follow_request', 'b2'), '', 'setup: b2 accepted');
select is(pg_temp.call('a1', 'accept_follow_request', 'b3'), '', 'setup: b3 accepted');
select is(pg_temp.call('a1', 'accept_follow_request', 'b4'), '', 'setup: b4 accepted');
select is(pg_temp.call('a1', 'block_user', 'a5'), '', 'setup: the owner blocks a5');
select is(pg_temp.call('a6', 'block_user', 'a1'), '', 'setup: a6 blocks the owner');
select is(pg_temp.call('a1', 'block_user', 'b4'), '', 'setup: the owner blocks accepted follower b4');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('a7');
update public.profiles set account_status = 'deactivated' where id = pg_temp.u('b3');
update public.profiles set handle = null, handle_changed_at = null, handle_correction_until = null where id = pg_temp.u('a8');
update auth.users set email_confirmed_at = null where id = pg_temp.u('b2');
insert into public.staff_roles (user_id, role) values (pg_temp.u('a9'), 'moderator'), (pg_temp.u('b1'), 'admin');

-- Visibility through a real policy on a real table, the way M6 will call it. One row per level.
create table public.__content (owner_id uuid not null, level public.visibility_level not null);
alter table public.__content enable row level security;
create policy read_content on public.__content for select to anon, authenticated using (private.can_view_level(owner_id, level));
grant select on public.__content to anon, authenticated;
insert into public.__content values (pg_temp.u('a1'), 'public'), (pg_temp.u('a1'), 'followers'), (pg_temp.u('a1'), 'private');

create function pg_temp.levels(p_actor text) returns text language sql as $$
  select coalesce(string_agg(x.level, ',' order by x.level), '') from jsonb_to_recordset(pg_temp.rows(p_actor, 'select level from public.__content')) as x(level text)
$$;

select is(pg_temp.levels('a1'), 'followers,private,public', 'owner: all levels');
select is((select coalesce(string_agg(x.level, ',' order by x.level), '') from jsonb_to_recordset(pg_temp.anon_rows('select level from public.__content')) as x(level text)), 'public', 'anonymous: public only');
select is(pg_temp.levels('a2'), 'public', 'stranger: public only');
select is(pg_temp.levels('a3'), 'public', 'pending follower: public only');
select is(pg_temp.levels('a4'), 'followers,public', 'accepted follower: public and followers, never private');
select is(pg_temp.levels('a5'), '', 'blocked by the owner: nothing, despite signing in');
select is(pg_temp.levels('a6'), '', 'blocked the owner: nothing');
select is(pg_temp.levels('b4'), '', 'a follower who was blocked: nothing, and no follow remains');
select is(pg_temp.levels('a7'), 'public', 'suspended accepted follower: no followers access');
select is(pg_temp.levels('b3'), 'public', 'deactivated accepted follower: no followers access');
select is(pg_temp.levels('b2'), 'public', 'accepted follower with an unverified email: no followers access');
select is(pg_temp.levels('a8'), 'public', 'account with no handle: public only');
select is(pg_temp.levels('a9'), 'public', 'moderator: no bypass');
select is(pg_temp.levels('b1'), 'public', 'admin: no bypass');

-- The owner's own status
update public.profiles set account_status = 'suspended' where id = pg_temp.u('a1');
select is(pg_temp.levels('a1'), 'followers,private,public', 'a suspended owner still reads their own content');
select is(pg_temp.levels('a4'), '', 'a follower of a suspended owner sees nothing');
select is(pg_temp.levels('a2'), '', 'a stranger sees nothing of a suspended owner');
select is((select count(*)::int from jsonb_array_elements(pg_temp.anon_rows('select level from public.__content'))), 0, 'anonymous sees nothing of a suspended owner');
update public.profiles set account_status = 'active' where id = pg_temp.u('a1');

-- Collection default stays private, whoever is asking
create function pg_temp.can_collection(p_actor text) returns boolean language plpgsql as $$
declare r boolean; v_o uuid := pg_temp.u('a1');
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
  r := private.can_view_collection(v_o);
  return r;
end $$;
select is((select collection_visibility from public.profiles where id = pg_temp.u('a1')), 'private'::public.visibility_level, 'collections still default to private');
select is(pg_temp.can_collection('a1'), true, 'private collection: owner');
select is(pg_temp.can_collection('a4'), false, 'private collection: not an accepted follower');
select is(pg_temp.can_collection('b1'), false, 'private collection: not an admin');
select is(pg_temp.can_collection('a2'), false, 'private collection: not a signed-in stranger');
update public.profiles set collection_visibility = 'followers' where id = pg_temp.u('a1');
select is(pg_temp.can_collection('a4'), true, 'followers collection: accepted follower');
select is(pg_temp.can_collection('a3'), false, 'followers collection: not a pending follower');
select is(pg_temp.can_collection('a7'), false, 'followers collection: not a suspended follower');
select is(pg_temp.can_collection('a2'), false, 'followers collection: not a stranger');
update public.profiles set collection_visibility = 'public' where id = pg_temp.u('a1');
select is(pg_temp.can_collection('a2'), true, 'public collection: a stranger');
select is(pg_temp.can_collection('a5'), false, 'public collection: not a blocked user when signed in');
update public.profiles set collection_visibility = 'private' where id = pg_temp.u('a1');
select is((select default_shelf_visibility from public.user_preferences where user_id = pg_temp.u('a2')), 'private'::public.visibility_level, 'shelves still default to private');
select is((select default_item_visibility from public.user_preferences where user_id = pg_temp.u('a2')), 'private'::public.visibility_level, 'items still default to private');
select is(pg_temp.can_collection('ff'), false, 'an unknown viewer sees nothing');
select lives_ok($$select set_config('request.jwt.claims', '', true)$$, 'setup: no viewer');
select is(private.can_view_collection('00000000-0000-0000-0000-0000000000ff'), false, 'an unknown owner grants nothing');
select is(private.can_view_level(pg_temp.u('a1'), null), false, 'a null level grants nothing');

-- Blocking semantics
select is(pg_temp.st('b4', 'a1'), 'none', 'blocking removed the blocked user''s accepted follow');
select is(pg_temp.call('a2', 'request_follow', 'a4'), 'following', 'setup: a2 follows a4');
select is(pg_temp.call('a4', 'request_follow', 'a2'), 'following', 'setup: a4 follows a2');
select is(pg_temp.call('a2', 'block_user', 'a4'), '', 'a block');
select is(pg_temp.st('a2', 'a4'), 'none', 'it removes the outgoing follow');
select is(pg_temp.st('a4', 'a2'), 'none', 'and the incoming one');
select lives_ok($$select pg_temp.call('a2', 'block_user', 'a4')$$, 'repeating a block is idempotent');
select is((select count(*)::int from public.blocked_users where blocker_id = pg_temp.u('a2')), 1, 'one block row');

select throws_ok($$select pg_temp.call('a4', 'request_follow', 'a2')$$, 'P0001', 'user unavailable', 'the blocked user can''t follow');
select throws_ok($$select pg_temp.call('a2', 'request_follow', 'a4')$$, 'P0001', 'user unavailable', 'the blocker can''t follow either');
select throws_ok($$select pg_temp.call('a4', 'request_follow', 'ff')$$, 'P0001', 'user unavailable', 'an unknown user gives the same answer as a blocked one');
select is(pg_temp.call('a4', 'get_follow_state', 'a2'), 'unavailable', 'the blocked user sees unavailable');
select is(pg_temp.call('a2', 'get_follow_state', 'a4'), 'blocked_by_you', 'the blocker sees their own block');
select is(pg_temp.call('a4', 'get_follow_state', 'ff'), 'unavailable', 'an unknown user reads the same as a block');
select throws_ok($$select pg_temp.call('a2', 'block_user', 'a2')$$, 'P0001', 'user unavailable', 'a self-block is refused');
select throws_ok($$select pg_temp.call('a2', 'block_user', 'ff')$$, 'P0001', 'user unavailable', 'blocking an unknown user is refused');

-- Cards
select is(jsonb_array_length(pg_temp.rows('a4', format('select id from public.profiles where id = %L', pg_temp.u('a2')))), 0, 'the blocked user can''t see the blocker''s card');
select is(jsonb_array_length(pg_temp.rows('a2', format('select id from public.profiles where id = %L', pg_temp.u('a4')))), 0, 'the blocker can''t see the blocked user''s card');
select is(jsonb_array_length(pg_temp.rows('a3', format('select id from public.profiles where id = %L', pg_temp.u('a2')))), 1, 'other users still see the card');
select is(jsonb_array_length(pg_temp.anon_rows(format('select id from public.profiles where id = %L', pg_temp.u('a2')))), 1, 'signed-out visitors still see the card, because public means public');
select is(jsonb_array_length(pg_temp.rows('a2', format('select id from public.profiles where id = %L', pg_temp.u('a2')))), 1, 'a blocker still sees their own card');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_read'), 0, 'the M2 read policy is replaced');
select is(
  (select array_agg(column_name::text collate "C" order by column_name::text collate "C") from information_schema.column_privileges where table_schema = 'public' and table_name = 'profiles' and grantee = 'authenticated' and privilege_type = 'SELECT'),
  array['avatar_path', 'bio', 'country_code', 'display_name', 'handle', 'id'],
  'public profile columns are unchanged'
);

-- A block list is private
select is(pg_temp.rows('a2', 'select handle from public.get_my_blocks()')->0->>'handle', 'user_a4', 'a blocker lists their own blocks');
select is(jsonb_array_length(pg_temp.rows('a4', 'select handle from public.get_my_blocks()')), 0, 'the blocked user sees nothing about it');
select is(jsonb_array_length(pg_temp.rows('a3', 'select handle from public.get_my_blocks()')), 0, 'nor does anyone else');

-- Unblock
select is(pg_temp.call('a4', 'unblock_user', 'a2'), '', 'the blocked user can''t lift the block: it does nothing');
select is((select count(*)::int from public.blocked_users where blocker_id = pg_temp.u('a2')), 1, 'the block remains');
select is(pg_temp.call('a2', 'unblock_user', 'a4'), '', 'the blocker unblocks');
select is((select count(*)::int from public.blocked_users where blocker_id = pg_temp.u('a2')), 0, 'the block is gone');
select lives_ok($$select pg_temp.call('a2', 'unblock_user', 'a4')$$, 'repeating an unblock is idempotent');
select is(pg_temp.st('a2', 'a4'), 'none', 'unblocking restores no outgoing follow');
select is(pg_temp.st('a4', 'a2'), 'none', 'unblocking restores no incoming follow');
select is(pg_temp.call('a2', 'request_follow', 'a4'), 'following', 'a new follow is a fresh relationship');

-- Mutual blocks are independent
select is(pg_temp.call('a3', 'block_user', 'b1'), '', 'setup: a3 blocks b1');
select is(pg_temp.call('b1', 'block_user', 'a3'), '', 'a user can block someone who has blocked them');
select is(pg_temp.call('a3', 'unblock_user', 'b1'), '', 'one side unblocks');
select throws_ok($$select pg_temp.call('a3', 'request_follow', 'b1')$$, 'P0001', 'user unavailable', 'the other block still applies');

-- A suspended user can still protect themselves
update public.profiles set account_status = 'suspended' where id = pg_temp.u('a2');
select is(pg_temp.call('a2', 'block_user', 'a3'), '', 'a suspended user can block');
select is(pg_temp.call('a2', 'unblock_user', 'a3'), '', 'a suspended user can unblock');
select is(pg_temp.call('a2', 'unfollow', 'a4'), '', 'a suspended user can unfollow');
select throws_ok($$select pg_temp.call('a2', 'request_follow', 'a3')$$, '42501', 'account not eligible', 'but can''t add a follow');
update public.profiles set account_status = 'active' where id = pg_temp.u('a2');

-- The database refuses a follow alongside a block, even from an operator
select throws_ok(
  format($q$insert into public.follows (follower_id, followee_id, status) values (%L, %L, 'pending')$q$, pg_temp.u('a5'), pg_temp.u('a1')),
  '23514', 'follow not allowed while a block exists', 'a follow row can''t be inserted during a block'
);
insert into public.follows (follower_id, followee_id, status, accepted_at) values (pg_temp.u('a9'), pg_temp.u('b3'), 'accepted', now());
insert into public.blocked_users (blocker_id, blocked_id) values (pg_temp.u('b3'), pg_temp.u('a9'));
select is(pg_temp.st('a9', 'b3'), 'none', 'an operator-inserted block also removes follows');

-- Permissions: tables
select is(has_table_privilege(r, t, p), false, format('%s has no %s on %s', r, p, t))
from unnest(array['anon', 'authenticated', 'service_role']) as r
cross join unnest(array['public.follows', 'public.blocked_users']) as t
cross join unnest(array['select', 'insert', 'update', 'delete']) as p;
select is((select count(*)::int from information_schema.column_privileges where table_schema = 'public' and table_name in ('follows', 'blocked_users') and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')), 0, 'no column grants exist either');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('follows', 'blocked_users')), 0, 'no policies exist');
select ok((select relrowsecurity from pg_class where oid = 'public.follows'::regclass), 'RLS is on for follows');
select ok((select relrowsecurity from pg_class where oid = 'public.blocked_users'::regclass), 'RLS is on for blocked_users');
select throws_ok(format($q$select pg_temp.rows('a4', 'select * from public.follows')$q$), '42501', null, 'a signed-in user can''t read follows');
select throws_ok($q$select pg_temp.rows('a4', 'select * from public.blocked_users')$q$, '42501', null, 'a signed-in user can''t read blocks');
select throws_ok($q$select pg_temp.anon_rows('select * from public.follows')$q$, '42501', null, 'anon can''t read follows');
set local role service_role;
select throws_ok($q$select * from public.follows$q$, '42501', null, 'service_role can''t read follows');
select throws_ok($q$insert into public.blocked_users (blocker_id, blocked_id) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2')$q$, '42501', null, 'service_role can''t write blocks');
reset role;

-- Permissions: functions, for each role separately
create temp table client_functions (sig text);
insert into client_functions values
  ('public.request_follow(uuid)'), ('public.cancel_follow_request(uuid)'), ('public.unfollow(uuid)'),
  ('public.accept_follow_request(uuid)'), ('public.reject_follow_request(uuid)'), ('public.remove_follower(uuid)'),
  ('public.block_user(uuid)'), ('public.unblock_user(uuid)'), ('public.get_follow_state(uuid)'),
  ('public.get_followers(uuid,integer,timestamp with time zone,uuid)'), ('public.get_following(uuid,integer,timestamp with time zone,uuid)'),
  ('public.get_profile_counts(uuid)'), ('public.get_received_follow_requests(integer,timestamp with time zone,uuid)'),
  ('public.get_sent_follow_requests(integer,timestamp with time zone,uuid)'), ('public.get_my_blocks(integer,timestamp with time zone,uuid)');
select is(has_function_privilege('anon', sig, 'execute'), false, 'anon can''t execute ' || sig) from client_functions;
select is(has_function_privilege('service_role', sig, 'execute'), false, 'service_role can''t execute ' || sig) from client_functions;
select is(has_function_privilege('authenticated', sig, 'execute'), true, 'authenticated can execute ' || sig) from client_functions;
select is((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = sig::regprocedure), true, 'definer with an empty search_path: ' || sig) from client_functions;
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace join client_functions c on c.sig::regprocedure = p.oid
    where exists (select 1 from unnest(coalesce(p.proargnames, '{}')) a where a ~* '(actor|user_id|viewer)')),
  0, 'no function takes an actor argument'
);

-- Internal helpers: refused directly, and only usable through policies
select is(has_schema_privilege(r, 'private', 'usage'), false, r || ' has no usage on private') from unnest(array['anon', 'authenticated', 'service_role']) as r;
select throws_ok(format($q$select pg_temp.rows('a4', %L)$q$, 'select private.' || h), '42501', null, 'a client can''t call private.' || h)
from unnest(array[
  'is_blocked_between(''00000000-0000-0000-0000-0000000000a1'')', 'is_accepted_follower(''00000000-0000-0000-0000-0000000000a1'')',
  'can_view_collection(''00000000-0000-0000-0000-0000000000a1'')', 'can_view_connections(''00000000-0000-0000-0000-0000000000a1'')',
  'block_peers()', 'require_active_user()', 'require_verified_user()'
]) as h;
select is(has_function_privilege('authenticated', 'private.lock_follow_pair(uuid,uuid)', 'execute'), false, 'clients have no EXECUTE on the pair lock');
select is(has_function_privilege('authenticated', 'private.can_view_connections(uuid)', 'execute'), false, 'clients have no EXECUTE on can_view_connections');
select is(has_function_privilege('anon', 'private.block_peers()', 'execute'), false, 'anon has no EXECUTE on block_peers');
select is(has_function_privilege('service_role', 'private.block_peers()', 'execute'), false, 'service_role has no EXECUTE on block_peers');
select is(has_function_privilege('anon', 'private.can_view_level(uuid,public.visibility_level)', 'execute'), true, 'anon has EXECUTE on can_view_level, for policies');
select is(has_function_privilege('service_role', 'private.can_view_level(uuid,public.visibility_level)', 'execute'), false, 'service_role doesn''t');

select * from finish();
rollback;
