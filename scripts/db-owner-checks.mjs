/**
 * M8a checks against the running local stack: the Owner's protection on the paths
 * pgTAP can't reach (the Auth Admin API's hard delete, soft delete, ban and factor
 * removal, and the server's account deletion), and deterministic races between
 * assigning the Owner and a second assignment or an account deletion. Each race uses
 * database sessions that really overlap: one holds its transaction open, the script
 * confirms the other is waiting on a lock, then the first commits.
 *
 * Every account, file and record made here is removed after. The Owner record is
 * permanent by design, so the cleanup removes the test Owner the way only a database
 * owner can: disabling the record's guard inside one transaction. The script refuses
 * to run if the local stack already has an Owner.
 *
 * Local only. Prints check names and statuses, never keys, tokens or TOTP secrets.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AvatarError, deleteAccountWithAvatars } from "../src/features/avatars/avatar-workflow.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];
const container = `supabase_db_${projectId}`;
const psqlArgs = ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"];
const psql = (sql) => execFileSync("docker", psqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
/** Runs SQL as postgres and returns its error message, or "" if it succeeded. */
function psqlError(sql) {
  try {
    psql(sql);
    return "";
  } catch (error) {
    return /ERROR:\s+([^\n]+)/.exec(String(error.stderr ?? ""))?.[1] ?? "failed";
  }
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` (${detail})` : ""}`);
}
const section = (title) => console.log(`\n${title}`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const status = JSON.parse(execFileSync(process.execPath, [cli, "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const api = status.API_URL;
const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
const serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
if (!api || !anonKey || !serviceKey) {
  console.error("Couldn't read the local stack's status. Is it running? Try npm run db:start.");
  process.exit(1);
}
if (psql("select count(*) from private.platform_owner;") !== "0") {
  console.error("This local stack already has an Owner. These checks assign and remove a test Owner, so they need a stack without one.");
  process.exit(1);
}
const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
const asUser = (token) => ({ apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const avatarConfig = { supabaseUrl: api, publishableKey: anonKey, secretKey: serviceKey };

/** The current TOTP code for a base32 secret (RFC 6238, SHA-1, 30 s, 6 digits). */
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "")) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, "0");
}
async function auth(path, { token, body, method = "POST" } = {}) {
  const response = await fetch(`${api}/auth/v1${path}`, { method, headers: token ? asUser(token) : { apikey: anonKey, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
/** Enrolls and verifies one TOTP factor; returns the factor id and the new session. */
async function addFactor(session, name) {
  const enrolled = await auth("/factors", { token: session.access_token, body: { factor_type: "totp", friendly_name: name } });
  if (enrolled.status !== 200) throw new Error(`could not enroll a factor: status ${enrolled.status}`);
  const challenge = await auth(`/factors/${enrolled.body.id}/challenge`, { token: session.access_token, body: {} });
  const verified = await auth(`/factors/${enrolled.body.id}/verify`, { token: session.access_token, body: { challenge_id: challenge.body.id, code: totp(enrolled.body.totp.secret) } });
  if (verified.status !== 200) throw new Error(`could not verify a factor: status ${verified.status}`);
  return { factorId: enrolled.body.id, session: verified.body };
}

const createdUsers = new Set();
const everyUser = new Set();
/** A verified account with a handle, and optionally two verified TOTP factors. */
async function createUser({ factors = 0 } = {}) {
  const email = `owner-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await fetch(`${api}/auth/v1/admin/users`, { method: "POST", headers: service, body: JSON.stringify({ email, password, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  everyUser.add(user.id);
  let session = (await auth("/token?grant_type=password", { body: { email, password } })).body;
  const handle = `ow_${randomBytes(6).toString("hex")}`;
  response = await fetch(`${api}/rest/v1/rpc/claim_handle`, { method: "POST", headers: asUser(session.access_token), body: JSON.stringify({ p_handle: handle }) });
  if (response.status !== 200) throw new Error(`could not claim a handle: status ${response.status}`);
  const factorIds = [];
  for (let i = 0; i < factors; i += 1) {
    const added = await addFactor(session, `factor ${i + 1}`);
    factorIds.push(added.factorId);
    session = added.session;
  }
  return { id: user.id, handle, factorIds };
}

/** A database session that runs statements one at a time and reports each one's outcome. */
class Session {
  constructor(name) {
    this.name = name;
    this.out = "";
    this.err = "";
    this.serial = 0;
    this.child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=0"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk) => (this.out += chunk.toString()));
    this.child.stderr.on("data", (chunk) => (this.err += chunk.toString()));
    this.child.stdin.write(`set application_name = '${name}';\n`);
  }
  run(sql) {
    this.serial += 1;
    const marker = `__done_${this.name}_${this.serial}__`;
    const errStart = this.err.length;
    const outStart = this.out.length;
    this.child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const at = this.out.indexOf(marker, outStart);
        if (at !== -1) {
          clearInterval(poll);
          resolve({ out: this.out.slice(outStart, at).trim(), err: this.err.slice(errStart).trim() });
        } else if (Date.now() - started > 60000) {
          clearInterval(poll);
          reject(new Error(`${this.name} didn't finish: ${sql.slice(0, 60)}`));
        }
      }, 20);
    });
  }
  close() {
    this.child.stdin.end();
  }
}
/** Whether session `waiter` is waiting on a lock that only session `holder` holds. */
async function waitingOn(waiter, holder) {
  for (let i = 0; i < 100; i += 1) {
    const blocked = psql(`select coalesce((select pg_blocking_pids(w.pid) = array[h.pid] from pg_stat_activity w, pg_stat_activity h
      where w.application_name = '${waiter}' and w.wait_event_type = 'Lock' and h.application_name = '${holder}'), false);`);
    if (blocked === "t") return true;
    await pause(50);
  }
  return false;
}
const errorOf = (result) => /ERROR:\s+([^\n]+)/.exec(result?.err ?? "")?.[1] ?? "";
const deadlocked = (result) => /deadlock/i.test(result?.err ?? "");

const owner = () => psql("select coalesce((select user_id::text from private.platform_owner), 'none');");
const designated = (id) => psql(`select private.is_designated_owner('${id}');`) === "t";
const findings = () => psql("select coalesce(string_agg(finding, '; ' order by finding), '') from private.owner_integrity();");
const exists = (id) => psql(`select (select count(*) from auth.users where id = '${id}') || '/' || (select count(*) from public.profiles where id = '${id}');`);
const assignSql = (handle) => `select private.assign_initial_owner('${handle}', 'Test owner, removed after the checks');`;
async function storageObjects(prefix) {
  const response = await fetch(`${api}/storage/v1/object/list/avatars`, { method: "POST", headers: service, body: JSON.stringify({ prefix: `${prefix}/`, limit: 100 }) });
  return response.ok ? (await response.json()).length : -1;
}

/** Removes the test Owner record: the guard refuses it, so it is disabled for this one transaction. */
function removeTestOwner() {
  psql(`begin;
alter table private.platform_owner disable trigger platform_owner_guard;
delete from private.platform_owner;
alter table private.platform_owner enable trigger platform_owner_guard;
commit;`);
}
async function cleanup() {
  removeTestOwner();
  const ids = [...everyUser].map((id) => `'${id}'`).join(",") || "null";
  psql(`delete from private.owner_recoveries where owner_id in (${ids}) or target_id in (${ids});
delete from private.ownership_transfers where from_user in (${ids}) or to_user in (${ids});`);
  let deletions = 0;
  for (const id of createdUsers) {
    await fetch(`${api}/storage/v1/object/avatars`, { method: "DELETE", headers: service, body: JSON.stringify({ prefixes: [`${id}/avatar.webp`] }) });
    const response = await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
    if (response.ok || response.status === 404) deletions += 1;
  }
  check("every test account is removed", deletions === createdUsers.size, `${deletions} of ${createdUsers.size}`);
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ow\\_%';");
  check("no Owner, transfer, recovery, account or audit row is left behind",
    psql(`select (select count(*) from private.platform_owner) + (select count(*) from private.owner_recoveries) + (select count(*) from private.ownership_transfers)
      + (select count(*) from auth.users where id in (${ids})) + (select count(*) from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids}));`) === "0");
}

const a = new Session("own_a");
const b = new Session("own_b");
try {
  // -------------------------------------------------------------------------
  section("1. Two assignments at once: one wins, the other is refused");
  {
    const first = await createUser({ factors: 2 });
    const second = await createUser({ factors: 2 });
    await a.run(`begin; ${assignSql(first.handle)}`);
    const racing = b.run(`begin; ${assignSql(second.handle)}`);
    check("the second assignment waits for the first", await waitingOn("own_b", "own_a"));
    await a.run("commit;");
    const lost = await racing;
    await b.run("rollback;");
    check("then is refused, with no deadlock", !deadlocked(lost) && errorOf(lost) === "an owner is already assigned", lost.err);
    check("exactly one Owner exists, the first", owner() === first.id && psql("select count(*) from private.platform_owner;") === "1");
    removeTestOwner();
  }

  // -------------------------------------------------------------------------
  section("2. An assignment and the candidate's account deletion");
  {
    const candidate = await createUser({ factors: 2 });
    await a.run(`begin; ${assignSql(candidate.handle)}`);
    const deleting = b.run(`begin; delete from auth.users where id = '${candidate.id}';`);
    check("a deletion during the assignment waits for it", await waitingOn("own_b", "own_a"));
    await a.run("commit;");
    const refused = await deleting;
    await b.run("rollback;");
    check("then is refused: the account is now the Owner's", !deadlocked(refused) && errorOf(refused) === "account protected", refused.err);
    check("and the account is intact", exists(candidate.id) === "1/1" && designated(candidate.id));
    removeTestOwner();

    const doomed = await createUser({ factors: 2 });
    await b.run(`begin; delete from auth.users where id = '${doomed.id}';`);
    const assigning = a.run(`begin; ${assignSql(doomed.handle)}`);
    check("the other way round, the assignment waits for the deletion", await waitingOn("own_a", "own_b"));
    await b.run("commit;");
    const late = await assigning;
    await a.run("rollback;");
    check("then is refused: the account is gone", !deadlocked(late) && errorOf(late) === "account not eligible: missing", late.err);
    check("and no Owner exists", owner() === "none");
    createdUsers.delete(doomed.id);
  }

  // -------------------------------------------------------------------------
  section("3. The Owner and the Auth Admin API");
  const theOwner = await createUser({ factors: 2 });
  psql(assignSql(theOwner.handle));
  check("a test Owner is assigned", owner() === theOwner.id);
  const upload = await fetch(`${api}/storage/v1/object/avatars/${theOwner.id}/avatar.webp`, { method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "image/webp" }, body: randomBytes(64) });
  check("with an avatar file", upload.ok && (await storageObjects(theOwner.id)) === 1, `status ${upload.status}`);
  {
    const hard = await fetch(`${api}/auth/v1/admin/users/${theOwner.id}`, { method: "DELETE", headers: service });
    check("the Admin API's hard delete is refused", hard.status >= 500, `status ${hard.status}`);
    check("and nothing is deleted: user, profile, identities and the Owner record",
      exists(theOwner.id) === "1/1" && psql(`select count(*) from auth.identities where user_id = '${theOwner.id}';`) === "1" && owner() === theOwner.id);

    let code = "";
    try {
      await deleteAccountWithAvatars(avatarConfig, theOwner.id);
    } catch (error) {
      code = error instanceof AvatarError ? error.code : "unexpected";
    }
    check("the server's account deletion refuses the Owner", code === "account_protected", code);
    check("before touching storage: the avatar file is kept", (await storageObjects(theOwner.id)) === 1);

    const ban = await fetch(`${api}/auth/v1/admin/users/${theOwner.id}`, { method: "PUT", headers: service, body: JSON.stringify({ ban_duration: "876000h" }) });
    check("the Admin API can ban the Owner (infrastructure level, not blockable here)", ban.ok, `status ${ban.status}`);
    check("a banned Owner is still the designated Owner, and still protected", designated(theOwner.id) && psqlError(`delete from public.profiles where id = '${theOwner.id}';`) === "account protected");
    check("and the integrity report names it", findings().includes("owner account: banned"), findings());
    await fetch(`${api}/auth/v1/admin/users/${theOwner.id}`, { method: "PUT", headers: service, body: JSON.stringify({ ban_duration: "none" }) });

    const removed = await fetch(`${api}/auth/v1/admin/users/${theOwner.id}/factors/${theOwner.factorIds[0]}`, { method: "DELETE", headers: service });
    check("the Admin API can remove one of the Owner's factors", removed.ok, `status ${removed.status}`);
    check("the Owner is still designated and protected with one factor (A1)", designated(theOwner.id) && psqlError(`delete from auth.users where id = '${theOwner.id}';`) === "account protected");
    check("and the report says one factor", findings().includes("owner has 1 verified TOTP factors"), findings());

    const soft = await fetch(`${api}/auth/v1/admin/users/${theOwner.id}`, { method: "DELETE", headers: service, body: JSON.stringify({ should_soft_delete: true }) });
    check("the Admin API's soft delete isn't blockable here", soft.ok, `status ${soft.status}`);
    check("a soft-deleted Owner is still the designated Owner, and still protected", designated(theOwner.id) && exists(theOwner.id) === "1/1" && psqlError(`delete from auth.users where id = '${theOwner.id}';`) === "account protected");
    check("and the report names it", findings().includes("owner account: deleted"), findings());
  }

  // -------------------------------------------------------------------------
  section("4. Anyone else's account is deleted as before");
  {
    const other = await createUser();
    await fetch(`${api}/storage/v1/object/avatars/${other.id}/avatar.webp`, { method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "image/webp" }, body: randomBytes(64) });
    await deleteAccountWithAvatars(avatarConfig, other.id);
    check("the server's account deletion removes another account and its files", exists(other.id) === "0/0" && (await storageObjects(other.id)) === 0);
    createdUsers.delete(other.id);
  }
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  for (const session of [a, b]) session.close();
  await pause(200);
  psql(`select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name in ('own_a', 'own_b');`);
  await cleanup();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
