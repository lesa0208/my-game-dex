-- M8 (D16): the parts of Supabase Auth's own tables that the Owner and MFA helpers
-- read. Nothing here writes to the auth schema. Run this before any Supabase CLI or
-- hosted upgrade: if it fails, the helpers fail closed (staff are refused, nothing
-- is exposed) until they are updated. See security-rls.md, "The Auth contract".
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- Columns and types read by account_standing, totp_factor_count and (M8b) the MFA helpers.
select col_type_is('auth', 'users', 'id', 'uuid', 'auth.users.id is a uuid');
select col_type_is('auth', 'users', 'deleted_at', 'timestamp with time zone', 'auth.users.deleted_at (soft delete)');
select col_type_is('auth', 'users', 'banned_until', 'timestamp with time zone', 'auth.users.banned_until');
select col_type_is('auth', 'users', 'email_confirmed_at', 'timestamp with time zone', 'auth.users.email_confirmed_at');
select col_type_is('auth', 'sessions', 'id', 'uuid', 'auth.sessions.id is the JWT session_id');
select col_type_is('auth', 'sessions', 'user_id', 'uuid', 'auth.sessions.user_id');
select col_type_is('auth', 'sessions', 'aal', 'auth.aal_level', 'auth.sessions.aal');
select col_type_is('auth', 'sessions', 'not_after', 'timestamp with time zone', 'auth.sessions.not_after');
select col_type_is('auth', 'sessions', 'factor_id', 'uuid', 'auth.sessions.factor_id, the factor that verified the session');
select col_type_is('auth', 'mfa_amr_claims', 'session_id', 'uuid', 'auth.mfa_amr_claims.session_id');
select col_type_is('auth', 'mfa_amr_claims', 'authentication_method', 'text', 'auth.mfa_amr_claims.authentication_method');
select col_type_is('auth', 'mfa_amr_claims', 'updated_at', 'timestamp with time zone', 'auth.mfa_amr_claims.updated_at, set by each verification');
select col_type_is('auth', 'mfa_factors', 'user_id', 'uuid', 'auth.mfa_factors.user_id');
select col_type_is('auth', 'mfa_factors', 'factor_type', 'auth.factor_type', 'auth.mfa_factors.factor_type');
select col_type_is('auth', 'mfa_factors', 'status', 'auth.factor_status', 'auth.mfa_factors.status');
select col_type_is('auth', 'mfa_factors', 'created_at', 'timestamp with time zone', 'auth.mfa_factors.created_at, the enrollment time (B2)');
select ok('totp' = any (enum_range(null::auth.factor_type)::text[]), 'factor_type has totp');
select ok('verified' = any (enum_range(null::auth.factor_status)::text[]), 'factor_status has verified');
select ok('aal2' = any (enum_range(null::auth.aal_level)::text[]), 'aal_level has aal2');

-- Who can read them: the owner of our SECURITY DEFINER functions can; clients can't.
select ok(bool_and(has_table_privilege('postgres', t, 'select')), 'postgres can read every table the helpers use')
  from unnest(array['auth.users', 'auth.sessions', 'auth.mfa_amr_claims', 'auth.mfa_factors']) t;
select ok((select rolbypassrls from pg_roles where rolname = 'postgres'), 'postgres bypasses RLS, which is on for these tables');
select ok(not bool_or(has_table_privilege(r, t, 'select,insert,update,delete')), 'no client role can read or change them')
  from unnest(array['auth.users', 'auth.sessions', 'auth.mfa_amr_claims', 'auth.mfa_factors']) t, unnest(array['anon', 'authenticated', 'service_role']) r;
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'private.totp_factor_count(uuid, interval)'::regprocedure), 'postgres', 'the helpers that read them are owned by postgres');

select * from finish();
rollback;
