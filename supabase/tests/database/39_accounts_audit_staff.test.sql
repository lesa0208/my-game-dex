-- M10e: the Accounts, Audit and Staff reads (search_accounts, get_account_summary,
-- get_audit_log, get_staff_overview): who may call them, what they return and never
-- return, their bounds and filters, and that they change nothing. Runs in one
-- transaction that rolls back, on the local stack only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(76);

create function pg_temp.session(p_user uuid, p_verified timestamptz) returns jsonb language plpgsql as $mfa$
begin
  insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    select p_user, p_user, 'Secret phone name', 'totp', 'verified', now() - interval '3 days', now()
    where not exists (select 1 from auth.mfa_factors where id = p_user);
  if not exists (select 1 from auth.mfa_amr_claims where session_id = p_user) then
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values (gen_random_uuid(), p_user, 'totp', p_verified, p_verified);
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user);
end $mfa$;
create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.session(pg_temp.u(p_actor), now())::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.as_aal1(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.as_anon(p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  perform set_config('role', 'anon', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;

-- a1: administrator. a2: a suspended administrator. b1: a moderator. e1: a catalog
-- editor. c1, c2: collectors. d1: an editor whose email was never confirmed. Thirty
-- more collectors whose handles start "accx", which a LIKE pattern "acc_" would match.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '-private@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'a2', 'b1', 'e1', 'c1', 'c2', 'd1']) as s;
update public.profiles set handle = 'acc_' || right(id::text, 2), handle_changed_at = now(), display_name = 'Name ' || right(id::text, 2)
where id in (select pg_temp.u(s) from unnest(array['a1', 'a2', 'b1', 'e1', 'c1', 'c2', 'd1']) s);
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select ('00000000-0000-0000-0000-0000000001' || lpad(to_hex(i), 2, '0'))::uuid, 'authenticated', 'authenticated', 'bulk' || i || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from generate_series(1, 30) i;
update public.profiles set handle = 'accxbulk_' || lpad(i::text, 2, '0'), handle_changed_at = now()
from generate_series(1, 30) i where id = ('00000000-0000-0000-0000-0000000001' || lpad(to_hex(i), 2, '0'))::uuid;
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('a1'), 'admin'), (pg_temp.u('a2'), 'admin'), (pg_temp.u('b1'), 'moderator'), (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('d1'), 'catalog_editor');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('a2');
update auth.users set email_confirmed_at = null where id = pg_temp.u('d1');

-- History, as the M8 and M10 functions leave it.
insert into private.audit_events (id, occurred_at, actor_id, action, target_profile_id, reason, metadata) values
  ('01900000-0000-7000-8000-00000000e001', now() - interval '40 days', pg_temp.u('b1'), 'account_suspended', pg_temp.u('c1'), 'Spam in bio', '{"from": "active", "to": "suspended"}'),
  ('01900000-0000-7000-8000-00000000e002', now() - interval '30 days', pg_temp.u('a1'), 'account_reinstated', pg_temp.u('c1'), 'Appeal accepted', '{"from": "suspended", "to": "active", "secret": "never shown"}'),
  ('01900000-0000-7000-8000-00000000e003', now() - interval '20 days', pg_temp.u('a1'), 'staff_role_granted', pg_temp.u('c1'), 'Trial moderator', '{"role": "moderator", "token": "abc"}'),
  ('01900000-0000-7000-8000-00000000e004', now() - interval '19 days', pg_temp.u('a1'), 'staff_role_revoked', pg_temp.u('c1'), 'Trial ended', '{"role": "moderator"}'),
  ('01900000-0000-7000-8000-00000000e005', now() - interval '10 days', pg_temp.u('b1'), 'staff_change_refused', pg_temp.u('c1'), 'Refused: admin_required', '{"code": "admin_required", "operation": "set_account_status", "status": "suspended"}'),
  ('01900000-0000-7000-8000-00000000e006', now() - interval '9 days', pg_temp.u('b1'), 'staff_change_refused', pg_temp.u('c1'), 'Refused: owner_only', '{"code": "owner_only", "operation": "grant_staff_role", "role": "admin"}'),
  ('01900000-0000-7000-8000-00000000e007', now() - interval '5 days', pg_temp.u('e1'), 'catalog_record_updated', null, 'Fixed the title',
     jsonb_build_object('entity', 'release', 'id', '01900000-0000-7000-8000-0000000000aa', 'field', 'title', 'note', repeat('n', 120), 'kind', repeat('k', 120))),
  ('01900000-0000-7000-8000-00000000e008', now() - interval '4 days', null, 'operator_action', null, 'Operator maintenance', '{"entity": "release", "id": "not-a-uuid", "fingerprint": "ffff"}'),
  ('01900000-0000-7000-8000-00000000e009', now() - interval '400 days', pg_temp.u('a1'), 'account_suspended', pg_temp.u('c2'), 'Old case', '{}');
insert into private.audit_events (actor_id, action, target_profile_id, reason, metadata)
select pg_temp.u('e1'), 'catalog_record_created', null, 'Bulk ' || i, '{"entity": "game"}' from generate_series(1, 120) i;

create temp table audit_before as select count(*) n from private.audit_events;
grant select on audit_before to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 1. Definitions and grants
-- ---------------------------------------------------------------------------
select is(
  (select string_agg(p.proname || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ','), ''), ' ' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('search_accounts', 'get_account_summary', 'get_audit_log', 'get_staff_overview')),
  'get_account_summary:true:search_path="" get_audit_log:true:search_path="" get_staff_overview:true:search_path="" search_accounts:true:search_path=""',
  'each read is SECURITY DEFINER with an empty search_path');
select is(
  (select string_agg(has_function_privilege('authenticated', f, 'execute') || '/' || has_function_privilege('anon', f, 'execute')
     || '/' || has_function_privilege('service_role', f, 'execute') || '/' || has_function_privilege('catalog_importer', f, 'execute'), ' ')
   from unnest(array['public.search_accounts(text, integer)', 'public.get_account_summary(text)',
     'public.get_audit_log(integer, uuid, text, text, text, text, text, timestamptz, timestamptz)', 'public.get_staff_overview()']) f),
  'true/false/false/false true/false/false/false true/false/false/false true/false/false/false',
  'only authenticated may execute them');
select is(
  (select bool_or(has_function_privilege(r, f, 'execute'))
   from unnest(array['authenticated', 'anon', 'service_role', 'catalog_importer']) r,
        unnest(array['private.audit_details(jsonb)', 'private.audit_event_view(private.audit_events)', 'private.audit_category_actions(text)']) f),
  false, 'the private helpers are reachable by no API role');

-- ---------------------------------------------------------------------------
-- 2. Who may call them
-- ---------------------------------------------------------------------------
create temp table calls (name text, sql text, who text);
grant select on calls to authenticated, anon;
insert into calls values
  ('search', 'select public.search_accounts(''acc'')::text', 'moderator'),
  ('summary', 'select public.get_account_summary(''acc_c1'')::text', 'moderator'),
  ('audit', 'select public.get_audit_log()::text', 'admin'),
  ('staff', 'select public.get_staff_overview()::text', 'admin');
select is((select string_agg(distinct pg_temp.as_anon(c.sql), ' ') from calls c) ~ '^(error: permission denied for function [a-z_]+ ?)+$', true, 'anon is refused by the grant');
select is((select string_agg(distinct pg_temp.as_user('c1', c.sql), ' ') from calls c), 'error: not permitted', 'a collector is refused');
select is((select string_agg(distinct pg_temp.as_user('e1', c.sql), ' ') from calls c), 'error: not permitted', 'a catalog editor is refused');
select is((select string_agg(distinct pg_temp.as_user('a2', c.sql), ' ') from calls c), 'error: not permitted', 'a suspended administrator is refused');
select is((select string_agg(distinct pg_temp.as_user('d1', c.sql), ' ') from calls c), 'error: not permitted', 'an unconfirmed staff member is refused');
select is((select string_agg(distinct pg_temp.as_aal1('a1', c.sql), ' ') from calls c), 'error: not permitted', 'an administrator without a verified session is refused');
select is((select string_agg(c.name, ',' order by c.name) from calls c where pg_temp.as_user('b1', c.sql) not like 'error%'), 'search,summary', 'a moderator may search and read an account, not the audit log or staff');
select is((select string_agg(distinct pg_temp.as_user('b1', c.sql), ' ') from calls c where c.who = 'admin'), 'error: not permitted', 'and is refused those by the database');
select is((select count(*)::int from calls c where pg_temp.as_user('a1', c.sql) like 'error%'), 0, 'an administrator reads each');

-- ---------------------------------------------------------------------------
-- 3. Account search: by handle prefix only, bounded
-- ---------------------------------------------------------------------------
create function pg_temp.search(q text, n text default 'null') returns jsonb language sql as $$ select pg_temp.as_user('b1', format('select public.search_accounts(%L, %s)::text', q, n))::jsonb $$;
select is((select string_agg(r ->> 'handle', ',') from jsonb_array_elements(pg_temp.search('acc_')) r), 'acc_a1,acc_a2,acc_b1,acc_c1,acc_c2,acc_d1,acc_e1', 'a prefix finds the handles that start with it, in order');
select is(jsonb_array_length(pg_temp.search('ACC_C')), 2, 'case doesn''t matter');
select is(jsonb_array_length(pg_temp.search('@acc_c1')), 1, 'nor a leading @');
select is(jsonb_array_length(pg_temp.search('acc_')), 7, 'an underscore is a character, not a wildcard');
select is(jsonb_array_length(pg_temp.search('acc')), 20, 'twenty by default');
select is(jsonb_array_length(pg_temp.search('acc', '1000')), 25, 'never more than 25');
select is(jsonb_array_length(pg_temp.search('acc', '0')), 1, 'at least one');
select is(pg_temp.as_user('b1', 'select public.search_accounts(''a'')::text'), 'error: invalid handle', 'one character is too short');
select is(pg_temp.as_user('b1', 'select public.search_accounts(''acc%'')::text'), 'error: invalid handle', 'a pattern character is refused');
select is(pg_temp.as_user('b1', 'select public.search_accounts(''private@example'')::text'), 'error: invalid handle', 'an email address is refused');
select is(jsonb_array_length(pg_temp.search('name')), 0, 'a display name isn''t searched');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.search('acc_c1') -> 0) k), 'account_status,display_name,handle,id,owner,roles', 'each with fixed keys');
select is(pg_temp.search('acc')::text ~ 'example\.test', false, 'no email address appears');

-- ---------------------------------------------------------------------------
-- 4. One account's summary and history
-- ---------------------------------------------------------------------------
create function pg_temp.summary(who text, h text) returns jsonb language sql as $$ select pg_temp.as_user(who, format('select public.get_account_summary(%L)::text', h))::jsonb $$;
select is(pg_temp.as_user('b1', 'select coalesce(public.get_account_summary(''acc_zz'')::text, ''none'')'), 'none', 'an unknown handle is null');
select is(pg_temp.as_user('b1', 'select public.get_account_summary(''a b'')::text'), 'error: invalid handle', 'a malformed handle is refused');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.summary('b1', 'acc_c1')) k), 'account,cap,history,moderation', 'fixed keys');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.summary('b1', 'acc_c1') -> 'account') k),
  'account_status,display_name,handle,id,member_since,owner,roles', 'the account: no email, collection or private setting');
select is(pg_temp.summary('b1', 'acc_c1')::text ~ 'example\.test|collection_visibility|"bio"', false, 'and none of them appears');
select is(pg_temp.summary('b1', 'acc_c1') -> 'moderation' ->> 'suspensions', '1', 'how often it was suspended');
select is(pg_temp.summary('b1', 'acc_c1') -> 'moderation' ->> 'reinstatements', '1', 'and reinstated');
select is(pg_temp.summary('b1', 'acc_c1') -> 'moderation' ->> 'refused_status_changes', '1', 'refused status changes only');
select is(pg_temp.summary('b1', 'acc_c1') -> 'moderation' -> 'last_status_change' ->> 'action', 'account_reinstated', 'its last status change');
select is(pg_temp.summary('b1', 'acc_c1') -> 'moderation' -> 'last_status_change' ->> 'actor_handle', 'acc_a1', 'and who made it');
select is((select string_agg(h ->> 'action', ',') from jsonb_array_elements(pg_temp.summary('b1', 'acc_c1') -> 'history') h),
  'staff_change_refused,account_reinstated,account_suspended', 'a moderator sees its status history and refused status changes, newest first');
select is((select string_agg(h ->> 'action', ',') from jsonb_array_elements(pg_temp.summary('a1', 'acc_c1') -> 'history') h),
  'staff_change_refused,staff_change_refused,staff_role_revoked,staff_role_granted,account_reinstated,account_suspended', 'an administrator also its staff roles');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.summary('a1', 'acc_c1') -> 'history' -> 0) k),
  'about_account,action,actor_handle,by_account,details,id,occurred_at,outcome,reason,target_handle', 'each event with fixed keys: no account ids');
select is(pg_temp.summary('a1', 'acc_c1')::text ~ 'never shown|"token"|abc"', false, 'and only allow-listed details');
select is(pg_temp.summary('b1', 'acc_c2') -> 'history' -> 0 ->> 'reason', 'Old case', 'history isn''t limited to a recent window');

-- ---------------------------------------------------------------------------
-- 5. The audit log: allow-listed details, filters and bounds
-- ---------------------------------------------------------------------------
create function pg_temp.audit(p_args text) returns jsonb language sql as $$ select pg_temp.as_user('a1', format('select public.get_audit_log(%s)::text', p_args))::jsonb $$;
create function pg_temp.event(p_id text) returns jsonb language sql as $$
  select e from jsonb_array_elements(pg_temp.audit(format('100, null, %L', (select a.action::text from private.audit_events a where a.id = p_id::uuid)))) e where e ->> 'id' = p_id $$;
select is(jsonb_array_length(pg_temp.audit('')), 50, 'fifty by default');
select is(jsonb_array_length(pg_temp.audit('1000')), 100, 'never more than 100');
select is(jsonb_array_length(pg_temp.audit('0')), 1, 'at least one');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.audit('1') -> 0) k),
  'about_account,action,actor_handle,by_account,details,id,occurred_at,outcome,reason,target_handle', 'each event has fixed keys: no account ids or raw metadata');
select is(pg_temp.event('01900000-0000-7000-8000-00000000e002') -> 'details', '{"from": "suspended", "to": "active"}'::jsonb, 'details keep known keys only');
select is(pg_temp.event('01900000-0000-7000-8000-00000000e007') -> 'details',
  jsonb_build_object('entity', 'release', 'kind', repeat('k', 80), 'record', jsonb_build_object('entity', 'release', 'id', '01900000-0000-7000-8000-0000000000aa')),
  'a catalog event names its record for a link, cuts strings to 80 and drops unknown keys');
select is(pg_temp.event('01900000-0000-7000-8000-00000000e008') -> 'details', '{"entity": "release"}'::jsonb, 'an id that isn''t a uuid isn''t a link, and a fingerprint never appears');
select is((pg_temp.event('01900000-0000-7000-8000-00000000e008') ->> 'by_account') || '/' || (pg_temp.event('01900000-0000-7000-8000-00000000e008') ->> 'outcome'), 'false/operator', 'an operator action says so');
select is((select string_agg(distinct e ->> 'action', ',' order by e ->> 'action') from jsonb_array_elements(pg_temp.audit('100, null, null, ''accounts''')) e), 'account_reinstated,account_suspended', 'by kind: accounts');
select is((select string_agg(distinct e ->> 'action', ',' order by e ->> 'action') from jsonb_array_elements(pg_temp.audit('100, null, null, ''staff''')) e), 'staff_change_refused,staff_role_granted,staff_role_revoked', 'by kind: staff');
select is((select count(*)::int from jsonb_array_elements(pg_temp.audit('100, null, null, ''catalog''')) e where e ->> 'action' not like 'catalog\_%'), 0, 'by kind: catalog');
select is((select string_agg(distinct e ->> 'outcome', ',') from jsonb_array_elements(pg_temp.audit('100, null, null, null, ''refused''')) e), 'refused', 'by outcome');
select is(jsonb_array_length(pg_temp.audit('100, null, ''account_suspended''')), 2, 'by action');
select is(jsonb_array_length(pg_temp.audit('100, null, null, null, null, ''acc_b1''')), 3, 'by who acted');
select is(jsonb_array_length(pg_temp.audit('100, null, null, null, null, null, ''@ACC_C1''')), 6, 'by who it was about, any case, with or without @');
select is(pg_temp.audit('100, null, null, null, null, ''acc_zz''')::text, '[]', 'an unknown handle matches nothing');
select is(jsonb_array_length(pg_temp.audit(format('100, null, ''account_suspended'', null, null, null, null, %L', now() - interval '60 days'))), 1, 'a start alone: the next 366 days');
select is(jsonb_array_length(pg_temp.audit(format('100, null, ''account_suspended'', null, null, null, null, null, %L', now() - interval '20 days'))), 1, 'an end alone: the 366 days before it');
select is(pg_temp.as_user('a1', format('select public.get_audit_log(10, null, null, null, null, null, null, %L, %L)::text', now() - interval '400 days', now())), 'error: invalid filter', 'a range over 366 days is refused');
select is(pg_temp.as_user('a1', format('select public.get_audit_log(10, null, null, null, null, null, null, %L, %L)::text', now(), now() - interval '1 day')), 'error: invalid filter', 'so is one that ends before it starts');
select is(pg_temp.as_user('a1', 'select public.get_audit_log(10, null, ''deleted_everything'')::text'), 'error: invalid filter', 'an unknown action is refused');
select is(pg_temp.as_user('a1', 'select public.get_audit_log(10, null, null, ''secrets'')::text'), 'error: invalid filter', 'an unknown kind is refused');
select is(pg_temp.as_user('a1', 'select public.get_audit_log(10, null, null, null, ''maybe'')::text'), 'error: invalid filter', 'an unknown outcome is refused');
select is(pg_temp.as_user('a1', 'select public.get_audit_log(10, null, null, null, null, ''x%'')::text'), 'error: invalid filter', 'a malformed handle is refused');
select is((select bool_and((e ->> 'id') < '01900000-0000-7000-8000-00000000e005') from jsonb_array_elements(pg_temp.audit('100, ''01900000-0000-7000-8000-00000000e005''')) e), true, 'paged by id, older than the last seen');

-- ---------------------------------------------------------------------------
-- 6. Staff: standing and authenticator readiness as counts
-- ---------------------------------------------------------------------------
select pg_temp.as_user('a1', 'select 1::text');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('00000000-0000-0000-0000-0000000002a1', pg_temp.u('a1'), 'Second secret name', 'totp', 'verified', now() - interval '3 days', now());
insert into private.mfa_factor_registrations (factor_id, user_id, factor_created_at, registered_at)
select f.id, f.user_id, f.created_at, now() - interval '2 days' from auth.mfa_factors f where f.user_id = pg_temp.u('a1')
on conflict do nothing;
create function pg_temp.staff() returns jsonb language sql as $$ select pg_temp.as_user('a1', 'select public.get_staff_overview()::text')::jsonb $$;
create function pg_temp.member(h text) returns jsonb language sql as $$ select m from jsonb_array_elements(pg_temp.staff() -> 'members') m where m ->> 'handle' = h $$;
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.staff()) k), 'cap,members,recent,roles', 'fixed keys');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.member('acc_a1')) k),
  'account_status,display_name,factors,handle,id,last_staff_action_at,mature_factors,owner,roles,standing,successor', 'each member with fixed keys');
select is((select string_agg(m ->> 'handle', ',') from jsonb_array_elements(pg_temp.staff() -> 'members') m), 'acc_a1,acc_a2,acc_b1,acc_d1,acc_e1', 'every staff member, and nobody else');
select is((pg_temp.member('acc_a1') ->> 'factors') || '/' || (pg_temp.member('acc_a1') ->> 'mature_factors'), '2/2', 'an administrator''s verified and mature factors, as counts');
select is((pg_temp.member('acc_b1') ->> 'factors') || '/' || (pg_temp.member('acc_b1') ->> 'mature_factors'), '1/0', 'a factor not yet registered for 24 hours isn''t mature');
select is((select string_agg((m ->> 'handle') || '=' || (m ->> 'standing'), ',') from jsonb_array_elements(pg_temp.staff() -> 'members') m),
  'acc_a1=active,acc_a2=suspended,acc_b1=active,acc_d1=unverified,acc_e1=active', 'each member''s standing, as a fixed word');
select is(pg_temp.staff()::text ~ 'Secret phone name|Second secret name|example\.test|00000000-0000-0000-0000-0000000002a1', false, 'no factor name or id and no email address appears');
select is(pg_temp.staff() -> 'roles', '{"admin": 2, "moderator": 1, "catalog_editor": 2}'::jsonb, 'the role counts');
select is((select string_agg(e ->> 'action', ',') from jsonb_array_elements(pg_temp.staff() -> 'recent') e),
  'staff_change_refused,staff_change_refused,staff_role_revoked,staff_role_granted', 'recent staff changes, newest first');
select is(pg_temp.member('acc_b1') ->> 'last_staff_action_at' is not null, true, 'and when each member last acted');

-- ---------------------------------------------------------------------------
-- 7. Nothing is written
-- ---------------------------------------------------------------------------
select is((select count(*) from private.audit_events), (select n from audit_before), 'no read wrote an audit event');

select * from finish();
rollback;
