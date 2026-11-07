-- M4b: notifications, their creation from follow, block and status changes,
-- preferences, visibility and the client functions. Races are in db-notification-checks.mjs.
--
-- Everything here runs in one transaction, so now() never moves. Tests that need an
-- older notification move its times back explicitly.
begin;
create extension if not exists pgtap with schema extensions;
select plan(75);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated;

-- Runs a statement as a signed-in user and returns its result, or the error as text.
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  return 'error: ' || sqlerrm;
end $t$;

-- Notifications for a recipient, optionally from one actor and of one type.
create function pg_temp.n(p_recipient text, p_actor text default null, p_type text default null) returns int language sql as $$
  select count(*)::int from public.notifications
  where recipient_id = pg_temp.u(p_recipient)
    and (p_actor is null or actor_id = pg_temp.u(p_actor))
    and (p_type is null or type::text = p_type)
$$;
create function pg_temp.between_pair(p_one text, p_other text) returns int language sql as $$
  select count(*)::int from public.notifications
  where (recipient_id = pg_temp.u(p_one) and actor_id = pg_temp.u(p_other))
     or (recipient_id = pg_temp.u(p_other) and actor_id = pg_temp.u(p_one))
$$;
create function pg_temp.visible(p_user text) returns int language sql as $$
  select pg_temp.as_user(p_user, 'select count(*)::text from public.get_my_notifications(100)')::int
$$;
create function pg_temp.unread(p_user text) returns int language sql as $$
  select pg_temp.as_user(p_user, 'select public.get_unread_notification_count()::text')::int
$$;

-- a1, d4, a7: followers. b2: public account. c3: private account (approval required).
-- e5: administrator. f6: unverified email. b8: paging and limits.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', case when s = 'f6' then null else now() end, '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'a7', 'b8']) as s;
update public.profiles set handle = 'user_' || right(id::text, 2), handle_changed_at = now() where id in (select pg_temp.u(s) from unnest(array['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'a7', 'b8']) s);
update public.profiles set follow_approval_required = true where id = pg_temp.u('c3');
insert into public.staff_roles (user_id, role) values (pg_temp.u('e5'), 'admin');

-- ---------------------------------------------------------------------------
-- Schema and access
-- ---------------------------------------------------------------------------
select has_table('public', 'notifications', 'notifications exists');
select is((select relrowsecurity from pg_class where oid = 'public.notifications'::regclass), true, 'notifications has RLS on');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'notifications'), 0, 'notifications has no policies');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
  where has_table_privilege(r, 'public.notifications', p)), 0, 'no API role has any privilege on notifications');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array[
    'private.notify(uuid,uuid,public.notification_type,timestamptz,jsonb)', 'private.notify_follow_change()',
    'private.remove_notifications_on_block()', 'private.notify_account_status_change()']) f
  where has_function_privilege(r, f, 'execute')), 0, 'no API role can execute a notification helper');
select is((select count(*)::int from unnest(array['anon', 'service_role']) r, unnest(array[
    'public.get_my_notifications(integer,uuid)', 'public.get_unread_notification_count()', 'public.mark_notifications_read(uuid)', 'public.delete_notification(uuid)']) f
  where has_function_privilege(r, f, 'execute')), 0, 'anon and service_role can execute no notification function');
select is((select count(*)::int from unnest(array[
    'public.get_my_notifications(integer,uuid)', 'public.get_unread_notification_count()', 'public.mark_notifications_read(uuid)', 'public.delete_notification(uuid)']) f
  where has_function_privilege('authenticated', f, 'execute')), 4, 'signed-in users can execute the four notification functions');
select is((select count(*)::int from pg_constraint where conrelid = 'public.notifications'::regclass and contype = 'f' and confdeltype = 'c'), 2,
  'deleting the recipient or the actor deletes the notification');
select is((select count(*)::int from pg_trigger where not tgisinternal and tgenabled = 'O'
  and tgname in ('notify_follow_change', 'remove_notifications_on_block', 'notify_account_status_change')), 3, 'the three notification triggers are enabled');
select ok((select bool_and(position('for key share' in prosrc) between 1 and position('for update' in prosrc))
  from pg_proc where oid in ('public.request_follow(uuid)'::regprocedure, 'public.accept_follow_request(uuid)'::regprocedure)),
  'request_follow and accept_follow_request lock both accounts before the follow row');

-- ---------------------------------------------------------------------------
-- Follows of a public account
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('a1', format('select public.request_follow(%L)', pg_temp.u('b2'))), 'following', 'a1 follows the public account b2');
select is((select count(*)::int from public.notifications n join public.follows f on f.follower_id = n.actor_id and f.followee_id = n.recipient_id
  where n.recipient_id = pg_temp.u('b2') and n.actor_id = pg_temp.u('a1') and n.type = 'follow' and n.event_at = f.accepted_at and n.read_at is null and n.data = '{}'),
  1, 'b2 gets one unread follow notice, keyed to the time of the follow');
-- now() is fixed within this test's transaction, so move the first event back an hour.
-- Otherwise the event key alone would hide a missing 24-hour window.
update public.notifications set event_at = event_at - interval '1 hour' where recipient_id = pg_temp.u('b2') and type = 'follow';
select pg_temp.as_user('a1', format('select public.unfollow(%L)', pg_temp.u('b2')));
select pg_temp.as_user('a1', format('select public.request_follow(%L)', pg_temp.u('b2')));
select is(pg_temp.n('b2', 'a1', 'follow'), 1, 'following again within 24 hours sends no second notice');
update public.notifications set created_at = created_at - interval '25 hours', event_at = event_at - interval '25 hours' where recipient_id = pg_temp.u('b2');
select pg_temp.as_user('a1', format('select public.unfollow(%L)', pg_temp.u('b2')));
select pg_temp.as_user('a1', format('select public.request_follow(%L)', pg_temp.u('b2')));
select is(pg_temp.n('b2', 'a1', 'follow'), 2, 'after 24 hours, following again notifies again');
select private.notify(pg_temp.u('a1'), pg_temp.u('b2'), 'follow_accepted', '2026-01-01 00:00:00+00');
select private.notify(pg_temp.u('a1'), pg_temp.u('b2'), 'follow_accepted', '2026-01-01 00:00:00+00');
select is(pg_temp.n('a1', 'b2', 'follow_accepted'), 1, 'the same event recorded twice is stored once');
select throws_ok(
  format($$insert into public.notifications (recipient_id, actor_id, type, event_at) values (%L, %L, 'follow_accepted', '2026-01-01 00:00:00+00')$$, pg_temp.u('a1'), pg_temp.u('b2')),
  '23505', null, 'the event key refuses a duplicate even from the owner');
delete from public.notifications where recipient_id = pg_temp.u('a1');

-- ---------------------------------------------------------------------------
-- Requests to a private account
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('a1', format('select public.request_follow(%L)', pg_temp.u('c3'))), 'requested', 'a1 requests to follow c3');
select is((select count(*)::int from public.notifications n join public.follows f on f.follower_id = n.actor_id and f.followee_id = n.recipient_id
  where n.recipient_id = pg_temp.u('c3') and n.actor_id = pg_temp.u('a1') and n.type = 'follow_request' and n.event_at = f.requested_at),
  1, 'c3 gets one request notice, keyed to the time of the request');
select pg_temp.as_user('a1', format('select public.cancel_follow_request(%L)', pg_temp.u('c3')));
select is(pg_temp.n('c3', 'a1', 'follow_request'), 0, 'cancelling withdraws the request notice');
select pg_temp.as_user('a1', format('select public.request_follow(%L)', pg_temp.u('c3')));
select is(pg_temp.n('c3', 'a1', 'follow_request'), 1, 'requesting again sends a new request notice');
select pg_temp.as_user('c3', format('select public.reject_follow_request(%L)', pg_temp.u('a1')));
select is(pg_temp.n('c3', 'a1', 'follow_request'), 0, 'rejecting withdraws the request notice');
select is(pg_temp.as_user('a1', format('select public.request_follow(%L)', pg_temp.u('c3'))), 'requested', 'a retry during the cooldown still reads as requested');
select pg_temp.as_user('a1', format('select public.request_follow(%L)', pg_temp.u('c3')));
select is(pg_temp.n('c3', 'a1'), 0, 'retries during a rejection cooldown notify nobody');

select pg_temp.as_user('a7', format('select public.request_follow(%L)', pg_temp.u('b2')));
select pg_temp.as_user('b2', format('select public.remove_follower(%L)', pg_temp.u('a7')));
select is(pg_temp.as_user('a7', format('select public.request_follow(%L)', pg_temp.u('b2'))), 'requested', 'a retry after removal reads as requested');
select is((select status::text from public.follows where follower_id = pg_temp.u('a7') and followee_id = pg_temp.u('b2')), 'rejected', 'the retry is recorded as rejected');
select is(pg_temp.n('b2', 'a7'), 1, 'a retry during a removal cooldown adds no notice');

-- ---------------------------------------------------------------------------
-- Accepting
-- ---------------------------------------------------------------------------
select pg_temp.as_user('d4', format('select public.request_follow(%L)', pg_temp.u('c3')));
select is(pg_temp.as_user('c3', format('select public.accept_follow_request(%L)', pg_temp.u('d4'))), '', 'c3 accepts d4');
select is(pg_temp.n('c3', 'd4', 'follow_request'), 0, 'accepting withdraws the request notice');
select is((select count(*)::int from public.notifications n join public.follows f on f.follower_id = n.recipient_id and f.followee_id = n.actor_id
  where n.recipient_id = pg_temp.u('d4') and n.actor_id = pg_temp.u('c3') and n.type = 'follow_accepted' and n.event_at = f.accepted_at),
  1, 'd4 is told the request was accepted, keyed to the time of acceptance');
select pg_temp.as_user('c3', format('select public.accept_follow_request(%L)', pg_temp.u('d4')));
select is(pg_temp.n('d4', 'c3'), 1, 'accepting again sends nothing more');
select is(pg_temp.n('c3', 'd4'), 0, 'the accepting account gets no follow notice of its own');

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('b2', $$update public.user_preferences set notification_settings = '{"follow": false}' where user_id = (select auth.uid()) returning ''$$), '', 'b2 turns follow notices off');
select pg_temp.as_user('d4', format('select public.request_follow(%L)', pg_temp.u('b2')));
select is(pg_temp.n('b2', 'd4'), 0, 'a type turned off stores nothing');
select pg_temp.as_user('b2', $$update public.user_preferences set notification_settings = '{}' where user_id = (select auth.uid()) returning ''$$);
select is(pg_temp.n('b2', 'd4'), 0, 'turning it back on brings nothing back');
select matches(pg_temp.as_user('b2', $$update public.user_preferences set notification_settings = '{"moderation": false}' where user_id = (select auth.uid()) returning ''$$),
  'user_preferences_notification_settings_valid', 'moderation notices can not be turned off');
select matches(pg_temp.as_user('b2', $$update public.user_preferences set notification_settings = '{"follow": "no"}' where user_id = (select auth.uid()) returning ''$$),
  'user_preferences_notification_settings_valid', 'a preference must be true or false');
select matches(pg_temp.as_user('b2', $$update public.user_preferences set notification_settings = '{"like": true}' where user_id = (select auth.uid()) returning ''$$),
  'user_preferences_notification_settings_valid', 'only the three follow types can be set');
select is(pg_temp.as_user('b2', $$update public.user_preferences set notification_settings = '{"follow_request": false, "follow_accepted": true}' where user_id = (select auth.uid()) returning ''$$),
  '', 'valid preferences are accepted');
select pg_temp.as_user('c3', $$update public.user_preferences set notification_settings = '{"follow_request": false}' where user_id = (select auth.uid()) returning ''$$);
select pg_temp.as_user('b8', format('select public.request_follow(%L)', pg_temp.u('c3')));
select is(pg_temp.n('c3', 'b8'), 0, 'request notices can be turned off');
select pg_temp.as_user('b8', format('select public.cancel_follow_request(%L)', pg_temp.u('c3')));
select pg_temp.as_user('c3', $$update public.user_preferences set notification_settings = '{}' where user_id = (select auth.uid()) returning ''$$);

-- ---------------------------------------------------------------------------
-- Moderation notices
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('e5', format($$select public.set_account_status(%L, 'suspended', 'Internal staff reason XYZ')$$, pg_temp.u('a7'))), 'true', 'e5 suspends a7');
select is((select count(*)::int from public.notifications where recipient_id = pg_temp.u('a7') and type = 'moderation' and actor_id is null and data = '{"status": "suspended"}'),
  1, 'a7 gets a moderation notice that names no actor');
select is((select count(*)::int from public.notifications where data::text like '%XYZ%'), 0, 'no notice contains the staff reason');
select is(pg_temp.as_user('a7', $$select string_agg(type || ':' || coalesce(actor_id::text, '-') || ':' || data::text, ',') from public.get_my_notifications()$$),
  'moderation:-:{"status": "suspended"}', 'the suspended account can read its notice');
select pg_temp.as_user('e5', format($$select public.set_account_status(%L, 'active', 'Reinstated')$$, pg_temp.u('a7')));
select is((select string_agg(data ->> 'status', ',' order by id) from public.notifications where recipient_id = pg_temp.u('a7') and type = 'moderation'),
  'suspended,active', 'reinstatement notifies too');
update public.profiles set account_status = 'deactivated' where id = pg_temp.u('b8');
update public.profiles set account_status = 'active' where id = pg_temp.u('b8');
select is(pg_temp.n('b8'), 0, 'deactivation is not a moderation notice');
select throws_ok(
  format($$insert into public.notifications (recipient_id, type, data) values (%L, 'moderation', '{"status": "suspended", "reason": "x"}')$$, pg_temp.u('b8')),
  '23514', null, 'a moderation notice can hold nothing but the status');
select throws_ok(
  format($$insert into public.notifications (recipient_id, type, event_at) values (%L, 'follow', now())$$, pg_temp.u('b8')),
  '23514', null, 'a follow notice needs an actor');
select throws_ok(
  format($$insert into public.notifications (recipient_id, actor_id, type, event_at) values (%L, %L, 'follow', now())$$, pg_temp.u('b8'), pg_temp.u('b8')),
  '23514', null, 'nobody is notified about themselves');
select throws_ok(
  format($$insert into public.notifications (recipient_id, actor_id, type, event_at) values (%L, %L, 'like', now())$$, pg_temp.u('b8'), pg_temp.u('a1')),
  '23514', null, 'M4 stores only follow and moderation notices');

-- ---------------------------------------------------------------------------
-- Atomicity: a failed notification fails the change that caused it
-- ---------------------------------------------------------------------------
create function pg_temp.fail_notify() returns trigger language plpgsql as $$ begin raise exception 'notification failed'; end $$;
create trigger fail_notify before insert on public.notifications for each row execute function pg_temp.fail_notify();
select is(pg_temp.as_user('b8', format('select public.request_follow(%L)', pg_temp.u('b2'))), 'error: notification failed', 'a follow fails when its notice fails');
select is((select count(*)::int from public.follows where follower_id = pg_temp.u('b8') and followee_id = pg_temp.u('b2')), 0, 'and leaves no follow behind');
select is(pg_temp.as_user('e5', format($$select public.set_account_status(%L, 'suspended', 'Atomicity')$$, pg_temp.u('b8'))), 'error: notification failed', 'a suspension fails when its notice fails');
select is((select account_status::text from public.profiles where id = pg_temp.u('b8')) || ':' || (select count(*) from private.audit_events where target_profile_id = pg_temp.u('b8')),
  'active:0', 'and leaves the account active and unaudited');
drop trigger fail_notify on public.notifications;

-- ---------------------------------------------------------------------------
-- Visibility: b2 now has two follow notices from a1 and one from a7
-- ---------------------------------------------------------------------------
select is(pg_temp.visible('b2'), 3, 'b2 sees all three notices');
select pg_temp.as_user('e5', format($$select public.set_account_status(%L, 'suspended', 'Visibility')$$, pg_temp.u('a1')));
select is(pg_temp.visible('b2'), 1, 'notices from a suspended actor are hidden from the list');
select is(pg_temp.unread('b2'), 1, 'and from the unread count');
select is(pg_temp.as_user('b2', 'select public.mark_notifications_read()::text'), '1', 'marking all as read touches only visible notices');
select pg_temp.as_user('e5', format($$select public.set_account_status(%L, 'active', 'Visibility')$$, pg_temp.u('a1')));
select is(pg_temp.visible('b2') || ':' || pg_temp.unread('b2'), '3:2', 'reinstating the actor shows its notices again, still unread');

-- ---------------------------------------------------------------------------
-- Blocks remove notices in both directions
-- ---------------------------------------------------------------------------
select pg_temp.as_user('b2', format('select public.request_follow(%L)', pg_temp.u('a1')));
select is(pg_temp.n('a1', 'b2', 'follow'), 1, 'a1 has a notice from b2 too');
select pg_temp.as_user('b2', format('select public.block_user(%L)', pg_temp.u('a1')));
select is(pg_temp.between_pair('a1', 'b2'), 0, 'a block removes every notice between the two, both ways');
select is(pg_temp.n('b2', 'a7') || ':' || pg_temp.n('a1', null, 'moderation'), '1:2', 'and nothing else');
select pg_temp.as_user('b2', format('select public.unblock_user(%L)', pg_temp.u('a1')));
select is(pg_temp.between_pair('a1', 'b2'), 0, 'unblocking brings nothing back');

-- ---------------------------------------------------------------------------
-- The client functions
-- ---------------------------------------------------------------------------
insert into public.notifications (recipient_id, type, data) select pg_temp.u('b8'), 'moderation', '{"status": "active"}' from generate_series(1, 120);
select is(pg_temp.unread('b8'), 100, 'the unread count stops at 100');
select is(pg_temp.as_user('b8', $$select (array_agg(id) = array_agg(id order by id desc))::text || ':' || count(*) from public.get_my_notifications(100)$$),
  'true:100', 'a page holds at most 100, newest first');
select is(pg_temp.as_user('b8', format('select count(*)::text from public.get_my_notifications(100, %L)',
  (select id from public.notifications where recipient_id = pg_temp.u('b8') order by id desc offset 99 limit 1))), '20', 'the next page continues after the cursor');
select is(pg_temp.as_user('b8', 'select count(*)::text from public.get_my_notifications(0)') || ',' || pg_temp.as_user('b8', 'select count(*)::text from public.get_my_notifications(101)')
  || ',' || pg_temp.as_user('b8', 'select count(*)::text from public.get_my_notifications(null)'),
  'error: invalid page request,error: invalid page request,error: invalid page request', 'page sizes outside 1 to 100 are refused');
select is(pg_temp.as_user('b8', format('select public.mark_notifications_read(%L)::text',
  (select id from public.notifications where recipient_id = pg_temp.u('b8') order by id offset 9 limit 1))), '10', 'marking up to an id leaves newer ones unread');
select is(pg_temp.as_user('b8', 'select public.mark_notifications_read()::text') || ':' || pg_temp.as_user('b8', 'select public.mark_notifications_read()::text') || ':' || pg_temp.unread('b8'),
  '110:0:0', 'marking all is repeatable');
select is((select count(*)::int from public.notifications where recipient_id <> pg_temp.u('b8') and read_at is not null), 1, 'marking touches only the caller''s own notices');
select pg_temp.as_user('b8', format('select public.delete_notification(%L)', (select id from public.notifications where recipient_id = pg_temp.u('b8') limit 1)));
select is(pg_temp.n('b8'), 119, 'a user deletes their own notice');
select is(pg_temp.as_user('b8', format('select public.delete_notification(%L)', (select id from public.notifications where recipient_id = pg_temp.u('b2') limit 1))) || ':' || pg_temp.n('b2'),
  ':1', 'deleting someone else''s notice silently does nothing');
select is(pg_temp.as_user('f6', 'select count(*)::text from public.get_my_notifications()'), 'error: account not eligible', 'an unverified account is refused');
select is(pg_temp.as_user('d4', 'select count(*)::text from public.get_my_notifications(100)'), pg_temp.n('d4')::text, 'a user sees only their own notices');

set local role anon;
select throws_ok('select public.get_unread_notification_count()', '42501', null, 'anon can not call the notification functions');
reset role;

-- ---------------------------------------------------------------------------
-- Account deletion removes notices on both sides (D4)
-- ---------------------------------------------------------------------------
create temp table before_delete as
  select count(*)::int as total, (count(*) filter (where recipient_id = pg_temp.u('a7') or actor_id = pg_temp.u('a7')))::int as about from public.notifications;
delete from auth.users where id = pg_temp.u('a7');
select is((select count(*)::int from public.notifications), (select total - about from before_delete),
  'deleting an account removes its notices and those it caused, keeping none without an actor');

select * from finish();
rollback;
