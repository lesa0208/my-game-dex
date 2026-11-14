-- M7b-2c: merged releases are public only if they were published (D3, D14).
--
-- Design: docs/architecture/security-rls.md#merging-releases-m7b-2c
--
-- Until now every `merged` release was readable by anyone, with its pieces, markets
-- and hardware requirements. M7b-2c merges unpublished submissions too, so a merged
-- release is public only when `merged_publicly` says it was published when merged.
-- Every other merged release stays readable only by catalog editors; its submitter
-- follows it through their submission. No release was merged before this migration,
-- so nothing that was readable becomes hidden. Applied, and tested, before any merge
-- function exists.

alter table public.releases
  add column merged_publicly boolean not null default false,
  add constraint releases_merged_publicly check (not merged_publicly or status = 'merged');

drop policy releases_read_anon on public.releases;
drop policy releases_read_authenticated on public.releases;
create policy releases_read_anon on public.releases
  for select to anon
  using (status = 'published' or (status = 'merged' and merged_publicly));
create policy releases_read_authenticated on public.releases
  for select to authenticated
  using (
    status = 'published' or (status = 'merged' and merged_publicly)
    or (submitted_by = (select auth.uid()) and status in ('unverified', 'under_review', 'rejected'))
    or (select private.is_catalog_editor())
  );

-- Pieces, markets and hardware requirements follow their release.
create or replace function private.can_read_release(p_release uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.releases r
    where r.id = p_release
      and (
        r.status = 'published' or (r.status = 'merged' and r.merged_publicly)
        or (r.submitted_by = (select auth.uid()) and r.status in ('unverified', 'under_review', 'rejected'))
        or private.is_catalog_editor()
      )
  )
$$;

-- Where an address naming a merged release should go (D14): the public release it was
-- merged into, and its game's address. Null for anything else, a release merged while
-- unpublished included, exactly as for an unknown id, so it never reveals that one
-- exists. Public and the same for every caller, so it can be cached with the catalog.
create function public.resolve_merged_release(p_release uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rel public.releases;
  v_depth integer := 0;
  v_game public.games;
begin
  select * into rel from public.releases r where r.id = p_release;
  if not found or rel.status <> 'merged' then
    return null;
  end if;
  -- Merges are flattened (D9), so this is one step; the limit only guards the loop.
  while rel.status = 'merged' loop
    if not rel.merged_publicly or v_depth >= 10 then
      return null;
    end if;
    v_depth := v_depth + 1;
    select * into rel from public.releases r where r.id = rel.merged_into_id;
    if not found then
      return null;
    end if;
  end loop;
  select * into v_game from public.games g where g.id = rel.game_id and g.status = 'published';
  if not found or not exists (select 1 from private.catalog_public_releases(v_game.id) x where x.id = rel.id) then
    return null;
  end if;
  return pg_catalog.jsonb_build_object('game_slug', v_game.slug, 'release_id', rel.id);
end;
$$;

revoke all on function private.can_read_release(uuid) from public, anon, authenticated, service_role;
grant execute on function private.can_read_release(uuid) to anon, authenticated;
revoke all on function public.resolve_merged_release(uuid) from public, anon, authenticated, service_role;
grant execute on function public.resolve_merged_release(uuid) to anon, authenticated;
