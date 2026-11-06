/**
 * M3 Authorization checks against the running local stack, through the real API, with
 * transactions held open in a separate session to force each race deterministically.
 * pgTAP covers the rules; this covers what clients and concurrent requests can do.
 *
 * Local only. Prints check names and statuses, never keys or tokens.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
  for (let attempt = 0; ; attempt += 1) {
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

const asUserSql = (id) => `select set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);\nset local role authenticated;`;

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
async function createUser({ approval = false, claim = true } = {}) {
  const email = `authz-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await post("/auth/v1/admin/users", service, { email, password, email_confirm: true });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  response = await post("/auth/v1/token?grant_type=password", anon, { email, password });
  const session = await response.json();
  const handle = `az_${randomBytes(6).toString("hex")}`;
  if (claim) {
    response = await post("/rest/v1/rpc/claim_handle", asUser(session.access_token), { p_handle: handle });
    if (!response.ok) throw new Error(`could not claim a handle: status ${response.status}`);
  }
  if (approval) psql(`update public.profiles set follow_approval_required = true where id = '${user.id}';`);
  return { id: user.id, handle, token: session.access_token, headers: asUser(session.access_token) };
}

/** Calls a function as a user. Never throws on a refusal. */
async function call(user, fn, args) {
  const response = await post(`/rest/v1/rpc/${fn}`, user.headers ?? user, args);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body, message: body?.message };
}
const follow = (user, target) => call(user, "request_follow", { p_target: target.id });
const accept = (owner, requester) => call(owner, "accept_follow_request", { p_requester: requester.id });
const reject = (owner, requester) => call(owner, "reject_follow_request", { p_requester: requester.id });
const cancel = (user, target) => call(user, "cancel_follow_request", { p_target: target.id });
const block = (user, target) => call(user, "block_user", { p_target: target.id });
const unblock = (user, target) => call(user, "unblock_user", { p_target: target.id });
const state = (user, target) => call(user, "get_follow_state", { p_target: target.id });
const rowStatus = (from, to) => psql(`select coalesce((select status::text from public.follows where follower_id = '${from.id}' and followee_id = '${to.id}'), 'none');`);
const rowCount = (a, b) => psql(`select count(*) from public.follows where (follower_id = '${a.id}' and followee_id = '${b.id}') or (follower_id = '${b.id}' and followee_id = '${a.id}');`);
const refused = (response) => response.status === 401 || response.status === 403 || response.status === 404;

/**
 * True only when the database refused for lack of a privilege on exactly this object.
 * A refusal from somewhere else, such as a function's own checks or a trigger, doesn't
 * count, because it would hide a grant that shouldn't exist.
 */
async function deniedByPrivilege(response, kind, name) {
  if (response.ok) return false;
  const text = typeof response.text === "function" ? await response.text() : JSON.stringify(response.body ?? "");
  let message = "";
  try {
    message = JSON.parse(text)?.message ?? "";
  } catch {
    message = text;
  }
  return new RegExp(`^permission denied for ${kind} ${name}$`).test(message);
}

async function permissions() {
  section("Direct table access");
  const user = await createUser();
  const other = await createUser();
  for (const table of ["follows", "blocked_users"]) {
    const key = table === "follows" ? "follower_id" : "blocker_id";
    for (const [label, headers] of [["anon", anon], ["a signed-in user", user.headers], ["service_role", service]]) {
      let response = await fetch(`${api}/rest/v1/${table}?select=${key}`, { headers });
      check(`${label} has no SELECT on ${table}`, await deniedByPrivilege(response, "table", table), `status ${response.status}`);
      response = await post(`/rest/v1/${table}`, { ...headers, Prefer: "return=minimal" }, table === "follows" ? { follower_id: user.id, followee_id: other.id, status: "accepted", accepted_at: new Date().toISOString() } : { blocker_id: user.id, blocked_id: other.id });
      check(`${label} has no INSERT on ${table}`, await deniedByPrivilege(response, "table", table), `status ${response.status}`);
      response = await fetch(`${api}/rest/v1/${table}?${key}=eq.${user.id}`, { method: "PATCH", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify({ created_at: new Date().toISOString() }) });
      check(`${label} has no UPDATE on ${table}`, await deniedByPrivilege(response, "table", table), `status ${response.status}`);
      response = await fetch(`${api}/rest/v1/${table}?${key}=eq.${user.id}`, { method: "DELETE", headers: { ...headers, Prefer: "return=minimal" } });
      check(`${label} has no DELETE on ${table}`, await deniedByPrivilege(response, "table", table), `status ${response.status}`);
    }
  }
  check("those attempts wrote nothing", rowCount(user, other) === "0" && psql(`select count(*) from public.blocked_users where blocker_id = '${user.id}';`) === "0");

  section("Function access for each role");
  const target = { p_target: other.id };
  const paged = { p_profile: other.id };
  const functions = [
    ["request_follow", target], ["cancel_follow_request", target], ["unfollow", target],
    ["accept_follow_request", { p_requester: other.id }], ["reject_follow_request", { p_requester: other.id }], ["remove_follower", { p_follower: other.id }],
    ["block_user", target], ["unblock_user", target], ["get_follow_state", target],
    ["get_followers", paged], ["get_following", paged], ["get_profile_counts", paged],
    ["get_received_follow_requests", {}], ["get_sent_follow_requests", {}], ["get_my_blocks", {}],
  ];
  for (const [name, args] of functions) {
    const asAnon = await call(anon, name, args);
    check(`anon has no EXECUTE on ${name}`, await deniedByPrivilege(asAnon, "function", name), `status ${asAnon.status}, ${asAnon.message}`);
    const asService = await call(service, name, args);
    check(`service_role has no EXECUTE on ${name}`, await deniedByPrivilege(asService, "function", name), `status ${asService.status}, ${asService.message}`);
  }
  check("those calls changed nothing", rowCount(user, other) === "0");

  section("Internal helpers");
  for (const name of ["is_blocked_between", "can_view_level", "can_view_collection", "can_view_connections", "block_peers", "lock_follow_pair"]) {
    const response = await call(user, name, {});
    check(`${name} isn't an API function`, !response.ok, `status ${response.status}`);
  }

  section("Actor spoofing and forged tokens");
  let response = await call(user, "request_follow", { p_target: other.id, p_actor: other.id });
  check("a function won't take an actor argument", !response.ok, `status ${response.status}`);
  response = await call(user, "request_follow", { p_target: other.id, follower_id: other.id, p_follower: other.id });
  check("nor a follower argument", !response.ok, `status ${response.status}`);
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { sub: other.id, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 };
  const payload = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  const forged = `${payload}.${createHmac("sha256", randomBytes(32)).update(payload).digest("base64url")}`;
  const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
  for (const [label, token] of [["a token signed with the wrong key", forged], ["an unsigned token", unsigned]]) {
    response = await call(asUser(token), "request_follow", { p_target: user.id });
    check(`${label} can't act as another user`, response.status === 401, `status ${response.status}`);
  }
  check("no follow was created in the other user's name", rowCount(user, other) === "0");
}

async function stateMachine() {
  section("State machine through the API");
  const owner = await createUser({ approval: true });
  const publicOwner = await createUser();
  const requester = await createUser();
  const stranger = await createUser();

  let response = await follow(requester, publicOwner);
  check("following a public account is immediate", response.body === "following", String(response.body));
  response = await follow(requester, owner);
  check("requesting a private account returns requested", response.body === "requested", String(response.body));
  check("the private account's approval setting isn't readable", refused(await fetch(`${api}/rest/v1/profiles?id=eq.${owner.id}&select=follow_approval_required`, { headers: stranger.headers })));

  response = await accept(stranger, requester);
  check("another user can't accept a request meant for the owner", !response.ok && rowStatus(requester, owner) === "pending", `status ${response.status}`);
  response = await accept(requester, requester);
  check("a requester can't accept their own request", !response.ok && rowStatus(requester, owner) === "pending", `status ${response.status}`);

  const queue = await call(owner, "get_received_follow_requests", {});
  check("the owner's queue shows the request", queue.ok && queue.body.length === 1 && queue.body[0].id === requester.id);
  check("the queue returns only card fields", queue.ok && Object.keys(queue.body[0]).sort().join() === "avatar_path,display_name,handle,id,requested_at");
  const strangerQueue = await call(stranger, "get_received_follow_requests", {});
  check("another user's queue doesn't show it", strangerQueue.ok && strangerQueue.body.length === 0);

  const before = await call(requester, "get_sent_follow_requests", {});
  const stateBefore = await state(requester, owner);
  response = await reject(owner, requester);
  check("the owner rejects", response.ok, `status ${response.status}`);
  const after = await call(requester, "get_sent_follow_requests", {});
  const stateAfter = await state(requester, owner);
  check("rejection is silent in the state", stateBefore.body === "requested" && stateAfter.body === "requested", String(stateAfter.body));
  check("rejection is silent in the sent list", JSON.stringify(before.body) === JSON.stringify(after.body));

  const cooldown = () => psql(`select rerequest_after from public.follows where follower_id = '${requester.id}' and followee_id = '${owner.id}';`);
  const firstCooldown = cooldown();
  for (let attempt = 0; attempt < 5; attempt += 1) await follow(requester, owner);
  check("retries are idempotent", rowStatus(requester, owner) === "rejected");
  check("retries don't change the cooldown", cooldown() === firstCooldown);
  check("retries create no history", rowCount(requester, owner) === "1");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await cancel(requester, owner);
    response = await follow(requester, owner);
  }
  check("cancelling and retrying can't bypass the cooldown", response.body === "requested" && rowStatus(requester, owner) === "rejected");
  check("that doesn't change the cooldown either", cooldown() === firstCooldown);
  const queueAfter = await call(owner, "get_received_follow_requests", {});
  check("none of it reaches the owner", queueAfter.body.length === 0);
  check("the database holds one row for the pair", rowCount(requester, owner) === "1");

  section("Blocks through the API");
  const blocker = await createUser();
  const blocked = await createUser();
  await follow(blocked, blocker);
  await follow(blocker, blocked);
  check("setup: mutual follows", rowCount(blocker, blocked) === "2");
  response = await block(blocker, blocked);
  check("a block removes both directions", response.ok && rowCount(blocker, blocked) === "0", `status ${response.status}`);

  response = await follow(blocked, blocker);
  const unknown = await call(blocked, "request_follow", { p_target: randomUUID() });
  check("a blocked follow gets the same answer as an unknown user", !response.ok && response.status === unknown.status && response.message === unknown.message, `${response.message}/${unknown.message}`);
  const cardsAsBlocked = await fetch(`${api}/rest/v1/profiles?id=eq.${blocker.id}&select=id,handle`, { headers: blocked.headers });
  check("the blocked user can't read the card when signed in", cardsAsBlocked.ok && (await cardsAsBlocked.json()).length === 0);
  const cardsAsBlocker = await fetch(`${api}/rest/v1/profiles?id=eq.${blocked.id}&select=id,handle`, { headers: blocker.headers });
  check("nor can the blocker", cardsAsBlocker.ok && (await cardsAsBlocker.json()).length === 0);
  const cardsAnon = await fetch(`${api}/rest/v1/profiles?id=eq.${blocker.id}&select=id,handle`, { headers: anon });
  check("a signed-out visitor still can", cardsAnon.ok && (await cardsAnon.json()).length === 1);
  const listed = await call(blocked, "get_followers", { p_profile: blocker.id });
  check("the blocked user can't list followers", listed.ok && listed.body.length === 0);
  const counts = await call(blocked, "get_profile_counts", { p_profile: blocker.id });
  check("the blocked user gets no counts", counts.ok && counts.body.length === 0);
  const blocks = await call(blocked, "get_my_blocks", {});
  check("the blocked user sees no block", blocks.ok && blocks.body.length === 0);
  const blocksOwn = await call(blocker, "get_my_blocks", {});
  check("the blocker can list it, in order to unblock", blocksOwn.ok && blocksOwn.body[0]?.id === blocked.id);

  response = await unblock(blocked, blocker);
  check("the blocked user can't lift the block", psql(`select count(*) from public.blocked_users where blocker_id = '${blocker.id}';`) === "1");
  response = await unblock(blocker, blocked);
  check("unblocking restores no follow", response.ok && rowCount(blocker, blocked) === "0");
  response = await follow(blocked, blocker);
  check("a new request after an unblock is a fresh one", response.body === "following" && rowCount(blocker, blocked) === "1", String(response.body));

  section("Lists and counts through the API");
  const account = await createUser();
  const hiddenFollower = await createUser({ approval: true });
  const visibleFollower = await createUser();
  const viewer = await createUser();
  psql(`update public.profiles set follow_approval_required = false where id = '${hiddenFollower.id}';`);
  await follow(hiddenFollower, account);
  await follow(visibleFollower, account);
  psql(`update public.profiles set follow_approval_required = true where id = '${hiddenFollower.id}';`);
  const list = await call(viewer, "get_followers", { p_profile: account.id });
  const count = await call(viewer, "get_profile_counts", { p_profile: account.id });
  check("a third party's list hides a private follower", list.ok && list.body.length === 1 && list.body[0].id === visibleFollower.id);
  check("and the count matches the list", Number(count.body?.[0]?.followers) === 1, JSON.stringify(count.body));
  const own = await call(account, "get_profile_counts", { p_profile: account.id });
  check("the owner sees the exact total", Number(own.body?.[0]?.followers) === 2);
  response = await call(viewer, "get_followers", { p_profile: account.id, p_limit: 101 });
  check("101 rows per page is refused", !response.ok && response.status === 400, `status ${response.status}`);
  const anonList = await call(anon, "get_followers", { p_profile: account.id });
  check("anon can't list", !anonList.ok, `status ${anonList.status}`);

  const privateAccount = await createUser({ approval: true });
  const privateFollower = await createUser();
  await follow(privateFollower, privateAccount);
  await accept(privateAccount, privateFollower);
  const pendingFollower = await createUser();
  await follow(pendingFollower, privateAccount);
  for (const [label, who] of [["a stranger", viewer], ["a pending follower", pendingFollower]]) {
    const hidden = await call(who, "get_followers", { p_profile: privateAccount.id });
    check(`${label} gets an empty follower list for a private account`, hidden.ok && hidden.body.length === 0, JSON.stringify(hidden.body));
    const hiddenFollowing = await call(who, "get_following", { p_profile: privateAccount.id });
    check(`${label} gets an empty following list for a private account`, hiddenFollowing.ok && hiddenFollowing.body.length === 0, JSON.stringify(hiddenFollowing.body));
    const hiddenCounts = await call(who, "get_profile_counts", { p_profile: privateAccount.id });
    check(`${label} gets no counts for a private account`, hiddenCounts.ok && hiddenCounts.body.length === 0, JSON.stringify(hiddenCounts.body));
  }
  const permitted = await call(privateFollower, "get_followers", { p_profile: privateAccount.id });
  check("an accepted follower can list a private account", permitted.ok && permitted.body.length === 1 && permitted.body[0].id === privateFollower.id);
}

async function races() {
  section("Concurrent requests");
  const owner = await createUser({ approval: true });
  const requester = await createUser();
  let results = await Promise.all(Array.from({ length: 6 }, () => follow(requester, owner)));
  check("six identical requests all succeed with one answer", results.every((result) => result.ok && result.body === "requested"), results.map((result) => result.status).join());
  check("and create one row", rowCount(requester, owner) === "1");

  const left = await createUser({ approval: true });
  const right = await createUser({ approval: true });
  results = await Promise.all([follow(left, right), follow(right, left)]);
  check("mutual requests don't deadlock, and create two rows", results.every((result) => result.ok) && rowCount(left, right) === "2", results.map((result) => result.status).join());

  results = await Promise.all(Array.from({ length: 5 }, () => accept(right, left)));
  check("five identical accepts all succeed", results.every((result) => result.ok), results.map((result) => result.status).join());
  check("and one row is accepted", rowStatus(left, right) === "accepted");

  section("Acceptance and cancellation");
  const a1 = await createUser();
  const o1 = await createUser({ approval: true });
  await follow(a1, o1);
  let held = await whileHeld(`${asUserSql(o1.id)}\nselect public.accept_follow_request('${a1.id}');`, () => cancel(a1, o1));
  check("a cancel during an uncommitted accept waits for it", held.waited > 500, `${held.waited} ms`);
  check("then does nothing, so the follow stands", rowStatus(a1, o1) === "accepted");

  const a2 = await createUser();
  const o2 = await createUser({ approval: true });
  await follow(a2, o2);
  held = await whileHeld(`${asUserSql(a2.id)}\nselect public.cancel_follow_request('${o2.id}');`, () => accept(o2, a2));
  check("an accept during an uncommitted cancel is refused", !held.result.ok && held.result.message === "request unavailable", `${held.result.status}`);
  check("and the request stays cancelled", rowStatus(a2, o2) === "cancelled");

  section("Block against request");
  const a3 = await createUser();
  const o3 = await createUser();
  held = await whileHeld(`${asUserSql(o3.id)}\nselect public.block_user('${a3.id}');`, () => follow(a3, o3));
  check("a follow during an uncommitted block is refused", !held.result.ok && held.result.message === "user unavailable", `${held.result.status}`);
  check("and leaves no row", rowCount(a3, o3) === "0");

  const a4 = await createUser();
  const o4 = await createUser();
  held = await whileHeld(`${asUserSql(a4.id)}\nselect public.request_follow('${o4.id}');`, () => block(o4, a4));
  check("a block during an uncommitted follow waits for it", held.waited > 500, `${held.waited} ms`);
  check("then removes it", held.result.ok && rowCount(a4, o4) === "0");

  section("Block against acceptance");
  const a5 = await createUser();
  const o5 = await createUser({ approval: true });
  await follow(a5, o5);
  held = await whileHeld(`${asUserSql(o5.id)}\nselect public.accept_follow_request('${a5.id}');`, () => block(a5, o5));
  check("a block during an uncommitted accept removes the follow", held.result.ok && rowCount(a5, o5) === "0", `${held.result.status}`);

  const a6 = await createUser();
  const o6 = await createUser({ approval: true });
  await follow(a6, o6);
  held = await whileHeld(`${asUserSql(a6.id)}\nselect public.block_user('${o6.id}');`, () => accept(o6, a6));
  check("an accept during an uncommitted block is refused", !held.result.ok, `${held.result.status}`);
  check("and leaves no row", rowCount(a6, o6) === "0");

  const a7 = await createUser();
  const o7 = await createUser();
  results = await Promise.all([block(a7, o7), block(o7, a7)]);
  check("two users blocking each other don't deadlock", results.every((result) => result.ok), results.map((result) => result.status).join());
  check("and both blocks exist", psql(`select count(*) from public.blocked_users where (blocker_id = '${a7.id}' and blocked_id = '${o7.id}') or (blocker_id = '${o7.id}' and blocked_id = '${a7.id}');`) === "2");

  section("Unblock followed by a new request");
  const a8 = await createUser();
  const o8 = await createUser();
  await follow(a8, o8);
  await block(o8, a8);
  held = await whileHeld(`${asUserSql(o8.id)}\nselect public.unblock_user('${a8.id}');`, () => follow(a8, o8));
  check("a request during an uncommitted unblock waits, then succeeds", held.result.ok && held.result.body === "following" && held.waited > 500, `${held.result.status}, ${held.waited} ms`);
  check("exactly one fresh row exists", rowCount(a8, o8) === "1");

  section("Account deletion during a request");
  const a9 = await createUser();
  const o9 = await createUser();
  held = await whileHeld(`delete from auth.users where id = '${o9.id}';`, () => follow(a9, o9));
  createdUsers.delete(o9.id);
  check("a request during an uncommitted deletion is refused", !held.result.ok && held.result.message === "user unavailable", `${held.result.status}`);
  check("and leaves no row", psql(`select count(*) from public.follows where follower_id = '${a9.id}';`) === "0");

  const b1 = await createUser();
  const c1 = await createUser();
  held = await whileHeld(`${asUserSql(b1.id)}\nselect public.request_follow('${c1.id}');`, async () => {
    const response = await fetch(`${api}/auth/v1/admin/users/${c1.id}`, { method: "DELETE", headers: service });
    return { ok: response.ok, status: response.status };
  });
  createdUsers.delete(c1.id);
  check("a deletion during an uncommitted request succeeds after it", held.result.ok && held.waited > 500, `${held.result.status}, ${held.waited} ms`);
  check("and removes the row", psql(`select count(*) from public.follows where follower_id = '${b1.id}';`) === "0");

  const b5 = await createUser();
  const c5 = await createUser({ approval: true });
  held = await whileHeld(`delete from auth.users where id = '${b5.id}';`, () => follow(b5, c5));
  createdUsers.delete(b5.id);
  check("a request while the requester's own deletion is uncommitted is refused", !held.result.ok && held.result.message === "user unavailable", `${held.result.status}, ${held.result.message}`);
  check("and leaves no row", psql(`select count(*) from public.follows where followee_id = '${c5.id}';`) === "0");

  section("Follow-approval changes during a request");
  const b2 = await createUser();
  const c2 = await createUser();
  held = await whileHeld(`update public.profiles set follow_approval_required = true where id = '${c2.id}';`, () => follow(b2, c2));
  check("a request during an uncommitted change to private waits, then needs approval", held.result.body === "requested" && held.waited > 500, `${held.result.body}, ${held.waited} ms`);
  check("so it's pending, not accepted", rowStatus(b2, c2) === "pending");

  const b3 = await createUser();
  const c3 = await createUser({ approval: true });
  held = await whileHeld(`update public.profiles set follow_approval_required = false where id = '${c3.id}';`, () => follow(b3, c3));
  check("a request during an uncommitted change to public follows immediately", held.result.body === "following", String(held.result.body));

  const b4 = await createUser();
  const c4 = await createUser({ approval: true });
  await follow(b4, c4);
  await whileHeld(`update public.profiles set follow_approval_required = false where id = '${c4.id}';`, () => follow(b4, c4));
  check("disabling approval during a repeat request leaves it pending", rowStatus(b4, c4) === "pending");

  section("Request limit under concurrency");
  const capped = await createUser();
  const targets = await Promise.all(Array.from({ length: 4 }, () => createUser({ approval: true })));
  psql(`
    create temp table seed as select gen_random_uuid() as id, g from generate_series(1, 199) g;
    insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
      select id, 'authenticated', 'authenticated', 'seed' || g || '-' || id || '@example.test', now(), '00000000-0000-0000-0000-000000000000' from seed;
    insert into public.follows (follower_id, followee_id, status) select '${capped.id}', id, 'pending' from seed;
  `);
  results = await Promise.all(targets.map((target) => follow(capped, target)));
  check("four concurrent requests at 199 outstanding: exactly one succeeds", results.filter((result) => result.ok).length === 1, results.map((result) => result.status).join());
  check("the others hit the limit", results.filter((result) => !result.ok).every((result) => result.message === "too many outstanding follow requests"));
  check("the database never exceeds 200", psql(`select count(*) from public.follows where follower_id = '${capped.id}' and status in ('pending', 'rejected');`) === "200");
}

async function cleanup() {
  psql("delete from auth.users where email like 'seed%@example.test';");
  for (const id of createdUsers) {
    await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
  }
  psql("delete from private.handle_holds where kind = 'released' and handle like 'az\\_%';");
}

try {
  await permissions();
  await stateMachine();
  await races();
} catch (error) {
  failed += 1;
  console.error(`FAIL authorization checks stopped early: ${error.message}`);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
