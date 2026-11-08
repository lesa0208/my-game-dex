-- M5a Catalog: physical releases, what they contain, where they were sold, and the
-- hardware they need. Also the publication rules that span games and releases.
--
-- Design: docs/architecture/database-schema.md#releases
-- A release is one specific physical edition. Nothing here is guessed: details the
-- source doesn't state stay null or 'unknown', and publication requires the ones
-- that identify the edition to be set (M5 decision 2). Different editions,
-- packaging, regions and print variants are separate releases (D6). A ROM revision
-- is not, unless an editor confirms a distinct physical product.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.releases (
  id uuid primary key default private.uuid_v7(),
  game_id uuid not null,
  platform_id uuid not null,
  -- 'unknown' when not known. Publishable only once an editor confirms it.
  region_code text not null references public.region_codes (code) on delete restrict,
  region_unknown_confirmed boolean not null default false,
  -- No defaults: an import never invents an edition. Required to publish.
  edition_name text check (char_length(edition_name) between 1 and 120 and edition_name = btrim(edition_name)),
  edition_kind public.edition_kind,
  variant_name text check (char_length(variant_name) between 1 and 120 and variant_name = btrim(variant_name)),
  -- Not unique: reprints and regional variants can share one. Evidence, never identity.
  product_code text check (char_length(product_code) between 1 and 40 and product_code = btrim(product_code)),
  barcode text check (barcode ~ '^[0-9]{8,14}$'),
  local_title text check (char_length(local_title) between 1 and 200 and local_title = btrim(local_title)),
  publisher_name text check (char_length(publisher_name) between 1 and 120 and publisher_name = btrim(publisher_name)),
  -- Required: a release is always on a physical medium.
  media_format_code text not null,
  media_count smallint check (media_count between 1 and 30),
  media_playability public.media_playability not null default 'unknown',
  packaging text check (char_length(packaging) between 1 and 80 and packaging = btrim(packaging)),
  -- BCP 47 tags, as printed on the package.
  languages text[] check (
    cardinality(languages) between 1 and 40
    and array_position(languages, null) is null
    and array_to_string(languages, ',') ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*(,[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)*$'
  ),
  rating_labels text[] check (
    cardinality(rating_labels) between 1 and 20
    and array_position(rating_labels, null) is null
    and char_length(array_to_string(rating_labels, '')) <= 400
  ),
  release_date date,
  release_date_precision public.date_precision not null default 'unknown',
  status public.catalog_status not null default 'unverified',
  merged_into_id uuid references public.releases (id) on delete restrict,
  submitted_by uuid references public.profiles (id) on delete set null,
  verified_at timestamptz,
  verified_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A release can't exist for a pairing that isn't recorded, or use a format its
  -- platform doesn't have. This keeps AES and MVS cartridges apart.
  foreign key (game_id, platform_id) references public.game_platforms (game_id, platform_id) on delete restrict,
  foreign key (platform_id, media_format_code) references public.platform_media_formats (platform_id, media_format_code) on delete restrict,
  -- Lets later tables keep game and release consistent with one composite key.
  unique (id, game_id),
  constraint releases_merged_consistent check ((status = 'merged') = (merged_into_id is not null)),
  constraint releases_not_merged_into_self check (merged_into_id is distinct from id),
  constraint releases_submitter_cleared check (status in ('unverified', 'under_review', 'rejected', 'excluded') or submitted_by is null),
  constraint releases_verifier_needs_time check (verified_by is null or verified_at is not null),
  constraint releases_date_precision check ((release_date is null) = (release_date_precision = 'unknown')),
  constraint releases_published_verified check (status <> 'published' or verified_at is not null),
  constraint releases_published_complete check (
    status <> 'published' or (edition_name is not null and edition_kind is not null and media_count is not null)
  ),
  constraint releases_published_region check (status <> 'published' or region_code <> 'unknown' or region_unknown_confirmed),
  constraint releases_region_confirmation check (not region_unknown_confirmed or region_code = 'unknown')
);

-- Published identity (D6). Markets aren't part of it, so one package sold in several
-- countries stays one release. Unpublished candidates aren't covered, so a duplicate
-- error never reveals someone else's submission.
create unique index releases_published_identity_key on public.releases
  (game_id, platform_id, region_code, edition_name, variant_name, packaging, product_code)
  nulls not distinct
  where status = 'published';

-- One user can't submit the same release twice (M7). Imported and editor candidates
-- have no submitter, and are deduplicated by review instead.
create unique index releases_pending_submission_key on public.releases
  (submitted_by, game_id, platform_id, region_code, edition_name, variant_name, packaging, product_code)
  nulls not distinct
  where status in ('unverified', 'under_review') and submitted_by is not null;

create index releases_game_platform_region_idx on public.releases (game_id, platform_id, region_code);
create index releases_platform_region_date_idx on public.releases (platform_id, region_code, release_date desc);
create index releases_barcode_idx on public.releases (barcode) where barcode is not null;
create index releases_product_code_idx on public.releases (product_code) where product_code is not null;
create index releases_review_queue_idx on public.releases (status, created_at) where status in ('unverified', 'under_review');
create index releases_merged_into_idx on public.releases (merged_into_id) where merged_into_id is not null;
create index releases_submitted_by_idx on public.releases (submitted_by) where submitted_by is not null;
create index releases_verified_by_idx on public.releases (verified_by) where verified_by is not null;
create index releases_format_idx on public.releases (platform_id, media_format_code);

-- Countries the release is known to have been sold in. No row means not known, never
-- "not sold there".
create table public.release_markets (
  release_id uuid not null references public.releases (id) on delete cascade,
  market_code text not null references public.markets (code) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (release_id, market_code)
);

create index release_markets_market_idx on public.release_markets (market_code, release_id);

-- What an edition included beyond its primary medium. Describes the edition and is
-- never owned by anyone.
create table public.release_components (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.releases (id) on delete cascade,
  kind public.component_kind not null,
  label text not null check (char_length(label) between 1 and 120 and label = btrim(label)),
  quantity smallint not null default 1 check (quantity between 1 and 99),
  media_format_code text,
  platform_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (platform_id, media_format_code) references public.platform_media_formats (platform_id, media_format_code) on delete restrict,
  unique (release_id, kind, label),
  constraint release_components_media check ((kind = 'game_media') = (media_format_code is not null)),
  constraint release_components_media_platform check ((kind = 'game_media') = (platform_id is not null))
);

create index release_components_format_idx on public.release_components (platform_id, media_format_code) where platform_id is not null;

-- No row means nothing is recorded, never "runs on everything".
create table public.release_hardware_requirements (
  release_id uuid not null references public.releases (id) on delete cascade,
  requirement_code text not null references public.hardware_requirements (code) on delete restrict,
  level public.requirement_level not null,
  note text check (char_length(note) between 1 and 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (release_id, requirement_code)
);

create index release_hardware_requirements_code_idx on public.release_hardware_requirements (requirement_code);

-- ---------------------------------------------------------------------------
-- 2. Integrity triggers
-- ---------------------------------------------------------------------------

create trigger guard_published_catalog_row before update on public.releases
  for each row execute function private.guard_published_catalog_row();

create trigger set_updated_at before update on public.releases
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.release_components
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.release_hardware_requirements
  for each row execute function private.set_updated_at();

-- A game is cataloged only for its physical editions (ADR-025): it has a published
-- release of its own, or a published compilation containing it has one.
create function private.game_has_published_release(p_game uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.releases r where r.game_id = p_game and r.status = 'published')
      or exists (
        select 1
        from public.game_relations gr
        join public.games c on c.id = gr.source_game_id and c.status = 'published'
        join public.releases r on r.game_id = c.id and r.status = 'published'
        where gr.target_game_id = p_game and gr.relation = 'contains'
      )
$$;

-- Checked at commit, so one transaction can publish a game, its platform and its
-- first release together. Each check rereads the committed-to-be state.
--
-- SECURITY DEFINER because a deferred trigger runs at commit as the session's role,
-- which for an API call is the caller, outside the editor function that made the
-- change. It only reads, and raises on a violation.
create function private.check_catalog_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game uuid;
  v_platform uuid;
begin
  if tg_table_name = 'releases' then
    v_game := new.game_id;
    v_platform := new.platform_id;
    if exists (
      select 1 from public.releases r
      where r.id = new.id and r.status = 'published'
        and not (
          exists (select 1 from public.games g where g.id = r.game_id and g.status = 'published')
          and exists (select 1 from public.game_platforms gp where gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published')
        )
    ) then
      raise exception 'a release can be published only with its game and platform' using errcode = 'check_violation';
    end if;
  elsif tg_table_name = 'game_platforms' then
    v_game := new.game_id;
    v_platform := new.platform_id;
  else
    v_game := new.id;
  end if;

  if v_platform is not null and exists (
    select 1 from public.game_platforms gp
    where gp.game_id = v_game and gp.platform_id = v_platform and gp.status = 'published'
      and not (
        exists (select 1 from public.games g where g.id = gp.game_id and g.status = 'published')
        and exists (select 1 from public.releases r where r.game_id = gp.game_id and r.platform_id = gp.platform_id and r.status = 'published')
      )
  ) then
    raise exception 'a platform is published for a game only with a published release on it' using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.games g where g.id = v_game and g.status = 'published')
     and not private.game_has_published_release(v_game) then
    raise exception 'a game is published only with a published physical release' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger check_catalog_publication after insert or update on public.games
  deferrable initially deferred
  for each row execute function private.check_catalog_publication();
create constraint trigger check_catalog_publication after insert or update on public.game_platforms
  deferrable initially deferred
  for each row execute function private.check_catalog_publication();
create constraint trigger check_catalog_publication after insert or update on public.releases
  deferrable initially deferred
  for each row execute function private.check_catalog_publication();

-- ---------------------------------------------------------------------------
-- 3. Read helpers
-- ---------------------------------------------------------------------------

-- Whether the caller may read a release and its details. Child tables use it,
-- because their own rows carry no status.
create function private.can_read_release(p_release uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.releases r
    where r.id = p_release
      and (
        r.status in ('published', 'merged')
        or (r.submitted_by = (select auth.uid()) and r.status in ('unverified', 'under_review', 'rejected'))
        or private.is_catalog_editor()
      )
  )
$$;

-- Whether the caller may attach a copy to a release, for M6. Foreign keys ignore
-- RLS, so collection policies must call this. Never excluded or merged.
create function private.can_use_release(p_release uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.releases r
    where r.id = p_release
      and (
        r.status = 'published'
        or (r.submitted_by = (select auth.uid()) and r.status in ('unverified', 'under_review', 'rejected'))
      )
  )
$$;

-- ---------------------------------------------------------------------------
-- 4. Access: RLS reads only. No client role can write.
-- ---------------------------------------------------------------------------

alter table public.releases enable row level security;
alter table public.release_markets enable row level security;
alter table public.release_components enable row level security;
alter table public.release_hardware_requirements enable row level security;

create policy releases_read_anon on public.releases
  for select to anon
  using (status in ('published', 'merged'));
create policy releases_read_authenticated on public.releases
  for select to authenticated
  using (
    status in ('published', 'merged')
    or (submitted_by = (select auth.uid()) and status in ('unverified', 'under_review', 'rejected'))
    or (select private.is_catalog_editor())
  );

create policy release_markets_read on public.release_markets
  for select to anon, authenticated
  using (private.can_read_release(release_id));
create policy release_components_read on public.release_components
  for select to anon, authenticated
  using (private.can_read_release(release_id));
create policy release_hardware_requirements_read on public.release_hardware_requirements
  for select to anon, authenticated
  using (private.can_read_release(release_id));

grant select (id, game_id, platform_id, region_code, region_unknown_confirmed, edition_name, edition_kind, variant_name,
              product_code, barcode, local_title, publisher_name, media_format_code, media_count, media_playability,
              packaging, languages, rating_labels, release_date, release_date_precision, status, merged_into_id,
              verified_at, created_at, updated_at)
  on public.releases to anon, authenticated;
grant select on public.release_markets to anon, authenticated;
grant select on public.release_components to anon, authenticated;
grant select on public.release_hardware_requirements to anon, authenticated;

revoke all on function private.game_has_published_release(uuid) from public, anon, authenticated, service_role;
revoke all on function private.check_catalog_publication() from public, anon, authenticated, service_role;
revoke all on function private.can_read_release(uuid) from public, anon, authenticated, service_role;
revoke all on function private.can_use_release(uuid) from public, anon, authenticated, service_role;
grant execute on function private.can_read_release(uuid) to anon, authenticated;
grant execute on function private.can_use_release(uuid) to authenticated;
