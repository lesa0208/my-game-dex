-- M11a-2 preliminary fixes to M11a-1 invitations (local development; no hosted change).
--
-- Design: docs/architecture/security-rls.md#invitations-and-registration-m11a-1, ADR-063
-- (amended).
--
-- 1. Account enumeration. M11a-1 answered an address that already had an account with
--    no ledger row, an audit code and an RPC result without an id, so an administrator
--    could learn which addresses have accounts. Now every accepted address gets a row
--    and the same answers. A row for an address Auth already holds is "withheld": no
--    email is ever sent for it, and nothing an administrator can read says so. The
--    steps that depend on what Auth holds (whether to send, recording what Auth did,
--    the account to ban, reconciling a revocation) move to functions only the server's
--    secret key (service_role) may call, so an administrator calling the API directly
--    can't skip or fake a step to tell rows apart. Authorization stays in the
--    administrator's own session: create, resend, revoke and retry still require an
--    administrator with a recent MFA verification, and record who asked.
--
--   create_account_invitation(email, reason)            administrators, recent MFA (changed)
--   request_invitation_resend(id, reason)               administrators, recent MFA (no address returned)
--   request_invitation_revocation(id, reason)           administrators, recent MFA (no account returned)
--   retry_invitation_revocation(id)                     administrators, recent MFA (no account returned)
--   invitation_delivery_plan(id)                        service_role: the address, and whether to send
--   record_invitation_delivery(id, operation, outcome)  service_role (was administrators)
--   invitation_revocation_target(id)                    service_role: the account to ban, if any
--   reconcile_invitation(id)                            service_role (was administrators)
--
-- 2. A handle claim racing a revocation. claim_handle read the invitation without a
--    lock, and the revocation checked for a handle without one, so both could succeed.
--    Both now lock the invitation row first and decide only after holding it.

-- ---------------------------------------------------------------------------
-- 1. The ledger
-- ---------------------------------------------------------------------------

alter table private.account_invitations
  -- The address already had an account (or an invitation) in Auth: nothing is sent, the
  -- row is never linked to an account, and it never blocks anyone's onboarding.
  add column withheld boolean not null default false,
  -- When an email for this (not withheld) invitation last failed, for the delivery state.
  add column last_failed_at timestamptz,
  -- Who asked for the latest resend, for the delivery's audit row.
  add column last_resend_requested_by uuid references public.profiles (id) on delete set null;

-- One open invitation per address among those really sent; withheld rows don't count,
-- so inviting an address twice looks the same whether or not it has an account.
drop index private.account_invitations_open_email;
create unique index account_invitations_open_email on private.account_invitations (email)
  where not withheld and state not in ('revoked', 'revoked_after_acceptance');

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

-- The invitation an account came from: by the linked account, or, while it isn't linked
-- yet, by its address, but only for an account Auth created by invitation. Withheld rows
-- are never anyone's invitation.
create or replace function private.invitation_for_user(p_user uuid)
returns private.account_invitations
language sql
stable
set search_path = ''
as $$
  select i.*
  from private.account_invitations i
  where not i.withheld
    and (i.invited_user_id = p_user
      or (i.invited_user_id is null
          and i.email = (select pg_catalog.lower(u.email) from auth.users u where u.id = p_user and u.invited_at is not null)))
  order by (i.invited_user_id = p_user) desc nulls last, i.id desc
  limit 1
$$;

-- Whether invitation emails are failing now: the latest attempt to send one (for a row
-- that really sends) failed, within the last hour. Withheld rows mirror this, so an
-- outage doesn't make them stand out as the only "sent" ones.
create function private.invitation_delivery_failing()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select pg_catalog.max(i.last_failed_at) > pg_catalog.now() - interval '1 hour'
       and pg_catalog.max(i.last_failed_at) > coalesce(pg_catalog.max(i.last_sent_at), '-infinity')
    from private.account_invitations i
    where not i.withheld
  ), false)
$$;

-- Whether Auth already holds an account (of any kind) for an address, or an invitation
-- that is really out for it.
create function private.invitation_address_taken(p_email text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from auth.users u where pg_catalog.lower(u.email) = p_email)
      or exists (select 1 from private.account_invitations i
                 where i.email = p_email and not i.withheld and i.state not in ('revoked', 'revoked_after_acceptance'))
$$;

-- Records a delivery outcome on a locked row and writes its audit row. The audit row
-- names who asked (the inviter, or the administrator who asked for the resend) and, in
-- metadata no page shows, the account. Administrators see the same row either way.
create function private.finish_invitation_delivery(i private.account_invitations, p_operation text, p_ok boolean, p_user uuid)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if p_ok then
    update private.account_invitations
    set invited_user_id = case when withheld then null else p_user end,
        state = 'sent', first_sent_at = coalesce(first_sent_at, pg_catalog.now()), last_sent_at = pg_catalog.now()
    where id = i.id;
  else
    update private.account_invitations
    set state = case when first_sent_at is null then 'send_failed' else state end,
        last_failed_at = case when withheld then last_failed_at else pg_catalog.now() end
    where id = i.id;
  end if;
  perform private.record_audit(
    case when p_operation = 'resend' then coalesce(i.last_resend_requested_by, i.invited_by) else i.invited_by end,
    'account_invitation_delivery', null,
    'Invitation email ' || case when p_ok then 'handed to Auth' else 'not sent' end,
    pg_catalog.jsonb_build_object('status', case when p_ok then 'sent' else 'send_failed' end, 'operation', p_operation)
      || case when p_user is not null and not i.withheld then pg_catalog.jsonb_build_object('invitee', p_user) else '{}' end
      || case when i.withheld then pg_catalog.jsonb_build_object('withheld', true) else '{}' end);
  return case when p_ok then 'sent' else 'send_failed' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Administrators' functions (in their own session; recent MFA)
-- ---------------------------------------------------------------------------

-- Records a new invitation before anything is sent, and answers every accepted address
-- the same way, with the new row's id. An address Auth already holds gets a withheld row.
-- Limits (20 open per administrator, 200 in all) apply to every address alike.
create or replace function public.create_account_invitation(p_email text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_email text;
  v_reason text;
  v_withheld boolean;
  v_id uuid;
begin
  v_me := private.require_active_staff('admin');
  perform private.require_recent_mfa();
  v_reason := private.require_reason(p_reason);
  v_email := private.normalize_invitation_email(p_email);
  perform private.lock_staff_changes();
  if private.outstanding_invitations(v_me) >= 20 then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'invitation_limit');
  end if;
  if private.outstanding_invitations(null) >= 200 then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'invitation_limit_total');
  end if;
  v_withheld := private.invitation_address_taken(v_email);
  insert into private.account_invitations (email, invited_by, reason, withheld)
  values (v_email, v_me, v_reason, v_withheld)
  returning id into v_id;
  perform private.record_audit(v_me, 'account_invited', null, v_reason,
    pg_catalog.jsonb_build_object('status', 'pending')
      || case when v_withheld then pg_catalog.jsonb_build_object('withheld', true) else '{}' end);
  return pg_catalog.jsonb_build_object('ok', true, 'result', 'accepted', 'id', v_id);
end;
$$;

-- Allows one more email for an invitation nobody has accepted: at most one every 10
-- minutes, five in all, counted when asked. Returns nothing about the address; the
-- server takes it from invitation_delivery_plan.
create or replace function public.request_invitation_resend(p_id uuid, p_reason text)
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
  set resend_count = resend_count + 1, last_resend_requested_at = pg_catalog.now(), last_resend_requested_by = v_me
  where id = i.id;
  perform private.record_audit(v_me, 'account_invitation_resent', null, v_reason,
    pg_catalog.jsonb_build_object('status', 'requested', 'resend', i.resend_count + 1));
  return pg_catalog.jsonb_build_object('ok', true, 'result', 'resend');
end;
$$;

-- Starts a revocation, recorded and audited before anything changes in Auth. Every
-- revocation answers the same way and becomes "being revoked" until the server has
-- banned the account (if there is one) and reconciled. An invitee who has already
-- claimed a handle has a working account: that's a suspension (set_account_status).
-- The row is locked before the handle is read, as claim_handle locks it before
-- deciding, so a claim and a revocation never both succeed.
create or replace function public.request_invitation_revocation(p_id uuid, p_reason text)
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
  -- Read after the lock: a claim that committed first is seen here.
  if not i.withheld then
    v_user := coalesce(i.invited_user_id,
      (select u.id from auth.users u where pg_catalog.lower(u.email) = i.email and u.invited_at is not null));
  end if;
  if exists (select 1 from public.profiles p where p.id = v_user and p.handle is not null) then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'already_active');
  end if;
  update private.account_invitations
  set state = 'revoke_pending', invited_user_id = v_user,
      revoke_requested_at = pg_catalog.now(), revoke_requested_by = v_me, revoke_reason = v_reason, revoked_at = null
  where id = i.id;
  perform private.record_audit(v_me, 'account_invitation_revoke_requested', null, v_reason,
    pg_catalog.jsonb_build_object('status', 'revoke_pending')
      || case when v_user is not null then pg_catalog.jsonb_build_object('invitee', v_user) else '{}' end);
  return pg_catalog.jsonb_build_object('ok', true, 'result', 'revoke_pending');
end;
$$;

-- Whether a revocation may be tried again (it is still being revoked). The server then
-- takes the account from invitation_revocation_target.
create or replace function public.retry_invitation_revocation(p_id uuid)
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
  if not found or i.state <> 'revoke_pending' then
    return pg_catalog.jsonb_build_object('ok', false, 'refusal', 'invitation_closed');
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'result', 'revoke_pending');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The server's functions (service_role only: the secret key, after an
--    administrator's function above authorized the step)
-- ---------------------------------------------------------------------------

-- What to do for an invitation's email: the address, and whether to hand it to Auth.
-- Never for a withheld row, or one being revoked.
create function public.invitation_delivery_plan(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i private.account_invitations;
begin
  select * into i from private.account_invitations where id = p_id;
  if not found then
    raise exception 'invitation unavailable' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object('email', i.email,
    'send', not i.withheld and i.state in ('pending', 'sent', 'send_failed'));
end;
$$;

-- Records what the server's Auth call did ('sent', 'unavailable' when Auth already holds
-- a confirmed account, 'failed', or 'skipped' when the plan said not to send). 'sent' is
-- believed only if Auth really holds an invited, unconfirmed account for the address,
-- which is then linked. 'unavailable' is believed only if Auth holds a confirmed account
-- for it, and the row becomes withheld. A withheld row is recorded as an email would
-- have been: sent, unless invitation emails are failing now. If a revocation was
-- requested meanwhile, the account Auth now has is returned, so the server bans it.
drop function public.record_invitation_delivery(uuid, text, boolean);
create function public.record_invitation_delivery(p_id uuid, p_operation text, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i private.account_invitations;
  v_user uuid;
begin
  if p_operation is null or p_operation not in ('invite', 'resend')
     or p_outcome is null or p_outcome not in ('sent', 'unavailable', 'failed', 'skipped') then
    raise exception 'invalid invitation' using errcode = '22023';
  end if;
  select * into i from private.account_invitations where id = p_id for update;
  if not found then
    raise exception 'invitation unavailable' using errcode = 'P0001';
  end if;
  if not i.withheld then
    select u.id into v_user
    from auth.users u
    where pg_catalog.lower(u.email) = i.email and u.invited_at is not null and u.email_confirmed_at is null;
  end if;
  if i.state in ('revoke_pending', 'revoked', 'revoked_after_acceptance') then
    if v_user is not null and i.invited_user_id is null then
      update private.account_invitations set invited_user_id = v_user, state = 'revoke_pending', revoked_at = null where id = i.id;
      return pg_catalog.jsonb_build_object('ok', true, 'result', 'revoke_pending', 'user_id', v_user);
    end if;
    return pg_catalog.jsonb_build_object('ok', true, 'result', i.state);
  end if;
  if not i.withheld and p_outcome = 'unavailable' and v_user is null
     and exists (select 1 from auth.users u where pg_catalog.lower(u.email) = i.email and u.email_confirmed_at is not null) then
    -- An account was made for the address after the invitation was recorded.
    update private.account_invitations set withheld = true where id = i.id returning * into i;
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'result', private.finish_invitation_delivery(i, p_operation,
    case when i.withheld then not private.invitation_delivery_failing() else p_outcome = 'sent' and v_user is not null end,
    v_user));
end;
$$;

-- The account to ban for a revocation in progress, if there is one (never for a
-- withheld row).
create function public.invitation_revocation_target(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i private.account_invitations;
begin
  select * into i from private.account_invitations where id = p_id;
  if not found then
    raise exception 'invitation unavailable' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object('user_id',
    case when i.state = 'revoke_pending' and not i.withheld then i.invited_user_id end);
end;
$$;

-- Brings a revocation in line with Auth, which it reads itself: only a ban Auth actually
-- holds completes it. A row with no account (withheld, or never sent) completes at once.
-- An account that confirmed its email first is recorded as revoked after acceptance and
-- stays banned and unable to onboard. Nothing here deletes or unbans an account. The
-- audit row names the administrator who asked for the revocation.
create or replace function public.reconcile_invitation(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i private.account_invitations;
  v_banned boolean;
  v_confirmed boolean;
  v_state text;
begin
  select * into i from private.account_invitations where id = p_id for update;
  if not found then
    raise exception 'invitation unavailable' using errcode = 'P0001';
  end if;
  if i.state <> 'revoke_pending' then
    return pg_catalog.jsonb_build_object('ok', true, 'result', i.state);
  end if;
  if i.withheld or i.invited_user_id is null then
    v_state := 'revoked';
  else
    select coalesce(u.banned_until > pg_catalog.now(), false), u.email_confirmed_at is not null
    into v_banned, v_confirmed
    from auth.users u where u.id = i.invited_user_id;
    if not found then
      v_state := 'revoked';
    elsif v_banned then
      v_state := case when v_confirmed then 'revoked_after_acceptance' else 'revoked' end;
    else
      return pg_catalog.jsonb_build_object('ok', true, 'result', 'revoke_pending');
    end if;
  end if;
  update private.account_invitations set state = v_state, revoked_at = pg_catalog.now() where id = i.id;
  perform private.record_audit(i.revoke_requested_by, 'account_invitation_revoked', null, 'Revocation confirmed in Auth',
    pg_catalog.jsonb_build_object('status', v_state)
      || case when i.invited_user_id is not null and not i.withheld then pg_catalog.jsonb_build_object('invitee', i.invited_user_id) else '{}' end);
  return pg_catalog.jsonb_build_object('ok', true, 'result', v_state);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. claim_handle: lock the invitation before deciding
-- ---------------------------------------------------------------------------

-- As in M11a-1, with one change: the caller's invitation row is locked (as the
-- revocation locks it) before eligibility is decided, and the decision reads it after
-- the lock. Lock order: invitation, then profile, then handles, the same as or a
-- prefix of every other path that takes these locks.
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
  if v_me is not null then
    perform 1 from private.account_invitations i
    where i.id = (select x.id from private.invitation_for_user(v_me) x)
    for update;
  end if;

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
-- 6. Privileges
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.invitation_delivery_failing()',
    'private.invitation_address_taken(text)',
    'private.finish_invitation_delivery(private.account_invitations, text, boolean, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.invitation_delivery_plan(uuid)',
    'public.record_invitation_delivery(uuid, text, text)',
    'public.invitation_revocation_target(uuid)',
    'public.reconcile_invitation(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
