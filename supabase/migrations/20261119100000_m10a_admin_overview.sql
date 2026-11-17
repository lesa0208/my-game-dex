-- M10a Admin Panel Expansion, foundations: the /admin overview's operational counts.
--
-- Design: docs/architecture/security-rls.md#the-admin-overview-m10a and the M10
-- decisions in architecture-decisions.md.
--
-- One read, for staff with a live verified session (M8b). It returns aggregate
-- counts only: no identity, handle, email, title, reason or collection data. Each
-- section is filled only for the roles that already read the underlying records,
-- and is null for everyone else, so the scope is decided here, not by the page:
--
--   catalog         catalog editors (and administrators): the review queue, open
--                   reclassifications, unpublished records, recent merges
--   accounts        moderators (and administrators): suspended accounts
--   administration  administrators: active exclusions, staff by role, refusals
--
-- Every count stops at a cap, so the read stays bounded however large a table grows.
-- Nothing is written, so nothing is audited, like the other M8d reads.

create function public.get_admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_cap constant integer := 10000;
  v_catalog jsonb;
  v_accounts jsonb;
  v_administration jsonb;
begin
  -- Staff only: an active account, a live verified session and a staff role, as
  -- get_my_admin_access counts staff. Everyone else gets the generic refusal.
  if v_me is null or not private.is_active_user() or not private.mfa_session_ok()
     or not exists (select 1 from public.staff_roles s where s.user_id = v_me) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if private.has_staff_role('catalog_editor') then
    v_catalog := pg_catalog.jsonb_build_object(
      'submissions_open', (select count(*) from (select 1 from public.catalog_change_requests r where r.status = 'open' limit v_cap) x),
      'submissions_in_review', (select count(*) from (select 1 from public.catalog_change_requests r where r.status = 'in_review' limit v_cap) x),
      'submissions_changes_requested', (select count(*) from (select 1 from public.catalog_change_requests r where r.status = 'changes_requested' limit v_cap) x),
      'oldest_waiting_at', (select r.created_at from public.catalog_change_requests r where r.status in ('open', 'in_review') order by r.created_at limit 1),
      'reclassifications_open', (select count(*) from (select 1 from private.catalog_reclassifications c where c.action = 'queued' and c.resolved_at is null limit v_cap) x),
      'games_unpublished', (select count(*) from (select 1 from public.games g where g.status in ('unverified', 'under_review') limit v_cap) x),
      'releases_unpublished', (select count(*) from (select 1 from public.releases r where r.status in ('unverified', 'under_review') limit v_cap) x),
      'merges_30_days', (select count(*) from (select 1 from private.catalog_merges m where m.merged_at > pg_catalog.now() - interval '30 days' limit v_cap) x)
    );
  end if;

  if private.has_staff_role('moderator') then
    v_accounts := pg_catalog.jsonb_build_object(
      'suspended', (select count(*) from (select 1 from public.profiles p where p.account_status = 'suspended' limit v_cap) x)
    );
  end if;

  if private.has_staff_role('admin') then
    v_administration := pg_catalog.jsonb_build_object(
      'exclusions_active', (select count(*) from (select 1 from private.catalog_exclusions e where e.restored_at is null limit v_cap) x),
      'staff_admins', (select count(*) from (select 1 from public.staff_roles s where s.role = 'admin' limit v_cap) x),
      'staff_moderators', (select count(*) from (select 1 from public.staff_roles s where s.role = 'moderator' limit v_cap) x),
      'staff_catalog_editors', (select count(*) from (select 1 from public.staff_roles s where s.role = 'catalog_editor' limit v_cap) x),
      'refusals_7_days', (select count(*) from (select 1 from private.audit_events a where a.outcome = 'refused' and a.occurred_at > pg_catalog.now() - interval '7 days' limit v_cap) x)
    );
  end if;

  return pg_catalog.jsonb_build_object('cap', v_cap, 'catalog', v_catalog, 'accounts', v_accounts, 'administration', v_administration);
end;
$$;

revoke all on function public.get_admin_overview() from public, anon, authenticated, service_role;
grant execute on function public.get_admin_overview() to authenticated;
