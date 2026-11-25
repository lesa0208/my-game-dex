-- M15 submission enrichment: what approved sources say about a submitted new game, looked up by
-- the server right after the collector submits, and kept with the submission for the editor.
--
-- - private.submission_enrichments: one row per new-game submission, made in the same
--   transaction as the submission (a trigger), so a lookup that never ran is still waiting
--   ('pending') and can be retried. No client role reads or writes it.
-- - The server's lookup claims rows and records its results through two functions that only
--   service_role (the server's secret key) may execute, as set_avatar_path (M2). A collector
--   can never write a source claim: every candidate here came from the server's own request.
-- - A claim carries a token. A result is accepted only for the current claim, so a late answer
--   from before the title changed (which re-queues the lookup) or a second concurrent lookup is
--   dropped, and retries never pile up results. Failures back off; at most 5 attempts, until an
--   editor asks again.
-- - Editors (catalog_editor, with MFA, as every staff read) read the result with the catalog games
--   that already use a candidate's Wikidata item or have the submitted title among their source
--   titles or aliases: the likely duplicates. They can ask for a new lookup. Collectors see only
--   their own submission's lookup status.
-- - Nothing here changes a game, release, pairing or request, decides anything or publishes.
--   Candidates are source claims, not evidence of the physical release.
--
-- It also fixes the guard that stopped collectors renaming their own new-game submission (below).
--
-- The "format not known" choice needs no change: on NES and SNES the generic rom-cartridge is
-- the documented "cartridge shape not classified" format (M11b-1b). A submission may use it, and
-- a release can't be published on it (accepts_new_publications = false) until an editor names
-- the shell.

create table private.submission_enrichments (
  submission_id uuid primary key references public.catalog_change_requests (id) on delete cascade,
  provider text not null default 'wikidata' check (provider = 'wikidata'),
  status text not null default 'pending'
    check (status in ('pending', 'failed', 'unsupported_platform', 'no_match', 'single_match', 'ambiguous')),
  attempts integer not null default 0 check (attempts between 0 and 100),
  -- The lookup in flight, if any: its token and when it was claimed.
  claim_id uuid,
  claimed_at timestamptz,
  -- When the last attempt was claimed: a failed lookup waits 15 minutes from it.
  last_attempt_at timestamptz,
  -- What was looked up, as the server sent it: the submitted title and the platform's slug.
  looked_up_title text check (char_length(looked_up_title) between 1 and 200),
  looked_up_platform text check (char_length(looked_up_platform) between 1 and 60),
  retrieved_at timestamptz,
  -- Each a source's claim with its id, revision, licence scope and retrieval time (match.ts).
  candidates jsonb not null default '[]'
    check (jsonb_typeof(candidates) = 'array' and jsonb_array_length(candidates) <= 10 and pg_column_size(candidates) <= 131072),
  -- Wikidata labels for the developer and publisher ids the candidates name.
  labels jsonb not null default '{}' check (jsonb_typeof(labels) = 'object' and pg_column_size(labels) <= 16384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint submission_enrichments_claim check ((claim_id is null) = (claimed_at is null)),
  constraint submission_enrichments_looked_up check (status = 'pending' or retrieved_at is not null)
);

create index submission_enrichments_waiting_idx on private.submission_enrichments (created_at) where status in ('pending', 'failed');

create trigger set_updated_at before update on private.submission_enrichments
  for each row execute function private.set_updated_at();

alter table private.submission_enrichments enable row level security;
revoke all on private.submission_enrichments from public, anon, authenticated, service_role;

-- A new-game submission waits for its lookup from the moment it exists. A changed title (the
-- collector's edit, before review) looks up again: the earlier answer was for another title.
create function private.queue_submission_enrichment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into private.submission_enrichments (submission_id) values (new.id) on conflict (submission_id) do nothing;
  else
    update private.submission_enrichments e set
      status = 'pending', attempts = 0, claim_id = null, claimed_at = null, last_attempt_at = null, looked_up_title = null, looked_up_platform = null,
      retrieved_at = null, candidates = '[]', labels = '{}'
    where e.submission_id = new.id;
  end if;
  return null;
end;
$$;
revoke all on function private.queue_submission_enrichment() from public, anon, authenticated, service_role;

create trigger queue_submission_enrichment after insert on public.catalog_change_requests
  for each row when (new.request_type = 'new_game') execute function private.queue_submission_enrichment();
create trigger requeue_submission_enrichment after update of details on public.catalog_change_requests
  for each row when (new.request_type = 'new_game' and new.details ->> 'title' is distinct from old.details ->> 'title')
  execute function private.queue_submission_enrichment();

-- Submissions made before this migration that are still waiting for a decision.
insert into private.submission_enrichments (submission_id)
select s.id from public.catalog_change_requests s
where s.request_type = 'new_game' and s.status in ('open', 'in_review', 'changes_requested')
on conflict (submission_id) do nothing;

-- A fix the title re-lookup depends on: a collector could not change the title of their own
-- new-game submission. guard_submitted_record (M7b-1, as replaced in M10c) runs on games and
-- releases, and its "region unknown is staff-only" check read new.region_unknown_confirmed on a
-- games row too, which has no such field: "record new has no field". The check now runs on
-- releases only; the function is otherwise unchanged.
CREATE OR REPLACE FUNCTION private.guard_submitted_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_me uuid := (select auth.uid());
  v_client boolean := coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon');
  v_release boolean := tg_table_name = 'releases';
  v_kind text := case when tg_table_name = 'releases' then 'release' else 'game' end;
  v_req public.catalog_change_requests;
  v_verifying boolean := new.verified_at is not null and new.verified_at is distinct from old.verified_at;
  v_publishing boolean := old.status <> 'published' and new.status = 'published';
  v_origin private.catalog_record_origins;
  v_unknown boolean;
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

  if v_verifying or v_publishing then
    if v_req.id is not null then
      raise exception 'review required' using errcode = 'P0001';
    end if;
    if v_me is not null and (old.submitted_by = v_me or exists (
         select 1 from public.catalog_change_requests s
         where s.submitted_by = v_me
           and case when v_release then s.release_id = new.id else s.game_id = new.id and s.created_game end)) then
      raise exception 'own submission' using errcode = 'P0001';
    end if;

    if v_client then
      if not private.mfa_recent(interval '10 minutes') then
        raise exception 'reauthentication required' using errcode = 'P0001';
      end if;
      v_origin := private.record_origin(v_kind, new.id);
      v_unknown := coalesce(v_origin.origin, 'unknown') = 'unknown';
      if v_me is not null and v_origin.creator_id = v_me then
        raise exception 'own record' using errcode = 'P0001';
      end if;
      if v_unknown and not private.has_staff_role('admin') then
        raise exception 'provenance unknown' using errcode = 'P0001';
      end if;
      if v_publishing and old.status in ('unverified', 'under_review') then
        if old.verified_by is null or old.verified_by is not distinct from v_origin.creator_id then
          raise exception 'verification required' using errcode = 'P0001';
        end if;
        if v_unknown and old.verified_by = v_me then
          raise exception 'independent review required' using errcode = 'P0001';
        end if;
        if not private.verification_current(v_kind, new.id, old.revision, old.verified_at) then
          raise exception 'verification stale' using errcode = 'P0001';
        end if;
      end if;
    end if;
  end if;

  if v_req.id is null or v_me is null or not v_client then
    return new;
  end if;
  if v_req.submitted_by = v_me then
    if v_req.status not in ('open', 'changes_requested') then
      raise exception 'submission locked' using errcode = 'P0001';
    end if;
    -- M15: nested, so a game row (which has no such field) is never asked for it.
    if v_release then
      if new.region_unknown_confirmed and not old.region_unknown_confirmed then
        raise exception 'not permitted' using errcode = '42501';
      end if;
    end if;
  elsif v_req.status <> 'in_review' then
    raise exception 'submission not in review' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The server's lookup (service_role only)
-- ---------------------------------------------------------------------------

-- Claims up to p_limit (1 to 10) lookups that are due, or the given submission's when it's due:
-- waiting ones, a claim left over 2 minutes ago (a lookup that died), and failed ones 15 minutes
-- after their last try, while the submission still waits for a decision, at most 5 attempts.
-- Returns [{submission_id, claim_id, title, platform}].
create function public.claim_submission_enrichments(p_submission uuid default null, p_limit integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  with due as (
    select e.submission_id
    from private.submission_enrichments e
    join public.catalog_change_requests s on s.id = e.submission_id
    where (p_submission is null or e.submission_id = p_submission)
      and s.status in ('open', 'in_review', 'changes_requested')
      and e.status in ('pending', 'failed')
      and e.attempts < 5
      and (e.claimed_at is null or e.claimed_at < pg_catalog.now() - interval '2 minutes')
      and (e.status = 'pending' or e.last_attempt_at is null or e.last_attempt_at < pg_catalog.now() - interval '15 minutes')
    order by e.created_at
    limit least(greatest(coalesce(p_limit, 1), 1), 10)
    for update of e skip locked
  ), claimed as (
    update private.submission_enrichments e
    set claim_id = gen_random_uuid(), claimed_at = pg_catalog.now(), last_attempt_at = pg_catalog.now(), attempts = e.attempts + 1
    from due
    where e.submission_id = due.submission_id
    returning e.submission_id, e.claim_id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'submission_id', c.submission_id, 'claim_id', c.claim_id,
           'title', s.details ->> 'title', 'platform', s.details -> 'platform' ->> 'slug')), '[]'::jsonb)
  into v_out
  from claimed c join public.catalog_change_requests s on s.id = c.submission_id;
  return v_out;
end;
$$;

-- Records the answer to the current claim. p_result: {status, title, platform, retrieved_at,
-- candidates, labels}. False, and nothing written, when the claim is no longer current.
create function public.record_submission_enrichment(p_submission uuid, p_claim uuid, p_result jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := p_result ->> 'status';
  v_candidates jsonb := coalesce(p_result -> 'candidates', '[]');
  v_labels jsonb := coalesce(p_result -> 'labels', '{}');
  v_rows integer;
begin
  if p_submission is null or p_claim is null or p_result is null or pg_catalog.jsonb_typeof(p_result) <> 'object'
     or v_status is null or v_status not in ('failed', 'unsupported_platform', 'no_match', 'single_match', 'ambiguous')
     or pg_catalog.jsonb_typeof(v_candidates) <> 'array' or pg_catalog.jsonb_typeof(v_labels) <> 'object'
     or (v_status in ('single_match', 'ambiguous')) <> (pg_catalog.jsonb_array_length(v_candidates) > 0)
     or (v_status = 'single_match' and pg_catalog.jsonb_array_length(v_candidates) <> 1)
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_candidates) c
                where pg_catalog.jsonb_typeof(c) <> 'object' or c ->> 'provider' is distinct from 'wikidata'
                   or coalesce(c ->> 'external_id', '') !~ '^Q[1-9][0-9]{0,11}$'
                   or coalesce(c ->> 'title', '') = '' or pg_catalog.char_length(c ->> 'title') > 400
                   or pg_catalog.jsonb_typeof(c -> 'titles') is distinct from 'array'
                   or pg_catalog.jsonb_typeof(c -> 'developers') is distinct from 'array'
                   or pg_catalog.jsonb_typeof(c -> 'publishers') is distinct from 'array'
                   or c ->> 'licence' is null or c ->> 'retrieved_at' is null)
     or exists (select 1 from pg_catalog.jsonb_each(v_labels) l
                where l.key !~ '^Q[1-9][0-9]{0,11}$' or pg_catalog.jsonb_typeof(l.value) <> 'string' or pg_catalog.char_length(l.value #>> '{}') > 200) then
    raise exception 'invalid enrichment' using errcode = '22023';
  end if;
  update private.submission_enrichments e set
    status = v_status, claim_id = null, claimed_at = null,
    looked_up_title = nullif(pg_catalog.left(p_result ->> 'title', 200), ''),
    looked_up_platform = nullif(pg_catalog.left(p_result ->> 'platform', 60), ''),
    retrieved_at = coalesce((p_result ->> 'retrieved_at')::timestamptz, pg_catalog.now()),
    candidates = v_candidates, labels = v_labels
  where e.submission_id = p_submission and e.claim_id = p_claim;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
exception
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'invalid enrichment' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------------
-- Editors and submitters
-- ---------------------------------------------------------------------------

-- The lookup for a submission, for catalog editors (with MFA), with the catalog games it may
-- duplicate: those whose own source records or references use a candidate's Wikidata item, and
-- those with the submitted title as their title, an alias or one of their source titles. The
-- submission's own game is left out. Null when the submission has no lookup (not a new game).
create function public.get_submission_enrichment(p_submission uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_req public.catalog_change_requests;
  v_row private.submission_enrichments;
  v_key text;
begin
  perform private.require_active_staff('catalog_editor');
  select * into v_req from public.catalog_change_requests s where s.id = p_submission;
  select * into v_row from private.submission_enrichments e where e.submission_id = p_submission;
  if v_req.id is null or v_row.submission_id is null then
    return null;
  end if;
  v_key := private.catalog_search_key(v_req.details ->> 'title');
  return pg_catalog.jsonb_build_object(
    'status', v_row.status, 'provider', v_row.provider, 'attempts', v_row.attempts,
    'looking_up', v_row.claimed_at is not null and v_row.claimed_at > pg_catalog.now() - interval '2 minutes',
    'looked_up_title', v_row.looked_up_title, 'looked_up_platform', v_row.looked_up_platform,
    'retrieved_at', v_row.retrieved_at, 'candidates', v_row.candidates, 'labels', v_row.labels,
    'current_title', v_req.details ->> 'title',
    'catalog_items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('external_id', x.external_id, 'game_id', g.id, 'title', g.title, 'status', g.status, 'slug', g.slug)
                                  order by x.external_id, g.title)
      from (
        select distinct pr.external_id, pr.matched_game_id as game_id from private.provider_records pr
        where pr.provider_code = 'wikidata' and pr.matched_game_id is not null
          and pr.external_id in (select c ->> 'external_id' from pg_catalog.jsonb_array_elements(v_row.candidates) c)
        union
        select xr.external_id, xr.game_id from private.external_references xr
        where xr.provider_code = 'wikidata' and xr.game_id is not null
          and xr.external_id in (select c ->> 'external_id' from pg_catalog.jsonb_array_elements(v_row.candidates) c)
      ) x
      join public.games g on g.id = x.game_id
      where g.id is distinct from v_req.game_id and g.status <> 'merged'), '[]'::jsonb),
    'title_matches', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('game_id', g.id, 'title', g.title, 'status', g.status, 'slug', g.slug, 'via', m.via) order by g.title)
      from (
        select g2.id, min(v.via) as via from public.games g2
        cross join lateral (
          select 'title' as via where g2.search_key = v_key
          union all
          select 'alias' from public.game_aliases a where a.game_id = g2.id and a.search_key = v_key
          union all
          select 'source title' from private.provider_records pr, pg_catalog.jsonb_array_elements_text(
              case when pg_catalog.jsonb_typeof(pr.payload -> 'titles') = 'array' then pr.payload -> 'titles' else '[]' end
              || case when pg_catalog.jsonb_typeof(pr.payload -> 'ja_titles') = 'array' then pr.payload -> 'ja_titles' else '[]' end) t
            where pr.matched_game_id = g2.id and pr.entity_type = 'game' and private.catalog_search_key(t) = v_key
        ) v
        where v_key is not null and g2.id is distinct from v_req.game_id and g2.status <> 'merged'
        group by g2.id
      ) m join public.games g on g.id = m.id), '[]'::jsonb)
  );
end;
$$;

-- Asks for a new lookup of a submission that is still waiting for a decision: a catalog editor
-- (with MFA). The earlier answer is kept until the new one arrives. True when queued.
create function public.request_submission_enrichment(p_submission uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  perform private.require_active_staff('catalog_editor');
  -- Waiting again, with a fresh allowance of attempts. A claim in flight is dropped: its answer
  -- will no longer be recorded.
  update private.submission_enrichments e set status = 'pending', attempts = 0, claim_id = null, claimed_at = null
  where e.submission_id = p_submission
    and exists (select 1 from public.catalog_change_requests s where s.id = e.submission_id and s.status in ('open', 'in_review', 'changes_requested'));
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- The caller's own submission's lookup, from a live session (M11a), as they may see it: whether it is waiting, found
-- something or found nothing. Never the candidates or the duplicates. Null when there is none.
create function public.my_submission_enrichment(p_submission uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'status', e.status, 'retrieved_at', e.retrieved_at, 'found', pg_catalog.jsonb_array_length(e.candidates) > 0)
  from private.submission_enrichments e
  join public.catalog_change_requests s on s.id = e.submission_id
  where e.submission_id = p_submission and s.submitted_by = (select auth.uid()) and (select private.session_is_live())
$$;

revoke all on function public.claim_submission_enrichments(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.record_submission_enrichment(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.get_submission_enrichment(uuid) from public, anon, authenticated, service_role;
revoke all on function public.request_submission_enrichment(uuid) from public, anon, authenticated, service_role;
revoke all on function public.my_submission_enrichment(uuid) from public, anon, authenticated, service_role;

grant execute on function public.claim_submission_enrichments(uuid, integer) to service_role;
grant execute on function public.record_submission_enrichment(uuid, uuid, jsonb) to service_role;
grant execute on function public.get_submission_enrichment(uuid) to authenticated;
grant execute on function public.request_submission_enrichment(uuid) to authenticated;
grant execute on function public.my_submission_enrichment(uuid) to authenticated;
