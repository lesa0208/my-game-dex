/**
 * M16 Home: the collection-first Home on the running demo preview (http://127.0.0.6:3006), in a
 * real browser (headless Edge or Chrome via playwright-core), with collectors who register through
 * the app's own sign-up page and confirm from the demo's Mailpit:
 *
 * - signed out: the landing, with Create Account, Explore and Sign in, an example shelf, no feed;
 * - a new collector with no copies: "Your collection starts here", no zero statistics;
 * - after their first game, after three systems, and with seven systems (six shown, three on a
 *   phone, the rest one link away): their own counts (checked against the database), their
 *   systems' tiles (with the approved console art, the Game Boy Advance's included) linking to
 *   their shelves, and their seven most recently added distinct games on one continuous shelf,
 *   newest first, a game with two copies shown once;
 * - another new collector seeing none of it; signing out returning to the landing;
 * - no horizontal scrolling at 390, 768 and 1440 pixels, three, two and one tiles per row,
 *   My Systems in the first desktop viewport, the shelf scrolling sideways on a phone (swipe,
 *   arrows, Tab) without the page doing so, keyboard use, and axe at a phone and a desktop width.
 *
 * Screenshots go to HOME_SCREENSHOTS (default ~/.my-game-dex/demo/home-screens).
 *
 *   MGD_STACK=demo node scripts/app-home-checks.mjs   (npm run app:home-checks)
 *
 * The demo stack and its running preview only. Its accounts are disposable ("home-…@example.test")
 * and removed at the end with their copies; the demo catalog is checked to be exactly as it was.
 * Prints check names, never a password, token, link or cookie.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright-core";

import { footprint } from "./lib/footprint.mjs";
import { projectId, stackName, stackStatus } from "./lib/stack.mjs";

if (stackName !== "demo" || projectId !== "my-game-dex-demo") {
  console.error("Refusing: run on the demo stack (MGD_STACK=demo).");
  process.exit(2);
}
const ORIGIN = process.env.DEMO_ORIGIN ?? "http://127.0.0.6:3006";
const status = stackStatus({ label: "the Home checks" });
const MAILPIT = status.MAILPIT_URL ?? status.INBUCKET_URL ?? "http://127.0.0.1:59324";
const API = status.API_URL;
const SERVICE = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
const SHOTS = process.env.HOME_SCREENSHOTS ?? join(homedir(), ".my-game-dex", "demo", "home-screens");
mkdirSync(SHOTS, { recursive: true });
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const { execFileSync } = await import("node:child_process");
const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_my-game-dex-demo", "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" }).trim();

const results = { passed: 0, failed: 0 };
function check(name, ok, detail = "") {
  if (ok) results.passed += 1;
  else results.failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}
const section = (title) => console.log(`\n${title}`);
const TAG = randomBytes(4).toString("hex");
const email = (who) => `home-${TAG}-${who}@example.test`;
const password = () => `Home ${randomBytes(9).toString("base64url")} shelf`;
const CATALOG = ["public.games", "public.game_platforms", "public.releases", "public.game_aliases"];
const startingCatalog = footprint(psql, CATALOG);
const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 768, height: 1024 };
const PHONE = { width: 390, height: 844 };
let browser;

async function eventually(condition, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await condition().catch(() => false)) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function confirmationLink(address, after) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const found = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)).json();
    const fresh = (found.messages ?? []).filter((m) => Date.parse(m.Created) > after).sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created));
    if (fresh.length) {
      const message = await (await fetch(`${MAILPIT}/api/v1/message/${fresh[0].ID}`)).json();
      const href = /href="([^"]*\/auth\/confirm\?[^"]*)"/.exec(message.HTML ?? "")?.[1]?.replace(/&amp;/g, "&");
      if (href) return href;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("no confirmation email");
}

const mainText = async (page) => (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
const homeLoaded = (page, text) => eventually(async () => (await mainText(page)).includes(text));

/** Registers through the sign-up page, confirms from Mailpit, chooses a handle: lands on /home. */
async function register(page, address, pass, handle) {
  const at = Date.now() - 2000;
  await page.goto(`${ORIGIN}/sign-up`, { waitUntil: "networkidle" });
  await page.fill("#email", address);
  await page.fill("#password", pass);
  await page.fill("#confirm", pass);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/sign-up\?status=sent/);
  await page.goto(await confirmationLink(address, at), { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Confirm my email" }).click();
  await page.waitForURL(/\/welcome/);
  await page.locator('main input[name="handle"]').fill(handle);
  await page.locator('main form:has(input[name="handle"]) button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname === "/home");
}

/** Adds a copy as a collector does (M17b): the header search, the result, then the game's Add to Collection: platform, region, Add. */
async function addGame(page, { query, title, platform, region }) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.locator('header input[type="search"]').fill(query);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/explore\?/);
  const result = page.locator("main [data-game-card] h3 a:visible").filter({ hasText: new RegExp(`^${esc(title)}$`) }).first();
  await result.waitFor({ timeout: 15000 });
  await result.click();
  await page.waitForURL(/\/games\//);
  const add = page.locator("main [data-action=add]").first();
  await add.waitFor({ timeout: 15000 });
  await add.click();
  const dialog = page.getByRole("dialog");
  await eventually(async () => (await dialog.getByRole("radio").count()) > 0);
  await dialog.locator("fieldset").first().locator("label").filter({ hasText: new RegExp(`^${esc(platform)}`) }).first().click();
  await dialog.locator("label").filter({ hasText: new RegExp(`^${esc(region)}$`) }).first().click();
  await dialog.getByRole("button", { name: "Add to collection" }).click();
  const done = await eventually(async () => (await dialog.locator("[data-quick-add-done]").count()) === 1);
  await page.keyboard.press("Escape");
  return done;
}

async function goHome(page, text) {
  await page.goto(`${ORIGIN}/home`, { waitUntil: "networkidle" });
  return homeLoaded(page, text);
}

async function shoot(page, name, { fullPage = true } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  // A full-page capture draws fixed elements where the first viewport ends; the phone's
  // bottom navigation is put at the page's end for it instead, as it is seen there.
  const style = fullPage ? await page.addStyleTag({ content: "body { position: relative } nav.fixed.bottom-0 { position: absolute !important }" }) : null;
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage });
  await style?.evaluate((node) => node.remove());
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function axe(page, label) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: axeSource });
  const found = await page.evaluate(async () => {
    const run = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
    return run.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id}: ${v.nodes.length}`);
  });
  check(`${label}: no critical or serious axe findings`, found.length === 0, found.join("; "));
}

/** The My Systems tiles shown at this width: link, and the top of each on screen. */
const systemTiles = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('section[aria-labelledby="home-systems"] ul a')]
      .filter((a) => a.getClientRects().length > 0)
      .map((a) => ({ href: a.getAttribute("href"), text: a.innerText.replace(/\s+/g, " "), top: Math.round(a.getBoundingClientRect().top), art: Boolean(a.querySelector("span[aria-hidden] img")) })),
  );
const perRow = (tiles) => tiles.filter((t) => t.top === tiles[0]?.top).length;
const overview = (page) =>
  page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('dl[aria-label="Collection overview"] > div')].map((d) => [d.querySelector("dt").innerText.trim(), d.querySelector("dd").innerText.trim()])),
  );
const RECENT = 'section[aria-labelledby="home-recent"]';
/** The games on the Recently Added shelf: link, title, where its media stands, and its column's top. */
const recentTitles = (page) =>
  page.evaluate(
    (recent) =>
      [...document.querySelectorAll(`${recent} a[data-recent-game]`)].map((a) => ({
        href: a.getAttribute("href"),
        title: a.getAttribute("data-recent-game"),
        text: a.innerText.replace(/\s+/g, " "),
        baseline: Math.round(a.querySelector("[data-media]").getBoundingClientRect().bottom),
        top: Math.round(a.getBoundingClientRect().top),
      })),
    RECENT,
  );
/** The shelf's scroller: how far it can and does scroll. */
const shelfScroll = (page) =>
  page.evaluate((recent) => {
    const el = document.querySelector(`${recent} [data-shelf-scroller]`);
    return el ? { overflow: el.scrollWidth - el.clientWidth, left: Math.round(el.scrollLeft) } : null;
  }, RECENT);

const FEED = ["For You", "Following", "Latest", "No posts yet"];
const made = [];
try {
  for (const channel of process.env.A11Y_BROWSER ? [process.env.A11Y_BROWSER] : ["msedge", "chrome"]) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // Try the next one.
    }
  }
  if (!browser) throw new Error("Needs Microsoft Edge or Google Chrome installed.");

  section("1. Signed out");
  const guest = await (await browser.newContext({ viewport: DESKTOP, colorScheme: "dark" })).newPage();
  await guest.goto(`${ORIGIN}/home`, { waitUntil: "networkidle" });
  await homeLoaded(guest, "Beautifully Organized");
  const landing = await mainText(guest);
  check("the landing says what My Game Dex is for", (await guest.getByRole("heading", { level: 1, name: "Your Physical Game Collection, Beautifully Organized." }).count()) === 1);
  check("no social feed on Home", !FEED.some((t) => landing.includes(t)), FEED.filter((t) => landing.includes(t)).join(", "));
  check("Create Account goes to the real sign-up page", (await guest.locator("main").getByRole("link", { name: "Create Account" }).getAttribute("href")) === "/sign-up");
  check("Explore Games and Sign in are offered", (await guest.locator("main").getByRole("link", { name: "Explore Games" }).getAttribute("href")) === "/explore" && (await guest.locator("main").getByRole("link", { name: "Sign in", exact: true }).getAttribute("href")) === "/sign-in");
  check("the example shelf says it's an example, with no counts", /example/i.test(landing) && landing.includes("Not anyone's collection") && !/\d+ (copies|games|systems)/i.test(landing));
  check("the three benefits", ["Organize by System", "Track Physical Copies", "Build Your Collection"].every((t) => landing.includes(t)));
  check("no horizontal scrolling at 1440", await noSideScroll(guest));
  await shoot(guest, "01-signed-out-desktop-1440", { fullPage: false });
  await shoot(guest, "01-signed-out-desktop-1440-full");
  await axe(guest, "signed out, 1440");
  await guest.setViewportSize(PHONE);
  check("no horizontal scrolling at 390", await noSideScroll(guest));
  await shoot(guest, "02-signed-out-mobile-390");
  await axe(guest, "signed out, 390");
  await guest.setViewportSize(DESKTOP);
  await guest.locator("main").getByRole("link", { name: "Create Account" }).click();
  await guest.waitForURL(/\/sign-up$/);
  check("Create Account opens sign-up", (await mainText(guest)).includes("Create an account"));
  await guest.context().close();

  section("2. A newly registered collector, no copies");
  const alexEmail = email("alex");
  const alexPassword = password();
  made.push(alexEmail);
  const desk = await (await browser.newContext({ viewport: DESKTOP, colorScheme: "dark" })).newPage();
  await register(desk, alexEmail, alexPassword, `ha${TAG}`);
  check("after the handle, Home is the first-collection invitation", await homeLoaded(desk, "Your collection starts here"));
  const empty = await mainText(desk);
  check("with its words and two ways to the catalog", empty.includes("Add your first physical game and start building your collection, one system at a time.") && (await desk.locator("main").getByRole("link", { name: "Find Your First Game" }).getAttribute("href")) === "/explore" && (await desk.locator("main").getByRole("link", { name: "Explore Games" }).getAttribute("href")) === "/explore");
  check("no zero statistics, no empty systems or recent sections", (await desk.locator('dl[aria-label="Collection overview"]').count()) === 0 && !empty.includes("My Systems") && !empty.includes("Recently Added"));
  check("no social feed", !FEED.some((t) => empty.includes(t)));
  check("and three steps saying how it works", ["Find a game", "Add your copy", "See it on its shelf"].every((t) => empty.includes(t)));
  await shoot(desk, "03-empty-collection-desktop-1440", { fullPage: false });
  await axe(desk, "empty collection, 1440");
  const phone = await (await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, colorScheme: "dark", storageState: await desk.context().storageState() })).newPage();
  await goHome(phone, "Your collection starts here");
  check("empty, at 390: no horizontal scrolling", await noSideScroll(phone));
  await shoot(phone, "04-empty-collection-mobile-390");
  await axe(phone, "empty collection, 390");
  const alexId = psql(`select id from auth.users where email = '${alexEmail}';`);

  section("3. After the first game");
  check("Super Mario World added on the SNES", await addGame(desk, { query: "super mario world", title: "Super Mario World", platform: "Super Nintendo", region: "NTSC-U/C" }));
  check("Home is now the collection, on a revisit", await goHome(desk, "Your Collection"));
  check("1 system, 1 game, 1 copy", JSON.stringify(await overview(desk)) === JSON.stringify({ Systems: "1", Games: "1", Copies: "1" }), JSON.stringify(await overview(desk)));
  const first = await systemTiles(desk);
  check("one tile: the SNES, linking to its shelf, with 1 copy", first.length === 1 && first[0].href === "/collection/systems/snes" && first[0].text.includes("1 copy"), JSON.stringify(first));
  check("Recently Added shows it", (await recentTitles(desk)).map((r) => r.title).join() === "Super Mario World");
  await shoot(desk, "05-after-first-game-desktop-1440", { fullPage: false });

  section("4. Three systems");
  check("Sonic the Hedgehog on the Mega Drive", await addGame(desk, { query: "sonic the hedgehog", title: "Sonic the Hedgehog", platform: "Mega Drive", region: "PAL" }));
  check("Crash Bandicoot on the PlayStation", await addGame(desk, { query: "crash bandicoot", title: "Crash Bandicoot", platform: "PlayStation", region: "NTSC-U/C" }));
  await goHome(desk, "My Systems");
  check("3 systems, 3 games, 3 copies", JSON.stringify(await overview(desk)) === JSON.stringify({ Systems: "3", Games: "3", Copies: "3" }), JSON.stringify(await overview(desk)));
  const three = await systemTiles(desk);
  check("tiles for exactly their three systems", three.map((t) => t.href).sort().join() === "/collection/systems/mega-drive,/collection/systems/playstation,/collection/systems/snes", JSON.stringify(three.map((t) => t.href)));
  check("three tiles in a row at 1440", perRow(three) === 3, String(perRow(three)));
  await shoot(desk, "06-three-systems-desktop-1440", { fullPage: false });
  await shoot(desk, "06-three-systems-desktop-1440-full");

  section("5. Seven systems");
  for (const game of [
    { query: "super mario bros. 3", title: "Super Mario Bros. 3", platform: "Nintendo Entertainment System", region: "NTSC-U/C" },
    { query: "mario kart 64", title: "Mario Kart 64", platform: "Nintendo 64", region: "PAL" },
    { query: "tetris", title: "Tetris", platform: "Game Boy", region: "NTSC-J" },
    { query: "ocarina of time", title: "The Legend of Zelda: Ocarina of Time", platform: "Nintendo 64", region: "NTSC-U/C" },
    { query: "pokemon emerald", title: "Pokémon Emerald", platform: "Game Boy Advance", region: "PAL" },
    // A second copy of a game already owned: the newest copy, but the game stands on the shelf once.
    { query: "mario kart 64", title: "Mario Kart 64", platform: "Nintendo 64", region: "PAL" },
  ]) {
    check(`${game.title} added`, await addGame(desk, game));
  }
  await goHome(desk, "My Systems");
  const db = psql(
    `select count(distinct claimed_platform_id) || '/' || count(distinct claimed_game_id) || '/' || count(*) from public.collection_items where owner_id = '${alexId}';`,
  ).split("/");
  const shown = await overview(desk);
  check("the overview matches their copies in the database", shown.Systems === db[0] && shown.Games === db[1] && shown.Copies === db[2], `${JSON.stringify(shown)} vs ${db.join("/")}`);
  check("which are 7 systems, 8 games, 9 copies", db.join("/") === "7/8/9", db.join("/"));
  const seven = await systemTiles(desk);
  check("six tiles on Home, the N64 (3 copies) first", seven.length === 6 && seven[0].href === "/collection/systems/nintendo-64" && seven[0].text.includes("3 copies"), JSON.stringify(seven.map((t) => t.href)));
  const gba = seven.find((t) => t.href === "/collection/systems/game-boy-advance");
  check("the Game Boy Advance tile shows its approved console art, not the placeholder", Boolean(gba?.art), JSON.stringify(gba));
  check("every tile shown has console art (each of these systems has an approved image)", seven.every((t) => t.art), JSON.stringify(seven.filter((t) => !t.art).map((t) => t.href)));
  const owned = psql(`select string_agg(distinct p.slug, ',') from public.collection_items c join public.platforms p on p.id = c.claimed_platform_id where c.owner_id = '${alexId}';`).split(",");
  check("every tile is one of their systems, linking to its shelf", seven.every((t) => owned.some((slug) => t.href === `/collection/systems/${slug}`)));
  check("and the link says there are seven", (await desk.locator("main").getByRole("link", { name: "View All 7 Systems" }).getAttribute("href")) === "/collection/systems");
  const recent = await recentTitles(desk);
  const newest = psql(
    `select string_agg(title, '|' order by latest desc) from (select g.title, max(c.created_at) as latest from public.collection_items c join public.games g on g.id = c.claimed_game_id where c.owner_id = '${alexId}' group by g.id, g.title order by latest desc limit 7) t;`,
  );
  check("Recently Added: their seven most recently added distinct games, newest first", recent.map((r) => r.title).join("|") === newest, `${recent.map((r) => r.title).join("|")} vs ${newest}`);
  check("Mario Kart 64, owned twice, stands once, at its newest copy", recent.filter((r) => r.title === "Mario Kart 64").length === 1 && recent[0]?.title === "Mario Kart 64");
  check("the oldest game, Super Mario World, is the eighth and not on the shelf", recent.length === 7 && !recent.some((r) => r.title === "Super Mario World"));
  check("each linking to that game's newest copy", recent.every((r) => /^\/collection\/[0-9a-f-]{36}$/.test(r.href)));
  check("one shelf, with no card around each game", (await desk.locator(`${RECENT} ul[data-recent-shelf]`).count()) === 1 && (await desk.locator(`${RECENT} a[data-recent-game].border`).count()) === 0);
  check("cartridges and cases stand on one baseline", new Set(recent.map((r) => r.baseline)).size === 1, recent.map((r) => r.baseline).join());
  const deskScroll = await shelfScroll(desk);
  check("all seven side by side at 1440, without scrolling", new Set(recent.map((r) => r.top)).size === 1 && deskScroll?.overflow <= 0, JSON.stringify(deskScroll));
  check("no arrows when everything fits", (await desk.locator("[data-shelf-arrow]").count()) === 0);
  const emerald = await desk.locator(`${RECENT} a[data-recent-game="Pokémon Emerald"] [data-media]`).getAttribute("data-media");
  check("Pokémon Emerald stands in the approved GBA cartridge shell, not the placeholder", emerald === "gba-cart:NTSC-U", String(emerald));
  const recentText = recent.map((r) => r.text).join(" ");
  check("each with its title, system and region", recentText.includes("Pokémon Emerald GBA · PAL") && recentText.includes("Tetris GB · NTSC-J"), recentText.slice(0, 240));
  check("the artwork is said to be illustrative", (await mainText(desk)).includes("Illustrative artwork. Actual editions may differ."));
  check("no Continue Collecting section", (await desk.locator("#home-continue").count()) === 0 && !(await mainText(desk)).includes("Continue Collecting"));
  const heading = await desk.locator("#home-systems").boundingBox();
  check("My Systems and its first row are in the first 1440×900 view", heading && heading.y < 900 && seven[0].top < 900 - 150, `${heading?.y} / ${seven[0].top}`);
  check("no horizontal scrolling at 1440", await noSideScroll(desk));
  await shoot(desk, "07-seven-systems-desktop-1440", { fullPage: false });
  await shoot(desk, "07-seven-systems-desktop-1440-full");
  await desk.locator(RECENT).screenshot({ path: join(SHOTS, "11-recently-added-shelf-desktop-1440.png") });
  await axe(desk, "populated, 1440");
  const sharp = await (await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2, colorScheme: "dark", storageState: await desk.context().storageState() })).newPage();
  await goHome(sharp, "My Systems");
  await sharp.evaluate(() => document.fonts.ready);
  await sharp.waitForTimeout(400);
  await sharp.locator('section[aria-labelledby="home-systems"] a[href="/collection/systems/game-boy-advance"]').screenshot({ path: join(SHOTS, "10-game-boy-advance-tile-closeup.png") });
  await sharp.context().close();

  await desk.setViewportSize(TABLET);
  await desk.waitForTimeout(300);
  const tablet = await systemTiles(desk);
  check("two tiles in a row at 768", perRow(tablet) === 2, String(perRow(tablet)));
  check("no horizontal scrolling at 768", await noSideScroll(desk));
  check("six tiles at 768", tablet.length === 6, String(tablet.length));
  await shoot(desk, "08-seven-systems-tablet-768");
  await desk.setViewportSize(DESKTOP);

  await goHome(phone, "My Systems");
  const mobile = await systemTiles(phone);
  check("three systems on a phone, the first three", mobile.length === 3 && mobile.map((t) => t.href).join() === seven.slice(0, 3).map((t) => t.href).join(), JSON.stringify(mobile.map((t) => t.href)));
  check("and the link still names all seven", (await phone.locator("main").getByRole("link", { name: "View All 7 Systems" }).count()) === 1);
  check("one tile a row at 390, nothing cut off", perRow(mobile) === 1 && (await noSideScroll(phone)));
  const recentTop = await phone.evaluate(() => Math.round(document.querySelector("#home-recent").getBoundingClientRect().top + window.scrollY));
  check("Recently Added starts within two phone screens", recentTop < 844 * 2, String(recentTop));
  check("the console art stays inside its tile at 390", await phone.evaluate(() =>
    [...document.querySelectorAll('section[aria-labelledby="home-systems"] ul a')].every((a) => {
      const tile = a.getBoundingClientRect();
      const art = a.querySelector("span[aria-hidden] img")?.getBoundingClientRect();
      return !art || (art.left >= tile.left - 1 && art.right <= tile.right + 1 && art.bottom <= tile.bottom + 1);
    }),
  ));
  await shoot(phone, "09-seven-systems-mobile-390");
  await shoot(phone, "09-seven-systems-mobile-390-viewport", { fullPage: false });
  await axe(phone, "populated, 390");
  const phoneShelf = await recentTitles(phone);
  check("the phone keeps one shelf of seven, not a stack", phoneShelf.length === 7 && new Set(phoneShelf.map((r) => r.top)).size === 1 && new Set(phoneShelf.map((r) => r.baseline)).size === 1);
  const before = await shelfScroll(phone);
  check("the shelf scrolls sideways at 390, the page doesn't", before?.overflow > 0 && before.left === 0 && (await noSideScroll(phone)), JSON.stringify(before));
  check("an arrow shows there's more, and none points back yet", (await phone.locator('[data-shelf-arrow="right"]').count()) === 1 && (await phone.locator('[data-shelf-arrow="left"]').count()) === 0);
  const clear = async () =>
    phone.evaluate((recent) => {
      const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const covered = [...document.querySelectorAll(`${recent} [data-media] > div, ${recent} a[data-recent-game] p`)].map((el) => el.getBoundingClientRect());
      return [...document.querySelectorAll("[data-shelf-arrow-face]")].every((face) => {
        const r = face.getBoundingClientRect();
        // The visible button may not cover any game's artwork or title.
        return !covered.some((c) => c.width > 0 && overlaps(r, c));
      });
    }, RECENT);
  check("the arrow covers no game artwork or title", await clear());
  await phone.locator(RECENT).scrollIntoViewIfNeeded();
  const target = await phone.evaluate(() => {
    const button = document.querySelector('[data-shelf-arrow="right"]');
    const r = button.getBoundingClientRect();
    const face = button.querySelector("[data-shelf-arrow-face]").getBoundingClientRect();
    const hit = (dx, dy) => button.contains(document.elementFromPoint(r.left + r.width / 2 + dx, r.top + r.height / 2 + dy));
    return { size: Math.round(face.width), target: Math.round(Math.min(r.width, r.height)), tap: hit(0, 0) && hit(-20, 0) && hit(0, -20) && hit(0, 20) };
  });
  check("small arrow, still a 44px tap target", target.size <= 32 && target.target >= 44 && target.tap, JSON.stringify(target));
  await phone.locator(RECENT).screenshot({ path: join(SHOTS, "12-recently-added-mobile-390-start.png") });
  await phone.locator('[data-shelf-arrow="right"]').click();
  check("the arrow moves the shelf on", await eventually(async () => (await shelfScroll(phone)).left > 100, 3000), JSON.stringify(await shelfScroll(phone)));
  check("and a back arrow appears", await eventually(async () => (await phone.locator('[data-shelf-arrow="left"]').count()) === 1, 3000));
  await phone.waitForTimeout(600);
  check("neither arrow covers any game artwork or title once scrolled", await clear());
  await phone.waitForTimeout(600);
  await phone.locator(RECENT).screenshot({ path: join(SHOTS, "13-recently-added-mobile-390-scrolled.png") });
  const scroller = phone.locator(`${RECENT} [data-shelf-scroller]`);
  await scroller.evaluate((el) => el.scrollTo({ left: 0 }));
  await eventually(async () => (await shelfScroll(phone)).left === 0, 3000);
  await phone.locator(`${RECENT} a[data-recent-game]`).last().focus();
  check("keyboard focus on the last game scrolls it into view", await eventually(async () => (await shelfScroll(phone)).left > 100, 3000));
  const swipeFrom = await shelfScroll(phone);
  await scroller.evaluate((el) => el.scrollBy({ left: -200 }));
  check("and it scrolls back, as a swipe would", await eventually(async () => (await shelfScroll(phone)).left < swipeFrom.left, 3000));
  check("still no page-wide horizontal scrolling", await noSideScroll(phone));
  await axe(phone, "populated, 390, shelf scrolled");

  section("6. Keyboard and links");
  await goHome(desk, "My Systems");
  let reached = false;
  for (let i = 0; i < 40 && !reached; i += 1) {
    await desk.keyboard.press("Tab");
    reached = await desk.evaluate(() => document.activeElement?.textContent?.trim() === "Add a Game");
  }
  check("Tab reaches Add a Game", reached);
  await desk.keyboard.press("Enter");
  await desk.waitForURL(/\/explore$/);
  check("and Enter opens Explore", new URL(desk.url()).pathname === "/explore");
  await goHome(desk, "My Systems");
  await desk.locator('section[aria-labelledby="home-systems"] a[href="/collection/systems/game-boy"]').focus();
  await desk.keyboard.press("Enter");
  await desk.waitForURL(/\/collection\/systems\/game-boy$/);
  check("a focused system tile opens that shelf, which holds the game", await eventually(async () => (await mainText(desk)).includes("Tetris")));
  await desk.goto(`${ORIGIN}/collection/systems`, { waitUntil: "networkidle" });
  check("the SNES, seventh by copies, is on Systems, one link away", await eventually(async () => (await desk.locator('main a[href="/collection/systems/snes"]').count()) === 1));
  await goHome(desk, "Recently Added");
  await desk.locator(`${RECENT} a[data-recent-game]`).first().click();
  await desk.waitForURL(/\/collection\/[0-9a-f-]{36}$/);
  check("a game on the shelf opens its newest copy's page", await eventually(async () => (await mainText(desk)).includes("Mario Kart 64")));

  section("7. Another new collector");
  const samEmail = email("sam");
  made.push(samEmail);
  const sam = await (await browser.newContext({ viewport: DESKTOP, colorScheme: "dark" })).newPage();
  await register(sam, samEmail, password(), `hs${TAG}`);
  check("their Home is the first-collection invitation", await homeLoaded(sam, "Your collection starts here"));
  const samHome = await mainText(sam);
  check("with none of the first collector's games, systems or counts", !["Super Mario World", "Pokémon Emerald", "My Systems", "Recently Added"].some((t) => samHome.includes(t)));
  await sam.context().close();

  section("8. Signing out");
  await goHome(desk, "My Systems");
  await desk.getByRole("button", { name: "Account menu" }).click();
  await desk.getByRole("menuitem", { name: "Sign out" }).or(desk.getByRole("button", { name: "Sign out" })).first().click();
  await desk.waitForURL(/\/sign-in/);
  await goHome(desk, "Beautifully Organized");
  const after = await mainText(desk);
  check("Home is the landing again, with nothing of the collection", !["Super Mario World", "My Systems", "Recently Added"].some((t) => after.includes(t)));
  await phone.context().close();
  await desk.context().close();
} catch (error) {
  check("the checks ran to the end", false, String(error.message).split("\n")[0]);
} finally {
  await browser?.close();
  const ids = psql(`select coalesce(string_agg(id::text, ','), '') from auth.users where email like 'home-${TAG}-%@example.test';`).split(",").filter(Boolean);
  if (ids.length) {
    const list = ids.map((id) => `'${id}'`).join(",");
    psql(`delete from public.collection_items where owner_id in (${list});`);
    for (const id of ids) await fetch(`${API}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    psql(`delete from private.handle_holds where kind = 'released' and handle like '%${TAG}';`);
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}); commit;`);
  }
  check("the disposable accounts are removed", psql(`select count(*) from auth.users where email like 'home-${TAG}-%';`) === "0");
  check("the demo catalog is exactly as it was", footprint(psql, CATALOG) === startingCatalog);
}
console.log(`\n${results.passed} passed, ${results.failed} failed (screenshots: ${SHOTS})`);
process.exit(results.failed === 0 ? 0 : 1);
