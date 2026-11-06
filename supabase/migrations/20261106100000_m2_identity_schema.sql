-- M2 Identity: accounts, preferences, staff roles and handles.
--
-- Design: docs/architecture/security-rls.md
-- No age or birth-date data is stored here. Public registration stays closed on
-- any hosted project until the legal questions in
-- docs/architecture/architecture-decisions.md are resolved.

-- ---------------------------------------------------------------------------
-- 1. Handle holds: reserved names and recently released handles
-- ---------------------------------------------------------------------------
-- In the private schema, with no grants, so no client can read or change it. It
-- stores a handle string with no link to any person.

create function private.handle_skeleton(p_handle text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  -- Removes underscores and folds the approved lookalikes: 0/o, 1/i/l, 3/e, 4/a,
  -- 5/s, 7/t. Only for reserved names and brand terms. Ordinary handles are unique
  -- by exact spelling, so mike_1985 and mike1985 can coexist.
  select translate(replace(lower(p_handle), '_', ''), '013457i', 'oleastl')
$$;

create table private.handle_holds (
  handle text primary key check (handle ~ '^[a-z0-9_]{1,40}$'),
  skeleton text generated always as (private.handle_skeleton(handle)) stored,
  kind text not null check (kind in ('reserved', 'released')),
  match text not null default 'exact' check (match in ('exact', 'contains')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'reserved') = (expires_at is null)),
  check (kind = 'reserved' or match = 'exact')
);

create index handle_holds_skeleton_idx on private.handle_holds (skeleton);
create index handle_holds_expires_idx on private.handle_holds (expires_at) where expires_at is not null;

alter table private.handle_holds enable row level security;
revoke all on private.handle_holds from public, anon, authenticated, service_role;

-- Expired holds stop applying immediately, without this. It only tidies old rows.
-- Nothing schedules it, and it never touches account data.
create function private.purge_expired_handle_holds()
returns integer
language sql
set search_path = ''
as $$
  with removed as (
    delete from private.handle_holds where kind = 'released' and expires_at <= pg_catalog.now() returning 1
  )
  select count(*)::integer from removed
$$;

-- Reserved names compare by skeleton, and released handles by exact spelling.
create function private.handle_is_held(p_handle text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from private.handle_holds h
    where (h.kind = 'released' and h.handle = p_handle and h.expires_at > pg_catalog.now())
       or (h.kind = 'reserved' and h.match = 'exact' and h.skeleton = private.handle_skeleton(p_handle))
       or (h.kind = 'reserved' and h.match = 'contains' and strpos(private.handle_skeleton(p_handle), h.skeleton) > 0)
  )
$$;

-- Serializes everything that claims or releases a handle until commit. Without it,
-- a claim could read "no hold" while another transaction is releasing that handle,
-- wait on the unique constraint, then succeed once the release commits.
create function private.lock_handle(p_handle text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('handle:' || p_handle, 0));
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- Public card columns are id, handle, display_name, avatar_path, bio and
-- country_code. Everything else has no client SELECT grant, because RLS can't hide
-- columns. Owners read their own settings through get_my_account().
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name text check (
    char_length(display_name) between 1 and 50
    and display_name is nfkc normalized
    and display_name !~ '[[:cntrl:]]'
    and display_name !~ E'[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]'
  ),
  avatar_path text,
  bio text check (
    char_length(bio) <= 500
    and bio !~ E'[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]'
  ),
  country_code text references public.markets (code) on delete set null,
  collection_visibility public.visibility_level not null default 'private',
  follow_approval_required boolean not null default false,
  allow_search_indexing boolean not null default false,
  account_status public.account_status not null default 'active',
  handle_changed_at timestamptz,
  -- Set by the first claim only, and cleared when the one correction is used.
  handle_correction_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An avatar path is always {owner id}/{random uuid}.webp, in the owner's folder.
  check (
    avatar_path is null
    or avatar_path ~ ('^' || id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$')
  ),
  check ((handle is null) = (handle_changed_at is null)),
  check (handle_correction_until is null or handle is not null)
);

create index profiles_country_idx on public.profiles (country_code) where country_code is not null;
create index profiles_handle_trgm_idx on public.profiles using gin (handle extensions.gin_trgm_ops) where handle is not null;
create index profiles_display_name_trgm_idx on public.profiles using gin (display_name extensions.gin_trgm_ops) where display_name is not null;

-- Private settings, readable only by their owner.
create table public.user_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  locale text not null default 'en' check (char_length(locale) between 2 and 35),
  timezone text check (char_length(timezone) between 1 and 64),
  theme public.theme_preference not null default 'system',
  default_currency text check (default_currency ~ '^[A-Z]{3}$'),
  preferred_region_code text references public.region_codes (code) on delete set null,
  default_item_visibility public.visibility_level not null default 'private',
  default_shelf_visibility public.visibility_level not null default 'private',
  default_post_visibility public.visibility_level not null default 'public',
  message_permission public.message_permission not null default 'followers',
  notification_settings jsonb not null default '{}' check (jsonb_typeof(notification_settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index user_preferences_region_idx on public.user_preferences (preferred_region_code) where preferred_region_code is not null;

-- Assigned only by an operator, or by audited functions from M4. See
-- docs/architecture/security-rls.md#assigning-the-first-administrator.
create table public.staff_roles (
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.staff_role not null,
  granted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create index staff_roles_granted_by_idx on public.staff_roles (granted_by) where granted_by is not null;

-- ---------------------------------------------------------------------------
-- 3. Authorization helpers
-- ---------------------------------------------------------------------------

-- Reads auth.users as well as the profile, so an account stays inactive until its
-- email is verified, even if a hosted Auth setting were wrong.
create function private.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.id = (select auth.uid())
      and p.account_status = 'active'
      and p.handle is not null
      and u.email_confirmed_at is not null
  )
$$;

-- Reads only staff_roles. Never metadata or JWT claims, which users can influence.
create function private.has_staff_role(p_role public.staff_role)
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
  )
$$;

-- ---------------------------------------------------------------------------
-- 4. Signup lifecycle
-- ---------------------------------------------------------------------------

-- Reads only new.id. raw_user_meta_data is user-controlled, so it's never used.
-- A failure rolls back the whole signup, with a message that exposes no detail.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  insert into public.user_preferences (user_id) values (new.id);
  return new;
exception
  when others then
    raise log 'handle_new_user failed with SQLSTATE %', sqlstate;
    raise exception 'account could not be created' using errcode = 'P0001';
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- A deleted account's handle is held for 30 days, so it can't be taken immediately
-- to impersonate its former owner.
create function private.hold_handle_on_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.handle is not null then
    perform private.lock_handle(old.handle);
    insert into private.handle_holds (handle, kind, expires_at)
    values (old.handle, 'released', pg_catalog.now() + interval '30 days')
    on conflict (handle) do update
      set expires_at = excluded.expires_at
      where private.handle_holds.kind = 'released';
  end if;
  return old;
end;
$$;

create trigger hold_handle_on_delete
  before delete on public.profiles
  for each row execute function private.hold_handle_on_delete();

-- Stops display names presenting as the platform, including with lookalikes.
create function private.validate_display_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.display_name is not null and exists (
    select 1 from private.handle_holds h
    where h.kind = 'reserved' and h.match = 'contains'
      and strpos(private.handle_skeleton(regexp_replace(new.display_name, '[^[:alnum:]]', '', 'g')), h.skeleton) > 0
  ) then
    raise exception 'display name not allowed' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger validate_display_name
  before insert or update of display_name on public.profiles
  for each row execute function private.validate_display_name();

create trigger set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.user_preferences
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Controlled functions
-- ---------------------------------------------------------------------------

-- The only path to setting a handle. Input may be in any case and is stored in
-- lowercase, so Marko and marko are one handle. A taken, reserved or held handle
-- gives the same answer, so this reveals nothing about which applies.
--
-- The first claim allows one correction within 24 hours. Otherwise a change needs
-- 30 days since the handle was last set. A failed attempt or a no-op changes nothing.
create function public.claim_handle(p_handle text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
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
  ) then
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
$$;

-- How an owner reads their own private settings.
create function public.get_my_account()
returns table (
  id uuid,
  handle text,
  display_name text,
  avatar_path text,
  bio text,
  country_code text,
  collection_visibility public.visibility_level,
  follow_approval_required boolean,
  allow_search_indexing boolean,
  account_status public.account_status,
  handle_changed_at timestamptz,
  handle_correction_until timestamptz,
  is_active boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.handle, p.display_name, p.avatar_path, p.bio, p.country_code,
         p.collection_visibility, p.follow_approval_required, p.allow_search_indexing,
         p.account_status, p.handle_changed_at, p.handle_correction_until, private.is_active_user()
  from public.profiles p
  where p.id = (select auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- 6. Row Level Security and grants
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.user_preferences enable row level security;
alter table public.staff_roles enable row level security;

-- A profile becomes public only after its handle is claimed, and claiming requires
-- a verified email.
create policy profiles_read on public.profiles
  for select to anon, authenticated
  using (handle is not null and account_status = 'active');

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) and private.is_active_user())
  with check (id = (select auth.uid()));

create policy user_preferences_read_own on public.user_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy user_preferences_update_own on public.user_preferences
  for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active_user())
  with check (user_id = (select auth.uid()));

create policy staff_roles_read_own on public.staff_roles
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Column grants do what the policies can't. handle, avatar_path, account_status,
-- handle_changed_at and handle_correction_until have no client write path.
grant select (id, handle, display_name, avatar_path, bio, country_code)
  on public.profiles to anon, authenticated;
grant update (display_name, bio, country_code, collection_visibility, follow_approval_required, allow_search_indexing)
  on public.profiles to authenticated;

grant select on public.user_preferences to authenticated;
grant update (locale, timezone, theme, default_currency, preferred_region_code, default_item_visibility,
              default_shelf_visibility, default_post_visibility, message_permission, notification_settings)
  on public.user_preferences to authenticated;

grant select on public.staff_roles to authenticated;

-- service_role has no table access here. It uses set_avatar_path, in the next step.

-- A policy calls this with EXECUTE alone. Without USAGE on private, clients still
-- can't call it directly.
revoke all on function private.is_active_user() from public, anon, authenticated, service_role;
grant execute on function private.is_active_user() to authenticated;

revoke all on function private.has_staff_role(public.staff_role) from public, anon, authenticated, service_role;
revoke all on function private.handle_skeleton(text) from public, anon, authenticated, service_role;
revoke all on function private.lock_handle(text) from public, anon, authenticated, service_role;
revoke all on function private.handle_is_held(text) from public, anon, authenticated, service_role;
revoke all on function private.purge_expired_handle_holds() from public, anon, authenticated, service_role;
revoke all on function private.handle_new_user() from public, anon, authenticated, service_role;
revoke all on function private.hold_handle_on_delete() from public, anon, authenticated, service_role;
revoke all on function private.validate_display_name() from public, anon, authenticated, service_role;

revoke all on function public.claim_handle(text) from public, anon, authenticated, service_role;
grant execute on function public.claim_handle(text) to authenticated;
revoke all on function public.get_my_account() from public, anon, authenticated, service_role;
grant execute on function public.get_my_account() to authenticated;
