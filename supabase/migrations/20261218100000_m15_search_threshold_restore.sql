-- Collector fast add: catalog search no longer fails on a connection's second search.
--
-- public.search_catalog saves the two pg_trgm thresholds, sets its own for the search, and sets
-- the saved ones back at the end. On a connection where pg_trgm's library isn't loaded yet (its
-- searches so far needed no fuzzy matching: a platform browse, a short query), a setting set
-- locally leaves an empty placeholder behind, so the next search saved '' and, with the library
-- loaded by then, setting '' back failed: "invalid value for parameter
-- "pg_trgm.similarity_threshold": """. A collector browsing a platform and then searching a
-- title on the same pooled connection got an error page.
--
-- The fix reads an empty saved value as unset, so pg_trgm's defaults are set back. The function
-- is otherwise exactly the current definition (migration 20261210100100), with its signature,
-- security definer, search path and grants unchanged (create or replace keeps the grants).
-- Nothing else is changed, and no data.

CREATE OR REPLACE FUNCTION public.search_catalog(p_query text DEFAULT NULL::text, p_platforms text[] DEFAULT NULL::text[], p_limit integer DEFAULT 20, p_cursor text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
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
  v_trgm_similarity := coalesce(nullif(pg_catalog.current_setting('pg_trgm.similarity_threshold', true), ''), '0.3');
  v_trgm_word_similarity := coalesce(nullif(pg_catalog.current_setting('pg_trgm.word_similarity_threshold', true), ''), '0.6');
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
      -- B1-M1: a published release, or a published, independently verified pairing.
      where private.catalog_game_listed(g.id, v_platforms)
      union all
      select 5, 0, g.sort_title, g.id, null::uuid, null::text, null::text, null::text
      from public.games g
      -- B1-M1: as above, on the platforms browsed.
      where v_browse and g.status = 'published' and private.catalog_game_listed(g.id, v_platforms)
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
$function$;
