-- M18a security fix: provider metadata is read by the app's server only.
--
-- IGDB's terms rule out redistributing its data as-is "through their own APIs". Granted to anon
-- (20261221100000), public.get_game_provider_metadata could be called by anyone holding the
-- publishable key, through the Supabase REST API, and would return IGDB's records as stored. Now
-- only service_role (the app server's SUPABASE_SECRET_KEY, never sent to a browser) may call it;
-- the pages render what it returns, labelled and credited, as before.
--
-- The function is recreated with one more column, platform_ids: the IGDB platform ids IGDB lists
-- for the game, so the app shows a game-level cover only on a platform IGDB lists for it (never
-- the SNES cover on the GBA page), and the honest fallback otherwise. Same rules otherwise:
-- published games, the provider cleared now, images only while its media are cleared.
--
-- Grants: service_role only. anon, authenticated and catalog_importer can't call it.

drop function public.get_game_provider_metadata(uuid[]);

create function public.get_game_provider_metadata(p_games uuid[])
returns table (
  game_id uuid,
  provider text,
  provider_name text,
  external_id text,
  slug text,
  url text,
  name text,
  summary text,
  genres text[],
  themes text[],
  developers text[],
  publishers text[],
  first_release_date text,
  platforms text[],
  platform_ids integer[],
  cover jsonb,
  screenshots jsonb,
  fetched_at text,
  attached_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, p.code, p.name, x.external_id,
    pg_catalog.left(r.payload ->> 'slug', 200),
    case when (r.payload ->> 'url') ~ '^https://www\.igdb\.com/games/[a-z0-9-]{1,200}$' then r.payload ->> 'url' end,
    pg_catalog.left(r.payload ->> 'name', 300),
    pg_catalog.left(r.payload ->> 'summary', 4000),
    private.provider_text_list(r.payload -> 'genres', 12),
    private.provider_text_list(r.payload -> 'themes', 12),
    private.provider_text_list(r.payload -> 'developers', 8),
    private.provider_text_list(r.payload -> 'publishers', 8),
    case when (r.payload ->> 'first_release_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then r.payload ->> 'first_release_date' end,
    private.provider_text_list(r.payload -> 'platforms', 30),
    case when pg_catalog.jsonb_typeof(r.payload -> 'platform_ids') = 'array' then coalesce((
      select pg_catalog.array_agg(e.v::integer order by e.o)
      from pg_catalog.jsonb_array_elements_text(r.payload -> 'platform_ids') with ordinality e(v, o)
      where e.o <= 30 and e.v ~ '^[0-9]{1,6}$'), '{}') else '{}' end,
    case when p.media_cleared then private.provider_image(r.payload -> 'cover') end,
    case when p.media_cleared and pg_catalog.jsonb_typeof(r.payload -> 'screenshots') = 'array' then coalesce((
      select pg_catalog.jsonb_agg(private.provider_image(s.v) order by s.o)
      from pg_catalog.jsonb_array_elements(r.payload -> 'screenshots') with ordinality s(v, o)
      where s.o <= 8 and private.provider_image(s.v) is not null), '[]') else '[]' end,
    pg_catalog.left(r.payload ->> 'fetched_at', 40),
    r.updated_at
  from public.games g
  join private.external_references x on x.game_id = g.id and x.entity_type = 'game' and private.is_enrichment_provider(x.provider_code)
  join private.external_providers p on p.code = x.provider_code and p.commercial_use_cleared
  join lateral (
    select pr.payload, pr.updated_at from private.provider_records pr
    where pr.provider_code = x.provider_code and pr.entity_type = 'game' and pr.external_id = x.external_id
      and pr.status = 'matched' and pr.matched_game_id = g.id
    order by pr.created_at desc limit 1
  ) r on true
  where g.id = any(p_games[1:200]) and g.status = 'published' and g.merged_into_id is null;
$$;

revoke all on function public.get_game_provider_metadata(uuid[]) from public, anon, authenticated, service_role, catalog_importer;
grant execute on function public.get_game_provider_metadata(uuid[]) to service_role;
