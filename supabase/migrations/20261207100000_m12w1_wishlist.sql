-- M12 W1 Physical Wishlist: the database foundation. A collector's private list of
-- physical games they want, pointing at the catalog and copying nothing from it.
--
-- Design: docs/architecture/database-schema.md#wishlist_items-m12-w1 and
-- docs/architecture/security-rls.md#wishlist-m12-w1. Approved with the M12 Wishlist
-- architecture proposal (decisions 1 to 15).
--
-- - Four levels of want, from loose to exact: a game in any version; a game on one
--   platform; a game on one platform in one region; one exact catalog release. Region,
--   edition and every other detail of a release come from the catalog record, never
--   from the entry.
-- - One entry per exact target per collector. Different targets for the same game
--   coexist ("any version" beside specific ones, PlayStation PAL beside Nintendo 64
--   NTSC-U). Adding the same target again returns the existing entry.
-- - Entries are added only for published records: the game (and the catalog's own
--   pairing of game and platform, when a platform is named), or the release. The rows
--   are locked FOR SHARE in the catalog's order (games, then releases, then pairings),
--   so an add and an exclusion or merge of its target are serialized.
-- - Catalog changes are resolved when the wishlist is read, never written onto the
--   entry: a merged release or game is shown as the record it was merged into, and an
--   excluded one as unavailable, with what the owner saw while it was published (as
--   preserved copies are, M7b-2b). Restoring a record makes its entries available again.
--   merge_release, exclude_release and restore_exclusion are unchanged, and the foreign
--   keys restrict, so nothing a wishlist references can be deleted (published records
--   are never deleted or unpublished: guard_published_catalog_row, M5).
-- - Owned copies stay separate: nothing is removed because the game is owned. Reads
--   report how many of the owner's copies match each entry, and how many of those meet
--   its lowest acceptable completeness.
-- - Private only. No visibility column until public profiles exist, and the note stays
--   owner-only then too. Not audited: a personal preference, not a catalog decision.
-- - Owner-only reads through a live session (M11a). Writes only through the functions
--   below (no INSERT, UPDATE or DELETE grant): adding and editing need an active
--   account; reading and removing don't, so a suspended owner can still see and remove
--   their entries, as with copies.
-- - The client chooses each new entry's UUIDv7, which makes adding idempotent, as with
--   copies (M6). At most 10,000 entries per collector.
--
-- Rollback: supabase/rollbacks/20261207100000_m12w1_wishlist.rollback.sql (refuses
-- while any collector has an entry, unless told to discard them).

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

create table public.wishlist_items (
  -- No default: the client supplies it, and a trigger checks it's a recent UUIDv7.
  id uuid primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  -- An exact release (level C), or
  release_id uuid references public.releases (id) on delete restrict,
  -- a game (level A), narrowed to a platform (B) and a region on it (B+).
  game_id uuid references public.games (id) on delete restrict,
  platform_id uuid references public.platforms (id) on delete restrict,
  region_code text references public.region_codes (code) on delete restrict,
  -- The lowest completeness the collector would accept. Null: any, or not said.
  -- Order, lowest first: loose, incomplete, complete, sealed (private.completeness_rank).
  completeness public.completeness,
  -- 1 high, 2 normal, 3 low.
  priority smallint not null default 2,
  -- The owner's own words, private. Stored tidied: NFC, line breaks as \n, no other
  -- control characters, no surrounding spaces or line breaks.
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wishlist_items_target check (
    (release_id is not null and game_id is null and platform_id is null and region_code is null)
    or (release_id is null and game_id is not null)),
  constraint wishlist_items_region_needs_platform check (region_code is null or platform_id is not null),
  -- The catalog's own 'unknown' code isn't a preference.
  constraint wishlist_items_region_known check (region_code is distinct from 'unknown'),
  constraint wishlist_items_priority check (priority between 1 and 3),
  constraint wishlist_items_note check (
    note is null or (
      pg_catalog.char_length(note) between 1 and 500
      and note = pg_catalog.btrim(note, E' \n')
      and pg_catalog.translate(note, E'\n', '') !~ '[[:cntrl:]]'
      and note is nfc normalized))
);

-- One entry per exact target per collector.
create unique index wishlist_items_release_key on public.wishlist_items (owner_id, release_id) where release_id is not null;
create unique index wishlist_items_game_key on public.wishlist_items (owner_id, game_id, platform_id, region_code) nulls not distinct
  where release_id is null;
-- Browsing, newest first, and the limit's count.
create index wishlist_items_owner_added_idx on public.wishlist_items (owner_id, created_at desc, id desc);
-- Restrict checks when catalog rows are deleted, and future "wanted by" counts.
create index wishlist_items_release_idx on public.wishlist_items (release_id) where release_id is not null;
create index wishlist_items_game_idx on public.wishlist_items (game_id) where game_id is not null;
create index wishlist_items_platform_idx on public.wishlist_items (platform_id) where platform_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Integrity triggers
-- ---------------------------------------------------------------------------

-- New entries: the id must be a UUIDv7 made within the last 24 hours, or up to 5
-- minutes ahead for clock skew, as for copies (M6). Then the owner's limit of 10,000,
-- under a per-owner lock so two concurrent additions can't both pass it.
create function private.check_new_wishlist_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c_limit constant integer := 10000;
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

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wishlist_items:' || new.owner_id::text, 0));
  if (select count(*) from public.wishlist_items w where w.owner_id = new.owner_id) >= c_limit then
    raise exception 'wishlist limit reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- An entry never changes hands, id or creation time.
create function private.guard_wishlist_item_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id or new.created_at is distinct from old.created_at then
    raise exception 'wishlist entries keep their id, owner and creation time' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger check_new_wishlist_item before insert on public.wishlist_items
  for each row execute function private.check_new_wishlist_item();
create trigger guard_wishlist_item_update before update on public.wishlist_items
  for each row execute function private.guard_wishlist_item_update();
create trigger set_updated_at before update on public.wishlist_items
  for each row execute function private.set_updated_at();

revoke all on function private.check_new_wishlist_item() from public, anon, authenticated, service_role;
revoke all on function private.guard_wishlist_item_update() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Access: the owner reads their own rows, through a live session; nothing else
-- ---------------------------------------------------------------------------
-- The SELECT grant serves the personal data export (W2), which reads its rows as the
-- owner. Every write goes through the functions below.

alter table public.wishlist_items enable row level security;

create policy wishlist_items_read_own on public.wishlist_items
  for select to authenticated
  using (owner_id = (select auth.uid()) and (select private.session_is_live()));

revoke all on public.wishlist_items from public, anon, authenticated, service_role;
grant select on public.wishlist_items to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------

-- Completeness, lowest first. A copy meets an entry's minimum when its rank is at
-- least the minimum's: sealed meets "complete", loose meets only "loose". A copy whose
-- completeness isn't recorded meets no minimum.
create function private.completeness_rank(p public.completeness)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p when 'loose' then 1 when 'incomplete' then 2 when 'complete' then 3 when 'sealed' then 4 end
$$;

-- The record a merged release or game now is: follows merged_into_id (merges repoint
-- earlier merges, so a chain is one step; a longer one is followed up to 16 steps).
create function private.final_release(p_release uuid)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_id uuid := p_release;
  v_next uuid;
begin
  for i in 1..16 loop
    v_next := null;
    select r.merged_into_id into v_next from public.releases r where r.id = v_id and r.status = 'merged';
    exit when v_next is null;
    v_id := v_next;
  end loop;
  return v_id;
end;
$$;

create function private.final_game(p_game uuid)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_id uuid := p_game;
  v_next uuid;
begin
  for i in 1..16 loop
    v_next := null;
    select g.merged_into_id into v_next from public.games g where g.id = v_id and g.status = 'merged';
    exit when v_next is null;
    v_id := v_next;
  end loop;
  return v_id;
end;
$$;

-- A target as the client sends it: {"release_id": uuid}, or {"game_id": uuid,
-- "platform_id"?: uuid, "region_code"?: text}, optional keys absent or null. Checks
-- its shape and region only; lock_wishlist_target checks the catalog.
create function private.parse_wishlist_target(p_target jsonb, out t_release uuid, out t_game uuid, out t_platform uuid, out t_region text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys text[];
begin
  if p_target is null or pg_catalog.jsonb_typeof(p_target) <> 'object' then
    raise exception 'invalid target' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_keys from pg_catalog.jsonb_object_keys(p_target) k;
  if exists (select 1 from pg_catalog.jsonb_each(p_target) e where pg_catalog.jsonb_typeof(e.value) not in ('string', 'null')) then
    raise exception 'invalid target' using errcode = '22023';
  end if;
  begin
    if p_target ? 'release_id' then
      if v_keys <> array['release_id'] then
        raise exception using errcode = '22023';
      end if;
      t_release := (p_target ->> 'release_id')::uuid;
      if t_release is null then
        raise exception using errcode = '22023';
      end if;
      return;
    end if;
    if not v_keys <@ array['game_id', 'platform_id', 'region_code'] then
      raise exception using errcode = '22023';
    end if;
    t_game := (p_target ->> 'game_id')::uuid;
    t_platform := (p_target ->> 'platform_id')::uuid;
    if t_game is null then
      raise exception using errcode = '22023';
    end if;
  exception when invalid_text_representation or invalid_parameter_value then
    raise exception 'invalid target' using errcode = '22023';
  end;
  t_region := nullif(pg_catalog.btrim(p_target ->> 'region_code'), '');
  if t_region is not null and t_platform is null then
    raise exception 'invalid target' using errcode = '22023';
  end if;
end;
$$;

-- Locks a target's catalog rows FOR SHARE, in the catalog's order (games, releases,
-- pairings: as lock_exclusion_records and lock_merge_records take them FOR UPDATE), and
-- checks they're published. FOR SHARE conflicts with those FOR UPDATE locks and with a
-- plain status update, so whichever comes second sees the other's result. A region
-- must be one the catalog lists (any of them, not only those with a release of the
-- game), and not 'unknown'.
create function private.lock_wishlist_target(p_release uuid, p_game uuid, p_platform uuid, p_region text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_game uuid;
  v_status public.catalog_status;
  v_game_status public.catalog_status;
begin
  if p_release is not null then
    select r.game_id into v_game from public.releases r where r.id = p_release;
    if not found then
      raise exception 'release unavailable' using errcode = 'P0001';
    end if;
    select g.status into v_game_status from public.games g where g.id = v_game for share;
    select r.status into v_status from public.releases r where r.id = p_release and r.game_id = v_game for share;
    if v_status is distinct from 'published' or v_game_status is distinct from 'published' then
      raise exception 'release unavailable' using errcode = 'P0001';
    end if;
    return;
  end if;
  if p_region is not null and (p_region = 'unknown' or not exists (select 1 from public.region_codes rc where rc.code = p_region)) then
    raise exception 'invalid region' using errcode = '22023';
  end if;
  select g.status into v_game_status from public.games g where g.id = p_game for share;
  if v_game_status is distinct from 'published' then
    raise exception 'game unavailable' using errcode = 'P0001';
  end if;
  if p_platform is not null then
    perform 1 from public.game_platforms gp
    where gp.game_id = p_game and gp.platform_id = p_platform and gp.status = 'published'
    for share;
    if not found then
      raise exception 'platform unavailable' using errcode = 'P0001';
    end if;
  end if;
end;
$$;

-- An entry's details as the client sends them: completeness (a value, or null for
-- any), priority (1, 2 or 3) and note (text up to 500 characters once tidied, or null
-- to clear it). Unknown keys are refused; p_allowed lists the other keys a caller
-- handles itself. d_keys lists the details given.
create function private.parse_wishlist_details(p_details jsonb, p_allowed text[],
  out d_keys text[], out d_completeness public.completeness, out d_priority smallint, out d_note text)
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_details is null or pg_catalog.jsonb_typeof(p_details) <> 'object' then
    raise exception 'invalid details' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.array_agg(k order by k), '{}') into d_keys
  from pg_catalog.jsonb_object_keys(p_details) k where k <> all (p_allowed);
  if not d_keys <@ array['completeness', 'note', 'priority'] then
    raise exception 'invalid details' using errcode = '22023';
  end if;
  if p_details ? 'completeness' then
    if pg_catalog.jsonb_typeof(p_details -> 'completeness') not in ('string', 'null') then
      raise exception 'invalid details' using errcode = '22023';
    end if;
    begin
      d_completeness := (p_details ->> 'completeness')::public.completeness;
    exception when invalid_text_representation then
      raise exception 'invalid details' using errcode = '22023';
    end;
  end if;
  if p_details ? 'priority' then
    if (p_details -> 'priority')::text not in ('1', '2', '3') then
      raise exception 'invalid details' using errcode = '22023';
    end if;
    d_priority := (p_details ->> 'priority')::smallint;
  end if;
  if p_details ? 'note' then
    if pg_catalog.jsonb_typeof(p_details -> 'note') not in ('string', 'null') then
      raise exception 'invalid details' using errcode = '22023';
    end if;
    d_note := nullif(pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(pg_catalog.normalize(p_details ->> 'note', 'NFC'),
      E'\r\n', E'\n'), E'\r', E'\n'), E' \n'), '');
    if pg_catalog.char_length(d_note) > 500 or pg_catalog.translate(d_note, E'\n', '') ~ '[[:cntrl:]]' then
      raise exception 'invalid details' using errcode = '22023';
    end if;
  end if;
end;
$$;

-- Every entry of one owner, with the catalog's changes resolved: what the entry now
-- shows (the game, and the release or the platform and region it names) and its
-- state. 'available': the record is published (a merged one counts as the record it
-- was merged into, and 'merged' says so). 'unavailable': the record, or the one it was
-- merged into, is no longer published; it's shown as the owner saw it. A game entry
-- on a platform whose pairing is no longer published is 'platform_unavailable'.
-- 'duplicate': another of the owner's entries now shows the same target (after a
-- merge), judged across all of them. Keys for sorting come with it, and the folded
-- text for searching when p_search. p_ids: only those entries (every entry is still
-- read, for "duplicate"; the per-entry work is done for those only).
create function private.wishlist_entries(p_owner uuid, p_ids uuid[] default null, p_search boolean default false)
returns table (
  id uuid, kind text, state text, merged boolean, duplicate boolean,
  game_id uuid, release_id uuid, platform_id uuid, region_code text,
  priority smallint, completeness public.completeness, created_at timestamptz,
  title_key text, search_key text
)
language sql
stable
set search_path = ''
as $$
  with base as (
    select w.id, w.priority, w.completeness, w.created_at, w.release_id as wanted_release, w.game_id as wanted_game,
      w.platform_id as wanted_platform, w.region_code as wanted_region, r0.game_id as release_game,
      case when r0.status = 'merged' then private.final_release(r0.id) else r0.id end as final_release,
      case when g0.status = 'merged' then private.final_game(g0.id) else g0.id end as final_game
    from public.wishlist_items w
    left join public.releases r0 on r0.id = w.release_id
    left join public.games g0 on g0.id = w.game_id
    where w.owner_id = p_owner
  ), judged as (
    select b.*,
      case when b.wanted_release is not null then coalesce(fr.status = 'published' and frg.status = 'published', false)
           else coalesce(fg.status = 'published', false) end as available,
      fr.game_id as final_release_game
    from base b
    left join public.releases fr on fr.id = b.final_release
    left join public.games frg on frg.id = fr.game_id
    left join public.games fg on fg.id = b.final_game
  ), shown as (
    select j.id, j.priority, j.completeness, j.created_at, j.available, j.wanted_platform, j.wanted_region,
      case when j.wanted_release is not null then 'release' else 'game' end as kind,
      case when j.wanted_release is null then null when j.available then j.final_release else j.wanted_release end as release_id,
      case when j.wanted_release is not null then case when j.available then j.final_release_game else j.release_game end
           else case when j.available then j.final_game else j.wanted_game end end as game_id,
      j.available and (j.final_release is distinct from j.wanted_release or j.final_game is distinct from j.wanted_game) as merged
    from judged j
  ), counted as (
    -- Across every entry of the owner, whatever p_ids asks for.
    select s.*, pg_catalog.count(*) over (partition by s.kind, s.release_id, s.game_id, s.wanted_platform, s.wanted_region) > 1 as duplicate
    from shown s
  )
  select s.id, s.kind,
    case
      when not s.available then 'unavailable'
      when s.kind = 'game' and s.wanted_platform is not null and not exists (
        select 1 from public.game_platforms gp where gp.game_id = s.game_id and gp.platform_id = s.wanted_platform and gp.status = 'published')
        then 'platform_unavailable'
      else 'available'
    end,
    s.merged,
    s.duplicate,
    s.game_id, s.release_id,
    coalesce(dr.platform_id, s.wanted_platform), coalesce(dr.region_code, s.wanted_region),
    s.priority, s.completeness, s.created_at,
    pg_catalog.lower(coalesce(dg.sort_title, dg.title, '')),
    case when p_search then
      pg_catalog.regexp_replace(normalize(pg_catalog.lower(coalesce(dg.title, '') || E'\n' || coalesce(dr.local_title, '')), NFKD), '[̀-ͯ]', '', 'g')
    end
  from counted s
  join public.games dg on dg.id = s.game_id
  left join public.releases dr on dr.id = s.release_id
  where p_ids is null or s.id = any (p_ids)
$$;

-- The response for some of one owner's entries, in the order given. The game's slug
-- only while it's published, for its page. For a release entry, the release's own
-- details; for a game entry, the platform and region it names. "owned": the owner's
-- copies that match the entry and aren't preserved (a release entry: copies of that
-- release; a game entry: copies of any release of the game, and unidentified copies of
-- it, on the platform and in the region it names, if it names them), and how many of
-- them meet its lowest acceptable completeness (all of them when it names none).
create function private.wishlist_json(p_owner uuid, p_ids uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id,
      'kind', e.kind,
      'state', e.state,
      'merged', e.merged,
      'duplicate', e.duplicate,
      'priority', e.priority,
      'completeness', e.completeness,
      'note', w.note,
      'added_at', w.created_at,
      'updated_at', w.updated_at,
      'game', pg_catalog.jsonb_build_object('id', g.id, 'title', g.title, 'slug', case when g.status = 'published' then g.slug end),
      'platform', case when pl.id is null then null else pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name) end,
      'region', case when e.region_code is null then null else pg_catalog.jsonb_build_object('code', e.region_code, 'label', rc.label) end,
      'release', case when r.id is null then null else pg_catalog.jsonb_build_object(
        'id', r.id, 'edition_kind', r.edition_kind, 'edition_name', r.edition_name, 'variant_name', r.variant_name,
        'local_title', r.local_title, 'format', pg_catalog.jsonb_build_object('code', r.media_format_code, 'name', mf.name),
        'media_count', r.media_count, 'packaging_code', r.packaging_code, 'product_code', r.product_code) end,
      'owned', pg_catalog.jsonb_build_object('copies', o.copies, 'meeting_completeness', o.meeting)
    ) order by pg_catalog.array_position(p_ids, e.id)), '[]'::jsonb)
  from private.wishlist_entries(p_owner, p_ids) e
  join public.wishlist_items w on w.id = e.id
  join public.games g on g.id = e.game_id
  left join public.releases r on r.id = e.release_id
  left join public.platforms pl on pl.id = e.platform_id
  left join public.region_codes rc on rc.code = e.region_code
  left join public.media_formats mf on mf.code = r.media_format_code
  cross join lateral (
    select pg_catalog.count(*)::integer as copies,
      (pg_catalog.count(*) filter (where e.completeness is null
        or private.completeness_rank(x.completeness) >= private.completeness_rank(e.completeness)))::integer as meeting
    from (
      select c.completeness from public.collection_items c
      where e.kind = 'release' and c.owner_id = p_owner and c.release_id = e.release_id and c.record_status <> 'invalid_preserved'
      union all
      select c.completeness from public.releases rr
      join public.collection_items c on c.release_id = rr.id and c.owner_id = p_owner
      where e.kind = 'game' and rr.game_id = e.game_id and c.record_status <> 'invalid_preserved'
        and rr.status in ('published', 'rejected', 'unverified', 'under_review')
        and (e.platform_id is null or rr.platform_id = e.platform_id)
        and (e.region_code is null or rr.region_code = e.region_code)
      union all
      select c.completeness from public.collection_items c
      where e.kind = 'game' and c.owner_id = p_owner and c.release_id is null and c.claimed_game_id = e.game_id
        and c.record_status <> 'invalid_preserved'
        and (e.platform_id is null or c.claimed_platform_id = e.platform_id)
        and (e.region_code is null or c.claimed_region_code = e.region_code)
    ) x
  ) o
  where e.id = any (p_ids)
$$;

revoke all on function private.completeness_rank(public.completeness) from public, anon, authenticated, service_role;
revoke all on function private.final_release(uuid) from public, anon, authenticated, service_role;
revoke all on function private.final_game(uuid) from public, anon, authenticated, service_role;
revoke all on function private.parse_wishlist_target(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.lock_wishlist_target(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.parse_wishlist_details(jsonb, text[]) from public, anon, authenticated, service_role;
revoke all on function private.wishlist_entries(uuid, uuid[], boolean) from public, anon, authenticated, service_role;
revoke all on function private.wishlist_json(uuid, uuid[]) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Writes
-- ---------------------------------------------------------------------------
-- Definers, so clients need no write grant. Each checks the caller itself: signed in
-- through a live session, and for adding and editing an active account.

-- Adds an entry. p_target as in parse_wishlist_target; p_details as in
-- parse_wishlist_details (priority defaults to normal). Returns {item_id, created}:
-- created is false for a retry of this request (the same id and target), and for a
-- target already on the wishlist, whose existing entry is returned unchanged.
--
-- Errors: 42501 'not permitted', 22023 'invalid item id' / 'invalid target' /
-- 'invalid region' / 'invalid details', P0001 'account not active', 'release
-- unavailable', 'game unavailable', 'platform unavailable' (the catalog doesn't list
-- the game on it), 'wishlist limit reached', 'request conflict' (the id is already
-- used otherwise).
create function public.add_wishlist_item(p_item_id uuid, p_target jsonb, p_details jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_t record;
  v_d record;
  v_existing public.wishlist_items;
  v_rows integer;
  v_other uuid;
begin
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_item_id is null then
    raise exception 'invalid item id' using errcode = '22023';
  end if;
  v_t := private.parse_wishlist_target(p_target);
  v_d := private.parse_wishlist_details(coalesce(p_details, '{}'), '{}');

  -- A repeat of a request that already succeeded.
  select * into v_existing from public.wishlist_items w where w.id = p_item_id;
  if found then
    if v_existing.owner_id = v_me and (v_existing.release_id, v_existing.game_id, v_existing.platform_id, v_existing.region_code)
         is not distinct from (v_t.t_release, v_t.t_game, v_t.t_platform, v_t.t_region) then
      return pg_catalog.jsonb_build_object('item_id', p_item_id, 'created', false);
    end if;
    raise exception 'request conflict' using errcode = 'P0001';
  end if;

  if not (select private.is_active_user()) then
    raise exception 'account not active' using errcode = 'P0001';
  end if;
  perform private.lock_wishlist_target(v_t.t_release, v_t.t_game, v_t.t_platform, v_t.t_region);

  insert into public.wishlist_items (id, owner_id, release_id, game_id, platform_id, region_code, completeness, priority, note)
  values (p_item_id, v_me, v_t.t_release, v_t.t_game, v_t.t_platform, v_t.t_region, v_d.d_completeness, coalesce(v_d.d_priority, 2), v_d.d_note)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    return pg_catalog.jsonb_build_object('item_id', p_item_id, 'created', true);
  end if;

  -- The same request committed meanwhile, or the target is already on the wishlist.
  select * into v_existing from public.wishlist_items w where w.id = p_item_id;
  if found then
    if v_existing.owner_id = v_me and (v_existing.release_id, v_existing.game_id, v_existing.platform_id, v_existing.region_code)
         is not distinct from (v_t.t_release, v_t.t_game, v_t.t_platform, v_t.t_region) then
      return pg_catalog.jsonb_build_object('item_id', p_item_id, 'created', false);
    end if;
    raise exception 'request conflict' using errcode = 'P0001';
  end if;
  select w.id into v_other from public.wishlist_items w
  where w.owner_id = v_me
    and (w.release_id, w.game_id, w.platform_id, w.region_code) is not distinct from (v_t.t_release, v_t.t_game, v_t.t_platform, v_t.t_region);
  if found then
    return pg_catalog.jsonb_build_object('item_id', v_other, 'created', false);
  end if;
  raise exception 'request conflict' using errcode = 'P0001';
end;
$$;

-- Changes an entry: any of "target" (another level of want or another record, as in
-- add_wishlist_item), "completeness", "priority" and "note" (null clears the note or
-- the completeness). A new target must be published; an unchanged one isn't checked
-- again, so an entry whose record left the catalog can still be edited. Returns
-- {item_id, changed}.
--
-- Errors: 42501 'not permitted', 22023 'invalid target' / 'invalid region' / 'invalid
-- details', P0001 'account not active', 'item unavailable', 'release unavailable',
-- 'game unavailable', 'platform unavailable', 'already on wishlist' (another entry
-- has that target), 'request conflict' (its target changed meanwhile; retryable).
create function public.update_wishlist_item(p_item uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_t record;
  v_d record;
  v_old public.wishlist_items;
  v_locked public.wishlist_items;
  v_new public.wishlist_items;
begin
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_d := private.parse_wishlist_details(p_changes, array['target']);
  if p_changes ? 'target' then
    v_t := private.parse_wishlist_target(p_changes -> 'target');
  end if;
  if not (select private.is_active_user()) then
    raise exception 'account not active' using errcode = 'P0001';
  end if;
  select * into v_old from public.wishlist_items w where w.id = p_item and w.owner_id = v_me;
  if not found then
    raise exception 'item unavailable' using errcode = 'P0001';
  end if;

  v_new := v_old;
  if p_changes ? 'target' then
    v_new.release_id := v_t.t_release;
    v_new.game_id := v_t.t_game;
    v_new.platform_id := v_t.t_platform;
    v_new.region_code := v_t.t_region;
  end if;
  -- Catalog rows before the entry, as everywhere.
  if (v_new.release_id, v_new.game_id, v_new.platform_id, v_new.region_code)
     is distinct from (v_old.release_id, v_old.game_id, v_old.platform_id, v_old.region_code) then
    perform private.lock_wishlist_target(v_new.release_id, v_new.game_id, v_new.platform_id, v_new.region_code);
  end if;
  select * into v_locked from public.wishlist_items w where w.id = p_item and w.owner_id = v_me for update;
  if not found then
    raise exception 'item unavailable' using errcode = 'P0001';
  end if;
  -- Changed by another request since it was read: its target may now differ from the
  -- one this request found unchanged, and so didn't check. Retryable.
  if (v_locked.release_id, v_locked.game_id, v_locked.platform_id, v_locked.region_code)
     is distinct from (v_old.release_id, v_old.game_id, v_old.platform_id, v_old.region_code) then
    raise exception 'request conflict' using errcode = 'P0001';
  end if;
  v_old := v_locked;
  if not (p_changes ? 'target') then
    v_new.release_id := v_old.release_id;
    v_new.game_id := v_old.game_id;
    v_new.platform_id := v_old.platform_id;
    v_new.region_code := v_old.region_code;
  end if;
  v_new.completeness := case when 'completeness' = any (v_d.d_keys) then v_d.d_completeness else v_old.completeness end;
  v_new.priority := case when 'priority' = any (v_d.d_keys) then v_d.d_priority else v_old.priority end;
  v_new.note := case when 'note' = any (v_d.d_keys) then v_d.d_note else v_old.note end;

  if (v_new.release_id, v_new.game_id, v_new.platform_id, v_new.region_code, v_new.completeness, v_new.priority, v_new.note)
     is not distinct from (v_old.release_id, v_old.game_id, v_old.platform_id, v_old.region_code, v_old.completeness, v_old.priority, v_old.note) then
    return pg_catalog.jsonb_build_object('item_id', p_item, 'changed', false);
  end if;
  begin
    update public.wishlist_items w set
      release_id = v_new.release_id, game_id = v_new.game_id, platform_id = v_new.platform_id, region_code = v_new.region_code,
      completeness = v_new.completeness, priority = v_new.priority, note = v_new.note
    where w.id = p_item;
  exception when unique_violation then
    raise exception 'already on wishlist' using errcode = 'P0001';
  end;
  return pg_catalog.jsonb_build_object('item_id', p_item, 'changed', true);
end;
$$;

-- Removes an entry. Allowed for a suspended account, and for an entry whose record
-- left the catalog. Returns true.
--
-- Errors: 42501 'not permitted', P0001 'item unavailable'.
create function public.remove_wishlist_item(p_item uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  delete from public.wishlist_items w where w.id = p_item and w.owner_id = v_me;
  if not found then
    raise exception 'item unavailable' using errcode = 'P0001';
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Reads
-- ---------------------------------------------------------------------------
-- Definers, so an entry whose record left the catalog can still be shown to its owner
-- (the caller's own reads can't see an excluded record). Each reads only the caller's
-- own entries, through a live session; anyone else gets 'not permitted'.

-- One page of the caller's wishlist. Filters: a title (the game's, or the release's
-- local title, ignoring case and accents), a platform slug, a region code and a
-- priority. An entry that names no platform matches no platform filter, and one that
-- names no region no region filter. Sorts: priority (high first, then newest), added
-- (newest first) or title. Returns {items, next_cursor, total}: total counts every
-- entry, whatever the filters. A cursor belongs to the filters and sort that made it.
--
-- Errors: 42501 'not permitted', 22023 'invalid filter' / 'query too long' / 'invalid
-- cursor'.
create function public.get_my_wishlist(
  p_query text default null,
  p_platform text default null,
  p_region text default null,
  p_priority integer default null,
  p_sort text default 'priority',
  p_limit integer default 50,
  p_cursor text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_sort text := coalesce(p_sort, 'priority');
  v_query text;
  v_hash text;
  v_cursor jsonb;
  c_priority smallint;
  c_added timestamptz;
  c_title text;
  c_id uuid;
  v_ids uuid[];
  v_more boolean;
  v_last_priority smallint;
  v_last_added timestamptz;
  v_last_title text;
  v_next text;
begin
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_sort <> all (array['priority', 'added', 'title']) or p_priority not between 1 and 3
     or pg_catalog.char_length(p_platform) > 64 or pg_catalog.char_length(p_region) > 32 then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  if pg_catalog.char_length(p_query) > 100 then
    raise exception 'query too long' using errcode = '22023';
  end if;
  v_query := nullif(pg_catalog.regexp_replace(normalize(pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, ''))), NFKD), '[̀-ͯ]', '', 'g'), '');
  v_hash := pg_catalog.md5(pg_catalog.jsonb_build_array(v_query, p_platform, p_region, p_priority, v_sort)::text);

  if p_cursor is not null then
    begin
      v_cursor := pg_catalog.convert_from(pg_catalog.decode(pg_catalog.translate(p_cursor, '-_', '+/') ||
        pg_catalog.repeat('=', (4 - pg_catalog.length(p_cursor) % 4) % 4), 'base64'), 'UTF8')::jsonb;
      if pg_catalog.jsonb_typeof(v_cursor) <> 'array' or pg_catalog.jsonb_array_length(v_cursor) <> 5 or v_cursor ->> 0 is distinct from v_hash then
        raise exception using errcode = '22023';
      end if;
      c_priority := (v_cursor ->> 1)::smallint;
      c_added := (v_cursor ->> 2)::timestamptz;
      c_title := v_cursor ->> 3;
      c_id := (v_cursor ->> 4)::uuid;
      if c_id is null or c_priority is null or c_added is null or c_title is null then
        raise exception using errcode = '22023';
      end if;
    exception when others then
      raise exception 'invalid cursor' using errcode = '22023';
    end;
  end if;

  -- The page's ids, one more to know there's another page, and the last one's keys.
  with page as (
    select e.id, e.priority, e.created_at, e.title_key,
      pg_catalog.row_number() over (order by
        case when v_sort = 'priority' then e.priority end,
        case when v_sort = 'title' then e.title_key end,
        case when v_sort <> 'title' then e.created_at end desc,
        case when v_sort = 'title' then e.id end,
        case when v_sort <> 'title' then e.id end desc) as n
    from private.wishlist_entries(v_me, null, v_query is not null) e
    left join public.platforms pl on pl.id = e.platform_id
    where (p_platform is null or pl.slug = p_platform)
      and (p_region is null or e.region_code = p_region)
      and (p_priority is null or e.priority = p_priority)
      and (v_query is null or pg_catalog.strpos(e.search_key, v_query) > 0)
      and (c_id is null
        or (v_sort = 'added' and (e.created_at, e.id) < (c_added, c_id))
        or (v_sort = 'priority' and (e.priority > c_priority or (e.priority = c_priority and (e.created_at, e.id) < (c_added, c_id))))
        or (v_sort = 'title' and (e.title_key, e.id) > (c_title, c_id)))
  )
  select pg_catalog.array_agg(p.id order by p.n) filter (where p.n <= v_limit), coalesce(bool_or(p.n > v_limit), false),
    max(p.priority) filter (where p.n = v_limit), max(p.created_at) filter (where p.n = v_limit), max(p.title_key) filter (where p.n = v_limit)
  into v_ids, v_more, v_last_priority, v_last_added, v_last_title
  from page p where p.n <= v_limit + 1;

  if v_more then
    v_next := pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(v_hash, v_last_priority, v_last_added, v_last_title, v_ids[v_limit])::text, 'UTF8'), 'base64'), E'+/\n', '-_'), '=');
  end if;
  return pg_catalog.jsonb_build_object(
    'items', private.wishlist_json(v_me, coalesce(v_ids, '{}')),
    'next_cursor', v_next,
    'total', (select pg_catalog.count(*) from public.wishlist_items w where w.owner_id = v_me));
end;
$$;

-- The caller's entries for one game, for its page: release entries of its releases and
-- game entries of it, after merges. High priority first, then newest. At most 200.
-- Returns {items}.
--
-- Errors: 42501 'not permitted'.
create function public.get_my_wishlist_for_game(p_game uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object('items', private.wishlist_json(v_me, coalesce((
    select pg_catalog.array_agg(x.id order by x.priority, x.created_at desc, x.id desc)
    from (
      select e.id, e.priority, e.created_at from private.wishlist_entries(v_me) e
      where e.game_id = p_game
      order by e.priority, e.created_at desc, e.id desc
      limit 200
    ) x), '{}')));
end;
$$;

-- One of the caller's entries, for its edit page, or null.
--
-- Errors: 42501 'not permitted'.
create function public.get_my_wishlist_item(p_item uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return private.wishlist_json(v_me, array[p_item]) -> 0;
end;
$$;

revoke all on function public.add_wishlist_item(uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.update_wishlist_item(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.remove_wishlist_item(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_wishlist(text, text, text, integer, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.get_my_wishlist_for_game(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_wishlist_item(uuid) from public, anon, authenticated, service_role;
grant execute on function public.add_wishlist_item(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.update_wishlist_item(uuid, jsonb) to authenticated;
grant execute on function public.remove_wishlist_item(uuid) to authenticated;
grant execute on function public.get_my_wishlist(text, text, text, integer, text, integer, text) to authenticated;
grant execute on function public.get_my_wishlist_for_game(uuid) to authenticated;
grant execute on function public.get_my_wishlist_item(uuid) to authenticated;
