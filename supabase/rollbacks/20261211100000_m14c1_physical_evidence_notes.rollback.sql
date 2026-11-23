-- ROLLBACK for 20261211100000_m14c1_physical_evidence_notes.sql (M14c-1).
--
-- Kept outside supabase/migrations. Run as a forward migration in one transaction. Restores
-- require_pairing_basis (B1-M1), record_batch_outcome (B1-M2) and approve_review_batch (M14a)
-- exactly as reviewed, drops the evidence-note check on public.game_platforms, the staff read
-- get_game_pairing_evidence and private.evidence_note_ok. It refuses nothing: every basis and
-- outcome the new rules allow is allowed by the old ones, so no row can violate them. Notes
-- already carried into bases stay there (the key was always allowed).

drop function public.get_game_pairing_evidence(uuid);
alter table public.game_platforms drop constraint game_platforms_physical_evidence_note;

create or replace function private.require_pairing_basis(p_basis jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_basis is null or pg_catalog.jsonb_typeof(p_basis) <> 'object'
     or pg_catalog.jsonb_typeof(p_basis -> 'source') <> 'string' or pg_catalog.char_length(p_basis ->> 'source') not between 1 and 60
     or pg_catalog.jsonb_typeof(p_basis -> 'reference') <> 'string' or pg_catalog.char_length(p_basis ->> 'reference') not between 1 and 300
     or p_basis ->> 'physical_eligibility' is distinct from 'confirmed'
     or (p_basis ? 'snapshot_sha256' and (p_basis ->> 'snapshot_sha256') !~ '^[0-9a-f]{64}$')
     or (p_basis ? 'note' and pg_catalog.char_length(p_basis ->> 'note') > 500)
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_basis) k
                where k not in ('source', 'reference', 'physical_eligibility', 'snapshot_sha256', 'note', 'batch_id')) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  return p_basis;
end;
$$;
create or replace function public.record_batch_outcome(p_batch uuid, p_game uuid, p_outcome text, p_critical_error text, p_note text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_batch private.catalog_review_batches;
  v_item private.catalog_review_batch_items;
  v_note text := nullif(pg_catalog.btrim(p_note), '');
begin
  v_me := private.begin_catalog_edit();
  perform private.require_recent_mfa();                                          -- B13 (finding 3)
  if p_outcome is null or p_outcome not in ('correct', 'incorrect', 'excluded')
     or (p_critical_error is not null and p_outcome = 'correct') or pg_catalog.char_length(coalesce(p_note, '')) > 1000 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select * into v_batch from private.catalog_review_batches b where b.id = p_batch for update;
  if not found or v_batch.status <> 'open' then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_batch.created_by = v_me then
    raise exception 'own record' using errcode = 'P0001';
  end if;
  -- B9: outcomes are final once any approval is recorded, so every approver approves the same findings.
  if exists (select 1 from private.catalog_review_batch_approvals a where a.batch_id = p_batch) then
    raise exception 'batch approval started' using errcode = 'P0001';
  end if;
  select * into v_item from private.catalog_review_batch_items i where i.batch_id = p_batch and i.game_id = p_game for update;
  if not found or not (v_item.sampled or cardinality(v_item.flags) > 0) then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  -- B13 (finding 2): no self-review of a member. The game's creator or submitter (catalog record
  -- origins, which also record submissions), its current submitter, and the pairing's creator.
  if private.created_by(v_me, null, array[p_game])
     or private.pairing_created_by(v_me, p_game, v_item.platform_id)
     or exists (select 1 from public.games g where g.id = p_game and g.submitted_by = v_me)
     or exists (select 1 from public.game_platforms gp where gp.game_id = p_game and gp.platform_id = v_item.platform_id and gp.submitted_by = v_me) then
    raise exception 'own record' using errcode = 'P0001';
  end if;
  -- B17: overriding a critical signal needs recorded evidence.
  if p_outcome = 'correct' and cardinality(v_item.critical_flags) > 0 and pg_catalog.char_length(coalesce(v_note, '')) < 20 then
    raise exception 'evidence required' using errcode = 'P0001';
  end if;
  -- B9: a recorded finding only becomes more conservative. A member found incorrect can still be
  -- excluded, but never changed to correct, and a recorded critical error is never cleared or
  -- replaced. To undo a mistaken finding, reject the batch and review a new one.
  if v_item.outcome is not null
     and not (v_item.outcome = 'incorrect' and p_outcome = 'excluded'
              and (v_item.critical_error is null or v_item.critical_error is not distinct from p_critical_error)) then
    raise exception 'outcome recorded' using errcode = 'P0001';
  end if;
  update private.catalog_review_batch_items i set outcome = p_outcome, critical_error = p_critical_error,
    reviewed_by = v_me, note = v_note, recorded_at = pg_catalog.clock_timestamp()
  where i.batch_id = p_batch and i.game_id = p_game;
  -- The audit log requires a reason: the outcome itself, with the reviewer's note (the evidence) in the metadata.
  perform private.record_audit(v_me, 'catalog_batch_outcome_recorded', null, 'Batch review outcome: ' || p_outcome, pg_catalog.jsonb_build_object(
    'batch_id', p_batch, 'game_id', p_game, 'outcome', p_outcome, 'critical_error', p_critical_error, 'sampled', v_item.sampled,
    'flags', v_item.flags, 'critical_flags', v_item.critical_flags, 'note', v_note));
  return true;
end;
$$;
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
  v_awaiting integer := 0;
  v_independent integer := 0;
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

  -- B7, as amended by M14a: verify the identity of each member reviewed correct, or unflagged
  -- and not sampled. Only a member a person reviewed and found correct has its physical
  -- existence confirmed: its pairing is verified ("confirmed"), recorded as verified by that
  -- reviewer, who confirmed the evidence. It is published only when this approver is someone
  -- else; one the approver reviewed waits for another editor (publish_game_identity, which
  -- refuses whoever verified the pairing). An unsampled member keeps a verified identity,
  -- recorded as batch-accepted, and nothing else: its pairing stays unverified and nothing of it
  -- is published, until an editor confirms its physical existence individually
  -- (verify_game_platform) and another publishes it. A provider listing it is never enough.
  -- B12: every write is conditional on the frozen state; any miss fails the whole approval.
  for v_item in
    select i.game_id, i.platform_id, i.frozen_game_revision, g.title, g.slug, pr.provider_code, pr.external_id, pr.payload_sha256,
           i.outcome = 'correct' as reviewed, i.reviewed_by
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
    -- outcome is null for a member nobody reviewed: "is not true", never "not", which would let null through.
    if v_item.reviewed is not true then
      v_awaiting := v_awaiting + 1;
      continue;
    end if;
    update public.game_platforms gp set verified_at = pg_catalog.clock_timestamp(), verified_by = v_item.reviewed_by,
      verified_game_revision = v_item.frozen_game_revision,
      verification_basis = pg_catalog.jsonb_build_object('source', v_item.provider_code, 'reference', v_item.external_id,
        'snapshot_sha256', v_item.payload_sha256,
        'physical_eligibility', 'confirmed', 'batch_id', p_batch::text)
    where gp.game_id = v_item.game_id and gp.platform_id = v_item.platform_id and gp.status in ('unverified', 'under_review');
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'batch stale' using errcode = 'P0001';
    end if;
    perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'game_platform', v_item.game_id, v_reason,
      pg_catalog.jsonb_build_object('platform_id', v_item.platform_id, 'batch_id', p_batch, 'acceptance', 'individually_reviewed',
        'confirmed_by', v_item.reviewed_by));
    -- Separation of duties: whoever confirmed the evidence never publishes it.
    if v_item.reviewed_by is null or v_item.reviewed_by = v_me then
      v_independent := v_independent + 1;
      continue;
    end if;
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
    'acceptance_number', v_batch.acceptance_number, 'sample_incorrect', v_incorrect, 'published', v_published, 'awaiting_physical_evidence', v_awaiting,
    'awaiting_independent_publication', v_independent,
    'approvers', (select pg_catalog.jsonb_agg(a.approver_id order by a.approved_at) from private.catalog_review_batch_approvals a where a.batch_id = p_batch)));
  return pg_catalog.jsonb_build_object('status', 'approved', 'published', v_published, 'awaiting_physical_evidence', v_awaiting,
    'awaiting_independent_publication', v_independent);
end;
$$;
drop function private.evidence_note_ok(text);
