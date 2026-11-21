/**
 * End-to-end checks for the real collection shelves (/collection/systems and a
 * system's shelf), driven over HTTP against the isolated test stack and its catalog
 * fixture. Collectors are throwaway accounts; their copies are added through the real
 * collection functions with their own sessions, so every database rule applies. With
 * SHELF_SCREENSHOTS=<folder>, a real browser also takes screenshots of the shelves.
 *
 *   npm run build && MGD_STACK=test npm run app:shelf-checks
 *
 * Local only. Installs the catalog fixture and removes it, and every test account, at
 * the end, then checks nothing is left behind. Prints check names and statuses, never
 * keys, tokens or cookies.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { api, appErrorLines, Browser, check, createUser, decode, deleteUsers, formWith, isRedirect, location, psql, publishableKey, readSession, results, root, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { footprint } from "./lib/footprint.mjs";

/** The copies standing on a shelf: its item links (class "group relative mt-5…"), each to a copy's page. */
const shelfIds = (html) =>
  [...html.matchAll(/<a\s[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('class="group relative mt-5'))
    .map((tag) => /href="\/collection\/([0-9a-f-]{36})"/.exec(tag)?.[1])
    .filter(Boolean);
const mediaOf = (html) => [...html.matchAll(/data-media="([^"]+)"/g)].map((m) => m[1]);
const plain = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const count = (sql) => Number(psql(sql));

function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A published fixture release, by game title, platform, region and format. */
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
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `sh_${randomBytes(5).toString("hex")}` });
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

/** Adds a copy of a release as the owner, through add_collection_item (M6b). */
const add = (owner, releaseId, details = {}) => rpc(owner, "add_collection_item", { p_item_id: uuidv7(), p_release: releaseId, p_details: details });

/** Adds an unidentified copy as the owner, through add_unidentified_copy (M12a). */
function claim(owner, title, platform, region = null, editionName = null) {
  const game = psql(`select id from public.games where title = '${title}' and merged_into_id is null limit 1;`);
  const platformId = psql(`select id from public.platforms where slug = '${platform}';`);
  return rpc(owner, "add_unidentified_copy", { p_item_id: uuidv7(), p_game: game, p_platform: platformId, p_region: region, p_edition_kind: null, p_edition_name: editionName });
}

const screenshots = process.env.SHELF_SCREENSHOTS ?? null;
let playwright = null;
let origin = null;

/** A screenshot as the owner, in a real browser with their session. Only with SHELF_SCREENSHOTS. */
async function shot(owner, name, path, { width = 1440, height = 900, full = true, before } = {}) {
  if (!screenshots) return;
  if (!playwright) {
    const { chromium } = createRequire(join(root, "package.json"))("playwright-core");
    playwright = await chromium.launch({ channel: "msedge", headless: true });
    mkdirSync(screenshots, { recursive: true });
  }
  const context = await playwright.newContext({ viewport: { width, height } });
  await context.addCookies([...owner.browser.cookies].map(([cookieName, value]) => ({ name: cookieName, value, url: origin })));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  await page.goto(origin + path, { waitUntil: "networkidle" });
  if (before) await before(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: full });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`screenshot ${name}: no console errors and no sideways scrolling`, errors.length === 0 && overflow <= 0, `${errors.length} errors, ${overflow}px`);
  await context.close();
}

// ---------------------------------------------------------------------------

async function signedOut() {
  section("Signed out");
  const visitor = new Browser();
  const systems = await visitor.get("/collection/systems");
  check("the Systems page sends a visitor to sign in", isRedirect(systems.response) && location(systems.response).startsWith("/sign-in"));
  const shelf = await visitor.get("/collection/systems/snes");
  check("and so does a system's shelf", isRedirect(shelf.response) && location(shelf.response).startsWith("/sign-in"));
}

async function empty() {
  section("An empty collection");
  const user = await collector("she");
  const systems = await user.browser.get("/collection/systems");
  check("the Systems page says the collection is empty", systems.response.status === 200 && plain(systems.html).includes("Your collection is empty"));
  check("with no system tiles", !systems.html.includes('href="/collection/systems/'));
  const shelf = await user.browser.get("/collection/systems/snes");
  check("a system's shelf is an empty shelf, not an error", shelf.response.status === 200 && plain(shelf.html).includes("This shelf is waiting for its first game"));
  const unknown = await user.browser.get("/collection/systems/not-a-platform");
  // Not-found pages stream inside Suspense, as the collection's copy page does: judged by what they say.
  check("an unknown platform is not found", plain(unknown.html).includes("There's no such system") && !unknown.html.includes('data-media="'));
  const preview = await user.browser.get("/collection/preview");
  check("the sample preview isn't served without seed data", preview.response.status === 404);
  await shot(user, "01-systems-empty", "/collection/systems", { full: false });
  return user;
}

async function small() {
  section("A small collection");
  const user = await collector("shs");
  const ids = {};
  // SNES: both recorded shells, the generic cartridge by region, three copies of one release, an unknown region.
  ids.na = await add(user, release("Super Mario World", "snes", "ntsc-uc", "snes-game-pak-na"), { completeness: "complete", overall_condition: "very_good", acquired_on: "2022-03-14" });
  ids.pal = await add(user, release("Super Mario World", "snes", "pal", "snes-cartridge-jp-pal"), { completeness: "loose", overall_condition: "good" });
  const starfallPal = release("Starfall Odyssey", "snes", "pal", "rom-cartridge");
  ids.copies = [await add(user, starfallPal, { completeness: "sealed", overall_condition: "mint" }), await add(user, starfallPal), await add(user, starfallPal, { completeness: "incomplete" })];
  ids.jp = await add(user, release("Starfall Odyssey", "snes", "ntsc-j", "rom-cartridge"));
  ids.meadow = await add(user, release("Quiet Meadow", "snes", "unknown", "rom-cartridge"));
  ids.snesClaim = await claim(user, "Twin Harbor", "snes", "pal", "Player's Choice");
  // Disc cases, a Saturn case and a North American Saturn copy the art doesn't show.
  ids.psPal = await add(user, release("Echoes of Tessaly", "playstation", "pal", "cd-rom"), { completeness: "complete", overall_condition: "near_mint" });
  ids.psUs = await add(user, release("Neon Drift Racing", "playstation", "ntsc-uc", "cd-rom"));
  ids.psJp = await add(user, release("Crash Bandicoot", "playstation", "ntsc-j", "cd-rom"));
  ids.psClaim = await claim(user, "Echoes of Tessaly", "playstation", null, "Platinum");
  ids.saturn = await add(user, release("Neon Drift Racing", "sega-saturn", "ntsc-j", "cd-rom"));
  ids.saturnUs = await claim(user, "Neon Drift Racing", "sega-saturn", "ntsc-uc");
  // Other cartridges, a Famicom-format copy, and a system without console or media art.
  ids.gb = await add(user, release("Pokétrail Rangers", "game-boy", "ntsc-j", "game-boy-game-pak"));
  ids.md = await add(user, release("The Crystal Warden", "mega-drive", "pal", "rom-cartridge"));
  ids.famicom = await claim(user, "Starfall Odyssey", "nes", "ntsc-j");
  ids.nes = await claim(user, "Starfall Odyssey", "nes", "pal");
  ids.pce = await add(user, release("Twin Harbor", "pc-engine", "ntsc-j", "hucard"));

  const systems = await user.browser.get("/collection/systems");
  const text = plain(systems.html);
  check("the Systems page lists every system the collector has copies on", ["snes", "playstation", "sega-saturn", "game-boy", "mega-drive", "nes", "pc-engine"].every((s) => systems.html.includes(`href="/collection/systems/${s}"`)));
  const perPlatform = psql(`select string_agg(p.slug || '=' || n, ',' order by p.slug) from (select coalesce(r.platform_id, c.claimed_platform_id) pid, count(*) n from public.collection_items c left join public.releases r on r.id = c.release_id where c.owner_id = '${user.id}' group by 1) x join public.platforms p on p.id = x.pid;`);
  const tiles = Object.fromEntries(perPlatform.split(",").map((pair) => pair.split("=")));
  const tileLabel = (slug) => [...systems.html.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(`href="/collection/systems/${slug}"`))?.match(/aria-label="([^"]*)"/)?.[1] ?? "";
  check("each tile counts the collector's copies on it", Object.entries(tiles).every(([slug, n]) => tileLabel(slug).endsWith(`: ${n} ${n === "1" ? "copy" : "copies"}`)), perPlatform);
  check("the header counts systems and copies", text.includes(`${Object.keys(tiles).length} systems`) && text.includes(`${count(`select count(*) from public.collection_items where owner_id = '${user.id}'`)} copies`));
  check("a system without console art still gets a tile", systems.html.includes('href="/collection/systems/pc-engine"'));

  const snes = await user.browser.get("/collection/systems/snes");
  const snesIds = shelfIds(snes.html);
  check("the SNES shelf shows each of its copies once", snesIds.length === 8 && new Set(snesIds).size === 8, `${snesIds.length}`);
  check("including all three copies of the same release", ids.copies.every((id) => snesIds.includes(id)));
  const snesMedia = mediaOf(snes.html);
  check("North American and PAL shells are drawn from their recorded formats", snesMedia.includes("snes-cart:NTSC-U") && snesMedia.includes("snes-cart:PAL"));
  check("a Japanese generic cartridge gets the Super Famicom shell", snesMedia.includes("snes-cart:NTSC-J"));
  check("a copy whose region isn't known is a placeholder, not a guessed shell", snesMedia.filter((m) => m === "placeholder").length === 1);
  check("the shelf counts copies and games", plain(snes.html).includes("8 Copies") || /8\s*<\/span>[\s\S]{0,200}Copies/.test(snes.html));
  check("copies of the shelf link to their own pages", snesIds.includes(ids.na) && snes.html.includes(`href="/collection/${ids.na}"`));
  check("the list's details are rendered for copies", plain(snes.html).includes("Super Mario World"));

  const ps = await user.browser.get("/collection/systems/playstation");
  check("the PlayStation shelf draws every copy in a jewel case, the claim too", mediaOf(ps.html).filter((m) => m.startsWith("ps1-case")).length === 4);
  const saturn = await user.browser.get("/collection/systems/sega-saturn");
  check("a Japanese Saturn copy gets the Saturn case; a North American one, the placeholder", mediaOf(saturn.html).includes("saturn-case:NTSC-J") && mediaOf(saturn.html).includes("placeholder"));
  const nes = await user.browser.get("/collection/systems/nes");
  check("a Famicom-region NES copy is a placeholder; a PAL one, the NES Game Pak", mediaOf(nes.html).includes("placeholder") && mediaOf(nes.html).includes("nes-cart:NTSC-U"));
  const pce = await user.browser.get("/collection/systems/pc-engine");
  check("a system without art shows its copies as placeholders", pce.response.status === 200 && shelfIds(pce.html).length === 1 && mediaOf(pce.html).every((m) => m === "placeholder"));
  const gamecube = await user.browser.get("/collection/systems/gamecube");
  check("a platform with no copies yet is an empty shelf", gamecube.response.status === 200 && plain(gamecube.html).includes("This shelf is waiting for its first game"));

  await shot(user, "02-systems-small", "/collection/systems");
  await shot(user, "03-snes-shelf-small", "/collection/systems/snes");
  await shot(user, "04-snes-list-small", "/collection/systems/snes", { before: (page) => page.getByRole("button", { name: "List" }).click() });
  await shot(user, "05-playstation-shelf", "/collection/systems/playstation", { full: false });
  await shot(user, "06-saturn-shelf", "/collection/systems/sega-saturn", { full: false });
  await shot(user, "07-pc-engine-shelf", "/collection/systems/pc-engine", { full: false });
  await shot(user, "08-snes-filtered", "/collection/systems/snes", {
    full: false,
    before: async (page) => {
      await page.getByRole("button", { name: "Filters" }).click();
      await page.getByLabel("Region").selectOption("PAL");
    },
  });
  await shot(user, "09-copy-page", `/collection/${ids.na}`, { full: false });
  await shot(user, "10-systems-mobile", "/collection/systems", { width: 390, height: 844 });
  await shot(user, "11-snes-shelf-mobile", "/collection/systems/snes", { width: 390, height: 844 });
  await shot(user, "12-playstation-list-mobile", "/collection/systems/playstation", { width: 390, height: 844, before: (page) => page.getByRole("button", { name: "List" }).click() });
  return { user, ids };
}

async function large() {
  section("A large collection");
  const user = await collector("shl");
  const snes = [
    release("Starfall Odyssey", "snes", "ntsc-uc", "rom-cartridge"),
    release("Starfall Odyssey II", "snes", "ntsc-uc", "rom-cartridge"),
    release("ClayBoxer Turbo", "snes", "ntsc-uc", "rom-cartridge"),
    release("Twin Harbor", "snes", "ntsc-uc", "rom-cartridge"),
    release("Super Mario World", "snes", "pal", "snes-cartridge-jp-pal"),
  ];
  const completeness = ["complete", "loose", "sealed", "incomplete", null];
  for (let i = 0; i < 260; i += 1) await add(user, snes[i % snes.length], completeness[i % completeness.length] ? { completeness: completeness[i % completeness.length] } : {});
  const shelf = await user.browser.get("/collection/systems/snes");
  const ids = shelfIds(shelf.html);
  check("a shelf of 260 copies loads every one, across the collection function's pages of 100", shelf.response.status === 200 && ids.length === 260 && new Set(ids).size === 260, `${ids.length}`);
  check("and no copy note says it was cut short", !plain(shelf.html).includes("This shelf shows your first"));
  await shot(user, "13-snes-shelf-large", "/collection/systems/snes", { full: false });
  await shot(user, "14-snes-shelf-large-mobile", "/collection/systems/snes", { width: 390, height: 844, full: false });
  return user;
}

async function privacy(owner, others) {
  section("Privacy");
  const intruder = others;
  const systems = await intruder.browser.get("/collection/systems");
  check("another collector's Systems page shows none of the owner's systems", !systems.html.includes('href="/collection/systems/playstation"'));
  const shelf = await intruder.browser.get("/collection/systems/playstation");
  check("and the owner's shelf, opened by them, is their own empty shelf", shelf.response.status === 200 && shelfIds(shelf.html).length === 0);
  check("none of the owner's copies appear in it", !Object.values(owner.ids).flat().some((id) => shelf.html.includes(id)));
  const copy = await intruder.browser.get(`/collection/${owner.ids.psPal}`);
  check("the owner's copy page is not available to them", plain(copy.html).includes("This copy isn't available") && !plain(copy.html).includes("Echoes of Tessaly"));
}

// ---------------------------------------------------------------------------

const LEFTOVER_TABLES = ["public.collection_items", "public.games"];
const startingFootprint = footprint(psql, LEFTOVER_TABLES);

try {
  installFixture();
  origin = await startApp(3270);
  await signedOut();
  const nobody = await empty();
  const owner = await small();
  await large();
  await privacy(owner, nobody);
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  await playwright?.close();
  stopApp();
  const ids = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'sh\\_%';");
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
