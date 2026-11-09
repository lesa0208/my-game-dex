/**
 * M5a Catalog checks against the running local stack, through the real API, with
 * transactions held open in a separate session to force each race deterministically.
 * pgTAP covers the rules; this covers what clients and concurrent requests can do.
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
const psqlArgs = ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"];

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` (${detail})` : ""}`);
}
const section = (title) => console.log(`\n${title}`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const psql = (sql) => execFileSync("docker", psqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Runs a transaction that stays open while `during` acts, and only continues once the
 * transaction has really reached its pause, so these races are deterministic.
 */
async function whileHeld(setupSql, during) {
  const marker = `hold_${randomBytes(6).toString("hex")}`;
  let sessionError = null;
  const session = new Promise((resolve, reject) => {
    const child = spawn("docker", psqlArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`held session exited with ${code}: ${stderr.trim().split("\n")[0] ?? ""}`))));
    child.stdin.end(`begin;\n${setupSql}\nselect pg_sleep(2) /* ${marker} */;\ncommit;`);
  });
  session.catch((error) => {
    sessionError = error;
  });
  for (let attempt = 0; ; attempt += 1) {
    if (sessionError) throw new Error(`the held transaction failed before its pause: ${sessionError.message}`);
    const active = psql(`select count(*) from pg_stat_activity where pid <> pg_backend_pid() and query like '%${marker}%' and wait_event = 'PgSleep';`);
    if (active !== "0") break;
    if (attempt > 100) throw new Error("the held session never reached its pause");
    await pause(50);
  }
  const started = Date.now();
  const result = await during();
  const waited = Date.now() - started;
  await session;
  return { result, waited };
}
const asUserSql = (user) => `select set_config('request.jwt.claims', '{"sub":"${user.id}","role":"authenticated"}', true);\nset local role authenticated;`;

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
const post = (path, headers, body) => fetch(`${api}${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });

const createdUsers = new Set();
const createdGames = new Set();
async function createUser() {
  const email = `catalog-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await post("/auth/v1/admin/users", service, { email, password, email_confirm: true });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  response = await post("/auth/v1/token?grant_type=password", anon, { email, password });
  const session = await response.json();
  const handle = `ct_${randomBytes(6).toString("hex")}`;
  response = await post("/rest/v1/rpc/claim_handle", asUser(session.access_token), { p_handle: handle });
  if (!response.ok) throw new Error(`could not claim a handle: status ${response.status}`);
  return { id: user.id, handle, headers: asUser(session.access_token) };
}

// Every catalog edit needs the editor's reason. These checks give one unless a call sets its own.
const catalogEdits = new Set(["create_game", "update_game", "set_game_platform", "create_release", "update_release", "set_release_markets", "set_release_components", "set_release_requirements"]);

const reviewed = { verify_game: "games", verify_release: "releases", publish_release: "releases" };

/** Calls a function. Never throws on a refusal. */
async function call(who, fn, args) {
  let payload = catalogEdits.has(fn) && !("p_reason" in args) ? { ...args, p_reason: "Catalog checks" } : args;
  // Verifying and publishing need the revision the editor reviewed. These checks read
  // the current one, as a client does, unless a call gives its own.
  if (reviewed[fn] && !("p_expected_revision" in payload)) {
    const id = payload.p_game ?? payload.p_release;
    payload = { ...payload, p_expected_revision: Number(psql(`select coalesce((select revision from public.${reviewed[fn]} where id = ${q(id)}), 1);`)) };
  }
  const response = await post(`/rest/v1/rpc/${fn}`, who.headers ?? who, payload);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body, message: body?.message, code: body?.code };
}
const deniedByPrivilege = (result, name) => !result.ok && result.message === `permission denied for function ${name}`;
const refusedWith = (result, message) => !result.ok && result.message === message;
const get = async (path, headers) => {
  const response = await fetch(`${api}/rest/v1/${path}`, { headers });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
};

/** The documented operator procedure for the first administrator. */
function makeFirstAdmin(user) {
  psql(`begin;
select private.record_operator_action('${user.id}', 'Catalog checks: first administrator', '{"role": "admin"}');
insert into public.staff_roles (user_id, role) values ('${user.id}', 'admin');
commit;`);
}
const grant = (actor, user, role, reason = "Catalog checks") => call(actor, "grant_staff_role", { p_user: user.id, p_role: role, p_reason: reason });
const revoke = (actor, user, role, reason = "Catalog checks") => call(actor, "revoke_staff_role", { p_user: user.id, p_role: role, p_reason: reason });
const snes = () => psql("select id from public.platforms where slug = 'snes';");
const complete = { edition_name: "Standard", edition_kind: "standard", media_count: 1 };

async function createGame(editor, title) {
  const result = await call(editor, "create_game", { p_title: title, p_kind: "game" });
  if (!result.ok) throw new Error(`could not create a game: ${result.message}`);
  createdGames.add(result.body);
  return result.body;
}
async function createRelease(editor, game, details = complete, region = "ntsc-uc") {
  const result = await call(editor, "create_release", { p_game: game, p_platform: snes(), p_media_format_code: "rom-cartridge", p_region_code: region, p_details: details });
  if (!result.ok) throw new Error(`could not create a release: ${result.message}`);
  return result.body;
}
const releaseStatus = (id) => psql(`select status from public.releases where id = ${q(id)};`);

const editorFunctions = [
  ["create_game", { p_title: "x", p_kind: "game" }],
  ["update_game", { p_game: randomUUID(), p_changes: {} }],
  ["verify_game", { p_game: randomUUID(), p_reason: "x" }],
  ["set_game_platform", { p_game: randomUUID(), p_platform: randomUUID() }],
  ["set_game_relation", { p_source: randomUUID(), p_target: randomUUID(), p_relation: "remake_of", p_reason: "x" }],
  ["create_release", { p_game: randomUUID(), p_platform: randomUUID(), p_media_format_code: "rom-cartridge" }],
  ["update_release", { p_release: randomUUID(), p_changes: {} }],
  ["set_release_markets", { p_release: randomUUID(), p_markets: [] }],
  ["set_release_components", { p_release: randomUUID(), p_components: [] }],
  ["set_release_requirements", { p_release: randomUUID(), p_requirements: [] }],
  ["verify_release", { p_release: randomUUID(), p_reason: "x" }],
  ["publish_release", { p_release: randomUUID(), p_reason: "x" }],
  ["set_catalog_field_lock", { p_entity: "game", p_id: randomUUID(), p_field: "title", p_locked: true, p_reason: "x" }],
];

async function permissions() {
  section("Permissions");
  const user = await createUser();
  for (const [name, args] of editorFunctions) {
    check(`anon has no EXECUTE on ${name}`, deniedByPrivilege(await call(anon, name, args), name));
    check(`service_role has no EXECUTE on ${name}`, deniedByPrivilege(await call(service, name, args), name));
    check(`an ordinary user is refused by ${name}`, refusedWith(await call(user, name, args), "not permitted"));
  }
  for (const [label, headers] of [["anon", anon], ["a signed-in user", user.headers], ["service_role", service]]) {
    const response = await fetch(`${api}/rest/v1/games`, { method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify({ title: "x", sort_title: "x" }) });
    check(`${label} can't insert a game through the API`, !response.ok, `status ${response.status}`);
  }
  check("service_role can't read the catalog", !(await get("releases?select=id&limit=1", service)).ok);
  check("anon can't read who submitted a game", !(await get("games?select=submitted_by&limit=1", anon)).ok);
  check("anon can't read who verified a release", !(await get("releases?select=verified_by&limit=1", anon)).ok);
  for (const [label, headers] of [["anon", anon], ["a signed-in user", user.headers]]) {
    const response = await fetch(`${api}/rest/v1/provider_records?select=id`, { headers: { ...headers, "Accept-Profile": "private" } });
    check(`${label} can't reach provenance tables through the API`, !response.ok, `status ${response.status}`);
  }
}

async function flow(admin, editor) {
  section("Editing through the API");
  const member = await createUser();
  const game = await createGame(editor, `Catalog checks ${randomBytes(3).toString("hex")}`);
  const release = await createRelease(editor, game, { ...complete, product_code: "SNS-CT-USA", languages: ["en"] });
  check("an editor records markets", (await call(editor, "set_release_markets", { p_release: release, p_markets: ["US", "CA"] })).body === true);
  check("anon can't see the unpublished game", (await get(`games?select=id&id=eq.${game}`, anon)).body?.length === 0);
  check("an ordinary user can't see the unpublished release", (await get(`releases?select=id&id=eq.${release}`, member.headers)).body?.length === 0);
  check("the editor can", (await get(`releases?select=id&id=eq.${release}`, editor.headers)).body?.length === 1);
  check("an editor can't publish an unverified release", refusedWith(await call(editor, "publish_release", { p_release: release, p_reason: "Publish" }), "release not verified"));
  check("an editor verifies the game", (await call(editor, "verify_game", { p_game: game, p_reason: "Checked" })).body === true);
  check("and the release", (await call(editor, "verify_release", { p_release: release, p_reason: "Checked" })).body === true);
  const published = await call(editor, "publish_release", { p_release: release, p_reason: "Publish" });
  check("then publishes it, and the rules hold at commit", published.ok && published.body === true, published.message);
  const seen = await get(`releases?select=id,status,product_code,release_markets(market_code)&id=eq.${release}`, anon);
  const seenGame = await get(`games?select=slug,status&id=eq.${game}`, anon);
  check("anon sees the release, its markets and its game", seen.ok && seen.body?.[0]?.status === "published" && seen.body[0].release_markets.length === 2 && seenGame.body?.[0]?.status === "published", JSON.stringify(seen.body));
  // Created twice, markets, verified twice, and published twice: the game with its first release.
  check("every step was audited", Number(psql(`select count(*) from private.audit_events where actor_id = '${editor.id}' and metadata ->> 'id' in (${q(game)}, ${q(release)});`)) === 7);
  check("an edit without a reason is refused", refusedWith(await call(editor, "update_game", { p_game: game, p_changes: { summary: "No reason." }, p_reason: null }), "reason required"));
  // An import changes a record between an editor reading it and verifying it.
  const late = await createRelease(editor, game, { ...complete, product_code: "SNS-CT2-USA" });
  const seenRevision = Number(psql(`select revision from public.releases where id = ${q(late)};`));
  const raced = await whileHeld(`update public.releases set publisher_name = 'Filled by an import' where id = ${q(late)};`, () =>
    call(editor, "verify_release", { p_release: late, p_reason: "Checked", p_expected_revision: seenRevision }));
  check("a verification during an uncommitted change to the record waits for it", raced.waited > 500, `${raced.waited} ms`);
  check("then is refused, because the record changed since it was reviewed", refusedWith(raced.result, "record changed") && psql(`select verified_at is null from public.releases where id = ${q(late)};`) === "t", raced.result.message);
  check("an admin can edit the catalog", (await call(admin, "update_game", { p_game: game, p_changes: { summary: "Checked by an admin." }, p_reason: "Admin correction" })).body === true);
}

async function races(admin) {
  section("Races");
  let held;

  // Two editors publish the same physical identity at once.
  const editorA = await createUser();
  const editorB = await createUser();
  await grant(admin, editorA, "catalog_editor");
  await grant(admin, editorB, "catalog_editor");
  let game = await createGame(editorA, `Same identity ${randomBytes(3).toString("hex")}`);
  const first = await createRelease(editorA, game, { ...complete, product_code: "SNS-DUP-USA" });
  const second = await createRelease(editorB, game, { ...complete, product_code: "SNS-DUP-USA" });
  await call(editorA, "verify_game", { p_game: game, p_reason: "Checked" });
  await call(editorA, "verify_release", { p_release: first, p_reason: "Checked" });
  await call(editorB, "verify_release", { p_release: second, p_reason: "Checked" });
  held = await whileHeld(`${asUserSql(editorA)}\nselect public.publish_release('${first}', 'race', (select revision from public.releases where id = '${first}'));`, () => call(editorB, "publish_release", { p_release: second, p_reason: "race" }));
  check("a publication during an uncommitted one of the same game waits for it", held.waited > 500, `${held.waited} ms`);
  check("then fails cleanly on the duplicate identity", !held.result.ok && held.result.code === "23505", `${held.result.status} ${held.result.message}`);
  check("exactly one is published, and the other is untouched", releaseStatus(first) === "published" && releaseStatus(second) === "under_review");

  // Revocation and edits, in both orders.
  const revoked = await createUser();
  await grant(admin, revoked, "catalog_editor");
  const before = createdGames.size;
  held = await whileHeld(`${asUserSql(admin)}\nselect public.revoke_staff_role('${revoked.id}', 'catalog_editor', 'race');`, () => call(revoked, "create_game", { p_title: "Too late", p_kind: "game" }));
  check("an edit during an uncommitted revocation waits for it", held.waited > 500, `${held.waited} ms`);
  check("then refuses the revoked editor", refusedWith(held.result, "not permitted"), held.result.message);
  check("and creates nothing", Number(psql(`select count(*) from public.games where title = 'Too late';`)) === 0 && createdGames.size === before);

  const editing = await createUser();
  await grant(admin, editing, "catalog_editor");
  game = await createGame(editing, `Edited before revocation ${randomBytes(3).toString("hex")}`);
  held = await whileHeld(`${asUserSql(editing)}\nselect public.update_game('${game}', '{"summary": "Edited first."}', 'race');`, () => revoke(admin, editing, "catalog_editor"));
  check("a revocation during an uncommitted edit waits for it", held.waited > 500, `${held.waited} ms`);
  check("then completes, and the edit came first", held.result.ok && held.result.body === true && psql(`select summary from public.games where id = ${q(game)};`) === "Edited first.", held.result.message);
  check("the revoked editor is refused afterwards", refusedWith(await call(editing, "update_game", { p_game: game, p_changes: { summary: "Later." } }), "not permitted"));

  // Editors don't wait for each other.
  held = await whileHeld(`${asUserSql(editorA)}\nselect public.update_game('${game}', '{"summary": "Held edit."}', 'race');`, () => call(editorB, "create_game", { p_title: `Parallel ${randomBytes(3).toString("hex")}`, p_kind: "game" }));
  if (held.result.ok) createdGames.add(held.result.body);
  check("an edit during another editor's uncommitted edit doesn't wait", held.result.ok && held.waited < 1000, `${held.waited} ms ${held.result.message ?? ""}`);

  // A suspension during a publication.
  const suspended = await createUser();
  await grant(admin, suspended, "catalog_editor");
  game = await createGame(suspended, `Suspended editor ${randomBytes(3).toString("hex")}`);
  const pending = await createRelease(suspended, game);
  await call(suspended, "verify_game", { p_game: game, p_reason: "Checked" });
  await call(suspended, "verify_release", { p_release: pending, p_reason: "Checked" });
  held = await whileHeld(`${asUserSql(admin)}\nselect public.set_account_status('${suspended.id}', 'suspended', 'race');`, () => call(suspended, "publish_release", { p_release: pending, p_reason: "race" }));
  check("a publication during the editor's uncommitted suspension waits for it", held.waited > 500, `${held.waited} ms`);
  check("then refuses the suspended editor and publishes nothing", refusedWith(held.result, "not permitted") && releaseStatus(pending) === "under_review", held.result.message);

  // Two games with the same title published at once get different slugs.
  const title = `Same title ${randomBytes(3).toString("hex")}`;
  const gameA = await createGame(editorA, title);
  const gameB = await createGame(editorB, title);
  const releaseA = await createRelease(editorA, gameA);
  const releaseB = await createRelease(editorB, gameB);
  for (const [editor, g, r] of [[editorA, gameA, releaseA], [editorB, gameB, releaseB]]) {
    await call(editor, "verify_game", { p_game: g, p_reason: "Checked" });
    await call(editor, "verify_release", { p_release: r, p_reason: "Checked" });
  }
  held = await whileHeld(`${asUserSql(editorA)}\nselect public.publish_release('${releaseA}', 'race', (select revision from public.releases where id = '${releaseA}'));`, () => call(editorB, "publish_release", { p_release: releaseB, p_reason: "race" }));
  const slugs = psql(`select string_agg(slug, ',' order by slug) from public.games where id in (${q(gameA)}, ${q(gameB)});`).split(",");
  check("two publications with the same title both succeed", held.result.ok && releaseStatus(releaseA) === "published" && releaseStatus(releaseB) === "published", held.result.message);
  check("with different slugs", slugs.length === 2 && slugs[0] !== slugs[1] && slugs[1] === `${slugs[0]}-2`, slugs.join(" "));

  // An editor's account deleted through Auth during their edit.
  const leaving = await createUser();
  await grant(admin, leaving, "catalog_editor");
  game = await createGame(leaving, `Deleted editor ${randomBytes(3).toString("hex")}`);
  const release = await createRelease(leaving, game);
  held = await whileHeld(`${asUserSql(leaving)}\nselect public.verify_release('${release}', 'Verified before leaving', (select revision from public.releases where id = '${release}'));`, () =>
    fetch(`${api}/auth/v1/admin/users/${leaving.id}`, { method: "DELETE", headers: service }),
  );
  check("a deletion during the editor's uncommitted edit waits for it", held.waited > 500, `${held.waited} ms`);
  check("then completes, without a deadlock", held.result.ok, `status ${held.result.status}`);
  check("the verification stays, without naming the deleted account", psql(`select (verified_at is not null)::text || '/' || coalesce(verified_by::text, 'none') from public.releases where id = ${q(release)};`) === "true/none");
}

/**
 * Removes test catalog rows, users, and their audit rows. The audit log is
 * append-only, so removing these rows needs the owner to skip triggers for this
 * session, as in the audit checks.
 */
async function cleanup() {
  if (createdGames.size) {
    const games = [...createdGames].map(q).join(",");
    psql(`begin;
delete from public.releases where game_id in (${games});
delete from public.game_relations where source_game_id in (${games}) or target_game_id in (${games});
delete from public.games where id in (${games});
commit;`);
  }
  let deletions = 0;
  for (const id of createdUsers) {
    const response = await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
    if (response.ok || response.status === 404) deletions += 1;
  }
  check("every test account is removed", deletions === createdUsers.size, `${deletions} of ${createdUsers.size}`);
  if (createdUsers.size) {
    const ids = [...createdUsers].map(q).join(",");
    psql(`begin;
set local session_replication_role = replica;
delete from private.audit_events where target_profile_id in (${ids}) or actor_id in (${ids}) or reason like 'Catalog checks%';
commit;`);
  }
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ct\\_%';");
}

try {
  await permissions();
  const admin = await createUser();
  makeFirstAdmin(admin);
  const editor = await createUser();
  await grant(admin, editor, "catalog_editor");
  await flow(admin, editor);
  await races(admin);
} catch (error) {
  failed += 1;
  console.error(`FAIL catalog checks stopped early: ${error.message}`);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
