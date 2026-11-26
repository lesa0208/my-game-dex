/**
 * End-to-end checks for the collector's game page (/games/[slug]): the catalog's facts,
 * each physical release on its own, the signed-in collector's own copies, and the links
 * between the game, its releases, copies and shelves. Driven over HTTP against the
 * isolated test stack and its fictional catalog fixture, with throwaway accounts whose
 * copies are added through the real collection functions. With
 * GAME_SCREENSHOTS=<folder>, a real browser also takes screenshots.
 *
 *   npm run build && MGD_STACK=test npm run app:game-details-checks
 *
 * Local only. Installs the catalog fixture and removes it, and every test account, at
 * the end, then checks nothing is left behind. Prints check names and statuses, never
 * keys, tokens or cookies.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { api, appErrorLines, Browser, check, createUser, decode, deleteUsers, formWith, location, psql, publishableKey, readSession, results, root, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { footprint } from "./lib/footprint.mjs";

const plain = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const SUMMARY = "A fictional fixture summary, set by these checks to show the game page renders the summary the catalog records.";

function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function release(title, platform, region, format) {
  const id = psql(`select r.id from public.releases r join public.games g on g.id = r.game_id join public.platforms p on p.id = r.platform_id
    where g.title = '${title}' and p.slug = '${platform}' and r.region_code = '${region}' and r.media_format_code = '${format}'
      and r.status = 'published' and r.merged_into_id is null order by r.id limit 1;`);
  if (!id) throw new Error(`no published release: ${title} ${platform} ${region} ${format}`);
  return id;
}

async function collector(prefix) {
  const user = await createUser({ prefix });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `gd_${randomBytes(5).toString("hex")}` });
  return { ...user, browser };
}

async function rpc(owner, name, body) {
  const { session } = readSession(owner.browser);
  const response = await fetch(`${api}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${name} failed: ${json.message}`);
  return json.item_id;
}

const add = (owner, releaseId, details = {}) => rpc(owner, "add_collection_item", { p_item_id: uuidv7(), p_release: releaseId, p_details: details });

function claim(owner, title, platform, region = null, editionName = null) {
  const game = psql(`select id from public.games where title = '${title}' and merged_into_id is null limit 1;`);
  const platformId = psql(`select id from public.platforms where slug = '${platform}';`);
  return rpc(owner, "add_unidentified_copy", { p_item_id: uuidv7(), p_game: game, p_platform: platformId, p_region: region, p_edition_kind: null, p_edition_name: editionName });
}

/** The copies listed in the page's "Your copies" section, by their links. */
/**
 * The copies listed under "Your copies of this game", by their View links. M17b: read
 * from the whole page, because React may stream part of the list later in the same
 * response (a placeholder, then the content), so the list isn't always one block.
 */
function listedCopies(html) {
  if (!html.includes('aria-label="Your copies of this game"')) return [];
  const views = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes('aria-label="View copy, '));
  return [...new Set(views.map((tag) => /href="\/collection\/([0-9a-f-]{36})"/.exec(tag)?.[1]).filter(Boolean))];
}

/**
 * The release rows of the "Physical releases" overview, by the release each one chooses:
 * the only links that open a release in the add steps (#choose-release). Read from the
 * whole document, since streamed rows can arrive after later sections.
 */
function overviewReleases(html) {
  return [...html.matchAll(/<a\s[^>]*href="\/games\/[^"]*release=([0-9a-f-]{36})#choose-release"/g)].map((m) => m[1]);
}

const screenshots = process.env.GAME_SCREENSHOTS ?? null;
let playwright = null;
let origin = null;

async function shot(owner, name, path, { width = 1440, height = 900, full = true } = {}) {
  if (!screenshots) return;
  if (!playwright) {
    const { chromium } = createRequire(join(root, "package.json"))("playwright-core");
    playwright = await chromium.launch({ channel: "msedge", headless: true });
    mkdirSync(screenshots, { recursive: true });
  }
  const context = await playwright.newContext({ viewport: { width, height } });
  if (owner) await context.addCookies([...owner.browser.cookies].map(([cookieName, value]) => ({ name: cookieName, value, url: origin })));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  await page.goto(origin + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: full });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`screenshot ${name}: no console errors and no sideways scrolling`, errors.length === 0 && overflow <= 0, `${errors.length} errors, ${overflow}px`);
  await context.close();
}

// ---------------------------------------------------------------------------

async function visitor() {
  section("A visitor");
  const browser = new Browser();
  const { response, html } = await browser.get("/games/starfall-odyssey");
  const text = plain(html);
  check("the game page is public", response.status === 200 && html.includes('id="game-title"') && text.includes("Starfall Odyssey"));
  check("it shows the catalog's summary", text.includes(SUMMARY));
  check("and its first release date", text.includes("First released") && text.includes("1993"));
  check("and its other titles", html.includes('aria-label="Other titles"'));
  const published = psql(`select string_agg(r.id::text, ',' order by r.id) from public.releases r join public.games g on g.id = r.game_id where g.slug = 'starfall-odyssey' and r.status = 'published' and r.merged_into_id is null;`).split(",");
  const rows = overviewReleases(html);
  check("every published release is its own row in the overview", rows.length === published.length && published.every((id) => rows.includes(id)), `${rows.length} of ${published.length}`);
  check("the overview never merges two regional releases", new Set(rows).size === rows.length);
  // M17b: the game page adds through its quick add; the step-by-step add has its own page.
  check("the game page has no add steps of its own", !html.includes('id="choose-release"'));
  const steps = await browser.get("/games/starfall-odyssey/add");
  check("the step-by-step add is on its own page, with its releases", steps.response.status === 200 && steps.html.includes('id="choose-release"') && steps.html.includes('aria-label="Releases"'));
  check("their full release list is folded away until something is chosen", /<details[^>]*>s*<summary[^>]*><span id="catalog-releases">/.test(steps.html));
  check("nothing about anyone's collection is shown", !text.includes("Owned:") && !text.includes("Not in your collection") && !text.includes("Your copies"));
  check("no developer or genre is made up", !text.includes("Developer") && !text.includes("Genre"));

  const multi = await browser.get("/games/neon-drift-racing");
  check("a game on several platforms groups its releases by platform", multi.html.includes('id="releases-playstation"') && multi.html.includes('id="releases-sega-saturn"'));

  const missing = await browser.get("/games/quiet-meadow");
  const missingText = plain(missing.html);
  check("a game the catalog knows little about still has a page", missing.response.status === 200 && missingText.includes("Quiet Meadow"));
  check("with no first release date or summary invented", !missingText.includes("First released") && !missingText.includes(SUMMARY));
  // M17b: no generated shell in the hero; it says there's no approved artwork yet.
  check("the hero says there's no artwork, rather than drawing a made-up one", missingText.includes("No approved artwork for Quiet Meadow yet") && missingText.includes("Artwork not available"));
  check("and its unknown-region release drawn as a placeholder, not a guessed shell", missing.html.includes('data-media="placeholder"') && !/data-media="snes-cart/.test(missing.html));

  const palRelease = release("Starfall Odyssey", "snes", "pal", "rom-cartridge");
  const old = await browser.get(`/games/starfall-odyssey?platform=snes&region=pal&release=${palRelease}`);
  check("an old step address on the game page goes to the step-by-step add, with the same choices", old.response.status === 308 && location(old.response) === `/games/starfall-odyssey/add?platform=snes&region=pal&release=${palRelease}`, `${old.response.status} ${location(old.response)}`);
  const chosen = await browser.get(`/games/starfall-odyssey/add?platform=snes&region=pal&release=${palRelease}`);
  check("choosing a release from the overview opens it in the add steps", plain(chosen.html).includes("Your release: SNES · PAL"));
  check("and the game page with that release still lists every release", overviewReleases((await browser.get(`/games/starfall-odyssey?release=${palRelease}`)).html).length === published.length);
  check("with the add steps' release list open once a release is chosen", !/<details[^>]*>s*<summary[^>]*><span id="catalog-releases">/.test(chosen.html) && chosen.html.includes('<h3 id="catalog-releases"'));

  await shot(null, "01-game-visitor", "/games/starfall-odyssey");
  await shot(null, "02-game-missing-metadata", "/games/quiet-meadow", { full: false });
  await shot(null, "03-game-multi-platform", "/games/neon-drift-racing");
}

async function collectors() {
  section("A collector's own copies");
  const owner = await collector("gdo");
  const pal = release("Starfall Odyssey", "snes", "pal", "rom-cartridge");
  const three = [await add(owner, pal, { completeness: "complete", overall_condition: "very_good", acquired_on: "2021-04-02" }), await add(owner, pal), await add(owner, pal, { completeness: "loose" })];
  const jp = await add(owner, release("Starfall Odyssey", "snes", "ntsc-j", "rom-cartridge"), { completeness: "sealed", overall_condition: "mint" });
  const unidentified = await claim(owner, "Starfall Odyssey", "playstation", "pal", "Platinum");
  // A copy of the sequel, which a search for the title also finds: never listed here.
  const sequel = await add(owner, release("Starfall Odyssey II", "snes", "ntsc-uc", "rom-cartridge"));
  const mine = [...three, jp, unidentified];

  const page = await owner.browser.get("/games/starfall-odyssey");
  const text = plain(page.html);
  const listed = listedCopies(page.html);
  check("the page counts the collector's copies", text.includes("Owned: 5 copies"), text.match(/Owned: [^ ]+ ?\w*/)?.[0]);
  check("and lists each one on its own", listed.length === 5 && mine.every((id) => listed.includes(id)), `${listed.length}; missing ${mine.filter((id) => !listed.includes(id)).map((id) => `${id.slice(0, 8)}:${page.html.split(id).length - 1}`).join(",")}`);
  check("copies of the same release stay separate", text.includes("Copy 1 of 3") && text.includes("Copy 2 of 3") && text.includes("Copy 3 of 3"));
  check("a copy of another game with a similar title isn't listed", !listed.includes(sequel));
  check("an unidentified copy is listed, and says it isn't linked to a release", listed.includes(unidentified) && text.includes("Not linked to a release"));
  const recorded = (completeness, condition) => new RegExp(`>Completeness</dt><dd>${completeness}</dd></div><div[^>]*><dt[^>]*>Condition</dt><dd>${condition}</dd>`).test(page.html);
  check("each copy shows its completeness and condition, as recorded", recorded("Complete in box", "Very good") && recorded("Sealed", "Mint"));
  check("and nothing private: no acquisition date", !text.includes("2021"));
  check("the copies link to their own pages and to the collector's shelves", page.html.includes(`href="/collection/${jp}"`) && page.html.includes('href="/collection/systems/snes"') && page.html.includes('href="/collection/systems/playstation"'));

  const claimPage = await owner.browser.get(`/collection/${unidentified}`);
  check("an unidentified copy's page links to its game", claimPage.html.includes('href="/games/starfall-odyssey"') && plain(claimPage.html).includes("See this game in the catalog"));
  check("and to its system shelf", claimPage.html.includes('href="/collection/systems/playstation"'));
  const copyPage = await owner.browser.get(`/collection/${jp}`);
  check("a copy of a release still links to its release in the catalog", copyPage.html.includes(`href="/games/starfall-odyssey?release=`) && copyPage.html.includes('href="/collection/systems/snes"'));
  const shelf = await owner.browser.get("/collection/systems/snes");
  check("the shelf still links each copy to its page", shelf.html.includes(`href="/collection/${jp}"`));

  section("Another collector");
  const stranger = await collector("gds");
  const theirs = await stranger.browser.get("/games/starfall-odyssey");
  const theirText = plain(theirs.html);
  check("another collector sees only that they have none", theirText.includes("Not in your collection yet") && !theirText.includes("Owned:"));
  check("and none of the owner's copies", listedCopies(theirs.html).length === 0 && !mine.some((id) => theirs.html.includes(id)));
  const theirCopy = await stranger.browser.get(`/collection/${jp}`);
  check("the owner's copy page isn't available to them", plain(theirCopy.html).includes("This copy isn't available") && !theirCopy.html.includes('href="/games/starfall-odyssey?release='));

  await shot(owner, "04-game-owner-desktop", "/games/starfall-odyssey");
  await shot(owner, "05-game-owner-mobile", "/games/starfall-odyssey", { width: 390, height: 844 });
  await shot(stranger, "06-game-not-owned", "/games/starfall-odyssey", { full: false });
  await shot(owner, "07-copy-page-claim", `/collection/${unidentified}`, { full: false });
  await shot(null, "08-game-visitor-mobile", "/games/neon-drift-racing", { width: 390, height: 844 });
}

// ---------------------------------------------------------------------------

const LEFTOVER_TABLES = ["public.collection_items", "public.games"];
const startingFootprint = footprint(psql, LEFTOVER_TABLES);

try {
  installFixture();
  // The fixture records no summaries; one fictional one shows the page renders what the catalog has.
  psql(`update public.games set summary = '${SUMMARY}' where slug = 'starfall-odyssey';`);
  origin = await startApp(3280);
  await visitor();
  await collectors();
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  await playwright?.close();
  stopApp();
  const ids = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'gd\\_%';");
  if (ids.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${ids.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  removeFixture();
  check("no copies or catalog data are left behind", footprint(psql, LEFTOVER_TABLES) === startingFootprint);
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
