/**
 * Deliberate security violations, used by db-mutation-checks.mjs to prove the tests
 * detect them. Each entry applies one violation to the local database, or to a
 * source file.
 *
 * `expect` names the suites that must fail: "pgtap", "api" or "both".
 */
const WORKFLOW = "src/features/avatars/avatar-workflow.ts";

const q = (text) => `$x$${text}$x$`;

/**
 * Rewrites a function body, and fails if the pattern is no longer there. Carriage
 * returns are removed first: a Windows checkout stores bodies with \r\n line endings,
 * and the patterns are written with \n.
 */
const rewrite = (signature, from, to) =>
  `do $m$ declare d text := replace(pg_get_functiondef('${signature}'::regprocedure), chr(13), ''); begin if position(${q(from)} in d) = 0 then raise exception 'pattern missing'; end if; execute replace(d, ${q(from)}, ${q(to)}); end $m$;`;

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

// M4a: one violation per audit and staff-authorization risk.
const GRANT = "public.grant_staff_role(uuid, public.staff_role, text)";
const REVOKE = "public.revoke_staff_role(uuid, public.staff_role, text)";
const STATUS = "public.set_account_status(uuid, public.account_status, text)";
const AUDIT_READ = "public.get_audit_events(integer, uuid)";

export const m4Mutations = [
  // Confidentiality and forgery
  sql("audit table granted to clients", "pgtap", "grant select, insert on private.audit_events to authenticated;"),
  sql("audit writer exposed", "pgtap", "grant execute on function private.record_audit(uuid, private.audit_action, uuid, text, jsonb) to authenticated;"),
  sql("service_role may grant roles", "both", `grant execute on function ${GRANT} to service_role;`),
  sql("anon may read the audit log", "both", `grant execute on function ${AUDIT_READ} to anon;`),
  sql("moderators may read the audit log", "both", rewrite(AUDIT_READ, "perform private.require_active_staff('admin');", "perform private.require_active_staff('moderator');")),
  // Append-only
  sql("audit rows can be changed", "pgtap", "drop trigger audit_events_no_update_or_delete on private.audit_events;"),
  sql("audit table can be truncated", "pgtap", "drop trigger audit_events_no_truncate on private.audit_events;"),
  // Completeness and atomicity
  sql("grant not audited", "both", rewrite(GRANT, "perform private.record_audit(v_me, 'staff_role_granted'", "perform pg_catalog.jsonb_build_array(v_me, 'staff_role_granted'")),
  sql("suspension not audited", "both", rewrite(STATUS, "perform private.record_audit(\n", "perform pg_catalog.jsonb_build_array(\n")),
  sql("audit failure ignored", "pgtap", rewrite("private.record_audit(uuid, private.audit_action, uuid, text, jsonb)", "  return v_id;\nend;", "  return v_id;\nexception when others then\n  return null;\nend;")),
  sql("reason not required", "pgtap", rewrite("private.require_reason(text)", "if v_reason is null or pg_catalog.char_length", "if pg_catalog.char_length")),
  // Staff authorization
  sql("moderator may grant roles", "pgtap", rewrite(GRANT, "v_me := private.require_active_staff('admin');", "v_me := private.require_active_staff('moderator');")),
  sql("suspended staff may act", "both", rewrite("private.require_active_staff(public.staff_role)", "or not private.is_active_user() ", "")),
  sql("inactive account may receive a role", "both", rewrite(GRANT, "where p.id = p_user and p.account_status = 'active' and p.handle", "where p.id = p_user and p.handle")),
  sql("last administrator may be removed", "pgtap", rewrite(REVOKE, "if p_role = 'admin' and private.other_active_admins(p_user) = 0 then", "if false then")),
  sql("moderator may suspend staff", "pgtap", rewrite(STATUS, "  if exists (select 1 from public.staff_roles s where s.user_id = p_user) then", "  if false then")),
  sql("self-suspension allowed", "pgtap", rewrite(STATUS, "if p_user is null or p_user = v_me then", "if p_user is null then")),
  sql("deactivation managed by staff", "pgtap", rewrite(STATUS, "p_status not in ('active', 'suspended')", "p_status not in ('active', 'suspended', 'deactivated')")),
  sql("staff function without search_path", "pgtap", `alter function ${STATUS} set search_path = public;`),
  // Concurrency
  sql("staff changes not serialized", "api", rewrite("private.lock_staff_changes()", "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('staff-changes', 0));", "null;")),
];

const NOTIFY = "private.notify(uuid, uuid, public.notification_type, timestamptz, jsonb)";
const FOLLOW_CHANGE = "private.notify_follow_change()";
const LIST = "public.get_my_notifications(integer, uuid)";
const COUNT = "public.get_unread_notification_count()";
const MARK = "public.mark_notifications_read(uuid)";
const VISIBLE = "(n.actor_id is null or (a.handle is not null and a.account_status = 'active' and not (n.actor_id = any (v_peers))))";
const LOCK_COMMENT = "\n  -- M4b: lock both accounts before the follow row. See the header.\n";

export const m4bMutations = [
  // Confidentiality
  sql("notifications granted to clients", "both", "grant select, insert on public.notifications to authenticated;"),
  sql("notification writer exposed", "pgtap", `grant execute on function ${NOTIFY} to authenticated;`),
  sql("service_role may list notifications", "both", `grant execute on function ${LIST} to service_role;`),
  sql("missing recipient filter", "both", rewrite(LIST, "where n.recipient_id = v_me\n      and (p_before", "where (p_before")),
  sql("list ignores actor visibility", "both", rewrite(LIST, `\n      and ${VISIBLE}\n    order by`, "\n    order by")),
  sql("count ignores actor visibility", "both", rewrite(COUNT, `\n        and ${VISIBLE}\n      limit 100`, "\n      limit 100")),
  sql("mark read ignores actor visibility", "pgtap", rewrite(MARK, "\n          and (x.actor_id is null or", "\n          and (true or")),
  sql("another user's notification can be deleted", "both", rewrite("public.delete_notification(uuid)", "where n.id = p_id and n.recipient_id = v_me", "where n.id = p_id")),
  // M3 promises
  sql("cooldown retry notifies", "both", rewrite(FOLLOW_CHANGE, "if new.status = 'pending' then", "if new.status in ('pending', 'rejected') then")),
  sql("request notice not withdrawn", "both", rewrite(FOLLOW_CHANGE, "if tg_op <> 'INSERT' and old.status = 'pending' and (tg_op = 'DELETE' or new.status <> 'pending') then", "if false then")),
  sql("block keeps notifications", "both", "drop trigger remove_notifications_on_block on public.blocked_users;"),
  sql("block removes notifications in one direction only", "both", rewrite("private.remove_notifications_on_block()", "\n     or (n.recipient_id = new.blocked_id and n.actor_id = new.blocker_id)", "")),
  // Idempotency and deduplication
  sql("event key removed", "pgtap", `alter table public.notifications drop constraint notifications_event_key; ${rewrite(NOTIFY, "\n  on conflict (recipient_id, actor_id, type, event_at) do nothing;", ";")}`),
  sql("24-hour window removed", "both", rewrite(NOTIFY, "and n.created_at > pg_catalog.now() - interval '24 hours'", "and false")),
  sql("mark read ignores its bound", "pgtap", rewrite(MARK, "and (p_up_to is null or x.id <= p_up_to)", "")),
  sql("mark read waits on locked rows", "api", rewrite(MARK, "for update of x skip locked", "for update of x")),
  // Preferences
  sql("preference ignored", "both", rewrite(NOTIFY, "and up.notification_settings ->> p_type::text = 'false'", "and false")),
  sql("preference validation dropped", "both", "alter table public.user_preferences drop constraint user_preferences_notification_settings_valid;"),
  // Moderation notices
  sql("moderation notice names the staff member", "both", `alter table public.notifications drop constraint notifications_shape; ${rewrite("private.notify_account_status_change()", "perform private.notify(new.id, null, 'moderation'", "perform private.notify(new.id, (select auth.uid()), 'moderation'")}`),
  sql("moderation notice skipped", "both", "drop trigger notify_account_status_change on public.profiles;"),
  // Account deletion and lock order
  sql("deleted actor's notices kept", "both", "alter table public.notifications drop constraint notifications_shape, drop constraint notifications_actor_id_fkey, add constraint notifications_actor_id_fkey foreign key (actor_id) references public.profiles (id) on delete set null;"),
  sql("follow notices written as the caller", "both", `alter function ${FOLLOW_CHANGE} security invoker;`),
  sql("accept locks the follow before the accounts", "both", rewrite("public.accept_follow_request(uuid)", `${LOCK_COMMENT}  perform 1 from public.profiles p where p.id in (v_me, p_requester) order by p.id for key share;\n`, "\n")),
  sql("request locks the follow before the accounts", "both", rewrite("public.request_follow(uuid)", `${LOCK_COMMENT}  perform 1 from public.profiles p where p.id = v_me for key share;\n`, "\n")),
];

const CATALOG_EDIT = "private.begin_catalog_edit()";
const CATALOG_LOCK = "private.lock_catalog_edits()";
const PUBLISH = "public.publish_release(uuid, text, bigint)";
const VERIFY_RELEASE = "public.verify_release(uuid, text, bigint)";
const CREATE_RELEASE = "public.create_release(uuid, uuid, text, text, jsonb, text)";
const PUBLICATION_CHECK = "private.check_catalog_publication()";
const SHARED_LOCK = "perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('staff-changes', 0));";

export const m5aMutations = [
  // Confidentiality: unpublished records and who handled them
  sql("catalog writable by clients", "pgtap", "grant insert, update, delete on public.games to authenticated;"),
  sql("unpublished games readable by anon", "both", "alter policy games_read_anon on public.games using (true);"),
  sql("unpublished releases readable by any user", "both", "alter policy releases_read_authenticated on public.releases using (true);"),
  sql("markets ignore release visibility", "pgtap", "alter policy release_markets_read on public.release_markets using (true);"),
  sql("verifier visible to clients", "both", "grant select (verified_by) on public.releases to anon, authenticated;"),
  sql("service_role reads the catalog", "both", "grant select on public.releases to service_role;"),
  sql("provenance readable by clients", "pgtap", "grant select on private.provider_records to authenticated;"),
  sql("editor function open to anon", "both", "grant execute on function public.create_game(text, public.game_kind, text, text, date, public.date_precision, text) to anon;"),
  // Editor authorization and the shared staff lock
  sql("anyone may edit the catalog", "both", rewrite(CATALOG_EDIT, "v_me := private.require_active_staff('catalog_editor');", "v_me := (select auth.uid());")),
  sql("catalog edits skip the staff lock", "both", rewrite(CATALOG_LOCK, SHARED_LOCK, "null;")),
  sql("catalog edits lock each other out", "both", rewrite(CATALOG_LOCK, SHARED_LOCK, "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('staff-changes', 0));")),
  sql("editor checked before the lock", "both", rewrite(CATALOG_EDIT, "  perform private.lock_catalog_edits();\n  v_me := private.require_active_staff('catalog_editor');", "  v_me := private.require_active_staff('catalog_editor');\n  perform private.lock_catalog_edits();")),
  sql("editor profile not locked first", "pgtap", rewrite(CATALOG_EDIT, "  perform 1 from public.profiles p where p.id = v_me for key share;\n", "")),
  // Verification and publication
  sql("unverified release published", "both", `alter table public.releases drop constraint releases_published_verified; ${rewrite(PUBLISH, "if v_release.verified_at is null then", "if false then")}`),
  sql("unverified game published", "pgtap", `alter table public.games drop constraint games_published_verified; ${rewrite(PUBLISH, "if v_game.verified_at is null then", "if false then")}`),
  sql("release published without its game", "pgtap", "drop trigger check_catalog_publication on public.releases;"),
  sql("game published without a physical release", "pgtap", rewrite(PUBLICATION_CHECK, "if exists (select 1 from public.games g where g.id = v_game and g.status = 'published')\n     and not private.game_has_published_release(v_game) then", "if false then")),
  sql("published release can be unpublished", "pgtap", "drop trigger guard_published_catalog_row on public.releases;"),
  sql("edits keep a stale verification", "pgtap", rewrite("private.clear_release_verification(uuid)", "where r.id = p_release and r.status <> 'published' and r.verified_at is not null;", "where false;")),
  sql("import defaults an edition", "pgtap", rewrite(CREATE_RELEASE, "v_row.edition_name,\n    v_row.edition_kind,", "coalesce(v_row.edition_name, 'Standard'),\n    coalesce(v_row.edition_kind, 'standard'),")),
  sql("unknown region published unconfirmed", "pgtap", `alter table public.releases drop constraint releases_published_region; ${rewrite(VERIFY_RELEASE, "\n     or (v_release.region_code = 'unknown' and not v_release.region_unknown_confirmed) then", " then")}`),
  sql("publication not audited", "both", rewrite(PUBLISH, "  perform private.record_catalog_audit(v_me, 'catalog_record_published', 'release'", "  perform pg_catalog.jsonb_build_array(v_me, 'catalog_record_published', 'release'")),
  // Physical identity and provenance
  sql("duplicate physical identity allowed", "both", "drop index public.releases_published_identity_key;"),
  sql("format not tied to its platform", "pgtap", "alter table public.releases drop constraint releases_platform_id_media_format_code_fkey;"),
  sql("stale verification accepted", "both", rewrite(VERIFY_RELEASE, "if v_release.revision <> p_expected_revision then", "if false then")),
  sql("stale publication accepted", "pgtap", rewrite(PUBLISH, "if v_release.revision <> p_expected_revision then", "if false then")),
  sql("details don't raise the revision", "pgtap", "drop trigger bump_release_revision on public.release_markets;"),
  sql("game data counts as release evidence", "pgtap", "drop trigger validate_release_evidence on private.release_evidence;"),
  sql("editor function without search_path", "pgtap", `alter function ${PUBLISH} set search_path = public;`),
];

const CLEARANCE = "private.import_require_clearance(text, text)";
const RUN_FOR = "private.import_run_for(uuid, uuid)";
const APPLY_GAME = "private.import_apply_game(private.import_runs, private.provider_records)";
const APPLY_RELEASE = "private.import_apply_release(private.import_runs, private.provider_records)";
const RECLASSIFY = "private.import_reclassify(private.import_runs, private.provider_records)";
const START_RUN = "catalog_import.start_run(text, text, text, text, timestamp with time zone, text, text, uuid)";

export const m5bMutations = [
  // Gate 1: clearance
  sql("uncleared provider imported", "pgtap", rewrite(CLEARANCE, "if not found or not v_provider.commercial_use_cleared then", "if not found then")),
  sql("terms not checked", "pgtap", rewrite(CLEARANCE, "if p_terms_sha256 is distinct from v_provider.terms_sha256 then", "if false then")),
  sql("withdrawal doesn't wait for a batch", "api", rewrite(CLEARANCE, "where p.code = p_provider for share;", "where p.code = p_provider for key share;")),
  // Gate 2: audit
  sql("import not audited", "both", rewrite(APPLY_GAME, "perform private.record_catalog_audit(null, 'catalog_record_created', 'game'", "perform pg_catalog.jsonb_build_array(null, 'catalog_record_created', 'game'")),
  // Gate 3: one run per snapshot, one process per run
  sql("snapshot runs concurrently", "both", `drop index private.import_runs_one_running_snapshot; ${rewrite(START_RUN, "if exists (select 1 from private.import_runs r where r.provider_code = p_provider and r.source_sha256 = p_source_sha256 and r.status = 'running') then", "if false then")}`),
  sql("lease not checked", "both", rewrite(RUN_FOR, "if p_lease is null or v_run.lease_id is distinct from p_lease then", "if false then")),
  // Gate 4: locks and editorial data
  sql("field locks ignored", "pgtap", rewrite("private.import_field_locked(uuid, uuid, text)", "select exists (", "select false and exists (")),
  sql("verified release overwritten", "pgtap", rewrite(APPLY_RELEASE, " or v_release.status = 'published' or v_release.verified_at is not null then", " then")),
  // Gate 5: evidence
  sql("evidence from another release", "pgtap", rewrite("private.validate_release_evidence()", "where pr.id = new.provider_record_id and pr.matched_release_id = new.release_id", "where pr.id = new.provider_record_id")),
  // Gate 6: source ids
  sql("source id not resolved", "both", rewrite(APPLY_GAME, "where x.provider_code = p_record.provider_code and x.entity_type = 'game' and x.external_id = p_record.external_id;", "where false;")),
  sql("source ids not serialized", "api", rewrite("private.import_lock_source_id(text, text, text)", "select pg_catalog.pg_advisory_xact_lock(", "select pg_catalog.pg_try_advisory_xact_lock(")),
  // Reclassification safety
  sql("withdrawal ignores verification", "pgtap", rewrite(RECLASSIFY, "  if v_release.verified_at is not null then", "  if false then")),
  sql("withdrawal ignores editor changes", "pgtap", rewrite(RECLASSIFY, "and e.metadata ->> 'id' = v_id::text and e.actor_id is not null) then", "and false) then")),
  sql("withdrawal ignores field locks", "pgtap", rewrite(RECLASSIFY, "  if exists (select 1 from private.catalog_field_locks l where l.release_id = v_id) then", "  if false then")),
  sql("held entries withdraw candidates", "pgtap", rewrite(RECLASSIFY, "  if p_record.review_reason is not null then", "  if false then")),
  sql("withdrawal deletes the candidate", "pgtap", rewrite(RECLASSIFY, "    update public.releases r set status = 'rejected' where r.id = v_id;", "    delete from public.releases r where r.id = v_id;")),
  // Title matching
  sql("word-break match ignores the platform", "pgtap", rewrite("private.import_games_by_compact(uuid, text)", "  join public.game_platforms gp on gp.game_id = g.id and gp.platform_id = p_platform\n", "")),
  sql("short titles match ignoring word breaks", "pgtap", rewrite("private.import_compact_key(text)", ">= 6 then", ">= 0 then")),
  // The restricted role
  sql("importer can verify", "pgtap", "grant execute on function public.verify_release(uuid, text, bigint) to catalog_importer;"),
  sql("importer reads the catalog", "both", "grant select on public.games to catalog_importer;"),
  sql("importer inherits roles", "pgtap", "alter role catalog_importer inherit;"),
  // Private submissions (M7b-1 follow-up)
  sql("imports match a pending submission by title", "pgtap", rewrite("private.import_games_by_key(uuid, text)", "\n    and not private.import_private_game(g)", "")),
  sql("imports match a pending submission ignoring word breaks", "pgtap", rewrite("private.import_games_by_compact(uuid, text)", "\n    and not private.import_private_game(g)", "")),
  sql("imports note a pending submission's serial", "pgtap",
    rewrite("private.import_apply_release(private.import_runs, private.provider_records)", "\n      and not private.import_private_release(r);", ";")),
  sql("an unowned submitted game is matched", "pgtap",
    rewrite("private.import_private_game(public.games)", "or exists (select 1 from public.catalog_change_requests s where s.game_id = p_game.id and s.created_game)", "or false")),
];

const SEARCH = "public.search_catalog(text, text[], integer, text)";
const PICKER = "public.get_release_picker(text, text, text, uuid)";
const PUBLIC_RELEASES = "private.catalog_public_releases(uuid)";
const GAME_PLATFORMS = "private.catalog_game_platforms_json(uuid)";
const GAME_JSON = "private.catalog_game_json(public.games)";
const RELEASE_JSON = "private.catalog_release_json(public.releases)";
const ADD_ALIAS = "public.add_game_alias(uuid, text, public.game_alias_kind, text, text, text)";

export const m5cMutations = [
  // Publication. Search filters games, pairings and releases in several places; each
  // of these removes a filter everywhere it applies in one function.
  sql("search shows unpublished releases", "both", rewrite(SEARCH, "r.status = 'published' and r.verified_at is not null", "true")),
  sql("picker shows unpublished releases", "both", rewrite(PUBLIC_RELEASES, "r.status = 'published' and r.verified_at is not null", "true")),
  sql("results count unpublished releases", "both", rewrite(GAME_PLATFORMS, "r.status = 'published' and r.verified_at is not null", "true")),
  sql("platform list counts unpublished releases", "pgtap", rewrite("public.list_catalog_platforms()", "where r.status = 'published' and r.verified_at is not null", "where true")),
  sql("never-public merged game resolves", "pgtap", rewrite(PICKER, "if v_game.slug is null or v_depth > 10 then", "if v_depth > 10 then")),
  // Response allowlists
  sql("picker shows the verifier", "both", rewrite(RELEASE_JSON, "'variant_name', p_release.variant_name,", "'variant_name', p_release.variant_name, 'verified_by', p_release.verified_by,")),
  sql("results show verification", "both", rewrite(GAME_JSON, "'title', p_game.title,", "'title', p_game.title, 'verified_at', p_game.verified_at,")),
  // Pages and limits
  sql("cursor continues another query", "both", rewrite(SEARCH, "if v_cursor ->> 0 is distinct from v_hash or", "if")),
  sql("cursor skips equal titles", "pgtap", rewrite(SEARCH,
    "(x.tier, -x.score, x.sort_title, x.game_id, coalesce(x.release_id, c_zero)) > (c_tier, -c_score, c_sort, c_game, c_release)",
    "(x.tier, -x.score, x.sort_title) > (c_tier, -c_score, c_sort)")),
  sql("results not capped", "pgtap", rewrite(SEARCH, "c_max_results constant integer := 200;", "c_max_results constant integer := 100000;")),
  sql("page size not capped", "pgtap", rewrite(SEARCH, "least(greatest(coalesce(p_limit, 20), 1), 50)", "greatest(coalesce(p_limit, 20), 1)")),
  // Matching
  sql("search key drops non-Latin titles", "pgtap", rewrite("private.catalog_search_key(text)", "'[^[:alnum:]]+'", "'[^a-z0-9]+'")),
  sql("trigram thresholds follow the session", "pgtap", rewrite(SEARCH,
    "  perform pg_catalog.set_config('pg_trgm.similarity_threshold', '0.5', true);\n  perform pg_catalog.set_config('pg_trgm.word_similarity_threshold', '0.6', true);\n", "")),
  // Revisions: the stored search keys must not count as content.
  sql("revision counts search columns", "pgtap", rewrite("private.bump_catalog_revision()", ", 'search_key', 'search_compact', 'search_words', 'local_title_key'", "")),
  // Aliases and access
  sql("alias needs no editor", "both", rewrite(ADD_ALIAS, "v_me := private.begin_catalog_edit();", "v_me := auth.uid();")),
  sql("alias not audited", "both", rewrite(ADD_ALIAS, "perform private.record_catalog_audit(v_me, 'catalog_alias_added',", "perform pg_catalog.jsonb_build_array(v_me, 'catalog_alias_added',")),
  sql("anon may write aliases", "pgtap", "grant insert on public.game_aliases to anon; create policy x on public.game_aliases for insert to anon with check (true);"),
  sql("search granted to service_role", "both", `grant execute on function ${SEARCH} to service_role;`),
];

const ADD_ITEM = "public.add_collection_item(uuid, uuid, jsonb)";
const ITEM = "public.get_my_collection_item(uuid)";
const NEW_ITEM = "private.check_new_collection_item()";
const ITEM_UPDATE = "private.guard_collection_item_update()";
const UPDATE = "public.update_collection_item(uuid, jsonb)";
const COMPONENT = "private.check_collection_item_component()";
const OWNER = "owner_id = (select auth.uid())";
const ACTIVE = "(select private.is_active_user())";

export const m6Mutations = [
  // Owner-only access
  sql("copies readable by every user", "both",
    `drop policy collection_items_read_own on public.collection_items; create policy collection_items_read_own on public.collection_items for select to authenticated using (true);`),
  sql("private details readable by every user", "both",
    `drop policy collection_item_private_read_own on public.collection_item_private; create policy collection_item_private_read_own on public.collection_item_private for select to authenticated using (true);`),
  sql("private details granted to service_role", "both", "grant select on public.collection_item_private to service_role;"),
  sql("copy read bypasses the owner", "both", `alter function ${ITEM} security definer; ${rewrite(ITEM, "where c.id = p_item and c.owner_id = (select auth.uid())", "where c.id = p_item")}`),
  // Writes
  sql("copies added for any owner", "pgtap",
    `drop policy collection_items_insert_own on public.collection_items; create policy collection_items_insert_own on public.collection_items for insert to authenticated with check (${ACTIVE} and private.can_use_release(release_id));`),
  sql("details written for another owner", "pgtap",
    `drop policy collection_item_private_insert_own on public.collection_item_private; create policy collection_item_private_insert_own on public.collection_item_private for insert to authenticated with check (${ACTIVE});`),
  // Since M7b-2a the late release check (a trigger) enforces the same rule as the
  // policy, so weakening the policy alone changes nothing. This removes both; the m7b2a
  // suite tests the trigger on its own.
  sql("any release can be attached", "both",
    `drop policy collection_items_insert_own on public.collection_items; create policy collection_items_insert_own on public.collection_items for insert to authenticated with check (${OWNER} and ${ACTIVE}); drop trigger check_copy_release on public.collection_items;`),
  sql("suspended owners may edit copies", "api",
    `drop policy collection_items_update_own on public.collection_items; create policy collection_items_update_own on public.collection_items for update to authenticated using (${OWNER}) with check (${OWNER} and private.can_use_release(release_id));`),
  sql("suspended owners may add", "both", rewrite(ADD_ITEM, "if not coalesce((select a.is_active from public.get_my_account() a), false) then", "if false then")),
  sql("client may move a copy", "both", "grant update (release_id) on public.collection_items to authenticated;"),
  sql("client may publish a copy", "both", "grant update (visibility) on public.collection_items to authenticated;"),
  // Idempotency, ids and the limit
  sql("repeat ignores the release", "both", rewrite(ADD_ITEM, "    if v_existing = p_release then\n      return", "    if true then\n      return")),
  sql("id age not checked", "pgtap", rewrite(NEW_ITEM, "if v_ms < v_now_ms - 86400000 or v_ms > v_now_ms + 300000 then", "if false then")),
  sql("limit check not locked", "api", rewrite(NEW_ITEM, "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('collection_items:' || new.owner_id::text, 0));", "")),
  // Pieces and preserved copies
  sql("unlisted pieces accepted", "both", rewrite(COMPONENT, "if tg_op = 'INSERT' and not exists (", "if false and not exists (")),
  sql("preserved copies editable", "pgtap", rewrite(ITEM_UPDATE, "    raise exception 'item preserved' using errcode = 'P0001';", "    null;")),
  // Records of pieces the release no longer lists (M6d follow-up)
  sql("edit drops records of unlisted pieces", "pgtap", rewrite(UPDATE,
    "      where c.item_id = p_item\n        and exists (select 1 from public.release_components rc\n                    where rc.release_id = v_item.release_id and rc.kind = c.kind and rc.label = c.label);",
    "      where c.item_id = p_item;")),
  sql("listed pieces removable", "pgtap", rewrite(UPDATE, '      -- A piece the release lists is changed through "components", never removed here.\n      if exists (', "      if false and exists (")),
  sql("unrecorded pieces removable", "pgtap", rewrite(UPDATE, "      -- Each must be a record of this copy's.\n      if exists (", "      if false and exists (")),
  sql("removal reaches the owner's other copies", "pgtap", rewrite(UPDATE, "c.item_id = p_item and c.owner_id = v_me and c.kind = x.kind", "c.owner_id = v_me and c.kind = x.kind")),
  sql("removal not validated", "pgtap", rewrite(UPDATE, "pg_catalog.jsonb_array_length(p_changes -> 'remove_components') not between 1 and 60", "false")),
];

const BEGIN_SUBMISSION = "private.begin_submission(boolean)";
const SUBMIT_RELEASE = "public.submit_release(uuid, text, text, text, jsonb, jsonb, text, boolean)";
const CREATE_SUBMITTED = "private.create_submitted_release(uuid, uuid, text, text, text, jsonb, jsonb)";
const LOCK_SUBMISSION = "private.lock_open_submission(uuid, uuid)";
const WITHDRAW = "public.withdraw_my_submission(uuid)";

export const m7aMutations = [
  // Owner-only history
  sql("review record readable by clients", "both",
    "grant select on public.catalog_change_requests to authenticated; create policy __m on public.catalog_change_requests for select to authenticated using (true);"),
  sql("reused pairing detectable", "both", "alter table public.catalog_change_requests disable row level security; grant select (id, created_pairing) on public.catalog_change_requests to authenticated;"),
  sql("submitters read the pairings they made", "both",
    "alter policy game_platforms_read_authenticated on public.game_platforms using (status = 'published' or (submitted_by = (select auth.uid()) and status in ('unverified', 'under_review', 'rejected')) or (select private.is_catalog_editor()));"),
  sql("clients may write the review record", "both",
    "grant insert on public.catalog_change_requests to authenticated; create policy __m on public.catalog_change_requests for insert to authenticated with check (true);"),
  // Who may submit, and what
  sql("suspended accounts may submit", "both", rewrite(BEGIN_SUBMISSION, "if not coalesce((select a.is_active from public.get_my_account() a), false) then", "if false then")),
  sql("hidden games accepted", "both", rewrite(SUBMIT_RELEASE, "and (g.status = 'published' or (g.submitted_by = v_me and g.status = 'unverified'))", "and true")),
  sql("physical confirmation skipped", "pgtap", rewrite(SUBMIT_RELEASE, "if not coalesce(p_physical, false) or ", "if ")),
  sql("unknown region confirmed", "pgtap", rewrite(CREATE_SUBMITTED, "p_game, create_submitted_release.platform_id, p_region, false,", "p_game, create_submitted_release.platform_id, p_region, p_region = 'unknown',")),
  // The rate limit
  sql("rate limit not locked", "api", rewrite(BEGIN_SUBMISSION, "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catalog_submissions:' || v_me::text, 0));", "")),
  sql("rate limit off by one", "both", rewrite(BEGIN_SUBMISSION, "interval '24 hours') >= 10 then", "interval '24 hours') > 10 then")),
  sql("withdrawn submissions don't count", "pgtap", rewrite(BEGIN_SUBMISSION, "where s.submitted_by = v_me and s.request_type", "where s.submitted_by = v_me and s.status <> 'withdrawn' and s.request_type")),
  // Changing and withdrawing
  sql("another user's submission editable", "pgtap", rewrite(LOCK_SUBMISSION, "where s.id = p_submission and s.submitted_by = p_me and", "where s.id = p_submission and")),
  sql("withdrawal ignores copies", "both", rewrite(WITHDRAW, "if exists (select 1 from public.collection_items c where c.release_id = v_release.id) then", "if false then")),
  sql("withdrawal deletes a shared pairing", "both", rewrite(WITHDRAW,
    "     and not exists (select 1 from public.releases r where r.game_id = v_release.game_id and r.platform_id = v_release.platform_id) then\n    delete from public.game_platforms",
    "     or true then\n    delete from public.game_platforms")),
];

const GUARD = "private.guard_submitted_record()";
const BEGIN_REVIEW = "private.begin_review(uuid, uuid, integer)";
const START_REVIEW = "public.start_submission_review(uuid, integer, text)";
const APPROVE = "public.approve_submission(uuid, integer, bigint, bigint, text, text)";
const REQUEST_CHANGES = "public.request_submission_changes(uuid, integer, text, text)";
const REJECT = "public.reject_submission(uuid, integer, text, text)";
const RESUBMIT = "public.resubmit_my_submission(uuid, text)";

export const m7b1Mutations = [
  // Who reviews, and never their own
  sql("anyone may start a review", "both", rewrite(START_REVIEW, "v_me := private.begin_catalog_edit();", "v_me := (select auth.uid());")),
  sql("collectors may read the queue", "both", rewrite("public.get_submission_queue(text, uuid, integer)", "v_me uuid := private.require_active_staff('catalog_editor');", "v_me uuid := (select auth.uid());")),
  sql("collectors may read a submission under review", "both", rewrite("public.get_submission_review(uuid)", "v_me uuid := private.require_active_staff('catalog_editor');", "v_me uuid := (select auth.uid());")),
  sql("self-review allowed", "pgtap", rewrite(BEGIN_REVIEW, "if req.submitted_by is not distinct from p_me then", "if false then")),
  sql("a deleted submitter blocks review", "both", rewrite(BEGIN_REVIEW, "if req.submitted_by is not distinct from p_me then", "if req.submitted_by is null or req.submitted_by = p_me then")),
  sql("editors see the submitter's email", "both", rewrite("private.review_submitter(uuid)", "'handle', p.handle,", "'handle', p.handle, 'email', (select u.email from auth.users u where u.id = p.id),")),
  // No bypass
  sql("publication without review", "both", rewrite(GUARD, "      raise exception 'review required' using errcode = 'P0001';", "      null;")),
  sql("submitters may verify what they submitted", "pgtap", rewrite(GUARD, "      raise exception 'own submission' using errcode = 'P0001';", "      null;")),
  sql("editors may change a submission before its review", "pgtap", rewrite(GUARD, "  elsif v_req.status <> 'in_review' then", "  elsif false then")),
  sql("submitters may change it in review as editors", "pgtap", rewrite(GUARD, "    if v_req.status not in ('open', 'changes_requested') then", "    if false then")),
  sql("submitters may confirm an unknown region", "pgtap", rewrite(GUARD, "if v_release and new.region_unknown_confirmed and not old.region_unknown_confirmed then", "if false then")),
  // Stale pages
  sql("stale version accepted", "both", rewrite(BEGIN_REVIEW, "if req.version <> p_expected_version then", "if false then")),
  sql("account deletion leaves the version", "pgtap", "drop trigger bump_request_version on public.catalog_change_requests;"),
  // Outcomes
  sql("approval leaves the request open", "both", rewrite(APPROVE, "status = 'approved', reviewed_by = v_me", "status = 'in_review', reviewed_by = v_me")),
  sql("changes requested of a deleted account", "both", rewrite(REQUEST_CHANGES, "if v_req.submitted_by is null then", "if false then")),
  sql("rejection ignores a game's other releases", "pgtap",
    rewrite(REJECT, "o.status in ('unverified', 'under_review', 'published')) then 'unverified'::public.catalog_status", "o.status in ('unverified', 'under_review', 'published') and false) then 'unverified'::public.catalog_status")),
  sql("resubmitting after rejection not counted", "pgtap", rewrite(RESUBMIT, "  perform private.begin_submission(true);", "  perform private.begin_submission(false);")),
  sql("a rejected request resubmitted twice", "pgtap", rewrite(RESUBMIT, "if exists (select 1 from public.catalog_change_requests n where n.previous_request_id = v_old.id) then", "if false then")),
  // Notifications
  sql("a submission notice names the reviewer", "both", rewrite(APPROVE, "perform private.notify(v_req.submitted_by, null, 'catalog_submission', null,", "perform private.notify(v_req.submitted_by, v_me, 'catalog_submission', null,")),
  sql("submission notices unconstrained", "pgtap", "alter table public.notifications drop constraint notifications_shape;"),
];

const USABLE = "private.lock_usable_release(uuid, uuid)";
const RELINK = "public.relink_my_copy(uuid, uuid)";

export const m7b2aMutations = [
  // Piece records survive a change of release
  sql("moving a copy drops its unlisted piece records", "both",
    "create function private.__m_drop_unlisted() returns trigger language plpgsql set search_path = '' as $f$ begin delete from public.collection_item_components c where c.item_id = new.id and not exists (select 1 from public.release_components rc where rc.release_id = new.release_id and rc.kind = c.kind and rc.label = c.label); return null; end $f$; create trigger __m_drop_unlisted after update of release_id on public.collection_items for each row when (new.release_id is distinct from old.release_id) execute function private.__m_drop_unlisted();"),
  // The late check
  sql("adding a copy skips the late release check", "both", "drop trigger check_copy_release on public.collection_items;"),
  sql("moving a copy skips the late release check", "pgtap", "drop trigger check_copy_release_move on public.collection_items;"),
  sql("the late check takes a key-share lock", "api", rewrite(USABLE, "for share;", "for key share;")),
  sql("the late check ignores the release's status", "both", rewrite(USABLE, "  if not found or not (rel.status = 'published'", "  if not found or false and not (rel.status = 'published'")),
  sql("the late check isn't null-safe", "pgtap", rewrite(USABLE, "or (rel.submitted_by is not null and rel.submitted_by = p_owner", "or (rel.submitted_by = p_owner")),
  // Relinking
  sql("another user's copy can be moved", "both", rewrite(RELINK, "c.owner_id = v_me", "true")),
  sql("a copy moves to another platform", "pgtap", rewrite(RELINK, "if v_target.platform_id is distinct from v_source.platform_id then", "if false then")),
  sql("a suspended owner can move copies", "pgtap", rewrite(RELINK, "if not private.is_active_user() then", "if false then")),
  sql("relinking locks the copy before the releases", "api", rewrite(RELINK, "  perform 1 from public.releases r where r.id in (v_from, p_release) order by r.id for share;\n", "")),
  sql("clients may change a copy's release directly", "both", "grant update (release_id) on public.collection_items to authenticated;"),
  sql("visitors may call relinking", "pgtap", `grant execute on function ${RELINK} to anon;`),
];

const EXCLUDE = "public.exclude_release(uuid, text, text, text, text, boolean, boolean)";
const RESTORE = "public.restore_exclusion(uuid, integer, text)";
const PLAN = "private.exclusion_plan(uuid)";
const BLOCKER = "private.restore_blocker(private.catalog_exclusions)";
const PUBLICATION = "private.check_publication_of(uuid, uuid)";
const PRESERVED = "private.my_preserved_releases(uuid[])";
const PRESERVED_RELEASE = "public.get_my_preserved_release(uuid)";
const COPY_TOUCHED = "private.set_copy_updated_at()";
const NEW_PROFILES = "private.lock_new_profiles(uuid[], uuid[])";
const RESTORED_COPIES = "    where c.release_id = ex.release_id and c.record_status = 'invalid_preserved' and c.invalidated_at = ex.excluded_at\n";

export const m7b2bMutations = [
  // Preservation
  sql("exclusion preserves other copies of the same owners", "pgtap", rewrite(EXCLUDE, "  where c.id = any (v_items);", "  where c.id = any (v_items) or c.owner_id = any (v_owners);")),
  sql("exclusion deletes piece records", "pgtap", rewrite(EXCLUDE, "  insert into private.catalog_exclusion_copies (exclusion_id, item_id, owner_id)", "  delete from public.collection_item_components k where k.item_id = any (v_items);\n  insert into private.catalog_exclusion_copies (exclusion_id, item_id, owner_id)")),
  sql("exclusion deletes private details", "pgtap", rewrite(EXCLUDE, "  insert into private.catalog_exclusion_copies (exclusion_id, item_id, owner_id)", "  delete from public.collection_item_private k where k.item_id = any (v_items);\n  insert into private.catalog_exclusion_copies (exclusion_id, item_id, owner_id)")),
  sql("exclusion changes a copy's updated_at", "api", rewrite(COPY_TOUCHED, "    new.updated_at := old.updated_at;", "    new.updated_at := pg_catalog.clock_timestamp();")),
  // Notifications
  sql("each copy is notified, not each owner", "pgtap", rewrite(EXCLUDE, "select o, count(*)::integer from pg_catalog.unnest(v_owners) o where o is distinct from v_notified group by o order by o", "select o, 1 from pg_catalog.unnest(v_owners) o where o is distinct from v_notified")),
  sql("a second notice of an event can be stored", "pgtap", "drop index public.notifications_exclusion_event_key;"),
  sql("notices name the excluding editor", "both", rewrite(EXCLUDE, "perform private.notify(v_owner, null, 'catalog_exclusion', null,", "perform private.notify(v_owner, v_me, 'catalog_exclusion', null,")),
  // Who may exclude and restore
  sql("collectors may exclude", "pgtap", rewrite(EXCLUDE, "v_me := private.begin_catalog_edit();", "v_me := (select auth.uid());")),
  sql("editors may exclude their own submission", "pgtap", rewrite(EXCLUDE, "if private.exclusion_involves(v_me, p_release, v_plan -> 'cascade') then", "if false then")),
  sql("editors may restore", "both", rewrite(RESTORE, "v_me := private.require_active_staff('admin');", "v_me := private.require_active_staff('catalog_editor');")),
  sql("administrators may restore their own exclusion", "pgtap", rewrite(RESTORE, "if ex.excluded_by = v_me then", "if false then")),
  sql("administrators may restore their own submission", "pgtap", rewrite(RESTORE, "if private.exclusion_involves(v_me, ex.release_id, ex.cascade) then", "if false then")),
  // Restoring only what the exclusion preserved
  sql("restoring reactivates every recorded copy", "pgtap", rewrite(RESTORE, RESTORED_COPIES, "")),
  sql("restoring moves relinked copies back", "pgtap", rewrite(RESTORE, RESTORED_COPIES, "") + rewrite(RESTORE, "set record_status = 'active', invalidated_at = null", "set record_status = 'active', invalidated_at = null, release_id = ex.release_id")),
  sql("restoring ignores a later preservation", "pgtap", rewrite(RESTORE, " and c.invalidated_at = ex.excluded_at\n", "\n")),
  sql("restoring ignores records changed since", "pgtap", rewrite(BLOCKER, "    return 'exclusion changed';", "    null;")),
  sql("restoring ignores the publication rules", "pgtap", rewrite(BLOCKER, "    return 'restore blocked';", "    null;")),
  // The preview, acknowledgements and the cascade
  sql("the preview's token is ignored", "both", rewrite(EXCLUDE, "if v_plan ->> 'token' is distinct from p_token then", "if false then")),
  sql("the cascade needn't be acknowledged", "pgtap", rewrite(EXCLUDE, "(pg_catalog.jsonb_array_length(v_plan -> 'cascade') > 0 and not coalesce(p_acknowledge_cascade, false))", "false")),
  sql("stranded submissions don't block", "pgtap", rewrite(EXCLUDE, "if pg_catalog.jsonb_array_length(v_plan -> 'blocking') > 0 then", "if false then")),
  sql("a game keeps publication without its last release", "pgtap", rewrite(PLAN, "      v_games := v_games || v_game.id;", "      null;")),
  sql("contained games aren't rechecked", "pgtap", rewrite(PUBLICATION, "  -- Games cataloged through this one, if it's a compilation (D2).\n  if exists (", "  if false and exists (")),
  sql("an unpublished game may keep published releases", "pgtap", rewrite(PUBLICATION, "    -- The reverse: nothing of an unpublished game stays published.\n    raise exception", "    perform 1; --")),
  // What owners read
  sql("anyone reads a preserved copy's release", "both", rewrite(PRESERVED, "    and c.owner_id = (select auth.uid())\n", "\n")),
  sql("the read path returns any of the owner's copies", "pgtap", rewrite(PRESERVED, "join public.releases r on r.id = c.release_id and r.status = 'excluded'", "join public.releases r on r.id = c.release_id") + rewrite(PRESERVED, "    and c.record_status = 'invalid_preserved'\n", "\n")),
  sql("the read path names the submitter", "both", rewrite(PRESERVED_RELEASE, "'media_count', (x.release).media_count, 'packaging', (x.release).packaging,", "'media_count', (x.release).media_count, 'packaging', (x.release).packaging, 'submitted_by', (x.release).submitted_by,")),
  // Locks
  sql("a profile found late is waited for", "api", rewrite(NEW_PROFILES, "for key share nowait;", "for key share;")),
  // Grants
  sql("visitors may exclude", "pgtap", `grant execute on function ${EXCLUDE} to anon;`),
  sql("clients may read exclusion records", "pgtap", "grant usage on schema private to authenticated; grant select on private.catalog_exclusions to authenticated;"),
];

export const suites = { m2: m2Mutations, m3: m3Mutations, m4: m4Mutations, m4b: m4bMutations, m5a: m5aMutations, m5b: m5bMutations, m5c: m5cMutations, m6: m6Mutations, m7a: m7aMutations, m7b1: m7b1Mutations, m7b2a: m7b2aMutations, m7b2b: m7b2bMutations };
