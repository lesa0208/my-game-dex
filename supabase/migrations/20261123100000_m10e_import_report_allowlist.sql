-- M10e privacy review of import monitoring (M10d): explicit allow-lists.
--
-- get_import_run returned catalog_import.run_report (M5b), the operator's pilot report,
-- whole apart from its run. That report also carries maps keyed by free text: values
-- copied from the raw source payload (created_release_types, created_flags) and
-- reasons, without a bound on how many. get_import_run_records returned a failed
-- entry's error, which is the importer's raw database error message (up to 300
-- characters, naming constraints and columns): an internal diagnostic. And a run's
-- stats kept any numeric key.
--
-- Now:
--   * a run's report is rebuilt from a fixed list of fields: ten counts, the status
--     and tier maps with keys of the known form only, the ignored and held reasons
--     (at most 20, each key at most 200 characters, numbers only), and the eight
--     "missing a detail" counts. Nothing from the payload is returned.
--   * a staged entry no longer returns an error message: its status says it failed,
--     and the operator's own log has the detail. Its ignore reason is cut to 200.
--   * a run's stats keep only the five staging counts the importer writes.
--
-- Same functions, signatures, grants and callers (administrators only, D8).

-- Counts by key from a report map: number values only, keys matching p_pattern (or
-- any, cut to p_key_length, when it's null), at most p_max, largest first.
create function private.import_report_counts(p_map jsonb, p_pattern text, p_key_length integer, p_max integer)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_object_agg(s.k, s.n), '{}')
  from (
    select pg_catalog.left(e.key, p_key_length) k, e.value n
    from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(p_map) = 'object' then p_map else '{}' end) e
    where pg_catalog.jsonb_typeof(e.value) = 'number' and (p_pattern is null or e.key ~ p_pattern)
    order by e.value desc, e.key
    limit p_max
  ) s
$$;

-- A number from the report, or null.
create function private.import_report_number(p_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when pg_catalog.jsonb_typeof(p_value) = 'number' then p_value end
$$;

-- The pilot report as the pages show it: the allow-list above.
create function private.import_report_safe(p_report jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'source_records', private.import_report_number(p_report -> 'source_records'),
    'games_created', private.import_report_number(p_report -> 'games_created'),
    'releases_created', private.import_report_number(p_report -> 'releases_created'),
    'possible_duplicates', private.import_report_number(p_report -> 'possible_duplicates'),
    'shared_serials', private.import_report_number(p_report -> 'shared_serials'),
    'suggested', private.import_report_number(p_report -> 'suggested'),
    'word_break_matches', private.import_report_number(p_report -> 'word_break_matches'),
    'withdrawn', private.import_report_number(p_report -> 'withdrawn'),
    'queued_for_review', private.import_report_number(p_report -> 'queued_for_review'),
    'published_or_verified', private.import_report_number(p_report -> 'published_or_verified'),
    'by_status', private.import_report_counts(p_report -> 'by_status', '^(game|release):(fetched|matched|needs_review|promoted|ignored|failed)$', 40, 20),
    'by_tier', private.import_report_counts(p_report -> 'by_tier', '^(game|release):(A|B|C|new)$', 40, 20),
    'ignored_reasons', private.import_report_counts(p_report -> 'ignored_reasons', null, 200, 20),
    'held_reasons', private.import_report_counts(p_report -> 'held_reasons', null, 200, 20),
    'releases_missing', (
      select pg_catalog.jsonb_object_agg(k, private.import_report_number(p_report -> 'releases_missing' -> k))
      from pg_catalog.unnest(array['releases', 'region', 'product_code', 'languages', 'edition', 'media_count', 'packaging', 'release_date']) k
    )
  )
$$;

create or replace function private.import_run_summary(p_run private.import_runs)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_run.id,
    'provider_code', p_run.provider_code,
    'provider_name', (select p.name from private.external_providers p where p.code = p_run.provider_code),
    'platform', (select pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name) from public.platforms pl where pl.id = p_run.platform_id),
    'source_name', p_run.source_name,
    'source_sha256', p_run.source_sha256,
    'source_fetched_at', p_run.source_fetched_at,
    'terms_sha256', p_run.terms_sha256,
    'status', p_run.status,
    'reason', p_run.reason,
    'started_at', p_run.started_at,
    'finished_at', p_run.finished_at,
    'lease_live', p_run.status = 'running' and p_run.lease_expires_at > pg_catalog.now(),
    'lease_expires_at', p_run.lease_expires_at,
    'stats', (select coalesce(pg_catalog.jsonb_object_agg(s.key, s.value), '{}') from pg_catalog.jsonb_each(p_run.stats) s
              where s.key in ('staged_new', 'staged_unchanged', 'staged_changed', 'staged_ignored', 'staged_repeated')
                and pg_catalog.jsonb_typeof(s.value) = 'number')
  )
$$;

create or replace function public.get_import_run(p_run uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_run private.import_runs;
  v_report jsonb;
begin
  perform private.require_active_staff('admin');
  select * into v_run from private.import_runs r where r.id = p_run;
  if not found then
    return null;
  end if;
  -- The operator's pilot report (M5b), through the allow-list: never the payload.
  v_report := private.import_report_safe(catalog_import.run_report(p_run));
  return pg_catalog.jsonb_build_object(
    'run', private.import_run_summary(v_run),
    'report', v_report,
    'failed', (select count(*) from private.provider_records pr
               join private.import_run_records x on x.provider_record_id = pr.id and x.import_run_id = p_run
               where pr.status = 'failed'),
    'needs_review', (select count(*) from private.provider_records pr
                     join private.import_run_records x on x.provider_record_id = pr.id and x.import_run_id = p_run
                     where pr.status = 'needs_review'),
    'reclassifications', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'release_id', c.release_id, 'action', c.action, 'reason', c.reason, 'created_at', c.created_at,
        'resolved_at', c.resolved_at, 'resolution', c.resolution) order by c.created_at, c.id)
      from (select * from private.catalog_reclassifications c where c.import_run_id = p_run order by c.created_at, c.id limit 100) c
    ), '[]'),
    'reclassifications_total', (select count(*) from private.catalog_reclassifications c where c.import_run_id = p_run)
  );
end;
$$;

create or replace function public.get_import_run_records(
  p_run uuid,
  p_status text default null,
  p_limit integer default 50,
  p_after integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_staff('admin');
  if p_status is not null and p_status not in ('fetched', 'matched', 'needs_review', 'promoted', 'ignored', 'failed') then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'position', x.position,
      'id', pr.id,
      'entity_type', pr.entity_type,
      'external_id', pr.external_id,
      'title', pg_catalog.left(pr.payload ->> 'title', 200),
      'status', pr.status,
      'match_tier', pr.match_tier,
      'review_reason', pr.review_reason,
      'ignored', pg_catalog.left(pr.match_notes ->> 'ignored', 200),
      'possible_duplicate', pr.match_notes ? 'candidates',
      'shared_serial', pr.match_notes ? 'serial_also_on',
      'matched_game_id', pr.matched_game_id,
      'matched_release_id', pr.matched_release_id
    ) order by x.position)
    from (
      select * from private.import_run_records x
      where x.import_run_id = p_run and (p_after is null or x.position > p_after)
        and (p_status is null or exists (select 1 from private.provider_records pr where pr.id = x.provider_record_id and pr.status::text = p_status))
      order by x.position
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) x
    join private.provider_records pr on pr.id = x.provider_record_id
  ), '[]');
end;
$$;

revoke all on function private.import_report_counts(jsonb, text, integer, integer) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function private.import_report_number(jsonb) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function private.import_report_safe(jsonb) from public, anon, authenticated, service_role, catalog_importer;
