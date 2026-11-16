-- M10c Catalog editing: who created each catalog record, and no self-review (D2);
-- recent MFA for sensitive catalog work (D3); verification bound to the revision
-- it attested (D-7). Product owner decisions D-1 to D-8 of the M10c design review.
--
-- 1. Provenance. Every game and release has one row in private.catalog_record_origins,
--    written by a trigger in the same transaction as the record, from the session the
--    database trusts: the signed-in caller, the importer's own login, or a maintenance
--    session. Nothing can change or remove it, except that deleting the creator's
--    account clears the id and marks the creator as removed. A client never writes it.
-- 2. No self-review. The M7b-1 guard also refuses the creator verifying or publishing
--    the record, including a game published through one of its releases, and
--    publishing a record its creator verified. Unknown provenance fails closed:
--    only an administrator may verify or publish it, and not both.
-- 3. Revision-bound verification. A verification is kept with the revision it
--    attested. Any later change to an unpublished record ends it, and publication
--    requires the verification to match the record as it is.
-- 4. Recent MFA. Verifying, publishing, approving and changing published content need
--    a TOTP verification in the last 10 minutes, in each function and, for
--    verification and publication, in the guard too.

-- ---------------------------------------------------------------------------
-- 1. Provenance
-- ---------------------------------------------------------------------------

-- How a catalog record came to exist. `staff`: a staff member created it in the
-- admin. `submission`: a member submitted it. `import`: the catalog importer.
-- `system`: a maintenance session (migrations, operators, tests). `unknown`: a
-- record from before M10c with no evidence, which only the backfill writes.
-- The creator is kept while their account exists. Deleting the account clears it
-- and sets creator_removed, so the row still says a person created it; no copy of
-- the id or anything else about them is kept here (the audit log keeps its plain
-- ids, under the same undecided retention, M4-D10).
create table private.catalog_record_origins (
  id uuid primary key default private.uuid_v7(),
  game_id uuid unique references public.games (id) on delete cascade,
  release_id uuid unique references public.releases (id) on delete cascade,
  origin text not null check (origin in ('staff', 'submission', 'import', 'system', 'unknown')),
  creator_id uuid references public.profiles (id) on delete set null,
  creator_removed boolean not null default false,
  recorded_at timestamptz not null default pg_catalog.now(),
  constraint catalog_record_origins_one_record check ((game_id is null) <> (release_id is null)),
  constraint catalog_record_origins_creator check (
    case when origin in ('staff', 'submission') then (creator_id is not null) <> creator_removed
         else creator_id is null and not creator_removed end)
);

create index catalog_record_origins_creator_idx on private.catalog_record_origins (creator_id) where creator_id is not null;

revoke all on private.catalog_record_origins from public, anon, authenticated, service_role, catalog_importer;

-- Provenance is permanent. The one change allowed is the foreign key clearing the
-- creator once their profile is gone, which also marks them removed. A row goes
-- only with its record. Auth deletes an account as its own role, and the foreign key
-- runs this then, so it's SECURITY DEFINER, as M4's notification triggers are.
create function private.guard_catalog_record_origin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if (old.game_id is not null and exists (select 1 from public.games g where g.id = old.game_id))
       or (old.release_id is not null and exists (select 1 from public.releases r where r.id = old.release_id)) then
      raise exception 'provenance is permanent' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.creator_id is not null and new.creator_id is null
     and (pg_catalog.to_jsonb(new) - array['creator_id', 'creator_removed'])
         = (pg_catalog.to_jsonb(old) - array['creator_id', 'creator_removed'])
     and not exists (select 1 from public.profiles p where p.id = old.creator_id) then
    new.creator_removed := true;
    return new;
  end if;
  raise exception 'provenance is permanent' using errcode = 'P0001';
end;
$$;

create trigger guard_catalog_record_origin before update or delete on private.catalog_record_origins
  for each row execute function private.guard_catalog_record_origin();

-- The verification a record holds, with the revision it attested. Written only by
-- the trigger below, from the record row itself under its row lock.
create table private.catalog_verifications (
  id uuid primary key default private.uuid_v7(),
  game_id uuid unique references public.games (id) on delete cascade,
  release_id uuid unique references public.releases (id) on delete cascade,
  revision bigint not null check (revision > 0),
  verified_at timestamptz not null,
  constraint catalog_verifications_one_record check ((game_id is null) <> (release_id is null))
);

revoke all on private.catalog_verifications from public, anon, authenticated, service_role, catalog_importer;

-- Backfill, before the triggers exist. In order of the evidence: the review request
-- that created the record (a submission), then the audit row of its creation (a staff
-- member, or the importer with its run), else unknown. A creator whose profile is
-- gone is recorded as removed. Unknown is never guessed to be an import or the system.
-- The classification is a function, so the tests can check it on legacy records.
create function private.legacy_catalog_origin(p_kind text, p_id uuid)
returns table (origin text, creator_id uuid, creator_removed boolean)
language sql
stable
set search_path = ''
as $$
  with evidence as (
    select coalesce(
      -- The review request that created it: a member's submission. Its submitter, or,
      -- after their account was deleted, the audit row's plain id.
      (select pg_catalog.jsonb_build_object('origin', 'submission', 'actor', coalesce(s.submitted_by,
                (select a.actor_id from private.audit_events a
                 where a.action = 'catalog_submission_created' and a.metadata ->> 'request_id' = s.id::text
                 order by a.id limit 1)))
       from public.catalog_change_requests s
       where (p_kind = 'game' and s.game_id = p_id and s.created_game) or (p_kind = 'release' and s.release_id = p_id)
       order by s.id limit 1),
      -- The audit row of its creation: a staff member, or the importer with its run.
      (select pg_catalog.jsonb_build_object('origin', case when a.actor_id is not null then 'staff'
                                                         when a.metadata ? 'import_run_id' then 'import'
                                                         else 'unknown' end, 'actor', a.actor_id)
       from private.audit_events a
       where a.action = 'catalog_record_created' and a.metadata ->> 'entity' = p_kind and a.metadata ->> 'id' = p_id::text
       order by a.id limit 1),
      '{"origin": "unknown"}'::jsonb) as j
  )
  select e.j ->> 'origin',
         case when e.j ->> 'origin' in ('staff', 'submission') then p.id end,
         e.j ->> 'origin' in ('staff', 'submission') and p.id is null
  from evidence e
  left join public.profiles p on p.id = (e.j ->> 'actor')::uuid
$$;

insert into private.catalog_record_origins (game_id, origin, creator_id, creator_removed, recorded_at)
select g.id, o.origin, o.creator_id, o.creator_removed, g.created_at
from public.games g cross join lateral private.legacy_catalog_origin('game', g.id) o;
insert into private.catalog_record_origins (release_id, origin, creator_id, creator_removed, recorded_at)
select r.id, o.origin, o.creator_id, o.creator_removed, r.created_at
from public.releases r cross join lateral private.legacy_catalog_origin('release', r.id) o;

-- No verification is carried over: a verification from before M10c attested no known
-- revision, so an unpublished record verified before M10c is verified again before
-- it's published.

-- Records each new game's and release's provenance. A client session is the
-- signed-in caller: a member's submission when the row is theirs, otherwise a staff
-- member, who must hold the catalog role. Anything else from a client is refused, so
-- no client can be taken for the importer or the system. The importer is its own
-- login with no user. Every other session is maintenance. A record inserted already
-- verified, which only maintenance does, keeps that verification at its revision.
create function private.record_catalog_origin()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_role text := coalesce(pg_catalog.current_setting('role', true), 'none');
  v_origin text;
  v_creator uuid;
begin
  if v_role in ('authenticated', 'anon', 'service_role') then
    if v_me is null then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if new.submitted_by is not distinct from v_me then
      v_origin := 'submission';
    elsif private.has_staff_role('catalog_editor') then
      v_origin := 'staff';
    else
      raise exception 'not permitted' using errcode = '42501';
    end if;
    v_creator := v_me;
  elsif v_me is null and (session_user = 'catalog_importer' or v_role = 'catalog_importer') then
    v_origin := 'import';
  else
    v_origin := 'system';
  end if;

  insert into private.catalog_record_origins (game_id, release_id, origin, creator_id)
  values (case when tg_table_name = 'games' then new.id end, case when tg_table_name = 'releases' then new.id end,
          v_origin, v_creator);
  if new.verified_at is not null then
    insert into private.catalog_verifications (game_id, release_id, revision, verified_at)
    values (case when tg_table_name = 'games' then new.id end, case when tg_table_name = 'releases' then new.id end,
            new.revision, new.verified_at);
  end if;
  return null;
end;
$$;

create trigger record_catalog_origin after insert on public.games
  for each row execute function private.record_catalog_origin();
create trigger record_catalog_origin after insert on public.releases
  for each row execute function private.record_catalog_origin();

-- Keeps a record's verification with the revision it attested: a new verification
-- replaces it, and clearing the verification removes it. A verification by someone else
-- in the same transaction (the same now()) still counts as new. Anything this misses
-- leaves the old revision, which publication refuses. A verifier's account deleted
-- through Auth clears verified_by, which changes nothing here; SECURITY DEFINER all the
-- same, as Auth's role can't reach the private schema.
create function private.sync_catalog_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game uuid := case when tg_table_name = 'games' then new.id end;
  v_release uuid := case when tg_table_name = 'releases' then new.id end;
begin
  if new.verified_at is null then
    delete from private.catalog_verifications c
    where c.game_id is not distinct from v_game and c.release_id is not distinct from v_release;
  elsif new.verified_at is distinct from old.verified_at or (new.verified_by is not null and new.verified_by is distinct from old.verified_by) then
    delete from private.catalog_verifications c
    where c.game_id is not distinct from v_game and c.release_id is not distinct from v_release;
    insert into private.catalog_verifications (game_id, release_id, revision, verified_at)
    values (v_game, v_release, new.revision, new.verified_at);
  end if;
  return null;
end;
$$;

create trigger sync_catalog_verification after update on public.games
  for each row when (new.verified_at is distinct from old.verified_at
                    or (new.verified_at is not null and new.verified_by is not null and new.verified_by is distinct from old.verified_by))
  execute function private.sync_catalog_verification();
create trigger sync_catalog_verification after update on public.releases
  for each row when (new.verified_at is distinct from old.verified_at
                    or (new.verified_at is not null and new.verified_by is not null and new.verified_by is distinct from old.verified_by))
  execute function private.sync_catalog_verification();

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

-- A record's provenance row, or null when it has none.
create function private.record_origin(p_kind text, p_id uuid)
returns private.catalog_record_origins
language sql
stable
set search_path = ''
as $$
  select o.* from private.catalog_record_origins o
  where (p_kind = 'game' and o.game_id = p_id) or (p_kind = 'release' and o.release_id = p_id)
$$;

-- Whether the record's verification attests it as it is: verified, at this revision,
-- by the verification that's recorded.
create function private.verification_current(p_kind text, p_id uuid, p_revision bigint, p_verified_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_verified_at is not null and exists (
    select 1 from private.catalog_verifications c
    where ((p_kind = 'game' and c.game_id = p_id) or (p_kind = 'release' and c.release_id = p_id))
      and c.revision = p_revision and c.verified_at = p_verified_at)
$$;

-- Whether p_me created any of these releases or games. A removed creator matches
-- nobody: their account is gone.
create function private.created_by(p_me uuid, p_releases uuid[], p_games uuid[])
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_me is not null and exists (
    select 1 from private.catalog_record_origins o
    where o.creator_id = p_me
      and (o.release_id = any (coalesce(p_releases, '{}')) or o.game_id = any (coalesce(p_games, '{}'))))
$$;

-- The games an exclusion's cascade names.
create function private.cascade_games(p_cascade jsonb)
returns uuid[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg((e ->> 'id')::uuid), '{}')
  from pg_catalog.jsonb_array_elements(coalesce(p_cascade, '[]')) e
  where e ->> 'entity' = 'game'
$$;

-- For the audit row of a verification or publication: whether the record's
-- provenance is unknown, which only an administrator may resolve.
create function private.provenance_note(p_kind text, p_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when coalesce((private.record_origin(p_kind, p_id)).origin, 'unknown') = 'unknown'
              then '{"provenance": "unknown"}'::jsonb else '{}'::jsonb end
$$;

-- Whether a change to this release ends its verification: it's verified and not
-- published. Read before the change.
create function private.release_verification_ends(p_release uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select r.status <> 'published' and r.verified_at is not null from public.releases r where r.id = p_release), false)
$$;

-- What the caller may do with a record, as the record pages show it, naming nobody:
-- how it came to exist, whether the caller created or verified it, and whether its
-- verification is current.
create function private.record_review(p_kind text, p_id uuid, p_status public.catalog_status, p_revision bigint,
                                      p_verified_at timestamptz, p_verified_by uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'origin', coalesce(o.origin, 'unknown'),
    'you_created', coalesce(o.creator_id = (select auth.uid()), false),
    'you_verified', coalesce(p_verified_by = (select auth.uid()), false),
    'verification_current', p_verified_at is not null
      and (p_status = 'published' or private.verification_current(p_kind, p_id, p_revision, p_verified_at)))
  from (select (private.record_origin(p_kind, p_id)).*) o
$$;

-- ---------------------------------------------------------------------------
-- 3. Revisions and the review guard
-- ---------------------------------------------------------------------------

-- The M5c revision trigger, unchanged in what raises a revision. M10c (D-7): a change
-- to an unpublished, verified record also ends its verification, so it's verified
-- again as it now is. A status change (publication, review, exclusion) doesn't; the
-- verification then no longer matches the revision, and publication refuses it.
create or replace function private.bump_catalog_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (pg_catalog.to_jsonb(new) - array['revision', 'updated_at', 'verified_at', 'verified_by', 'search_key', 'search_compact', 'search_words', 'local_title_key'])
       is distinct from (pg_catalog.to_jsonb(old) - array['revision', 'updated_at', 'verified_at', 'verified_by', 'search_key', 'search_compact', 'search_words', 'local_title_key'])
     or new.revision is distinct from old.revision then
    new.revision := old.revision + 1;
    if old.status not in ('published', 'merged', 'excluded') and new.status = old.status
       and old.verified_at is not null and new.verified_at is not distinct from old.verified_at then
      new.verified_at := null;
      new.verified_by := null;
    end if;
  end if;
  return new;
end;
$$;

-- A game's aliases and relations are part of what a verification attests, like a
-- release's markets, pieces and requirements (M5b): changing one raises the game's
-- revision. A relation raises both games'.
create function private.bump_game_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'game_aliases' then
    update public.games g set revision = g.revision + 1
    where g.id = case when tg_op = 'DELETE' then old.game_id else new.game_id end;
  else
    update public.games g set revision = g.revision + 1
    where g.id in (select x from unnest(case when tg_op = 'DELETE' then array[old.source_game_id, old.target_game_id]
                                             when tg_op = 'INSERT' then array[new.source_game_id, new.target_game_id]
                                             else array[old.source_game_id, old.target_game_id, new.source_game_id, new.target_game_id] end) x);
  end if;
  return null;
end;
$$;

create trigger bump_game_revision after insert or update or delete on public.game_aliases
  for each row execute function private.bump_game_revision();
create trigger bump_game_revision after insert or update or delete on public.game_relations
  for each row execute function private.bump_game_revision();

-- The M7b-1 guard, extended (M10c). For a signed-in caller verifying a record or
-- making it published:
-- - a TOTP verification in the last 10 minutes (D3), behind each function's own check;
-- - never its creator (D2), whatever their role;
-- - unknown provenance: an administrator only (D-2).
-- And for a first publication, from unverified or under review:
-- - a verifier who's known and isn't the creator, nor, for unknown provenance, the
--   publisher;
-- - a verification that matches the record as it is (D-7).
-- A restoration from an exclusion isn't a first publication: restore_exclusion checks
-- its own rules. The submission rules are as before.
create or replace function private.guard_submitted_record()
returns trigger
language plpgsql
set search_path = ''
as $$
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
    if v_release and new.region_unknown_confirmed and not old.region_unknown_confirmed then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  elsif v_req.status <> 'in_review' then
    raise exception 'submission not in review' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- A platform pairing is published only with a release. A signed-in caller doing so
-- needs a recent TOTP verification, behind publish_release's own check (D-8).
create function private.guard_pairing_publication()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'published' and new.status = 'published'
     and coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon')
     and not private.mfa_recent(interval '10 minutes') then
    raise exception 'reauthentication required' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger guard_pairing_publication before update on public.game_platforms
  for each row execute function private.guard_pairing_publication();

-- ---------------------------------------------------------------------------
-- 4. Functions: recent MFA (D3), the creator (D-4) and current verifications (D-7)
-- ---------------------------------------------------------------------------
-- Each is its previous definition with the M10c changes marked. Replacing keeps its
-- grants.

create or replace function public.verify_game(p_game uuid, p_reason text, p_expected_revision bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_game public.games;
begin
  v_me := private.begin_catalog_edit();
  -- M10c (D3): a TOTP verification in the last 10 minutes.
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  if p_expected_revision is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select * into v_game from public.games g where g.id = p_game for update;
  if not found or v_game.status not in ('unverified', 'under_review', 'published') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_game.revision <> p_expected_revision then
    raise exception 'record changed' using errcode = 'P0001';
  end if;
  -- Already verified as it is. M10c (D-7): a verification of an earlier revision
  -- no longer counts, and the record is verified again.
  if v_game.verified_at is not null
     and (v_game.status = 'published' or private.verification_current('game', v_game.id, v_game.revision, v_game.verified_at)) then
    return false;
  end if;
  -- M10c (D-7): the statement's own time, so every verification is distinct, even two in
  -- one transaction, and is kept with the revision it attested.
  update public.games g set verified_at = pg_catalog.clock_timestamp(), verified_by = v_me where g.id = p_game;
  perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'game', p_game, v_reason,
    pg_catalog.jsonb_build_object('revision', v_game.revision) || private.provenance_note('game', p_game));
  return true;
end;
$$;

create or replace function public.verify_release(p_release uuid, p_reason text, p_expected_revision bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_release public.releases;
begin
  v_me := private.begin_catalog_edit();
  -- M10c (D3): a TOTP verification in the last 10 minutes.
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  if p_expected_revision is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select * into v_release from public.releases r where r.id = p_release for update;
  if not found or v_release.status not in ('unverified', 'under_review', 'published') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_release.revision <> p_expected_revision then
    raise exception 'record changed' using errcode = 'P0001';
  end if;
  -- Already verified as it is. M10c (D-7): a verification of an earlier revision
  -- no longer counts, and the record is verified again.
  if v_release.verified_at is not null
     and (v_release.status = 'published' or private.verification_current('release', v_release.id, v_release.revision, v_release.verified_at)) then
    return false;
  end if;
  if v_release.edition_name is null or v_release.edition_kind is null or v_release.media_count is null
     or (v_release.region_code = 'unknown' and not v_release.region_unknown_confirmed) then
    raise exception 'release incomplete' using errcode = '22023';
  end if;
  -- M10c (D-7): the statement's own time, so every verification is distinct, even two in
  -- one transaction, and is kept with the revision it attested.
  update public.releases r set verified_at = pg_catalog.clock_timestamp(), verified_by = v_me where r.id = p_release;
  perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('revision', v_release.revision) || private.provenance_note('release', p_release));
  return true;
end;
$$;

create or replace function public.publish_release(p_release uuid, p_reason text, p_expected_revision bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_game_id uuid;
  v_game public.games;
  v_release public.releases;
  v_pairing public.catalog_status;
  v_slug text;
begin
  v_me := private.begin_catalog_edit();
  -- M10c (D3): a TOTP verification in the last 10 minutes.
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  if p_expected_revision is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;

  select r.game_id into v_game_id from public.releases r where r.id = p_release;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  select * into v_game from public.games g where g.id = v_game_id for update;
  select * into v_release from public.releases r where r.id = p_release for update;
  if v_release.status = 'published' then
    return false;
  end if;
  if v_release.status not in ('unverified', 'under_review') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_release.revision <> p_expected_revision then
    raise exception 'record changed' using errcode = 'P0001';
  end if;
  if v_release.verified_at is null then
    raise exception 'release not verified' using errcode = 'P0001';
  end if;

  select gp.status into v_pairing from public.game_platforms gp
  where gp.game_id = v_release.game_id and gp.platform_id = v_release.platform_id for update;
  if v_pairing not in ('unverified', 'under_review', 'published') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;

  if v_game.status <> 'published' then
    if v_game.status not in ('unverified', 'under_review') then
      raise exception 'record unavailable' using errcode = 'P0001';
    end if;
    if v_game.verified_at is null then
      raise exception 'game not verified' using errcode = 'P0001';
    end if;
    v_slug := coalesce(v_game.slug, private.assign_game_slug(v_game.title));
    update public.games g set status = 'published', slug = v_slug, submitted_by = null where g.id = v_game.id;
    perform private.record_catalog_audit(v_me, 'catalog_record_published', 'game', v_game.id, v_reason,
      pg_catalog.jsonb_build_object('slug', v_slug, 'with_release_id', p_release) || private.provenance_note('game', v_game.id));
  end if;

  if v_pairing <> 'published' then
    update public.game_platforms gp set status = 'published', submitted_by = null
    where gp.game_id = v_release.game_id and gp.platform_id = v_release.platform_id;
  end if;
  update public.releases r set status = 'published', submitted_by = null where r.id = p_release;

  perform private.record_catalog_audit(v_me, 'catalog_record_published', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('game_id', v_release.game_id, 'platform_id', v_release.platform_id, 'revision', v_release.revision) || private.provenance_note('release', p_release));
  return true;
end;
$$;

create or replace function public.approve_submission(
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
  -- M10c (D3): a TOTP verification in the last 10 minutes.
  perform private.require_recent_mfa();
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
    if v_req.created_game and v_game.status <> 'published'
       and not private.verification_current('game', v_game.id, v_game.revision, v_game.verified_at) then
      perform public.verify_game(v_game.id, v_reason, p_game_revision);
    end if;
    if not private.verification_current('release', v_rel.id, v_rel.revision, v_rel.verified_at) then
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

create or replace function public.update_game(p_game uuid, p_changes jsonb, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_keys text[];
  v_old public.games;
  v_new public.games;
  v_changed text[];
  v_clear boolean;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_keys := private.change_keys(p_changes, array['first_release_date', 'first_release_precision', 'kind', 'sort_title', 'summary', 'title']);

  select * into v_old from public.games g where g.id = p_game for update;
  if not found or v_old.status in ('merged', 'excluded') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_old.status = 'published' and v_reason is null then
    raise exception 'reason required' using errcode = '22023';
  end if;
  -- M10c (D3): changing a published game needs a recent TOTP verification.
  if v_old.status = 'published' then
    perform private.require_recent_mfa();
  end if;

  v_new := pg_catalog.jsonb_populate_record(v_old, p_changes);
  select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_changed
  from unnest(v_keys) k
  where pg_catalog.to_jsonb(v_old) -> k is distinct from pg_catalog.to_jsonb(v_new) -> k;
  if cardinality(v_changed) = 0 then
    return false;
  end if;

  -- M10c (D-7): any change ends an unpublished game's verification.
  v_clear := v_old.status <> 'published' and v_old.verified_at is not null;

  if v_new.kind <> 'compilation' and exists (
    select 1 from public.game_relations gr where gr.source_game_id = p_game and gr.relation = 'contains'
  ) then
    raise exception 'a game that contains others must stay a compilation' using errcode = 'check_violation';
  end if;

  update public.games g set
    title = v_new.title,
    sort_title = v_new.sort_title,
    kind = v_new.kind,
    summary = v_new.summary,
    first_release_date = v_new.first_release_date,
    first_release_precision = v_new.first_release_precision,
    verified_at = case when v_clear then null else g.verified_at end,
    verified_by = case when v_clear then null else g.verified_by end
  where g.id = p_game;

  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'game', p_game, v_reason,
    pg_catalog.jsonb_build_object('fields', v_changed, 'verification_cleared', v_clear));
  return true;
end;
$$;

create or replace function public.update_release(p_release uuid, p_changes jsonb, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_keys text[];
  v_old public.releases;
  v_new public.releases;
  v_changed text[];
  v_cleared boolean;
  v_status public.catalog_status;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_keys := private.change_keys(p_changes, array[
    'barcode', 'edition_kind', 'edition_name', 'languages', 'local_title', 'media_count', 'media_format_code', 'media_playability',
    'packaging', 'product_code', 'publisher_name', 'rating_labels', 'region_code', 'region_unknown_confirmed', 'release_date',
    'release_date_precision', 'variant_name'
  ]);
  v_status := private.lock_release_for_edit(p_release, v_reason);
  -- M10c (D3): changing a published release needs a recent TOTP verification.
  if v_status = 'published' then
    perform private.require_recent_mfa();
  end if;
  -- M10c (D-7): any change ends an unpublished release's verification.
  v_cleared := private.release_verification_ends(p_release);

  select * into v_old from public.releases r where r.id = p_release;
  v_new := pg_catalog.jsonb_populate_record(v_old, p_changes);
  -- Confirming an unknown region applies only while the region is unknown.
  if v_new.region_code <> 'unknown' then
    v_new.region_unknown_confirmed := false;
  end if;
  select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_changed
  from unnest(array['barcode', 'edition_kind', 'edition_name', 'languages', 'local_title', 'media_count', 'media_format_code',
                    'media_playability', 'packaging', 'product_code', 'publisher_name', 'rating_labels', 'region_code',
                    'region_unknown_confirmed', 'release_date', 'release_date_precision', 'variant_name']) k
  where pg_catalog.to_jsonb(v_old) -> k is distinct from pg_catalog.to_jsonb(v_new) -> k;
  if cardinality(v_changed) = 0 then
    return false;
  end if;

  update public.releases r set
    region_code = v_new.region_code,
    region_unknown_confirmed = v_new.region_unknown_confirmed,
    edition_name = v_new.edition_name,
    edition_kind = v_new.edition_kind,
    variant_name = v_new.variant_name,
    product_code = v_new.product_code,
    barcode = v_new.barcode,
    local_title = v_new.local_title,
    publisher_name = v_new.publisher_name,
    media_format_code = v_new.media_format_code,
    media_count = v_new.media_count,
    media_playability = v_new.media_playability,
    packaging = v_new.packaging,
    languages = v_new.languages,
    rating_labels = v_new.rating_labels,
    release_date = v_new.release_date,
    release_date_precision = v_new.release_date_precision
  where r.id = p_release;

  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('fields', v_changed, 'verification_cleared', v_cleared));
  return true;
end;
$$;

create or replace function public.set_release_markets(p_release uuid, p_markets text[], p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_old text[];
  v_new text[];
  v_cleared boolean;
  v_status public.catalog_status;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if cardinality(p_markets) > 250 or array_position(p_markets, null) is not null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  v_status := private.lock_release_for_edit(p_release, v_reason);
  -- M10c (D3): changing a published release needs a recent TOTP verification.
  if v_status = 'published' then
    perform private.require_recent_mfa();
  end if;
  -- M10c (D-7): any change ends an unpublished release's verification.
  v_cleared := private.release_verification_ends(p_release);

  select coalesce(pg_catalog.array_agg(m.market_code order by m.market_code), '{}') into v_old
  from public.release_markets m where m.release_id = p_release;
  select coalesce(pg_catalog.array_agg(distinct x order by x), '{}') into v_new from unnest(coalesce(p_markets, '{}')) x;
  if v_old = v_new then
    return false;
  end if;

  delete from public.release_markets m where m.release_id = p_release and not (m.market_code = any (v_new));
  insert into public.release_markets (release_id, market_code)
  select p_release, x from unnest(v_new) x
  on conflict (release_id, market_code) do nothing;

  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('fields', array['markets'], 'verification_cleared', v_cleared));
  return true;
end;
$$;

create or replace function public.set_release_components(p_release uuid, p_components jsonb, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_old jsonb;
  v_new jsonb;
  v_cleared boolean;
  v_status public.catalog_status;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if p_components is null or pg_catalog.jsonb_typeof(p_components) <> 'array' or pg_catalog.jsonb_array_length(p_components) > 50
     or exists (select 1 from pg_catalog.jsonb_array_elements(p_components) e
                where pg_catalog.jsonb_typeof(e) <> 'object'
                   or not (select coalesce(pg_catalog.array_agg(k), '{}') from pg_catalog.jsonb_object_keys(e) k)
                          operator(pg_catalog.<@) array['kind', 'label', 'media_format_code', 'platform_id', 'quantity']) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  v_status := private.lock_release_for_edit(p_release, v_reason);
  -- M10c (D3): changing a published release needs a recent TOTP verification.
  if v_status = 'published' then
    perform private.require_recent_mfa();
  end if;
  -- M10c (D-7): any change ends an unpublished release's verification.
  v_cleared := private.release_verification_ends(p_release);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', c.kind, 'label', c.label, 'quantity', c.quantity,
           'media_format_code', c.media_format_code, 'platform_id', c.platform_id) order by c.kind, c.label), '[]')
  into v_old from public.release_components c where c.release_id = p_release;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', x.kind, 'label', x.label, 'quantity', coalesce(x.quantity, 1),
           'media_format_code', x.media_format_code, 'platform_id', x.platform_id) order by x.kind, x.label), '[]')
  into v_new from pg_catalog.jsonb_to_recordset(p_components) as x(kind public.component_kind, label text, quantity smallint, media_format_code text, platform_id uuid);
  if v_old = v_new then
    return false;
  end if;

  delete from public.release_components c where c.release_id = p_release;
  insert into public.release_components (release_id, kind, label, quantity, media_format_code, platform_id)
  select p_release, x.kind, x.label, coalesce(x.quantity, 1), x.media_format_code, x.platform_id
  from pg_catalog.jsonb_to_recordset(p_components) as x(kind public.component_kind, label text, quantity smallint, media_format_code text, platform_id uuid);

  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('fields', array['components'], 'verification_cleared', v_cleared));
  return true;
end;
$$;

create or replace function public.set_release_requirements(p_release uuid, p_requirements jsonb, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_old jsonb;
  v_new jsonb;
  v_cleared boolean;
  v_status public.catalog_status;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if p_requirements is null or pg_catalog.jsonb_typeof(p_requirements) <> 'array' or pg_catalog.jsonb_array_length(p_requirements) > 20
     or exists (select 1 from pg_catalog.jsonb_array_elements(p_requirements) e
                where pg_catalog.jsonb_typeof(e) <> 'object'
                   or not (select coalesce(pg_catalog.array_agg(k), '{}') from pg_catalog.jsonb_object_keys(e) k)
                          operator(pg_catalog.<@) array['level', 'note', 'requirement_code']) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  v_status := private.lock_release_for_edit(p_release, v_reason);
  -- M10c (D3): changing a published release needs a recent TOTP verification.
  if v_status = 'published' then
    perform private.require_recent_mfa();
  end if;
  -- M10c (D-7): any change ends an unpublished release's verification.
  v_cleared := private.release_verification_ends(p_release);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('requirement_code', h.requirement_code, 'level', h.level, 'note', h.note)
           order by h.requirement_code), '[]')
  into v_old from public.release_hardware_requirements h where h.release_id = p_release;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('requirement_code', x.requirement_code, 'level', x.level, 'note', x.note)
           order by x.requirement_code), '[]')
  into v_new from pg_catalog.jsonb_to_recordset(p_requirements) as x(requirement_code text, level public.requirement_level, note text);
  if v_old = v_new then
    return false;
  end if;

  delete from public.release_hardware_requirements h where h.release_id = p_release;
  insert into public.release_hardware_requirements (release_id, requirement_code, level, note)
  select p_release, x.requirement_code, x.level, x.note
  from pg_catalog.jsonb_to_recordset(p_requirements) as x(requirement_code text, level public.requirement_level, note text);

  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('fields', array['requirements'], 'verification_cleared', v_cleared));
  return true;
end;
$$;

create or replace function public.add_game_alias(
  p_game uuid,
  p_title text,
  p_kind public.game_alias_kind,
  p_language_code text default null,
  p_region_code text default null,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_title text;
  v_game_title text;
  v_id uuid;
  v_status public.catalog_status;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_title := pg_catalog.btrim(p_title);
  if p_kind is null or v_title is null or private.catalog_search_key(v_title) is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  -- M10c: locked for update, as the alias raises the game's revision.
  select g.title, g.status into v_game_title, v_status from public.games g where g.id = p_game and g.status not in ('merged', 'excluded') for update;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  -- M10c (D3): a published game's aliases are public; changing them needs a recent TOTP verification.
  if v_status = 'published' then
    perform private.require_recent_mfa();
  end if;
  if private.catalog_search_key(v_title) = private.catalog_search_key(v_game_title) then
    raise exception 'alias repeats the title' using errcode = '22023';
  end if;

  insert into public.game_aliases (game_id, title, kind, language_code, region_code)
  values (p_game, v_title, p_kind, p_language_code, p_region_code)
  on conflict (game_id, search_key, language_code, region_code) do nothing
  returning id into v_id;
  if v_id is null then
    select a.id into v_id from public.game_aliases a
    where a.game_id = p_game and a.search_key = private.catalog_search_key(v_title)
      and a.language_code is not distinct from p_language_code and a.region_code is not distinct from p_region_code;
    return v_id;
  end if;

  perform private.record_catalog_audit(v_me, 'catalog_alias_added', 'game', p_game, v_reason,
    pg_catalog.jsonb_build_object('alias_id', v_id, 'title', v_title, 'kind', p_kind,
      'language_code', p_language_code, 'region_code', p_region_code));
  return v_id;
end;
$$;

create or replace function public.remove_game_alias(p_alias uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_alias public.game_aliases;
  v_status public.catalog_status;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  select a.* into v_alias from public.game_aliases a where a.id = p_alias;
  if not found then
    return false;
  end if;
  -- M10c: locked for update, as removing the alias raises the game's revision.
  select g.status into v_status from public.games g where g.id = v_alias.game_id for update;
  -- M10c (D3): a published game's aliases are public; changing them needs a recent TOTP verification.
  if v_status = 'published' then
    perform private.require_recent_mfa();
  end if;
  delete from public.game_aliases a where a.id = p_alias returning a.* into v_alias;
  if not found then
    return false;
  end if;
  perform private.record_catalog_audit(v_me, 'catalog_alias_removed', 'game', v_alias.game_id, v_reason,
    pg_catalog.jsonb_build_object('alias_id', v_alias.id, 'title', v_alias.title, 'kind', v_alias.kind,
      'language_code', v_alias.language_code, 'region_code', v_alias.region_code));
  return true;
end;
$$;

create or replace function public.set_game_relation(
  p_source uuid,
  p_target uuid,
  p_relation public.game_relation_type,
  p_position smallint default null,
  p_note text default null,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if p_relation is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  if (select count(*) from public.games g where g.id in (p_source, p_target) and g.status not in ('merged', 'excluded')) <> 2 then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  -- M10c: locked for update, as the relation raises both games' revisions.
  perform 1 from public.games g where g.id in (p_source, p_target) order by g.id for update;
  -- M10c (D3): a relation between two published games is public; changing it needs a
  -- recent TOTP verification.
  if (select count(*) from public.games g where g.id in (p_source, p_target) and g.status = 'published') = 2 then
    perform private.require_recent_mfa();
  end if;
  insert into public.game_relations (source_game_id, target_game_id, relation, position, note)
  values (p_source, p_target, p_relation, p_position, p_note)
  on conflict (source_game_id, target_game_id, relation) do update
    set position = excluded.position, note = excluded.note
    where (public.game_relations.position, public.game_relations.note) is distinct from (excluded.position, excluded.note);
  if not found then
    return false;
  end if;
  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'game_relation', p_source, v_reason,
    pg_catalog.jsonb_build_object('target_id', p_target, 'relation', p_relation));
  return true;
end;
$$;

create or replace function public.exclude_release(
  p_release uuid,
  p_token text,
  p_reason_code text,
  p_reason text,
  p_owner_note text default null,
  p_acknowledge_cascade boolean default false,
  p_acknowledge_copies boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_code private.exclusion_reason;
  v_note text := nullif(pg_catalog.btrim(p_owner_note), '');
  v_locked uuid[];
  v_plan jsonb;
  rel public.releases;
  req public.catalog_change_requests;
  v_items uuid[];
  v_owners uuid[];
  v_id uuid;
  v_now timestamptz := pg_catalog.now();
  v_owner uuid;
  v_count integer;
  v_notified uuid := null;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  begin
    v_code := p_reason_code::private.exclusion_reason;
  exception when others then
    raise exception 'invalid exclusion' using errcode = '22023';
  end;
  if v_code is null or p_token is null or pg_catalog.char_length(v_note) > 1000 then
    raise exception 'invalid exclusion' using errcode = '22023';
  end if;

  -- 1. Profiles first, before any catalog row.
  v_locked := private.exclusion_profiles(v_me, p_release, null);
  perform 1 from public.profiles p where p.id = any (v_locked) order by p.id for key share;

  -- 2. Catalog rows, then the plan again under the locks.
  rel := private.lock_exclusion_records(p_release);
  v_plan := private.exclusion_plan(p_release);
  if v_plan is null then
    raise exception 'release unavailable' using errcode = 'P0001';
  end if;
  if v_plan ->> 'token' is distinct from p_token then
    raise exception 'preview stale' using errcode = 'P0001';
  end if;
  if private.exclusion_involves(v_me, p_release, v_plan -> 'cascade') then
    raise exception 'own submission' using errcode = 'P0001';
  end if;
  -- M10c (D-4): never a release, or a game it takes with it, that the caller created.
  if private.created_by(v_me, array[p_release], private.cascade_games(v_plan -> 'cascade')) then
    raise exception 'own record' using errcode = 'P0001';
  end if;
  -- M10c (D-5): excluding a published release needs a recent TOTP verification.
  if rel.status = 'published' then
    perform private.require_recent_mfa();
  end if;
  if pg_catalog.jsonb_array_length(v_plan -> 'blocking') > 0 then
    raise exception 'exclusion blocked' using errcode = 'P0001';
  end if;
  if (pg_catalog.jsonb_array_length(v_plan -> 'cascade') > 0 and not coalesce(p_acknowledge_cascade, false))
     or ((v_plan ->> 'copies')::bigint > 0 and not coalesce(p_acknowledge_copies, false)) then
    raise exception 'acknowledgement required' using errcode = 'P0001';
  end if;

  -- 3. Anyone referenced or owning a copy now, who wasn't locked before: no waiting.
  perform private.lock_new_profiles(v_locked, private.exclusion_profiles(v_me, p_release, null));

  -- 4. The copies. None can be added or moved away while the release is locked.
  select coalesce(pg_catalog.array_agg(x.id order by x.id), '{}'), coalesce(pg_catalog.array_agg(x.owner_id order by x.id), '{}')
  into v_items, v_owners
  from (
    select c.id, c.owner_id from public.collection_items c
    where c.release_id = rel.id and c.record_status = 'active'
    order by c.id
    for update
  ) x;

  if v_plan ->> 'request_id' is not null then
    select * into req from public.catalog_change_requests s where s.id = (v_plan ->> 'request_id')::uuid;
  end if;

  insert into private.catalog_exclusions (
    release_id, excluded_by, excluded_at, reason_code, staff_reason, owner_note, previous_status,
    request_id, previous_request, cascade, copies_preserved, owners_affected)
  values (
    rel.id, v_me, v_now, v_code, v_reason, v_note, rel.status,
    req.id,
    case when req.id is null then null else pg_catalog.jsonb_build_object(
      'status', req.status, 'reviewed_by', req.reviewed_by, 'reviewed_at', req.reviewed_at, 'reviewer_note', req.reviewer_note) end,
    v_plan -> 'cascade', pg_catalog.cardinality(v_items), (select count(distinct o) from pg_catalog.unnest(v_owners) o))
  returning id into v_id;

  -- 5. The changes. The request first: the M7b-1 guard refuses changes to a record
  --    whose submission is still active.
  if req.id is not null then
    update public.catalog_change_requests s set
      status = 'excluded', reviewed_by = v_me, reviewed_at = v_now, reviewer_note = v_note
    where s.id = req.id;
  end if;
  update public.releases r set status = 'excluded' where r.id = rel.id;
  update public.games g set status = 'excluded'
  where g.id in (select (e ->> 'id')::uuid from pg_catalog.jsonb_array_elements(v_plan -> 'cascade') e where e ->> 'entity' = 'game');
  update public.game_platforms gp set status = 'excluded'
  where exists (select 1 from pg_catalog.jsonb_array_elements(v_plan -> 'cascade') e
                where e ->> 'entity' = 'pairing' and (e ->> 'game_id')::uuid = gp.game_id and (e ->> 'platform_id')::uuid = gp.platform_id);

  -- Only the preservation status and its time change; the copy, its private details
  -- and every piece record stay as they are.
  update public.collection_items c set record_status = 'invalid_preserved', invalidated_at = v_now
  where c.id = any (v_items);
  insert into private.catalog_exclusion_copies (exclusion_id, item_id, owner_id)
  select v_id, i, o from rows from (pg_catalog.unnest(v_items), pg_catalog.unnest(v_owners)) as x(i, o);

  -- 6. Each affected person once (D8): the submitter by their submission, every other
  --    owner by their copies. Nobody is told who acted.
  if req.id is not null and req.submitted_by is not null then
    perform private.notify(req.submitted_by, null, 'catalog_submission', null,
      pg_catalog.jsonb_build_object('status', 'excluded', 'submission_id', req.id, 'exclusion_id', v_id));
    v_notified := req.submitted_by;
  end if;
  for v_owner, v_count in
    select o, count(*)::integer from pg_catalog.unnest(v_owners) o where o is distinct from v_notified group by o order by o
  loop
    perform private.notify(v_owner, null, 'catalog_exclusion', null,
      pg_catalog.jsonb_build_object('status', 'excluded', 'exclusion_id', v_id, 'copies', v_count));
  end loop;

  perform private.record_catalog_audit(v_me, 'catalog_release_excluded', 'release', rel.id, v_reason,
    pg_catalog.jsonb_build_object('exclusion_id', v_id, 'reason_code', v_code, 'previous_status', rel.status,
      'cascade', pg_catalog.jsonb_array_length(v_plan -> 'cascade'), 'copies', pg_catalog.cardinality(v_items)));
  return pg_catalog.jsonb_build_object('exclusion_id', v_id, 'copies', pg_catalog.cardinality(v_items),
    'owners', (select count(distinct o) from pg_catalog.unnest(v_owners) o));
end;
$$;

create or replace function public.restore_exclusion(p_exclusion uuid, p_expected_version integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  ex private.catalog_exclusions;
  v_locked uuid[];
  rel public.releases;
  v_blocker text;
  v_items uuid[];
  v_owners uuid[];
  v_prev jsonb;
  v_owner uuid;
  v_count integer;
  v_submitter uuid;
begin
  perform private.lock_catalog_edits();
  v_me := private.require_active_staff('admin');
  perform 1 from public.profiles p where p.id = v_me for key share;
  v_reason := private.require_reason(p_reason);
  if p_expected_version is null then
    raise exception 'invalid restoration' using errcode = '22023';
  end if;
  select * into ex from private.catalog_exclusions e where e.id = p_exclusion;
  if not found then
    raise exception 'exclusion unavailable' using errcode = 'P0001';
  end if;

  -- 1. Profiles first.
  v_locked := private.exclusion_profiles(v_me, ex.release_id, ex.id);
  perform 1 from public.profiles p where p.id = any (v_locked) order by p.id for key share;

  -- 2. The exclusion record, then the catalog rows.
  select * into ex from private.catalog_exclusions e where e.id = p_exclusion for update;
  if ex.version <> p_expected_version then
    raise exception 'request conflict' using errcode = 'P0001';
  end if;
  if ex.excluded_by = v_me then
    raise exception 'own exclusion' using errcode = 'P0001';
  end if;
  if private.exclusion_involves(v_me, ex.release_id, ex.cascade) then
    raise exception 'own submission' using errcode = 'P0001';
  end if;
  -- M10c (D-4): never a release, or a game it brings back, that the caller created.
  if private.created_by(v_me, array[ex.release_id], private.cascade_games(ex.cascade)) then
    raise exception 'own record' using errcode = 'P0001';
  end if;
  -- M10c (D-5): bringing anything back as published needs a recent TOTP verification.
  if ex.previous_status = 'published'
     or exists (select 1 from pg_catalog.jsonb_array_elements(ex.cascade) e where e ->> 'previous_status' = 'published') then
    perform private.require_recent_mfa();
  end if;
  rel := private.lock_exclusion_records(ex.release_id);
  v_blocker := private.restore_blocker(ex);
  if v_blocker is not null then
    raise exception '%', v_blocker using errcode = 'P0001';
  end if;

  -- 3. Anyone not locked before, without waiting.
  perform private.lock_new_profiles(v_locked, private.exclusion_profiles(v_me, ex.release_id, ex.id));

  -- 4. Only this exclusion's copies, still on the release and still preserved by it.
  select coalesce(pg_catalog.array_agg(x.id order by x.id), '{}'), coalesce(pg_catalog.array_agg(x.owner_id order by x.id), '{}')
  into v_items, v_owners
  from (
    select c.id, c.owner_id
    from public.collection_items c
    join private.catalog_exclusion_copies ec on ec.item_id = c.id and ec.exclusion_id = ex.id
    where c.release_id = ex.release_id and c.record_status = 'invalid_preserved' and c.invalidated_at = ex.excluded_at
    order by c.id
    for update of c
  ) x;

  -- 5. Records first, the request last: the M7b-1 guard refuses changes to a record
  --    whose submission is active.
  update public.releases r set status = ex.previous_status where r.id = ex.release_id;
  update public.games g set status = (e ->> 'previous_status')::public.catalog_status
  from pg_catalog.jsonb_array_elements(ex.cascade) e
  where e ->> 'entity' = 'game' and g.id = (e ->> 'id')::uuid;
  update public.game_platforms gp set status = (e ->> 'previous_status')::public.catalog_status
  from pg_catalog.jsonb_array_elements(ex.cascade) e
  where e ->> 'entity' = 'pairing' and gp.game_id = (e ->> 'game_id')::uuid and gp.platform_id = (e ->> 'platform_id')::uuid;
  if ex.request_id is not null then
    v_prev := ex.previous_request;
    update public.catalog_change_requests s set
      status = (v_prev ->> 'status')::public.catalog_review_status,
      -- A reviewer whose account is gone stays gone.
      reviewed_by = (select p.id from public.profiles p where p.id = (v_prev ->> 'reviewed_by')::uuid),
      reviewed_at = (v_prev ->> 'reviewed_at')::timestamptz,
      reviewer_note = v_prev ->> 'reviewer_note'
    where s.id = ex.request_id
    returning s.submitted_by into v_submitter;
  end if;
  update public.collection_items c set record_status = 'active', invalidated_at = null
  where c.id = any (v_items);
  update private.catalog_exclusions e set
    restored_at = pg_catalog.now(), restored_by = v_me, restore_reason = v_reason,
    copies_restored = pg_catalog.cardinality(v_items), version = e.version + 1
  where e.id = ex.id;

  -- 6. Each person whose copies came back, once, and the submitter.
  for v_owner, v_count in
    select x.o, count(x.i)::integer
    from (select o, i from rows from (pg_catalog.unnest(v_owners), pg_catalog.unnest(v_items)) as y(o, i)
          union all select v_submitter, null where v_submitter is not null) x
    group by x.o order by x.o
  loop
    perform private.notify(v_owner, null, 'catalog_exclusion', null,
      pg_catalog.jsonb_build_object('status', 'restored', 'exclusion_id', ex.id, 'copies', v_count));
  end loop;

  perform private.record_catalog_audit(v_me, 'catalog_exclusion_restored', 'release', ex.release_id, v_reason,
    pg_catalog.jsonb_build_object('exclusion_id', ex.id, 'restored_status', ex.previous_status, 'copies', pg_catalog.cardinality(v_items)));
  return pg_catalog.jsonb_build_object('copies', pg_catalog.cardinality(v_items));
end;
$$;

create or replace function public.merge_release(
  p_source uuid,
  p_target uuid,
  p_token text,
  p_reason text,
  p_owner_note text,
  p_acknowledged text[],
  p_acknowledge_copies boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_note text := nullif(pg_catalog.btrim(p_owner_note), '');
  v_locked uuid[];
  v_plan jsonb;
  req public.catalog_change_requests;
  v_items uuid[];
  v_owners uuid[];
  v_id uuid;
  v_now timestamptz := pg_catalog.now();
  v_owner uuid;
  v_count integer;
  v_notified uuid := null;
  v_references integer;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if p_token is null or pg_catalog.char_length(v_note) > 1000 then
    raise exception 'invalid merge' using errcode = '22023';
  end if;

  -- 1. Profiles first, before any catalog row.
  v_locked := private.merge_profiles(v_me, p_source, p_target);
  perform 1 from public.profiles p where p.id = any (v_locked) order by p.id for key share;

  -- 2. Catalog rows, then the plan again under the locks.
  perform private.lock_merge_records(p_source, p_target);
  v_plan := private.merge_plan(p_source, p_target);
  if v_plan ->> 'token' is distinct from p_token then
    raise exception 'preview stale' using errcode = 'P0001';
  end if;
  if v_plan ->> 'kind' = 'published' and not private.has_staff_role('admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- M8d (D3): merging a published release needs a TOTP verification in the last 10
  -- minutes, checked before anything is written. Submissions merge as before.
  if v_plan ->> 'kind' = 'published' then
    perform private.require_recent_mfa();
  end if;
  if private.merge_involves(v_me, p_source, p_target) then
    raise exception 'own submission' using errcode = 'P0001';
  end if;
  -- M10c (D-4): never a merge of either release, or of either release's game, that the
  -- caller created.
  if private.created_by(v_me, array[p_source, p_target],
       array(select r.game_id from public.releases r where r.id in (p_source, p_target))) then
    raise exception 'own record' using errcode = 'P0001';
  end if;
  if pg_catalog.jsonb_array_length(v_plan -> 'blocking') > 0 then
    raise exception 'merge blocked' using errcode = 'P0001';
  end if;
  -- Each difference acknowledged by name, no more and no fewer (safeguard 2).
  if (select coalesce(pg_catalog.array_agg(d ->> 'field' order by d ->> 'field'), '{}')
      from pg_catalog.jsonb_array_elements(v_plan -> 'differences') d)
     is distinct from
     (select coalesce(pg_catalog.array_agg(distinct a order by a), '{}') from pg_catalog.unnest(p_acknowledged) a)
     or ((v_plan ->> 'copies')::bigint > 0 and not coalesce(p_acknowledge_copies, false)) then
    raise exception 'acknowledgement required' using errcode = 'P0001';
  end if;

  -- 3. Anyone referenced or owning a copy now, who wasn't locked before: no waiting.
  perform private.lock_new_profiles(v_locked, private.merge_profiles(v_me, p_source, p_target));

  -- 4. The copies. None can be added or moved away while the source is locked.
  select coalesce(pg_catalog.array_agg(x.id order by x.id), '{}'), coalesce(pg_catalog.array_agg(x.owner_id order by x.id), '{}')
  into v_items, v_owners
  from (
    select c.id, c.owner_id from public.collection_items c
    where c.release_id = p_source and c.record_status = 'active'
    order by c.id
    for update
  ) x;

  if v_plan ->> 'request_id' is not null then
    select * into req from public.catalog_change_requests x where x.id = (v_plan ->> 'request_id')::uuid;
  end if;
  v_references := pg_catalog.jsonb_array_length(v_plan -> 'references');

  insert into private.catalog_merges (
    source_release_id, target_release_id, source_game_id, target_game_id, kind, merged_by, merged_at, staff_reason, owner_note,
    previous_status, previous_revision, request_id, previous_request, differences, repointed_releases, repointed_requests,
    retired_game, copies_moved, owners_affected, references_moved)
  values (
    p_source, p_target, (v_plan ->> 'source_game_id')::uuid, (v_plan ->> 'target_game_id')::uuid, v_plan ->> 'kind', v_me, v_now,
    v_reason, v_note, (v_plan ->> 'previous_status')::public.catalog_status, (v_plan ->> 'previous_revision')::bigint,
    case when v_plan ->> 'kind' = 'submission' then req.id end,
    case when v_plan ->> 'kind' = 'submission' then pg_catalog.jsonb_build_object(
      'status', req.status, 'version', req.version, 'reviewed_by', req.reviewed_by, 'reviewed_at', req.reviewed_at,
      'reviewer_note', req.reviewer_note, 'merged_into_release_id', req.merged_into_release_id) end,
    v_plan -> 'differences',
    (select coalesce(pg_catalog.array_agg(x::uuid), '{}') from pg_catalog.jsonb_array_elements_text(v_plan -> 'repoint_releases') x),
    (select coalesce(pg_catalog.array_agg(x::uuid), '{}') from pg_catalog.jsonb_array_elements_text(v_plan -> 'repoint_requests') x),
    v_plan -> 'retire', pg_catalog.cardinality(v_items), (select count(distinct o) from pg_catalog.unnest(v_owners) o), v_references)
  returning id into v_id;

  -- 5. The changes. The submission first: the M7b-1 guard refuses changes to a record
  --    whose submission is still active.
  if v_plan ->> 'kind' = 'submission' then
    update public.catalog_change_requests x set
      status = 'merged', merged_into_release_id = p_target, reviewed_by = v_me, reviewed_at = v_now, reviewer_note = v_note
    where x.id = req.id;
  end if;
  update public.catalog_change_requests x set merged_into_release_id = p_target
  where x.merged_into_release_id = p_source;
  -- A source is public as merged only if it was published (D3).
  update public.releases r set
    status = 'merged', merged_into_id = p_target, merged_publicly = (r.status = 'published'), submitted_by = null
  where r.id = p_source;
  -- No chains (D9): what pointed at the source points at the target.
  update public.releases r set merged_into_id = p_target where r.merged_into_id = p_source;
  if v_plan -> 'retire' is not null and v_plan -> 'retire' <> 'null'::jsonb then
    update public.games g set status = (v_plan -> 'retire' ->> 'status')::public.catalog_status
    where g.id = (v_plan -> 'retire' ->> 'id')::uuid;
  end if;

  -- External references: recorded as they were, then moved (safeguard 4).
  insert into private.catalog_merge_references (merge_id, reference_id, provider_code, entity_type, external_id,
    from_release_id, to_release_id, target_had_provider)
  select v_id, (x ->> 'id')::uuid, x ->> 'provider_code', x ->> 'entity_type', x ->> 'external_id', p_source, p_target,
         (x ->> 'target_had_provider')::boolean
  from pg_catalog.jsonb_array_elements(v_plan -> 'references') x;
  update private.external_references x set release_id = p_target where x.release_id = p_source;

  -- The copies: recorded, then moved. Nothing else about them changes: conditions,
  -- private details, every piece record and updated_at stay (D10, D12).
  insert into private.catalog_merge_copies (merge_id, item_id, owner_id)
  select v_id, i, o from rows from (pg_catalog.unnest(v_items), pg_catalog.unnest(v_owners)) as x(i, o);
  update public.collection_items c set release_id = p_target where c.id = any (v_items);

  -- 6. Each affected person once (D13): the submitter by their submission, every other
  --    owner by their copies. Nobody is told who acted.
  if v_plan ->> 'kind' = 'submission' and req.submitted_by is not null then
    perform private.notify(req.submitted_by, null, 'catalog_submission', null,
      pg_catalog.jsonb_build_object('status', 'merged', 'submission_id', req.id, 'merge_id', v_id));
    v_notified := req.submitted_by;
  end if;
  for v_owner, v_count in
    select o, count(*)::integer from pg_catalog.unnest(v_owners) o where o is distinct from v_notified group by o order by o
  loop
    perform private.notify(v_owner, null, 'catalog_merge', null,
      pg_catalog.jsonb_build_object('status', 'merged', 'merge_id', v_id, 'copies', v_count));
  end loop;

  perform private.record_catalog_audit(v_me, 'catalog_release_merged', 'release', p_source, v_reason,
    pg_catalog.jsonb_build_object('merge_id', v_id, 'target_id', p_target, 'kind', v_plan ->> 'kind',
      'copies', pg_catalog.cardinality(v_items), 'references', v_references,
      'repointed', pg_catalog.jsonb_array_length(v_plan -> 'repoint_releases')));
  return pg_catalog.jsonb_build_object('merge_id', v_id, 'copies', pg_catalog.cardinality(v_items),
    'owners', (select count(distinct o) from pg_catalog.unnest(v_owners) o), 'references', v_references);
end;
$$;

create or replace function public.get_game_record(p_game uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  g public.games;
begin
  perform private.require_active_staff('catalog_editor');
  select * into g from public.games x where x.id = p_game;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'id', g.id, 'slug', g.slug, 'title', g.title, 'sort_title', g.sort_title, 'kind', g.kind, 'summary', g.summary,
    'first_release', private.catalog_date_json(g.first_release_date, g.first_release_precision),
    'status', g.status, 'verified_at', g.verified_at, 'revision', g.revision,
    'review', private.record_review('game', g.id, g.status, g.revision, g.verified_at, g.verified_by),
    'created_at', g.created_at, 'updated_at', g.updated_at,
    'merged_into', (select pg_catalog.jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status)
                    from public.games t where t.id = g.merged_into_id),
    'aliases', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'id', a.id, 'title', a.title, 'kind', a.kind, 'language_code', a.language_code, 'region_code', a.region_code)
                  order by a.kind, a.title), '[]')
                from public.game_aliases a where a.game_id = g.id),
    'platforms', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'slug', p.slug, 'name', p.name, 'short_name', p.short_name, 'status', gp.status)
                    order by p.name), '[]')
                  from public.game_platforms gp join public.platforms p on p.id = gp.platform_id where gp.game_id = g.id),
    'relations', (select coalesce(pg_catalog.jsonb_agg(x.j order by x.dir, x.relation, x.title), '[]') from (
                    select 'from' as dir, gr.relation, t.title,
                      pg_catalog.jsonb_build_object('direction', 'outgoing', 'relation', gr.relation, 'position', gr.position,
                        'game', pg_catalog.jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status)) as j
                    from public.game_relations gr join public.games t on t.id = gr.target_game_id where gr.source_game_id = g.id
                    union all
                    select 'to', gr.relation, s.title,
                      pg_catalog.jsonb_build_object('direction', 'incoming', 'relation', gr.relation, 'position', gr.position,
                        'game', pg_catalog.jsonb_build_object('id', s.id, 'title', s.title, 'status', s.status))
                    from public.game_relations gr join public.games s on s.id = gr.source_game_id where gr.target_game_id = g.id
                  ) x),
    'release_count', (select count(*) from public.releases r where r.game_id = g.id),
    'releases', (select coalesce(pg_catalog.jsonb_agg(private.record_release_summary(x) order by x.platform_id, x.region_code, x.id), '[]')
                 from (select r.* from public.releases r where r.game_id = g.id order by r.platform_id, r.region_code, r.id limit 100) x),
    'external_references', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                'provider', pv.name, 'external_id', er.external_id) order by pv.name, er.external_id), '[]')
                            from private.external_references er join private.external_providers pv on pv.code = er.provider_code
                            where er.game_id = g.id),
    'field_locks', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', fl.field_name, 'locked_at', fl.locked_at)
                      order by fl.field_name), '[]')
                    from private.catalog_field_locks fl where fl.game_id = g.id),
    'submissions', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'id', x.id, 'kind', x.request_type, 'status', x.status, 'created_at', x.created_at) order by x.id desc), '[]')
                    from (select s.* from public.catalog_change_requests s where s.game_id = g.id order by s.id desc limit 20) x));
end;
$$;

create or replace function public.get_release_record(p_release uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.releases;
begin
  perform private.require_active_staff('catalog_editor');
  select * into r from public.releases x where x.id = p_release;
  if not found then
    return null;
  end if;
  return private.catalog_release_json(r) || pg_catalog.jsonb_build_object(
    'game', (select pg_catalog.jsonb_build_object('id', g.id, 'title', g.title, 'slug', g.slug, 'status', g.status)
             from public.games g where g.id = r.game_id),
    'region_unknown_confirmed', r.region_unknown_confirmed,
    'status', r.status, 'verified_at', r.verified_at, 'revision', r.revision,
    'review', private.record_review('release', r.id, r.status, r.revision, r.verified_at, r.verified_by),
    'merged_publicly', r.merged_publicly,
    'created_at', r.created_at, 'updated_at', r.updated_at,
    'merged_into', (select private.record_release_summary(t) from public.releases t where t.id = r.merged_into_id),
    'pairing_status', (select gp.status from public.game_platforms gp where gp.game_id = r.game_id and gp.platform_id = r.platform_id),
    'external_references', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                'provider', pv.name, 'external_id', er.external_id) order by pv.name, er.external_id), '[]')
                            from private.external_references er join private.external_providers pv on pv.code = er.provider_code
                            where er.release_id = r.id),
    'evidence', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', x.field_name, 'provider', x.name, 'sources', x.n)
                   order by x.field_name, x.name), '[]')
                 from (select ev.field_name, pv.name, count(*) as n
                       from private.release_evidence ev
                       join private.provider_records pr on pr.id = ev.provider_record_id
                       join private.external_providers pv on pv.code = pr.provider_code
                       where ev.release_id = r.id
                       group by ev.field_name, pv.name) x),
    'field_locks', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', fl.field_name, 'locked_at', fl.locked_at)
                      order by fl.field_name), '[]')
                    from private.catalog_field_locks fl where fl.release_id = r.id),
    'merges', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                   'id', x.id, 'merged_at', x.merged_at, 'kind', x.kind,
                   'role', case when x.source_release_id = r.id then 'source' else 'target' end,
                   'other', (select private.record_release_summary(o) from public.releases o
                             where o.id = case when x.source_release_id = r.id then x.target_release_id else x.source_release_id end))
                 order by x.id desc), '[]')
               from (select m.* from private.catalog_merges m where m.source_release_id = r.id or m.target_release_id = r.id
                     order by m.id desc limit 20) x),
    'submissions', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'id', x.id, 'kind', x.request_type, 'status', x.status, 'created_at', x.created_at) order by x.id desc), '[]')
                    from (select s.* from public.catalog_change_requests s
                          where s.release_id = r.id or s.merged_into_release_id = r.id order by s.id desc limit 20) x),
    'exclusions', case when private.has_staff_role('admin') then
                    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'id', x.id, 'excluded_at', x.excluded_at, 'reason_code', x.reason_code, 'restored_at', x.restored_at)
                       order by x.id desc), '[]')
                     from (select e.* from private.catalog_exclusions e where e.release_id = r.id order by e.id desc limit 20) x)
                  end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Access. The new helpers and triggers are for the database only; the replaced
--    public functions keep their grants.
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.guard_catalog_record_origin()',
    'private.record_catalog_origin()',
    'private.sync_catalog_verification()',
    'private.legacy_catalog_origin(text, uuid)',
    'private.record_origin(text, uuid)',
    'private.verification_current(text, uuid, bigint, timestamp with time zone)',
    'private.created_by(uuid, uuid[], uuid[])',
    'private.cascade_games(jsonb)',
    'private.provenance_note(text, uuid)',
    'private.release_verification_ends(uuid)',
    'private.record_review(text, uuid, public.catalog_status, bigint, timestamp with time zone, uuid)',
    'private.bump_game_revision()',
    'private.guard_pairing_publication()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
  end loop;
end;
$$;
