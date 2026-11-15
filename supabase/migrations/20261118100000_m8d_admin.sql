-- M8d Superadmin foundation: what the unified /admin and Settings → Security need
-- from the database, and fresh MFA for published merges (D3).
--
-- Design: docs/architecture/security-rls.md#staff-authority-m8 and ADR-055.
-- Every function here checks its caller itself; the pages only mirror it. None
-- returns an email, a TOTP secret, a purchase detail or a collection.

-- ---------------------------------------------------------------------------
-- 1. Published merges need a recent verification (D3). The function is the M7b-2c
--    one with that check added; same signature, result and privileges.
-- ---------------------------------------------------------------------------

create or replace function public.merge_release(
  p_source uuid,
  p_target uuid,
  p_token text,
  p_reason text,
  p_owner_note text,
  p_acknowledged text[],
  p_acknowledge_copies boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_note text := nullif(pg_catalog.btrim(p_owner_note), '');
  v_locked uuid[];
  v_plan jsonb;
  req public.catalog_change_requests;
  v_items uuid[];
  v_owners uuid[];
  v_id uuid;
  v_now timestamptz := pg_catalog.now();
  v_owner uuid;
  v_count integer;
  v_notified uuid := null;
  v_references integer;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if p_token is null or pg_catalog.char_length(v_note) > 1000 then
    raise exception 'invalid merge' using errcode = '22023';
  end if;

  -- 1. Profiles first, before any catalog row.
  v_locked := private.merge_profiles(v_me, p_source, p_target);
  perform 1 from public.profiles p where p.id = any (v_locked) order by p.id for key share;

  -- 2. Catalog rows, then the plan again under the locks.
  perform private.lock_merge_records(p_source, p_target);
  v_plan := private.merge_plan(p_source, p_target);
  if v_plan ->> 'token' is distinct from p_token then
    raise exception 'preview stale' using errcode = 'P0001';
  end if;
  if v_plan ->> 'kind' = 'published' and not private.has_staff_role('admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- M8d (D3): merging a published release needs a TOTP verification in the last 10
  -- minutes, checked before anything is written. Submissions merge as before.
  if v_plan ->> 'kind' = 'published' then
    perform private.require_recent_mfa();
  end if;
  if private.merge_involves(v_me, p_source, p_target) then
    raise exception 'own submission' using errcode = 'P0001';
  end if;
  if pg_catalog.jsonb_array_length(v_plan -> 'blocking') > 0 then
    raise exception 'merge blocked' using errcode = 'P0001';
  end if;
  -- Each difference acknowledged by name, no more and no fewer (safeguard 2).
  if (select coalesce(pg_catalog.array_agg(d ->> 'field' order by d ->> 'field'), '{}')
      from pg_catalog.jsonb_array_elements(v_plan -> 'differences') d)
     is distinct from
     (select coalesce(pg_catalog.array_agg(distinct a order by a), '{}') from pg_catalog.unnest(p_acknowledged) a)
     or ((v_plan ->> 'copies')::bigint > 0 and not coalesce(p_acknowledge_copies, false)) then
    raise exception 'acknowledgement required' using errcode = 'P0001';
  end if;

  -- 3. Anyone referenced or owning a copy now, who wasn't locked before: no waiting.
  perform private.lock_new_profiles(v_locked, private.merge_profiles(v_me, p_source, p_target));

  -- 4. The copies. None can be added or moved away while the source is locked.
  select coalesce(pg_catalog.array_agg(x.id order by x.id), '{}'), coalesce(pg_catalog.array_agg(x.owner_id order by x.id), '{}')
  into v_items, v_owners
  from (
    select c.id, c.owner_id from public.collection_items c
    where c.release_id = p_source and c.record_status = 'active'
    order by c.id
    for update
  ) x;

  if v_plan ->> 'request_id' is not null then
    select * into req from public.catalog_change_requests x where x.id = (v_plan ->> 'request_id')::uuid;
  end if;
  v_references := pg_catalog.jsonb_array_length(v_plan -> 'references');

  insert into private.catalog_merges (
    source_release_id, target_release_id, source_game_id, target_game_id, kind, merged_by, merged_at, staff_reason, owner_note,
    previous_status, previous_revision, request_id, previous_request, differences, repointed_releases, repointed_requests,
    retired_game, copies_moved, owners_affected, references_moved)
  values (
    p_source, p_target, (v_plan ->> 'source_game_id')::uuid, (v_plan ->> 'target_game_id')::uuid, v_plan ->> 'kind', v_me, v_now,
    v_reason, v_note, (v_plan ->> 'previous_status')::public.catalog_status, (v_plan ->> 'previous_revision')::bigint,
    case when v_plan ->> 'kind' = 'submission' then req.id end,
    case when v_plan ->> 'kind' = 'submission' then pg_catalog.jsonb_build_object(
      'status', req.status, 'version', req.version, 'reviewed_by', req.reviewed_by, 'reviewed_at', req.reviewed_at,
      'reviewer_note', req.reviewer_note, 'merged_into_release_id', req.merged_into_release_id) end,
    v_plan -> 'differences',
    (select coalesce(pg_catalog.array_agg(x::uuid), '{}') from pg_catalog.jsonb_array_elements_text(v_plan -> 'repoint_releases') x),
    (select coalesce(pg_catalog.array_agg(x::uuid), '{}') from pg_catalog.jsonb_array_elements_text(v_plan -> 'repoint_requests') x),
    v_plan -> 'retire', pg_catalog.cardinality(v_items), (select count(distinct o) from pg_catalog.unnest(v_owners) o), v_references)
  returning id into v_id;

  -- 5. The changes. The submission first: the M7b-1 guard refuses changes to a record
  --    whose submission is still active.
  if v_plan ->> 'kind' = 'submission' then
    update public.catalog_change_requests x set
      status = 'merged', merged_into_release_id = p_target, reviewed_by = v_me, reviewed_at = v_now, reviewer_note = v_note
    where x.id = req.id;
  end if;
  update public.catalog_change_requests x set merged_into_release_id = p_target
  where x.merged_into_release_id = p_source;
  -- A source is public as merged only if it was published (D3).
  update public.releases r set
    status = 'merged', merged_into_id = p_target, merged_publicly = (r.status = 'published'), submitted_by = null
  where r.id = p_source;
  -- No chains (D9): what pointed at the source points at the target.
  update public.releases r set merged_into_id = p_target where r.merged_into_id = p_source;
  if v_plan -> 'retire' is not null and v_plan -> 'retire' <> 'null'::jsonb then
    update public.games g set status = (v_plan -> 'retire' ->> 'status')::public.catalog_status
    where g.id = (v_plan -> 'retire' ->> 'id')::uuid;
  end if;

  -- External references: recorded as they were, then moved (safeguard 4).
  insert into private.catalog_merge_references (merge_id, reference_id, provider_code, entity_type, external_id,
    from_release_id, to_release_id, target_had_provider)
  select v_id, (x ->> 'id')::uuid, x ->> 'provider_code', x ->> 'entity_type', x ->> 'external_id', p_source, p_target,
         (x ->> 'target_had_provider')::boolean
  from pg_catalog.jsonb_array_elements(v_plan -> 'references') x;
  update private.external_references x set release_id = p_target where x.release_id = p_source;

  -- The copies: recorded, then moved. Nothing else about them changes: conditions,
  -- private details, every piece record and updated_at stay (D10, D12).
  insert into private.catalog_merge_copies (merge_id, item_id, owner_id)
  select v_id, i, o from rows from (pg_catalog.unnest(v_items), pg_catalog.unnest(v_owners)) as x(i, o);
  update public.collection_items c set release_id = p_target where c.id = any (v_items);

  -- 6. Each affected person once (D13): the submitter by their submission, every other
  --    owner by their copies. Nobody is told who acted.
  if v_plan ->> 'kind' = 'submission' and req.submitted_by is not null then
    perform private.notify(req.submitted_by, null, 'catalog_submission', null,
      pg_catalog.jsonb_build_object('status', 'merged', 'submission_id', req.id, 'merge_id', v_id));
    v_notified := req.submitted_by;
  end if;
  for v_owner, v_count in
    select o, count(*)::integer from pg_catalog.unnest(v_owners) o where o is distinct from v_notified group by o order by o
  loop
    perform private.notify(v_owner, null, 'catalog_merge', null,
      pg_catalog.jsonb_build_object('status', 'merged', 'merge_id', v_id, 'copies', v_count));
  end loop;

  perform private.record_catalog_audit(v_me, 'catalog_release_merged', 'release', p_source, v_reason,
    pg_catalog.jsonb_build_object('merge_id', v_id, 'target_id', p_target, 'kind', v_plan ->> 'kind',
      'copies', pg_catalog.cardinality(v_items), 'references', v_references,
      'repointed', pg_catalog.jsonb_array_length(v_plan -> 'repoint_releases')));
  return pg_catalog.jsonb_build_object('merge_id', v_id, 'copies', pg_catalog.cardinality(v_items),
    'owners', (select count(distinct o) from pg_catalog.unnest(v_owners) o), 'references', v_references);
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. The audit log, filtered (A2's guarded pattern). get_audit_events gains bounded
--    filters and the handles of actor and target, so the page never needs ids.
-- ---------------------------------------------------------------------------

do $guard$
declare
  v_oid oid := pg_catalog.to_regprocedure('public.get_audit_events(integer, uuid)');
  v_proc pg_catalog.pg_proc;
begin
  if v_oid is null then
    raise exception 'M8d guard: public.get_audit_events(integer, uuid) is missing';
  end if;
  select * into v_proc from pg_catalog.pg_proc where oid = v_oid;
  if pg_catalog.pg_get_function_result(v_oid) is distinct from
     'TABLE(id uuid, occurred_at timestamp with time zone, actor_id uuid, action text, target_profile_id uuid, reason text, metadata jsonb, outcome text)' then
    raise exception 'M8d guard: get_audit_events returns %, not the M8c table', pg_catalog.pg_get_function_result(v_oid);
  end if;
  if not v_proc.prosecdef or v_proc.proconfig is distinct from array['search_path=""']
     or pg_catalog.pg_get_userbyid(v_proc.proowner) <> 'postgres'
     or v_proc.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres}' then
    raise exception 'M8d guard: get_audit_events is not the SECURITY DEFINER function M8c created';
  end if;
  if (select count(*) from pg_catalog.pg_proc p where p.proname = 'get_audit_events') <> 1 then
    raise exception 'M8d guard: get_audit_events has another overload';
  end if;
  if exists (select 1 from pg_catalog.pg_depend d where d.refclassid = 'pg_catalog.pg_proc'::regclass and d.refobjid = v_oid) then
    raise exception 'M8d guard: something depends on get_audit_events';
  end if;
end;
$guard$;

drop function public.get_audit_events(integer, uuid);

-- Administrators only. Newest first, 1 to 100 rows, paged by id. Every filter is
-- optional: an action, the actor's or target's handle (exact), and a time range of
-- at most a year. An unknown handle matches nothing.
create function public.get_audit_events(
  p_limit integer default 50,
  p_before uuid default null,
  p_action text default null,
  p_actor_handle text default null,
  p_target_handle text default null,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns table (
  id uuid,
  occurred_at timestamptz,
  actor_id uuid,
  action text,
  target_profile_id uuid,
  reason text,
  metadata jsonb,
  outcome text,
  actor_handle text,
  target_handle text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_action private.audit_action;
  v_actor uuid;
  v_target uuid;
begin
  perform private.require_active_staff('admin');
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid page request' using errcode = '22023';
  end if;
  if p_action is not null then
    if not (p_action = any (pg_catalog.enum_range(null::private.audit_action)::text[])) then
      raise exception 'invalid filter' using errcode = '22023';
    end if;
    v_action := p_action::private.audit_action;
  end if;
  if (p_since is not null and p_until is not null and (p_since > p_until or p_until - p_since > interval '366 days'))
     or pg_catalog.char_length(p_actor_handle) > 24 or pg_catalog.char_length(p_target_handle) > 24 then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  if p_actor_handle is not null then
    select p.id into v_actor from public.profiles p where p.handle = pg_catalog.lower(pg_catalog.btrim(p_actor_handle));
    if v_actor is null then return; end if;
  end if;
  if p_target_handle is not null then
    select p.id into v_target from public.profiles p where p.handle = pg_catalog.lower(pg_catalog.btrim(p_target_handle));
    if v_target is null then return; end if;
  end if;
  return query
    select e.id, e.occurred_at, e.actor_id, e.action::text, e.target_profile_id, e.reason, e.metadata, e.outcome, a.handle, t.handle
    from private.audit_events e
    left join public.profiles a on a.id = e.actor_id
    left join public.profiles t on t.id = e.target_profile_id
    where (p_before is null or e.id < p_before)
      and (v_action is null or e.action = v_action)
      and (v_actor is null or e.actor_id = v_actor)
      and (v_target is null or e.target_profile_id = v_target)
      and (p_since is null or e.occurred_at >= p_since)
      and (p_until is null or e.occurred_at < p_until)
    order by e.id desc
    limit p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Reads for the admin pages and Settings → Security
-- ---------------------------------------------------------------------------

-- A profile's handle, or null when it has none or no longer exists.
create function private.handle_of(p_user uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select p.handle from public.profiles p where p.id = p_user
$$;

-- What the caller may see in /admin, from live state. Anyone signed in may ask; it
-- says only what concerns the caller. roles are the caller's own, even without MFA,
-- so a staff member at aal1 is sent to verify rather than told the page is missing.
create function public.get_my_admin_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
  if v_me is null then
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
$$;

-- Everyone holding a staff role, for administrators: handle, display name, status,
-- roles, and whether they are the Owner or the successor. No email, nothing private.
create function public.get_staff_members()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_staff('admin');
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', p.id, 'handle', p.handle, 'display_name', p.display_name, 'account_status', p.account_status,
      'roles', (select pg_catalog.jsonb_agg(s.role::text order by s.role) from public.staff_roles s where s.user_id = p.id),
      'owner', private.is_designated_owner(p.id),
      'successor', exists (select 1 from private.platform_owner o where o.successor_id = p.id)
    ) order by p.handle nulls last, p.id)
    from public.profiles p
    where exists (select 1 from public.staff_roles s where s.user_id = p.id)
  ), '[]');
end;
$$;

-- One account by its exact handle (D11), for moderators and administrators: what
-- deciding on a role or a suspension needs, and nothing else. Null if none.
create function public.find_account_by_handle(p_handle text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_handle text := pg_catalog.lower(pg_catalog.btrim(p_handle));
begin
  perform private.require_active_staff('moderator');
  if v_handle is null or v_handle !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'invalid handle' using errcode = '22023';
  end if;
  return (
    select pg_catalog.jsonb_build_object(
      'id', p.id, 'handle', p.handle, 'display_name', p.display_name, 'account_status', p.account_status,
      'roles', coalesce((select pg_catalog.jsonb_agg(s.role::text order by s.role) from public.staff_roles s where s.user_id = p.id), '[]'),
      'owner', private.is_designated_owner(p.id))
    from public.profiles p
    where p.handle = v_handle
  );
end;
$$;

-- The Owner record and anything pending, for administrators: who holds it, the
-- successor, whether a succession document is registered (never its fingerprint),
-- a pending transfer or recovery, and whether the Owner's factors changed in the
-- last 24 hours (A1). Null when no Owner is assigned.
create function public.get_ownership_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o private.platform_owner;
  v_transfer jsonb;
  v_recovery jsonb;
  v_changed boolean;
begin
  perform private.require_active_staff('admin');
  select * into o from private.platform_owner;
  if not found then
    return null;
  end if;
  select pg_catalog.jsonb_build_object('id', t.id, 'from_handle', private.handle_of(t.from_user), 'to_handle', private.handle_of(t.to_user),
      'created_at', t.created_at, 'expires_at', t.expires_at, 'expired', t.expires_at <= pg_catalog.now())
  into v_transfer
  from private.ownership_transfers t where t.status = 'pending';
  select pg_catalog.jsonb_build_object('id', r.id, 'kind', r.kind, 'target_handle', private.handle_of(r.target_id), 'created_at', r.created_at,
      'hold_until', r.hold_until, 'confirmed', r.confirmed_at is not null, 'disputed', r.disputed)
  into v_recovery
  from private.owner_recoveries r where r.status = 'pending';
  begin
    v_changed := exists (select 1 from auth.mfa_factors f where f.user_id = o.user_id and f.created_at > pg_catalog.now() - interval '24 hours')
      or exists (select 1 from private.mfa_factor_registrations r where r.user_id = o.user_id and r.registered_at > pg_catalog.now() - interval '24 hours');
  exception when undefined_column or undefined_table or undefined_object then
    raise log 'mygamedex: auth schema contract broken in get_ownership_status (%)', sqlstate;
    v_changed := null;
  end;
  return pg_catalog.jsonb_build_object(
    'owner', pg_catalog.jsonb_build_object('handle', private.handle_of(o.user_id), 'display_name', (select p.display_name from public.profiles p where p.id = o.user_id)),
    'assigned_at', o.assigned_at,
    'version', o.version,
    'successor_handle', private.handle_of(o.successor_id),
    'document_registered_at', o.succession_registered_at,
    'transfer', v_transfer,
    'recovery', v_recovery,
    'security_changed', v_changed
  );
end;
$$;

-- The caller's own TOTP factors and whether each is registered and mature (D13),
-- for Settings → Security. Never the secret. Unverified factors are listed, so an
-- abandoned enrollment can be removed.
create function public.get_my_factor_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null then
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
$$;

-- ---------------------------------------------------------------------------
-- 4. Privileges
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  revoke all on function private.handle_of(uuid) from public, anon, authenticated, service_role;
  foreach v_signature in array array[
    'public.get_audit_events(integer, uuid, text, text, text, timestamptz, timestamptz)',
    'public.get_my_admin_access()',
    'public.get_staff_members()',
    'public.find_account_by_handle(text)',
    'public.get_ownership_status()',
    'public.get_my_factor_status()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
