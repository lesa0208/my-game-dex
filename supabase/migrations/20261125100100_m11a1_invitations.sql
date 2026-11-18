-- M11a-1 Invitations and registration (local development; no hosted change).
--
-- Design: docs/architecture/security-rls.md#invitations-and-registration-m11a-1.
--
-- Invitations are Supabase-native: the server sends them with Auth's Admin API, using a
-- server-only secret key, only after these functions authorize the administrator in their
-- own session. The ledger below is the record of who invited whom and what state each
-- invitation is in. The database never trusts the server's word about Auth: it reads
-- auth.users itself (read-only) to confirm an invitation was created, an account was
-- banned, or an email was confirmed, and auth.audit_log_entries to confirm a password was
-- actually set.
--
--   create_account_invitation(email, reason)        administrators, recent MFA
--   record_invitation_delivery(id, operation, sent)  administrators, recent MFA
--   request_invitation_resend(id, reason)            administrators, recent MFA
--   request_invitation_revocation(id, reason)        administrators, recent MFA
--   retry_invitation_revocation(id)                  administrators, recent MFA
--   reconcile_invitation(id)                         administrators
--   get_account_invitations(limit, before)           administrators: masked emails
--   get_my_onboarding()                              the caller's own onboarding state
--   complete_my_password_setup()                     the caller, after Auth set a password
--
-- Revocation never deletes an Auth account. It records the request, the server bans the
-- account in Auth, and reconciliation reads the ban back. A revoked or revoke-pending
-- invitee can't record a password or claim a handle (claim_handle checks), so they can't
-- finish onboarding even with a token issued before the ban.

-- ---------------------------------------------------------------------------
-- 1. The ledger
-- ---------------------------------------------------------------------------

create table private.account_invitations (
  id uuid primary key default private.uuid_v7(),
  -- Normalized at entry; only administrators' functions read it, and lists show it masked.
  email text not null check (
    email = pg_catalog.lower(pg_catalog.btrim(email)) and pg_catalog.char_length(email) between 3 and 254
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  invited_user_id uuid references public.profiles (id) on delete set null,
  invited_by uuid references public.profiles (id) on delete set null,
  state text not null default 'pending'
    check (state in ('pending', 'sent', 'send_failed', 'revoke_pending', 'revoked', 'revoked_after_acceptance')),
  reason text not null check (pg_catalog.char_length(reason) between 1 and 500),
  created_at timestamptz not null default pg_catalog.now(),
  first_sent_at timestamptz,
  last_sent_at timestamptz,
  resend_count integer not null default 0 check (resend_count between 0 and 5),
  last_resend_requested_at timestamptz,
  revoke_requested_at timestamptz,
  revoke_requested_by uuid references public.profiles (id) on delete set null,
  revoke_reason text check (revoke_reason is null or pg_catalog.char_length(revoke_reason) between 1 and 500),
  revoked_at timestamptz,
  -- Set only by complete_my_password_setup, after Auth recorded a password change.
  password_set_at timestamptz
);

-- One open invitation per address; a revoked one doesn't block a new one.
create unique index account_invitations_open_email on private.account_invitations (email)
  where state not in ('revoked', 'revoked_after_acceptance');
create unique index account_invitations_user on private.account_invitations (invited_user_id) where invited_user_id is not null;
create index account_invitations_by on private.account_invitations (invited_by, state);
create index account_invitations_order on private.account_invitations (id desc);

alter table private.account_invitations enable row level security;
revoke all on private.account_invitations from public, anon, authenticated, service_role, catalog_importer;

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

-- An address for a list: first letter, the domain's first letter and its last label.
-- "jane@example.com" becomes "j***@e***.com".
create function private.mask_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.left(pg_catalog.split_part(p_email, '@', 1), 1) || '***@'
    || pg_catalog.left(pg_catalog.split_part(p_email, '@', 2), 1) || '***.'
    || pg_catalog.reverse(pg_catalog.split_part(pg_catalog.reverse(p_email), '.', 1))
$$;

-- The invitation an account came from: by the linked account, or, while it isn't linked
-- yet (the server stopped between sending and recording), by its address.
create function private.invitation_for_user(p_user uuid)
returns private.account_invitations
language sql
stable
set search_path = ''
as $$
  select i.*
  from private.account_invitations i
  where i.invited_user_id = p_user
     or (i.invited_user_id is null
         and i.email = (select pg_catalog.lower(u.email) from auth.users u where u.id = p_user))
  order by (i.invited_user_id = p_user) desc nulls last, i.id desc
  limit 1
$$;

-- Whether an account came from an invitation it can't finish yet: one being revoked or
-- revoked, or one whose password hasn't been set. Accounts that didn't come from an
-- invitation (made before M11a, or by an operator) are never blocked by this.
create function private.invitation_onboarding_blocked(p_user uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select i.state in ('revoke_pending', 'revoked', 'revoked_after_acceptance') or i.password_set_at is null
    from private.invitation_for_user(p_user) i
    where i.id is not null
  ), false)
$$;

-- Invitations an administrator has out: not revoked, and not yet accepted.
create function private.outstanding_invitations(p_by uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
  from private.account_invitations i
  left join auth.users u on u.id = i.invited_user_id
  where i.state in ('pending', 'sent', 'send_failed', 'revoke_pending')
    and u.email_confirmed_at is null
    and (p_by is null or i.invited_by = p_by)
$$;

create function private.normalize_invitation_email(p_email text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
begin
  if v_email is null or pg_catalog.char_length(v_email) not between 3 and 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid email' using errcode = '22023';
  end if;
  return v_email;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Administrators' functions
-- ---------------------------------------------------------------------------

-- Records a new invitation before anything is sent. An address that already has an
-- account or an open invitation gets the same answer as one that doesn't ('accepted'
-- with no id), so a page can't tell them apart; the refusal is audited without the
-- address. Limits: 20 open invitations per administrator, 200 in all.
create function public.create_account_invitation(p_email text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_email text;
  v_reason text;
  v_id uuid;
begin
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  v_email := private.normalize_invitation_email(p_email);
  perform private.lock_staff_changes();
  if exists (select 1 from auth.users u where pg_catalog.lower(u.email) = v_email)
     or exists (select 1 from private.account_invitations i where i.email = v_email and i.state not in ('revoked', 'revoked_after_acceptance')) then
    perform private.record_audit(v_me, 'account_invited', null, v_reason, pg_catalog.jsonb_build_object('status', 'not_sent', 'code', 'address_unavailable'));
    return pg_catalog.jsonb_build_object('ok', true, 'result', 'accepted');
  end if;
  if private.outstanding_invitations(v_me) >= 20 then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'invitation_limit');
  end if;
  if private.outstanding_invitations(null) >= 200 then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'invitation_limit_total');
  end if;
  insert into private.account_invitations (email, invited_by, reason)
  values (v_email, v_me, v_reason)
  returning id into v_id;
  perform private.record_audit(v_me, 'account_invited', null, v_reason, pg_catalog.jsonb_build_object('status', 'pending'));
  return pg_catalog.jsonb_build_object('ok', true, 'result', 'accepted', 'id', v_id);
end;
$$;

-- Records what the server's Auth call did. 'sent' is believed only if Auth really holds
-- an invited, unconfirmed account for the address, which is then linked. If a revocation
-- was requested meanwhile, the invitation stays being revoked and the account it now has
-- is returned, so the server bans it.
create function public.record_invitation_delivery(p_id uuid, p_operation text, p_sent boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  i private.account_invitations;
  v_user uuid;
  v_ok boolean;
begin
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  if p_operation is null or p_operation not in ('invite', 'resend') or p_sent is null then
    raise exception 'invalid invitation' using errcode = '22023';
  end if;
  select * into i from private.account_invitations where id = p_id for update;
  if not found then
    raise exception 'invitation unavailable' using errcode = 'P0001';
  end if;
  select u.id into v_user
  from auth.users u
  where pg_catalog.lower(u.email) = i.email and u.invited_at is not null and u.email_confirmed_at is null;
  v_ok := p_sent and v_user is not null;
  if i.state in ('revoke_pending', 'revoked', 'revoked_after_acceptance') then
    if v_user is not null and i.invited_user_id is null then
      update private.account_invitations set invited_user_id = v_user, state = 'revoke_pending', revoked_at = null where id = i.id;
      return pg_catalog.jsonb_build_object('ok', true, 'result', 'revoke_pending', 'user_id', v_user);
    end if;
    return pg_catalog.jsonb_build_object('ok', true, 'result', i.state);
  end if;
  if v_ok then
    update private.account_invitations
    set invited_user_id = v_user, state = 'sent', first_sent_at = coalesce(first_sent_at, pg_catalog.now()), last_sent_at = pg_catalog.now()
    where id = i.id;
  elsif i.first_sent_at is null then
    update private.account_invitations set state = 'send_failed' where id = i.id;
  end if;
  perform private.record_audit(v_me, 'account_invitation_delivery', v_user, 'Invitation email ' || case when v_ok then 'handed to Auth' else 'not sent' end,
    pg_catalog.jsonb_build_object('status', case when v_ok then 'sent' else 'send_failed' end, 'operation', p_operation));
  return pg_catalog.jsonb_build_object('ok', true, 'result', case when v_ok then 'sent' else 'send_failed' end);
end;
$$;

-- Allows one more email for an invitation nobody has accepted: at most one every 10
-- minutes, five in all. Counted when asked, so a failing send can't be retried without
-- limit. Returns the address to the server only, to hand to Auth.
create function public.request_invitation_resend(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  i private.account_invitations;
  v_confirmed boolean;
begin
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  select * into i from private.account_invitations where id = p_id for update;
  if not found then
    raise exception 'invitation unavailable' using errcode = 'P0001';
  end if;
  select u.email_confirmed_at is not null into v_confirmed from auth.users u where u.id = i.invited_user_id;
  if i.state not in ('sent', 'send_failed') then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'invitation_closed');
  elsif coalesce(v_confirmed, false) then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'already_accepted');
  elsif i.resend_count >= 5 then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'resend_limit');
  elsif greatest(i.last_sent_at, i.last_resend_requested_at) > pg_catalog.now() - interval '10 minutes' then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'resend_too_soon');
  end if;
  update private.account_invitations
  set resend_count = resend_count + 1, last_resend_requested_at = pg_catalog.now()
  where id = i.id;
  perform private.record_audit(v_me, 'account_invitation_resent', i.invited_user_id, v_reason,
    pg_catalog.jsonb_build_object('status', 'requested', 'resend', i.resend_count + 1));
  return pg_catalog.jsonb_build_object('ok', true, 'result', 'resend', 'email', i.email);
end;
$$;

-- Starts a revocation, recorded and audited before anything changes in Auth. From here
-- the invitee can't record a password or claim a handle. An invitee who has already
-- claimed a handle has a working account: that's a suspension (set_account_status), not
-- a revocation. Returns the account the server must ban, if there is one.
create function public.request_invitation_revocation(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  i private.account_invitations;
  v_user uuid;
begin
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  select * into i from private.account_invitations where id = p_id for update;
  if not found then
    raise exception 'invitation unavailable' using errcode = 'P0001';
  end if;
  if i.state in ('revoke_pending', 'revoked', 'revoked_after_acceptance') then
    return pg_catalog.jsonb_build_object('ok', true, 'result', 'unchanged');
  end if;
  v_user := coalesce(i.invited_user_id, (select u.id from auth.users u where pg_catalog.lower(u.email) = i.email));
  if exists (select 1 from public.profiles p where p.id = v_user and p.handle is not null) then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'already_active');
  end if;
  update private.account_invitations
  set state = case when v_user is null then 'revoked' else 'revoke_pending' end,
      invited_user_id = v_user,
      revoke_requested_at = pg_catalog.now(), revoke_requested_by = v_me, revoke_reason = v_reason,
      revoked_at = case when v_user is null then pg_catalog.now() end
  where id = i.id;
  perform private.record_audit(v_me, 'account_invitation_revoke_requested', v_user, v_reason,
    pg_catalog.jsonb_build_object('status', case when v_user is null then 'revoked' else 'revoke_pending' end));
  return pg_catalog.jsonb_build_object('ok', true, 'result', case when v_user is null then 'revoked' else 'revoke_pending' end, 'user_id', v_user);
end;
$$;

-- The account to ban again for a revocation that hasn't been confirmed yet.
create function public.retry_invitation_revocation(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i private.account_invitations;
begin
  perform private.require_active_staff('admin');
  perform private.require_recent_mfa();
  select * into i from private.account_invitations where id = p_id;
  if not found or i.state <> 'revoke_pending' or i.invited_user_id is null then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'invitation_closed');
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'result', 'revoke_pending', 'user_id', i.invited_user_id);
end;
$$;

-- Brings a revocation in line with Auth, which it reads itself: only a ban Auth actually
-- holds completes it. An account that confirmed its email first is recorded as revoked
-- after acceptance and stays banned and unable to onboard; nothing here deletes or unbans
-- an account. Without a ban, the revocation stays pending, and still blocks onboarding.
create function public.reconcile_invitation(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  i private.account_invitations;
  v_banned boolean;
  v_confirmed boolean;
  v_state text;
begin
  v_me := private.require_active_staff('admin');
  select * into i from private.account_invitations where id = p_id for update;
  if not found then
    raise exception 'invitation unavailable' using errcode = 'P0001';
  end if;
  if i.state <> 'revoke_pending' then
    return pg_catalog.jsonb_build_object('ok', true, 'result', i.state);
  end if;
  select coalesce(u.banned_until > pg_catalog.now(), false), u.email_confirmed_at is not null
  into v_banned, v_confirmed
  from auth.users u where u.id = i.invited_user_id;
  if not found then
    -- The account no longer exists in Auth, so nothing can use the invitation.
    v_state := 'revoked';
  elsif v_banned then
    v_state := case when v_confirmed then 'revoked_after_acceptance' else 'revoked' end;
  else
    return pg_catalog.jsonb_build_object('ok', true, 'result', 'revoke_pending');
  end if;
  update private.account_invitations set state = v_state, revoked_at = pg_catalog.now() where id = i.id;
  perform private.record_audit(v_me, 'account_invitation_revoked', i.invited_user_id, 'Revocation confirmed in Auth',
    pg_catalog.jsonb_build_object('status', v_state));
  return pg_catalog.jsonb_build_object('ok', true, 'result', v_state);
end;
$$;

-- The invitations, newest first, for administrators: masked addresses and a status
-- derived from the ledger and Auth, never the address, the reason or an account id.
create function public.get_account_invitations(p_limit integer default 50, p_before uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
begin
  v_me := private.require_active_staff('admin');
  return pg_catalog.jsonb_build_object(
    'limits', pg_catalog.jsonb_build_object('mine', private.outstanding_invitations(v_me), 'mine_max', 20,
      'total', private.outstanding_invitations(null), 'total_max', 200),
    'invitations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', x.id,
        'email', private.mask_email(x.email),
        'status', case
          -- From Auth as it is now: an acceptance that began before the ban can finish after
          -- the revocation was confirmed, and then shows as revoked after acceptance.
          when x.state in ('revoked', 'revoked_after_acceptance') then case when x.confirmed then 'revoked_after_acceptance' else 'revoked' end
          when x.state in ('revoke_pending', 'send_failed') then x.state
          when x.state = 'pending' then 'sending'
          when x.handle is not null then 'active'
          when x.confirmed then case when x.password_set_at is not null then 'password_set' else 'accepted' end
          when x.last_sent_at < pg_catalog.now() - interval '1 hour' then 'expired'
          else 'sent' end,
        'invited_by', (select p.handle from public.profiles p where p.id = x.invited_by),
        'created_at', x.created_at,
        'last_sent_at', x.last_sent_at,
        'resends_left', 5 - x.resend_count,
        'next_resend_at', case when x.state in ('sent', 'send_failed') and not x.confirmed and x.resend_count < 5
          -- The same rule as request_invitation_resend: 10 minutes after the last email or resend.
          then greatest(x.last_sent_at, x.last_resend_requested_at) + interval '10 minutes' end,
        'revoked_at', x.revoked_at
      ) order by x.id desc)
      from (
        select i.*, coalesce(u.email_confirmed_at is not null, false) as confirmed, p.handle
        from private.account_invitations i
        left join auth.users u on u.id = i.invited_user_id
        left join public.profiles p on p.id = i.invited_user_id
        where p_before is null or i.id < p_before
        order by i.id desc
        limit least(greatest(coalesce(p_limit, 50), 1), 100)
      ) x
    ), '[]'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The invitee's own onboarding
-- ---------------------------------------------------------------------------

-- The caller's onboarding state: whether they came from an invitation, whether its
-- password step is done, and whether it was revoked. Nothing about anyone else.
create function public.get_my_onboarding()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  i private.account_invitations;
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  i := private.invitation_for_user(v_me);
  return pg_catalog.jsonb_build_object(
    'invited', i.id is not null,
    'password_set', i.password_set_at is not null,
    'revoked', coalesce(i.state in ('revoke_pending', 'revoked', 'revoked_after_acceptance'), false));
end;
$$;

-- Records that the caller set their password. Believed only if Auth logged a password
-- change for this account after it accepted the invitation (auth.audit_log_entries,
-- read-only). Only the caller's own invitation, once; repeating it changes nothing.
-- A revoked or revoke-pending invitation refuses. If Auth's log can't be read, it fails
-- closed: the step stays undone.
create function public.complete_my_password_setup()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  i private.account_invitations;
  v_accepted timestamptz;
  v_evidence boolean := false;
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  i := private.invitation_for_user(v_me);
  if i.id is null then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'not_invited');
  end if;
  if i.state in ('revoke_pending', 'revoked', 'revoked_after_acceptance') then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'invitation_revoked');
  end if;
  if i.password_set_at is not null then
    return pg_catalog.jsonb_build_object('ok', true, 'result', 'unchanged');
  end if;
  select u.email_confirmed_at into v_accepted from auth.users u where u.id = v_me;
  if v_accepted is null then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'not_accepted');
  end if;
  begin
    select exists (
      select 1 from auth.audit_log_entries a
      where a.payload ->> 'action' = 'user_updated_password'
        and a.payload ->> 'actor_id' = v_me::text
        and a.created_at >= v_accepted)
    into v_evidence;
  exception when undefined_table or undefined_column or invalid_text_representation then
    raise log 'mygamedex: auth audit log contract broken in complete_my_password_setup (%)', sqlstate;
    v_evidence := false;
  end;
  if not v_evidence then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'password_not_set');
  end if;
  update private.account_invitations
  set password_set_at = pg_catalog.now(), invited_user_id = v_me
  where id = i.id and password_set_at is null;
  return pg_catalog.jsonb_build_object('ok', true, 'result', 'recorded');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. claim_handle (M2): an invitee claims a handle only after the password step, and
--    never once the invitation is being revoked. Otherwise unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.claim_handle(p_handle text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_handle text;
  v_current text;
  v_changed_at timestamptz;
  v_correction_until timestamptz;
begin
  if v_me is null or not exists (
    select 1
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.id = v_me and p.account_status = 'active' and u.email_confirmed_at is not null
  ) or private.invitation_onboarding_blocked(v_me) then
    raise exception 'account not eligible' using errcode = '42501';
  end if;

  -- Validated before lowercasing, because some non-ASCII letters lowercase to ASCII.
  if p_handle is null or p_handle !~ '^[A-Za-z0-9_]{3,24}$' then
    raise exception 'invalid handle' using errcode = '22023';
  end if;
  v_handle := pg_catalog.lower(p_handle collate pg_catalog."C");

  select p.handle, p.handle_changed_at, p.handle_correction_until
  into v_current, v_changed_at, v_correction_until
  from public.profiles p
  where p.id = v_me
  for update;

  if v_current = v_handle then
    return v_current;
  end if;

  if v_current is not null
    and coalesce(v_correction_until > pg_catalog.now(), false) is false
    and v_changed_at > pg_catalog.now() - interval '30 days'
  then
    raise exception 'handle change not available yet' using errcode = 'P0001';
  end if;

  -- In a fixed order, so two users swapping handles can't deadlock.
  if v_current is null then
    perform private.lock_handle(v_handle);
  else
    perform private.lock_handle(least(v_current, v_handle));
    perform private.lock_handle(greatest(v_current, v_handle));
  end if;

  if private.handle_is_held(v_handle) then
    raise exception 'handle unavailable' using errcode = 'P0001';
  end if;

  begin
    update public.profiles
    set handle = v_handle,
        handle_changed_at = pg_catalog.now(),
        handle_correction_until = case when v_current is null then pg_catalog.now() + interval '24 hours' end
    where id = v_me;
  exception
    when unique_violation then
      raise exception 'handle unavailable' using errcode = 'P0001';
  end;

  if v_current is not null then
    insert into private.handle_holds (handle, kind, expires_at)
    values (v_current, 'released', pg_catalog.now() + interval '30 days')
    on conflict (handle) do update
      set expires_at = excluded.expires_at
      where private.handle_holds.kind = 'released';
  end if;

  return v_handle;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. The audit log's "accounts" kind includes invitations (M10e)
-- ---------------------------------------------------------------------------

create or replace function private.audit_category_actions(p_category text)
returns private.audit_action[]
language sql
immutable
set search_path = ''
as $$
  select case p_category
    when 'accounts' then array['account_suspended', 'account_reinstated', 'account_invited', 'account_invitation_delivery',
      'account_invitation_resent', 'account_invitation_revoke_requested', 'account_invitation_revoked']::private.audit_action[]
    when 'staff' then array['staff_role_granted', 'staff_role_revoked', 'staff_change_refused', 'owner_protection_refused']::private.audit_action[]
    when 'ownership' then array['owner_assigned', 'ownership_transfer_started', 'ownership_transfer_accepted', 'ownership_transfer_cancelled',
      'owner_successor_set', 'owner_succession_registered', 'owner_recovery_started', 'owner_recovery_confirmed', 'owner_recovery_cancelled',
      'owner_recovery_completed', 'owner_status_set_by_operator']::private.audit_action[]
    when 'catalog' then (select pg_catalog.array_agg(a) from pg_catalog.unnest(pg_catalog.enum_range(null::private.audit_action)) a where a::text like 'catalog\_%')
    when 'operator' then array['operator_action']::private.audit_action[]
  end
$$;

-- ---------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.mask_email(text)',
    'private.invitation_for_user(uuid)',
    'private.invitation_onboarding_blocked(uuid)',
    'private.outstanding_invitations(uuid)',
    'private.normalize_invitation_email(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.create_account_invitation(text, text)',
    'public.record_invitation_delivery(uuid, text, boolean)',
    'public.request_invitation_resend(uuid, text)',
    'public.request_invitation_revocation(uuid, text)',
    'public.retry_invitation_revocation(uuid)',
    'public.reconcile_invitation(uuid)',
    'public.get_account_invitations(integer, uuid)',
    'public.get_my_onboarding()',
    'public.complete_my_password_setup()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
