/**
 * M7b-2c checks against the running local stack: merging through the real API, and
 * deterministic races between a merge and account deletions, exclusions, a
 * restoration, review decisions, relinking, a new copy, another merge, and an import.
 * Each race uses database sessions that really overlap: one holds its transaction
 * open, the script confirms the other is waiting on a lock, then the first commits,
 * so the outcome doesn't depend on timing. A merge's session sets a short lock
 * timeout, so a wait it shouldn't make fails a named check in seconds. Every catalog
 * record, copy, merge and account made here is removed after.
 *
 * Local only. Prints check names and statuses, never keys or tokens.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { claimsFor, elevate } from "./lib/mfa-session.mjs";
import { stackConfigPath, stackStatus } from "./lib/stack.mjs";

const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(stackConfigPath, "utf8"))[1];
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

const status = stackStatus();
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
  const email = `merge-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await fetch(`${api}/auth/v1/admin/users`, { method: "POST", headers: service, body: JSON.stringify({ email, password, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  everyUser.add(user.id);
  response = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: "POST", headers: anon, body: JSON.stringify({ email, password }) });
  const session = await elevate(api, anonKey, await response.json());
  const claimed = await rpc(asUser(session.access_token), "claim_handle", { p_handle: `xm_${randomBytes(6).toString("hex")}` });
  if (claimed.status !== 200) throw new Error(`could not claim a handle: status ${claimed.status}`);
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { id: user.id, headers: asUser(session.access_token) };
}
/** Runs SQL as a signed-in user in its own transaction, and returns the last line. */
function sqlAs(userId, sql) {
  const out = psql(`begin; select set_config('request.jwt.claims', '${claimsFor(userId)}', true); set local role authenticated; ${sql} commit;`);
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
    return this.run(`select set_config('request.jwt.claims', '${claimsFor(userId)}', true); set local role authenticated; ${sql} reset role;`);
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
/**
 * Whether session `waiter` waits for the game row that session `holder` holds, and
 * for nothing else: holder, idle in its transaction, is its only blocker; it waits
 * for holder's transaction; and the row it is queued for is in public.games.
 */
async function waitingForGame(waiter, holder) {
  const sql = `select coalesce((select pg_catalog.pg_blocking_pids(w.pid) = array[h.pid]
      and h.state = 'idle in transaction'
      and exists (select 1 from pg_catalog.pg_locks l where l.pid = w.pid and not l.granted and l.locktype = 'transactionid' and l.transactionid = h.backend_xid)
      and exists (select 1 from pg_catalog.pg_locks l where l.pid = w.pid and l.granted and l.locktype = 'tuple' and l.relation = 'public.games'::regclass)
      and not exists (select 1 from pg_catalog.pg_locks l where l.pid = w.pid and l.locktype = 'tuple' and l.relation <> 'public.games'::regclass)
    from pg_catalog.pg_stat_activity w, pg_catalog.pg_stat_activity h
    where w.application_name = '${waiter}' and w.wait_event_type = 'Lock' and h.application_name = '${holder}'), false);`;
  for (let i = 0; i < 100; i += 1) {
    if (psql(sql) === "t") return true;
    await pause(50);
  }
  return false;
}
/**
 * Tries to lock a profile FOR UPDATE NOWAIT from a new connection that holds nothing
 * else, and lets go at once: "locked" if another transaction holds a lock on it that
 * conflicts (KEY SHARE does), "free" if not, "missing" if there's no such profile.
 */
const profileLock = (id) =>
  psql(`create function pg_temp.probe(p uuid) returns text language plpgsql as $f$
begin
  perform 1 from public.profiles where id = p for update nowait;
  if not found then return 'missing'; end if;
  return 'free';
exception when lock_not_available then
  return 'locked';
end $f$;
select pg_temp.probe('${id}');`);
/** Whether a promise settles within ms; a slow one keeps running. */
const settlesWithin = (promise, ms) =>
  Promise.race([promise.then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);
const deadlocked = (result) => /deadlock/i.test(result?.err ?? "");
const errorOf = (result) => /ERROR:\s+([^\n]+)/.exec(result?.err ?? "")?.[1] ?? "";

// ---------------------------------------------------------------------------
// Catalog records, made by an editor through the M5 functions
// ---------------------------------------------------------------------------
const PREFIX = `Mxx ${randomBytes(3).toString("hex")}`;
let editor;
// Creates the records the others review: nobody reviews a record they created (M10c).
let maker;
let reviewer;
let admin;
let admin2;
const snes = () => psql("select id from public.platforms where slug = 'snes';");
function makeGame(title) {
  sqlAs(maker.id, `select g from public.create_game('${PREFIX} ${title}', 'game', null, null, null, 'unknown', 'Merge checks') g;`);
  return sqlAs(editor.id, `select public.verify_game(g.id, 'Merge checks', g.revision) from public.games g where g.title = '${PREFIX} ${title}';
    select id from public.games where title = '${PREFIX} ${title}';`);
}
let codes = 0;
function makeRelease(game, region = "ntsc-uc") {
  codes += 1;
  const code = `MXX-${codes}-${randomBytes(2).toString("hex")}`;
  sqlAs(maker.id, `select public.create_release('${game}', '${snes()}', 'snes-game-pak-na', '${region}', '{"edition_name": "${code}", "edition_kind": "standard", "media_count": 1, "product_code": "${code}", "packaging_code": "cardboard-box"}', 'Merge checks');`);
  return sqlAs(editor.id, `select public.verify_release(r.id, 'Merge checks', r.revision) from public.releases r where r.product_code = '${code}';
    select public.publish_release(r.id, 'Merge checks', r.revision) from public.releases r where r.product_code = '${code}';
    select id from public.releases where product_code = '${code}';`);
}
function submit(user, game, region) {
  codes += 1;
  return JSON.parse(sqlAs(user.id, `select public.submit_release('${game}', 'snes', 'snes-game-pak-na', '${region}', '{"product_code": "MXX-S${codes}"}', '[]', null, true)::text;`));
}
const addCopy = (user, release) => {
  const id = uuidv7();
  sqlAs(user.id, `select public.add_collection_item('${id}', '${release}', '{"notes": "Kept"}');`);
  return id;
};

const preview = (actor, source, target) => JSON.parse(sqlAs(actor.id, `select public.get_merge_preview('${source}', '${target}')::text;`));
const fieldsOf = (p) => `{${p.differences.map((d) => d.field).sort().join(",")}}`;
/** The merge call, for a session, from a preview taken now. */
function mergeSql(source, target, p = preview(editor, source, target)) {
  return `select public.merge_release('${source}', '${target}', '${p.token}', 'Concurrency check', null, '${fieldsOf(p)}', true);`;
}
const merge = (actor, source, target) => JSON.parse(sqlAs(actor.id, `select ${mergeSql(source, target).slice(7, -1)}::text;`));
const releaseStatus = (release) => psql(`select status from public.releases where id = '${release}';`);
const copyOn = (item) => psql(`select coalesce((select release_id::text from public.collection_items where id = '${item}'), 'gone');`);
const requestOf = (release) => psql(`select id || ' ' || version from public.catalog_change_requests where release_id = '${release}' order by id desc limit 1;`).split(" ");
const startReview = (release) => {
  const [req, ver] = requestOf(release);
  return [req, sqlAs(reviewer.id, `select public.start_submission_review('${req}', ${ver}, 'Checking');`)];
};
const merges = (release) => psql(`select count(*) from private.catalog_merges where source_release_id = '${release}';`);

async function cleanup() {
  const ids = [...everyUser].map((id) => `'${id}'`).join(",") || "null";
  // Merge records are permanent by design; this test data is removed with the
  // triggers off, then everything else with them on, so cascades run.
  psql(`begin;
create temp table our_games on commit drop as select id from public.games where title like '${PREFIX}%';
create temp table our_releases on commit drop as select id from public.releases where game_id in (select id from our_games);
set local session_replication_role = replica;
delete from private.catalog_merge_references where merge_id in (select id from private.catalog_merges where source_release_id in (select id from our_releases));
delete from private.catalog_merge_copies where merge_id in (select id from private.catalog_merges where source_release_id in (select id from our_releases));
delete from private.catalog_merges where source_release_id in (select id from our_releases);
update public.releases set merged_into_id = null, merged_publicly = false, status = 'rejected' where id in (select id from our_releases) and status = 'merged';
set local session_replication_role = origin;
delete from private.catalog_exclusions where release_id in (select id from our_releases);
delete from public.collection_items where owner_id in (${ids}) or release_id in (select id from our_releases);
delete from public.catalog_change_requests where game_id in (select id from our_games) or submitted_by in (${ids});
delete from private.external_references where release_id in (select id from our_releases);
delete from public.release_components where release_id in (select id from our_releases);
delete from public.release_markets where release_id in (select id from our_releases);
delete from public.releases where id in (select id from our_releases);
delete from public.games where id in (select id from our_games);
commit;`);
  let deletions = 0;
  for (const id of createdUsers) {
    const response = await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
    if (response.ok || response.status === 404) deletions += 1;
  }
  check("every test account is removed", deletions === createdUsers.size, `${deletions} of ${createdUsers.size}`);
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'xm\\_%';");
  check("no catalog records, copies or merges are left behind",
    psql(`select (select count(*) from public.games where title like '${PREFIX}%') + (select count(*) from public.collection_items where owner_id in (${ids}))
      + (select count(*) from private.catalog_merges m where not exists (select 1 from public.releases r where r.id = m.source_release_id));`) === "0");
}

const a = new Session("mrg_a");
const b = new Session("mrg_b");
const c = new Session("mrg_c");
const d = new Session("mrg_d");
// A wait the merge shouldn't make ends in seconds, not at the runner's timeout.
const begin = (s) => s.run("begin; set local lock_timeout = '15s';");
try {
  editor = await createUser("catalog_editor");
  maker = await createUser("catalog_editor");
  reviewer = await createUser("catalog_editor");
  admin = await createUser("admin");
  admin2 = await createUser("admin");
  const owner = await createUser();

  // -------------------------------------------------------------------------
  section("Merging over the API");
  {
    const g = makeGame("Api");
    const t = makeRelease(g, "ntsc-uc");
    const s = makeRelease(g, "ntsc-uc");
    const item = addCopy(owner, s);
    const touched = () => psql(`select updated_at from public.collection_items where id = '${item}';`);
    const touchedBefore = touched();
    check("a visitor can't preview a merge", isDenied(await rpc(anon, "get_merge_preview", { p_source: s, p_target: t })));
    check("nor can service_role", isDenied(await rpc(service, "get_merge_preview", { p_source: s, p_target: t })));
    check("a collector is refused", error(await rpc(owner.headers, "get_merge_preview", { p_source: s, p_target: t }), "not permitted"));
    const p = await rpc(editor.headers, "get_merge_preview", { p_source: s, p_target: t });
    check("an editor previews it", p.status === 200 && p.body.copies === 1 && p.body.requires_admin === true && typeof p.body.token === "string");
    const args = { p_source: s, p_target: t, p_token: p.body.token, p_reason: "Api check", p_owner_note: "Same game, same box", p_acknowledged: p.body.differences.map((x) => x.field), p_acknowledge_copies: true };
    check("an editor can't merge a published release", error(await rpc(editor.headers, "merge_release", args), "not permitted"));
    check("one acknowledgement short is refused with a plain message", error(await rpc(admin.headers, "merge_release", { ...args, p_acknowledged: args.p_acknowledged.slice(1) }), "acknowledgement required"));
    check("a stale token is refused with a plain message", error(await rpc(admin.headers, "merge_release", { ...args, p_token: "stale" }), "preview stale"));
    // M8d (D3): a published merge needs a TOTP verification in the last 10 minutes,
    // through the API as through the app. Only postgres can age the claim like this.
    const session = JSON.parse(claimsFor(admin.id)).session_id;
    psql(`update auth.mfa_amr_claims set updated_at = now() - interval '11 minutes' where session_id = '${session}';`);
    check("with a verification 11 minutes old, an administrator must reauthenticate to merge a published release",
      error(await rpc(admin.headers, "merge_release", args), "reauthentication required") && releaseStatus(s) === "published" && copyOn(item) === s);
    psql(`update auth.mfa_amr_claims set updated_at = now() where session_id = '${session}';`);
    const done = await rpc(admin.headers, "merge_release", args);
    check("an administrator merges it", done.status === 200 && done.body.copies === 1 && copyOn(item) === t && releaseStatus(s) === "merged", done.text);
    check("which leaves the copy's updated_at as its owner last left it", touched() === touchedBefore);
    // The owner's own move is their edit: it still moves updated_at on.
    const other = makeRelease(g, "pal");
    const relinked = await rpc(owner.headers, "relink_my_copy", { p_item: item, p_release: other });
    check("an owner's own relink afterwards still moves its updated_at on", relinked.status === 200 && copyOn(item) === other
      && psql(`select updated_at > '${touchedBefore}'::timestamptz from public.collection_items where id = '${item}';`) === "t", relinked.text);
    const resolved = await rpc(anon, "resolve_merged_release", { p_release: s });
    check("a visitor's link to it resolves to the target", resolved.body?.release_id === t);
    const list = await rpc(editor.headers, "get_merges", {});
    check("editors list it", list.body?.items?.some((m) => m.id === done.body.merge_id));
    check("collectors can't", error(await rpc(owner.headers, "get_merges", {}), "not permitted"));
  }

  // -------------------------------------------------------------------------
  section("1. A merge and the deletion of a copy owner who verified the source");
  {
    const g = makeGame("Verifier");
    const t = makeRelease(g, "ntsc-uc");
    const s = makeRelease(g, "ntsc-uc");
    const v = await createUser("catalog_editor");
    psql(`update public.releases set verified_by = '${v.id}' where id = '${s}';`);
    const vCopy = addCopy(v, s);
    const keep = addCopy(owner, s);
    await begin(a);
    const first = await a.asUser(admin.id, mergeSql(s, t));
    check("the merge holds its locks", !first.err, first.err);
    const deleting = b.run(`begin; delete from auth.users where id = '${v.id}';`);
    check("the account deletion waits for it", await waitingOnLock("mrg_b"));
    await a.run("commit;");
    const deleted = await deleting;
    await b.run("commit;");
    check("then completes, with no deadlock", !deadlocked(deleted) && !deleted.err && copyOn(vCopy) === "gone" && copyOn(keep) === t, deleted.err);
    createdUsers.delete(v.id);

    const s2 = makeRelease(g, "ntsc-uc");
    const v2 = await createUser("catalog_editor");
    psql(`update public.releases set verified_by = '${v2.id}' where id = '${s2}';`);
    addCopy(v2, s2);
    const keep2 = addCopy(owner, s2);
    const p = preview(editor, s2, t);
    await b.run(`begin; delete from auth.users where id = '${v2.id}';`);
    await begin(a);
    const waiting = a.asUser(admin.id, mergeSql(s2, t, p));
    check("the other way round, the merge waits for the deletion", await waitingOnLock("mrg_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("commit;");
    // Clearing a verifier doesn't change a release's revision, so the preview stands.
    check("then merges, with no deadlock, without the deleted owner's copy", !deadlocked(done) && !done.err
      && psql(`select copies_moved from private.catalog_merges where source_release_id = '${s2}';`) === "1" && copyOn(keep2) === t, done.err);
    createdUsers.delete(v2.id);
  }

  // -------------------------------------------------------------------------
  section("2. A submission's merge and its submitter's or reviewer's account deletion");
  {
    const g = makeGame("Submitter");
    const t = makeRelease(g, "ntsc-uc");
    const submitter = await createUser();
    const sub = submit(submitter, g, "ntsc-uc");
    const subCopy = addCopy(submitter, sub.release_id);
    const [req] = startReview(sub.release_id);
    await begin(a);
    const first = await a.asUser(editor.id, mergeSql(sub.release_id, t));
    check("the merge holds its locks", !first.err, first.err);
    const deleting = b.run(`begin; delete from auth.users where id = '${submitter.id}';`);
    check("the submitter's account deletion waits for it", await waitingOnLock("mrg_b"));
    await a.run("commit;");
    const deleted = await deleting;
    await b.run("commit;");
    check("then completes, with no deadlock", !deadlocked(deleted) && !deleted.err && copyOn(subCopy) === "gone"
      && psql(`select status || ' ' || (submitted_by is null) from public.catalog_change_requests where id = '${req}';`) === "merged true", deleted.err);
    createdUsers.delete(submitter.id);

    const submitter2 = await createUser();
    const w = await createUser("catalog_editor");
    const sub2 = submit(submitter2, g, "ntsc-uc");
    addCopy(submitter2, sub2.release_id);
    let [req2, ver2] = requestOf(sub2.release_id);
    sqlAs(w.id, `select public.start_submission_review('${req2}', ${ver2}, 'Checking');`);
    // As if w had decided on it before: the request names its reviewer.
    psql(`update public.catalog_change_requests set reviewed_by = '${w.id}', reviewed_at = now() where id = '${req2}';`);
    const p = preview(editor, sub2.release_id, t);
    await b.run(`begin; delete from auth.users where id = '${w.id}';`);
    await begin(a);
    const waiting = a.asUser(editor.id, mergeSql(sub2.release_id, t, p));
    check("the merge waits for the reviewer's account deletion", await waitingOnLock("mrg_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("rollback;");
    // The deletion changed the request, which the token covers.
    check("then is refused as stale, with no deadlock", !deadlocked(done) && errorOf(done) === "preview stale", done.err);
    const retried = merge(editor, sub2.release_id, t);
    check("and a fresh preview merges it, the reviewer gone from the request", retried.merge_id
      && psql(`select status || ' ' || (reviewed_by = '${editor.id}') from public.catalog_change_requests where id = '${req2}';`) === "merged true");
    createdUsers.delete(w.id);
  }

  // -------------------------------------------------------------------------
  section("3. A merge and an exclusion of its target, or of its source");
  {
    const g = makeGame("Exclusion");
    const t = makeRelease(g, "ntsc-uc");
    makeRelease(g, "pal");
    const s = makeRelease(g, "ntsc-uc");
    addCopy(owner, s);
    const exToken = (r) => sqlAs(editor.id, `select public.get_exclusion_preview('${r}') ->> 'token';`);
    const excludeSql = (r, tok) => `select public.exclude_release('${r}', '${tok}', 'no_game_data', 'Concurrency check', null, true, true);`;
    const tokT = exToken(t);
    await begin(a);
    const first = await a.asUser(admin.id, mergeSql(s, t));
    check("the merge holds its locks", !first.err, first.err);
    await begin(b);
    const excluding = b.asUser(reviewer.id, excludeSql(t, tokT));
    check("an exclusion of the target waits for it", await waitingOnLock("mrg_b"));
    await a.run("commit;");
    const ex = await excluding;
    await b.run("rollback;");
    check("then is refused, with no deadlock, and the merge stands", !deadlocked(ex) && ["preview stale", "exclusion blocked"].includes(errorOf(ex)) && releaseStatus(t) === "published" && releaseStatus(s) === "merged", ex.err);

    const s2 = makeRelease(g, "ntsc-uc");
    const p = preview(editor, s2, t);
    const tokS2 = exToken(s2);
    await begin(b);
    const firstEx = await b.asUser(reviewer.id, excludeSql(s2, tokS2));
    check("an exclusion of a source holds its locks", !firstEx.err, firstEx.err);
    await begin(a);
    const waiting = a.asUser(admin.id, mergeSql(s2, t, p));
    check("the merge waits for it", await waitingOnLock("mrg_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("rollback;");
    check("then is refused, with no deadlock: an excluded release isn't merged", !deadlocked(done) && errorOf(done) === "release unavailable" && releaseStatus(s2) === "excluded", done.err);
  }

  // -------------------------------------------------------------------------
  section("4. A merge and a restoration on the same game");
  {
    const g = makeGame("Restore");
    const t = makeRelease(g, "ntsc-uc");
    const x = makeRelease(g, "pal");
    makeRelease(g, "ntsc-j");
    const s = makeRelease(g, "ntsc-uc");
    const xTok = sqlAs(editor.id, `select public.get_exclusion_preview('${x}') ->> 'token';`);
    const exclusion = JSON.parse(sqlAs(editor.id, `select public.exclude_release('${x}', '${xTok}', 'no_game_data', 'Check', null, true, true)::text;`)).exclusion_id;
    const p = preview(editor, s, t);
    await begin(b);
    const restoring = await b.asUser(admin2.id, `select public.restore_exclusion('${exclusion}', 1, 'Restore check');`);
    check("a restoration holds its locks", !restoring.err, restoring.err);
    await begin(a);
    const waiting = a.asUser(admin.id, mergeSql(s, t, p));
    check("a merge on the same game waits for it", await waitingOnLock("mrg_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("commit;");
    check("then merges, with no deadlock", !deadlocked(done) && !done.err && releaseStatus(x) === "published" && releaseStatus(s) === "merged", done.err);
  }

  // -------------------------------------------------------------------------
  section("5. A submission's merge and a review decision on it");
  {
    const g = makeGame("Decision");
    const t = makeRelease(g, "ntsc-uc");
    const submitter = await createUser();
    const sub = submit(submitter, g, "pal");
    const [req, ver] = startReview(sub.release_id);
    const p = preview(editor, sub.release_id, t);
    await begin(b);
    const rejecting = await b.asUser(reviewer.id, `select public.reject_submission('${req}', ${ver}, 'Duplicate', null);`);
    check("a rejection holds its locks", !rejecting.err, rejecting.err);
    await begin(a);
    const waiting = a.asUser(editor.id, mergeSql(sub.release_id, t, p));
    check("the merge waits for it", await waitingOnLock("mrg_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("rollback;");
    check("then is refused, with no deadlock", !deadlocked(done) && errorOf(done) === "release unavailable" && releaseStatus(sub.release_id) === "rejected", done.err);

    const sub2 = submit(submitter, g, "ntsc-j");
    const [req2, ver2] = startReview(sub2.release_id);
    await begin(a);
    const first = await a.asUser(editor.id, mergeSql(sub2.release_id, t));
    check("the merge holds its locks", !first.err, first.err);
    await begin(b);
    const deciding = b.asUser(reviewer.id, `select public.reject_submission('${req2}', ${ver2}, 'Duplicate', null);`);
    check("a rejection waits for it", await waitingOnLock("mrg_b"));
    await a.run("commit;");
    const decided = await deciding;
    await b.run("rollback;");
    check("then is refused, with no deadlock", !deadlocked(decided) && errorOf(decided) !== "" && releaseStatus(sub2.release_id) === "merged", decided.err);
  }

  // -------------------------------------------------------------------------
  section("6. A merge and an owner relinking a copy of the source");
  {
    const g = makeGame("Relink");
    const t = makeRelease(g, "ntsc-uc");
    const other = makeRelease(g, "pal");
    const s = makeRelease(g, "ntsc-uc");
    const moving = addCopy(owner, s);
    const staying = addCopy(owner, s);
    const p = preview(editor, s, t);
    await b.run("begin;");
    const relinked = await b.asUser(owner.id, `select public.relink_my_copy('${moving}', '${other}');`);
    check("a relink holds its locks", !relinked.err, relinked.err);
    await begin(a);
    const waiting = a.asUser(admin.id, mergeSql(s, t, p));
    check("the merge waits for it", await waitingOnLock("mrg_a"));
    await b.run("commit;");
    const done = await waiting;
    await a.run("commit;");
    check("then merges, with no deadlock, moving only the copy still on the source", !deadlocked(done) && !done.err && copyOn(moving) === other && copyOn(staying) === t, done.err);

    const s2 = makeRelease(g, "ntsc-uc");
    const c2 = addCopy(owner, s2);
    await begin(a);
    const first = await a.asUser(admin.id, mergeSql(s2, t));
    check("the merge holds its locks", !first.err, first.err);
    await b.run("begin;");
    const relinking = b.asUser(owner.id, `select public.relink_my_copy('${c2}', '${other}');`);
    check("a relink of one of its copies waits for it", await waitingOnLock("mrg_b"));
    await a.run("commit;");
    const r2 = await relinking;
    await b.run("commit;");
    check("then completes, with no deadlock, and the copy is never lost", !deadlocked(r2) && [t, other].includes(copyOn(c2)), r2.err);
  }

  // -------------------------------------------------------------------------
  section("7. A copy owner the merge can't lock without waiting, and a retry");
  {
    const g = makeGame("Nowait");
    const t = makeRelease(g, "ntsc-uc");
    const s = makeRelease(g, "ntsc-uc");
    const keep = addCopy(owner, s);
    const newcomer = await createUser();
    const p = preview(editor, s, t);
    // d holds the game, so the merge stops after its first profile locks.
    await d.run(`begin; select 1 from public.games where id = '${g}' for share;`);
    // Nothing else holds the profiles the merge will lock, d included.
    check("before the merge, neither the administrator's nor the copy owner's profile is locked", profileLock(admin.id) === "free" && profileLock(owner.id) === "free");
    await begin(a);
    const merging = a.asUser(admin.id, mergeSql(s, t, p));
    check("the merge waits for the game, and only for the game", await waitingForGame("mrg_a", "mrg_d"));
    // Its own profile is locked as it starts (begin_catalog_edit); the copy owner's
    // only by the profile locks the merge takes before any catalog row.
    check("while the merge waits, it holds the administrator's profile", profileLock(admin.id) === "locked");
    check("the merge holds the copy owner's profile before any catalog row", profileLock(owner.id) === "locked");
    const late = addCopy(newcomer, s);
    check("meanwhile a new owner adds a copy", copyOn(late) === s);
    const deleting = await c.run(`begin; delete from auth.users where id = '${newcomer.id}';`);
    check("and their account deletion is in progress", !deleting.err, deleting.err);
    await d.run("commit;");
    const prompt = await settlesWithin(merging, 5000);
    check("once it has the game, it doesn't wait for that owner's deletion", prompt);
    const done = await merging;
    check("the merge can't lock that owner without waiting, so it stops with a retryable conflict", !deadlocked(done) && errorOf(done) === "request conflict", done.err);
    check("which names no lock or table", !/profiles|lock|nowait/i.test(errorOf(done)));
    await a.run("rollback;");
    check("its lock timeout ended with its transaction", (await a.run("show lock_timeout;")).out === "0");
    check("and nothing it did is kept: release, copies, merge, notices and audit",
      releaseStatus(s) === "published" && copyOn(keep) === s && merges(s) === "0"
      && psql(`select count(*) from private.audit_events where action = 'catalog_release_merged' and metadata ->> 'id' = '${s}';`) === "0");
    await c.run("commit;");
    createdUsers.delete(newcomer.id);
    const retried = merge(admin, s, t);
    check("a retry merges it", retried.copies === 1 && copyOn(keep) === t && copyOn(late) === "gone");
  }

  // -------------------------------------------------------------------------
  section("8. Crossing merges, and a merge into a source being merged");
  {
    const g = makeGame("Crossing");
    const x = makeRelease(g, "ntsc-uc");
    const y = makeRelease(g, "ntsc-uc");
    const pYX = preview(editor, y, x);
    await begin(a);
    const first = await a.asUser(admin.id, mergeSql(x, y));
    check("a merge of x into y holds its locks", !first.err, first.err);
    await begin(b);
    const crossing = b.asUser(admin2.id, mergeSql(y, x, pYX));
    check("a merge of y into x waits for it", await waitingOnLock("mrg_b"));
    await a.run("commit;");
    const crossed = await crossing;
    await b.run("rollback;");
    check("then is refused, with no deadlock and no cycle", !deadlocked(crossed) && errorOf(crossed) === "target unavailable"
      && psql(`select merged_into_id from public.releases where id = '${x}';`) === y && releaseStatus(y) === "published", crossed.err);

    const s = makeRelease(g, "ntsc-uc");
    const t = makeRelease(g, "ntsc-uc");
    const early = makeRelease(g, "ntsc-uc");
    const pEarly = preview(editor, early, s);
    await begin(b);
    const into = await b.asUser(admin2.id, mergeSql(early, s, pEarly));
    check("a merge into s holds its locks", !into.err, into.err);
    const pS = preview(editor, s, t);
    await begin(a);
    const waiting = a.asUser(admin.id, mergeSql(s, t, pS));
    check("a merge of s waits for it", await waitingOnLock("mrg_a"));
    await b.run("commit;");
    const stale = await waiting;
    await a.run("rollback;");
    check("then is refused as stale, with no deadlock", !deadlocked(stale) && errorOf(stale) === "preview stale", stale.err);
    const retried = merge(admin, s, t);
    check("and a fresh merge flattens what was merged into s", retried.merge_id && psql(`select merged_into_id from public.releases where id = '${early}';`) === t);
  }

  // -------------------------------------------------------------------------
  section("9. An import holding the source, and a failure at commit");
  {
    const g = makeGame("Import");
    const t = makeRelease(g, "ntsc-uc");
    const s = makeRelease(g, "ntsc-uc");
    const item = addCopy(owner, s);
    psql(`insert into private.external_references (provider_code, external_id, release_id) values ('wikidata', 'Q-${PREFIX.replace(/\W/g, "")}', '${s}');`);
    const p = preview(editor, s, t);
    await b.run(`begin; select 1 from public.releases where id = '${s}' for update;`);
    await begin(a);
    const waiting = a.asUser(admin.id, mergeSql(s, t, p));
    check("a merge waits for an import holding the source", await waitingOnLock("mrg_a"));
    await b.run("commit;");
    const done = await waiting;
    check("then merges, with no deadlock", !deadlocked(done) && !done.err, done.err);
    // Something later in the same transaction breaks the publication rules.
    const broke = await a.run(`update public.game_platforms set status = 'excluded' where game_id = '${g}';`);
    check("a later change in the transaction is accepted until commit", !broke.err, broke.err);
    const committed = await a.run("commit;");
    check("then the commit fails on the publication rules", /published/.test(errorOf(committed)), committed.err);
    check("and nothing the merge did is kept: release, copy, references, merge, notices and audit",
      releaseStatus(s) === "published" && copyOn(item) === s && merges(s) === "0"
      && psql(`select count(*) from private.external_references where release_id = '${s}';`) === "1"
      && psql(`select count(*) from public.notifications where recipient_id = '${owner.id}' and type = 'catalog_merge' and data ->> 'merge_id' not in (select id::text from private.catalog_merges);`) === "0"
      && psql(`select count(*) from private.audit_events where action = 'catalog_release_merged' and metadata ->> 'id' = '${s}';`) === "0");
  }
} catch (caught) {
  check("the checks ran to the end", false, caught.message);
} finally {
  for (const s of [a, b, c, d]) s.close();
  // A session left waiting on a lock would keep its transaction, and its locks, open
  // and hold up the cleanup: end each one's backend. Their settings went with them.
  psql(`select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name in (${[a, b, c, d].map((s) => `'${s.name}'`).join(", ")});`);
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
