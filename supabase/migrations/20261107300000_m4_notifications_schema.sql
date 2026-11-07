-- M4b Notifications: storage, preferences, and creation from real state changes.
--
-- Design: docs/architecture/security-rls.md#notifications
-- No client role has any access to the table. RLS is on with no policies, and clients
-- read and change their own notifications only through the functions in the next
-- migration. Notifications are written only by the triggers below, in the same
-- transaction as the change that causes them, so they commit or roll back together.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default private.uuid_v7(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  -- Cascade (D4): nothing about a deleted account remains in anyone's notifications.
  actor_id uuid references public.profiles (id) on delete cascade,
  type public.notification_type not null,
  -- The time of the follow change that caused it: requested_at or accepted_at. With the
  -- unique key, the same change can never notify twice.
  event_at timestamptz,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_event_key unique (recipient_id, actor_id, type, event_at),
  constraint notifications_not_self check (actor_id is distinct from recipient_id),
  -- M4 creates only these types. A moderation notice never names who acted and holds
  -- only the new status, never the staff member's reason (D8).
  constraint notifications_shape check (
    (type in ('follow', 'follow_request', 'follow_accepted')
      and actor_id is not null and event_at is not null and data = '{}'::jsonb)
    or (type = 'moderation'
      and actor_id is null and event_at is null
      and data - 'status' = '{}'::jsonb and data ->> 'status' in ('suspended', 'active'))
  )
);

create index notifications_recipient_idx on public.notifications (recipient_id, id desc);
create index notifications_unread_idx on public.notifications (recipient_id, id desc) where read_at is null;
create index notifications_actor_idx on public.notifications (actor_id, recipient_id) where actor_id is not null;

alter table public.notifications enable row level security;
revoke all on public.notifications from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Preferences (D9): in-app only, on unless set to false. Moderation can't be off.
-- ---------------------------------------------------------------------------

alter table public.user_preferences add constraint user_preferences_notification_settings_valid check (
  notification_settings - array['follow', 'follow_request', 'follow_accepted'] = '{}'::jsonb
  and coalesce(jsonb_typeof(notification_settings -> 'follow'), 'boolean') = 'boolean'
  and coalesce(jsonb_typeof(notification_settings -> 'follow_request'), 'boolean') = 'boolean'
  and coalesce(jsonb_typeof(notification_settings -> 'follow_accepted'), 'boolean') = 'boolean'
);

-- ---------------------------------------------------------------------------
-- 3. Creation
-- ---------------------------------------------------------------------------

-- Stores one notification, unless the recipient turned the type off or it's a
-- duplicate. Turning a type off means nothing is stored, and turning it back on brings
-- nothing back. Follow changes call this under the M3 pair lock, so two racing calls for
-- the same pair can't both pass the 24-hour check.
create function private.notify(p_recipient uuid, p_actor uuid, p_type public.notification_type, p_event_at timestamptz, p_data jsonb default '{}')
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_type <> 'moderation' and exists (
    select 1 from public.user_preferences up
    where up.user_id = p_recipient and up.notification_settings ->> p_type::text = 'false'
  ) then
    return;
  end if;

  -- D3: repeated follow, unfollow, follow notifies once per 24 hours.
  if p_type = 'follow' and exists (
    select 1 from public.notifications n
    where n.recipient_id = p_recipient and n.actor_id = p_actor and n.type = 'follow'
      and n.created_at > pg_catalog.now() - interval '24 hours'
  ) then
    return;
  end if;

  insert into public.notifications (recipient_id, actor_id, type, event_at, data)
  values (p_recipient, p_actor, p_type, p_event_at, p_data)
  on conflict (recipient_id, actor_id, type, event_at) do nothing;
end;
$$;

-- Follow changes, from the status transition alone:
--   new pending, or cancelled -> pending     follow_request to the followee
--   new accepted, or cancelled -> accepted   follow to the followee
--   pending -> accepted                      follow_accepted to the follower
--   pending -> anything else, or removed     the follow_request notice is withdrawn
-- A cooldown retry stays rejected, or moves cancelled -> rejected, so it notifies nobody.
--
-- SECURITY DEFINER because account deletion reaches it: Auth deletes the user as its own
-- role, and the cascade removes their follow rows, which withdraws request notices. The
-- trigger acts only on the rows it is given.
create function private.notify_follow_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' and old.status = 'pending' and (tg_op = 'DELETE' or new.status <> 'pending') then
    delete from public.notifications n
    where n.recipient_id = old.followee_id and n.actor_id = old.follower_id and n.type = 'follow_request';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_op = 'INSERT' or new.status <> old.status then
    if new.status = 'pending' then
      perform private.notify(new.followee_id, new.follower_id, 'follow_request', new.requested_at);
    elsif new.status = 'accepted' and tg_op = 'UPDATE' and old.status = 'pending' then
      perform private.notify(new.follower_id, new.followee_id, 'follow_accepted', new.accepted_at);
    elsif new.status = 'accepted' then
      perform private.notify(new.followee_id, new.follower_id, 'follow', new.accepted_at);
    end if;
  end if;
  return new;
end;
$$;

create trigger notify_follow_change
  after insert or update or delete on public.follows
  for each row execute function private.notify_follow_change();

-- A block removes every notification between the two users, in both directions, under
-- the pair lock block_user holds. Nothing comes back on unblock.
create function private.remove_notifications_on_block()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.notifications n
  where (n.recipient_id = new.blocker_id and n.actor_id = new.blocked_id)
     or (n.recipient_id = new.blocked_id and n.actor_id = new.blocker_id);
  return new;
end;
$$;

create trigger remove_notifications_on_block
  after insert on public.blocked_users
  for each row execute function private.remove_notifications_on_block();

-- Suspension and reinstatement always notify the account (D8), whoever made the change.
-- Deactivation isn't a moderation action and doesn't notify.
create function private.notify_account_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.notify(new.id, null, 'moderation', null, pg_catalog.jsonb_build_object('status', new.account_status));
  return new;
end;
$$;

create trigger notify_account_status_change
  after update of account_status on public.profiles
  for each row
  when ((old.account_status = 'active' and new.account_status = 'suspended')
     or (old.account_status = 'suspended' and new.account_status = 'active'))
  execute function private.notify_account_status_change();

revoke all on function private.notify(uuid, uuid, public.notification_type, timestamptz, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.notify_follow_change() from public, anon, authenticated, service_role;
revoke all on function private.remove_notifications_on_block() from public, anon, authenticated, service_role;
revoke all on function private.notify_account_status_change() from public, anon, authenticated, service_role;
