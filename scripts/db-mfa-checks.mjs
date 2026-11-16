/**
 * M8b checks against the running local stack, over the API with real sessions from
 * the local Auth server: staff privileges need a live aal2 session with a verified
 * TOTP factor (D3), on direct RPC calls and on the catalog editors' read policies; a
 * token that still says aal2 after sign-out or factor removal is refused; and
 * registering verified factors (D13) is idempotent, server-timed and safe when two
 * sessions do it at once.
 *
 * Every account and record made here is removed after.
 * Local only. Prints check names and statuses, never keys, tokens or TOTP secrets.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeClaims, elevate, totp } from "./lib/mfa-session.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];
const container = `supabase_db_${projectId}`;
const psqlArgs = ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"];
const psql = (sql) => execFileSync("docker", psqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

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
const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
const asUser = (token) => ({ apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function rpc(token, fn, args = {}) {
  const response = await fetch(`${api}/rest/v1/rpc/${fn}`, { method: "POST", headers: asUser(token), body: JSON.stringify(args) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}
const refused = (r) => r.status === 403 && r.body?.message === "not permitted" && !r.body?.details && !r.body?.hint;
async function auth(path, token, body, method = "POST") {
  const response = await fetch(`${api}/auth/v1${path}`, { method, headers: token ? asUser(token) : { apikey: anonKey, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const createdUsers = new Set();
/** A verified account with a handle and, optionally, a staff role. Returns its password too. */
async function createUser(role = null) {
  const email = `mfa-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const response = await fetch(`${api}/auth/v1/admin/users`, { method: "POST", headers: service, body: JSON.stringify({ email, password, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  const session = (await auth("/token?grant_type=password", null, { email, password })).body;
  const claimed = await rpc(session.access_token, "claim_handle", { p_handle: `mf_${randomBytes(6).toString("hex")}` });
  if (claimed.status !== 200) throw new Error(`could not claim a handle: status ${claimed.status}`);
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { id: user.id, email, password };
}
/** A new password-only (aal1) session. */
const signIn = async (user) => (await auth("/token?grant_type=password", null, { email: user.email, password: user.password })).body;
/** A new session taken to aal2 with an existing factor. */
async function signInAal2(user) {
  const s = await signIn(user);
  const challenge = await auth(`/factors/${user.factorId}/challenge`, s.access_token, {});
  return (await auth(`/factors/${user.factorId}/verify`, s.access_token, { challenge_id: challenge.body.id, code: totp(user.secret) })).body;
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
  /** Runs SQL inside the open transaction with a real session's claims. */
  as(token, sql) {
    const c = decodeClaims(token);
    const claims = JSON.stringify({ sub: c.sub, role: "authenticated", aal: c.aal, session_id: c.session_id });
    return this.run(`select set_config('request.jwt.claims', '${claims}', true); set local role authenticated; ${sql} reset role;`);
  }
  close() {
    this.child.stdin.end();
  }
}
async function waitingOn(waiter, holder) {
  for (let i = 0; i < 100; i += 1) {
    if (psql(`select coalesce((select pg_blocking_pids(w.pid) = array[h.pid] from pg_stat_activity w, pg_stat_activity h
      where w.application_name = '${waiter}' and w.wait_event_type = 'Lock' and h.application_name = '${holder}'), false);`) === "t") return true;
    await pause(50);
  }
  return false;
}

const PREFIX = `Mfa ${randomBytes(3).toString("hex")}`;
const a = new Session("mfa_a");
const b = new Session("mfa_b");
try {
  // -------------------------------------------------------------------------
  section("1. A staff function over the API");
  const admin = await createUser("admin");
  {
    const aal1 = await signIn(admin);
    check("an admin's password-only session is aal1", decodeClaims(aal1.access_token).aal === "aal1");
    check("at aal1, a staff function is refused with the generic message", refused(await rpc(aal1.access_token, "get_audit_events")));
    const elevated = await elevate(api, anonKey, aal1);
    Object.assign(admin, { factorId: elevated.factorId, secret: elevated.totpSecret });
    check("after a TOTP verification, the session is aal2", decodeClaims(elevated.access_token).aal === "aal2");
    check("and the same function works", (await rpc(elevated.access_token, "get_audit_events")).status === 200);
    check("the earlier aal1 token still can't use it", refused(await rpc(aal1.access_token, "get_audit_events")));

    const out = await auth("/logout?scope=local", elevated.access_token, {});
    check("after signing out", out.status === 204, `status ${out.status}`);
    check("the aal2 token, unexpired, is refused", refused(await rpc(elevated.access_token, "get_audit_events")));
  }

  // -------------------------------------------------------------------------
  section("2. Factor removal");
  {
    const s1 = await signInAal2(admin);
    check("a new aal2 session works", (await rpc(s1.access_token, "get_audit_events")).status === 200);
    // Session A ends verified with a spare factor; session B, a separate sign-in, with the first.
    const extra = await auth("/factors", s1.access_token, { factor_type: "totp", friendly_name: "spare" });
    const ch = await auth(`/factors/${extra.body.id}/challenge`, s1.access_token, {});
    const sessionA = (await auth(`/factors/${extra.body.id}/verify`, s1.access_token, { challenge_id: ch.body.id, code: totp(extra.body.totp.secret) })).body;
    await pause(31000 - (Date.now() % 30000));
    const sessionB = await signInAal2(admin);
    check("two separate sessions, verified with different factors", decodeClaims(sessionA.access_token).session_id !== decodeClaims(sessionB.access_token).session_id
      && psql(`select count(distinct factor_id) from auth.sessions where id in ('${decodeClaims(sessionA.access_token).session_id}', '${decodeClaims(sessionB.access_token).session_id}');`) === "2");
    const removed = await auth(`/factors/${admin.factorId}`, sessionA.access_token, null, "DELETE");
    check("the admin removes their first factor", removed.status === 200, `status ${removed.status}`);
    check("a token from the session verified with it, still claiming aal2, is refused", refused(await rpc(sessionB.access_token, "get_audit_events")));
    check("the session verified with the remaining factor keeps working", (await rpc(sessionA.access_token, "get_audit_events")).status === 200);
    Object.assign(admin, { factorId: extra.body.id, secret: extra.body.totp.secret });
    const s3 = await signInAal2(admin);
    check("a new session with the remaining factor works", (await rpc(s3.access_token, "get_audit_events")).status === 200);
    const adminRemoval = await fetch(`${api}/auth/v1/admin/users/${admin.id}/factors/${admin.factorId}`, { method: "DELETE", headers: service });
    check("when the Admin API removes the last factor", adminRemoval.ok, `status ${adminRemoval.status}`);
    check("that session is refused too", refused(await rpc(s3.access_token, "get_audit_events")));
  }

  // -------------------------------------------------------------------------
  section("3. The catalog editors' read policies");
  {
    const editor = await createUser("catalog_editor");
    const aal1 = await signIn(editor);
    const aal2 = await elevate(api, anonKey, aal1);
    const made = await rpc(aal2.access_token, "create_game", { p_title: `${PREFIX} Unverified`, p_kind: "game", p_reason: "MFA checks" });
    check("an editor at aal2 creates an unverified game", made.status === 200, `status ${made.status}`);
    const id = psql(`select id from public.games where title = '${PREFIX} Unverified';`);
    const read = async (token) => (await (await fetch(`${api}/rest/v1/games?id=eq.${id}&select=id`, { headers: asUser(token) })).json()).length;
    check("at aal2 they can read it", (await read(aal2.access_token)) === 1);
    check("at aal1 they can't: the read policy needs MFA too", (await read(aal1.access_token)) === 0);
    check("and at aal1 they aren't offered review", (await rpc(aal1.access_token, "can_review_submissions")).body === false);
    check("at aal2 they are", (await rpc(aal2.access_token, "can_review_submissions")).body === true);
  }

  // -------------------------------------------------------------------------
  section("4. Registering verified factors (D13)");
  {
    const user = await createUser();
    const aal1 = await signIn(user);
    const first = await elevate(api, anonKey, aal1, "first");
    const extra = await auth("/factors", first.access_token, { factor_type: "totp", friendly_name: "second" });
    const ch = await auth(`/factors/${extra.body.id}/challenge`, first.access_token, {});
    const second = (await auth(`/factors/${extra.body.id}/verify`, first.access_token, { challenge_id: ch.body.id, code: totp(extra.body.totp.secret) })).body;
    await auth("/factors", second.access_token, { factor_type: "totp", friendly_name: "never verified" });
    check("registering from an aal1 session is refused", refused(await rpc((await signIn(user)).access_token, "register_my_verified_factors")));
    const before = psql("select extract(epoch from now())::bigint;");
    const added = await rpc(second.access_token, "register_my_verified_factors");
    check("from aal2, both verified factors are registered, not the unverified one", added.status === 200 && added.body === 2, JSON.stringify(added.body));
    check("at the server's time", psql(`select bool_and(extract(epoch from registered_at)::bigint between ${before} and ${before} + 5) from private.mfa_factor_registrations where user_id = '${user.id}';`) === "t");
    const timed = await rpc(second.access_token, "register_my_verified_factors", { p_registered_at: "2000-01-01T00:00:00Z" });
    check("the call takes no time from the client", timed.status === 404 || timed.status === 400, `status ${timed.status}`);
    check("a second call adds nothing", (await rpc(second.access_token, "register_my_verified_factors")).body === 0);
    check("neither factor is mature yet", psql(`select private.mature_totp_factor_count('${user.id}');`) === "0");

    // Two sessions register a new factor at once: one records it, the other waits and adds nothing.
    const third = await auth("/factors", second.access_token, { factor_type: "totp", friendly_name: "third" });
    const ch3 = await auth(`/factors/${third.body.id}/challenge`, second.access_token, {});
    const latest = (await auth(`/factors/${third.body.id}/verify`, second.access_token, { challenge_id: ch3.body.id, code: totp(third.body.totp.secret) })).body;
    await a.run("begin;");
    const one = await a.as(latest.access_token, "select public.register_my_verified_factors();");
    await b.run("begin;");
    const racing = b.as(latest.access_token, "select public.register_my_verified_factors();");
    check("a second registration of the same factor waits for the first", await waitingOn("mfa_b", "mfa_a"));
    await a.run("commit;");
    const other = await racing;
    await b.run("commit;");
    check("the first records it, the second adds nothing", one.out.split("\n").includes("1") && other.out.split("\n").includes("0") && !other.err, `${one.out} / ${other.out} ${other.err}`);
    check("so the factor is recorded once", psql(`select count(*) from private.mfa_factor_registrations where factor_id = '${third.body.id}';`) === "1");

    // -----------------------------------------------------------------------
    section("5. Registrations can't be backdated by the app (M8d review)");
    const direct = await fetch(`${api}/rest/v1/mfa_factor_registrations`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${latest.access_token}`, "Content-Type": "application/json", "Content-Profile": "private", Prefer: "return=minimal" },
      body: JSON.stringify({ factor_id: randomUUID(), user_id: user.id, factor_created_at: "2000-01-01T00:00:00Z", registered_at: "2000-01-01T00:00:00Z" }),
    });
    check("a signed-in user can't write a registration through the API", !direct.ok, `status ${direct.status}`);
    const patched = await fetch(`${api}/rest/v1/mfa_factor_registrations?user_id=eq.${user.id}`, {
      method: "PATCH",
      headers: { apikey: anonKey, Authorization: `Bearer ${latest.access_token}`, "Content-Type": "application/json", "Content-Profile": "private", Prefer: "return=minimal" },
      body: JSON.stringify({ registered_at: "2000-01-01T00:00:00Z" }),
    });
    check("nor move one back", !patched.ok && psql(`select bool_and(registered_at > now() - interval '1 hour') from private.mfa_factor_registrations where user_id = '${user.id}';`) === "t", `status ${patched.status}`);
    const removed = await fetch(`${api}/rest/v1/mfa_factor_registrations?user_id=eq.${user.id}`, {
      method: "DELETE",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Profile": "private" },
    });
    check("nor can service_role delete one", !removed.ok && psql(`select count(*) from private.mfa_factor_registrations where user_id = '${user.id}';`) === "3", `status ${removed.status}`);
    const migrations = readdirSync(join(root, "supabase", "migrations")).filter((name) => name.endsWith(".sql"));
    const writers = migrations.filter((name) => /insert\s+into\s+private\.mfa_factor_registrations/i.test(readFileSync(join(root, "supabase", "migrations", name), "utf8")));
    check("only the M8b migration writes registrations", writers.length === 1 && writers[0] === "20261116200000_m8b_mfa.sql", writers.join(", "));
    // Every statement that writes the ledger, in every migration: only M8b's, using now().
    const inserts = migrations.flatMap((name) => readFileSync(join(root, "supabase", "migrations", name), "utf8").match(/insert\s+into\s+private\.mfa_factor_registrations[^;]*;/gi) ?? []);
    check("and it records the server's now(), never an earlier time", inserts.length === 1 && /pg_catalog\.now\(\)/.test(inserts[0]) && !/interval/.test(inserts[0]), inserts.join(" | "));
    check("no migration updates or deletes registrations", migrations.every((name) => !/(update|delete\s+from)\s+private\.mfa_factor_registrations/i.test(readFileSync(join(root, "supabase", "migrations", name), "utf8"))));
  }
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  for (const session of [a, b]) session.close();
  await pause(200);
  psql("select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name in ('mfa_a', 'mfa_b');");
  const ids = [...createdUsers].map((id) => `'${id}'`).join(",") || "null";
  psql(`delete from public.games where title like '${PREFIX}%';`);
  let deletions = 0;
  for (const id of createdUsers) {
    const response = await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
    if (response.ok || response.status === 404) deletions += 1;
  }
  check("every test account is removed", deletions === createdUsers.size, `${deletions} of ${createdUsers.size}`);
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'mf\\_%';");
  check("no account, factor registration, session, game or audit row is left behind",
    psql(`select (select count(*) from auth.users where id in (${ids})) + (select count(*) from private.mfa_factor_registrations where user_id in (${ids}))
      + (select count(*) from auth.sessions where user_id in (${ids})) + (select count(*) from public.games where title like '${PREFIX}%')
      + (select count(*) from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids}));`) === "0");
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
