-- M5b Catalog import: reclassifying imported candidates, and word-break matching.
--
-- Design: docs/architecture/security-rls.md#catalog-import
-- When a later snapshot classifies an entry as not a release to import, or holds it,
-- and its source id already has a candidate, the import reconsiders that candidate:
--   - It withdraws it, by setting it 'rejected', only when the source now rejects it
--     with explicit evidence (a digital service, another platform, a prototype, a
--     pirate copy, a hack, not a game, a bad or non-working dump), and the candidate is
--     unpublished, unverified, without field locks, created by an import, never
--     changed by an editor, and supported by no other source entry.
--   - Otherwise it queues it for an editor, with the reason and what blocked
--     withdrawal. A held entry is never withdrawn.
-- Nothing is deleted. The candidate, its source records, its evidence and its audit
-- history stay, and each withdrawal and queue item is audited.
--
-- A title that matches nothing exactly but matches one game on the platform ignoring
-- word breaks is a match. Several such games mean review.

-- ---------------------------------------------------------------------------
-- 1. Word-break-insensitive keys
-- ---------------------------------------------------------------------------

alter table private.game_title_keys
  add column compact_key text generated always as (pg_catalog.replace(title_key, '-', '')) stored;
create index game_title_keys_compact_key_idx on private.game_title_keys (compact_key);

-- A title key without word breaks, or null when too short to compare safely.
create function private.import_compact_key(p_title text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when pg_catalog.char_length(pg_catalog.replace(k, '-', '')) >= 6 then pg_catalog.replace(k, '-', '') end
  from (select private.import_title_key(p_title) as k) s
$$;

create function private.import_games_by_compact(p_platform uuid, p_compact text)
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct g.id), '{}')
  from private.game_title_keys k
  join public.games g on g.id = k.game_id
  join public.game_platforms gp on gp.game_id = g.id and gp.platform_id = p_platform
  where p_compact is not null and k.compact_key = p_compact and g.status not in ('merged', 'excluded', 'rejected')
$$;

-- ---------------------------------------------------------------------------
-- 2. Reclassification and the editor review queue
-- ---------------------------------------------------------------------------

create table private.catalog_reclassifications (
  id uuid primary key default private.uuid_v7(),
  release_id uuid not null references public.releases (id) on delete cascade,
  provider_record_id uuid not null references private.provider_records (id) on delete cascade,
  import_run_id uuid not null references private.import_runs (id) on delete cascade,
  action text not null check (action in ('withdrawn', 'queued')),
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  resolution text check (char_length(resolution) between 1 and 500),
  constraint catalog_reclassifications_resolution check ((resolved_at is null) = (resolution is null)),
  constraint catalog_reclassifications_queue_only check (action = 'queued' or resolved_at is null),
  unique (release_id, provider_record_id)
);
create index catalog_reclassifications_open_idx on private.catalog_reclassifications (created_at) where action = 'queued' and resolved_at is null;
create index catalog_reclassifications_record_idx on private.catalog_reclassifications (provider_record_id);
create index catalog_reclassifications_run_idx on private.catalog_reclassifications (import_run_id);
alter table private.catalog_reclassifications enable row level security;
revoke all on table private.catalog_reclassifications from public, anon, authenticated, service_role, catalog_importer;

-- Finding a record's catalog audit history by its id.
create index audit_events_catalog_record_idx on private.audit_events ((metadata ->> 'id')) where metadata ? 'id';

-- Reconsiders an existing candidate whose source entry is now ignored or held.
create function private.import_reclassify(p_run private.import_runs, p_record private.provider_records)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_release public.releases;
  v_reason text := coalesce(p_record.review_reason, p_record.match_notes ->> 'ignored', 'reclassified by the source');
  v_blockers text[] := '{}';
begin
  perform private.import_lock_source_id(p_record.provider_code, 'release', p_record.external_id);
  select x.release_id into v_id from private.external_references x
  where x.provider_code = p_record.provider_code and x.entity_type = 'release' and x.external_id = p_record.external_id;
  if not found or exists (select 1 from private.catalog_reclassifications c where c.provider_record_id = p_record.id) then
    return pg_catalog.jsonb_build_object('outcome', 'skipped');
  end if;
  select * into v_release from public.releases r where r.id = v_id for update;
  if v_release.status = 'rejected' then
    return pg_catalog.jsonb_build_object('outcome', 'skipped', 'status', v_release.status);
  end if;

  if p_record.review_reason is not null then
    v_blockers := v_blockers || 'held for review, not rejected'::text;
  elsif v_reason not in ('digital release', 'release for another platform', 'prototype', 'pirate copy', 'hack or fan translation',
                         'not a game', 'not a working dump', 'bad dump') then
    v_blockers := v_blockers || 'reason needs an editor'::text;
  end if;
  if v_release.status not in ('unverified', 'under_review') then
    v_blockers := v_blockers || ('status ' || v_release.status::text);
  end if;
  if v_release.verified_at is not null then
    v_blockers := v_blockers || 'verified'::text;
  end if;
  if exists (select 1 from private.catalog_field_locks l where l.release_id = v_id) then
    v_blockers := v_blockers || 'field locked'::text;
  end if;
  if exists (select 1 from private.audit_events e where e.metadata ? 'id' and e.metadata ->> 'id' = v_id::text and e.actor_id is not null) then
    v_blockers := v_blockers || 'changed by an editor'::text;
  end if;
  if not exists (select 1 from private.audit_events e where e.metadata ? 'id' and e.metadata ->> 'id' = v_id::text
                 and e.action = 'catalog_record_created' and e.actor_id is null and e.metadata ? 'import_run_id') then
    v_blockers := v_blockers || 'not created by an import'::text;
  end if;
  if exists (select 1 from private.release_evidence e join private.provider_records pr on pr.id = e.provider_record_id
             where e.release_id = v_id and (pr.provider_code, pr.external_id) is distinct from (p_record.provider_code, p_record.external_id)) then
    v_blockers := v_blockers || 'supported by another source entry'::text;
  end if;

  if cardinality(v_blockers) = 0 then
    update public.releases r set status = 'rejected' where r.id = v_id;
    insert into private.catalog_reclassifications (release_id, provider_record_id, import_run_id, action, reason)
    values (v_id, p_record.id, p_run.id, 'withdrawn', v_reason);
    perform private.record_catalog_audit(null, 'catalog_record_withdrawn', 'release', v_id, p_run.reason,
      pg_catalog.jsonb_build_object('reason', v_reason, 'status', 'rejected', 'import_run_id', p_run.id, 'provider_record_id', p_record.id));
    return pg_catalog.jsonb_build_object('outcome', 'withdrawn', 'release_id', v_id, 'reason', v_reason);
  end if;

  insert into private.catalog_reclassifications (release_id, provider_record_id, import_run_id, action, reason)
  values (v_id, p_record.id, p_run.id, 'queued', pg_catalog.left(v_reason || ' (' || pg_catalog.array_to_string(v_blockers, ', ') || ')', 500));
  perform private.record_catalog_audit(null, 'catalog_review_queued', 'release', v_id, p_run.reason,
    pg_catalog.jsonb_build_object('reason', v_reason, 'blockers', v_blockers, 'import_run_id', p_run.id, 'provider_record_id', p_record.id));
  return pg_catalog.jsonb_build_object('outcome', 'queued', 'release_id', v_id, 'reason', v_reason, 'blockers', v_blockers);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The importer's functions
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

  -- A game on this platform with the same title, or the same title ignoring word
  -- breaks, not already identified by another entry of this source, may be the same game.
  select coalesce(pg_catalog.array_agg(distinct s), '{}') into v_similar
  from pg_catalog.unnest(private.import_games_titled(p_run.platform_id, v_title)
    || private.import_games_by_compact(p_run.platform_id, private.import_compact_key(v_title))) s
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
  v_compact uuid[];
  v_match_note text;
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
    -- The same title ignoring word breaks ("ClayFighter", "Clay Fighter") is a match
    -- only when exactly one game on the platform has it.
    v_compact := private.import_games_by_compact(p_run.platform_id, private.import_compact_key(p_record.payload ->> 'title'));
    if cardinality(v_compact) > 1 then
      perform private.import_set_record(p_record.id, 'needs_review', 'B', null, null,
        pg_catalog.jsonb_build_object('reason', 'several games match ignoring word breaks', 'candidates', v_compact));
      return pg_catalog.jsonb_build_object('outcome', 'ambiguous', 'candidates', v_compact);
    end if;
    v_games := v_compact;
    v_match_note := 'matched ignoring word breaks';
  end if;
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
    case when cardinality(v_same_serial) > 0 then pg_catalog.jsonb_build_object('serial_also_on', v_same_serial) else '{}' end
    || case when v_match_note is not null then pg_catalog.jsonb_build_object('match', v_match_note) else '{}' end);

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
    where x.import_run_id = p_run and x.position > coalesce(p_after, -1)
      and (
        (pr.status in ('fetched', 'needs_review') and pr.review_reason is null)
        -- A release entry now ignored or held, whose source id already has a candidate,
        -- is reconsidered once.
        or (pr.entity_type = 'release' and (pr.status = 'ignored' or pr.review_reason is not null)
            and exists (select 1 from private.external_references r
                        where r.provider_code = pr.provider_code and r.entity_type = 'release' and r.external_id = pr.external_id)
            and not exists (select 1 from private.catalog_reclassifications c where c.provider_record_id = pr.id))
      )
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
  if v_record.entity_type = 'release' and (v_record.review_reason is not null or v_record.status = 'ignored')
     and exists (select 1 from private.external_references r
                 where r.provider_code = v_record.provider_code and r.entity_type = 'release' and r.external_id = v_record.external_id) then
    -- The source now says an existing candidate isn't a release to import.
    v_result := private.import_reclassify(v_run, v_record);
  elsif v_record.review_reason is not null then
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
    'word_break_matches', (select pg_catalog.count(*) from recs where match_notes ->> 'match' = 'matched ignoring word breaks'),
    'withdrawn', (select pg_catalog.count(*) from private.catalog_reclassifications c where c.import_run_id = p_run and c.action = 'withdrawn'),
    'queued_for_review', (select pg_catalog.count(*) from private.catalog_reclassifications c where c.import_run_id = p_run and c.action = 'queued'),
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
    -- An entry's classification is part of what the source says, so a reclassified
    -- entry with the same payload is a changed entry. Unclassified entries hash their payload.
    v_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((v_entry -> 'payload')::text
      || case when v_entry ? 'ignore_reason' then pg_catalog.chr(10) || 'ignored: ' || (v_entry ->> 'ignore_reason')
              when v_entry ? 'review_reason' then pg_catalog.chr(10) || 'held: ' || (v_entry ->> 'review_reason') else '' end, 'UTF8')), 'hex');
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

-- ---------------------------------------------------------------------------
-- 4. The editor review queue
-- ---------------------------------------------------------------------------

-- Open items, oldest first. For active catalog editors and administrators.
create function public.get_catalog_review_queue(p_limit integer default 50)
returns table (id uuid, release_id uuid, reason text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.begin_catalog_edit();
  return query
    select c.id, c.release_id, c.reason, c.created_at from private.catalog_reclassifications c
    where c.action = 'queued' and c.resolved_at is null
    order by c.created_at, c.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- Closes an item with the editor's resolution. Any change to the release itself goes
-- through the editor functions.
create function public.resolve_catalog_review(p_id uuid, p_resolution text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_resolution text;
  v_release uuid;
begin
  v_me := private.begin_catalog_edit();
  v_resolution := private.require_reason(p_resolution);
  update private.catalog_reclassifications c set resolved_at = pg_catalog.now(), resolved_by = v_me, resolution = v_resolution
  where c.id = p_id and c.action = 'queued' and c.resolved_at is null
  returning c.release_id into v_release;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  perform private.record_catalog_audit(v_me, 'catalog_review_resolved', 'release', v_release, v_resolution,
    pg_catalog.jsonb_build_object('review_id', p_id));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Access
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.import_compact_key(text)',
    'private.import_games_by_compact(uuid, text)',
    'private.import_reclassify(private.import_runs, private.provider_records)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.get_catalog_review_queue(integer)',
    'public.resolve_catalog_review(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
