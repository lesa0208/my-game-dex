-- M7b-2b: what the owner of a preserved copy may read about its excluded release (D3).
--
-- Design: docs/architecture/security-rls.md#excluding-and-restoring-releases-m7b-2b
-- Catalog RLS is unchanged: an excluded release stays readable only by catalog editors.
-- These two functions read past it for one purpose, each returning a fixed set of
-- fields, and only for the caller's own copy that is preserved and on an excluded
-- release. A copy relinked away, deleted or someone else's returns nothing, exactly as
-- one that doesn't exist. Never returned: who submitted, verified or excluded it,
-- evidence, provenance, field locks, the staff reason, other owners, or anything from
-- the audit log.

-- The rows behind both functions: the caller's preserved copies on excluded releases.
create function private.my_preserved_releases(p_items uuid[])
returns table (item_id uuid, release public.releases, game public.games)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, r, g
  from public.collection_items c
  join public.releases r on r.id = c.release_id and r.status = 'excluded'
  join public.games g on g.id = r.game_id
  where c.id = any (p_items)
    and c.owner_id = (select auth.uid())
    and c.record_status = 'invalid_preserved'
$$;

-- The release a preserved copy is on, for its page: the details the owner saw when it
-- was in the catalog, the pieces it listed, and why it was excluded. Null otherwise.
create function public.get_my_preserved_release(p_item uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'release', pg_catalog.jsonb_build_object(
      'id', (x.release).id,
      'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
      'region', pg_catalog.jsonb_build_object('code', (x.release).region_code, 'label', rc.label),
      'edition_name', (x.release).edition_name, 'variant_name', (x.release).variant_name, 'local_title', (x.release).local_title,
      'format', pg_catalog.jsonb_build_object('code', (x.release).media_format_code, 'name', mf.name),
      'media_count', (x.release).media_count, 'packaging', (x.release).packaging,
      'identifiers', pg_catalog.jsonb_build_object('product_code', (x.release).product_code, 'barcode', (x.release).barcode)),
    -- The slug only while the game is in the catalog, for choosing another release of it.
    'game', pg_catalog.jsonb_build_object('title', (x.game).title,
      'slug', case when (x.game).status = 'published' then (x.game).slug end),
    'components', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', k.kind, 'label', k.label, 'quantity', k.quantity) order by k.kind, k.label)
      from public.release_components k where k.release_id = (x.release).id), '[]'),
    'exclusion', (
      select pg_catalog.jsonb_build_object('reason_code', e.reason_code, 'note', e.owner_note, 'excluded_at', e.excluded_at)
      from private.catalog_exclusions e where e.release_id = (x.release).id and e.restored_at is null))
  from private.my_preserved_releases(array[p_item]) x
  join public.platforms pl on pl.id = (x.release).platform_id
  left join public.region_codes rc on rc.code = (x.release).region_code
  left join public.media_formats mf on mf.code = (x.release).media_format_code
$$;

-- Titles and platforms for preserved copies in a list, at most 100 at a time:
-- {item_id: {title, local_title, platform, region, edition_name, variant_name}}.
create function public.get_my_preserved_titles(p_items uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if pg_catalog.cardinality(p_items) > 100 then
    raise exception 'too many items' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_object_agg(x.item_id, pg_catalog.jsonb_build_object(
      'title', (x.game).title, 'local_title', (x.release).local_title,
      'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
      'region', pg_catalog.jsonb_build_object('code', (x.release).region_code, 'label', rc.label),
      'edition_name', (x.release).edition_name, 'variant_name', (x.release).variant_name))
    from private.my_preserved_releases(coalesce(p_items, '{}')) x
    join public.platforms pl on pl.id = (x.release).platform_id
    left join public.region_codes rc on rc.code = (x.release).region_code
  ), '{}'::jsonb);
end;
$$;

revoke all on function private.my_preserved_releases(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.get_my_preserved_release(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_preserved_titles(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_my_preserved_release(uuid) to authenticated;
grant execute on function public.get_my_preserved_titles(uuid[]) to authenticated;
