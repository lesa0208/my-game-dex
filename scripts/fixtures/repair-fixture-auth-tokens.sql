-- LOCAL ONLY, one-off (M11a-5): repairs the two catalog-fixture accounts that
-- catalog-search-fixture.sql created by SQL before it set Auth's token columns.
--
-- GoTrue v2.197 reads confirmation_token, recovery_token, email_change_token_new and
-- email_change as strings, and created_at and updated_at as times; none of the six has a
-- default, so a row inserted by SQL without them holds NULLs, and Auth's user listing
-- fails for every account ("Scan error on column index 3, name confirmation_token:
-- converting NULL to string is unsupported", then index 5, created_at). Verified on an
-- isolated restored copy with a throwaway GoTrue v2.197: these six fields, and only these,
-- are needed for the listing to work. This sets the four tokens to '' (what GoTrue writes)
-- and the two times to the account's profile creation time, on exactly the two fixture
-- accounts, and nothing else. Any other state aborts the whole transaction.
-- NOT APPLIED to the development demo without the product owner's approval (M11a-5).
--
--   docker exec -i <local db container> psql -U postgres -d postgres -v ON_ERROR_STOP=1 < this file
\set ON_ERROR_STOP on
begin;

create temp table _repair_before on commit drop as
  select u.id, to_jsonb(u) as r from auth.users u;

do $$
declare
  v_ids constant uuid[] := array['f1c5f1c5-0000-4000-8000-00000000c5c5', 'f1c5f1c5-0000-4000-8000-00000000c5c6']::uuid[];
  v_n integer;
begin
  -- Preconditions: exactly the two fixture accounts have NULLs, and only in these four fields.
  select count(*) into v_n from auth.users u
  where u.confirmation_token is null or u.recovery_token is null or u.email_change_token_new is null or u.email_change is null
     or u.email_change_token_current is null or u.phone_change is null or u.phone_change_token is null or u.reauthentication_token is null;
  if v_n <> 2 then raise exception 'precondition: expected 2 accounts with NULL token fields, found %', v_n; end if;
  if exists (select 1 from auth.users u
             where (u.confirmation_token is null or u.recovery_token is null or u.email_change_token_new is null or u.email_change is null)
               and u.id <> all (v_ids)) then
    raise exception 'precondition: an account other than the two fixture accounts has NULL token fields';
  end if;
  if exists (select 1 from auth.users u where u.id = any (v_ids)
             and (u.email_change_token_current is null or u.phone_change is null or u.phone_change_token is null or u.reauthentication_token is null)) then
    raise exception 'precondition: a fixture account has an unexpected NULL field';
  end if;
  if (select count(*) from auth.users u join public.profiles p on p.id = u.id
      where (u.id, u.email, p.handle) in (
        ('f1c5f1c5-0000-4000-8000-00000000c5c5'::uuid, 'catalog-fixture@example.test', 'catalog_fixture'),
        ('f1c5f1c5-0000-4000-8000-00000000c5c6'::uuid, 'catalog-fixture-reviewer@example.test', 'catalog_fixture_rv'))
        and u.confirmation_token is null and u.recovery_token is null and u.email_change_token_new is null and u.email_change is null
        and u.created_at is null and u.updated_at is null
        and u.encrypted_password is null and u.last_sign_in_at is null) <> 2 then
    raise exception 'precondition: the fixture accounts are not as expected';
  end if;

  update auth.users u set
    confirmation_token = coalesce(u.confirmation_token, ''),
    recovery_token = coalesce(u.recovery_token, ''),
    email_change_token_new = coalesce(u.email_change_token_new, ''),
    email_change = coalesce(u.email_change, ''),
    created_at = coalesce(u.created_at, p.created_at),
    updated_at = coalesce(u.updated_at, p.created_at)
  from public.profiles p
  where p.id = u.id and u.id = any (v_ids);
  get diagnostics v_n = row_count;
  if v_n <> 2 then raise exception 'postcondition: % rows updated, expected 2', v_n; end if;

  -- Postconditions: every other account is unchanged; the two fixture accounts differ in
  -- these four fields only, each now ''.
  if exists (select 1 from auth.users u join _repair_before b on b.id = u.id where u.id <> all (v_ids) and to_jsonb(u) <> b.r)
     or (select count(*) from auth.users) <> (select count(*) from _repair_before) then
    raise exception 'postcondition: another account changed';
  end if;
  if exists (select 1 from auth.users u join _repair_before b on b.id = u.id where u.id = any (v_ids)
             and (to_jsonb(u) - array['confirmation_token', 'recovery_token', 'email_change_token_new', 'email_change', 'created_at', 'updated_at'])
                 <> (b.r - array['confirmation_token', 'recovery_token', 'email_change_token_new', 'email_change', 'created_at', 'updated_at'])) then
    raise exception 'postcondition: a fixture account changed outside the four token fields';
  end if;
  if exists (select 1 from auth.users u where u.id = any (v_ids)
             and not (u.confirmation_token = '' and u.recovery_token = '' and u.email_change_token_new = '' and u.email_change = ''
                      and u.created_at is not null and u.updated_at is not null)) then
    raise exception 'postcondition: a token field isn''t empty, or a time is missing';
  end if;
  if exists (select 1 from auth.users u
             where u.confirmation_token is null or u.recovery_token is null or u.email_change_token_new is null or u.email_change is null) then
    raise exception 'postcondition: an account still has a NULL token field';
  end if;
  raise notice 'repaired: 2 fixture accounts, 6 fields each; no other account changed';
end $$;

commit;
