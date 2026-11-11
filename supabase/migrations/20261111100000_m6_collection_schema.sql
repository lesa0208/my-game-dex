-- M6b Collection: physical copies, their owner-only details, and the edition pieces
-- each copy has.
--
-- Design: docs/architecture/database-schema.md#collection-system
-- Approved for M6 (ADR-049):
-- - One row per physical copy. A copy is the game medium itself (ADR-030), so it
--   never has a "missing medium" value. Completeness may be left unrecorded (null):
--   nothing is guessed.
-- - Owner-only in M6. There's no read path for anyone else, staff included, and no
--   client can change visibility, which stays 'private'.
-- - The client chooses each new copy's UUIDv7, which makes adding idempotent.
-- - A copy attaches only to a release the owner may use: published, or their own
--   submission (M7). Foreign keys ignore RLS, so the policies check it.
-- - At most 100,000 copies per owner.
-- - record_status and invalidated_at are set only by M7's exclusion. Until a copy is
--   moved to a usable release, it can't be edited.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.collection_items (
  -- No default: the client supplies it, and a trigger checks it's a recent UUIDv7.
  id uuid primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  release_id uuid not null references public.releases (id) on delete restrict,
  -- Null means not recorded.
  completeness public.completeness,
  -- Null means not assessed. 'not_included' means this copy doesn't have it.
  overall_condition public.condition_grade,
  box_condition public.condition_grade,
  media_condition public.condition_grade,
  manual_condition public.condition_grade,
  visibility public.visibility_level not null default 'private',
  record_status public.collection_record_status not null default 'active',
  invalidated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The target for composite foreign keys, so child rows always share the owner.
  unique (id, owner_id),
  -- A copy is the game itself, so its medium is always there.
  constraint collection_items_media_present check (media_condition is distinct from 'not_included'),
  constraint collection_items_overall_assessed check (overall_condition is distinct from 'not_included'),
  -- Loose is the medium alone.
  constraint collection_items_loose check (
    completeness is distinct from 'loose'
    or (coalesce(box_condition, 'not_included') = 'not_included' and coalesce(manual_condition, 'not_included') = 'not_included')
  ),
  -- Complete in box has its box.
  constraint collection_items_complete check (completeness is distinct from 'complete' or box_condition is distinct from 'not_included'),
  -- A sealed copy can't be assessed inside without opening it.
  constraint collection_items_sealed check (completeness is distinct from 'sealed' or (media_condition is null and manual_condition is null)),
  constraint collection_items_invalidation check ((record_status = 'invalid_preserved') = (invalidated_at is not null))
);

-- Browsing, newest first.
create index collection_items_owner_added_idx on public.collection_items (owner_id, created_at desc, id desc);
-- "How many copies of this release do I have?", and statistics.
create index collection_items_owner_release_idx on public.collection_items (owner_id, release_id);
-- Merging and excluding a release (M7) find its copies.
create index collection_items_release_idx on public.collection_items (release_id);

-- Owner-only, whatever the copy's visibility. A row exists only with at least one value.
create table public.collection_item_private (
  item_id uuid primary key,
  owner_id uuid not null,
  acquired_on date,
  -- 0 to 4 decimal places covers every ISO 4217 currency.
  purchase_price numeric(14, 4),
  currency text,
  notes text,
  storage_location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (item_id, owner_id) references public.collection_items (id, owner_id) on delete cascade,
  constraint collection_item_private_price_currency check ((purchase_price is null) = (currency is null)),
  constraint collection_item_private_price check (purchase_price >= 0),
  constraint collection_item_private_currency check (currency ~ '^[A-Z]{3}$'),
  -- Before home video games existed is a typing mistake. Future dates are refused by a trigger.
  constraint collection_item_private_acquired check (acquired_on >= date '1970-01-01'),
  constraint collection_item_private_notes check (char_length(notes) between 1 and 5000),
  constraint collection_item_private_location check (char_length(storage_location) between 1 and 120 and storage_location = btrim(storage_location)),
  constraint collection_item_private_not_empty check (num_nonnulls(acquired_on, purchase_price, notes, storage_location) > 0)
);

create index collection_item_private_owner_acquired_idx on public.collection_item_private (owner_id, acquired_on desc);

-- Which of its release's listed pieces this copy has: inserts, maps, artwork, and
-- additional game media such as "Disc 2". Identified by the release component's kind
-- and label, not its id: editors replace a release's component rows when they edit
-- them (set_release_components), so ids aren't stable. A trigger checks the piece is
-- listed for the copy's release when it's recorded. Can't exist without its copy.
create table public.collection_item_components (
  item_id uuid not null,
  owner_id uuid not null,
  kind public.component_kind not null,
  label text not null check (char_length(label) between 1 and 120 and label = btrim(label)),
  -- Null: present, not assessed. 'not_included': this copy is missing it.
  condition public.condition_grade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (item_id, kind, label),
  foreign key (item_id, owner_id) references public.collection_items (id, owner_id) on delete cascade
);

create index collection_item_components_owner_idx on public.collection_item_components (owner_id, item_id);

-- ---------------------------------------------------------------------------
-- 2. Triggers
-- ---------------------------------------------------------------------------
-- None is SECURITY DEFINER. They run with the caller's rights, so they see only what
-- the caller may see: their own copies, and the releases they may read.

-- New copies: the id must be a UUIDv7 made within the last 24 hours, or up to 5
-- minutes ahead for clock skew. That keeps ids in time order for the index, and stops
-- a client from choosing arbitrary ids. Then the owner's limit of 100,000 copies,
-- under a per-owner lock so two concurrent additions can't both pass it. The limit is
-- written here rather than in a helper: this runs as the caller, who can't reach the
-- private schema.
create function private.check_new_collection_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c_limit constant integer := 100000;
  v_text text := new.id::text;
  v_ms bigint;
  v_now_ms bigint := (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
begin
  if substr(v_text, 15, 1) <> '7' or substr(v_text, 20, 1) not in ('8', '9', 'a', 'b') then
    raise exception 'invalid item id' using errcode = '22023';
  end if;
  v_ms := ('x' || substr(v_text, 1, 8) || substr(v_text, 10, 4))::bit(48)::bigint;
  if v_ms < v_now_ms - 86400000 or v_ms > v_now_ms + 300000 then
    raise exception 'invalid item id' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('collection_items:' || new.owner_id::text, 0));
  if (select count(*) from public.collection_items c where c.owner_id = new.owner_id) >= c_limit then
    raise exception 'collection limit reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- A preserved copy (M7: its release was excluded) can't be edited until it's moved to
-- a usable release, and moving it clears the flag. Moving a copy drops the pieces its
-- new release doesn't list.
create function private.guard_collection_item_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.release_id is distinct from old.release_id then
    if old.record_status = 'invalid_preserved' and new.record_status = 'invalid_preserved' then
      new.record_status := 'active';
      new.invalidated_at := null;
    end if;
  elsif old.record_status = 'invalid_preserved' and new.record_status = 'invalid_preserved' then
    raise exception 'item preserved' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create function private.drop_unlisted_components()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.collection_item_components c
  where c.item_id = new.id
    and not exists (
      select 1 from public.release_components rc
      where rc.release_id = new.release_id and rc.kind = c.kind and rc.label = c.label
    );
  return null;
end;
$$;

-- A piece must be listed for the copy's release, and a preserved copy's pieces can't
-- change. Read as the caller: their own copy, and a release they may read.
create function private.check_collection_item_component()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_release uuid;
  v_status public.collection_record_status;
begin
  select c.release_id, c.record_status into v_release, v_status
  from public.collection_items c where c.id = new.item_id and c.owner_id = new.owner_id;
  if not found then
    raise exception 'item unavailable' using errcode = 'P0001';
  end if;
  if v_status = 'invalid_preserved' then
    raise exception 'item preserved' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' and not exists (
    select 1 from public.release_components rc
    where rc.release_id = v_release and rc.kind = new.kind and rc.label = new.label
  ) then
    raise exception 'component unavailable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Owner-only details can't change on a preserved copy either, and an acquisition date
-- can't be in the future (a day of leeway for time zones).
create function private.check_collection_item_private()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.collection_items c where c.id = new.item_id and c.record_status = 'invalid_preserved') then
    raise exception 'item preserved' using errcode = 'P0001';
  end if;
  if new.acquired_on > (pg_catalog.now() at time zone 'UTC')::date + 1 then
    raise exception 'invalid details' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger check_new_collection_item before insert on public.collection_items
  for each row execute function private.check_new_collection_item();
create trigger guard_collection_item_update before update on public.collection_items
  for each row execute function private.guard_collection_item_update();
create trigger drop_unlisted_components after update of release_id on public.collection_items
  for each row when (new.release_id is distinct from old.release_id)
  execute function private.drop_unlisted_components();
create trigger set_updated_at before update on public.collection_items
  for each row execute function private.set_updated_at();

create trigger check_collection_item_private before insert or update on public.collection_item_private
  for each row execute function private.check_collection_item_private();
create trigger set_updated_at before update on public.collection_item_private
  for each row execute function private.set_updated_at();

create trigger check_collection_item_component before insert or update on public.collection_item_components
  for each row execute function private.check_collection_item_component();
create trigger set_updated_at before update on public.collection_item_components
  for each row execute function private.set_updated_at();

revoke all on function private.check_new_collection_item() from public, anon, authenticated, service_role;
revoke all on function private.guard_collection_item_update() from public, anon, authenticated, service_role;
revoke all on function private.drop_unlisted_components() from public, anon, authenticated, service_role;
revoke all on function private.check_collection_item_component() from public, anon, authenticated, service_role;
revoke all on function private.check_collection_item_private() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Access: owner only
-- ---------------------------------------------------------------------------
-- No grant to anon or service_role on any of these tables. Adding and editing need an
-- active account; reading and deleting your own copies don't, so a suspended owner can
-- still see and remove them. Column grants leave out id changes, owner changes,
-- release changes, visibility, record_status and timestamps.

alter table public.collection_items enable row level security;
alter table public.collection_item_private enable row level security;
alter table public.collection_item_components enable row level security;

create policy collection_items_read_own on public.collection_items
  for select to authenticated
  using (owner_id = (select auth.uid()));
create policy collection_items_insert_own on public.collection_items
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select private.is_active_user()) and private.can_use_release(release_id));
create policy collection_items_update_own on public.collection_items
  for update to authenticated
  using (owner_id = (select auth.uid()) and (select private.is_active_user()))
  with check (owner_id = (select auth.uid()) and private.can_use_release(release_id));
create policy collection_items_delete_own on public.collection_items
  for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy collection_item_private_read_own on public.collection_item_private
  for select to authenticated
  using (owner_id = (select auth.uid()));
create policy collection_item_private_insert_own on public.collection_item_private
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select private.is_active_user()));
create policy collection_item_private_update_own on public.collection_item_private
  for update to authenticated
  using (owner_id = (select auth.uid()) and (select private.is_active_user()))
  with check (owner_id = (select auth.uid()));
create policy collection_item_private_delete_own on public.collection_item_private
  for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy collection_item_components_read_own on public.collection_item_components
  for select to authenticated
  using (owner_id = (select auth.uid()));
create policy collection_item_components_insert_own on public.collection_item_components
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select private.is_active_user()));
create policy collection_item_components_update_own on public.collection_item_components
  for update to authenticated
  using (owner_id = (select auth.uid()) and (select private.is_active_user()))
  with check (owner_id = (select auth.uid()));
create policy collection_item_components_delete_own on public.collection_item_components
  for delete to authenticated
  using (owner_id = (select auth.uid()));

grant select on public.collection_items to authenticated;
grant insert (id, owner_id, release_id, completeness, overall_condition, box_condition, media_condition, manual_condition)
  on public.collection_items to authenticated;
grant update (completeness, overall_condition, box_condition, media_condition, manual_condition)
  on public.collection_items to authenticated;
grant delete on public.collection_items to authenticated;

grant select on public.collection_item_private to authenticated;
grant insert (item_id, owner_id, acquired_on, purchase_price, currency, notes, storage_location)
  on public.collection_item_private to authenticated;
grant update (acquired_on, purchase_price, currency, notes, storage_location)
  on public.collection_item_private to authenticated;
grant delete on public.collection_item_private to authenticated;

grant select on public.collection_item_components to authenticated;
grant insert (item_id, owner_id, kind, label, condition) on public.collection_item_components to authenticated;
grant update (condition) on public.collection_item_components to authenticated;
grant delete on public.collection_item_components to authenticated;
