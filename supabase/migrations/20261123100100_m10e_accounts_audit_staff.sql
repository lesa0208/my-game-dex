-- M10e Accounts, Audit and Staff: four reads for the existing /admin pages.
--
-- Design: docs/architecture/security-rls.md#accounts-audit-and-staff-m10e.
--
--   search_accounts(query, limit)  moderators and up: accounts whose handle starts
--                                  with the query, 1 to 25, never by email or name
--   get_account_summary(handle)    moderators and up: one account, its moderation
--                                  counts and its recent history (administrators also
--                                  see its staff-role history)
--   get_audit_log(...)             administrators: the audit log through an explicit
--                                  allow-list of details, by action, kind of action,
--                                  outcome, handles and a range of at most 366 days
--   get_staff_overview()           administrators: each staff member's standing and
--                                  authenticator readiness as counts, the role counts,
--                                  and recent staff changes
--
-- Nothing here writes: every change stays the existing audited functions
-- (set_account_status, grant_staff_role, revoke_staff_role and the Owner functions,
-- M8c), which decide every rule again. No email address, collection, purchase,
-- private note, authenticator secret or name, factor id, session or token is read
-- or returned. get_audit_events (M8d) is unchanged; the page now uses get_audit_log.

-- Audit details a page may show: plain values under known keys, strings cut to 80
-- characters, and a link target for a game or release. Never ids of accounts,
-- fingerprints, tokens or anything else in the metadata.
create function private.audit_details(p_metadata jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce((
    select pg_catalog.jsonb_object_agg(e.key,
      case when pg_catalog.jsonb_typeof(e.value) = 'string' then pg_catalog.to_jsonb(pg_catalog.left(e.value #>> '{}', 80)) else e.value end)
    from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}' end) e
    where e.key in ('code', 'operation', 'role', 'from', 'to', 'status', 'kind', 'by', 'cause', 'reason_code', 'previous_status', 'copies', 'entity')
      and pg_catalog.jsonb_typeof(e.value) in ('string', 'number', 'boolean')
  ), '{}') || case
    when p_metadata ->> 'entity' in ('game', 'release') and p_metadata ->> 'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then pg_catalog.jsonb_build_object('record', pg_catalog.jsonb_build_object('entity', p_metadata ->> 'entity', 'id', p_metadata ->> 'id'))
    else '{}'
  end
$$;

-- One audit event as a page shows it: no account ids, only handles and whether an
-- account (rather than an operator or the system) acted or was acted on.
create function private.audit_event_view(p_event private.audit_events)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_event.id,
    'occurred_at', p_event.occurred_at,
    'action', p_event.action::text,
    'outcome', p_event.outcome,
    'reason', pg_catalog.left(p_event.reason, 500),
    'by_account', p_event.actor_id is not null,
    'actor_handle', (select p.handle from public.profiles p where p.id = p_event.actor_id),
    'about_account', p_event.target_profile_id is not null,
    'target_handle', (select p.handle from public.profiles p where p.id = p_event.target_profile_id),
    'details', private.audit_details(p_event.metadata)
  )
$$;

-- The actions in each kind a page can filter by.
create function private.audit_category_actions(p_category text)
returns private.audit_action[]
language sql
immutable
set search_path = ''
as $$
  select case p_category
    when 'accounts' then array['account_suspended', 'account_reinstated']::private.audit_action[]
    when 'staff' then array['staff_role_granted', 'staff_role_revoked', 'staff_change_refused', 'owner_protection_refused']::private.audit_action[]
    when 'ownership' then array['owner_assigned', 'ownership_transfer_started', 'ownership_transfer_accepted', 'ownership_transfer_cancelled',
      'owner_successor_set', 'owner_succession_registered', 'owner_recovery_started', 'owner_recovery_confirmed', 'owner_recovery_cancelled',
      'owner_recovery_completed', 'owner_status_set_by_operator']::private.audit_action[]
    when 'catalog' then (select pg_catalog.array_agg(a) from pg_catalog.unnest(pg_catalog.enum_range(null::private.audit_action)) a where a::text like 'catalog\_%')
    when 'operator' then array['operator_action']::private.audit_action[]
  end
$$;

create function public.search_accounts(p_query text, p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text := pg_catalog.ltrim(pg_catalog.lower(pg_catalog.btrim(p_query)), '@');
begin
  perform private.require_active_staff('moderator');
  if v_query is null or v_query !~ '^[a-z0-9_]{2,24}$' then
    raise exception 'invalid handle' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', p.id, 'handle', p.handle, 'display_name', p.display_name, 'account_status', p.account_status,
      'roles', coalesce((select pg_catalog.jsonb_agg(s.role::text order by s.role) from public.staff_roles s where s.user_id = p.id), '[]'),
      'owner', private.is_designated_owner(p.id)
    ) order by p.handle)
    from (
      select * from public.profiles p
      where p.handle is not null and pg_catalog.starts_with(p.handle, v_query)
      order by p.handle
      limit least(greatest(coalesce(p_limit, 20), 1), 25)
    ) p
  ), '[]');
end;
$$;

create function public.get_account_summary(p_handle text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cap constant integer := 10000;
  v_handle text := pg_catalog.ltrim(pg_catalog.lower(pg_catalog.btrim(p_handle)), '@');
  v_profile public.profiles;
  v_admin boolean;
  v_actions private.audit_action[];
begin
  perform private.require_active_staff('moderator');
  if v_handle is null or v_handle !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'invalid handle' using errcode = '22023';
  end if;
  select * into v_profile from public.profiles p where p.handle = v_handle;
  if not found then
    return null;
  end if;
  -- Moderators see an account's status history; administrators also its staff roles.
  v_admin := private.has_staff_role('admin');
  v_actions := case when v_admin
    then array['account_suspended', 'account_reinstated', 'staff_role_granted', 'staff_role_revoked', 'staff_change_refused', 'owner_protection_refused']::private.audit_action[]
    else array['account_suspended', 'account_reinstated', 'staff_change_refused', 'owner_protection_refused']::private.audit_action[]
  end;
  return pg_catalog.jsonb_build_object(
    'cap', v_cap,
    'account', pg_catalog.jsonb_build_object(
      'id', v_profile.id, 'handle', v_profile.handle, 'display_name', v_profile.display_name,
      'account_status', v_profile.account_status, 'member_since', v_profile.created_at,
      'roles', coalesce((select pg_catalog.jsonb_agg(s.role::text order by s.role) from public.staff_roles s where s.user_id = v_profile.id), '[]'),
      'owner', private.is_designated_owner(v_profile.id)),
    'moderation', pg_catalog.jsonb_build_object(
      'suspensions', (select count(*) from (select 1 from private.audit_events e where e.target_profile_id = v_profile.id and e.action = 'account_suspended' limit v_cap) x),
      'reinstatements', (select count(*) from (select 1 from private.audit_events e where e.target_profile_id = v_profile.id and e.action = 'account_reinstated' limit v_cap) x),
      'refused_status_changes', (select count(*) from (select 1 from private.audit_events e where e.target_profile_id = v_profile.id
        and e.action in ('staff_change_refused', 'owner_protection_refused') and e.metadata ->> 'operation' = 'set_account_status' limit v_cap) x),
      'last_status_change', (select pg_catalog.jsonb_build_object('at', e.occurred_at, 'action', e.action::text,
          'actor_handle', (select p.handle from public.profiles p where p.id = e.actor_id))
        from private.audit_events e where e.target_profile_id = v_profile.id and e.action in ('account_suspended', 'account_reinstated')
        order by e.id desc limit 1)),
    'history', coalesce((
      select pg_catalog.jsonb_agg(private.audit_event_view(e) order by e.id desc)
      from (
        select * from private.audit_events e
        where e.target_profile_id = v_profile.id and e.action = any (v_actions)
          and (v_admin or e.action in ('account_suspended', 'account_reinstated') or e.metadata ->> 'operation' = 'set_account_status')
        order by e.id desc
        limit 20
      ) e
    ), '[]')
  );
end;
$$;

create function public.get_audit_log(
  p_limit integer default 50,
  p_before uuid default null,
  p_action text default null,
  p_category text default null,
  p_outcome text default null,
  p_actor_handle text default null,
  p_target_handle text default null,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_action private.audit_action;
  v_actions private.audit_action[];
  v_actor uuid;
  v_target uuid;
  v_actor_handle text := pg_catalog.ltrim(pg_catalog.lower(pg_catalog.btrim(p_actor_handle)), '@');
  v_target_handle text := pg_catalog.ltrim(pg_catalog.lower(pg_catalog.btrim(p_target_handle)), '@');
  v_since timestamptz;
  v_until timestamptz;
begin
  perform private.require_active_staff('admin');
  if (p_action is not null and not (p_action = any (pg_catalog.enum_range(null::private.audit_action)::text[])))
     or (p_category is not null and p_category not in ('accounts', 'staff', 'ownership', 'catalog', 'operator'))
     or (p_outcome is not null and p_outcome not in ('succeeded', 'refused', 'operator'))
     or (v_actor_handle is not null and v_actor_handle !~ '^[a-z0-9_]{3,24}$')
     or (v_target_handle is not null and v_target_handle !~ '^[a-z0-9_]{3,24}$') then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  -- A range is at most 366 days. With one end only, the other is 366 days away.
  if p_since is not null or p_until is not null then
    v_until := coalesce(p_until, p_since + interval '366 days');
    v_since := coalesce(p_since, p_until - interval '366 days');
    if v_since > v_until or v_until - v_since > interval '366 days' then
      raise exception 'invalid filter' using errcode = '22023';
    end if;
  end if;
  v_action := p_action::private.audit_action;
  v_actions := private.audit_category_actions(p_category);
  if v_actor_handle is not null then
    select p.id into v_actor from public.profiles p where p.handle = v_actor_handle;
    if v_actor is null then return '[]'; end if;
  end if;
  if v_target_handle is not null then
    select p.id into v_target from public.profiles p where p.handle = v_target_handle;
    if v_target is null then return '[]'; end if;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(private.audit_event_view(e) order by e.id desc)
    from (
      select * from private.audit_events e
      where (p_before is null or e.id < p_before)
        and (v_action is null or e.action = v_action)
        and (v_actions is null or e.action = any (v_actions))
        and (p_outcome is null or e.outcome = p_outcome)
        and (v_actor is null or e.actor_id = v_actor)
        and (v_target is null or e.target_profile_id = v_target)
        and (v_since is null or e.occurred_at >= v_since)
        and (v_until is null or e.occurred_at < v_until)
      order by e.id desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) e
  ), '[]');
end;
$$;

create function public.get_staff_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cap constant integer := 500;
begin
  perform private.require_active_staff('admin');
  return pg_catalog.jsonb_build_object(
    'cap', v_cap,
    'roles', pg_catalog.jsonb_build_object(
      'admin', (select count(*) from public.staff_roles s where s.role = 'admin'),
      'moderator', (select count(*) from public.staff_roles s where s.role = 'moderator'),
      'catalog_editor', (select count(*) from public.staff_roles s where s.role = 'catalog_editor')),
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'handle', p.handle, 'display_name', p.display_name, 'account_status', p.account_status,
        'roles', (select pg_catalog.jsonb_agg(s.role::text order by s.role) from public.staff_roles s where s.user_id = p.id),
        'owner', private.is_designated_owner(p.id),
        'successor', exists (select 1 from private.platform_owner o where o.successor_id = p.id),
        -- Why a role can't be used, as a fixed word: never a detail of the sign-in record.
        'standing', case
          when p.account_status = 'suspended' then 'suspended'
          when p.account_status = 'deactivated' then 'deactivated'
          when private.account_standing(p.id) is null then 'active'
          when private.account_standing(p.id) in ('unverified', 'no_handle', 'banned', 'deleted') then private.account_standing(p.id)
          else 'unavailable' end,
        -- Authenticator readiness as counts only.
        'factors', private.totp_factor_count(p.id),
        'mature_factors', private.mature_totp_factor_count(p.id),
        'last_staff_action_at', (select max(e.occurred_at) from private.audit_events e where e.actor_id = p.id)
      ) order by p.handle nulls last, p.id)
      from (
        select * from public.profiles p
        where exists (select 1 from public.staff_roles s where s.user_id = p.id)
        order by p.handle nulls last, p.id
        limit v_cap
      ) p
    ), '[]'),
    'recent', coalesce((
      select pg_catalog.jsonb_agg(private.audit_event_view(e) order by e.id desc)
      from (
        select * from private.audit_events e
        where e.action in ('staff_role_granted', 'staff_role_revoked', 'staff_change_refused', 'owner_protection_refused')
        order by e.id desc
        limit 20
      ) e
    ), '[]')
  );
end;
$$;

revoke all on function private.audit_details(jsonb) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function private.audit_event_view(private.audit_events) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function private.audit_category_actions(text) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function public.search_accounts(text, integer) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function public.get_account_summary(text) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function public.get_audit_log(integer, uuid, text, text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function public.get_staff_overview() from public, anon, authenticated, service_role, catalog_importer;
grant execute on function public.search_accounts(text, integer) to authenticated;
grant execute on function public.get_account_summary(text) to authenticated;
grant execute on function public.get_audit_log(integer, uuid, text, text, text, text, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.get_staff_overview() to authenticated;
