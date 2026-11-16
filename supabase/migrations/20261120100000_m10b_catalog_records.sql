-- M10b Admin: catalog search, game and release records, and catalog-record history.
--
-- Design: docs/architecture/security-rls.md#catalog-records-and-history-m10b
-- Four read-only functions for catalog editors and administrators. Each is STABLE
-- and SECURITY DEFINER with an empty search_path, checks the caller itself
-- (require_active_staff: an active account, the role, and a session verified with
-- the authenticator), and builds its response from a fixed list of fields:
--
--   search_catalog_records    games or releases of any status, filtered and paged
--   get_game_record           one game, its titles, platforms, releases and sources
--   get_release_record        one release, its contents, sources, merges, submissions
--   get_catalog_record_history one record's events from the audit log (D4)
--
-- Editors could already read every game and release through the RLS policies. What
-- these add is search over unpublished records, provenance (private), and history.
-- None returns who submitted or verified a record, collection data of any kind, a
-- provider's raw entry, or an audit row's metadata as stored. The full audit log
-- stays administrators' only (get_audit_events). The public search is unchanged.

-- ---------------------------------------------------------------------------
-- 1. Indexes
-- ---------------------------------------------------------------------------

-- The staff search reaches every status, so the published-only public search indexes
-- don't apply. Named _staff_ so the M5c guard (20_catalog_search) tells them apart.
create index games_staff_search_trgm_idx on public.games using gin (search_key extensions.gin_trgm_ops);
create index releases_staff_local_title_trgm_idx on public.releases using gin (local_title_key extensions.gin_trgm_ops)
  where local_title_key is not null;
create index releases_staff_product_code_idx on public.releases (pg_catalog.upper(product_code)) where product_code is not null;

-- History reads one record's events newest first. Catalog events name their record
-- in metadata: 'id' (with 'entity'), 'release_id' and 'game_id' (submissions), and
-- 'target_id' (a merge's target, a relation's other game).
create index audit_events_catalog_id_idx on private.audit_events ((metadata ->> 'id'), id desc) where metadata ? 'id';
create index audit_events_catalog_release_idx on private.audit_events ((metadata ->> 'release_id'), id desc) where metadata ? 'release_id';
create index audit_events_catalog_game_idx on private.audit_events ((metadata ->> 'game_id'), id desc) where metadata ? 'game_id';
create index audit_events_catalog_target_idx on private.audit_events ((metadata ->> 'target_id'), id desc) where metadata ? 'target_id';

-- ---------------------------------------------------------------------------
-- 2. Helpers. None is reachable from the API.
-- ---------------------------------------------------------------------------

-- A page cursor made by private.catalog_cursor_encode, as an array of p_length.
create function private.records_cursor_decode(p_cursor text, p_length integer)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb;
begin
  if p_cursor is null or pg_catalog.char_length(p_cursor) > 600 or p_cursor !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;
  begin
    v := pg_catalog.convert_from(pg_catalog.decode(
      pg_catalog.translate(p_cursor, '-_', '+/') || pg_catalog.repeat('=', (4 - pg_catalog.char_length(p_cursor) % 4) % 4), 'base64'), 'UTF8')::jsonb;
  exception when others then
    raise exception 'invalid cursor' using errcode = '22023';
  end;
  if pg_catalog.jsonb_typeof(v) <> 'array' or pg_catalog.jsonb_array_length(v) <> p_length then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- A release in a list: what tells it apart from its siblings, and where it stands.
create function private.record_release_summary(p_release public.releases)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_release.id,
    'game', (select pg_catalog.jsonb_build_object('id', g.id, 'title', g.title, 'status', g.status)
             from public.games g where g.id = p_release.game_id),
    'platform', (select pg_catalog.jsonb_build_object('slug', p.slug, 'name', p.name, 'short_name', p.short_name)
                 from public.platforms p where p.id = p_release.platform_id),
    'region', (select pg_catalog.jsonb_build_object('code', rc.code, 'label', rc.label)
               from public.region_codes rc where rc.code = p_release.region_code),
    'edition_name', p_release.edition_name,
    'variant_name', p_release.variant_name,
    'product_code', p_release.product_code,
    'format', (select f.name from public.media_formats f where f.code = p_release.media_format_code),
    'status', p_release.status,
    'verified', p_release.verified_at is not null,
    'merged_into_id', p_release.merged_into_id)
$$;

-- The actions a record's history may show. Anything else, including every account,
-- staff, Owner and import-run event, never appears.
create function private.history_actions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'catalog_record_created', 'catalog_record_updated', 'catalog_record_verified', 'catalog_record_published',
    'catalog_field_locked', 'catalog_field_unlocked', 'catalog_record_withdrawn', 'catalog_review_queued',
    'catalog_review_resolved', 'catalog_alias_added', 'catalog_alias_removed',
    'catalog_submission_created', 'catalog_submission_updated', 'catalog_submission_withdrawn',
    'catalog_submission_resubmitted', 'catalog_submission_review_started', 'catalog_submission_approved',
    'catalog_submission_changes_requested', 'catalog_submission_rejected',
    'catalog_release_excluded', 'catalog_exclusion_restored', 'catalog_release_merged'
  ]
$$;

-- One event as history shows it. Who acted is a kind: an import, a submitter (never
-- named here; the submission page says who), or a staff member by handle. A staff
-- reason is shown except for exclusions, whose reasons stay with the administrators'
-- exclusion record. Details are an allow-list of metadata keys, each a plain value
-- or a list of them; counts of copies or owners, provider entries and import runs
-- are never among them.
create function private.history_event_json(p_event private.audit_events)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_event.id,
    'occurred_at', p_event.occurred_at,
    'action', p_event.action,
    'actor', case
      when p_event.actor_id is null then pg_catalog.jsonb_build_object('kind', case when m ? 'import_run_id' then 'import' else 'system' end)
      when p_event.action::text in ('catalog_submission_created', 'catalog_submission_updated', 'catalog_submission_withdrawn', 'catalog_submission_resubmitted')
        then pg_catalog.jsonb_build_object('kind', 'submitter')
      else pg_catalog.jsonb_build_object('kind', 'staff', 'handle', (select p.handle from public.profiles p where p.id = p_event.actor_id))
    end,
    'reason', case
      when p_event.actor_id is null
        or p_event.action::text in ('catalog_submission_created', 'catalog_submission_updated', 'catalog_submission_withdrawn',
                                    'catalog_submission_resubmitted', 'catalog_release_excluded', 'catalog_exclusion_restored')
        then null
      else p_event.reason
    end,
    'details', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'entity', m -> 'entity',
      'record_id', m -> 'id',
      'fields', case when pg_catalog.jsonb_typeof(m -> 'fields') = 'array' then m -> 'fields' end,
      'field', m -> 'field',
      'verification_cleared', m -> 'verification_cleared',
      'revision', m -> 'revision',
      'slug', m -> 'slug',
      'game_id', m -> 'game_id',
      'platform_id', m -> 'platform_id',
      'release_id', m -> 'release_id',
      'with_release_id', m -> 'with_release_id',
      'target_id', m -> 'target_id',
      'relation', m -> 'relation',
      'request_id', m -> 'request_id',
      'previous_request_id', m -> 'previous_request_id',
      'review_id', m -> 'review_id',
      'code', case when p_event.action::text in ('catalog_record_withdrawn', 'catalog_review_queued') then m -> 'reason' end,
      'blockers', case when pg_catalog.jsonb_typeof(m -> 'blockers') = 'array' then m -> 'blockers' end,
      'status', m -> 'status',
      'alias_title', case when p_event.action::text like 'catalog_alias_%' then m -> 'title' end,
      'alias_kind', case when p_event.action::text like 'catalog_alias_%' then m -> 'kind' end,
      'language_code', m -> 'language_code',
      'region_code', m -> 'region_code',
      'merge_id', m -> 'merge_id',
      'merge_kind', case when p_event.action::text = 'catalog_release_merged' then m -> 'kind' end,
      'exclusion_id', case when private.has_staff_role('admin') then m -> 'exclusion_id' end,
      'reason_code', m -> 'reason_code',
      'previous_status', m -> 'previous_status',
      'restored_status', m -> 'restored_status')))
  from (select p_event.metadata as m) x
$$;

revoke all on function private.records_cursor_decode(text, integer) from public, anon, authenticated, service_role;
revoke all on function private.record_release_summary(public.releases) from public, anon, authenticated, service_role;
revoke all on function private.history_actions() from public, anon, authenticated, service_role;
revoke all on function private.history_event_json(private.audit_events) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Search
-- ---------------------------------------------------------------------------

-- Games or releases of any status, unpublished, merged, excluded and rejected ones
-- included, by title (the game's, an alias, or a release's local title, anywhere in
-- the normalized title), by exact id, or for releases by exact product code or
-- barcode. A release search for a game's id lists that game's releases. Filters:
-- one platform (by slug) and one status. With no query, it lists everything the
-- filters allow. Ordered by sort title, then id; keyset pages of at most 50, and the
-- cursor is tied to the query and filters it came from.
create function public.search_catalog_records(
  p_kind text default 'games',
  p_query text default null,
  p_platform text default null,
  p_status text default null,
  p_limit integer default 25,
  p_cursor text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text := pg_catalog.btrim(coalesce(p_query, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_status public.catalog_status;
  v_platform uuid;
  v_key text;
  v_id uuid;
  v_code text;
  v_barcode text;
  v_hash text;
  v_cursor jsonb;
  c_sort text;
  c_game uuid;
  c_id uuid;
  v_row record;
  v_rows jsonb := '[]';
  v_count integer := 0;
  v_more boolean := false;
  l_sort text;
  l_game uuid;
  l_id uuid;
begin
  perform private.require_active_staff('catalog_editor');
  if p_kind is null or p_kind not in ('games', 'releases') then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_query) > 100 or pg_catalog.char_length(coalesce(p_platform, '')) > 60 then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  if p_status is not null then
    if not (p_status = any (pg_catalog.enum_range(null::public.catalog_status)::text[])) then
      raise exception 'invalid filter' using errcode = '22023';
    end if;
    v_status := p_status::public.catalog_status;
  end if;
  if p_platform is not null then
    select p.id into v_platform from public.platforms p where p.slug = p_platform;
    if v_platform is null then
      return pg_catalog.jsonb_build_object('status', 'unknown_platform', 'items', '[]'::jsonb, 'next_cursor', null);
    end if;
  end if;

  if v_query <> '' then
    if v_query ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_id := v_query::uuid;
    else
      v_key := private.catalog_search_key(v_query);
      if v_key is null or (pg_catalog.char_length(v_key) < 2 and pg_catalog.octet_length(v_key) = pg_catalog.char_length(v_key)) then
        return pg_catalog.jsonb_build_object('status', 'too_short', 'items', '[]'::jsonb, 'next_cursor', null);
      end if;
      if p_kind = 'releases' then
        v_code := pg_catalog.upper(pg_catalog.regexp_replace(v_query, '\s+', '', 'g'));
        if v_code !~ '^[A-Z0-9][A-Z0-9-]{2,39}$' or v_code !~ '[0-9-]' then
          v_code := null;
        end if;
        v_barcode := pg_catalog.regexp_replace(v_query, '[\s-]+', '', 'g');
        if v_barcode !~ '^[0-9]{8,14}$' then
          v_barcode := null;
        end if;
      end if;
    end if;
  end if;

  v_hash := pg_catalog.left(pg_catalog.md5(pg_catalog.concat_ws('|', p_kind, coalesce(v_key, ''), coalesce(v_id::text, ''),
    coalesce(v_platform::text, ''), coalesce(v_status::text, ''))), 12);
  if p_cursor is not null then
    v_cursor := private.records_cursor_decode(p_cursor, 4);
    begin
      c_sort := v_cursor ->> 1;
      c_game := (v_cursor ->> 2)::uuid;
      c_id := (v_cursor ->> 3)::uuid;
    exception when others then
      raise exception 'invalid cursor' using errcode = '22023';
    end;
    if v_cursor ->> 0 is distinct from v_hash or c_sort is null or c_game is null or c_id is null then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
  end if;

  if p_kind = 'games' then
    for v_row in
      select g.id, g.sort_title
      from public.games g
      where (v_status is null or g.status = v_status)
        and (v_platform is null or exists (select 1 from public.game_platforms gp where gp.game_id = g.id and gp.platform_id = v_platform))
        and (v_query = ''
             or g.id = v_id
             or (v_key is not null and (g.search_key like '%' || v_key || '%'
                 or exists (select 1 from public.game_aliases a where a.game_id = g.id and a.search_key like '%' || v_key || '%'))))
        and (p_cursor is null or (g.sort_title, g.id) > (c_sort, c_id))
      order by g.sort_title, g.id
      limit v_limit + 1
    loop
      v_count := v_count + 1;
      if v_count > v_limit then
        v_more := true;
        exit;
      end if;
      l_sort := v_row.sort_title;
      l_game := v_row.id;
      l_id := v_row.id;
      v_rows := v_rows || pg_catalog.jsonb_build_array((
        select pg_catalog.jsonb_build_object(
          'id', g.id, 'title', g.title, 'kind', g.kind, 'slug', g.slug, 'status', g.status,
          'verified', g.verified_at is not null, 'merged_into_id', g.merged_into_id,
          'first_release', private.catalog_date_json(g.first_release_date, g.first_release_precision),
          'platforms', (select coalesce(pg_catalog.jsonb_agg(p.short_name order by p.name), '[]')
                        from public.game_platforms gp join public.platforms p on p.id = gp.platform_id where gp.game_id = g.id),
          'releases', (select pg_catalog.jsonb_build_object('total', count(*), 'published', count(*) filter (where r.status = 'published'))
                       from public.releases r where r.game_id = g.id))
        from public.games g where g.id = v_row.id));
    end loop;
  else
    for v_row in
      select r.id, r.game_id, g.sort_title
      from public.releases r
      join public.games g on g.id = r.game_id
      where (v_status is null or r.status = v_status)
        and (v_platform is null or r.platform_id = v_platform)
        and (v_query = ''
             or r.id = v_id or r.game_id = v_id
             or (v_code is not null and pg_catalog.upper(r.product_code) = v_code)
             or (v_barcode is not null and r.barcode = v_barcode)
             or (v_key is not null and (g.search_key like '%' || v_key || '%'
                 or r.local_title_key like '%' || v_key || '%'
                 or exists (select 1 from public.game_aliases a where a.game_id = g.id and a.search_key like '%' || v_key || '%'))))
        and (p_cursor is null or (g.sort_title, r.game_id, r.id) > (c_sort, c_game, c_id))
      order by g.sort_title, r.game_id, r.id
      limit v_limit + 1
    loop
      v_count := v_count + 1;
      if v_count > v_limit then
        v_more := true;
        exit;
      end if;
      l_sort := v_row.sort_title;
      l_game := v_row.game_id;
      l_id := v_row.id;
      v_rows := v_rows || pg_catalog.jsonb_build_array((
        select private.record_release_summary(r) from public.releases r where r.id = v_row.id));
    end loop;
  end if;

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'items', v_rows,
    'next_cursor', case when v_more then private.catalog_cursor_encode(pg_catalog.jsonb_build_array(v_hash, l_sort, l_game, l_id)) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Records
-- ---------------------------------------------------------------------------

-- One game: its catalog fields, other titles, platforms, related games, its first
-- 100 releases, its sources and field locks, and its 20 latest submissions. Null if
-- there is no such game.
create function public.get_game_record(p_game uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  g public.games;
begin
  perform private.require_active_staff('catalog_editor');
  select * into g from public.games x where x.id = p_game;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'id', g.id, 'slug', g.slug, 'title', g.title, 'sort_title', g.sort_title, 'kind', g.kind, 'summary', g.summary,
    'first_release', private.catalog_date_json(g.first_release_date, g.first_release_precision),
    'status', g.status, 'verified_at', g.verified_at, 'revision', g.revision,
    'created_at', g.created_at, 'updated_at', g.updated_at,
    'merged_into', (select pg_catalog.jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status)
                    from public.games t where t.id = g.merged_into_id),
    'aliases', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'title', a.title, 'kind', a.kind, 'language_code', a.language_code, 'region_code', a.region_code)
                  order by a.kind, a.title), '[]')
                from public.game_aliases a where a.game_id = g.id),
    'platforms', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'slug', p.slug, 'name', p.name, 'short_name', p.short_name, 'status', gp.status)
                    order by p.name), '[]')
                  from public.game_platforms gp join public.platforms p on p.id = gp.platform_id where gp.game_id = g.id),
    'relations', (select coalesce(pg_catalog.jsonb_agg(x.j order by x.dir, x.relation, x.title), '[]') from (
                    select 'from' as dir, gr.relation, t.title,
                      pg_catalog.jsonb_build_object('direction', 'outgoing', 'relation', gr.relation, 'position', gr.position,
                        'game', pg_catalog.jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status)) as j
                    from public.game_relations gr join public.games t on t.id = gr.target_game_id where gr.source_game_id = g.id
                    union all
                    select 'to', gr.relation, s.title,
                      pg_catalog.jsonb_build_object('direction', 'incoming', 'relation', gr.relation, 'position', gr.position,
                        'game', pg_catalog.jsonb_build_object('id', s.id, 'title', s.title, 'status', s.status))
                    from public.game_relations gr join public.games s on s.id = gr.source_game_id where gr.target_game_id = g.id
                  ) x),
    'release_count', (select count(*) from public.releases r where r.game_id = g.id),
    'releases', (select coalesce(pg_catalog.jsonb_agg(private.record_release_summary(x) order by x.platform_id, x.region_code, x.id), '[]')
                 from (select r.* from public.releases r where r.game_id = g.id order by r.platform_id, r.region_code, r.id limit 100) x),
    'external_references', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                'provider', pv.name, 'external_id', er.external_id) order by pv.name, er.external_id), '[]')
                            from private.external_references er join private.external_providers pv on pv.code = er.provider_code
                            where er.game_id = g.id),
    'field_locks', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', fl.field_name, 'locked_at', fl.locked_at)
                      order by fl.field_name), '[]')
                    from private.catalog_field_locks fl where fl.game_id = g.id),
    'submissions', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'id', x.id, 'kind', x.request_type, 'status', x.status, 'created_at', x.created_at) order by x.id desc), '[]')
                    from (select s.* from public.catalog_change_requests s where s.game_id = g.id order by s.id desc limit 20) x));
end;
$$;

-- One release: its catalog fields as the public release view lists them, plus
-- status, verification and revision, its sources (which provider supports which
-- field, never the provider's entry), field locks, the merges it took part in, its
-- 20 latest submissions, and for administrators its exclusions. Null if none.
create function public.get_release_record(p_release uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.releases;
begin
  perform private.require_active_staff('catalog_editor');
  select * into r from public.releases x where x.id = p_release;
  if not found then
    return null;
  end if;
  return private.catalog_release_json(r) || pg_catalog.jsonb_build_object(
    'game', (select pg_catalog.jsonb_build_object('id', g.id, 'title', g.title, 'slug', g.slug, 'status', g.status)
             from public.games g where g.id = r.game_id),
    'region_unknown_confirmed', r.region_unknown_confirmed,
    'status', r.status, 'verified_at', r.verified_at, 'revision', r.revision,
    'merged_publicly', r.merged_publicly,
    'created_at', r.created_at, 'updated_at', r.updated_at,
    'merged_into', (select private.record_release_summary(t) from public.releases t where t.id = r.merged_into_id),
    'pairing_status', (select gp.status from public.game_platforms gp where gp.game_id = r.game_id and gp.platform_id = r.platform_id),
    'external_references', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                'provider', pv.name, 'external_id', er.external_id) order by pv.name, er.external_id), '[]')
                            from private.external_references er join private.external_providers pv on pv.code = er.provider_code
                            where er.release_id = r.id),
    'evidence', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', x.field_name, 'provider', x.name, 'sources', x.n)
                   order by x.field_name, x.name), '[]')
                 from (select ev.field_name, pv.name, count(*) as n
                       from private.release_evidence ev
                       join private.provider_records pr on pr.id = ev.provider_record_id
                       join private.external_providers pv on pv.code = pr.provider_code
                       where ev.release_id = r.id
                       group by ev.field_name, pv.name) x),
    'field_locks', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', fl.field_name, 'locked_at', fl.locked_at)
                      order by fl.field_name), '[]')
                    from private.catalog_field_locks fl where fl.release_id = r.id),
    'merges', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                   'id', x.id, 'merged_at', x.merged_at, 'kind', x.kind,
                   'role', case when x.source_release_id = r.id then 'source' else 'target' end,
                   'other', (select private.record_release_summary(o) from public.releases o
                             where o.id = case when x.source_release_id = r.id then x.target_release_id else x.source_release_id end))
                 order by x.id desc), '[]')
               from (select m.* from private.catalog_merges m where m.source_release_id = r.id or m.target_release_id = r.id
                     order by m.id desc limit 20) x),
    'submissions', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'id', x.id, 'kind', x.request_type, 'status', x.status, 'created_at', x.created_at) order by x.id desc), '[]')
                    from (select s.* from public.catalog_change_requests s
                          where s.release_id = r.id or s.merged_into_release_id = r.id order by s.id desc limit 20) x),
    'exclusions', case when private.has_staff_role('admin') then
                    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'id', x.id, 'excluded_at', x.excluded_at, 'reason_code', x.reason_code, 'restored_at', x.restored_at)
                       order by x.id desc), '[]')
                     from (select e.* from private.catalog_exclusions e where e.release_id = r.id order by e.id desc limit 20) x)
                  end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. History (D4)
-- ---------------------------------------------------------------------------

-- One game's or release's events, newest first, in pages of at most 50 before an
-- event id. A game's are those recorded on it, on its platform pairings and its
-- relations (either side), and submissions naming it; a release's are those on it,
-- merges into it, and its submissions. Only the actions in history_actions(), each
-- shaped by history_event_json(). 'record unavailable' if there is no such record.
create function public.get_catalog_record_history(
  p_entity text,
  p_id uuid,
  p_limit integer default 25,
  p_before uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_id text := p_id::text;
  v_actions private.audit_action[];
  v_rows jsonb := '[]';
  v_count integer := 0;
  v_more boolean := false;
  v_last uuid;
  e private.audit_events;
begin
  perform private.require_active_staff('catalog_editor');
  if p_entity is null or p_entity not in ('game', 'release') or p_id is null then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  if (p_entity = 'game' and not exists (select 1 from public.games g where g.id = p_id))
     or (p_entity = 'release' and not exists (select 1 from public.releases r where r.id = p_id)) then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  v_actions := private.history_actions()::private.audit_action[];

  for e in
    select x.* from (
      select a.* from private.audit_events a
      where a.metadata ? 'id' and a.metadata ->> 'id' = v_id
        and (p_before is null or a.id < p_before)
        and a.metadata ->> 'entity' = any (case when p_entity = 'game' then array['game', 'game_platform', 'game_relation'] else array['release'] end)
      union
      select a.* from private.audit_events a
      where a.metadata ? 'target_id' and a.metadata ->> 'target_id' = v_id
        and (p_before is null or a.id < p_before)
        and ((p_entity = 'game' and a.metadata ->> 'entity' = 'game_relation')
             or (p_entity = 'release' and a.action = 'catalog_release_merged'))
      union
      select a.* from private.audit_events a
      where p_entity = 'release' and a.metadata ? 'release_id' and a.metadata ->> 'release_id' = v_id
        and (p_before is null or a.id < p_before)
        and a.action::text like 'catalog_submission_%'
      union
      select a.* from private.audit_events a
      where p_entity = 'game' and a.metadata ? 'game_id' and a.metadata ->> 'game_id' = v_id
        and (p_before is null or a.id < p_before)
        and a.action::text like 'catalog_submission_%'
    ) x
    where x.action = any (v_actions)
    order by x.id desc
    limit v_limit + 1
  loop
    v_count := v_count + 1;
    if v_count > v_limit then
      v_more := true;
      exit;
    end if;
    v_last := e.id;
    v_rows := v_rows || pg_catalog.jsonb_build_array(private.history_event_json(e));
  end loop;

  return pg_catalog.jsonb_build_object('items', v_rows, 'next_before', case when v_more then v_last end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Access
-- ---------------------------------------------------------------------------

revoke all on function public.search_catalog_records(text, text, text, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.get_game_record(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_release_record(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_catalog_record_history(text, uuid, integer, uuid) from public, anon, authenticated, service_role;
grant execute on function public.search_catalog_records(text, text, text, text, integer, text) to authenticated;
grant execute on function public.get_game_record(uuid) to authenticated;
grant execute on function public.get_release_record(uuid) to authenticated;
grant execute on function public.get_catalog_record_history(text, uuid, integer, uuid) to authenticated;
