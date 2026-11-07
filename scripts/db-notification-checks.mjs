/**
 * M4b Notifications checks against the running local stack, through the real API, with
 * transactions held open in a separate session to force each race deterministically.
 * pgTAP covers the rules; this covers what clients, Auth and concurrent requests can do.
 *
 * Local only. Prints check names and statuses, never keys or tokens.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];
const psqlArgs = ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"];

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` (${detail})` : ""}`);
}
const section = (title) => console.log(`\n${title}`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const psql = (sql) => execFileSync("docker", psqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

/**
 * Runs a transaction that stays open while `during` acts, and only continues once the
 * transaction has really reached its pause, so these races are deterministic.
 */
async function whileHeld(setupSql, during) {
  const marker = `hold_${randomBytes(6).toString("hex")}`;
  const session = new Promise((resolve, reject) => {
    const child = spawn("docker", psqlArgs, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.resume();
    child.stderr.resume();
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`held session exited with ${code}`))));
    child.stdin.end(`begin;\n${setupSql}\nselect pg_sleep(2) /* ${marker} */;\ncommit;`);
  });
  // If the held statement fails, report that instead of crashing on an unhandled rejection.
  let sessionError = null;
  session.catch((error) => {
    sessionError = error;
  });
  for (let attempt = 0; ; attempt += 1) {
    if (sessionError) throw new Error(`the held transaction failed before its pause: ${sessionError.message}`);
    const active = psql(`select count(*) from pg_stat_activity where pid <> pg_backend_pid() and query like '%${marker}%' and wait_event = 'PgSleep';`);
    if (active !== "0") break;
    if (attempt > 100) throw new Error("the held session never reached its pause");
    await pause(50);
  }
  const started = Date.now();
  const result = await during();
  const waited = Date.now() - started;
  await session;
  return { result, waited };
}
/**
 * An account deletion that locks the profile, pauses while `during` starts, then
 * deletes, which is the order Postgres uses. Reports failures rather than throwing, so
 * a deadlock on either side fails a named check.
 */
async function deletionAround(user, during) {
  const marker = `hold_${randomBytes(6).toString("hex")}`;
  const session = new Promise((resolve) => {
    const child = spawn("docker", psqlArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let errors = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("close", (code) => resolve({ ok: code === 0, errors }));
    child.stdin.end(`begin;
select 1 from public.profiles where id = '${user.id}' for update;
select pg_sleep(1.5) /* ${marker} */;
delete from auth.users where id = '${user.id}';
commit;`);
  });
  for (let attempt = 0; ; attempt += 1) {
    const active = psql(`select count(*) from pg_stat_activity where pid <> pg_backend_pid() and query like '%${marker}%' and wait_event = 'PgSleep';`);
    if (active !== "0") break;
    if (attempt > 100) throw new Error("the deleting session never reached its pause");
    await pause(50);
  }
  const [result, deletion] = await Promise.all([during(), session]);
  createdUsers.delete(user.id);
  return { result, deletion };
}
const asUserSql = (user) => `select set_config('request.jwt.claims', '{"sub":"${user.id}","role":"authenticated"}', true);\nset local role authenticated;`;

const status = JSON.parse(execFileSync(process.execPath, [cli, "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const api = status.API_URL;
const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
const serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
if (!api || !anonKey || !serviceKey) {
  console.error("Couldn't read the local stack's status. Is it running? Try npm run db:start.");
  process.exit(1);
}

const anon = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" };
const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
const asUser = (token) => ({ apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const post = (path, headers, body) => fetch(`${api}${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });

const createdUsers = new Set();
async function createUser() {
  const email = `notify-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await post("/auth/v1/admin/users", service, { email, password, email_confirm: true });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  response = await post("/auth/v1/token?grant_type=password", anon, { email, password });
  const session = await response.json();
  const handle = `nt_${randomBytes(6).toString("hex")}`;
  response = await post("/rest/v1/rpc/claim_handle", asUser(session.access_token), { p_handle: handle });
  if (!response.ok) throw new Error(`could not claim a handle: status ${response.status}`);
  return { id: user.id, handle, headers: asUser(session.access_token) };
}

/** Calls a function. Never throws on a refusal. */
async function call(who, fn, args) {
  const response = await post(`/rest/v1/rpc/${fn}`, who.headers ?? who, args);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body, message: body?.message };
}
const deniedByPrivilege = (result, name) => !result.ok && result.message === `permission denied for function ${name}`;
const refusedWith = (result, message) => !result.ok && result.message === message;

/** The documented operator procedure for the first administrator. */
function makeFirstAdmin(user) {
  psql(`begin;
select private.record_operator_action('${user.id}', 'Notification checks: first administrator', '{"role": "admin"}');
insert into public.staff_roles (user_id, role) values ('${user.id}', 'admin');
commit;`);
}
const setStatus = (actor, user, value, reason = "Notification checks") => call(actor, "set_account_status", { p_user: user.id, p_status: value, p_reason: reason });

const followState = (from, to) =>
  psql(`select coalesce((select status::text from public.follows where follower_id = '${from.id}' and followee_id = '${to.id}'), 'none');`);
const stored = (recipient, actor = null, type = null) =>
  Number(psql(`select count(*) from public.notifications where recipient_id = '${recipient.id}'${actor ? ` and actor_id = '${actor.id}'` : ""}${type ? ` and type = '${type}'` : ""};`));
const between = (one, other) =>
  Number(psql(`select count(*) from public.notifications where (recipient_id = '${one.id}' and actor_id = '${other.id}') or (recipient_id = '${other.id}' and actor_id = '${one.id}');`));
const storedAbout = (id) => Number(psql(`select count(*) from public.notifications where recipient_id = '${id}' or actor_id = '${id}';`));
async function list(who) {
  const result = await call(who, "get_my_notifications", { p_limit: 100 });
  return Array.isArray(result.body) ? result.body : [];
}
const unread = async (who) => (await call(who, "get_unread_notification_count", {})).body;
const patchOwn = (user, table, column, body) =>
  fetch(`${api}/rest/v1/${table}?${column}=eq.${user.id}`, { method: "PATCH", headers: { ...user.headers, Prefer: "return=minimal" }, body: JSON.stringify(body) });
const makePrivate = (user) => patchOwn(user, "profiles", "id", { follow_approval_required: true });
const setPreferences = (user, settings) => patchOwn(user, "user_preferences", "user_id", { notification_settings: settings });
async function deleteAccount(user) {
  const response = await fetch(`${api}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: service });
  if (response.ok) createdUsers.delete(user.id);
  return { ok: response.ok, status: response.status };
}
async function privateAccount() {
  const user = await createUser();
  await makePrivate(user);
  return user;
}

const functions = [
  ["get_my_notifications", {}],
  ["get_unread_notification_count", {}],
  ["mark_notifications_read", {}],
  ["delete_notification", { p_id: randomUUID() }],
];

async function permissions() {
  section("Permissions");
  const user = await createUser();
  for (const [name, args] of functions) {
    check(`anon has no EXECUTE on ${name}`, deniedByPrivilege(await call(anon, name, args), name));
    check(`service_role has no EXECUTE on ${name}`, deniedByPrivilege(await call(service, name, args), name));
    check(`a signed-in user can call ${name}`, (await call(user, name, args)).ok);
  }
  for (const [label, headers] of [["anon", anon], ["a signed-in user", user.headers], ["service_role", service]]) {
    const read = await fetch(`${api}/rest/v1/notifications?select=id`, { headers });
    check(`${label} can't read the notifications table`, !read.ok, `status ${read.status}`);
    const write = await fetch(`${api}/rest/v1/notifications`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ recipient_id: user.id, type: "moderation", data: { status: "active" } }),
    });
    check(`${label} can't write to it`, !write.ok, `status ${write.status}`);
  }
}

async function flow() {
  section("Follows of a public account");
  const owner = await createUser();
  const fan = await createUser();
  const stranger = await createUser();
  check("following returns following", (await call(fan, "request_follow", { p_target: owner.id })).body === "following");
  let rows = await list(owner);
  check(
    "the account sees one unread follow notice with the follower's card",
    rows.length === 1 && rows[0].type === "follow" && rows[0].actor_id === fan.id && rows[0].actor_handle === fan.handle && rows[0].read_at === null,
  );
  check("and an unread count of 1", (await unread(owner)) === 1);
  await call(fan, "unfollow", { p_target: owner.id });
  await call(fan, "request_follow", { p_target: owner.id });
  check("following again within 24 hours sends nothing new", stored(owner, fan, "follow") === 1);
  check("another user sees none of it", (await list(stranger)).length === 0);
  check("and can't delete it", (await call(stranger, "delete_notification", { p_id: rows[0].id })).ok && stored(owner) === 1);
  check("marking read reports one change", (await call(owner, "mark_notifications_read", { p_up_to: rows[0].id })).body === 1);
  check("and clears the count", (await unread(owner)) === 0);
  check("the owner deletes it", (await call(owner, "delete_notification", { p_id: rows[0].id })).ok && stored(owner) === 0);

  section("Requests to a private account");
  const host = await privateAccount();
  const asker = await createUser();
  check("a request returns requested", (await call(asker, "request_follow", { p_target: host.id })).body === "requested");
  check("the account sees the request notice", (await list(host)).some((row) => row.type === "follow_request" && row.actor_id === asker.id));
  await call(asker, "cancel_follow_request", { p_target: host.id });
  check("cancelling withdraws it", stored(host, asker) === 0);
  await call(asker, "request_follow", { p_target: host.id });
  check("accepting succeeds", (await call(host, "accept_follow_request", { p_requester: asker.id })).ok);
  check("and withdraws the request notice", stored(host, asker, "follow_request") === 0);
  check("and tells the requester", (await list(asker)).some((row) => row.type === "follow_accepted" && row.actor_id === host.id));
  const rejected = await createUser();
  await call(rejected, "request_follow", { p_target: host.id });
  await call(host, "reject_follow_request", { p_requester: rejected.id });
  for (let i = 0; i < 3; i += 1) await call(rejected, "request_follow", { p_target: host.id });
  check("retries during a cooldown notify nobody", stored(host, rejected) === 0 && followState(rejected, host) === "rejected");

  section("Preferences");
  let response = await setPreferences(owner, { follow: false });
  check("a user turns follow notices off", response.ok, `status ${response.status}`);
  await call(stranger, "request_follow", { p_target: owner.id });
  check("then a new follower stores nothing", stored(owner, stranger) === 0);
  response = await setPreferences(owner, { follow: "no" });
  check("an invalid preference is refused", !response.ok, `status ${response.status}`);
  response = await setPreferences(owner, { moderation: false });
  check("moderation notices can't be turned off", !response.ok, `status ${response.status}`);
  await setPreferences(owner, {});

  section("Moderation notices");
  const admin = await createUser();
  makeFirstAdmin(admin);
  const member = await createUser();
  let result = await setStatus(admin, member, "suspended", "Notification checks: internal note ZQX");
  check("an admin suspends an account", result.body === true, result.message);
  rows = await list(member);
  check(
    "the suspended account sees a notice holding only the new status",
    rows.length === 1 && rows[0].type === "moderation" && rows[0].actor_id === null && JSON.stringify(rows[0].data) === '{"status":"suspended"}',
  );
  check("the staff reason appears nowhere in it", !JSON.stringify(rows).includes("ZQX"));
  check("the suspended account can mark it read", (await call(member, "mark_notifications_read", {})).body === 1);
  await setStatus(admin, member, "active");
  check("reinstatement notifies too", (await list(member)).some((row) => row.type === "moderation" && row.data.status === "active"));

  section("Visibility and blocks");
  const watcher = await createUser();
  await call(member, "request_follow", { p_target: watcher.id });
  check("a follow from an active account shows", (await list(watcher)).length === 1);
  await setStatus(admin, member, "suspended");
  check("and is hidden while its actor is suspended", (await list(watcher)).length === 0 && (await unread(watcher)) === 0);
  await setStatus(admin, member, "active");
  check("and shows again on reinstatement", (await list(watcher)).length === 1);
  await call(watcher, "request_follow", { p_target: member.id });
  check("the pair now has notices both ways", between(member, watcher) === 2);
  await call(watcher, "block_user", { p_target: member.id });
  check("a block removes them both ways", between(member, watcher) === 0);
  await call(watcher, "unblock_user", { p_target: member.id });
  check("unblocking restores nothing", between(member, watcher) === 0);

  section("Account deletion");
  const leaving = await createUser();
  const kept = await privateAccount();
  await call(leaving, "request_follow", { p_target: kept.id });
  await call(kept, "request_follow", { p_target: leaving.id });
  check("the leaving account has a pending request and a notice", stored(kept, leaving, "follow_request") === 1 && stored(leaving, kept) === 1);
  const deleted = await deleteAccount(leaving);
  check("Auth deletes the account", deleted.ok, `status ${deleted.status}`);
  check("and every notice it sent or received is gone", storedAbout(leaving.id) === 0 && stored(kept) === 0);
}

async function races() {
  section("Races");
  let held;
  let host;
  let asker;

  // Accept against the requester's account deletion, in both orders. Without the M4b
  // lock order, the first of these deadlocks and the deletion fails.
  host = await privateAccount();
  asker = await createUser();
  await call(asker, "request_follow", { p_target: host.id });
  held = await whileHeld(`${asUserSql(host)}\nselect public.accept_follow_request('${asker.id}');`, () => deleteAccount(asker));
  check("a deletion during an uncommitted accept waits for it", held.waited > 500, `${held.waited} ms`);
  check("then deletes the account", held.result.ok, `status ${held.result.status}`);
  check("leaving no notice behind", storedAbout(asker.id) === 0);

  host = await privateAccount();
  asker = await createUser();
  await call(asker, "request_follow", { p_target: host.id });
  held = await whileHeld(`delete from auth.users where id = '${asker.id}';`, () => call(host, "accept_follow_request", { p_requester: asker.id }));
  createdUsers.delete(asker.id);
  check("an accept during an uncommitted deletion waits for it", held.waited > 500, `${held.waited} ms`);
  check("then finds no request", refusedWith(held.result, "request unavailable"), held.result.message);
  check("and stores nothing", stored(host) === 0 && storedAbout(asker.id) === 0);

  // The deadlock itself: a deletion that has locked the profile and is about to delete,
  // while the accept is already running. The accept must wait before locking the follow.
  host = await privateAccount();
  asker = await createUser();
  await call(asker, "request_follow", { p_target: host.id });
  let raced = await deletionAround(asker, () => call(host, "accept_follow_request", { p_requester: asker.id }));
  check("an accept racing a deletion mid-way doesn't deadlock", !/deadlock/i.test(`${raced.deletion.errors} ${raced.result.message}`), raced.deletion.errors.trim() || raced.result.message);
  check("the deletion completes", raced.deletion.ok, raced.deletion.errors.trim());
  check("and the accept finds no request", refusedWith(raced.result, "request unavailable"), raced.result.message);

  host = await privateAccount();
  asker = await createUser();
  await call(asker, "request_follow", { p_target: host.id });
  await call(asker, "cancel_follow_request", { p_target: host.id });
  raced = await deletionAround(asker, () => call(asker, "request_follow", { p_target: host.id }));
  check("a request racing its own deletion mid-way doesn't deadlock", !/deadlock/i.test(`${raced.deletion.errors} ${raced.result.message}`), raced.deletion.errors.trim() || raced.result.message);
  check("that deletion completes too", raced.deletion.ok && storedAbout(asker.id) === 0, raced.deletion.errors.trim());

  // A request against the requester's own deletion, through the cancelled -> pending path.
  host = await privateAccount();
  asker = await createUser();
  await call(asker, "request_follow", { p_target: host.id });
  await call(asker, "cancel_follow_request", { p_target: host.id });
  held = await whileHeld(`${asUserSql(asker)}\nselect public.request_follow('${host.id}');`, () => deleteAccount(asker));
  check("a deletion during the user's own uncommitted request waits for it", held.waited > 500, `${held.waited} ms`);
  check("then deletes the account and its notice", held.result.ok && storedAbout(asker.id) === 0, `status ${held.result.status}`);

  // Accept against cancel, in both orders.
  host = await privateAccount();
  asker = await createUser();
  await call(asker, "request_follow", { p_target: host.id });
  held = await whileHeld(`${asUserSql(asker)}\nselect public.cancel_follow_request('${host.id}');`, () => call(host, "accept_follow_request", { p_requester: asker.id }));
  check("an accept during an uncommitted cancel waits for it", held.waited > 500, `${held.waited} ms`);
  check("then finds no request", refusedWith(held.result, "request unavailable"), held.result.message);
  check("and nobody is notified", between(host, asker) === 0);
  await call(asker, "request_follow", { p_target: host.id });
  held = await whileHeld(`${asUserSql(host)}\nselect public.accept_follow_request('${asker.id}');`, () => call(asker, "cancel_follow_request", { p_target: host.id }));
  check("a cancel during an uncommitted accept waits, then changes nothing", held.waited > 500 && followState(asker, host) === "accepted", `${held.waited} ms`);
  check("leaving exactly the acceptance notice", stored(asker, host, "follow_accepted") === 1 && stored(host, asker) === 0);

  // Block against a request, in both orders: no notice survives the block.
  host = await privateAccount();
  asker = await createUser();
  held = await whileHeld(`${asUserSql(host)}\nselect public.block_user('${asker.id}');`, () => call(asker, "request_follow", { p_target: host.id }));
  check("a request during an uncommitted block waits, then is refused", held.waited > 500 && refusedWith(held.result, "user unavailable"), held.result.message);
  check("and stores nothing", between(host, asker) === 0);
  await call(host, "unblock_user", { p_target: asker.id });
  held = await whileHeld(`${asUserSql(asker)}\nselect public.request_follow('${host.id}');`, () => call(host, "block_user", { p_target: asker.id }));
  check("a block during an uncommitted request waits for it", held.waited > 500 && held.result.ok, `${held.waited} ms`);
  check("then removes its notice", between(host, asker) === 0);

  // Follow, unfollow, follow while the first follow is uncommitted: still one notice.
  const owner = await createUser();
  const fan = await createUser();
  held = await whileHeld(`${asUserSql(fan)}\nselect public.request_follow('${owner.id}');`, async () => {
    await call(fan, "unfollow", { p_target: owner.id });
    return call(fan, "request_follow", { p_target: owner.id });
  });
  check("toggling during an uncommitted follow waits for it", held.waited > 500, `${held.waited} ms`);
  check("and the 24-hour rule still leaves one notice", stored(owner, fan, "follow") === 1);

  // Mark all read against a notice still being created, and against a block removing notices.
  const other = await createUser();
  held = await whileHeld(`${asUserSql(other)}\nselect public.request_follow('${owner.id}');`, () => call(owner, "mark_notifications_read", {}));
  check("marking read doesn't wait for an uncommitted notice", held.waited < 1000 && held.result.body === 1, `${held.waited} ms, ${held.result.body}`);
  check("which stays unread", (await unread(owner)) === 1);
  held = await whileHeld(`${asUserSql(owner)}\nselect public.block_user('${other.id}');`, () => call(owner, "mark_notifications_read", {}));
  check("marking read doesn't wait for notices a block is removing", held.waited < 1000 && held.result.ok, `${held.waited} ms`);
  check("and the block removes them", between(owner, other) === 0);
}

/** Test accounts are deleted through Auth, which is itself a check: see "Account deletion". */
async function cleanup() {
  let failedDeletes = 0;
  for (const id of [...createdUsers]) {
    const response = await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
    if (!response.ok) failedDeletes += 1;
  }
  check("every test account deletes cleanly through Auth", failedDeletes === 0, `${failedDeletes} failed`);
  // Audit rows from the moderation checks. See db-audit-checks.mjs for why this needs
  // the owner to skip the append-only triggers.
  psql(`begin;
set local session_replication_role = replica;
delete from private.audit_events where reason like 'Notification checks%';
commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'nt\\_%';");
}

try {
  await permissions();
  await flow();
  await races();
} catch (error) {
  failed += 1;
  console.error(`FAIL notification checks stopped early: ${error.message}`);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
