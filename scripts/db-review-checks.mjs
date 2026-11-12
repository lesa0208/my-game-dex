/**
 * M7b-1 catalog review checks against the running local stack, through the real API,
 * as anon, collectors, a moderator, catalog editors and service_role, with concurrent
 * requests: two editors acting at once, a review against a withdrawal or an edit, a
 * review against an account deletion, and a withdrawal against an approval on the
 * same game and pairing. Uses the local catalog fixture (scripts/catalog-fixture.mjs),
 * and removes it, every submitted record and every test account after. Staff roles
 * are temporary and go with their accounts. pgTAP covers the rules; this covers what
 * clients can do and what happens when requests race.
 *
 * Local only. Prints check names and statuses, never keys or tokens.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installFixture, removeFixture } from "./catalog-fixture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];
const psqlArgs = ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"];
const psql = (sql) => execFileSync("docker", psqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` (${detail})` : ""}`);
}
const section = (title) => console.log(`\n${title}`);

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

async function request(method, path, headers, body) {
  const response = await fetch(`${api}${path}`, { method, headers: { ...headers, Prefer: "return=representation" }, body: body === undefined ? undefined : JSON.stringify(body) });
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
const table = (headers, path) => request("GET", `/rest/v1/${path}`, headers);
const isDenied = (r) => r.status === 401 || r.status === 403;
const error = (r, message) => r.status >= 400 && r.body?.message === message && !r.body?.details && !r.body?.hint;
const deadlocked = (r) => r.body?.code === "40P01" || /deadlock/i.test(r.text ?? "");

const createdUsers = new Set();
// Every account made, including ones a check deletes itself, for the audit cleanup.
const everyUser = new Set();
const submissions = new Set();
async function createUser(role) {
  const email = `rev-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await fetch(`${api}/auth/v1/admin/users`, { method: "POST", headers: service, body: JSON.stringify({ email, password, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  everyUser.add(user.id);
  response = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: "POST", headers: anon, body: JSON.stringify({ email, password }) });
  const session = await response.json();
  const claimed = await rpc(asUser(session.access_token), "claim_handle", { p_handle: `rv_${randomBytes(6).toString("hex")}` });
  if (claimed.status !== 200) throw new Error(`could not claim a handle: status ${claimed.status}`);
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { id: user.id, email, headers: asUser(session.access_token) };
}
const deleteUser = (user) => fetch(`${api}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: service });

let serial = 0;
async function submit(user, game) {
  serial += 1;
  const r = await rpc(user.headers, "submit_release", {
    p_game: game, p_platform: "snes", p_media_format: "rom-cartridge", p_region: "pal",
    p_details: { product_code: `QZR-${process.pid}-${serial}` }, p_components: [], p_physical: true,
  });
  if (r.body?.outcome !== "submitted") throw new Error(`submission refused: ${r.text}`);
  submissions.add(r.body.submission_id);
  return r.body;
}
const detail = async (editor, id) => (await rpc(editor.headers, "get_submission_review", { p_request: id })).body;
const reason = "Checked against the photos";
const start = async (editor, id, version) =>
  rpc(editor.headers, "start_submission_review", { p_request: id, p_expected_version: version ?? (await detail(editor, id)).request.version, p_reason: reason });
const fix = (editor, releaseId, changes = { edition_name: "Standard", edition_kind: "standard", media_count: 1 }) =>
  rpc(editor.headers, "update_release", { p_release: releaseId, p_changes: changes, p_reason: reason });
const approveWith = (editor, id, d) =>
  rpc(editor.headers, "approve_submission", { p_request: id, p_expected_version: d.request.version, p_release_revision: d.release.revision, p_game_revision: d.game?.revision ?? null, p_reason: reason });
const rejectWith = (editor, id, d) => rpc(editor.headers, "reject_submission", { p_request: id, p_expected_version: d.request.version, p_reason: reason, p_note: null });
async function ready(editor, id, releaseId) {
  await start(editor, id);
  await fix(editor, releaseId);
  return detail(editor, id);
}
const requestStatus = (id) => psql(`select status from public.catalog_change_requests where id = '${id}';`);

async function cleanup() {
  const ids = [...createdUsers].map((id) => `'${id}'`).join(",") || "null";
  const subs = [...submissions].map((id) => `'${id}'`).join(",") || "null";
  // Submitted records first, published ones included: they're found through the requests,
  // since publication clears submitted_by. A whole new game goes in one transaction.
  psql(`begin;
delete from public.collection_items where owner_id in (${ids});
create temp table sub_requests on commit drop as select * from public.catalog_change_requests where submitted_by in (${ids}) or id in (${subs});
delete from public.releases where submitted_by in (${ids}) or id in (select release_id from sub_requests);
delete from public.game_platforms where submitted_by in (${ids}) or game_id in (select game_id from sub_requests where created_game);
delete from public.catalog_change_requests where id in (select id from sub_requests);
delete from public.games where submitted_by in (${ids}) or id in (select game_id from sub_requests where created_game);
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
  if (everyUser.size) {
    const all = [...everyUser].map((id) => `'${id}'`).join(",");
    psql(`begin;
set local session_replication_role = replica;
delete from private.audit_events where actor_id in (${all}) or target_profile_id in (${all});
commit;`);
  }
  psql("delete from private.handle_holds where kind = 'released' and handle like 'rv\\_%';");
  check("no submissions, catalog data or notifications are left behind",
    psql("select (select count(*) from public.catalog_change_requests) + (select count(*) from public.games) + (select count(*) from public.releases) + (select count(*) from public.collection_items) + (select count(*) from public.notifications) + (select count(*) from private.audit_events);") === "0");
}

try {
  installFixture();
  const starfall = psql("select id from public.games where title = 'Starfall Odyssey' and status = 'published';");
  const submitter = await createUser();
  const collector = await createUser();
  const moderator = await createUser("moderator");
  const editor = await createUser("catalog_editor");
  const editor2 = await createUser("catalog_editor");

  section("Who can review");
  const first = await submit(submitter, starfall);
  check("a visitor can't", isDenied(await rpc(anon, "get_submission_queue")) && isDenied(await rpc(anon, "start_submission_review", { p_request: first.submission_id, p_expected_version: 1, p_reason: reason })));
  check("service_role can't", isDenied(await rpc(service, "get_submission_queue")) && isDenied(await rpc(service, "get_submission_review", { p_request: first.submission_id })));
  check("a collector can't", error(await rpc(collector.headers, "get_submission_queue"), "not permitted") && error(await start(collector, first.submission_id, 1), "not permitted"));
  check("a moderator can't", error(await rpc(moderator.headers, "get_submission_review", { p_request: first.submission_id }), "not permitted"));
  check("they're told so", (await rpc(collector.headers, "can_review_submissions")).body === false && (await rpc(moderator.headers, "can_review_submissions")).body === false);
  check("a catalog editor can", (await rpc(editor.headers, "can_review_submissions")).body === true);
  const queue = await rpc(editor.headers, "get_submission_queue", { p_status: "all" });
  check("and reads the queue", queue.status === 200 && queue.body?.items?.some((i) => i.id === first.submission_id), queue.text);
  const page = await detail(editor, first.submission_id);
  check("and a submission, with the submitter's handle", typeof page?.submitter?.handle === "string" && page.submitter.deleted === false);
  check("but never their email address", !queue.text.includes(submitter.email) && !JSON.stringify(page).includes(submitter.email) && !JSON.stringify(page).includes("@example.test"));
  check("no client reads the review record directly, editors included", isDenied(await table(editor.headers, "catalog_change_requests?select=id")));
  check("or writes the catalog directly", isDenied(await request("PATCH", `/rest/v1/releases?id=eq.${first.release_id}`, editor.headers, { status: "published" })));
  check("or a notification", isDenied(await request("POST", "/rest/v1/notifications", editor.headers, { recipient_id: submitter.id, type: "catalog_submission", data: { status: "published", submission_id: first.submission_id } })));

  section("A review over the API");
  check("a stale page can't start it", error(await start(editor, first.submission_id, page.request.version + 1), "request conflict"));
  check("an editor starts it", (await start(editor, first.submission_id)).status === 200);
  check("the submitter can't withdraw it now", error(await rpc(submitter.headers, "withdraw_my_submission", { p_submission: first.submission_id }), "submission locked"));
  check("an editor corrects it", (await fix(editor, first.release_id)).body === true);
  let d = await detail(editor, first.submission_id);
  check("it can't be verified outside the review", error(await rpc(editor2.headers, "verify_release", { p_release: first.release_id, p_reason: reason, p_expected_revision: d.release.revision }), "review required"));
  const approved = await approveWith(editor, first.submission_id, d);
  check("approval publishes it", approved.status === 200 && psql(`select status from public.releases where id = '${first.release_id}';`) === "published", approved.text);
  check("the submitter sees it published", (await rpc(submitter.headers, "get_my_submission", { p_submission: first.submission_id })).body?.status === "published");
  const notices = (await rpc(submitter.headers, "get_my_notifications")).body ?? [];
  const notice = notices.find((n) => n.type === "catalog_submission");
  check("and is notified, without the reviewer", notice?.actor_id === null && notice?.actor_handle === null
    && JSON.stringify(Object.keys(notice?.data ?? {}).sort()) === JSON.stringify(["status", "submission_id"]), JSON.stringify(notice));
  check("and it's public", (await table(anon, `releases?id=eq.${first.release_id}&select=id`)).body?.length === 1);

  section("Two editors at once");
  {
    const s = await submit(submitter, starfall);
    const ready1 = await ready(editor, s.submission_id, s.release_id);
    const both = await Promise.all([approveWith(editor, s.submission_id, ready1), approveWith(editor2, s.submission_id, ready1)]);
    const wins = both.filter((r) => r.status === 200).length;
    check("two approvals of one submission: exactly one succeeds", wins === 1 && both.some((r) => error(r, "request conflict")), both.map((r) => r.text).join(" | "));
    check("and it's approved once", psql(`select count(*) from private.audit_events where action = 'catalog_submission_approved' and metadata ->> 'request_id' = '${s.submission_id}';`) === "1");
  }
  {
    const s = await submit(submitter, starfall);
    const ready2 = await ready(editor, s.submission_id, s.release_id);
    const both = await Promise.all([approveWith(editor, s.submission_id, ready2), rejectWith(editor2, s.submission_id, ready2)]);
    const wins = both.filter((r) => r.status === 200).length;
    const final = requestStatus(s.submission_id);
    check("an approval and a rejection at once: exactly one wins", wins === 1 && ["approved", "rejected"].includes(final), `${final}: ${both.map((r) => r.text).join(" | ")}`);
  }
  {
    const s = await submit(submitter, starfall);
    await start(editor, s.submission_id);
    const read = await detail(editor, s.submission_id);
    const fixes = await Promise.all([fix(editor, s.release_id), fix(editor2, s.release_id, { publisher_name: "Qzs Soft" })]);
    check("two corrections at once both apply", fixes.every((r) => r.body === true), fixes.map((r) => r.text).join(" | "));
    const stale = await approveWith(editor, s.submission_id, read);
    check("and an approval of the page read before them is refused", error(stale, "record changed"), stale.text);
  }

  section("A review against the submitter");
  {
    // A fresh submitter for each run of races, so the daily limit isn't what's tested.
    let racer = await createUser();
    let outcomes = [];
    for (let i = 0; i < 4; i += 1) {
      const s = await submit(racer, starfall);
      const read = await detail(editor, s.submission_id);
      const [started, withdrawn] = await Promise.all([start(editor, s.submission_id, read.request.version), rpc(racer.headers, "withdraw_my_submission", { p_submission: s.submission_id })]);
      const final = requestStatus(s.submission_id);
      const release = psql(`select count(*) from public.releases where id = '${s.release_id}';`);
      const consistent = (started.status === 200 && error(withdrawn, "submission locked") && final === "in_review" && release === "1")
        || (withdrawn.status === 200 && (error(started, "request conflict") || error(started, "submission unavailable")) && final === "withdrawn" && release === "0");
      outcomes.push(consistent && !deadlocked(started) && !deadlocked(withdrawn));
    }
    check("starting a review while it's withdrawn: one wins, consistently, four times", outcomes.every(Boolean), JSON.stringify(outcomes));
    outcomes = [];
    racer = await createUser();
    for (let i = 0; i < 4; i += 1) {
      const s = await submit(racer, starfall);
      const read = await detail(editor, s.submission_id);
      const [started, edited] = await Promise.all([start(editor, s.submission_id, read.request.version), rpc(racer.headers, "update_my_submission", { p_submission: s.submission_id, p_changes: { note: `Edit ${i}` } })]);
      const final = requestStatus(s.submission_id);
      outcomes.push((started.status === 200 && error(edited, "submission locked") && final === "in_review")
        || (edited.status === 200 && error(started, "request conflict") && final === "open"));
    }
    check("starting a review while it's edited: one wins, four times", outcomes.every(Boolean), JSON.stringify(outcomes));
  }

  section("A review against an account deletion");
  {
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) {
      const leaving = await createUser();
      const s = await submit(leaving, starfall);
      await start(editor, s.submission_id);
      const read = await detail(editor, s.submission_id);
      const [rejected, deleted] = await Promise.all([rejectWith(editor, s.submission_id, read), deleteUser(leaving)]);
      const row = psql(`select status || '/' || (submitted_by is null) from public.catalog_change_requests where id = '${s.submission_id}';`);
      outcomes.push(deleted.ok && !deadlocked(rejected)
        && ((rejected.status === 200 && row === "rejected/true") || (error(rejected, "request conflict") && row === "in_review/true")));
      createdUsers.delete(leaving.id);
    }
    check("rejecting while the submitter deletes their account: no deadlock, a consistent result", outcomes.every(Boolean), JSON.stringify(outcomes));
    const orphan = await submit(await createUser(), starfall);
    const owner = [...createdUsers].at(-1);
    await deleteUser({ id: owner });
    createdUsers.delete(owner);
    const orphanPage = await detail(editor, orphan.submission_id);
    check("an unowned submission shows as from a deleted account", orphanPage?.submitter?.deleted === true);
    await start(editor, orphan.submission_id);
    check("changes can't be requested of it", error(await rpc(editor.headers, "request_submission_changes", {
      p_request: orphan.submission_id, p_expected_version: (await detail(editor, orphan.submission_id)).request.version, p_note: "Which edition?", p_reason: reason }), "submitter unavailable"));
    await fix(editor, orphan.release_id);
    check("but it can be approved", (await approveWith(editor, orphan.submission_id, await detail(editor, orphan.submission_id))).status === 200);
  }

  section("A withdrawal against an approval on the same game and pairing");
  {
    const outcomes = [];
    const other = await createUser();
    const withdrawer = await createUser();
    for (let i = 0; i < 5; i += 1) {
      const leaving = await submit(withdrawer, starfall);
      const s = await submit(other, starfall);
      const read = await ready(editor, s.submission_id, s.release_id);
      const [withdrawn, approvedNow] = await Promise.all([rpc(withdrawer.headers, "withdraw_my_submission", { p_submission: leaving.submission_id }), approveWith(editor, s.submission_id, read)]);
      outcomes.push(withdrawn.status === 200 && approvedNow.status === 200 && !deadlocked(withdrawn) && !deadlocked(approvedNow) ? "ok" : `${withdrawn.text} | ${approvedNow.text}`);
    }
    check("both succeed, five times, with no deadlock", outcomes.every((o) => o === "ok"), JSON.stringify(outcomes));
  }
} catch (caught) {
  check("the checks ran to the end", false, caught.message);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
