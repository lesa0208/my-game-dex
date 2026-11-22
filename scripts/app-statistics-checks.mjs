/**
 * M13 end-to-end checks: Collection Statistics (/collection/statistics), driven over HTTP
 * as a browser without JavaScript would, against the production build, the isolated test
 * stack and its fictional catalog fixture. Throwaway accounts only; copies are added with
 * the collector's own session through the collection functions. One release's exclusion
 * is simulated by postgres (as the wishlist checks do) and undone.
 *
 * A real browser (Edge, or Chrome) then audits the page with axe-core at phone and desktop
 * widths, follows a system to its shelf and back with the keyboard and, with
 * STATISTICS_SCREENSHOTS=<folder>, takes screenshots.
 *
 *   npm run build && MGD_STACK=test npm run app:statistics-checks
 *
 * Local only. Installs the catalog fixture and removes it, and every test account, at the
 * end, then checks nothing is left behind. Prints check names and statuses, never keys,
 * tokens, cookies or addresses.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { api, appErrorLines, Browser, check, createUser, decode, deleteUsers, forms, location, psql, publishableKey, readSession, results, root, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { footprint } from "./lib/footprint.mjs";

const PORT = 3293;
const STATS = "/collection/statistics";
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** React streams parts of a page as segments; put each where its placeholder is. */
function resolveSegments(html) {
  // The first segment's script defines $RS before calling it: allow anything but the
  // end of the script between <script> and the call.
  const segments = new Map([...html.matchAll(/<div hidden id="S:([^"]+)">([\s\S]*?)<\/div><script>(?:(?!<\/script>)[\s\S])*?\$RS\("S:\1"/g)].map((m) => [m[1], m[2]]));
  let out = html;
  for (let i = 0; i < 20 && /<template id="P:[^"]+"><\/template>/.test(out); i += 1) {
    out = out.replace(/<template id="P:([^"]+)"><\/template>/g, (whole, id) => segments.get(id) ?? whole);
  }
  return out;
}
const plain = (html) => decode(resolveSegments(html).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const has = (text, fragment) => text.includes(fragment);

function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// The fixture and accounts
// ---------------------------------------------------------------------------

const one = (query) => {
  const value = psql(query);
  if (!value) throw new Error(`fixture record missing: ${query.slice(0, 80)}`);
  return value;
};
const fxRelease = (game, platform, region, extra = "") =>
  one(`select r.id from public.releases r join public.games g on g.id = r.game_id join public.platforms p on p.id = r.platform_id
    where g.title = ${sql(game)} and p.slug = ${sql(platform)} and r.region_code = ${sql(region)} and r.status = 'published' ${extra} order by r.created_at limit 1;`);
let F = null;
function fixture() {
  return {
    starfallUs: one("select id from public.releases where product_code = 'SNS-ZSFE-USA' and status = 'published';"),
    starfallEu: one("select id from public.releases where product_code = 'SNSP-ZSFP-EUR' and status = 'published';"),
    starfallJp: one("select id from public.releases where product_code = 'SHVC-ZSFJ-JPN' and status = 'published';"),
    neonPs: one("select id from public.releases where product_code = 'SLUS-00999' and status = 'published';"),
    neonSaturn: one("select id from public.releases where product_code = 'T-99901G' and status = 'published';"),
    tessalyEu: one("select id from public.releases where product_code = 'SLES-01234' and status = 'published';"),
    poketrailUs: one("select id from public.releases where product_code = 'DMG-APTE-USA' and status = 'published';"),
    meadow: fxRelease("Quiet Meadow", "snes", "unknown"),
    clayboxer: fxRelease("ClayBoxer Turbo", "snes", "ntsc-uc"),
    starfall: one("select id from public.games where title = 'Starfall Odyssey' and status = 'published';"),
    starfallSlug: one("select slug from public.games where title = 'Starfall Odyssey' and status = 'published';"),
    warden: one("select g.id from public.games g join public.releases r on r.game_id = g.id where r.product_code = 'MK-1701' and g.status = 'published';"),
    snes: one("select id from public.platforms where slug = 'snes';"),
    megaDrive: one("select id from public.platforms where slug = 'mega-drive';"),
  };
}

async function collector(prefix) {
  const user = await createUser({ prefix });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  const handle = `st_${randomBytes(5).toString("hex")}`;
  await browser.submit("/welcome", forms(welcome.html).find((f) => f.names.includes("handle")), { handle });
  return { ...user, handle, browser };
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
async function addCopy(owner, release, details = {}) {
  const result = await rpc(owner, "add_collection_item", { p_item_id: uuidv7(), p_release: release, p_details: details });
  if (!result.json?.item_id) throw new Error(`could not add a copy (${result.status})`);
  return result.json.item_id;
}
async function addClaim(owner, game, platform, region, details = {}) {
  const result = await rpc(owner, "add_unidentified_copy", { p_item_id: uuidv7(), p_game: game, p_platform: platform, p_region: region, p_edition_kind: null, p_edition_name: null, p_details: details });
  if (!result.json?.item_id) throw new Error(`could not add an unidentified copy (${result.status})`);
  return result.json.item_id;
}
const copiesOf = (u) => Number(psql(`select count(*) from public.collection_items where owner_id = ${sql(u.id)};`));

const people = {};
let preservedCopy = null;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function signedOut() {
  section("Signed out");
  const visitor = new Browser();
  const page = await visitor.get(STATS);
  const to = location(page.response);
  check("statistics send a visitor to sign in", (page.response.status >= 300 && page.response.status < 400 && to.startsWith("/sign-in")) || /\/sign-in\?next=%2Fcollection%2Fstatistics/.test(page.html), `${page.response.status}`);
  check("and show none of anyone's numbers", !/Physical copies|Distinct games/.test(plain(page.html)));
}

async function empty() {
  section("An empty collection");
  const empty = (people.empty = await collector("ste"));
  const page = await empty.browser.get(STATS);
  const text = plain(page.html);
  check("the page loads for a collector with no copies", page.response.status === 200);
  check("and says there are no statistics yet, with a way to add games", has(text, "No statistics yet") && page.html.includes('href="/explore"'));
  check("with no figures", !has(text, "Physical copies") && !has(text, "By system"));
}

/** Thirteen copies on five systems: every counting rule at once. */
async function build() {
  const o = (people.owner = await collector("sto"));
  const secret = { purchase_price: "987.65", currency: "EUR", acquired_on: "2001-02-03", notes: "zz-private-note-zz", storage_location: "zz-attic-shelf-zz" };
  await addCopy(o, F.starfallUs, { completeness: "complete", ...secret });
  await addCopy(o, F.starfallUs, { completeness: "sealed" });
  await addCopy(o, F.starfallUs, {});
  await addCopy(o, F.starfallEu, { completeness: "loose" });
  await addCopy(o, F.starfallJp, { completeness: "incomplete" });
  await addCopy(o, F.neonPs, { completeness: "complete" });
  await addCopy(o, F.neonSaturn, { completeness: "sealed" });
  await addCopy(o, F.tessalyEu, { completeness: "complete" });
  await addCopy(o, F.poketrailUs, {});
  await addCopy(o, F.meadow, { completeness: "loose" });
  await addClaim(o, F.warden, F.megaDrive, "pal", { completeness: "complete" });
  await addClaim(o, F.starfall, F.snes, null, {});
  preservedCopy = await addCopy(o, F.clayboxer, {});
  // The release leaves the catalog and its copy is kept privately, as an exclusion does.
  psql(`begin; set local session_replication_role = replica;
    update public.releases set status = 'excluded' where id = ${sql(F.clayboxer)};
    update public.collection_items set record_status = 'invalid_preserved', invalidated_at = now() where id = ${sql(preservedCopy)};
    commit;`);
  return o;
}

function undoExclusion() {
  if (!preservedCopy) return;
  psql(`begin; set local session_replication_role = replica;
    update public.collection_items set record_status = 'active', invalidated_at = null where id = ${sql(preservedCopy)};
    update public.releases set status = 'published' where id = ${sql(F.clayboxer)};
    commit;`);
  preservedCopy = null;
}

async function overview() {
  section("A collection on five systems");
  const o = await build();
  check("the collector has 13 copies", copiesOf(o) === 13, `${copiesOf(o)}`);
  const page = await o.browser.get(STATS);
  const text = plain(page.html);
  people.ownerText = text;
  check("the page loads", page.response.status === 200, `${page.response.status}`);
  check("13 physical copies", has(text, "13 Physical copies"));
  check("6 distinct games: several copies of one release, regional releases and an unidentified copy of one game count once", has(text, "6 Distinct games"));
  check("5 systems", has(text, "5 Systems"));
  check("complete in box or sealed: 6 of 13 is 46%", has(text, "46% Complete in box or sealed"));
  check("the copy whose release left the catalog is a copy but not a game, and says why", has(text, "1 copy is counted as a copy but not as a game") && page.html.includes('href="/collection?status=invalid"'));

  section("Completeness");
  check("sealed 2 (15%)", has(text, "Sealed 2 15%"));
  check("complete in box 4 (31%)", has(text, "Complete in box 4 31%"));
  check("incomplete 1 (8%)", has(text, "Incomplete 1 8%"));
  { const r = resolveSegments(page.html); const i = r.indexOf("Loose (medium only)</span>"); check("loose 2 (15%)", has(text, "Loose (medium only) 2 15%"), r.slice(i, i + 400)); }
  check("not recorded 4 (31%), in the same denominator", has(text, "Not recorded 4 31%"));
  check("the bar's accessible name gives every part", /role="img" aria-label="Completeness of all copies: Sealed 2 copies \(15%\), Complete in box 4 copies \(31%\), Incomplete 1 copy \(8%\), Loose \(medium only\) 2 copies \(15%\), Not recorded 4 copies \(31%\)"/.test(decode(resolveSegments(page.html))));

  section("By system");
  const rows = [
    ["Super Nintendo Entertainment System", "7 copies · 2 games", "54%"],
    ["PlayStation", "2 copies · 2 games", "15%"],
    ["Saturn", "1 copy · 1 game", "8%"],
    ["Game Boy", "1 copy · 1 game", "8%"],
    ["Mega Drive", "1 copy · 1 game", "8%"],
  ];
  for (const [name, line, share] of rows) check(`${name}: ${line}, ${share} of copies`, has(text, `${name} ${line} ${share}`));
  check("each system has one bar, split by completeness, named in full", decode(resolveSegments(page.html)).includes("aria-label=\"Super Nintendo Entertainment System: 7 copies, 54% of your copies. Completeness: Sealed 1 copy (14%), Complete in box 1 copy (14%), Incomplete 1 copy (14%), Loose (medium only) 2 copies (29%), Not recorded 2 copies (29%)\""));
  check("most copies first", text.indexOf("Super Nintendo Entertainment System 7 copies") < text.indexOf("PlayStation 2 copies"));
  check("a game on two systems counts once on each (Neon Drift Racing: PlayStation and Saturn)", has(text, "PlayStation 2 copies · 2 games") && has(text, "Saturn 1 copy · 1 game"));
  check("the copy with no known system is on no row, and says so", has(text, "1 copy has no known system"));
  for (const slug of ["snes", "playstation", "sega-saturn", "game-boy", "mega-drive"]) {
    check(`the ${slug} row links to its shelf`, resolveSegments(page.html).includes(`href="/collection/systems/${slug}"`));
  }
  // The Systems screen's tiles are named "<system>: <copies>" (from the collection summary).
  const systemsHtml = decode(resolveSegments((await o.browser.get("/collection/systems")).html));
  for (const [name, line] of rows) {
    const copiesText = line.split(" · ")[0];
    check(`${name}: the same ${copiesText} as its Systems tile`, systemsHtml.includes(`aria-label="${name}: ${copiesText}"`));
  }

  section("Regions and physical media");
  for (const [label, n, share] of [["NTSC-U/C", 5, "38%"], ["PAL", 3, "23%"], ["NTSC-J", 2, "15%"], ["Region unknown in the catalog", 1, "8%"], ["Not recorded", 1, "8%"], ["No longer in the catalog", 1, "8%"]]) {
    check(`region ${label}: ${n} (${share})`, has(text, `Regions`) && new RegExp(`${label.replace(/[()/]/g, "\\$&")} ${n} ${share}`).test(text.slice(text.indexOf("Regions"), text.indexOf("Physical media"))));
  }
  const media = text.slice(text.indexOf("Physical media"), text.indexOf("Several copies"));
  for (const [label, n, share] of [["ROM cartridge", 6, "46%"], ["CD-ROM", 3, "23%"], ["Game Boy Game Pak", 1, "8%"], ["Not recorded", 2, "15%"], ["No longer in the catalog", 1, "8%"]]) {
    check(`format ${label}: ${n} (${share})`, has(media, `${label} ${n} ${share}`), media.slice(0, 300));
  }
  check("no format is guessed for unidentified copies: they are 'Not recorded'", has(media, "Not recorded 2 15%"));

  section("Several copies");
  const several = text.slice(text.indexOf("Several copies"));
  check("2 games with several copies", has(several, "Games with several copies 2"));
  check("6 copies beyond the first of each game", has(several, "Copies beyond the first of each game 6"));
  check("1 release with several copies", has(several, "Release with several copies 1"));
  check("Starfall Odyssey first: 6 copies, 3 releases (an unidentified copy has none)", has(several, "Starfall Odyssey 6 copies · 3 releases"));
  check("then Neon Drift Racing: 2 copies, 2 releases, 2 systems", has(several, "Neon Drift Racing 2 copies · 2 releases · 2 systems"));
  check("the game links to its page", resolveSegments(page.html).includes(`href="/games/${F.starfallSlug}"`));
  check("the counting rules are explained on the page", has(text, "How these are counted") && has(text, "Shares are of all your copies"));
}

async function privacy() {
  section("Privacy");
  const text = people.ownerText;
  check("no purchase price, date, note or storage place reaches the page", !/987\.65|987,65|2001-02-03|zz-private-note-zz|zz-attic-shelf-zz/.test(text));
  const raw = (await people.owner.browser.get(STATS)).html;
  check("not in the page's data either", !/987\.65|2001-02-03|zz-private-note-zz|zz-attic-shelf-zz/.test(raw));
  const copyIds = psql(`select id from public.collection_items where owner_id = ${sql(people.owner.id)};`).split("\n").filter(Boolean);
  check(`none of the collector's ${copyIds.length} copy ids is sent (the layout's own user menu names the viewer)`, copyIds.length === 13 && copyIds.every((id) => !raw.includes(id)));

  const other = (people.other = await collector("stx"));
  await addCopy(other, F.tessalyEu, { completeness: "sealed" });
  const theirs = plain((await other.browser.get(STATS)).html);
  check("another collector sees only their own one copy", has(theirs, "1 Physical copy") && has(theirs, "1 Distinct game") && has(theirs, "1 System"));
  check("on one system, which is 100% of their copies", has(theirs, "PlayStation 1 copy · 1 game 100%"));
  check("and nothing of the first collector's", !has(theirs, "Starfall") && !has(theirs, "Super Nintendo") && !has(theirs, "13 Physical"));
  check("their completeness: all sealed", has(theirs, "Sealed 1 100%") && has(theirs, "Not recorded 0 0%"));

  // A session that was signed out everywhere can't read statistics.
  const ended = await collector("sts");
  await addCopy(ended, F.tessalyEu, {});
  const stale = new Browser();
  for (const [name, value] of ended.browser.cookies) stale.cookies.set(name, value);
  const { session } = readSession(ended.browser);
  await fetch(`${api}/auth/v1/logout?scope=global`, { method: "POST", headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}` } });
  const after = await stale.get(STATS);
  check("after signing out everywhere, the old cookies show no statistics", !has(plain(after.html), "Physical cop"), `${after.response.status}`);
}

async function navigation() {
  section("Navigation");
  const o = people.owner;
  const collection = await o.browser.get("/collection");
  check("My Collection links to Statistics", resolveSegments(collection.html).includes(`href="${STATS}"`));
  // The same collection summary My Collection shows: 13 copies on the same 5 systems.
  check("My Collection's total and platforms agree with the statistics (13 copies on 5)", has(plain(collection.html), "13 copies Physical copies on 5 platforms") && has(people.ownerText, "13 Physical copies") && has(people.ownerText, "5 Systems"));
  const page = await o.browser.get(STATS);
  check("Statistics links back to My Collection", resolveSegments(page.html).includes('href="/collection"'));
  const shelf = await o.browser.get("/collection/systems/snes");
  check("a system's shelf opens from its statistics row", shelf.response.status === 200 && has(plain(shelf.html), "Super Nintendo"));
  const mobileNav = readFileSync(join(root, "src", "config", "navigation.ts"), "utf8");
  check("the mobile bottom navigation is unchanged (no Statistics item)", !/statistics/i.test(mobileNav));
}

const LARGE = Number(process.env.STATISTICS_COPIES ?? 5000);
async function performance() {
  section("A large collection");
  const big = (people.big = await collector("stb"));
  // 5,000 copies by default (STATISTICS_COPIES to change it) over every published release on the stack, made as postgres: the
  // functions' rules are covered above; this measures reading and counting.
  psql(`insert into public.collection_items (id, owner_id, release_id, completeness)
    select private.uuid_v7(), ${sql(big.id)}, r.id, (array['sealed','complete','incomplete','loose',null])[1 + n % 5]::public.completeness
    from generate_series(1, ${LARGE}) n
    join lateral (select id from public.releases where status = 'published' order by id offset (n % (select count(*) from public.releases where status = 'published')) limit 1) r on true;
    analyze public.collection_items;`);
  // A long insert can outlast the HTTP client's idle connection to the app: drop it with a
  // throwaway request before timing.
  await big.browser.get("/home").catch(() => {});
  const total = copiesOf(big);
  const times = [];
  let text = "";
  for (let i = 0; i < 3; i += 1) {
    const started = Date.now();
    text = plain((await big.browser.get(STATS)).html);
    times.push(Date.now() - started);
  }
  times.sort((a, b) => a - b);
  console.log(`  ${total} copies: statistics in ${times.join(", ")} ms`);
  check(`with ${total.toLocaleString("en")} copies, every copy is counted`, has(text, `${total.toLocaleString("en")} Physical copies`));
  const distinct = psql(`select count(distinct r.game_id) from public.collection_items c join public.releases r on r.id = c.release_id where c.owner_id = ${sql(big.id)};`);
  check(`and the distinct games match the database (${distinct})`, has(text, `${Number(distinct).toLocaleString("en")} Distinct games`));
  check("it loads in under 3 seconds (median)", times[1] < 3000, `${times[1]} ms`);
  const notRecorded = Number(psql(`select count(*) from public.collection_items where owner_id = ${sql(big.id)} and completeness is null;`));
  check(`'Not recorded' completeness matches the database (${notRecorded})`, has(text, `Not recorded ${notRecorded.toLocaleString("en")} `));
}

// ---------------------------------------------------------------------------
// In a real browser
// ---------------------------------------------------------------------------

const screenshots = process.env.STATISTICS_SCREENSHOTS ?? null;
let browserApp = null;
let axeSource = null;

async function launch() {
  const { chromium } = createRequire(join(root, "package.json"))("playwright-core");
  for (const channel of [process.env.A11Y_BROWSER, "msedge", "chrome"].filter(Boolean)) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // Try the next one.
    }
  }
  return null;
}
async function contextFor(user, viewport) {
  const context = await browserApp.newContext({ viewport, colorScheme: "dark" });
  if (user) await context.addCookies([...user.browser.cookies].map(([name, value]) => ({ name, value, url: `http://127.0.0.1:${PORT}` })));
  return context;
}
async function shot(name, user, path, { width = 1440, height = 900, full = true } = {}) {
  mkdirSync(screenshots, { recursive: true });
  const context = await contextFor(user, { width, height });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: full });
  await context.close();
}
async function audit(user, name, path) {
  for (const viewport of [{ tag: "phone", width: 390, height: 844 }, { tag: "desktop", width: 1280, height: 900 }]) {
    const context = await contextFor(user, viewport);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
    await page.addScriptTag({ content: axeSource });
    const found = await page.evaluate(async () => {
      const run = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
      return run.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, target: String(v.nodes[0]?.target ?? "") }));
    });
    const blocking = found.filter((v) => v.impact === "critical" || v.impact === "serious");
    for (const v of found.filter((x) => !blocking.includes(x))) console.log(`  note ${viewport.tag} ${name}: ${v.impact} ${v.id} (${v.count})`);
    check(`${viewport.tag} ${name}: no critical or serious axe findings`, blocking.length === 0, blocking.map((v) => `${v.impact} ${v.id}(${v.count}) ${v.target}`).join("; "));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${viewport.tag} ${name}: no sideways scrolling and no console errors`, overflow <= 0 && errors.length === 0, `${overflow}px, ${errors.slice(0, 2).join(" | ")}`);
    await context.close();
  }
}

async function inBrowser() {
  section("In a real browser");
  browserApp = await launch();
  check("a browser (Edge or Chrome) started for the browser checks", Boolean(browserApp));
  if (!browserApp) return;
  axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  await audit(people.owner, "statistics", STATS);
  await audit(people.empty, "statistics, empty", STATS);
  await audit(people.other, "statistics, one system", STATS);

  // Keyboard only: from a system's row to its shelf, and back.
  const context = await contextFor(people.owner, { width: 1280, height: 900 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}${STATS}`, { waitUntil: "networkidle" });
  const link = page.locator('#stats-systems ~ div a[href="/collection/systems/playstation"]');
  await link.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/collection\/systems\/playstation$/);
  check("keyboard: Enter on a system opens its shelf", page.url().endsWith("/collection/systems/playstation"));
  await page.goBack();
  await page.waitForURL(/\/collection\/statistics$/);
  check("and the back button returns to the statistics", page.url().endsWith(STATS));
  const active = await page.locator('nav[aria-label="Main"] a[aria-current="page"]').evaluateAll((links) => links.filter((a) => a.offsetParent !== null).map((a) => a.getAttribute("href")));
  check("on Statistics, the sidebar marks My Collection", JSON.stringify(active) === JSON.stringify(["/collection"]), active.join(" "));
  await context.close();

  if (screenshots) {
    await shot("01-statistics-desktop", people.owner, STATS);
    await shot("02-statistics-mobile", people.owner, STATS, { width: 390, height: 844 });
    await shot("03-statistics-empty", people.empty, STATS, { full: false });
    await shot("04-statistics-one-system", people.other, STATS);
    await shot("05-statistics-large", people.big, STATS);
    await shot("06-my-collection-entry", people.owner, "/collection", { full: false });
  }
}

// ---------------------------------------------------------------------------

const LEFTOVER_TABLES = ["public.collection_items", "public.collection_item_private", "public.games", "public.releases", "public.game_platforms"];
const startingFootprint = footprint(psql, LEFTOVER_TABLES);
const statuses = () => psql("select md5(string_agg(id::text || status::text, ',' order by id)) from public.releases;");

try {
  installFixture();
  F = fixture();
  const releaseStatuses = statuses();
  await startApp(PORT);
  await signedOut();
  await empty();
  await overview();
  await privacy();
  await navigation();
  await performance();
  // In the browser while the exclusion is still simulated, so the page shows it.
  await inBrowser();
  undoExclusion();
  check("the simulated exclusion was undone", statuses() === releaseStatuses);
} catch (error) {
  check("the checks ran to the end", false, `${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ""}`);
} finally {
  await browserApp?.close().catch(() => {});
  stopApp();
  undoExclusion();
  const ids = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'st\\_%';");
  if (ids.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${ids.map((id) => `'${id}'`).join(",")}); delete from private.request_slots where user_id in (${ids.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  removeFixture();
  check("no copies or catalog data are left behind", footprint(psql, LEFTOVER_TABLES) === startingFootprint);
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed ? 1 : 0);
