-- M5b Catalog: record revisions, so an editor never verifies or publishes a record
-- that changed after they reviewed it.
--
-- Design: docs/architecture/security-rls.md#catalog-editing
-- Imports now fill empty fields of unverified records, so a record can change
-- between an editor reading it and verifying it. Every content change to a game or
-- release, or to a release's markets, components or hardware requirements, raises
-- its revision. verify_game, verify_release and publish_release require the revision
-- the editor reviewed, and refuse with 'record changed' if it moved on. The check is
-- made after the row is locked, so a change committed while the call waited is seen.
-- Verifying doesn't change a revision, so verify then publish needs one read.

-- ---------------------------------------------------------------------------
-- 1. Revisions
-- ---------------------------------------------------------------------------

alter table public.games add column revision bigint not null default 1 check (revision > 0);
alter table public.releases add column revision bigint not null default 1 check (revision > 0);

-- Raises the revision when anything but verification or timestamps changes. A direct
-- write to revision only ever raises it by one, so it can't be reset or set ahead.
create function private.bump_catalog_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (pg_catalog.to_jsonb(new) - array['revision', 'updated_at', 'verified_at', 'verified_by'])
       is distinct from (pg_catalog.to_jsonb(old) - array['revision', 'updated_at', 'verified_at', 'verified_by'])
     or new.revision is distinct from old.revision then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

create trigger bump_catalog_revision before update on public.games
  for each row execute function private.bump_catalog_revision();
create trigger bump_catalog_revision before update on public.releases
  for each row execute function private.bump_catalog_revision();

-- A release's details are part of what an editor reviews.
create function private.bump_release_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.releases r set revision = r.revision + 1
  where r.id = case when tg_op = 'DELETE' then old.release_id else new.release_id end;
  return null;
end;
$$;

create trigger bump_release_revision after insert or update or delete on public.release_markets
  for each row execute function private.bump_release_revision();
create trigger bump_release_revision after insert or update or delete on public.release_components
  for each row execute function private.bump_release_revision();
create trigger bump_release_revision after insert or update or delete on public.release_hardware_requirements
  for each row execute function private.bump_release_revision();

revoke all on function private.bump_catalog_revision() from public, anon, authenticated, service_role, catalog_importer;
revoke all on function private.bump_release_revision() from public, anon, authenticated, service_role, catalog_importer;

grant select (revision) on public.games to anon, authenticated;
grant select (revision) on public.releases to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Verification and publication against a reviewed revision
-- ---------------------------------------------------------------------------

drop function public.verify_game(uuid, text);
drop function public.verify_release(uuid, text);
drop function public.publish_release(uuid, text);

create function public.verify_game(p_game uuid, p_reason text, p_expected_revision bigint)
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
  if v_game.verified_at is not null then
    return false;
  end if;
  update public.games g set verified_at = pg_catalog.now(), verified_by = v_me where g.id = p_game;
  perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'game', p_game, v_reason,
    pg_catalog.jsonb_build_object('revision', v_game.revision));
  return true;
end;
$$;

-- Confirms the physical identity of a release. It must be complete enough to publish:
-- an edition and medium count set, and an unknown region explicitly confirmed.
create function public.verify_release(p_release uuid, p_reason text, p_expected_revision bigint)
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
  if v_release.verified_at is not null then
    return false;
  end if;
  if v_release.edition_name is null or v_release.edition_kind is null or v_release.media_count is null
     or (v_release.region_code = 'unknown' and not v_release.region_unknown_confirmed) then
    raise exception 'release incomplete' using errcode = '22023';
  end if;
  update public.releases r set verified_at = pg_catalog.now(), verified_by = v_me where r.id = p_release;
  perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('revision', v_release.revision));
  return true;
end;
$$;

-- Publishes a verified release at the revision the editor reviewed. Its game, if
-- verified and not yet public, and its platform pairing are published in the same
-- transaction (M5 decision 5). The publication rules are checked again at commit.
create function public.publish_release(p_release uuid, p_reason text, p_expected_revision bigint)
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
      pg_catalog.jsonb_build_object('slug', v_slug, 'with_release_id', p_release));
  end if;

  if v_pairing <> 'published' then
    update public.game_platforms gp set status = 'published', submitted_by = null
    where gp.game_id = v_release.game_id and gp.platform_id = v_release.platform_id;
  end if;
  update public.releases r set status = 'published', submitted_by = null where r.id = p_release;

  perform private.record_catalog_audit(v_me, 'catalog_record_published', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('game_id', v_release.game_id, 'platform_id', v_release.platform_id, 'revision', v_release.revision));
  return true;
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.verify_game(uuid, text, bigint)',
    'public.verify_release(uuid, text, bigint)',
    'public.publish_release(uuid, text, bigint)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
