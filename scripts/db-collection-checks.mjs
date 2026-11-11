/**
 * M6b collection checks against the running local stack, through the real API, as
 * anon, the owner, another collector, a catalog editor, a suspended owner and
 * service_role, with concurrent requests. Uses the local catalog fixture
 * (scripts/catalog-fixture.mjs), and removes it and every test account after.
 * pgTAP covers the rules; this covers what clients can do.
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

/** A UUIDv7 for now, as a client makes one. */
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
  const email = `coll-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await fetch(`${api}/auth/v1/admin/users`, { method: "POST", headers: service, body: JSON.stringify({ email, password, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  response = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: "POST", headers: anon, body: JSON.stringify({ email, password }) });
  const session = await response.json();
  const claimed = await rpc(asUser(session.access_token), "claim_handle", { p_handle: `ct_${randomBytes(6).toString("hex")}` });
  if (claimed.status !== 200) throw new Error(`could not claim a handle: status ${claimed.status}`);
  return { id: user.id, headers: asUser(session.access_token) };
}

const isDenied = (r) => r.status === 401 || r.status === 403;
const error = (r, message) => r.status >= 400 && r.body?.message === message && !r.body?.details && !r.body?.hint;

// The limit trigger, lowered for the race and restored after. Restored in `finally`
// too, and the mutation runner's fingerprint would catch it if it ever weren't.
const LIMIT_FUNCTION = "private.check_new_collection_item()";
let originalLimit = null;
function lowerLimit(limit) {
  originalLimit = psql(`select pg_get_functiondef('${LIMIT_FUNCTION}'::regprocedure);`);
  if (!originalLimit.includes("c_limit constant integer := 100000;")) throw new Error("the limit isn't where expected");
  psql(originalLimit.replace("c_limit constant integer := 100000;", `c_limit constant integer := ${limit};`) + ";");
}
function restoreLimit() {
  if (originalLimit) psql(`${originalLimit};`);
  originalLimit = null;
}

async function cleanup() {
  restoreLimit();
  check("the limit is restored", psql(`select position('c_limit constant integer := 100000;' in pg_get_functiondef('${LIMIT_FUNCTION}'::regprocedure)) > 0;`) === "t");
  // Removing the fixture must work while copies of its releases exist.
  let fixtureRemoved = true;
  try {
    removeFixture();
  } catch {
    fixtureRemoved = false;
  }
  check("the catalog fixture can be removed while it has copies", fixtureRemoved);
  let deletions = 0;
  for (const id of createdUsers) {
    const response = await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
    if (response.ok || response.status === 404) deletions += 1;
  }
  check("every test account is removed", deletions === createdUsers.size, `${deletions} of ${createdUsers.size}`);
  if (createdUsers.size) {
    const ids = [...createdUsers].map((id) => `'${id}'`).join(",");
    psql(`begin;
set local session_replication_role = replica;
delete from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids});
commit;`);
  }
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ct\\_%';");
  check("no collection or catalog data is left behind",
    psql("select (select count(*) from public.collection_items) + (select count(*) from public.collection_item_private) + (select count(*) from public.collection_item_components) + (select count(*) from public.games) + (select count(*) from private.audit_events);") === "0");
}

try {
  installFixture();
  const release = (code) => psql(`select id from public.releases where product_code = '${code}';`);
  const published = release("SNS-ZSFE-USA");
  const collector = release("SNS-ZSFE-USA-CE");
  const draft = release("SNS-ZSFE-DRAFT");
  const owner = await createUser();
  const other = await createUser();
  const editor = await createUser();
  psql(`insert into public.staff_roles (user_id, role) values ('${editor.id}', 'catalog_editor');`);

  section("Who can reach the collection");
  for (const path of ["collection_items?select=id", "collection_item_private?select=item_id", "collection_item_components?select=label"]) {
    check(`anon can't read ${path.split("?")[0]}`, isDenied(await table(anon, path)));
    check(`service_role can't read ${path.split("?")[0]}`, isDenied(await table(service, path)));
  }
  check("anon can't add a copy", isDenied(await rpc(anon, "add_collection_item", { p_item_id: uuidv7(), p_release: published })));
  check("service_role can't call the collection functions", isDenied(await rpc(service, "get_my_collection")) && isDenied(await rpc(service, "get_my_collection_summary")));
  check("service_role can't add a copy", isDenied(await rpc(service, "add_collection_item", { p_item_id: uuidv7(), p_release: published })));

  section("Adding, once per request");
  const first = uuidv7();
  const notes = `Bought at a fair ${randomBytes(4).toString("hex")}`;
  const added = await rpc(owner.headers, "add_collection_item", {
    p_item_id: first, p_release: published,
    p_details: { completeness: "complete", box_condition: "good", purchase_price: "49.99", currency: "EUR", notes, storage_location: "Shelf A",
      components: [{ kind: "insert", label: "Instruction manual" }] },
  });
  check("the owner adds a copy with its details", added.status === 200 && added.body.created === true && added.body.item_id === first, `${added.status} ${added.text}`);
  const race = await Promise.all(Array.from({ length: 10 }, () => rpc(owner.headers, "add_collection_item", { p_item_id: first, p_release: published })));
  check("ten concurrent repeats all succeed", race.every((r) => r.status === 200), race.map((r) => r.status).join(","));
  check("and none adds another copy", race.every((r) => r.body.created === false) && psql(`select count(*) from public.collection_items where owner_id = '${owner.id}';`) === "1");
  const fresh = uuidv7();
  const parallel = await Promise.all(Array.from({ length: 6 }, () => rpc(owner.headers, "add_collection_item", { p_item_id: fresh, p_release: collector })));
  check("concurrent first attempts add exactly one copy", parallel.filter((r) => r.body?.created === true).length === 1 && parallel.every((r) => r.status === 200),
    parallel.map((r) => `${r.status}:${r.body?.created}`).join(","));
  const second = await rpc(owner.headers, "add_collection_item", { p_item_id: uuidv7(), p_release: published });
  check("another id adds a second copy of the same release", second.body?.created === true);
  check("a request id can't be reused for another release", error(await rpc(owner.headers, "add_collection_item", { p_item_id: first, p_release: collector }), "request conflict"));
  check("another user can't reuse the owner's request id", error(await rpc(other.headers, "add_collection_item", { p_item_id: first, p_release: published }), "request conflict"));

  section("Only usable releases");
  check("an unpublished release is refused", error(await rpc(owner.headers, "add_collection_item", { p_item_id: uuidv7(), p_release: draft }), "release unavailable"));
  check("an unknown release gets the same answer", error(await rpc(owner.headers, "add_collection_item", { p_item_id: uuidv7(), p_release: randomUUID() }), "release unavailable"));
  check("an editor can't use an unpublished release either", error(await rpc(editor.headers, "add_collection_item", { p_item_id: uuidv7(), p_release: draft }), "release unavailable"));
  const direct = await request("POST", "/rest/v1/collection_items", owner.headers, { id: uuidv7(), owner_id: owner.id, release_id: draft });
  check("a direct insert can't use an unpublished release", direct.status === 403, `${direct.status}`);
  check("a random id is refused", error(await rpc(owner.headers, "add_collection_item", { p_item_id: randomUUID(), p_release: published }), "invalid item id"));

  section("Nobody else sees or changes a copy");
  const forOther = await Promise.all([
    table(other.headers, "collection_items?select=*"),
    table(other.headers, "collection_item_private?select=*"),
    table(other.headers, "collection_item_components?select=*"),
    rpc(other.headers, "get_my_collection"),
    rpc(other.headers, "get_my_collection_item", { p_item: first }),
    rpc(other.headers, "get_my_release_copies", { p_release: published }),
    rpc(other.headers, "get_my_collection_summary"),
  ]);
  check("another collector reads nothing of the owner's", forOther[0].body.length === 0 && forOther[1].body.length === 0 && forOther[2].body.length === 0
    && forOther[3].body.items.length === 0 && forOther[4].body === null && forOther[5].body.count === 0 && forOther[6].body.total === 0);
  const forEditor = await Promise.all([table(editor.headers, "collection_items?select=*"), table(editor.headers, "collection_item_private?select=*"), rpc(editor.headers, "get_my_collection_item", { p_item: first })]);
  check("a catalog editor reads nothing of the owner's", forEditor[0].body.length === 0 && forEditor[1].body.length === 0 && forEditor[2].body === null);
  check("no response to them contains the owner's notes or id",
    [...forOther, ...forEditor].every((r) => !r.text.includes(notes) && !r.text.includes(owner.id) && !r.text.includes(first)));
  const refusals = await Promise.all([
    rpc(other.headers, "update_collection_item", { p_item: first, p_changes: { notes: "x" } }),
    rpc(other.headers, "update_collection_item", { p_item: first, p_changes: { completeness: "loose", box_condition: "good" } }),
    rpc(other.headers, "remove_collection_item", { p_item: first }),
    rpc(other.headers, "add_collection_item", { p_item_id: first, p_release: collector }),
    rpc(other.headers, "get_my_collection", { p_cursor: Buffer.from(JSON.stringify(["x", "a", null, first])).toString("base64url") }),
    request("POST", "/rest/v1/collection_item_components", other.headers, { item_id: first, owner_id: owner.id, kind: "insert", label: "Instruction manual" }),
  ]);
  check("every refusal to them is a fixed message with no detail", refusals.every((r) => r.status >= 400 && !r.body?.details && !r.body?.hint), refusals.map((r) => `${r.status}:${r.body?.message}`).join(" | "));
  check("and none mentions the owner's details, release or id",
    refusals.every((r) => !r.text.includes(notes) && !r.text.includes(owner.id) && !r.text.includes(published) && !r.text.includes("Shelf A") && !r.text.includes("49.99")));
  const edit = await request("PATCH", `/rest/v1/collection_items?id=eq.${first}`, other.headers, { completeness: "loose" });
  check("another collector's direct edit changes nothing", edit.status === 200 && edit.body.length === 0, `${edit.status}`);
  const detailEdit = await request("PATCH", `/rest/v1/collection_item_private?item_id=eq.${first}`, other.headers, { notes: "x" });
  check("nor can they edit the owner's details", detailEdit.body.length === 0);
  const removal = await request("DELETE", `/rest/v1/collection_items?id=eq.${first}`, other.headers);
  check("nor delete the owner's copy", removal.body.length === 0);
  const unknown = await rpc(other.headers, "remove_collection_item", { p_item: randomUUID() });
  const theirs = await rpc(other.headers, "remove_collection_item", { p_item: first });
  check("someone else's copy and a missing one give the same answer", error(unknown, "item unavailable") && unknown.text === theirs.text);
  const steal = await request("POST", "/rest/v1/collection_item_private", other.headers, { item_id: first, owner_id: other.id, notes: "x" });
  check("details can't be attached to someone else's copy", steal.status >= 400);
  check("the owner's copy is unchanged", psql(`select completeness || ' ' || (select notes from public.collection_item_private where item_id = '${first}') from public.collection_items where id = '${first}';`) === `complete ${notes}`);

  section("The owner's own writes are limited too");
  const move = await request("PATCH", `/rest/v1/collection_items?id=eq.${first}`, owner.headers, { release_id: collector });
  check("the owner can't move a copy to another release directly", move.status === 403, `${move.status}`);
  const give = await request("PATCH", `/rest/v1/collection_items?id=eq.${first}`, owner.headers, { owner_id: other.id });
  check("or give it away", give.status === 403);
  const publish = await request("PATCH", `/rest/v1/collection_items?id=eq.${first}`, owner.headers, { visibility: "public" });
  check("or make it visible to others", publish.status === 403);
  const unpreserve = await request("PATCH", `/rest/v1/collection_items?id=eq.${first}`, owner.headers, { record_status: "active" });
  check("or change its status", unpreserve.status === 403);
  check("an unlisted piece is refused", error(await rpc(owner.headers, "update_collection_item", { p_item: first, p_changes: { components: [{ kind: "insert", label: "Sticker" }] } }), "component unavailable"));
  check("an inconsistent copy is refused", error(await rpc(owner.headers, "update_collection_item", { p_item: first, p_changes: { completeness: "loose" } }), "invalid details"));

  section("Reading");
  const own = await rpc(owner.headers, "get_my_collection");
  check("the owner lists their copies, newest first", own.status === 200 && own.body.items.length === 3 && own.body.items[2].id === first, `${own.body?.items?.length}`);
  const full = await rpc(owner.headers, "get_my_collection_item", { p_item: first });
  check("a full copy has its details and pieces", full.body.notes === notes && full.body.price.amount === "49.9900" && full.body.components.filter((c) => c.recorded).length === 1);
  check("no response includes the owner id or internal columns", !/owner_id|record_status|invalidated_at|visibility|submitted_by|verified_by/.test(own.text + full.text));
  const pages = [];
  let cursor = null;
  do {
    const page = await rpc(owner.headers, "get_my_collection", { p_sort: "title", p_limit: 1, p_cursor: cursor });
    pages.push(...page.body.items.map((item) => item.id));
    cursor = page.body.next_cursor;
  } while (cursor && pages.length < 10);
  check("pages one at a time reach every copy once", pages.length === 3 && new Set(pages).size === 3, pages.length);
  const badCursor = await rpc(owner.headers, "get_my_collection", { p_cursor: "x" });
  check("a bad cursor is refused without detail", error(badCursor, "invalid cursor"), badCursor.text);
  check("copies of a release are counted", (await rpc(owner.headers, "get_my_release_copies", { p_release: published })).body.count === 2);
  const summary = (await rpc(owner.headers, "get_my_collection_summary")).body;
  check("the summary counts the owned copies", summary.total === 3 && summary.owned === 3 && summary.platforms[0]?.count === 3, JSON.stringify(summary));

  section("The limit holds under concurrency");
  lowerLimit(5);
  const burst = await Promise.all(Array.from({ length: 8 }, () => rpc(owner.headers, "add_collection_item", { p_item_id: uuidv7(), p_release: published })));
  check("eight concurrent additions stop at the limit", burst.filter((r) => r.body?.created === true).length === 2 && burst.filter((r) => error(r, "collection limit reached")).length === 6,
    burst.map((r) => r.body?.message ?? r.body?.created).join(","));
  check("the owner never has more than the limit", psql(`select count(*) from public.collection_items where owner_id = '${owner.id}';`) === "5");
  restoreLimit();

  section("A suspended owner");
  psql(`update public.profiles set account_status = 'suspended' where id = '${owner.id}';`);
  check("can't add", error(await rpc(owner.headers, "add_collection_item", { p_item_id: uuidv7(), p_release: published }), "account not active"));
  check("can't edit", error(await rpc(owner.headers, "update_collection_item", { p_item: first, p_changes: { notes: "x" } }), "account not active"));
  const patchSuspended = await request("PATCH", `/rest/v1/collection_items?id=eq.${first}`, owner.headers, { completeness: "incomplete" });
  check("can't edit directly", patchSuspended.body.length === 0);
  check("can still read their copies", (await rpc(owner.headers, "get_my_collection")).body.items.length === 5);
  check("can still remove a copy", (await rpc(owner.headers, "remove_collection_item", { p_item: second.body.item_id })).body === true);
  psql(`update public.profiles set account_status = 'active' where id = '${owner.id}';`);

  section("Account deletion");
  const leaving = await createUser();
  await rpc(leaving.headers, "add_collection_item", { p_item_id: uuidv7(), p_release: published, p_details: { notes: "private", components: [{ kind: "map", label: "World map poster" }] } });
  const deletion = await fetch(`${api}/auth/v1/admin/users/${leaving.id}`, { method: "DELETE", headers: service });
  check("Auth deletes an account that has copies", deletion.ok, `${deletion.status}`);
  check("and its copies, details and pieces go with it",
    psql(`select (select count(*) from public.collection_items where owner_id = '${leaving.id}') + (select count(*) from public.collection_item_private where owner_id = '${leaving.id}') + (select count(*) from public.collection_item_components where owner_id = '${leaving.id}');`) === "0");
} catch (caught) {
  check("the checks ran to the end", false, caught.message);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
