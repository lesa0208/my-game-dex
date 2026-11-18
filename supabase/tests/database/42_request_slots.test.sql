-- M11a-4a: per-account request limits (take_request_slot). Each caller counts only
-- against themselves, the kinds and limits are fixed, a refusal isn't counted, and no
-- client reaches the table. Runs in one transaction that rolls back, on a local stack only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
-- A password session (aal1), as Auth creates one at sign-in: since the session-revocation
-- checkpoint, owner-scoped reads and writes need the token's session to exist.
create function pg_temp.plain(p_user uuid) returns jsonb language plpgsql as $plain$
declare v_session uuid := md5('plain:' || p_user::text)::uuid;
begin
  if exists (select 1 from auth.users where id = p_user) then
    insert into auth.sessions (id, user_id, aal, created_at, updated_at) values (v_session, p_user, 'aal1', now(), now()) on conflict (id) do nothing;
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1', 'session_id', v_session);
end $plain$;
create function pg_temp.run(p_role text, p_claims jsonb, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', p_claims::text, true);
  perform set_config('role', p_role, true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language sql as $$
  select pg_temp.run('authenticated', pg_temp.plain(pg_temp.u(p_actor)), p_sql) $$;
create function pg_temp.take(p_actor text, p_kind text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.take_request_slot(%L)::text', p_kind)) $$;

insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', 'slot-' || s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'b1', 'c1']) s;

-- Grants and definition.
select ok(has_function_privilege('authenticated', 'public.take_request_slot(text)', 'execute'), 'signed-in users may take a slot');
select ok(not has_function_privilege('anon', 'public.take_request_slot(text)', 'execute'), 'anon may not');
select ok(not has_function_privilege('service_role', 'public.take_request_slot(text)', 'execute'), 'nor the server key, which has no account');
select ok(not has_table_privilege('authenticated', 'private.request_slots', 'select'), 'no client reads the counts');
select ok(not has_table_privilege('authenticated', 'private.request_slots', 'insert') and not has_table_privilege('authenticated', 'private.request_slots', 'delete'), 'or changes them');
select is((select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'public.take_request_slot(text)'::regprocedure), true, 'a definer with an empty search_path');

-- Export: three an hour.
select is(pg_temp.take('a1', 'data_export'), '{"allowed": true}', 'the first export is allowed');
select pg_temp.take('a1', 'data_export');
select is(pg_temp.take('a1', 'data_export'), '{"allowed": true}', 'and the third');
select ok((pg_temp.take('a1', 'data_export'))::jsonb ->> 'allowed' = 'false' and ((pg_temp.take('a1', 'data_export'))::jsonb ->> 'retry_at')::timestamptz > now(), 'the fourth is refused, with when to try again');
select is((select count(*)::int from private.request_slots where user_id = pg_temp.u('a1') and kind = 'data_export'), 3, 'refusals aren''t counted');

-- Each account and kind counts on its own.
select is(pg_temp.take('b1', 'data_export'), '{"allowed": true}', 'another account has its own count');
select is(pg_temp.take('a1', 'avatar_upload'), '{"allowed": true}', 'and another kind');
select ok((select bool_and(pg_temp.take('c1', 'avatar_upload')::jsonb ->> 'allowed' = 'true') from generate_series(1, 10)) and pg_temp.take('c1', 'avatar_upload')::jsonb ->> 'allowed' = 'false', 'ten photo uploads an hour, then a refusal');

-- Times older than the window are removed and free their slot.
update private.request_slots set taken_at = now() - interval '61 minutes' where user_id = pg_temp.u('a1') and kind = 'data_export';
select is(pg_temp.take('a1', 'data_export'), '{"allowed": true}', 'an hour later a slot is free again');
select is((select count(*)::int from private.request_slots where user_id = pg_temp.u('a1') and kind = 'data_export'), 1, 'and the old times are gone');

-- Refusals.
select is(pg_temp.take('a1', 'anything'), 'error: invalid kind', 'only the fixed kinds');
select is(pg_temp.run('anon', '{"role": "anon"}', $$select public.take_request_slot('data_export')::text$$), 'error: permission denied for function take_request_slot', 'signed out, refused');

select * from finish();
rollback;
