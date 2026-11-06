-- Measures follower lists, counts and profile cards on a representative dataset, with
-- query plans. Runs in one transaction that always rolls back, on the local stack only:
--
--   docker exec -i supabase_db_my-game-dex psql -U postgres -d postgres -X < supabase/benchmarks/m3_connections.sql
--
-- 50,000 accounts, 20% private. About 500,000 relationships, including one account with
-- 50,000 followers and one with 5,000. Each measurement runs three times, to include a
-- warm result.
\pset format unaligned
\pset tuples_only on
\set ON_ERROR_STOP on
begin;

create temp table ids as select gen_random_uuid() as id, g as n from generate_series(1, 50000) g;
create index on ids (n);
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select id, 'authenticated', 'authenticated', 'bench' || n || '@example.test', now(), '00000000-0000-0000-0000-000000000000' from ids;
update public.profiles p set handle = 'bench_' || i.n, handle_changed_at = now(), follow_approval_required = (i.n % 5 = 0) from ids i where i.id = p.id;

-- n=1 has 50,000 followers, n=2 has 5,000, n=3 is private with 5,000
insert into public.follows (follower_id, followee_id, status, accepted_at, requested_at)
select i.id, (select id from ids where n = 1), 'accepted', now() - (i.n || ' seconds')::interval, now() from ids i where i.n <> 1;
insert into public.follows (follower_id, followee_id, status, accepted_at, requested_at)
select i.id, (select id from ids where n = 2), 'accepted', now() - (i.n || ' seconds')::interval, now() from ids i where i.n between 3 and 5002;
update public.profiles set follow_approval_required = true where id = (select id from ids where n = 3);
insert into public.follows (follower_id, followee_id, status, accepted_at, requested_at)
select i.id, (select id from ids where n = 3), 'accepted', now() - (i.n || ' seconds')::interval, now() from ids i where i.n between 4 and 5003;
-- Everyone follows about nine others
insert into public.follows (follower_id, followee_id, status, accepted_at, requested_at)
select a.id, b.id, 'accepted', now() - (s || ' minutes')::interval, now()
from ids a cross join generate_series(1, 9) s join ids b on b.n = 4 + ((a.n * 7 + s * 131) % 49990) where a.id <> b.id
on conflict do nothing;
-- Some pending requests and blocks
insert into public.follows (follower_id, followee_id, status, requested_at)
select a.id, (select id from ids where n = 4), 'pending', now() - (a.n || ' seconds')::interval from ids a where a.n between 6000 and 7000 on conflict do nothing;
insert into public.blocked_users (blocker_id, blocked_id)
select a.id, b.id from ids a join ids b on b.n = 1 + (a.n * 13 % 50000) where a.n % 10 = 0 and a.id <> b.id on conflict do nothing;
analyze public.follows;
analyze public.blocked_users;
analyze public.profiles;

select 'accounts', count(*) from ids;
select 'relationships', count(*) from public.follows;
select 'accepted', count(*) from public.follows where status = 'accepted';
select 'blocks', count(*) from public.blocked_users;

-- The viewer is an active, public account in no special relationship.
select id as viewer from ids where n = 49999 \gset
select id as big from ids where n = 1 \gset
select id as mid from ids where n = 2 \gset
select id as priv from ids where n = 3 \gset
select id as queue from ids where n = 4 \gset
select set_config('request.jwt.claims', json_build_object('sub', :'viewer', 'role', 'authenticated')::text, true);

create temp table cursor_row as select accepted_at, follower_id from public.follows where followee_id = :'big' and status = 'accepted' order by accepted_at desc, follower_id desc offset 40000 limit 1;
select accepted_at as at40k, follower_id as id40k from cursor_row \gset

set local role authenticated;
\timing on
\echo == first page of 50 from 50,000 followers
select count(*) from public.get_followers(:'big', 50);
select count(*) from public.get_followers(:'big', 50);
select count(*) from public.get_followers(:'big', 50);
\echo == maximum page of 100
select count(*) from public.get_followers(:'big', 100);
\echo == a page 40,000 rows in, by keyset cursor
select count(*) from public.get_followers(:'big', 50, :'at40k', :'id40k');
select count(*) from public.get_followers(:'big', 50, :'at40k', :'id40k');
\echo == following list
select count(*) from public.get_following(:'viewer', 50);
\echo == counts on 50,000 followers
select * from public.get_profile_counts(:'big');
select * from public.get_profile_counts(:'big');
select * from public.get_profile_counts(:'big');
\echo == counts on 5,000 followers
select * from public.get_profile_counts(:'mid');
select * from public.get_profile_counts(:'mid');
\echo == counts for a typical account
select * from public.get_profile_counts(:'viewer');
\echo == private account, not permitted: no row
select count(*) from public.get_profile_counts(:'priv');
\echo == follow state
select public.get_follow_state(:'big');
select public.get_follow_state(:'priv');
\echo == 50 profile cards, through the RLS block check
select count(*) from (select id from public.profiles limit 50) x;
select count(*) from (select id from public.profiles limit 50) x;
\echo == a card by handle
select count(*) from public.profiles where handle = 'bench_123';
\echo == handle search over cards
select count(*) from public.profiles where handle like 'bench_123%';
reset role;
\timing off

select set_config('request.jwt.claims', json_build_object('sub', :'queue', 'role', 'authenticated')::text, true);
set local role authenticated;
\timing on
\echo == owner queue of about 1,000 pending requests
select count(*) from public.get_received_follow_requests(50);
\timing off
reset role;

\echo == plan: follower page, the query inside get_followers
explain (analyze, buffers, timing off, summary on)
select o.id from public.follows f join public.profiles o on o.id = f.follower_id
where f.followee_id = :'big' and f.status = 'accepted'
  and (f.accepted_at, f.follower_id) < ('infinity'::timestamptz, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
  and (o.handle is not null and o.account_status = 'active' and o.follow_approval_required is false)
order by f.accepted_at desc, f.follower_id desc limit 50;

\echo == plan: a page 40,000 rows in
explain (analyze, buffers, timing off, summary on)
select o.id from public.follows f join public.profiles o on o.id = f.follower_id
where f.followee_id = :'big' and f.status = 'accepted'
  and (f.accepted_at, f.follower_id) < (:'at40k'::timestamptz, :'id40k'::uuid)
  and (o.handle is not null and o.account_status = 'active' and o.follow_approval_required is false)
order by f.accepted_at desc, f.follower_id desc limit 50;

\echo == plan: follower count
explain (analyze, buffers, timing off, summary on)
select count(*) from public.follows f join public.profiles o on o.id = f.follower_id
where f.followee_id = :'big' and f.status = 'accepted'
  and (o.handle is not null and o.account_status = 'active' and o.follow_approval_required is false);

rollback;
\echo == rolled back
