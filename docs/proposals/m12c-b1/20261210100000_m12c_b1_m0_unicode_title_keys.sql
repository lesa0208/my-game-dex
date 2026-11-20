-- PROPOSAL (M12c-B1, B1-M0): not a migration until reviewed and moved to supabase/migrations.
--
-- Title keys normalize Unicode compatibility characters first (NFKC).
--
-- Why: private.catalog_search_key and private.import_title_key drop every character that
-- isn't a letter or digit in their own sense, so single-character Roman numerals such as
-- "Ⅱ" (U+2161) and "Ⅲ" (U+2162) vanish: "Super Momotaro Dentetsu Ⅱ" and "… Ⅲ" get the same
-- key, and "Ⅱ" never matches "II". NFKC turns "Ⅱ" into "II" (then "2" by the existing
-- Roman-numeral rule), fullwidth letters into ASCII and ligatures into letters. The trademark
-- signs "™" and "℠" become a space first: NFKC would otherwise turn "Tetris™" into "TetrisTM",
-- where today's key is "tetris".
--
-- Distinct numerals stay distinct: "Ⅱ" and "II" both become "2", "Ⅲ" and "III" both "3".
-- Nothing here merges games: these are search and import-matching keys, not identities, and
-- the importer never links a source record to a game by title (a title match is held for
-- review as a possible duplicate; only an external identifier links). Titles, aliases and
-- every other column keep their values.
--
-- Run b1_m0_preflight_report.sql (read-only) on the target database first, and resolve what it
-- lists, before applying this migration.
--
-- Deployment role (SQL review of 62267d6, item 7): the recompute sets session_replication_role
-- for its own transaction. That parameter needs a superuser, or on Supabase a member of
-- supabase_privileged_role, which supautils lets set it (supautils.privileged_role_allowed_configs
-- lists session_replication_role). Checked on the local stack: postgres is not a superuser, is a
-- member of supabase_privileged_role, and the setting is allowed. Hosted Supabase runs migrations
-- as postgres with the same supautils configuration; confirm on the target before applying. Replica
-- mode also skips foreign-key triggers, so the postcheck below verifies the rows this step wrote.
--
-- What changes: the two key functions, and the stored keys derived from them, only where
-- the new key differs:
--   public.games.search_key, search_compact, search_words      (generated from title)
--   public.game_aliases.search_key, search_compact, search_words (generated from title)
--   public.releases.local_title_key                              (generated from local_title)
--   private.game_title_keys.title_key (and its generated compact_key), origins 'title' and
--   'source'.
--
-- What never changes: any id, title, slug, status, revision, verification, alias, release or
-- audit row. No index is created or dropped: the key indexes are on stored columns, not on
-- these functions, so replacing the functions doesn't invalidate an index.
--
-- Preserving identities: before anything changes, a preflight computes the new keys and
-- refuses if they would collide in a unique index (game_aliases_unique). Identity collisions
-- between games (two games whose keys would become equal) are reported, never resolved:
-- they are search keys, not identity, and nothing is merged.
--
-- Rollback: 20261210100000_m12c_b1_m0_unicode_title_keys.rollback.sql restores the previous
-- function bodies and recomputes the same columns. It is a forward migration of its own.

-- 1. The new keys, computed without changing anything, and the preflight.
create temp table m0_new_keys on commit drop as
select 'alias' as kind, a.id, a.game_id, a.language_code, a.region_code,
       a.search_key as old_key,
       private.catalog_search_key(normalize(pg_catalog.translate(a.title, '™℠', '  '), NFKC)) as new_key
from public.game_aliases a
union all
select 'game', g.id, g.id, null, null, g.search_key, private.catalog_search_key(normalize(pg_catalog.translate(g.title, '™℠', '  '), NFKC))
from public.games g;

do $$
declare
  v_collisions text;
begin
  -- An alias unique index violation would stop the recompute half way: refuse first.
  select pg_catalog.string_agg(pg_catalog.format('game %s: %s', x.game_id, x.new_key), '; ')
  into v_collisions
  from (
    select k.game_id, k.new_key
    from m0_new_keys k
    where k.kind = 'alias'
    group by k.game_id, k.new_key, k.language_code, k.region_code
    having count(*) > 1
  ) x;
  if v_collisions is not null then
    raise exception 'B1-M0 preflight: normalized alias keys would collide (%). Nothing was changed.', v_collisions;
  end if;
end $$;

-- Identity report: games whose normalized key would equal another game's (informational).
do $$
declare
  v_report text;
begin
  -- Each key once, with every game that shares it (changed or not).
  select pg_catalog.string_agg(pg_catalog.format('%s (%s games)', s.new_key,
           (select count(*) from m0_new_keys o where o.kind = 'game' and o.new_key = s.new_key)), '; ' order by s.new_key)
  into v_report
  from (
    select distinct k.new_key
    from m0_new_keys k
    where k.kind = 'game' and k.new_key is distinct from k.old_key
      and exists (select 1 from m0_new_keys o where o.kind = 'game' and o.id <> k.id and o.new_key = k.new_key)
  ) s;
  if v_report is not null then
    raise notice 'B1-M0: games that now share a search key with another game (reported, not merged): %', v_report;
  end if;
end $$;

-- 2. The functions: NFKC first, everything else as before.
CREATE OR REPLACE FUNCTION private.catalog_search_key(p_title text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
declare
  v text;
  v_tokens text[];
  v_out text[] := '{}';
  v_roman constant jsonb := '{"ii": "2", "iii": "3", "iv": "4", "vi": "6", "vii": "7", "viii": "8", "ix": "9"}';
  i integer;
begin
  if p_title is null then
    return null;
  end if;
  -- B1-M0: compatibility characters first ("Ⅱ" is "II", fullwidth "Ａ" is "A").
  v := pg_catalog.translate(pg_catalog.lower(normalize(pg_catalog.translate(p_title, '™℠', '  '), NFKC)), 'àáâãäåāçćčèéêëēěìíîïīłñńòóôõöøōùúûüūýÿžšśźżß', 'aaaaaaaccceeeeeeiiiiilnnooooooouuuuuyyzsszzs');
  v := pg_catalog.replace(v, '&', ' and ');
  v := pg_catalog.regexp_replace(v, '[''`´‘’]', '', 'g');
  v := pg_catalog.regexp_replace(v, '^(.*), (the|a|an)( - .*)?$', '\2 \1\3');
  v := pg_catalog.btrim(pg_catalog.regexp_replace(v, '[^[:alnum:]]+', ' ', 'g'));
  if v = '' then
    return null;
  end if;
  v_tokens := pg_catalog.string_to_array(v, ' ');
  if cardinality(v_tokens) > 1 and (v_tokens[1] in ('the', 'an') or (v_tokens[1] = 'a' and pg_catalog.char_length(v_tokens[2]) >= 3)) then
    v_tokens := v_tokens[2:];
  end if;
  for i in 1 .. cardinality(v_tokens) loop
    if v_roman ? v_tokens[i] then
      v_tokens[i] := v_roman ->> v_tokens[i];
    end if;
  end loop;
  for i in 1 .. cardinality(v_tokens) loop
    continue when v_tokens[i] = 'part' and i < cardinality(v_tokens) and v_tokens[i + 1] ~ '^[0-9]+$';
    v_out := v_out || v_tokens[i];
  end loop;
  return pg_catalog.left(pg_catalog.array_to_string(v_out, ' '), 200);
end;
$function$;

CREATE OR REPLACE FUNCTION private.import_title_key(p_title text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v text;
  v_tokens text[];
  v_out text[] := '{}';
  v_roman constant jsonb := '{"ii": "2", "iii": "3", "iv": "4", "vi": "6", "vii": "7", "viii": "8", "ix": "9"}';
  i integer;
begin
  if p_title is null then
    return null;
  end if;
  -- B1-M0: compatibility characters first, as private.catalog_search_key.
  v := pg_catalog.translate(pg_catalog.lower(normalize(pg_catalog.translate(p_title, '™℠', '  '), NFKC)), 'àáâãäåāçćčèéêëēěìíîïīñńòóôõöøōùúûüūýÿžšß', 'aaaaaaaccceeeeeeiiiiinnooooooouuuuuyyzss');
  v := pg_catalog.replace(v, '&', ' and ');
  v := pg_catalog.regexp_replace(v, '[''`´‘’]', '', 'g');
  v := pg_catalog.regexp_replace(v, '^(.*), (the|a|an)( - .*)?$', '\2 \1\3');
  v := pg_catalog.btrim(pg_catalog.regexp_replace(v, '[^a-z0-9]+', ' ', 'g'));
  if v = '' then
    return null;
  end if;
  v_tokens := pg_catalog.string_to_array(v, ' ');
  if cardinality(v_tokens) > 1 and (v_tokens[1] in ('the', 'an') or (v_tokens[1] = 'a' and pg_catalog.length(v_tokens[2]) >= 3)) then
    v_tokens := v_tokens[2:];
  end if;
  for i in 1 .. cardinality(v_tokens) loop
    if v_roman ? v_tokens[i] then
      v_tokens[i] := v_roman ->> v_tokens[i];
    end if;
  end loop;
  for i in 1 .. cardinality(v_tokens) loop
    continue when v_tokens[i] = 'part' and i < cardinality(v_tokens) and v_tokens[i + 1] ~ '^[0-9]+$';
    v_out := v_out || v_tokens[i];
  end loop;
  return pg_catalog.left(pg_catalog.array_to_string(v_out, '-'), 200);
end;
$function$;

-- 3. Recompute only the rows whose keys change. Generated columns are recomputed when the
-- row is updated; replica mode skips user triggers, so no revision, updated_at, verification
-- or audit side effect happens (this is a key recompute, not an edit).
-- Title keys whose game or source record no longer exists, before this step (a test cleanup that
-- deleted games in replica mode can leave some; b1_m0_preflight_report.sql lists them).
create temp table m0_orphans_before on commit drop as select (select count(*) from private.game_title_keys k where not exists (select 1 from public.games g where g.id = k.game_id))
       + (select count(*) from private.game_title_keys k
          where k.provider_record_id is not null and not exists (select 1 from private.provider_records pr where pr.id = k.provider_record_id)) as n;
set local session_replication_role = replica;
update public.games g set title = g.title
where g.search_key is distinct from private.catalog_search_key(g.title);
update public.game_aliases a set title = a.title
where a.search_key is distinct from private.catalog_search_key(a.title);
update public.releases r set local_title = r.local_title
where r.local_title is not null and r.local_title_key is distinct from private.catalog_search_key(r.local_title);

-- Import title keys: a game's own title (origin 'title') is recomputed from games.title; a
-- source's titles (origin 'source') from the source record that listed them.
update private.game_title_keys k set title_key = private.import_title_key(g.title)
from public.games g
where k.origin = 'title' and k.game_id = g.id and k.title_key is distinct from private.import_title_key(g.title)
  and private.import_title_key(g.title) is not null;

create temp table m0_sources on commit drop as
select distinct k.game_id, k.provider_record_id
from private.game_title_keys k
join private.provider_records pr on pr.id = k.provider_record_id
where k.origin = 'source'
  and exists (
    select 1 from pg_catalog.jsonb_array_elements_text(
      case when pg_catalog.jsonb_typeof(pr.payload -> 'titles') = 'array' then pr.payload -> 'titles' else '[]' end
      || pg_catalog.jsonb_build_array(coalesce(pr.payload ->> 'title', ''))) t
    where normalize(t, NFKC) <> t);
delete from private.game_title_keys k
using m0_sources s
where k.origin = 'source' and k.game_id = s.game_id and k.provider_record_id = s.provider_record_id;
do $$
declare
  v record;
begin
  for v in select s.game_id, pr from m0_sources s join private.provider_records pr on pr.id = s.provider_record_id loop
    perform private.import_add_title_keys(v.game_id, v.pr);
  end loop;
end $$;
set local session_replication_role = origin;

-- 4. Postcheck: every stored key now equals what the functions return.
do $$
begin
  if exists (select 1 from public.games g where g.search_key is distinct from private.catalog_search_key(g.title))
     or exists (select 1 from public.game_aliases a where a.search_key is distinct from private.catalog_search_key(a.title))
     or exists (select 1 from public.releases r where r.local_title is not null and r.local_title_key is distinct from private.catalog_search_key(r.local_title))
     or exists (select 1 from private.game_title_keys k join public.games g on g.id = k.game_id
                where k.origin = 'title' and k.title_key is distinct from private.import_title_key(g.title)) then
    raise exception 'B1-M0 postcheck: a stored key differs from its function. Rolled back.';
  end if;
  -- Replica mode skipped foreign-key triggers while the source keys were rewritten: no title key
  -- this step wrote may point to a missing game or source record.
  if (select count(*) from private.game_title_keys k where not exists (select 1 from public.games g where g.id = k.game_id))
         + (select count(*) from private.game_title_keys k
            where k.provider_record_id is not null and not exists (select 1 from private.provider_records pr where pr.id = k.provider_record_id)) > (select n from m0_orphans_before) then
    raise exception 'B1-M0 postcheck: a title key lost its game or source record. Rolled back.';
  end if;
end $$;
