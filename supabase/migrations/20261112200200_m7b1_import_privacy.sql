-- M7b-1 follow-up: imports never match, change or take over a private submission.
--
-- Design: docs/architecture/security-rls.md#catalog-import
--
-- Before: the importer found existing games by title (exactly, ignoring word breaks,
-- and by main title, as a suggestion) among all games on the run's platform except
-- merged, excluded and rejected ones. That included a collector's pending submitted
-- game. A source entry with the same title was then held as a possible duplicate of
-- it, or, for a release, created on it: the import added a release to someone's private
-- submission, which also kept the game alive if they withdrew. A shared serial was
-- noted with the ids of every release with that product code, pending submissions
-- included.
--
-- After: a private submission is invisible to import matching. That's an unpublished
-- game or release that a collector submitted: `submitted_by` is set, or a review
-- request created it, which covers a submitter whose account was deleted. A source entry
-- with the same title is then treated as if the submission weren't there: a game entry
-- creates its own candidate, under review, and a release entry matches only other
-- games, or none. Editors see both in review, where duplicates are listed. Once a
-- submission is published it's an ordinary catalog record, and matched as before.
--
-- Nothing else changes. Every importer change to an existing record goes through its
-- own external references, which only ever point to records an import created, and
-- the review guard (M7b-1) refuses verifying or publishing a submission outside review.
-- Games have no unique title, so a candidate with the same title as a submission is
-- allowed, as two equal titles always were.

create function private.import_private_game(p_game public.games)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_game.status <> 'published'
    and (p_game.submitted_by is not null
         or exists (select 1 from public.catalog_change_requests s where s.game_id = p_game.id and s.created_game))
$$;

create function private.import_private_release(p_release public.releases)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_release.status <> 'published'
    and (p_release.submitted_by is not null
         or exists (select 1 from public.catalog_change_requests s where s.release_id = p_release.id))
$$;

revoke all on function private.import_private_game(public.games) from public, anon, authenticated, service_role, catalog_importer;
revoke all on function private.import_private_release(public.releases) from public, anon, authenticated, service_role, catalog_importer;

-- Games on the platform with a title key: exact titles, source titles and main titles.
create or replace function private.import_games_by_key(p_platform uuid, p_key text)
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
    and not private.import_private_game(g)
$$;

-- Games on the platform with the same title ignoring word breaks.
create or replace function private.import_games_by_compact(p_platform uuid, p_compact text)
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
    and not private.import_private_game(g)
$$;

-- As in M5b, except that a shared serial is never noted against a private submission.
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
    where r.platform_id = p_run.platform_id and r.product_code = v_serial
      and not private.import_private_release(r);
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
