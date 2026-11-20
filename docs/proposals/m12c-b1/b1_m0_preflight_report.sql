-- PROPOSAL (M12c-B1, B1-M0): read-only preflight report. Run on the target database before
-- B1-M0, with the current (pre-B1-M0) functions installed:
--
--   psql -X -A -F ' | ' -v ON_ERROR_STOP=1 -f b1_m0_preflight_report.sql
--
-- It computes each title's B1-M0 key without changing anything. With the current function,
-- catalog_search_key(normalize(translate(title, '™℠', '  '), NFKC)) is exactly what B1-M0's
-- function returns for title, because B1-M0 only adds that first step.
--
-- One result, one row per finding:
--   1 alias_conflict           aliases of one game that would collide in game_aliases_unique.
--                              B1-M0 refuses to run while any exist: remove the redundant alias.
--   2 games_newly_sharing_key  games (not merged, rejected or excluded) whose key would become
--                              equal to another game's. Nothing is merged; each group is a
--                              possible duplicate for an editor, or distinct games with
--                              equivalent titles.
--   3 keys_changing            stored keys B1-M0 would recompute, by table.
--   4 source_records_rekeyed   provider records whose titles contain compatibility characters.
--   5 orphaned_title_keys      import title keys whose game or source record no longer exists
--                              (left by a cleanup that deleted rows with foreign keys off). B1-M0
--                              doesn't change them and won't add any; worth removing separately.
begin transaction isolation level repeatable read read only;

with k as (
  select 'alias'::text as kind, a.id, a.game_id, a.language_code, a.region_code, a.title, a.search_key as old_key,
         private.catalog_search_key(normalize(pg_catalog.translate(a.title, '™℠', '  '), NFKC)) as new_key
  from public.game_aliases a
  union all
  select 'game', g.id, g.id, null, null, g.title, g.search_key,
         private.catalog_search_key(normalize(pg_catalog.translate(g.title, '™℠', '  '), NFKC))
  from public.games g where g.status not in ('merged', 'rejected', 'excluded')
)
select '1 alias_conflict' as finding, k.game_id::text as subject, k.new_key as key,
       pg_catalog.string_agg(k.title, ' / ' order by k.title) as detail
from k where k.kind = 'alias'
group by k.game_id, k.new_key, k.language_code, k.region_code having count(*) > 1
union all
select '2 games_newly_sharing_key', null, s.new_key,
       pg_catalog.string_agg(pg_catalog.format('%s [%s]', k.title, k.id), ' / ' order by k.title, k.id)
from (select distinct c.new_key from k c
      where c.kind = 'game' and c.new_key is distinct from c.old_key
        and exists (select 1 from k o where o.kind = 'game' and o.id <> c.id and o.new_key = c.new_key)) s
join k on k.kind = 'game' and k.new_key = s.new_key
group by s.new_key
union all
select '3 keys_changing', 'games', null, count(*)::text from k where kind = 'game' and new_key is distinct from old_key
union all
select '3 keys_changing', 'game_aliases', null, count(*)::text from k where kind = 'alias' and new_key is distinct from old_key
union all
select '3 keys_changing', 'releases.local_title', null, count(*)::text from public.releases r
where r.local_title is not null
  and r.local_title_key is distinct from private.catalog_search_key(normalize(pg_catalog.translate(r.local_title, '™℠', '  '), NFKC))
union all
select '4 source_records_rekeyed', null, null, count(distinct tk.provider_record_id)::text
from private.game_title_keys tk
join private.provider_records pr on pr.id = tk.provider_record_id
where tk.origin = 'source'
  and exists (
    select 1 from pg_catalog.jsonb_array_elements_text(
      case when pg_catalog.jsonb_typeof(pr.payload -> 'titles') = 'array' then pr.payload -> 'titles' else '[]' end
      || pg_catalog.jsonb_build_array(coalesce(pr.payload ->> 'title', ''))) t
    where normalize(pg_catalog.translate(t, '™℠', '  '), NFKC) <> t)
union all
select '5 orphaned_title_keys', 'missing game', null, count(*)::text
from private.game_title_keys k where not exists (select 1 from public.games g where g.id = k.game_id)
union all
select '5 orphaned_title_keys', 'missing source record', null, count(*)::text
from private.game_title_keys k
where k.provider_record_id is not null and not exists (select 1 from private.provider_records pr where pr.id = k.provider_record_id)
order by 1, 2, 3;

rollback;
