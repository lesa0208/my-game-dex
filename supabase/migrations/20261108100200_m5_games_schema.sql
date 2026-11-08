-- M5a Catalog: games, the platforms they have physical releases on, and the
-- relations between games.
--
-- Design: docs/architecture/database-schema.md#games
-- Clients have no write path: catalog editors change these through the functions in
-- 20261108100500. Reads follow status: published and merged rows are public, and
-- everything else is visible only to catalog editors and, from M7, the submitter.
-- Publication rules that span tables are in the releases migration.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.games (
  id uuid primary key default gen_random_uuid(),
  -- Assigned on publication, and fixed from then on.
  slug text check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 120),
  title text not null check (char_length(title) between 1 and 200 and title = btrim(title)),
  sort_title text not null check (char_length(sort_title) between 1 and 200 and sort_title = btrim(sort_title)),
  kind public.game_kind not null default 'game',
  summary text check (char_length(summary) between 1 and 2000),
  first_release_date date,
  first_release_precision public.date_precision not null default 'unknown',
  status public.catalog_status not null default 'unverified',
  merged_into_id uuid references public.games (id) on delete restrict,
  -- From M7. Cleared on publication, so a public row never shows who submitted it.
  submitted_by uuid references public.profiles (id) on delete set null,
  -- Editorial verification, separate from publication.
  verified_at timestamptz,
  verified_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint games_merged_consistent check ((status = 'merged') = (merged_into_id is not null)),
  constraint games_not_merged_into_self check (merged_into_id is distinct from id),
  constraint games_published_has_slug check (status <> 'published' or slug is not null),
  constraint games_published_verified check (status <> 'published' or verified_at is not null),
  constraint games_submitter_cleared check (status in ('unverified', 'under_review', 'rejected', 'excluded') or submitted_by is null),
  constraint games_verifier_needs_time check (verified_by is null or verified_at is not null),
  constraint games_date_precision check ((first_release_date is null) = (first_release_precision = 'unknown'))
);

create unique index games_slug_key on public.games (slug) where slug is not null;
create index games_status_sort_idx on public.games (status, sort_title);
create index games_merged_into_idx on public.games (merged_into_id) where merged_into_id is not null;
create index games_submitted_by_idx on public.games (submitted_by) where submitted_by is not null;
create index games_verified_by_idx on public.games (verified_by) where verified_by is not null;

-- Which platforms a game has physical releases on. Its own status keeps an
-- unreviewed pairing out of the public catalog. Published only together with a
-- published release on that platform.
create table public.game_platforms (
  game_id uuid not null references public.games (id) on delete cascade,
  platform_id uuid not null references public.platforms (id) on delete restrict,
  status public.catalog_status not null default 'unverified',
  submitted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (game_id, platform_id),
  constraint game_platforms_status check (status in ('unverified', 'under_review', 'published', 'rejected', 'excluded')),
  constraint game_platforms_submitter_cleared check (status in ('unverified', 'under_review', 'rejected', 'excluded') or submitted_by is null)
);

create index game_platforms_published_idx on public.game_platforms (platform_id, game_id) where status = 'published';
create index game_platforms_status_idx on public.game_platforms (game_id, status);
create index game_platforms_submitted_by_idx on public.game_platforms (submitted_by) where submitted_by is not null;

-- Remakes, remasters and compilation contents, decided by editors (ADR-026). Ports
-- and re-releases are the same game, so they never appear here.
create table public.game_relations (
  source_game_id uuid not null references public.games (id) on delete cascade,
  target_game_id uuid not null references public.games (id) on delete cascade,
  relation public.game_relation_type not null,
  position smallint check (position between 1 and 999),
  note text check (char_length(note) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_game_id, target_game_id, relation),
  constraint game_relations_not_self check (source_game_id <> target_game_id),
  constraint game_relations_position_for_contents check (position is null or relation = 'contains')
);

create index game_relations_target_idx on public.game_relations (target_game_id, relation);

-- ---------------------------------------------------------------------------
-- 2. Integrity triggers
-- ---------------------------------------------------------------------------

-- Published records stay published in M5: there's no unpublishing (M5 decision).
-- M7 adds merging and exclusion. A published game's slug never changes.
create function private.guard_published_catalog_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'published' and new.status not in ('published', 'merged', 'excluded') then
    raise exception 'published catalog records can''t be unpublished' using errcode = 'check_violation';
  end if;
  if tg_table_name = 'games' then
    -- Read through to_jsonb, because other tables using this trigger have no slug.
    if old.status in ('published', 'merged') and to_jsonb(new) ->> 'slug' is distinct from to_jsonb(old) ->> 'slug' then
      raise exception 'a published game''s slug can''t be changed' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_published_catalog_row before update on public.games
  for each row execute function private.guard_published_catalog_row();
create trigger guard_published_catalog_row before update on public.game_platforms
  for each row execute function private.guard_published_catalog_row();

-- Only a compilation can contain other games.
create function private.validate_game_relation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.relation = 'contains' and not exists (
    select 1 from public.games g where g.id = new.source_game_id and g.kind = 'compilation'
  ) then
    raise exception 'only a compilation can contain other games' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger validate_game_relation before insert or update on public.game_relations
  for each row execute function private.validate_game_relation();

create trigger set_updated_at before update on public.games
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.game_platforms
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.game_relations
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Read helpers
-- ---------------------------------------------------------------------------

-- An active, verified catalog editor or administrator. Policies call it once per
-- query through a scalar subquery.
create function private.is_catalog_editor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_user() and private.has_staff_role('catalog_editor')
$$;

-- ---------------------------------------------------------------------------
-- 4. Access: RLS reads only. No client role can write.
-- ---------------------------------------------------------------------------

alter table public.games enable row level security;
alter table public.game_platforms enable row level security;
alter table public.game_relations enable row level security;

create policy games_read_anon on public.games
  for select to anon
  using (status in ('published', 'merged'));
create policy games_read_authenticated on public.games
  for select to authenticated
  using (
    status in ('published', 'merged')
    or (submitted_by = (select auth.uid()) and status in ('unverified', 'under_review', 'rejected'))
    or (select private.is_catalog_editor())
  );

create policy game_platforms_read_anon on public.game_platforms
  for select to anon
  using (status = 'published');
create policy game_platforms_read_authenticated on public.game_platforms
  for select to authenticated
  using (
    status = 'published'
    or (submitted_by = (select auth.uid()) and status in ('unverified', 'under_review', 'rejected'))
    or (select private.is_catalog_editor())
  );

-- A relation is public only when both games are. The subqueries are themselves
-- subject to the games policies.
create policy game_relations_read_anon on public.game_relations
  for select to anon
  using (
    exists (select 1 from public.games g where g.id = source_game_id and g.status = 'published')
    and exists (select 1 from public.games g where g.id = target_game_id and g.status = 'published')
  );
create policy game_relations_read_authenticated on public.game_relations
  for select to authenticated
  using (
    (exists (select 1 from public.games g where g.id = source_game_id and g.status = 'published')
      and exists (select 1 from public.games g where g.id = target_game_id and g.status = 'published'))
    or (select private.is_catalog_editor())
  );

-- Column grants keep who submitted or verified a record out of client reads.
-- service_role has no access: no server job reads the catalog yet.
grant select (id, slug, title, sort_title, kind, summary, first_release_date, first_release_precision, status, merged_into_id, verified_at, created_at, updated_at)
  on public.games to anon, authenticated;
grant select (game_id, platform_id, status, created_at, updated_at)
  on public.game_platforms to anon, authenticated;
grant select on public.game_relations to anon, authenticated;

revoke all on function private.guard_published_catalog_row() from public, anon, authenticated, service_role;
revoke all on function private.validate_game_relation() from public, anon, authenticated, service_role;
revoke all on function private.is_catalog_editor() from public, anon, authenticated, service_role;
grant execute on function private.is_catalog_editor() to authenticated;
