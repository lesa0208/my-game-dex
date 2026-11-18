-- M11a session revocation: a signed-in request must belong to a session Auth still has.
--
-- Design: docs/architecture/session-and-password-decisions.md (option A, approved), and
-- docs/architecture/security-rls.md#ended-sessions-m11a.
-- Before this, an access token stayed usable until it expired (an hour at most) after
-- "sign out on all devices", a password reset or a change, because PostgREST verifies a
-- token's signature only. Now every owner-scoped read and write also asks whether the
-- token's signed session_id is still a row in auth.sessions, for this user, not past its
-- not_after. Auth deletes that row when a session ends, so the next statement is refused.
--
-- - One definer helper reads auth.sessions; no API role gets access to Auth's tables.
-- - It is added to the shared guards (is_active_user, require_verified_user), to the
--   owner-only policies that didn't use them (reads and deletes of copies, private
--   details, pieces, preferences and staff roles), to the own-submission branch of the
--   catalog's read rules, and to the owner-scoped functions that checked only auth.uid().
--   Public reads (published catalog, public profile cards) are unchanged: a signed-out
--   visitor sees the same as before, and so does an ended session.
-- - Always as (select private.session_is_live()), so it runs once per statement, not per row.
-- - Fails closed: a missing or malformed session_id, or an Auth schema change (logged),
--   answers false. 31_auth_contract pins the columns it reads.
-- - Staff functions already required a live session (mfa_session_ok, M8b); unchanged.
-- - Every function below is its current definition with one condition added; their
--   grants and comments are kept by CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- 1. The check
-- ---------------------------------------------------------------------------

create function private.session_is_live()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
  v_me uuid := (select auth.uid());
  v_session uuid;
begin
  if v_me is null or v_claims is null then
    return false;
  end if;
  begin
    v_session := (v_claims ->> 'session_id')::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  if v_session is null then
    return false;
  end if;
  return exists (
    select 1 from auth.sessions s
    where s.id = v_session and s.user_id = v_me
      and (s.not_after is null or s.not_after > pg_catalog.now())
  );
exception when undefined_column or undefined_table or undefined_object then
  raise log 'mygamedex: auth schema contract broken in session_is_live (%)', sqlstate;
  return false;
end;
$$;

-- A policy calls this with EXECUTE alone; without USAGE on private, clients can't call it.
revoke all on function private.session_is_live() from public, anon, authenticated, service_role;
grant execute on function private.session_is_live() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The shared guards, the catalog's own-submission rules, and owner-scoped functions
-- ---------------------------------------------------------------------------

-- private.is_active_user()
create or replace function private.is_active_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.id = (select auth.uid())
      and p.account_status = 'active'
      and p.handle is not null
      and u.email_confirmed_at is not null
  ) and (select private.session_is_live())
$function$;

-- private.require_verified_user()
create or replace function private.require_verified_user()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null or not (select private.session_is_live()) or not exists (
    select 1 from public.profiles p join auth.users u on u.id = p.id
    where p.id = v_me and u.email_confirmed_at is not null
  ) then
    raise exception 'account not eligible' using errcode = '42501';
  end if;
  return v_me;
end;
$function$;

-- private.can_read_release(uuid)
create or replace function private.can_read_release(p_release uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.releases r
    where r.id = p_release
      and (
        r.status = 'published' or (r.status = 'merged' and r.merged_publicly)
        or (r.submitted_by = (select auth.uid()) and r.status in ('unverified', 'under_review', 'rejected') and (select private.session_is_live()))
        or private.is_catalog_editor()
      )
  )
$function$;

-- private.can_use_release(uuid)
create or replace function private.can_use_release(p_release uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.releases r
    where r.id = p_release
      and (
        r.status = 'published'
        or (r.submitted_by = (select auth.uid()) and r.status in ('unverified', 'under_review', 'rejected') and (select private.session_is_live()))
      )
  )
$function$;

-- private.my_preserved_releases(uuid[])
create or replace function private.my_preserved_releases(p_items uuid[])
 RETURNS TABLE(item_id uuid, release releases, game games)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select c.id, r, g
  from public.collection_items c
  join public.releases r on r.id = c.release_id and r.status = 'excluded'
  join public.games g on g.id = r.game_id
  where c.id = any (p_items)
    and c.owner_id = (select auth.uid())
    and (select private.session_is_live())
    and c.record_status = 'invalid_preserved'
$function$;

-- public.get_my_account()
create or replace function public.get_my_account()
 RETURNS TABLE(id uuid, handle text, display_name text, avatar_path text, bio text, country_code text, collection_visibility visibility_level, follow_approval_required boolean, allow_search_indexing boolean, account_status account_status, handle_changed_at timestamp with time zone, handle_correction_until timestamp with time zone, is_active boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p.id, p.handle, p.display_name, p.avatar_path, p.bio, p.country_code,
         p.collection_visibility, p.follow_approval_required, p.allow_search_indexing,
         p.account_status, p.handle_changed_at, p.handle_correction_until, private.is_active_user()
  from public.profiles p
  where p.id = (select auth.uid()) and (select private.session_is_live())
$function$;

-- public.get_my_submission(uuid)
create or replace function public.get_my_submission(p_submission uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'id', s.id, 'kind', s.request_type, 'status', private.submission_status(s.status),
    'created_at', s.created_at, 'updated_at', s.updated_at,
    'note', s.reason, 'reviewer_note', s.reviewer_note, 'created_game', s.created_game, 'details', s.details,
    'release_id', r.id, 'game_id', s.game_id,
    'game_slug', case when g.status = 'published' then g.slug end,
    'editable', s.status in ('open', 'changes_requested') and r.status = 'unverified' and r.submitted_by = s.submitted_by,
    'resubmittable', (s.status = 'changes_requested' and r.status = 'unverified' and r.submitted_by = s.submitted_by)
      or (s.status = 'rejected' and r.status = 'rejected' and r.submitted_by = s.submitted_by
          and not exists (select 1 from public.catalog_change_requests n where n.previous_request_id = s.id)),
    'previous_id', (select p.id from public.catalog_change_requests p where p.id = s.previous_request_id and p.submitted_by = s.submitted_by),
    'next_id', (select n.id from public.catalog_change_requests n where n.previous_request_id = s.id and n.submitted_by = s.submitted_by),
    'my_copies', (select count(*) from public.collection_items c where c.release_id = r.id and c.owner_id = s.submitted_by)
  )
  from public.catalog_change_requests s
  left join public.releases r on r.id = s.release_id
  left join public.games g on g.id = s.game_id
  where s.id = p_submission and s.submitted_by = (select auth.uid()) and (select private.session_is_live()) and s.request_type in ('new_game', 'new_release')
$function$;

-- public.my_submission_for_release(uuid)
create or replace function public.my_submission_for_release(p_release uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select s.id from public.catalog_change_requests s
  where s.release_id = p_release and s.submitted_by = (select auth.uid()) and (select private.session_is_live()) and s.status <> 'withdrawn'
  order by s.id desc
  limit 1
$function$;

-- public.get_my_merged_submission(uuid)
create or replace function public.get_my_merged_submission(p_submission uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object('release_id', r.id, 'game_slug', g.slug)
  from public.catalog_change_requests x
  join public.releases r on r.id = x.merged_into_release_id and r.status = 'published'
  join public.games g on g.id = r.game_id and g.status = 'published'
  where x.id = p_submission and x.submitted_by = (select auth.uid()) and (select private.session_is_live()) and x.status = 'merged'
    and exists (select 1 from private.catalog_public_releases(g.id) p where p.id = r.id)
$function$;

-- public.my_catalog_submissions(uuid,integer)
create or replace function public.my_catalog_submissions(p_before uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_items jsonb;
  v_last uuid;
  v_more boolean;
  v_used integer;
  v_oldest timestamptz;
begin
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  with page as (
    select s.*, g.slug, g.status as game_status
    from public.catalog_change_requests s
    left join public.games g on g.id = s.game_id
    where s.submitted_by = v_me and s.request_type in ('new_game', 'new_release') and (p_before is null or s.id < p_before)
    order by s.id desc
    limit v_limit + 1
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', p.id, 'kind', p.request_type, 'status', private.submission_status(p.status),
           'created_at', p.created_at, 'updated_at', p.updated_at, 'release_id', p.release_id,
           'game_slug', case when p.game_status = 'published' then p.slug end,
           'title', p.details ->> 'title', 'platform', p.details -> 'platform', 'region', p.details -> 'region',
           'format', p.details -> 'format', 'edition_name', p.details ->> 'edition_name'
         ) order by p.id desc) filter (where p.n <= v_limit), '[]'::jsonb),
         max(p.id::text) filter (where p.n = v_limit)::uuid,
         coalesce(bool_or(p.n > v_limit), false)
  into v_items, v_last, v_more
  from (select page.*, row_number() over (order by page.id desc) as n from page) p;

  select count(*), min(s.created_at) into v_used, v_oldest from public.catalog_change_requests s
  where s.submitted_by = v_me and s.request_type in ('new_game', 'new_release') and s.created_at > pg_catalog.now() - interval '24 hours';
  return pg_catalog.jsonb_build_object(
    'items', v_items,
    'next_before', case when v_more then v_last end,
    'allowance', pg_catalog.jsonb_build_object('limit', 10, 'used', v_used,
      'next_available_at', case when v_used >= 10 then v_oldest + interval '24 hours' end)
  );
end;
$function$;

-- public.get_my_onboarding()
create or replace function public.get_my_onboarding()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := (select auth.uid());
  i private.account_invitations;
begin
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  i := private.invitation_for_user(v_me);
  return pg_catalog.jsonb_build_object(
    'invited', i.id is not null,
    'password_set', i.password_set_at is not null,
    'revoked', coalesce(i.state in ('revoke_pending', 'revoked', 'revoked_after_acceptance'), false));
end;
$function$;

-- public.complete_my_password_setup()
create or replace function public.complete_my_password_setup()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := (select auth.uid());
  i private.account_invitations;
  v_accepted timestamptz;
  v_evidence boolean := false;
begin
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  i := private.invitation_for_user(v_me);
  if i.id is null then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'not_invited');
  end if;
  if i.state in ('revoke_pending', 'revoked', 'revoked_after_acceptance') then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'invitation_revoked');
  end if;
  if i.password_set_at is not null then
    return pg_catalog.jsonb_build_object('ok', true, 'result', 'unchanged');
  end if;
  select u.email_confirmed_at into v_accepted from auth.users u where u.id = v_me;
  if v_accepted is null then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'not_accepted');
  end if;
  begin
    select exists (
      select 1 from auth.audit_log_entries a
      where a.payload ->> 'action' = 'user_updated_password'
        and a.payload ->> 'actor_id' = v_me::text
        and a.created_at >= v_accepted)
    into v_evidence;
  exception when undefined_table or undefined_column or invalid_text_representation then
    raise log 'mygamedex: auth audit log contract broken in complete_my_password_setup (%)', sqlstate;
    v_evidence := false;
  end;
  if not v_evidence then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'password_not_set');
  end if;
  update private.account_invitations
  set password_set_at = pg_catalog.now(), invited_user_id = v_me
  where id = i.id and password_set_at is null;
  return pg_catalog.jsonb_build_object('ok', true, 'result', 'recorded');
end;
$function$;

-- public.get_my_factor_status()
create or replace function public.get_my_factor_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id, 'friendly_name', f.friendly_name, 'status', f.status::text, 'created_at', f.created_at,
      'registered_at', r.registered_at,
      'matures_at', r.registered_at + interval '24 hours',
      'mature', coalesce(f.status = 'verified' and r.registered_at <= pg_catalog.now() - interval '24 hours', false)
    ) order by f.created_at, f.id)
    from auth.mfa_factors f
    left join private.mfa_factor_registrations r
      on r.factor_id = f.id and r.user_id = f.user_id and r.factor_created_at = f.created_at
    where f.user_id = v_me and f.factor_type = 'totp'
  ), '[]');
exception when undefined_column or undefined_table or undefined_object or invalid_text_representation then
  raise log 'mygamedex: auth schema contract broken in get_my_factor_status (%)', sqlstate;
  raise exception 'not permitted' using errcode = '42501';
end;
$function$;

-- public.claim_handle(text)
create or replace function public.claim_handle(p_handle text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := (select auth.uid());
  v_handle text;
  v_current text;
  v_changed_at timestamptz;
  v_correction_until timestamptz;
begin
  if v_me is not null then
    perform 1 from private.account_invitations i
    where i.id = (select x.id from private.invitation_for_user(v_me) x)
    for update;
  end if;

  if v_me is null or not (select private.session_is_live()) or not exists (
    select 1
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.id = v_me and p.account_status = 'active' and u.email_confirmed_at is not null
  ) or private.invitation_onboarding_blocked(v_me) then
    raise exception 'account not eligible' using errcode = '42501';
  end if;

  -- Validated before lowercasing, because some non-ASCII letters lowercase to ASCII.
  if p_handle is null or p_handle !~ '^[A-Za-z0-9_]{3,24}$' then
    raise exception 'invalid handle' using errcode = '22023';
  end if;
  v_handle := pg_catalog.lower(p_handle collate pg_catalog."C");

  select p.handle, p.handle_changed_at, p.handle_correction_until
  into v_current, v_changed_at, v_correction_until
  from public.profiles p
  where p.id = v_me
  for update;

  if v_current = v_handle then
    return v_current;
  end if;

  if v_current is not null
    and coalesce(v_correction_until > pg_catalog.now(), false) is false
    and v_changed_at > pg_catalog.now() - interval '30 days'
  then
    raise exception 'handle change not available yet' using errcode = 'P0001';
  end if;

  -- In a fixed order, so two users swapping handles can't deadlock.
  if v_current is null then
    perform private.lock_handle(v_handle);
  else
    perform private.lock_handle(least(v_current, v_handle));
    perform private.lock_handle(greatest(v_current, v_handle));
  end if;

  if private.handle_is_held(v_handle) then
    raise exception 'handle unavailable' using errcode = 'P0001';
  end if;

  begin
    update public.profiles
    set handle = v_handle,
        handle_changed_at = pg_catalog.now(),
        handle_correction_until = case when v_current is null then pg_catalog.now() + interval '24 hours' end
    where id = v_me;
  exception
    when unique_violation then
      raise exception 'handle unavailable' using errcode = 'P0001';
  end;

  if v_current is not null then
    insert into private.handle_holds (handle, kind, expires_at)
    values (v_current, 'released', pg_catalog.now() + interval '30 days')
    on conflict (handle) do update
      set expires_at = excluded.expires_at
      where private.handle_holds.kind = 'released';
  end if;

  return v_handle;
end;
$function$;

-- public.take_request_slot(text)
create or replace function public.take_request_slot(p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := (select auth.uid());
  v_max integer;
  v_window interval;
  v_used integer;
  v_oldest timestamptz;
begin
  if v_me is null or not (select private.session_is_live()) or not exists (select 1 from public.profiles p where p.id = v_me) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  case p_kind
    when 'data_export' then v_max := 3; v_window := interval '1 hour';
    when 'avatar_upload' then v_max := 10; v_window := interval '1 hour';
    else raise exception 'invalid kind' using errcode = '22023';
  end case;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('request_slot:' || v_me::text || ':' || p_kind, 0));
  delete from private.request_slots s where s.user_id = v_me and s.kind = p_kind and s.taken_at <= pg_catalog.now() - v_window;
  select count(*), min(s.taken_at) into v_used, v_oldest from private.request_slots s where s.user_id = v_me and s.kind = p_kind;
  if v_used >= v_max then
    return pg_catalog.jsonb_build_object('allowed', false, 'retry_at', v_oldest + v_window);
  end if;
  insert into private.request_slots (user_id, kind) values (v_me, p_kind);
  return pg_catalog.jsonb_build_object('allowed', true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Owner-only policies that didn't use a shared guard
-- ---------------------------------------------------------------------------
-- Deletes keep allowing an account that isn't active (removing your own data is always
-- allowed, M6), but not an ended session.

alter policy collection_items_read_own on public.collection_items
  using (owner_id = (select auth.uid()) and (select private.session_is_live()));
alter policy collection_items_delete_own on public.collection_items
  using (owner_id = (select auth.uid()) and (select private.session_is_live()));
alter policy collection_item_private_read_own on public.collection_item_private
  using (owner_id = (select auth.uid()) and (select private.session_is_live()));
alter policy collection_item_private_delete_own on public.collection_item_private
  using (owner_id = (select auth.uid()) and (select private.session_is_live()));
alter policy collection_item_components_read_own on public.collection_item_components
  using (owner_id = (select auth.uid()) and (select private.session_is_live()));
alter policy collection_item_components_delete_own on public.collection_item_components
  using (owner_id = (select auth.uid()) and (select private.session_is_live()));
alter policy user_preferences_read_own on public.user_preferences
  using (user_id = (select auth.uid()) and (select private.session_is_live()));
alter policy staff_roles_read_own on public.staff_roles
  using (user_id = (select auth.uid()) and (select private.session_is_live()));

-- The catalog: published (and publicly merged) records stay readable by every signed-in
-- request, as by anon. Only a submitter's own unpublished records need a live session.
alter policy games_read_authenticated on public.games
  using (
    status in ('published', 'merged')
    or (submitted_by = (select auth.uid()) and status in ('unverified', 'under_review', 'rejected') and (select private.session_is_live()))
    or (select private.is_catalog_editor())
  );
alter policy releases_read_authenticated on public.releases
  using (
    status = 'published'
    or (status = 'merged' and merged_publicly)
    or (submitted_by = (select auth.uid()) and status in ('unverified', 'under_review', 'rejected') and (select private.session_is_live()))
    or (select private.is_catalog_editor())
  );
