-- M4b Notifications: lock order for the two follow functions that create notifications.
--
-- A notification references both accounts, so inserting one takes a key-share lock on
-- each profile. Account deletion locks the profile first and then its follow rows. If
-- these functions took the profile locks only after locking the follow row, a deletion
-- racing an accept or a request would deadlock. So they now take them first, in the
-- same order as deletion. Nothing else in either function changes: both bodies are the
-- M3 versions plus one statement each. EXECUTE grants are kept by CREATE OR REPLACE.

create or replace function public.request_follow(p_target uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_active_user();
  v_requires_approval boolean;
  v_status public.follow_status;
  v_rerequest_after timestamptz;
begin
  if p_target is null or p_target = v_me then
    raise exception 'user unavailable' using errcode = 'P0001';
  end if;

  perform private.lock_follow_requester(v_me);
  perform private.lock_follow_pair(v_me, p_target);

  -- Waits for an uncommitted change to this account, so a request can't act on a
  -- follow setting that's about to change, and an account deletion can't be missed.
  select p.follow_approval_required into v_requires_approval
  from public.profiles p
  where p.id = p_target and p.handle is not null and p.account_status = 'active'
  for share;

  if not found or private.is_blocked_between(p_target) then
    raise exception 'user unavailable' using errcode = 'P0001';
  end if;

  -- M4b: lock both accounts before the follow row. See the header.
  perform 1 from public.profiles p where p.id = v_me for key share;

  select f.status, f.rerequest_after into v_status, v_rerequest_after
  from public.follows f
  where f.follower_id = v_me and f.followee_id = p_target
  for update;

  if v_status = 'accepted' then
    return 'following';
  elsif v_status in ('pending', 'rejected') then
    return 'requested';
  end if;

  -- A cooldown is active, so this attempt is recorded as already rejected. Nothing
  -- reaches the target, the cooldown isn't changed, and the caller can't tell.
  if v_rerequest_after > pg_catalog.now() then
    perform private.enforce_request_limit(v_me);
    update public.follows
    set status = 'rejected', requested_at = pg_catalog.now()
    where follower_id = v_me and followee_id = p_target;
    return 'requested';
  end if;

  if v_requires_approval is false then
    insert into public.follows (follower_id, followee_id, status, accepted_at)
    values (v_me, p_target, 'accepted', pg_catalog.now())
    on conflict (follower_id, followee_id) do update
      set status = 'accepted', accepted_at = pg_catalog.now(), rerequest_after = null, requested_at = pg_catalog.now();
    return 'following';
  end if;

  perform private.enforce_request_limit(v_me);
  insert into public.follows (follower_id, followee_id, status)
  values (v_me, p_target, 'pending')
  on conflict (follower_id, followee_id) do update
    set status = 'pending', rerequest_after = null, requested_at = pg_catalog.now();
  return 'requested';
exception
  when foreign_key_violation then
    raise exception 'user unavailable' using errcode = 'P0001';
end;
$$;

create or replace function public.accept_follow_request(p_requester uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_active_user();
  v_status public.follow_status;
begin
  perform private.lock_follow_pair(v_me, p_requester);

  -- M4b: lock both accounts before the follow row. See the header.
  perform 1 from public.profiles p where p.id in (v_me, p_requester) order by p.id for key share;

  select f.status into v_status
  from public.follows f
  join public.profiles p on p.id = f.follower_id
  where f.follower_id = p_requester and f.followee_id = v_me
    and p.handle is not null and p.account_status = 'active'
  for update of f;

  if v_status = 'accepted' then
    return;
  elsif v_status is distinct from 'pending' then
    raise exception 'request unavailable' using errcode = 'P0001';
  end if;

  update public.follows
  set status = 'accepted', accepted_at = pg_catalog.now()
  where follower_id = p_requester and followee_id = v_me;
end;
$$;
