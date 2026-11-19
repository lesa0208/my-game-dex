-- M12a Flexible physical ownership: a copy is either identified (it names a physical
-- release) or unidentified (a private claim on a game and platform, with region and
-- edition each optional).
--
-- Design: docs/architecture/database-schema.md#collection-system (M12a)
-- - Identified copies keep reading game, platform, region and edition from their
--   release. Nothing about the release is copied onto them, so merges, exclusions and
--   catalog corrections have nothing to keep in step.
-- - An unidentified copy names a published game and any platform. It creates no
--   release, pairing or edition: its region and edition are the owner's private claim.
--   The four combinations (region known or not, edition known or not) are all allowed.
-- - A copy's identity (its release, or its claim) changes only through
--   set_my_copy_identity() (and relink_my_copy, now a wrapper of it), merges and
--   maintenance. Clients have no UPDATE grant on any identity column. Every change is
--   recorded in an owner-only history.
-- - A claim needs its game published when it's made or changed. The game row is
--   locked FOR SHARE, which conflicts with the FOR UPDATE an exclusion takes before it
--   excludes a game, so a claim can't be made against a game while it's excluded.
-- - An exclusion that excludes a game preserves the active claims on it, recorded per
--   exclusion; restoring brings back only those still preserved by it.
-- - Confirmed catalog counts ("owned") are unchanged: unidentified copies are counted
--   on their own.

-- ---------------------------------------------------------------------------
-- 1. Copies: the claim columns and the two states
-- ---------------------------------------------------------------------------

alter table public.collection_items
  alter column release_id drop not null,
  add column claimed_game_id uuid references public.games (id) on delete restrict,
  add column claimed_platform_id uuid references public.platforms (id) on delete restrict,
  -- Null: the owner isn't sure. The catalog's own 'unknown' code isn't a claim.
  add column claimed_region_code text references public.region_codes (code) on delete restrict,
  -- Null: the owner isn't sure. Kind and name are independent.
  add column claimed_edition_kind public.edition_kind,
  add column claimed_edition_name text;

alter table public.collection_items
  add constraint collection_items_identity check (
    (release_id is not null and claimed_game_id is null and claimed_platform_id is null and claimed_region_code is null
     and claimed_edition_kind is null and claimed_edition_name is null)
    or (release_id is null and claimed_game_id is not null and claimed_platform_id is not null)),
  add constraint collection_items_claimed_region check (claimed_region_code is distinct from 'unknown'),
  -- Stored as written, only tidied: NFC, single ASCII spaces, no surrounding space, no
  -- control characters. Functions tidy what they're given; the check refuses the rest.
  add constraint collection_items_claimed_edition_name check (
    claimed_edition_name is null or (
      pg_catalog.char_length(claimed_edition_name) between 1 and 80
      and claimed_edition_name = pg_catalog.btrim(claimed_edition_name)
      and pg_catalog.strpos(claimed_edition_name, '  ') = 0
      and claimed_edition_name !~ '[[:cntrl:]   -     　﻿]'
      and claimed_edition_name is nfc normalized));

-- The owner's claims on a game ("Owned: Yes"), and an exclusion finding a game's claims.
create index collection_items_owner_claim_idx on public.collection_items (owner_id, claimed_game_id) where release_id is null;
create index collection_items_claimed_game_idx on public.collection_items (claimed_game_id) where release_id is null;
create index collection_items_claimed_platform_idx on public.collection_items (claimed_platform_id) where release_id is null;

-- ---------------------------------------------------------------------------
-- 2. The owner's private history of identity changes
-- ---------------------------------------------------------------------------
-- One row per change of a copy's release or claim, written by a trigger whatever made
-- the change: the owner ('owner'), a catalog merge ('catalog'), or maintenance. Who on
-- the staff acted is never recorded here. Read by the owner through
-- get_my_copy_history(); goes with the copy.

create table private.collection_item_identity_events (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null,
  owner_id uuid not null,
  -- The time of the change itself, so changes in one transaction keep their order.
  changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  source text not null check (source in ('owner', 'catalog', 'maintenance')),
  previous jsonb not null,
  current jsonb not null,
  foreign key (item_id, owner_id) references public.collection_items (id, owner_id) on delete cascade
);

create index collection_item_identity_events_item_idx on private.collection_item_identity_events (item_id, changed_at desc, id desc);
alter table private.collection_item_identity_events enable row level security;
revoke all on private.collection_item_identity_events from public, anon, authenticated, service_role;

-- A claim preserved by an exclusion names the game it was preserved for. Null for a
-- copy preserved on the excluded release itself.
alter table private.catalog_exclusion_copies add column claimed_game_id uuid references public.games (id) on delete restrict;
create index catalog_exclusion_copies_claimed_game_idx on private.catalog_exclusion_copies (claimed_game_id) where claimed_game_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------

-- A copy's identity as a record: its release, or its claim.
create function private.copy_identity(p_item public.collection_items)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_item.release_id is not null
    then pg_catalog.jsonb_build_object('release_id', p_item.release_id)
    else pg_catalog.jsonb_build_object('game_id', p_item.claimed_game_id, 'platform_id', p_item.claimed_platform_id,
      'region_code', p_item.claimed_region_code, 'edition_kind', p_item.claimed_edition_kind, 'edition_name', p_item.claimed_edition_name)
  end
$$;

-- An edition name as the owner typed it, tidied: NFC, any run of spaces (Unicode ones
-- included) made one ASCII space, trimmed. Nothing else changes. Null or empty: null.
create function private.tidy_edition_name(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.normalize(p, 'NFC'),
    '[[:space:]   -     　﻿]+', ' ', 'g')), '')
$$;

-- Whether the caller may claim a copy of this game on this platform: the game is
-- published and the platform exists. Never reads pairings or releases, so it reveals
-- nothing about anyone's submissions. Used by the copy policies.
create function private.can_claim(p_game uuid, p_platform uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.games g where g.id = p_game and g.status = 'published')
     and exists (select 1 from public.platforms pl where pl.id = p_platform)
$$;

-- Locks the claimed game FOR SHARE and checks it's published. FOR SHARE conflicts
-- with the FOR UPDATE that exclusions (lock_exclusion_records) take on a game before
-- excluding it, so a claim and an exclusion of its game are serialized: whichever is
-- second sees the other's result. (FOR KEY SHARE wouldn't: a status change doesn't
-- change the key.)
create function private.lock_claimable_game(p_game uuid, p_platform uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.catalog_status;
begin
  select g.status into v_status from public.games g where g.id = p_game for share;
  if not found or v_status <> 'published' then
    raise exception 'game unavailable' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.platforms pl where pl.id = p_platform) then
    raise exception 'platform unavailable' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function private.copy_identity(public.collection_items) from public, anon, authenticated, service_role;
revoke all on function private.tidy_edition_name(text) from public, anon, authenticated, service_role;
revoke all on function private.can_claim(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_claimable_game(uuid, uuid) from public, anon, authenticated, service_role;
-- The policies call it with the caller's rights, as they do can_use_release.
grant execute on function private.can_claim(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Triggers
-- ---------------------------------------------------------------------------

-- A new copy: the owner's profile, then its release, or for a claim its game.
create or replace function private.check_new_copy_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.profiles p where p.id = new.owner_id for key share;
  if new.release_id is not null then
    perform private.lock_usable_release(new.release_id, new.owner_id);
  else
    perform private.lock_claimable_game(new.claimed_game_id, new.claimed_platform_id);
  end if;
  return new;
end;
$$;

-- A copy whose identity changes: the new release, or the new claim's game. Covers every
-- identity column, so a claim can't change while its release stays null without the
-- same check.
create or replace function private.check_moved_copy_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.release_id is not null then
    perform private.lock_usable_release(new.release_id, new.owner_id);
  else
    perform private.lock_claimable_game(new.claimed_game_id, new.claimed_platform_id);
  end if;
  return new;
end;
$$;

drop trigger check_copy_release_move on public.collection_items;
create trigger check_copy_release_move
  before update of release_id, claimed_game_id, claimed_platform_id, claimed_region_code, claimed_edition_kind, claimed_edition_name
  on public.collection_items
  for each row when (
    (new.release_id, new.claimed_game_id, new.claimed_platform_id, new.claimed_region_code, new.claimed_edition_kind, new.claimed_edition_name)
    is distinct from
    (old.release_id, old.claimed_game_id, old.claimed_platform_id, old.claimed_region_code, old.claimed_edition_kind, old.claimed_edition_name))
  execute function private.check_moved_copy_release();

-- A preserved copy changes only by getting a new identity, which makes it active again;
-- anything else on it is refused. Now any identity column, not only the release.
create or replace function private.guard_collection_item_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.release_id, new.claimed_game_id, new.claimed_platform_id, new.claimed_region_code, new.claimed_edition_kind, new.claimed_edition_name)
     is distinct from
     (old.release_id, old.claimed_game_id, old.claimed_platform_id, old.claimed_region_code, old.claimed_edition_kind, old.claimed_edition_name) then
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

-- The history row. set_my_copy_identity marks its own changes for the transaction;
-- any other change by an API session is a catalog merge; anything else is maintenance.
create function private.record_copy_identity_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.collection_item_identity_events (item_id, owner_id, source, previous, current)
  values (new.id, new.owner_id,
    case
      when pg_catalog.current_setting('mgd.copy_identity_change', true) = new.id::text then 'owner'
      when coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then 'catalog'
      else 'maintenance'
    end,
    private.copy_identity(old), private.copy_identity(new));
  return null;
end;
$$;

create trigger record_copy_identity_change
  after update of release_id, claimed_game_id, claimed_platform_id, claimed_region_code, claimed_edition_kind, claimed_edition_name
  on public.collection_items
  for each row when (
    (new.release_id, new.claimed_game_id, new.claimed_platform_id, new.claimed_region_code, new.claimed_edition_kind, new.claimed_edition_name)
    is distinct from
    (old.release_id, old.claimed_game_id, old.claimed_platform_id, old.claimed_region_code, old.claimed_edition_kind, old.claimed_edition_name))
  execute function private.record_copy_identity_change();

revoke all on function private.record_copy_identity_change() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Policies and grants
-- ---------------------------------------------------------------------------
-- A copy either names a release the owner may use (unchanged), or claims a published
-- game on an existing platform.

drop policy collection_items_insert_own on public.collection_items;
create policy collection_items_insert_own on public.collection_items
  for insert to authenticated
  with check (
    owner_id = (select auth.uid()) and (select private.is_active_user())
    and ((release_id is not null and private.can_use_release(release_id))
         or (release_id is null and private.can_claim(claimed_game_id, claimed_platform_id))));
drop policy collection_items_update_own on public.collection_items;
create policy collection_items_update_own on public.collection_items
  for update to authenticated
  using (owner_id = (select auth.uid()) and (select private.is_active_user()))
  with check (
    owner_id = (select auth.uid())
    and ((release_id is not null and private.can_use_release(release_id))
         or (release_id is null and private.can_claim(claimed_game_id, claimed_platform_id))));

-- Adding a claim is an insert like adding a release. Changing an identity column is
-- never granted: only the functions above may.
grant insert (claimed_game_id, claimed_platform_id, claimed_region_code, claimed_edition_kind, claimed_edition_name)
  on public.collection_items to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Adding an unidentified copy
-- ---------------------------------------------------------------------------
-- Like add_collection_item: runs with the caller's rights, the client chooses the
-- copy's id, and a repeat of the same request returns the same copy. Region and edition
-- are each optional; the edition name is tidied as stored. Optional details as in
-- add_collection_item.
--
-- Errors: 42501 'not permitted', 22023 'invalid item id' / 'invalid region' /
-- 'invalid edition', P0001 'account not active', 'game unavailable' (not a published
-- game, or no such platform), 'request conflict' (the id is already used otherwise).
create function public.add_unidentified_copy(
  p_item_id uuid,
  p_game uuid,
  p_platform uuid,
  p_region text default null,
  p_edition_kind text default null,
  p_edition_name text default null,
  p_details jsonb default '{}'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_kind public.edition_kind;
  v_name text;
  v_region text := nullif(pg_catalog.btrim(p_region), '');
  v_rows integer;
  v_want jsonb;
  v_existing public.collection_items;
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_item_id is null then
    raise exception 'invalid item id' using errcode = '22023';
  end if;
  if p_game is null or p_platform is null then
    raise exception 'game unavailable' using errcode = 'P0001';
  end if;
  if v_region is not null and (v_region = 'unknown' or not exists (select 1 from public.region_codes r where r.code = v_region)) then
    raise exception 'invalid region' using errcode = '22023';
  end if;
  begin
    v_kind := nullif(pg_catalog.btrim(p_edition_kind), '')::public.edition_kind;
  exception when others then
    raise exception 'invalid edition' using errcode = '22023';
  end;
  -- Tidied as private.tidy_edition_name does: this runs as the caller, who can't reach
  -- the private schema.
  v_name := nullif(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.normalize(p_edition_name, 'NFC'),
    '[[:space:]   -     　﻿]+', ' ', 'g')), '');
  if pg_catalog.char_length(v_name) > 80 or v_name ~ '[[:cntrl:]]' then
    raise exception 'invalid edition' using errcode = '22023';
  end if;
  v_want := pg_catalog.jsonb_build_array(p_game, p_platform, v_region, v_kind, v_name);

  -- A repeat of a request that already succeeded.
  select * into v_existing from public.collection_items c where c.id = p_item_id and c.owner_id = v_me;
  if found then
    if v_existing.release_id is null and pg_catalog.jsonb_build_array(v_existing.claimed_game_id, v_existing.claimed_platform_id,
         v_existing.claimed_region_code, v_existing.claimed_edition_kind, v_existing.claimed_edition_name) = v_want then
      return pg_catalog.jsonb_build_object('item_id', p_item_id, 'created', false);
    end if;
    raise exception 'request conflict' using errcode = 'P0001';
  end if;

  if not coalesce((select a.is_active from public.get_my_account() a), false) then
    raise exception 'account not active' using errcode = 'P0001';
  end if;

  begin
    insert into public.collection_items (id, owner_id, claimed_game_id, claimed_platform_id, claimed_region_code, claimed_edition_kind, claimed_edition_name)
    values (p_item_id, v_me, p_game, p_platform, v_region, v_kind, v_name)
    on conflict (id) do nothing;
    get diagnostics v_rows = row_count;
  exception
    -- The insert policy refuses a game that isn't published; a missing one fails its foreign key.
    when insufficient_privilege or foreign_key_violation then
      raise exception 'game unavailable' using errcode = 'P0001';
  end;

  if v_rows = 0 then
    select * into v_existing from public.collection_items c where c.id = p_item_id and c.owner_id = v_me;
    if found and v_existing.release_id is null and pg_catalog.jsonb_build_array(v_existing.claimed_game_id, v_existing.claimed_platform_id,
         v_existing.claimed_region_code, v_existing.claimed_edition_kind, v_existing.claimed_edition_name) = v_want then
      return pg_catalog.jsonb_build_object('item_id', p_item_id, 'created', false);
    end if;
    raise exception 'request conflict' using errcode = 'P0001';
  end if;

  if p_details is not null and p_details <> '{}'::jsonb then
    perform public.update_collection_item(p_item_id, p_details);
  end if;
  return pg_catalog.jsonb_build_object('item_id', p_item_id, 'created', true);
end;
$$;

revoke all on function public.add_unidentified_copy(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.add_unidentified_copy(uuid, uuid, uuid, text, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Changing a copy's identity
-- ---------------------------------------------------------------------------
-- The owner identifies a copy (claim to release), relinks it (release to release),
-- leaves it unidentified (release to claim), or corrects a claim (claim to claim). The
-- platform never changes: a copy on another platform is another copy. A preserved copy
-- becomes active again by getting a new identity (the existing rule), and nothing
-- about it is lost: its private details, pieces and when it was added stay, and the
-- history records what it was. A release the caller can't use reads the same as one
-- that doesn't exist, and its platform is never compared.
--
-- p_identity: {"release_id": uuid} or {"game_id": uuid, "platform_id": uuid,
-- "region_code"?: text, "edition_kind"?: text, "edition_name"?: text}.
-- Returns {changed, identity: 'release' | 'claim', release_id, record_status}.
--
-- Errors: 42501 'not permitted', 22023 'invalid identity' / 'invalid region' /
-- 'invalid edition', P0001 'account not active', 'item unavailable', 'release
-- unavailable', 'game unavailable', 'other platform', 'request conflict'.
--
-- Lock order: the profile, the target claim's game (FOR SHARE), the releases involved
-- (FOR SHARE, by id), then the copy: games before releases before copies, as
-- exclusions and merges take them.
create function public.set_my_copy_identity(p_item uuid, p_identity jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_seen public.collection_items;
  v_item public.collection_items;
  v_target_release public.releases;
  v_source_platform uuid;
  v_release uuid;
  v_game uuid;
  v_platform uuid;
  v_region text;
  v_kind public.edition_kind;
  v_name text;
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not private.is_active_user() then
    raise exception 'account not active' using errcode = 'P0001';
  end if;
  if p_identity is null or pg_catalog.jsonb_typeof(p_identity) <> 'object' then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  -- The identity asked for, checked for shape before anything is locked.
  begin
    if p_identity ? 'release_id' then
      if exists (select 1 from pg_catalog.jsonb_object_keys(p_identity) k where k <> 'release_id') then
        raise exception using errcode = '22023';
      end if;
      v_release := (p_identity ->> 'release_id')::uuid;
      if v_release is null then
        raise exception using errcode = '22023';
      end if;
    else
      if exists (select 1 from pg_catalog.jsonb_object_keys(p_identity) k
                 where k <> all (array['game_id', 'platform_id', 'region_code', 'edition_kind', 'edition_name'])) then
        raise exception using errcode = '22023';
      end if;
      v_game := (p_identity ->> 'game_id')::uuid;
      v_platform := (p_identity ->> 'platform_id')::uuid;
      if v_game is null or v_platform is null
         or pg_catalog.jsonb_typeof(p_identity -> 'region_code') not in ('string', 'null')
         or pg_catalog.jsonb_typeof(p_identity -> 'edition_kind') not in ('string', 'null')
         or pg_catalog.jsonb_typeof(p_identity -> 'edition_name') not in ('string', 'null') then
        raise exception using errcode = '22023';
      end if;
    end if;
  exception when others then
    raise exception 'invalid identity' using errcode = '22023';
  end;
  if v_release is null then
    v_region := nullif(pg_catalog.btrim(p_identity ->> 'region_code'), '');
    if v_region is not null and (v_region = 'unknown' or not exists (select 1 from public.region_codes r where r.code = v_region)) then
      raise exception 'invalid region' using errcode = '22023';
    end if;
    begin
      v_kind := nullif(pg_catalog.btrim(p_identity ->> 'edition_kind'), '')::public.edition_kind;
    exception when others then
      raise exception 'invalid edition' using errcode = '22023';
    end;
    v_name := private.tidy_edition_name(p_identity ->> 'edition_name');
    if pg_catalog.char_length(v_name) > 80 or v_name ~ '[[:cntrl:]]' then
      raise exception 'invalid edition' using errcode = '22023';
    end if;
  end if;

  perform 1 from public.profiles p where p.id = v_me for key share;
  select * into v_seen from public.collection_items c where c.id = p_item and c.owner_id = v_me;
  if not found then
    raise exception 'item unavailable' using errcode = 'P0001';
  end if;

  -- Games, then releases, then the copy.
  if v_release is null then
    perform 1 from public.games g where g.id = v_game for share;
  end if;
  perform 1 from public.releases r where r.id in (v_seen.release_id, v_release) order by r.id for share;
  select * into v_item from public.collection_items c where c.id = p_item and c.owner_id = v_me for update;
  if not found then
    raise exception 'item unavailable' using errcode = 'P0001';
  end if;
  if private.copy_identity(v_item) is distinct from private.copy_identity(v_seen) then
    raise exception 'request conflict' using errcode = 'P0001';
  end if;

  -- The target first (as relink_my_copy always did), then its platform.
  if v_release is not null then
    select * into v_target_release from public.releases r where r.id = v_release;
    if not found or not (v_target_release.status = 'published'
                         or (v_target_release.submitted_by is not null and v_target_release.submitted_by = v_me
                             and v_target_release.status in ('unverified', 'under_review', 'rejected'))) then
      raise exception 'release unavailable' using errcode = 'P0001';
    end if;
    v_platform := v_target_release.platform_id;
  elsif not private.can_claim(v_game, v_platform) then
    raise exception 'game unavailable' using errcode = 'P0001';
  end if;
  if v_item.release_id is not null then
    select r.platform_id into v_source_platform from public.releases r where r.id = v_item.release_id;
  else
    v_source_platform := v_item.claimed_platform_id;
  end if;
  if v_platform is distinct from v_source_platform then
    raise exception 'other platform' using errcode = 'P0001';
  end if;

  if (v_item.release_id, v_item.claimed_game_id, v_item.claimed_platform_id, v_item.claimed_region_code, v_item.claimed_edition_kind, v_item.claimed_edition_name)
     is not distinct from
     (v_release, v_game, case when v_release is null then v_platform end, v_region, v_kind, v_name) then
    return pg_catalog.jsonb_build_object('changed', false, 'identity', case when v_item.release_id is null then 'claim' else 'release' end,
      'release_id', v_item.release_id, 'record_status', v_item.record_status);
  end if;

  -- Marks this change as the owner's for the history trigger, for this copy only.
  perform pg_catalog.set_config('mgd.copy_identity_change', v_item.id::text, true);
  update public.collection_items c set
    release_id = v_release,
    claimed_game_id = v_game,
    claimed_platform_id = case when v_release is null then v_platform end,
    claimed_region_code = v_region,
    claimed_edition_kind = v_kind,
    claimed_edition_name = v_name
  where c.id = v_item.id
  returning * into v_item;
  perform pg_catalog.set_config('mgd.copy_identity_change', '', true);

  return pg_catalog.jsonb_build_object('changed', true, 'identity', case when v_item.release_id is null then 'claim' else 'release' end,
    'release_id', v_item.release_id, 'record_status', v_item.record_status);
end;
$$;

revoke all on function public.set_my_copy_identity(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.set_my_copy_identity(uuid, jsonb) to authenticated;

-- relink_my_copy keeps its signature, errors and result, as a wrapper: a copy, now
-- identified or not, moved to a release on its platform.
create or replace function public.relink_my_copy(p_item uuid, p_release uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not private.is_active_user() then
    raise exception 'account not active' using errcode = 'P0001';
  end if;
  if p_release is null then
    raise exception 'release unavailable' using errcode = 'P0001';
  end if;
  v := public.set_my_copy_identity(p_item, pg_catalog.jsonb_build_object('release_id', p_release));
  return pg_catalog.jsonb_build_object('moved', (v ->> 'changed')::boolean, 'release_id', p_release, 'record_status', v ->> 'record_status');
end;
$$;

-- The owner's history of a copy's identity, newest first. Each entry has when, what
-- made it ('owner', 'catalog', 'maintenance'), and the identity before and after.
create function public.get_my_copy_history(p_item uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'changed_at', e.changed_at, 'source', e.source, 'previous', e.previous, 'current', e.current)
      order by e.changed_at desc, e.id desc), '[]'::jsonb)
  from private.collection_item_identity_events e
  where e.item_id = p_item and e.owner_id = (select auth.uid()) and (select private.session_is_live())
$$;

revoke all on function public.get_my_copy_history(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_my_copy_history(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Personal ownership of a game
-- ---------------------------------------------------------------------------
-- The signed-in owner's copies of one game, for "Owned: Yes" and what they own:
-- grouped by status, platform, region and edition. "owned" is true when any copy is
-- active, whatever its catalog standing (confirmed, pending, not approved or
-- unidentified); preserved copies are listed but don't count. A definer so that
-- copies preserved on an excluded release of the game are still found; it reads only
-- the caller's own copies.
create function public.get_my_game_ownership(p_game uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select
      case
        when c.record_status = 'invalid_preserved' then 'invalid'
        when c.release_id is null then 'unidentified'
        when r.status = 'published' then 'owned'
        when r.status = 'rejected' then 'not_approved'
        when r.status in ('unverified', 'under_review') then 'pending'
        else 'invalid'
      end as status,
      c.release_id,
      coalesce(r.platform_id, c.claimed_platform_id) as platform_id,
      case when c.release_id is null then c.claimed_region_code else r.region_code end as region_code,
      case when c.release_id is null then c.claimed_edition_kind else r.edition_kind end as edition_kind,
      case when c.release_id is null then c.claimed_edition_name else r.edition_name end as edition_name,
      c.claimed_game_id is not null and exists (
        select 1 from public.game_platforms gp
        where gp.game_id = c.claimed_game_id and gp.platform_id = c.claimed_platform_id and gp.status = 'published') as catalog_pairing
    from public.collection_items c
    left join public.releases r on r.id = c.release_id
    where c.owner_id = (select auth.uid()) and (select private.session_is_live())
      and coalesce(r.game_id, c.claimed_game_id) = p_game
  )
  select pg_catalog.jsonb_build_object(
    'owned', exists (select 1 from mine m where m.status <> 'invalid'),
    'copies', (select count(*) from mine m where m.status <> 'invalid'),
    'entries', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'status', x.status, 'release_id', x.release_id,
          'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
          'region', case when x.region_code is null then null else pg_catalog.jsonb_build_object('code', x.region_code, 'label', rc.label) end,
          'edition_kind', x.edition_kind, 'edition_name', x.edition_name,
          'catalog_pairing', x.catalog_pairing, 'count', x.n)
        order by pl.name, x.region_code nulls last, x.edition_name nulls last, x.status)
      from (
        select m.status, m.release_id, m.platform_id, m.region_code, m.edition_kind, m.edition_name, m.catalog_pairing, count(*) as n
        from mine m group by 1, 2, 3, 4, 5, 6, 7
      ) x
      join public.platforms pl on pl.id = x.platform_id
      left join public.region_codes rc on rc.code = x.region_code
    ), '[]'::jsonb)
  )
$$;

revoke all on function public.get_my_game_ownership(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_my_game_ownership(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Preserved claims, as the owner reads them
-- ---------------------------------------------------------------------------
-- A claim preserved by an exclusion of its game: the game is no longer published, so
-- the caller's own reads can't see it. These read it for the owner only.
create function private.my_preserved_claims(p_items uuid[])
returns table (item_id uuid, item public.collection_items, game public.games)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c, g
  from public.collection_items c
  join public.games g on g.id = c.claimed_game_id and g.status <> 'published'
  where c.id = any (p_items)
    and c.owner_id = (select auth.uid())
    and (select private.session_is_live())
    and c.release_id is null
    and c.record_status = 'invalid_preserved'
$$;

revoke all on function private.my_preserved_claims(uuid[]) from public, anon, authenticated, service_role;

-- The copy page of a preserved claim: what was claimed, and the exclusion that
-- preserved it.
create function public.get_my_preserved_claim(p_item uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'game', pg_catalog.jsonb_build_object('title', (x.game).title),
    'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
    'region', case when (x.item).claimed_region_code is null then null
                   else pg_catalog.jsonb_build_object('code', (x.item).claimed_region_code, 'label', rc.label) end,
    'edition_kind', (x.item).claimed_edition_kind, 'edition_name', (x.item).claimed_edition_name,
    'exclusion', (
      select pg_catalog.jsonb_build_object('reason_code', e.reason_code, 'note', e.owner_note, 'excluded_at', e.excluded_at)
      from private.catalog_exclusion_copies ec
      join private.catalog_exclusions e on e.id = ec.exclusion_id
      where ec.item_id = x.item_id and ec.claimed_game_id = (x.item).claimed_game_id and e.restored_at is null
        and e.excluded_at = (x.item).invalidated_at
      order by e.excluded_at desc limit 1))
  from private.my_preserved_claims(array[p_item]) x
  join public.platforms pl on pl.id = (x.item).claimed_platform_id
  left join public.region_codes rc on rc.code = (x.item).claimed_region_code
$$;

revoke all on function public.get_my_preserved_claim(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_my_preserved_claim(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. The collection list: unidentified copies, by their claimed game and platform
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_collection(p_query text DEFAULT NULL::text, p_platform text DEFAULT NULL::text, p_completeness text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_sort text DEFAULT 'added'::text, p_limit integer DEFAULT 50, p_cursor text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_me uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_sort text := coalesce(p_sort, 'added');
  v_query text;
  v_hash text;
  v_cursor jsonb;
  c_k1 text;
  c_k2 text;
  c_id uuid;
  v_keys text;
  v_order text;
  v_after text;
  v_ids uuid[];
  v_last_k1 text;
  v_last_k2 text;
  v_more boolean;
  v_items jsonb;
  v_next text;
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_sort <> all (array['added', 'title', 'platform', 'acquired'])
     or p_completeness <> all (array['loose', 'incomplete', 'complete', 'sealed', 'not_recorded'])
     or p_status <> all (array['owned', 'pending', 'not_approved', 'invalid', 'unidentified']) then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  if pg_catalog.char_length(p_query) > 100 then
    raise exception 'query too long' using errcode = '22023';
  end if;
  v_query := nullif(pg_catalog.regexp_replace(normalize(pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, ''))), NFKD), '[̀-ͯ]', '', 'g'), '');
  v_hash := pg_catalog.md5(pg_catalog.jsonb_build_array(v_query, p_platform, p_completeness, p_status, v_sort)::text);

  if p_cursor is not null then
    begin
      v_cursor := pg_catalog.convert_from(pg_catalog.decode(pg_catalog.translate(p_cursor, '-_', '+/') ||
        pg_catalog.repeat('=', (4 - pg_catalog.length(p_cursor) % 4) % 4), 'base64'), 'UTF8')::jsonb;
      if pg_catalog.jsonb_typeof(v_cursor) <> 'array' or pg_catalog.jsonb_array_length(v_cursor) <> 4 or v_cursor ->> 0 is distinct from v_hash then
        raise exception using errcode = '22023';
      end if;
      c_k1 := v_cursor ->> 1;
      c_k2 := v_cursor ->> 2;
      c_id := (v_cursor ->> 3)::uuid;
      if c_id is null or c_k1 is null or (v_sort = 'platform' and c_k2 is null) then
        raise exception using errcode = '22023';
      end if;
      -- The keys must have the sort's types.
      case v_sort
        when 'added' then perform c_k1::timestamptz;
        when 'acquired' then perform c_k1::date;
        else null;
      end case;
    exception when others then
      raise exception 'invalid cursor' using errcode = '22023';
    end;
  end if;

  -- The sort's keys ($k1, $k2), order and position after the cursor.
  case v_sort
    when 'added' then
      v_keys := 'c.created_at::text, null::text';
      v_order := 'c.created_at desc, c.id desc';
      v_after := '(c.created_at, c.id) < ($6::timestamptz, $8)';
    when 'title' then
      v_keys := 'pg_catalog.lower(coalesce(g.sort_title, g.title, '''')), null::text';
      v_order := 'pg_catalog.lower(coalesce(g.sort_title, g.title, '''')), c.id';
      v_after := '(pg_catalog.lower(coalesce(g.sort_title, g.title, '''')), c.id) > ($6, $8)';
    when 'platform' then
      v_keys := 'pg_catalog.lower(coalesce(pl.name, '''')), pg_catalog.lower(coalesce(g.sort_title, g.title, ''''))';
      v_order := 'pg_catalog.lower(coalesce(pl.name, '''')), pg_catalog.lower(coalesce(g.sort_title, g.title, '''')), c.id';
      v_after := '(pg_catalog.lower(coalesce(pl.name, '''')), pg_catalog.lower(coalesce(g.sort_title, g.title, '''')), c.id) > ($6, $7, $8)';
    else
      v_keys := 'coalesce(pv.acquired_on, date ''0001-01-01'')::text, null::text';
      v_order := 'coalesce(pv.acquired_on, date ''0001-01-01'') desc, c.id desc';
      v_after := '(coalesce(pv.acquired_on, date ''0001-01-01''), c.id) < ($6::date, $8)';
  end case;

  -- $1 owner, $2 platform, $3 completeness, $4 status, $5 folded query, $6 to $8 the
  -- cursor, $9 the page size. Unused joins are removed by the planner.
  execute pg_catalog.format($q$
    select array_agg(x.id order by x.n) filter (where x.n <= $9),
           max(x.k1) filter (where x.n = $9), max(x.k2) filter (where x.n = $9),
           coalesce(bool_or(x.n > $9), false)
    from (
      select p.id, p.k1, p.k2, p.n
      from (
        select c.id, %1$s, row_number() over (order by %2$s)
        from public.collection_items c
        left join public.releases r on r.id = c.release_id
        left join public.games g on g.id = coalesce(r.game_id, c.claimed_game_id)
        left join public.platforms pl on pl.id = coalesce(r.platform_id, c.claimed_platform_id)
        left join public.collection_item_private pv on pv.item_id = c.id
        where c.owner_id = $1
          and ($2 is null or pl.slug = $2)
          and ($3 is null or ($3 = 'not_recorded' and c.completeness is null) or c.completeness::text = $3)
          and ($4 is null or $4 = case
                when c.record_status = 'invalid_preserved' then 'invalid'
                when c.release_id is null then 'unidentified'
                when r.status = 'published' then 'owned'
                when r.status = 'rejected' then 'not_approved'
                when r.status is null then 'invalid'
                else 'pending'
              end)
          and ($5 is null
               or pg_catalog.strpos(pg_catalog.regexp_replace(normalize(pg_catalog.lower(coalesce(g.title, '')), NFKD), '[̀-ͯ]', '', 'g'), $5) > 0
               or pg_catalog.strpos(pg_catalog.regexp_replace(normalize(pg_catalog.lower(coalesce(r.local_title, '')), NFKD), '[̀-ͯ]', '', 'g'), $5) > 0)
          and ($8 is null or %3$s)
        order by %2$s
        limit $9 + 1
      ) p(id, k1, k2, n)
    ) x
  $q$, v_keys, v_order, v_after)
  into v_ids, v_last_k1, v_last_k2, v_more
  using v_me, p_platform, p_completeness, p_status, v_query, c_k1, c_k2, c_id, v_limit;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id,
      'status', case
        when c.record_status = 'invalid_preserved' then 'invalid'
        when c.release_id is null then 'unidentified'
        when r.status = 'published' then 'owned'
        when r.status = 'rejected' then 'not_approved'
        when r.status is null then 'invalid'
        else 'pending'
      end,
      'added_at', c.created_at,
      'updated_at', c.updated_at,
      'completeness', c.completeness,
      'conditions', pg_catalog.jsonb_build_object('overall', c.overall_condition, 'box', c.box_condition, 'media', c.media_condition, 'manual', c.manual_condition),
      'copies_of_release', case when c.release_id is null then 0 else (select count(*) from public.collection_items x where x.owner_id = v_me and x.release_id = c.release_id) end,
      'game', case when g.id is null then null else pg_catalog.jsonb_build_object('id', g.id, 'slug', g.slug, 'title', g.title) end,
      'release', case when r.id is null then null else pg_catalog.jsonb_build_object(
        'id', r.id,
        'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
        'region', pg_catalog.jsonb_build_object('code', r.region_code, 'label', rc.label),
        'edition_name', r.edition_name, 'variant_name', r.variant_name, 'local_title', r.local_title,
        'format', pg_catalog.jsonb_build_object('code', r.media_format_code, 'name', mf.name),
        'media_count', r.media_count) end,
      'acquired_on', pv.acquired_on,
      'price', case when pv.purchase_price is null then null else pg_catalog.jsonb_build_object('amount', pv.purchase_price::text, 'currency', pv.currency) end,
      'storage_location', pv.storage_location,
      'identity', case when c.release_id is null then 'claim' else 'release' end,
      'claim', case when c.release_id is null then pg_catalog.jsonb_build_object(
        'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
        'region', case when c.claimed_region_code is null then null else pg_catalog.jsonb_build_object('code', c.claimed_region_code, 'label', rc.label) end,
        'edition_kind', c.claimed_edition_kind, 'edition_name', c.claimed_edition_name,
        -- Whether the catalog lists this platform for the game: a claim on one it
        -- doesn't is the owner's own, not a verified pairing.
        'catalog_pairing', exists (select 1 from public.game_platforms gp
          where gp.game_id = c.claimed_game_id and gp.platform_id = c.claimed_platform_id and gp.status = 'published')) end,
      'has_notes', pv.notes is not null
    ) order by pg_catalog.array_position(v_ids, c.id)), '[]'::jsonb)
  into v_items
  from public.collection_items c
  left join public.releases r on r.id = c.release_id
  left join public.games g on g.id = coalesce(r.game_id, c.claimed_game_id)
  left join public.platforms pl on pl.id = coalesce(r.platform_id, c.claimed_platform_id)
  left join public.region_codes rc on rc.code = coalesce(r.region_code, c.claimed_region_code)
  left join public.media_formats mf on mf.code = r.media_format_code
  left join public.collection_item_private pv on pv.item_id = c.id
  where c.owner_id = v_me and c.id = any (coalesce(v_ids, '{}'));

  if v_more then
    v_next := pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(v_hash, v_last_k1, v_last_k2, v_ids[v_limit])::text, 'UTF8'), 'base64'), E'+/\n', '-_'), '=');
  end if;
  return pg_catalog.jsonb_build_object('items', v_items, 'next_cursor', v_next);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 11. One copy: its claim, when it has one
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_collection_item(p_item uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'id', c.id,
    'status', case
      when c.record_status = 'invalid_preserved' then 'invalid'
      when c.release_id is null then 'unidentified'
      when r.status = 'published' then 'owned'
      when r.status = 'rejected' then 'not_approved'
      when r.status is null then 'invalid'
      else 'pending'
    end,
    'added_at', c.created_at,
    'updated_at', c.updated_at,
    'completeness', c.completeness,
    'conditions', pg_catalog.jsonb_build_object('overall', c.overall_condition, 'box', c.box_condition, 'media', c.media_condition, 'manual', c.manual_condition),
    'copies_of_release', case when c.release_id is null then 0 else (select count(*) from public.collection_items x where x.owner_id = c.owner_id and x.release_id = c.release_id) end,
    'game', case when g.id is null then null else pg_catalog.jsonb_build_object('id', g.id, 'slug', g.slug, 'title', g.title) end,
    'release', case when r.id is null then null else pg_catalog.jsonb_build_object(
      'id', r.id,
      'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
      'region', pg_catalog.jsonb_build_object('code', r.region_code, 'label', rc.label),
      'edition_name', r.edition_name, 'variant_name', r.variant_name, 'local_title', r.local_title,
      'format', pg_catalog.jsonb_build_object('code', r.media_format_code, 'name', mf.name),
      'media_count', r.media_count, 'packaging', r.packaging, 'packaging_code', r.packaging_code,
      'identifiers', pg_catalog.jsonb_build_object('product_code', r.product_code, 'barcode', r.barcode)) end,
    'acquired_on', pv.acquired_on,
    'price', case when pv.purchase_price is null then null else pg_catalog.jsonb_build_object('amount', pv.purchase_price::text, 'currency', pv.currency) end,
    'storage_location', pv.storage_location,
    'notes', pv.notes,
    'identity', case when c.release_id is null then 'claim' else 'release' end,
    'claim', case when c.release_id is null then pg_catalog.jsonb_build_object(
      'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
      'region', case when c.claimed_region_code is null then null else pg_catalog.jsonb_build_object('code', c.claimed_region_code, 'label', rc.label) end,
      'edition_kind', c.claimed_edition_kind, 'edition_name', c.claimed_edition_name,
      -- Whether the catalog lists this platform for the game: a claim on one it
      -- doesn't is the owner's own, not a verified pairing.
      'catalog_pairing', exists (select 1 from public.game_platforms gp
        where gp.game_id = c.claimed_game_id and gp.platform_id = c.claimed_platform_id and gp.status = 'published')) end,
    'components', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'kind', x.kind, 'label', x.label, 'quantity', x.quantity, 'listed', x.listed, 'recorded', x.recorded, 'condition', x.condition
      ) order by x.listed desc, x.kind, x.label)
      from (
        select coalesce(l.kind, m.kind) as kind, coalesce(l.label, m.label) as label, l.quantity,
               l.kind is not null as listed, m.kind is not null as recorded, m.condition
        from (select k.kind, k.label, k.quantity from public.release_components k where k.release_id = c.release_id) l
        full join (select k.kind, k.label, k.condition from public.collection_item_components k where k.item_id = c.id) m
          on m.kind = l.kind and m.label = l.label
      ) x
    ), '[]'::jsonb)
  )
  from public.collection_items c
  left join public.releases r on r.id = c.release_id
  left join public.games g on g.id = coalesce(r.game_id, c.claimed_game_id)
  left join public.platforms pl on pl.id = coalesce(r.platform_id, c.claimed_platform_id)
  left join public.region_codes rc on rc.code = coalesce(r.region_code, c.claimed_region_code)
  left join public.media_formats mf on mf.code = r.media_format_code
  left join public.collection_item_private pv on pv.item_id = c.id
  where c.id = p_item and c.owner_id = (select auth.uid())
$function$;

-- ---------------------------------------------------------------------------
-- 12. The summary: unidentified copies counted on their own
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_collection_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with mine as (
    select
      case
        when c.record_status = 'invalid_preserved' then 'invalid'
        when c.release_id is null then 'unidentified'
        when r.status = 'published' then 'owned'
        when r.status = 'rejected' then 'not_approved'
        when r.status is null then 'invalid'
        else 'pending'
      end as status,
      case when c.record_status = 'invalid_preserved' then r.platform_id else coalesce(r.platform_id, c.claimed_platform_id) end as platform_id
    from public.collection_items c
    left join public.releases r on r.id = c.release_id
    where c.owner_id = (select auth.uid())
  )
  select pg_catalog.jsonb_build_object(
    'total', (select count(*) from mine),
    'owned', (select count(*) from mine where status = 'owned'),
    'pending', (select count(*) from mine where status = 'pending'),
    'not_approved', (select count(*) from mine where status = 'not_approved'),
    'invalid', (select count(*) from mine where status = 'invalid'),
    -- M12a: unidentified copies on their own. 'owned' stays confirmed releases only.
    'unidentified', (select count(*) from mine where status = 'unidentified'),
    'limit', 100000,
    'platforms', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name, 'count', x.n)
             order by pl.name)
      from (select m.platform_id, count(*) as n from mine m where m.platform_id is not null group by m.platform_id) x
      join public.platforms pl on pl.id = x.platform_id
    ), '[]'::jsonb)
  )
$function$;

-- ---------------------------------------------------------------------------
-- 13. Export: titles of preserved claims
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_preserved_titles(p_items uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if pg_catalog.cardinality(p_items) > 100 then
    raise exception 'too many items' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_object_agg(y.item_id, y.value) from (
      select x.item_id, pg_catalog.jsonb_build_object(
        'title', (x.game).title, 'local_title', (x.release).local_title,
        'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
        'region', pg_catalog.jsonb_build_object('code', (x.release).region_code, 'label', rc.label),
        'edition_name', (x.release).edition_name, 'variant_name', (x.release).variant_name) as value
      from private.my_preserved_releases(coalesce(p_items, '{}')) x
      join public.platforms pl on pl.id = (x.release).platform_id
      left join public.region_codes rc on rc.code = (x.release).region_code
      union all
      -- M12a: a preserved claim, as claimed.
      select x.item_id, pg_catalog.jsonb_build_object(
        'title', (x.game).title, 'local_title', null,
        'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
        'region', case when (x.item).claimed_region_code is null then null
                       else pg_catalog.jsonb_build_object('code', (x.item).claimed_region_code, 'label', rc.label) end,
        'edition_name', (x.item).claimed_edition_name, 'edition_kind', (x.item).claimed_edition_kind, 'variant_name', null)
      from private.my_preserved_claims(coalesce(p_items, '{}')) x
      join public.platforms pl on pl.id = (x.item).claimed_platform_id
      left join public.region_codes rc on rc.code = (x.item).claimed_region_code
    ) y
  ), '{}'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 14. Exclusion plan: claims on the games an exclusion excludes
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.exclusion_plan(p_release uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  rel public.releases;
  req public.catalog_change_requests;
  v_game public.games;
  v_cascade jsonb := '[]';
  v_games uuid[] := '{}';
  v_blocking jsonb;
  v_copies bigint;
  v_owners bigint;
  v_claims bigint;
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

  -- M12a: the copies on the release, and the active claims on each game it excludes.
  select count(*), count(distinct c.owner_id), count(*) filter (where c.release_id is null) into v_copies, v_owners, v_claims
  from public.collection_items c
  where c.record_status = 'active'
    and (c.release_id = rel.id or (c.release_id is null and c.claimed_game_id = any (v_games)));

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
    'claimed_copies', v_claims,
    'token', pg_catalog.md5(pg_catalog.jsonb_build_array(
      rel.id, rel.status, rel.revision, req.id, req.status, req.version, v_cascade, pg_catalog.jsonb_array_length(v_blocking))::text)
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 15. Exclusion profiles: owners of the claims
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.exclusion_profiles(p_me uuid, p_release uuid, p_exclusion uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
    -- M12a: owners of active claims on the release's game or the games it contains,
    -- any of which the exclusion may exclude.
    select c.owner_id from public.releases r
    join public.collection_items c on c.release_id is null and c.record_status = 'active'
      and (c.claimed_game_id = r.game_id
           or c.claimed_game_id in (select gr.target_game_id from public.game_relations gr where gr.source_game_id = r.game_id and gr.relation = 'contains'))
    where p_exclusion is null and r.id = p_release
    union all
    select ec.owner_id from private.catalog_exclusion_copies ec where ec.exclusion_id = p_exclusion
  ) x
$function$;

-- ---------------------------------------------------------------------------
-- 16. Excluding: claims on an excluded game are preserved with the release's copies
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.exclude_release(p_release uuid, p_token text, p_reason_code text, p_reason text, p_owner_note text DEFAULT NULL::text, p_acknowledge_cascade boolean DEFAULT false, p_acknowledge_copies boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_claim_games uuid[];
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
  -- M10c (D-4): never a release, or a game it takes with it, that the caller created.
  if private.created_by(v_me, array[p_release], private.cascade_games(v_plan -> 'cascade')) then
    raise exception 'own record' using errcode = 'P0001';
  end if;
  -- M10c (D-5): excluding a published release needs a recent TOTP verification.
  if rel.status = 'published' then
    perform private.require_recent_mfa();
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

  -- 4. The copies. None can be added or moved away while the release is locked. M12a:
  --    with them, the active claims on each game this excludes; none can be made or
  --    moved onto a game while it's locked (lock_claimable_game).
  select coalesce(pg_catalog.array_agg(x.id order by x.id), '{}'), coalesce(pg_catalog.array_agg(x.owner_id order by x.id), '{}'),
         coalesce(pg_catalog.array_agg(x.claimed_game_id order by x.id), '{}')
  into v_items, v_owners, v_claim_games
  from (
    select c.id, c.owner_id, c.claimed_game_id from public.collection_items c
    where c.record_status = 'active'
      and (c.release_id = rel.id
           or (c.release_id is null and c.claimed_game_id in (
                 select (e ->> 'id')::uuid from pg_catalog.jsonb_array_elements(v_plan -> 'cascade') e where e ->> 'entity' = 'game')))
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
  insert into private.catalog_exclusion_copies (exclusion_id, item_id, owner_id, claimed_game_id)
  select v_id, i, o, g from rows from (pg_catalog.unnest(v_items), pg_catalog.unnest(v_owners), pg_catalog.unnest(v_claim_games)) as x(i, o, g);

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
$function$;

-- ---------------------------------------------------------------------------
-- 17. Restoring: claims still preserved by this exclusion come back
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.restore_exclusion(p_exclusion uuid, p_expected_version integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- M10c (D-4): never a release, or a game it brings back, that the caller created.
  if private.created_by(v_me, array[ex.release_id], private.cascade_games(ex.cascade)) then
    raise exception 'own record' using errcode = 'P0001';
  end if;
  -- M10c (D-5): bringing anything back as published needs a recent TOTP verification.
  if ex.previous_status = 'published'
     or exists (select 1 from pg_catalog.jsonb_array_elements(ex.cascade) e where e ->> 'previous_status' = 'published') then
    perform private.require_recent_mfa();
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
    -- M12a: a claim it preserved, still that claim; a copy the owner has changed since is active, and left alone.
    where (case when ec.claimed_game_id is null then c.release_id = ex.release_id
                 else c.release_id is null and c.claimed_game_id = ec.claimed_game_id end)
      and c.record_status = 'invalid_preserved' and c.invalidated_at = ex.excluded_at
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
$function$;

-- ---------------------------------------------------------------------------
-- 18. An exclusion's copies, claims included
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_exclusion(p_exclusion uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
                          where ec.exclusion_id = ex.id and (case when ec.claimed_game_id is null then c.release_id = ex.release_id
                 else c.release_id is null and c.claimed_game_id = ec.claimed_game_id end)
                            and c.record_status = 'invalid_preserved' and c.invalidated_at = ex.excluded_at),
      'moved', (select count(*) from private.catalog_exclusion_copies ec join public.collection_items c on c.id = ec.item_id
                where ec.exclusion_id = ex.id and not (case when ec.claimed_game_id is null then c.release_id = ex.release_id
                 else c.release_id is null and c.claimed_game_id = ec.claimed_game_id end)),
      'removed', ex.copies_preserved - (select count(*) from private.catalog_exclusion_copies ec where ec.exclusion_id = ex.id)),
    'restored_at', ex.restored_at, 'restore_reason', ex.restore_reason, 'copies_restored', ex.copies_restored,
    'own_exclusion', ex.excluded_by = v_me,
    'own_submission', private.exclusion_involves(v_me, ex.release_id, ex.cascade),
    'blocker', v_blocker);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 19. Merge plan: a claimed game is never retired
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.merge_plan(p_source uuid, p_target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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

  -- M12a: never retire a game someone claims a copy of. Claims need a published game
  -- and only unpublished ones are retired, so this is a safeguard.
  if v_retire is not null and exists (select 1 from public.collection_items c
                                      where c.release_id is null and c.claimed_game_id = (v_retire ->> 'id')::uuid) then
    v_blocking := v_blocking || pg_catalog.jsonb_build_object('kind', 'claimed_copy');
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
$function$;
