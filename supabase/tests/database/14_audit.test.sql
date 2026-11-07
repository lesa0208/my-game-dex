-- M4a: the audit log, audited staff functions, suspension and admin audit access.
-- Races are in db-audit-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(82);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated;

-- Runs a statement as a signed-in user and returns its result, or the error as text,
-- so an unexpected error fails the named assertion instead of aborting the file.
-- A failure rolls the role back with it.
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

create function pg_temp.audits() returns int language sql as $$ select count(*)::int from private.audit_events $$;
create function pg_temp.status(s text) returns text language sql as $$ select account_status::text from public.profiles where id = pg_temp.u(s) $$;

-- a1, a2: future admins. d3: moderator. c4, c5: ordinary users. e6: catalog editor.
-- b7: no handle. f8: unverified email.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', case when s = 'f8' then null else now() end, '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'a2', 'd3', 'c4', 'c5', 'e6', 'b7', 'f8']) as s;
update public.profiles set handle = 'user_' || right(id::text, 2), handle_changed_at = now() where id <> pg_temp.u('b7');

-- Schema and access
select has_table('private', 'audit_events', 'audit_events exists in private');
select is((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'audit_action'),
  'staff_role_granted,staff_role_revoked,account_suspended,account_reinstated,operator_action', 'the five audit actions exist');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
  where has_table_privilege(r, 'private.audit_events', p)), 0, 'no API role has any privilege on audit_events');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array[
    'private.record_audit(uuid,private.audit_action,uuid,text,jsonb)', 'private.record_operator_action(uuid,text,jsonb)', 'private.lock_staff_changes()',
    'private.require_active_staff(public.staff_role)', 'private.require_reason(text)', 'private.other_active_admins(uuid)', 'private.audit_events_append_only()']) f
  where has_function_privilege(r, f, 'execute')), 0, 'no API role can execute an audit helper');
select is((select count(*)::int from unnest(array['anon', 'service_role']) r, unnest(array[
    'public.grant_staff_role(uuid,public.staff_role,text)', 'public.revoke_staff_role(uuid,public.staff_role,text)',
    'public.set_account_status(uuid,public.account_status,text)', 'public.get_audit_events(integer,uuid)']) f
  where has_function_privilege(r, f, 'execute')), 0, 'anon and service_role can execute no staff function');
select is((select count(*)::int from unnest(array[
    'public.grant_staff_role(uuid,public.staff_role,text)', 'public.revoke_staff_role(uuid,public.staff_role,text)',
    'public.set_account_status(uuid,public.account_status,text)', 'public.get_audit_events(integer,uuid)']) f
  where has_function_privilege('authenticated', f, 'execute')), 4, 'signed-in users can call the staff functions, which check the role');
select is(pg_temp.as_user('c4', 'select count(*)::text from private.audit_events'), 'error: permission denied for schema private', 'a signed-in user can''t reach the table');
set local role service_role;
select throws_ok('select * from private.audit_events', '42501', 'permission denied for schema private', 'service_role can''t reach the table');
reset role;

-- The documented operator procedure records the first administrator
select ok(private.record_operator_action(pg_temp.u('a1'), 'First administrator, approved by the product owner', '{"role": "admin"}') is not null, 'the operator records the assignment');
insert into public.staff_roles (user_id, role) values (pg_temp.u('a1'), 'admin');
select is((select actor_id from private.audit_events where action = 'operator_action'), null, 'an operator action has no actor');
select is((select target_profile_id from private.audit_events where action = 'operator_action'), pg_temp.u('a1'), 'and names its target');

-- Append-only, for every role that doesn't disable the trigger
select throws_ok('update private.audit_events set reason = ''changed''', 'P0001', 'audit events are append-only', 'even the owner can''t update a row');
select throws_ok('delete from private.audit_events', 'P0001', 'audit events are append-only', 'or delete one');
select throws_ok('truncate private.audit_events', 'P0001', 'audit events are append-only', 'or truncate the table');
select is((select string_agg(tgname || '=' || tgenabled::text, ',' order by tgname) from pg_trigger where tgrelid = 'private.audit_events'::regclass and not tgisinternal),
  'audit_events_no_truncate=O,audit_events_no_update_or_delete=O', 'both append-only triggers are enabled');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and (p.prosrc ~* 'update\s+private\.audit_events' or p.prosrc ~* 'delete\s+from\s+private\.audit_events' or p.prosrc ~* 'truncate[^;]*audit_events')),
  0, 'no function changes or removes audit rows');
select throws_ok('select private.record_audit(null, ''operator_action'', null, ''  '')', '22023', 'reason required', 'every audit row needs a reason');

-- Who may grant
select is(pg_temp.as_user('c4', $$select public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x')::text$$), 'error: not permitted', 'an ordinary user can''t grant a role');
insert into public.staff_roles (user_id, role) values (pg_temp.u('d3'), 'moderator');
select is(pg_temp.as_user('d3', $$select public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x')::text$$), 'error: not permitted', 'a moderator can''t grant a role');
insert into public.staff_roles (user_id, role) values (pg_temp.u('b7'), 'admin'), (pg_temp.u('f8'), 'admin');
select is(pg_temp.as_user('b7', $$select public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x')::text$$), 'error: not permitted', 'an admin without a handle can''t act');
select is(pg_temp.as_user('f8', $$select public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x')::text$$), 'error: not permitted', 'an unverified admin can''t act');
delete from public.staff_roles where user_id in (pg_temp.u('b7'), pg_temp.u('f8'));
delete from public.staff_roles where user_id = pg_temp.u('d3');
select is(pg_temp.audits(), 1, 'refused grants record nothing');

-- Granting
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('d3'), 'moderator', '  New moderator for the launch team  ')::text$$), 'true', 'an admin grants a role');
select is((select granted_by from public.staff_roles where user_id = pg_temp.u('d3') and role = 'moderator'), pg_temp.u('a1'), 'the grant records who granted it');
select is((select row(actor_id, action, target_profile_id, reason, metadata)::text from private.audit_events where action = 'staff_role_granted'),
  row(pg_temp.u('a1'), 'staff_role_granted'::private.audit_action, pg_temp.u('d3'), 'New moderator for the launch team', '{"role": "moderator"}'::jsonb)::text,
  'the audit row names the actor, target, trimmed reason and role');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('d3'), 'moderator', 'again')::text$$), 'false', 'granting a held role changes nothing');
select is(pg_temp.audits(), 2, 'and records nothing');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('c5'), 'moderator', '   ')::text$$), 'error: reason required', 'a blank reason is refused');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('c5'), 'moderator', null)::text$$), 'error: reason required', 'a missing reason is refused');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('c5'), 'moderator', repeat('x', 501))::text$$), 'error: reason required', 'a reason over 500 characters is refused');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('c5'), null, 'x')::text$$), 'error: invalid role', 'a missing role is refused');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('b7'), 'moderator', 'x')::text$$), 'error: user unavailable', 'an account without a handle can''t hold a role');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('f8'), 'moderator', 'x')::text$$), 'error: user unavailable', 'an unverified account can''t hold a role');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('ff'), 'moderator', 'x')::text$$), 'error: user unavailable', 'an unknown account can''t hold a role');
select is((select count(*)::int from public.staff_roles where user_id = pg_temp.u('c5')), 0, 'no refused grant created a role');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('a2'), 'admin', 'Second administrator')::text$$), 'true', 'an admin can grant admin (D12)');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('e6'), 'catalog_editor', 'Catalog team')::text$$), 'true', 'an admin grants catalog_editor');

-- Revoking
select is(pg_temp.as_user('d3', $$select public.revoke_staff_role(pg_temp.u('e6'), 'catalog_editor', 'x')::text$$), 'error: not permitted', 'a moderator can''t revoke a role');
select is(pg_temp.as_user('a1', $$select public.revoke_staff_role(pg_temp.u('c5'), 'moderator', 'x')::text$$), 'false', 'revoking a role that isn''t held changes nothing');
select is(pg_temp.audits(), 4, 'and records nothing');
select is(pg_temp.as_user('a1', $$select public.revoke_staff_role(pg_temp.u('a2'), 'admin', 'No longer needed')::text$$), 'true', 'an admin revokes another admin');
select is((select metadata from private.audit_events where action = 'staff_role_revoked'), '{"role": "admin"}'::jsonb, 'the revocation is audited with the role');
select is(pg_temp.as_user('a1', $$select public.revoke_staff_role(pg_temp.u('a1'), 'admin', 'Stepping down')::text$$), 'error: last administrator', 'the last administrator can''t be removed');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('a2'), 'admin', 'Back again')::text$$), 'true', 'setup: a second admin again');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('a2');
select is(pg_temp.as_user('a1', $$select public.revoke_staff_role(pg_temp.u('a1'), 'admin', 'Stepping down')::text$$), 'error: last administrator', 'a suspended admin doesn''t count as remaining');
select is(pg_temp.as_user('a2', $$select public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x')::text$$), 'error: not permitted', 'a suspended admin can''t act');
update public.profiles set account_status = 'active' where id = pg_temp.u('a2');
select is(pg_temp.as_user('a1', $$select public.revoke_staff_role(pg_temp.u('a1'), 'admin', 'Stepping down')::text$$), 'true', 'with another active admin, an admin can step down');
select is(pg_temp.as_user('a2', $$select public.grant_staff_role(pg_temp.u('a1'), 'admin', 'Restored')::text$$), 'true', 'setup: a1 is admin again');

-- Suspension
select is(pg_temp.as_user('c4', $$select public.set_account_status(pg_temp.u('c5'), 'suspended', 'x')::text$$), 'error: not permitted', 'an ordinary user can''t suspend');
select is(pg_temp.as_user('d3', $$select public.set_account_status(pg_temp.u('c4'), 'suspended', 'Spam reports')::text$$), 'true', 'a moderator suspends an ordinary account');
select is(pg_temp.status('c4'), 'suspended', 'the account is suspended');
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('c4'), 'moderator', 'x')::text$$), 'error: user unavailable', 'a suspended account can''t receive a role');
select is((select metadata from private.audit_events where action = 'account_suspended'), '{"to": "suspended", "from": "active"}'::jsonb, 'the suspension is audited with before and after');
select is(pg_temp.as_user('d3', $$select public.set_account_status(pg_temp.u('c4'), 'suspended', 'again')::text$$), 'false', 'suspending a suspended account changes nothing');
select is((select count(*)::int from private.audit_events where action = 'account_suspended'), 1, 'and records nothing');
select is(pg_temp.as_user('c4', $$select public.request_follow(pg_temp.u('c5'))$$), 'error: account not eligible', 'a suspended user''s existing session can''t follow');
select is(pg_temp.as_user('c4', $$select public.block_user(pg_temp.u('c5'))::text$$), '', 'but can still block (D6)');
select is(pg_temp.as_user('d3', $$select public.set_account_status(pg_temp.u('c4'), 'active', 'Appeal accepted')::text$$), 'true', 'a moderator reinstates the account');
select is((select action::text from private.audit_events order by id desc limit 1), 'account_reinstated', 'the reinstatement is audited');
select is(pg_temp.as_user('d3', $$select public.set_account_status(pg_temp.u('d3'), 'suspended', 'x')::text$$), 'error: not permitted', 'nobody can suspend themselves');
select is(pg_temp.as_user('a1', $$select public.set_account_status(pg_temp.u('a1'), 'suspended', 'x')::text$$), 'error: not permitted', 'not even an admin');
select is(pg_temp.as_user('d3', $$select public.set_account_status(pg_temp.u('e6'), 'suspended', 'x')::text$$), 'error: not permitted', 'a moderator can''t suspend staff');
select is(pg_temp.as_user('d3', $$select public.set_account_status(pg_temp.u('a2'), 'suspended', 'x')::text$$), 'error: not permitted', 'or an admin');
select is(pg_temp.as_user('a1', $$select public.set_account_status(pg_temp.u('e6'), 'suspended', 'Compromised account')::text$$), 'true', 'an admin suspends staff');
select is(pg_temp.as_user('a1', $$select public.set_account_status(pg_temp.u('a2'), 'suspended', 'Compromised account')::text$$), 'true', 'an admin suspends another admin');
select is(pg_temp.as_user('a1', $$select public.set_account_status(pg_temp.u('a2'), 'active', 'Recovered')::text$$), 'true', 'and reinstates them');
select is(pg_temp.as_user('d3', $$select public.set_account_status(pg_temp.u('c5'), 'deactivated', 'x')::text$$), 'error: invalid status', 'deactivation isn''t managed here');
update public.profiles set account_status = 'deactivated' where id = pg_temp.u('c5');
select is(pg_temp.as_user('d3', $$select public.set_account_status(pg_temp.u('c5'), 'active', 'x')::text$$), 'error: user unavailable', 'a deactivated account can''t be changed here');
update public.profiles set account_status = 'active' where id = pg_temp.u('c5');
select is(pg_temp.as_user('d3', $$select public.set_account_status(pg_temp.u('ff'), 'suspended', 'x')::text$$), 'error: user unavailable', 'an unknown account is refused');
select is(pg_temp.as_user('d3', $$select public.set_account_status(pg_temp.u('c5'), 'suspended', '')::text$$), 'error: reason required', 'a suspension needs a reason');
select is(pg_temp.status('c5'), 'active', 'no refused call changed the account');

-- Atomicity: if the audit row can't be written, the action doesn't happen
create function pg_temp.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'audit storage failed'; end $$;
create trigger fail_audit before insert on private.audit_events for each row execute function pg_temp.fail_audit();
select is(pg_temp.as_user('a1', $$select public.grant_staff_role(pg_temp.u('c5'), 'moderator', 'x')::text$$), 'error: audit storage failed', 'a failed audit write fails the grant');
select is((select count(*)::int from public.staff_roles where user_id = pg_temp.u('c5')), 0, 'and no role was granted');
select is(pg_temp.as_user('d3', $$select public.set_account_status(pg_temp.u('c5'), 'suspended', 'x')::text$$), 'error: audit storage failed', 'a failed audit write fails the suspension');
select is(pg_temp.status('c5'), 'active', 'and the account stays active');
drop trigger fail_audit on private.audit_events;

-- Reading the log
select is(pg_temp.as_user('a1', 'select count(*)::text from public.get_audit_events(100)'), (select count(*)::text from private.audit_events), 'an admin reads every row');
select is(pg_temp.as_user('a1', 'select id::text from public.get_audit_events(1)'), (select id::text from private.audit_events order by id desc limit 1), 'newest first');
select is(pg_temp.as_user('a1', format('select string_agg(id::text, '','') from public.get_audit_events(3, %L)', (select id from (select id from private.audit_events order by id desc limit 3) t order by id limit 1))),
  (select string_agg(id::text, ',' order by id desc) from (select id from private.audit_events order by id desc offset 3 limit 3) t), 'the next page continues without overlap');
select is(pg_temp.as_user('a1', 'select count(*)::text from public.get_audit_events(0)'), 'error: invalid page request', 'a page needs at least one row');
select is(pg_temp.as_user('a1', 'select count(*)::text from public.get_audit_events(101)'), 'error: invalid page request', 'and at most 100');
select is(pg_temp.as_user('d3', 'select count(*)::text from public.get_audit_events()'), 'error: not permitted', 'a moderator can''t read the log (D2)');
select is(pg_temp.as_user('c4', 'select count(*)::text from public.get_audit_events()'), 'error: not permitted', 'an ordinary user can''t read the log');

select * from finish();
rollback;
