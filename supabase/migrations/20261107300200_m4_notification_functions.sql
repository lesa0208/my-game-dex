-- M4b Notifications: the only client path to notifications (D11).
--
-- Design: docs/architecture/security-rls.md#notifications
-- Every function takes the recipient from auth.uid(), never from an argument, and acts
-- only on the caller's own notifications. Suspended accounts can still read and manage
-- them, including their own moderation notice.
--
-- Visibility, applied the same way by the list, the count and mark-as-read: a
-- notification shows only while its actor is visible now, by the M3 rule for profile
-- cards. The actor must be active, have a handle and share no block with the caller. A
-- hidden notification isn't deleted, and shows again if its actor becomes visible.
-- Moderation notices have no actor and always show. Keep the three filters in step.

-- Newest first, 1 to 100 rows, paged by id.
create function public.get_my_notifications(p_limit integer default 50, p_before uuid default null)
returns table (
  id uuid,
  type text,
  created_at timestamptz,
  read_at timestamptz,
  actor_id uuid,
  actor_handle text,
  actor_display_name text,
  actor_avatar_path text,
  data jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
  v_peers uuid[] := private.block_peers();
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid page request' using errcode = '22023';
  end if;
  return query
    select n.id, n.type::text, n.created_at, n.read_at, n.actor_id, a.handle::text, a.display_name, a.avatar_path, n.data
    from public.notifications n
    left join public.profiles a on a.id = n.actor_id
    where n.recipient_id = v_me
      and (p_before is null or n.id < p_before)
      and (n.actor_id is null or (a.handle is not null and a.account_status = 'active' and not (n.actor_id = any (v_peers))))
    order by n.id desc
    limit p_limit;
end;
$$;

-- Counts up to 100, so the interface shows "99+" beyond 99.
create function public.get_unread_notification_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
  v_peers uuid[] := private.block_peers();
begin
  return (
    select count(*)::integer from (
      select 1
      from public.notifications n
      left join public.profiles a on a.id = n.actor_id
      where n.recipient_id = v_me
        and n.read_at is null
        and (n.actor_id is null or (a.handle is not null and a.account_status = 'active' and not (n.actor_id = any (v_peers))))
      limit 100
    ) x
  );
end;
$$;

-- Marks the caller's visible unread notifications as read, up to and including
-- p_up_to: pass the newest id the user has seen, so anything newer stays unread. Null
-- means everything visible now. Returns how many changed, and repeating it is harmless.
-- Rows another transaction has locked are skipped: they're being deleted or marked
-- already. So this never waits on a row lock, and can't take part in a deadlock.
create function public.mark_notifications_read(p_up_to uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
  v_peers uuid[] := private.block_peers();
  v_count integer;
begin
  with marked as (
    update public.notifications n
    set read_at = pg_catalog.now()
    where n.recipient_id = v_me
      and n.read_at is null
      and n.id in (
        select x.id
        from public.notifications x
        left join public.profiles a on a.id = x.actor_id
        where x.recipient_id = v_me
          and x.read_at is null
          and (p_up_to is null or x.id <= p_up_to)
          and (x.actor_id is null or (a.handle is not null and a.account_status = 'active' and not (x.actor_id = any (v_peers))))
        for update of x skip locked
      )
    returning 1
  )
  select count(*)::integer into v_count from marked;
  return v_count;
end;
$$;

-- Deletes one of the caller's notifications. Silent if it doesn't exist or isn't theirs.
create function public.delete_notification(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_verified_user();
begin
  delete from public.notifications n where n.id = p_id and n.recipient_id = v_me;
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.get_my_notifications(integer, uuid)',
    'public.get_unread_notification_count()',
    'public.mark_notifications_read(uuid)',
    'public.delete_notification(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
