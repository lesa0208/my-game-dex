/**
 * M14a end-to-end checks: a game whose physical existence was confirmed with evidence, and
 * which is published as an identity with no verified physical release yet (B1-M1, gated by
 * 20261210100400_m14a_physical_evidence_gate), in the built app over HTTP, against a stack
 * with the B1 migrations: Explore, Game Details, adding an unidentified copy, the wishlist,
 * Collection Statistics, and a catalog change. A game whose identity was verified but whose
 * physical existence wasn't (as a batch-accepted member is left) stays out of sight.
 *
 * The two games are made through the editor functions, as the catalog fixture's editor
 * (creator) and reviewer (a different editor), never by writing published rows directly.
 *
 *   npm run build && MGD_TEST_STACK=scratch node scripts/test-stack.mjs run app:catalog-identity-checks
 *
 * Local only. Refuses every stack but scratch (the only one with the B1 migrations during
 * M14a Phase 1). Installs the catalog fixture and removes it, and every test account, at the
 * end, then checks nothing is left behind.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { api, appErrorLines, Browser, check, createUser, decode, deleteUsers, formById, forms, psql, publishableKey, readSession, results, root, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { FIXTURE_EDITOR, FIXTURE_REVIEWER, installFixture, removeFixture } from "./catalog-fixture.mjs";
import { footprint } from "./lib/footprint.mjs";
import { stackName } from "./lib/stack.mjs";

if (stackName !== "scratch") {
  console.error("Refusing: these checks need the B1 migrations, which during M14a Phase 1 are only on the scratch stack (MGD_TEST_STACK=scratch).");
  process.exit(1);
}

const PORT = 3295;
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;
const MESSAGE = "No verified physical release recorded yet";
const CONFIRMED = "Zqx Verified Identity";
const AWAITING = "Zqx Awaiting Evidence";
/** M14c-1: the evidence note the fixture reviewer records for the confirmed game's SNES pairing. */
const EVIDENCE_NOTE = "Cartridge, box and manual photographed; label and end label match the SNES listing";

function resolveSegments(html) {
  const segments = new Map([...html.matchAll(/<div hidden id="S:([^"]+)">([\s\S]*?)<\/div><script>(?:(?!<\/script>)[\s\S])*?\$RS\("S:\1"/g)].map((m) => [m[1], m[2]]));
  let out = html;
  for (let i = 0; i < 20 && /<template id="P:[^"]+"><\/template>/.test(out); i += 1) {
    out = out.replace(/<template id="P:([^"]+)"><\/template>/g, (whole, id) => segments.get(id) ?? whole);
  }
  return out;
}
const plain = (html) => decode(resolveSegments(html).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function collector(prefix) {
  const user = await createUser({ prefix });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", forms(welcome.html).find((f) => f.names.includes("handle")), { handle: `ci_${randomBytes(5).toString("hex")}` });
  return { ...user, browser };
}
async function rpc(owner, name, body) {
  const { session } = readSession(owner.browser);
  const response = await fetch(`${api}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

/**
 * A third, temporary catalog editor for this run, in the fixture's shape (Auth fields GoTrue
 * reads, a verified factor and a recent second-factor claim): publishing takes an editor who
 * neither created the game nor confirmed its evidence. Removed in the clean-up.
 */
const PUBLISHER = "f1c5f1c5-0000-4000-8000-00000000c5c7";
function addPublisher() {
  psql(`begin;
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id, confirmation_token, recovery_token, email_change_token_new, email_change, created_at, updated_at)
values ('${PUBLISHER}', 'authenticated', 'authenticated', 'catalog-identity-publisher@example.test', now(), '00000000-0000-0000-0000-000000000000', '', '', '', '', now(), now());
update public.profiles set handle = 'ci_publisher', handle_changed_at = now() where id = '${PUBLISHER}';
insert into public.staff_roles (user_id, role) values ('${PUBLISHER}', 'catalog_editor');
insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values ('${PUBLISHER}', '${PUBLISHER}', 'aal2', '${PUBLISHER}', now(), now());
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values ('${PUBLISHER}', '${PUBLISHER}', 'fixture', 'totp', 'verified', now(), now(), '');
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at) values (gen_random_uuid(), '${PUBLISHER}', 'totp', now(), now());
commit;`);
}
function removePublisher() {
  psql(`begin;
delete from public.staff_roles where user_id = '${PUBLISHER}';
delete from auth.users where id = '${PUBLISHER}';
delete from private.handle_holds where kind = 'released' and handle = 'ci_publisher';
set local session_replication_role = replica;
delete from private.audit_events where actor_id = '${PUBLISHER}';
commit;`);
}

/**
 * The two games, through the editor functions in one transaction: the fixture editor creates
 * each game and pairs it with the SNES; the reviewer verifies both identities and confirms the
 * first one's physical existence with evidence; a third editor publishes it (whoever confirmed
 * the evidence never publishes it). The second keeps a verified identity and an unverified
 * pairing: what a batch-accepted member is left with.
 */
function makeGames() {
  const as = (user) => `select set_config('request.jwt.claims', jsonb_build_object('sub', '${user}', 'role', 'authenticated', 'aal', 'aal2', 'session_id', '${user}')::text, true);`;
  const rev = (title) => `(select revision from public.games where title = ${sql(title)})`;
  const gid = (title) => `(select id from public.games where title = ${sql(title)})`;
  const snes = "(select id from public.platforms where slug = 'snes')";
  addPublisher();
  psql(`begin;
update auth.mfa_amr_claims set created_at = now(), updated_at = now() where session_id in ('${FIXTURE_EDITOR}', '${FIXTURE_REVIEWER}', '${PUBLISHER}');
${as(FIXTURE_EDITOR)}
set local role authenticated;
select public.create_game(${sql(CONFIRMED)}, 'game', null, null, '1994-06-01', 'day', 'M14a identity checks');
select public.create_game(${sql(AWAITING)}, 'game', null, null, '1994-06-02', 'day', 'M14a identity checks');
select public.set_game_platform(${gid(CONFIRMED)}, ${snes}, 'M14a identity checks');
select public.set_game_platform(${gid(AWAITING)}, ${snes}, 'M14a identity checks');
reset role;
${as(FIXTURE_REVIEWER)}
set local role authenticated;
select public.verify_game(${gid(CONFIRMED)}, 'M14a identity checks', ${rev(CONFIRMED)});
select public.verify_game(${gid(AWAITING)}, 'M14a identity checks', ${rev(AWAITING)});
select public.verify_game_platform(${gid(CONFIRMED)}, ${snes},
  '{"source": "editor", "reference": "Cartridge and box photographed; label checked", "physical_eligibility": "confirmed", "note": "${EVIDENCE_NOTE}"}', 'M14a identity checks', ${rev(CONFIRMED)});
reset role;
${as(PUBLISHER)}
set local role authenticated;
select public.publish_game_identity(${gid(CONFIRMED)}, array[${snes}], 'M14a identity checks', ${rev(CONFIRMED)});
reset role;
commit;`);
  return {
    confirmed: { id: psql(`select id from public.games where title = ${sql(CONFIRMED)};`), slug: psql(`select slug from public.games where title = ${sql(CONFIRMED)};`) },
    awaiting: { id: psql(`select id from public.games where title = ${sql(AWAITING)};`) },
    snes: psql("select id from public.platforms where slug = 'snes';"),
  };
}

let G = null;
const people = {};

async function catalogState() {
  section("The two games in the database");
  check("the confirmed game is published, with its SNES pairing published on confirmed physical evidence, and no release",
    psql(`select g.status || '/' || gp.status || '/' || (gp.verification_basis ->> 'physical_eligibility') || '/' || (select count(*) from public.releases r where r.game_id = g.id)
          from public.games g join public.game_platforms gp on gp.game_id = g.id where g.id = ${sql(G.confirmed.id)};`) === "published/published/confirmed/0");
  check("the other has a verified identity, but its pairing is unverified and nothing of it is published",
    psql(`select g.status || '/' || (g.verified_at is not null) || '/' || gp.status || '/' || (gp.verified_at is null)
          from public.games g join public.game_platforms gp on gp.game_id = g.id where g.id = ${sql(G.awaiting.id)};`) === "under_review/true/under_review/true");
}

async function explore() {
  section("Explore");
  const visitor = new Browser();
  const found = plain((await visitor.get(`/explore?q=${encodeURIComponent("Zqx Verified")}`)).html);
  check("the confirmed game is found", found.includes(CONFIRMED));
  check(`its result says "${MESSAGE}"`, found.includes(`${MESSAGE}.`));
  check("and its SNES chip says no verified release yet, not \"0 releases\"", found.includes("SNES · no verified release yet") && !found.includes("0 releases"));
  const hidden = plain((await visitor.get(`/explore?q=${encodeURIComponent("Zqx Awaiting")}`)).html);
  check("the game without physical evidence isn't found", !hidden.includes(AWAITING));
  const fixture = plain((await visitor.get(`/explore?q=${encodeURIComponent("Starfall Odyssey")}`)).html);
  check("a game with releases still shows its release count, and no such message", /SNES · \d+ releases?/.test(fixture) && !fixture.includes(MESSAGE));
}

async function gameDetails() {
  section("Game Details");
  const visitor = new Browser();
  const page = await visitor.get(`/games/${G.confirmed.slug}`);
  const text = plain(page.html);
  people.gameText = text;
  check("the page loads for a visitor", page.response.status === 200, `${page.response.status}`);
  check("its facts give the platform and the message", text.includes("Platform Super Nintendo Entertainment System") && text.includes(`Physical releases ${MESSAGE}`));
  check("the releases section says none is recorded, and invents no edition, region, publisher, format or packaging",
    text.includes(`${MESSAGE}. The catalog records ${CONFIRMED} on Super Nintendo Entertainment System, but none of its editions, regions, publishers, formats or packaging yet.`));
  check("no release row, product code or shell is shown", !/Want this release|SNS-|NTSC-U\/C release|PAL release/.test(text) && !resolveSegments(page.html).includes('data-media="snes-cart"'));
  check("its first release date is the catalog's", text.includes("First released") && text.includes("1994"));
  const awaiting = await visitor.get(`/games/${encodeURIComponent(psql(`select coalesce(slug, 'zqx-awaiting-evidence') from public.games where id = ${sql(G.awaiting.id)};`))}`);
  // A not-found page streams with status 200; Next marks it in the page data (as on copy pages).
  check("the game without physical evidence has no page, and nothing of it is shown",
    (awaiting.response.status === 404 || awaiting.html.includes("NEXT_HTTP_ERROR_FALLBACK;404")) && !plain(awaiting.html).includes(AWAITING), `${awaiting.response.status}`);
}

async function collecting() {
  section("Collecting it");
  const c = (people.collector = await collector("cic"));
  const page = await c.browser.get(`/games/${G.confirmed.slug}`);
  const html = resolveSegments(page.html);
  check("signed in, the add steps offer the SNES (the existing picker)", html.includes(`href="/games/${G.confirmed.slug}?platform=snes"`));
  const claim = await rpc(c, "add_unidentified_copy", { p_item_id: uuidv7(), p_game: G.confirmed.id, p_platform: G.snes, p_region: "pal", p_edition_kind: null, p_edition_name: null, p_details: { completeness: "complete" } });
  check("a copy of it is added as the collector's own record (an unidentified copy)", Boolean(claim.json?.item_id), `${claim.status}`);
  const refused = await rpc(c, "add_unidentified_copy", { p_item_id: uuidv7(), p_game: G.awaiting.id, p_platform: G.snes, p_region: null, p_edition_kind: null, p_edition_name: null, p_details: {} });
  check("the game without physical evidence can't be claimed", !refused.json?.item_id, `${refused.status}`);
  const copiesPage = await c.browser.get(`/games/${G.confirmed.slug}`);
  const copies = plain(copiesPage.html);
  // M12b's headline for one copy, and the copy itself with the region it records.
  check("the game page says it's owned, and lists the copy with its recorded region", copies.includes("Owned: Yes") && /PAL/.test(copies.slice(copies.indexOf("Owned: Yes"))));
}

async function wishing() {
  section("The wishlist");
  const c = people.collector;
  const page = await c.browser.get(`/games/${G.confirmed.slug}`);
  const add = formById(page.html, "add-wish");
  check("the game page has the wishlist form", Boolean(add));
  const raw = resolveSegments(page.html);
  const wishForm = raw.slice(raw.indexOf('id="add-wish"'), raw.indexOf("</form>", raw.indexOf('id="add-wish"')));
  check("it offers the game, platform and region levels, and no exact release", ["game", "platform", "region"].every((l) => wishForm.includes(`value="${l}"`)) && !wishForm.includes('value="release"'));
  for (const fields of [{ level: "game" }, { level: "platform", platform_id: G.snes }, { level: "region", platform_id: G.snes, region_code: "ntsc-j" }]) {
    const form = formById((await c.browser.get(`/games/${G.confirmed.slug}`)).html, "add-wish");
    await c.browser.submit(`/games/${G.confirmed.slug}`, form, { priority: "2", completeness: "", note: "", ...fields });
  }
  check("game, platform and region wishes are stored (any region, none catalogued)", psql(`select count(*) from public.wishlist_items where owner_id = ${sql(c.id)} and game_id = ${sql(G.confirmed.id)};`) === "3");
  const refused = await rpc(c, "add_wishlist_item", { p_item_id: uuidv7(), p_target: { game_id: G.awaiting.id }, p_details: {} });
  check("the game without physical evidence can't be wished for", refused.status >= 400 && /game unavailable/.test(JSON.stringify(refused.json)), `${refused.status}`);
  const list = plain((await c.browser.get("/collection/wishlist")).html);
  check("the wishlist shows them, available", list.includes(CONFIRMED) && !list.includes("no longer in the catalog"));
}

async function statistics() {
  section("Collection Statistics");
  const text = plain((await people.collector.browser.get("/collection/statistics")).html);
  check("the copy counts: 1 copy, 1 game, 1 system", text.includes("1 Physical copy") && text.includes("1 Distinct game") && text.includes("1 System"));
  check("on the SNES, in its recorded region, complete in box", text.includes("Super Nintendo Entertainment System 1 copy · 1 game 100%") && text.includes("Complete in box 1 100%") && /PAL 1 100%/.test(text));
  check("with its format not recorded, never guessed", text.slice(text.indexOf("Physical media")).includes("Not recorded 1 100%"));
}

async function catalogChange() {
  section("A catalog change");
  const c = people.collector;
  // The game leaves the catalog (simulated, as the wishlist checks do), then comes back.
  psql(`begin; set local session_replication_role = replica; update public.games set status = 'excluded' where id = ${sql(G.confirmed.id)}; commit;`);
  try {
    check("the copy is kept", psql(`select count(*) from public.collection_items where owner_id = ${sql(c.id)};`) === "1");
    check("and the wishes too", psql(`select count(*) from public.wishlist_items where owner_id = ${sql(c.id)};`) === "3");
    const list = plain((await c.browser.get("/collection/wishlist")).html);
    check("the wishlist says the game is no longer in the catalog", list.includes(CONFIRMED) && /no longer in the catalog/i.test(list));
    const stats = plain((await c.browser.get("/collection/statistics")).html);
    check("Statistics still count the copy", stats.includes("1 Physical copy"));
  } finally {
    psql(`begin; set local session_replication_role = replica; update public.games set status = 'published' where id = ${sql(G.confirmed.id)}; commit;`);
  }
  const back = plain((await c.browser.get("/collection/wishlist")).html);
  check("restored, the wishes are available again", back.includes(CONFIRMED) && !/no longer in the catalog/i.test(back));
}

/**
 * M14c-1: the staff game record's evidence section, over HTTP. A catalog editor (a throwaway
 * account with its own authenticator) sees each pairing's physical-evidence state, basis,
 * verifier and publication eligibility; a collector, a visitor and the public game page see none
 * of it, and neither can the evidence read be called directly.
 */
async function staffEvidence() {
  section("Staff evidence");
  const user = await createUser({ prefix: "ci-staff", mfa: true });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", forms(welcome.html).find((f) => f.names.includes("handle")), { handle: `ci_${randomBytes(5).toString("hex")}` });
  psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', 'catalog_editor');`);
  people.staff = { ...user, browser };
  const reviewer = psql(`select handle from public.profiles where id = '${FIXTURE_REVIEWER}';`);

  const confirmed = await browser.get(`/admin/catalog/games/${G.confirmed.id}`);
  const c = plain(confirmed.html);
  check("staff see the game's platforms with their physical evidence", confirmed.response.status === 200 && c.includes("Platforms and physical evidence"));
  check("the published identity says so, with no verified release", c.includes("Published identity, no verified release.") && c.includes("Physical releases None recorded"));
  const facts = ["Physical existence Confirmed with evidence", "Evidence source editor", "Evidence reference Cartridge and box photographed; label checked", `Evidence note ${EVIDENCE_NOTE}`];
  check("with its evidence: confirmed, source, reference and the reviewer's note", facts.every((f) => c.includes(f)),
    `missing: ${facts.filter((f) => !c.includes(f)).join(" | ")}`);
  check("who confirmed it, by handle only, and when", Boolean(reviewer) && c.includes(`Verified by @${reviewer}`) && /Verified [A-Z][a-z]+ \d{1,2}, /.test(c) && !c.includes("@example.test"));
  check("and that its identity is already public", c.includes("Identity publication Already public."));
  const awaiting = plain((await browser.get(`/admin/catalog/games/${G.awaiting.id}`)).html);
  check("a pairing without evidence says its physical existence isn't confirmed",
    awaiting.includes("Physical existence not confirmed.") && awaiting.includes("Physical existence Not confirmed: no evidence recorded"));
  check("shows no evidence, verifier or date it doesn't have", !awaiting.includes("Evidence note") && !awaiting.includes("Verified by"));
  check("and that it can't be published until its physical existence is confirmed",
    awaiting.includes("Identity publication Not yet: its physical existence hasn't been confirmed with evidence."));

  const asCollector = plain((await people.collector.browser.get(`/admin/catalog/games/${G.confirmed.id}`)).html);
  check("a collector doesn't get the staff record or its evidence", !asCollector.includes("Platforms and physical evidence") && !asCollector.includes(EVIDENCE_NOTE));
  const visitor = await new Browser().get(`/admin/catalog/games/${G.confirmed.id}`);
  const v = plain(visitor.html);
  check("nor does a visitor", !v.includes("Platforms and physical evidence") && !v.includes(EVIDENCE_NOTE));
  const publicPage = plain((await new Browser().get(`/games/${G.confirmed.slug}`)).html);
  check("the public game page shows no evidence note, basis or verifier",
    !publicPage.includes(EVIDENCE_NOTE) && !publicPage.includes("Evidence note") && !publicPage.includes("Cartridge and box photographed; label checked") && !publicPage.includes(`@${reviewer}`));
  const direct = await rpc(people.collector, "get_game_pairing_evidence", { p_game: G.confirmed.id });
  check("a collector can't call the evidence read", direct.status >= 400 && !JSON.stringify(direct.json ?? "").includes(EVIDENCE_NOTE), `status ${direct.status}`);
  const anon = await fetch(`${api}/rest/v1/rpc/get_game_pairing_evidence`, {
    method: "POST", headers: { apikey: publishableKey, "Content-Type": "application/json" }, body: JSON.stringify({ p_game: G.confirmed.id }),
  });
  check("nor can a visitor", !anon.ok && !(await anon.text()).includes(EVIDENCE_NOTE));
  const basis = await fetch(`${api}/rest/v1/game_platforms?select=verification_basis&game_id=eq.${G.confirmed.id}`, { headers: { apikey: publishableKey } });
  check("and no visitor can read a pairing's basis from the table", !basis.ok && !(await basis.text()).includes(EVIDENCE_NOTE));
}

let browserApp = null;
async function inBrowser() {
  section("In a real browser");
  const { chromium } = createRequire(join(root, "package.json"))("playwright-core");
  for (const channel of [process.env.A11Y_BROWSER, "msedge", "chrome"].filter(Boolean)) {
    try {
      browserApp = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // Try the next one.
    }
  }
  check("a browser (Edge or Chrome) started", Boolean(browserApp));
  if (!browserApp) return;
  const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  for (const [name, path, user] of [
    ["game page, no verified release", `/games/${G.confirmed.slug}`, null],
    ["game page, no verified release, signed in", `/games/${G.confirmed.slug}`, people.collector],
    ["Explore result", `/explore?q=${encodeURIComponent("Zqx Verified")}`, null],
    // M14c-1: the staff evidence section, confirmed and not confirmed.
    ["staff game record, published identity", `/admin/catalog/games/${G.confirmed.id}`, people.staff],
    ["staff game record, physical existence not confirmed", `/admin/catalog/games/${G.awaiting.id}`, people.staff],
  ]) {
    for (const viewport of [{ tag: "phone", width: 390, height: 844 }, { tag: "desktop", width: 1280, height: 900 }]) {
      const context = await browserApp.newContext({ viewport, colorScheme: "dark" });
      if (user) await context.addCookies([...user.browser.cookies].map(([n, value]) => ({ name: n, value, url: `http://127.0.0.1:${PORT}` })));
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
      await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: "networkidle" });
      await page.addScriptTag({ content: axe });
      const found = await page.evaluate(async () => {
        const run = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
        return run.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length }));
      });
      const blocking = found.filter((v) => v.impact === "critical" || v.impact === "serious");
      check(`${viewport.tag} ${name}: no critical or serious axe findings`, blocking.length === 0, blocking.map((v) => `${v.impact} ${v.id}(${v.count})`).join("; "));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${viewport.tag} ${name}: no sideways scrolling and no console errors`, overflow <= 0 && errors.length === 0, `${overflow}px ${errors.slice(0, 2).join(" | ")}`);
      await context.close();
    }
  }
}

const LEFTOVER_TABLES = ["public.collection_items", "public.wishlist_items", "public.games", "public.releases", "public.game_platforms"];
const startingFootprint = footprint(psql, LEFTOVER_TABLES);

try {
  installFixture();
  G = makeGames();
  await startApp(PORT);
  await catalogState();
  await explore();
  await gameDetails();
  await collecting();
  await wishing();
  await statistics();
  await catalogChange();
  await staffEvidence();
  await inBrowser();
} catch (error) {
  check("the checks ran to the end", false, `${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ""}`);
} finally {
  await browserApp?.close().catch(() => {});
  stopApp();
  const ids = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ci\\_%';");
  if (ids.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${ids.map((id) => `'${id}'`).join(",")}); delete from private.request_slots where user_id in (${ids.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  removePublisher();
  removeFixture();
  check("no copies, wishes or catalog data are left behind", footprint(psql, LEFTOVER_TABLES) === startingFootprint);
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed ? 1 : 0);
