-- M5c Catalog search: the public search, release picker and platform list.
--
-- Design: docs/architecture/security-rls.md#catalog-search
-- Three read-only functions that anon and signed-in users call. Each is STABLE, so
-- it can't write, and SECURITY DEFINER with an empty search_path, so it can read the
-- private search keys without exposing them. Each filters every source explicitly:
-- the RLS read policies also return merged records and a user's own submissions,
-- which search never shows, to anyone, editors included.
--
-- What is public: a game is listed only when it is published and has at least one
-- published, verified release on a published platform pairing. Only such releases
-- are shown. Each function builds its response from a fixed list of fields, and
-- never includes who submitted, verified or edited anything, provenance, audit
-- data, revisions or review state.
--
-- Unknown stays unknown: a field the catalog doesn't have is null, never a default.
-- A date is given only to the precision the catalog records.

-- ---------------------------------------------------------------------------
-- 1. Response helpers. None is reachable from the API.
-- ---------------------------------------------------------------------------

-- A date to the precision the catalog records: "1994", "1994-03" or "1994-03-11".
create function private.catalog_date_json(p_date date, p_precision public.date_precision)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_date is null or p_precision = 'unknown' then null
    else pg_catalog.jsonb_build_object(
      'value', pg_catalog.to_char(p_date, case p_precision when 'day' then 'YYYY-MM-DD' when 'month' then 'YYYY-MM' else 'YYYY' end),
      'precision', p_precision)
  end
$$;

-- A published game's public fields.
create function private.catalog_game_json(p_game public.games)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_game.id,
    'slug', p_game.slug,
    'title', p_game.title,
    'kind', p_game.kind,
    'first_release', private.catalog_date_json(p_game.first_release_date, p_game.first_release_precision))
$$;

-- The platforms a game has public releases on, with how many.
create function private.catalog_game_platforms_json(p_game uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'slug', p.slug, 'name', p.name, 'short_name', p.short_name, 'release_count', x.n) order by p.name, p.slug), '[]')
  from (
    select r.platform_id, count(*)::integer as n
    from public.releases r
    join public.game_platforms gp on gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published'
    where r.game_id = p_game and r.status = 'published' and r.verified_at is not null
    group by r.platform_id
  ) x
  join public.platforms p on p.id = x.platform_id
$$;

-- A public release's fields, for the picker. Absent details are null.
create function private.catalog_release_json(p_release public.releases)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_release.id,
    'platform', (select pg_catalog.jsonb_build_object('slug', p.slug, 'name', p.name, 'short_name', p.short_name)
                 from public.platforms p where p.id = p_release.platform_id),
    'region', (select pg_catalog.jsonb_build_object('code', rc.code, 'label', rc.label)
               from public.region_codes rc where rc.code = p_release.region_code),
    'markets', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code', m.code, 'name', m.name) order by m.name), '[]')
                from public.release_markets rm join public.markets m on m.code = rm.market_code where rm.release_id = p_release.id),
    'edition', case when p_release.edition_name is null and p_release.edition_kind is null then null
                    else pg_catalog.jsonb_build_object('name', p_release.edition_name, 'kind', p_release.edition_kind) end,
    'variant_name', p_release.variant_name,
    'local_title', p_release.local_title,
    'publisher_name', p_release.publisher_name,
    'format', (select pg_catalog.jsonb_build_object('code', f.code, 'name', f.name, 'category', f.category)
               from public.media_formats f where f.code = p_release.media_format_code),
    'media_count', p_release.media_count,
    'media_playability', nullif(p_release.media_playability, 'unknown'),
    'packaging', p_release.packaging,
    'identifiers', pg_catalog.jsonb_build_object('product_code', p_release.product_code, 'barcode', p_release.barcode),
    'languages', pg_catalog.to_jsonb(p_release.languages),
    'rating_labels', pg_catalog.to_jsonb(p_release.rating_labels),
    'release_date', private.catalog_date_json(p_release.release_date, p_release.release_date_precision),
    'components', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'kind', c.kind, 'label', c.label, 'quantity', c.quantity,
                       'format', (select f.name from public.media_formats f where f.code = c.media_format_code))
                     order by c.kind, c.label), '[]')
                   from public.release_components c where c.release_id = p_release.id),
    'requirements', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'code', h.requirement_code, 'label', hr.label, 'level', h.level, 'note', h.note)
                       order by hr.label), '[]')
                     from public.release_hardware_requirements h join public.hardware_requirements hr on hr.code = h.requirement_code
                     where h.release_id = p_release.id))
$$;

-- An opaque page cursor, and its reverse. The reverse raises 'invalid cursor' for
-- anything it didn't make.
create function private.catalog_cursor_encode(p_value jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.rtrim(pg_catalog.translate(
    pg_catalog.replace(pg_catalog.encode(pg_catalog.convert_to(p_value::text, 'UTF8'), 'base64'), pg_catalog.chr(10), ''),
    '+/', '-_'), '=')
$$;

create function private.catalog_cursor_decode(p_cursor text)
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
  if pg_catalog.jsonb_typeof(v) <> 'array' or pg_catalog.jsonb_array_length(v) <> 7 then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Search
-- ---------------------------------------------------------------------------

-- Searches published games by title, alias and local release title, and published
-- releases by exact product code or barcode. Results are games, except that an
-- exact identifier match is the release it identifies.
--
-- Matches, best first: 'code' (an exact identifier), 'exact' (the same key, or the
-- same ignoring word breaks), 'prefix' (the key starts with the query), 'words'
-- (every query word, the last as a prefix), 'similar' (trigram similarity of at
-- least 0.5, or word similarity of at least 0.6, for typos and scripts without word
-- breaks, from five Latin letters or two of another script). Within a match, titles
-- that add least to the query come first, and similar titles by similarity; then
-- sort title and id, so the order is always the same. With no query but a platform
-- filter, it lists that platform's games by sort title ('browse').
--
-- Pages are keyset: next_cursor continues where the page ended, and is tied to
-- the query and filter it came from. At most 200 results per query. A query has
-- at most 100 characters and needs two letters or digits, or one of a script that
-- doesn't use Latin letters. Distinct games are never combined: two games with the
-- same title are two results.
--
-- Planning: each call is planned for its own values (plan_cache_mode), so a prefix
-- is an index range rather than a generic plan's scan. Each match condition is its
-- own branch with its own index; the planner otherwise decides as usual. (A single
-- query ORing the conditions led it to read every game row by row.)
create function public.search_catalog(
  p_query text default null,
  p_platforms text[] default null,
  p_limit integer default 20,
  p_cursor text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  c_max_results constant integer := 200;
  c_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_query text := pg_catalog.btrim(coalesce(p_query, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_platforms uuid[];
  v_slugs text[] := '{}';
  v_key text;
  v_compact text;
  v_pattern text;
  v_words tsquery;
  v_fuzzy boolean := false;
  v_latin boolean;
  v_browse boolean := false;
  v_code text;
  v_barcode text;
  v_hash text;
  v_cursor jsonb;
  c_n integer := 0;
  c_tier integer;
  c_score integer;
  c_sort text;
  c_game uuid;
  c_release uuid;
  v_take integer;
  v_row record;
  v_rows jsonb := '[]';
  v_count integer := 0;
  v_more boolean := false;
  -- The last row returned, in scalars: a record that a call never assigned has no
  -- fields, so reading it fails when a page is empty.
  l_tier integer;
  l_score integer;
  l_sort text;
  l_game uuid;
  l_release uuid;
  v_items jsonb;
  v_trgm_similarity text;
  v_trgm_word_similarity text;
begin
  if pg_catalog.char_length(v_query) > 100 then
    raise exception 'query too long' using errcode = '22023';
  end if;
  if p_platforms is not null and cardinality(p_platforms) > 10 then
    raise exception 'too many platforms' using errcode = '22023';
  end if;
  if p_platforms is not null and cardinality(p_platforms) > 0 then
    select coalesce(pg_catalog.array_agg(p.id order by p.slug), '{}'), coalesce(pg_catalog.array_agg(p.slug order by p.slug), '{}')
    into v_platforms, v_slugs
    from public.platforms p where p.slug = any(p_platforms);
  end if;

  if v_query = '' then
    if v_platforms is null then
      return pg_catalog.jsonb_build_object('status', 'empty', 'platforms', pg_catalog.to_jsonb(v_slugs), 'items', '[]'::jsonb, 'next_cursor', null);
    end if;
    v_browse := true;
  else
    v_key := private.catalog_search_key(v_query);
    if v_key is null or (pg_catalog.char_length(v_key) < 2 and pg_catalog.octet_length(v_key) = pg_catalog.char_length(v_key)) then
      return pg_catalog.jsonb_build_object('status', 'too_short', 'platforms', pg_catalog.to_jsonb(v_slugs), 'items', '[]'::jsonb, 'next_cursor', null);
    end if;
    v_compact := pg_catalog.replace(v_key, ' ', '');
    v_pattern := v_key || '%';
    select pg_catalog.to_tsquery('pg_catalog.simple', pg_catalog.string_agg(pg_catalog.quote_literal(t) || case when o = n then ':*' else '' end, ' & ' order by o))
    into v_words
    from (select t, o, count(*) over () as n from pg_catalog.unnest(pg_catalog.string_to_array(v_key, ' ')) with ordinality as x(t, o)) s;
    -- Latin queries of one or two characters match whole-title prefixes only, and
    -- similarity needs five, so a short query doesn't match most of the catalog.
    -- Scripts without Latin letters carry more per character.
    v_latin := pg_catalog.octet_length(v_key) = pg_catalog.char_length(v_key);
    if v_latin and pg_catalog.char_length(v_key) < 3 then
      v_words := null;
    end if;
    v_fuzzy := pg_catalog.char_length(v_key) >= case when v_latin then 5 else 2 end;
    v_code := pg_catalog.upper(pg_catalog.regexp_replace(v_query, '\s+', '', 'g'));
    if v_code !~ '^[A-Z0-9][A-Z0-9-]{2,39}$' or v_code !~ '[0-9-]' then
      v_code := null;
    end if;
    v_barcode := pg_catalog.regexp_replace(v_query, '[\s-]+', '', 'g');
    if v_barcode !~ '^[0-9]{8,14}$' then
      v_barcode := null;
    end if;
  end if;

  v_hash := pg_catalog.left(pg_catalog.md5(concat_ws('|', coalesce(v_key, ''), pg_catalog.array_to_string(v_slugs, ','), coalesce(v_code, ''), coalesce(v_barcode, ''), v_browse::text)), 12);
  if p_cursor is not null then
    v_cursor := private.catalog_cursor_decode(p_cursor);
    begin
      c_n := (v_cursor ->> 1)::integer;
      c_tier := (v_cursor ->> 2)::integer;
      c_score := (v_cursor ->> 3)::integer;
      c_sort := v_cursor ->> 4;
      c_game := (v_cursor ->> 5)::uuid;
      c_release := (v_cursor ->> 6)::uuid;
    exception when others then
      raise exception 'invalid cursor' using errcode = '22023';
    end;
    if v_cursor ->> 0 is distinct from v_hash or c_n is null or c_n < 1 or c_n >= c_max_results
       or c_tier is null or c_score is null or c_sort is null or c_game is null or c_release is null then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
  end if;
  v_take := least(v_limit, c_max_results - c_n);

  -- The trigram operators read their thresholds from settings any session can change,
  -- so fix them for this query and restore the caller's afterwards. Both are
  -- user-settable: no superuser, and nothing a hosted migration can't create.
  v_trgm_similarity := coalesce(pg_catalog.current_setting('pg_trgm.similarity_threshold', true), '0.3');
  v_trgm_word_similarity := coalesce(pg_catalog.current_setting('pg_trgm.word_similarity_threshold', true), '0.6');
  perform pg_catalog.set_config('pg_trgm.similarity_threshold', '0.5', true);
  perform pg_catalog.set_config('pg_trgm.word_similarity_threshold', '0.6', true);

  for v_row in
    -- One branch per condition, so each uses its own index; best removes repeats.
    with titles as (
      select g.id as game_id, g.search_key as k, g.search_words as w, null::text as matched, null::text as source
      from public.games g where v_key is not null and g.status = 'published' and g.search_key like v_pattern
      union all
      select g.id, g.search_key, g.search_words, null, null
      from public.games g where v_key is not null and g.status = 'published' and g.search_compact = v_compact
      union all
      select g.id, g.search_key, g.search_words, null, null
      from public.games g where v_words is not null and g.status = 'published' and g.search_words @@ v_words
      union all
      select g.id, g.search_key, g.search_words, null, null
      from public.games g where v_fuzzy and g.status = 'published'
        and v_key operator(extensions.%) g.search_key and extensions.similarity(v_key, g.search_key) >= 0.5
      union all
      select g.id, g.search_key, g.search_words, null, null
      from public.games g where v_fuzzy and g.status = 'published' and v_key operator(extensions.<%) g.search_key
      union all
      select a.game_id, a.search_key, a.search_words, a.title, 'alias'
      from public.game_aliases a where v_key is not null and a.search_key like v_pattern
      union all
      select a.game_id, a.search_key, a.search_words, a.title, 'alias'
      from public.game_aliases a where v_key is not null and a.search_compact = v_compact
      union all
      select a.game_id, a.search_key, a.search_words, a.title, 'alias'
      from public.game_aliases a where v_words is not null and a.search_words @@ v_words
      union all
      select a.game_id, a.search_key, a.search_words, a.title, 'alias'
      from public.game_aliases a where v_fuzzy
        and v_key operator(extensions.%) a.search_key and extensions.similarity(v_key, a.search_key) >= 0.5
      union all
      select a.game_id, a.search_key, a.search_words, a.title, 'alias'
      from public.game_aliases a where v_fuzzy and v_key operator(extensions.<%) a.search_key
      union all
      select r.game_id, r.local_title_key, null::tsvector, r.local_title, 'local_title'
      from public.releases r where v_key is not null and r.status = 'published' and r.verified_at is not null
        and r.local_title_key is not null and r.local_title_key like v_pattern
      union all
      select r.game_id, r.local_title_key, null::tsvector, r.local_title, 'local_title'
      from public.releases r where v_fuzzy and r.status = 'published' and r.verified_at is not null and r.local_title_key is not null
        and v_key operator(extensions.%) r.local_title_key and extensions.similarity(v_key, r.local_title_key) >= 0.5
      union all
      select r.game_id, r.local_title_key, null::tsvector, r.local_title, 'local_title'
      from public.releases r where v_fuzzy and r.status = 'published' and r.verified_at is not null and r.local_title_key is not null
        and v_key operator(extensions.<%) r.local_title_key
    ),
    -- Within a tier: the exact key first, then titles that add least to the query,
    -- and for similar titles, the most similar. Similarity is computed only there.
    scored as (
      select s.game_id, s.matched, s.source, s.tier,
        case
          when s.k = v_key then 1000
          when s.tier < 4 then 999 - least(abs(pg_catalog.char_length(s.k) - pg_catalog.char_length(v_key)), 998)
          else pg_catalog.floor(greatest(extensions.similarity(v_key, s.k), extensions.word_similarity(v_key, s.k)) * 1000)::integer
        end as score
      from (
        select t.*,
          case
            when t.k = v_key or pg_catalog.replace(t.k, ' ', '') = v_compact then 1
            when t.k like v_pattern then 2
            when t.w @@ v_words then 3
            else 4
          end as tier
        from titles t
      ) s
    ),
    best as (
      select distinct on (s.game_id) s.game_id, s.tier, s.score, s.matched, s.source
      from scored s
      order by s.game_id, s.tier, s.score desc, (s.source is not null), s.matched
    ),
    results as (
      -- An exact identifier: the release itself.
      select 0 as tier, 1000 as score, g.sort_title, g.id as game_id, r.id as release_id, null::text as matched, null::text as source,
        case when v_code is not null and pg_catalog.upper(r.product_code) = v_code then 'product_code' else 'barcode' end as identifier
      from public.releases r
      join public.game_platforms gp on gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published'
      join public.games g on g.id = r.game_id and g.status = 'published'
      where r.status = 'published' and r.verified_at is not null
        and ((v_code is not null and pg_catalog.upper(r.product_code) = v_code) or (v_barcode is not null and r.barcode = v_barcode))
        and (v_platforms is null or r.platform_id = any(v_platforms))
      union all
      select b.tier, b.score, g.sort_title, g.id, null::uuid, b.matched, b.source, null::text
      from best b
      join public.games g on g.id = b.game_id and g.status = 'published'
      where exists (
        select 1 from public.releases r
        join public.game_platforms gp on gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published'
        where r.game_id = g.id and r.status = 'published' and r.verified_at is not null
          and (v_platforms is null or r.platform_id = any(v_platforms)))
      union all
      select 5, 0, g.sort_title, g.id, null::uuid, null::text, null::text, null::text
      from public.games g
      where v_browse and g.status = 'published' and exists (
        select 1 from public.releases r
        join public.game_platforms gp on gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published'
        where r.game_id = g.id and r.status = 'published' and r.verified_at is not null and r.platform_id = any(v_platforms))
    )
    select x.* from results x
    where p_cursor is null
       or (x.tier, -x.score, x.sort_title, x.game_id, coalesce(x.release_id, c_zero)) > (c_tier, -c_score, c_sort, c_game, c_release)
    order by x.tier, -x.score, x.sort_title, x.game_id, coalesce(x.release_id, c_zero)
    limit v_take + 1
  loop
    v_count := v_count + 1;
    if v_count > v_take then
      v_more := true;
      exit;
    end if;
    l_tier := v_row.tier;
    l_score := v_row.score;
    l_sort := v_row.sort_title;
    l_game := v_row.game_id;
    l_release := coalesce(v_row.release_id, c_zero);
    v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'tier', v_row.tier, 'game_id', v_row.game_id, 'release_id', v_row.release_id,
      'matched', v_row.matched, 'source', v_row.source, 'identifier', v_row.identifier));
  end loop;
  perform pg_catalog.set_config('pg_trgm.similarity_threshold', v_trgm_similarity, true);
  perform pg_catalog.set_config('pg_trgm.word_similarity_threshold', v_trgm_word_similarity, true);

  select coalesce(pg_catalog.jsonb_agg(
      case when e ->> 'release_id' is not null then pg_catalog.jsonb_build_object(
        'kind', 'release',
        'match', 'code',
        'matched_identifier', e ->> 'identifier',
        'game', private.catalog_game_json(g),
        'release', pg_catalog.jsonb_build_object(
          'id', r.id,
          'platform', pg_catalog.jsonb_build_object('slug', p.slug, 'name', p.name, 'short_name', p.short_name),
          'region', pg_catalog.jsonb_build_object('code', rc.code, 'label', rc.label),
          'edition_name', r.edition_name,
          'variant_name', r.variant_name,
          'identifiers', pg_catalog.jsonb_build_object('product_code', r.product_code, 'barcode', r.barcode)))
      else pg_catalog.jsonb_build_object(
        'kind', 'game',
        'match', (array['exact', 'prefix', 'words', 'similar', 'browse'])[(e ->> 'tier')::integer],
        'matched', case when e ->> 'source' is null then null
                        else pg_catalog.jsonb_build_object('title', e ->> 'matched', 'source', e ->> 'source') end,
        'game', private.catalog_game_json(g),
        'platforms', private.catalog_game_platforms_json(g.id))
      end order by o), '[]')
  into v_items
  from pg_catalog.jsonb_array_elements(v_rows) with ordinality as x(e, o)
  join public.games g on g.id = (e ->> 'game_id')::uuid
  left join public.releases r on r.id = (e ->> 'release_id')::uuid
  left join public.platforms p on p.id = r.platform_id
  left join public.region_codes rc on rc.code = r.region_code;

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'platforms', pg_catalog.to_jsonb(v_slugs),
    'items', v_items,
    'next_cursor', case when v_more and c_n + v_count - 1 < c_max_results then private.catalog_cursor_encode(pg_catalog.jsonb_build_array(
      v_hash, c_n + v_take, l_tier, l_score, l_sort, l_game, l_release)) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Release picker
-- ---------------------------------------------------------------------------

-- A public game, by slug or id, with its public releases, for choosing one. A
-- merged game resolves to the game it was merged into, but only when it was itself
-- public once (it has a slug) and the game it resolves to is public now. Anything
-- else, unknown, unpublished, rejected or without a public release, is null, the
-- same for every case.
--
-- p_release selects a release and sets the platform and region to its own. Without
-- it, p_platform and p_region filter the releases, and a game on one platform has
-- that platform selected. A filter the game has no public release for is ignored.
create function public.get_release_picker(
  p_game text,
  p_platform text default null,
  p_region text default null,
  p_release uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_depth integer := 0;
  v_platform uuid;
  v_region text;
  v_selected uuid;
  v_platforms jsonb;
  v_regions jsonb;
  v_releases jsonb;
begin
  if p_game is null or pg_catalog.char_length(p_game) > 120 then
    return null;
  end if;
  if p_game ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_game from public.games g where g.id = p_game::uuid;
  else
    select * into v_game from public.games g where g.slug = p_game;
  end if;
  if not found then
    return null;
  end if;
  while v_game.status = 'merged' loop
    v_depth := v_depth + 1;
    if v_game.slug is null or v_depth > 10 then
      return null;
    end if;
    select * into v_game from public.games g where g.id = v_game.merged_into_id;
    if not found then
      return null;
    end if;
  end loop;
  if v_game.status <> 'published' then
    return null;
  end if;


  select r.id, r.platform_id, r.region_code into v_selected, v_platform, v_region
  from private.catalog_public_releases(v_game.id) r where r.id = p_release;
  if v_selected is null then
    select p.id into v_platform from public.platforms p
    where p.slug = p_platform and exists (select 1 from private.catalog_public_releases(v_game.id) r where r.platform_id = p.id);
    if v_platform is null then
      select min(r.platform_id::text)::uuid into v_platform from private.catalog_public_releases(v_game.id) r
      having count(distinct r.platform_id) = 1;
    end if;
    select rc.code into v_region from public.region_codes rc
    where rc.code = p_region and exists (select 1 from private.catalog_public_releases(v_game.id) r
                                          where r.region_code = rc.code and (v_platform is null or r.platform_id = v_platform));
  end if;

  v_platforms := private.catalog_game_platforms_json(v_game.id);
  if v_platforms = '[]' then
    return null;
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code', rc.code, 'label', rc.label, 'release_count', x.n)
           order by rc.position), '[]')
  into v_regions
  from (select r.region_code, count(*)::integer as n from private.catalog_public_releases(v_game.id) r
        where v_platform is null or r.platform_id = v_platform group by r.region_code) x
  join public.region_codes rc on rc.code = x.region_code;

  select coalesce(pg_catalog.jsonb_agg(private.catalog_release_json(r)
           order by p.name, p.slug, rc.position, r.release_date nulls last, r.edition_kind nulls first,
                    r.edition_name nulls first, r.variant_name nulls first, r.id), '[]')
  into v_releases
  from private.catalog_public_releases(v_game.id) r
  join public.platforms p on p.id = r.platform_id
  join public.region_codes rc on rc.code = r.region_code
  where (v_platform is null or r.platform_id = v_platform) and (v_region is null or r.region_code = v_region);

  return pg_catalog.jsonb_build_object(
    'game', private.catalog_game_json(v_game) || pg_catalog.jsonb_build_object('aliases',
      (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'title', a.title, 'kind', a.kind, 'language_code', a.language_code, 'region_code', a.region_code)
        order by a.kind, a.title, a.id), '[]')
       from public.game_aliases a where a.game_id = v_game.id)),
    'platforms', v_platforms,
    'regions', v_regions,
    'selection', pg_catalog.jsonb_build_object(
      'platform', (select p.slug from public.platforms p where p.id = v_platform),
      'region', v_region,
      'release_id', v_selected),
    'releases', v_releases);
end;
$$;

-- A public game's public releases: published and verified, on a published pairing.
create function private.catalog_public_releases(p_game uuid)
returns setof public.releases
language sql
stable
set search_path = ''
as $$
  select r.* from public.releases r
  join public.game_platforms gp on gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published'
  join public.games g on g.id = r.game_id and g.status = 'published'
  where r.game_id = p_game and r.status = 'published' and r.verified_at is not null
$$;

-- ---------------------------------------------------------------------------
-- 4. Platforms
-- ---------------------------------------------------------------------------

-- Every platform in the catalog, whether or not it has public releases yet, with
-- its regional names and how many public games and releases it has.
create function public.list_catalog_platforms()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'slug', p.slug,
      'name', p.name,
      'short_name', p.short_name,
      'manufacturer', p.manufacturer,
      'family', p.family,
      'kind', p.kind,
      'names', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', n.name, 'region_code', n.region_code)
                  order by n.name, n.region_code), '[]')
                from public.platform_names n where n.platform_id = p.id),
      'game_count', coalesce(c.games, 0),
      'release_count', coalesce(c.releases, 0))
    order by p.name, p.slug), '[]')
  from public.platforms p
  left join (
    select r.platform_id, count(distinct r.game_id)::integer as games, count(*)::integer as releases
    from public.releases r
    join public.game_platforms gp on gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published'
    join public.games g on g.id = r.game_id and g.status = 'published'
    where r.status = 'published' and r.verified_at is not null
    group by r.platform_id
  ) c on c.platform_id = p.id
$$;

-- ---------------------------------------------------------------------------
-- 5. Access
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.catalog_date_json(date, public.date_precision)',
    'private.catalog_game_json(public.games)',
    'private.catalog_game_platforms_json(uuid)',
    'private.catalog_release_json(public.releases)',
    'private.catalog_cursor_encode(jsonb)',
    'private.catalog_cursor_decode(text)',
    'private.catalog_public_releases(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
  end loop;

  foreach v_signature in array array[
    'public.search_catalog(text, text[], integer, text)',
    'public.get_release_picker(text, text, text, uuid)',
    'public.list_catalog_platforms()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
    execute format('grant execute on function %s to anon, authenticated', v_signature);
  end loop;
end;
$$;
