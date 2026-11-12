-- M7a Catalog submissions: signed-in collectors submit a physical release the catalog
-- is missing, of a game it has or of a new game, and can add their own copy at once.
-- Nobody else sees a submission until an editor publishes it (M7b).
--
-- Design: docs/architecture/security-rls.md#catalog-submissions-m7a and
-- docs/architecture/database-schema.md#catalog_change_requests
--
-- A submission writes the existing catalog records, never copies of them: a game (for
-- a new game), its platform pairing, a release and its listed pieces, all 'unverified'
-- and marked with submitted_by. The existing policies already let only the submitter
-- (and catalog editors) read those, already keep them out of search, the picker and
-- counts, and already let the submitter attach a copy (can_use_release).
--
-- catalog_change_requests is the review record the schema design planned: who
-- submitted what, kept after publication clears submitted_by from the catalog rows, so
-- M7b can refuse self-review. As designed, no client role reads it: submitters use the
-- functions below, which return only their own requests and only safe fields.
--
-- Catalog tables have no client write grants, by design, so the functions here are
-- SECURITY DEFINER, like the M5a editor functions: an empty search_path, explicit
-- fields, fixed errors, and an active account required. A submitter can never set a
-- status, verification, a slug, a merge, the "region unknown" confirmation, media
-- playability, a submitter, or anything staff-only.
--
-- Errors (SQLSTATE, message):
--   42501 'not permitted'              no signed-in user
--   P0001 'account not active'         submitting needs an active account with a handle
--   P0001 'submission limit reached'   10 in the last 24 hours, withdrawn ones included
--   P0001 'game unavailable'           not a published game or the caller's own pending one
--   P0001 'already submitted'          the caller has a pending submission of this release
--   P0001 'submission unavailable'     no such submission of the caller's, or withdrawn
--   P0001 'submission locked'          review has started; it can't change any more
--   P0001 'submission in use'          the caller still has copies of the release
--   22023 'invalid submission'         a field is missing, malformed or not allowed

-- ---------------------------------------------------------------------------
-- 1. The review record
-- ---------------------------------------------------------------------------

create table public.catalog_change_requests (
  id uuid primary key default private.uuid_v7(),
  request_type public.catalog_request_type not null,
  -- Null after the submitter's account is deleted. Not cleared on publication.
  submitted_by uuid references public.profiles (id) on delete set null,
  -- The records it made or used. Set null, not cascaded, so a withdrawal, which
  -- deletes what it made, keeps the request as history.
  game_id uuid references public.games (id) on delete set null,
  release_id uuid references public.releases (id) on delete set null,
  platform_id uuid references public.platforms (id) on delete restrict,
  -- Field name to proposed value, for a correction (later).
  proposed_changes jsonb check (jsonb_typeof(proposed_changes) = 'object' and pg_column_size(proposed_changes) <= 16384),
  -- What a new record held as last saved, so the history reads the same after a withdrawal.
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 16384),
  -- From the submitter.
  reason text check (char_length(reason) between 1 and 1000),
  -- The submitter confirmed a new release is a physical game release.
  physical_confirmed boolean not null default false,
  created_game boolean not null default false,
  -- Whether it made the platform pairing. Never shown to the submitter: a pairing it
  -- reused may be someone else's hidden record.
  created_pairing boolean not null default false,
  status public.catalog_review_status not null default 'open',
  -- Staff only (M7b). The note is shown to the submitter; the reviewer never is.
  reviewer_note text check (char_length(reviewer_note) between 1 and 2000),
  merged_into_release_id uuid references public.releases (id) on delete set null,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_change_requests_target check (num_nonnulls(game_id, release_id, platform_id) >= 1),
  constraint catalog_change_requests_physical check (request_type = 'correction' or physical_confirmed),
  constraint catalog_change_requests_new_game check ((request_type = 'new_game') = created_game)
);

create index catalog_change_requests_queue_idx on public.catalog_change_requests (status, created_at);
create index catalog_change_requests_submitter_idx on public.catalog_change_requests (submitted_by, created_at desc);
create index catalog_change_requests_reviewer_idx on public.catalog_change_requests (reviewed_by) where reviewed_by is not null;
create index catalog_change_requests_game_idx on public.catalog_change_requests (game_id) where game_id is not null;
create index catalog_change_requests_release_idx on public.catalog_change_requests (release_id) where release_id is not null;
create index catalog_change_requests_platform_idx on public.catalog_change_requests (platform_id) where platform_id is not null;
create index catalog_change_requests_merged_idx on public.catalog_change_requests (merged_into_release_id) where merged_into_release_id is not null;

create trigger set_updated_at before update on public.catalog_change_requests
  for each row execute function private.set_updated_at();

-- No client reads or writes it: submitters use the functions below, staff come in M7b.
alter table public.catalog_change_requests enable row level security;
revoke all on public.catalog_change_requests from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Helpers. Called only by the functions below, never by clients.
-- ---------------------------------------------------------------------------

-- The caller, who must be signed in with an active account. When p_new is true, also
-- the rate limit: a lock per user, then a count, each in its own statement, so two
-- concurrent submissions can't both see room for one more.
create function private.begin_submission(p_new boolean)
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

-- A release's optional details from a submission, checked and normalized. Only these
-- keys, each a string or a number; an empty string means not known.
create function private.submission_details(p_details jsonb)
returns public.releases
language plpgsql
stable
set search_path = ''
as $$
declare
  r public.releases;
  v_precision text;
begin
  if p_details is null or pg_catalog.jsonb_typeof(p_details) <> 'object'
     or exists (select 1 from pg_catalog.jsonb_each(p_details) e
                where e.key <> all (array['edition_name', 'edition_kind', 'variant_name', 'product_code', 'barcode', 'local_title',
                                          'publisher_name', 'media_count', 'packaging', 'release_date', 'release_date_precision'])
                   or pg_catalog.jsonb_typeof(e.value) not in ('string', 'number', 'null')) then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  r.edition_name := nullif(pg_catalog.btrim(p_details ->> 'edition_name'), '');
  r.edition_kind := nullif(p_details ->> 'edition_kind', '')::public.edition_kind;
  r.variant_name := nullif(pg_catalog.btrim(p_details ->> 'variant_name'), '');
  r.product_code := nullif(pg_catalog.btrim(p_details ->> 'product_code'), '');
  r.barcode := nullif(pg_catalog.btrim(p_details ->> 'barcode'), '');
  r.local_title := nullif(pg_catalog.btrim(p_details ->> 'local_title'), '');
  r.publisher_name := nullif(pg_catalog.btrim(p_details ->> 'publisher_name'), '');
  r.media_count := nullif(p_details ->> 'media_count', '')::smallint;
  r.packaging := nullif(pg_catalog.btrim(p_details ->> 'packaging'), '');
  r.release_date := nullif(p_details ->> 'release_date', '')::date;
  v_precision := nullif(p_details ->> 'release_date_precision', '');
  if r.release_date is null then
    if v_precision is not null and v_precision <> 'unknown' then
      raise exception 'invalid submission' using errcode = '22023';
    end if;
    r.release_date_precision := 'unknown';
  else
    r.release_date_precision := coalesce(v_precision, 'day')::public.date_precision;
    if r.release_date_precision = 'unknown' or r.release_date < date '1950-01-01' or r.release_date > pg_catalog.now()::date + 366 then
      raise exception 'invalid submission' using errcode = '22023';
    end if;
    -- Stored to the precision given: a year is its first day, a month its first day.
    if r.release_date_precision = 'year' then
      r.release_date := pg_catalog.make_date(pg_catalog.date_part('year', r.release_date)::int, 1, 1);
    elsif r.release_date_precision = 'month' then
      r.release_date := pg_catalog.make_date(pg_catalog.date_part('year', r.release_date)::int, pg_catalog.date_part('month', r.release_date)::int, 1);
    end if;
  end if;
  return r;
exception
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
    raise exception 'invalid submission' using errcode = '22023';
end;
$$;

-- Replaces a submitted release's listed pieces: inserts, maps, artwork and other
-- original materials, by kind and label, at most 30. Extra discs go in the media count.
create function private.set_submitted_pieces(p_release uuid, p_pieces jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_pieces is null or pg_catalog.jsonb_typeof(p_pieces) <> 'array' or pg_catalog.jsonb_array_length(p_pieces) > 30
     or exists (select 1 from pg_catalog.jsonb_array_elements(p_pieces) e
                where pg_catalog.jsonb_typeof(e) <> 'object'
                   or exists (select 1 from pg_catalog.jsonb_object_keys(e) k where k <> all (array['kind', 'label', 'quantity']))
                   or e ->> 'kind' is null or e ->> 'kind' not in ('insert', 'map', 'artwork', 'other')
                   or pg_catalog.jsonb_typeof(e -> 'label') is distinct from 'string') then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  delete from public.release_components c where c.release_id = p_release;
  insert into public.release_components (release_id, kind, label, quantity)
  select p_release, (e ->> 'kind')::public.component_kind, pg_catalog.btrim(e ->> 'label'), coalesce((e ->> 'quantity')::smallint, 1)
  from pg_catalog.jsonb_array_elements(p_pieces) e;
end;
$$;

-- What a submission holds now, for its history.
create function private.submission_snapshot(p_release uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'title', g.title, 'game_kind', g.kind,
    'first_release_year', case when g.first_release_precision = 'unknown' then null else pg_catalog.date_part('year', g.first_release_date)::int end,
    'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
    'region', pg_catalog.jsonb_build_object('code', r.region_code, 'label', rc.label),
    'format', pg_catalog.jsonb_build_object('code', r.media_format_code, 'name', mf.name, 'category', mf.category),
    'edition_name', r.edition_name, 'edition_kind', r.edition_kind, 'variant_name', r.variant_name,
    'product_code', r.product_code, 'barcode', r.barcode, 'local_title', r.local_title, 'publisher_name', r.publisher_name,
    'media_count', r.media_count, 'packaging', r.packaging,
    'release_date', r.release_date, 'release_date_precision', r.release_date_precision,
    'components', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', c.kind, 'label', c.label, 'quantity', c.quantity) order by c.kind, c.label)
                            from public.release_components c where c.release_id = r.id), '[]'::jsonb)
  )
  from public.releases r
  join public.games g on g.id = r.game_id
  join public.platforms pl on pl.id = r.platform_id
  join public.region_codes rc on rc.code = r.region_code
  join public.media_formats mf on mf.code = r.media_format_code
  where r.id = p_release
$$;

-- Creates the submitted release on a game, with its pairing if the catalog doesn't
-- have it yet. An existing pairing is reused as it is, whatever its status or whoever
-- made it, and the caller gets the same answer either way.
create function private.create_submitted_release(
  p_me uuid, p_game uuid, p_platform text, p_media_format text, p_region text, p_details jsonb, p_pieces jsonb,
  out release_id uuid, out platform_id uuid, out created_pairing boolean
)
language plpgsql
set search_path = ''
as $$
declare
  v_row public.releases;
  v_rows integer;
  v_constraint text;
begin
  select p.id into platform_id from public.platforms p where p.slug = p_platform;
  if platform_id is null
     or not exists (select 1 from public.platform_media_formats f where f.platform_id = create_submitted_release.platform_id and f.media_format_code = p_media_format)
     or not exists (select 1 from public.region_codes rc where rc.code = p_region) then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  v_row := private.submission_details(coalesce(p_details, '{}'));

  begin
    insert into public.game_platforms (game_id, platform_id, status, submitted_by)
    values (p_game, create_submitted_release.platform_id, 'unverified', p_me)
    on conflict on constraint game_platforms_pkey do nothing;
    get diagnostics v_rows = row_count;
    created_pairing := v_rows = 1;

    insert into public.releases (
      game_id, platform_id, region_code, region_unknown_confirmed, media_format_code, media_playability,
      edition_name, edition_kind, variant_name, product_code, barcode, local_title, publisher_name, media_count, packaging,
      release_date, release_date_precision, status, submitted_by
    ) values (
      p_game, create_submitted_release.platform_id, p_region, false, p_media_format, 'unknown',
      v_row.edition_name, v_row.edition_kind, v_row.variant_name, v_row.product_code, v_row.barcode, v_row.local_title,
      v_row.publisher_name, v_row.media_count, v_row.packaging, v_row.release_date, v_row.release_date_precision, 'unverified', p_me
    )
    returning id into release_id;

    perform private.set_submitted_pieces(release_id, coalesce(p_pieces, '[]'));
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'releases_pending_submission_key' then
        raise exception 'already submitted' using errcode = 'P0001';
      end if;
      raise exception 'invalid submission' using errcode = '22023';
    when invalid_text_representation or check_violation or numeric_value_out_of_range or not_null_violation
      or string_data_right_truncation or foreign_key_violation then
      raise exception 'invalid submission' using errcode = '22023';
  end;
end;
$$;

-- A request's status, as its submitter sees it: 'submitted' (open), 'in_review',
-- 'changes_requested', 'published' (approved), 'rejected', 'excluded', 'merged' or
-- 'withdrawn'.
create function private.submission_status(p_status public.catalog_review_status)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'open' then 'submitted'
    when 'approved' then 'published'
    else p_status::text
  end
$$;

revoke all on function private.begin_submission(boolean) from public, anon, authenticated, service_role;
revoke all on function private.submission_details(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.set_submitted_pieces(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.submission_snapshot(uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_submitted_release(uuid, uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.submission_status(public.catalog_review_status) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Submitting
-- ---------------------------------------------------------------------------

-- A missing physical release of a game: one the catalog has published, or the
-- caller's own pending game. If the same release is already published, nothing is
-- submitted and its id comes back instead: published records are public.
-- Returns {outcome: 'submitted', submission_id, release_id, game_id} or
-- {outcome: 'published_duplicate', release_id}.
create function public.submit_release(
  p_game uuid,
  p_platform text,
  p_media_format text,
  p_region text,
  p_details jsonb default '{}',
  p_components jsonb default '[]',
  p_note text default null,
  p_physical boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_row public.releases;
  v_existing uuid;
  v_release uuid;
  v_platform uuid;
  v_pairing boolean;
  v_note text := nullif(pg_catalog.btrim(p_note), '');
  v_id uuid;
begin
  v_me := private.begin_submission(true);
  if not coalesce(p_physical, false) or pg_catalog.char_length(v_note) > 1000 then
    raise exception 'invalid submission' using errcode = '22023';
  end if;

  perform 1 from public.games g
  where g.id = p_game
    and (g.status = 'published' or (g.submitted_by = v_me and g.status = 'unverified'))
  for share;
  if not found then
    raise exception 'game unavailable' using errcode = 'P0001';
  end if;

  v_row := private.submission_details(coalesce(p_details, '{}'));
  select r.id into v_existing
  from public.releases r join public.platforms pl on pl.id = r.platform_id
  where r.status = 'published' and r.game_id = p_game and pl.slug = p_platform and r.region_code = p_region
    and r.edition_name is not distinct from v_row.edition_name and r.variant_name is not distinct from v_row.variant_name
    and r.packaging is not distinct from v_row.packaging and r.product_code is not distinct from v_row.product_code
  limit 1;
  if v_existing is not null then
    return pg_catalog.jsonb_build_object('outcome', 'published_duplicate', 'release_id', v_existing);
  end if;

  select c.release_id, c.platform_id, c.created_pairing into v_release, v_platform, v_pairing
  from private.create_submitted_release(v_me, p_game, p_platform, p_media_format, p_region, p_details, p_components) c;

  insert into public.catalog_change_requests (request_type, submitted_by, game_id, release_id, platform_id, details, reason, physical_confirmed, created_game, created_pairing)
  values ('new_release', v_me, p_game, v_release, v_platform, private.submission_snapshot(v_release), v_note, true, false, v_pairing)
  returning id into v_id;
  perform private.record_audit(v_me, 'catalog_submission_created', null, 'Catalog submission',
    pg_catalog.jsonb_build_object('request_id', v_id, 'release_id', v_release, 'game_id', p_game));
  return pg_catalog.jsonb_build_object('outcome', 'submitted', 'submission_id', v_id, 'release_id', v_release, 'game_id', p_game);
end;
$$;

-- A new game with its first physical release. The year is optional: unknown stays
-- unknown. Returns {outcome: 'submitted', submission_id, release_id, game_id}.
create function public.submit_game(
  p_title text,
  p_kind public.game_kind,
  p_first_release_year integer,
  p_platform text,
  p_media_format text,
  p_region text,
  p_details jsonb default '{}',
  p_components jsonb default '[]',
  p_note text default null,
  p_physical boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_title text := pg_catalog.btrim(p_title);
  v_note text := nullif(pg_catalog.btrim(p_note), '');
  v_game uuid;
  v_release uuid;
  v_platform uuid;
  v_pairing boolean;
  v_id uuid;
begin
  v_me := private.begin_submission(true);
  if not coalesce(p_physical, false) or pg_catalog.char_length(v_note) > 1000 or p_kind is null
     or v_title is null or pg_catalog.char_length(v_title) not between 1 and 200
     or (p_first_release_year is not null and p_first_release_year not between 1950 and pg_catalog.date_part('year', pg_catalog.now())::int + 1) then
    raise exception 'invalid submission' using errcode = '22023';
  end if;

  insert into public.games (title, sort_title, kind, first_release_date, first_release_precision, status, submitted_by)
  values (v_title, v_title, p_kind,
          case when p_first_release_year is null then null else pg_catalog.make_date(p_first_release_year, 1, 1) end,
          case when p_first_release_year is null then 'unknown' else 'year' end::public.date_precision,
          'unverified', v_me)
  returning id into v_game;

  select c.release_id, c.platform_id, c.created_pairing into v_release, v_platform, v_pairing
  from private.create_submitted_release(v_me, v_game, p_platform, p_media_format, p_region, p_details, p_components) c;

  insert into public.catalog_change_requests (request_type, submitted_by, game_id, release_id, platform_id, details, reason, physical_confirmed, created_game, created_pairing)
  values ('new_game', v_me, v_game, v_release, v_platform, private.submission_snapshot(v_release), v_note, true, true, v_pairing)
  returning id into v_id;
  perform private.record_audit(v_me, 'catalog_submission_created', null, 'Catalog submission',
    pg_catalog.jsonb_build_object('request_id', v_id, 'release_id', v_release, 'game_id', v_game));
  return pg_catalog.jsonb_build_object('outcome', 'submitted', 'submission_id', v_id, 'release_id', v_release, 'game_id', v_game);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Changing and withdrawing, before review
-- ---------------------------------------------------------------------------

-- The caller's own open request, locked, and its release locked too, which must still
-- be unverified and theirs. Shared by changing and withdrawing.
create function private.lock_open_submission(p_me uuid, p_submission uuid)
returns public.catalog_change_requests
language plpgsql
set search_path = ''
as $$
declare
  req public.catalog_change_requests;
  rel public.releases;
begin
  select * into req from public.catalog_change_requests s
  where s.id = p_submission and s.submitted_by = p_me and s.request_type in ('new_game', 'new_release') and s.status <> 'withdrawn'
  for update;
  if not found or req.release_id is null then
    raise exception 'submission unavailable' using errcode = 'P0001';
  end if;
  select * into rel from public.releases r where r.id = req.release_id for update;
  if req.status <> 'open' or rel.status is distinct from 'unverified' or rel.submitted_by is distinct from p_me then
    raise exception 'submission locked' using errcode = 'P0001';
  end if;
  return req;
end;
$$;
revoke all on function private.lock_open_submission(uuid, uuid) from public, anon, authenticated, service_role;

-- Changes a submission while it's unreviewed. Keys: note; region, media_format;
-- details (the optional details, replaced as a whole); components (replaced); and,
-- for a new game, title, game_kind and first_release_year. The platform can't change:
-- withdraw and submit again. Edits don't count toward the limit. Returns true.
create function public.update_my_submission(p_submission uuid, p_changes jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_sub public.catalog_change_requests;
  v_release public.releases;
  v_row public.releases;
  v_year integer;
  v_constraint text;
begin
  v_me := private.begin_submission(false);
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) <> 'object'
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_changes) k
                where k <> all (array['note', 'region', 'media_format', 'details', 'components', 'title', 'game_kind', 'first_release_year'])) then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  v_sub := private.lock_open_submission(v_me, p_submission);
  -- Already locked by the helper, in this transaction.
  select * into v_release from public.releases r where r.id = v_sub.release_id;

  if (p_changes ?| array['title', 'game_kind', 'first_release_year'])
     and (not v_sub.created_game or not exists (select 1 from public.games g where g.id = v_release.game_id and g.status = 'unverified' and g.submitted_by = v_me)) then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  if p_changes ? 'note' and pg_catalog.char_length(pg_catalog.btrim(p_changes ->> 'note')) > 1000 then
    raise exception 'invalid submission' using errcode = '22023';
  end if;

  begin
    if p_changes ?| array['title', 'game_kind', 'first_release_year'] then
      v_year := case when p_changes ? 'first_release_year' then nullif(p_changes ->> 'first_release_year', '')::integer end;
      if v_year is not null and v_year not between 1950 and pg_catalog.date_part('year', pg_catalog.now())::int + 1 then
        raise exception 'invalid submission' using errcode = '22023';
      end if;
      update public.games g set
        title = case when p_changes ? 'title' then pg_catalog.btrim(p_changes ->> 'title') else g.title end,
        sort_title = case when p_changes ? 'title' then pg_catalog.btrim(p_changes ->> 'title') else g.sort_title end,
        kind = case when p_changes ? 'game_kind' then (p_changes ->> 'game_kind')::public.game_kind else g.kind end,
        first_release_date = case when p_changes ? 'first_release_year' then case when v_year is null then null else pg_catalog.make_date(v_year, 1, 1) end else g.first_release_date end,
        first_release_precision = case when p_changes ? 'first_release_year' then case when v_year is null then 'unknown' else 'year' end::public.date_precision else g.first_release_precision end
      where g.id = v_release.game_id;
    end if;

    if p_changes ? 'region' and not exists (select 1 from public.region_codes rc where rc.code = p_changes ->> 'region') then
      raise exception 'invalid submission' using errcode = '22023';
    end if;
    if p_changes ? 'media_format' and not exists (select 1 from public.platform_media_formats f
                                                  where f.platform_id = v_release.platform_id and f.media_format_code = p_changes ->> 'media_format') then
      raise exception 'invalid submission' using errcode = '22023';
    end if;
    if p_changes ? 'details' then
      v_row := private.submission_details(p_changes -> 'details');
    end if;
    update public.releases r set
      region_code = case when p_changes ? 'region' then p_changes ->> 'region' else r.region_code end,
      media_format_code = case when p_changes ? 'media_format' then p_changes ->> 'media_format' else r.media_format_code end,
      edition_name = case when p_changes ? 'details' then v_row.edition_name else r.edition_name end,
      edition_kind = case when p_changes ? 'details' then v_row.edition_kind else r.edition_kind end,
      variant_name = case when p_changes ? 'details' then v_row.variant_name else r.variant_name end,
      product_code = case when p_changes ? 'details' then v_row.product_code else r.product_code end,
      barcode = case when p_changes ? 'details' then v_row.barcode else r.barcode end,
      local_title = case when p_changes ? 'details' then v_row.local_title else r.local_title end,
      publisher_name = case when p_changes ? 'details' then v_row.publisher_name else r.publisher_name end,
      media_count = case when p_changes ? 'details' then v_row.media_count else r.media_count end,
      packaging = case when p_changes ? 'details' then v_row.packaging else r.packaging end,
      release_date = case when p_changes ? 'details' then v_row.release_date else r.release_date end,
      release_date_precision = case when p_changes ? 'details' then v_row.release_date_precision else r.release_date_precision end
    where r.id = v_release.id;

    if p_changes ? 'components' then
      perform private.set_submitted_pieces(v_release.id, p_changes -> 'components');
    end if;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'releases_pending_submission_key' then
        raise exception 'already submitted' using errcode = 'P0001';
      end if;
      raise exception 'invalid submission' using errcode = '22023';
    when invalid_text_representation or check_violation or numeric_value_out_of_range or not_null_violation
      or string_data_right_truncation or foreign_key_violation or invalid_datetime_format or datetime_field_overflow then
      raise exception 'invalid submission' using errcode = '22023';
  end;

  update public.catalog_change_requests s set
    reason = case when p_changes ? 'note' then nullif(pg_catalog.btrim(p_changes ->> 'note'), '') else s.reason end,
    details = private.submission_snapshot(v_release.id)
  where s.id = v_sub.id;
  perform private.record_audit(v_me, 'catalog_submission_updated', null, 'Catalog submission',
    pg_catalog.jsonb_build_object('request_id', v_sub.id, 'release_id', v_release.id));
  return true;
end;
$$;

-- Withdraws an unreviewed submission. Refused while any copy is linked to its release,
-- so a copy is never removed implicitly. Deletes the release, and the pairing and game
-- only when they're the caller's own unreviewed records and nothing else uses them, so
-- a shared or someone else's record is never deleted. Each is locked before that check,
-- so a concurrent submission can't lose it. The request stays, as 'withdrawn', and
-- still counts toward the limit. Returns true.
create function public.withdraw_my_submission(p_submission uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_sub public.catalog_change_requests;
  v_release public.releases;
begin
  v_me := private.begin_submission(false);
  v_sub := private.lock_open_submission(v_me, p_submission);
  -- Already locked by the helper, in this transaction.
  select * into v_release from public.releases r where r.id = v_sub.release_id;
  if exists (select 1 from public.collection_items c where c.release_id = v_release.id) then
    raise exception 'submission in use' using errcode = 'P0001';
  end if;

  delete from public.releases r where r.id = v_release.id;

  -- The pairing and the game go too, but only when they're the caller's own unreviewed
  -- records (only the caller's submissions set submitted_by to the caller) and nothing
  -- else uses them. Locked first, so a concurrent submission that reuses one either
  -- commits before the check, and keeps it, or waits until after.
  perform 1 from public.game_platforms gp
  where gp.game_id = v_release.game_id and gp.platform_id = v_release.platform_id
  for update;
  if exists (select 1 from public.game_platforms gp
             where gp.game_id = v_release.game_id and gp.platform_id = v_release.platform_id
               and gp.status = 'unverified' and gp.submitted_by = v_me)
     and not exists (select 1 from public.releases r where r.game_id = v_release.game_id and r.platform_id = v_release.platform_id) then
    delete from public.game_platforms gp where gp.game_id = v_release.game_id and gp.platform_id = v_release.platform_id;
  end if;

  perform 1 from public.games g where g.id = v_release.game_id for update;
  if exists (select 1 from public.games g where g.id = v_release.game_id and g.status = 'unverified' and g.submitted_by = v_me)
     and not exists (select 1 from public.releases r where r.game_id = v_release.game_id)
     and not exists (select 1 from public.game_platforms gp where gp.game_id = v_release.game_id)
     and not exists (select 1 from public.game_relations gr where gr.source_game_id = v_release.game_id or gr.target_game_id = v_release.game_id)
     and not exists (select 1 from public.game_aliases ga where ga.game_id = v_release.game_id) then
    delete from public.games g where g.id = v_release.game_id;
  end if;

  update public.catalog_change_requests s set status = 'withdrawn' where s.id = v_sub.id;
  perform private.record_audit(v_me, 'catalog_submission_withdrawn', null, 'Catalog submission withdrawn',
    pg_catalog.jsonb_build_object('request_id', v_sub.id, 'release_id', v_release.id));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Reading the caller's own submissions: safe fields only, never a reviewer
-- ---------------------------------------------------------------------------

-- A page of the caller's submissions, newest first, and how many more they may make.
-- Returns {items, next_before, allowance: {limit, used, next_available_at}}.
create function public.my_catalog_submissions(p_before uuid default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_items jsonb;
  v_last uuid;
  v_more boolean;
  v_used integer;
  v_oldest timestamptz;
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  with page as (
    select s.*, g.slug, g.status as game_status
    from public.catalog_change_requests s
    left join public.games g on g.id = s.game_id
    where s.submitted_by = v_me and s.request_type in ('new_game', 'new_release') and (p_before is null or s.id < p_before)
    order by s.id desc
    limit v_limit + 1
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', p.id, 'kind', p.request_type, 'status', private.submission_status(p.status),
           'created_at', p.created_at, 'updated_at', p.updated_at, 'release_id', p.release_id,
           'game_slug', case when p.game_status = 'published' then p.slug end,
           'title', p.details ->> 'title', 'platform', p.details -> 'platform', 'region', p.details -> 'region',
           'format', p.details -> 'format', 'edition_name', p.details ->> 'edition_name'
         ) order by p.id desc) filter (where p.n <= v_limit), '[]'::jsonb),
         max(p.id::text) filter (where p.n = v_limit)::uuid,
         coalesce(bool_or(p.n > v_limit), false)
  into v_items, v_last, v_more
  from (select page.*, row_number() over (order by page.id desc) as n from page) p;

  select count(*), min(s.created_at) into v_used, v_oldest from public.catalog_change_requests s
  where s.submitted_by = v_me and s.request_type in ('new_game', 'new_release') and s.created_at > pg_catalog.now() - interval '24 hours';
  return pg_catalog.jsonb_build_object(
    'items', v_items,
    'next_before', case when v_more then v_last end,
    'allowance', pg_catalog.jsonb_build_object('limit', 10, 'used', v_used,
      'next_available_at', case when v_used >= 10 then v_oldest + interval '24 hours' end)
  );
end;
$$;

-- One of the caller's submissions, or null. The history snapshot is always there; the
-- reviewer's note is shown, the reviewer never.
create function public.get_my_submission(p_submission uuid)
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
    'editable', s.status = 'open' and r.status = 'unverified' and r.submitted_by = s.submitted_by,
    'my_copies', (select count(*) from public.collection_items c where c.release_id = r.id and c.owner_id = s.submitted_by)
  )
  from public.catalog_change_requests s
  left join public.releases r on r.id = s.release_id
  left join public.games g on g.id = s.game_id
  where s.id = p_submission and s.submitted_by = (select auth.uid()) and s.request_type in ('new_game', 'new_release')
$$;

-- The caller's open or reviewed submission of a release they hold a copy of, for a
-- link from the copy's page. Null otherwise.
create function public.my_submission_for_release(p_release uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from public.catalog_change_requests s
  where s.release_id = p_release and s.submitted_by = (select auth.uid()) and s.status <> 'withdrawn'
  order by s.id desc
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants: signed-in users only
-- ---------------------------------------------------------------------------

revoke all on function public.submit_release(uuid, text, text, text, jsonb, jsonb, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.submit_game(text, public.game_kind, integer, text, text, text, jsonb, jsonb, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.update_my_submission(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.withdraw_my_submission(uuid) from public, anon, authenticated, service_role;
revoke all on function public.my_catalog_submissions(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_my_submission(uuid) from public, anon, authenticated, service_role;
revoke all on function public.my_submission_for_release(uuid) from public, anon, authenticated, service_role;

grant execute on function public.submit_release(uuid, text, text, text, jsonb, jsonb, text, boolean) to authenticated;
grant execute on function public.submit_game(text, public.game_kind, integer, text, text, text, jsonb, jsonb, text, boolean) to authenticated;
grant execute on function public.update_my_submission(uuid, jsonb) to authenticated;
grant execute on function public.withdraw_my_submission(uuid) to authenticated;
grant execute on function public.my_catalog_submissions(uuid, integer) to authenticated;
grant execute on function public.get_my_submission(uuid) to authenticated;
grant execute on function public.my_submission_for_release(uuid) to authenticated;
