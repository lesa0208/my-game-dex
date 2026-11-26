-- M16: a game on several platforms gets every platform's pairing, however its source record changed.
--
-- The importer keeps one provider record per source id and payload. When a game's Wikidata record
-- is identical for two platforms, the second platform's run stages it as "unchanged": the run links
-- the existing record, which the first run already promoted (or matched). pending_records offered
-- only fetched records, and apply_record skipped everything else, so the second platform's pairing
-- was never made. The M16 demo import lost 116 of its 1,080 listings this way.
--
-- Now a game record already applied (promoted or matched), not held, whose game is identified by
-- that source id and has no pairing on the run's platform, is offered once more, and applying it
-- only adds that pairing, under review (private.import_pair_unchanged). Nothing else about the
-- game, the record or its status changes: no field is filled, no title key added, no audit
-- written beyond what the matched path writes (none for a pairing). A merged, excluded or rejected
-- game is never paired. An existing pairing, whatever its status (an excluded one included), is
-- never touched, so a pairing an editor withdrew isn't brought back.
--
-- pending_records and apply_record are otherwise their current definitions (migration
-- 20261109100500), with the same signatures, security definer, search path and grants (create or
-- replace keeps them). catalog_importer gains no privilege: the new function is private and is
-- called only from apply_record.

create function private.import_pair_unchanged(p_run private.import_runs, p_record private.provider_records)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_status public.catalog_status;
begin
  perform private.import_lock_source_id(p_record.provider_code, 'game', p_record.external_id);
  select x.game_id into v_id from private.external_references x
  where x.provider_code = p_record.provider_code and x.entity_type = 'game' and x.external_id = p_record.external_id;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'skipped', 'status', p_record.status);
  end if;
  select g.status into v_status from public.games g where g.id = v_id for update;
  if v_status in ('merged', 'excluded', 'rejected') then
    return pg_catalog.jsonb_build_object('outcome', 'skipped', 'status', p_record.status, 'game_status', v_status);
  end if;
  insert into public.game_platforms (game_id, platform_id, status) values (v_id, p_run.platform_id, 'under_review')
  on conflict (game_id, platform_id) do nothing;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'skipped', 'status', p_record.status);
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'paired', 'game_id', v_id);
end;
$$;

revoke all on function private.import_pair_unchanged(private.import_runs, private.provider_records) from public, anon, authenticated, service_role;

create or replace function catalog_import.pending_records(p_run uuid, p_lease uuid, p_after integer, p_limit integer)
returns table(record_position integer, provider_record_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.import_runs := private.import_run_for(p_run, p_lease);
begin
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
        -- M16: a game record already applied, unchanged, whose game has no pairing on this
        -- run's platform yet (import_pair_unchanged).
        or (pr.entity_type = 'game' and pr.status in ('promoted', 'matched') and pr.review_reason is null
            and exists (select 1 from private.external_references r
                        join public.games g on g.id = r.game_id and g.status not in ('merged', 'excluded', 'rejected')
                        where r.provider_code = pr.provider_code and r.entity_type = 'game' and r.external_id = pr.external_id
                          and not exists (select 1 from public.game_platforms gp where gp.game_id = r.game_id and gp.platform_id = v_run.platform_id)))
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
  elsif v_record.entity_type = 'game' and v_record.status in ('promoted', 'matched') then
    -- M16: an unchanged game record seen by another platform's run: that platform's pairing only.
    v_result := private.import_pair_unchanged(v_run, v_record);
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
