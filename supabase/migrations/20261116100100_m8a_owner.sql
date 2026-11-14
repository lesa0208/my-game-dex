-- M8a Superadmin foundation: the Owner record, its protections, recovery
-- infrastructure and the audit foundation.
--
-- Design: docs/architecture/security-rls.md#the-owner-m8 and ADR-055.
-- The Owner is a record, not a staff role (D1). Every protection depends only on
-- being the designated Owner (A1): losing a factor, a suspension or a damaged Auth
-- account never leaves the Owner unprotected. The authority to act as Owner, which
-- also needs current MFA eligibility, is added in M8b. No client role can read or
-- write anything here; operator functions are executable by postgres only.
--
-- Lock order, shared by every function here and in M8c: lock_staff_changes(), then
-- profiles FOR KEY SHARE in id order, then platform_owner FOR UPDATE, then transfer
-- and recovery rows FOR UPDATE.

-- ---------------------------------------------------------------------------
-- 1. Audit outcome (D9)
-- ---------------------------------------------------------------------------

-- Derived from the action, so no row is rewritten and the append-only trigger stays
-- as it is. Imports also record a null actor, so 'operator' comes from the action.
alter table private.audit_events
  add column outcome text not null generated always as (
    case
      when action in ('owner_protection_refused', 'staff_change_refused') then 'refused'
      when action in ('operator_action', 'owner_assigned', 'owner_recovery_started', 'owner_recovery_completed', 'owner_status_set_by_operator')
        or (action in ('owner_recovery_cancelled', 'owner_recovery_confirmed') and actor_id is null) then 'operator'
      else 'succeeded'
    end
  ) stored;

create index audit_events_refusals_idx on private.audit_events (actor_id, action, occurred_at desc)
  where action in ('owner_protection_refused', 'staff_change_refused');

-- ---------------------------------------------------------------------------
-- 2. The Owner record (D1) and the records of transfers and recoveries
-- ---------------------------------------------------------------------------

-- At most one row (the key can only be true), never deleted once assigned, so after
-- the first assignment exactly one Owner exists in every committed state. Its user
-- can't be deleted (RESTRICT, which a disabled user trigger doesn't lift).
create table private.platform_owner (
  id boolean primary key default true check (id),
  user_id uuid not null unique references public.profiles (id) on delete restrict,
  assigned_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  successor_id uuid references public.profiles (id) on delete set null,
  succession_fingerprint text check (succession_fingerprint ~ '^[0-9a-f]{64}$'),
  succession_registered_at timestamptz,
  check (successor_id is distinct from user_id),
  check ((succession_fingerprint is null) = (succession_registered_at is null))
);

-- Two-step ownership transfers (D5), used from M8c. One pending at a time.
create table private.ownership_transfers (
  id uuid primary key default private.uuid_v7(),
  from_user uuid references public.profiles (id) on delete set null,
  to_user uuid references public.profiles (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by uuid references public.profiles (id) on delete set null,
  cancel_cause text check (cancel_cause in ('owner', 'target', 'recovery_started', 'account_deleted', 'target_suspended', 'target_role_revoked')),
  check ((status = 'pending') = (decided_at is null)),
  check (expires_at > created_at)
);
create unique index ownership_transfers_one_pending on private.ownership_transfers ((true)) where status = 'pending';
create index ownership_transfers_from_idx on private.ownership_transfers (from_user) where from_user is not null;
create index ownership_transfers_to_idx on private.ownership_transfers (to_user) where to_user is not null;
create index ownership_transfers_decided_by_idx on private.ownership_transfers (decided_by) where decided_by is not null;

-- Break-glass recoveries (D6): a factor reset for the Owner, or reassigning
-- ownership. Opened and completed by an operator in SQL after a 72-hour hold (D17);
-- one pending at a time. A disputed recovery can't be cancelled from the app (D6b).
create table private.owner_recoveries (
  id uuid primary key default private.uuid_v7(),
  kind text not null check (kind in ('factor_reset', 'reassign')),
  status text not null default 'pending' check (status in ('pending', 'cancelled', 'completed')),
  owner_id uuid references public.profiles (id) on delete set null,
  target_id uuid references public.profiles (id) on delete set null,
  case_ref text not null check (char_length(case_ref) between 1 and 200 and case_ref = btrim(case_ref)),
  disputed boolean not null default false,
  fingerprint_matched boolean,
  created_at timestamptz not null default now(),
  hold_until timestamptz not null,
  confirmed_at timestamptz,
  decided_at timestamptz,
  cancelled_by_owner boolean not null default false,
  cancel_cause text check (cancel_cause in ('owner', 'operator', 'account_deleted')),
  check ((status = 'pending') = (decided_at is null)),
  check (hold_until > created_at),
  check (kind = 'reassign' or confirmed_at is null),
  check (not cancelled_by_owner or status = 'cancelled')
);
create unique index owner_recoveries_one_pending on private.owner_recoveries ((true)) where status = 'pending';
create index owner_recoveries_owner_idx on private.owner_recoveries (owner_id) where owner_id is not null;
create index owner_recoveries_target_idx on private.owner_recoveries (target_id) where target_id is not null;

alter table private.platform_owner enable row level security;
alter table private.ownership_transfers enable row level security;
alter table private.owner_recoveries enable row level security;
revoke all on private.platform_owner from public, anon, authenticated, service_role;
revoke all on private.ownership_transfers from public, anon, authenticated, service_role;
revoke all on private.owner_recoveries from public, anon, authenticated, service_role;

-- The Owner record is permanent; who holds it changes only through a transfer or a
-- recovery, which set mygamedex.owner_change for their own transaction. This guards
-- against mistakes in SQL; a database owner can still disable it.
create function private.guard_platform_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'the owner record is permanent' using errcode = 'P0001';
  end if;
  if new.id is distinct from old.id then
    raise exception 'the owner record is permanent' using errcode = 'P0001';
  end if;
  if new.user_id is distinct from old.user_id then
    if pg_catalog.current_setting('mygamedex.owner_change', true) is distinct from 'on' then
      raise exception 'ownership changes only by transfer or recovery' using errcode = 'P0001';
    end if;
    new.version := old.version + 1;
    new.assigned_at := pg_catalog.now();
  elsif new.version is distinct from old.version then
    raise exception 'the owner record is permanent' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger platform_owner_guard
  before update or delete on private.platform_owner
  for each row execute function private.guard_platform_owner();
create trigger platform_owner_no_truncate
  before truncate on private.platform_owner
  for each statement execute function private.guard_platform_owner();

-- ---------------------------------------------------------------------------
-- 3. Identity and standing
-- ---------------------------------------------------------------------------

-- Whether p_user is the recorded Owner. Nothing else is checked: every protection
-- uses this, never eligibility (A1).
create function private.is_designated_owner(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and exists (select 1 from private.platform_owner o where o.user_id = p_user)
$$;

-- Why an account can't hold the Owner record or authority now, or null if it can:
-- its Auth user exists, isn't soft-deleted or banned and has a verified email; its
-- profile is active with a handle. Reads auth.users; never writes it.
create function private.account_standing(p_user uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_deleted timestamptz;
  v_banned timestamptz;
  v_confirmed timestamptz;
  v_status public.account_status;
  v_handle text;
begin
  select p.account_status, p.handle into v_status, v_handle from public.profiles p where p.id = p_user;
  if not found then
    return 'missing';
  end if;
  begin
    select u.deleted_at, u.banned_until, u.email_confirmed_at into strict v_deleted, v_banned, v_confirmed
    from auth.users u where u.id = p_user;
  exception
    when no_data_found then return 'auth_missing';
    when undefined_column or undefined_table or undefined_object then
      raise log 'mygamedex: auth schema contract broken in account_standing (%)', sqlstate;
      return 'auth_contract_broken';
  end;
  if v_deleted is not null then return 'deleted'; end if;
  if v_banned is not null and v_banned > pg_catalog.now() then return 'banned'; end if;
  if v_confirmed is null then return 'unverified'; end if;
  if v_status <> 'active' then return 'inactive'; end if;
  if v_handle is null then return 'no_handle'; end if;
  return null;
end;
$$;

-- Verified TOTP factors of p_user enrolled at least p_min_age ago (created_at is the
-- enrollment time, unchanged by verification or renaming). Null if the Auth schema no
-- longer matches what this reads.
create function private.totp_factor_count(p_user uuid, p_min_age interval default interval '0')
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  select count(*)::integer into v_count
  from auth.mfa_factors f
  where f.user_id = p_user and f.factor_type = 'totp' and f.status = 'verified'
    and f.created_at <= pg_catalog.now() - p_min_age;
  return v_count;
exception when undefined_column or undefined_table or undefined_object or invalid_text_representation then
  raise log 'mygamedex: auth schema contract broken in totp_factor_count (%)', sqlstate;
  return null;
end;
$$;

-- Whether this transaction holds the staff-changes lock. Functions that record a
-- refusal require it, so their rate limit can't race.
create function private.holds_staff_lock()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from pg_catalog.pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid() and l.granted
      and l.classid = ((pg_catalog.hashtextextended('staff-changes', 0) >> 32) & 4294967295)::oid
      and l.objid = (pg_catalog.hashtextextended('staff-changes', 0) & 4294967295)::oid
      and l.objsubid = 1
  )
$$;

-- ---------------------------------------------------------------------------
-- 4. Protections (D12), keyed on designated ownership
-- ---------------------------------------------------------------------------

-- Refuses deleting the Owner's profile, whichever path deletes it: the Auth Admin
-- API, a cascade from auth.users or SQL. Otherwise closes anything pending for the
-- account being deleted. A refusal raises, so only the server log line survives it.
create function private.protect_owner_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise log 'mygamedex owner protection: refused TRUNCATE on profiles by % (session %)', current_user, session_user;
    raise exception 'account protected' using errcode = 'P0001';
  end if;
  if private.is_designated_owner(old.id) then
    raise log 'mygamedex owner protection: refused % of profile % by % (session %)', tg_op, old.id, current_user, session_user;
    raise exception 'account protected' using errcode = 'P0001';
  end if;
  update private.ownership_transfers t
  set status = 'cancelled', decided_at = pg_catalog.now(), cancel_cause = 'account_deleted'
  where t.status = 'pending' and (t.to_user = old.id or t.from_user = old.id);
  update private.owner_recoveries r
  set status = 'cancelled', decided_at = pg_catalog.now(), cancel_cause = 'account_deleted'
  where r.status = 'pending' and r.target_id = old.id;
  return old;
end;
$$;

create trigger protect_owner_profile
  before delete on public.profiles
  for each row execute function private.protect_owner_profile();
create trigger protect_owner_profiles_truncate
  before truncate on public.profiles
  for each statement execute function private.protect_owner_profile();

-- Refuses changing the Owner's account status, except through the audited operator
-- function below. The Owner can't be suspended from the app by anyone, themselves
-- included.
create function private.protect_owner_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.account_status is distinct from old.account_status and private.is_designated_owner(old.id)
     and pg_catalog.current_setting('mygamedex.owner_status_change', true) is distinct from 'on' then
    raise log 'mygamedex owner protection: refused status change of profile % by % (session %)', old.id, current_user, session_user;
    raise exception 'account protected' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger protect_owner_status
  before update of account_status on public.profiles
  for each row execute function private.protect_owner_status();

-- The Owner always keeps the administrator role.
create function private.protect_owner_admin_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    if exists (select 1 from private.platform_owner) then
      raise log 'mygamedex owner protection: refused TRUNCATE on staff_roles by % (session %)', current_user, session_user;
      raise exception 'account protected' using errcode = 'P0001';
    end if;
    return null;
  end if;
  if old.role = 'admin' and private.is_designated_owner(old.user_id)
     and (tg_op = 'DELETE' or new.user_id is distinct from old.user_id or new.role is distinct from old.role) then
    raise log 'mygamedex owner protection: refused % of the owner''s admin role by % (session %)', tg_op, current_user, session_user;
    raise exception 'account protected' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger protect_owner_admin_role
  before update or delete on public.staff_roles
  for each row execute function private.protect_owner_admin_role();
create trigger protect_owner_admin_role_truncate
  before truncate on public.staff_roles
  for each statement execute function private.protect_owner_admin_role();

-- For the server's account deletion (service role only): whether deleting this
-- account must be refused before anything, storage included, is touched.
create function public.account_deletion_blocked(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_designated_owner(p_user)
$$;

-- ---------------------------------------------------------------------------
-- 5. Refusals (D9)
-- ---------------------------------------------------------------------------

-- Records a refused attempt by verified staff and returns the audit row's id, or
-- null when the same refusal (actor, action, target and code) was recorded in the
-- last 10 minutes. The caller must hold the staff-changes lock, so concurrent
-- attempts are counted one at a time, and must have written nothing else: it
-- returns the refusal, and the transaction commits with only this row.
create function private.record_refusal(
  p_actor uuid,
  p_action private.audit_action,
  p_target uuid,
  p_code text,
  p_metadata jsonb default '{}'
)
returns uuid
language plpgsql
set search_path = ''
as $$
begin
  if p_action not in ('owner_protection_refused', 'staff_change_refused') or p_code !~ '^[a-z_]{1,40}$' then
    raise exception 'invalid refusal' using errcode = '22023';
  end if;
  if not private.holds_staff_lock() then
    raise exception 'refusal recorded without the staff lock' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from private.audit_events e
    where e.action = p_action and e.actor_id is not distinct from p_actor
      and e.target_profile_id is not distinct from p_target
      and e.metadata ->> 'code' = p_code
      and e.occurred_at > pg_catalog.now() - interval '10 minutes'
  ) then
    return null;
  end if;
  return private.record_audit(p_actor, p_action, p_target, 'Refused: ' || p_code,
    coalesce(p_metadata, '{}') || pg_catalog.jsonb_build_object('code', p_code));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Integrity report (D12 layer 5)
-- ---------------------------------------------------------------------------

-- Anything wrong with the Owner, for an operator and the tests. Reports a broken
-- Auth schema instead of failing, so it always works.
create function private.owner_integrity()
returns table (finding text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o private.platform_owner;
  v_standing text;
  v_factors integer;
  v_recent integer;
begin
  select * into o from private.platform_owner;
  if not found then
    return query select ('no owner assigned')::text;
    return;
  end if;
  v_standing := private.account_standing(o.user_id);
  if v_standing is not null then
    return query select 'owner account: ' || v_standing;
  end if;
  if not exists (select 1 from public.staff_roles s where s.user_id = o.user_id and s.role = 'admin') then
    return query select ('owner is not an administrator')::text;
  end if;
  v_factors := private.totp_factor_count(o.user_id);
  if v_factors is null then
    return query select ('auth contract broken')::text;
  else
    if v_factors < 2 then
      return query select ('owner has ' || v_factors || ' verified TOTP factors')::text;
    end if;
    v_recent := v_factors - private.totp_factor_count(o.user_id, interval '24 hours');
    if v_recent > 0 or exists (select 1 from auth.mfa_factors f where f.user_id = o.user_id and f.created_at > pg_catalog.now() - interval '24 hours') then
      return query select ('owner security changed in the last 24 hours')::text;
    end if;
  end if;
  if exists (select 1 from private.owner_recoveries r where r.status = 'pending') then
    return query select ('recovery pending')::text;
  end if;
  if exists (select 1 from private.ownership_transfers t where t.status = 'pending') then
    return query select ('transfer pending')::text;
  end if;
exception when undefined_column or undefined_table or undefined_object then
  return query select ('auth contract broken')::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Operator functions (D2, D6). postgres only, from a direct connection, as
--    written in the runbook. None is reachable from the API.
-- ---------------------------------------------------------------------------

-- Locks the profiles given, FOR KEY SHARE in id order, skipping nulls.
create function private.lock_owner_profiles(p_users uuid[])
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.profiles p where p.id = any (p_users) order by p.id for key share;
end;
$$;

-- Assigns the first Owner (D2). Refuses if one exists. The account must be in good
-- standing with at least two verified TOTP factors; it gets the admin role if it
-- hasn't one. The approval itself stays outside the database.
create function private.assign_initial_owner(p_handle text, p_approval text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid;
  v_reason text := private.require_reason(p_approval);
  v_standing text;
  v_factors integer;
  v_granted boolean := false;
begin
  perform private.lock_staff_changes();
  select p.id into v_user from public.profiles p where p.handle = pg_catalog.lower(pg_catalog.btrim(p_handle));
  if v_user is null then
    raise exception 'user unavailable' using errcode = 'P0001';
  end if;
  perform private.lock_owner_profiles(array[v_user]);
  perform 1 from private.platform_owner for update;
  if found then
    raise exception 'an owner is already assigned' using errcode = 'P0001';
  end if;
  v_standing := private.account_standing(v_user);
  if v_standing is not null then
    raise exception 'account not eligible: %', v_standing using errcode = 'P0001';
  end if;
  v_factors := private.totp_factor_count(v_user);
  if v_factors is null then
    raise exception 'auth contract broken' using errcode = 'P0001';
  elsif v_factors < 2 then
    raise exception 'two verified TOTP factors required' using errcode = 'P0001';
  end if;
  insert into public.staff_roles (user_id, role, granted_by) values (v_user, 'admin', null)
  on conflict (user_id, role) do nothing;
  v_granted := found;
  insert into private.platform_owner (user_id) values (v_user);
  perform private.record_audit(null, 'owner_assigned', v_user, v_reason, pg_catalog.jsonb_build_object('admin_granted', v_granted));
  return v_user;
end;
$$;

-- Opens a break-glass recovery (D6). 'factor_reset' keeps the Owner and lets an
-- operator remove their factors after the hold; 'reassign' moves ownership to the
-- target after the hold and the target's own confirmation in the app. Pending
-- transfers are cancelled, and Owner authority is frozen until it ends. A disputed
-- recovery (D6b) needs an earlier one the Owner cancelled in the last 30 days, and
-- can then be cancelled only by an operator. p_fingerprint is the SHA-256 of the
-- succession document presented, when one is registered.
create function private.begin_owner_recovery(
  p_kind text,
  p_target_handle text,
  p_case_ref text,
  p_fingerprint text default null,
  p_disputed boolean default false
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  o private.platform_owner;
  v_target uuid;
  v_case text := pg_catalog.btrim(p_case_ref);
  v_matched boolean;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('factor_reset', 'reassign') or v_case is null or v_case = ''
     or (p_fingerprint is not null and p_fingerprint !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid recovery' using errcode = '22023';
  end if;
  perform private.lock_staff_changes();
  select * into o from private.platform_owner;
  if not found then
    raise exception 'no owner assigned' using errcode = 'P0001';
  end if;
  if p_kind = 'factor_reset' then
    v_target := o.user_id;
  else
    select p.id into v_target from public.profiles p where p.handle = pg_catalog.lower(pg_catalog.btrim(p_target_handle));
    if v_target is null or v_target = o.user_id then
      raise exception 'user unavailable' using errcode = 'P0001';
    end if;
  end if;
  perform private.lock_owner_profiles(array[o.user_id, v_target]);
  select * into o from private.platform_owner for update;
  if exists (select 1 from private.owner_recoveries r where r.status = 'pending') then
    raise exception 'recovery pending' using errcode = 'P0001';
  end if;
  if p_disputed and not exists (
    select 1 from private.owner_recoveries r
    where r.cancelled_by_owner and r.owner_id = o.user_id and r.decided_at > pg_catalog.now() - interval '30 days'
  ) then
    raise exception 'a disputed recovery follows one the owner cancelled' using errcode = 'P0001';
  end if;
  if p_kind = 'reassign' then
    if private.account_standing(v_target) is not null then
      raise exception 'user unavailable' using errcode = 'P0001';
    end if;
    if o.succession_fingerprint is not null then
      if p_fingerprint is distinct from o.succession_fingerprint then
        raise exception 'succession document does not match' using errcode = 'P0001';
      end if;
      v_matched := true;
    elsif p_fingerprint is not null then
      raise exception 'no succession document is registered' using errcode = 'P0001';
    end if;
  end if;
  update private.ownership_transfers t
  set status = 'cancelled', decided_at = pg_catalog.now(), cancel_cause = 'recovery_started'
  where t.status = 'pending';
  insert into private.owner_recoveries (kind, owner_id, target_id, case_ref, disputed, fingerprint_matched, hold_until)
  values (p_kind, o.user_id, v_target, v_case, coalesce(p_disputed, false), v_matched, pg_catalog.now() + interval '72 hours')
  returning id into v_id;
  perform private.record_audit(null, 'owner_recovery_started', v_target, v_case, pg_catalog.jsonb_build_object(
    'recovery_id', v_id, 'kind', p_kind, 'owner_id', o.user_id, 'disputed', coalesce(p_disputed, false),
    'fingerprint', case when v_matched then 'matched' when p_kind = 'reassign' then 'none registered' else 'not applicable' end,
    'designated_successor', p_kind = 'reassign' and o.successor_id is not distinct from v_target));
  return v_id;
end;
$$;

-- Completes a pending recovery after its hold. 'reassign' also needs the target's
-- confirmation, and moves ownership, the admin role with it, and removes the
-- previous Owner's admin role (D6c), all in this transaction. 'factor_reset' records
-- that the operator may now remove the Owner's factors through the Auth Admin API.
create function private.complete_owner_recovery(p_recovery uuid, p_case_ref text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  o private.platform_owner;
  r private.owner_recoveries;
  v_case text := private.require_reason(p_case_ref);
  v_factors integer;
  v_revoked boolean := false;
begin
  perform private.lock_staff_changes();
  select * into o from private.platform_owner;
  select * into r from private.owner_recoveries x where x.id = p_recovery;
  if not found or o.user_id is null then
    raise exception 'recovery unavailable' using errcode = 'P0001';
  end if;
  perform private.lock_owner_profiles(array[o.user_id, r.target_id]);
  select * into o from private.platform_owner for update;
  select * into r from private.owner_recoveries x where x.id = p_recovery for update;
  if r.status <> 'pending' then
    raise exception 'recovery not pending' using errcode = 'P0001';
  end if;
  if pg_catalog.now() < r.hold_until then
    raise exception 'recovery hold not over' using errcode = 'P0001';
  end if;
  if r.owner_id is distinct from o.user_id then
    raise exception 'owner changed since the recovery began' using errcode = 'P0001';
  end if;
  if r.kind = 'reassign' then
    if r.target_id is null or private.account_standing(r.target_id) is not null then
      raise exception 'user unavailable' using errcode = 'P0001';
    end if;
    if r.confirmed_at is null then
      raise exception 'target has not confirmed' using errcode = 'P0001';
    end if;
    v_factors := private.totp_factor_count(r.target_id);
    if v_factors is null then
      raise exception 'auth contract broken' using errcode = 'P0001';
    elsif v_factors < 2 then
      raise exception 'two verified TOTP factors required' using errcode = 'P0001';
    end if;
    perform pg_catalog.set_config('mygamedex.owner_change', 'on', true);
    update private.platform_owner set user_id = r.target_id, successor_id = null, succession_fingerprint = null, succession_registered_at = null;
    perform pg_catalog.set_config('mygamedex.owner_change', 'off', true);
    insert into public.staff_roles (user_id, role, granted_by) values (r.target_id, 'admin', null)
    on conflict (user_id, role) do nothing;
    delete from public.staff_roles s where s.user_id = o.user_id and s.role = 'admin';
    v_revoked := found;
  end if;
  update private.owner_recoveries set status = 'completed', decided_at = pg_catalog.now() where id = r.id;
  perform private.record_audit(null, 'owner_recovery_completed', r.target_id, v_case, pg_catalog.jsonb_build_object(
    'recovery_id', r.id, 'kind', r.kind, 'previous_owner_id', o.user_id, 'previous_owner_admin_revoked', v_revoked));
  return pg_catalog.jsonb_build_object('kind', r.kind, 'owner_id', case when r.kind = 'reassign' then r.target_id else o.user_id end, 'previous_owner_admin_revoked', v_revoked);
end;
$$;

-- An operator cancels a pending recovery, disputed or not.
create function private.cancel_owner_recovery_by_operator(p_recovery uuid, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_reason text := private.require_reason(p_reason);
  r private.owner_recoveries;
begin
  perform private.lock_staff_changes();
  select * into r from private.owner_recoveries x where x.id = p_recovery for update;
  if not found or r.status <> 'pending' then
    raise exception 'recovery not pending' using errcode = 'P0001';
  end if;
  update private.owner_recoveries set status = 'cancelled', decided_at = pg_catalog.now(), cancel_cause = 'operator' where id = r.id;
  perform private.record_audit(null, 'owner_recovery_cancelled', r.target_id, v_reason,
    pg_catalog.jsonb_build_object('recovery_id', r.id, 'kind', r.kind, 'by', 'operator'));
end;
$$;

-- Suspends or reinstates the Owner's account, for an operator only: no app path can
-- change it (protect_owner_status).
create function private.operator_set_owner_status(p_status public.account_status, p_reason text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_reason text := private.require_reason(p_reason);
  v_owner uuid;
  v_current public.account_status;
begin
  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  perform private.lock_staff_changes();
  select o.user_id into v_owner from private.platform_owner o;
  if v_owner is null then
    raise exception 'no owner assigned' using errcode = 'P0001';
  end if;
  select p.account_status into v_current from public.profiles p where p.id = v_owner for update;
  if v_current = p_status then
    return false;
  end if;
  perform pg_catalog.set_config('mygamedex.owner_status_change', 'on', true);
  update public.profiles set account_status = p_status where id = v_owner;
  perform pg_catalog.set_config('mygamedex.owner_status_change', 'off', true);
  perform private.record_audit(null, 'owner_status_set_by_operator', v_owner, v_reason,
    pg_catalog.jsonb_build_object('from', v_current, 'to', p_status));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Privileges
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.guard_platform_owner()',
    'private.is_designated_owner(uuid)',
    'private.account_standing(uuid)',
    'private.totp_factor_count(uuid, interval)',
    'private.holds_staff_lock()',
    'private.protect_owner_profile()',
    'private.protect_owner_status()',
    'private.protect_owner_admin_role()',
    'private.record_refusal(uuid, private.audit_action, uuid, text, jsonb)',
    'private.owner_integrity()',
    'private.lock_owner_profiles(uuid[])',
    'private.assign_initial_owner(text, text)',
    'private.begin_owner_recovery(text, text, text, text, boolean)',
    'private.complete_owner_recovery(uuid, text)',
    'private.cancel_owner_recovery_by_operator(uuid, text)',
    'private.operator_set_owner_status(public.account_status, text)',
    'public.account_deletion_blocked(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
end;
$$;

grant execute on function public.account_deletion_blocked(uuid) to service_role;
