-- M0: private.uuid_v7(). Decodes the bytes directly: PostgreSQL 17 has no
-- max(uuid), and its uuid_extract_timestamp() doesn't decode version 7.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

create function pg_temp.uuid_ms(u uuid) returns bigint language sql immutable as
  $$ select ('x' || encode(substring(uuid_send(u) from 1 for 6), 'hex'))::bit(48)::bigint $$;
create function pg_temp.uuid_version(u uuid) returns int language sql immutable as
  $$ select get_byte(uuid_send(u), 6) >> 4 $$;
create function pg_temp.uuid_variant(u uuid) returns int language sql immutable as
  $$ select get_byte(uuid_send(u), 8) >> 6 $$;

-- Function properties
select is((select provolatile::text from pg_proc where oid = 'private.uuid_v7()'::regprocedure), 'v', 'uuid_v7 is volatile');
select is((select prosecdef from pg_proc where oid = 'private.uuid_v7()'::regprocedure), false, 'uuid_v7 is not SECURITY DEFINER');
select is((select proconfig from pg_proc where oid = 'private.uuid_v7()'::regprocedure), array['search_path=""'], 'uuid_v7 pins an empty search_path');
select is(has_function_privilege('anon', 'private.uuid_v7()', 'execute'), false, 'anon can not execute uuid_v7 by default');

-- Version, variant and uniqueness across a large sample
create temp table sample as select n, private.uuid_v7() as u from generate_series(1, 20000) n;
select is((select count(*)::int from sample), 20000, 'generated 20000 ids');
select is((select count(distinct u)::int from sample), 20000, 'all 20000 ids are unique');
select is((select count(*)::int from sample where pg_temp.uuid_version(u) <> 7), 0, 'every id is version 7');
select is((select count(*)::int from sample where pg_temp.uuid_variant(u) <> 2), 0, 'every id has the RFC 9562 variant');

-- The embedded timestamp matches the clock
do $$
declare before_ms bigint; after_ms bigint; id uuid;
begin
  before_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  id := private.uuid_v7();
  after_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  create temp table clock_check as select pg_temp.uuid_ms(id) between before_ms and after_ms as in_range;
end $$;
select ok((select in_range from clock_check), 'the first 48 bits are the current Unix time in milliseconds');

-- Across distinct milliseconds, ids sort by time
create temp table spaced (n int, u uuid);
do $$
begin
  for i in 1..100 loop
    insert into spaced values (i, private.uuid_v7());
    perform pg_sleep(0.002);
  end loop;
end $$;
create temp view spaced_pairs as
  select u, lag(u) over (order by n) as prev from spaced;
select is((select count(*)::int from spaced_pairs where prev is not null and pg_temp.uuid_ms(u) <= pg_temp.uuid_ms(prev)), 0, 'ids generated in later milliseconds have later timestamps');
select is((select count(*)::int from spaced_pairs where prev is not null and u <= prev), 0, 'ids generated in later milliseconds sort after earlier ones');
select is(
  array(select u from spaced order by u),
  array(select u from spaced order by n),
  'sorting by id gives creation order when milliseconds differ'
);

-- Within one millisecond: unique, but not ordered. Never assume strict monotonic.
create temp view same_ms as
  select u, lag(u) over (order by n) as prev, pg_temp.uuid_ms(u) as ms, lag(pg_temp.uuid_ms(u)) over (order by n) as prev_ms from sample;
select cmp_ok((select count(*)::int from same_ms where ms = prev_ms), '>', 0, 'the sample contains ids generated in the same millisecond');
select cmp_ok((select count(*)::int from same_ms where ms = prev_ms and u < prev), '>', 0, 'order within one millisecond is not monotonic, so nothing may rely on it');

-- Column default use, as later tables will need it
create table public.__d (id uuid primary key default private.uuid_v7(), note text);
grant insert on public.__d to authenticated;
set local role authenticated;
select throws_ok($$insert into public.__d (note) values ('x')$$, '42501', null, 'a default using uuid_v7 needs EXECUTE for the inserting role');
reset role;
grant execute on function private.uuid_v7() to authenticated;
set local role authenticated;
select lives_ok($$insert into public.__d (note) values ('x')$$, 'with EXECUTE granted, the default works without USAGE on private');
reset role;

select * from finish();
rollback;
