-- M5b Catalog import: the importer role, its gates and its functions.
--
-- Design: docs/architecture/security-rls.md#catalog-import
-- The operator tool (scripts/catalog-import.mjs) connects as catalog_importer, a
-- role that can do nothing except call the functions in the catalog_import schema.
-- Those functions run as their owner and enforce every rule here:
--
--   1. A run needs a provider whose commercial use is cleared, against the exact
--      terms that were reviewed. Clearance is rechecked on every call.
--   2. Every run event and every catalog change is audited, with no actor and the
--      operator's reason for the run.
--   3. One snapshot is processed by one run at a time, and one run by one process,
--      through a lease.
--   4. Editor field locks are honoured here, not in the tool.
--   5. Release evidence must come from a source record matched to that release.
--   6. A source id already linked to a record is resolved to it before anything is
--      created, under a lock per source id.
--
-- Imports create candidates under review and fill only empty fields of records no
-- editor has verified. Nothing here verifies or publishes, invents an edition,
-- packaging or medium count, or merges releases because their serials match.

-- ---------------------------------------------------------------------------
-- 1. The role
-- ---------------------------------------------------------------------------

-- Created without login. An operator enables login with a password verifier, never
-- a plain password (scripts/catalog-import-role.mjs). Roles outlive a local reset,
-- so an existing role is brought back to these settings.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'catalog_importer') then
    create role catalog_importer nologin noinherit connection limit 4;
  else
    alter role catalog_importer nologin noinherit connection limit 4;
  end if;
end;
$$;
alter role catalog_importer set statement_timeout = '60s';
alter role catalog_importer set lock_timeout = '30s';
alter role catalog_importer set idle_in_transaction_session_timeout = '60s';

create schema catalog_import;
revoke all on schema catalog_import from public;
grant usage on schema catalog_import to catalog_importer;

-- ---------------------------------------------------------------------------
-- 2. Sources and runs
-- ---------------------------------------------------------------------------

-- The pilot sources, not cleared. Clearance is an operator decision, recorded with
-- private.record_provider_clearance.
insert into private.external_providers (code, name) values
  ('wikidata', 'Wikidata'),
  ('no-intro', 'No-Intro')
on conflict (code) do nothing;

-- reason: the operator's reason, used for every audit row of the run.
-- lease: the process working on the run. Another process must wait for it to expire.
alter table private.import_runs
  add column reason text check (char_length(reason) between 1 and 500 and reason = btrim(reason)),
  add column lease_id uuid,
  add column lease_expires_at timestamptz,
  add constraint import_runs_lease check ((lease_id is null) = (lease_expires_at is null)),
  add constraint import_runs_lease_running check (status = 'running' or lease_id is null),
  add constraint import_runs_platform check (platform_id is not null or status <> 'running');

-- One run at a time per snapshot.
create unique index import_runs_one_running_snapshot on private.import_runs (provider_code, source_sha256) where status = 'running';

-- The entries of each run's snapshot, in source order. An unchanged entry from an
-- earlier snapshot is the same provider record, listed again here.
create table private.import_run_records (
  import_run_id uuid not null references private.import_runs (id) on delete cascade,
  provider_record_id uuid not null references private.provider_records (id) on delete cascade,
  position integer not null check (position >= 0),
  primary key (import_run_id, provider_record_id),
  unique (import_run_id, position)
);
create index import_run_records_record_idx on private.import_run_records (provider_record_id);
alter table private.import_run_records enable row level security;
revoke all on table private.import_run_records from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Evidence consistency (gate 5)
-- ---------------------------------------------------------------------------

create or replace function private.validate_release_evidence()
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
  if not exists (
    select 1 from private.provider_records pr where pr.id = new.provider_record_id and pr.matched_release_id = new.release_id
  ) then
    raise exception 'release evidence must come from a source record matched to that release' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- A source record is what the source said: it never changes. Once it supports a
-- release's fields, it can't be matched to another release, unless that release no
-- longer exists.
create function private.guard_provider_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.provider_code, new.entity_type, new.external_id, new.payload, new.payload_sha256, new.import_run_id)
     is distinct from (old.provider_code, old.entity_type, old.external_id, old.payload, old.payload_sha256, old.import_run_id) then
    raise exception 'source records can''t be changed' using errcode = 'check_violation';
  end if;
  if new.matched_release_id is distinct from old.matched_release_id
     and exists (select 1 from private.release_evidence e where e.provider_record_id = old.id)
     and exists (select 1 from public.releases r where r.id = old.matched_release_id) then
    raise exception 'a source record with evidence can''t be matched to another release' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger guard_provider_record before update on private.provider_records
  for each row execute function private.guard_provider_record();

-- ---------------------------------------------------------------------------
-- 4. Clearance, by an operator (gate 1)
-- ---------------------------------------------------------------------------

-- For operators working in SQL, after reviewing a source's terms. terms_sha256 is the
-- hash of the saved copy of the terms. Runs must quote the same hash, so a change of
-- terms needs a new review. Clearing false withdraws it, and stops running imports.
create function private.record_provider_clearance(
  p_code text,
  p_cleared boolean,
  p_terms_url text,
  p_terms_sha256 text,
  p_note text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_note text := private.require_reason(p_note);
begin
  if p_cleared is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  update private.external_providers p set
    commercial_use_cleared = p_cleared,
    terms_url = p_terms_url,
    terms_sha256 = p_terms_sha256,
    terms_reviewed_at = pg_catalog.now(),
    cleared_note = v_note
  where p.code = p_code;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  perform private.record_audit(null, 'catalog_provider_cleared', null, v_note,
    pg_catalog.jsonb_build_object('provider', p_code, 'cleared', p_cleared, 'terms_sha256', p_terms_sha256));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Helpers. None is reachable by any client role or by the importer.
-- ---------------------------------------------------------------------------

-- The provider is cleared against these terms, or the call fails.
create function private.import_require_clearance(p_provider text, p_terms_sha256 text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_provider private.external_providers;
begin
  -- A share lock, so withdrawing clearance waits for calls in progress, and every
  -- call after it is refused.
  select * into v_provider from private.external_providers p where p.code = p_provider for share;
  if not found or not v_provider.commercial_use_cleared then
    raise exception 'provider not cleared' using errcode = 'P0001';
  end if;
  if p_terms_sha256 is distinct from v_provider.terms_sha256 then
    raise exception 'terms not cleared' using errcode = 'P0001';
  end if;
end;
$$;

-- Locks a running run for the caller holding its lease, rechecks clearance, and
-- extends the lease. Every call that changes anything for a run starts here.
create function private.import_run_for(p_run uuid, p_lease uuid)
returns private.import_runs
language plpgsql
set search_path = ''
as $$
declare
  v_run private.import_runs;
begin
  select * into v_run from private.import_runs r where r.id = p_run for update;
  if not found or v_run.status <> 'running' then
    raise exception 'run unavailable' using errcode = 'P0001';
  end if;
  if p_lease is null or v_run.lease_id is distinct from p_lease then
    raise exception 'run in use' using errcode = 'P0001';
  end if;
  perform private.import_require_clearance(v_run.provider_code, v_run.terms_sha256);
  update private.import_runs r set lease_expires_at = pg_catalog.now() + interval '10 minutes' where r.id = p_run
  returning * into v_run;
  return v_run;
end;
$$;

create function private.import_audit(p_run private.import_runs, p_event text, p_details jsonb default '{}')
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform private.record_audit(null, 'catalog_import_run', null, p_run.reason,
    pg_catalog.jsonb_build_object('event', p_event, 'run_id', p_run.id, 'provider', p_run.provider_code,
      'source_sha256', p_run.source_sha256) || coalesce(p_details, '{}'));
end;
$$;

create function private.import_field_locked(p_game uuid, p_release uuid, p_field text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from private.catalog_field_locks l
    where l.field_name = p_field
      and l.game_id is not distinct from p_game
      and l.release_id is not distinct from p_release
  )
$$;

-- Serializes work on one source id, so two runs can't both create a record for it.
create function private.import_lock_source_id(p_provider text, p_entity text, p_external_id text)
returns void
language sql
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catalog-import:' || p_provider || ':' || p_entity || ':' || p_external_id, 0))
$$;

-- Comparable form of a title.
create function private.import_title_key(p_title text)
returns text
language sql
immutable
set search_path = ''
as $$
  select private.slugify(p_title)
$$;

-- Games that a source title could mean, on the run's platform: by title, or by a
-- title a matched source record lists for them.
create function private.import_games_titled(p_platform uuid, p_title text)
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct g.id), '{}')
  from public.games g
  join public.game_platforms gp on gp.game_id = g.id and gp.platform_id = p_platform
  where g.status not in ('merged', 'excluded', 'rejected')
    and private.import_title_key(p_title) is not null
    and (
      private.import_title_key(g.title) = private.import_title_key(p_title)
      or exists (
        select 1 from private.provider_records pr, pg_catalog.jsonb_array_elements_text(
          case when pg_catalog.jsonb_typeof(pr.payload -> 'titles') = 'array' then pr.payload -> 'titles' else '[]' end) t
        where pr.matched_game_id = g.id and pr.entity_type = 'game'
          and private.import_title_key(t) = private.import_title_key(p_title)
      )
    )
$$;

create function private.import_set_record(
  p_record uuid,
  p_status public.provider_record_status,
  p_tier text,
  p_game uuid,
  p_release uuid,
  p_notes jsonb
)
returns void
language sql
set search_path = ''
as $$
  update private.provider_records pr set
    status = p_status,
    match_tier = p_tier,
    matched_game_id = coalesce(p_game, pr.matched_game_id),
    matched_release_id = coalesce(p_release, pr.matched_release_id),
    match_notes = coalesce(p_notes, '{}')
  where pr.id = p_record
$$;

-- A game entry: resolve its source id, or create a candidate unless it may duplicate
-- a game already on the platform.
create function private.import_apply_game(p_run private.import_runs, p_record private.provider_records)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_game public.games;
  v_id uuid;
  v_title text := pg_catalog.btrim(p_record.payload ->> 'title');
  v_date date;
  v_precision public.date_precision;
  v_similar uuid[];
  v_filled text[] := '{}';
begin
  perform private.import_lock_source_id(p_record.provider_code, 'game', p_record.external_id);
  begin
    v_date := (p_record.payload ->> 'first_release_date')::date;
    v_precision := coalesce((p_record.payload ->> 'first_release_precision')::public.date_precision, 'unknown');
  exception when others then
    raise exception 'invalid source entry' using errcode = '22023';
  end;
  if v_date is null then
    v_precision := 'unknown';
  elsif v_precision = 'unknown' then
    v_date := null;
  end if;

  select x.game_id into v_id from private.external_references x
  where x.provider_code = p_record.provider_code and x.entity_type = 'game' and x.external_id = p_record.external_id;

  if found then
    select * into v_game from public.games g where g.id = v_id for update;
    if v_game.status in ('merged', 'excluded', 'rejected') then
      perform private.import_set_record(p_record.id, 'needs_review', 'A', v_id, null,
        pg_catalog.jsonb_build_object('reason', 'linked game is ' || v_game.status));
      return pg_catalog.jsonb_build_object('outcome', 'needs_review', 'game_id', v_id);
    end if;
    -- Fill only what's empty, unlocked and unverified.
    if v_game.status <> 'published' and v_game.verified_at is null and v_game.first_release_date is null and v_date is not null
       and not private.import_field_locked(v_id, null, 'first_release_date')
       and not private.import_field_locked(v_id, null, 'first_release_precision') then
      update public.games g set first_release_date = v_date, first_release_precision = v_precision where g.id = v_id;
      v_filled := array['first_release_date', 'first_release_precision'];
    end if;
    insert into public.game_platforms (game_id, platform_id, status) values (v_id, p_run.platform_id, 'under_review')
    on conflict (game_id, platform_id) do nothing;
    perform private.import_set_record(p_record.id, 'matched', 'A', v_id, null,
      pg_catalog.jsonb_build_object('filled', v_filled, 'kept_editorial', v_game.status = 'published' or v_game.verified_at is not null));
    if cardinality(v_filled) > 0 then
      perform private.record_catalog_audit(null, 'catalog_record_updated', 'game', v_id, p_run.reason,
        pg_catalog.jsonb_build_object('fields', v_filled, 'import_run_id', p_run.id, 'provider_record_id', p_record.id));
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'matched', 'game_id', v_id, 'filled', v_filled);
  end if;

  if v_title is null or v_title = '' then
    raise exception 'invalid source entry' using errcode = '22023';
  end if;

  -- A game on this platform with the same title, not already identified by another
  -- entry of this source, may be the same game.
  select coalesce(pg_catalog.array_agg(s), '{}') into v_similar
  from pg_catalog.unnest(private.import_games_titled(p_run.platform_id, v_title)) s
  where not exists (select 1 from private.external_references x where x.game_id = s and x.provider_code = p_record.provider_code);
  if cardinality(v_similar) > 0 then
    perform private.import_set_record(p_record.id, 'needs_review', 'B', null, null,
      pg_catalog.jsonb_build_object('reason', 'possible duplicate', 'candidates', v_similar));
    return pg_catalog.jsonb_build_object('outcome', 'ambiguous', 'candidates', v_similar);
  end if;

  insert into public.games (title, sort_title, kind, first_release_date, first_release_precision, status)
  values (v_title, v_title, 'game', v_date, v_precision, 'under_review')
  returning id into v_id;
  insert into public.game_platforms (game_id, platform_id, status) values (v_id, p_run.platform_id, 'under_review');
  insert into private.external_references (provider_code, external_id, game_id) values (p_record.provider_code, p_record.external_id, v_id);
  perform private.import_set_record(p_record.id, 'promoted', null, v_id, null, '{}');
  perform private.record_catalog_audit(null, 'catalog_record_created', 'game', v_id, p_run.reason,
    pg_catalog.jsonb_build_object('import_run_id', p_run.id, 'provider_record_id', p_record.id));
  return pg_catalog.jsonb_build_object('outcome', 'created', 'game_id', v_id);
end;
$$;

-- A release entry: resolve its source id, or create a candidate for the one game it
-- matches. Only what the source states is stored, each field with its evidence.
create function private.import_apply_release(p_run private.import_runs, p_record private.provider_records)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_release public.releases;
  v_id uuid;
  v_games uuid[];
  v_format text;
  v_regions text[];
  v_region text := 'unknown';
  v_serial text := nullif(pg_catalog.btrim(p_record.payload ->> 'serial'), '');
  v_languages text[];
  v_same_serial uuid[];
  v_filled text[] := '{}';
  v_field text;
begin
  perform private.import_lock_source_id(p_record.provider_code, 'release', p_record.external_id);
  begin
    select coalesce(pg_catalog.array_agg(distinct r order by r), '{}') into v_regions
    from pg_catalog.jsonb_array_elements_text(coalesce(p_record.payload -> 'region_codes', '[]')) r;
    select nullif(coalesce(pg_catalog.array_agg(distinct l order by l), '{}'), '{}') into v_languages
    from pg_catalog.jsonb_array_elements_text(coalesce(p_record.payload -> 'languages', '[]')) l;
  exception when others then
    raise exception 'invalid source entry' using errcode = '22023';
  end;
  if cardinality(v_regions) = 1 and v_regions[1] <> 'unknown' then
    v_region := v_regions[1];
  end if;

  select x.release_id into v_id from private.external_references x
  where x.provider_code = p_record.provider_code and x.entity_type = 'release' and x.external_id = p_record.external_id;

  if found then
    select * into v_release from public.releases r where r.id = v_id for update;
    perform private.import_set_record(p_record.id, 'matched', 'A', v_release.game_id, v_id, '{}');
    if v_release.status in ('merged', 'excluded', 'rejected') or v_release.status = 'published' or v_release.verified_at is not null then
      perform private.import_set_record(p_record.id, 'matched', 'A', v_release.game_id, v_id,
        pg_catalog.jsonb_build_object('kept_editorial', true));
      return pg_catalog.jsonb_build_object('outcome', 'matched', 'release_id', v_id, 'filled', v_filled);
    end if;
    if v_region <> 'unknown' and v_release.region_code = 'unknown' and not v_release.region_unknown_confirmed
       and not private.import_field_locked(null, v_id, 'region_code') then
      update public.releases r set region_code = v_region where r.id = v_id;
      v_filled := v_filled || 'region_code'::text;
    end if;
    if v_serial is not null and v_release.product_code is null and not private.import_field_locked(null, v_id, 'product_code') then
      update public.releases r set product_code = v_serial where r.id = v_id;
      v_filled := v_filled || 'product_code'::text;
    end if;
    if v_languages is not null and v_release.languages is null and not private.import_field_locked(null, v_id, 'languages') then
      update public.releases r set languages = v_languages where r.id = v_id;
      v_filled := v_filled || 'languages'::text;
    end if;
    foreach v_field in array v_filled loop
      insert into private.release_evidence (release_id, field_name, provider_record_id) values (v_id, v_field, p_record.id)
      on conflict do nothing;
    end loop;
    perform private.import_set_record(p_record.id, 'matched', 'A', v_release.game_id, v_id, pg_catalog.jsonb_build_object('filled', v_filled));
    if cardinality(v_filled) > 0 then
      perform private.record_catalog_audit(null, 'catalog_record_updated', 'release', v_id, p_run.reason,
        pg_catalog.jsonb_build_object('fields', v_filled, 'import_run_id', p_run.id, 'provider_record_id', p_record.id));
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'matched', 'release_id', v_id, 'filled', v_filled);
  end if;

  -- The release's game: exactly one game on the platform with its title.
  v_games := private.import_games_titled(p_run.platform_id, p_record.payload ->> 'title');
  if cardinality(v_games) = 0 then
    perform private.import_set_record(p_record.id, 'needs_review', 'C', null, null, pg_catalog.jsonb_build_object('reason', 'no matching game'));
    return pg_catalog.jsonb_build_object('outcome', 'unmatched');
  end if;
  if cardinality(v_games) > 1 then
    perform private.import_set_record(p_record.id, 'needs_review', 'B', null, null,
      pg_catalog.jsonb_build_object('reason', 'several matching games', 'candidates', v_games));
    return pg_catalog.jsonb_build_object('outcome', 'ambiguous', 'candidates', v_games);
  end if;

  -- The medium is known only when the platform has a single format.
  select pg_catalog.min(f.media_format_code) into v_format from public.platform_media_formats f
  where f.platform_id = p_run.platform_id having pg_catalog.count(*) = 1;
  if v_format is null then
    perform private.import_set_record(p_record.id, 'needs_review', 'A', v_games[1], null, pg_catalog.jsonb_build_object('reason', 'format unknown'));
    return pg_catalog.jsonb_build_object('outcome', 'needs_review');
  end if;

  -- A shared serial is noted for the editor, never used to merge.
  if v_serial is not null then
    select coalesce(pg_catalog.array_agg(r.id), '{}') into v_same_serial from public.releases r
    where r.platform_id = p_run.platform_id and r.product_code = v_serial;
  end if;

  insert into public.game_platforms (game_id, platform_id, status) values (v_games[1], p_run.platform_id, 'under_review')
  on conflict (game_id, platform_id) do nothing;
  insert into public.releases (game_id, platform_id, region_code, product_code, media_format_code, languages, status)
  values (v_games[1], p_run.platform_id, v_region, v_serial, v_format, v_languages, 'under_review')
  returning id into v_id;
  insert into private.external_references (provider_code, external_id, release_id) values (p_record.provider_code, p_record.external_id, v_id);
  perform private.import_set_record(p_record.id, 'promoted', 'A', v_games[1], v_id,
    case when cardinality(v_same_serial) > 0 then pg_catalog.jsonb_build_object('serial_also_on', v_same_serial) else '{}' end);

  v_filled := array['platform'];
  if v_region <> 'unknown' then v_filled := v_filled || 'region_code'::text; end if;
  if v_serial is not null then v_filled := v_filled || 'product_code'::text; end if;
  if v_languages is not null then v_filled := v_filled || 'languages'::text; end if;
  foreach v_field in array v_filled loop
    insert into private.release_evidence (release_id, field_name, provider_record_id) values (v_id, v_field, p_record.id);
  end loop;
  perform private.record_catalog_audit(null, 'catalog_record_created', 'release', v_id, p_run.reason,
    pg_catalog.jsonb_build_object('game_id', v_games[1], 'fields', v_filled, 'import_run_id', p_run.id, 'provider_record_id', p_record.id));
  return pg_catalog.jsonb_build_object('outcome', 'created', 'release_id', v_id, 'game_id', v_games[1],
    'serial_also_on', coalesce(v_same_serial, '{}'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The importer's functions
-- ---------------------------------------------------------------------------

-- Starts a run of one snapshot, held by the caller's lease.
create function catalog_import.start_run(
  p_provider text,
  p_platform text,
  p_source_name text,
  p_source_sha256 text,
  p_source_fetched_at timestamptz,
  p_terms_sha256 text,
  p_reason text,
  p_lease uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := private.require_reason(p_reason);
  v_platform uuid;
  v_run private.import_runs;
begin
  perform private.import_require_clearance(p_provider, p_terms_sha256);
  select p.id into v_platform from public.platforms p where p.slug = p_platform;
  if not found or p_lease is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  if exists (select 1 from private.import_runs r where r.provider_code = p_provider and r.source_sha256 = p_source_sha256 and r.status = 'running') then
    raise exception 'snapshot already running' using errcode = 'P0001';
  end if;
  insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, reason, lease_id, lease_expires_at)
  values (p_provider, v_platform, p_source_name, p_source_sha256, p_source_fetched_at, p_terms_sha256, v_reason, p_lease, pg_catalog.now() + interval '10 minutes')
  returning * into v_run;
  perform private.import_audit(v_run, 'started', pg_catalog.jsonb_build_object('platform', p_platform, 'source_name', p_source_name));
  return v_run.id;
end;
$$;

-- Takes over a running run whose lease has expired, to resume it, from the same
-- snapshot file. Returns its checkpoint.
create function catalog_import.claim_run(p_run uuid, p_lease uuid, p_source_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.import_runs;
begin
  select * into v_run from private.import_runs r where r.id = p_run for update;
  if not found or v_run.status <> 'running' or p_lease is null then
    raise exception 'run unavailable' using errcode = 'P0001';
  end if;
  if v_run.lease_id is distinct from p_lease and v_run.lease_expires_at > pg_catalog.now() then
    raise exception 'run in use' using errcode = 'P0001';
  end if;
  if p_source_sha256 is distinct from v_run.source_sha256 then
    raise exception 'snapshot differs' using errcode = 'P0001';
  end if;
  perform private.import_require_clearance(v_run.provider_code, v_run.terms_sha256);
  update private.import_runs r set lease_id = p_lease, lease_expires_at = pg_catalog.now() + interval '10 minutes'
  where r.id = p_run returning * into v_run;
  perform private.import_audit(v_run, 'resumed');
  return v_run.checkpoint;
end;
$$;

-- Stages up to 500 entries, in source order. Each is {entity_type, external_id,
-- payload, ignore_reason}. An unchanged entry is found, not added. Returns counts.
create function catalog_import.stage_records(p_run uuid, p_lease uuid, p_records jsonb, p_checkpoint jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.import_runs := private.import_run_for(p_run, p_lease);
  v_entry jsonb;
  v_id uuid;
  v_sha text;
  v_position integer;
  v_new integer := 0;
  v_unchanged integer := 0;
  v_changed integer := 0;
  v_ignored integer := 0;
  v_repeated integer := 0;
begin
  if p_records is null or pg_catalog.jsonb_typeof(p_records) <> 'array' or pg_catalog.jsonb_array_length(p_records) > 500
     or (p_checkpoint is not null and (pg_catalog.jsonb_typeof(p_checkpoint) <> 'object' or pg_catalog.pg_column_size(p_checkpoint) > 4096)) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.max(x.position), -1) into v_position from private.import_run_records x where x.import_run_id = p_run;

  for v_entry in select e from pg_catalog.jsonb_array_elements(p_records) e loop
    if pg_catalog.jsonb_typeof(v_entry) <> 'object'
       or not (select coalesce(pg_catalog.array_agg(k), '{}') from pg_catalog.jsonb_object_keys(v_entry) k)
              operator(pg_catalog.<@) array['entity_type', 'external_id', 'ignore_reason', 'payload']
       or pg_catalog.jsonb_typeof(v_entry -> 'payload') is distinct from 'object' then
      raise exception 'invalid source entry' using errcode = '22023';
    end if;
    v_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((v_entry -> 'payload')::text, 'UTF8')), 'hex');
    insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, match_notes)
    values (v_run.provider_code, v_entry ->> 'entity_type', v_entry ->> 'external_id', v_entry -> 'payload', v_sha, p_run,
      case when v_entry ? 'ignore_reason' then 'ignored'::public.provider_record_status else 'fetched'::public.provider_record_status end,
      case when v_entry ? 'ignore_reason' then pg_catalog.jsonb_build_object('ignored', pg_catalog.left(v_entry ->> 'ignore_reason', 200)) else '{}' end)
    on conflict (provider_code, entity_type, external_id, payload_sha256) do nothing
    returning id into v_id;
    if v_id is null then
      select pr.id into v_id from private.provider_records pr
      where pr.provider_code = v_run.provider_code and pr.entity_type = v_entry ->> 'entity_type'
        and pr.external_id = v_entry ->> 'external_id' and pr.payload_sha256 = v_sha;
      v_unchanged := v_unchanged + 1;
    else
      v_new := v_new + 1;
      if v_entry ? 'ignore_reason' then
        v_ignored := v_ignored + 1;
      end if;
      if exists (select 1 from private.provider_records pr where pr.provider_code = v_run.provider_code and pr.entity_type = v_entry ->> 'entity_type'
                 and pr.external_id = v_entry ->> 'external_id' and pr.id <> v_id) then
        v_changed := v_changed + 1;
      end if;
    end if;
    v_position := v_position + 1;
    insert into private.import_run_records (import_run_id, provider_record_id, position) values (p_run, v_id, v_position)
    on conflict (import_run_id, provider_record_id) do nothing;
    if not found then
      v_repeated := v_repeated + 1;
    end if;
    v_id := null;
  end loop;

  update private.import_runs r set
    checkpoint = coalesce(p_checkpoint, r.checkpoint),
    stats = r.stats || pg_catalog.jsonb_build_object(
      'staged_new', coalesce((r.stats ->> 'staged_new')::integer, 0) + v_new,
      'staged_unchanged', coalesce((r.stats ->> 'staged_unchanged')::integer, 0) + v_unchanged,
      'staged_changed', coalesce((r.stats ->> 'staged_changed')::integer, 0) + v_changed,
      'staged_ignored', coalesce((r.stats ->> 'staged_ignored')::integer, 0) + v_ignored,
      'staged_repeated', coalesce((r.stats ->> 'staged_repeated')::integer, 0) + v_repeated)
  where r.id = p_run;
  return pg_catalog.jsonb_build_object('new', v_new, 'unchanged', v_unchanged, 'changed', v_changed, 'ignored', v_ignored, 'repeated', v_repeated);
end;
$$;

-- The run's entries still to apply, after a position.
create function catalog_import.pending_records(p_run uuid, p_lease uuid, p_after integer, p_limit integer)
returns table (record_position integer, provider_record_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.import_run_for(p_run, p_lease);
  return query
    select x.position, x.provider_record_id
    from private.import_run_records x
    join private.provider_records pr on pr.id = x.provider_record_id
    where x.import_run_id = p_run and x.position > coalesce(p_after, -1) and pr.status in ('fetched', 'needs_review')
    order by x.position
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

-- Applies one staged entry of the run: resolves, matches or creates a candidate.
create function catalog_import.apply_record(p_run uuid, p_lease uuid, p_record uuid, p_checkpoint jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.import_runs := private.import_run_for(p_run, p_lease);
  v_record private.provider_records;
  v_result jsonb;
begin
  if p_checkpoint is not null and (pg_catalog.jsonb_typeof(p_checkpoint) <> 'object' or pg_catalog.pg_column_size(p_checkpoint) > 4096) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select pr.* into v_record from private.provider_records pr
  join private.import_run_records x on x.provider_record_id = pr.id and x.import_run_id = p_run
  where pr.id = p_record for update of pr;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_record.status not in ('fetched', 'needs_review') then
    v_result := pg_catalog.jsonb_build_object('outcome', 'skipped', 'status', v_record.status);
  elsif v_record.entity_type = 'game' then
    v_result := private.import_apply_game(v_run, v_record);
  else
    v_result := private.import_apply_release(v_run, v_record);
  end if;
  if p_checkpoint is not null then
    update private.import_runs r set checkpoint = p_checkpoint where r.id = p_run;
  end if;
  return v_result;
end;
$$;

-- Records that an entry couldn't be applied, after its call failed.
create function catalog_import.mark_record_failed(p_run uuid, p_lease uuid, p_record uuid, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.import_run_for(p_run, p_lease);
  update private.provider_records pr set status = 'failed',
    match_notes = pg_catalog.jsonb_build_object('error', pg_catalog.left(coalesce(p_message, 'failed'), 300))
  where pr.id = p_record and pr.status in ('fetched', 'needs_review')
    and exists (select 1 from private.import_run_records x where x.import_run_id = p_run and x.provider_record_id = pr.id);
end;
$$;

-- Ends a run and releases its lease.
create function catalog_import.finish_run(p_run uuid, p_lease uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.import_runs;
begin
  if p_status is null or p_status not in ('completed', 'failed', 'abandoned') then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  -- A run is ended even if clearance was withdrawn meanwhile.
  select * into v_run from private.import_runs r where r.id = p_run for update;
  if not found or v_run.status <> 'running' then
    raise exception 'run unavailable' using errcode = 'P0001';
  end if;
  if p_lease is null or v_run.lease_id is distinct from p_lease then
    raise exception 'run in use' using errcode = 'P0001';
  end if;
  update private.import_runs r set status = p_status, finished_at = pg_catalog.now(), lease_id = null, lease_expires_at = null
  where r.id = p_run returning * into v_run;
  perform private.import_audit(v_run, 'finished', pg_catalog.jsonb_build_object('status', p_status, 'stats', v_run.stats));
end;
$$;

-- What a run found and did, for the pilot report.
create function catalog_import.run_report(p_run uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with run as (
    select * from private.import_runs r where r.id = p_run
  ), recs as (
    select pr.* from private.provider_records pr
    join private.import_run_records x on x.provider_record_id = pr.id and x.import_run_id = p_run
  ), rels as (
    select r.* from public.releases r where r.id in (select matched_release_id from recs where entity_type = 'release')
  )
  select pg_catalog.jsonb_build_object(
    'run', (select pg_catalog.jsonb_build_object('id', id, 'provider', provider_code, 'status', status, 'source_name', source_name,
             'source_sha256', source_sha256, 'started_at', started_at, 'finished_at', finished_at, 'stats', stats) from run),
    'source_records', (select pg_catalog.count(*) from recs),
    'by_status', (select coalesce(pg_catalog.jsonb_object_agg(k, n), '{}') from (select entity_type || ':' || status k, pg_catalog.count(*) n from recs group by 1) s),
    'by_tier', (select coalesce(pg_catalog.jsonb_object_agg(k, n), '{}') from (select entity_type || ':' || coalesce(match_tier, 'new') k, pg_catalog.count(*) n from recs where status <> 'ignored' group by 1) s),
    'games_created', (select pg_catalog.count(*) from recs where entity_type = 'game' and status = 'promoted'),
    'releases_created', (select pg_catalog.count(*) from recs where entity_type = 'release' and status = 'promoted'),
    'possible_duplicates', (select pg_catalog.count(*) from recs where match_notes ? 'candidates'),
    'shared_serials', (select pg_catalog.count(*) from recs where match_notes ? 'serial_also_on'),
    'ignored_reasons', (select coalesce(pg_catalog.jsonb_object_agg(k, n), '{}') from (select match_notes ->> 'ignored' k, pg_catalog.count(*) n from recs where status = 'ignored' group by 1) s),
    'releases_missing', (select pg_catalog.jsonb_build_object(
        'releases', pg_catalog.count(*),
        'region', pg_catalog.count(*) filter (where region_code = 'unknown'),
        'product_code', pg_catalog.count(*) filter (where product_code is null),
        'languages', pg_catalog.count(*) filter (where languages is null),
        'edition', pg_catalog.count(*) filter (where edition_name is null or edition_kind is null),
        'media_count', pg_catalog.count(*) filter (where media_count is null),
        'packaging', pg_catalog.count(*) filter (where packaging is null),
        'release_date', pg_catalog.count(*) filter (where release_date is null)) from rels),
    'published_or_verified', (select pg_catalog.count(*) from rels where status = 'published' or verified_at is not null)
  )
  where exists (select 1 from run)
$$;

-- ---------------------------------------------------------------------------
-- 7. Access
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.guard_provider_record()',
    'private.record_provider_clearance(text, boolean, text, text, text)',
    'private.import_require_clearance(text, text)',
    'private.import_run_for(uuid, uuid)',
    'private.import_audit(private.import_runs, text, jsonb)',
    'private.import_field_locked(uuid, uuid, text)',
    'private.import_lock_source_id(text, text, text)',
    'private.import_title_key(text)',
    'private.import_games_titled(uuid, text)',
    'private.import_set_record(uuid, public.provider_record_status, text, uuid, uuid, jsonb)',
    'private.import_apply_game(private.import_runs, private.provider_records)',
    'private.import_apply_release(private.import_runs, private.provider_records)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
  end loop;

  foreach v_signature in array array[
    'catalog_import.start_run(text, text, text, text, timestamptz, text, text, uuid)',
    'catalog_import.claim_run(uuid, uuid, text)',
    'catalog_import.stage_records(uuid, uuid, jsonb, jsonb)',
    'catalog_import.pending_records(uuid, uuid, integer, integer)',
    'catalog_import.apply_record(uuid, uuid, uuid, jsonb)',
    'catalog_import.mark_record_failed(uuid, uuid, uuid, text)',
    'catalog_import.finish_run(uuid, uuid, text)',
    'catalog_import.run_report(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to catalog_importer', v_signature);
  end loop;
end;
$$;
