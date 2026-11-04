-- M1 Reference: structure
--
-- Read-only reference data: region codes, markets, platforms and their names,
-- physical media formats, and hardware requirement definitions. Seed data is in
-- the next migration.
--
-- Design: docs/architecture/database-schema.md#gaming-catalog
-- Every table ships with RLS, a read-only policy and explicit grants. M0's default
-- privileges mean nothing here is reachable without those grants. There is no
-- client write path to any of these tables.

-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------
-- M0's media_format enum couldn't separate a general category from a specific
-- format without a value per proprietary format, so media_formats replaces it.
-- Nothing depends on the old type.

drop type public.media_format;

create type public.media_category as enum ('cartridge', 'optical_disc', 'solid_state_card', 'magnetic_disk', 'magnetic_tape');
create type public.hardware_requirement_kind as enum ('revision', 'add_on', 'compatibility_mode');

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- The collector-facing classification of a physical release. No table maps a
-- code to countries, because regional conventions vary by platform and generation.
create table public.region_codes (
  code text primary key check (code ~ '^[a-z]+(-[a-z]+)*$'),
  label text not null unique check (char_length(label) between 1 and 40),
  description text not null,
  position smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Countries and territories by ISO 3166-1 alpha-2 code. Groupings such as
-- "Nordics" aren't stored, and nothing here refers to region_codes.
create table public.markets (
  code text primary key check (code ~ '^[A-Z]{2}$'),
  name text not null unique check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A software platform, not a piece of collectible hardware. Hardware revisions
-- and regional names don't create rows here.
create table public.platforms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null unique check (char_length(name) between 1 and 80),
  short_name text not null check (char_length(short_name) between 1 and 30),
  manufacturer text check (char_length(manufacturer) between 1 and 80),
  family text not null check (char_length(family) between 1 and 40),
  kind public.platform_kind not null,
  base_platform_id uuid references public.platforms (id) on delete restrict,
  released_year smallint check (released_year between 1970 and 2100),
  notes text check (char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (base_platform_id is distinct from id)
);

create index platforms_family_idx on public.platforms (family, name);
create index platforms_base_platform_idx on public.platforms (base_platform_id) where base_platform_id is not null;
create index platforms_name_trgm_idx on public.platforms using gin (name extensions.gin_trgm_ops);

-- Regional names and common aliases. A shared name never implies that hardware
-- or media are interchangeable. A null region means a general alias.
create table public.platform_names (
  platform_id uuid not null references public.platforms (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  region_code text references public.region_codes (code) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (platform_id, name, region_code)
);

create index platform_names_region_idx on public.platform_names (region_code) where region_code is not null;
create index platform_names_name_trgm_idx on public.platform_names using gin (name extensions.gin_trgm_ops);

-- Genuine physical game media only. A specific row exists when collectors or
-- manufacturers name that format. Otherwise the generic row plus the platform
-- says enough. The CHECK is a backstop, because eligibility is an editorial decision.
create table public.media_formats (
  code text primary key check (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  category public.media_category not null,
  name text not null unique check (char_length(name) between 1 and 60),
  description text,
  position smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (code !~* '(digital|download|key|stream|cloud|licen[cs]e|entitlement)'),
  check (name !~* '(digital|download|key card|stream|cloud|licen[cs]e|entitlement)')
);

create index media_formats_category_idx on public.media_formats (category, position);

-- Which formats a platform's physical games use. M5 will require a Release's
-- platform and format to appear here, through a composite foreign key.
create table public.platform_media_formats (
  platform_id uuid not null references public.platforms (id) on delete cascade,
  media_format_code text not null references public.media_formats (code) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (platform_id, media_format_code)
);

create index platform_media_formats_format_idx on public.platform_media_formats (media_format_code);

-- Capabilities a physical release can need, or be classified by. These are
-- definitions, not hardware anyone owns: nothing connects them to collections.
-- A row is added only when a release needs it.
create table public.hardware_requirements (
  code text primary key check (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  platform_id uuid not null references public.platforms (id) on delete restrict,
  label text not null check (char_length(label) between 1 and 80),
  kind public.hardware_requirement_kind not null,
  description text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform_id, label)
);

-- ---------------------------------------------------------------------------
-- 3. Integrity triggers
-- ---------------------------------------------------------------------------

-- A slug is a platform's stable public identity, so a rename must not change it.
create function private.prevent_slug_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.slug is distinct from old.slug then
    raise exception 'platform slugs are stable and can''t be changed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- An add-on attaches directly to a base platform: no chains of add-ons.
create function private.validate_platform_base()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.base_platform_id is null then
    return new;
  end if;
  if exists (select 1 from public.platforms p where p.id = new.base_platform_id and p.base_platform_id is not null) then
    raise exception 'a base platform can''t itself be an add-on'
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.platforms p where p.base_platform_id = new.id) then
    raise exception 'a platform with add-ons can''t itself be an add-on'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_slug_change() from public, anon, authenticated, service_role;
revoke all on function private.validate_platform_base() from public, anon, authenticated, service_role;

create trigger prevent_slug_change before update of slug on public.platforms
  for each row execute function private.prevent_slug_change();
create trigger validate_platform_base before insert or update of base_platform_id on public.platforms
  for each row execute function private.validate_platform_base();

create trigger set_updated_at before update on public.region_codes
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.markets
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.platforms
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.platform_names
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.media_formats
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.hardware_requirements
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Row Level Security and grants
-- ---------------------------------------------------------------------------
-- Publicly readable, and never client-writable. No role gets a write grant, and
-- no write policy exists. Staff tooling arrives in a later step, through functions.

alter table public.region_codes enable row level security;
alter table public.markets enable row level security;
alter table public.platforms enable row level security;
alter table public.platform_names enable row level security;
alter table public.media_formats enable row level security;
alter table public.platform_media_formats enable row level security;
alter table public.hardware_requirements enable row level security;

create policy region_codes_read on public.region_codes for select to anon, authenticated using (true);
create policy markets_read on public.markets for select to anon, authenticated using (true);
create policy platforms_read on public.platforms for select to anon, authenticated using (true);
create policy platform_names_read on public.platform_names for select to anon, authenticated using (true);
create policy media_formats_read on public.media_formats for select to anon, authenticated using (true);
create policy platform_media_formats_read on public.platform_media_formats for select to anon, authenticated using (true);
create policy hardware_requirements_read on public.hardware_requirements for select to anon, authenticated using (true);

grant select on public.region_codes to anon, authenticated, service_role;
grant select on public.markets to anon, authenticated, service_role;
grant select on public.platforms to anon, authenticated, service_role;
grant select on public.platform_names to anon, authenticated, service_role;
grant select on public.media_formats to anon, authenticated, service_role;
grant select on public.platform_media_formats to anon, authenticated, service_role;
grant select on public.hardware_requirements to anon, authenticated, service_role;
