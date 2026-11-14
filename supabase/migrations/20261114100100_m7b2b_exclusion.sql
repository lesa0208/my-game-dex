-- M7b-2b: excluding releases from the catalog, and restoring an exclusion.
--
-- Design: docs/architecture/security-rls.md#excluding-and-restoring-releases-m7b-2b
-- Approved decisions D1 to D12 and the lock-order correction.
--
-- 1. Publication rules hold in both directions at commit, including games cataloged
--    only through a compilation (D2). Every change below is checked by them, and a
--    violation rolls the whole transaction back.
-- 2. A copy's updated_at records its owner's edits. Changing only its preservation
--    status, as exclusion and restoration do, keeps it.
-- 3. exclude_release() excludes a published, pending or rejected release, with the
--    game, pairing and contained games that would otherwise break the publication
--    rules (D1, D2), acknowledged against a token from get_exclusion_preview() (D12).
--    Every active copy on it becomes invalid_preserved; nothing is deleted.
-- 4. restore_exclusion() lets another administrator put back exactly the previous
--    statuses (D4, D5), reactivating only the copies that exclusion preserved and
--    that are still on the release and still preserved.
--
-- Lock order (approved). Profiles are locked FOR KEY SHARE before any catalog row:
-- the caller, then, in id order, every profile the rows about to be locked refer to
-- (submitters, verifiers, reviewers) and every owner of an affected copy. Then catalog
-- rows: the request, games by id, the release, the pairing, then copies by id. Account
-- deletion locks a profile and then clears references to it in catalog rows, so
-- waiting for a profile while holding catalog rows could deadlock with it. After the
-- catalog locks, references and owners are read again, and any profile not yet locked
-- is locked with NOWAIT: if that would wait, the call fails with 'request conflict'
-- and nothing is changed. Restoration takes the same order; its copies are a recorded
-- set that can only shrink.

-- ---------------------------------------------------------------------------
-- 1. Publication rules, both directions
-- ---------------------------------------------------------------------------

-- Whether a game keeps a published physical release if p_without is no longer one: its
-- own, or one of a published compilation containing it (ADR-025).
create function private.game_keeps_release(p_game uuid, p_without uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.releases r where r.game_id = p_game and r.status = 'published' and r.id is distinct from p_without)
      or exists (
        select 1
        from public.game_relations gr
        join public.games c on c.id = gr.source_game_id and c.status = 'published'
        join public.releases r on r.game_id = c.id and r.status = 'published' and r.id is distinct from p_without
        where gr.target_game_id = p_game and gr.relation = 'contains'
      )
$$;

-- The rules for one game and, optionally, one of its platforms.
create function private.check_publication_of(p_game uuid, p_platform uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_published boolean;
begin
  v_published := exists (select 1 from public.games g where g.id = p_game and g.status = 'published');

  if p_platform is not null then
    if exists (
      select 1 from public.game_platforms gp
      where gp.game_id = p_game and gp.platform_id = p_platform and gp.status = 'published'
        and not (v_published
                 and exists (select 1 from public.releases r where r.game_id = gp.game_id and r.platform_id = gp.platform_id and r.status = 'published'))
    ) then
      raise exception 'a platform is published for a game only with a published release on it' using errcode = 'check_violation';
    end if;
    -- The reverse: a published release needs its pairing published.
    if exists (
      select 1 from public.releases r
      where r.game_id = p_game and r.platform_id = p_platform and r.status = 'published'
        and not exists (select 1 from public.game_platforms gp where gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published')
    ) then
      raise exception 'a release can be published only with its game and platform' using errcode = 'check_violation';
    end if;
  end if;

  if v_published then
    if not private.game_has_published_release(p_game) then
      raise exception 'a game is published only with a published physical release' using errcode = 'check_violation';
    end if;
  elsif exists (select 1 from public.releases r where r.game_id = p_game and r.status = 'published')
     or exists (select 1 from public.game_platforms gp where gp.game_id = p_game and gp.status = 'published') then
    -- The reverse: nothing of an unpublished game stays published.
    raise exception 'a release can be published only with its game and platform' using errcode = 'check_violation';
  end if;

  -- Games cataloged through this one, if it's a compilation (D2).
  if exists (
    select 1
    from public.game_relations gr
    join public.games t on t.id = gr.target_game_id and t.status = 'published'
    where gr.source_game_id = p_game and gr.relation = 'contains'
      and not private.game_has_published_release(t.id)
  ) then
    raise exception 'a game is published only with a published physical release' using errcode = 'check_violation';
  end if;
end;
$$;

-- Checked at commit, as in M5, now in both directions and for contained games. It
-- rereads the state about to be committed. SECURITY DEFINER for the M5 reason: at
-- commit it runs as the session's role.
create or replace function private.check_catalog_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'releases' then
    perform private.check_publication_of(new.game_id, new.platform_id);
    if tg_op = 'UPDATE' and (old.game_id, old.platform_id) is distinct from (new.game_id, new.platform_id) then
      perform private.check_publication_of(old.game_id, old.platform_id);
    end if;
  elsif tg_table_name = 'game_platforms' then
    perform private.check_publication_of(new.game_id, new.platform_id);
  else
    perform private.check_publication_of(new.id, null);
  end if;
  return null;
end;
$$;

revoke all on function private.game_keeps_release(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.check_publication_of(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.check_catalog_publication() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. A copy's updated_at
-- ---------------------------------------------------------------------------

-- Changing only a copy's preservation status isn't its owner's edit, so it keeps
-- updated_at. Every other update sets it, as before.
create function private.set_copy_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
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

drop trigger set_updated_at on public.collection_items;
create trigger set_updated_at before update on public.collection_items
  for each row execute function private.set_copy_updated_at();
revoke all on function private.set_copy_updated_at() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Exclusion records
-- ---------------------------------------------------------------------------

-- One row per exclusion, kept after restoration as history. Staff ids are plain values,
-- as in the audit log, so an account deletion never changes or locks them.
create table private.catalog_exclusions (
  id uuid primary key default private.uuid_v7(),
  release_id uuid not null references public.releases (id) on delete restrict,
  excluded_by uuid not null,
  excluded_at timestamptz not null,
  reason_code private.exclusion_reason not null,
  -- Private to staff (D7).
  staff_reason text not null check (char_length(staff_reason) between 1 and 500),
  -- Shown to owners of preserved copies, and to the submitter (D7).
  owner_note text check (char_length(owner_note) between 1 and 1000 and owner_note = btrim(owner_note)),
  previous_status public.catalog_status not null check (previous_status in ('unverified', 'under_review', 'published', 'rejected')),
  -- The submission it closed, and that request's fields before.
  request_id uuid references public.catalog_change_requests (id) on delete set null,
  previous_request jsonb check (previous_request is null or jsonb_typeof(previous_request) = 'object'),
  -- [{entity: 'game' | 'pairing', id | game_id + platform_id, previous_status}]
  cascade jsonb not null default '[]' check (jsonb_typeof(cascade) = 'array'),
  copies_preserved integer not null check (copies_preserved >= 0),
  owners_affected integer not null check (owners_affected >= 0),
  version integer not null default 1 check (version > 0),
  restored_at timestamptz,
  restored_by uuid,
  restore_reason text check (char_length(restore_reason) between 1 and 500),
  copies_restored integer check (copies_restored >= 0),
  constraint catalog_exclusions_restored check ((restored_at is null) = (restored_by is null) and (restored_at is null) = (restore_reason is null) and (restored_at is null) = (copies_restored is null))
);
-- A release is excluded at most once at a time.
create unique index catalog_exclusions_active_key on private.catalog_exclusions (release_id) where restored_at is null;
create index catalog_exclusions_list_idx on private.catalog_exclusions ((restored_at is null), id desc);

-- The copies an exclusion preserved: exactly those, so restoration never touches a copy
-- preserved by anything else. A row goes when its copy is deleted, so an owner's
-- deletion is never undone and nothing about a deleted account stays here.
create table private.catalog_exclusion_copies (
  exclusion_id uuid not null references private.catalog_exclusions (id) on delete cascade,
  item_id uuid not null references public.collection_items (id) on delete cascade,
  owner_id uuid not null,
  primary key (exclusion_id, item_id)
);
create index catalog_exclusion_copies_item_idx on private.catalog_exclusion_copies (item_id);

alter table private.catalog_exclusions enable row level security;
alter table private.catalog_exclusion_copies enable row level security;
revoke all on table private.catalog_exclusions from public, anon, authenticated, service_role;
revoke all on table private.catalog_exclusion_copies from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Notifications: once per owner per event, never naming staff (D8)
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
  -- The submitter of an excluded submission.
  or (type = 'catalog_submission'
    and actor_id is null and event_at is null
    and data - array['status', 'submission_id', 'exclusion_id'] = '{}'::jsonb
    and data ->> 'status' = 'excluded'
    and jsonb_typeof(data -> 'submission_id') = 'string' and jsonb_typeof(data -> 'exclusion_id') = 'string')
  -- Owners of copies a release's exclusion preserved, or its restoration reactivated.
  or (type = 'catalog_exclusion'
    and actor_id is null and event_at is null
    and data - array['status', 'exclusion_id', 'copies'] = '{}'::jsonb
    and data ->> 'status' in ('excluded', 'restored')
    and jsonb_typeof(data -> 'exclusion_id') = 'string' and jsonb_typeof(data -> 'copies') = 'number')
);
create unique index notifications_exclusion_event_key on public.notifications (recipient_id, (data ->> 'exclusion_id'), (data ->> 'status'))
  where data ? 'exclusion_id';

-- ---------------------------------------------------------------------------
-- 5. Planning an exclusion
-- ---------------------------------------------------------------------------

-- What excluding a release would do, from the current state: null if it can't be
-- excluded at all. Read without locks for the preview, and again under the locks
-- before anything changes. The token covers the release's state and revision, the
-- submission it would close and the whole cascade, not the copy or owner counts (D12).
create function private.exclusion_plan(p_release uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  rel public.releases;
  req public.catalog_change_requests;
  v_game public.games;
  v_cascade jsonb := '[]';
  v_games uuid[] := '{}';
  v_blocking jsonb;
  v_copies bigint;
  v_owners bigint;
begin
  select * into rel from public.releases r where r.id = p_release;
  if not found or rel.status not in ('unverified', 'under_review', 'published', 'rejected') then
    return null;
  end if;
  -- The submission an exclusion closes: the active one, or else the latest rejected one.
  select * into req from public.catalog_change_requests s
  where s.release_id = rel.id and s.request_type in ('new_game', 'new_release')
    and s.status in ('open', 'in_review', 'changes_requested', 'rejected')
  order by (s.status <> 'rejected') desc, s.id desc
  limit 1;
  select * into v_game from public.games g where g.id = rel.game_id;

  if rel.status = 'published' then
    -- The pairing, if no other published release is on it.
    if exists (select 1 from public.game_platforms gp where gp.game_id = rel.game_id and gp.platform_id = rel.platform_id and gp.status = 'published')
       and not exists (select 1 from public.releases o where o.game_id = rel.game_id and o.platform_id = rel.platform_id and o.status = 'published' and o.id <> rel.id) then
      v_cascade := v_cascade || pg_catalog.jsonb_build_object('entity', 'pairing', 'game_id', rel.game_id, 'platform_id', rel.platform_id, 'previous_status', 'published');
    end if;
    -- The game, if this was its last published physical release.
    if v_game.status = 'published' and not private.game_keeps_release(v_game.id, rel.id) then
      v_games := v_games || v_game.id;
    end if;
    -- Games cataloged only through this release, if the game is a compilation.
    v_games := v_games || coalesce((
      select pg_catalog.array_agg(t.id order by t.id)
      from public.game_relations gr
      join public.games t on t.id = gr.target_game_id and t.status = 'published'
      where gr.source_game_id = rel.game_id and gr.relation = 'contains' and t.id <> rel.game_id
        and not private.game_keeps_release(t.id, rel.id)
    ), '{}');
    v_cascade := v_cascade || coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('entity', 'game', 'id', g.id, 'previous_status', 'published',
               'contained', g.id <> rel.game_id) order by g.id)
      from public.games g where g.id = any (v_games)
    ), '[]');
  elsif req.created_game and v_game.status in ('unverified', 'under_review')
        and not exists (select 1 from public.releases o where o.game_id = v_game.id and o.id <> rel.id
                        and o.status in ('unverified', 'under_review', 'published', 'rejected')) then
    -- A game the submission made, used by nothing else, as rejection treats it.
    v_games := array[v_game.id];
    v_cascade := v_cascade || pg_catalog.jsonb_build_object('entity', 'game', 'id', v_game.id, 'previous_status', v_game.status, 'contained', false);
  end if;

  -- What would be stranded or left pointing at an excluded record (D1, D10).
  select coalesce(pg_catalog.jsonb_agg(b order by b ->> 'kind', b ->> 'id'), '[]') into v_blocking from (
    select pg_catalog.jsonb_build_object('kind', 'submission', 'id', o.id, 'game_id', o.game_id) as b
    from public.releases o
    where o.game_id = any (v_games) and o.id <> rel.id and o.status in ('unverified', 'under_review', 'rejected')
    union all
    select pg_catalog.jsonb_build_object('kind', 'merged_release', 'id', o.id)
    from public.releases o where o.merged_into_id = rel.id
    union all
    select pg_catalog.jsonb_build_object('kind', 'merged_game', 'id', o.id)
    from public.games o where o.merged_into_id = any (v_games)
  ) x;

  select count(*), count(distinct c.owner_id) into v_copies, v_owners
  from public.collection_items c where c.release_id = rel.id and c.record_status = 'active';

  return pg_catalog.jsonb_build_object(
    'release_id', rel.id,
    'game_id', rel.game_id,
    'platform_id', rel.platform_id,
    'status', rel.status,
    'request_id', req.id,
    'request_status', req.status,
    'cascade', v_cascade,
    'blocking', v_blocking,
    'copies', v_copies,
    'owners', v_owners,
    'token', pg_catalog.md5(pg_catalog.jsonb_build_array(
      rel.id, rel.status, rel.revision, req.id, req.status, req.version, v_cascade, pg_catalog.jsonb_array_length(v_blocking))::text)
  );
end;
$$;

-- Whether p_me submitted the release, or a game the exclusion would take with it.
create function private.exclusion_involves(p_me uuid, p_release uuid, p_cascade jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.catalog_change_requests s
    where s.submitted_by = p_me
      and (s.release_id = p_release
           or (s.created_game and s.game_id in (
                 select (e ->> 'id')::uuid from pg_catalog.jsonb_array_elements(p_cascade) e where e ->> 'entity' = 'game')))
  )
$$;

-- Every profile the rows an exclusion or restoration locks refer to, with the owners of
-- the copies it changes and the caller, sorted. Copies are the release's active ones,
-- or, with p_exclusion, the ones that exclusion recorded.
create function private.exclusion_profiles(p_me uuid, p_release uuid, p_exclusion uuid)
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct x.id order by x.id) filter (where x.id is not null), '{}')
  from (
    select p_me as id
    union all
    select unnest(array[r.submitted_by, r.verified_by]) from public.releases r where r.id = p_release
    union all
    select unnest(array[g.submitted_by, g.verified_by])
    from public.releases r
    join public.games g on g.id = r.game_id
      or g.id in (select gr.target_game_id from public.game_relations gr where gr.source_game_id = r.game_id and gr.relation = 'contains')
    where r.id = p_release
    union all
    select gp.submitted_by from public.releases r
    join public.game_platforms gp on gp.game_id = r.game_id and gp.platform_id = r.platform_id
    where r.id = p_release
    union all
    select unnest(array[s.submitted_by, s.reviewed_by]) from public.catalog_change_requests s
    where s.release_id = p_release and s.status in ('open', 'in_review', 'changes_requested', 'rejected', 'excluded')
    union all
    select (e.previous_request ->> 'reviewed_by')::uuid from private.catalog_exclusions e where e.id = p_exclusion
    union all
    select c.owner_id from public.collection_items c
    where p_exclusion is null and c.release_id = p_release and c.record_status = 'active'
    union all
    select ec.owner_id from private.catalog_exclusion_copies ec where ec.exclusion_id = p_exclusion
  ) x
$$;

-- After the catalog rows are locked: locks any profile not locked before, without
-- waiting. If one is being changed (an account deletion), the whole call fails with a
-- retryable conflict and nothing it did is kept.
create function private.lock_new_profiles(p_locked uuid[], p_now uuid[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  for v_id in select x from pg_catalog.unnest(p_now) x where not (x = any (p_locked)) order by x loop
    begin
      perform 1 from public.profiles p where p.id = v_id for key share nowait;
    exception when lock_not_available then
      raise exception 'request conflict' using errcode = 'P0001';
    end;
  end loop;
end;
$$;

-- Locks an exclusion's catalog rows in the established order: the release's
-- submission requests, its game and the games it contains by id, the release, then
-- its pairing. Returns the release.
create function private.lock_exclusion_records(p_release uuid)
returns public.releases
language plpgsql
set search_path = ''
as $$
declare
  v_game uuid;
  rel public.releases;
begin
  select r.game_id into v_game from public.releases r where r.id = p_release;
  if not found then
    raise exception 'release unavailable' using errcode = 'P0001';
  end if;
  perform 1 from public.catalog_change_requests s
  where s.release_id = p_release and s.status in ('open', 'in_review', 'changes_requested', 'rejected', 'excluded')
  order by s.id for update;
  perform 1 from public.games g
  where g.id = v_game
     or g.id in (select gr.target_game_id from public.game_relations gr where gr.source_game_id = v_game and gr.relation = 'contains')
  order by g.id for update;
  select * into rel from public.releases r where r.id = p_release for update;
  if rel.game_id is distinct from v_game then
    raise exception 'request conflict' using errcode = 'P0001';
  end if;
  perform 1 from public.game_platforms gp where gp.game_id = rel.game_id and gp.platform_id = rel.platform_id for update;
  return rel;
end;
$$;

-- "Game title (Platform · Region · Edition · Product code)", for staff pages.
create function private.release_label(p_release uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', r.id, 'status', r.status,
    'game', pg_catalog.jsonb_build_object('id', g.id, 'title', g.title, 'slug', g.slug, 'status', g.status),
    'platform', pg_catalog.jsonb_build_object('id', pl.id, 'slug', pl.slug, 'name', pl.name),
    'region', coalesce(rc.label, r.region_code),
    'edition_name', r.edition_name, 'variant_name', r.variant_name, 'product_code', r.product_code)
  from public.releases r
  join public.games g on g.id = r.game_id
  join public.platforms pl on pl.id = r.platform_id
  left join public.region_codes rc on rc.code = r.region_code
  where r.id = p_release
$$;

-- The plan with names, for the editor's preview.
create function private.describe_plan(p_plan jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select p_plan - array['game_id', 'platform_id', 'request_status']
    || pg_catalog.jsonb_build_object(
      'release', private.release_label((p_plan ->> 'release_id')::uuid),
      'cascade', coalesce((
        select pg_catalog.jsonb_agg(e || case e ->> 'entity'
            when 'game' then pg_catalog.jsonb_build_object('title', (select g.title from public.games g where g.id = (e ->> 'id')::uuid))
            else pg_catalog.jsonb_build_object(
              'title', (select g.title from public.games g where g.id = (e ->> 'game_id')::uuid),
              'platform', (select pl.name from public.platforms pl where pl.id = (e ->> 'platform_id')::uuid))
          end)
        from pg_catalog.jsonb_array_elements(p_plan -> 'cascade') e), '[]'),
      'blocking', coalesce((
        select pg_catalog.jsonb_agg(b || case b ->> 'kind'
            when 'merged_game' then pg_catalog.jsonb_build_object('label', (select g.title from public.games g where g.id = (b ->> 'id')::uuid))
            else pg_catalog.jsonb_build_object('label', private.release_label((b ->> 'id')::uuid),
              'request_id', (select s.id from public.catalog_change_requests s where s.release_id = (b ->> 'id')::uuid order by s.id desc limit 1))
          end)
        from pg_catalog.jsonb_array_elements(p_plan -> 'blocking') b), '[]'))
$$;

revoke all on function private.exclusion_plan(uuid) from public, anon, authenticated, service_role;
revoke all on function private.exclusion_involves(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.exclusion_profiles(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_new_profiles(uuid[], uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.lock_exclusion_records(uuid) from public, anon, authenticated, service_role;
revoke all on function private.release_label(uuid) from public, anon, authenticated, service_role;
revoke all on function private.describe_plan(jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Excluding
-- ---------------------------------------------------------------------------

-- What excluding a release would do, for an active catalog editor: the release, the
-- copies and owners affected, the cascade, anything blocking it, whether it's the
-- caller's own submission, and the token exclude_release() needs.
create function public.get_exclusion_preview(p_release uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_plan jsonb;
begin
  v_me := private.require_active_staff('catalog_editor');
  v_plan := private.exclusion_plan(p_release);
  if v_plan is null then
    raise exception 'release unavailable' using errcode = 'P0001';
  end if;
  return private.describe_plan(v_plan)
    || pg_catalog.jsonb_build_object('own_submission', private.exclusion_involves(v_me, p_release, v_plan -> 'cascade'));
end;
$$;

-- Excludes a release (D1, D6, D7, D12). The caller is an active catalog editor or
-- administrator who didn't submit it. p_token is the preview's: if anything it covers
-- changed, the call is refused with 'preview stale' and the editor reviews it again.
-- Returns {exclusion_id, copies, owners}.
create function public.exclude_release(
  p_release uuid,
  p_token text,
  p_reason_code text,
  p_reason text,
  p_owner_note text default null,
  p_acknowledge_cascade boolean default false,
  p_acknowledge_copies boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_code private.exclusion_reason;
  v_note text := nullif(pg_catalog.btrim(p_owner_note), '');
  v_locked uuid[];
  v_plan jsonb;
  rel public.releases;
  req public.catalog_change_requests;
  v_items uuid[];
  v_owners uuid[];
  v_id uuid;
  v_now timestamptz := pg_catalog.now();
  v_owner uuid;
  v_count integer;
  v_notified uuid := null;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  begin
    v_code := p_reason_code::private.exclusion_reason;
  exception when others then
    raise exception 'invalid exclusion' using errcode = '22023';
  end;
  if v_code is null or p_token is null or pg_catalog.char_length(v_note) > 1000 then
    raise exception 'invalid exclusion' using errcode = '22023';
  end if;

  -- 1. Profiles first, before any catalog row.
  v_locked := private.exclusion_profiles(v_me, p_release, null);
  perform 1 from public.profiles p where p.id = any (v_locked) order by p.id for key share;

  -- 2. Catalog rows, then the plan again under the locks.
  rel := private.lock_exclusion_records(p_release);
  v_plan := private.exclusion_plan(p_release);
  if v_plan is null then
    raise exception 'release unavailable' using errcode = 'P0001';
  end if;
  if v_plan ->> 'token' is distinct from p_token then
    raise exception 'preview stale' using errcode = 'P0001';
  end if;
  if private.exclusion_involves(v_me, p_release, v_plan -> 'cascade') then
    raise exception 'own submission' using errcode = 'P0001';
  end if;
  if pg_catalog.jsonb_array_length(v_plan -> 'blocking') > 0 then
    raise exception 'exclusion blocked' using errcode = 'P0001';
  end if;
  if (pg_catalog.jsonb_array_length(v_plan -> 'cascade') > 0 and not coalesce(p_acknowledge_cascade, false))
     or ((v_plan ->> 'copies')::bigint > 0 and not coalesce(p_acknowledge_copies, false)) then
    raise exception 'acknowledgement required' using errcode = 'P0001';
  end if;

  -- 3. Anyone referenced or owning a copy now, who wasn't locked before: no waiting.
  perform private.lock_new_profiles(v_locked, private.exclusion_profiles(v_me, p_release, null));

  -- 4. The copies. None can be added or moved away while the release is locked.
  select coalesce(pg_catalog.array_agg(x.id order by x.id), '{}'), coalesce(pg_catalog.array_agg(x.owner_id order by x.id), '{}')
  into v_items, v_owners
  from (
    select c.id, c.owner_id from public.collection_items c
    where c.release_id = rel.id and c.record_status = 'active'
    order by c.id
    for update
  ) x;

  if v_plan ->> 'request_id' is not null then
    select * into req from public.catalog_change_requests s where s.id = (v_plan ->> 'request_id')::uuid;
  end if;

  insert into private.catalog_exclusions (
    release_id, excluded_by, excluded_at, reason_code, staff_reason, owner_note, previous_status,
    request_id, previous_request, cascade, copies_preserved, owners_affected)
  values (
    rel.id, v_me, v_now, v_code, v_reason, v_note, rel.status,
    req.id,
    case when req.id is null then null else pg_catalog.jsonb_build_object(
      'status', req.status, 'reviewed_by', req.reviewed_by, 'reviewed_at', req.reviewed_at, 'reviewer_note', req.reviewer_note) end,
    v_plan -> 'cascade', pg_catalog.cardinality(v_items), (select count(distinct o) from pg_catalog.unnest(v_owners) o))
  returning id into v_id;

  -- 5. The changes. The request first: the M7b-1 guard refuses changes to a record
  --    whose submission is still active.
  if req.id is not null then
    update public.catalog_change_requests s set
      status = 'excluded', reviewed_by = v_me, reviewed_at = v_now, reviewer_note = v_note
    where s.id = req.id;
  end if;
  update public.releases r set status = 'excluded' where r.id = rel.id;
  update public.games g set status = 'excluded'
  where g.id in (select (e ->> 'id')::uuid from pg_catalog.jsonb_array_elements(v_plan -> 'cascade') e where e ->> 'entity' = 'game');
  update public.game_platforms gp set status = 'excluded'
  where exists (select 1 from pg_catalog.jsonb_array_elements(v_plan -> 'cascade') e
                where e ->> 'entity' = 'pairing' and (e ->> 'game_id')::uuid = gp.game_id and (e ->> 'platform_id')::uuid = gp.platform_id);

  -- Only the preservation status and its time change; the copy, its private details
  -- and every piece record stay as they are.
  update public.collection_items c set record_status = 'invalid_preserved', invalidated_at = v_now
  where c.id = any (v_items);
  insert into private.catalog_exclusion_copies (exclusion_id, item_id, owner_id)
  select v_id, i, o from rows from (pg_catalog.unnest(v_items), pg_catalog.unnest(v_owners)) as x(i, o);

  -- 6. Each affected person once (D8): the submitter by their submission, every other
  --    owner by their copies. Nobody is told who acted.
  if req.id is not null and req.submitted_by is not null then
    perform private.notify(req.submitted_by, null, 'catalog_submission', null,
      pg_catalog.jsonb_build_object('status', 'excluded', 'submission_id', req.id, 'exclusion_id', v_id));
    v_notified := req.submitted_by;
  end if;
  for v_owner, v_count in
    select o, count(*)::integer from pg_catalog.unnest(v_owners) o where o is distinct from v_notified group by o order by o
  loop
    perform private.notify(v_owner, null, 'catalog_exclusion', null,
      pg_catalog.jsonb_build_object('status', 'excluded', 'exclusion_id', v_id, 'copies', v_count));
  end loop;

  perform private.record_catalog_audit(v_me, 'catalog_release_excluded', 'release', rel.id, v_reason,
    pg_catalog.jsonb_build_object('exclusion_id', v_id, 'reason_code', v_code, 'previous_status', rel.status,
      'cascade', pg_catalog.jsonb_array_length(v_plan -> 'cascade'), 'copies', pg_catalog.cardinality(v_items)));
  return pg_catalog.jsonb_build_object('exclusion_id', v_id, 'copies', pg_catalog.cardinality(v_items),
    'owners', (select count(distinct o) from pg_catalog.unnest(v_owners) o));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Restoring
-- ---------------------------------------------------------------------------

-- Why an exclusion can't be restored now, as the refusal restore_exclusion() gives, or
-- null: 'exclusion unavailable' (already restored), 'exclusion changed' (a record isn't
-- as the exclusion left it) or 'restore blocked' (the publication rules wouldn't hold).
-- Checked under the locks before a restoration, and shown to administrators.
create function private.restore_blocker(p_exclusion private.catalog_exclusions)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  rel public.releases;
  v_game public.catalog_status;
  v_pairing public.catalog_status;
begin
  if p_exclusion.restored_at is not null then
    return 'exclusion unavailable';
  end if;
  select * into rel from public.releases r where r.id = p_exclusion.release_id;
  -- Nothing changed since: each record is still as the exclusion left it.
  if rel.status <> 'excluded'
     or exists (select 1 from public.catalog_change_requests s where s.id = p_exclusion.request_id and s.status <> 'excluded')
     or exists (
       select 1 from pg_catalog.jsonb_array_elements(p_exclusion.cascade) e
       where (e ->> 'entity' = 'game' and not exists (
                select 1 from public.games g where g.id = (e ->> 'id')::uuid and g.status = 'excluded'))
          or (e ->> 'entity' = 'pairing' and not exists (
                select 1 from public.game_platforms gp
                where gp.game_id = (e ->> 'game_id')::uuid and gp.platform_id = (e ->> 'platform_id')::uuid and gp.status = 'excluded'))) then
    return 'exclusion changed';
  end if;
  -- The current publication rules, with the game and pairing as they are now or as
  -- this restores them: a published release needs both published, and a submission
  -- can't come back under a game that has since been excluded or merged.
  select coalesce((select (e ->> 'previous_status')::public.catalog_status from pg_catalog.jsonb_array_elements(p_exclusion.cascade) e
                   where e ->> 'entity' = 'game' and (e ->> 'id')::uuid = rel.game_id), g.status)
  into v_game from public.games g where g.id = rel.game_id;
  select coalesce((select (e ->> 'previous_status')::public.catalog_status from pg_catalog.jsonb_array_elements(p_exclusion.cascade) e
                   where e ->> 'entity' = 'pairing'), gp.status)
  into v_pairing from public.game_platforms gp where gp.game_id = rel.game_id and gp.platform_id = rel.platform_id;
  if (p_exclusion.previous_status = 'published' and (v_game is distinct from 'published' or v_pairing is distinct from 'published'))
     or v_game in ('excluded', 'merged') then
    return 'restore blocked';
  end if;
  return null;
end;
$$;

-- Restores an exclusion (D4, D5): an active administrator other than the one who
-- excluded it, who submitted none of it. Puts back exactly the previous statuses, and
-- reactivates only the copies this exclusion preserved that are still on the release
-- and still preserved since then. It never moves a copy, and never touches one an owner
-- relinked or deleted. Returns {copies}.
create function public.restore_exclusion(p_exclusion uuid, p_expected_version integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  ex private.catalog_exclusions;
  v_locked uuid[];
  rel public.releases;
  v_blocker text;
  v_items uuid[];
  v_owners uuid[];
  v_prev jsonb;
  v_owner uuid;
  v_count integer;
  v_submitter uuid;
begin
  perform private.lock_catalog_edits();
  v_me := private.require_active_staff('admin');
  perform 1 from public.profiles p where p.id = v_me for key share;
  v_reason := private.require_reason(p_reason);
  if p_expected_version is null then
    raise exception 'invalid restoration' using errcode = '22023';
  end if;
  select * into ex from private.catalog_exclusions e where e.id = p_exclusion;
  if not found then
    raise exception 'exclusion unavailable' using errcode = 'P0001';
  end if;

  -- 1. Profiles first.
  v_locked := private.exclusion_profiles(v_me, ex.release_id, ex.id);
  perform 1 from public.profiles p where p.id = any (v_locked) order by p.id for key share;

  -- 2. The exclusion record, then the catalog rows.
  select * into ex from private.catalog_exclusions e where e.id = p_exclusion for update;
  if ex.version <> p_expected_version then
    raise exception 'request conflict' using errcode = 'P0001';
  end if;
  if ex.excluded_by = v_me then
    raise exception 'own exclusion' using errcode = 'P0001';
  end if;
  if private.exclusion_involves(v_me, ex.release_id, ex.cascade) then
    raise exception 'own submission' using errcode = 'P0001';
  end if;
  rel := private.lock_exclusion_records(ex.release_id);
  v_blocker := private.restore_blocker(ex);
  if v_blocker is not null then
    raise exception '%', v_blocker using errcode = 'P0001';
  end if;

  -- 3. Anyone not locked before, without waiting.
  perform private.lock_new_profiles(v_locked, private.exclusion_profiles(v_me, ex.release_id, ex.id));

  -- 4. Only this exclusion's copies, still on the release and still preserved by it.
  select coalesce(pg_catalog.array_agg(x.id order by x.id), '{}'), coalesce(pg_catalog.array_agg(x.owner_id order by x.id), '{}')
  into v_items, v_owners
  from (
    select c.id, c.owner_id
    from public.collection_items c
    join private.catalog_exclusion_copies ec on ec.item_id = c.id and ec.exclusion_id = ex.id
    where c.release_id = ex.release_id and c.record_status = 'invalid_preserved' and c.invalidated_at = ex.excluded_at
    order by c.id
    for update of c
  ) x;

  -- 5. Records first, the request last: the M7b-1 guard refuses changes to a record
  --    whose submission is active.
  update public.releases r set status = ex.previous_status where r.id = ex.release_id;
  update public.games g set status = (e ->> 'previous_status')::public.catalog_status
  from pg_catalog.jsonb_array_elements(ex.cascade) e
  where e ->> 'entity' = 'game' and g.id = (e ->> 'id')::uuid;
  update public.game_platforms gp set status = (e ->> 'previous_status')::public.catalog_status
  from pg_catalog.jsonb_array_elements(ex.cascade) e
  where e ->> 'entity' = 'pairing' and gp.game_id = (e ->> 'game_id')::uuid and gp.platform_id = (e ->> 'platform_id')::uuid;
  if ex.request_id is not null then
    v_prev := ex.previous_request;
    update public.catalog_change_requests s set
      status = (v_prev ->> 'status')::public.catalog_review_status,
      -- A reviewer whose account is gone stays gone.
      reviewed_by = (select p.id from public.profiles p where p.id = (v_prev ->> 'reviewed_by')::uuid),
      reviewed_at = (v_prev ->> 'reviewed_at')::timestamptz,
      reviewer_note = v_prev ->> 'reviewer_note'
    where s.id = ex.request_id
    returning s.submitted_by into v_submitter;
  end if;
  update public.collection_items c set record_status = 'active', invalidated_at = null
  where c.id = any (v_items);
  update private.catalog_exclusions e set
    restored_at = pg_catalog.now(), restored_by = v_me, restore_reason = v_reason,
    copies_restored = pg_catalog.cardinality(v_items), version = e.version + 1
  where e.id = ex.id;

  -- 6. Each person whose copies came back, once, and the submitter.
  for v_owner, v_count in
    select x.o, count(x.i)::integer
    from (select o, i from rows from (pg_catalog.unnest(v_owners), pg_catalog.unnest(v_items)) as y(o, i)
          union all select v_submitter, null where v_submitter is not null) x
    group by x.o order by x.o
  loop
    perform private.notify(v_owner, null, 'catalog_exclusion', null,
      pg_catalog.jsonb_build_object('status', 'restored', 'exclusion_id', ex.id, 'copies', v_count));
  end loop;

  perform private.record_catalog_audit(v_me, 'catalog_exclusion_restored', 'release', ex.release_id, v_reason,
    pg_catalog.jsonb_build_object('exclusion_id', ex.id, 'restored_status', ex.previous_status, 'copies', pg_catalog.cardinality(v_items)));
  return pg_catalog.jsonb_build_object('copies', pg_catalog.cardinality(v_items));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Reading exclusions, for administrators
-- ---------------------------------------------------------------------------

-- Exclusions, newest first: 'active' (not restored) or 'restored'. {items, next}.
create function public.get_exclusions(p_status text default 'active', p_after uuid default null, p_limit integer default 50)
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
  perform private.require_active_staff('admin');
  if p_status is null or p_status not in ('active', 'restored') then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.jsonb_agg(x.item order by x.id desc), '[]') into v_items
  from (
    select e.id, pg_catalog.jsonb_build_object(
      'id', e.id, 'excluded_at', e.excluded_at, 'reason_code', e.reason_code, 'previous_status', e.previous_status,
      'copies_preserved', e.copies_preserved, 'owners_affected', e.owners_affected,
      'restored_at', e.restored_at, 'copies_restored', e.copies_restored,
      'release', private.release_label(e.release_id)) as item
    from private.catalog_exclusions e
    where (e.restored_at is null) = (p_status = 'active') and (p_after is null or e.id < p_after)
    order by e.id desc
    limit v_limit + 1
  ) x;
  return pg_catalog.jsonb_build_object(
    'items', coalesce((select pg_catalog.jsonb_agg(i) from (select i from pg_catalog.jsonb_array_elements(v_items) with ordinality t(i, n) where n <= v_limit order by n) y), '[]'),
    'next', case when pg_catalog.jsonb_array_length(v_items) > v_limit then v_items -> (v_limit - 1) ->> 'id' end);
end;
$$;

-- One exclusion, with what restoring it would do now.
create function public.get_exclusion(p_exclusion uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  ex private.catalog_exclusions;
  v_blocker text;
begin
  v_me := private.require_active_staff('admin');
  select * into ex from private.catalog_exclusions e where e.id = p_exclusion;
  if not found then
    return null;
  end if;
  v_blocker := private.restore_blocker(ex);
  return pg_catalog.jsonb_build_object(
    'id', ex.id, 'version', ex.version,
    'excluded_at', ex.excluded_at, 'reason_code', ex.reason_code, 'staff_reason', ex.staff_reason, 'owner_note', ex.owner_note,
    'previous_status', ex.previous_status, 'request_id', ex.request_id,
    'release', private.release_label(ex.release_id),
    'cascade', private.describe_plan(pg_catalog.jsonb_build_object('release_id', ex.release_id, 'cascade', ex.cascade, 'blocking', '[]'::jsonb)) -> 'cascade',
    'copies_preserved', ex.copies_preserved, 'owners_affected', ex.owners_affected,
    'copies', pg_catalog.jsonb_build_object(
      'still_preserved', (select count(*) from private.catalog_exclusion_copies ec join public.collection_items c on c.id = ec.item_id
                          where ec.exclusion_id = ex.id and c.release_id = ex.release_id and c.record_status = 'invalid_preserved' and c.invalidated_at = ex.excluded_at),
      'moved', (select count(*) from private.catalog_exclusion_copies ec join public.collection_items c on c.id = ec.item_id
                where ec.exclusion_id = ex.id and c.release_id <> ex.release_id),
      'removed', ex.copies_preserved - (select count(*) from private.catalog_exclusion_copies ec where ec.exclusion_id = ex.id)),
    'restored_at', ex.restored_at, 'restore_reason', ex.restore_reason, 'copies_restored', ex.copies_restored,
    'own_exclusion', ex.excluded_by = v_me,
    'own_submission', private.exclusion_involves(v_me, ex.release_id, ex.cascade),
    'blocker', v_blocker);
end;
$$;

revoke all on function private.restore_blocker(private.catalog_exclusions) from public, anon, authenticated, service_role;
revoke all on function public.get_exclusion_preview(uuid) from public, anon, authenticated, service_role;
revoke all on function public.exclude_release(uuid, text, text, text, text, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.restore_exclusion(uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.get_exclusions(text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_exclusion(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_exclusion_preview(uuid) to authenticated;
grant execute on function public.exclude_release(uuid, text, text, text, text, boolean, boolean) to authenticated;
grant execute on function public.restore_exclusion(uuid, integer, text) to authenticated;
grant execute on function public.get_exclusions(text, uuid, integer) to authenticated;
grant execute on function public.get_exclusion(uuid) to authenticated;
