-- M3: the follow-request state machine. now() is fixed within this transaction, so
-- cooldown boundaries are tested exactly. Races are in db-authorization-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(140);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;

-- Runs a statement and returns its result, or the error as text, so that an unexpected
-- error fails the named assertion instead of aborting the file.
create function pg_temp.try(p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  execute p_sql into r;
  return r;
exception when others then
  return 'error: ' || sqlerrm;
end $t$;

-- Runs one call as a signed-in user. A failure rolls the role back with it.
create function pg_temp.call(p_actor text, p_fn text, p_target text default null) returns text language plpgsql as $$
declare r text; v_sql text;
begin
  v_sql := format('select public.%I(%L)::text', p_fn, pg_temp.u(p_target));
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute v_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
end $$;

-- Runs a query as a signed-in user, and returns its rows.
create function pg_temp.rows(p_actor text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute format('select coalesce(jsonb_agg(t), ''[]'') from (%s) t', p_sql) into r;
  perform set_config('role', 'none', true);
  return r;
end $$;

create function pg_temp.st(p_from text, p_to text) returns text language sql as $$
  select coalesce((select f.status::text from public.follows f where f.follower_id = pg_temp.u(p_from) and f.followee_id = pg_temp.u(p_to)), 'none')
$$;
create function pg_temp.cool(p_from text, p_to text) returns timestamptz language sql as $$
  select f.rerequest_after from public.follows f where f.follower_id = pg_temp.u(p_from) and f.followee_id = pg_temp.u(p_to)
$$;

insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'a7', 'a8']) as s;
update public.profiles set handle = 'user_' || right(id::text, 2), handle_changed_at = now();
-- a1 is public, b2 is private. c3 to f6 are ordinary users.
update public.profiles set follow_approval_required = true where id = pg_temp.u('b2');
-- a7 has no handle, and a8 will be suspended.
update public.profiles set handle = null, handle_changed_at = null, handle_correction_until = null where id = pg_temp.u('a7');

-- Schema
select has_table('public', 'follows', 'follows exists');
select has_table('public', 'blocked_users', 'blocked_users exists');
select col_is_pk('public', 'follows', array['follower_id', 'followee_id'], 'one row per ordered pair');
select is((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'follow_status'), 'pending,accepted,rejected,cancelled', 'the four states exist');

-- Public account: an instant follow
select is(pg_temp.call('c3', 'get_follow_state', 'a1'), 'can_follow', 'a public account reads as can_follow');
select is(pg_temp.call('c3', 'request_follow', 'a1'), 'following', 'following a public account is immediate');
select is(pg_temp.st('c3', 'a1'), 'accepted', 'the row is accepted');
select is(pg_temp.call('c3', 'request_follow', 'a1'), 'following', 'repeating a follow is idempotent');
select is(pg_temp.call('c3', 'get_follow_state', 'a1'), 'following', 'the state reads as following');

-- Unfollow
select is(pg_temp.call('c3', 'unfollow', 'a1'), '', 'unfollow works');
select is(pg_temp.st('c3', 'a1'), 'none', 'unfollow leaves no row');
select lives_ok($$select pg_temp.call('c3', 'unfollow', 'a1')$$, 'repeating an unfollow is idempotent');
select is(pg_temp.call('c3', 'request_follow', 'a1'), 'following', 'following again after an unfollow is immediate');
select is(pg_temp.call('c3', 'unfollow', 'a1'), '', 'setup: unfollow');

-- Private account: a request
select is(pg_temp.call('c3', 'get_follow_state', 'b2'), 'can_request', 'a private account reads as can_request');
select is(pg_temp.call('c3', 'request_follow', 'b2'), 'requested', 'a request to a private account is pending');
select is(pg_temp.st('c3', 'b2'), 'pending', 'the row is pending');
select is(pg_temp.call('c3', 'request_follow', 'b2'), 'requested', 'repeating a request is idempotent');
select is((select count(*)::int from public.follows where follower_id = pg_temp.u('c3')), 1, 'repeats create no extra rows');
select is(pg_temp.call('c3', 'get_follow_state', 'b2'), 'requested', 'the state reads as requested');

-- Only the owner decides
select throws_ok($$select pg_temp.call('c3', 'accept_follow_request', 'c3')$$, 'P0001', 'request unavailable', 'a requester can not accept their own request');
select throws_ok($$select pg_temp.call('d4', 'accept_follow_request', 'c3')$$, 'P0001', 'request unavailable', 'a stranger can not accept someone else''s request');
select throws_ok($$select pg_temp.call('d4', 'reject_follow_request', 'c3')$$, 'P0001', 'request unavailable', 'a stranger can not reject someone else''s request');
select is(pg_temp.st('c3', 'b2'), 'pending', 'still pending after those attempts');

-- Accept
select is(pg_temp.call('b2', 'accept_follow_request', 'c3'), '', 'the owner accepts');
select is(pg_temp.st('c3', 'b2'), 'accepted', 'the row is accepted');
select lives_ok($$select pg_temp.call('b2', 'accept_follow_request', 'c3')$$, 'repeating an accept is idempotent');
select throws_ok($$select pg_temp.call('b2', 'reject_follow_request', 'c3')$$, 'P0001', 'request unavailable', 'an accepted follow can not be rejected');
select is(pg_temp.try($$select pg_temp.call('c3', 'cancel_follow_request', 'b2')$$), '', 'cancel on an accepted follow does nothing');
select is(pg_temp.st('c3', 'b2'), 'accepted', 'a cancel can not unfollow');
select ok((select accepted_at = now() from public.follows where follower_id = pg_temp.u('c3') and followee_id = pg_temp.u('b2')), 'accepted_at is recorded');

-- Reject: silent to the requester
select is(pg_temp.call('d4', 'request_follow', 'b2'), 'requested', 'setup: another request');
select is(pg_temp.call('b2', 'reject_follow_request', 'd4'), '', 'the owner rejects');
select is(pg_temp.st('d4', 'b2'), 'rejected', 'the row is rejected');
select is(pg_temp.cool('d4', 'b2'), now() + interval '30 days', 'the cooldown is exactly 30 days');
select is(pg_temp.call('d4', 'get_follow_state', 'b2'), 'requested', 'a rejection reads as requested');
select is(pg_temp.call('d4', 'request_follow', 'b2'), 'requested', 'a retry gets the same answer');
select is(pg_temp.st('d4', 'b2'), 'rejected', 'a retry stays rejected, so nothing becomes actionable');
select is(pg_temp.cool('d4', 'b2'), now() + interval '30 days', 'a retry doesn''t change the cooldown');
select lives_ok($$select pg_temp.call('b2', 'reject_follow_request', 'd4')$$, 'repeating a reject is idempotent');
-- now() is fixed in this transaction, so move the cooldown to see whether a repeat
-- would reset it.
update public.follows set rerequest_after = now() + interval '10 days' where follower_id = pg_temp.u('d4') and followee_id = pg_temp.u('b2');
select is(pg_temp.call('b2', 'reject_follow_request', 'd4'), '', 'setup: the owner rejects again');
select is(pg_temp.cool('d4', 'b2'), now() + interval '10 days', 'repeating a reject never extends the cooldown');
select is(pg_temp.call('d4', 'request_follow', 'b2'), 'requested', 'setup: the requester retries');
select is(pg_temp.cool('d4', 'b2'), now() + interval '10 days', 'a retry never extends the cooldown either');
update public.follows set rerequest_after = now() + interval '30 days' where follower_id = pg_temp.u('d4') and followee_id = pg_temp.u('b2');
select throws_ok($$select pg_temp.call('b2', 'accept_follow_request', 'd4')$$, 'P0001', 'request unavailable', 'a rejected request can not be accepted later');
select is((select count(*)::int from public.follows where follower_id = pg_temp.u('d4')), 1, 'retries create no extra rows');

-- The requester's views of pending and rejected are identical
select is(pg_temp.call('e5', 'request_follow', 'b2'), 'requested', 'setup: a truly pending request');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pg_temp.rows('d4', 'select * from public.get_sent_follow_requests()')->0) k),
  (select array_agg(k order by k) from jsonb_object_keys(pg_temp.rows('e5', 'select * from public.get_sent_follow_requests()')->0) k),
  'the sent list has the same fields for each'
);
select is(jsonb_array_length(pg_temp.rows('d4', 'select * from public.get_sent_follow_requests()')), 1, 'a rejected request stays on the requester''s sent list');
select is(pg_temp.rows('d4', 'select * from public.get_sent_follow_requests()')->0->>'handle', 'user_b2', 'naming the same target');
select is(pg_temp.call('e5', 'cancel_follow_request', 'b2'), '', 'setup: cancelled');

-- Cooldown can't be bypassed by cancelling
select is(pg_temp.call('d4', 'cancel_follow_request', 'b2'), '', 'the requester cancels');
select is(pg_temp.st('d4', 'b2'), 'cancelled', 'the row is cancelled');
select is(pg_temp.cool('d4', 'b2'), now() + interval '30 days', 'cancelling keeps the cooldown');
select is(pg_temp.call('d4', 'get_follow_state', 'b2'), 'can_request', 'after cancelling, it reads as can_request');
select is(pg_temp.call('d4', 'request_follow', 'b2'), 'requested', 'a retry looks like a real request');
select is(pg_temp.st('d4', 'b2'), 'rejected', 'but it goes straight back to rejected');
select is(pg_temp.cool('d4', 'b2'), now() + interval '30 days', 'and the cooldown is unchanged');
select is(pg_temp.rows('b2', 'select id from public.get_received_follow_requests()'), '[]'::jsonb, 'nothing reaches the owner''s queue');

-- Exact cooldown boundary, reached by a cancelled row
select is(pg_temp.call('d4', 'cancel_follow_request', 'b2'), '', 'setup: cancelled again');
update public.follows set rerequest_after = now() + interval '1 microsecond' where follower_id = pg_temp.u('d4') and followee_id = pg_temp.u('b2');
select is(pg_temp.call('d4', 'request_follow', 'b2'), 'requested', 'just inside the cooldown: same answer');
select is(pg_temp.st('d4', 'b2'), 'rejected', 'just inside the cooldown, it stays rejected');
select is(pg_temp.call('d4', 'cancel_follow_request', 'b2'), '', 'setup: cancelled again');
update public.follows set rerequest_after = now() where follower_id = pg_temp.u('d4') and followee_id = pg_temp.u('b2');
select is(pg_temp.call('d4', 'request_follow', 'b2'), 'requested', 'at the end of the cooldown: a real request');
select is(pg_temp.st('d4', 'b2'), 'pending', 'at the end of the cooldown, it''s actionable');
select is(pg_temp.cool('d4', 'b2'), null, 'the cooldown is cleared');

-- An expired rejection stays masked until the requester cancels
select is(pg_temp.call('b2', 'reject_follow_request', 'd4'), '', 'setup: rejected');
update public.follows set rerequest_after = now() - interval '1 day' where follower_id = pg_temp.u('d4') and followee_id = pg_temp.u('b2');
select is(pg_temp.call('d4', 'get_follow_state', 'b2'), 'requested', 'an expired rejection still reads as requested');
select is(pg_temp.call('d4', 'request_follow', 'b2'), 'requested', 'retrying an expired rejection without cancelling changes nothing');
select is(pg_temp.st('d4', 'b2'), 'rejected', 'it stays rejected');

-- Cancel a pending request: no cooldown
select is(pg_temp.call('e5', 'request_follow', 'b2'), 'requested', 'setup: pending');
select is(pg_temp.call('e5', 'cancel_follow_request', 'b2'), '', 'cancel a pending request');
select is(pg_temp.st('e5', 'b2'), 'cancelled', 'the row is cancelled');
select is(pg_temp.cool('e5', 'b2'), null, 'cancelling your own request starts no cooldown');
select lives_ok($$select pg_temp.call('e5', 'cancel_follow_request', 'b2')$$, 'repeating a cancel is idempotent');
select throws_ok($$select pg_temp.call('b2', 'accept_follow_request', 'e5')$$, 'P0001', 'request unavailable', 'a cancelled request can not be accepted');
select is(pg_temp.call('e5', 'request_follow', 'b2'), 'requested', 'requesting again after a cancel works');
select is(pg_temp.st('e5', 'b2'), 'pending', 'and it''s a real request, reusing the row');
select is((select count(*)::int from public.follows where follower_id = pg_temp.u('e5')), 1, 'still one row');

-- Remove a follower
select is(pg_temp.call('b2', 'remove_follower', 'c3'), '', 'the owner removes a follower');
select is(pg_temp.st('c3', 'b2'), 'cancelled', 'the row is cancelled');
select is(pg_temp.cool('c3', 'b2'), now() + interval '30 days', 'removal starts a 30-day cooldown');
select is((select accepted_at from public.follows where follower_id = pg_temp.u('c3') and followee_id = pg_temp.u('b2')), null, 'accepted_at is cleared');
select is(pg_temp.call('c3', 'get_follow_state', 'b2'), 'can_request', 'the removed follower reads as not following');
select is(pg_temp.call('c3', 'request_follow', 'b2'), 'requested', 'a retry looks like a real request');
select is(pg_temp.st('c3', 'b2'), 'rejected', 'but it''s silently refused');
select lives_ok($$select pg_temp.call('d4', 'remove_follower', 'c3')$$, 'removing someone who doesn''t follow you does nothing');
select is(pg_temp.st('c3', 'b2'), 'rejected', 'and can''t affect another account''s row');

-- Removal from a public account: no instant re-follow during the cooldown
select is(pg_temp.call('f6', 'request_follow', 'a1'), 'following', 'setup: following a public account');
select is(pg_temp.call('a1', 'remove_follower', 'f6'), '', 'a public account removes a follower');
select is(pg_temp.call('f6', 'request_follow', 'a1'), 'requested', 'an instant re-follow is refused during the cooldown');
select is(pg_temp.st('f6', 'a1'), 'rejected', 'it''s silently rejected');

-- Approval disabled while requests are pending
select is(pg_temp.st('e5', 'b2'), 'pending', 'setup: a pending request');
update public.profiles set follow_approval_required = false where id = pg_temp.u('b2');
select is(pg_temp.st('e5', 'b2'), 'pending', 'disabling approval leaves requests pending');
select is(pg_temp.call('e5', 'request_follow', 'b2'), 'requested', 'and repeating the request doesn''t accept it');
select is(pg_temp.st('d4', 'b2'), 'rejected', 'disabling approval doesn''t clear a rejection');
select is(pg_temp.call('b2', 'accept_follow_request', 'e5'), '', 'the owner can still accept it');
update public.profiles set follow_approval_required = true where id = pg_temp.u('b2');
select is(pg_temp.st('e5', 'b2'), 'accepted', 'enabling approval leaves accepted follows in place');

-- Who may act
select throws_ok($$select pg_temp.call('a1', 'request_follow', 'a1')$$, 'P0001', 'user unavailable', 'a self-follow is refused');
select lives_ok($$select set_config('request.jwt.claims', '', true)$$, 'setup: no signed-in user');
select throws_ok($$select public.request_follow('00000000-0000-0000-0000-0000000000a1')$$, '42501', 'account not eligible', 'a call with no user is refused');
select throws_ok($$select pg_temp.call('c3', 'request_follow', 'ff')$$, 'P0001', 'user unavailable', 'an unknown target is unavailable');
select throws_ok($$select pg_temp.call('c3', 'request_follow', 'a7')$$, 'P0001', 'user unavailable', 'an account with no handle is unavailable');
select throws_ok($$select pg_temp.call('a7', 'request_follow', 'a1')$$, '42501', 'account not eligible', 'an account with no handle can''t follow');
update auth.users set email_confirmed_at = null where id = pg_temp.u('f6');
select throws_ok($$select pg_temp.call('f6', 'request_follow', 'b2')$$, '42501', 'account not eligible', 'an unverified account can''t follow');
select throws_ok($$select pg_temp.call('f6', 'block_user', 'b2')$$, '42501', 'account not eligible', 'an unverified account can''t block');
update auth.users set email_confirmed_at = now() where id = pg_temp.u('f6');

-- Suspension: adding access is refused, and reducing it isn't
update public.profiles set account_status = 'suspended' where id = pg_temp.u('a8');
select throws_ok($$select pg_temp.call('a8', 'request_follow', 'a1')$$, '42501', 'account not eligible', 'a suspended account can''t follow');
select throws_ok($$select pg_temp.call('c3', 'request_follow', 'a8')$$, 'P0001', 'user unavailable', 'a suspended account can''t be followed');
update public.profiles set account_status = 'active' where id = pg_temp.u('a8');
select is(pg_temp.rows('a7', 'select id from public.get_received_follow_requests()'), '[]'::jsonb, 'a verified account with no handle can read its own empty queue');
update public.profiles set follow_approval_required = true where id = pg_temp.u('a8');
select is(pg_temp.call('c3', 'request_follow', 'a8'), 'requested', 'setup: a pending request to a8');
select is(pg_temp.call('d4', 'request_follow', 'a8'), 'requested', 'setup: another pending request to a8');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('a8');
select throws_ok($$select pg_temp.call('a8', 'accept_follow_request', 'c3')$$, '42501', 'account not eligible', 'a suspended owner can''t accept');
select is(pg_temp.call('a8', 'reject_follow_request', 'd4'), '', 'a suspended owner can reject');
select is(pg_temp.st('d4', 'a8'), 'rejected', 'and the rejection applies');
select is(pg_temp.call('c3', 'cancel_follow_request', 'a8'), '', 'a pending request to a suspended account can be cancelled');
update public.profiles set account_status = 'active' where id = pg_temp.u('a8');
select is(pg_temp.call('f6', 'request_follow', 'b2'), 'requested', 'setup: f6 requests');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('f6');
select throws_ok($$select pg_temp.call('b2', 'accept_follow_request', 'f6')$$, 'P0001', 'request unavailable', 'a suspended requester can''t be accepted, and the answer is generic');
update public.profiles set account_status = 'active' where id = pg_temp.u('f6');
select is(pg_temp.st('f6', 'b2'), 'pending', 'and the request is unchanged');
select is(pg_temp.call('f6', 'cancel_follow_request', 'b2'), '', 'setup: cancelled');

-- The database refuses illegal transitions, even from an operator
select is(pg_temp.st('a1', 'b2'), 'none', 'setup: no row');
insert into public.follows (follower_id, followee_id, status) values (pg_temp.u('a1'), pg_temp.u('b2'), 'pending');
select throws_ok($$insert into public.follows (follower_id, followee_id, status, rerequest_after) values (pg_temp.u('f6'), pg_temp.u('b2'), 'rejected', now())$$, '23514', 'invalid follow transition', 'a row can''t start rejected');
select throws_ok($$insert into public.follows (follower_id, followee_id, status) values (pg_temp.u('f6'), pg_temp.u('b2'), 'cancelled')$$, '23514', 'invalid follow transition', 'a row can''t start cancelled');
select throws_ok($$insert into public.follows (follower_id, followee_id, status) values (pg_temp.u('a1'), pg_temp.u('b2'), 'pending')$$, '23505', null, 'a duplicate pair is refused');
select throws_ok($$insert into public.follows (follower_id, followee_id, status) values (pg_temp.u('a1'), pg_temp.u('a1'), 'pending')$$, '23514', null, 'a self-follow row is refused');
select throws_ok($$update public.follows set followee_id = pg_temp.u('c3') where follower_id = pg_temp.u('a1')$$, '23514', 'invalid follow transition', 'a row can''t point at someone else');
select throws_ok($$update public.follows set status = 'accepted' where follower_id = pg_temp.u('a1') and followee_id = pg_temp.u('b2')$$, '23514', null, 'accepted needs accepted_at');
select throws_ok($$update public.follows set status = 'rejected' where follower_id = pg_temp.u('a1') and followee_id = pg_temp.u('b2')$$, '23514', null, 'rejected needs a cooldown');
update public.follows set status = 'accepted', accepted_at = now() where follower_id = pg_temp.u('a1') and followee_id = pg_temp.u('b2');
select throws_ok($$update public.follows set status = 'pending', accepted_at = null where follower_id = pg_temp.u('a1') and followee_id = pg_temp.u('b2')$$, '23514', 'invalid follow transition', 'accepted can''t go back to pending');
select throws_ok($$update public.follows set status = 'rejected', accepted_at = null, rerequest_after = now() where follower_id = pg_temp.u('a1') and followee_id = pg_temp.u('b2')$$, '23514', 'invalid follow transition', 'accepted can''t go to rejected');
update public.follows set status = 'cancelled', accepted_at = null where follower_id = pg_temp.u('a1') and followee_id = pg_temp.u('b2');
update public.follows set status = 'rejected', rerequest_after = now() where follower_id = pg_temp.u('a1') and followee_id = pg_temp.u('b2');
select throws_ok($$update public.follows set status = 'pending', rerequest_after = null where follower_id = pg_temp.u('a1') and followee_id = pg_temp.u('b2')$$, '23514', 'invalid follow transition', 'rejected can''t go to pending');
select throws_ok($$update public.follows set status = 'accepted', accepted_at = now(), rerequest_after = null where follower_id = pg_temp.u('a1') and followee_id = pg_temp.u('b2')$$, '23514', 'invalid follow transition', 'rejected can''t go to accepted');

-- Request limit: 200 outstanding, counting rejected, which reads the same as pending
create temp table cap_users as select gen_random_uuid() as id, g from generate_series(1, 201) g;
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select id, 'authenticated', 'authenticated', 'cap' || g || '@example.test', now(), '00000000-0000-0000-0000-000000000000' from cap_users;
update public.profiles p set handle = 'cap_' || c.g, handle_changed_at = now(), follow_approval_required = true from cap_users c where c.id = p.id;
insert into public.follows (follower_id, followee_id, status) select pg_temp.u('a8'), id, 'pending' from cap_users where g <= 199;
update public.follows set status = 'rejected', rerequest_after = now() + interval '30 days' where follower_id = pg_temp.u('a8') and followee_id in (select id from cap_users where g <= 50);
create function pg_temp.call_cap(p_actor text, p_g int) returns text language plpgsql as $$
declare r text; t uuid;
begin
  select id into t from cap_users where g = p_g;
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute format('select public.request_follow(%L)', t) into r;
  perform set_config('role', 'none', true);
  return r;
end $$;
select is(pg_temp.call_cap('a8', 200), 'requested', 'request number 200 is allowed');
select throws_ok($$select pg_temp.call_cap('a8', 201)$$, 'P0001', 'too many outstanding follow requests', 'request number 201 is refused');
select is(pg_temp.call_cap('a8', 200), 'requested', 'repeating an existing request is still idempotent at the limit');
select is(pg_temp.call('a8', 'request_follow', 'a1'), 'following', 'an instant follow of a public account isn''t limited');
update public.follows set status = 'cancelled' where follower_id = pg_temp.u('a8') and followee_id = (select id from cap_users where g = 1);
select is((select count(*)::int from public.follows where follower_id = pg_temp.u('a8') and status in ('pending', 'rejected')), 199, 'cancelling frees a place');
select is(pg_temp.call_cap('a8', 201), 'requested', 'and another request is allowed');

-- Deletion removes rows, in both directions
select cmp_ok((select count(*)::int from public.follows where follower_id = pg_temp.u('d4') or followee_id = pg_temp.u('d4')), '>', 0, 'setup: d4 has rows');
delete from auth.users where id = pg_temp.u('d4');
select is((select count(*)::int from public.follows where follower_id = pg_temp.u('d4') or followee_id = pg_temp.u('d4')), 0, 'deleting an account removes its rows, including rejection history');
select throws_ok($$select pg_temp.call('d4', 'request_follow', 'a1')$$, '42501', 'account not eligible', 'a deleted user''s token can''t act');

select * from finish();
rollback;
