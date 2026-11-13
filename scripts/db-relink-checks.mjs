/**
 * M7b-2a checks against the running local stack: relinking through the real API, and
 * deterministic races between adding or moving a copy and a change to a release's
 * status, or the owner's account deletion. Each race uses two database sessions: one
 * holds its change open, the script confirms the other is waiting on a lock, then the
 * first commits, so the outcome doesn't depend on timing. Uses the local catalog
 * fixture (scripts/catalog-fixture.mjs) and removes it, every copy and every test
 * account after.
 *
 * Local only. Prints check names and statuses, never keys or tokens.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installFixture, removeFixture } from "./catalog-fixture.mjs";

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

async function request(method, path, headers, body, prefer = "return=representation") {
  const response = await fetch(`${api}${path}`, { method, headers: { ...headers, Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, text };
}
const rpc = (headers, fn, args = {}) => request("POST", `/rest/v1/rpc/${fn}`, headers, args);
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
// Submissions made here, found by id: an account deleted mid-test leaves them unowned.
const submissions = new Set();
const submitted = (r) => {
  if (r.body?.submission_id) submissions.add(r.body.submission_id);
  return r;
};
async function createUser() {
  const email = `rlnk-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await fetch(`${api}/auth/v1/admin/users`, { method: "POST", headers: service, body: JSON.stringify({ email, password, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  everyUser.add(user.id);
  response = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: "POST", headers: anon, body: JSON.stringify({ email, password }) });
  const session = await response.json();
  const claimed = await rpc(asUser(session.access_token), "claim_handle", { p_handle: `rk_${randomBytes(6).toString("hex")}` });
  if (claimed.status !== 200) throw new Error(`could not claim a handle: status ${claimed.status}`);
  return { id: user.id, headers: asUser(session.access_token) };
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
  /** Sends a statement; the promise resolves with its output and errors once it finishes. */
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
        } else if (Date.now() - started > 30000) {
          clearInterval(poll);
          reject(new Error(`${this.name} didn't finish: ${sql.slice(0, 60)}`));
        }
      }, 20);
    });
  }
  /** Runs SQL as a signed-in user, inside the session's open transaction. */
  asUser(userId, sql) {
    return this.run(`select set_config('request.jwt.claims', '{"sub": "${userId}", "role": "authenticated"}', true); set local role authenticated; ${sql} reset role;`);
  }
  close() {
    this.child.stdin.end();
  }
}

/** Whether a session is waiting on a lock right now. */
async function waitingOnLock(name) {
  for (let i = 0; i < 100; i += 1) {
    if (psql(`select count(*) from pg_stat_activity where application_name = '${name}' and wait_event_type = 'Lock';`) === "1") return true;
    await pause(50);
  }
  return false;
}
const deadlocked = (result) => /deadlock/i.test(result?.err ?? "");

async function cleanup() {
  const ids = [...everyUser].map((id) => `'${id}'`).join(",") || "null";
  psql(`begin;
delete from public.collection_items where owner_id in (${ids});
create temp table sub_requests on commit drop as select * from public.catalog_change_requests where submitted_by in (${ids}) or id in (${[...submissions].map((id) => `'${id}'`).join(",") || "null"});
delete from public.releases where submitted_by in (${ids}) or id in (select release_id from sub_requests);
delete from public.catalog_change_requests where id in (select id from sub_requests);
commit;`);
  let fixtureRemoved = true;
  try {
    removeFixture();
  } catch {
    fixtureRemoved = false;
  }
  check("the catalog fixture can be removed", fixtureRemoved);
  let deletions = 0;
  for (const id of createdUsers) {
    const response = await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
    if (response.ok || response.status === 404) deletions += 1;
  }
  check("every test account is removed", deletions === createdUsers.size, `${deletions} of ${createdUsers.size}`);
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'rk\\_%';");
  check("no copies or catalog data are left behind",
    psql("select (select count(*) from public.collection_items) + (select count(*) from public.games) + (select count(*) from public.releases) + (select count(*) from public.catalog_change_requests);") === "0");
}

try {
  installFixture();
  const release = (code) => psql(`select id from public.releases where product_code = '${code}' and status = 'published';`);
  const us = release("SNS-ZSFE-USA");
  const eu = release("SNSP-ZSFP-EUR");
  const jp = release("SHVC-ZSFJ-JPN");
  const starfall = psql("select game_id from public.releases where product_code = 'SNS-ZSFE-USA';");
  const owner = await createUser();
  const other = await createUser();
  const add = async (user, releaseId, details = {}) => {
    const id = uuidv7();
    const r = await rpc(user.headers, "add_collection_item", { p_item_id: id, p_release: releaseId, p_details: details });
    if (r.body?.created !== true) throw new Error(`couldn't add a copy: ${r.text}`);
    return id;
  };
  const onRelease = (item) => psql(`select release_id from public.collection_items where id = '${item}';`);
  const state = (item) => psql(`select concat_ws(' | ', (select (to_jsonb(c) - array['release_id', 'updated_at', 'record_status', 'invalidated_at'])::text from public.collection_items c where c.id = '${item}'),
    (select to_jsonb(p)::text from public.collection_item_private p where p.item_id = '${item}'),
    (select string_agg(to_jsonb(x)::text, ',' order by x.kind, x.label) from public.collection_item_components x where x.item_id = '${item}'));`);

  section("Relinking over the API");
  const piece = psql(`select kind || ':' || label from public.release_components where release_id = '${us}' limit 1;`);
  const [pieceKind, pieceLabel] = piece.split(":");
  const copy = await add(owner, us, { completeness: "complete", box_condition: "good", purchase_price: "30", currency: "EUR", notes: "Mine", storage_location: "Shelf B", components: pieceLabel ? [{ kind: pieceKind, label: pieceLabel, condition: "good" }] : [] });
  const before = state(copy);
  check("a visitor can't relink", isDenied(await rpc(anon, "relink_my_copy", { p_item: copy, p_release: eu })));
  check("service_role can't", isDenied(await rpc(service, "relink_my_copy", { p_item: copy, p_release: eu })));
  check("another collector can't move someone's copy", error(await rpc(other.headers, "relink_my_copy", { p_item: copy, p_release: eu }), "item unavailable") && onRelease(copy) === us);
  const direct = await request("PATCH", `/rest/v1/collection_items?id=eq.${copy}`, owner.headers, { release_id: eu }, "return=minimal");
  check("the owner can't change a copy's release directly", (direct.status === 401 || direct.status === 403) && onRelease(copy) === us, `status ${direct.status}`);
  const forged = await request("PATCH", `/rest/v1/collection_items?id=eq.${copy}`, owner.headers, { record_status: "active", owner_id: other.id }, "return=minimal");
  check("or any column relinking sets", (forged.status === 401 || forged.status === 403) && state(copy) === before, `status ${forged.status}`);
  const pending = submitted(await rpc(other.headers, "submit_release", { p_game: starfall, p_platform: "snes", p_media_format: "rom-cartridge", p_region: "pal", p_details: { product_code: "RLK-OTHER" }, p_components: [], p_physical: true }));
  const hidden = await rpc(owner.headers, "relink_my_copy", { p_item: copy, p_release: pending.body?.release_id });
  const missing = await rpc(owner.headers, "relink_my_copy", { p_item: copy, p_release: randomUUID() });
  check("someone else's pending submission reads like a release that doesn't exist", error(hidden, "release unavailable") && hidden.text === missing.text);
  const moved = await rpc(owner.headers, "relink_my_copy", { p_item: copy, p_release: eu });
  check("the owner moves their copy", moved.body?.moved === true && onRelease(copy) === eu, moved.text);
  check("keeping its conditions, private details and piece records", state(copy) === before);

  section("A copy against a change to its release, deterministically");
  const a = new Session("relink_a");
  const b = new Session("relink_b");
  try {
    // 1. The release changes first; adding a copy waits, then sees the change.
    await a.run(`begin; update public.releases set status = 'excluded' where id = '${jp}';`);
    const item1 = uuidv7();
    const adding = b.run(`begin; select set_config('request.jwt.claims', '{"sub": "${owner.id}", "role": "authenticated"}', true); set local role authenticated; select public.add_collection_item('${item1}', '${jp}', '{}');`);
    check("adding a copy waits for a release whose status is changing", await waitingOnLock("relink_b"));
    await a.run("commit;");
    const added = await adding;
    await b.run("rollback;");
    check("and is refused once the release is excluded", /release unavailable/.test(added.err) && psql(`select count(*) from public.collection_items where id = '${item1}';`) === "0", added.err);
    psql(`update public.releases set status = 'published' where id = '${jp}';`);

    // 2. A copy is added first; the status change waits, then sees the copy.
    const item2 = uuidv7();
    const first = await b.run(`begin; select set_config('request.jwt.claims', '{"sub": "${owner.id}", "role": "authenticated"}', true); set local role authenticated; select public.add_collection_item('${item2}', '${jp}', '{}'); reset role;`);
    check("a copy is being added", !first.err, first.err);
    const changing = a.run(`begin; update public.releases set status = 'excluded' where id = '${jp}';`);
    check("a status change waits for the copy being added", await waitingOnLock("relink_a"));
    await b.run("commit;");
    await changing;
    const seen = await a.run(`select count(*) from public.collection_items where release_id = '${jp}' and id = '${item2}';`);
    check("and then finds it, as an exclusion would", seen.out.endsWith("1"), seen.out);
    await a.run("rollback;");

    // 3. The target changes first; relinking waits, then is refused.
    await a.run(`begin; update public.releases set status = 'excluded' where id = '${us}';`);
    const relinking = b.run(`begin; select set_config('request.jwt.claims', '{"sub": "${owner.id}", "role": "authenticated"}', true); set local role authenticated; select public.relink_my_copy('${copy}', '${us}');`);
    check("relinking waits for a target whose status is changing", await waitingOnLock("relink_b"));
    await a.run("commit;");
    const relinked = await relinking;
    await b.run("rollback;");
    check("and is refused once it's excluded, leaving the copy where it was", /release unavailable/.test(relinked.err) && onRelease(copy) === eu, relinked.err);
    psql(`update public.releases set status = 'published' where id = '${us}';`);

    // 4. Relinking first; the status change waits for it.
    const firstMove = await b.run(`begin; select set_config('request.jwt.claims', '{"sub": "${owner.id}", "role": "authenticated"}', true); set local role authenticated; select public.relink_my_copy('${copy}', '${us}'); reset role;`);
    check("a copy is being moved", !firstMove.err, firstMove.err);
    const changing2 = a.run(`begin; update public.releases set status = 'excluded' where id = '${us}';`);
    check("a status change of the target waits for the move", await waitingOnLock("relink_a"));
    await b.run("commit;");
    await changing2;
    const moved2 = await a.run(`select release_id from public.collection_items where id = '${copy}';`);
    check("and then finds the copy on it", moved2.out.endsWith(us), moved2.out);
    await a.run("rollback;");

    // 5. The copy's current release changes; relinking away waits, then succeeds.
    await a.run(`begin; update public.releases set status = 'excluded' where id = '${us}';`);
    const away = b.run(`begin; select set_config('request.jwt.claims', '{"sub": "${owner.id}", "role": "authenticated"}', true); set local role authenticated; select public.relink_my_copy('${copy}', '${eu}'); reset role;`);
    check("relinking away from a release being changed waits for it, release before copy", await waitingOnLock("relink_b"));
    await a.run("rollback;");
    const awayDone = await away;
    await b.run("commit;");
    check("and then moves the copy", !awayDone.err && onRelease(copy) === eu, awayDone.err);

    // 6. An account deletion against the owner adding a copy to their own pending release.
    const leaving = await createUser();
    const own = submitted(await rpc(leaving.headers, "submit_release", { p_game: starfall, p_platform: "snes", p_media_format: "rom-cartridge", p_region: "ntsc-j", p_details: { product_code: "RLK-LEAVE" }, p_components: [], p_physical: true }));
    await a.run(`begin; delete from auth.users where id = '${leaving.id}';`);
    const item3 = uuidv7();
    const addingOwn = b.run(`begin; select set_config('request.jwt.claims', '{"sub": "${leaving.id}", "role": "authenticated"}', true); set local role authenticated; select public.add_collection_item('${item3}', '${own.body?.release_id}', '{}');`);
    check("adding a copy waits for its owner's account deletion", await waitingOnLock("relink_b"));
    const deletedFirst = await a.run("commit;");
    const addedLate = await addingOwn;
    await b.run("rollback;");
    check("which completes, with no deadlock, and no copy is left", !deletedFirst.err && !deadlocked(addedLate) && psql(`select count(*) from public.collection_items where id = '${item3}';`) === "0", addedLate.err);
    createdUsers.delete(leaving.id);

    const leaving2 = await createUser();
    const own2 = submitted(await rpc(leaving2.headers, "submit_release", { p_game: starfall, p_platform: "snes", p_media_format: "rom-cartridge", p_region: "ntsc-uc", p_details: { product_code: "RLK-LEAVE2" }, p_components: [], p_physical: true }));
    const item4 = uuidv7();
    const addFirst = await b.run(`begin; select set_config('request.jwt.claims', '{"sub": "${leaving2.id}", "role": "authenticated"}', true); set local role authenticated; select public.add_collection_item('${item4}', '${own2.body?.release_id}', '{}'); reset role;`);
    check("an owner adds a copy of their own pending release", !addFirst.err, addFirst.err);
    const deleting = a.run(`begin; delete from auth.users where id = '${leaving2.id}';`);
    check("their account deletion waits for it", await waitingOnLock("relink_a"));
    await b.run("commit;");
    const deleted = await deleting;
    await a.run("commit;");
    check("then completes, with no deadlock, removing the copy", !deadlocked(deleted) && !deleted.err && psql(`select count(*) from public.collection_items where id = '${item4}';`) === "0", deleted.err);
    createdUsers.delete(leaving2.id);
  } finally {
    a.close();
    b.close();
  }
} catch (caught) {
  check("the checks ran to the end", false, caught.message);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
