-- M4a Audit: audited staff functions and admin access to the audit log.
--
-- Design: docs/architecture/security-rls.md#staff-actions
-- Every function takes the staff-changes lock before checking the caller, so a
-- caller whose role or account changes concurrently is checked against the result.
-- Each change and its audit row commit together, or not at all. A call that changes
-- nothing records nothing and returns false.

create function public.grant_staff_role(p_user uuid, p_role public.staff_role, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('admin');
  v_reason := private.require_reason(p_reason);
  if p_role is null then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  -- Only active, verified accounts with a handle can hold a role.
  if p_user is null or not exists (
    select 1 from public.profiles p join auth.users u on u.id = p.id
    where p.id = p_user and p.account_status = 'active' and p.handle is not null and u.email_confirmed_at is not null
  ) then
    raise exception 'user unavailable' using errcode = 'P0001';
  end if;

  insert into public.staff_roles (user_id, role, granted_by)
  values (p_user, p_role, v_me)
  on conflict (user_id, role) do nothing;
  if not found then
    return false;
  end if;

  perform private.record_audit(v_me, 'staff_role_granted', p_user, v_reason, pg_catalog.jsonb_build_object('role', p_role));
  return true;
end;
$$;

create function public.revoke_staff_role(p_user uuid, p_role public.staff_role, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('admin');
  v_reason := private.require_reason(p_reason);
  if p_role is null then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  if not exists (select 1 from public.staff_roles s where s.user_id = p_user and s.role = p_role) then
    return false;
  end if;

  -- At least one active administrator must remain. The lock makes this check and
  -- the delete atomic against every other staff change.
  if p_role = 'admin' and private.other_active_admins(p_user) = 0 then
    raise exception 'last administrator' using errcode = 'P0001';
  end if;

  delete from public.staff_roles s where s.user_id = p_user and s.role = p_role;
  perform private.record_audit(v_me, 'staff_role_revoked', p_user, v_reason, pg_catalog.jsonb_build_object('role', p_role));
  return true;
end;
$$;

-- Suspends or reinstates an account. Moderators act on accounts without a staff
-- role; accounts with any staff role need an administrator. Nobody acts on
-- themselves. 'deactivated' is not managed here.
create function public.set_account_status(p_user uuid, p_status public.account_status, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_current public.account_status;
begin
  perform private.lock_staff_changes();
  v_me := private.require_active_staff('moderator');
  v_reason := private.require_reason(p_reason);
  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if p_user is null or p_user = v_me then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select p.account_status into v_current
  from public.profiles p
  where p.id = p_user
  for update;
  if not found or v_current = 'deactivated' then
    raise exception 'user unavailable' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.staff_roles s where s.user_id = p_user) then
    -- The caller is then an active admin other than the target, so suspending an
    -- admin can never leave none.
    if not private.has_staff_role('admin') then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end if;

  if v_current = p_status then
    return false;
  end if;

  update public.profiles set account_status = p_status where id = p_user;
  perform private.record_audit(
    v_me,
    case p_status when 'suspended' then 'account_suspended'::private.audit_action else 'account_reinstated'::private.audit_action end,
    p_user,
    v_reason,
    pg_catalog.jsonb_build_object('from', v_current, 'to', p_status)
  );
  return true;
end;
$$;

-- Administrators only. Newest first, 1 to 100 rows, paged by id.
create function public.get_audit_events(p_limit integer default 50, p_before uuid default null)
returns table (
  id uuid,
  occurred_at timestamptz,
  actor_id uuid,
  action text,
  target_profile_id uuid,
  reason text,
  metadata jsonb
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
    select e.id, e.occurred_at, e.actor_id, e.action::text, e.target_profile_id, e.reason, e.metadata
    from private.audit_events e
    where p_before is null or e.id < p_before
    order by e.id desc
    limit p_limit;
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.grant_staff_role(uuid, public.staff_role, text)',
    'public.revoke_staff_role(uuid, public.staff_role, text)',
    'public.set_account_status(uuid, public.account_status, text)',
    'public.get_audit_events(integer, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
