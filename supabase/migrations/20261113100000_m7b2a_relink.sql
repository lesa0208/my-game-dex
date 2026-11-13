-- M7b-2a: copies keep every piece record when they change release, a copy can never be
-- added or moved to a release whose status changes at the same moment, and owners move
-- their own copies to another release of the same platform.
--
-- Design: docs/architecture/security-rls.md#relinking-copies-m7b-2a
--
-- 1. Piece records. The M6 trigger drop_unlisted_components deleted a copy's records
--    of pieces its new release doesn't list whenever its release changed. Merging
--    (M7b-2c) moves copies, so it would have deleted collectors' data. It's removed:
--    a copy keeps every record, with its condition and timestamps. A record of a piece
--    the new release also lists matches it by kind and label; the rest show as no
--    longer listed (M6d), and only the owner removes them (update_collection_item's
--    "remove_components"). Recording a new piece still needs it to be listed.
--
-- 2. The late check. Adding a copy was checked by the insert policy, which reads the
--    release's status from the statement's snapshot, and by the foreign key, which only
--    takes FOR KEY SHARE. An update of a release's status takes FOR NO KEY UPDATE, which
--    doesn't conflict with FOR KEY SHARE, so a copy could still land on a release whose
--    status had just changed. Two triggers now lock the target release FOR SHARE, which
--    conflicts with every update of that row, and check its status after the lock:
--    whichever commits first is seen by the other. A copy's release must be usable by
--    the copy's owner: published, or the owner's own submission that's pending or not
--    approved. Never merged or excluded. The check uses the copy's owner, not the
--    caller, so a staff merge (M7b-2c) moving copies to a published release passes it.
--    A locking read needs UPDATE privilege, which clients rightly don't have on
--    releases, so these trigger functions run as their owner. They only read and lock
--    the one release named by the row being written.
--
-- 3. Relinking. relink_my_copy() moves the caller's own copy. Clients have no grant to
--    change a copy's release_id, and this keeps it that way: rather than a column grant,
--    which would let any client change release_id directly with only the policies to
--    guard it, a dedicated SECURITY DEFINER function changes that one column, after its
--    own checks. Every trigger still runs.
--
-- Lock order, everywhere: profiles, then releases (by id), then copies. Adding a copy
-- takes, in trigger order, the owner's profile, its release, then the owner's
-- collection lock (M6's limit), which only other additions by that owner take, so it
-- can't close a cycle. Status changes lock their release FOR UPDATE, and so will
-- M7b-2b and M7b-2c, before any copy. Adding a copy locks the owner's profile first, so
-- an account deletion, which locks the profile and then clears submitted_by on their
-- releases, can't deadlock with it.

-- ---------------------------------------------------------------------------
-- 1. Piece records survive a change of release
-- ---------------------------------------------------------------------------

drop trigger drop_unlisted_components on public.collection_items;
drop function private.drop_unlisted_components();

-- ---------------------------------------------------------------------------
-- 2. The late check
-- ---------------------------------------------------------------------------

-- A release a copy owned by p_owner may be on, locked FOR SHARE until the transaction
-- ends. Raises 'release unavailable' otherwise.
create function private.lock_usable_release(p_release uuid, p_owner uuid)
returns public.releases
language plpgsql
security definer
set search_path = ''
as $$
declare
  rel public.releases;
begin
  select * into rel from public.releases r where r.id = p_release for share;
  -- Null-safe: an editor's release has no submitter, and a null comparison here would
  -- make the whole condition null, which IF treats as false.
  if not found or not (rel.status = 'published'
                       or (rel.submitted_by is not null and rel.submitted_by = p_owner
                           and rel.status in ('unverified', 'under_review', 'rejected'))) then
    raise exception 'release unavailable' using errcode = 'P0001';
  end if;
  return rel;
end;
$$;

-- A new copy: the owner's profile, then its release.
create function private.check_new_copy_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.profiles p where p.id = new.owner_id for key share;
  perform private.lock_usable_release(new.release_id, new.owner_id);
  return new;
end;
$$;

-- A copy moving to another release: the new release. The owner can't change, so their
-- profile isn't needed, and a merge that already holds its releases takes no new lock.
create function private.check_moved_copy_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_usable_release(new.release_id, new.owner_id);
  return new;
end;
$$;

create trigger check_copy_release before insert on public.collection_items
  for each row execute function private.check_new_copy_release();
create trigger check_copy_release_move before update of release_id on public.collection_items
  for each row when (new.release_id is distinct from old.release_id)
  execute function private.check_moved_copy_release();

revoke all on function private.lock_usable_release(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.check_new_copy_release() from public, anon, authenticated, service_role;
revoke all on function private.check_moved_copy_release() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Relinking
-- ---------------------------------------------------------------------------

-- Moves the caller's copy to another release of the same platform that they may use:
-- published, or their own pending or not-approved submission. Everything else about the
-- copy stays: its id, conditions, private details, piece records (kept, as no longer
-- listed where the new release doesn't list them) and when it was added. A preserved
-- copy (its release was excluded or merged) becomes active again. Moving to the release
-- it's already on changes nothing. A release the caller can't use reads the same as one
-- that doesn't exist, and its platform is never compared.
-- Returns {moved, release_id, record_status}.
--
-- Errors: 42501 'not permitted' (signed out), P0001 'account not active',
-- 'item unavailable' (not the caller's copy), 'release unavailable', 'other platform',
-- 'request conflict' (the copy moved while this waited; read it again).
create function public.relink_my_copy(p_item uuid, p_release uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_from uuid;
  v_item public.collection_items;
  v_source public.releases;
  v_target public.releases;
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not private.is_active_user() then
    raise exception 'account not active' using errcode = 'P0001';
  end if;
  perform 1 from public.profiles p where p.id = v_me for key share;

  select c.release_id into v_from from public.collection_items c where c.id = p_item and c.owner_id = v_me;
  if not found then
    raise exception 'item unavailable' using errcode = 'P0001';
  end if;
  -- Releases before the copy, in id order, as merges and exclusions lock them.
  perform 1 from public.releases r where r.id in (v_from, p_release) order by r.id for share;
  select * into v_item from public.collection_items c where c.id = p_item and c.owner_id = v_me for update;
  if not found then
    raise exception 'item unavailable' using errcode = 'P0001';
  end if;
  if v_item.release_id is distinct from v_from then
    raise exception 'request conflict' using errcode = 'P0001';
  end if;

  select * into v_target from public.releases r where r.id = p_release;
  -- Null-safe, as in lock_usable_release.
  if not found or not (v_target.status = 'published'
                       or (v_target.submitted_by is not null and v_target.submitted_by = v_me
                           and v_target.status in ('unverified', 'under_review', 'rejected'))) then
    raise exception 'release unavailable' using errcode = 'P0001';
  end if;
  select * into v_source from public.releases r where r.id = v_from;
  if v_target.platform_id is distinct from v_source.platform_id then
    raise exception 'other platform' using errcode = 'P0001';
  end if;
  if v_target.id = v_source.id then
    return pg_catalog.jsonb_build_object('moved', false, 'release_id', v_target.id, 'record_status', v_item.record_status);
  end if;

  update public.collection_items c set release_id = v_target.id where c.id = v_item.id;
  return pg_catalog.jsonb_build_object('moved', true, 'release_id', v_target.id,
    'record_status', (select c.record_status from public.collection_items c where c.id = v_item.id));
end;
$$;

revoke all on function public.relink_my_copy(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.relink_my_copy(uuid, uuid) to authenticated;
