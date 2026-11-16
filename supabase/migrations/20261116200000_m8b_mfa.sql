-- M8b Superadmin foundation: MFA enforcement for staff (D3, D16) and the maturity of
-- TOTP factors for Owner authority (D13).
--
-- Design: docs/architecture/security-rls.md#mfa-for-staff-m8
-- Staff privileges exist only in a live aal2 session with a verified TOTP factor.
-- The JWT alone isn't trusted: a signed-out or downgraded session keeps its claims
-- until it expires, so every check reads Auth's live session, factor and claim rows.
-- Nothing here writes to the auth schema. If Auth's tables stop matching what this
-- reads, every check fails closed (staff are refused) and logs why; the operator
-- functions don't depend on these checks.

-- ---------------------------------------------------------------------------
-- 1. The live MFA state of the caller's session
-- ---------------------------------------------------------------------------

-- True when the caller's JWT says aal2, names a session that still exists for them
-- at aal2 and hasn't passed not_after, and the factor that verified that session
-- (sessions.factor_id) still exists, verified. Auth also downgrades a session whose
-- factor is removed; this doesn't rely on it.
create function private.mfa_session_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
  v_me uuid := (select auth.uid());
  v_session uuid;
begin
  if v_me is null or v_claims is null or v_claims ->> 'aal' is distinct from 'aal2' then
    return false;
  end if;
  begin
    v_session := (v_claims ->> 'session_id')::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  if v_session is null then
    return false;
  end if;
  return exists (
    select 1
    from auth.sessions s
    join auth.mfa_factors f on f.id = s.factor_id
    where s.id = v_session and s.user_id = v_me and s.aal = 'aal2'
      and (s.not_after is null or s.not_after > pg_catalog.now())
      and f.user_id = v_me and f.factor_type = 'totp' and f.status = 'verified'
  );
exception when undefined_column or undefined_table or undefined_object or invalid_text_representation then
  raise log 'mygamedex: auth schema contract broken in mfa_session_ok (%)', sqlstate;
  return false;
end;
$$;

-- True when, besides mfa_session_ok(), this session verified a TOTP code within
-- p_window. The time is Auth's live claim row, not the JWT, so refreshing a token
-- never extends it; a time more than 60 seconds ahead of the database is refused.
create function private.mfa_recent(p_window interval)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_window is null or p_window <= interval '0' or p_window > interval '10 minutes' then
    return false;
  end if;
  return private.mfa_session_ok() and exists (
    select 1 from auth.mfa_amr_claims c
    where c.session_id = (auth.jwt() ->> 'session_id')::uuid
      and c.authentication_method = 'totp'
      and c.updated_at > pg_catalog.now() - p_window
      and c.updated_at <= pg_catalog.now() + interval '60 seconds'
  );
exception when undefined_column or undefined_table or undefined_object or invalid_text_representation then
  raise log 'mygamedex: auth schema contract broken in mfa_recent (%)', sqlstate;
  return false;
end;
$$;

-- Raises 'not permitted' unless the session passes mfa_session_ok(). Returns the caller.
create function private.require_mfa()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.mfa_session_ok() then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return (select auth.uid());
end;
$$;

-- Raises 'not permitted' without MFA, and 'reauthentication required' without a
-- TOTP verification in the last p_window (10 minutes at most). Returns the caller.
create function private.require_recent_mfa(p_window interval default interval '10 minutes')
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_me uuid := private.require_mfa();
begin
  if not private.mfa_recent(p_window) then
    raise exception 'reauthentication required' using errcode = 'P0001';
  end if;
  return v_me;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Staff privileges need MFA (D3)
-- ---------------------------------------------------------------------------

-- Every staff check goes through has_staff_role, so this is the one place MFA is
-- enforced: require_active_staff (every staff function), the catalog editors' read
-- policies, can_review_submissions and is_catalog_editor. Without a live aal2
-- session, a staff member has an ordinary user's access.
create or replace function private.has_staff_role(p_role public.staff_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_roles s
    where s.user_id = (select auth.uid())
      and s.role in (p_role, 'admin'::public.staff_role)
  ) and private.mfa_session_ok()
$$;

-- ---------------------------------------------------------------------------
-- 3. Factor maturity (D13): a factor counts for Owner authority 24 hours after it
--    was registered here, never earlier than its verification.
-- ---------------------------------------------------------------------------

-- Each verified TOTP factor, recorded the first time its owner registers it from a
-- live aal2 session. registered_at is the server's time, never the client's, and the
-- row can't change afterwards. Auth's created_at (enrollment) is kept, so a factor
-- id reused for another factor never inherits maturity.
create table private.mfa_factor_registrations (
  factor_id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  factor_created_at timestamptz not null,
  registered_at timestamptz not null default now()
);
create index mfa_factor_registrations_user_idx on private.mfa_factor_registrations (user_id);
alter table private.mfa_factor_registrations enable row level security;
revoke all on private.mfa_factor_registrations from public, anon, authenticated, service_role;

create function private.mfa_registration_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'factor registrations are permanent' using errcode = 'P0001';
end;
$$;

create trigger mfa_factor_registrations_immutable
  before update on private.mfa_factor_registrations
  for each row execute function private.mfa_registration_immutable();

-- Records the caller's verified TOTP factors that aren't recorded yet, at the current
-- time, from a live aal2 session. Idempotent; concurrent calls record a factor once.
-- The app calls this right after each TOTP verification. Returns how many were added.
create function public.register_my_verified_factors()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_mfa();
  v_added integer;
begin
  insert into private.mfa_factor_registrations (factor_id, user_id, factor_created_at, registered_at)
  select f.id, f.user_id, f.created_at, pg_catalog.now()
  from auth.mfa_factors f
  where f.user_id = v_me and f.factor_type = 'totp' and f.status = 'verified'
  on conflict (factor_id) do nothing;
  get diagnostics v_added = row_count;
  return v_added;
exception when undefined_column or undefined_table or undefined_object then
  raise log 'mygamedex: auth schema contract broken in register_my_verified_factors (%)', sqlstate;
  raise exception 'not permitted' using errcode = '42501';
end;
$$;

-- Verified TOTP factors of p_user that still exist as registered and were registered
-- at least 24 hours ago. Unverified, unregistered, removed or replaced factors never
-- count. Null if Auth's tables no longer match.
create function private.mature_totp_factor_count(p_user uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  select count(*)::integer into v_count
  from auth.mfa_factors f
  join private.mfa_factor_registrations r
    on r.factor_id = f.id and r.user_id = f.user_id and r.factor_created_at = f.created_at
  where f.user_id = p_user and f.factor_type = 'totp' and f.status = 'verified'
    and r.registered_at <= pg_catalog.now() - interval '24 hours';
  return v_count;
exception when undefined_column or undefined_table or undefined_object or invalid_text_representation then
  raise log 'mygamedex: auth schema contract broken in mature_totp_factor_count (%)', sqlstate;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Owner authority (A1): eligibility, separate from designated identity
-- ---------------------------------------------------------------------------

-- Why the caller can't exercise Owner authority now, or null if they can (used by
-- the Owner-only actions in M8c):
--   owner_only                 not the designated Owner
--   mfa_required               no live aal2 session with a verified factor
--   owner_ineligible           account not in good standing, or fewer than two
--                              mature TOTP factors (D13)
--   recovery_pending           a break-glass recovery freezes Owner authority (D6)
--   reauthentication_required  no TOTP verification in the last 10 minutes
-- Protection never depends on this: is_designated_owner() alone decides that.
create function private.owner_authority_refusal()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_mature integer;
begin
  if not private.is_designated_owner(v_me) then
    return 'owner_only';
  end if;
  if not private.mfa_session_ok() then
    return 'mfa_required';
  end if;
  if private.account_standing(v_me) is not null then
    return 'owner_ineligible';
  end if;
  v_mature := private.mature_totp_factor_count(v_me);
  if v_mature is null or v_mature < 2 then
    return 'owner_ineligible';
  end if;
  if exists (select 1 from private.owner_recoveries r where r.status = 'pending') then
    return 'recovery_pending';
  end if;
  if not private.mfa_recent(interval '10 minutes') then
    return 'reauthentication_required';
  end if;
  return null;
end;
$$;

create function private.can_exercise_owner_authority()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.owner_authority_refusal() is null
$$;

-- ---------------------------------------------------------------------------
-- 5. The integrity report counts mature factors
-- ---------------------------------------------------------------------------

create or replace function private.owner_integrity()
returns table (finding text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o private.platform_owner;
  v_standing text;
  v_verified integer;
  v_mature integer;
begin
  select * into o from private.platform_owner;
  if not found then
    return query select ('no owner assigned')::text;
    return;
  end if;
  v_standing := private.account_standing(o.user_id);
  if v_standing is not null then
    return query select 'owner account: ' || v_standing;
  end if;
  if not exists (select 1 from public.staff_roles s where s.user_id = o.user_id and s.role = 'admin') then
    return query select ('owner is not an administrator')::text;
  end if;
  v_verified := private.totp_factor_count(o.user_id);
  v_mature := private.mature_totp_factor_count(o.user_id);
  if v_verified is null or v_mature is null then
    return query select ('auth contract broken')::text;
  else
    if v_verified < 2 then
      return query select ('owner has ' || v_verified || ' verified TOTP factors')::text;
    end if;
    if v_mature < 2 then
      return query select ('owner has ' || v_mature || ' mature TOTP factors')::text;
    end if;
    -- A factor enrolled, registered or verified but not registered in the last day.
    if exists (select 1 from auth.mfa_factors f where f.user_id = o.user_id and f.created_at > pg_catalog.now() - interval '24 hours')
       or exists (select 1 from private.mfa_factor_registrations r where r.user_id = o.user_id and r.registered_at > pg_catalog.now() - interval '24 hours')
       or exists (
         select 1 from auth.mfa_factors f
         where f.user_id = o.user_id and f.factor_type = 'totp' and f.status = 'verified'
           and not exists (select 1 from private.mfa_factor_registrations r where r.factor_id = f.id and r.user_id = f.user_id and r.factor_created_at = f.created_at)
       ) then
      return query select ('owner security changed in the last 24 hours')::text;
    end if;
  end if;
  if exists (select 1 from private.owner_recoveries r where r.status = 'pending') then
    return query select ('recovery pending')::text;
  end if;
  if exists (select 1 from private.ownership_transfers t where t.status = 'pending') then
    return query select ('transfer pending')::text;
  end if;
exception when undefined_column or undefined_table or undefined_object then
  return query select ('auth contract broken')::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.mfa_session_ok()',
    'private.mfa_recent(interval)',
    'private.require_mfa()',
    'private.require_recent_mfa(interval)',
    'private.mfa_registration_immutable()',
    'private.mature_totp_factor_count(uuid)',
    'private.owner_authority_refusal()',
    'private.can_exercise_owner_authority()',
    'public.register_my_verified_factors()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
end;
$$;

grant execute on function public.register_my_verified_factors() to authenticated;
