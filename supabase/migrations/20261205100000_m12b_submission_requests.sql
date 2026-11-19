-- M12b Missing game: a submission made from one form is made once, however often the
-- form is sent.
--
-- Design: docs/architecture/database-schema.md#catalog-submissions (M12b)
-- - The submission form carries a request id, made when it's rendered and kept on a
--   failure (the same id that names the copy it adds). submit_game_once and
--   submit_release_once record which submission a request made; sending the same request
--   again (a double click, a retry after a lost response, a reload) returns that
--   submission instead of making a second one.
-- - They call submit_game and submit_release unchanged, so every M7a check (account,
--   limit, fields, duplicates of published releases) applies as before. A repeat is
--   answered before them, so it neither counts toward the daily limit nor is refused by it.
-- - Concurrent sends of one request are serialised on the request id, so the second waits
--   for the first and then finds its submission.
-- - A request id is the submitter's own: another user sending it is refused. Only the
--   submitter's live session gets an answer for it.
-- - The record goes with its submission (on delete cascade), and is in private, readable
--   by no role. The private helpers run with the rights of the public functions that call
--   them; no role can call them directly.

create table private.submission_requests (
  request_id uuid primary key,
  submission_id uuid not null unique references public.catalog_change_requests (id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now()
);

alter table private.submission_requests enable row level security;
revoke all on private.submission_requests from public, anon, authenticated, service_role;

-- The submission a request already made, for its submitter; null when none. Raises when
-- the request is someone else's.
create function private.repeated_submission(p_request uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_row record;
begin
  if p_request is null then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  if v_me is null or not (select private.session_is_live()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- Held to the end of the transaction: a concurrent send of the same request waits here.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('submission_request:' || p_request::text, 0));
  select s.id, s.submitted_by, s.release_id, s.game_id into v_row
  from private.submission_requests q
  join public.catalog_change_requests s on s.id = q.submission_id
  where q.request_id = p_request;
  if not found then
    return null;
  end if;
  if v_row.submitted_by is distinct from v_me then
    raise exception 'request conflict' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'submitted', 'submission_id', v_row.id, 'release_id', v_row.release_id,
    'game_id', v_row.game_id, 'repeated', true);
end;
$$;

-- Records the submission a request made, when it made one.
create function private.record_submission_request(p_request uuid, p_outcome jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  if p_outcome ->> 'outcome' = 'submitted' and p_outcome ? 'submission_id' then
    insert into private.submission_requests (request_id, submission_id) values (p_request, (p_outcome ->> 'submission_id')::uuid);
  end if;
  return p_outcome;
end;
$$;

revoke all on function private.repeated_submission(uuid) from public, anon, authenticated, service_role;
revoke all on function private.record_submission_request(uuid, jsonb) from public, anon, authenticated, service_role;

create function public.submit_game_once(
  p_request uuid,
  p_title text,
  p_kind public.game_kind,
  p_first_release_year integer,
  p_platform text,
  p_media_format text,
  p_region text,
  p_details jsonb default '{}'::jsonb,
  p_components jsonb default '[]'::jsonb,
  p_note text default null,
  p_physical boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seen jsonb := private.repeated_submission(p_request);
begin
  if v_seen is not null then
    return v_seen;
  end if;
  return private.record_submission_request(p_request,
    public.submit_game(p_title, p_kind, p_first_release_year, p_platform, p_media_format, p_region, p_details, p_components, p_note, p_physical));
end;
$$;

create function public.submit_release_once(
  p_request uuid,
  p_game uuid,
  p_platform text,
  p_media_format text,
  p_region text,
  p_details jsonb default '{}'::jsonb,
  p_components jsonb default '[]'::jsonb,
  p_note text default null,
  p_physical boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seen jsonb := private.repeated_submission(p_request);
begin
  if v_seen is not null then
    return v_seen;
  end if;
  return private.record_submission_request(p_request,
    public.submit_release(p_game, p_platform, p_media_format, p_region, p_details, p_components, p_note, p_physical));
end;
$$;

revoke all on function public.submit_game_once(uuid, text, public.game_kind, integer, text, text, text, jsonb, jsonb, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.submit_release_once(uuid, uuid, text, text, text, jsonb, jsonb, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.submit_game_once(uuid, text, public.game_kind, integer, text, text, text, jsonb, jsonb, text, boolean) to authenticated;
grant execute on function public.submit_release_once(uuid, uuid, text, text, text, jsonb, jsonb, text, boolean) to authenticated;
