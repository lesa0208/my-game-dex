-- M7b-1 Catalog review: catalog editors review submissions. They start a review,
-- correct fields with the M5a editor functions, then approve (verify and publish),
-- request changes or reject. A submitter answers requested changes, and may resubmit
-- a rejected submission as a new, linked request. Merging, exclusion, restoration and
-- relinking copies come with M7b-2.
--
-- Design: docs/architecture/security-rls.md#catalog-review-m7b-1
--
-- Who reviews. Active catalog editors and administrators, through private.begin_catalog_edit()
-- (the shared staff lock, the role check, then the caller's profile), like every M5a
-- editor function. Nobody reviews their own submission: each action compares the
-- caller with the request's submitter, which the request keeps after publication
-- clears it from the catalog rows. A deleted submitter (null) is no conflict, since a
-- deleted account can't review.
--
-- No bypass. The M5 editor functions verify and publish any unpublished record, so
-- without a guard an editor could publish a submission, their own included, without a
-- review. A trigger on games and releases now refuses verifying or publishing a record
-- while a review request for it is active, and refuses it to anyone who ever submitted
-- it. Approval marks its request approved first, and then verifies and publishes with
-- the M5 functions, so every publication rule applies unchanged. The same trigger lets
-- only the reviewing editors edit a submission in review, and its submitter only while
-- it's theirs to change.
--
-- Stale pages. Every action needs the request's version, which any change raises, and
-- approval also needs the records' M5b revisions. A stale one gets 'request conflict'
-- or 'record changed', and nothing changes.
--
-- Locks, everywhere in this order: the staff lock, profiles (the caller's, then the
-- submitter's), the request, the game, the release, the platform pairing. Account
-- deletion locks the profile first, so it and a review wait for each other rather
-- than deadlock. M7a's submitter functions now lock the caller's profile first and
-- the game before the release, matching the editor functions.
--
-- Errors (SQLSTATE, message), besides the M5 and M7a ones:
--   42501 'not permitted'             not an active catalog editor
--   P0001 'submission unavailable'    no such submission, or not in a state for this
--   P0001 'request conflict'          the request changed since the page was read
--   P0001 'own submission'            the caller submitted it
--   P0001 'review required'           it can only be verified or published by approving it
--   P0001 'submission not in review'  an editor's change before the review started
--   P0001 'submitter unavailable'     changes can't be requested of a deleted account
--   P0001 'already published'         an identical release is already published
--   22023 'invalid review'            a note is missing or too long

-- ---------------------------------------------------------------------------
-- 1. The review record: a version, the link to a rejected predecessor, one active
--    request per release
-- ---------------------------------------------------------------------------

alter table public.catalog_change_requests
  add column version integer not null default 1 check (version > 0),
  add column previous_request_id uuid references public.catalog_change_requests (id) on delete set null;

create index catalog_change_requests_previous_idx on public.catalog_change_requests (previous_request_id) where previous_request_id is not null;
create unique index catalog_change_requests_active_release_key on public.catalog_change_requests (release_id)
  where release_id is not null and status in ('open', 'in_review', 'changes_requested');

-- Raises the version on any change, including an account deletion clearing the
-- submitter. A direct write can only raise it by one.
create function private.bump_request_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (pg_catalog.to_jsonb(new) - array['version', 'updated_at']) is distinct from (pg_catalog.to_jsonb(old) - array['version', 'updated_at'])
     or new.version is distinct from old.version then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

create trigger bump_request_version before update on public.catalog_change_requests
  for each row execute function private.bump_request_version();

-- ---------------------------------------------------------------------------
-- 2. The guard on submitted records
-- ---------------------------------------------------------------------------

-- Before any change to a game or release:
-- - Verifying or publishing it is refused while a review request for it is active
--   (open, in review, or changes requested), whoever asks: approval is the only way.
-- - It's refused to anyone who submitted it, by the permanent history, whatever
--   happened to the request since.
-- - While a request is active, a signed-in caller may change the record only as its
--   submitter while the request is theirs to change (never confirming an unknown
--   region), or as an editor while it's in review.
-- A release's request is by release_id; a game's is the request that created it.
-- Maintenance sessions that aren't a client role (tests, operators) skip only the
-- caller rules.
create function private.guard_submitted_record()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_client boolean := coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon');
  v_release boolean := tg_table_name = 'releases';
  v_req public.catalog_change_requests;
begin
  if v_release then
    select * into v_req from public.catalog_change_requests s
    where s.release_id = new.id and s.status in ('open', 'in_review', 'changes_requested');
  else
    select * into v_req from public.catalog_change_requests s
    where s.game_id = new.id and s.created_game and s.status in ('open', 'in_review', 'changes_requested')
    order by s.id desc
    limit 1;
  end if;

  if (old.verified_at is null and new.verified_at is not null) or (old.status <> 'published' and new.status = 'published') then
    if v_req.id is not null then
      raise exception 'review required' using errcode = 'P0001';
    end if;
    if v_me is not null and (old.submitted_by = v_me or exists (
         select 1 from public.catalog_change_requests s
         where s.submitted_by = v_me
           and case when v_release then s.release_id = new.id else s.game_id = new.id and s.created_game end)) then
      raise exception 'own submission' using errcode = 'P0001';
    end if;
  end if;

  if v_req.id is null or v_me is null or not v_client then
    return new;
  end if;
  if v_req.submitted_by = v_me then
    if v_req.status not in ('open', 'changes_requested') then
      raise exception 'submission locked' using errcode = 'P0001';
    end if;
    if v_release and new.region_unknown_confirmed and not old.region_unknown_confirmed then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  elsif v_req.status <> 'in_review' then
    raise exception 'submission not in review' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger guard_submitted_record before update on public.games
  for each row execute function private.guard_submitted_record();
create trigger guard_submitted_record before update on public.releases
  for each row execute function private.guard_submitted_record();

revoke all on function private.bump_request_version() from public, anon, authenticated, service_role;
revoke all on function private.guard_submitted_record() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Notifications: a submission's outcome, to its submitter
-- ---------------------------------------------------------------------------

-- Like a moderation notice: no actor, so the reviewer is never named, and only the
-- new status and the submission's id. The note to the submitter is read on the
-- submission's page; the editor's reason stays in the audit log. Always on: the
-- preferences can't hold this type, so private.notify never skips it.
alter table public.notifications drop constraint notifications_shape;
alter table public.notifications add constraint notifications_shape check (
  (type in ('follow', 'follow_request', 'follow_accepted')
    and actor_id is not null and event_at is not null and data = '{}'::jsonb)
  or (type = 'moderation'
    and actor_id is null and event_at is null
    and data - 'status' = '{}'::jsonb and data ->> 'status' in ('suspended', 'active'))
  or (type = 'catalog_submission'
    and actor_id is null and event_at is null
    and data - array['status', 'submission_id'] = '{}'::jsonb
    and data ->> 'status' in ('published', 'changes_requested', 'rejected')
    and jsonb_typeof(data -> 'submission_id') = 'string')
);

-- ---------------------------------------------------------------------------
-- 4. Submitter functions: lock order, answering requested changes, resubmitting
-- ---------------------------------------------------------------------------

-- As in M7a, and now locks the caller's profile before anything else, as the editor
-- functions do, so an account deletion and a submission wait for each other.
create or replace function private.begin_submission(p_new boolean)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not coalesce((select a.is_active from public.get_my_account() a), false) then
    raise exception 'account not active' using errcode = 'P0001';
  end if;
  perform 1 from public.profiles p where p.id = v_me for key share;
  if p_new then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catalog_submissions:' || v_me::text, 0));
    if (select count(*) from public.catalog_change_requests s
        where s.submitted_by = v_me and s.request_type in ('new_game', 'new_release') and s.created_at > pg_catalog.now() - interval '24 hours') >= 10 then
      raise exception 'submission limit reached' using errcode = 'P0001';
    end if;
  end if;
  return v_me;
end;
$$;

-- The caller's own request that they may still change: open, or returned to them with
-- changes requested. Locks the request, then the game, then the release, the order
-- the editor functions use, so a withdrawal and an editor's change can't deadlock.
create or replace function private.lock_open_submission(p_me uuid, p_submission uuid)
returns public.catalog_change_requests
language plpgsql
set search_path = ''
as $$
declare
  req public.catalog_change_requests;
  rel public.releases;
  v_game uuid;
begin
  select * into req from public.catalog_change_requests s
  where s.id = p_submission and s.submitted_by = p_me and s.request_type in ('new_game', 'new_release') and s.status <> 'withdrawn'
  for update;
  if not found or req.release_id is null then
    raise exception 'submission unavailable' using errcode = 'P0001';
  end if;
  select r.game_id into v_game from public.releases r where r.id = req.release_id;
  perform 1 from public.games g where g.id = v_game for update;
  select * into rel from public.releases r where r.id = req.release_id for update;
  if req.status not in ('open', 'changes_requested') or rel.status is distinct from 'unverified'
     or rel.submitted_by is distinct from p_me or rel.game_id is distinct from v_game then
    raise exception 'submission locked' using errcode = 'P0001';
  end if;
  return req;
end;
$$;

-- Sends a submission back for review: one with changes requested, as the same request
-- (not counted again), or a rejected one, as a new request linked to it, which counts
-- toward the limit (product owner decision 3). Only the latest request of a rejected
-- chain can be resubmitted. A new note replaces the old one; none keeps it.
-- Returns {submission_id}: the same id, or the new one.
create function public.resubmit_my_submission(p_submission uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_old public.catalog_change_requests;
  v_rel public.releases;
  v_note text := nullif(pg_catalog.btrim(p_note), '');
  v_id uuid;
  v_constraint text;
begin
  v_me := private.begin_submission(false);
  if pg_catalog.char_length(v_note) > 1000 then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  select * into v_old from public.catalog_change_requests s
  where s.id = p_submission and s.submitted_by = v_me and s.request_type in ('new_game', 'new_release') and s.status in ('changes_requested', 'rejected')
  for update;
  if not found or v_old.release_id is null then
    raise exception 'submission unavailable' using errcode = 'P0001';
  end if;

  if v_old.status = 'changes_requested' then
    perform private.lock_open_submission(v_me, v_old.id);
    update public.catalog_change_requests s set
      status = 'open',
      reason = coalesce(v_note, s.reason),
      details = private.submission_snapshot(v_old.release_id)
    where s.id = v_old.id;
    perform private.record_audit(v_me, 'catalog_submission_resubmitted', null, 'Catalog submission',
      pg_catalog.jsonb_build_object('request_id', v_old.id, 'release_id', v_old.release_id));
    return pg_catalog.jsonb_build_object('submission_id', v_old.id);
  end if;

  -- Rejected: a new request, counted like any other submission.
  perform private.begin_submission(true);
  if exists (select 1 from public.catalog_change_requests n where n.previous_request_id = v_old.id) then
    raise exception 'submission unavailable' using errcode = 'P0001';
  end if;
  perform 1 from public.games g where g.id = v_old.game_id for update;
  select * into v_rel from public.releases r where r.id = v_old.release_id for update;
  if v_rel.status is distinct from 'rejected' or v_rel.submitted_by is distinct from v_me then
    raise exception 'submission locked' using errcode = 'P0001';
  end if;

  begin
    update public.releases r set status = 'unverified' where r.id = v_rel.id;
    if v_old.created_game then
      update public.games g set status = 'unverified'
      where g.id = v_rel.game_id and g.status = 'rejected' and g.submitted_by = v_me;
    end if;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'releases_pending_submission_key' then
        raise exception 'already submitted' using errcode = 'P0001';
      end if;
      raise exception 'invalid submission' using errcode = '22023';
  end;

  insert into public.catalog_change_requests (request_type, submitted_by, game_id, release_id, platform_id, details, reason,
    physical_confirmed, created_game, created_pairing, previous_request_id)
  values (v_old.request_type, v_me, v_old.game_id, v_rel.id, v_old.platform_id, private.submission_snapshot(v_rel.id),
    coalesce(v_note, v_old.reason), true, v_old.created_game, v_old.created_pairing, v_old.id)
  returning id into v_id;
  perform private.record_audit(v_me, 'catalog_submission_resubmitted', null, 'Catalog submission',
    pg_catalog.jsonb_build_object('request_id', v_id, 'previous_request_id', v_old.id, 'release_id', v_rel.id));
  return pg_catalog.jsonb_build_object('submission_id', v_id);
end;
$$;

-- As in M7a, plus: editable while changes are requested, whether it can be sent back
-- for review, and the requests before and after it.
create or replace function public.get_my_submission(p_submission uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', s.id, 'kind', s.request_type, 'status', private.submission_status(s.status),
    'created_at', s.created_at, 'updated_at', s.updated_at,
    'note', s.reason, 'reviewer_note', s.reviewer_note, 'created_game', s.created_game, 'details', s.details,
    'release_id', r.id, 'game_id', s.game_id,
    'game_slug', case when g.status = 'published' then g.slug end,
    'editable', s.status in ('open', 'changes_requested') and r.status = 'unverified' and r.submitted_by = s.submitted_by,
    'resubmittable', (s.status = 'changes_requested' and r.status = 'unverified' and r.submitted_by = s.submitted_by)
      or (s.status = 'rejected' and r.status = 'rejected' and r.submitted_by = s.submitted_by
          and not exists (select 1 from public.catalog_change_requests n where n.previous_request_id = s.id)),
    'previous_id', (select p.id from public.catalog_change_requests p where p.id = s.previous_request_id and p.submitted_by = s.submitted_by),
    'next_id', (select n.id from public.catalog_change_requests n where n.previous_request_id = s.id and n.submitted_by = s.submitted_by),
    'my_copies', (select count(*) from public.collection_items c where c.release_id = r.id and c.owner_id = s.submitted_by)
  )
  from public.catalog_change_requests s
  left join public.releases r on r.id = s.release_id
  left join public.games g on g.id = s.game_id
  where s.id = p_submission and s.submitted_by = (select auth.uid()) and s.request_type in ('new_game', 'new_release')
$$;

-- ---------------------------------------------------------------------------
-- 5. Review helpers. Called only by the review functions, never by clients.
-- ---------------------------------------------------------------------------

-- Locks the submitter's profile, then the request, for a review action by p_me (who
-- began a catalog edit). Refuses the caller's own submission and a stale version.
-- An account deleted meanwhile leaves a null submitter, which is no conflict.
create function private.begin_review(p_me uuid, p_request uuid, p_expected_version integer)
returns public.catalog_change_requests
language plpgsql
set search_path = ''
as $$
declare
  v_submitter uuid;
  req public.catalog_change_requests;
begin
  if p_expected_version is null then
    raise exception 'invalid review' using errcode = '22023';
  end if;
  select s.submitted_by into v_submitter from public.catalog_change_requests s where s.id = p_request;
  if v_submitter is not null then
    perform 1 from public.profiles p where p.id = v_submitter for key share;
  end if;
  select * into req from public.catalog_change_requests s
  where s.id = p_request and s.request_type in ('new_game', 'new_release')
  for update;
  if not found or req.release_id is null then
    raise exception 'submission unavailable' using errcode = 'P0001';
  end if;
  if req.submitted_by is not distinct from p_me then
    raise exception 'own submission' using errcode = 'P0001';
  end if;
  if req.version <> p_expected_version then
    raise exception 'request conflict' using errcode = 'P0001';
  end if;
  return req;
end;
$$;

-- Locks a request's records, game first, then release, then pairing, and returns the
-- release. The request's own records must still be what it made.
create function private.lock_review_records(p_req public.catalog_change_requests)
returns public.releases
language plpgsql
set search_path = ''
as $$
declare
  v_game uuid;
  rel public.releases;
begin
  select r.game_id into v_game from public.releases r where r.id = p_req.release_id;
  perform 1 from public.games g where g.id = v_game for update;
  select * into rel from public.releases r where r.id = p_req.release_id for update;
  if not found or rel.game_id is distinct from v_game then
    raise exception 'submission unavailable' using errcode = 'P0001';
  end if;
  perform 1 from public.game_platforms gp where gp.game_id = rel.game_id and gp.platform_id = rel.platform_id for update;
  return rel;
end;
$$;

-- A note for the submitter: trimmed, null when empty, at most 2,000 characters.
create function private.review_note(p_note text, p_required boolean)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_note text := nullif(pg_catalog.btrim(p_note), '');
begin
  if (p_required and v_note is null) or pg_catalog.char_length(v_note) > 2000 then
    raise exception 'invalid review' using errcode = '22023';
  end if;
  return v_note;
end;
$$;

-- Who submitted a request, as editors see it: a handle and account status, or that
-- the account was deleted. Never an email or anything from a collection.
create function private.review_submitter(p_submitter uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case
    when p_submitter is null then pg_catalog.jsonb_build_object('deleted', true)
    else (select pg_catalog.jsonb_build_object('deleted', false, 'handle', p.handle, 'account_status', p.account_status)
          from public.profiles p where p.id = p_submitter)
  end
$$;

revoke all on function private.begin_review(uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.lock_review_records(public.catalog_change_requests) from public, anon, authenticated, service_role;
revoke all on function private.review_note(text, boolean) from public, anon, authenticated, service_role;
revoke all on function private.review_submitter(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Review actions. Each is one transaction with an audit row; outcomes notify the
--    submitter, unless their account was deleted.
-- ---------------------------------------------------------------------------

-- Starts the review of an open submission: the submitter can no longer change or
-- withdraw it, and editors may correct it. Returns the request's new version.
create function public.start_submission_review(p_request uuid, p_expected_version integer, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_req public.catalog_change_requests;
  v_rel public.releases;
  v_version integer;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_req := private.begin_review(v_me, p_request, p_expected_version);
  if v_req.status <> 'open' then
    raise exception 'submission unavailable' using errcode = 'P0001';
  end if;
  v_rel := private.lock_review_records(v_req);

  update public.catalog_change_requests s set status = 'in_review' where s.id = v_req.id
  returning s.version into v_version;
  update public.releases r set status = 'under_review' where r.id = v_rel.id and r.status = 'unverified';
  if v_req.created_game then
    update public.games g set status = 'under_review' where g.id = v_rel.game_id and g.status = 'unverified';
  end if;
  perform private.record_audit(v_me, 'catalog_submission_review_started', null, v_reason,
    pg_catalog.jsonb_build_object('request_id', v_req.id, 'release_id', v_rel.id));
  return v_version;
end;
$$;

-- Approves a submission in review: marks the request approved, then verifies and
-- publishes it with the M5 functions, at the revisions the editor reviewed, so every
-- publication rule applies (an edition, a medium count, an unknown region confirmed).
-- A new game needs its revision too. The note, if any, is shown to the submitter.
-- Returns {release_id, game_slug}.
create function public.approve_submission(
  p_request uuid,
  p_expected_version integer,
  p_release_revision bigint,
  p_game_revision bigint,
  p_reason text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_note text;
  v_req public.catalog_change_requests;
  v_rel public.releases;
  v_game public.games;
  v_constraint text;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_note := private.review_note(p_note, false);
  v_req := private.begin_review(v_me, p_request, p_expected_version);
  if v_req.status <> 'in_review' then
    raise exception 'submission unavailable' using errcode = 'P0001';
  end if;
  v_rel := private.lock_review_records(v_req);
  if p_release_revision is null or v_rel.revision <> p_release_revision then
    raise exception 'record changed' using errcode = 'P0001';
  end if;
  select * into v_game from public.games g where g.id = v_rel.game_id;

  update public.catalog_change_requests s set
    status = 'approved', reviewed_by = v_me, reviewed_at = pg_catalog.now(), reviewer_note = v_note
  where s.id = v_req.id;

  begin
    if v_req.created_game and v_game.status <> 'published' and v_game.verified_at is null then
      perform public.verify_game(v_game.id, v_reason, p_game_revision);
    end if;
    if v_rel.verified_at is null then
      perform public.verify_release(v_rel.id, v_reason, p_release_revision);
    end if;
    perform public.publish_release(v_rel.id, v_reason, p_release_revision);
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'releases_published_identity_key' then
        raise exception 'already published' using errcode = 'P0001';
      end if;
      raise;
  end;

  if v_req.submitted_by is not null then
    perform private.notify(v_req.submitted_by, null, 'catalog_submission', null,
      pg_catalog.jsonb_build_object('status', 'published', 'submission_id', v_req.id));
  end if;
  perform private.record_audit(v_me, 'catalog_submission_approved', null, v_reason,
    pg_catalog.jsonb_build_object('request_id', v_req.id, 'release_id', v_rel.id, 'game_id', v_rel.game_id));
  return pg_catalog.jsonb_build_object('release_id', v_rel.id, 'game_slug', (select g.slug from public.games g where g.id = v_rel.game_id));
end;
$$;

-- Returns a submission in review to its submitter with a note saying what to change.
-- Its records go back to unverified, so the submitter can edit them, and it waits
-- for them to send it back. Refused when the submitter's account was deleted: nobody
-- could answer. Returns the request's new version.
create function public.request_submission_changes(p_request uuid, p_expected_version integer, p_note text, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_note text;
  v_req public.catalog_change_requests;
  v_rel public.releases;
  v_version integer;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_note := private.review_note(p_note, true);
  v_req := private.begin_review(v_me, p_request, p_expected_version);
  if v_req.status <> 'in_review' then
    raise exception 'submission unavailable' using errcode = 'P0001';
  end if;
  if v_req.submitted_by is null then
    raise exception 'submitter unavailable' using errcode = 'P0001';
  end if;
  v_rel := private.lock_review_records(v_req);

  -- While the request is still in review, so the guard lets this editor change them.
  update public.releases r set status = 'unverified' where r.id = v_rel.id and r.status = 'under_review';
  if v_req.created_game then
    update public.games g set status = 'unverified' where g.id = v_rel.game_id and g.status = 'under_review';
  end if;
  -- The snapshot becomes the record as it is now, with any editor's corrections, so the
  -- submitter edits from that and saving can't undo them.
  update public.catalog_change_requests s set
    status = 'changes_requested', reviewed_by = v_me, reviewed_at = pg_catalog.now(), reviewer_note = v_note,
    details = private.submission_snapshot(v_rel.id)
  where s.id = v_req.id
  returning s.version into v_version;

  perform private.notify(v_req.submitted_by, null, 'catalog_submission', null,
    pg_catalog.jsonb_build_object('status', 'changes_requested', 'submission_id', v_req.id));
  perform private.record_audit(v_me, 'catalog_submission_changes_requested', null, v_reason,
    pg_catalog.jsonb_build_object('request_id', v_req.id, 'release_id', v_rel.id));
  return v_version;
end;
$$;

-- Rejects a submission in review: a genuine physical product whose data or evidence
-- isn't good enough. Its release is kept as rejected, and with it the submitter's
-- copies, shown as not approved. A new game is rejected too, unless another release
-- of it is pending or published; then it goes back to unverified. Nothing is deleted,
-- and a shared pairing is untouched.
-- The note, if any, is shown to the submitter. Returns the request's new version.
create function public.reject_submission(p_request uuid, p_expected_version integer, p_reason text, p_note text default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_note text;
  v_req public.catalog_change_requests;
  v_rel public.releases;
  v_version integer;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_note := private.review_note(p_note, false);
  v_req := private.begin_review(v_me, p_request, p_expected_version);
  if v_req.status <> 'in_review' then
    raise exception 'submission unavailable' using errcode = 'P0001';
  end if;
  v_rel := private.lock_review_records(v_req);

  update public.catalog_change_requests s set
    status = 'rejected', reviewed_by = v_me, reviewed_at = pg_catalog.now(), reviewer_note = v_note
  where s.id = v_req.id
  returning s.version into v_version;
  update public.releases r set status = 'rejected' where r.id = v_rel.id;
  if v_req.created_game then
    update public.games g set status = case
        when exists (select 1 from public.releases o where o.game_id = g.id and o.id <> v_rel.id
                     and o.status in ('unverified', 'under_review', 'published')) then 'unverified'::public.catalog_status
        else 'rejected'::public.catalog_status
      end
    where g.id = v_rel.game_id and g.status in ('unverified', 'under_review');
  end if;

  if v_req.submitted_by is not null then
    perform private.notify(v_req.submitted_by, null, 'catalog_submission', null,
      pg_catalog.jsonb_build_object('status', 'rejected', 'submission_id', v_req.id));
  end if;
  perform private.record_audit(v_me, 'catalog_submission_rejected', null, v_reason,
    pg_catalog.jsonb_build_object('request_id', v_req.id, 'release_id', v_rel.id));
  return v_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Reading, for editors
-- ---------------------------------------------------------------------------

-- Whether the caller may review: an active catalog editor or administrator.
create function public.can_review_submissions()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and private.is_active_user() and private.has_staff_role('catalog_editor')
$$;

-- The review queue, oldest first, paged by id. p_status is a request status, or
-- 'active' (open and in review) or 'all'. Returns {items, next_after}.
create function public.get_submission_queue(p_status text default 'active', p_after uuid default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_active_staff('catalog_editor');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_items jsonb;
  v_last uuid;
  v_more boolean;
begin
  if p_status is null or p_status <> all (array['active', 'all', 'open', 'in_review', 'changes_requested', 'approved', 'rejected', 'withdrawn']) then
    raise exception 'invalid review' using errcode = '22023';
  end if;
  with page as (
    select s.*, row_number() over (order by s.id) as n
    from public.catalog_change_requests s
    where s.request_type in ('new_game', 'new_release')
      and (p_after is null or s.id > p_after)
      and case p_status
            when 'all' then true
            when 'active' then s.status in ('open', 'in_review')
            else s.status::text = p_status
          end
    order by s.id
    limit v_limit + 1
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', p.id, 'kind', p.request_type, 'status', p.status, 'version', p.version,
           'created_at', p.created_at, 'updated_at', p.updated_at,
           'title', p.details ->> 'title', 'platform', p.details -> 'platform', 'region', p.details -> 'region',
           'format', p.details -> 'format', 'edition_name', p.details ->> 'edition_name',
           'submitter', private.review_submitter(p.submitted_by), 'own', p.submitted_by is not distinct from v_me,
           'resubmission', p.previous_request_id is not null
         ) order by p.id) filter (where p.n <= v_limit), '[]'::jsonb),
         max(p.id::text) filter (where p.n = v_limit)::uuid,
         coalesce(bool_or(p.n > v_limit), false)
  into v_items, v_last, v_more
  from page p;
  return pg_catalog.jsonb_build_object('items', v_items, 'next_after', case when v_more then v_last end);
end;
$$;

-- One submission for review, or null: the request, who submitted it, the records as
-- they are now (with the revisions approval needs), its history, and possible
-- duplicates in the whole catalog, published or not, which only editors see.
create function public.get_submission_review(p_request uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_active_staff('catalog_editor');
  v_req public.catalog_change_requests;
  v_rel public.releases;
  v_game public.games;
  v_history jsonb;
  v_duplicates jsonb;
  v_similar jsonb;
begin
  select * into v_req from public.catalog_change_requests s
  where s.id = p_request and s.request_type in ('new_game', 'new_release');
  if not found then
    return null;
  end if;
  select * into v_rel from public.releases r where r.id = v_req.release_id;
  select * into v_game from public.games g where g.id = coalesce(v_rel.game_id, v_req.game_id);

  -- Every request on the same records: earlier and later rounds.
  with recursive back as (
    select s.id, s.previous_request_id from public.catalog_change_requests s where s.id = v_req.id
    union all
    select s.id, s.previous_request_id from public.catalog_change_requests s join back b on s.id = b.previous_request_id
  ), fwd as (
    select s.id from public.catalog_change_requests s where s.id = v_req.id
    union all
    select s.id from public.catalog_change_requests s join fwd f on s.previous_request_id = f.id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', s.id, 'status', s.status, 'created_at', s.created_at, 'reviewed_at', s.reviewed_at,
           'reviewer_note', s.reviewer_note,
           'reviewer', (select pr.handle from public.profiles pr where pr.id = s.reviewed_by)
         ) order by s.id), '[]'::jsonb)
  into v_history
  from public.catalog_change_requests s
  where s.id in (select id from back union select id from fwd);

  -- Releases that may be the same physical product: on the same game and platform, or
  -- with the same product code or barcode anywhere.
  select coalesce(pg_catalog.jsonb_agg(d order by d ->> 'status', d ->> 'id'), '[]'::jsonb) into v_duplicates
  from (
    select pg_catalog.jsonb_build_object(
      'id', r.id, 'status', r.status, 'game_title', g.title, 'game_slug', case when g.status = 'published' then g.slug end,
      'platform', pl.short_name, 'region', r.region_code, 'format', r.media_format_code,
      'edition_name', r.edition_name, 'variant_name', r.variant_name, 'product_code', r.product_code, 'barcode', r.barcode,
      'same_product_code', r.product_code is not null and r.product_code = v_rel.product_code,
      'same_barcode', r.barcode is not null and r.barcode = v_rel.barcode,
      'request_id', (select a.id from public.catalog_change_requests a where a.release_id = r.id
                     and a.status in ('open', 'in_review', 'changes_requested'))
    ) d
    from public.releases r
    join public.games g on g.id = r.game_id
    join public.platforms pl on pl.id = r.platform_id
    where r.id <> v_rel.id and r.status not in ('merged')
      and ((r.game_id = v_rel.game_id and r.platform_id = v_rel.platform_id)
           or (v_rel.product_code is not null and r.product_code = v_rel.product_code)
           or (v_rel.barcode is not null and r.barcode = v_rel.barcode))
    limit 25
  ) x;

  -- For a new game, games with the same or a similar title.
  if v_req.created_game and v_game.id is not null then
    select coalesce(pg_catalog.jsonb_agg(d order by (d ->> 'similarity')::numeric desc), '[]'::jsonb) into v_similar
    from (
      select pg_catalog.jsonb_build_object('id', g.id, 'title', g.title, 'status', g.status,
               'slug', case when g.status = 'published' then g.slug end,
               'similarity', round(extensions.similarity(g.search_key, v_game.search_key)::numeric, 2)) d
      from public.games g
      where g.id <> v_game.id and g.status not in ('merged')
        and (g.search_compact = v_game.search_compact or extensions.similarity(g.search_key, v_game.search_key) >= 0.5)
      order by extensions.similarity(g.search_key, v_game.search_key) desc
      limit 10
    ) x;
  end if;

  return pg_catalog.jsonb_build_object(
    'request', pg_catalog.jsonb_build_object(
      'id', v_req.id, 'kind', v_req.request_type, 'status', v_req.status, 'version', v_req.version,
      'created_at', v_req.created_at, 'updated_at', v_req.updated_at, 'note', v_req.reason,
      'reviewer_note', v_req.reviewer_note, 'reviewed_at', v_req.reviewed_at,
      'reviewer', (select pr.handle from public.profiles pr where pr.id = v_req.reviewed_by),
      'created_game', v_req.created_game, 'details', v_req.details, 'previous_request_id', v_req.previous_request_id,
      'own', v_req.submitted_by is not distinct from v_me),
    'submitter', private.review_submitter(v_req.submitted_by),
    'release', case when v_rel.id is null then null else pg_catalog.jsonb_build_object(
      'id', v_rel.id, 'status', v_rel.status, 'revision', v_rel.revision, 'verified', v_rel.verified_at is not null,
      'platform', (select pg_catalog.jsonb_build_object('id', pl.id, 'slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name)
                   from public.platforms pl where pl.id = v_rel.platform_id),
      'region_code', v_rel.region_code, 'region_unknown_confirmed', v_rel.region_unknown_confirmed,
      'media_format_code', v_rel.media_format_code, 'media_count', v_rel.media_count,
      'edition_name', v_rel.edition_name, 'edition_kind', v_rel.edition_kind, 'variant_name', v_rel.variant_name,
      'product_code', v_rel.product_code, 'barcode', v_rel.barcode, 'local_title', v_rel.local_title,
      'publisher_name', v_rel.publisher_name, 'packaging', v_rel.packaging,
      'release_date', v_rel.release_date, 'release_date_precision', v_rel.release_date_precision,
      'components', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', c.kind, 'label', c.label, 'quantity', c.quantity)
                                order by c.kind, c.label)
                              from public.release_components c where c.release_id = v_rel.id), '[]'::jsonb),
      'pairing_status', (select gp.status from public.game_platforms gp where gp.game_id = v_rel.game_id and gp.platform_id = v_rel.platform_id)
    ) end,
    'game', case when v_game.id is null then null else pg_catalog.jsonb_build_object(
      'id', v_game.id, 'title', v_game.title, 'kind', v_game.kind, 'status', v_game.status, 'revision', v_game.revision,
      'verified', v_game.verified_at is not null, 'slug', case when v_game.status = 'published' then v_game.slug end,
      'first_release_year', case when v_game.first_release_precision = 'unknown' then null
                                 else pg_catalog.date_part('year', v_game.first_release_date)::int end
    ) end,
    'history', v_history,
    'duplicates', v_duplicates,
    'similar_games', coalesce(v_similar, '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.resubmit_my_submission(uuid, text)',
    'public.start_submission_review(uuid, integer, text)',
    'public.approve_submission(uuid, integer, bigint, bigint, text, text)',
    'public.request_submission_changes(uuid, integer, text, text)',
    'public.reject_submission(uuid, integer, text, text)',
    'public.can_review_submissions()',
    'public.get_submission_queue(text, uuid, integer)',
    'public.get_submission_review(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
