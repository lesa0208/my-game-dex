-- Rollback of 20261214100000_m15_audit_ordering: puts back the five readers as they were before it
-- (the definitions below are their previous versions, verbatim), then removes the trigger, its
-- function, the two indexes, the two constraints, the seq column and its sequence.
--
-- No audit row is changed or removed: dropping a column doesn't touch rows or fire the append-only
-- triggers. What is lost is the order of the rows recorded since the migration within one
-- transaction: after a rollback they sort by (occurred_at, id) again, as all rows did before.
-- Run it in one transaction (psql -1), on a database whose backup has been taken; then remove the
-- migration's row from supabase_migrations.schema_migrations if the migration is to be applied again.

CREATE OR REPLACE FUNCTION public.get_review_batch_member(p_batch uuid, p_game uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid;
  b private.catalog_review_batches;
  i private.catalog_review_batch_items;
  g public.games;
  gp public.game_platforms;
  pr private.provider_records;
  v_approvals integer;
  v_required boolean;
  v_own boolean;
  v_block text;
  v_keys text[];
begin
  v_me := private.require_active_staff('catalog_editor');
  select * into b from private.catalog_review_batches x where x.id = p_batch;
  if not found then
    return null;
  end if;
  select * into i from private.catalog_review_batch_items x where x.batch_id = b.id and x.game_id = p_game;
  if not found then
    return null;
  end if;
  select * into g from public.games x where x.id = i.game_id;
  select * into gp from public.game_platforms x where x.game_id = i.game_id and x.platform_id = i.platform_id;
  select * into pr from private.provider_records x where x.id = i.provider_record_id;
  select count(*) into v_approvals from private.catalog_review_batch_approvals a where a.batch_id = b.id;
  v_required := i.sampled or pg_catalog.cardinality(i.flags) > 0;
  v_own := private.created_by(v_me, null, array[i.game_id])
    or private.pairing_created_by(v_me, i.game_id, i.platform_id)
    or g.submitted_by is not distinct from v_me
    or gp.submitted_by is not distinct from v_me;
  v_block := case
    when b.status <> 'open' then 'not_open'
    when b.created_by = v_me then 'you_created_batch'
    when v_approvals > 0 then 'approval_started'
    when not v_required then 'not_required'
    when v_own then 'you_created_record'
    when i.outcome is not null and i.outcome <> 'incorrect' then 'outcome_final' end;
  v_keys := private.review_external_keys(pr.payload);

  return pg_catalog.jsonb_build_object(
    'batch', pg_catalog.jsonb_build_object(
      'id', b.id, 'status', b.status, 'content_sha256', b.content_sha256, 'created_at', b.created_at,
      'platform', (select pg_catalog.jsonb_build_object('slug', p.slug, 'name', p.name, 'short_name', p.short_name) from public.platforms p where p.id = b.platform_id),
      'approvals', v_approvals),
    'member', pg_catalog.jsonb_build_object(
      'category', (array['critical', 'flagged', 'sampled', 'unsampled'])[private.review_member_rank(i.sampled, i.flags, i.critical_flags) + 1],
      'sampled', i.sampled, 'flags', i.flags, 'info_flags', i.info_flags, 'critical_flags', i.critical_flags,
      'requires_outcome', v_required, 'frozen_game_revision', i.frozen_game_revision,
      'outcome', i.outcome, 'critical_error', i.critical_error, 'note', i.note, 'recorded_at', i.recorded_at,
      'reviewer', private.review_person(i.reviewed_by, v_me),
      'stale', case when b.status = 'open' then (gp.game_id is null or g.revision <> i.frozen_game_revision
                     or g.status not in ('unverified', 'under_review') or g.verified_at is not null
                     or gp.status not in ('unverified', 'under_review')) end),
    'game', pg_catalog.jsonb_build_object(
      'id', g.id, 'title', g.title, 'kind', g.kind, 'status', g.status, 'revision', g.revision, 'slug', g.slug,
      'first_release', case when g.first_release_date is null then null else pg_catalog.jsonb_build_object('value', g.first_release_date, 'precision', g.first_release_precision) end,
      'identity_verified', g.verified_at is not null),
    'pairing', case when gp.game_id is null then null else pg_catalog.jsonb_build_object(
      'status', gp.status,
      'physical_confirmed', gp.verification_basis is not null and gp.verified_at is not null,
      'releases', (select pg_catalog.jsonb_build_object('total', count(*), 'published', count(*) filter (where r.status = 'published' and r.verified_at is not null))
                   from public.releases r where r.game_id = gp.game_id and r.platform_id = gp.platform_id)) end,
    'source', case when pr.id is null then null else pg_catalog.jsonb_build_object(
      'provider', pr.provider_code,
      'provider_name', (select ep.name from private.external_providers ep where ep.code = pr.provider_code),
      'external_id', pr.external_id,
      'payload_sha256', pr.payload_sha256,
      'snapshot_sha256', (select r.source_sha256 from private.import_runs r where r.id = pr.import_run_id),
      'record', private.review_source_summary(pr.payload),
      'assessment', pg_catalog.jsonb_build_object(
        'assessor', case when (pr.payload #>> '{risk_assessment,assessor}') ~ '^[A-Za-z0-9._-]{1,60}$' then pr.payload #>> '{risk_assessment,assessor}' end,
        'assessor_version', case when (pr.payload #>> '{risk_assessment,assessor_version}') ~ '^[A-Za-z0-9._-]{1,20}$' then pr.payload #>> '{risk_assessment,assessor_version}' end,
        'problems', pg_catalog.to_jsonb(private.review_risk_problems(pr)))) end,
    'conflicts', pg_catalog.jsonb_build_object(
      -- Catalog games with the same title key: on the batch's platform or another.
      'same_title', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'id', c.id, 'title', c.title, 'status', c.status,
                        'on_platform', exists (select 1 from public.game_platforms cp where cp.game_id = c.id and cp.platform_id = i.platform_id),
                        'in_batch', exists (select 1 from private.catalog_review_batch_items o where o.batch_id = b.id and o.game_id = c.id))
                      order by c.title, c.id), '[]'::jsonb)
                     from (select c.* from public.games c
                           where c.search_key = g.search_key and c.id <> g.id and c.status not in ('merged', 'rejected')
                           order by c.title, c.id limit 20) c),
      -- Members of this batch sharing an IGDB or MobyGames id with it.
      'shared_ids', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', o.game_id, 'title', og.title) order by og.title, o.game_id), '[]'::jsonb)
                     from (select o.* from private.catalog_review_batch_items o join private.provider_records opr on opr.id = o.provider_record_id
                           where o.batch_id = b.id and o.game_id <> i.game_id and private.review_external_keys(opr.payload) && v_keys
                           limit 20) o join public.games og on og.id = o.game_id),
      -- Other catalog games already linked to the same source id.
      'linked_elsewhere', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'title', c.title, 'status', c.status) order by c.title, c.id), '[]'::jsonb)
                           from (select distinct c.id, c.title, c.status from private.external_references er join public.games c on c.id = er.game_id
                                 where er.provider_code = pr.provider_code and er.external_id = pr.external_id and er.game_id <> i.game_id
                                 limit 10) c)),
    -- Every batch the game was in on this platform, newest first, this one included.
    'batches', (select coalesce(pg_catalog.jsonb_agg(x.j order by x.created_at desc, x.id desc), '[]'::jsonb) from (
                  select ob.id, ob.created_at, pg_catalog.jsonb_build_object(
                    'id', ob.id, 'status', ob.status, 'created_at', ob.created_at, 'decided_at', ob.decided_at,
                    'sampled', oi.sampled, 'flagged', pg_catalog.cardinality(oi.flags) > 0,
                    'outcome', oi.outcome, 'critical_error', oi.critical_error, 'recorded_at', oi.recorded_at) as j
                  from private.catalog_review_batch_items oi join private.catalog_review_batches ob on ob.id = oi.batch_id
                  where oi.game_id = i.game_id and oi.platform_id = i.platform_id
                  order by ob.created_at desc, ob.id desc limit 20) x),
    -- This member's recorded outcomes in this batch, oldest first (incorrect, then excluded).
    'trail', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'at', e.occurred_at, 'person', private.review_person(e.actor_id, v_me),
                 'outcome', e.metadata ->> 'outcome', 'critical_error', e.metadata ->> 'critical_error', 'note', e.metadata ->> 'note')
               order by e.occurred_at, e.id), '[]'::jsonb)
              from (select e.* from private.audit_events e
                    where e.metadata ? 'game_id' and e.metadata ->> 'game_id' = i.game_id::text and e.action = 'catalog_batch_outcome_recorded'
                      and e.metadata ->> 'batch_id' = b.id::text
                    order by e.occurred_at, e.id limit 10) e),
    'you', pg_catalog.jsonb_build_object(
      'record', v_block,
      'options', case
        when v_block is not null then '[]'::jsonb
        when i.outcome = 'incorrect' then '["excluded"]'::jsonb
        else '["correct", "incorrect", "excluded"]'::jsonb end,
      'keep_critical_error', case when v_block is null and i.outcome = 'incorrect' then i.critical_error end));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_account_summary(p_handle text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_staff_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_audit_log(p_limit integer DEFAULT 50, p_before uuid DEFAULT NULL::uuid, p_action text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_outcome text DEFAULT NULL::text, p_actor_handle text DEFAULT NULL::text, p_target_handle text DEFAULT NULL::text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_catalog_record_history(p_entity text, p_id uuid, p_limit integer DEFAULT 25, p_before uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_id text := p_id::text;
  v_actions private.audit_action[];
  v_rows jsonb := '[]';
  v_count integer := 0;
  v_more boolean := false;
  v_last uuid;
  e private.audit_events;
begin
  perform private.require_active_staff('catalog_editor');
  if p_entity is null or p_entity not in ('game', 'release') or p_id is null then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  if (p_entity = 'game' and not exists (select 1 from public.games g where g.id = p_id))
     or (p_entity = 'release' and not exists (select 1 from public.releases r where r.id = p_id)) then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  v_actions := private.history_actions()::private.audit_action[];

  for e in
    select x.* from (
      select a.* from private.audit_events a
      where a.metadata ? 'id' and a.metadata ->> 'id' = v_id
        and (p_before is null or a.id < p_before)
        and a.metadata ->> 'entity' = any (case when p_entity = 'game' then array['game', 'game_platform', 'game_relation'] else array['release'] end)
      union
      select a.* from private.audit_events a
      where a.metadata ? 'target_id' and a.metadata ->> 'target_id' = v_id
        and (p_before is null or a.id < p_before)
        and ((p_entity = 'game' and a.metadata ->> 'entity' = 'game_relation')
             or (p_entity = 'release' and a.action = 'catalog_release_merged'))
      union
      select a.* from private.audit_events a
      where p_entity = 'release' and a.metadata ? 'release_id' and a.metadata ->> 'release_id' = v_id
        and (p_before is null or a.id < p_before)
        and a.action::text like 'catalog_submission_%'
      union
      select a.* from private.audit_events a
      where p_entity = 'game' and a.metadata ? 'game_id' and a.metadata ->> 'game_id' = v_id
        and (p_before is null or a.id < p_before)
        and a.action::text like 'catalog_submission_%'
    ) x
    where x.action = any (v_actions)
    order by x.id desc
    limit v_limit + 1
  loop
    v_count := v_count + 1;
    if v_count > v_limit then
      v_more := true;
      exit;
    end if;
    v_last := e.id;
    v_rows := v_rows || pg_catalog.jsonb_build_array(private.history_event_json(e));
  end loop;

  return pg_catalog.jsonb_build_object('items', v_rows, 'next_before', case when v_more then v_last end);
end;
$function$
;


drop trigger if exists audit_events_assign_seq on private.audit_events;
drop function if exists private.audit_events_assign_seq();
drop index if exists private.audit_events_chronological_idx;
drop index if exists private.audit_events_seq_key;
alter table private.audit_events drop constraint if exists audit_events_seq_recorded;
alter table private.audit_events drop constraint if exists audit_events_seq_positive;
alter table private.audit_events drop column if exists seq;
drop sequence if exists private.audit_events_seq;
