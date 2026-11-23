-- M14c-1: physical-evidence notes are mandatory, carried into the pairing's basis, and visible
-- to catalog staff.
--
-- M14a made confirmed physical existence the only way a game is public without a published
-- release, and kept whoever confirms it from publishing it. But the evidence itself was optional
-- free text: a batch member found correct could carry no note at all, approval stored only the
-- provider record it came from (a Wikidata listing is not evidence of a physical release), and no
-- staff page showed what a pairing's verification rests on. This migration:
--
-- 1. Adds private.evidence_note_ok: a note is evidence when, with surrounding and repeated
--    whitespace collapsed, it has at least 20 characters, of which at least 10 are letters or
--    digits (no padding with spaces or punctuation), and at most 500 (the basis's limit).
-- 2. Replaces private.require_pairing_basis (verify_game_platform's check): the basis must carry
--    such a note. Its other rules are unchanged: source, reference, physical_eligibility
--    "confirmed", optional snapshot_sha256 and batch_id, and nothing else.
-- 3. Replaces public.record_batch_outcome (same signature and grants): a "correct" outcome needs
--    such a note, not only one that overrides a critical signal (B17), and at most 500
--    characters. "incorrect" and "excluded" keep their rules: optional notes up to 1,000.
-- 4. Replaces public.approve_review_batch (same signature, grants and every B1 and M14a rule):
--    it refuses while any member found correct lacks such a note ("evidence required"), and
--    carries the reviewer's note into the pairing's basis, beside the record they checked. The
--    pairing's audit row records the whole basis, as verify_game_platform's does.
-- 5. Adds a check on public.game_platforms: a verification basis always carries such a note,
--    whichever path wrote it. No database has a verified pairing yet (checked 2026-11-23 on
--    development, the test stack and B1), so it is validated now; a database with one fails
--    here, loudly, and that pairing has to be verified again with evidence.
-- 6. Adds public.get_game_pairing_evidence, read-only, for catalog editors and administrators
--    with a verified session: each of a game's pairings, its physical-evidence state, basis,
--    verifier's handle, review batches, releases, and whether its identity can be published now.
--
-- Unchanged: who may verify, approve or publish (MFA, revision, no self-review, separation of
-- duties), the publication invariant, and physical releases, which keep their own verification.
-- Outcomes recorded before this migration keep their notes; one found correct without evidence
-- can't be approved (the open B1 batch has two: that batch would be rejected and reviewed again).
-- Rollback: supabase/rollbacks/20261211100000_m14c1_physical_evidence_notes.rollback.sql.

-- 1. What counts as an evidence note.
create function private.evidence_note_ok(p_note text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_note is not null
     and pg_catalog.char_length(p_note) <= 500
     and pg_catalog.char_length(pg_catalog.regexp_replace(pg_catalog.regexp_replace(p_note, '^\s+|\s+$', '', 'g'), '\s+', ' ', 'g')) >= 20
     and pg_catalog.char_length(pg_catalog.regexp_replace(p_note, '[^[:alnum:]]', '', 'g')) >= 10
$$;
-- Owner only, like every private helper. The table check below calls it, and PostgreSQL checks
-- EXECUTE on a check's functions for whoever writes the row: every write to game_platforms is by
-- its owner (SECURITY DEFINER functions, foreign-key actions, migrations). A future write path
-- running as another role would need EXECUTE granted here first.
revoke all on function private.evidence_note_ok(text) from public, anon, authenticated, service_role;

-- 2. The individual path's basis.
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
     -- M14c-1: the editor's own account of the physical evidence they checked, always.
     or pg_catalog.jsonb_typeof(p_basis -> 'note') is distinct from 'string' or not private.evidence_note_ok(p_basis ->> 'note')
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_basis) k
                where k not in ('source', 'reference', 'physical_eligibility', 'snapshot_sha256', 'note', 'batch_id')) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  return p_basis;
end;
$$;
-- 3. Batch outcomes: a member found correct carries its reviewer's evidence.
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
     or (p_critical_error is not null and p_outcome = 'correct') or pg_catalog.char_length(coalesce(p_note, '')) > 1000
     -- M14c-1: a correct outcome's note becomes the pairing's evidence note, which holds 500.
     or (p_outcome = 'correct' and pg_catalog.char_length(coalesce(v_note, '')) > 500) then
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
  -- B17, widened by M14c-1: a member found correct needs the reviewer's own evidence of its
  -- physical existence (what they checked, and where), whether or not it overrides a critical
  -- signal. Its note is carried into the pairing's verification basis at approval.
  if p_outcome = 'correct' and not private.evidence_note_ok(v_note) then
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
-- 4. Batch approval: every confirmed pairing carries its reviewer's evidence note.
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
  v_basis jsonb;
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
  -- M14c-1: every member found correct carries its reviewer's evidence note, which becomes its
  -- pairing's. An outcome recorded before the rule, without one, holds the whole approval.
  if exists (select 1 from private.catalog_review_batch_items i
             where i.batch_id = p_batch and i.outcome = 'correct' and not private.evidence_note_ok(i.note)) then
    raise exception 'evidence required' using errcode = 'P0001';
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
           i.outcome = 'correct' as reviewed, i.reviewed_by, i.note
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
    -- M14c-1: source and reference name the record the reviewer checked; the note is their
    -- evidence of physical existence. A provider listing alone is never the evidence.
    v_basis := pg_catalog.jsonb_build_object('source', v_item.provider_code, 'reference', v_item.external_id,
        'snapshot_sha256', v_item.payload_sha256,
        'physical_eligibility', 'confirmed', 'batch_id', p_batch::text, 'note', v_item.note);
    update public.game_platforms gp set verified_at = pg_catalog.clock_timestamp(), verified_by = v_item.reviewed_by,
      verified_game_revision = v_item.frozen_game_revision,
      verification_basis = v_basis
    where gp.game_id = v_item.game_id and gp.platform_id = v_item.platform_id and gp.status in ('unverified', 'under_review');
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'batch stale' using errcode = 'P0001';
    end if;
    perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'game_platform', v_item.game_id, v_reason,
      pg_catalog.jsonb_build_object('platform_id', v_item.platform_id, 'batch_id', p_batch, 'acceptance', 'individually_reviewed',
        'confirmed_by', v_item.reviewed_by, 'basis', v_basis));
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
-- 5. Every verification basis carries an evidence note, whichever path wrote it.
alter table public.game_platforms
  add constraint game_platforms_physical_evidence_note
  check (verification_basis is null
         or (pg_catalog.jsonb_typeof(verification_basis -> 'note') = 'string' and private.evidence_note_ok(verification_basis ->> 'note')) is true);

-- 6. What staff see: each pairing's physical evidence, read-only.
--
-- state:  unconfirmed             in review, physical existence not confirmed
--         confirmed               in review, physical existence confirmed (not public yet)
--         published_identity      public, with no published (verified) release on the platform
--         published_with_release  public, with at least one published, verified release
--         closed                  excluded, rejected or merged: not public, not in review
-- publication.eligible says whether publish_game_identity would accept the record as it stands
-- (the same conditions, in the same order); you_may_publish adds the caller's own rules. Neither
-- includes the authenticator check publish_game_identity also makes at the time (recent MFA).
create function public.get_game_pairing_evidence(p_game uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  g public.games;
  v_game_current boolean;
  v_you_created boolean;
begin
  v_me := private.require_active_staff('catalog_editor');
  select * into g from public.games x where x.id = p_game;
  if not found then
    return null;
  end if;
  v_game_current := g.verified_at is not null and private.verification_current('game', g.id, g.revision, g.verified_at);
  v_you_created := private.created_by(v_me, null, array[g.id]);
  return pg_catalog.jsonb_build_object(
    'game', pg_catalog.jsonb_build_object('id', g.id, 'status', g.status, 'revision', g.revision, 'identity_verified', v_game_current),
    'pairings', (select coalesce(pg_catalog.jsonb_agg(x.j order by x.name, x.slug), '[]') from (
      select p.name, p.slug, pg_catalog.jsonb_build_object(
        'platform', pg_catalog.jsonb_build_object('slug', p.slug, 'name', p.name, 'short_name', p.short_name),
        'status', gp.status,
        'state', case
          when gp.status = 'published' and rel.published > 0 then 'published_with_release'
          when gp.status = 'published' then 'published_identity'
          when gp.status in ('unverified', 'under_review') and gp.verification_basis is not null and gp.verified_at is not null then 'confirmed'
          when gp.status in ('unverified', 'under_review') then 'unconfirmed'
          else 'closed' end,
        'physical', case when gp.verification_basis is null or gp.verified_at is null then null else pg_catalog.jsonb_build_object(
          'source', gp.verification_basis ->> 'source',
          'reference', gp.verification_basis ->> 'reference',
          'note', gp.verification_basis ->> 'note',
          'snapshot_sha256', gp.verification_basis ->> 'snapshot_sha256',
          'batch_id', gp.verification_basis ->> 'batch_id',
          'verified_at', gp.verified_at,
          'verified_game_revision', gp.verified_game_revision,
          'current', gp.verified_game_revision is not distinct from g.revision,
          -- A handle only, as staff history shows it; null once the account is gone.
          'verifier', pg_catalog.jsonb_build_object(
            'handle', (select pr.handle from public.profiles pr where pr.id = gp.verified_by),
            'you', coalesce(gp.verified_by = v_me, false))) end,
        'releases', pg_catalog.jsonb_build_object('total', rel.total, 'published', rel.published),
        'batches', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'id', b.id, 'status', b.status, 'created_at', b.created_at, 'decided_at', b.decided_at,
                        'sampled', i.sampled, 'flagged', pg_catalog.cardinality(i.flags) > 0,
                        'outcome', i.outcome, 'recorded_at', i.recorded_at) order by b.created_at desc), '[]')
                    from private.catalog_review_batch_items i join private.catalog_review_batches b on b.id = i.batch_id
                    where i.game_id = gp.game_id and i.platform_id = gp.platform_id),
        'publication', pub.j) as j
      from public.game_platforms gp
      join public.platforms p on p.id = gp.platform_id
      cross join lateral (
        select count(*) as total, count(*) filter (where r.status = 'published' and r.verified_at is not null) as published
        from public.releases r where r.game_id = gp.game_id and r.platform_id = gp.platform_id) rel
      cross join lateral (
        select case
          when gp.status = 'published' then 'published'
          when g.status not in ('unverified', 'under_review', 'published') then 'game_unavailable'
          when gp.status not in ('unverified', 'under_review') then 'pairing_unavailable'
          when g.status <> 'published' and not v_game_current then 'game_not_verified'
          when gp.verified_at is null or gp.verification_basis is null then 'physical_evidence_unconfirmed'
          when gp.verified_by is null then 'verifier_gone'
          when gp.verified_game_revision is distinct from g.revision then 'evidence_outdated'
          end as reason) why
      cross join lateral (
        select pg_catalog.jsonb_build_object(
          'eligible', why.reason is null,
          'reason', why.reason,
          'you_may_publish', coalesce(why.reason is null and gp.verified_by <> v_me and not v_you_created
                             and not private.pairing_created_by(v_me, gp.game_id, gp.platform_id), false),
          'your_reason', case
            when why.reason is not null then null
            when gp.verified_by = v_me then 'you_confirmed'
            when v_you_created or private.pairing_created_by(v_me, gp.game_id, gp.platform_id) then 'you_created' end) as j) pub
      where gp.game_id = g.id) x));
end;
$$;
revoke all on function public.get_game_pairing_evidence(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_game_pairing_evidence(uuid) to authenticated;
