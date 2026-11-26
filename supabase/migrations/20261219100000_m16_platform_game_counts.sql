-- M16: a platform's game count includes games published without a release.
--
-- public.list_catalog_platforms counted a platform's games through its published, verified
-- releases only (M5c). Since M12c-B1 a game is also public on a platform through an independently
-- verified pairing, without any release (identity publication), and the catalog's platform list
-- said "Nintendo 64 (0)" for a platform with hundreds of such games: the explore page's platform
-- filter showed 0 for every platform of an identity-only catalog.
--
-- game_count is now the number of published games with a published pairing on the platform, which
-- is exactly when search and the release picker show the game there (a published pairing needs a
-- published release or a verified pairing, checked at commit by private.check_publication_of).
-- release_count is unchanged: published, verified releases on a published pairing of a published
-- game. Everything else, the signature, security definer, search path and grants (create or
-- replace keeps them), is the current definition (migration 20261110100200). No data changes.

create or replace function public.list_catalog_platforms()
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
      'game_count', coalesce(gc.games, 0),
      'release_count', coalesce(rc.releases, 0))
    order by p.name, p.slug), '[]')
  from public.platforms p
  left join (
    select gp.platform_id, count(distinct gp.game_id)::integer as games
    from public.game_platforms gp
    join public.games g on g.id = gp.game_id and g.status = 'published'
    where gp.status = 'published'
    group by gp.platform_id
  ) gc on gc.platform_id = p.id
  left join (
    select r.platform_id, count(*)::integer as releases
    from public.releases r
    join public.game_platforms gp on gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published'
    join public.games g on g.id = r.game_id and g.status = 'published'
    where r.status = 'published' and r.verified_at is not null
    group by r.platform_id
  ) rc on rc.platform_id = p.id
$$;
