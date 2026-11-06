/**
 * Deliberate security violations, used by db-mutation-checks.mjs to prove the tests
 * detect them. Each entry applies one violation to the local database, or to a
 * source file.
 *
 * `expect` names the suites that must fail: "pgtap", "api" or "both".
 */
const WORKFLOW = "src/features/avatars/avatar-workflow.ts";

const q = (text) => `$x$${text}$x$`;

/** Rewrites a function body, and fails if the pattern is no longer there. */
const rewrite = (signature, from, to) =>
  `do $m$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin if position(${q(from)} in d) = 0 then raise exception 'pattern missing'; end if; execute replace(d, ${q(from)}, ${q(to)}); end $m$;`;

const sql = (name, expect, statement, role = "postgres") => ({ name, expect, sql: statement, role });
const code = (name, expect, from, to, file = WORKFLOW) => ({ name, expect, code: { file, from, to } });

const CORRECTION_CLEAR = "case when v_current is null then pg_catalog.now() + interval '24 hours' end";

export const m2Mutations = [
  sql("private column granted to anon", "both", "grant select (allow_search_indexing) on public.profiles to anon;"),
  sql("follow setting granted to authenticated", "both", "grant select (follow_approval_required) on public.profiles to authenticated;"),
  sql("client may update handle", "both", "grant update (handle) on public.profiles to authenticated;"),
  sql("client may update account_status", "both", "grant update (account_status) on public.profiles to authenticated;"),
  sql("staff self-grant policy", "both", "grant insert on public.staff_roles to authenticated; create policy x on public.staff_roles for insert to authenticated with check (true);"),
  sql("staff write granted to service_role", "both", "grant insert on public.staff_roles to service_role;"),
  sql("has_staff_role trusts JWT", "pgtap", rewrite("private.has_staff_role(public.staff_role)", "select exists (", "select coalesce(auth.jwt()->>'staff_role','')='admin' or exists (")),
  sql("trigger reads metadata role", "both", rewrite("private.handle_new_user()", "insert into public.user_preferences (user_id) values (new.id);", "insert into public.user_preferences (user_id) values (new.id); if new.raw_user_meta_data->>'role' = 'admin' then insert into public.staff_roles (user_id, role) values (new.id,'admin'); end if;")),
  sql("trigger leaks exception detail", "both", rewrite("private.handle_new_user()", "raise exception 'account could not be created' using errcode = 'P0001';", "raise;")),
  sql("any user may edit any profile", "both", "drop policy profiles_update_own on public.profiles; create policy profiles_update_own on public.profiles for update to authenticated using (true) with check (true);"),
  sql("account without handle may edit", "pgtap", "drop policy profiles_update_own on public.profiles; create policy profiles_update_own on public.profiles for update to authenticated using (id=(select auth.uid())) with check (id=(select auth.uid()));"),
  sql("preferences readable by all users", "both", "drop policy user_preferences_read_own on public.user_preferences; create policy user_preferences_read_own on public.user_preferences for select to authenticated using (true);"),
  sql("unverified users may claim", "pgtap", rewrite("public.claim_handle(text)", "and u.email_confirmed_at is not null", "")),
  sql("cooldown removed", "both", rewrite("public.claim_handle(text)", "v_changed_at > pg_catalog.now() - interval '30 days'", "false")),
  sql("holds not checked", "both", rewrite("public.claim_handle(text)", "if private.handle_is_held(v_handle) then", "if false then")),
  sql("no hold after rename", "pgtap", rewrite("public.claim_handle(text)", "if v_current is not null then\n    insert", "if false then\n    insert")),
  sql("no hold after account deletion", "both", "alter table public.profiles disable trigger hold_handle_on_delete;"),
  sql("ordinary uniqueness removed", "both", "alter table public.profiles drop constraint profiles_handle_key;"),
  sql("reserved names compared by spelling only", "both", rewrite("private.handle_is_held(text)", "h.skeleton = private.handle_skeleton(p_handle)", "h.handle = p_handle")),
  sql("brand terms no longer match inside a name", "pgtap", rewrite("private.handle_is_held(text)", "strpos(private.handle_skeleton(p_handle), h.skeleton) > 0", "h.skeleton = private.handle_skeleton(p_handle)")),
  sql("released holds also block lookalikes", "pgtap", rewrite("private.handle_is_held(text)", "h.handle = p_handle and", "h.skeleton = private.handle_skeleton(p_handle) and")),
  sql("skeleton uniqueness restored", "both", "grant execute on function private.handle_skeleton(text) to authenticated; create unique index __m on public.profiles (private.handle_skeleton(handle)) where handle is not null;"),
  sql("case not folded", "both", rewrite("public.claim_handle(text)", 'pg_catalog.lower(p_handle collate pg_catalog."C")', "p_handle")),
  sql("lowercase before validating", "pgtap", rewrite("public.claim_handle(text)", "p_handle !~ '^[A-Za-z0-9_]{3,24}$'", "pg_catalog.lower(p_handle) !~ '^[a-z0-9_]{3,24}$'")),
  sql("correction window widened", "pgtap", rewrite("public.claim_handle(text)", "interval '24 hours'", "interval '48 hours'")),
  sql("correction boundary off by one", "pgtap", rewrite("public.claim_handle(text)", "v_correction_until > pg_catalog.now()", "v_correction_until >= pg_catalog.now()")),
  sql("correction not used up", "both", rewrite("public.claim_handle(text)", CORRECTION_CLEAR, "coalesce(v_correction_until, pg_catalog.now() + interval '24 hours')")),
  sql("correction granted on every change", "both", rewrite("public.claim_handle(text)", CORRECTION_CLEAR, "pg_catalog.now() + interval '24 hours'")),
  sql("correction leaves no hold", "both", rewrite("public.claim_handle(text)", "if v_current is not null then\n    insert", "if v_current is not null and v_correction_until is null then\n    insert")),
  sql("correction doesn't restart the cooldown", "pgtap", rewrite("public.claim_handle(text)", "handle_changed_at = pg_catalog.now(),", "handle_changed_at = coalesce(v_changed_at, pg_catalog.now()),")),
  sql("cooldown boundary off by one", "pgtap", rewrite("public.claim_handle(text)", "v_changed_at > pg_catalog.now() - interval '30 days'", "v_changed_at >= pg_catalog.now() - interval '30 days'")),
  sql("claim row lock removed", "api", rewrite("public.claim_handle(text)", "where p.id = v_me\n  for update;", "where p.id = v_me;")),
  sql("claim handle lock removed", "api", rewrite("public.claim_handle(text)", "perform private.lock_handle(least(v_current, v_handle));\n    perform private.lock_handle(greatest(v_current, v_handle));", "null;")),
  sql("deletion handle lock removed", "api", rewrite("private.hold_handle_on_delete()", "perform private.lock_handle(old.handle);", "")),
  sql("correction allowance readable", "both", "grant select (handle_correction_until) on public.profiles to authenticated;"),
  sql("correction allowance writable", "both", "grant update (handle_correction_until) on public.profiles to authenticated;"),
  sql("skeleton function executable", "pgtap", "grant execute on function private.handle_skeleton(text) to authenticated;"),
  sql("client can read holds", "pgtap", "grant usage on schema private to authenticated; grant select on private.handle_holds to authenticated;"),
  sql("client can run set_avatar_path", "both", "grant execute on function public.set_avatar_path(uuid,text) to authenticated;"),
  sql("set_avatar_path skips file check", "pgtap", rewrite("public.set_avatar_path(uuid,text)", "if not exists (", "if false and not exists (")),
  sql("avatar owner path CHECK removed", "pgtap", "do $m$ declare c text; begin select conname into c from pg_constraint where conrelid='public.profiles'::regclass and pg_get_constraintdef(oid) like '%webp%'; execute format('alter table public.profiles drop constraint %I',c); end $m$;"),
  sql("definer without search_path", "pgtap", "alter function public.get_my_account() reset search_path;"),
  sql("clients may upload avatars", "both", "create policy __m on storage.objects for insert to authenticated with check (bucket_id='avatars');", "supabase_admin"),
  sql("clients may delete avatars", "both", "create policy __m on storage.objects for delete to authenticated using (bucket_id='avatars'); create policy __n on storage.objects for select to authenticated using (bucket_id='avatars');", "supabase_admin"),
  sql("bucket accepts any type", "both", "update storage.buckets set allowed_mime_types=null where id='avatars';"),
  sql("bucket size limit removed", "both", "update storage.buckets set file_size_limit=null where id='avatars';"),
  code("code: metadata kept", "api", ".webp({ quality: 82 })", ".keepMetadata().webp({ quality: 82 })"),
  code("code: no active-account check", "api", "!account || account.id !== user.id || !account.is_active", "false"),
  code("code: signature check removed", "api", 'if (!sniffed) throw new AvatarError("unsupported_type");', ""),
  code("code: pixel limit removed", "api", "limitInputPixels: MAX_INPUT_PIXELS", "limitInputPixels: false"),
  code("code: side limit removed", "api", "width > MAX_DIMENSION ||\n      height > MAX_DIMENSION", "false"),
  code("code: old file left behind", "api", "const previousRemoved = previous ? await removeObjects(config, [previous]) : true;", "const previousRemoved = true;"),
  code("code: no cleanup on deletion", "api", "objects.map((object) => `${userId}/${object.name}`),", "[],"),
];

const REQUEST = "public.request_follow(uuid)";
const CARD_FILTER = "o.handle is not null and o.account_status = 'active' and o.follow_approval_required is false and not (o.id = any (v_peers))";
const CARD_FILTER_NO_PRIVACY = "o.handle is not null and o.account_status = 'active' and not (o.id = any (v_peers))";
const PAGING = "get_followers(uuid,integer,timestamp with time zone,uuid)";
const FOLLOWING = "get_following(uuid,integer,timestamp with time zone,uuid)";
const REQUEST_LOCKS = "perform private.lock_follow_requester(v_me);";

export const m3Mutations = [
  // Visibility
  sql("pending counts as accepted", "pgtap", rewrite("private.is_accepted_follower(uuid)", "f.status = 'accepted'", "f.status in ('accepted', 'pending')")),
  sql("rejected counts as accepted", "pgtap", rewrite("private.is_accepted_follower(uuid)", "f.status = 'accepted'", "f.status <> 'cancelled'")),
  sql("suspended follower keeps access", "pgtap", rewrite("private.is_accepted_follower(uuid)", "private.is_active_user() and exists", "exists")),
  sql("staff bypass private content", "pgtap", rewrite("private.can_view_level(uuid,public.visibility_level)", "p_owner = (select auth.uid())\n", "p_owner = (select auth.uid()) or private.has_staff_role('moderator')\n")),
  sql("block ignored for content", "pgtap", rewrite("private.can_view_level(uuid,public.visibility_level)", "and not private.is_blocked_between(p_owner)", "")),
  sql("followers see private content", "pgtap", rewrite("private.can_view_level(uuid,public.visibility_level)", "else false", "else private.is_accepted_follower(p_owner)")),
  sql("authentication alone grants followers content", "pgtap", rewrite("private.can_view_level(uuid,public.visibility_level)", "when 'followers' then private.is_accepted_follower(p_owner)", "when 'followers' then (select auth.uid()) is not null")),
  sql("suspended owner's content stays visible", "pgtap", rewrite("private.can_view_level(uuid,public.visibility_level)", "p.handle is not null and p.account_status = 'active'", "p.handle is not null")),
  sql("unknown collection owner grants access", "pgtap", rewrite("private.can_view_collection(uuid)", "    false\n", "    true\n")),
  sql("block ignored for profile cards", "both", "drop policy profiles_read_authenticated on public.profiles; create policy profiles_read_authenticated on public.profiles for select to authenticated using (handle is not null and account_status = 'active');"),
  sql("private column added to the card", "pgtap", "grant select (follow_approval_required) on public.profiles to anon;"),

  // State machine
  sql("rejection shown in follow state", "both", rewrite("public.get_follow_state(uuid)", "elsif v_status in ('pending', 'rejected') then", "elsif v_status = 'pending' then")),
  sql("rejection removed from sent list", "both", rewrite("public.get_sent_follow_requests(integer,timestamp with time zone,uuid)", "f.status in ('pending', 'rejected')", "f.status = 'pending'")),
  sql("retry during cooldown becomes actionable", "both", rewrite(REQUEST, "if v_rerequest_after > pg_catalog.now() then", "if false then")),
  sql("retry extends the cooldown", "both", rewrite(REQUEST, "set status = 'rejected', requested_at = pg_catalog.now()", "set status = 'rejected', requested_at = pg_catalog.now(), rerequest_after = pg_catalog.now() + interval '31 days'")),
  sql("cancel clears the cooldown", "both", rewrite("public.cancel_follow_request(uuid)", "set status = 'cancelled'", "set status = 'cancelled', rerequest_after = null")),
  sql("re-request boundary off by one", "pgtap", rewrite(REQUEST, "if v_rerequest_after > pg_catalog.now() then", "if v_rerequest_after >= pg_catalog.now() then")),
  sql("rejection cooldown shortened", "pgtap", rewrite("public.reject_follow_request(uuid)", "interval '30 days'", "interval '7 days'")),
  sql("repeat rejection extends the cooldown", "pgtap", rewrite("public.reject_follow_request(uuid)", "if v_status = 'rejected' then\n    return;\n  elsif v_status is distinct from 'pending' then", "if v_status is distinct from 'pending' and v_status is distinct from 'rejected' then")),
  sql("removal starts no cooldown", "pgtap", rewrite("public.remove_follower(uuid)", "rerequest_after = pg_catalog.now() + interval '30 days'", "rerequest_after = null")),
  sql("disabling approval accepts pending requests", "pgtap", rewrite(REQUEST, "if v_status = 'accepted' then\n    return 'following';", "if v_status = 'pending' and v_requires_approval is false then\n    update public.follows set status = 'accepted', accepted_at = pg_catalog.now() where follower_id = v_me and followee_id = p_target;\n    return 'following';\n  elsif v_status = 'accepted' then\n    return 'following';")),
  sql("cancel can unfollow", "pgtap", rewrite("public.cancel_follow_request(uuid)", "status in ('pending', 'rejected')", "status in ('pending', 'rejected', 'accepted')")),
  sql("illegal transitions allowed", "pgtap", "alter table public.follows disable trigger validate_follow_row;"),
  sql("self-follow not refused by the function", "pgtap", rewrite(REQUEST, "if p_target is null or p_target = v_me then", "if p_target is null then")),
  sql("inactive user may request", "pgtap", rewrite(REQUEST, "v_me uuid := private.require_active_user();", "v_me uuid := private.require_verified_user();")),
  sql("inactive owner may accept", "pgtap", rewrite("public.accept_follow_request(uuid)", "v_me uuid := private.require_active_user();", "v_me uuid := private.require_verified_user();")),
  sql("unverified user treated as verified", "pgtap", rewrite("private.require_verified_user()", "and u.email_confirmed_at is not null", "")),
  sql("suspended target may be followed", "pgtap", rewrite(REQUEST, "where p.id = p_target and p.handle is not null and p.account_status = 'active'", "where p.id = p_target and p.handle is not null")),
  sql("suspended requester may be accepted", "pgtap", rewrite("public.accept_follow_request(uuid)", "and p.handle is not null and p.account_status = 'active'", "")),

  // Blocks
  sql("request ignores blocks", "both", rewrite(REQUEST, "if not found or private.is_blocked_between(p_target) then", "if not found then")),
  sql("block keeps follows", "both", "alter table public.blocked_users disable trigger remove_follows_on_block;"),
  sql("block removes one direction only", "both", rewrite("private.remove_follows_on_block()", "\n     or (f.follower_id = new.blocked_id and f.followee_id = new.blocker_id)", "")),
  sql("follow state reveals a block", "pgtap", rewrite("public.get_follow_state(uuid)", "if not found or private.is_blocked_between(p_target) then\n    return 'unavailable';", "if private.is_blocked_between(p_target) then\n    return 'blocked_you';\n  elsif not found then\n    return 'unavailable';")),
  sql("blocked user can lift a block", "both", rewrite("public.unblock_user(uuid)", "where blocker_id = v_me and blocked_id = p_target", "where (blocker_id = v_me and blocked_id = p_target) or (blocker_id = p_target and blocked_id = v_me)")),
  sql("block list shows blocks on the caller", "both", rewrite("public.get_my_blocks(integer,timestamp with time zone,uuid)", "where b.blocker_id = v_me", "where (b.blocker_id = v_me or b.blocked_id = v_me)")),
  sql("unblock restores a follow", "pgtap", rewrite("public.unblock_user(uuid)", "delete from public.blocked_users where blocker_id = v_me and blocked_id = p_target;", "delete from public.blocked_users where blocker_id = v_me and blocked_id = p_target;\n  insert into public.follows (follower_id, followee_id, status, accepted_at) values (v_me, p_target, 'accepted', pg_catalog.now()) on conflict do nothing;")),

  // Concurrency
  sql("pair lock removed", "api", rewrite("private.lock_follow_pair(uuid,uuid)", "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(\n    'follow-pair:' || least(p_one, p_other)::text || ':' || greatest(p_one, p_other)::text, 0));", "null;")),
  sql("pair lock depends on direction", "api", rewrite("private.lock_follow_pair(uuid,uuid)", "least(p_one, p_other)::text || ':' || greatest(p_one, p_other)::text", "p_one::text || ':' || p_other::text")),
  sql("requester lock removed", "api", rewrite(REQUEST, REQUEST_LOCKS, "")),
  sql("target row not locked during a request", "api", rewrite(REQUEST, "where p.id = p_target and p.handle is not null and p.account_status = 'active'\n  for share;", "where p.id = p_target and p.handle is not null and p.account_status = 'active';")),
  sql("uniqueness of a follow pair removed", "both", "alter table public.follows drop constraint follows_pkey cascade;"),

  // Request limit
  sql("request limit removed", "both", rewrite("private.enforce_request_limit(uuid)", ">= 200", ">= 2000000")),
  sql("request limit off by one", "both", rewrite("private.enforce_request_limit(uuid)", ">= 200", "> 200")),
  sql("request limit ignores rejected requests", "pgtap", rewrite("private.enforce_request_limit(uuid)", "f.status in ('pending', 'rejected')", "f.status = 'pending'")),

  // Lists and counts
  sql("follower count includes private accounts", "both", rewrite("public.get_profile_counts(uuid)", CARD_FILTER, CARD_FILTER_NO_PRIVACY)),
  sql("follower list includes private accounts", "both", rewrite(`public.${PAGING}`, CARD_FILTER, CARD_FILTER_NO_PRIVACY)),
  sql("following list includes private accounts", "pgtap", rewrite(`public.${FOLLOWING}`, CARD_FILTER, CARD_FILTER_NO_PRIVACY)),
  sql("count includes pending requests", "pgtap", rewrite("public.get_profile_counts(uuid)", "f.status = 'accepted'", "f.status in ('accepted', 'pending')")),
  sql("count ignores viewer blocks", "pgtap", rewrite("public.get_profile_counts(uuid)", " and not (o.id = any (v_peers))", "")),
  sql("list ignores viewer blocks", "pgtap", rewrite(`public.${PAGING}`, " and not (o.id = any (v_peers))", "")),
  sql("private lists open to everyone", "both", rewrite("private.can_view_connections(uuid)", "and (p.follow_approval_required is false or private.is_accepted_follower(p_owner))", "")),
  sql("blocked viewer may list", "both", rewrite("private.can_view_connections(uuid)", "and not private.is_blocked_between(p_owner)", "")),
  sql("suspended viewer may list", "pgtap", rewrite("private.can_view_connections(uuid)", "private.is_active_user()\n      and ", "")),
  sql("page limit raised", "both", rewrite("private.page_size(integer,timestamp with time zone,uuid)", "p_limit > 100", "p_limit > 100000")),
  sql("half a cursor accepted", "pgtap", rewrite("private.page_size(integer,timestamp with time zone,uuid)", " or (p_before_at is null) <> (p_before_id is null)", "")),
  sql("paging ignores the tie-breaker", "pgtap", rewrite(`public.${PAGING}`, "(f.accepted_at, f.follower_id) < (coalesce(p_before_at, 'infinity'::timestamptz), coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))", "f.accepted_at < coalesce(p_before_at, 'infinity'::timestamptz)")),
  sql("queue shows rejected requests", "pgtap", rewrite("public.get_received_follow_requests(integer,timestamp with time zone,uuid)", "f.status = 'pending'", "f.status in ('pending', 'rejected')")),

  // Permissions
  sql("follows readable by clients", "both", "grant select on public.follows to authenticated;"),
  sql("follows readable by anon", "both", "grant select on public.follows to anon;"),
  sql("follows writable by service_role", "both", "grant insert on public.follows to service_role;"),
  sql("blocks readable by clients", "both", "grant select on public.blocked_users to authenticated;"),
  sql("RLS disabled on follows", "pgtap", "alter table public.follows disable row level security;"),
  sql("anon may list followers", "both", `grant execute on function public.${PAGING} to anon;`),
  sql("anon may request a follow", "both", "grant execute on function public.request_follow(uuid) to anon;"),
  sql("service_role may block for anyone", "both", "grant execute on function public.block_user(uuid) to service_role;"),
  sql("private helper exposed", "pgtap", "grant execute on function private.can_view_connections(uuid) to authenticated;"),
  sql("usage granted on private", "pgtap", "grant usage on schema private to authenticated;"),
  sql("request function without search_path", "pgtap", "alter function public.request_follow(uuid) reset search_path;"),
  sql("list function loses definer safety", "pgtap", `alter function public.${PAGING} set search_path = public;`),
];

export const suites = { m2: m2Mutations, m3: m3Mutations };
