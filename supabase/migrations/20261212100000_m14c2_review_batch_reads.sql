-- M14c-2: review batches, read by catalog staff in the admin panel.
--
-- B1-M2's get_review_batch returns a batch with every member at once and no provenance. The
-- review pages need bounded, paginated reads that also say what the database would refuse, so
-- the page never works it out from counts. This migration adds, read-only, for catalog editors
-- and administrators with a verified session (require_active_staff('catalog_editor')):
--
-- 1. public.list_review_batches: one page of batches, newest first, by status and platform.
-- 2. public.get_review_batch_overview: one batch's provenance, sampling, progress, member counts
--    by review category, and its approval blockers, assessed here in approve_review_batch's own
--    order, plus what the caller may not do (review or approve) and why.
-- 3. public.list_review_batch_members: one page of a batch's members, by category or progress,
--    in a fixed order (critical, flagged, sampled, then unsampled; the source record's title; id),
--    all frozen with the batch, so neither a review nor an edit moves a member while someone pages.
-- 4. public.get_review_batch_member: one member's review context: its game and pairing, the
--    source record's allow-listed fields (never the raw payload), possible duplicates and
--    conflicts, other batches it was in, its outcome trail, and whether the caller may record
--    an outcome now, in record_batch_outcome's own order.
--
-- Nothing here writes, and nothing changes who may record, approve, reject or publish:
-- record_batch_outcome and approve_review_batch still decide, with MFA, revision and
-- independence checks of their own. The assessments leave out what those functions check at the
-- time of the call (a recent authenticator check, and the row locks approval takes), and say so.
--
-- People appear by handle only ("you" for the caller), as staff history shows them; never an
-- email address or an account id. Source metadata is allow-listed and bounded: strings of fixed
-- shape and length, a few per field. Rollback: supabase/rollbacks/20261212100000_m14c2_review_batch_reads.rollback.sql.

create index catalog_review_batches_created_idx on private.catalog_review_batches (created_at desc, id desc);

-- A member's review category, from frozen fields only: 0 critical (flagged, with a critical
-- signal), 1 flagged, 2 sampled, 3 unsampled (accepted with the batch, never reviewed).
create function private.review_member_rank(p_sampled boolean, p_flags text[], p_critical text[])
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when pg_catalog.cardinality(p_critical) > 0 then 0
    when pg_catalog.cardinality(p_flags) > 0 then 1
    when p_sampled then 2
    else 3 end
$$;

-- Up to p_limit strings from a JSON array, each matching p_pattern (a whole-string pattern)
-- and at most p_max characters. Anything else is left out, never shown raw.
create function private.json_safe_strings(p_value jsonb, p_pattern text, p_max integer, p_limit integer)
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(v order by n), '[]'::jsonb)
  from (
    select e #>> '{}' as v, n
    from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(p_value) = 'array' then p_value else '[]'::jsonb end) with ordinality as x(e, n)
    where pg_catalog.jsonb_typeof(e) = 'string' and pg_catalog.char_length(e #>> '{}') between 1 and p_max and (e #>> '{}') ~ p_pattern
    order by n
    limit p_limit) s
$$;

-- What the review pages show of a source record's payload: allow-listed fields only.
create function private.review_source_summary(p_payload jsonb)
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'title', private.json_safe_strings(pg_catalog.jsonb_build_array(p_payload -> 'title'), '^[^[:cntrl:]\u200e\u200f\u202a-\u202e\u2066-\u2069]+$', 300, 1) ->> 0,
    'titles', private.json_safe_strings(p_payload -> 'titles', '^[^[:cntrl:]\u200e\u200f\u202a-\u202e\u2066-\u2069]+$', 300, 20),
    'ja_titles', private.json_safe_strings(p_payload -> 'ja_titles', '^[^[:cntrl:]\u200e\u200f\u202a-\u202e\u2066-\u2069]+$', 300, 20),
    'first_release', case when pg_catalog.jsonb_typeof(p_payload -> 'first_release_date') = 'string'
                            and (p_payload ->> 'first_release_date') ~ '^\d{4}(-\d{2}){0,2}$' then pg_catalog.jsonb_build_object(
      'value', p_payload ->> 'first_release_date',
      'precision', case when (p_payload ->> 'first_release_precision') in ('day', 'month', 'year') then p_payload ->> 'first_release_precision' end) end,
    'revision', case when pg_catalog.jsonb_typeof(p_payload #> '{source,revision}') = 'number'
                       and (p_payload #>> '{source,revision}') ~ '^[1-9]\d{0,14}$' then (p_payload #>> '{source,revision}')::bigint end,
    'platform_first_release', case when pg_catalog.jsonb_typeof(p_payload #> '{source,platform_first_release,value}') = 'string'
                                     and (p_payload #>> '{source,platform_first_release,value}') ~ '^[+-]?\d{4}(-\d{2}){0,2}$' then pg_catalog.jsonb_build_object(
      'value', p_payload #>> '{source,platform_first_release,value}',
      'precision', case when (p_payload #>> '{source,platform_first_release,precision}') in ('day', 'month', 'year') then p_payload #>> '{source,platform_first_release,precision}' end) end,
    'distribution_formats', private.json_safe_strings(p_payload #> '{source,distribution_formats}', '^Q[1-9]\d{0,11}$', 13, 20),
    'instance_of', private.json_safe_strings(p_payload #> '{source,instance_of}', '^Q[1-9]\d{0,11}$', 13, 20),
    'platforms', case when pg_catalog.jsonb_typeof(p_payload #> '{source,platforms}') = 'array' then pg_catalog.jsonb_array_length(p_payload #> '{source,platforms}') end,
    'external_ids', pg_catalog.jsonb_build_object(
      'igdb', private.json_safe_strings(p_payload #> '{source,external_ids,igdb}', '^[A-Za-z0-9._-]+$', 80, 10),
      'mobygames', private.json_safe_strings(p_payload #> '{source,external_ids,mobygames}', '^[A-Za-z0-9._-]+$', 80, 10)),
    'detail', pg_catalog.jsonb_typeof(p_payload -> 'source') = 'object' and p_payload -> 'source' <> '{}'::jsonb)
$$;

-- A source record's IGDB and MobyGames ids, as create_review_batch compares them.
create function private.review_external_keys(p_payload jsonb)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array(
    select 'igdb:' || pg_catalog.jsonb_array_elements_text(case when pg_catalog.jsonb_typeof(p_payload #> '{source,external_ids,igdb}') = 'array' then p_payload #> '{source,external_ids,igdb}' else '[]' end)
    union
    select 'mobygames:' || pg_catalog.jsonb_array_elements_text(case when pg_catalog.jsonb_typeof(p_payload #> '{source,external_ids,mobygames}') = 'array' then p_payload #> '{source,external_ids,mobygames}' else '[]' end))
$$;

revoke all on function private.review_member_rank(boolean, text[], text[]), private.json_safe_strings(jsonb, text, integer, integer),
  private.review_source_summary(jsonb), private.review_external_keys(jsonb) from public, anon, authenticated, service_role;

-- A person as the review pages show them: a handle, or "you". Null once the account is gone.
create function private.review_person(p_id uuid, p_me uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when p_id is null then null else pg_catalog.jsonb_build_object(
    'handle', (select pr.handle from public.profiles pr where pr.id = p_id),
    'you', p_id = p_me) end
$$;
revoke all on function private.review_person(uuid, uuid) from public, anon, authenticated, service_role;

-- 1. Batches, newest first. p_status: open, approved, rejected or null (all). p_platform: a
-- platform slug or null. p_after: the last batch id of the previous page. p_limit: 1 to 100.
create function public.list_review_batches(p_status text default null, p_platform text default null, p_after uuid default null, p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_platform uuid;
  v_after private.catalog_review_batches;
  v_limit integer := coalesce(p_limit, 25);
  v_items jsonb;
  v_more boolean;
begin
  v_me := private.require_active_staff('catalog_editor');
  if (p_status is not null and p_status not in ('open', 'approved', 'rejected')) or v_limit not between 1 and 100 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  if p_platform is not null then
    select p.id into v_platform from public.platforms p where p.slug = p_platform;
    if v_platform is null then
      return pg_catalog.jsonb_build_object('status', 'unknown_platform', 'items', '[]'::jsonb, 'next_after', null);
    end if;
  end if;
  if p_after is not null then
    select * into v_after from private.catalog_review_batches b where b.id = p_after;
    if not found then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
  end if;

  -- One row more than a page is read, only to know whether another page follows.
  with page as (
    select b.*, row_number() over (order by b.created_at desc, b.id desc) as n from (
      select b.* from private.catalog_review_batches b
      where (p_status is null or b.status = p_status)
        and (v_platform is null or b.platform_id = v_platform)
        and (p_after is null or (b.created_at, b.id) < (v_after.created_at, v_after.id))
      order by b.created_at desc, b.id desc
      limit v_limit + 1) b)
  select pg_catalog.jsonb_agg(x.j order by x.created_at desc, x.id desc) filter (where x.n <= v_limit), count(*) > v_limit
  into v_items, v_more
  from (
    select b.id, b.created_at, b.n, pg_catalog.jsonb_build_object(
      'id', b.id, 'status', b.status, 'created_at', b.created_at, 'decided_at', b.decided_at,
      'platform', pg_catalog.jsonb_build_object('slug', p.slug, 'name', p.name, 'short_name', p.short_name),
      'source', pg_catalog.jsonb_build_object('provider', r.provider_code, 'provider_name', ep.name, 'name', r.source_name, 'fetched_at', r.source_fetched_at),
      'creator', private.review_person(b.created_by, v_me),
      'items', b.item_count, 'flagged', b.flagged_count, 'sampled', b.sample_size,
      'required', c.required, 'recorded', c.recorded, 'pending', c.required - c.recorded,
      'critical_signals', c.critical_signals, 'critical_errors', c.critical_errors,
      'approvals', pg_catalog.jsonb_build_object('recorded', c.approvals, 'required', b.required_approvals)) as j
    from page b
    join public.platforms p on p.id = b.platform_id
    join private.import_runs r on r.id = b.import_run_id
    left join private.external_providers ep on ep.code = r.provider_code
    cross join lateral (
      select count(*) filter (where i.sampled or pg_catalog.cardinality(i.flags) > 0) as required,
             count(*) filter (where (i.sampled or pg_catalog.cardinality(i.flags) > 0) and i.outcome is not null) as recorded,
             count(*) filter (where pg_catalog.cardinality(i.critical_flags) > 0) as critical_signals,
             count(*) filter (where i.critical_error is not null) as critical_errors,
             (select count(*) from private.catalog_review_batch_approvals a where a.batch_id = b.id) as approvals
      -- The extra row's counts are never read.
      from private.catalog_review_batch_items i where i.batch_id = b.id and b.n <= v_limit) c) x;

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'items', coalesce(v_items, '[]'::jsonb),
    'next_after', case when v_more then (v_items -> (v_limit - 1)) ->> 'id' end);
end;
$$;

-- 2. One batch: what it is, where it came from, how far its review is, and what holds it.
--
-- blockers: what approve_review_batch would refuse now, in its order (each with how many
-- members or sources cause it): pending_outcomes, sample_failed, critical_errors_unresolved,
-- evidence_missing, stale, publication_rights. Empty for a batch that isn't open.
-- you.review: why the caller can't record outcomes in this batch (null when they can, member
-- rules aside): not_open, you_created_batch, approval_started.
-- you.approve: why the caller couldn't approve it, whatever the blockers: not_open,
-- you_created_batch, you_created_member, you_already_approved.
-- Neither includes the recent authenticator check both functions make at the time.
create function public.get_review_batch_overview(p_batch uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  b private.catalog_review_batches;
  c record;
  v_stale integer := 0;
  v_rights integer := 0;
  v_approvals integer;
  v_blockers jsonb := '[]'::jsonb;
  v_own_member boolean;
begin
  v_me := private.require_active_staff('catalog_editor');
  select * into b from private.catalog_review_batches x where x.id = p_batch;
  if not found then
    return null;
  end if;

  select count(*) as items,
         count(*) filter (where pg_catalog.cardinality(i.critical_flags) > 0) as critical,
         count(*) filter (where pg_catalog.cardinality(i.flags) > 0) as flagged,
         count(*) filter (where i.sampled) as sampled,
         count(*) filter (where not i.sampled and pg_catalog.cardinality(i.flags) = 0) as unsampled,
         count(*) filter (where i.sampled or pg_catalog.cardinality(i.flags) > 0) as required,
         count(*) filter (where (i.sampled or pg_catalog.cardinality(i.flags) > 0) and i.outcome is null) as pending,
         count(*) filter (where i.outcome is not null) as recorded,
         count(*) filter (where i.outcome = 'correct') as correct,
         count(*) filter (where i.outcome = 'incorrect') as incorrect,
         count(*) filter (where i.outcome = 'excluded') as excluded,
         count(*) filter (where i.critical_error is not null) as critical_errors,
         count(*) filter (where i.critical_error is not null and i.outcome = 'incorrect') as critical_unresolved,
         count(*) filter (where i.sampled and i.outcome <> 'correct') as sample_errors,
         count(*) filter (where i.sampled and i.critical_error is not null) as sample_critical,
         count(*) filter (where i.outcome = 'correct' and not private.evidence_note_ok(i.note)) as evidence_missing,
         count(*) filter (where pg_catalog.cardinality(i.info_flags) > 0) as with_info_flags
  into c
  from private.catalog_review_batch_items i where i.batch_id = b.id;
  select count(*) into v_approvals from private.catalog_review_batch_approvals a where a.batch_id = b.id;

  if b.status = 'open' then
    -- As approve_review_batch checks staleness (without its locks).
    select count(*) into v_stale
    from private.catalog_review_batch_items i
    left join public.games g on g.id = i.game_id
    left join public.game_platforms gp on gp.game_id = i.game_id and gp.platform_id = i.platform_id
    where i.batch_id = b.id and (g.id is null or gp.game_id is null or g.revision <> i.frozen_game_revision
                                 or g.status not in ('unverified', 'under_review') or g.verified_at is not null
                                 or gp.status not in ('unverified', 'under_review'));
    -- As require_publication_rights decides, for the sources approval would publish from.
    select count(*) into v_rights from (
      select distinct pr.provider_code, src.terms_sha256
      from private.catalog_review_batch_items i
      join private.provider_records pr on pr.id = i.provider_record_id
      join private.import_runs src on src.id = pr.import_run_id
      where i.batch_id = b.id and (i.outcome = 'correct' or (i.outcome is null and pg_catalog.cardinality(i.flags) = 0 and not i.sampled))) s
    where s.terms_sha256 is null or not exists (
      select 1 from private.external_providers p
      where p.code = s.provider_code
        and ((p.commercial_use_cleared and p.terms_sha256 = s.terms_sha256)
             or (p.rights_survive_withdrawal and p.rights_terms_sha256 = s.terms_sha256)));

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code', k.code, 'count', k.n) order by k.ord), '[]'::jsonb)
    into v_blockers
    from (values
      (1, 'pending_outcomes', c.pending),
      (2, 'sample_failed', case when c.sample_errors > b.acceptance_number or c.sample_critical > 0 then c.sample_errors else 0 end),
      (3, 'critical_errors_unresolved', c.critical_unresolved),
      (4, 'evidence_missing', c.evidence_missing),
      (5, 'stale', v_stale),
      (6, 'publication_rights', v_rights)) as k(ord, code, n)
    where k.n > 0;
  end if;

  v_own_member := private.created_by(v_me, null, (select pg_catalog.array_agg(i.game_id) from private.catalog_review_batch_items i where i.batch_id = b.id))
    or exists (select 1 from private.catalog_review_batch_items i where i.batch_id = b.id and private.pairing_created_by(v_me, i.game_id, i.platform_id))
    or exists (select 1 from private.catalog_review_batch_items i join public.games g on g.id = i.game_id where i.batch_id = b.id and g.submitted_by = v_me);

  return (
    select pg_catalog.jsonb_build_object(
      'id', b.id, 'status', b.status, 'reason', b.reason,
      'created_at', b.created_at, 'decided_at', b.decided_at, 'decision_reason', b.decision_reason,
      'creator', private.review_person(b.created_by, v_me),
      'platform', pg_catalog.jsonb_build_object('slug', p.slug, 'name', p.name, 'short_name', p.short_name),
      'source', pg_catalog.jsonb_build_object(
        'run_id', r.id, 'provider', r.provider_code, 'provider_name', ep.name, 'name', r.source_name,
        'snapshot_sha256', r.source_sha256, 'fetched_at', r.source_fetched_at, 'finished_at', r.finished_at, 'terms_sha256', r.terms_sha256),
      'content_sha256', b.content_sha256,
      'seed', b.seed,
      'sampling', pg_catalog.jsonb_build_object(
        'sample_size', b.sample_size, 'acceptance_number', b.acceptance_number,
        'tolerable_error', b.tolerable_error, 'confidence', b.confidence),
      'counts', pg_catalog.jsonb_build_object(
        'items', c.items, 'critical', c.critical, 'flagged', c.flagged, 'sampled', c.sampled, 'unsampled', c.unsampled,
        'with_info_flags', c.with_info_flags, 'required', c.required, 'pending', c.pending, 'recorded', c.recorded,
        'correct', c.correct, 'incorrect', c.incorrect, 'excluded', c.excluded,
        'critical_errors', c.critical_errors, 'sample_errors', c.sample_errors),
      'approvals', pg_catalog.jsonb_build_object(
        'required', b.required_approvals, 'recorded', v_approvals,
        'by', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('person', private.review_person(a.approver_id, v_me), 'at', a.approved_at)
                 order by a.approved_at), '[]'::jsonb)
               from private.catalog_review_batch_approvals a where a.batch_id = b.id)),
      'blockers', v_blockers,
      'ready', b.status = 'open' and pg_catalog.jsonb_array_length(v_blockers) = 0,
      'you', pg_catalog.jsonb_build_object(
        'review', case
          when b.status <> 'open' then 'not_open'
          when b.created_by = v_me then 'you_created_batch'
          when v_approvals > 0 then 'approval_started' end,
        'approve', case
          when b.status <> 'open' then 'not_open'
          when b.created_by = v_me then 'you_created_batch'
          when v_own_member then 'you_created_member'
          when exists (select 1 from private.catalog_review_batch_approvals a where a.batch_id = b.id and a.approver_id = v_me) then 'you_already_approved' end))
    from public.platforms p, private.import_runs r
    left join private.external_providers ep on ep.code = r.provider_code
    where p.id = b.platform_id and r.id = b.import_run_id);
end;
$$;

-- 3. One page of a batch's members, ordered by category, then the frozen source record's title,
-- then game id: all fixed when the batch is frozen. p_filter: all, needs_review (an outcome is required and
-- none is recorded), reviewed (an outcome is recorded), critical, flagged (critical included),
-- sampled or unsampled. p_after: the last member's game id on the previous page.
create function public.list_review_batch_members(p_batch uuid, p_filter text default 'all', p_after uuid default null, p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  b private.catalog_review_batches;
  v_filter text := coalesce(p_filter, 'all');
  v_limit integer := coalesce(p_limit, 25);
  v_after_rank integer;
  v_after_title text;
  v_after_id uuid;
  v_items jsonb;
  v_more boolean;
begin
  v_me := private.require_active_staff('catalog_editor');
  if v_filter not in ('all', 'needs_review', 'reviewed', 'critical', 'flagged', 'sampled', 'unsampled') or v_limit not between 1 and 100 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select * into b from private.catalog_review_batches x where x.id = p_batch;
  if not found then
    return null;
  end if;
  if p_after is not null then
    select private.review_member_rank(i.sampled, i.flags, i.critical_flags), coalesce(pr.payload ->> 'title', ''), i.game_id
    into v_after_rank, v_after_title, v_after_id
    from private.catalog_review_batch_items i left join private.provider_records pr on pr.id = i.provider_record_id
    where i.batch_id = b.id and i.game_id = p_after;
    if not found then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
  end if;

  with m as (
    select i.*, g.title, g.status as game_status, g.revision, g.verified_at as game_verified_at,
           gp.status as pairing_status, gp.game_id is not null as paired,
           private.review_member_rank(i.sampled, i.flags, i.critical_flags) as rank,
           -- The sort title is the frozen source record's (records can't change), never the live game title.
           coalesce(pr.payload ->> 'title', '') as sort_title
    from private.catalog_review_batch_items i
    join public.games g on g.id = i.game_id
    left join private.provider_records pr on pr.id = i.provider_record_id
    left join public.game_platforms gp on gp.game_id = i.game_id and gp.platform_id = i.platform_id
    where i.batch_id = b.id
      and case v_filter
        when 'needs_review' then (i.sampled or pg_catalog.cardinality(i.flags) > 0) and i.outcome is null
        when 'reviewed' then i.outcome is not null
        when 'critical' then pg_catalog.cardinality(i.critical_flags) > 0
        when 'flagged' then pg_catalog.cardinality(i.flags) > 0
        when 'sampled' then i.sampled
        when 'unsampled' then not i.sampled and pg_catalog.cardinality(i.flags) = 0
        else true end
      and (p_after is null or (private.review_member_rank(i.sampled, i.flags, i.critical_flags), coalesce(pr.payload ->> 'title', ''), i.game_id) > (v_after_rank, v_after_title, v_after_id))
    order by rank, sort_title, i.game_id
    limit v_limit + 1)
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'game', pg_catalog.jsonb_build_object('id', m.game_id, 'title', m.title, 'status', m.game_status),
           'pairing_status', m.pairing_status,
           'category', (array['critical', 'flagged', 'sampled', 'unsampled'])[m.rank + 1],
           'sampled', m.sampled, 'flags', m.flags, 'info_flags', m.info_flags, 'critical_flags', m.critical_flags,
           'source', (select pg_catalog.jsonb_build_object('provider', pr.provider_code, 'external_id', pr.external_id)
                      from private.provider_records pr where pr.id = m.provider_record_id),
           'requires_outcome', m.sampled or pg_catalog.cardinality(m.flags) > 0,
           'outcome', m.outcome, 'critical_error', m.critical_error, 'note', m.note, 'recorded_at', m.recorded_at,
           'reviewer', private.review_person(m.reviewed_by, v_me),
           'stale', case when b.status = 'open' then (not m.paired or m.revision <> m.frozen_game_revision
                          or m.game_status not in ('unverified', 'under_review') or m.game_verified_at is not null
                          or m.pairing_status not in ('unverified', 'under_review')) end)
           order by m.rank, m.sort_title, m.game_id) filter (where m.n <= v_limit),
         count(*) > v_limit
  into v_items, v_more
  from (select m.*, row_number() over (order by m.rank, m.sort_title, m.game_id) as n from m) m;

  return pg_catalog.jsonb_build_object(
    'batch', pg_catalog.jsonb_build_object('id', b.id, 'status', b.status),
    'filter', v_filter,
    'items', coalesce(v_items, '[]'::jsonb),
    'next_after', case when v_more then (v_items -> (v_limit - 1)) -> 'game' ->> 'id' end);
end;
$$;

-- 4. One member's review context.
--
-- you.record: why the caller can't record an outcome for it now (null when they can), in
-- record_batch_outcome's order: not_open, you_created_batch, approval_started, not_required,
-- you_created_record, outcome_final. you.options: the outcomes they may record: all three, or
-- only "excluded" for a member found incorrect (keeping its critical error, if one was recorded).
-- Not included: the recent authenticator check record_batch_outcome also makes.
create function public.get_review_batch_member(p_batch uuid, p_game uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  b private.catalog_review_batches;
  i private.catalog_review_batch_items;
  g public.games;
  gp public.game_platforms;
  pr private.provider_records;
  v_approvals integer;
  v_required boolean;
  v_own boolean;
  v_block text;
  v_keys text[];
begin
  v_me := private.require_active_staff('catalog_editor');
  select * into b from private.catalog_review_batches x where x.id = p_batch;
  if not found then
    return null;
  end if;
  select * into i from private.catalog_review_batch_items x where x.batch_id = b.id and x.game_id = p_game;
  if not found then
    return null;
  end if;
  select * into g from public.games x where x.id = i.game_id;
  select * into gp from public.game_platforms x where x.game_id = i.game_id and x.platform_id = i.platform_id;
  select * into pr from private.provider_records x where x.id = i.provider_record_id;
  select count(*) into v_approvals from private.catalog_review_batch_approvals a where a.batch_id = b.id;
  v_required := i.sampled or pg_catalog.cardinality(i.flags) > 0;
  v_own := private.created_by(v_me, null, array[i.game_id])
    or private.pairing_created_by(v_me, i.game_id, i.platform_id)
    or g.submitted_by is not distinct from v_me
    or gp.submitted_by is not distinct from v_me;
  v_block := case
    when b.status <> 'open' then 'not_open'
    when b.created_by = v_me then 'you_created_batch'
    when v_approvals > 0 then 'approval_started'
    when not v_required then 'not_required'
    when v_own then 'you_created_record'
    when i.outcome is not null and i.outcome <> 'incorrect' then 'outcome_final' end;
  v_keys := private.review_external_keys(pr.payload);

  return pg_catalog.jsonb_build_object(
    'batch', pg_catalog.jsonb_build_object(
      'id', b.id, 'status', b.status, 'content_sha256', b.content_sha256, 'created_at', b.created_at,
      'platform', (select pg_catalog.jsonb_build_object('slug', p.slug, 'name', p.name, 'short_name', p.short_name) from public.platforms p where p.id = b.platform_id),
      'approvals', v_approvals),
    'member', pg_catalog.jsonb_build_object(
      'category', (array['critical', 'flagged', 'sampled', 'unsampled'])[private.review_member_rank(i.sampled, i.flags, i.critical_flags) + 1],
      'sampled', i.sampled, 'flags', i.flags, 'info_flags', i.info_flags, 'critical_flags', i.critical_flags,
      'requires_outcome', v_required, 'frozen_game_revision', i.frozen_game_revision,
      'outcome', i.outcome, 'critical_error', i.critical_error, 'note', i.note, 'recorded_at', i.recorded_at,
      'reviewer', private.review_person(i.reviewed_by, v_me),
      'stale', case when b.status = 'open' then (gp.game_id is null or g.revision <> i.frozen_game_revision
                     or g.status not in ('unverified', 'under_review') or g.verified_at is not null
                     or gp.status not in ('unverified', 'under_review')) end),
    'game', pg_catalog.jsonb_build_object(
      'id', g.id, 'title', g.title, 'kind', g.kind, 'status', g.status, 'revision', g.revision, 'slug', g.slug,
      'first_release', case when g.first_release_date is null then null else pg_catalog.jsonb_build_object('value', g.first_release_date, 'precision', g.first_release_precision) end,
      'identity_verified', g.verified_at is not null),
    'pairing', case when gp.game_id is null then null else pg_catalog.jsonb_build_object(
      'status', gp.status,
      'physical_confirmed', gp.verification_basis is not null and gp.verified_at is not null,
      'releases', (select pg_catalog.jsonb_build_object('total', count(*), 'published', count(*) filter (where r.status = 'published' and r.verified_at is not null))
                   from public.releases r where r.game_id = gp.game_id and r.platform_id = gp.platform_id)) end,
    'source', case when pr.id is null then null else pg_catalog.jsonb_build_object(
      'provider', pr.provider_code,
      'provider_name', (select ep.name from private.external_providers ep where ep.code = pr.provider_code),
      'external_id', pr.external_id,
      'payload_sha256', pr.payload_sha256,
      'snapshot_sha256', (select r.source_sha256 from private.import_runs r where r.id = pr.import_run_id),
      'record', private.review_source_summary(pr.payload),
      'assessment', pg_catalog.jsonb_build_object(
        'assessor', case when (pr.payload #>> '{risk_assessment,assessor}') ~ '^[A-Za-z0-9._-]{1,60}$' then pr.payload #>> '{risk_assessment,assessor}' end,
        'assessor_version', case when (pr.payload #>> '{risk_assessment,assessor_version}') ~ '^[A-Za-z0-9._-]{1,20}$' then pr.payload #>> '{risk_assessment,assessor_version}' end,
        'problems', pg_catalog.to_jsonb(private.review_risk_problems(pr)))) end,
    'conflicts', pg_catalog.jsonb_build_object(
      -- Catalog games with the same title key: on the batch's platform or another.
      'same_title', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'id', c.id, 'title', c.title, 'status', c.status,
                        'on_platform', exists (select 1 from public.game_platforms cp where cp.game_id = c.id and cp.platform_id = i.platform_id),
                        'in_batch', exists (select 1 from private.catalog_review_batch_items o where o.batch_id = b.id and o.game_id = c.id))
                      order by c.title, c.id), '[]'::jsonb)
                     from (select c.* from public.games c
                           where c.search_key = g.search_key and c.id <> g.id and c.status not in ('merged', 'rejected')
                           order by c.title, c.id limit 20) c),
      -- Members of this batch sharing an IGDB or MobyGames id with it.
      'shared_ids', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', o.game_id, 'title', og.title) order by og.title, o.game_id), '[]'::jsonb)
                     from (select o.* from private.catalog_review_batch_items o join private.provider_records opr on opr.id = o.provider_record_id
                           where o.batch_id = b.id and o.game_id <> i.game_id and private.review_external_keys(opr.payload) && v_keys
                           limit 20) o join public.games og on og.id = o.game_id),
      -- Other catalog games already linked to the same source id.
      'linked_elsewhere', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'title', c.title, 'status', c.status) order by c.title, c.id), '[]'::jsonb)
                           from (select distinct c.id, c.title, c.status from private.external_references er join public.games c on c.id = er.game_id
                                 where er.provider_code = pr.provider_code and er.external_id = pr.external_id and er.game_id <> i.game_id
                                 limit 10) c)),
    -- Every batch the game was in on this platform, newest first, this one included.
    'batches', (select coalesce(pg_catalog.jsonb_agg(x.j order by x.created_at desc, x.id desc), '[]'::jsonb) from (
                  select ob.id, ob.created_at, pg_catalog.jsonb_build_object(
                    'id', ob.id, 'status', ob.status, 'created_at', ob.created_at, 'decided_at', ob.decided_at,
                    'sampled', oi.sampled, 'flagged', pg_catalog.cardinality(oi.flags) > 0,
                    'outcome', oi.outcome, 'critical_error', oi.critical_error, 'recorded_at', oi.recorded_at) as j
                  from private.catalog_review_batch_items oi join private.catalog_review_batches ob on ob.id = oi.batch_id
                  where oi.game_id = i.game_id and oi.platform_id = i.platform_id
                  order by ob.created_at desc, ob.id desc limit 20) x),
    -- This member's recorded outcomes in this batch, oldest first (incorrect, then excluded).
    'trail', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'at', e.occurred_at, 'person', private.review_person(e.actor_id, v_me),
                 'outcome', e.metadata ->> 'outcome', 'critical_error', e.metadata ->> 'critical_error', 'note', e.metadata ->> 'note')
               order by e.occurred_at, e.id), '[]'::jsonb)
              from (select e.* from private.audit_events e
                    where e.metadata ? 'game_id' and e.metadata ->> 'game_id' = i.game_id::text and e.action = 'catalog_batch_outcome_recorded'
                      and e.metadata ->> 'batch_id' = b.id::text
                    order by e.occurred_at, e.id limit 10) e),
    'you', pg_catalog.jsonb_build_object(
      'record', v_block,
      'options', case
        when v_block is not null then '[]'::jsonb
        when i.outcome = 'incorrect' then '["excluded"]'::jsonb
        else '["correct", "incorrect", "excluded"]'::jsonb end,
      'keep_critical_error', case when v_block is null and i.outcome = 'incorrect' then i.critical_error end));
end;
$$;

revoke all on function public.list_review_batches(text, text, uuid, integer), public.get_review_batch_overview(uuid),
  public.list_review_batch_members(uuid, text, uuid, integer), public.get_review_batch_member(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_review_batches(text, text, uuid, integer), public.get_review_batch_overview(uuid),
  public.list_review_batch_members(uuid, text, uuid, integer), public.get_review_batch_member(uuid, uuid)
  to authenticated;
