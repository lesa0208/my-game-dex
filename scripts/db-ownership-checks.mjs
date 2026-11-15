/**
 * M8c checks against the running local stack: deterministic races between ownership
 * transfers, recoveries and the staff changes, deletions and refusals that can meet
 * them, plus the direct-API paths pgTAP can't reach (a stale previous-Owner token,
 * Auth Admin API factor removal).
 *
 * Every user has a real aal2 session from local GoTrue. Each race uses database
 * sessions that really overlap, running SQL with that user's own claims: one holds its
 * transaction open, the script confirms the other is waiting on a lock held by the
 * first, then the first commits. After each race exactly one Owner record exists.
 *
 * The Owner needs factors registered 24 hours ago (D13); as postgres the script
 * records them as 25 hours old (scripts/lib/test-owner.mjs). Everything made here is
 * removed after. Refuses to run if the stack already has an Owner.
 *
 * Local only. Prints check names and statuses, never keys, tokens or TOTP secrets.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { addFactor, claimsFor, elevate } from "./lib/mfa-session.mjs";
import { matureFactors, removeTestOwner, requireNoOwner } from "./lib/test-owner.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];
const container = `supabase_db_${projectId}`;
const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

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
requireNoOwner(psql, api);
const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
const asUser = (token) => ({ apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const post = (path, headers, body) => fetch(`${api}${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });

const createdUsers = new Set();
const everyUser = new Set();
/** A verified account with a handle and one or two verified TOTP factors, optionally an admin. */
async function createUser({ factors = 1, admin = false } = {}) {
  const email = `ownership-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await post("/auth/v1/admin/users", service, { email, password, email_confirm: true });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  everyUser.add(user.id);
  response = await post("/auth/v1/token?grant_type=password", { apikey: anonKey, "Content-Type": "application/json" }, { email, password });
  let session = await elevate(api, anonKey, await response.json(), "First factor");
  const firstFactor = session.factorId;
  if (factors > 1) session = await addFactor(api, anonKey, session, "Second factor");
  const handle = `oc_${randomBytes(6).toString("hex")}`;
  response = await post("/rest/v1/rpc/claim_handle", asUser(session.access_token), { p_handle: handle });
  if (!response.ok) throw new Error(`could not claim a handle: status ${response.status}`);
  if (admin) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', 'admin') on conflict do nothing;`);
  return { id: user.id, handle, session, firstFactor };
}

/** Calls a function through the API with the user's own token. Never throws on a refusal. */
async function rpc(token, fn, args) {
  const response = await post(`/rest/v1/rpc/${fn}`, asUser(token), args);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body, message: body?.message };
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
          const out = this.out.slice(outStart, at).trim();
          resolve({ out, last: out.split("\n").pop(), err: this.err.slice(errStart).trim() });
        } else if (Date.now() - started > 60000) {
          clearInterval(poll);
          reject(new Error(`${this.name} didn't finish: ${sql.slice(0, 60)}`));
        }
      }, 20);
    });
  }
  /** Opens a transaction and runs a statement in it as the user, with their real claims. */
  asUser(user, statement) {
    return this.run(`begin;\nselect set_config('request.jwt.claims', '${claimsFor(user.id)}', true) is null;\nset local role authenticated;\n${statement}`);
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
/** A JSONB result as text: changed, unchanged or 'refused: <code>' (A4); or the error. */
function outcome(result) {
  const error = errorOf(result);
  if (error) return `error: ${error}`;
  try {
    const body = JSON.parse(result.last);
    return body.ok ? body.result : `refused: ${body.refusal}`;
  } catch {
    return `unreadable: ${result.last}`;
  }
}
const bodyOutcome = (result) => (result.ok ? (result.body?.ok ? result.body.result : `refused: ${result.body?.refusal}`) : `error: ${result.message}`);

const ownerOf = () => psql("select coalesce((select user_id::text from private.platform_owner), 'none');");
const ownerRows = () => psql("select count(*) from private.platform_owner;");
const oneOwner = (user) => ownerOf() === user.id && ownerRows() === "1";
const pendingTransfer = () => psql("select coalesce((select id::text from private.ownership_transfers where status = 'pending'), '');");
const transferOf = (id) => psql(`select status || coalesce('/' || cancel_cause, '') from private.ownership_transfers where id = '${id}';`);
const isAdmin = (user) => psql(`select exists (select 1 from public.staff_roles where user_id = '${user.id}' and role = 'admin');`) === "t";
/** Makes `user` the Owner afresh, with no transfer or recovery pending. */
function resetOwner(user) {
  removeTestOwner(psql);
  psql(`select private.assign_initial_owner('${user.handle}', 'Ownership checks: test owner');`);
  matureFactors(psql, user.id);
}
const start = (to) => `select public.start_ownership_transfer('${to.id}', 'Ownership checks');`;
const accept = (id) => `select public.accept_ownership_transfer('${id}');`;
/** Starts a transfer from the Owner to `to`, committed, and returns its id. */
async function offered(from, to) {
  const result = await rpc(from.session.access_token, "start_ownership_transfer", { p_to: to.id, p_reason: "Ownership checks" });
  if (bodyOutcome(result) !== "changed") throw new Error(`setup transfer failed: ${bodyOutcome(result)}`);
  return result.body.transfer_id;
}

const a = new Session("oc_a");
const b = new Session("oc_b");
try {
  const owner = await createUser({ factors: 2 });
  const target = await createUser({ factors: 2, admin: true });
  const other = await createUser({ factors: 2, admin: true });
  const collector = await createUser();
  resetOwner(owner);
  check("setup: a test Owner with two mature factors", oneOwner(owner) && psql(`select private.mature_totp_factor_count('${owner.id}');`) === "2");

  // -------------------------------------------------------------------------
  section("1. Two transfers started at once");
  {
    const first = await a.asUser(owner, start(target));
    const racing = b.asUser(owner, start(other));
    check("the second start waits for the first", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    const second = await racing;
    await b.run("commit;");
    check("the first is offered", outcome(first) === "changed", outcome(first));
    check("then the second is refused: one transfer at a time", !deadlocked(second) && outcome(second) === "refused: transfer_pending", outcome(second));
    check("exactly one transfer is pending, to the first target", psql("select count(*) || '/' || min(to_user::text) from private.ownership_transfers where status = 'pending';") === `1/${target.id}`);
    check("and the Owner is unchanged", oneOwner(owner));
  }

  // -------------------------------------------------------------------------
  section("2. An acceptance and a cancellation");
  {
    let id = pendingTransfer();
    await a.asUser(owner, `select public.cancel_ownership_transfer('${id}', 'Changed my mind');`);
    let racing = b.asUser(target, accept(id));
    check("an acceptance during an uncommitted cancellation waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    let late = await racing;
    await b.run("rollback;");
    check("then finds the transfer gone", !deadlocked(late) && outcome(late) === "error: transfer unavailable", outcome(late));
    check("the transfer is cancelled and the Owner unchanged", transferOf(id) === "cancelled/owner" && oneOwner(owner));

    id = await offered(owner, target);
    const accepted = await a.asUser(target, accept(id));
    racing = b.asUser(owner, `select public.cancel_ownership_transfer('${id}', 'Too late');`);
    check("a cancellation during an uncommitted acceptance waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    late = await racing;
    await b.run("commit;");
    check("the acceptance completes", outcome(accepted) === "changed", outcome(accepted));
    check("then the cancellation changes nothing", !deadlocked(late) && outcome(late) === "unchanged", outcome(late));
    check("the target is the only Owner, and the transfer accepted", oneOwner(target) && transferOf(id) === "accepted");
    check("the previous Owner is still an admin (voluntary transfer)", isAdmin(owner));
  }

  // -------------------------------------------------------------------------
  section("3. An acceptance and the target's admin role being revoked");
  {
    resetOwner(owner);
    let id = await offered(owner, target);
    await a.asUser(owner, `select public.revoke_staff_role('${target.id}', 'admin', 'Ownership checks');`);
    let racing = b.asUser(target, accept(id));
    check("an acceptance during an uncommitted revocation waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    let late = await racing;
    await b.run("rollback;");
    check("then is refused: the target is no longer an admin", !deadlocked(late) && outcome(late) === "error: not permitted", outcome(late));
    check("the revocation cancelled the transfer, and the Owner is unchanged", transferOf(id) === "cancelled/target_role_revoked" && oneOwner(owner));
    psql(`insert into public.staff_roles (user_id, role) values ('${target.id}', 'admin');`);

    id = await offered(owner, target);
    await a.asUser(target, accept(id));
    racing = b.asUser(owner, `select public.revoke_staff_role('${target.id}', 'admin', 'Ownership checks');`);
    check("a revocation during an uncommitted acceptance waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    late = await racing;
    await b.run("commit;");
    check("then is refused: the target is now the protected Owner", !deadlocked(late) && outcome(late) === "refused: owner_protected", outcome(late));
    check("the target is the only Owner, still an admin", oneOwner(target) && isAdmin(target));
  }

  // -------------------------------------------------------------------------
  section("4. An acceptance and the target's suspension");
  {
    resetOwner(owner);
    let id = await offered(owner, target);
    await a.asUser(owner, `select public.set_account_status('${target.id}', 'suspended', 'Ownership checks');`);
    let racing = b.asUser(target, accept(id));
    check("an acceptance during an uncommitted suspension waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    let late = await racing;
    await b.run("rollback;");
    check("then is refused: the target is suspended", !deadlocked(late) && outcome(late) === "error: not permitted", outcome(late));
    check("the suspension cancelled the transfer, and the Owner is unchanged", transferOf(id) === "cancelled/target_suspended" && oneOwner(owner));
    psql(`update public.profiles set account_status = 'active' where id = '${target.id}';`);

    id = await offered(owner, target);
    await a.asUser(target, accept(id));
    racing = b.asUser(owner, `select public.set_account_status('${target.id}', 'suspended', 'Ownership checks');`);
    check("a suspension during an uncommitted acceptance waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    late = await racing;
    await b.run("commit;");
    check("then is refused: the target is now the protected Owner", !deadlocked(late) && outcome(late) === "refused: owner_protected", outcome(late));
    check("the target is the only Owner, and active", oneOwner(target) && psql(`select account_status from public.profiles where id = '${target.id}';`) === "active");
  }

  // -------------------------------------------------------------------------
  section("5. An acceptance and the target's account deletion");
  {
    resetOwner(owner);
    const doomed = await createUser({ factors: 2, admin: true });
    let id = await offered(owner, doomed);
    await a.run(`begin; delete from auth.users where id = '${doomed.id}';`);
    let racing = b.asUser(doomed, accept(id));
    check("an acceptance during an uncommitted deletion of the target waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    let late = await racing;
    await b.run("rollback;");
    check("then finds the transfer gone", !deadlocked(late) && outcome(late) === "error: transfer unavailable", outcome(late));
    check("the deletion cancelled the transfer, and the Owner is unchanged", transferOf(id) === "cancelled/account_deleted" && oneOwner(owner));
    createdUsers.delete(doomed.id);

    const keeper = await createUser({ factors: 2, admin: true });
    id = await offered(owner, keeper);
    await a.asUser(keeper, accept(id));
    racing = b.run(`begin; delete from auth.users where id = '${keeper.id}';`);
    check("a deletion of the target during an uncommitted acceptance waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    late = await racing;
    await b.run("rollback;");
    check("then is refused: the account is now the Owner's", !deadlocked(late) && errorOf(late) === "account protected", late.err);
    check("the target is the only Owner, and intact", oneOwner(keeper) && psql(`select count(*) from public.profiles where id = '${keeper.id}';`) === "1");
  }

  // -------------------------------------------------------------------------
  section("6. Authority checked live: a stale previous-Owner session, factors, freshness");
  {
    resetOwner(owner);
    const id = await offered(owner, target);
    await a.asUser(target, accept(id));
    const racing = b.asUser(owner, `select public.grant_staff_role('${collector.id}', 'admin', 'Ownership checks');`);
    check("a previous-Owner action during an uncommitted acceptance waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    const late = await racing;
    await b.run("commit;");
    check("then is refused: they are no longer the Owner", !deadlocked(late) && outcome(late) === "refused: owner_only", outcome(late));
    const stale = await rpc(owner.session.access_token, "start_ownership_transfer", { p_to: other.id, p_reason: "Stale session" });
    check("the previous Owner's unexpired token gains nothing over the API", bodyOutcome(stale) === "refused: owner_only", bodyOutcome(stale));
    check("and nothing was granted", !isAdmin(collector) && oneOwner(target));

    resetOwner(owner);
    const transfer = await offered(owner, other);
    const removed = await fetch(`${api}/auth/v1/admin/users/${other.id}/factors/${other.firstFactor}`, { method: "DELETE", headers: service });
    check("setup: the Admin API removes one of the target's factors", removed.ok, `status ${removed.status}`);
    let result = await rpc(other.session.access_token, "accept_ownership_transfer", { p_transfer: transfer });
    check("then the target can't accept: two verified factors are checked live", bodyOutcome(result) === "refused: target_ineligible", bodyOutcome(result));
    other.session = await addFactor(api, anonKey, other.session, "Replacement factor");
    other.firstFactor = other.session.factorId;
    psql(`update auth.mfa_amr_claims set updated_at = now() - interval '11 minutes' where session_id = '${JSON.parse(claimsFor(other.id)).session_id}';`);
    result = await rpc(other.session.access_token, "accept_ownership_transfer", { p_transfer: transfer });
    check("with a verification 11 minutes old, the target must reauthenticate", result.status === 400 && result.message === "reauthentication required", `${result.status} ${result.message}`);
    psql(`update auth.mfa_amr_claims set updated_at = now() where session_id = '${JSON.parse(claimsFor(other.id)).session_id}';`);
    result = await rpc(other.session.access_token, "accept_ownership_transfer", { p_transfer: transfer });
    check("with a recent one, and a replacement factor, they accept", bodyOutcome(result) === "changed" && oneOwner(other), bodyOutcome(result));
  }

  // -------------------------------------------------------------------------
  section("7. Recoveries meet transfers");
  {
    resetOwner(owner);
    await a.asUser(owner, start(target));
    const opening = b.run(`begin; select private.begin_owner_recovery('reassign', '${other.handle}', 'Ownership checks R1');`);
    check("opening a recovery during an uncommitted transfer start waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    const opened = await opening;
    await b.run("commit;");
    const recovery = opened.last;
    check("then opens, with no deadlock", !deadlocked(opened) && /^[0-9a-f-]{36}$/.test(recovery), opened.err);
    check("and cancels the transfer that had just started", psql("select status || '/' || cancel_cause from private.ownership_transfers;") === "cancelled/recovery_started");
    let result = await rpc(owner.session.access_token, "start_ownership_transfer", { p_to: target.id, p_reason: "During recovery" });
    check("no transfer starts while the recovery is pending", bodyOutcome(result) === "refused: recovery_pending", bodyOutcome(result));
    result = await rpc(other.session.access_token, "confirm_owner_recovery", { p_recovery: recovery });
    check("the recovery's target confirms it over the API", bodyOutcome(result) === "changed", bodyOutcome(result));

    psql(`update private.owner_recoveries set created_at = now() - interval '73 hours', hold_until = now() - interval '1 hour' where id = '${recovery}';`);
    const cancelled = await a.asUser(owner, `select public.cancel_owner_recovery('${recovery}', 'I am here');`);
    const completing = b.run(`begin; select private.complete_owner_recovery('${recovery}', 'Ownership checks R1');`);
    check("completing a recovery during the Owner's uncommitted cancellation waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    let late = await completing;
    await b.run("rollback;");
    check("the Owner's cancellation completes", outcome(cancelled) === "changed", outcome(cancelled));
    check("then the completion is refused", !deadlocked(late) && errorOf(late) === "recovery not pending", late.err);
    check("and the Owner is unchanged", oneOwner(owner));

    const second = psql(`select private.begin_owner_recovery('reassign', '${other.handle}', 'Ownership checks R2');`);
    result = await rpc(other.session.access_token, "confirm_owner_recovery", { p_recovery: second });
    psql(`update private.owner_recoveries set created_at = now() - interval '73 hours', hold_until = now() - interval '1 hour' where id = '${second}';`);
    const completed = await a.run(`begin; select private.complete_owner_recovery('${second}', 'Ownership checks R2');`);
    const cancelling = b.asUser(owner, `select public.cancel_owner_recovery('${second}', 'Too late');`);
    check("the Owner's cancellation during an uncommitted completion waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    late = await cancelling;
    await b.run("rollback;");
    check("the completion moves ownership", !errorOf(completed) && oneOwner(other), completed.err);
    check("then the cancellation is refused: its caller lost the admin role with the ownership (D6c)", !deadlocked(late) && outcome(late) === "error: not permitted", outcome(late));
    check("the previous Owner is no longer an admin", !isAdmin(owner));
    psql(`insert into public.staff_roles (user_id, role) values ('${owner.id}', 'admin');`);
  }

  // -------------------------------------------------------------------------
  section("8. Concurrent refusals are recorded once (D9 rate limit)");
  {
    resetOwner(owner);
    const statement = `select public.grant_staff_role('${collector.id}', 'admin', 'Ownership checks');`;
    const before = psql(`select count(*) from private.audit_events where actor_id = '${target.id}' and metadata ->> 'code' = 'owner_only';`);
    const first = await a.asUser(target, statement);
    const racing = b.asUser(target, statement);
    check("an identical refusal during an uncommitted one waits for it", await waitingOn("oc_b", "oc_a"));
    await a.run("commit;");
    const second = await racing;
    await b.run("commit;");
    check("both are refused", outcome(first) === "refused: owner_only" && outcome(second) === "refused: owner_only", `${outcome(first)} ${outcome(second)}`);
    check("the second isn't recorded: its audit_id is null", JSON.parse(second.last).audit_id === null && JSON.parse(first.last).audit_id !== null);
    check("exactly one refusal row was committed", Number(psql(`select count(*) from private.audit_events where actor_id = '${target.id}' and metadata ->> 'code' = 'owner_only';`)) === Number(before) + 1);
    check("and nothing was granted", !isAdmin(collector));
  }

  // -------------------------------------------------------------------------
  section("9. The direct API: errors stay generic, refusals are committed");
  {
    let result = await rpc(collector.session.access_token, "start_ownership_transfer", { p_to: target.id, p_reason: "x" });
    check("a collector is refused with the generic message, unaudited", result.status === 403 && result.message === "not permitted", `${result.status} ${result.message}`);
    result = await rpc(target.session.access_token, "start_ownership_transfer", { p_to: other.id, p_reason: "x" });
    const audit = result.body?.audit_id;
    check("an admin's refusal is a 200 with the JSONB refusal", result.status === 200 && bodyOutcome(result) === "refused: owner_only", bodyOutcome(result));
    check("and its audit row is committed, though the request ended in a refusal", typeof audit === "string" && psql(`select outcome from private.audit_events where id = '${audit}';`) === "refused");
    result = await rpc(owner.session.access_token, "set_owner_successor", { p_successor: target.id, p_reason: "Named successor" });
    check("the Owner names a successor over the API", bodyOutcome(result) === "changed" && psql("select successor_id from private.platform_owner;") === target.id, bodyOutcome(result));
    result = await rpc(owner.session.access_token, "register_succession_document", { p_fingerprint: randomBytes(32).toString("hex"), p_reason: "Signed document" });
    check("and registers the succession document", bodyOutcome(result) === "changed", bodyOutcome(result));
    const anon = await post("/rest/v1/rpc/accept_ownership_transfer", { apikey: anonKey, "Content-Type": "application/json" }, { p_transfer: randomUUID() });
    check("anon has no EXECUTE on the transfer functions", anon.status === 401 || anon.status === 403 || anon.status === 404, `status ${anon.status}`);
  }
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  for (const session of [a, b]) session.close();
  await pause(200);
  psql("select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name in ('oc_a', 'oc_b');");
  removeTestOwner(psql);
  const ids = [...everyUser].map((id) => `'${id}'`).join(",") || "null";
  let deletions = 0;
  for (const id of createdUsers) {
    const response = await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
    if (response.ok || response.status === 404) deletions += 1;
  }
  check("every test account is removed", deletions === createdUsers.size, `${deletions} of ${createdUsers.size}`);
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'oc\\_%';");
  check("no Owner, transfer, recovery, registration, account or audit row is left behind",
    psql(`select (select count(*) from private.platform_owner) + (select count(*) from private.owner_recoveries) + (select count(*) from private.ownership_transfers)
      + (select count(*) from private.mfa_factor_registrations where user_id in (${ids})) + (select count(*) from auth.users where id in (${ids}))
      + (select count(*) from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids}));`) === "0");
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
