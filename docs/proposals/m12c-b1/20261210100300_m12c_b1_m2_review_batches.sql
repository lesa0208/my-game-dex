-- PROPOSAL (M12c-B1, B1-M2, part 2): not a migration until reviewed and moved to supabase/migrations.
--
-- Frozen review batches for game identities: risk-based validation, reproducible sampling,
-- explicit human approval and audit history. Requires B1-M1 (pairing verification and
-- identity publication) and part 1 (audit actions).
--
-- Invariants (tested in 50_b1_review_batches.test.sql):
--   B1  Membership is frozen at creation: items can't be added, removed or changed after the
--       creating transaction, except the outcome fields while the batch is open.
--   B2  The sample is reproducible: the seed is drawn after the content is frozen, and the
--       sample is the unflagged members in sha256(seed || game id) order. The sample size is
--       computed in the database for the batch's actual unflagged count (hypergeometric).
--   B3  Every flagged and every sampled member has a human outcome before approval.
--   B4  Approval is refused: by the batch's creator; by anyone who created one of its games
--       or pairings; without recent MFA; if the sample's incorrect count exceeds the acceptance
--       number; if any critical error is unresolved; if a sampled (unflagged) member has a
--       critical error (the validators missed one: reject, fix, re-batch); if any member's
--       revision changed after freezing, or its game or pairing left review (B10).
--   B5  A rejected batch is never reopened or resampled. Its members can join a new batch with
--       a new seed. No automatic acceptance ever follows a failed sample.
--   B6  Batches above the policy's size need a second, different approver (A-4); the pilot
--       needs one.
--   B7  Approval publishes identities only: games and their pairings. It never creates,
--       verifies or publishes a release.
--   B8  Every step writes an audit row naming the editor, the batch, its content hash, source
--       run, seed, sample, findings and decision. Audit rows are never edited.
--   B9  Findings only become more conservative: a recorded outcome changes only from incorrect
--       to excluded, a recorded critical error is never cleared, and nothing changes once an
--       approval is recorded. A sampled member that isn't correct (incorrect or excluded) is a
--       sample error.
--   B10 Members are only records still in review: a withdrawn (excluded) or rejected pairing
--       never joins a batch, and a member whose game or pairing left review makes it stale.
--   B11 Each published pairing's provenance is its frozen source record (provider, id, payload
--       hash). Physical eligibility is "confirmed" only for a member a person found correct;
--       an unsampled member is "batch_accepted".
--
-- RLS: the tables are in the private schema with no client grants; editors act only through
-- the SECURITY DEFINER functions below, which check the caller.
--
-- Rollback: revoke execute on the five functions (a forward migration). The tables stay as
-- review history; nothing that was published is unpublished.

-- 1. Policy (one row).
create table private.catalog_review_policy (
  id boolean primary key default true check (id),
  tolerable_error numeric not null default 0.02 check (tolerable_error > 0 and tolerable_error < 0.5),
  confidence numeric not null default 0.95 check (confidence >= 0.8 and confidence < 1),
  acceptance_number integer not null default 0 check (acceptance_number between 0 and 5),
  second_approval_above integer not null default 1000 check (second_approval_above > 0),
  updated_at timestamptz not null default now()
);
insert into private.catalog_review_policy default values;

-- 2. Batches, items and approvals.
create table private.catalog_review_batches (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references private.import_runs (id) on delete restrict,
  platform_id uuid not null references public.platforms (id) on delete restrict,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  reason text not null check (char_length(reason) between 1 and 500),
  item_count integer not null check (item_count between 1 and 5000),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  seed uuid not null,
  flagged_count integer not null check (flagged_count >= 0),
  sample_size integer not null check (sample_size >= 0),
  acceptance_number integer not null check (acceptance_number >= 0),
  tolerable_error numeric not null,
  confidence numeric not null,
  required_approvals integer not null check (required_approvals between 1 and 2),
  status text not null default 'open' check (status in ('open', 'approved', 'rejected')),
  decided_at timestamptz,
  decision_reason text check (char_length(decision_reason) between 1 and 500),
  check ((status = 'open') = (decided_at is null)),
  check ((status = 'open') = (decision_reason is null))
);

create table private.catalog_review_batch_items (
  batch_id uuid not null references private.catalog_review_batches (id) on delete restrict,
  game_id uuid not null references public.games (id) on delete restrict,
  platform_id uuid not null,
  provider_record_id uuid references private.provider_records (id) on delete restrict,
  frozen_game_revision bigint not null,
  flags text[] not null default '{}',
  critical_flags text[] not null default '{}',
  sampled boolean not null default false,
  outcome text check (outcome in ('correct', 'incorrect', 'excluded')),
  critical_error text check (critical_error in ('wrong_identity_or_type', 'wrong_platform', 'physical_eligibility_unsupported',
    'distinct_games_merged', 'conflicting_duplicate_identities', 'conflicting_identifiers', 'missing_provenance')),
  reviewed_by uuid references public.profiles (id) on delete set null,
  note text check (char_length(note) <= 1000),
  recorded_at timestamptz,
  primary key (batch_id, game_id),
  check ((outcome is null) = (recorded_at is null)),
  check (critical_error is null or outcome in ('incorrect', 'excluded')),
  check (not (sampled and cardinality(flags) > 0))
);
create index catalog_review_batch_items_game_idx on private.catalog_review_batch_items (game_id);

create table private.catalog_review_batch_approvals (
  batch_id uuid not null references private.catalog_review_batches (id) on delete restrict,
  approver_id uuid not null references public.profiles (id) on delete restrict,
  approved_at timestamptz not null default now(),
  reason text not null check (char_length(reason) between 1 and 500),
  primary key (batch_id, approver_id)
);

revoke all on private.catalog_review_policy, private.catalog_review_batches, private.catalog_review_batch_items,
  private.catalog_review_batch_approvals from public, anon, authenticated, service_role;

-- 3. Immutability (B1, B5, B8).
create function private.guard_review_batch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'review batches are kept' using errcode = 'check_violation';
  end if;
  if old.status <> 'open' then
    raise exception 'a decided batch can''t change' using errcode = 'check_violation';
  end if;
  if (pg_catalog.to_jsonb(new) - array['status', 'decided_at', 'decision_reason'])
     is distinct from (pg_catalog.to_jsonb(old) - array['status', 'decided_at', 'decision_reason']) then
    raise exception 'a batch''s content is frozen' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger guard_review_batch before update or delete on private.catalog_review_batches
  for each row execute function private.guard_review_batch();

create function private.guard_review_batch_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_batch private.catalog_review_batches;
begin
  if tg_op = 'DELETE' then
    raise exception 'review batches are kept' using errcode = 'check_violation';
  end if;
  select * into v_batch from private.catalog_review_batches b where b.id = new.batch_id;
  if tg_op = 'INSERT' then
    -- Members are added only in the transaction that creates the batch.
    if v_batch.created_at <> pg_catalog.now() then
      raise exception 'a batch''s membership is frozen' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if v_batch.status <> 'open' then
    raise exception 'a decided batch can''t change' using errcode = 'check_violation';
  end if;
  if (pg_catalog.to_jsonb(new) - array['outcome', 'critical_error', 'reviewed_by', 'note', 'recorded_at'])
     is distinct from (pg_catalog.to_jsonb(old) - array['outcome', 'critical_error', 'reviewed_by', 'note', 'recorded_at']) then
    raise exception 'a batch''s membership is frozen' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger guard_review_batch_item before insert or update or delete on private.catalog_review_batch_items
  for each row execute function private.guard_review_batch_item();

create function private.guard_review_batch_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'approvals are kept as recorded' using errcode = 'check_violation';
end;
$$;
create trigger guard_review_batch_approval before update or delete on private.catalog_review_batch_approvals
  for each row execute function private.guard_review_batch_approval();

-- 4. The sample size for the actual lot (B2): the smallest n such that a lot of p_lot items
-- with ceil(p_tolerable * p_lot) errors gives at most p_c errors in the sample with
-- probability at most 1 - p_confidence (hypergeometric, exact). The whole lot (a census)
-- when no smaller n does.
create function private.ln_choose(p_n integer, p_k integer)
returns double precision
language plpgsql
immutable
set search_path = ''
as $$
declare
  v double precision := 0;
  i integer;
begin
  if p_k < 0 or p_k > p_n then
    return '-Infinity';
  end if;
  for i in 1 .. least(p_k, p_n - p_k) loop
    v := v + pg_catalog.ln((p_n - least(p_k, p_n - p_k) + i)::double precision / i);
  end loop;
  return v;
end;
$$;

create function private.hypergeometric_cdf(p_c integer, p_n integer, p_lot integer, p_defects integer)
returns double precision
language plpgsql
immutable
set search_path = ''
as $$
declare
  v double precision := 0;
  k integer;
  v_total double precision := private.ln_choose(p_lot, p_n);
begin
  for k in 0 .. p_c loop
    if k <= p_defects and p_n - k <= p_lot - p_defects and p_n - k >= 0 then
      v := v + pg_catalog.exp(private.ln_choose(p_defects, k) + private.ln_choose(p_lot - p_defects, p_n - k) - v_total);
    end if;
  end loop;
  return v;
end;
$$;

create function private.review_sample_size(p_lot integer, p_tolerable numeric, p_confidence numeric, p_c integer)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_defects integer;
  v_lo integer := 0;
  v_hi integer := p_lot;
  v_mid integer;
begin
  if p_lot is null or p_lot <= 0 then
    return 0;
  end if;
  v_defects := greatest(1, pg_catalog.ceil(p_tolerable * p_lot)::integer);
  -- The acceptance probability falls as n grows; find the first n at or below 1 - confidence.
  while v_lo < v_hi loop
    v_mid := (v_lo + v_hi) / 2;
    if private.hypergeometric_cdf(p_c, v_mid, p_lot, v_defects) <= 1 - p_confidence then
      v_hi := v_mid;
    else
      v_lo := v_mid + 1;
    end if;
  end loop;
  return v_lo;
end;
$$;

revoke all on function private.guard_review_batch(), private.guard_review_batch_item(), private.guard_review_batch_approval(),
  private.ln_choose(integer, integer), private.hypergeometric_cdf(integer, integer, integer, integer),
  private.review_sample_size(integer, numeric, numeric, integer) from public, anon, authenticated, service_role;

-- 5. Flags that may point to a critical error (checkpoint two § 4). They come from the source
-- record (the importer stores the parser's flags as payload.review_flags) and from checks here.
create function private.review_critical_signal(p_flag text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_flag
    when 'entity_detail_pending' then 'missing_provenance'
    when 'title_collision_in_batch' then 'conflicting_duplicate_identities'
    when 'external_id_shared_in_batch' then 'conflicting_identifiers'
    when 'catalog_title_match_same_platform' then 'conflicting_duplicate_identities'
    when 'other_instance_of' then 'wrong_identity_or_type'
    when 'platform_date_before_launch' then 'wrong_platform'
    when 'platform_date_after_era' then 'physical_eligibility_unsupported'
    when 'distribution_format_unclassified' then 'physical_eligibility_unsupported'
    when 'distribution_non_physical' then 'physical_eligibility_unsupported'
  end
$$;
revoke all on function private.review_critical_signal(text) from public, anon, authenticated, service_role;

-- 6. Editor functions.
create function public.create_review_batch(p_run uuid, p_platform uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_policy private.catalog_review_policy;
  v_batch uuid := gen_random_uuid();
  v_seed uuid;
  v_count integer;
  v_flagged integer;
  v_sample integer;
  v_hash text;
begin
  v_me := private.begin_catalog_edit();
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  select * into v_policy from private.catalog_review_policy;
  if not exists (select 1 from private.import_runs r where r.id = p_run)
     or not exists (select 1 from public.platforms p where p.id = p_platform) then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;

  -- The run's game candidates on the platform: unpublished, unverified, paired with the
  -- platform, and not in another open batch. One row per game, with its source record.
  -- (Working tables of this call only: dropped first, so two batches in one transaction work.)
  drop table if exists pg_temp.b1_members;
  drop table if exists pg_temp.b1_flags;
  create temp table b1_members on commit drop as
  select distinct on (g.id) g.id as game_id, g.revision, pr.id as provider_record_id, pr.payload, g.search_key,
         g.first_release_date, g.first_release_precision
  from private.import_run_records rr
  join private.provider_records pr on pr.id = rr.provider_record_id
  join public.games g on g.id = pr.matched_game_id
  join public.game_platforms gp on gp.game_id = g.id and gp.platform_id = p_platform
  where rr.import_run_id = p_run and pr.entity_type = 'game'
    -- Only records still in review: a withdrawn (excluded) or rejected pairing never joins.
    and g.status in ('unverified', 'under_review') and g.verified_at is null and gp.status in ('unverified', 'under_review')
    and not exists (select 1 from private.catalog_review_batch_items i join private.catalog_review_batches b on b.id = i.batch_id
                    where i.game_id = g.id and b.status = 'open')
  order by g.id, pr.created_at desc;
  select count(*) into v_count from b1_members;
  if v_count = 0 or v_count > 5000 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;

  -- B1: the content and its hash, frozen before the seed exists.
  select pg_catalog.encode(extensions.digest(pg_catalog.string_agg(m.game_id::text || ':' || m.revision::text, ',' order by m.game_id), 'sha256'), 'hex')
  into v_hash from b1_members m;

  -- Flags: the source record's, and checks here (dates, title collisions in the batch and with
  -- the catalog on the platform).
  create temp table b1_flags on commit drop as
  select m.game_id,
         array(select distinct f from (
           select pg_catalog.jsonb_array_elements_text(case when pg_catalog.jsonb_typeof(m.payload -> 'review_flags') = 'array' then m.payload -> 'review_flags' else '[]' end) as f
           union all select 'entity_detail_pending' where m.payload -> 'source' is null
           union all select 'no_release_date' where m.first_release_date is null
           union all select 'year_precision_only' where m.first_release_precision = 'year'
           union all select 'title_collision_in_batch' where exists (select 1 from b1_members o where o.game_id <> m.game_id and o.search_key = m.search_key)
           union all select 'catalog_title_match_same_platform' where exists (
             select 1 from public.games c join public.game_platforms cp on cp.game_id = c.id and cp.platform_id = p_platform
             where c.id <> m.game_id and c.search_key = m.search_key and c.status not in ('merged', 'rejected', 'excluded')
               and not exists (select 1 from b1_members o where o.game_id = c.id))
         ) x where f is not null order by f) as flags
  from b1_members m;
  select count(*) into v_flagged from b1_flags f where cardinality(f.flags) > 0;

  v_sample := private.review_sample_size(v_count - v_flagged, v_policy.tolerable_error, v_policy.confidence, v_policy.acceptance_number);
  v_seed := gen_random_uuid();   -- B2: drawn after the content is frozen.

  insert into private.catalog_review_batches (id, import_run_id, platform_id, created_by, reason, item_count, content_sha256, seed,
    flagged_count, sample_size, acceptance_number, tolerable_error, confidence, required_approvals)
  values (v_batch, p_run, p_platform, v_me, v_reason, v_count, v_hash, v_seed, v_flagged, v_sample, v_policy.acceptance_number,
    v_policy.tolerable_error, v_policy.confidence, case when v_count > v_policy.second_approval_above then 2 else 1 end);

  insert into private.catalog_review_batch_items (batch_id, game_id, platform_id, provider_record_id, frozen_game_revision, flags, critical_flags, sampled)
  select v_batch, m.game_id, p_platform, m.provider_record_id, m.revision, f.flags,
         array(select distinct s from (select private.review_critical_signal(x) as s from pg_catalog.unnest(f.flags) x) y where s is not null order by s),
         cardinality(f.flags) = 0 and m.game_id in (
           select u.game_id from b1_members u join b1_flags uf on uf.game_id = u.game_id
           where cardinality(uf.flags) = 0
           order by pg_catalog.encode(extensions.digest(v_seed::text || u.game_id::text, 'sha256'), 'hex')
           limit v_sample)
  from b1_members m join b1_flags f on f.game_id = m.game_id;

  perform private.record_audit(v_me, 'catalog_batch_created', null, v_reason, pg_catalog.jsonb_build_object(
    'batch_id', v_batch, 'import_run_id', p_run, 'platform_id', p_platform, 'items', v_count, 'flagged', v_flagged,
    'sample_size', v_sample, 'acceptance_number', v_policy.acceptance_number, 'tolerable_error', v_policy.tolerable_error,
    'confidence', v_policy.confidence, 'content_sha256', v_hash, 'seed', v_seed));
  return v_batch;
end;
$$;

create function public.record_batch_outcome(p_batch uuid, p_game uuid, p_outcome text, p_critical_error text, p_note text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_batch private.catalog_review_batches;
  v_item private.catalog_review_batch_items;
begin
  v_me := private.begin_catalog_edit();
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
  -- B9: a recorded finding only becomes more conservative. A member found incorrect can still be
  -- excluded, but never changed to correct, and a recorded critical error is never cleared or
  -- replaced. To undo a mistaken finding, reject the batch and review a new one.
  if v_item.outcome is not null
     and not (v_item.outcome = 'incorrect' and p_outcome = 'excluded'
              and (v_item.critical_error is null or v_item.critical_error is not distinct from p_critical_error)) then
    raise exception 'outcome recorded' using errcode = 'P0001';
  end if;
  update private.catalog_review_batch_items i set outcome = p_outcome, critical_error = p_critical_error,
    reviewed_by = v_me, note = nullif(pg_catalog.btrim(p_note), ''), recorded_at = pg_catalog.clock_timestamp()
  where i.batch_id = p_batch and i.game_id = p_game;
  -- The audit log requires a reason: the outcome itself, with the reviewer's note in the metadata.
  perform private.record_audit(v_me, 'catalog_batch_outcome_recorded', null, 'Batch review outcome: ' || p_outcome, pg_catalog.jsonb_build_object(
    'batch_id', p_batch, 'game_id', p_game, 'outcome', p_outcome, 'critical_error', p_critical_error, 'sampled', v_item.sampled,
    'flags', v_item.flags, 'note', nullif(pg_catalog.btrim(p_note), '')));
  return true;
end;
$$;

create function public.approve_review_batch(p_batch uuid, p_reason text)
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
  v_published integer := 0;
  v_slug text;
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
     or exists (select 1 from private.catalog_review_batch_items i where i.batch_id = p_batch and private.pairing_created_by(v_me, i.game_id, i.platform_id)) then
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
  for v_item in
    select i.game_id, i.platform_id, g.title, g.slug, g.revision, pr.provider_code, pr.external_id, pr.payload_sha256,
           i.outcome = 'correct' as reviewed
    from private.catalog_review_batch_items i
    join public.games g on g.id = i.game_id
    join private.provider_records pr on pr.id = i.provider_record_id
    where i.batch_id = p_batch and (i.outcome = 'correct' or (i.outcome is null and cardinality(i.flags) = 0 and not i.sampled))
    order by i.game_id
  loop
    update public.games g set verified_at = pg_catalog.clock_timestamp(), verified_by = v_me where g.id = v_item.game_id;
    perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'game', v_item.game_id, v_reason,
      pg_catalog.jsonb_build_object('revision', v_item.revision, 'batch_id', p_batch));
    update public.game_platforms gp set verified_at = pg_catalog.clock_timestamp(), verified_by = v_me,
      verified_game_revision = v_item.revision,
      verification_basis = pg_catalog.jsonb_build_object('source', v_item.provider_code, 'reference', v_item.external_id,
        'snapshot_sha256', v_item.payload_sha256,
        'physical_eligibility', case when v_item.reviewed then 'confirmed' else 'batch_accepted' end, 'batch_id', p_batch::text)
    where gp.game_id = v_item.game_id and gp.platform_id = v_item.platform_id;
    perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'game_platform', v_item.game_id, v_reason,
      pg_catalog.jsonb_build_object('platform_id', v_item.platform_id, 'batch_id', p_batch));
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

create function public.reject_review_batch(p_batch uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_batch private.catalog_review_batches;
begin
  v_me := private.begin_catalog_edit();
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  select * into v_batch from private.catalog_review_batches b where b.id = p_batch for update;
  if not found or v_batch.status <> 'open' then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  update private.catalog_review_batches b set status = 'rejected', decided_at = pg_catalog.now(), decision_reason = v_reason
  where b.id = p_batch;
  perform private.record_audit(v_me, 'catalog_batch_rejected', null, v_reason, pg_catalog.jsonb_build_object(
    'batch_id', p_batch, 'content_sha256', v_batch.content_sha256, 'seed', v_batch.seed,
    'outcomes', (select pg_catalog.jsonb_object_agg(coalesce(i.outcome, 'pending'), n) from (
      select i.outcome, count(*) as n from private.catalog_review_batch_items i where i.batch_id = p_batch group by i.outcome) i)));
  return true;
end;
$$;

create function public.get_review_batch(p_batch uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_staff('catalog_editor');
  return (
    select pg_catalog.jsonb_build_object(
      'id', b.id, 'status', b.status, 'items', b.item_count, 'flagged', b.flagged_count, 'sample_size', b.sample_size,
      'acceptance_number', b.acceptance_number, 'tolerable_error', b.tolerable_error, 'confidence', b.confidence,
      'required_approvals', b.required_approvals, 'content_sha256', b.content_sha256, 'seed', b.seed, 'created_at', b.created_at,
      'members', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'game_id', i.game_id, 'title', g.title, 'flags', i.flags, 'critical_flags', i.critical_flags, 'sampled', i.sampled,
          'outcome', i.outcome, 'critical_error', i.critical_error) order by g.title, i.game_id), '[]')
        from private.catalog_review_batch_items i join public.games g on g.id = i.game_id where i.batch_id = b.id))
    from private.catalog_review_batches b where b.id = p_batch);
end;
$$;

revoke all on function public.create_review_batch(uuid, uuid, text), public.record_batch_outcome(uuid, uuid, text, text, text),
  public.approve_review_batch(uuid, text), public.reject_review_batch(uuid, text), public.get_review_batch(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_review_batch(uuid, uuid, text), public.record_batch_outcome(uuid, uuid, text, text, text),
  public.approve_review_batch(uuid, text), public.reject_review_batch(uuid, text), public.get_review_batch(uuid)
  to authenticated;
