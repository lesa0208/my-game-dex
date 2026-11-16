-- M8c Superadmin foundation: the staff authority matrix, the JSONB contract for the
-- staff functions (D9, D15), ownership transfer (D5), the successor and succession
-- document (D14, D6a), and the app side of recovery (D6, D6b).
--
-- Design: docs/architecture/security-rls.md#staff-authority-m8 and ADR-055.
--
-- Authority matrix, enforced here and nowhere else:
--   grant or revoke admin                    Owner, with Owner authority (A1, D13)
--   grant or revoke catalog_editor/moderator  any admin, the Owner included
--   suspend or reinstate an admin             Owner, with Owner authority
--   suspend or reinstate an editor/moderator  any admin
--   suspend or reinstate a collector          any moderator or admin
--   any change to the Owner                   nobody (owner_protected)
--   any change to oneself                     nobody (self_change, D7)
-- Every staff-management action needs a TOTP verification in the last 10 minutes (D3).
-- The Owner gains nothing else: no collection, purchase-data, catalog or review rule
-- mentions the Owner.
--
-- Contract (A4). Success: {"ok": true, "result": "changed" | "unchanged", "audit_id"}.
-- Refusal of verified staff: {"ok": false, "refusal": "<code>", "audit_id"}, committed
-- with its audit row and nothing else; audit_id is null when rate-limited. Anything
-- else raises and writes nothing: 42501 'not permitted', P0001 'reauthentication
-- required', 22023 invalid input, P0001 'user unavailable' and the like.
--
-- Every function runs in the same phases: take the staff lock; authenticate (raises);
-- validate (raises); lock and load the rows, in the shared order (profiles FOR KEY
-- SHARE in id order, then platform_owner FOR UPDATE, then transfer or recovery rows);
-- evaluate the whole matrix; only then write. A refusal writes only its audit row.

-- ---------------------------------------------------------------------------
-- 1. Guard (A2): the four functions replaced below must be exactly what M4 created,
--    with nothing depending on them. Any difference stops this migration, which then
--    changes nothing (each migration file applies in one transaction, B1).
-- ---------------------------------------------------------------------------

do $guard$
declare
  r record;
  v_oid oid;
  v_proc pg_catalog.pg_proc;
begin
  for r in
    select * from (values
      ('public.grant_staff_role(uuid, public.staff_role, text)', 'grant_staff_role', 'boolean'),
      ('public.revoke_staff_role(uuid, public.staff_role, text)', 'revoke_staff_role', 'boolean'),
      ('public.set_account_status(uuid, public.account_status, text)', 'set_account_status', 'boolean'),
      ('public.get_audit_events(integer, uuid)', 'get_audit_events',
        'TABLE(id uuid, occurred_at timestamp with time zone, actor_id uuid, action text, target_profile_id uuid, reason text, metadata jsonb)')
    ) as t (signature, name, result)
  loop
    v_oid := pg_catalog.to_regprocedure(r.signature);
    if v_oid is null then
      raise exception 'M8c guard: % is missing', r.signature;
    end if;
    select * into v_proc from pg_catalog.pg_proc where oid = v_oid;
    if pg_catalog.pg_get_function_result(v_oid) is distinct from r.result then
      raise exception 'M8c guard: % returns %, expected %', r.signature, pg_catalog.pg_get_function_result(v_oid), r.result;
    end if;
    if not v_proc.prosecdef or v_proc.proconfig is distinct from array['search_path=""']
       or pg_catalog.pg_get_userbyid(v_proc.proowner) <> 'postgres' then
      raise exception 'M8c guard: % is not the SECURITY DEFINER function M4 created', r.signature;
    end if;
    if v_proc.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres}' then
      raise exception 'M8c guard: % has privileges %, expected EXECUTE for authenticated only', r.signature, v_proc.proacl;
    end if;
    if (select count(*) from pg_catalog.pg_proc p where p.proname = r.name) <> 1 then
      raise exception 'M8c guard: % has another overload', r.name;
    end if;
    if exists (select 1 from pg_catalog.pg_depend d where d.refclassid = 'pg_catalog.pg_proc'::regclass and d.refobjid = v_oid) then
      raise exception 'M8c guard: something depends on %', r.signature;
    end if;
  end loop;
end;
$guard$;

-- Exact signatures, without CASCADE: if anything depended on them, this would fail.
drop function public.grant_staff_role(uuid, public.staff_role, text);
drop function public.revoke_staff_role(uuid, public.staff_role, text);
drop function public.set_account_status(uuid, public.account_status, text);
drop function public.get_audit_events(integer, uuid);

-- ---------------------------------------------------------------------------
-- 2. Helpers. None is reachable from the API.
-- ---------------------------------------------------------------------------

-- A success result. No audit row means nothing changed.
create function private.staff_result(p_audit uuid, p_extra jsonb default '{}')
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('ok', true, 'result', case when p_audit is null then 'unchanged' else 'changed' end, 'audit_id', p_audit)
    || coalesce(p_extra, '{}')
$$;

-- Records a refusal (rate-limited, under the staff lock) and returns its result.
-- Attempts on the Owner are owner_protection_refused; the rest staff_change_refused.
-- If the audit row can't be written this raises, so nothing is committed silently.
create function private.staff_refusal(p_actor uuid, p_target uuid, p_code text, p_metadata jsonb default '{}')
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_audit uuid;
begin
  v_audit := private.record_refusal(
    p_actor,
    case when p_code = 'owner_protected' then 'owner_protection_refused' else 'staff_change_refused' end::private.audit_action,
    p_target, p_code, p_metadata);
  return pg_catalog.jsonb_build_object('ok', false, 'refusal', p_code, 'audit_id', v_audit);
end;
$$;

-- Why p_actor can't grant or revoke p_role for p_user, or null if they can. The
-- caller is already an active admin with recent MFA.
create function private.role_change_refusal(p_actor uuid, p_user uuid, p_role public.staff_role)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_user = p_actor then
    return 'self_change';
  end if;
  if private.is_designated_owner(p_user) then
    return 'owner_protected';
  end if;
  if p_role = 'admin' then
    return private.owner_authority_refusal();
  end if;
  return null;
end;
$$;

-- Whether p_user could hold the Owner record now: good standing, an admin, and at
-- least two verified TOTP factors (D13). Authority also needs them to mature.
create function private.owner_candidate_ok(p_user uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select private.account_standing(p_user) is null
    and exists (select 1 from public.staff_roles s where s.user_id = p_user and s.role = 'admin')
    and coalesce(private.totp_factor_count(p_user), 0) >= 2
$$;

-- When p_user stops being an admin or is suspended, the pending transfer to them is
-- cancelled, and a successor who is no longer an admin is cleared, each audited
-- with p_actor and p_reason. Called after the change, under the same locks.
create function private.close_owner_designations(p_actor uuid, p_user uuid, p_cause text, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_transfer uuid;
begin
  if p_cause = 'target_role_revoked' then
    update private.platform_owner o set successor_id = null where o.successor_id = p_user;
    if found then
      perform private.record_audit(p_actor, 'owner_successor_set', p_user, p_reason,
        pg_catalog.jsonb_build_object('successor_id', null, 'previous_successor_id', p_user, 'cause', p_cause));
    end if;
  end if;
  for v_transfer in
    update private.ownership_transfers t
    set status = 'cancelled', decided_at = pg_catalog.now(), decided_by = p_actor, cancel_cause = p_cause
    where t.status = 'pending' and t.to_user = p_user
    returning t.id
  loop
    perform private.record_audit(p_actor, 'ownership_transfer_cancelled', p_user, p_reason,
      pg_catalog.jsonb_build_object('transfer_id', v_transfer, 'cause', p_cause));
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The staff functions, under the matrix
-- ---------------------------------------------------------------------------

create function public.grant_staff_role(p_user uuid, p_role public.staff_role, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_refusal text;
  v_audit uuid;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  if p_role is null then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  -- Only active, verified accounts with a handle can hold a role.
  perform private.lock_owner_profiles(array[v_me, p_user]);
  if p_user is null or not exists (
    select 1 from public.profiles p join auth.users u on u.id = p.id
    where p.id = p_user and p.account_status = 'active' and p.handle is not null and u.email_confirmed_at is not null
  ) then
    raise exception 'user unavailable' using errcode = 'P0001';
  end if;

  v_refusal := private.role_change_refusal(v_me, p_user, p_role);
  if v_refusal is not null then
    return private.staff_refusal(v_me, p_user, v_refusal, pg_catalog.jsonb_build_object('operation', 'grant_staff_role', 'role', p_role));
  end if;

  insert into public.staff_roles (user_id, role, granted_by)
  values (p_user, p_role, v_me)
  on conflict (user_id, role) do nothing;
  if not found then
    return private.staff_result(null);
  end if;
  v_audit := private.record_audit(v_me, 'staff_role_granted', p_user, v_reason, pg_catalog.jsonb_build_object('role', p_role));
  return private.staff_result(v_audit);
end;
$$;

-- "At least one administrator remains" is now "the Owner is always an administrator":
-- only the Owner, in good standing, revokes admin, never their own, and the Owner's
-- admin role can't be removed (protect_owner_admin_role).
create function public.revoke_staff_role(p_user uuid, p_role public.staff_role, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_refusal text;
  v_audit uuid;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  if p_role is null then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  perform private.lock_owner_profiles(array[v_me, p_user]);
  v_refusal := private.role_change_refusal(v_me, p_user, p_role);
  if v_refusal is not null then
    return private.staff_refusal(v_me, p_user, v_refusal, pg_catalog.jsonb_build_object('operation', 'revoke_staff_role', 'role', p_role));
  end if;

  delete from public.staff_roles s where s.user_id = p_user and s.role = p_role;
  if not found then
    return private.staff_result(null);
  end if;
  v_audit := private.record_audit(v_me, 'staff_role_revoked', p_user, v_reason, pg_catalog.jsonb_build_object('role', p_role));
  if p_role = 'admin' then
    perform private.close_owner_designations(v_me, p_user, 'target_role_revoked', v_reason);
  end if;
  return private.staff_result(v_audit);
end;
$$;

-- Suspends or reinstates an account. 'deactivated' is not managed here.
create function public.set_account_status(p_user uuid, p_status public.account_status, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_current public.account_status;
  v_refusal text;
  v_audit uuid;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('moderator');
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if p_user is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select p.account_status into v_current
  from public.profiles p
  where p.id = p_user
  for update;
  if not found or v_current = 'deactivated' then
    raise exception 'user unavailable' using errcode = 'P0001';
  end if;

  if p_user = v_me then
    v_refusal := 'self_change';
  elsif private.is_designated_owner(p_user) then
    v_refusal := 'owner_protected';
  elsif exists (select 1 from public.staff_roles s where s.user_id = p_user and s.role = 'admin') then
    v_refusal := private.owner_authority_refusal();
  elsif exists (select 1 from public.staff_roles s where s.user_id = p_user) and not private.has_staff_role('admin') then
    v_refusal := 'admin_required';
  end if;
  if v_refusal is not null then
    return private.staff_refusal(v_me, p_user, v_refusal, pg_catalog.jsonb_build_object('operation', 'set_account_status', 'status', p_status));
  end if;

  if v_current = p_status then
    return private.staff_result(null);
  end if;
  update public.profiles set account_status = p_status where id = p_user;
  v_audit := private.record_audit(
    v_me,
    case p_status when 'suspended' then 'account_suspended'::private.audit_action else 'account_reinstated'::private.audit_action end,
    p_user,
    v_reason,
    pg_catalog.jsonb_build_object('from', v_current, 'to', p_status)
  );
  if p_status = 'suspended' then
    perform private.close_owner_designations(v_me, p_user, 'target_suspended', v_reason);
  end if;
  return private.staff_result(v_audit);
end;
$$;

-- Administrators only. Newest first, 1 to 100 rows, paged by id. M8c adds outcome:
-- succeeded, refused or operator (D9).
create function public.get_audit_events(p_limit integer default 50, p_before uuid default null)
returns table (
  id uuid,
  occurred_at timestamptz,
  actor_id uuid,
  action text,
  target_profile_id uuid,
  reason text,
  metadata jsonb,
  outcome text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_staff('admin');
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid page request' using errcode = '22023';
  end if;
  return query
    select e.id, e.occurred_at, e.actor_id, e.action::text, e.target_profile_id, e.reason, e.metadata, e.outcome
    from private.audit_events e
    where p_before is null or e.id < p_before
    order by e.id desc
    limit p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Ownership transfer (D5): the Owner offers, an admin accepts within 72 hours.
--    The previous Owner stays an admin. Ownership is never in a token: every check
--    reads platform_owner under the staff lock, so a stale session gains nothing.
-- ---------------------------------------------------------------------------

create function public.start_ownership_transfer(p_to uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_refusal text;
  v_transfer private.ownership_transfers;
  v_audit uuid;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);

  perform private.lock_owner_profiles(array[v_me, p_to]);
  if p_to is null or not exists (select 1 from public.profiles p where p.id = p_to) then
    raise exception 'user unavailable' using errcode = 'P0001';
  end if;
  perform 1 from private.platform_owner for update;

  v_refusal := private.owner_authority_refusal();
  if v_refusal is null and p_to = v_me then
    v_refusal := 'self_change';
  end if;
  if v_refusal is null and exists (select 1 from private.ownership_transfers t where t.status = 'pending' and t.expires_at > pg_catalog.now()) then
    v_refusal := 'transfer_pending';
  end if;
  if v_refusal is null and not private.owner_candidate_ok(p_to) then
    v_refusal := 'target_ineligible';
  end if;
  if v_refusal is not null then
    return private.staff_refusal(v_me, p_to, v_refusal, pg_catalog.jsonb_build_object('operation', 'start_ownership_transfer'));
  end if;

  -- A transfer left to expire is closed now, so the new one can be the pending one.
  update private.ownership_transfers t set status = 'expired', decided_at = pg_catalog.now()
  where t.status = 'pending' and t.expires_at <= pg_catalog.now();
  insert into private.ownership_transfers (from_user, to_user, expires_at)
  values (v_me, p_to, pg_catalog.now() + interval '72 hours')
  returning * into v_transfer;
  v_audit := private.record_audit(v_me, 'ownership_transfer_started', p_to, v_reason,
    pg_catalog.jsonb_build_object('transfer_id', v_transfer.id, 'expires_at', v_transfer.expires_at));
  return private.staff_result(v_audit, pg_catalog.jsonb_build_object('transfer_id', v_transfer.id));
end;
$$;

-- The target accepts. Everything is checked again under the locks: still pending and
-- unexpired, offered by the current Owner, no recovery pending, and the target still
-- an admin in good standing with two verified factors and a recent verification.
create function public.accept_ownership_transfer(p_transfer uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_owner uuid;
  t private.ownership_transfers;
  v_refusal text;
  v_audit uuid;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  if p_transfer is null then
    raise exception 'invalid transfer' using errcode = '22023';
  end if;

  select * into t from private.ownership_transfers x where x.id = p_transfer;
  if not found or t.to_user is distinct from v_me then
    raise exception 'transfer unavailable' using errcode = 'P0001';
  end if;
  perform private.lock_owner_profiles(array[t.from_user, t.to_user]);
  select o.user_id into v_owner from private.platform_owner o for update;
  select * into t from private.ownership_transfers x where x.id = p_transfer for update;
  if t.status = 'accepted' and t.to_user = v_me and v_owner = v_me then
    return private.staff_result(null, pg_catalog.jsonb_build_object('transfer_id', t.id));
  end if;
  if t.status <> 'pending' or t.to_user is distinct from v_me or t.from_user is distinct from v_owner then
    raise exception 'transfer unavailable' using errcode = 'P0001';
  end if;

  if t.expires_at <= pg_catalog.now() then
    v_refusal := 'transfer_expired';
  elsif exists (select 1 from private.owner_recoveries r where r.status = 'pending') then
    v_refusal := 'recovery_pending';
  elsif not private.owner_candidate_ok(v_me) then
    v_refusal := 'target_ineligible';
  end if;
  if v_refusal is not null then
    return private.staff_refusal(v_me, v_me, v_refusal, pg_catalog.jsonb_build_object('operation', 'accept_ownership_transfer', 'transfer_id', t.id));
  end if;

  -- The successor and succession document were the previous Owner's. Every update of
  -- the singleton names its key: PostgREST sessions load safeupdate, which refuses an
  -- UPDATE without a WHERE clause.
  perform pg_catalog.set_config('mygamedex.owner_change', 'on', true);
  update private.platform_owner
  set user_id = v_me, successor_id = null, succession_fingerprint = null, succession_registered_at = null
  where id;
  perform pg_catalog.set_config('mygamedex.owner_change', 'off', true);
  update private.ownership_transfers set status = 'accepted', decided_at = pg_catalog.now(), decided_by = v_me where id = t.id;
  v_audit := private.record_audit(v_me, 'ownership_transfer_accepted', v_me, 'Accepted the ownership transfer',
    pg_catalog.jsonb_build_object('transfer_id', t.id, 'previous_owner_id', t.from_user));
  return private.staff_result(v_audit, pg_catalog.jsonb_build_object('transfer_id', t.id));
end;
$$;

-- The Owner cancels (with a recent verification) or the target declines (at aal2).
create function public.cancel_ownership_transfer(p_transfer uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  t private.ownership_transfers;
  v_by text;
  v_audit uuid;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('admin');
  v_reason := private.require_reason(p_reason);
  if p_transfer is null then
    raise exception 'invalid transfer' using errcode = '22023';
  end if;

  select * into t from private.ownership_transfers x where x.id = p_transfer;
  if not found or (t.from_user is distinct from v_me and t.to_user is distinct from v_me) then
    raise exception 'transfer unavailable' using errcode = 'P0001';
  end if;
  v_by := case when t.from_user = v_me then 'owner' else 'target' end;
  if v_by = 'owner' then
    perform private.require_recent_mfa();
  end if;
  perform private.lock_owner_profiles(array[t.from_user, t.to_user]);
  select * into t from private.ownership_transfers x where x.id = p_transfer for update;
  if t.status <> 'pending' then
    return private.staff_result(null, pg_catalog.jsonb_build_object('transfer_id', t.id));
  end if;

  update private.ownership_transfers
  set status = case v_by when 'owner' then 'cancelled' else 'declined' end,
      decided_at = pg_catalog.now(), decided_by = v_me, cancel_cause = v_by
  where id = t.id;
  v_audit := private.record_audit(v_me, 'ownership_transfer_cancelled', t.to_user, v_reason,
    pg_catalog.jsonb_build_object('transfer_id', t.id, 'by', v_by, 'expired', t.expires_at <= pg_catalog.now()));
  return private.staff_result(v_audit, pg_catalog.jsonb_build_object('transfer_id', t.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Succession (D14, D6a): a visible, powerless successor, and the fingerprint of
--    the succession document kept outside the database. Owner authority required.
-- ---------------------------------------------------------------------------

-- Names another admin in good standing as the default target of a reassignment, or
-- clears the designation with null. It gives them nothing.
create function public.set_owner_successor(p_successor uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_previous uuid;
  v_refusal text;
  v_audit uuid;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);

  perform private.lock_owner_profiles(array[v_me, p_successor]);
  if p_successor is not null and not exists (select 1 from public.profiles p where p.id = p_successor) then
    raise exception 'user unavailable' using errcode = 'P0001';
  end if;
  select o.successor_id into v_previous from private.platform_owner o for update;

  v_refusal := private.owner_authority_refusal();
  if v_refusal is null and p_successor = v_me then
    v_refusal := 'self_change';
  end if;
  if v_refusal is null and p_successor is not null and not (
    private.account_standing(p_successor) is null
    and exists (select 1 from public.staff_roles s where s.user_id = p_successor and s.role = 'admin')
  ) then
    v_refusal := 'target_ineligible';
  end if;
  if v_refusal is not null then
    return private.staff_refusal(v_me, p_successor, v_refusal, pg_catalog.jsonb_build_object('operation', 'set_owner_successor'));
  end if;

  if v_previous is not distinct from p_successor then
    return private.staff_result(null);
  end if;
  update private.platform_owner set successor_id = p_successor where id;
  v_audit := private.record_audit(v_me, 'owner_successor_set', p_successor, v_reason,
    pg_catalog.jsonb_build_object('successor_id', p_successor, 'previous_successor_id', v_previous));
  return private.staff_result(v_audit);
end;
$$;

-- Registers the SHA-256 of the succession document (64 hex digits), or clears it
-- with null. The fingerprint is recorded in the audit row: it reveals nothing of the
-- document and lets an operator match the one presented in a recovery.
create function public.register_succession_document(p_fingerprint text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_fingerprint text := pg_catalog.lower(pg_catalog.btrim(p_fingerprint));
  v_previous text;
  v_refusal text;
  v_audit uuid;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  if v_fingerprint is not null and v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid fingerprint' using errcode = '22023';
  end if;

  perform private.lock_owner_profiles(array[v_me]);
  select o.succession_fingerprint into v_previous from private.platform_owner o for update;
  v_refusal := private.owner_authority_refusal();
  if v_refusal is not null then
    return private.staff_refusal(v_me, v_me, v_refusal, pg_catalog.jsonb_build_object('operation', 'register_succession_document'));
  end if;

  if v_previous is not distinct from v_fingerprint then
    return private.staff_result(null);
  end if;
  update private.platform_owner
  set succession_fingerprint = v_fingerprint,
      succession_registered_at = case when v_fingerprint is null then null else pg_catalog.now() end
  where id;
  v_audit := private.record_audit(v_me, 'owner_succession_registered', v_me, v_reason,
    pg_catalog.jsonb_build_object('fingerprint', v_fingerprint, 'replaced', v_previous is not null));
  return private.staff_result(v_audit);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Recovery, the app side (D6). An operator opens and completes recoveries in SQL
--    (M8a); in the app the target confirms, and the Owner may cancel.
-- ---------------------------------------------------------------------------

-- The target of a pending reassignment confirms it with a recent verification,
-- proving they control the account and its MFA. Completion requires this.
create function public.confirm_owner_recovery(p_recovery uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_owner uuid;
  r private.owner_recoveries;
  v_audit uuid;
begin
  perform private.lock_staff_changes();
  v_me := private.require_recent_mfa();
  if not private.is_active_user() then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_recovery is null then
    raise exception 'invalid recovery' using errcode = '22023';
  end if;

  select * into r from private.owner_recoveries x where x.id = p_recovery;
  if not found or r.kind <> 'reassign' or r.target_id is distinct from v_me then
    raise exception 'recovery unavailable' using errcode = 'P0001';
  end if;
  select o.user_id into v_owner from private.platform_owner o;
  perform private.lock_owner_profiles(array[v_owner, r.target_id]);
  perform 1 from private.platform_owner for update;
  select * into r from private.owner_recoveries x where x.id = p_recovery for update;
  if r.status <> 'pending' or r.target_id is distinct from v_me then
    raise exception 'recovery unavailable' using errcode = 'P0001';
  end if;
  if r.confirmed_at is not null then
    return private.staff_result(null, pg_catalog.jsonb_build_object('recovery_id', r.id));
  end if;

  update private.owner_recoveries set confirmed_at = pg_catalog.now() where id = r.id;
  v_audit := private.record_audit(v_me, 'owner_recovery_confirmed', v_me, 'Confirmed the ownership recovery',
    pg_catalog.jsonb_build_object('recovery_id', r.id));
  return private.staff_result(v_audit, pg_catalog.jsonb_build_object('recovery_id', r.id));
end;
$$;

-- The designated Owner cancels a pending recovery (D6b): a live aal2 session, a
-- recent verification and good standing, but not full Owner authority, so the real
-- Owner can stop a takeover after losing a factor. A disputed recovery can't be
-- cancelled here, only by an operator: after the Owner cancels one, an operator may
-- open a disputed one (begin_owner_recovery), so a compromised session can't block
-- recovery indefinitely. Refused attempts are audited.
create function public.cancel_owner_recovery(p_recovery uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_owner uuid;
  r private.owner_recoveries;
  v_refusal text;
  v_audit uuid;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  if p_recovery is null then
    raise exception 'invalid recovery' using errcode = '22023';
  end if;

  select * into r from private.owner_recoveries x where x.id = p_recovery;
  if not found then
    raise exception 'recovery unavailable' using errcode = 'P0001';
  end if;
  select o.user_id into v_owner from private.platform_owner o;
  perform private.lock_owner_profiles(array[v_owner, r.target_id]);
  perform 1 from private.platform_owner for update;
  select * into r from private.owner_recoveries x where x.id = p_recovery for update;

  if not private.is_designated_owner(v_me) then
    v_refusal := 'owner_only';
  elsif private.account_standing(v_me) is not null then
    v_refusal := 'owner_ineligible';
  elsif r.status = 'pending' and r.disputed then
    v_refusal := 'recovery_disputed';
  end if;
  if v_refusal is not null then
    return private.staff_refusal(v_me, r.target_id, v_refusal, pg_catalog.jsonb_build_object('operation', 'cancel_owner_recovery', 'recovery_id', r.id));
  end if;
  if r.status <> 'pending' then
    return private.staff_result(null, pg_catalog.jsonb_build_object('recovery_id', r.id));
  end if;

  update private.owner_recoveries
  set status = 'cancelled', decided_at = pg_catalog.now(), cancelled_by_owner = true, cancel_cause = 'owner'
  where id = r.id;
  v_audit := private.record_audit(v_me, 'owner_recovery_cancelled', r.target_id, v_reason,
    pg_catalog.jsonb_build_object('recovery_id', r.id, 'kind', r.kind, 'by', 'owner'));
  return private.staff_result(v_audit, pg_catalog.jsonb_build_object('recovery_id', r.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. The operator's completion (M8a) names the Owner record's key in its update, like
--    every update here: harmless from the direct connection operators use, and safe
--    should it ever run in a session that loads safeupdate. Otherwise unchanged.
-- ---------------------------------------------------------------------------

create or replace function private.complete_owner_recovery(p_recovery uuid, p_case_ref text)
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
    update private.platform_owner set user_id = r.target_id, successor_id = null, succession_fingerprint = null, succession_registered_at = null where id;
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

-- ---------------------------------------------------------------------------
-- 8. Privileges: the same as M4 gave the staff functions, EXECUTE for authenticated
--    only; the helpers for nobody.
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.staff_result(uuid, jsonb)',
    'private.staff_refusal(uuid, uuid, text, jsonb)',
    'private.role_change_refusal(uuid, uuid, public.staff_role)',
    'private.owner_candidate_ok(uuid)',
    'private.close_owner_designations(uuid, uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.grant_staff_role(uuid, public.staff_role, text)',
    'public.revoke_staff_role(uuid, public.staff_role, text)',
    'public.set_account_status(uuid, public.account_status, text)',
    'public.get_audit_events(integer, uuid)',
    'public.start_ownership_transfer(uuid, text)',
    'public.accept_ownership_transfer(uuid)',
    'public.cancel_ownership_transfer(uuid, text)',
    'public.set_owner_successor(uuid, text)',
    'public.register_succession_document(text, text)',
    'public.confirm_owner_recovery(uuid)',
    'public.cancel_owner_recovery(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
