-- PROPOSAL (M12c-B1, B1-M0 rollback): a forward migration restoring the title-key functions as they were
-- before B1-M0 (bodies copied from the database on 2026-11-20), then recomputing the same stored keys.
-- Nothing else changes, as in B1-M0.

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
  v := pg_catalog.translate(pg_catalog.lower(p_title), 'àáâãäåāçćčèéêëēěìíîïīłñńòóôõöøōùúûüūýÿžšśźżß', 'aaaaaaaccceeeeeeiiiiilnnooooooouuuuuyyzsszzs');
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
$function$

;

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
  v := pg_catalog.translate(pg_catalog.lower(p_title), 'àáâãäåāçćčèéêëēěìíîïīñńòóôõöøōùúûüūýÿžšß', 'aaaaaaaccceeeeeeiiiiinnooooooouuuuuyyzss');
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
$function$

;

-- 3. Recompute only the rows whose keys change. Generated columns are recomputed when the
-- row is updated; replica mode skips user triggers, so no revision, updated_at, verification
-- or audit side effect happens (this is a key recompute, not an edit).
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
    where true);
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
end $$;
