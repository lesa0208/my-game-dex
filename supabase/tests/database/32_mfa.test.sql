-- M8b: MFA for staff (D3, D16), factor maturity (D13) and Owner eligibility (A1).
-- The rows below have the shape GoTrue writes; db-mfa-checks.mjs repeats the
-- important cases with real sessions from local GoTrue, over the API.
begin;
create extension if not exists pgtap with schema extensions;
select plan(58);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.sid(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-00000000aa' || s)::uuid $$;
create function pg_temp.fid(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-00000000bb' || s)::uuid $$;

-- Claims for p_user's session p_sid at p_aal (no claims at all when p_user is null).
create function pg_temp.claim(p_user text, p_sid text, p_aal text) returns void language plpgsql as $t$
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else
    jsonb_build_object('sub', pg_temp.u(p_user), 'role', 'authenticated', 'aal', p_aal, 'session_id', coalesce(pg_temp.sid(p_sid)::text, 'x'))::text end, true);
end $t$;
-- Evaluates p_sql as postgres with those claims (private helpers aren't granted to clients).
create function pg_temp.as_pg(p_user text, p_sid text, p_aal text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform pg_temp.claim(p_user, p_sid, p_aal);
  execute p_sql into r;
  return coalesce(r, 'null');
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
-- Runs p_sql as the signed-in client with those claims.
create function pg_temp.as_client(p_user text, p_sid text, p_aal text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform pg_temp.claim(p_user, p_sid, p_aal);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, 'null');
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
grant execute on function pg_temp.u(text), pg_temp.sid(text), pg_temp.fid(text), pg_temp.claim(text, text, text) to authenticated;
-- A session; p_factor is the factor that verified it (sessions.factor_id), as Auth records.
create function pg_temp.session(p_user text, p_sid text, p_aal auth.aal_level, p_not_after interval default null, p_factor text default null) returns void language sql as $$
  insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at, not_after)
  values (pg_temp.sid(p_sid), pg_temp.u(p_user), p_aal, pg_temp.fid(p_factor), now(), now(), case when p_not_after is null then null else now() + p_not_after end)
$$;
create function pg_temp.verified_at(p_sid text, p_age interval) returns void language sql as $$
  insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
  values (gen_random_uuid(), pg_temp.sid(p_sid), 'totp', now() - p_age, now() - p_age)
  on conflict (session_id, authentication_method) do update set updated_at = excluded.updated_at
$$;
create function pg_temp.factor(p_user text, p_fid text, p_status auth.factor_status default 'verified') returns void language sql as $$
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values (pg_temp.fid(p_fid), pg_temp.u(p_user), 'factor ' || p_fid, 'totp', p_status, now() - interval '3 days', now())
$$;
-- Registers a factor as if p_age ago, the way only postgres can: the function always uses now().
create function pg_temp.registered(p_fid text, p_age interval) returns void language sql as $$
  delete from private.mfa_factor_registrations where factor_id = pg_temp.fid(p_fid);
  insert into private.mfa_factor_registrations (factor_id, user_id, factor_created_at, registered_at)
  select f.id, f.user_id, f.created_at, now() - p_age from auth.mfa_factors f where f.id = pg_temp.fid(p_fid)
$$;

-- a1: admin. e2: catalog editor. c3: collector. f4: the future Owner.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'e2', 'c3', 'f4']) as s;
update public.profiles set handle = 'mfa_t_' || right(id::text, 2), handle_changed_at = now();
insert into public.staff_roles (user_id, role) values (pg_temp.u('a1'), 'admin'), (pg_temp.u('e2'), 'catalog_editor');

-- 1. The live session (D3, F5)
select pg_temp.factor('a1', '01');
select pg_temp.session('a1', '01', 'aal2', null, '01');
select pg_temp.verified_at('01', interval '1 minute');
select pg_temp.session('a1', '02', 'aal1');
select pg_temp.session('e2', '03', 'aal2');
select pg_temp.session('a1', '04', 'aal2', interval '-1 minute', '01');
select pg_temp.session('a1', '05', 'aal1', null, '01');
select is(pg_temp.as_pg('a1', '01', 'aal2', 'select private.mfa_session_ok()::text'), 'true', 'a live aal2 session with a verified factor passes');
select is(pg_temp.as_pg(null, null, null, 'select private.mfa_session_ok()::text'), 'false', 'no claims don''t');
select is(pg_temp.as_pg('a1', '01', 'aal1', 'select private.mfa_session_ok()::text'), 'false', 'nor an aal1 token, even for an aal2 session');
select is(pg_temp.as_pg('a1', '09', 'aal2', 'select private.mfa_session_ok()::text'), 'false', 'nor an aal2 token whose session doesn''t exist (signed out)');
select is(pg_temp.as_pg('a1', '02', 'aal2', 'select private.mfa_session_ok()::text'), 'false', 'nor an aal2 token for a session now at aal1 (factor removed)');
select is(pg_temp.as_pg('a1', '03', 'aal2', 'select private.mfa_session_ok()::text'), 'false', 'nor someone else''s session');
select is(pg_temp.as_pg('a1', '04', 'aal2', 'select private.mfa_session_ok()::text'), 'false', 'nor a session past not_after');
-- The session's own level, alone: Auth recorded it at aal1, though it names a factor
-- that's still verified, so only the aal check can refuse it.
select is(pg_temp.as_pg('a1', '05', 'aal2', 'select private.mfa_session_ok()::text'), 'false', 'nor a session Auth holds at aal1, even naming a verified factor');
select is(pg_temp.as_pg('a1', null, 'aal2', 'select private.mfa_session_ok()::text'), 'false', 'nor a session id that isn''t a uuid');
select is(pg_temp.as_pg('e2', '03', 'aal2', 'select private.mfa_session_ok()::text'), 'false', 'nor an aal2 session without a verified factor');
select pg_temp.factor('e2', '03', 'unverified');
update auth.sessions set factor_id = pg_temp.fid('03') where id = pg_temp.sid('03');
select is(pg_temp.as_pg('e2', '03', 'aal2', 'select private.mfa_session_ok()::text'), 'false', 'an unverified factor doesn''t count');
select pg_temp.factor('e2', '05');
select pg_temp.verified_at('03', interval '1 minute');
select is(pg_temp.as_pg('e2', '03', 'aal2', 'select private.mfa_session_ok()::text'), 'false', 'nor does a verified factor other than the one that verified the session');
update auth.sessions set factor_id = pg_temp.fid('05') where id = pg_temp.sid('03');
select is(pg_temp.as_pg('e2', '03', 'aal2', 'select private.mfa_session_ok()::text'), 'true', 'a session verified by a verified factor passes');
select is(pg_temp.as_pg('a1', '02', 'aal1', 'select private.require_mfa()::text'), 'error: not permitted', 'require_mfa refuses with the generic message');

-- 2. Recent verification: 10 minutes, 60 seconds of skew (D3, F10)
select is(pg_temp.as_pg('a1', '01', 'aal2', $$select private.mfa_recent('10 minutes')::text$$), 'true', 'a TOTP verification a minute ago is recent');
select pg_temp.verified_at('01', interval '11 minutes');
select is(pg_temp.as_pg('a1', '01', 'aal2', $$select private.mfa_recent('10 minutes')::text$$), 'false', 'eleven minutes ago isn''t');
select is(pg_temp.as_pg('a1', '01', 'aal2', $$select private.require_recent_mfa()::text$$), 'error: reauthentication required', 'require_recent_mfa then asks for reauthentication');
select is(pg_temp.as_pg('a1', '01', 'aal2', $$select private.mfa_session_ok()::text$$), 'true', 'while the session itself still passes');
select pg_temp.verified_at('01', interval '-30 seconds');
select is(pg_temp.as_pg('a1', '01', 'aal2', $$select private.mfa_recent('10 minutes')::text$$), 'true', '30 seconds ahead is within the skew allowance');
select pg_temp.verified_at('01', interval '-2 minutes');
select is(pg_temp.as_pg('a1', '01', 'aal2', $$select private.mfa_recent('10 minutes')::text$$), 'false', 'two minutes ahead isn''t');
select pg_temp.verified_at('01', interval '1 minute');
select is(pg_temp.as_pg('a1', '01', 'aal2', $$select private.mfa_recent('20 minutes')::text$$), 'false', 'no caller can widen the window past 10 minutes');
select is(pg_temp.as_pg('a1', '01', 'aal2', $$select private.require_recent_mfa()::text$$), pg_temp.u('a1')::text, 'a recent verification passes');

-- 3. Staff privileges need MFA, on every path
select is(pg_temp.as_client('a1', '02', 'aal1', 'select public.get_audit_log()::text'), 'error: not permitted', 'an admin at aal1 can''t use a staff function');
select is(pg_temp.as_client('a1', '01', 'aal2', $$select jsonb_typeof(public.get_audit_log())$$), 'array', 'at aal2 they can');
select is(pg_temp.as_pg('a1', '02', 'aal1', $$select private.has_staff_role('admin')::text$$), 'false', 'has_staff_role is false at aal1');
select is(pg_temp.as_pg('e2', '03', 'aal1', $$select private.is_catalog_editor()::text$$), 'false', 'so is is_catalog_editor, which the catalog read policies use');
select is(pg_temp.as_pg('e2', '03', 'aal2', $$select private.is_catalog_editor()::text$$), 'true', 'and true at aal2');
select is(pg_temp.as_client('e2', '03', 'aal1', 'select public.can_review_submissions()::text'), 'false', 'an editor at aal1 isn''t offered review');
select is(pg_temp.as_client('e2', '03', 'aal2', 'select public.can_review_submissions()::text'), 'true', 'at aal2 they are');
select is(pg_temp.as_client('c3', '01', 'aal2', 'select public.can_review_submissions()::text'), 'false', 'a collector presenting an admin''s session id gets nothing');
delete from auth.sessions where id = pg_temp.sid('03');
select is(pg_temp.as_client('e2', '03', 'aal2', 'select public.can_review_submissions()::text'), 'false', 'after sign-out the same token gets nothing');

-- 4. Registration and maturity (D13)
select pg_temp.factor('f4', '11');
select pg_temp.factor('f4', '12');
select pg_temp.factor('f4', '13', 'unverified');
select pg_temp.session('f4', '21', 'aal2', null, '11');
select pg_temp.verified_at('21', interval '1 minute');
select pg_temp.session('f4', '22', 'aal1');
select is(pg_temp.as_client('f4', '22', 'aal1', 'select public.register_my_verified_factors()::text'), 'error: not permitted', 'registering needs a live aal2 session');
select is(pg_temp.as_client('f4', '21', 'aal2', 'select public.register_my_verified_factors()::text'), '2', 'it records both verified factors, not the unverified one');
select ok((select bool_and(registered_at = now()) and count(*) = 2 from private.mfa_factor_registrations where user_id = pg_temp.u('f4')), 'at the server''s time');
select is(pg_temp.as_client('f4', '21', 'aal2', 'select public.register_my_verified_factors()::text'), '0', 'a second call records nothing');
select is((select count(*)::int from private.mfa_factor_registrations), 2, 'nor anyone else''s factors');
select is(private.mature_totp_factor_count(pg_temp.u('f4')), 0, 'just registered, no factor is mature');
select is(pg_temp.as_pg(null, null, null, $$update private.mfa_factor_registrations set registered_at = now() - interval '2 days' returning 'changed'$$), 'error: factor registrations are permanent', 'a registration can''t be backdated, even by postgres');
select pg_temp.registered('11', interval '25 hours');
select is(private.mature_totp_factor_count(pg_temp.u('f4')), 1, 'a factor registered 25 hours ago is mature');
select pg_temp.registered('12', interval '25 hours');
select is(private.mature_totp_factor_count(pg_temp.u('f4')), 2, 'two are');
insert into private.mfa_factor_registrations (factor_id, user_id, factor_created_at, registered_at)
  values (pg_temp.fid('13'), pg_temp.u('f4'), now() - interval '3 days', now() - interval '25 hours');
select is(private.mature_totp_factor_count(pg_temp.u('f4')), 2, 'an unverified factor never counts, registered or not');
delete from auth.mfa_factors where id = pg_temp.fid('12');
select is(private.mature_totp_factor_count(pg_temp.u('f4')), 1, 'a removed factor stops counting');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values (pg_temp.fid('12'), pg_temp.u('f4'), 'replacement', 'totp', 'verified', now() - interval '1 hour', now());
select is(private.mature_totp_factor_count(pg_temp.u('f4')), 1, 'a different factor with the old id doesn''t inherit its maturity');

-- 5. Owner identity versus eligibility (A1)
delete from auth.mfa_factors where id = pg_temp.fid('12');
select pg_temp.factor('f4', '12');
select private.assign_initial_owner('mfa_t_f4', 'Test owner');
select pg_temp.registered('12', interval '25 hours');
select is(pg_temp.as_pg('a1', '01', 'aal2', 'select private.owner_authority_refusal()'), 'owner_only', 'an admin who isn''t the Owner has no Owner authority');
select is(pg_temp.as_pg('f4', '22', 'aal1', 'select private.owner_authority_refusal()'), 'mfa_required', 'the Owner at aal1 has none');
select is(pg_temp.as_pg('f4', '21', 'aal2', 'select private.owner_authority_refusal()'), 'null', 'with two mature factors, a recent verification and good standing, they have it');
select is(pg_temp.as_pg('f4', '21', 'aal2', 'select private.can_exercise_owner_authority()::text'), 'true', 'can_exercise_owner_authority agrees');
select pg_temp.verified_at('21', interval '11 minutes');
select is(pg_temp.as_pg('f4', '21', 'aal2', 'select private.owner_authority_refusal()'), 'reauthentication_required', 'without a recent verification, they must reauthenticate');
select pg_temp.verified_at('21', interval '1 minute');
select private.begin_owner_recovery('factor_reset', null, 'Case MFA');
select is(pg_temp.as_pg('f4', '21', 'aal2', 'select private.owner_authority_refusal()'), 'recovery_pending', 'a pending recovery freezes it');
select private.cancel_owner_recovery_by_operator((select id from private.owner_recoveries where status = 'pending'), 'Test over');
update auth.users set banned_until = now() + interval '1 day' where id = pg_temp.u('f4');
select is(pg_temp.as_pg('f4', '21', 'aal2', 'select private.owner_authority_refusal()'), 'owner_ineligible', 'a banned Owner has none');
update auth.users set banned_until = null where id = pg_temp.u('f4');
-- One factor lost: still the Owner and protected, but not eligible (A1, D13).
delete from auth.mfa_factors where id = pg_temp.fid('11');
select is(pg_temp.as_pg('f4', '21', 'aal2', 'select private.mfa_session_ok()::text'), 'false', 'the session the lost factor verified no longer counts, even if Auth hadn''t downgraded it');
select pg_temp.session('f4', '23', 'aal2', null, '12');
select pg_temp.verified_at('23', interval '1 minute');
select is(pg_temp.as_pg('f4', '23', 'aal2', 'select private.owner_authority_refusal()'), 'owner_ineligible', 'with one mature factor left, the Owner has no Owner authority');
select ok(private.is_designated_owner(pg_temp.u('f4')), 'but is still the designated Owner');
select is(pg_temp.as_pg(null, null, null, $$delete from public.profiles where id = '$$ || pg_temp.u('f4') || $$' returning 'deleted'$$), 'error: account protected', 'and still protected');
select is(pg_temp.as_client('f4', '23', 'aal2', $$select jsonb_typeof(public.get_audit_log())$$), 'array', 'and keeps ordinary admin access with the remaining factor');
-- A replacement, enrolled with the remaining factor and registered now, waits 24 hours.
select pg_temp.factor('f4', '14');
select is(pg_temp.as_client('f4', '23', 'aal2', 'select public.register_my_verified_factors()::text'), '1', 'the replacement is registered');
select is(pg_temp.as_pg('f4', '23', 'aal2', 'select private.owner_authority_refusal()'), 'owner_ineligible', 'and until it matures, Owner authority stays off');
select pg_temp.registered('14', interval '24 hours 1 minute');
select is(pg_temp.as_pg('f4', '23', 'aal2', 'select private.owner_authority_refusal()'), 'null', 'after 24 hours it returns');

select * from finish();
rollback;
