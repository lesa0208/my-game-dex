-- M15 catalog UX: what the sources said about a game, for catalog editors. Read only.
--
-- An imported game keeps its source record in private.provider_records: the provider's titles,
-- dates, platforms, developers, publishers, distribution formats, external ids and the risk
-- assessment its flags travel in. Until now an editor could see none of it on the game's page
-- (only "wikidata: Q…"). This returns it, as the source stated it: claims to check, never
-- verified facts, and never evidence of a physical release.
--
-- It also lists the held source records (an editorial hold: no game was created) whose title
-- matches one of this game's title keys, so a possible duplicate the import held back is visible
-- beside the game it may duplicate.
--
-- Catalog editors only (private.require_active_staff), like get_game_record. Nothing is written.

create or replace function public.get_game_source_facts(p_game uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_staff('catalog_editor');
  if not exists (select 1 from public.games g where g.id = p_game) then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'sources', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'provider', pr.provider_code,
          'provider_name', ep.name,
          'external_id', pr.external_id,
          'record_status', pr.status,
          'imported_at', ir.started_at,
          'source_name', ir.source_name,
          'source_sha256', ir.source_sha256,
          'source_fetched_at', ir.source_fetched_at,
          'terms_sha256', ir.terms_sha256,
          'licence', pg_catalog.jsonb_build_object(
            'cleared', ep.commercial_use_cleared,
            'terms_url', ep.terms_url,
            'rights_survive_withdrawal', ep.rights_survive_withdrawal),
          'title', pr.payload ->> 'title',
          'titles', coalesce(pr.payload -> 'titles', '[]'),
          'ja_titles', coalesce(pr.payload -> 'ja_titles', '[]'),
          'first_release_date', pr.payload ->> 'first_release_date',
          'first_release_precision', pr.payload ->> 'first_release_precision',
          'source', coalesce(pr.payload -> 'source', '{}'),
          'flags', coalesce(pr.payload -> 'risk_assessment' -> 'flags', '[]'),
          'critical', coalesce(pr.payload -> 'risk_assessment' -> 'critical', '[]'))
        order by pr.created_at), '[]')
      from private.provider_records pr
      join private.import_runs ir on ir.id = pr.import_run_id
      join private.external_providers ep on ep.code = pr.provider_code
      where pr.matched_game_id = p_game and pr.entity_type = 'game'),
    'held_lookalikes', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'provider', h.provider_code, 'external_id', h.external_id,
          'title', h.payload ->> 'title', 'reason', h.review_reason)
        order by h.external_id), '[]')
      from private.provider_records h
      where h.entity_type = 'game'
        and h.matched_game_id is null
        and h.review_reason is not null
        and exists (
          select 1 from private.game_title_keys k
          where k.game_id = p_game
            and k.title_key = private.import_title_key(h.payload ->> 'title')))
  );
end;
$$;

revoke all on function public.get_game_source_facts(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_game_source_facts(uuid) to authenticated;

-- Catalog records search (search_catalog_records, M10b) also finds a game by the other titles its
-- own source records list ("Zelda no Densetsu" finds A Link to the Past). Until now it matched only
-- the game's title and its aliases, and imported titles are kept with the source record, not as
-- aliases. Unchanged otherwise: the same arguments, rules, pages and privileges.
create or replace function public.search_catalog_records(
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
                 or exists (select 1 from public.game_aliases a where a.game_id = g.id and a.search_key like '%' || v_key || '%')
                 -- M15 catalog UX: the other titles the game's own source records list.
                 or exists (select 1 from private.provider_records pr, pg_catalog.jsonb_array_elements_text(
                              case when pg_catalog.jsonb_typeof(pr.payload -> 'titles') = 'array' then pr.payload -> 'titles' else '[]' end
                              || case when pg_catalog.jsonb_typeof(pr.payload -> 'ja_titles') = 'array' then pr.payload -> 'ja_titles' else '[]' end) t
                            where pr.matched_game_id = g.id and pr.entity_type = 'game' and private.catalog_search_key(t) like '%' || v_key || '%'))))
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
                 or exists (select 1 from public.game_aliases a where a.game_id = g.id and a.search_key like '%' || v_key || '%')
                 -- M15 catalog UX: the other titles the game's own source records list.
                 or exists (select 1 from private.provider_records pr, pg_catalog.jsonb_array_elements_text(
                              case when pg_catalog.jsonb_typeof(pr.payload -> 'titles') = 'array' then pr.payload -> 'titles' else '[]' end
                              || case when pg_catalog.jsonb_typeof(pr.payload -> 'ja_titles') = 'array' then pr.payload -> 'ja_titles' else '[]' end) t
                            where pr.matched_game_id = g.id and pr.entity_type = 'game' and private.catalog_search_key(t) like '%' || v_key || '%'))))
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
