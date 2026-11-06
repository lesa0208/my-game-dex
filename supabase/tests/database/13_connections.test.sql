-- M3: follower lists, counts and paging. Counts must match what the lists show.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;

create function pg_temp.rows(p_actor text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute format('select coalesce(jsonb_agg(t), ''[]'') from (%s) t', p_sql) into r;
  perform set_config('role', 'none', true);
  return r;
end $$;

-- Walks every page of a list, a few rows at a time, and returns the handles.
create function pg_temp.walk(p_actor text, p_fn text, p_profile text, p_page int default 2) returns text[] language plpgsql as $$
declare
  v_all text[] := '{}'; v_rows jsonb; v_at text; v_id text; v_guard int := 0;
begin
  loop
    v_rows := pg_temp.rows(p_actor, format('select * from public.%I(%L, %s, %L, %L)', p_fn, pg_temp.u(p_profile), p_page, v_at, v_id));
    exit when jsonb_array_length(v_rows) = 0;
    v_all := v_all || array(select e->>'handle' from jsonb_array_elements(v_rows) e);
    v_at := v_rows->(jsonb_array_length(v_rows) - 1)->>'followed_at';
    v_id := v_rows->(jsonb_array_length(v_rows) - 1)->>'id';
    v_guard := v_guard + 1;
    if v_guard > 100 then raise exception 'paging did not end'; end if;
  end loop;
  return (select coalesce(array_agg(h order by h), '{}') from unnest(v_all) h);
end $$;

create function pg_temp.counts(p_actor text, p_profile text) returns jsonb language plpgsql as $$
begin
  return pg_temp.rows(p_actor, format('select * from public.get_profile_counts(%L)', pg_temp.u(p_profile)))->0;
end $$;

insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'b2', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'd1', 'd2', 'd3']) as s;
update public.profiles set handle = 'u_' || right(id::text, 2), handle_changed_at = now();

-- a1 is public and b2 is private. Followers: c1, c2, c3 public; c4 private; c5 suspended;
-- c6 public, in a block with viewer d2. c7 follows only b2. d1 is a stranger.
update public.profiles set follow_approval_required = true where id in (pg_temp.u('b2'), pg_temp.u('c4'));
insert into public.follows (follower_id, followee_id, status, accepted_at)
select pg_temp.u(s), pg_temp.u('a1'), 'accepted', now() from unnest(array['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) as s;
insert into public.follows (follower_id, followee_id, status, accepted_at)
select pg_temp.u(s), pg_temp.u('b2'), 'accepted', now() from unnest(array['c1', 'c7']) as s;
-- a1 follows c1 (public) and c4 (private). b2's and a1's other states don't count.
insert into public.follows (follower_id, followee_id, status, accepted_at)
select pg_temp.u('a1'), pg_temp.u(s), 'accepted', now() from unnest(array['c1', 'c4']) as s;
insert into public.follows (follower_id, followee_id, status) values (pg_temp.u('d3'), pg_temp.u('a1'), 'pending');
insert into public.follows (follower_id, followee_id, status) values (pg_temp.u('d1'), pg_temp.u('b2'), 'pending');
insert into public.follows (follower_id, followee_id, status, rerequest_after) values (pg_temp.u('d3'), pg_temp.u('b2'), 'pending', null);
update public.follows set status = 'rejected', rerequest_after = now() + interval '30 days' where follower_id = pg_temp.u('d3') and followee_id = pg_temp.u('b2');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('c5');
insert into public.blocked_users (blocker_id, blocked_id) values (pg_temp.u('d2'), pg_temp.u('c6'));

-- Public account: third parties see only public, active accounts
select is(pg_temp.walk('d1', 'get_followers', 'a1'), array['u_c1', 'u_c2', 'u_c3', 'u_c6'], 'a stranger sees public followers only: no private or suspended account');
select is((pg_temp.counts('d1', 'a1')->>'followers')::int, 4, 'and the count matches');
select is(pg_temp.walk('d2', 'get_followers', 'a1'), array['u_c1', 'u_c2', 'u_c3'], 'a viewer doesn''t see someone they have a block with');
select is((pg_temp.counts('d2', 'a1')->>'followers')::int, 3, 'and the count matches');
select is(pg_temp.walk('c6', 'get_followers', 'a1'), array['u_c1', 'u_c2', 'u_c3', 'u_c6'], 'c6 sees itself');
select is(pg_temp.walk('c4', 'get_followers', 'a1'), array['u_c1', 'u_c2', 'u_c3', 'u_c4', 'u_c6'], 'a private follower sees their own relationship');
select is((pg_temp.counts('c4', 'a1')->>'followers')::int, 5, 'and the count matches');

-- The owner sees exact accepted totals, and pending or rejected never count
select is(pg_temp.walk('a1', 'get_followers', 'a1'), array['u_c1', 'u_c2', 'u_c3', 'u_c4', 'u_c5', 'u_c6'], 'the owner sees every accepted follower');
select is((pg_temp.counts('a1', 'a1')->>'followers')::int, 6, 'and the exact total, which leaves out the pending request');
select is((pg_temp.counts('a1', 'a1')->>'following')::int, 2, 'the owner''s exact following count');
select is(pg_temp.walk('b2', 'get_followers', 'b2'), array['u_c1', 'u_c7'], 'a private owner sees accepted followers only');
select is((pg_temp.counts('b2', 'b2')->>'followers')::int, 2, 'pending and rejected aren''t counted');

-- Following: a private account's relationship isn't shown through the other side
select is(pg_temp.walk('d1', 'get_following', 'a1'), array['u_c1'], 'a stranger doesn''t see that a1 follows a private account');
select is((pg_temp.counts('d1', 'a1')->>'following')::int, 1, 'and the count matches');
select is(pg_temp.walk('a1', 'get_following', 'a1'), array['u_c1', 'u_c4'], 'the owner sees it');
select is(pg_temp.walk('c4', 'get_following', 'a1'), array['u_c1', 'u_c4'], 'and the private account itself sees it');
select is(pg_temp.walk('d1', 'get_following', 'c1'), array['u_a1'], 'a stranger doesn''t see c1''s follow of private b2');

-- Private account: strangers see nothing at all
select is(pg_temp.walk('d1', 'get_followers', 'b2'), '{}'::text[], 'a pending follower can''t list a private account');
select is(pg_temp.counts('d1', 'b2'), null, 'and gets no counts');
select is(pg_temp.walk('d3', 'get_followers', 'b2'), '{}'::text[], 'a rejected requester can''t either');
select is(pg_temp.counts('d3', 'b2'), null, 'and gets no counts');
select is(pg_temp.walk('d2', 'get_following', 'b2'), '{}'::text[], 'a stranger can''t list who a private account follows');
select is(pg_temp.walk('c7', 'get_followers', 'b2'), array['u_c1', 'u_c7'], 'an accepted follower can list a private account');
select is((pg_temp.counts('c7', 'b2')->>'followers')::int, 2, 'and the count matches');

-- A flip takes effect immediately, with nothing to repair
update public.profiles set follow_approval_required = true where id = pg_temp.u('c1');
select is((pg_temp.counts('d1', 'a1')->>'followers')::int, 3, 'an account going private leaves third-party counts at once');
select is(pg_temp.walk('d1', 'get_followers', 'a1'), array['u_c2', 'u_c3', 'u_c6'], 'and lists');
update public.profiles set follow_approval_required = false where id = pg_temp.u('c1');

-- Blocks and suspension for lists themselves
insert into public.blocked_users (blocker_id, blocked_id) values (pg_temp.u('a1'), pg_temp.u('d3'));
select is(pg_temp.walk('d3', 'get_followers', 'a1'), '{}'::text[], 'a blocked viewer can''t list');
select is(pg_temp.counts('d3', 'a1'), null, 'and gets no counts');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('d1');
select is(pg_temp.walk('d1', 'get_followers', 'a1'), '{}'::text[], 'a suspended viewer can''t list');
select is(pg_temp.counts('d1', 'a1'), null, 'and gets no counts');
update public.profiles set account_status = 'active' where id = pg_temp.u('d1');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('a1');
select is(pg_temp.walk('d1', 'get_followers', 'a1'), '{}'::text[], 'a suspended account can''t be listed');
select is((pg_temp.counts('a1', 'a1')->>'followers')::int, 6, 'but its owner still sees their own total');
update public.profiles set account_status = 'active' where id = pg_temp.u('a1');

-- Fields stay minimal
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pg_temp.rows('d2', format('select * from public.get_followers(%L)', pg_temp.u('a1')))->0) k),
  array['avatar_path', 'display_name', 'followed_at', 'handle', 'id'],
  'a list returns only card fields and the cursor'
);

-- Paging limits and cursors
select throws_ok(format('select pg_temp.rows(%L, %L)', 'd2', format('select * from public.get_followers(%L, 101)', pg_temp.u('a1'))), '22023', 'invalid page request', '101 rows per page is refused');
select throws_ok(format('select pg_temp.rows(%L, %L)', 'd2', format('select * from public.get_followers(%L, 0)', pg_temp.u('a1'))), '22023', 'invalid page request', '0 rows per page is refused');
select throws_ok(format('select pg_temp.rows(%L, %L)', 'd2', format('select * from public.get_followers(%L, -1)', pg_temp.u('a1'))), '22023', 'invalid page request', 'a negative page size is refused');
select throws_ok(format('select pg_temp.rows(%L, %L)', 'd2', format('select * from public.get_followers(%L, null)', pg_temp.u('a1'))), '22023', 'invalid page request', 'a null page size is refused');
select throws_ok(format('select pg_temp.rows(%L, %L)', 'd2', format('select * from public.get_followers(%L, 10, now())', pg_temp.u('a1'))), '22023', 'invalid page request', 'half a cursor is refused');
select is(jsonb_array_length(pg_temp.rows('d2', format('select * from public.get_followers(%L, 100)', pg_temp.u('a1')))), 3, '100 rows per page is allowed');
select is(jsonb_array_length(pg_temp.rows('d2', format('select * from public.get_followers(%L, 1)', pg_temp.u('a1')))), 1, 'the page size is respected');
select throws_ok(format($q$select pg_temp.rows('d2', 'select * from public.get_sent_follow_requests(101)')$q$), '22023', 'invalid page request', 'the sent list has the same limit');
select throws_ok(format($q$select pg_temp.rows('d2', 'select * from public.get_received_follow_requests(101)')$q$), '22023', 'invalid page request', 'the received list has the same limit');
select throws_ok(format($q$select pg_temp.rows('d2', 'select * from public.get_my_blocks(101)')$q$), '22023', 'invalid page request', 'the block list has the same limit');

-- All these rows share one timestamp in this transaction, so ties are tested: every
-- page size must return each row exactly once.
select is(pg_temp.walk('a1', 'get_followers', 'a1', 1), array['u_c1', 'u_c2', 'u_c3', 'u_c4', 'u_c5', 'u_c6'], 'one row per page: every row once, despite equal timestamps');
select is(pg_temp.walk('a1', 'get_followers', 'a1', 4), array['u_c1', 'u_c2', 'u_c3', 'u_c4', 'u_c5', 'u_c6'], 'four rows per page: every row once');

-- Newest first, by acceptance time
update public.follows set accepted_at = now() - interval '1 day' where follower_id = pg_temp.u('c1') and followee_id = pg_temp.u('a1');
select is(pg_temp.rows('a1', format('select * from public.get_followers(%L, 100)', pg_temp.u('a1')))->5->>'handle', 'u_c1', 'the oldest acceptance is last');

-- Queues
select is(pg_temp.rows('b2', 'select handle from public.get_received_follow_requests()')->0->>'handle', 'u_d1', 'an owner''s queue shows a pending requester');
select is(jsonb_array_length(pg_temp.rows('b2', 'select handle from public.get_received_follow_requests()')), 1, 'but not a rejected one');
select is(jsonb_array_length(pg_temp.rows('d1', 'select handle from public.get_received_follow_requests()')), 0, 'and nobody else''s');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('d1');
select is(jsonb_array_length(pg_temp.rows('b2', 'select handle from public.get_received_follow_requests()')), 0, 'a suspended requester leaves the queue');
update public.profiles set account_status = 'active' where id = pg_temp.u('d1');

-- Plans are inspected in supabase/benchmarks/m3_connections.sql
select is((select count(*)::int from pg_indexes where indexname in ('follows_followers_page_idx', 'follows_following_page_idx', 'follows_received_page_idx', 'follows_sent_page_idx')), 4, 'the paging indexes exist');
select hasnt_column('public', 'profiles', 'follower_count', 'no stored follower count');
select hasnt_column('public', 'profiles', 'following_count', 'no stored following count');

select * from finish();
rollback;
