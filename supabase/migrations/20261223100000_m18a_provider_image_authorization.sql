-- M18a security fix: an IGDB image is served only while it is authorized, asset by asset.
--
-- Before: next.config.ts allowed the app's image optimizer to fetch any image under
-- images.igdb.com/igdb/image/upload/, whatever the clearance, the record or the game, and the
-- optimizer kept what it fetched on disk for hours. Now the optimizer allows no IGDB image at all;
-- the app serves IGDB images through its own route (src/app/media/igdb/[size]/[image]/route.ts),
-- which asks this function on every request, and fetches the image only when it answers true.
--
-- public.provider_image_allowed(provider, image_id) is true only when the image is the cover or one
-- of the first 8 screenshots of the latest attached record (the record the public read shows) of a
-- published, unmerged game linked to that provider, and the provider and its media are cleared now.
-- Exactly what public.get_game_provider_metadata would show: no other image of IGDB's, no image
-- of a held or unattached record, nothing after a withdrawal.
--
-- Grants: service_role only (the app server's secret key), like the metadata read.

create function public.provider_image_allowed(p_provider text, p_image_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_image_id ~ '^[a-z0-9]{1,40}$' and private.is_enrichment_provider(p_provider) and exists (
    select 1
    from private.external_references x
    join public.games g on g.id = x.game_id and g.status = 'published' and g.merged_into_id is null
    join private.external_providers p on p.code = x.provider_code and p.commercial_use_cleared and p.media_cleared
    join lateral (
      select pr.payload from private.provider_records pr
      where pr.provider_code = x.provider_code and pr.entity_type = 'game' and pr.external_id = x.external_id
        and pr.status = 'matched' and pr.matched_game_id = g.id
      order by pr.created_at desc limit 1
    ) r on true
    where x.provider_code = p_provider and x.entity_type = 'game'
      and (private.provider_image(r.payload -> 'cover') ->> 'image_id' = p_image_id
        or (pg_catalog.jsonb_typeof(r.payload -> 'screenshots') = 'array' and exists (
          select 1 from pg_catalog.jsonb_array_elements(r.payload -> 'screenshots') with ordinality s(v, o)
          where s.o <= 8 and private.provider_image(s.v) ->> 'image_id' = p_image_id)))
  );
$$;

revoke all on function public.provider_image_allowed(text, text) from public, anon, authenticated, service_role, catalog_importer;
grant execute on function public.provider_image_allowed(text, text) to service_role;
