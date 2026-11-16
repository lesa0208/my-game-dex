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

import { decodeClaims, elevate, reverify, totp } from "./lib/mfa-session.mjs";

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

  // -------------------------------------------------------------------------
  section("6. The admin overview over the API, scoped by role (M10a)");
  {
    const sections = (r) => ["catalog", "accounts", "administration"].map((k) => (r.body?.[k] && typeof r.body[k] === "object" ? k : "-")).join("/");
    const anon = await fetch(`${api}/rest/v1/rpc/get_admin_overview`, { method: "POST", headers: { apikey: anonKey, "Content-Type": "application/json" }, body: "{}" });
    const anonBody = await anon.json().catch(() => ({}));
    check("anon is refused by PostgreSQL itself", anon.status === 401 && anonBody.code === "42501" && anonBody.message === "permission denied for function get_admin_overview",
      `${anon.status} ${anonBody.code} ${anonBody.message}`);
    const collector = await createUser();
    const collectorAal2 = await elevate(api, anonKey, await signIn(collector));
    check("a collector, even at aal2, is refused with the generic message", refused(await rpc(collectorAal2.access_token, "get_admin_overview")));
    const editor = await createUser("catalog_editor");
    const editorAal1 = await signIn(editor);
    check("a catalog editor at aal1 is refused", refused(await rpc(editorAal1.access_token, "get_admin_overview")));
    const editorAal2 = await elevate(api, anonKey, editorAal1);
    const editorRead = await rpc(editorAal2.access_token, "get_admin_overview");
    check("at aal2, a catalog editor gets the catalog counts only", editorRead.status === 200 && sections(editorRead) === "catalog/-/-", sections(editorRead));
    const moderator = await createUser("moderator");
    const moderatorRead = await rpc((await elevate(api, anonKey, await signIn(moderator))).access_token, "get_admin_overview");
    check("a moderator gets the account counts only", moderatorRead.status === 200 && sections(moderatorRead) === "-/accounts/-", sections(moderatorRead));
    const administrator = await createUser("admin");
    const adminRead = await rpc((await elevate(api, anonKey, await signIn(administrator))).access_token, "get_admin_overview");
    check("an administrator gets every section", adminRead.status === 200 && sections(adminRead) === "catalog/accounts/administration", sections(adminRead));
    const text = JSON.stringify(adminRead.body);
    check("and only numbers: no id, handle or email", !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text) && !text.includes("@") && !/mf_[0-9a-f]/.test(text));
    // Account status is read live, so the same aal2 token stops working at once.
    psql(`update public.profiles set account_status = 'suspended' where id = '${editor.id}';`);
    check("once suspended, the same editor's aal2 token is refused", refused(await rpc(editorAal2.access_token, "get_admin_overview")));
  }

  section("7. Catalog search, records and history over the API (M10b)");
  {
    const title = `${PREFIX} Unpublished Record`;
    const editor = await createUser("catalog_editor");
    const editorAal1 = await signIn(editor);
    const editorAal2 = await elevate(api, anonKey, editorAal1);
    const created = await rpc(editorAal2.access_token, "create_game", { p_title: title, p_kind: "game", p_reason: "Adding a record to search for" });
    const game = created.body;
    check("setup: an editor adds an unpublished game", created.status === 200 && typeof game === "string", `${created.status}`);
    const calls = [
      ["search_catalog_records", { p_kind: "games", p_query: title }],
      ["get_game_record", { p_game: game }],
      ["get_release_record", { p_release: game }],
      ["get_catalog_record_history", { p_entity: "game", p_id: game }],
    ];
    let anonRefused = true;
    for (const [fn, args] of calls) {
      const r = await fetch(`${api}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify(args) });
      const body = await r.json().catch(() => ({}));
      anonRefused &&= r.status === 401 && body.code === "42501" && body.message === `permission denied for function ${fn}`;
    }
    check("anon is refused by PostgreSQL itself, for all four", anonRefused);
    const collector = await createUser();
    const collectorAal2 = await elevate(api, anonKey, await signIn(collector));
    const moderator = await createUser("moderator");
    const moderatorAal2 = await elevate(api, anonKey, await signIn(moderator));
    for (const [name, token] of [["a collector at aal2", collectorAal2.access_token], ["a moderator at aal2", moderatorAal2.access_token], ["a catalog editor at aal1", editorAal1.access_token]]) {
      let all = true;
      for (const [fn, args] of calls) all &&= refused(await rpc(token, fn, args));
      check(`${name} is refused by all four, with the generic message`, all);
    }
    const search = await rpc(editorAal2.access_token, "search_catalog_records", { p_kind: "games", p_query: title });
    check("an editor's search finds the unpublished game", search.status === 200 && search.body.items?.length === 1 && search.body.items[0].id === game && search.body.items[0].status === "under_review",
      JSON.stringify(search.body?.items?.map((i) => i.status)));
    const administrator = await createUser("admin");
    const adminAal2 = await elevate(api, anonKey, await signIn(administrator));
    check("so does an administrator's", (await rpc(adminAal2.access_token, "search_catalog_records", { p_kind: "games", p_query: title })).body?.items?.length === 1);
    const record = await rpc(editorAal2.access_token, "get_game_record", { p_game: game });
    check("the game's record opens for the editor", record.status === 200 && record.body?.title === title && record.body?.status === "under_review");
    const history = await rpc(editorAal2.access_token, "get_catalog_record_history", { p_entity: "game", p_id: game });
    const created1 = history.body?.items?.find((e) => e.action === "catalog_record_created");
    check("its history names the editor by handle, with their reason", created1?.actor?.kind === "staff" && /^mf_/.test(created1.actor.handle ?? "") && created1.reason === "Adding a record to search for",
      JSON.stringify(created1?.actor));
    const text = JSON.stringify([search.body, record.body, history.body]);
    check("nothing in them holds an email or an account id", !text.includes("@") && !text.includes(editor.id) && !text.includes("submitted_by") && !text.includes("verified_by"));
    const bounded = await rpc(editorAal2.access_token, "search_catalog_records", { p_kind: "releases", p_limit: 1000 });
    check("a page holds at most 50 results, however many are asked for", bounded.status === 200 && bounded.body.items.length <= 50, `${bounded.body?.items?.length}`);
    const historyBounded = await rpc(editorAal2.access_token, "get_catalog_record_history", { p_entity: "game", p_id: game, p_limit: 1000 });
    check("and a history page at most 50 events", historyBounded.status === 200 && historyBounded.body.items.length <= 50);
    const badCursor = await rpc(editorAal2.access_token, "search_catalog_records", { p_kind: "games", p_cursor: "bm90LWEtY3Vyc29y" });
    check("a made-up cursor is refused", badCursor.status === 400 && badCursor.body?.message === "invalid cursor", `${badCursor.status} ${badCursor.body?.message}`);
    // The public reads are unchanged: the unpublished game stays out of them.
    const collectorRead = await fetch(`${api}/rest/v1/games?select=id&id=eq.${game}`, { headers: asUser(collectorAal2.access_token) });
    check("a collector still can't read the unpublished game directly", (await collectorRead.json()).length === 0);
    const publicSearch = await fetch(`${api}/rest/v1/rpc/search_catalog`, { method: "POST", headers: { apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ p_query: title }) });
    check("and the public search doesn't find it", (await publicSearch.json()).items?.length === 0);
    check("the full audit log is still administrators' only", refused(await rpc(editorAal2.access_token, "get_audit_events", { p_limit: 5 })));
    psql(`update public.profiles set account_status = 'suspended' where id = '${editor.id}';`);
    check("once suspended, the same editor's aal2 token is refused", refused(await rpc(editorAal2.access_token, "search_catalog_records", { p_kind: "games", p_query: title })));
  }

  section("8. Catalog editing over the API: the creator and a recent verification (M10c)");
  {
    const failedWith = (r, message) => r.status >= 400 && r.body?.message === message;
    const revision = (table, id) => Number(psql(`select revision from public.${table} where id = '${id}';`));
    /** Makes a session's TOTP verification 11 minutes old. Only postgres can age the claim like this. */
    const age = (session) => psql(`update auth.mfa_amr_claims set updated_at = now() - interval '11 minutes' where session_id = '${decodeClaims(session.access_token).session_id}';`);
    const creator = await createUser("catalog_editor");
    const creatorAal2 = await elevate(api, anonKey, await signIn(creator));
    const other = await createUser("catalog_editor");
    const otherAal2 = await elevate(api, anonKey, await signIn(other));
    const title = `${PREFIX} edited ${randomBytes(3).toString("hex")}`;
    const game = (await rpc(creatorAal2.access_token, "create_game", { p_title: title, p_kind: "game", p_reason: "Editing checks" })).body;
    const snes = psql("select id from public.platforms where slug = 'snes';");
    const release = (await rpc(creatorAal2.access_token, "create_release", {
      p_game: game, p_platform: snes, p_media_format_code: "rom-cartridge", p_region_code: "ntsc-uc",
      p_details: { edition_name: "Standard", edition_kind: "standard", media_count: 1, product_code: `MF-${randomBytes(3).toString("hex")}` }, p_reason: "Editing checks",
    })).body;
    check("an editor creates a game and a release over the API", /^[0-9a-f-]{36}$/.test(game ?? "") && /^[0-9a-f-]{36}$/.test(release ?? ""));
    const anonCreate = await fetch(`${api}/rest/v1/rpc/create_game`, { method: "POST", headers: { apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ p_title: "x", p_kind: "game", p_reason: "x" }) });
    check("anon is refused by PostgreSQL itself", anonCreate.status === 401);
    const collector = await createUser();
    const collectorAal2 = await elevate(api, anonKey, await signIn(collector));
    check("a collector at aal2 can't verify", refused(await rpc(collectorAal2.access_token, "verify_game", { p_game: game, p_reason: "x", p_expected_revision: revision("games", game) })));
    check("the creator can't verify their game", failedWith(await rpc(creatorAal2.access_token, "verify_game", { p_game: game, p_reason: "Mine", p_expected_revision: revision("games", game) }), "own record"));
    const administrator = await createUser("admin");
    const adminAal2 = await elevate(api, anonKey, await signIn(administrator));
    const adminGame = (await rpc(adminAal2.access_token, "create_game", { p_title: `${PREFIX} admin ${randomBytes(3).toString("hex")}`, p_kind: "game", p_reason: "Editing checks" })).body;
    check("nor can an administrator verify their own", failedWith(await rpc(adminAal2.access_token, "verify_game", { p_game: adminGame, p_reason: "Mine", p_expected_revision: revision("games", adminGame) }), "own record"));
    age(otherAal2);
    check("another editor with a verification 11 minutes old is asked to verify again",
      failedWith(await rpc(otherAal2.access_token, "verify_game", { p_game: game, p_reason: "Checked", p_expected_revision: revision("games", game) }), "reauthentication required")
      && psql(`select verified_at is null from public.games where id = '${game}';`) === "t");
    check("while editing an unpublished game needs only the live session",
      (await rpc(otherAal2.access_token, "update_game", { p_game: game, p_changes: { summary: "Described." }, p_reason: "Editing checks" })).body === true);
    const fresh = await reverify(api, anonKey, otherAal2);
    check("with a recent verification, the other editor verifies the game and the release",
      (await rpc(fresh.access_token, "verify_game", { p_game: game, p_reason: "Checked", p_expected_revision: revision("games", game) })).body === true
      && (await rpc(fresh.access_token, "verify_release", { p_release: release, p_reason: "Checked", p_expected_revision: revision("releases", release) })).body === true);
    check("the creator can't publish it", failedWith(await rpc(creatorAal2.access_token, "publish_release", { p_release: release, p_reason: "Mine", p_expected_revision: revision("releases", release) }), "own record"));
    check("the other editor publishes it, with its game",
      (await rpc(fresh.access_token, "publish_release", { p_release: release, p_reason: "Ready", p_expected_revision: revision("releases", release) })).body === true
      && psql(`select status from public.games where id = '${game}';`) === "published");
    age(fresh);
    check("editing the published release then needs a recent verification again",
      failedWith(await rpc(fresh.access_token, "update_release", { p_release: release, p_changes: { packaging: "Box" }, p_reason: "Editing checks" }), "reauthentication required")
      && psql(`select packaging is null from public.releases where id = '${release}';`) === "t");
    const relations = () => psql(`select count(*) from public.game_relations where '${game}' in (source_game_id, target_game_id);`);
    check("so does relating the published game to an unpublished one, in either direction",
      failedWith(await rpc(fresh.access_token, "set_game_relation", { p_source: game, p_target: adminGame, p_relation: "remake_of", p_reason: "Editing checks" }), "reauthentication required")
      && failedWith(await rpc(fresh.access_token, "set_game_relation", { p_source: adminGame, p_target: game, p_relation: "remaster_of", p_reason: "Editing checks" }), "reauthentication required")
      && relations() === "0");
    const freshAgain = await reverify(api, anonKey, fresh);
    check("which a recent verification allows",
      (await rpc(freshAgain.access_token, "set_game_relation", { p_source: adminGame, p_target: game, p_relation: "remaster_of", p_reason: "Editing checks" })).body === true && relations() === "1");
    const asCreator = (await rpc(creatorAal2.access_token, "get_release_record", { p_release: release })).body?.review;
    const asOther = (await rpc(fresh.access_token, "get_release_record", { p_release: release })).body?.review;
    check("the record tells each only what they did themselves", asCreator?.you_created === true && asCreator?.you_verified === false && asOther?.you_created === false && asOther?.you_verified === true);
    const reviewText = JSON.stringify([asCreator, asOther]);
    check("and names nobody", ![creator.id, other.id, creator.email, other.email].some((x) => reviewText.includes(x)));
    check("no client can reach provenance", !(await fetch(`${api}/rest/v1/catalog_record_origins?select=id`, { headers: { ...asUser(creatorAal2.access_token), "Accept-Profile": "private" } })).ok);
    psql(`delete from public.releases where game_id in ('${game}', '${adminGame}');`);
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
