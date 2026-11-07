-- M4a Audit: storage for security audit events, and the helpers staff functions use.
--
-- Design: docs/architecture/security-rls.md#audit-log
-- The log is append-only for application and API roles: they have no access to it
-- at all, and a trigger refuses changes from every other path. A database owner or
-- superuser can still disable the trigger or rewrite the table, so this is a
-- guardrail against our own mistakes, not tamper-proof storage.

-- ---------------------------------------------------------------------------
-- 1. Storage
-- ---------------------------------------------------------------------------

create type private.audit_action as enum (
  'staff_role_granted',
  'staff_role_revoked',
  'account_suspended',
  'account_reinstated',
  'operator_action'
);

-- IDs are kept as plain values with no foreign keys, so deleting an account never
-- changes the log. Rows hold no handles, names or other copies of profile data.
-- Retention is undecided (D10): nothing removes rows, and that is an interim state,
-- not a commitment to keep them.
create table private.audit_events (
  id uuid primary key default private.uuid_v7(),
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  action private.audit_action not null,
  target_profile_id uuid,
  reason text not null check (char_length(reason) between 1 and 500 and reason = btrim(reason)),
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 2048)
);

create index audit_events_target_idx on private.audit_events (target_profile_id, id desc) where target_profile_id is not null;
create index audit_events_actor_idx on private.audit_events (actor_id, id desc) where actor_id is not null;

alter table private.audit_events enable row level security;
revoke all on table private.audit_events from public, anon, authenticated, service_role;

-- Refuses every change after insert, for all roles that don't disable the trigger.
create function private.audit_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit events are append-only' using errcode = 'P0001';
end;
$$;

create trigger audit_events_no_update_or_delete
  before update or delete on private.audit_events
  for each row execute function private.audit_events_append_only();

create trigger audit_events_no_truncate
  before truncate on private.audit_events
  for each statement execute function private.audit_events_append_only();

-- ---------------------------------------------------------------------------
-- 2. Helpers. None is reachable from the API.
-- ---------------------------------------------------------------------------

-- Taken first by every change to staff roles or account status, so these changes
-- happen one at a time. M3 functions never take it, so it can't deadlock with them.
create function private.lock_staff_changes()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('staff-changes', 0));
end;
$$;

-- The caller must hold the role (admin implies every role) and have an active,
-- verified account with a handle. has_staff_role() alone doesn't check the account.
create function private.require_active_staff(p_role public.staff_role)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null or not private.is_active_user() or not private.has_staff_role(p_role) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return v_me;
end;
$$;

-- Trimmed, 1 to 500 characters.
create function private.require_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reason text := pg_catalog.btrim(p_reason);
begin
  if v_reason is null or pg_catalog.char_length(v_reason) not between 1 and 500 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  return v_reason;
end;
$$;

-- Active, verified administrators with a handle, other than p_except.
create function private.other_active_admins(p_except uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select count(*)
  from public.staff_roles s
  join public.profiles p on p.id = s.user_id
  join auth.users u on u.id = p.id
  where s.role = 'admin'
    and s.user_id <> p_except
    and p.account_status = 'active'
    and p.handle is not null
    and u.email_confirmed_at is not null
$$;

-- The only way rows are added. Runs inside the caller's transaction, so a failure
-- here rolls back the action it records.
create function private.record_audit(
  p_actor uuid,
  p_action private.audit_action,
  p_target uuid,
  p_reason text,
  p_metadata jsonb default '{}'
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into private.audit_events (actor_id, action, target_profile_id, reason, metadata)
  values (p_actor, p_action, p_target, private.require_reason(p_reason), coalesce(p_metadata, '{}'))
  returning id into v_id;
  return v_id;
end;
$$;

-- For operators working in SQL, such as assigning the first administrator. Run it in
-- the same transaction as the change it records. See the runbook in security-rls.md.
create function private.record_operator_action(p_target uuid, p_reason text, p_metadata jsonb default '{}')
returns uuid
language plpgsql
set search_path = ''
as $$
begin
  perform private.lock_staff_changes();
  return private.record_audit(null, 'operator_action', p_target, p_reason, p_metadata);
end;
$$;

revoke all on function private.audit_events_append_only() from public, anon, authenticated, service_role;
revoke all on function private.lock_staff_changes() from public, anon, authenticated, service_role;
revoke all on function private.require_active_staff(public.staff_role) from public, anon, authenticated, service_role;
revoke all on function private.require_reason(text) from public, anon, authenticated, service_role;
revoke all on function private.other_active_admins(uuid) from public, anon, authenticated, service_role;
revoke all on function private.record_audit(uuid, private.audit_action, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.record_operator_action(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on type private.audit_action from public, anon, authenticated, service_role;
