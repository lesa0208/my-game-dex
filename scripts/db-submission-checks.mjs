/**
 * M7a catalog submission checks against the running local stack, through the real API,
 * as anon, a submitter, another collector, a catalog editor, a suspended account and
 * service_role, with concurrent requests. Uses the local catalog fixture
 * (scripts/catalog-fixture.mjs), and removes it, every submitted record and every test
 * account after. pgTAP covers the rules; this covers what clients can do.
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
async function createUser() {
  const email = `subm-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await fetch(`${api}/auth/v1/admin/users`, { method: "POST", headers: service, body: JSON.stringify({ email, password, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  response = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: "POST", headers: anon, body: JSON.stringify({ email, password }) });
  const session = await response.json();
  const claimed = await rpc(asUser(session.access_token), "claim_handle", { p_handle: `sb_${randomBytes(6).toString("hex")}` });
  if (claimed.status !== 200) throw new Error(`could not claim a handle: status ${claimed.status}`);
  return { id: user.id, headers: asUser(session.access_token) };
}

const submit = (user, game, args = {}) =>
  rpc(user.headers, "submit_release", { p_game: game, p_platform: "snes", p_media_format: "rom-cartridge", p_region: "pal", p_details: {}, p_components: [], p_physical: true, ...args });

async function cleanup() {
  const ids = [...createdUsers].map((id) => `'${id}'`).join(",") || "null";
  // Submitted records first: deleting an account leaves its pending releases unowned.
  psql(`begin;
delete from public.collection_items where owner_id in (${ids});
create temp table sub_games on commit drop as select distinct game_id as id from public.catalog_change_requests where submitted_by in (${ids}) and created_game and game_id is not null;
delete from public.releases where submitted_by in (${ids}) or id in (select release_id from public.catalog_change_requests where submitted_by in (${ids}));
delete from public.catalog_change_requests where submitted_by in (${ids});
delete from public.game_platforms where submitted_by in (${ids});
delete from public.games where id in (select id from sub_games) or submitted_by in (${ids});
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
  if (createdUsers.size) {
    psql(`begin;
set local session_replication_role = replica;
delete from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids});
commit;`);
  }
  psql("delete from private.handle_holds where kind = 'released' and handle like 'sb\\_%';");
  check("no submissions or catalog data are left behind",
    psql("select (select count(*) from public.catalog_change_requests) + (select count(*) from public.games) + (select count(*) from public.releases) + (select count(*) from public.collection_items) + (select count(*) from private.audit_events);") === "0");
}

try {
  installFixture();
  const game = (title) => psql(`select id from public.games where title = '${title}' and status = 'published';`);
  const starfall = game("Starfall Odyssey");
  const hiddenGame = psql("select id from public.games where title = 'Hidden Prototype Quest';");
  const submitter = await createUser();
  const other = await createUser();
  const editor = await createUser();
  const racer = await createUser();
  psql(`insert into public.staff_roles (user_id, role) values ('${editor.id}', 'catalog_editor');`);

  section("Who can submit");
  check("a visitor can't", isDenied(await submit({ headers: anon }, starfall)));
  check("service_role can't", isDenied(await submit({ headers: service }, starfall)));
  const suspended = await createUser();
  psql(`update public.profiles set account_status = 'suspended' where id = '${suspended.id}';`);
  check("a suspended account can't", error(await submit(suspended, starfall), "account not active"));

  section("Submitting, privately");
  const first = await submit(submitter, starfall, { p_details: { edition_name: "Players Choice", product_code: "SNSP-QZ" }, p_components: [{ kind: "insert", label: "Poster" }], p_note: "Bought in 1995" });
  check("a missing release is submitted", first.status === 200 && first.body?.outcome === "submitted", first.text);
  const releaseId = first.body?.release_id;
  check("the submitter can read it", (await table(submitter.headers, `releases?id=eq.${releaseId}&select=id,status`)).body?.[0]?.status === "unverified");
  check("another collector can't", JSON.stringify((await table(other.headers, `releases?id=eq.${releaseId}&select=id`)).body) === "[]");
  check("a visitor can't", JSON.stringify((await table(anon, `releases?id=eq.${releaseId}&select=id`)).body) === "[]");
  check("a catalog editor can", (await table(editor.headers, `releases?id=eq.${releaseId}&select=id`)).body?.length === 1);
  check("its pieces are hidden too", JSON.stringify((await table(other.headers, `release_components?release_id=eq.${releaseId}&select=id`)).body) === "[]");
  check("the submitter reads their own submission, through the function", (await rpc(submitter.headers, "get_my_submission", { p_submission: first.body?.submission_id })).body?.note === "Bought in 1995");
  check("which shows no reviewer and no reused pairing", !/reviewed_by|created_pairing/.test(JSON.stringify((await rpc(submitter.headers, "get_my_submission", { p_submission: first.body?.submission_id })).body)));
  check("no client reads the review record directly, not even their own", isDenied(await table(submitter.headers, "catalog_change_requests?select=id")) && isDenied(await table(editor.headers, "catalog_change_requests?select=id")));
  check("another collector can't open the submission", (await rpc(other.headers, "get_my_submission", { p_submission: first.body?.submission_id })).body === null);
  // A complete, valid row with its own id, without asking for it back: asking would
  // need read access, and the id's default calls a function clients can't reach, so
  // either would refuse it for the wrong reason.
  const requestsBefore = psql("select count(*) from public.catalog_change_requests;");
  const forgedRequest = await fetch(`${api}/rest/v1/catalog_change_requests`, {
    method: "POST",
    headers: { ...submitter.headers, Prefer: "return=minimal" },
    body: JSON.stringify({ id: uuidv7(), submitted_by: submitter.id, request_type: "new_release", platform_id: psql("select id from public.platforms where slug = 'snes';"), physical_confirmed: true }),
  });
  check("no client can write the review record", (forgedRequest.status === 401 || forgedRequest.status === 403)
    && psql("select count(*) from public.catalog_change_requests;") === requestsBefore, `status ${forgedRequest.status}`);
  check("or the catalog", isDenied(await request("PATCH", `/rest/v1/releases?id=eq.${releaseId}`, submitter.headers, { status: "published" })));
  const search = await rpc(anon, "search_catalog", { p_query: "Starfall Odyssey" });
  check("search shows published records only", search.status === 200 && !search.text.includes("SNSP-QZ") && !search.text.includes("Players Choice"));
  const editorSearch = await rpc(editor.headers, "search_catalog", { p_query: "Starfall Odyssey" });
  check("even to an editor", !editorSearch.text.includes("SNSP-QZ"));

  section("Hidden records stay hidden");
  const hidden = await submit(other, hiddenGame);
  const missing = await submit(other, randomUUID());
  check("an unpublished game reads exactly like a missing one", error(hidden, "game unavailable") && error(missing, "game unavailable") && hidden.text === missing.text);
  const theirs = await submit(other, starfall, { p_details: { edition_name: "Players Choice", product_code: "SNSP-QZ" } });
  check("someone else's identical submission isn't revealed", theirs.body?.outcome === "submitted", theirs.text);
  const published = await submit(other, starfall, { p_region: "ntsc-uc", p_details: { product_code: "SNS-ZSFE-USA", edition_name: psql(`select edition_name from public.releases where product_code = 'SNS-ZSFE-USA';`) } });
  check("a published release is pointed to, since it's public", published.body?.outcome === "published_duplicate" && published.body?.release_id === psql("select id from public.releases where product_code = 'SNS-ZSFE-USA';"));
  // The fixture's Starfall Odyssey has no Game Boy pairing. The first submission makes
  // one, hidden from everyone else; the second reuses it and must get the same answer.
  const makes = await submit(submitter, starfall, { p_platform: "game-boy", p_media_format: "game-boy-game-pak", p_region: "ntsc-j" });
  const reuses = await submit(other, starfall, { p_platform: "game-boy", p_media_format: "game-boy-game-pak", p_region: "ntsc-uc" });
  check("reusing a hidden pairing answers like making one", makes.status === reuses.status && Object.keys(makes.body).sort().join() === Object.keys(reuses.body).sort().join() && reuses.body.outcome === "submitted");
  check("and the pairing stays hidden from the second submitter",
    JSON.stringify((await table(other.headers, `game_platforms?game_id=eq.${starfall}&select=platform_id,status`)).body?.filter((p) => p.status !== "published")) === "[]");

  section("A copy of a pending release");
  const copyId = uuidv7();
  const added = await rpc(submitter.headers, "add_collection_item", { p_item_id: copyId, p_release: releaseId });
  check("the submitter adds their own copy", added.body?.created === true, added.text);
  check("another collector can't", error(await rpc(other.headers, "add_collection_item", { p_item_id: uuidv7(), p_release: releaseId }), "release unavailable"));
  const listing = await rpc(submitter.headers, "get_my_collection");
  check("it counts as awaiting review", listing.body?.items?.[0]?.status === "pending");

  section("Withdrawing");
  const submissionId = first.body?.submission_id;
  check("another user can't withdraw it", error(await rpc(other.headers, "withdraw_my_submission", { p_submission: submissionId }), "submission unavailable"));
  check("a submission with a copy can't be withdrawn", error(await rpc(submitter.headers, "withdraw_my_submission", { p_submission: submissionId }), "submission in use"));
  await rpc(submitter.headers, "remove_collection_item", { p_item: copyId });
  check("without it, it can", (await rpc(submitter.headers, "withdraw_my_submission", { p_submission: submissionId })).body === true);
  check("the release is gone", psql(`select count(*) from public.releases where id = '${releaseId}';`) === "0");
  check("the other user's identical submission is untouched", psql(`select count(*) from public.releases where id = '${theirs.body.release_id}';`) === "1");
  const pairing = () => psql(`select count(*) from public.game_platforms gp join public.platforms p on p.id = gp.platform_id where gp.game_id = '${starfall}' and p.slug = 'game-boy';`);
  check("withdrawing the submission that made a shared pairing keeps the pairing", (await rpc(submitter.headers, "withdraw_my_submission", { p_submission: makes.body.submission_id })).body === true && pairing() === "1");
  check("the history keeps what was submitted", (await rpc(submitter.headers, "get_my_submission", { p_submission: submissionId })).body?.details?.product_code === "SNSP-QZ");

  section("Atomic and rate-limited");
  const broken = await rpc(submitter.headers, "submit_game", { p_title: "Qzs Half Made", p_kind: "game", p_first_release_year: null, p_platform: "snes", p_media_format: "rom-cartridge", p_region: "pal", p_details: {}, p_components: [{ kind: "sticker", label: "x" }], p_physical: true });
  check("a submission that fails partway is refused", error(broken, "invalid submission"));
  check("and leaves no game behind", psql("select count(*) from public.games where title = 'Qzs Half Made';") === "0");
  const burst = await Promise.all(Array.from({ length: 15 }, (_, i) => submit(racer, starfall, { p_details: { edition_name: `Race ${i}` } })));
  const accepted = burst.filter((r) => r.body?.outcome === "submitted").length;
  const refused = burst.filter((r) => error(r, "submission limit reached")).length;
  check("fifteen concurrent submissions: exactly ten are accepted", accepted === 10 && refused === 5, `${accepted} accepted, ${refused} refused`);
  check("the user sees when they can submit again", Boolean((await rpc(racer.headers, "my_catalog_submissions")).body?.allowance?.next_available_at));
} catch (caught) {
  check("the checks ran to the end", false, caught.message);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
