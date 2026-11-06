-- M3 Authorization: follows, blocks and visibility helpers.
--
-- Design: docs/architecture/security-rls.md
-- No client role has any access to these tables. RLS is on with no policies, and
-- everything goes through the functions in the next migration.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

-- One row per ordered pair, ever, so repeated requests can't build up history.
create table public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  status public.follow_status not null,
  -- The end of a rejection or removal cooldown. A retry never changes it.
  rerequest_after timestamptz,
  requested_at timestamptz not null default now(),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id),
  check ((status = 'accepted') = (accepted_at is not null)),
  check (status <> 'rejected' or rerequest_after is not null),
  check (status not in ('pending', 'accepted') or rerequest_after is null)
);

create index follows_followers_page_idx on public.follows (followee_id, accepted_at desc, follower_id desc) where status = 'accepted';
create index follows_following_page_idx on public.follows (follower_id, accepted_at desc, followee_id desc) where status = 'accepted';
create index follows_received_page_idx on public.follows (followee_id, requested_at desc, follower_id desc) where status = 'pending';
create index follows_sent_page_idx on public.follows (follower_id, requested_at desc, followee_id desc) where status in ('pending', 'rejected');

create table public.blocked_users (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index blocked_users_reverse_idx on public.blocked_users (blocked_id, blocker_id);

alter table public.follows enable row level security;
alter table public.blocked_users enable row level security;
revoke all on public.follows from public, anon, authenticated, service_role;
revoke all on public.blocked_users from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Locks
-- ---------------------------------------------------------------------------

-- Serializes every follow and block change for a pair of users, in either direction,
-- until commit. This is what stops a request slipping in during a block.
create function private.lock_follow_pair(p_one uuid, p_other uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'follow-pair:' || least(p_one, p_other)::text || ':' || greatest(p_one, p_other)::text, 0));
end;
$$;

-- Always taken before a pair lock, and only by request_follow, so the two can't deadlock.
create function private.lock_follow_requester(p_requester uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('follow-requester:' || p_requester::text, 0));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Row rules: these hold for every writer, including operators
-- ---------------------------------------------------------------------------

create function private.validate_follow_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('pending', 'accepted') then
      raise exception 'invalid follow transition' using errcode = '23514';
    end if;
  else
    if new.follower_id <> old.follower_id or new.followee_id <> old.followee_id then
      raise exception 'invalid follow transition' using errcode = '23514';
    end if;
    if new.status <> old.status and not (
      (old.status = 'pending' and new.status in ('accepted', 'rejected', 'cancelled'))
      or (old.status = 'accepted' and new.status = 'cancelled')
      or (old.status = 'rejected' and new.status = 'cancelled')
      or (old.status = 'cancelled' and new.status in ('pending', 'accepted', 'rejected'))
    ) then
      raise exception 'invalid follow transition' using errcode = '23514';
    end if;
  end if;

  if new.status in ('pending', 'accepted') and exists (
    select 1 from public.blocked_users b
    where (b.blocker_id = new.follower_id and b.blocked_id = new.followee_id)
       or (b.blocker_id = new.followee_id and b.blocked_id = new.follower_id)
  ) then
    raise exception 'follow not allowed while a block exists' using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger validate_follow_row
  before insert or update on public.follows
  for each row execute function private.validate_follow_row();

create trigger set_updated_at before update on public.follows
  for each row execute function private.set_updated_at();

-- Blocking removes follows, requests and cooldowns in both directions, atomically.
-- Nothing brings them back on unblock.
create function private.remove_follows_on_block()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.lock_follow_pair(new.blocker_id, new.blocked_id);
  delete from public.follows f
  where (f.follower_id = new.blocker_id and f.followee_id = new.blocked_id)
     or (f.follower_id = new.blocked_id and f.followee_id = new.blocker_id);
  return new;
end;
$$;

create trigger remove_follows_on_block
  after insert on public.blocked_users
  for each row execute function private.remove_follows_on_block();

-- ---------------------------------------------------------------------------
-- 4. Authorization helpers
-- ---------------------------------------------------------------------------
-- These read tables clients can't, so they're SECURITY DEFINER. They take the viewer
-- only from auth.uid(), and answer for no one else. Staff status is never consulted:
-- staff access to private content can only come through audited M4 functions.

create function private.is_blocked_between(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.blocked_users b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = p_other)
       or (b.blocker_id = p_other and b.blocked_id = (select auth.uid()))
  )
$$;

-- An accepted follow counts only while the viewer's own account is active.
create function private.is_accepted_follower(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_user() and exists (
    select 1 from public.follows f
    where f.follower_id = (select auth.uid()) and f.followee_id = p_owner and f.status = 'accepted'
  )
$$;

-- The core rule, which later policies on collections, shelves and wantlists call. An
-- unknown or null level grants nothing.
create function private.can_view_level(p_owner uuid, p_level public.visibility_level)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_owner = (select auth.uid())
    or (
      exists (select 1 from public.profiles p where p.id = p_owner and p.handle is not null and p.account_status = 'active')
      and not private.is_blocked_between(p_owner)
      and case p_level
        when 'public' then true
        when 'followers' then private.is_accepted_follower(p_owner)
        else false
      end
    ),
    false
  )
$$;

create function private.can_view_collection(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select private.can_view_level(p_owner, p.collection_visibility) from public.profiles p where p.id = p_owner),
    false
  )
$$;

-- Whether the viewer may see this account's follower lists and counts at all. Signed-in
-- active viewers only. A private account's connections need an accepted follow.
create function private.can_view_connections(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_owner = (select auth.uid())
    or (
      private.is_active_user()
      and not private.is_blocked_between(p_owner)
      and exists (
        select 1 from public.profiles p
        where p.id = p_owner and p.handle is not null and p.account_status = 'active'
          and (p.follow_approval_required is false or private.is_accepted_follower(p_owner))
      )
    ),
    false
  )
$$;

-- Everyone in a block with the viewer, in either direction, evaluated once per query.
create function private.block_peers()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(x.id), '{}') from (
    select b.blocked_id as id from public.blocked_users b where b.blocker_id = (select auth.uid())
    union all
    select b.blocker_id from public.blocked_users b where b.blocked_id = (select auth.uid())
  ) x
$$;

-- Returns the caller, or refuses. Used by actions that only reduce access, which stay
-- available to suspended accounts as a safety measure.
create function private.require_verified_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null or not exists (
    select 1 from public.profiles p join auth.users u on u.id = p.id
    where p.id = v_me and u.email_confirmed_at is not null
  ) then
    raise exception 'account not eligible' using errcode = '42501';
  end if;
  return v_me;
end;
$$;

-- Returns the caller, or refuses. Used by actions that add access.
create function private.require_active_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_active_user() then
    raise exception 'account not eligible' using errcode = '42501';
  end if;
  return (select auth.uid());
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

revoke all on function private.lock_follow_pair(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_follow_requester(uuid) from public, anon, authenticated, service_role;
revoke all on function private.validate_follow_row() from public, anon, authenticated, service_role;
revoke all on function private.remove_follows_on_block() from public, anon, authenticated, service_role;
revoke all on function private.can_view_connections(uuid) from public, anon, authenticated, service_role;
revoke all on function private.require_verified_user() from public, anon, authenticated, service_role;
revoke all on function private.require_active_user() from public, anon, authenticated, service_role;

-- Policies on public content call these during anonymous reads. A policy needs only
-- EXECUTE, and with no USAGE on private, clients still can't call them directly.
revoke all on function private.is_blocked_between(uuid) from public, anon, authenticated, service_role;
revoke all on function private.is_accepted_follower(uuid) from public, anon, authenticated, service_role;
revoke all on function private.can_view_level(uuid, public.visibility_level) from public, anon, authenticated, service_role;
revoke all on function private.can_view_collection(uuid) from public, anon, authenticated, service_role;
grant execute on function private.is_blocked_between(uuid) to anon, authenticated;
grant execute on function private.is_accepted_follower(uuid) to anon, authenticated;
grant execute on function private.can_view_level(uuid, public.visibility_level) to anon, authenticated;
grant execute on function private.can_view_collection(uuid) to anon, authenticated;

revoke all on function private.block_peers() from public, anon, authenticated, service_role;
grant execute on function private.block_peers() to authenticated;
