-- M12b-0: three consistency corrections to M12a, found in its review.
--
-- Design: docs/architecture/database-schema.md#collection-system (M12a, M12b-0)
-- 1. Summary: a preserved claim keeps its claimed platform in the platform counts. A
--    preserved copy of a release still counts by its release's platform when the owner
--    can read it, as before.
-- 2. Exclusion details: "moved" also counts a recorded copy that is active again where
--    it is: a preserved claim whose region or edition the owner changed stays on the
--    same game, so it was counted neither as moved nor as still preserved. Stored
--    exclusion records and copies are not changed.
-- 3. Ownership: catalog_pairing is whether the catalog publishes the copy's game and
--    platform, for a copy of a release as for a claim. It was false for every copy of
--    a release.
-- Each function is replaced whole, with only the lines above changed. Grants, owners
-- and settings are kept by CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- 1. The summary
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_collection_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with mine as (
    select
      case
        when c.record_status = 'invalid_preserved' then 'invalid'
        when c.release_id is null then 'unidentified'
        when r.status = 'published' then 'owned'
        when r.status = 'rejected' then 'not_approved'
        when r.status is null then 'invalid'
        else 'pending'
      end as status,
      coalesce(r.platform_id, c.claimed_platform_id) as platform_id
    from public.collection_items c
    left join public.releases r on r.id = c.release_id
    where c.owner_id = (select auth.uid())
  )
  select pg_catalog.jsonb_build_object(
    'total', (select count(*) from mine),
    'owned', (select count(*) from mine where status = 'owned'),
    'pending', (select count(*) from mine where status = 'pending'),
    'not_approved', (select count(*) from mine where status = 'not_approved'),
    'invalid', (select count(*) from mine where status = 'invalid'),
    -- M12a: unidentified copies on their own. 'owned' stays confirmed releases only.
    'unidentified', (select count(*) from mine where status = 'unidentified'),
    'limit', 100000,
    'platforms', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name, 'count', x.n)
             order by pl.name)
      from (select m.platform_id, count(*) as n from mine m where m.platform_id is not null group by m.platform_id) x
      join public.platforms pl on pl.id = x.platform_id
    ), '[]'::jsonb)
  )
$function$;

-- ---------------------------------------------------------------------------
-- 2. An exclusion's copies
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_exclusion(p_exclusion uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid;
  ex private.catalog_exclusions;
  v_blocker text;
begin
  v_me := private.require_active_staff('admin');
  select * into ex from private.catalog_exclusions e where e.id = p_exclusion;
  if not found then
    return null;
  end if;
  v_blocker := private.restore_blocker(ex);
  return pg_catalog.jsonb_build_object(
    'id', ex.id, 'version', ex.version,
    'excluded_at', ex.excluded_at, 'reason_code', ex.reason_code, 'staff_reason', ex.staff_reason, 'owner_note', ex.owner_note,
    'previous_status', ex.previous_status, 'request_id', ex.request_id,
    'release', private.release_label(ex.release_id),
    'cascade', private.describe_plan(pg_catalog.jsonb_build_object('release_id', ex.release_id, 'cascade', ex.cascade, 'blocking', '[]'::jsonb)) -> 'cascade',
    'copies_preserved', ex.copies_preserved, 'owners_affected', ex.owners_affected,
    'copies', pg_catalog.jsonb_build_object(
      'still_preserved', (select count(*) from private.catalog_exclusion_copies ec join public.collection_items c on c.id = ec.item_id
                          where ec.exclusion_id = ex.id and (case when ec.claimed_game_id is null then c.release_id = ex.release_id
                 else c.release_id is null and c.claimed_game_id = ec.claimed_game_id end)
                            and c.record_status = 'invalid_preserved' and c.invalidated_at = ex.excluded_at),
      'moved', (select count(*) from private.catalog_exclusion_copies ec join public.collection_items c on c.id = ec.item_id
                where ec.exclusion_id = ex.id and (not (case when ec.claimed_game_id is null then c.release_id = ex.release_id
                 else c.release_id is null and c.claimed_game_id = ec.claimed_game_id end)
                   or c.record_status <> 'invalid_preserved')),
      'removed', ex.copies_preserved - (select count(*) from private.catalog_exclusion_copies ec where ec.exclusion_id = ex.id)),
    'restored_at', ex.restored_at, 'restore_reason', ex.restore_reason, 'copies_restored', ex.copies_restored,
    'own_exclusion', ex.excluded_by = v_me,
    'own_submission', private.exclusion_involves(v_me, ex.release_id, ex.cascade),
    'blocker', v_blocker);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Personal ownership of a game
-- ---------------------------------------------------------------------------

create or replace function public.get_my_game_ownership(p_game uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select
      case
        when c.record_status = 'invalid_preserved' then 'invalid'
        when c.release_id is null then 'unidentified'
        when r.status = 'published' then 'owned'
        when r.status = 'rejected' then 'not_approved'
        when r.status in ('unverified', 'under_review') then 'pending'
        else 'invalid'
      end as status,
      c.release_id,
      coalesce(r.platform_id, c.claimed_platform_id) as platform_id,
      case when c.release_id is null then c.claimed_region_code else r.region_code end as region_code,
      case when c.release_id is null then c.claimed_edition_kind else r.edition_kind end as edition_kind,
      case when c.release_id is null then c.claimed_edition_name else r.edition_name end as edition_name,
      exists (
        select 1 from public.game_platforms gp
        where gp.game_id = coalesce(r.game_id, c.claimed_game_id)
          and gp.platform_id = coalesce(r.platform_id, c.claimed_platform_id)
          and gp.status = 'published') as catalog_pairing
    from public.collection_items c
    left join public.releases r on r.id = c.release_id
    where c.owner_id = (select auth.uid()) and (select private.session_is_live())
      and coalesce(r.game_id, c.claimed_game_id) = p_game
  )
  select pg_catalog.jsonb_build_object(
    'owned', exists (select 1 from mine m where m.status <> 'invalid'),
    'copies', (select count(*) from mine m where m.status <> 'invalid'),
    'entries', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'status', x.status, 'release_id', x.release_id,
          'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
          'region', case when x.region_code is null then null else pg_catalog.jsonb_build_object('code', x.region_code, 'label', rc.label) end,
          'edition_kind', x.edition_kind, 'edition_name', x.edition_name,
          'catalog_pairing', x.catalog_pairing, 'count', x.n)
        order by pl.name, x.region_code nulls last, x.edition_name nulls last, x.status)
      from (
        select m.status, m.release_id, m.platform_id, m.region_code, m.edition_kind, m.edition_name, m.catalog_pairing, count(*) as n
        from mine m group by 1, 2, 3, 4, 5, 6, 7
      ) x
      join public.platforms pl on pl.id = x.platform_id
      left join public.region_codes rc on rc.code = x.region_code
    ), '[]'::jsonb)
  )
$$;
