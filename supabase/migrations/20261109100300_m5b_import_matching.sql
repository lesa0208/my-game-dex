-- M5b Catalog import: physical classification held for review, and better matching.
--
-- Design: docs/architecture/security-rls.md#catalog-import
-- After the SNES pilot of 2026-11-09:
--   1. An entry can be held for an editor with a review reason, such as a Nintendo
--      Power flash release. A held entry is staged and reported, never applied.
--   2. Titles compare after normalizing case, accents, apostrophes, "&", punctuation,
--      separators and a leading or trailing article, and roman numerals II to IX
--      and "Part N" become numbers. I, V and X stay as they are, because they are
--      often letters ("Mega Man X").
--   3. A game's comparable titles, its own and every title its source records list,
--      are kept in private.game_title_keys, indexed by key.
--   4. An entry matching no game, but whose main title before a subtitle matches
--      one, is suggested for review, never matched. Several matches still mean
--      review: nothing is merged.

-- ---------------------------------------------------------------------------
-- 1. Held entries
-- ---------------------------------------------------------------------------

alter table private.provider_records
  add column review_reason text check (char_length(review_reason) between 1 and 200),
  add constraint provider_records_review_held check (review_reason is null or status in ('needs_review', 'failed'));

create or replace function private.guard_provider_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.provider_code, new.entity_type, new.external_id, new.payload, new.payload_sha256, new.import_run_id, new.review_reason)
     is distinct from (old.provider_code, old.entity_type, old.external_id, old.payload, old.payload_sha256, old.import_run_id, old.review_reason) then
    raise exception 'source records can''t be changed' using errcode = 'check_violation';
  end if;
  if new.matched_release_id is distinct from old.matched_release_id
     and exists (select 1 from private.release_evidence e where e.provider_record_id = old.id)
     and exists (select 1 from public.releases r where r.id = old.matched_release_id) then
    raise exception 'a source record with evidence can''t be matched to another release' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Comparable titles
-- ---------------------------------------------------------------------------

-- Same algorithm as titleKey in scripts/catalog-import-sources.mjs. Keep them equal.
create or replace function private.import_title_key(p_title text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
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
$$;

-- The comparable form of a title's main part, before its first subtitle separator,
-- or null when it has none.
create function private.import_main_title_key(p_title text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when pg_catalog.strpos(t, ' - ') > 0 or pg_catalog.strpos(t, ': ') > 0
    then private.import_title_key(pg_catalog.split_part(pg_catalog.replace(t, ': ', ' - '), ' - ', 1)) end
  from (select pg_catalog.replace(p_title, ' – ', ' - ') as t) s
$$;

-- Every comparable title of a game: its own ('title'), kept by a trigger, and each
-- title a matched source record lists ('source').
create table private.game_title_keys (
  game_id uuid not null references public.games (id) on delete cascade,
  title_key text not null check (char_length(title_key) between 1 and 200),
  origin text not null check (origin in ('title', 'source')),
  provider_record_id uuid references private.provider_records (id) on delete cascade,
  constraint game_title_keys_origin check ((origin = 'source') = (provider_record_id is not null)),
  id uuid primary key default gen_random_uuid()
);
create unique index game_title_keys_unique on private.game_title_keys (game_id, title_key, origin, provider_record_id) nulls not distinct;
create index game_title_keys_title_key_idx on private.game_title_keys (title_key);
create index game_title_keys_record_idx on private.game_title_keys (provider_record_id) where provider_record_id is not null;
alter table private.game_title_keys enable row level security;
revoke all on table private.game_title_keys from public, anon, authenticated, service_role, catalog_importer;

create function private.sync_game_title_key()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from private.game_title_keys k where k.game_id = new.id and k.origin = 'title';
  if private.import_title_key(new.title) is not null then
    insert into private.game_title_keys (game_id, title_key, origin) values (new.id, private.import_title_key(new.title), 'title');
  end if;
  return null;
end;
$$;

create trigger sync_game_title_key after insert or update of title on public.games
  for each row execute function private.sync_game_title_key();

-- The titles a source record lists for a game.
create function private.import_add_title_keys(p_game uuid, p_record private.provider_records)
returns void
language sql
set search_path = ''
as $$
  insert into private.game_title_keys (game_id, title_key, origin, provider_record_id)
  select distinct p_game, private.import_title_key(t), 'source', p_record.id
  from pg_catalog.jsonb_array_elements_text(
    case when pg_catalog.jsonb_typeof(p_record.payload -> 'titles') = 'array' then p_record.payload -> 'titles' else '[]' end
    || pg_catalog.jsonb_build_array(coalesce(p_record.payload ->> 'title', ''))) t
  where private.import_title_key(t) is not null
  on conflict do nothing
$$;

-- Backfill what earlier imports and editors created.
insert into private.game_title_keys (game_id, title_key, origin)
select g.id, private.import_title_key(g.title), 'title' from public.games g where private.import_title_key(g.title) is not null
on conflict do nothing;
select private.import_add_title_keys(pr.matched_game_id, pr) from private.provider_records pr
where pr.entity_type = 'game' and pr.matched_game_id is not null;

-- Games on the platform with a comparable title, through the index.
create function private.import_games_by_key(p_platform uuid, p_key text)
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct g.id), '{}')
  from private.game_title_keys k
  join public.games g on g.id = k.game_id
  join public.game_platforms gp on gp.game_id = g.id and gp.platform_id = p_platform
  where p_key is not null and k.title_key = p_key and g.status not in ('merged', 'excluded', 'rejected')
$$;

create or replace function private.import_games_titled(p_platform uuid, p_title text)
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select private.import_games_by_key(p_platform, private.import_title_key(p_title))
$$;

-- ---------------------------------------------------------------------------
-- 3. The importer's functions, with title keys, suggestions and held entries
-- ---------------------------------------------------------------------------

create or replace function private.import_apply_game(p_run private.import_runs, p_record private.provider_records)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_game public.games;
  v_id uuid;
  v_title text := pg_catalog.btrim(p_record.payload ->> 'title');
  v_date date;
  v_precision public.date_precision;
  v_similar uuid[];
  v_filled text[] := '{}';
begin
  perform private.import_lock_source_id(p_record.provider_code, 'game', p_record.external_id);
  begin
    v_date := (p_record.payload ->> 'first_release_date')::date;
    v_precision := coalesce((p_record.payload ->> 'first_release_precision')::public.date_precision, 'unknown');
  exception when others then
    raise exception 'invalid source entry' using errcode = '22023';
  end;
  if v_date is null then
    v_precision := 'unknown';
  elsif v_precision = 'unknown' then
    v_date := null;
  end if;

  select x.game_id into v_id from private.external_references x
  where x.provider_code = p_record.provider_code and x.entity_type = 'game' and x.external_id = p_record.external_id;

  if found then
    select * into v_game from public.games g where g.id = v_id for update;
    if v_game.status in ('merged', 'excluded', 'rejected') then
      perform private.import_set_record(p_record.id, 'needs_review', 'A', v_id, null,
        pg_catalog.jsonb_build_object('reason', 'linked game is ' || v_game.status));
      return pg_catalog.jsonb_build_object('outcome', 'needs_review', 'game_id', v_id);
    end if;
    -- Fill only what's empty, unlocked and unverified.
    if v_game.status <> 'published' and v_game.verified_at is null and v_game.first_release_date is null and v_date is not null
       and not private.import_field_locked(v_id, null, 'first_release_date')
       and not private.import_field_locked(v_id, null, 'first_release_precision') then
      update public.games g set first_release_date = v_date, first_release_precision = v_precision where g.id = v_id;
      v_filled := array['first_release_date', 'first_release_precision'];
    end if;
    insert into public.game_platforms (game_id, platform_id, status) values (v_id, p_run.platform_id, 'under_review')
    on conflict (game_id, platform_id) do nothing;
    perform private.import_add_title_keys(v_id, p_record);
    perform private.import_set_record(p_record.id, 'matched', 'A', v_id, null,
      pg_catalog.jsonb_build_object('filled', v_filled, 'kept_editorial', v_game.status = 'published' or v_game.verified_at is not null));
    if cardinality(v_filled) > 0 then
      perform private.record_catalog_audit(null, 'catalog_record_updated', 'game', v_id, p_run.reason,
        pg_catalog.jsonb_build_object('fields', v_filled, 'import_run_id', p_run.id, 'provider_record_id', p_record.id));
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'matched', 'game_id', v_id, 'filled', v_filled);
  end if;

  if v_title is null or v_title = '' then
    raise exception 'invalid source entry' using errcode = '22023';
  end if;

  -- A game on this platform with the same title, not already identified by another
  -- entry of this source, may be the same game.
  select coalesce(pg_catalog.array_agg(s), '{}') into v_similar
  from pg_catalog.unnest(private.import_games_titled(p_run.platform_id, v_title)) s
  where not exists (select 1 from private.external_references x where x.game_id = s and x.provider_code = p_record.provider_code);
  if cardinality(v_similar) > 0 then
    perform private.import_set_record(p_record.id, 'needs_review', 'B', null, null,
      pg_catalog.jsonb_build_object('reason', 'possible duplicate', 'candidates', v_similar));
    return pg_catalog.jsonb_build_object('outcome', 'ambiguous', 'candidates', v_similar);
  end if;

  insert into public.games (title, sort_title, kind, first_release_date, first_release_precision, status)
  values (v_title, v_title, 'game', v_date, v_precision, 'under_review')
  returning id into v_id;
  insert into public.game_platforms (game_id, platform_id, status) values (v_id, p_run.platform_id, 'under_review');
  insert into private.external_references (provider_code, external_id, game_id) values (p_record.provider_code, p_record.external_id, v_id);
  perform private.import_add_title_keys(v_id, p_record);
  perform private.import_set_record(p_record.id, 'promoted', null, v_id, null, '{}');
  perform private.record_catalog_audit(null, 'catalog_record_created', 'game', v_id, p_run.reason,
    pg_catalog.jsonb_build_object('import_run_id', p_run.id, 'provider_record_id', p_record.id));
  return pg_catalog.jsonb_build_object('outcome', 'created', 'game_id', v_id);
end;
$$;

create or replace function private.import_apply_release(p_run private.import_runs, p_record private.provider_records)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_release public.releases;
  v_id uuid;
  v_games uuid[];
  v_format text;
  v_regions text[];
  v_region text := 'unknown';
  v_serial text := nullif(pg_catalog.btrim(p_record.payload ->> 'serial'), '');
  v_languages text[];
  v_same_serial uuid[];
  v_filled text[] := '{}';
  v_field text;
  v_suggested uuid[];
begin
  perform private.import_lock_source_id(p_record.provider_code, 'release', p_record.external_id);
  begin
    select coalesce(pg_catalog.array_agg(distinct r order by r), '{}') into v_regions
    from pg_catalog.jsonb_array_elements_text(coalesce(p_record.payload -> 'region_codes', '[]')) r;
    select nullif(coalesce(pg_catalog.array_agg(distinct l order by l), '{}'), '{}') into v_languages
    from pg_catalog.jsonb_array_elements_text(coalesce(p_record.payload -> 'languages', '[]')) l;
  exception when others then
    raise exception 'invalid source entry' using errcode = '22023';
  end;
  if cardinality(v_regions) = 1 and v_regions[1] <> 'unknown' then
    v_region := v_regions[1];
  end if;

  select x.release_id into v_id from private.external_references x
  where x.provider_code = p_record.provider_code and x.entity_type = 'release' and x.external_id = p_record.external_id;

  if found then
    select * into v_release from public.releases r where r.id = v_id for update;
    perform private.import_set_record(p_record.id, 'matched', 'A', v_release.game_id, v_id, '{}');
    if v_release.status in ('merged', 'excluded', 'rejected') or v_release.status = 'published' or v_release.verified_at is not null then
      perform private.import_set_record(p_record.id, 'matched', 'A', v_release.game_id, v_id,
        pg_catalog.jsonb_build_object('kept_editorial', true));
      return pg_catalog.jsonb_build_object('outcome', 'matched', 'release_id', v_id, 'filled', v_filled);
    end if;
    if v_region <> 'unknown' and v_release.region_code = 'unknown' and not v_release.region_unknown_confirmed
       and not private.import_field_locked(null, v_id, 'region_code') then
      update public.releases r set region_code = v_region where r.id = v_id;
      v_filled := v_filled || 'region_code'::text;
    end if;
    if v_serial is not null and v_release.product_code is null and not private.import_field_locked(null, v_id, 'product_code') then
      update public.releases r set product_code = v_serial where r.id = v_id;
      v_filled := v_filled || 'product_code'::text;
    end if;
    if v_languages is not null and v_release.languages is null and not private.import_field_locked(null, v_id, 'languages') then
      update public.releases r set languages = v_languages where r.id = v_id;
      v_filled := v_filled || 'languages'::text;
    end if;
    foreach v_field in array v_filled loop
      insert into private.release_evidence (release_id, field_name, provider_record_id) values (v_id, v_field, p_record.id)
      on conflict do nothing;
    end loop;
    perform private.import_set_record(p_record.id, 'matched', 'A', v_release.game_id, v_id, pg_catalog.jsonb_build_object('filled', v_filled));
    if cardinality(v_filled) > 0 then
      perform private.record_catalog_audit(null, 'catalog_record_updated', 'release', v_id, p_run.reason,
        pg_catalog.jsonb_build_object('fields', v_filled, 'import_run_id', p_run.id, 'provider_record_id', p_record.id));
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'matched', 'release_id', v_id, 'filled', v_filled);
  end if;

  -- The release's game: exactly one game on the platform with its title.
  v_games := private.import_games_titled(p_run.platform_id, p_record.payload ->> 'title');
  if cardinality(v_games) = 0 then
    -- A game titled like the entry's main title, before its subtitle, is suggested for
    -- review, never matched.
    v_suggested := private.import_games_by_key(p_run.platform_id, private.import_main_title_key(p_record.payload ->> 'title'));
    if cardinality(v_suggested) > 0 then
      perform private.import_set_record(p_record.id, 'needs_review', 'B', null, null,
        pg_catalog.jsonb_build_object('reason', 'possible match by main title', 'candidates', v_suggested));
      return pg_catalog.jsonb_build_object('outcome', 'suggested', 'candidates', v_suggested);
    end if;
    perform private.import_set_record(p_record.id, 'needs_review', 'C', null, null, pg_catalog.jsonb_build_object('reason', 'no matching game'));
    return pg_catalog.jsonb_build_object('outcome', 'unmatched');
  end if;
  if cardinality(v_games) > 1 then
    perform private.import_set_record(p_record.id, 'needs_review', 'B', null, null,
      pg_catalog.jsonb_build_object('reason', 'several matching games', 'candidates', v_games));
    return pg_catalog.jsonb_build_object('outcome', 'ambiguous', 'candidates', v_games);
  end if;

  -- The medium is known only when the platform has a single format.
  select pg_catalog.min(f.media_format_code) into v_format from public.platform_media_formats f
  where f.platform_id = p_run.platform_id having pg_catalog.count(*) = 1;
  if v_format is null then
    perform private.import_set_record(p_record.id, 'needs_review', 'A', v_games[1], null, pg_catalog.jsonb_build_object('reason', 'format unknown'));
    return pg_catalog.jsonb_build_object('outcome', 'needs_review');
  end if;

  -- A shared serial is noted for the editor, never used to merge.
  if v_serial is not null then
    select coalesce(pg_catalog.array_agg(r.id), '{}') into v_same_serial from public.releases r
    where r.platform_id = p_run.platform_id and r.product_code = v_serial;
  end if;

  insert into public.game_platforms (game_id, platform_id, status) values (v_games[1], p_run.platform_id, 'under_review')
  on conflict (game_id, platform_id) do nothing;
  insert into public.releases (game_id, platform_id, region_code, product_code, media_format_code, languages, status)
  values (v_games[1], p_run.platform_id, v_region, v_serial, v_format, v_languages, 'under_review')
  returning id into v_id;
  insert into private.external_references (provider_code, external_id, release_id) values (p_record.provider_code, p_record.external_id, v_id);
  perform private.import_set_record(p_record.id, 'promoted', 'A', v_games[1], v_id,
    case when cardinality(v_same_serial) > 0 then pg_catalog.jsonb_build_object('serial_also_on', v_same_serial) else '{}' end);

  v_filled := array['platform'];
  if v_region <> 'unknown' then v_filled := v_filled || 'region_code'::text; end if;
  if v_serial is not null then v_filled := v_filled || 'product_code'::text; end if;
  if v_languages is not null then v_filled := v_filled || 'languages'::text; end if;
  foreach v_field in array v_filled loop
    insert into private.release_evidence (release_id, field_name, provider_record_id) values (v_id, v_field, p_record.id);
  end loop;
  perform private.record_catalog_audit(null, 'catalog_record_created', 'release', v_id, p_run.reason,
    pg_catalog.jsonb_build_object('game_id', v_games[1], 'fields', v_filled, 'import_run_id', p_run.id, 'provider_record_id', p_record.id));
  return pg_catalog.jsonb_build_object('outcome', 'created', 'release_id', v_id, 'game_id', v_games[1],
    'serial_also_on', coalesce(v_same_serial, '{}'));
end;
$$;

create or replace function catalog_import.stage_records(p_run uuid, p_lease uuid, p_records jsonb, p_checkpoint jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.import_runs := private.import_run_for(p_run, p_lease);
  v_entry jsonb;
  v_id uuid;
  v_sha text;
  v_position integer;
  v_new integer := 0;
  v_unchanged integer := 0;
  v_changed integer := 0;
  v_ignored integer := 0;
  v_repeated integer := 0;
begin
  if p_records is null or pg_catalog.jsonb_typeof(p_records) <> 'array' or pg_catalog.jsonb_array_length(p_records) > 500
     or (p_checkpoint is not null and (pg_catalog.jsonb_typeof(p_checkpoint) <> 'object' or pg_catalog.pg_column_size(p_checkpoint) > 4096)) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.max(x.position), -1) into v_position from private.import_run_records x where x.import_run_id = p_run;

  for v_entry in select e from pg_catalog.jsonb_array_elements(p_records) e loop
    if pg_catalog.jsonb_typeof(v_entry) <> 'object'
       or not (select coalesce(pg_catalog.array_agg(k), '{}') from pg_catalog.jsonb_object_keys(v_entry) k)
              operator(pg_catalog.<@) array['entity_type', 'external_id', 'ignore_reason', 'payload', 'review_reason']
       or (v_entry ? 'ignore_reason' and v_entry ? 'review_reason')
       or pg_catalog.jsonb_typeof(v_entry -> 'payload') is distinct from 'object' then
      raise exception 'invalid source entry' using errcode = '22023';
    end if;
    v_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((v_entry -> 'payload')::text, 'UTF8')), 'hex');
    insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, match_notes, review_reason)
    values (v_run.provider_code, v_entry ->> 'entity_type', v_entry ->> 'external_id', v_entry -> 'payload', v_sha, p_run,
      case when v_entry ? 'ignore_reason' then 'ignored'::public.provider_record_status
           when v_entry ? 'review_reason' then 'needs_review'::public.provider_record_status else 'fetched'::public.provider_record_status end,
      case when v_entry ? 'ignore_reason' then pg_catalog.jsonb_build_object('ignored', pg_catalog.left(v_entry ->> 'ignore_reason', 200))
           when v_entry ? 'review_reason' then pg_catalog.jsonb_build_object('held', pg_catalog.left(v_entry ->> 'review_reason', 200)) else '{}' end,
      pg_catalog.left(nullif(pg_catalog.btrim(v_entry ->> 'review_reason'), ''), 200))
    on conflict (provider_code, entity_type, external_id, payload_sha256) do nothing
    returning id into v_id;
    if v_id is null then
      select pr.id into v_id from private.provider_records pr
      where pr.provider_code = v_run.provider_code and pr.entity_type = v_entry ->> 'entity_type'
        and pr.external_id = v_entry ->> 'external_id' and pr.payload_sha256 = v_sha;
      v_unchanged := v_unchanged + 1;
    else
      v_new := v_new + 1;
      if v_entry ? 'ignore_reason' then
        v_ignored := v_ignored + 1;
      end if;
      if exists (select 1 from private.provider_records pr where pr.provider_code = v_run.provider_code and pr.entity_type = v_entry ->> 'entity_type'
                 and pr.external_id = v_entry ->> 'external_id' and pr.id <> v_id) then
        v_changed := v_changed + 1;
      end if;
    end if;
    v_position := v_position + 1;
    insert into private.import_run_records (import_run_id, provider_record_id, position) values (p_run, v_id, v_position)
    on conflict (import_run_id, provider_record_id) do nothing;
    if not found then
      v_repeated := v_repeated + 1;
    end if;
    v_id := null;
  end loop;

  update private.import_runs r set
    checkpoint = coalesce(p_checkpoint, r.checkpoint),
    stats = r.stats || pg_catalog.jsonb_build_object(
      'staged_new', coalesce((r.stats ->> 'staged_new')::integer, 0) + v_new,
      'staged_unchanged', coalesce((r.stats ->> 'staged_unchanged')::integer, 0) + v_unchanged,
      'staged_changed', coalesce((r.stats ->> 'staged_changed')::integer, 0) + v_changed,
      'staged_ignored', coalesce((r.stats ->> 'staged_ignored')::integer, 0) + v_ignored,
      'staged_repeated', coalesce((r.stats ->> 'staged_repeated')::integer, 0) + v_repeated)
  where r.id = p_run;
  return pg_catalog.jsonb_build_object('new', v_new, 'unchanged', v_unchanged, 'changed', v_changed, 'ignored', v_ignored, 'repeated', v_repeated);
end;
$$;

create or replace function catalog_import.pending_records(p_run uuid, p_lease uuid, p_after integer, p_limit integer)
returns table (record_position integer, provider_record_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.import_run_for(p_run, p_lease);
  return query
    select x.position, x.provider_record_id
    from private.import_run_records x
    join private.provider_records pr on pr.id = x.provider_record_id
    where x.import_run_id = p_run and x.position > coalesce(p_after, -1) and pr.status in ('fetched', 'needs_review') and pr.review_reason is null
    order by x.position
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

create or replace function catalog_import.apply_record(p_run uuid, p_lease uuid, p_record uuid, p_checkpoint jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.import_runs := private.import_run_for(p_run, p_lease);
  v_record private.provider_records;
  v_result jsonb;
begin
  if p_checkpoint is not null and (pg_catalog.jsonb_typeof(p_checkpoint) <> 'object' or pg_catalog.pg_column_size(p_checkpoint) > 4096) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select pr.* into v_record from private.provider_records pr
  join private.import_run_records x on x.provider_record_id = pr.id and x.import_run_id = p_run
  where pr.id = p_record for update of pr;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_record.review_reason is not null then
    -- Held for an editor, such as a Nintendo Power flash release: never applied.
    v_result := pg_catalog.jsonb_build_object('outcome', 'held', 'reason', v_record.review_reason);
  elsif v_record.status not in ('fetched', 'needs_review') then
    v_result := pg_catalog.jsonb_build_object('outcome', 'skipped', 'status', v_record.status);
  elsif v_record.entity_type = 'game' then
    v_result := private.import_apply_game(v_run, v_record);
  else
    v_result := private.import_apply_release(v_run, v_record);
  end if;
  if p_checkpoint is not null then
    update private.import_runs r set checkpoint = p_checkpoint where r.id = p_run;
  end if;
  return v_result;
end;
$$;

create or replace function catalog_import.run_report(p_run uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with run as (
    select * from private.import_runs r where r.id = p_run
  ), recs as (
    select pr.* from private.provider_records pr
    join private.import_run_records x on x.provider_record_id = pr.id and x.import_run_id = p_run
  ), rels as (
    select r.* from public.releases r where r.id in (select matched_release_id from recs where entity_type = 'release')
  )
  select pg_catalog.jsonb_build_object(
    'run', (select pg_catalog.jsonb_build_object('id', id, 'provider', provider_code, 'status', status, 'source_name', source_name,
             'source_sha256', source_sha256, 'started_at', started_at, 'finished_at', finished_at, 'stats', stats) from run),
    'source_records', (select pg_catalog.count(*) from recs),
    'by_status', (select coalesce(pg_catalog.jsonb_object_agg(k, n), '{}') from (select entity_type || ':' || status k, pg_catalog.count(*) n from recs group by 1) s),
    'by_tier', (select coalesce(pg_catalog.jsonb_object_agg(k, n), '{}') from (select entity_type || ':' || coalesce(match_tier, 'new') k, pg_catalog.count(*) n from recs where status <> 'ignored' group by 1) s),
    'games_created', (select pg_catalog.count(*) from recs where entity_type = 'game' and status = 'promoted'),
    'releases_created', (select pg_catalog.count(*) from recs where entity_type = 'release' and status = 'promoted'),
    'possible_duplicates', (select pg_catalog.count(*) from recs where match_notes ? 'candidates'),
    'shared_serials', (select pg_catalog.count(*) from recs where match_notes ? 'serial_also_on'),
    'ignored_reasons', (select coalesce(pg_catalog.jsonb_object_agg(k, n), '{}') from (select match_notes ->> 'ignored' k, pg_catalog.count(*) n from recs where status = 'ignored' group by 1) s),
    'held_reasons', (select coalesce(pg_catalog.jsonb_object_agg(k, n), '{}') from (select review_reason k, pg_catalog.count(*) n from recs where review_reason is not null group by 1) s),
    'suggested', (select pg_catalog.count(*) from recs where match_notes ->> 'reason' = 'possible match by main title'),
    'created_release_types', (select coalesce(pg_catalog.jsonb_object_agg(k, n), '{}') from (select coalesce(payload ->> 'release_type', 'original') k, pg_catalog.count(*) n from recs where entity_type = 'release' and status = 'promoted' group by 1) s),
    'created_flags', (select coalesce(pg_catalog.jsonb_object_agg(k, n), '{}') from (select f k, pg_catalog.count(*) n from recs, pg_catalog.jsonb_array_elements_text(case when pg_catalog.jsonb_typeof(payload -> 'flags') = 'array' then payload -> 'flags' else '[]' end) f where entity_type = 'release' and status = 'promoted' group by 1) s),
    'releases_missing', (select pg_catalog.jsonb_build_object(
        'releases', pg_catalog.count(*),
        'region', pg_catalog.count(*) filter (where region_code = 'unknown'),
        'product_code', pg_catalog.count(*) filter (where product_code is null),
        'languages', pg_catalog.count(*) filter (where languages is null),
        'edition', pg_catalog.count(*) filter (where edition_name is null or edition_kind is null),
        'media_count', pg_catalog.count(*) filter (where media_count is null),
        'packaging', pg_catalog.count(*) filter (where packaging is null),
        'release_date', pg_catalog.count(*) filter (where release_date is null)) from rels),
    'published_or_verified', (select pg_catalog.count(*) from rels where status = 'published' or verified_at is not null)
  )
  where exists (select 1 from run)
$$;

-- ---------------------------------------------------------------------------
-- 4. Access
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.import_main_title_key(text)',
    'private.sync_game_title_key()',
    'private.import_add_title_keys(uuid, private.provider_records)',
    'private.import_games_by_key(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
  end loop;
end;
$$;
