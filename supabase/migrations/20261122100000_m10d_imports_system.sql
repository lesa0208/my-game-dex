-- M10d Admin Panel Expansion: import monitoring and the system view, read-only.
--
-- Design: docs/architecture/security-rls.md#imports-and-system-m10d and the M10
-- decisions D5, D7 and D8 in architecture-decisions.md.
--
-- Five reads, each for administrators only (D8), with a live verified session (M8b):
--
--   get_import_providers()     each source: its terms record, clearance and run counts
--   get_import_runs(...)       runs, newest first, 1 to 100 a page, by provider or status
--   get_import_run(run)        one run, its pilot report and its reclassifications
--   get_import_run_records(...) one run's staged entries, 1 to 100 a page, by status
--   get_system_status()        migrations, the importer role's state, counts (not the
--                              Owner record, which get_ownership_status already covers)
--
-- Nothing here writes, so nothing is audited, like the other staff reads. No lease,
-- checkpoint, raw payload, match notes, credential, connection detail or setting is
-- returned. Reference data (D5) is public and needs no function: the pages read it as
-- anon. Resolving a reclassification stays the existing audited
-- resolve_catalog_review, for catalog editors (M5b).

-- A run as the pages show it: no lease id or checkpoint, and only the numbers in stats.
create function private.import_run_summary(p_run private.import_runs)
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
              where pg_catalog.jsonb_typeof(s.value) = 'number')
  )
$$;

create function public.get_import_providers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cap constant integer := 10000;
begin
  perform private.require_active_staff('admin');
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'code', p.code,
      'name', p.name,
      'terms_url', p.terms_url,
      'terms_sha256', p.terms_sha256,
      'terms_reviewed_at', p.terms_reviewed_at,
      'commercial_use_cleared', p.commercial_use_cleared,
      'cleared_note', p.cleared_note,
      'updated_at', p.updated_at,
      'runs', (select count(*) from (select 1 from private.import_runs r where r.provider_code = p.code limit v_cap) x),
      'runs_running', (select count(*) from (select 1 from private.import_runs r where r.provider_code = p.code and r.status = 'running' limit v_cap) x),
      'last_run_at', (select max(r.started_at) from private.import_runs r where r.provider_code = p.code),
      'source_records', (select count(*) from (select 1 from private.provider_records pr where pr.provider_code = p.code limit v_cap) x)
    ) order by p.name)
    from private.external_providers p
  ), '[]');
end;
$$;

create function public.get_import_runs(
  p_limit integer default 25,
  p_before uuid default null,
  p_provider text default null,
  p_status text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_staff('admin');
  if (p_status is not null and p_status not in ('running', 'completed', 'failed', 'abandoned'))
     or (p_provider is not null and (p_provider !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or pg_catalog.char_length(p_provider) > 40)) then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(private.import_run_summary(r) order by r.id desc)
    from (
      select * from private.import_runs r
      where (p_before is null or r.id < p_before)
        and (p_provider is null or r.provider_code = p_provider)
        and (p_status is null or r.status = p_status)
      order by r.id desc
      limit least(greatest(coalesce(p_limit, 25), 1), 100)
    ) r
  ), '[]');
end;
$$;

create function public.get_import_run(p_run uuid)
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
  -- The operator's pilot report (M5b), without its own copy of the run.
  v_report := catalog_import.run_report(p_run) - 'run';
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

create function public.get_import_run_records(
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
      'ignored', pr.match_notes ->> 'ignored',
      'error', pr.match_notes ->> 'error',
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

-- What an administrator needs to know about the installation's state, and nothing that
-- would help anyone reach it: no setting, address, version string, key or role detail
-- beyond whether the importer can log in.
create function public.get_system_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cap constant integer := 10000;
  v_migrations jsonb := null;
begin
  perform private.require_active_staff('admin');
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select pg_catalog.jsonb_build_object(''applied'', count(*), ''latest'', max(version)) from supabase_migrations.schema_migrations'
      into v_migrations;
  end if;
  return pg_catalog.jsonb_build_object(
    'cap', v_cap,
    'checked_at', pg_catalog.now(),
    'migrations', v_migrations,
    'importer', pg_catalog.jsonb_build_object(
      'login_enabled', coalesce((select r.rolcanlogin from pg_catalog.pg_roles r where r.rolname = 'catalog_importer'), false),
      'runs_running', (select count(*) from (select 1 from private.import_runs r where r.status = 'running' limit v_cap) x),
      'leases_expired', (select count(*) from (select 1 from private.import_runs r where r.status = 'running' and r.lease_expires_at <= pg_catalog.now() limit v_cap) x),
      'last_run_at', (select max(r.started_at) from private.import_runs r)
    ),
    'providers', pg_catalog.jsonb_build_object(
      'total', (select count(*) from private.external_providers),
      'cleared', (select count(*) from private.external_providers p where p.commercial_use_cleared)
    ),
    'reference', pg_catalog.jsonb_build_object(
      'platforms', (select count(*) from public.platforms),
      'media_formats', (select count(*) from public.media_formats),
      'region_codes', (select count(*) from public.region_codes),
      'markets', (select count(*) from public.markets),
      'hardware_requirements', (select count(*) from public.hardware_requirements)
    ),
    'catalog', pg_catalog.jsonb_build_object(
      'games_published', (select count(*) from (select 1 from public.games g where g.status = 'published' limit v_cap) x),
      'releases_published', (select count(*) from (select 1 from public.releases r where r.status = 'published' limit v_cap) x)
    )
  );
end;
$$;

revoke all on function private.import_run_summary(private.import_runs) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function public.get_import_providers() from public, anon, authenticated, service_role, catalog_importer;
revoke all on function public.get_import_runs(integer, uuid, text, text) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function public.get_import_run(uuid) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function public.get_import_run_records(uuid, text, integer, integer) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function public.get_system_status() from public, anon, authenticated, service_role, catalog_importer;
grant execute on function public.get_import_providers() to authenticated;
grant execute on function public.get_import_runs(integer, uuid, text, text) to authenticated;
grant execute on function public.get_import_run(uuid) to authenticated;
grant execute on function public.get_import_run_records(uuid, text, integer, integer) to authenticated;
grant execute on function public.get_system_status() to authenticated;
