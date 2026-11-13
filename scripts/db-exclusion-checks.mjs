/**
 * M7b-2b checks against the running local stack: excluding and restoring through the
 * real API, and deterministic races between an exclusion or restoration and account
 * deletions, review decisions, copies being added or relinked, and each other. Each
 * race uses database sessions that really overlap: one holds its transaction open,
 * the script confirms the other is waiting on a lock, then the first commits, so the
 * outcome doesn't depend on timing. Every catalog record, copy and account made here
 * is removed after.
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
const anon = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" };
const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
const asUser = (token) => ({ apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function rpc(headers, fn, args = {}) {
  const response = await fetch(`${api}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}
const isDenied = (r) => r.status === 401 || r.status === 403;
const error = (r, message) => r.status >= 400 && r.body?.message === message && !r.body?.details && !r.body?.hint;

function uuidv7() {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const createdUsers = new Set();
const everyUser = new Set();
async function createUser(role = null) {
  const email = `excl-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await fetch(`${api}/auth/v1/admin/users`, { method: "POST", headers: service, body: JSON.stringify({ email, password, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  everyUser.add(user.id);
  response = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: "POST", headers: anon, body: JSON.stringify({ email, password }) });
  const session = await response.json();
  const claimed = await rpc(asUser(session.access_token), "claim_handle", { p_handle: `xk_${randomBytes(6).toString("hex")}` });
  if (claimed.status !== 200) throw new Error(`could not claim a handle: status ${claimed.status}`);
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { id: user.id, headers: asUser(session.access_token) };
}
/** Runs SQL as a signed-in user in its own transaction, and returns the last line. */
function sqlAs(userId, sql) {
  const out = psql(`begin; select set_config('request.jwt.claims', '{"sub": "${userId}", "role": "authenticated"}', true); set local role authenticated; ${sql} commit;`);
  return out.split("\n").filter((line) => line !== "" && !line.startsWith("{\"sub\"")).at(-1) ?? "";
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
  /** Runs SQL as a signed-in user inside the session's open transaction. */
  asUser(userId, sql) {
    return this.run(`select set_config('request.jwt.claims', '{"sub": "${userId}", "role": "authenticated"}', true); set local role authenticated; ${sql} reset role;`);
  }
  close() {
    this.child.stdin.end();
  }
}
async function waitingOnLock(name) {
  for (let i = 0; i < 100; i += 1) {
    if (psql(`select count(*) from pg_stat_activity where application_name = '${name}' and wait_event_type = 'Lock';`) === "1") return true;
    await pause(50);
  }
  return false;
}
const deadlocked = (result) => /deadlock/i.test(result?.err ?? "");
const errorOf = (result) => /ERROR:\s+([^\n]+)/.exec(result?.err ?? "")?.[1] ?? "";

// ---------------------------------------------------------------------------
// Catalog records, made by an editor through the M5 functions
// ---------------------------------------------------------------------------
const PREFIX = `Exx ${randomBytes(3).toString("hex")}`;
let editor;
let reviewer;
let admin;
let admin2;
const snes = () => psql("select id from public.platforms where slug = 'snes';");
function makeGame(title) {
  return sqlAs(editor.id, `select g from public.create_game('${PREFIX} ${title}', 'game', null, null, null, 'unknown', 'Exclusion checks') g;
    select public.verify_game(g.id, 'Exclusion checks', g.revision) from public.games g where g.title = '${PREFIX} ${title}';
    select id from public.games where title = '${PREFIX} ${title}';`);
}
let codes = 0;
function makeRelease(game, region = "ntsc-uc") {
  codes += 1;
  const code = `EXX-${codes}-${randomBytes(2).toString("hex")}`;
  return sqlAs(editor.id, `select public.create_release('${game}', '${snes()}', 'rom-cartridge', '${region}', '{"edition_name": "${code}", "edition_kind": "standard", "media_count": 1, "product_code": "${code}"}', 'Exclusion checks');
    select public.verify_release(r.id, 'Exclusion checks', r.revision) from public.releases r where r.product_code = '${code}';
    select public.publish_release(r.id, 'Exclusion checks', r.revision) from public.releases r where r.product_code = '${code}';
    select id from public.releases where product_code = '${code}';`);
}
function submit(user, game, region) {
  codes += 1;
  return JSON.parse(sqlAs(user.id, `select public.submit_release('${game}', 'snes', 'rom-cartridge', '${region}', '{"product_code": "EXX-S${codes}"}', '[]', null, true)::text;`));
}
const addCopy = (user, release) => {
  const id = uuidv7();
  sqlAs(user.id, `select public.add_collection_item('${id}', '${release}', '{"notes": "Kept"}');`);
  return id;
};
const token = (release) => sqlAs(editor.id, `select public.get_exclusion_preview('${release}') ->> 'token';`);
const excludeSql = (release, tok) => `select public.exclude_release('${release}', '${tok}', 'no_game_data', 'Concurrency check', null, true, true);`;
const exclude = (release) => JSON.parse(sqlAs(editor.id, `select ${excludeSql(release, token(release)).slice(7, -1)}::text;`));
const releaseStatus = (release) => psql(`select status from public.releases where id = '${release}';`);
const copyStatus = (item) => psql(`select coalesce((select record_status::text from public.collection_items where id = '${item}'), 'gone');`);
const exclusionOf = (release) => psql(`select id from private.catalog_exclusions where release_id = '${release}' and restored_at is null;`);
const exclusionVersion = (id) => psql(`select version from private.catalog_exclusions where id = '${id}';`);
const requestOf = (release) => psql(`select id || ' ' || version from public.catalog_change_requests where release_id = '${release}' order by id desc limit 1;`).split(" ");

async function cleanup() {
  const ids = [...everyUser].map((id) => `'${id}'`).join(",") || "null";
  // Not in replica mode: foreign-key cascades must run, so copies take their private
  // details and piece records with them, and games their pairings.
  psql(`begin;
create temp table our_games on commit drop as select id from public.games where title like '${PREFIX}%';
delete from private.catalog_exclusions where release_id in (select id from public.releases where game_id in (select id from our_games));
delete from public.collection_items where owner_id in (${ids}) or release_id in (select id from public.releases where game_id in (select id from our_games));
delete from public.catalog_change_requests where game_id in (select id from our_games) or submitted_by in (${ids});
delete from public.release_components where release_id in (select id from public.releases where game_id in (select id from our_games));
delete from public.release_markets where release_id in (select id from public.releases where game_id in (select id from our_games));
delete from public.releases where game_id in (select id from our_games);
delete from public.games where id in (select id from our_games);
commit;`);
  let deletions = 0;
  for (const id of createdUsers) {
    const response = await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
    if (response.ok || response.status === 404) deletions += 1;
  }
  check("every test account is removed", deletions === createdUsers.size, `${deletions} of ${createdUsers.size}`);
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'xk\\_%';");
  check("no catalog records, copies or exclusions are left behind",
    psql(`select (select count(*) from public.games where title like '${PREFIX}%') + (select count(*) from public.collection_items where owner_id in (${ids})) + (select count(*) from private.catalog_exclusions e where not exists (select 1 from public.releases r where r.id = e.release_id));`) === "0");
}

const a = new Session("excl_a");
const b = new Session("excl_b");
const c = new Session("excl_c");
const d = new Session("excl_d");
try {
  editor = await createUser("catalog_editor");
  reviewer = await createUser("catalog_editor");
  admin = await createUser("admin");
  admin2 = await createUser("admin");
  const owner = await createUser();

  section("Excluding and restoring over the API");
  const g0 = makeGame("Api");
  const r0 = makeRelease(g0, "ntsc-uc");
  makeRelease(g0, "pal");
  const item0 = addCopy(owner, r0);
  const touched = () => psql(`select updated_at from public.collection_items where id = '${item0}';`);
  const touchedBefore = touched();
  check("a visitor can't preview an exclusion", isDenied(await rpc(anon, "get_exclusion_preview", { p_release: r0 })));
  check("nor can service_role", isDenied(await rpc(service, "get_exclusion_preview", { p_release: r0 })));
  check("a collector is refused", error(await rpc(owner.headers, "get_exclusion_preview", { p_release: r0 }), "not permitted"));
  const preview = await rpc(editor.headers, "get_exclusion_preview", { p_release: r0 });
  check("an editor previews it", preview.status === 200 && preview.body.copies === 1 && typeof preview.body.token === "string");
  check("a stale token is refused with a plain message", error(await rpc(editor.headers, "exclude_release", { p_release: r0, p_token: "stale", p_reason_code: "no_game_data", p_reason: "Api check", p_acknowledge_copies: true }), "preview stale"));
  const excluded = await rpc(editor.headers, "exclude_release", { p_release: r0, p_token: preview.body.token, p_reason_code: "no_game_data", p_reason: "Api check", p_owner_note: "Not a game", p_acknowledge_copies: true });
  check("the editor excludes it", excluded.status === 200 && excluded.body.copies === 1 && copyStatus(item0) === "invalid_preserved", excluded.text);
  check("which leaves the copy's updated_at as its owner last left it", touched() === touchedBefore);
  const mine = await rpc(owner.headers, "get_my_preserved_release", { p_item: item0 });
  check("its owner reads what it was, and why", mine.body?.exclusion?.note === "Not a game" && mine.body?.release?.platform?.slug === "snes" && !("submitted_by" in (mine.body?.release ?? {})));
  const other = await createUser();
  check("another collector reads nothing through it", (await rpc(other.headers, "get_my_preserved_release", { p_item: item0 })).body === null);
  check("an editor can't restore", error(await rpc(editor.headers, "restore_exclusion", { p_exclusion: excluded.body.exclusion_id, p_expected_version: 1, p_reason: "Api" }), "not permitted"));
  const restored = await rpc(admin.headers, "restore_exclusion", { p_exclusion: excluded.body.exclusion_id, p_expected_version: 1, p_reason: "Api check" });
  check("an administrator restores it", restored.status === 200 && restored.body.copies === 1 && copyStatus(item0) === "active" && releaseStatus(r0) === "published", restored.text);

  // -------------------------------------------------------------------------
  section("1. An exclusion and the deletion of a copy owner who verified the release");
  {
    const g = makeGame("Verifier");
    const r = makeRelease(g, "ntsc-uc");
    makeRelease(g, "pal");
    const v = await createUser("catalog_editor");
    psql(`update public.releases set verified_by = '${v.id}' where id = '${r}';`);
    const vCopy = addCopy(v, r);
    const keep = addCopy(owner, r);
    await a.run("begin;");
    const first = await a.asUser(editor.id, excludeSql(r, token(r)));
    check("the exclusion holds its locks", !first.err, first.err);
    const deleting = b.run(`begin; delete from auth.users where id = '${v.id}';`);
    check("the account deletion waits for it", await waitingOnLock("excl_b"));
    await a.run("commit;");
    const deleted = await deleting;
    await b.run("commit;");
    check("then completes, with no deadlock", !deadlocked(deleted) && !deleted.err && copyStatus(vCopy) === "gone" && copyStatus(keep) === "invalid_preserved", deleted.err);
    createdUsers.delete(v.id);

    const r2 = makeRelease(g, "ntsc-j");
    const v2 = await createUser("catalog_editor");
    psql(`update public.releases set verified_by = '${v2.id}' where id = '${r2}';`);
    addCopy(v2, r2);
    const keep2 = addCopy(owner, r2);
    const tok = token(r2);
    await b.run(`begin; delete from auth.users where id = '${v2.id}';`);
    await a.run("begin;");
    const waiting = a.asUser(editor.id, excludeSql(r2, tok));
    check("the other way round, the exclusion waits for the deletion", await waitingOnLock("excl_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("commit;");
    check("then excludes, with no deadlock, and the deleted owner's copy is gone", !deadlocked(done) && !done.err && releaseStatus(r2) === "excluded" && copyStatus(keep2) === "invalid_preserved", done.err);
    createdUsers.delete(v2.id);
  }

  // -------------------------------------------------------------------------
  section("2. An exclusion and the deletion of the submission's reviewer");
  {
    const g = makeGame("Reviewer");
    makeRelease(g);
    const submitter = await createUser();
    const w = await createUser("catalog_editor");
    const s = submit(submitter, g, "pal");
    addCopy(submitter, s.release_id);
    let [req, ver] = requestOf(s.release_id);
    ver = sqlAs(w.id, `select public.start_submission_review('${req}', ${ver}, 'Checking');`);
    sqlAs(w.id, `select public.request_submission_changes('${req}', ${ver}, 'Add a photo', 'Needs evidence');`);
    check("the reviewer's decision is on the request", psql(`select reviewed_by from public.catalog_change_requests where id = '${req}';`) === w.id);
    await a.run("begin;");
    const first = await a.asUser(editor.id, excludeSql(s.release_id, token(s.release_id)));
    check("the exclusion holds its locks", !first.err, first.err);
    const deleting = b.run(`begin; delete from auth.users where id = '${w.id}';`);
    check("the reviewer's account deletion waits for it", await waitingOnLock("excl_b"));
    await a.run("commit;");
    const deleted = await deleting;
    await b.run("commit;");
    check("then completes, with no deadlock", !deadlocked(deleted) && !deleted.err && psql(`select status || ' ' || (reviewed_by = '${editor.id}') from public.catalog_change_requests where id = '${req}';`) === "excluded true"
      && psql(`select count(*) from public.profiles where id = '${w.id}';`) === "0", deleted.err);
    createdUsers.delete(w.id);

    const s2 = submit(submitter, g, "ntsc-j");
    const w2 = await createUser("catalog_editor");
    let [req2, ver2] = requestOf(s2.release_id);
    ver2 = sqlAs(w2.id, `select public.start_submission_review('${req2}', ${ver2}, 'Checking');`);
    sqlAs(w2.id, `select public.request_submission_changes('${req2}', ${ver2}, 'Add a photo', 'Needs evidence');`);
    const tok = token(s2.release_id);
    await b.run(`begin; delete from auth.users where id = '${w2.id}';`);
    await a.run("begin;");
    const waiting = a.asUser(editor.id, excludeSql(s2.release_id, tok));
    check("the other way round, the exclusion waits for the reviewer's deletion", await waitingOnLock("excl_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("rollback;");
    check("then is refused as stale, with no deadlock: the request changed", !deadlocked(done) && errorOf(done) === "preview stale" && releaseStatus(s2.release_id) !== "excluded", done.err);
    createdUsers.delete(w2.id);
    const retried = exclude(s2.release_id);
    check("and a fresh preview excludes it", retried.exclusion_id && releaseStatus(s2.release_id) === "excluded");
  }

  // -------------------------------------------------------------------------
  section("3. An exclusion and a review decision that changes the reviewer");
  {
    const g = makeGame("Decision");
    makeRelease(g);
    const submitter = await createUser();
    const s = submit(submitter, g, "pal");
    let [req, ver] = requestOf(s.release_id);
    ver = sqlAs(reviewer.id, `select public.start_submission_review('${req}', ${ver}, 'Checking');`);
    const tok = token(s.release_id);
    await b.run("begin;");
    const decision = await b.asUser(reviewer.id, `select public.request_submission_changes('${req}', ${ver}, 'Add a photo', 'Needs evidence');`);
    check("a review decision holds the request", !decision.err, decision.err);
    await a.run("begin;");
    const waiting = a.asUser(editor.id, excludeSql(s.release_id, tok));
    check("the exclusion waits for it", await waitingOnLock("excl_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("rollback;");
    check("then is refused as stale: the reviewer and status changed", !deadlocked(done) && errorOf(done) === "preview stale", done.err);
    check("and a fresh preview excludes it", exclude(s.release_id).exclusion_id && releaseStatus(s.release_id) === "excluded");

    const s2 = submit(submitter, g, "ntsc-j");
    let [req2, ver2] = requestOf(s2.release_id);
    ver2 = sqlAs(reviewer.id, `select public.start_submission_review('${req2}', ${ver2}, 'Checking');`);
    await a.run("begin;");
    const first = await a.asUser(editor.id, excludeSql(s2.release_id, token(s2.release_id)));
    check("the other way round, the exclusion holds the request", !first.err, first.err);
    await b.run("begin;");
    const deciding = b.asUser(reviewer.id, `select public.request_submission_changes('${req2}', ${ver2}, 'Add a photo', 'Needs evidence');`);
    check("the review decision waits", await waitingOnLock("excl_b"));
    await a.run("commit;");
    const decided = await deciding;
    await b.run("rollback;");
    check("and is then refused: the submission is excluded", !deadlocked(decided) && ["submission unavailable", "request conflict"].includes(errorOf(decided)), decided.err);
  }

  // -------------------------------------------------------------------------
  section("4. An exclusion and a copy from a new owner");
  {
    const g = makeGame("Arriving");
    const r = makeRelease(g, "ntsc-uc");
    makeRelease(g, "pal");
    const newcomer = await createUser();
    const tok = token(r);
    await a.run("begin;");
    const first = await a.asUser(editor.id, excludeSql(r, tok));
    check("the exclusion holds the release", !first.err, first.err);
    const item = uuidv7();
    await b.run("begin;");
    const adding = b.asUser(newcomer.id, `select public.add_collection_item('${item}', '${r}', '{}');`);
    check("a new owner's copy waits for it", await waitingOnLock("excl_b"));
    await a.run("commit;");
    const added = await adding;
    await b.run("rollback;");
    check("and is refused once it's excluded", errorOf(added) === "release unavailable" && copyStatus(item) === "gone", added.err);

    const r2 = makeRelease(g, "ntsc-j");
    const tok2 = token(r2);
    const item2 = uuidv7();
    await b.run("begin;");
    const adding2 = await b.asUser(newcomer.id, `select public.add_collection_item('${item2}', '${r2}', '{}');`);
    check("the other way round, a new owner's copy is being added", !adding2.err, adding2.err);
    await a.run("begin;");
    const waiting = a.asUser(editor.id, excludeSql(r2, tok2));
    check("the exclusion waits for it", await waitingOnLock("excl_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("commit;");
    check("then excludes, locking the new owner without waiting, and preserves the copy", !done.err && copyStatus(item2) === "invalid_preserved", done.err);
    check("and the new owner is notified", psql(`select count(*) from public.notifications where recipient_id = '${newcomer.id}' and type = 'catalog_exclusion';`) === "1");
  }

  // -------------------------------------------------------------------------
  section("5. An exclusion and the deletion of an account with several references");
  {
    const g = makeGame("Many refs");
    makeRelease(g);
    const m = await createUser("catalog_editor");
    const s = submit(m, g, "pal");
    addCopy(m, s.release_id);
    const keep = addCopy(m, s.release_id);
    psql(`update public.games set verified_by = '${m.id}' where id = '${g}';`);
    await a.run("begin;");
    const first = await a.asUser(editor.id, excludeSql(s.release_id, token(s.release_id)));
    check("the exclusion holds its locks", !first.err, first.err);
    const deleting = b.run(`begin; delete from auth.users where id = '${m.id}';`);
    check("the deletion of its submitter, owner and the game's verifier waits for it", await waitingOnLock("excl_b"));
    await a.run("commit;");
    const deleted = await deleting;
    await b.run("commit;");
    check("then completes, with no deadlock", !deadlocked(deleted) && !deleted.err && copyStatus(keep) === "gone" && releaseStatus(s.release_id) === "excluded", deleted.err);
    createdUsers.delete(m.id);

    const m2 = await createUser("catalog_editor");
    const s2 = submit(m2, g, "ntsc-j");
    addCopy(m2, s2.release_id);
    psql(`update public.games set verified_by = '${m2.id}' where id = '${g}';`);
    const tok = token(s2.release_id);
    await b.run(`begin; delete from auth.users where id = '${m2.id}';`);
    await a.run("begin;");
    const waiting = a.asUser(editor.id, excludeSql(s2.release_id, tok));
    check("the other way round, the exclusion waits for the deletion", await waitingOnLock("excl_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("rollback;");
    check("then is refused as stale, with no deadlock", !deadlocked(done) && errorOf(done) === "preview stale", done.err);
    createdUsers.delete(m2.id);
    check("and a fresh preview excludes it", exclude(s2.release_id).exclusion_id && releaseStatus(s2.release_id) === "excluded");
  }

  // -------------------------------------------------------------------------
  section("6. A restoration and an owner's account deletion");
  {
    const g = makeGame("Restore");
    const r = makeRelease(g, "ntsc-uc");
    makeRelease(g, "pal");
    const o1 = await createUser();
    const o2 = await createUser();
    const c1 = addCopy(o1, r);
    const c2 = addCopy(o2, r);
    const keep = addCopy(owner, r);
    const x = exclude(r).exclusion_id;
    await a.run("begin;");
    const first = await a.asUser(admin.id, `select public.restore_exclusion('${x}', ${exclusionVersion(x)}, 'Restore check');`);
    check("a restoration holds its locks", !first.err, first.err);
    const deleting = b.run(`begin; delete from auth.users where id = '${o1.id}';`);
    check("an owner's account deletion waits for it", await waitingOnLock("excl_b"));
    await a.run("commit;");
    const deleted = await deleting;
    await b.run("commit;");
    check("then completes, with no deadlock", !deadlocked(deleted) && !deleted.err && copyStatus(c1) === "gone" && copyStatus(keep) === "active", deleted.err);
    createdUsers.delete(o1.id);

    const x2 = exclude(r).exclusion_id;
    await b.run(`begin; delete from auth.users where id = '${o2.id}';`);
    await a.run("begin;");
    const waiting = a.asUser(admin.id, `select public.restore_exclusion('${x2}', ${exclusionVersion(x2)}, 'Restore check');`);
    check("the other way round, the restoration waits for the deletion", await waitingOnLock("excl_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("commit;");
    check("then restores the remaining copies, with no deadlock", !deadlocked(done) && !done.err && copyStatus(c2) === "gone" && copyStatus(keep) === "active" && releaseStatus(r) === "published", done.err);
    createdUsers.delete(o2.id);
  }

  // -------------------------------------------------------------------------
  section("7. A profile that can't be locked without waiting, and a retry");
  {
    const g = makeGame("Nowait");
    const r = makeRelease(g, "ntsc-uc");
    makeRelease(g, "pal");
    const keep = addCopy(owner, r);
    const newcomer = await createUser();
    const tok = token(r);
    // d holds the game, so the exclusion stops after its first profile locks.
    await d.run(`begin; select 1 from public.games where id = '${g}' for share;`);
    await a.run("begin;");
    const excluding = a.asUser(editor.id, excludeSql(r, tok));
    check("the exclusion has locked the profiles it knew, and waits for the game", await waitingOnLock("excl_a"));
    const late = addCopy(newcomer, r);
    check("meanwhile a new owner adds a copy", copyStatus(late) === "active");
    const deleting = await c.run(`begin; delete from auth.users where id = '${newcomer.id}';`);
    check("and their account deletion is in progress", !deleting.err, deleting.err);
    await d.run("commit;");
    const done = await excluding;
    check("the exclusion can't lock that owner without waiting, so it stops with a retryable conflict", !deadlocked(done) && errorOf(done) === "request conflict", done.err);
    check("which names no lock or table", !/profiles|lock|nowait/i.test(errorOf(done)));
    await a.run("rollback;");
    check("and nothing it did is kept: release, copies, exclusion, notices and audit",
      releaseStatus(r) === "published" && copyStatus(keep) === "active" && exclusionOf(r) === ""
      && psql(`select count(*) from public.notifications where recipient_id = '${owner.id}' and type = 'catalog_exclusion' and created_at > now() - interval '1 minute' and data ->> 'exclusion_id' not in (select id::text from private.catalog_exclusions);`) === "0"
      && psql(`select count(*) from private.audit_events where action = 'catalog_release_excluded' and metadata ->> 'id' = '${r}';`) === "0");
    await c.run("commit;");
    createdUsers.delete(newcomer.id);
    const retried = exclude(r);
    check("a retry excludes it", retried.exclusion_id && releaseStatus(r) === "excluded" && copyStatus(keep) === "invalid_preserved" && copyStatus(late) === "gone");
  }

  // -------------------------------------------------------------------------
  section("8. A publication rule failing at commit rolls everything back");
  {
    const g = makeGame("Rollback");
    const r = makeRelease(g);
    const keep = addCopy(owner, r);
    await a.run("begin;");
    const excluded1 = await a.asUser(editor.id, excludeSql(r, token(r)));
    check("an exclusion with its cascade runs", !excluded1.err, excluded1.err);
    await a.run(`update public.games set status = 'published' where id = '${g}';`);
    const committed = await a.run("commit;");
    check("a violation in the same transaction fails at commit", /published/.test(errorOf(committed)), committed.err);
    check("and nothing is kept: the release, game, copy, exclusion, notices and audit",
      releaseStatus(r) === "published" && psql(`select status from public.games where id = '${g}';`) === "published" && copyStatus(keep) === "active" && exclusionOf(r) === ""
      && psql(`select count(*) from private.audit_events where action = 'catalog_release_excluded' and metadata ->> 'id' = '${r}';`) === "0"
      && psql(`select count(*) from public.notifications n where recipient_id = '${owner.id}' and type = 'catalog_exclusion' and not exists (select 1 from private.catalog_exclusions e where e.id::text = n.data ->> 'exclusion_id');`) === "0");
  }

  // -------------------------------------------------------------------------
  section("Relinking, another exclusion and another restoration");
  {
    const g = makeGame("Relink");
    const r = makeRelease(g, "ntsc-uc");
    const target = makeRelease(g, "pal");
    makeRelease(g, "ntsc-j");
    const away = addCopy(owner, r);
    const keep = addCopy(owner, r);
    const tok = token(r);
    await b.run("begin;");
    const moving = await b.asUser(owner.id, `select public.relink_my_copy('${away}', '${target}');`);
    check("an owner is relinking a copy away", !moving.err, moving.err);
    await a.run("begin;");
    const waiting = a.asUser(editor.id, excludeSql(r, tok));
    check("the exclusion waits for it", await waitingOnLock("excl_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("commit;");
    check("then excludes the release without the moved copy", !done.err && copyStatus(away) === "active" && copyStatus(keep) === "invalid_preserved", done.err);

    const x = exclusionOf(r);
    await a.run("begin;");
    const tok2 = token(target);
    const first = await a.asUser(editor.id, excludeSql(target, tok2));
    check("an exclusion of the target holds it", !first.err, first.err);
    await b.run("begin;");
    const twice = b.asUser(reviewer.id, excludeSql(target, tok2));
    check("a second exclusion of it waits", await waitingOnLock("excl_b"));
    await a.run("commit;");
    const refused = await twice;
    await b.run("rollback;");
    check("and is refused once it's excluded", errorOf(refused) === "release unavailable", refused.err);

    await b.run("begin;");
    const recovering = await b.asUser(owner.id, `select public.relink_my_copy('${keep}', '${makeRelease(g, "pal")}');`);
    check("an owner is relinking a preserved copy away", !recovering.err, recovering.err);
    await a.run("begin;");
    const restoring = a.asUser(admin.id, `select public.restore_exclusion('${x}', ${exclusionVersion(x)}, 'Restore check');`);
    check("a restoration waits for it", await waitingOnLock("excl_a"));
    await b.run("commit;");
    const restored = await restoring;
    await a.run("commit;");
    check("then restores without touching the relinked copy", !restored.err && /"copies": 0/.test(restored.out) && copyStatus(keep) === "active"
      && psql(`select release_id from public.collection_items where id = '${keep}';`) !== r, restored.err);

    const x2 = exclusionOf(target);
    await a.run("begin;");
    const one = await a.asUser(admin.id, `select public.restore_exclusion('${x2}', ${exclusionVersion(x2)}, 'Restore check');`);
    check("a restoration holds an exclusion", !one.err, one.err);
    await b.run("begin;");
    const two = b.asUser(admin2.id, `select public.restore_exclusion('${x2}', 1, 'Restore check');`);
    check("another administrator's restoration of it waits", await waitingOnLock("excl_b"));
    await a.run("commit;");
    const late = await two;
    await b.run("rollback;");
    check("and is refused once it's restored", errorOf(late) === "request conflict", late.err);
  }
} catch (caught) {
  check("the checks ran to the end", false, caught.message);
} finally {
  for (const s of [a, b, c, d]) s.close();
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
