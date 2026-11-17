-- M10 integration review: retire the two administrator reads M10e replaced, and stop
-- showing moderators the free-text reasons staff write when changing an account's
-- status.
--
-- Design: docs/architecture/security-rls.md#m10-integration-review.
--
--   get_audit_events(...) (M8d)   returned each audit row's raw metadata, account ids
--                                 and reason to administrators. Replaced by
--                                 get_audit_log (M10e), which returns allow-listed,
--                                 bounded details and handles only. Dropped.
--   get_staff_members() (M8d)     the staff list without standing or readiness.
--                                 Replaced by get_staff_overview (M10e). Dropped.
--   get_account_summary(handle)   unchanged for administrators. For moderators each
--                                 history entry keeps its action, outcome, time,
--                                 handles and allow-listed details (status from and
--                                 to, a refusal's code), and its reason is withheld.
--
-- Each drop is guarded (A2's pattern): the exact signature, result, SECURITY DEFINER,
-- search_path, owner and privileges must be what M8d created, with no overload, no
-- dependent object and no function body that names it. Any difference stops the
-- migration, which then changes nothing. drop function names the exact signature and
-- RESTRICT; nothing is dropped with CASCADE. No audit row is changed or deleted.

do $guard$
declare
  v_check record;
  v_oid oid;
  v_proc pg_catalog.pg_proc;
begin
  for v_check in
    select * from (values
      ('public.get_audit_events(integer, uuid, text, text, text, timestamptz, timestamptz)', 'get_audit_events',
       'TABLE(id uuid, occurred_at timestamp with time zone, actor_id uuid, action text, target_profile_id uuid, reason text, metadata jsonb, outcome text, actor_handle text, target_handle text)'),
      ('public.get_staff_members()', 'get_staff_members', 'jsonb')
    ) as t(signature, name, result)
  loop
    v_oid := pg_catalog.to_regprocedure(v_check.signature);
    if v_oid is null then
      raise exception 'M10 retirement guard: % is missing', v_check.signature;
    end if;
    select * into v_proc from pg_catalog.pg_proc where oid = v_oid;
    if pg_catalog.pg_get_function_result(v_oid) is distinct from v_check.result then
      raise exception 'M10 retirement guard: % returns %, not the M8d result', v_check.signature, pg_catalog.pg_get_function_result(v_oid);
    end if;
    if not v_proc.prosecdef or v_proc.proconfig is distinct from array['search_path=""']
       or pg_catalog.pg_get_userbyid(v_proc.proowner) <> 'postgres'
       or v_proc.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres}' then
      raise exception 'M10 retirement guard: % is not the SECURITY DEFINER function M8d created', v_check.signature;
    end if;
    if (select count(*) from pg_catalog.pg_proc p where p.proname = v_check.name) <> 1 then
      raise exception 'M10 retirement guard: % has another overload', v_check.name;
    end if;
    if exists (select 1 from pg_catalog.pg_depend d where d.refclassid = 'pg_catalog.pg_proc'::regclass and d.refobjid = v_oid) then
      raise exception 'M10 retirement guard: something depends on %', v_check.name;
    end if;
    -- PL/pgSQL calls aren't recorded in pg_depend, so look for callers by name.
    if exists (select 1 from pg_catalog.pg_proc p where p.oid <> v_oid and p.prosrc like '%' || v_check.name || '%') then
      raise exception 'M10 retirement guard: another function calls %', v_check.name;
    end if;
  end loop;
end;
$guard$;

drop function public.get_audit_events(integer, uuid, text, text, text, timestamptz, timestamptz) restrict;
drop function public.get_staff_members() restrict;

-- Moderators: an account's status history without the reasons staff wrote. Only the
-- history projection changes; the counts, the last change and administrators' view
-- are as M10e left them, and the signature and privileges stay.
create or replace function public.get_account_summary(p_handle text)
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
    'reasons_shown', v_admin,
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
      select pg_catalog.jsonb_agg(
        -- A reason is free text an administrator or moderator wrote; moderators get
        -- the entry without it, and the code of a refusal stays in its details.
        case when v_admin then private.audit_event_view(e)
          else (private.audit_event_view(e) - 'reason') || pg_catalog.jsonb_build_object('reason', null) end
        order by e.id desc)
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
