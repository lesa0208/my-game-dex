-- ROLLBACK for 20261210100400_m14a_physical_evidence_gate.sql (M14a).
--
-- Kept outside supabase/migrations. Run as a forward migration in one transaction. Restores
-- B1-M2's approve_review_batch and B1-M1's publish_game_identity exactly as reviewed, and
-- drops the physical-evidence check. It refuses nothing: no row can violate the old rules.

alter table public.game_platforms drop constraint game_platforms_physical_evidence;

create or replace function public.approve_review_batch(p_batch uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_batch private.catalog_review_batches;
  v_missing integer;
  v_incorrect integer;
  v_critical integer;
  v_sample_critical integer;
  v_stale integer;
  v_approvals integer;
  v_item record;
  v_source record;
  v_published integer := 0;
  v_slug text;
  v_rows integer;
begin
  v_me := private.begin_catalog_edit();
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  select * into v_batch from private.catalog_review_batches b where b.id = p_batch for update;
  if not found or v_batch.status <> 'open' then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  -- B4: independence.
  if v_batch.created_by = v_me
     or private.created_by(v_me, null, (select pg_catalog.array_agg(i.game_id) from private.catalog_review_batch_items i where i.batch_id = p_batch))
     or exists (select 1 from private.catalog_review_batch_items i where i.batch_id = p_batch and private.pairing_created_by(v_me, i.game_id, i.platform_id))
     or exists (select 1 from private.catalog_review_batch_items i join public.games g on g.id = i.game_id
                where i.batch_id = p_batch and g.submitted_by = v_me) then
    raise exception 'own record' using errcode = 'P0001';
  end if;
  if exists (select 1 from private.catalog_review_batch_approvals a where a.batch_id = p_batch and a.approver_id = v_me) then
    raise exception 'already approved' using errcode = 'P0001';
  end if;

  -- A sampled member that isn't correct is a sample error whether it was marked incorrect or
  -- excluded: excluding it doesn't make the validators' miss go away (B4).
  select count(*) filter (where (i.sampled or cardinality(i.flags) > 0) and i.outcome is null),
         count(*) filter (where i.sampled and i.outcome <> 'correct'),
         count(*) filter (where i.critical_error is not null and i.outcome = 'incorrect'),
         count(*) filter (where i.sampled and i.critical_error is not null)
  into v_missing, v_incorrect, v_critical, v_sample_critical
  from private.catalog_review_batch_items i where i.batch_id = p_batch;
  if v_missing > 0 then
    raise exception 'batch not reviewed' using errcode = 'P0001';                 -- B3
  end if;
  if v_incorrect > v_batch.acceptance_number or v_sample_critical > 0 then
    raise exception 'sample failed' using errcode = 'P0001';                      -- B4, B5
  end if;
  if v_critical > 0 then
    raise exception 'critical errors unresolved' using errcode = 'P0001';         -- B4
  end if;

  -- B12 (finding 1): lock every member game, then every member pairing, in id order, before
  -- checking them. A concurrent edit either finishes first (and the check below sees it) or
  -- waits for this transaction. Deterministic order, so two approvals can't deadlock.
  perform 1 from public.games g
  where g.id in (select i.game_id from private.catalog_review_batch_items i where i.batch_id = p_batch)
  order by g.id for update;
  perform 1 from public.game_platforms gp
  join private.catalog_review_batch_items i on i.game_id = gp.game_id and i.platform_id = gp.platform_id and i.batch_id = p_batch
  order by gp.game_id, gp.platform_id for update of gp;

  select count(*) into v_stale
  from private.catalog_review_batch_items i
  left join public.games g on g.id = i.game_id
  left join public.game_platforms gp on gp.game_id = i.game_id and gp.platform_id = i.platform_id
  -- A member is stale if its game changed (any edit, status change or pairing withdrawal moves
  -- the revision), or its game or pairing is no longer in review.
  where i.batch_id = p_batch and (g.id is null or gp.game_id is null or g.revision <> i.frozen_game_revision
                                  or g.status not in ('unverified', 'under_review') or g.verified_at is not null
                                  or gp.status not in ('unverified', 'under_review'));
  if v_stale > 0 then
    raise exception 'batch stale' using errcode = 'P0001';                        -- B4: revision invalidation
  end if;

  -- B16 (finding 6): the right to publish each member's source, rechecked now, under a share
  -- lock on the provider, so withdrawn clearance after staging stops the approval.
  for v_source in
    select distinct pr.provider_code, src.terms_sha256
    from private.catalog_review_batch_items i
    join private.provider_records pr on pr.id = i.provider_record_id
    join private.import_runs src on src.id = pr.import_run_id
    where i.batch_id = p_batch and (i.outcome = 'correct' or (i.outcome is null and cardinality(i.flags) = 0 and not i.sampled))
    order by 1, 2
  loop
    perform private.require_publication_rights(v_source.provider_code, v_source.terms_sha256);
  end loop;

  insert into private.catalog_review_batch_approvals (batch_id, approver_id, reason) values (p_batch, v_me, v_reason);
  select count(*) into v_approvals from private.catalog_review_batch_approvals a where a.batch_id = p_batch;
  if v_approvals < v_batch.required_approvals then
    perform private.record_audit(v_me, 'catalog_batch_approval_recorded', null, v_reason, pg_catalog.jsonb_build_object(
      'batch_id', p_batch, 'approvals', v_approvals, 'required', v_batch.required_approvals));
    return pg_catalog.jsonb_build_object('status', 'awaiting_approval', 'approvals', v_approvals, 'required', v_batch.required_approvals);
  end if;

  -- B7: publish identities: each member reviewed correct, or unflagged and not sampled.
  -- Provenance is the frozen member's own source record. Physical eligibility is "confirmed" for
  -- a member a person reviewed and found correct, and "batch_accepted" for an unsampled member
  -- accepted with the batch's passing sample: never presented as an individual check.
  -- B12: every write is conditional on the frozen state; any miss fails the whole approval.
  for v_item in
    select i.game_id, i.platform_id, i.frozen_game_revision, g.title, g.slug, pr.provider_code, pr.external_id, pr.payload_sha256,
           i.outcome = 'correct' as reviewed
    from private.catalog_review_batch_items i
    join public.games g on g.id = i.game_id
    join private.provider_records pr on pr.id = i.provider_record_id
    where i.batch_id = p_batch and (i.outcome = 'correct' or (i.outcome is null and cardinality(i.flags) = 0 and not i.sampled))
    order by i.game_id
  loop
    -- The game row has no basis column, so its audit row says how it was accepted: a batch-accepted
    -- record is never recorded as individually reviewed.
    update public.games g set verified_at = pg_catalog.clock_timestamp(), verified_by = v_me
    where g.id = v_item.game_id and g.revision = v_item.frozen_game_revision
      and g.status in ('unverified', 'under_review') and g.verified_at is null;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'batch stale' using errcode = 'P0001';
    end if;
    perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'game', v_item.game_id, v_reason,
      pg_catalog.jsonb_build_object('revision', v_item.frozen_game_revision, 'batch_id', p_batch,
        'acceptance', case when v_item.reviewed then 'individually_reviewed' else 'batch_accepted' end));
    update public.game_platforms gp set verified_at = pg_catalog.clock_timestamp(), verified_by = v_me,
      verified_game_revision = v_item.frozen_game_revision,
      verification_basis = pg_catalog.jsonb_build_object('source', v_item.provider_code, 'reference', v_item.external_id,
        'snapshot_sha256', v_item.payload_sha256,
        'physical_eligibility', case when v_item.reviewed then 'confirmed' else 'batch_accepted' end, 'batch_id', p_batch::text)
    where gp.game_id = v_item.game_id and gp.platform_id = v_item.platform_id and gp.status in ('unverified', 'under_review');
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'batch stale' using errcode = 'P0001';
    end if;
    perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'game_platform', v_item.game_id, v_reason,
      pg_catalog.jsonb_build_object('platform_id', v_item.platform_id, 'batch_id', p_batch,
        'acceptance', case when v_item.reviewed then 'individually_reviewed' else 'batch_accepted' end));
    v_slug := coalesce(v_item.slug, private.assign_game_slug(v_item.title));
    update public.games g set status = 'published', slug = v_slug, submitted_by = null where g.id = v_item.game_id;
    update public.game_platforms gp set status = 'published', submitted_by = null
    where gp.game_id = v_item.game_id and gp.platform_id = v_item.platform_id;
    perform private.record_catalog_audit(v_me, 'catalog_record_published', 'game', v_item.game_id, v_reason,
      pg_catalog.jsonb_build_object('slug', v_slug, 'identity', true, 'platforms', pg_catalog.jsonb_build_array(v_item.platform_id), 'batch_id', p_batch));
    v_published := v_published + 1;
  end loop;

  update private.catalog_review_batches b set status = 'approved', decided_at = pg_catalog.now(), decision_reason = v_reason
  where b.id = p_batch;
  perform private.record_audit(v_me, 'catalog_batch_approved', null, v_reason, pg_catalog.jsonb_build_object(
    'batch_id', p_batch, 'import_run_id', v_batch.import_run_id, 'content_sha256', v_batch.content_sha256, 'seed', v_batch.seed,
    'items', v_batch.item_count, 'flagged', v_batch.flagged_count, 'sample_size', v_batch.sample_size,
    'acceptance_number', v_batch.acceptance_number, 'sample_incorrect', v_incorrect, 'published', v_published,
    'approvers', (select pg_catalog.jsonb_agg(a.approver_id order by a.approved_at) from private.catalog_review_batch_approvals a where a.batch_id = p_batch)));
  return pg_catalog.jsonb_build_object('status', 'approved', 'published', v_published);
end;
$$;

create or replace function public.publish_game_identity(p_game uuid, p_platforms uuid[], p_reason text, p_expected_revision bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_game public.games;
  v_platform uuid;
  v_pair public.game_platforms;
  v_slug text;
begin
  v_me := private.begin_catalog_edit();
  perform private.require_recent_mfa();                       -- I6
  v_reason := private.require_reason(p_reason);
  if p_expected_revision is null or p_platforms is null or pg_catalog.cardinality(p_platforms) = 0
     or pg_catalog.cardinality(p_platforms) > 20 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select * into v_game from public.games g where g.id = p_game for update;
  if not found or v_game.status not in ('unverified', 'under_review', 'published') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_game.revision <> p_expected_revision then
    raise exception 'record changed' using errcode = 'P0001';
  end if;
  if private.created_by(v_me, null, array[p_game]) then       -- I4
    raise exception 'own record' using errcode = 'P0001';
  end if;
  -- I5: the game's verification attests this revision (a published game is already public).
  if v_game.status <> 'published' and not private.verification_current('game', v_game.id, v_game.revision, v_game.verified_at) then
    raise exception 'game not verified' using errcode = 'P0001';
  end if;
  foreach v_platform in array p_platforms loop
    select * into v_pair from public.game_platforms gp where gp.game_id = p_game and gp.platform_id = v_platform for update;
    if not found or v_pair.status not in ('unverified', 'under_review', 'published') then
      raise exception 'record unavailable' using errcode = 'P0001';
    end if;
    if private.pairing_created_by(v_me, p_game, v_platform) then
      raise exception 'own record' using errcode = 'P0001';
    end if;
    if v_pair.verified_at is null or v_pair.verified_game_revision is distinct from v_game.revision then
      raise exception 'pairing not verified' using errcode = 'P0001';
    end if;
  end loop;

  -- I7: games and pairings only.
  if v_game.status <> 'published' then
    v_slug := coalesce(v_game.slug, private.assign_game_slug(v_game.title));
    update public.games g set status = 'published', slug = v_slug, submitted_by = null where g.id = p_game;
    perform private.record_catalog_audit(v_me, 'catalog_record_published', 'game', p_game, v_reason,
      pg_catalog.jsonb_build_object('slug', v_slug, 'identity', true, 'platforms', p_platforms, 'revision', v_game.revision)
      || private.provenance_note('game', p_game));
  end if;
  update public.game_platforms gp set status = 'published', submitted_by = null
  where gp.game_id = p_game and gp.platform_id = any (p_platforms) and gp.status <> 'published';
  foreach v_platform in array p_platforms loop
    perform private.record_catalog_audit(v_me, 'catalog_record_published', 'game_platform', p_game, v_reason,
      pg_catalog.jsonb_build_object('platform_id', v_platform, 'identity', true));
  end loop;
  return true;
end;
$$;
