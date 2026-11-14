-- M7b-2c: merging a duplicate release into a published one.
--
-- Design: docs/architecture/security-rls.md#merging-releases-m7b-2c
--
-- Approved with decisions D1 to D15 and the safeguards of the M7b-2c approval. A
-- catalog editor (an administrator, for a published source) previews a merge of a
-- source into a published target of the same platform and physical format, then
-- merges it through a token-checked call that acknowledges every differing field and
-- the copies. In one transaction: the source's submission becomes merged, the source
-- becomes merged into the target, releases merged into the source are repointed, its
-- external references move with a permanent record, every copy moves with everything
-- its owner recorded, and each affected person is notified once. The target is never
-- changed; the source and its evidence, pieces, markets and field locks stay as
-- history. Nothing is deleted, and there is no unmerge (D11): the records below keep
-- what one would need.

-- ---------------------------------------------------------------------------
-- 1. Records
-- ---------------------------------------------------------------------------

-- One row per merge, written once. Staff ids are plain values, as in the audit log.
create table private.catalog_merges (
  id uuid primary key default private.uuid_v7(),
  source_release_id uuid not null references public.releases (id) on delete restrict,
  target_release_id uuid not null references public.releases (id) on delete restrict,
  source_game_id uuid not null,
  target_game_id uuid not null,
  -- published: a published duplicate (D1a). submission: a submission in review (D1b).
  -- unpublished: an unverified release with no submission, such as an import's (D1c).
  kind text not null check (kind in ('published', 'submission', 'unpublished')),
  merged_by uuid not null,
  merged_at timestamptz not null default now(),
  staff_reason text not null check (char_length(staff_reason) between 1 and 500),
  owner_note text check (char_length(owner_note) between 1 and 1000),
  -- The source before the merge, and its submission's fields before.
  previous_status public.catalog_status not null,
  previous_revision bigint not null,
  request_id uuid,
  previous_request jsonb,
  -- Every acknowledged difference, with both values, as the preview showed them.
  differences jsonb not null,
  -- Releases and submissions that pointed at the source and now point at the target.
  repointed_releases uuid[] not null default '{}',
  repointed_requests uuid[] not null default '{}',
  -- A game the submission created, retired as rejection does: {id, previous_status, status}.
  retired_game jsonb,
  copies_moved integer not null check (copies_moved >= 0),
  owners_affected integer not null check (owners_affected >= 0),
  references_moved integer not null check (references_moved >= 0),
  constraint catalog_merges_distinct check (source_release_id <> target_release_id),
  constraint catalog_merges_request check ((kind = 'submission') = (request_id is not null))
);
create unique index catalog_merges_source_key on private.catalog_merges (source_release_id);
create index catalog_merges_target_idx on private.catalog_merges (target_release_id);

-- Exactly the copies a merge moved. A row goes when its copy is deleted.
create table private.catalog_merge_copies (
  merge_id uuid not null references private.catalog_merges (id) on delete restrict,
  item_id uuid not null references public.collection_items (id) on delete cascade,
  owner_id uuid not null,
  primary key (merge_id, item_id)
);
create index catalog_merge_copies_item_idx on private.catalog_merge_copies (item_id);

-- Every external reference a merge reassigned, as it was (safeguard 4). Nothing about
-- a reference is overwritten or dropped: each external id keeps its one release, now
-- the target. A target may already have its own reference from the same provider;
-- both are kept, and target_had_provider records that it did.
create table private.catalog_merge_references (
  merge_id uuid not null references private.catalog_merges (id) on delete restrict,
  reference_id uuid not null,
  provider_code text not null,
  entity_type text not null,
  external_id text not null,
  from_release_id uuid not null,
  to_release_id uuid not null,
  target_had_provider boolean not null,
  primary key (merge_id, reference_id)
);

-- Merge history is permanent. A moved copy's row goes only with the copy.
create function private.refuse_merge_record_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'catalog_merge_copies' and tg_op = 'DELETE' then
    return old;
  end if;
  raise exception 'merge records can''t be changed' using errcode = 'P0001';
end;
$$;
create trigger refuse_change before update or delete on private.catalog_merges
  for each row execute function private.refuse_merge_record_change();
create trigger refuse_change before update or delete on private.catalog_merge_copies
  for each row execute function private.refuse_merge_record_change();
create trigger refuse_change before update or delete on private.catalog_merge_references
  for each row execute function private.refuse_merge_record_change();

alter table private.catalog_merges enable row level security;
alter table private.catalog_merge_copies enable row level security;
alter table private.catalog_merge_references enable row level security;
revoke all on private.catalog_merges from public, anon, authenticated, service_role;
revoke all on private.catalog_merge_copies from public, anon, authenticated, service_role;
revoke all on private.catalog_merge_references from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Notifications (D13)
-- ---------------------------------------------------------------------------

alter table public.notifications drop constraint notifications_shape;
alter table public.notifications add constraint notifications_shape check (
  (type in ('follow', 'follow_request', 'follow_accepted')
    and actor_id is not null and event_at is not null and data = '{}'::jsonb)
  or (type = 'moderation'
    and actor_id is null and event_at is null
    and data - 'status' = '{}'::jsonb and data ->> 'status' in ('suspended', 'active'))
  or (type = 'catalog_submission'
    and actor_id is null and event_at is null
    and data - array['status', 'submission_id'] = '{}'::jsonb
    and data ->> 'status' in ('published', 'changes_requested', 'rejected')
    and jsonb_typeof(data -> 'submission_id') = 'string')
  or (type = 'catalog_submission'
    and actor_id is null and event_at is null
    and data - array['status', 'submission_id', 'exclusion_id'] = '{}'::jsonb
    and data ->> 'status' = 'excluded'
    and jsonb_typeof(data -> 'submission_id') = 'string' and jsonb_typeof(data -> 'exclusion_id') = 'string')
  or (type = 'catalog_exclusion'
    and actor_id is null and event_at is null
    and data - array['status', 'exclusion_id', 'copies'] = '{}'::jsonb
    and data ->> 'status' in ('excluded', 'restored')
    and jsonb_typeof(data -> 'exclusion_id') = 'string' and jsonb_typeof(data -> 'copies') = 'number')
  -- The submitter of a merged submission.
  or (type = 'catalog_submission'
    and actor_id is null and event_at is null
    and data - array['status', 'submission_id', 'merge_id'] = '{}'::jsonb
    and data ->> 'status' = 'merged'
    and jsonb_typeof(data -> 'submission_id') = 'string' and jsonb_typeof(data -> 'merge_id') = 'string')
  -- Owners of copies a merge moved.
  or (type = 'catalog_merge'
    and actor_id is null and event_at is null
    and data - array['status', 'merge_id', 'copies'] = '{}'::jsonb
    and data ->> 'status' = 'merged'
    and jsonb_typeof(data -> 'merge_id') = 'string' and jsonb_typeof(data -> 'copies') = 'number')
);
create unique index notifications_merge_event_key on public.notifications (recipient_id, (data ->> 'merge_id'), (data ->> 'status'))
  where data ? 'merge_id';

-- ---------------------------------------------------------------------------
-- 3. A moved copy's updated_at (D12)
-- ---------------------------------------------------------------------------

-- Being moved by a merge isn't the owner's edit, so it keeps updated_at, as a change
-- of preservation status does (M7b-2b). Only a move this transaction's merge recorded
-- counts, which no client can write. Checked only when the release changes, which
-- only definer functions do, so a client's own edit never reads the merge records.
create or replace function private.set_copy_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.release_id is distinct from old.release_id then
    if (pg_catalog.to_jsonb(new) - array['release_id', 'updated_at']) = (pg_catalog.to_jsonb(old) - array['release_id', 'updated_at']) then
      if exists (
        select 1 from private.catalog_merge_copies mc
        join private.catalog_merges m on m.id = mc.merge_id
        where mc.item_id = new.id and m.source_release_id = old.release_id and m.target_release_id = new.release_id
          and m.merged_at = pg_catalog.now()
      ) then
        new.updated_at := old.updated_at;
        return new;
      end if;
    end if;
    new.updated_at := pg_catalog.now();
    return new;
  end if;
  if (new.record_status, new.invalidated_at) is distinct from (old.record_status, old.invalidated_at)
     and (pg_catalog.to_jsonb(new) - array['record_status', 'invalidated_at', 'updated_at'])
         = (pg_catalog.to_jsonb(old) - array['record_status', 'invalidated_at', 'updated_at']) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := pg_catalog.now();
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Planning a merge
-- ---------------------------------------------------------------------------

-- What's compared between two releases (D5, safeguard 2). Platform and physical
-- format aren't here: they must match, and a mismatch blocks the merge.
create function private.merge_fields(p_release uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'game', pg_catalog.jsonb_build_object('id', g.id, 'title', g.title),
    'region_code', r.region_code,
    'region_unknown_confirmed', r.region_unknown_confirmed,
    'edition_name', r.edition_name,
    'edition_kind', r.edition_kind,
    'variant_name', r.variant_name,
    'product_code', r.product_code,
    'barcode', r.barcode,
    'local_title', r.local_title,
    'publisher_name', r.publisher_name,
    'media_count', r.media_count,
    'media_playability', r.media_playability,
    'packaging', r.packaging,
    'languages', r.languages,
    'rating_labels', r.rating_labels,
    'release_date', r.release_date,
    'release_date_precision', r.release_date_precision,
    'components', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'kind', c.kind, 'label', c.label, 'quantity', c.quantity, 'media_format_code', c.media_format_code)
        order by c.kind, c.label), '[]') from public.release_components c where c.release_id = r.id),
    'markets', (select coalesce(pg_catalog.jsonb_agg(m.market_code order by m.market_code), '[]')
                from public.release_markets m where m.release_id = r.id),
    'hardware', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code', h.requirement_code, 'level', h.level)
                 order by h.requirement_code), '[]') from public.release_hardware_requirements h where h.release_id = r.id))
  from public.releases r
  join public.games g on g.id = r.game_id
  where r.id = p_release
$$;

-- What merging p_source into p_target would do, from the current state. Read without
-- locks for the preview, and again under the locks before anything changes. The token
-- covers both releases' states and revisions, the submission and its version, every
-- difference with both values, the blockers, what would be repointed, retired and
-- reassigned; not the copy or owner counts, as for exclusions.
create function private.merge_plan(p_source uuid, p_target uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  s public.releases;
  t public.releases;
  req public.catalog_change_requests;
  v_kind text;
  v_game public.games;
  v_source jsonb;
  v_target jsonb;
  v_field text;
  v_differences jsonb := '[]';
  v_blocking jsonb := '[]';
  v_retire jsonb := null;
  v_repoint uuid[];
  v_repoint_requests uuid[];
  v_references jsonb;
  v_copies bigint;
  v_owners bigint;
  c_critical constant text[] := array['game', 'region_code', 'edition_name', 'edition_kind', 'product_code', 'barcode', 'media_count'];
begin
  select * into s from public.releases r where r.id = p_source;
  if not found or s.status not in ('published', 'unverified', 'under_review') then
    raise exception 'release unavailable' using errcode = 'P0001';
  end if;
  select * into t from public.releases r where r.id = p_target;
  if not found or t.status <> 'published' or t.id = s.id then
    raise exception 'target unavailable' using errcode = 'P0001';
  end if;

  select * into req from public.catalog_change_requests x
  where x.release_id = s.id and x.status in ('open', 'in_review', 'changes_requested')
  order by x.id desc limit 1;
  v_kind := case when s.status = 'published' then 'published'
                 when req.id is not null or s.submitted_by is not null then 'submission'
                 else 'unpublished' end;

  -- Always blocking (safeguard 2, D2, D4, D7, D8).
  if s.platform_id <> t.platform_id then
    v_blocking := v_blocking || pg_catalog.jsonb_build_object('kind', 'platform');
  end if;
  if s.media_format_code is distinct from t.media_format_code then
    v_blocking := v_blocking || pg_catalog.jsonb_build_object('kind', 'media_format');
  end if;
  if v_kind = 'published' and s.game_id <> t.game_id then
    v_blocking := v_blocking || pg_catalog.jsonb_build_object('kind', 'other_game');
  end if;
  if v_kind = 'submission' and (req.id is null or req.status <> 'in_review') then
    v_blocking := v_blocking || pg_catalog.jsonb_build_object('kind', 'submission_not_in_review');
  end if;
  if exists (select 1 from public.collection_items c where c.release_id = s.id and c.record_status = 'invalid_preserved') then
    v_blocking := v_blocking || pg_catalog.jsonb_build_object('kind', 'preserved_copy');
  end if;
  if exists (
    select 1 from private.catalog_exclusions e
    where e.restored_at is null
      and (e.release_id in (s.id, t.id)
           or exists (select 1 from pg_catalog.jsonb_array_elements(e.cascade) x
                      where (x ->> 'entity' = 'game' and (x ->> 'id')::uuid in (s.game_id, t.game_id))
                         or (x ->> 'entity' = 'pairing'
                             and ((x ->> 'game_id')::uuid, (x ->> 'platform_id')::uuid) in ((s.game_id, s.platform_id), (t.game_id, t.platform_id)))))
  ) then
    v_blocking := v_blocking || pg_catalog.jsonb_build_object('kind', 'active_exclusion');
  end if;

  -- Every compared field that differs, in a fixed order (safeguard 2).
  v_source := private.merge_fields(s.id);
  v_target := private.merge_fields(t.id);
  for v_field in select k from pg_catalog.jsonb_object_keys(v_source) k order by k loop
    if v_source -> v_field is distinct from v_target -> v_field then
      v_differences := v_differences || pg_catalog.jsonb_build_object(
        'field', v_field, 'source', v_source -> v_field, 'target', v_target -> v_field, 'critical', v_field = any (c_critical));
    end if;
  end loop;

  -- A game the submission created, on another game's target: retired as rejection does.
  if v_kind = 'submission' and req.created_game and s.game_id <> t.game_id then
    select * into v_game from public.games g where g.id = s.game_id;
    if v_game.status in ('unverified', 'under_review') then
      v_retire := pg_catalog.jsonb_build_object('id', v_game.id, 'previous_status', v_game.status, 'status',
        case when exists (select 1 from public.releases o where o.game_id = v_game.id and o.id <> s.id
                          and o.status in ('unverified', 'under_review', 'published')) then 'unverified' else 'rejected' end);
    end if;
  end if;

  select coalesce(pg_catalog.array_agg(r.id order by r.id), '{}') into v_repoint
  from public.releases r where r.merged_into_id = s.id;
  select coalesce(pg_catalog.array_agg(x.id order by x.id), '{}') into v_repoint_requests
  from public.catalog_change_requests x where x.merged_into_release_id = s.id;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', x.id, 'provider_code', x.provider_code, 'entity_type', x.entity_type, 'external_id', x.external_id,
      'target_had_provider', exists (select 1 from private.external_references y where y.release_id = t.id and y.provider_code = x.provider_code))
      order by x.id), '[]')
  into v_references
  from private.external_references x where x.release_id = s.id;

  select count(*), count(distinct c.owner_id) into v_copies, v_owners
  from public.collection_items c where c.release_id = s.id and c.record_status = 'active';

  return pg_catalog.jsonb_build_object(
    'source_id', s.id, 'target_id', t.id, 'kind', v_kind,
    'source_game_id', s.game_id, 'target_game_id', t.game_id,
    'previous_status', s.status, 'previous_revision', s.revision,
    'request_id', req.id, 'request_version', req.version,
    'differences', v_differences,
    'blocking', v_blocking,
    'retire', v_retire,
    'repoint_releases', pg_catalog.to_jsonb(v_repoint),
    'repoint_requests', pg_catalog.to_jsonb(v_repoint_requests),
    'references', v_references,
    'copies', v_copies,
    'owners', v_owners,
    'token', pg_catalog.md5(pg_catalog.jsonb_build_object(
      'source', pg_catalog.jsonb_build_array(s.id, s.status, s.revision),
      'target', pg_catalog.jsonb_build_array(t.id, t.status, t.revision),
      'request', pg_catalog.jsonb_build_array(req.id, req.status, req.version),
      'kind', v_kind, 'differences', v_differences, 'blocking', v_blocking, 'retire', v_retire,
      'repoint', pg_catalog.to_jsonb(v_repoint), 'repoint_requests', pg_catalog.to_jsonb(v_repoint_requests),
      'references', v_references)::text));
end;
$$;

-- Whether p_me ever submitted the source, the target, or a game either is on (D6),
-- by the permanent history, or is still recorded as a submitter of either.
create function private.merge_involves(p_me uuid, p_source uuid, p_target uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.releases r where r.id in (p_source, p_target) and r.submitted_by = p_me)
      or exists (select 1 from public.games g join public.releases r on r.game_id = g.id
                 where r.id in (p_source, p_target) and g.submitted_by = p_me)
      or exists (select 1 from public.catalog_change_requests x
                 where x.submitted_by = p_me
                   and (x.release_id in (p_source, p_target)
                        or (x.created_game and x.game_id in (select r.game_id from public.releases r where r.id in (p_source, p_target)))))
$$;

-- Every profile the merge's locked rows refer to, and every owner of a copy on the
-- source, with the caller, in id order (safeguard 3). Account deletion locks a profile
-- and then clears it from these rows, so they're locked first.
create function private.merge_profiles(p_me uuid, p_source uuid, p_target uuid)
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct x.id order by x.id) filter (where x.id is not null), '{}')
  from (
    select p_me as id
    union all
    select unnest(array[r.submitted_by, r.verified_by]) from public.releases r where r.id in (p_source, p_target)
    union all
    select unnest(array[g.submitted_by, g.verified_by])
    from public.releases r join public.games g on g.id = r.game_id where r.id in (p_source, p_target)
    union all
    select gp.submitted_by from public.releases r
    join public.game_platforms gp on gp.game_id = r.game_id and gp.platform_id = r.platform_id
    where r.id in (p_source, p_target)
    union all
    select unnest(array[x.submitted_by, x.reviewed_by]) from public.catalog_change_requests x
    where (x.release_id = p_source and x.status in ('open', 'in_review', 'changes_requested')) or x.merged_into_release_id = p_source
    union all
    select unnest(array[r.submitted_by, r.verified_by]) from public.releases r where r.merged_into_id = p_source
    union all
    select c.owner_id from public.collection_items c where c.release_id = p_source
  ) x
$$;

-- Locks a merge's catalog rows in the global order (safeguard 3): the source's open
-- submission and the submissions merged into it, by id; both games, by id; the
-- releases, by id (the source and those merged into it for update, the target for
-- share, as relinking takes it); then both pairings. A game changing under the locks
-- is a retryable conflict.
create function private.lock_merge_records(p_source uuid, p_target uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_source_game uuid;
  v_target_game uuid;
  v_id uuid;
begin
  select r.game_id into v_source_game from public.releases r where r.id = p_source;
  if not found then
    raise exception 'release unavailable' using errcode = 'P0001';
  end if;
  select r.game_id into v_target_game from public.releases r where r.id = p_target;
  if not found then
    raise exception 'target unavailable' using errcode = 'P0001';
  end if;
  perform 1 from public.catalog_change_requests x
  where (x.release_id = p_source and x.status in ('open', 'in_review', 'changes_requested')) or x.merged_into_release_id = p_source
  order by x.id for update;
  perform 1 from public.games g where g.id in (v_source_game, v_target_game) order by g.id for update;
  for v_id in select r.id from public.releases r where r.id in (p_source, p_target) or r.merged_into_id = p_source order by r.id loop
    if v_id = p_target then
      perform 1 from public.releases r where r.id = v_id for share;
    else
      perform 1 from public.releases r where r.id = v_id for update;
    end if;
  end loop;
  if (select r.game_id from public.releases r where r.id = p_source) is distinct from v_source_game
     or (select r.game_id from public.releases r where r.id = p_target) is distinct from v_target_game then
    raise exception 'request conflict' using errcode = 'P0001';
  end if;
  perform 1 from public.game_platforms gp
  where (gp.game_id, gp.platform_id) in (select r.game_id, r.platform_id from public.releases r where r.id in (p_source, p_target))
  order by gp.game_id, gp.platform_id for share;
end;
$$;

-- The plan with names, for the editor's preview.
create function private.describe_merge(p_me uuid, p_plan jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select p_plan - array['previous_revision', 'request_version']
    || pg_catalog.jsonb_build_object(
      'source', private.release_label((p_plan ->> 'source_id')::uuid),
      'target', private.release_label((p_plan ->> 'target_id')::uuid),
      'requires_admin', p_plan ->> 'kind' = 'published',
      'own_submission', private.merge_involves(p_me, (p_plan ->> 'source_id')::uuid, (p_plan ->> 'target_id')::uuid))
$$;

revoke all on function private.merge_fields(uuid) from public, anon, authenticated, service_role;
revoke all on function private.merge_plan(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.merge_involves(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.merge_profiles(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_merge_records(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.describe_merge(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.refuse_merge_record_change() from public, anon, authenticated, service_role;
revoke all on function private.set_copy_updated_at() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Previewing and merging
-- ---------------------------------------------------------------------------

-- What merging would do, for an active catalog editor: both releases, every
-- difference, what blocks it, the copies and owners, what's repointed, retired and
-- reassigned, whether it needs an administrator, and the token merge_release() needs.
create function public.get_merge_preview(p_source uuid, p_target uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
begin
  v_me := private.require_active_staff('catalog_editor');
  return private.describe_merge(v_me, private.merge_plan(p_source, p_target));
end;
$$;

-- Published releases a source could be merged into, for an active catalog editor:
-- the same platform and physical format, its own game first, then matching product
-- codes or barcodes, then games with similar titles. At most 25.
create function public.get_merge_candidates(p_source uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.releases;
  v_key text;
begin
  perform private.require_active_staff('catalog_editor');
  select * into s from public.releases r where r.id = p_source and r.status in ('published', 'unverified', 'under_review');
  if not found then
    raise exception 'release unavailable' using errcode = 'P0001';
  end if;
  select g.search_key into v_key from public.games g where g.id = s.game_id;
  return (
    select coalesce(pg_catalog.jsonb_agg(private.release_label(x.id) || pg_catalog.jsonb_build_object(
             'same_game', x.same_game, 'same_code', x.same_code) order by x.rank, x.id), '[]')
    from (
      select r.id, r.game_id = s.game_id as same_game,
             (s.product_code is not null and r.product_code = s.product_code) or (s.barcode is not null and r.barcode = s.barcode) as same_code,
             case when r.game_id = s.game_id then 0
                  when (s.product_code is not null and r.product_code = s.product_code) or (s.barcode is not null and r.barcode = s.barcode) then 1
                  else 2 end as rank
      from public.releases r
      join public.games g on g.id = r.game_id
      where r.status = 'published' and r.id <> s.id and r.platform_id = s.platform_id
        and r.media_format_code is not distinct from s.media_format_code
        and (r.game_id = s.game_id
             or (s.status <> 'published'
                 and ((s.product_code is not null and r.product_code = s.product_code)
                      or (s.barcode is not null and r.barcode = s.barcode)
                      or (v_key is not null and extensions.similarity(g.search_key, v_key) >= 0.5))))
      order by rank, r.id
      limit 25
    ) x
  );
end;
$$;

-- Merges p_source into p_target. p_acknowledged names every differing field, each
-- one, exactly as the preview listed them; p_acknowledge_copies is required when
-- copies move. Returns {merge_id, copies, owners, references}.
create function public.merge_release(
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
-- 6. Reading merges
-- ---------------------------------------------------------------------------

-- Merges, newest first, paged by id, for active catalog editors. Returns {items, next_after}.
create function public.get_merges(p_after uuid default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_items jsonb;
begin
  perform private.require_active_staff('catalog_editor');
  select coalesce(pg_catalog.jsonb_agg(x.d order by x.id desc), '[]') into v_items
  from (
    select m.id, pg_catalog.jsonb_build_object(
      'id', m.id, 'kind', m.kind, 'merged_at', m.merged_at, 'copies_moved', m.copies_moved, 'owners_affected', m.owners_affected,
      'source', private.release_label(m.source_release_id), 'target', private.release_label(m.target_release_id)) d
    from private.catalog_merges m
    where p_after is null or m.id < p_after
    order by m.id desc
    limit v_limit + 1
  ) x;
  return pg_catalog.jsonb_build_object(
    'items', (select coalesce(pg_catalog.jsonb_agg(e order by n), '[]') from pg_catalog.jsonb_array_elements(v_items) with ordinality a(e, n) where n <= v_limit),
    'next_after', case when pg_catalog.jsonb_array_length(v_items) > v_limit then v_items -> (v_limit - 1) ->> 'id' end);
end;
$$;

-- One merge in full, for active catalog editors.
create function public.get_merge(p_merge uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  m private.catalog_merges;
begin
  perform private.require_active_staff('catalog_editor');
  select * into m from private.catalog_merges x where x.id = p_merge;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'id', m.id, 'kind', m.kind, 'merged_at', m.merged_at,
    'merged_by', (select p.handle from public.profiles p where p.id = m.merged_by),
    'staff_reason', m.staff_reason, 'owner_note', m.owner_note,
    'source', private.release_label(m.source_release_id), 'target', private.release_label(m.target_release_id),
    'previous_status', m.previous_status, 'request_id', m.request_id,
    'differences', m.differences,
    'repointed_releases', pg_catalog.to_jsonb(m.repointed_releases), 'repointed_requests', pg_catalog.to_jsonb(m.repointed_requests),
    'retired_game', m.retired_game,
    'references', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'provider_code', r.provider_code, 'entity_type', r.entity_type, 'external_id', r.external_id,
        'target_had_provider', r.target_had_provider) order by r.provider_code, r.external_id), '[]')
      from private.catalog_merge_references r where r.merge_id = m.id),
    'copies_moved', m.copies_moved, 'owners_affected', m.owners_affected, 'references_moved', m.references_moved);
end;
$$;

-- Where a submitter's merged submission went: the release it was merged into and its
-- game's address, while that release is public. Null otherwise, and for anyone else.
create function public.get_my_merged_submission(p_submission uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('release_id', r.id, 'game_slug', g.slug)
  from public.catalog_change_requests x
  join public.releases r on r.id = x.merged_into_release_id and r.status = 'published'
  join public.games g on g.id = r.game_id and g.status = 'published'
  where x.id = p_submission and x.submitted_by = (select auth.uid()) and x.status = 'merged'
    and exists (select 1 from private.catalog_public_releases(g.id) p where p.id = r.id)
$$;

revoke all on function public.get_merge_preview(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_merge_candidates(uuid) from public, anon, authenticated, service_role;
revoke all on function public.merge_release(uuid, uuid, text, text, text, text[], boolean) from public, anon, authenticated, service_role;
revoke all on function public.get_merges(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_merge(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_merged_submission(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_merge_preview(uuid, uuid) to authenticated;
grant execute on function public.get_merge_candidates(uuid) to authenticated;
grant execute on function public.merge_release(uuid, uuid, text, text, text, text[], boolean) to authenticated;
grant execute on function public.get_merges(uuid, integer) to authenticated;
grant execute on function public.get_merge(uuid) to authenticated;
grant execute on function public.get_my_merged_submission(uuid) to authenticated;
