/**
 * M5c catalog search checks against the running local stack, through the real API,
 * as anon, an ordinary user, an editor and service_role. Uses the local search
 * fixture (scripts/catalog-fixture.mjs), and removes it and every test account after.
 * pgTAP covers the rules; this covers what clients see.
 *
 * Local only. Prints check names and statuses, never keys or tokens.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURE_EDITOR, installFixture, removeFixture } from "./catalog-fixture.mjs";

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
const post = (path, headers, body) => fetch(`${api}${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });

/** Calls a function and returns its status and parsed body. */
async function rpc(headers, fn, args = {}) {
  const response = await post(`/rest/v1/rpc/${fn}`, headers, args);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

const createdUsers = new Set();
async function createUser() {
  const email = `search-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  let response = await post("/auth/v1/admin/users", service, { email, password, email_confirm: true });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  response = await post("/auth/v1/token?grant_type=password", anon, { email, password });
  const session = await response.json();
  const handle = `st_${randomBytes(6).toString("hex")}`;
  response = await post("/rest/v1/rpc/claim_handle", asUser(session.access_token), { p_handle: handle });
  if (!response.ok) throw new Error(`could not claim a handle: status ${response.status}`);
  return { id: user.id, headers: asUser(session.access_token) };
}

const titles = (body) => (body?.items ?? []).map((item) => item.game.title);
const keys = (value) => Object.keys(value ?? {}).sort().join(",");

const GAME_ITEM = "game,kind,match,matched,platforms";
const RELEASE_ITEM = "game,kind,match,matched_identifier,release";
const GAME = "first_release,id,kind,slug,title";
const PICKER_RELEASE =
  "components,edition,format,id,identifiers,languages,local_title,markets,media_count,media_playability,packaging,platform,publisher_name,rating_labels,region,release_date,requirements,variant_name";
const FORBIDDEN = /(verified|submitted)_(by|at)|revision|provider|evidence|audit|"(published|under_review|unverified|rejected|excluded|merged)"/;

async function cleanup() {
  removeFixture();
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
delete from private.audit_events where actor_id in (${ids}) or target_profile_id in (${ids}) or reason like 'Search checks%';
commit;`);
  }
  psql("delete from private.handle_holds where kind = 'released' and handle like 'st\\_%';");
  check("no catalog data is left behind", psql("select (select count(*) from public.games) + (select count(*) from public.game_aliases) + (select count(*) from private.audit_events);") === "0");
}

try {
  installFixture();
  const user = await createUser();
  const editor = await createUser();
  psql(`insert into public.staff_roles (user_id, role) values ('${editor.id}', 'catalog_editor');`);

  section("Search, for everyone");
  const asAnon = await rpc(anon, "search_catalog", { p_query: "starfall" });
  check("anon can search", asAnon.status === 200 && asAnon.body.status === "ok", `status ${asAnon.status}`);
  check("and finds the published games", titles(asAnon.body).join("|") === "Starfall Odyssey|Starfall Odyssey II", titles(asAnon.body).join("|"));
  const asSignedIn = await rpc(user.headers, "search_catalog", { p_query: "starfall" });
  check("a signed-in user gets the same response", asSignedIn.text === asAnon.text);
  const asEditor = await rpc(editor.headers, "search_catalog", { p_query: "starfall" });
  check("and so does an editor", asEditor.text === asAnon.text);
  const byService = await rpc(service, "search_catalog", { p_query: "starfall" });
  check("service_role can't search", byService.status === 401 || byService.status === 403, `status ${byService.status}`);

  section("Nothing unpublished, for anyone");
  for (const [who, headers] of [["anon", anon], ["a user", user.headers], ["an editor", editor.headers]]) {
    const results = await Promise.all(
      ["hidden prototype", "secret starfall quest", "SNS-HPQE-USA", "rejected racer", "orphan saga", "SNS-ORSE-USA", "shadow copy", "starfall odysey"].map((query) =>
        rpc(headers, "search_catalog", { p_query: query }),
      ),
    );
    const leaked = results.flatMap((result) => titles(result.body)).filter((title) => !title.startsWith("Starfall Odyssey"));
    check(`${who} never finds an unpublished, rejected, excluded or merged game`, leaked.length === 0, leaked.join(", "));
  }
  // Starfall Odyssey has an unpublished release on its published SNES pairing.
  const draft = await rpc(anon, "search_catalog", { p_query: "SNS-ZSFE-DRAFT" });
  check("an unpublished release's product code isn't found", draft.status === 200 && draft.body.items.length === 0, JSON.stringify(draft.body?.items?.map((i) => i.kind)));
  const starfall = asAnon.body.items.find((item) => item.game?.slug === "starfall-odyssey");
  check("a result counts only published releases", starfall?.platforms?.[0]?.release_count === 4, JSON.stringify(starfall?.platforms));
  const regions = (await rpc(anon, "get_release_picker", { p_game: "starfall-odyssey", p_region: "latam" })).body;
  check("the picker offers no region with only an unpublished release", regions && !regions.regions.some((r) => r.code === "latam") && regions.releases.length === 4,
    JSON.stringify(regions?.regions?.map((r) => r.code)));
  const crystal = await rpc(anon, "get_release_picker", { p_game: "the-crystal-warden" });
  check("a platform with only an unpublished release isn't offered", JSON.stringify(crystal.body.platforms.map((p) => p.slug)) === '["mega-drive"]');

  section("Response fields");
  const game = asAnon.body.items[0];
  check("a search response has only its fields", keys(asAnon.body) === "items,next_cursor,platforms,status", keys(asAnon.body));
  check("a game result has only its fields", keys(game) === GAME_ITEM && keys(game.game) === GAME, `${keys(game)} / ${keys(game.game)}`);
  const code = await rpc(anon, "search_catalog", { p_query: "sns-zsfe-usa" });
  const codeItem = code.body.items[0];
  check("an exact product code is the release", codeItem?.kind === "release" && codeItem.release.identifiers.product_code === "SNS-ZSFE-USA");
  check("a release result has only its fields", keys(codeItem) === RELEASE_ITEM && keys(codeItem.release) === "edition_name,id,identifiers,platform,region,variant_name");
  const picker = await rpc(anon, "get_release_picker", { p_game: "starfall-odyssey" });
  check("the picker lists the published releases", picker.status === 200 && picker.body.releases.length === 4, `${picker.body?.releases?.length}`);
  check("each with only its fields", picker.body.releases.every((release) => keys(release) === PICKER_RELEASE));
  const platforms = await rpc(anon, "list_catalog_platforms");
  check("every platform is listed", platforms.body.length === Number(psql("select count(*) from public.platforms;")));
  const bodies = [asAnon.text, code.text, picker.text, platforms.text, (await rpc(user.headers, "get_release_picker", { p_game: "starfall-odyssey" })).text];
  check("no response names an editor, a verification, a revision, provenance or a review status",
    bodies.every((text) => !FORBIDDEN.test(text) && !text.includes(FIXTURE_EDITOR) && !text.includes(editor.id)));

  section("Not found is the same for every case");
  const ids = Object.fromEntries(psql("select title, id from public.games where title in ('Hidden Prototype Quest', 'Rejected Racer', 'Orphan Saga');").split("\n").map((line) => line.split("|")));
  const lookups = await Promise.all([
    rpc(anon, "get_release_picker", { p_game: "no-such-game" }),
    rpc(anon, "get_release_picker", { p_game: randomUUID() }),
    rpc(anon, "get_release_picker", { p_game: ids["Hidden Prototype Quest"] }),
    rpc(editor.headers, "get_release_picker", { p_game: ids["Hidden Prototype Quest"] }),
    rpc(anon, "get_release_picker", { p_game: ids["Rejected Racer"] }),
    rpc(anon, "get_release_picker", { p_game: "orphan-saga" }),
    rpc(anon, "get_release_picker", { p_game: "shadow-copy" }),
  ]);
  check("unknown, unpublished, rejected, excluded and merged-into-unpublished are identical", lookups.every((r) => r.status === 200 && r.text === "null"),
    lookups.map((r) => `${r.status}:${r.text.slice(0, 20)}`).join(" "));
  const merged = await rpc(anon, "get_release_picker", { p_game: "starfall-odysey" });
  check("a merged game resolves to the public game it was merged into", merged.body?.game?.slug === "starfall-odyssey");

  section("Pages, cursors and limits");
  const snes = platforms.body.find((p) => p.slug === "snes");
  const browsed = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await rpc(anon, "search_catalog", { p_platforms: ["snes"], p_limit: 2, p_cursor: cursor });
    browsed.push(...titles(page.body).map((title, i) => `${title}#${page.body.items[i].game.id}`));
    cursor = page.body.next_cursor;
    pages += 1;
  } while (cursor && pages < 20);
  check("browsing a platform two at a time reaches every game once", browsed.length === snes.game_count && new Set(browsed).size === browsed.length,
    `${browsed.length} of ${snes.game_count}`);
  const sorted = browsed.map((t) => t.split("#")[0]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  check("in title order", browsed.map((t) => t.split("#")[0]).join("|") === sorted.join("|"));
  const first = await rpc(anon, "search_catalog", { p_platforms: ["snes"], p_limit: 2 });
  const reused = await rpc(anon, "search_catalog", { p_query: "starfall", p_limit: 2, p_cursor: first.body.next_cursor });
  check("a cursor only continues its own query", reused.status === 400 && reused.body.message === "invalid cursor", `${reused.status} ${reused.body?.message}`);
  const forged = await rpc(anon, "search_catalog", { p_query: "starfall", p_cursor: Buffer.from('["x",1,1,1,"a","b","c"]').toString("base64url") });
  check("a forged cursor is refused", forged.status === 400 && forged.body.message === "invalid cursor");
  check("without revealing anything", !forged.body.details && !forged.body.hint, JSON.stringify(forged.body));
  const tooLong = await rpc(anon, "search_catalog", { p_query: "x".repeat(101) });
  check("a query has at most 100 characters", tooLong.status === 400 && tooLong.body.message === "query too long");
  const capped = await rpc(anon, "search_catalog", { p_platforms: ["snes"], p_limit: 1000 });
  check("a page has at most 50 results", capped.status === 200 && capped.body.items.length <= 50);

  section("Aliases, by editors only");
  const twin = psql("select id from public.games where title = 'Twin Harbor' and first_release_date = '1991-01-01';");
  const denied = await rpc(user.headers, "add_game_alias", { p_game: twin, p_title: "Port Gemini", p_kind: "alternate", p_reason: "Search checks" });
  check("an ordinary user can't add an alias", denied.status === 403 && denied.body.message === "not permitted", `${denied.status} ${denied.body?.message}`);
  const anonDenied = await rpc(anon, "add_game_alias", { p_game: twin, p_title: "Port Gemini", p_kind: "alternate", p_reason: "Search checks" });
  check("nor can anon", anonDenied.status === 401 || anonDenied.status === 403, `${anonDenied.status}`);
  check("so it isn't found", titles((await rpc(anon, "search_catalog", { p_query: "port gemini" })).body).length === 0);
  const added = await rpc(editor.headers, "add_game_alias", { p_game: twin, p_title: "Port Gemini", p_kind: "alternate", p_language_code: "en", p_reason: "Search checks: known title" });
  check("an editor adds an alias", added.status === 200 && /^[0-9a-f-]{36}$/.test(added.body), `${added.status}`);
  const found = await rpc(anon, "search_catalog", { p_query: "port gemini" });
  check("which anon then finds, saying it matched an alias", found.body.items[0]?.game.id === twin && found.body.items[0].matched?.source === "alias");
  check("and the audit log records who and why",
    psql(`select count(*) from private.audit_events where action = 'catalog_alias_added' and actor_id = '${editor.id}' and reason = 'Search checks: known title';`) === "1");
  const removed = await rpc(editor.headers, "remove_game_alias", { p_alias: added.body, p_reason: "Search checks: not a real title" });
  check("an editor removes it", removed.status === 200 && removed.body === true);
  check("and it's no longer found", titles((await rpc(anon, "search_catalog", { p_query: "port gemini" })).body).length === 0);
  const aliasRows = await fetch(`${api}/rest/v1/game_aliases?select=title`, { headers: anon }).then((r) => r.json());
  check("anon reads only aliases of published games", aliasRows.every((row) => row.title !== "Secret Starfall Quest") && aliasRows.length === 2, JSON.stringify(aliasRows));
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
