-- M11a-5: get_my_admin_access() refuses an ended session.
--
-- Found by the M11a-5 integration review. The session-revocation migration
-- (20261128100000) made staff_roles unreadable to an ended session, but this definer
-- function read the caller's roles, whether they are the Owner, a pending ownership
-- transfer offered to them and an Owner recovery naming them, gated only on auth.uid():
-- its is_active_user() and mfa_session_ok() calls set flags without holding the rest
-- back. Now an ended session gets 'not permitted', as from every other owner-scoped
-- function; the app already treats an error here as "no staff access". Nothing it
-- returned could be acted on (staff actions need mfa_session_ok), so this closed an
-- information disclosure only. Its current definition, with one condition added; its
-- grants are kept by CREATE OR REPLACE.

create or replace function public.get_my_admin_access()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := (select auth.uid());
  v_roles text[];
  v_active boolean;
  v_mfa boolean;
  v_staff boolean;
  v_admin boolean;
  v_owner boolean;
  v_transfer jsonb;
  v_recovery jsonb;
begin
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.array_agg(s.role::text order by s.role), '{}') into v_roles from public.staff_roles s where s.user_id = v_me;
  v_active := private.is_active_user();
  v_mfa := private.mfa_session_ok();
  v_staff := v_active and v_mfa and pg_catalog.cardinality(v_roles) > 0;
  v_admin := v_staff and private.has_staff_role('admin');
  v_owner := private.is_designated_owner(v_me);
  select pg_catalog.jsonb_build_object('id', t.id, 'from_handle', private.handle_of(t.from_user), 'expires_at', t.expires_at)
  into v_transfer
  from private.ownership_transfers t
  where t.status = 'pending' and t.to_user = v_me and t.expires_at > pg_catalog.now();
  select pg_catalog.jsonb_build_object('id', r.id, 'hold_until', r.hold_until, 'confirmed', r.confirmed_at is not null)
  into v_recovery
  from private.owner_recoveries r
  where r.status = 'pending' and r.kind = 'reassign' and r.target_id = v_me;
  return pg_catalog.jsonb_build_object(
    'roles', pg_catalog.to_jsonb(v_roles),
    'active', v_active,
    'mfa', v_mfa,
    'recent_mfa', v_mfa and private.mfa_recent(interval '10 minutes'),
    'staff', v_staff,
    'admin', v_admin,
    'moderator', v_staff and private.has_staff_role('moderator'),
    'editor', v_staff and private.has_staff_role('catalog_editor'),
    'owner', v_owner,
    'owner_authority', case when v_owner then private.owner_authority_refusal() end,
    'recovery_pending', v_staff and exists (select 1 from private.owner_recoveries r where r.status = 'pending'),
    'transfer_offered', v_transfer,
    'recovery_to_confirm', v_recovery
  );
end;
$function$;
