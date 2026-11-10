-- M5a Catalog: where catalog data came from, and the editor's protection against
-- re-imports.
--
-- Design: docs/architecture/database-schema.md#metadata-providers
-- Every table is in the private schema, with no access for any API role. Imports
-- (M5b) run from an operator tool with a direct database connection. Imported
-- entries are only candidates: nothing here publishes anything, and a provider entry
-- is never taken as proof of a verified physical release.

-- ---------------------------------------------------------------------------
-- 1. Sources
-- ---------------------------------------------------------------------------

-- A data source. No source is used in production until its terms are reviewed and
-- commercial use is cleared (D14). Metadata clearance never covers artwork (D15).
create table private.external_providers (
  code text primary key check (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(code) <= 40),
  name text not null unique check (char_length(name) between 1 and 80),
  terms_url text check (terms_url ~ '^https?://' and char_length(terms_url) <= 500),
  -- The terms as reviewed: a hash of the saved copy, and when it was taken.
  terms_sha256 text check (terms_sha256 ~ '^[0-9a-f]{64}$'),
  terms_reviewed_at timestamptz,
  commercial_use_cleared boolean not null default false,
  cleared_note text check (char_length(cleared_note) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_providers_clearance_recorded check (not commercial_use_cleared or (terms_sha256 is not null and terms_reviewed_at is not null and cleared_note is not null))
);

-- One import of one source snapshot. The snapshot itself stays outside the
-- repository and the database: this records its name, hash and when it was fetched,
-- so every candidate can be traced to the exact file. checkpoint lets an interrupted
-- run resume.
create table private.import_runs (
  id uuid primary key default private.uuid_v7(),
  provider_code text not null references private.external_providers (code) on delete restrict,
  platform_id uuid references public.platforms (id) on delete restrict,
  source_name text not null check (char_length(source_name) between 1 and 300),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_fetched_at timestamptz not null,
  terms_sha256 text check (terms_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'abandoned')),
  checkpoint jsonb not null default '{}' check (jsonb_typeof(checkpoint) = 'object'),
  stats jsonb not null default '{}' check (jsonb_typeof(stats) = 'object'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint import_runs_finished check ((status = 'running') = (finished_at is null))
);

create index import_runs_provider_idx on private.import_runs (provider_code, started_at desc);
create index import_runs_platform_idx on private.import_runs (platform_id) where platform_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Candidates
-- ---------------------------------------------------------------------------

-- One normalized source entry, as the source stated it. Re-importing an unchanged
-- entry matches the unique key and adds nothing. A changed entry is a new row, for
-- review. matched_* records the matcher's proposal, never a decision.
create table private.provider_records (
  id uuid primary key default private.uuid_v7(),
  provider_code text not null references private.external_providers (code) on delete restrict,
  entity_type text not null check (entity_type in ('game', 'release')),
  external_id text not null check (char_length(external_id) between 1 and 200),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 32768),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  import_run_id uuid not null references private.import_runs (id) on delete restrict,
  status public.provider_record_status not null default 'fetched',
  match_tier text check (match_tier in ('A', 'B', 'C')),
  match_notes jsonb not null default '{}' check (jsonb_typeof(match_notes) = 'object' and pg_column_size(match_notes) <= 8192),
  matched_game_id uuid references public.games (id) on delete set null,
  matched_release_id uuid references public.releases (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_code, entity_type, external_id, payload_sha256),
  constraint provider_records_release_match check (entity_type = 'release' or matched_release_id is null)
);

create index provider_records_run_idx on private.provider_records (import_run_id);
create index provider_records_status_idx on private.provider_records (provider_code, status);
create index provider_records_game_idx on private.provider_records (matched_game_id) where matched_game_id is not null;
create index provider_records_release_idx on private.provider_records (matched_release_id) where matched_release_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Provenance of catalog records
-- ---------------------------------------------------------------------------

-- A source's identifier for one of our games or releases, such as a Wikidata item.
-- One external entry identifies at most one record. A record can have several, for
-- example two ROM revisions of one physical release.
create table private.external_references (
  id uuid primary key default gen_random_uuid(),
  provider_code text not null references private.external_providers (code) on delete restrict,
  external_id text not null check (char_length(external_id) between 1 and 200),
  game_id uuid references public.games (id) on delete cascade,
  release_id uuid references public.releases (id) on delete cascade,
  entity_type text generated always as (case when game_id is not null then 'game' else 'release' end) stored,
  created_at timestamptz not null default now(),
  constraint external_references_one_target check (num_nonnulls(game_id, release_id) = 1),
  unique (provider_code, entity_type, external_id)
);

create index external_references_game_idx on private.external_references (game_id) where game_id is not null;
create index external_references_release_idx on private.external_references (release_id) where release_id is not null;

-- Which source records support which field of a release. Batch publication (M5b)
-- needs every required field supported here. Game-level data never counts as
-- release evidence, and a matching serial is evidence, never identity.
create table private.release_evidence (
  release_id uuid not null references public.releases (id) on delete cascade,
  field_name text not null check (field_name in (
    'game', 'platform', 'region_code', 'edition_name', 'edition_kind', 'variant_name', 'product_code', 'barcode',
    'local_title', 'publisher_name', 'media_format_code', 'media_count', 'packaging', 'languages', 'rating_labels',
    'release_date', 'markets'
  )),
  provider_record_id uuid not null references private.provider_records (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (release_id, field_name, provider_record_id)
);

create index release_evidence_record_idx on private.release_evidence (provider_record_id);

create function private.validate_release_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from private.provider_records pr where pr.id = new.provider_record_id and pr.entity_type = 'release'
  ) then
    raise exception 'release evidence must come from a release-level source record' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger validate_release_evidence before insert or update on private.release_evidence
  for each row execute function private.validate_release_evidence();
revoke all on function private.validate_release_evidence() from public, anon, authenticated, service_role;

-- Fields an editor has fixed. Imports never overwrite them.
create table private.catalog_field_locks (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references public.games (id) on delete cascade,
  release_id uuid references public.releases (id) on delete cascade,
  field_name text not null check (field_name ~ '^[a-z_]+$' and char_length(field_name) <= 40),
  locked_by uuid references public.profiles (id) on delete set null,
  locked_at timestamptz not null default now(),
  constraint catalog_field_locks_one_target check (num_nonnulls(game_id, release_id) = 1)
);

create unique index catalog_field_locks_key on private.catalog_field_locks (game_id, release_id, field_name) nulls not distinct;
create index catalog_field_locks_release_idx on private.catalog_field_locks (release_id) where release_id is not null;
create index catalog_field_locks_locked_by_idx on private.catalog_field_locks (locked_by) where locked_by is not null;

create trigger set_updated_at before update on private.external_providers
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on private.provider_records
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Access: none for any API role.
-- ---------------------------------------------------------------------------

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'private.external_providers', 'private.import_runs', 'private.provider_records',
    'private.external_references', 'private.release_evidence', 'private.catalog_field_locks'
  ] loop
    execute format('alter table %s enable row level security', v_table);
    execute format('revoke all on table %s from public, anon, authenticated, service_role', v_table);
  end loop;
end;
$$;
