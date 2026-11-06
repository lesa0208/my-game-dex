-- M3 Authorization: the only client path to follows and blocks.
--
-- Every function takes the acting user from auth.uid(), never from an argument.
-- Target-related refusals share one message, so a response can't distinguish a blocked,
-- suspended or unknown account.

-- ---------------------------------------------------------------------------
-- 1. Follow requests
-- ---------------------------------------------------------------------------

-- Returns 'following' or 'requested'.
create function public.request_follow(p_target uuid)
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

-- Counts everything shown to the requester as requested, so a rejection can't be
-- inferred from reaching the limit later than expected. Requires the requester lock.
create function private.enforce_request_limit(p_requester uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.follows f where f.follower_id = p_requester and f.status in ('pending', 'rejected')) >= 200 then
    raise exception 'too many outstanding follow requests' using errcode = 'P0001';
  end if;
end;
$$;

-- Idempotent. A cooldown survives, so cancelling can't be used to retry sooner.
create function public.cancel_follow_request(p_target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
begin
  perform private.lock_follow_pair(v_me, p_target);
  update public.follows
  set status = 'cancelled'
  where follower_id = v_me and followee_id = p_target and status in ('pending', 'rejected');
end;
$$;

-- Idempotent. Leaves no cooldown and no row.
create function public.unfollow(p_target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
begin
  perform private.lock_follow_pair(v_me, p_target);
  delete from public.follows
  where follower_id = v_me and followee_id = p_target and status = 'accepted';
end;
$$;

-- Requires an active account, because accepting adds access. A request that's gone, or
-- whose requester can no longer be seen, gives one generic answer.
create function public.accept_follow_request(p_requester uuid)
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

-- Idempotent, and repeating it doesn't extend the cooldown.
create function public.reject_follow_request(p_requester uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
  v_status public.follow_status;
begin
  perform private.lock_follow_pair(v_me, p_requester);

  select f.status into v_status
  from public.follows f
  where f.follower_id = p_requester and f.followee_id = v_me
  for update;

  if v_status = 'rejected' then
    return;
  elsif v_status is distinct from 'pending' then
    raise exception 'request unavailable' using errcode = 'P0001';
  end if;

  update public.follows
  set status = 'rejected', rerequest_after = pg_catalog.now() + interval '30 days'
  where follower_id = p_requester and followee_id = v_me;
end;
$$;

-- Idempotent. The removed follower simply stops following, and a retry within 30 days
-- is silently refused.
create function public.remove_follower(p_follower uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
begin
  perform private.lock_follow_pair(v_me, p_follower);
  update public.follows
  set status = 'cancelled', accepted_at = null, rerequest_after = pg_catalog.now() + interval '30 days'
  where follower_id = p_follower and followee_id = v_me and status = 'accepted';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Blocks
-- ---------------------------------------------------------------------------

-- Idempotent. Allowed for suspended accounts, and for a target who has blocked the
-- caller, because refusing would reveal that block.
create function public.block_user(p_target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
begin
  if p_target is null or p_target = v_me or not exists (
    select 1 from public.profiles p where p.id = p_target and p.handle is not null
  ) then
    raise exception 'user unavailable' using errcode = 'P0001';
  end if;

  perform private.lock_follow_pair(v_me, p_target);
  insert into public.blocked_users (blocker_id, blocked_id)
  values (v_me, p_target)
  on conflict (blocker_id, blocked_id) do nothing;
exception
  when foreign_key_violation then
    raise exception 'user unavailable' using errcode = 'P0001';
end;
$$;

-- Idempotent. Never restores a follow, and only ever removes the caller's own block.
create function public.unblock_user(p_target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
begin
  perform private.lock_follow_pair(v_me, p_target);
  delete from public.blocked_users where blocker_id = v_me and blocked_id = p_target;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Reads
-- ---------------------------------------------------------------------------

-- The narrow way to ask how following one account would work. A rejection reads as
-- 'requested', and a block by the target reads as 'unavailable'.
create function public.get_follow_state(p_target uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_active_user();
  v_requires_approval boolean;
  v_status public.follow_status;
begin
  if p_target = v_me then
    return 'self';
  end if;

  if exists (select 1 from public.blocked_users b where b.blocker_id = v_me and b.blocked_id = p_target) then
    return 'blocked_by_you';
  end if;

  select p.follow_approval_required into v_requires_approval
  from public.profiles p
  where p.id = p_target and p.handle is not null and p.account_status = 'active';

  if not found or private.is_blocked_between(p_target) then
    return 'unavailable';
  end if;

  select f.status into v_status from public.follows f where f.follower_id = v_me and f.followee_id = p_target;

  if v_status = 'accepted' then
    return 'following';
  elsif v_status in ('pending', 'rejected') then
    return 'requested';
  elsif v_requires_approval then
    return 'can_request';
  end if;
  return 'can_follow';
end;
$$;

-- Validates paging input for the list functions. At most 100 rows per page, and a
-- cursor must be complete.
create function private.page_size(p_limit integer, p_before_at timestamptz, p_before_id uuid)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 or (p_before_at is null) <> (p_before_id is null) then
    raise exception 'invalid page request' using errcode = '22023';
  end if;
  return p_limit;
end;
$$;

-- Lists and counts apply one rule. The owner sees every accepted relationship. Anyone
-- else permitted sees accepted relationships with public, active accounts they have no
-- block with, plus their own. A private account's relationships are never shown to
-- third parties, on either side. Keep get_followers, get_following and
-- get_profile_counts in step: tests compare a full page walk with the count.

create function public.get_followers(p_profile uuid, p_limit integer default 50, p_before_at timestamptz default null, p_before_id uuid default null)
returns table (id uuid, handle text, display_name text, avatar_path text, followed_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
  v_limit integer := private.page_size(p_limit, p_before_at, p_before_id);
  v_peers uuid[];
begin
  if not private.can_view_connections(p_profile) then
    return;
  end if;
  v_peers := private.block_peers();

  return query
    select o.id, o.handle, o.display_name, o.avatar_path, f.accepted_at
    from public.follows f
    join public.profiles o on o.id = f.follower_id
    where f.followee_id = p_profile
      and f.status = 'accepted'
      and (f.accepted_at, f.follower_id) < (coalesce(p_before_at, 'infinity'::timestamptz), coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
      and (
        p_profile = v_me or o.id = v_me
        or (o.handle is not null and o.account_status = 'active' and o.follow_approval_required is false and not (o.id = any (v_peers)))
      )
    order by f.accepted_at desc, f.follower_id desc
    limit v_limit;
end;
$$;

create function public.get_following(p_profile uuid, p_limit integer default 50, p_before_at timestamptz default null, p_before_id uuid default null)
returns table (id uuid, handle text, display_name text, avatar_path text, followed_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
  v_limit integer := private.page_size(p_limit, p_before_at, p_before_id);
  v_peers uuid[];
begin
  if not private.can_view_connections(p_profile) then
    return;
  end if;
  v_peers := private.block_peers();

  return query
    select o.id, o.handle, o.display_name, o.avatar_path, f.accepted_at
    from public.follows f
    join public.profiles o on o.id = f.followee_id
    where f.follower_id = p_profile
      and f.status = 'accepted'
      and (f.accepted_at, f.followee_id) < (coalesce(p_before_at, 'infinity'::timestamptz), coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
      and (
        p_profile = v_me or o.id = v_me
        or (o.handle is not null and o.account_status = 'active' and o.follow_approval_required is false and not (o.id = any (v_peers)))
      )
    order by f.accepted_at desc, f.followee_id desc
    limit v_limit;
end;
$$;

-- Returns no row when the viewer may not see these counts. For anyone but the owner,
-- a count means visible relationships, not necessarily the complete total.
create function public.get_profile_counts(p_profile uuid)
returns table (followers bigint, following bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
  v_peers uuid[];
begin
  if not private.can_view_connections(p_profile) then
    return;
  end if;
  v_peers := private.block_peers();

  return query
    select
      (select count(*) from public.follows f join public.profiles o on o.id = f.follower_id
        where f.followee_id = p_profile and f.status = 'accepted'
          and (p_profile = v_me or o.id = v_me
            or (o.handle is not null and o.account_status = 'active' and o.follow_approval_required is false and not (o.id = any (v_peers))))),
      (select count(*) from public.follows f join public.profiles o on o.id = f.followee_id
        where f.follower_id = p_profile and f.status = 'accepted'
          and (p_profile = v_me or o.id = v_me
            or (o.handle is not null and o.account_status = 'active' and o.follow_approval_required is false and not (o.id = any (v_peers)))));
end;
$$;

-- The owner's incoming queue. Requesters who can't currently be seen are left out.
create function public.get_received_follow_requests(p_limit integer default 50, p_before_at timestamptz default null, p_before_id uuid default null)
returns table (id uuid, handle text, display_name text, avatar_path text, requested_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
  v_limit integer := private.page_size(p_limit, p_before_at, p_before_id);
begin
  return query
    select o.id, o.handle, o.display_name, o.avatar_path, f.requested_at
    from public.follows f
    join public.profiles o on o.id = f.follower_id
    where f.followee_id = v_me
      and f.status = 'pending'
      and o.handle is not null and o.account_status = 'active'
      and (f.requested_at, f.follower_id) < (coalesce(p_before_at, 'infinity'::timestamptz), coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
    order by f.requested_at desc, f.follower_id desc
    limit v_limit;
end;
$$;

-- What the caller has asked for. A rejected request looks exactly like a pending one.
create function public.get_sent_follow_requests(p_limit integer default 50, p_before_at timestamptz default null, p_before_id uuid default null)
returns table (id uuid, handle text, display_name text, avatar_path text, requested_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
  v_limit integer := private.page_size(p_limit, p_before_at, p_before_id);
begin
  return query
    select o.id, o.handle, o.display_name, o.avatar_path, f.requested_at
    from public.follows f
    join public.profiles o on o.id = f.followee_id
    where f.follower_id = v_me
      and f.status in ('pending', 'rejected')
      and o.handle is not null and o.account_status = 'active'
      and (f.requested_at, f.followee_id) < (coalesce(p_before_at, 'infinity'::timestamptz), coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
    order by f.requested_at desc, f.followee_id desc
    limit v_limit;
end;
$$;

-- The only way to read a block list, and it shows only the caller's own. These cards
-- are hidden from the caller by RLS, so this returns them itself to allow unblocking.
create function public.get_my_blocks(p_limit integer default 50, p_before_at timestamptz default null, p_before_id uuid default null)
returns table (id uuid, handle text, display_name text, avatar_path text, blocked_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
  v_limit integer := private.page_size(p_limit, p_before_at, p_before_id);
begin
  return query
    select o.id, o.handle, o.display_name, o.avatar_path, b.created_at
    from public.blocked_users b
    join public.profiles o on o.id = b.blocked_id
    where b.blocker_id = v_me
      and (b.created_at, b.blocked_id) < (coalesce(p_before_at, 'infinity'::timestamptz), coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
    order by b.created_at desc, b.blocked_id desc
    limit v_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------

revoke all on function private.enforce_request_limit(uuid) from public, anon, authenticated, service_role;
revoke all on function private.page_size(integer, timestamptz, uuid) from public, anon, authenticated, service_role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.request_follow(uuid)',
    'public.cancel_follow_request(uuid)',
    'public.unfollow(uuid)',
    'public.accept_follow_request(uuid)',
    'public.reject_follow_request(uuid)',
    'public.remove_follower(uuid)',
    'public.block_user(uuid)',
    'public.unblock_user(uuid)',
    'public.get_follow_state(uuid)',
    'public.get_followers(uuid, integer, timestamptz, uuid)',
    'public.get_following(uuid, integer, timestamptz, uuid)',
    'public.get_profile_counts(uuid)',
    'public.get_received_follow_requests(integer, timestamptz, uuid)',
    'public.get_sent_follow_requests(integer, timestamptz, uuid)',
    'public.get_my_blocks(integer, timestamptz, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
