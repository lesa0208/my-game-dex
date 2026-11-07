/**
 * M4a Audit checks against the running local stack, through the real API, with
 * transactions held open in a separate session to force each race deterministically.
 * pgTAP covers the rules; this covers what clients and concurrent requests can do.
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
  const email = `audit-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await post("/auth/v1/admin/users", service, { email, password, email_confirm: true });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  response = await post("/auth/v1/token?grant_type=password", anon, { email, password });
  const session = await response.json();
  const handle = `au_${randomBytes(6).toString("hex")}`;
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
select private.record_operator_action('${user.id}', 'Audit checks: first administrator', '{"role": "admin"}');
insert into public.staff_roles (user_id, role) values ('${user.id}', 'admin');
commit;`);
}
const grant = (actor, user, role, reason = "Audit checks") => call(actor, "grant_staff_role", { p_user: user.id, p_role: role, p_reason: reason });
const revoke = (actor, user, role, reason = "Audit checks") => call(actor, "revoke_staff_role", { p_user: user.id, p_role: role, p_reason: reason });
const setStatus = (actor, user, value, reason = "Audit checks") => call(actor, "set_account_status", { p_user: user.id, p_status: value, p_reason: reason });
const accountStatus = (user) => psql(`select account_status from public.profiles where id = '${user.id}';`);
const roles = (user) => psql(`select coalesce(string_agg(role::text, ',' order by role), '') from public.staff_roles where user_id = '${user.id}';`);
const audits = (user) => Number(psql(`select count(*) from private.audit_events where target_profile_id = '${user.id}';`));

const functions = [
  ["grant_staff_role", { p_user: randomUUID(), p_role: "moderator", p_reason: "x" }],
  ["revoke_staff_role", { p_user: randomUUID(), p_role: "moderator", p_reason: "x" }],
  ["set_account_status", { p_user: randomUUID(), p_status: "suspended", p_reason: "x" }],
  ["get_audit_events", {}],
];

async function permissions() {
  section("Permissions");
  const user = await createUser();
  for (const [name, args] of functions) {
    check(`anon has no EXECUTE on ${name}`, deniedByPrivilege(await call(anon, name, args), name));
    check(`service_role has no EXECUTE on ${name}`, deniedByPrivilege(await call(service, name, args), name));
    check(`an ordinary user is refused by ${name}`, refusedWith(await call(user, name, args), "not permitted"));
  }
  for (const [label, headers] of [["anon", anon], ["a signed-in user", user.headers], ["service_role", service]]) {
    const response = await fetch(`${api}/rest/v1/audit_events?select=id`, { headers: { ...headers, "Accept-Profile": "private" } });
    check(`${label} can't reach the audit table through the API`, !response.ok, `status ${response.status}`);
  }
}

async function flow() {
  section("Staff actions through the API");
  const admin = await createUser();
  const moderator = await createUser();
  const member = await createUser();
  const other = await createUser();
  makeFirstAdmin(admin);

  let result = await grant(admin, moderator, "moderator", "Launch moderator");
  check("an admin grants a role", result.ok && result.body === true && roles(moderator) === "moderator", result.message);
  check("the grant is audited", audits(moderator) === 1);
  result = await setStatus(moderator, member, "suspended", "Spam");
  check("a moderator suspends an ordinary account", result.ok && result.body === true && accountStatus(member) === "suspended", result.message);

  section("A suspended user's existing session");
  const before = psql(`select coalesce(display_name, '') from public.profiles where id = '${member.id}';`);
  const patch = await fetch(`${api}/rest/v1/profiles?id=eq.${member.id}`, { method: "PATCH", headers: { ...member.headers, Prefer: "return=minimal" }, body: JSON.stringify({ display_name: "Changed" }) });
  check("can't edit the profile", psql(`select coalesce(display_name, '') from public.profiles where id = '${member.id}';`) === before, `status ${patch.status}`);
  check("can't follow", refusedWith(await call(member, "request_follow", { p_target: other.id }), "account not eligible"));
  check("can't claim another handle", !(await call(member, "claim_handle", { p_handle: `au_${randomBytes(6).toString("hex")}` })).ok);
  check("can still block (D6)", (await call(member, "block_user", { p_target: other.id })).ok);
  check("can still unblock (D6)", (await call(member, "unblock_user", { p_target: other.id })).ok);

  section("Audit log access");
  result = await call(admin, "get_audit_events", { p_limit: 100 });
  const mine = Array.isArray(result.body) ? result.body.filter((row) => [admin.id, moderator.id, member.id].includes(row.target_profile_id)) : [];
  check("an admin reads the log", result.ok && mine.length === 3, result.message);
  check("rows carry the action and reason", mine.some((row) => row.action === "account_suspended" && row.reason === "Spam" && row.actor_id === moderator.id));
  check("a moderator can't read the log", refusedWith(await call(moderator, "get_audit_events", {}), "not permitted"));
  result = await setStatus(moderator, member, "active", "Appeal");
  check("the moderator reinstates the account", result.ok && accountStatus(member) === "active", result.message);
}

async function races() {
  section("Races");
  let held;

  // Two admins revoke each other at once: the second waits, then is no longer an admin.
  const adminA = await createUser();
  const adminB = await createUser();
  makeFirstAdmin(adminA);
  await grant(adminA, adminB, "admin");
  held = await whileHeld(`${asUserSql(adminA)}\nselect public.revoke_staff_role('${adminB.id}', 'admin', 'race');`, () => revoke(adminB, adminA, "admin"));
  check("a revoke during an uncommitted revoke waits for it", held.waited > 500, `${held.waited} ms`);
  check("then finds its caller is no longer an admin", refusedWith(held.result, "not permitted"), held.result.message);
  check("an administrator remains", roles(adminA) === "admin" && roles(adminB) === "");

  // A grant to an account being suspended: the grant waits, then sees the suspension.
  const moderator = await createUser();
  await grant(adminA, moderator, "moderator");
  const target = await createUser();
  held = await whileHeld(`${asUserSql(moderator)}\nselect public.set_account_status('${target.id}', 'suspended', 'race');`, () => grant(adminA, target, "moderator"));
  check("a grant during an uncommitted suspension waits for it", held.waited > 500, `${held.waited} ms`);
  check("then refuses the suspended account", refusedWith(held.result, "user unavailable"), held.result.message);
  check("no role was granted", roles(target) === "");

  // A moderator suspended while acting: the action waits, then the caller is refused.
  const member = await createUser();
  held = await whileHeld(`${asUserSql(adminA)}\nselect public.set_account_status('${moderator.id}', 'suspended', 'race');`, () => setStatus(moderator, member, "suspended"));
  check("an action during the caller's uncommitted suspension waits for it", held.waited > 500, `${held.waited} ms`);
  check("then refuses the suspended caller", refusedWith(held.result, "not permitted"), held.result.message);
  check("and changes nothing", accountStatus(member) === "active");
  await setStatus(adminA, moderator, "active");

  // M3 lock compatibility: a suspension and a follow overlap in both orders without deadlock.
  const publicTarget = await createUser();
  const follower = await createUser();
  held = await whileHeld(`${asUserSql(follower)}\nselect public.request_follow('${publicTarget.id}');`, () => setStatus(moderator, follower, "suspended"));
  check("a suspension during an uncommitted follow waits for it", held.waited > 500, `${held.waited} ms`);
  check("both complete, in order", held.result.ok && accountStatus(follower) === "suspended" && psql(`select status from public.follows where follower_id = '${follower.id}';`) === "accepted", held.result.message);
  check("the suspended user can't follow afterwards", refusedWith(await call(follower, "request_follow", { p_target: member.id }), "account not eligible"));
  await setStatus(moderator, follower, "active");

  const second = await createUser();
  held = await whileHeld(`${asUserSql(moderator)}\nselect public.set_account_status('${second.id}', 'suspended', 'race');`, () => call(second, "request_follow", { p_target: publicTarget.id }));
  check("a follow during an uncommitted suspension of its caller waits for it", held.waited > 500, `${held.waited} ms`);
  check("and finishes as if it came just before the suspension", held.result.ok && accountStatus(second) === "suspended", held.result.message);

  // Access-reducing actions still work for the account being suspended (D6).
  const third = await createUser();
  held = await whileHeld(`${asUserSql(moderator)}\nselect public.set_account_status('${third.id}', 'suspended', 'race');`, () => call(third, "block_user", { p_target: publicTarget.id }));
  check("a block during an uncommitted suspension of its caller completes", held.result.ok, held.result.message);
  check("and the block exists", psql(`select count(*) from public.blocked_users where blocker_id = '${third.id}';`) === "1");
}

/**
 * The log is append-only for every application path, so removing these test rows
 * needs the owner to skip triggers for this session. That is exactly the owner-level
 * limit documented in security-rls.md, used here only to clean up test data.
 */
async function cleanup() {
  for (const id of createdUsers) {
    await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
  }
  if (createdUsers.size) {
    const ids = [...createdUsers].map((id) => `'${id}'`).join(",");
    psql(`begin;
set local session_replication_role = replica;
delete from private.audit_events where target_profile_id in (${ids}) or actor_id in (${ids});
commit;`);
  }
  psql("delete from private.handle_holds where kind = 'released' and handle like 'au\\_%';");
}

try {
  await permissions();
  await flow();
  await races();
} catch (error) {
  failed += 1;
  console.error(`FAIL audit checks stopped early: ${error.message}`);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
