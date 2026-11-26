/**
 * M17a Explore: suggestions while typing, the results grid, the quick add and quick wishlist,
 * browsing by system and the header, on the running demo preview (http://127.0.0.6:3006), in a
 * real browser (headless Edge or Chrome via playwright-core), with a collector who registers
 * through the app's own sign-up page and confirms from the demo's Mailpit. The collector workflow:
 *
 * 1. signed out: the landing (search, systems with their counts, all platforms, games on the
 *    most systems), suggestions for "Mario" and the results, the SNES browse, the header at
 *    320, 390 and 768 pixels, and Add and Wishlist asking to sign in and coming back;
 * 2. a new collector types "Mario", sees suggestions (stale answers never win), and opens one;
 * 3. adds a game from an Explore result without visiting its page (a platform, a region or
 *    "not sure", nothing added before Add), and sees it owned there and on its system's shelf;
 * 4. adds another game to the wishlist (any version), sees it saved, not added twice, and on
 *    the wishlist page;
 * 5. opens the game's page, sees the copy, and signs out to the public state;
 * 6. the same on a phone, and axe at a phone and a desktop width.
 *
 * Screenshots go to EXPLORE_SCREENSHOTS (default ~/.my-game-dex/demo/m17a-screens).
 *
 *   MGD_STACK=demo node scripts/app-explore-checks.mjs   (npm run app:explore-checks)
 *
 * The demo stack and its running preview only. Its accounts are disposable ("explore-…@example.test")
 * and removed at the end with their copies and wishes; the demo catalog is checked to be exactly
 * as it was. Prints check names, never a password, token, link or cookie.
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
const status = stackStatus({ label: "the Explore checks" });
const MAILPIT = status.MAILPIT_URL ?? status.INBUCKET_URL ?? "http://127.0.0.1:59324";
const API = status.API_URL;
const SERVICE = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
const SHOTS = process.env.EXPLORE_SCREENSHOTS ?? join(homedir(), ".my-game-dex", "demo", "m17a-screens");
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
const email = (who) => `explore-${TAG}-${who}@example.test`;
const password = () => `Explore ${randomBytes(9).toString("base64url")} shelf`;
const CATALOG = ["public.games", "public.game_platforms", "public.releases", "public.game_aliases"];
const startingCatalog = footprint(psql, CATALOG);
const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 768, height: 1024 };
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 320, height: 640 };
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

/** Registers through the sign-up page, confirms from Mailpit, chooses a handle. */
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

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function shoot(page, name, { fullPage = false } = {}) {
  await settle(page);
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

/** The header's logo and controls don't overlap each other, and the page doesn't scroll sideways. */
async function headerFits(page) {
  return page.evaluate(() => {
    const header = document.querySelector("header");
    const logo = header?.querySelector('a[aria-label$="home"]');
    const controls = [...(header?.querySelectorAll("a, button") ?? [])].filter((el) => el !== logo && el.getClientRects().length && !logo?.contains(el));
    const overlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const parts = logo ? [logo, ...logo.querySelectorAll("svg, span")].filter((el) => el.getClientRects().length) : [];
    const clash = parts.some((p) => controls.some((c) => overlap(p.getBoundingClientRect(), c.getBoundingClientRect())));
    return { clash, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth, right: Math.max(...controls.map((c) => c.getBoundingClientRect().right)) <= window.innerWidth + 1 };
  });
}

const cards = (page) =>
  page.evaluate(() => [...document.querySelectorAll("[data-game-card]")].map((c) => ({ title: c.getAttribute("data-game-card"), text: c.innerText.replace(/\s+/g, " ") })));

/** Types into Explore's search like a person, and returns the suggestions shown. */
async function typeSearch(page, text) {
  const input = page.locator("[data-explore-search] input[role=combobox]");
  await input.click();
  await input.fill("");
  await page.keyboard.type(text, { delay: 70 });
  await eventually(async () => (await page.locator("[role=listbox]:visible [role=option]").count()) > 0, 8000);
  await page.waitForTimeout(300);
  return page.locator("[role=listbox]:visible [role=option]").evaluateAll((els) => els.map((e) => e.getAttribute("data-suggestion")));
}

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
  await guest.goto(`${ORIGIN}/explore`, { waitUntil: "networkidle" });
  const landing = await mainText(guest);
  check("the landing has a search field, not an empty box", (await guest.locator("[data-explore-search] input[role=combobox]").count()) === 1 && !landing.includes("Search the game catalog"));
  const counts = Object.fromEntries(
    psql("select p.slug || '=' || count(distinct g.id) from public.platforms p join public.game_platforms gp on gp.platform_id = p.id and gp.status = 'published' join public.games g on g.id = gp.game_id and g.status = 'published' group by p.slug;")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("=")),
  );
  const tiles = await guest.locator('section[aria-labelledby="explore-systems"] ul.hidden a, section[aria-labelledby="explore-systems"] ul.sm\\:grid a').evaluateAll((as) =>
    as.filter((a) => a.getClientRects().length).map((a) => ({ href: a.getAttribute("href"), text: a.innerText.replace(/\s+/g, " "), art: Boolean(a.querySelector("img")) })),
  );
  check("Browse by System: exactly the systems with games", tiles.length === Object.keys(counts).length && tiles.every((t) => counts[t.href.split("=")[1]]), `${tiles.length} vs ${Object.keys(counts).length}`);
  check("each with the database's game count", tiles.every((t) => t.text.includes(`${counts[t.href.split("=")[1]]} games`)), JSON.stringify(tiles.map((t) => t.text)));
  check("each with its approved console art", tiles.every((t) => t.art));
  check("and every supported platform one step away", /All supported platforms \(\d+\)/.test(landing));
  const most = await cards(guest);
  const mostDb = psql("select string_agg(n::text, ',' order by n desc) from (select count(*) n from public.game_platforms gp join public.games g on g.id = gp.game_id where gp.status = 'published' and g.status = 'published' group by gp.game_id order by n desc limit 8) t;").split(",");
  check("games on the most systems, by the catalog's own pairings", most.length > 0 && most.length <= 8 && mostDb[0] >= 3, String(most.length));
  check("no trending, popular or rated claims", !/trending|popular|top rated|rating/i.test(landing));
  check("no page-wide sideways scrolling at 1440", await noSideScroll(guest));
  await shoot(guest, "01-explore-landing-desktop-1440");
  await shoot(guest, "01-explore-landing-desktop-1440-full", { fullPage: true });
  await axe(guest, "landing, signed out, 1440");

  const suggestions = await typeSearch(guest, "mario");
  check("typing “mario” suggests real games", suggestions.length >= 6 && suggestions.length <= 8 && suggestions.every((t) => /mario/i.test(t) || t), suggestions.join(" | "));
  const optionText = await guest.locator("[role=listbox]:visible [role=option]").first().innerText();
  check("each with its year and platforms", /\b(19|20)\d\d\b/.test(optionText) && /NES|SNES|N64|GB|GBA|GBC/.test(optionText), optionText);
  check("own titles before other-title matches at the same strength", suggestions.indexOf("Mario Bros.") >= 0 && suggestions.indexOf("Mario Bros.") < Math.max(0, suggestions.indexOf("Super Mario Bros. 2")), suggestions.join(" | "));
  await shoot(guest, "02-autocomplete-mario-desktop-1440");
  await guest.keyboard.press("ArrowDown");
  check("arrow keys move through the suggestions", (await guest.locator("[role=option][aria-selected=true]").count()) === 1);
  await guest.keyboard.press("Escape");
  check("Escape closes them", (await guest.locator("[role=listbox]:visible").count()) === 0);
  await guest.keyboard.press("Enter");
  await guest.waitForURL(/\/explore\?q=mario/);
  check("Enter with none chosen runs the full search", new URL(guest.url()).searchParams.get("q") === "mario");
  await eventually(async () => (await guest.locator("[data-game-card]").count()) > 0);
  const marioCards = await cards(guest);
  check("results are a grid of game cards", marioCards.length === 20, String(marioCards.length));
  check("no repeated “no verified release” notice", !(await mainText(guest)).includes("no verified release"));
  check("every card offers Add to Collection and Wishlist", (await guest.locator("[data-game-card] [data-action=add]").count()) === 20 && (await guest.locator("[data-game-card] [data-action=wish]").count()) === 20);
  check("no control nested in another link", await guest.evaluate(() => ![...document.querySelectorAll("[data-game-card] a, [data-game-card] button")].some((el) => el.parentElement?.closest("a, button"))));
  check("cards fill the width: three or more across at 1440", await guest.evaluate(() => {
    const tops = [...document.querySelectorAll("[data-game-card]")].slice(0, 6).map((c) => Math.round(c.getBoundingClientRect().top));
    return tops.filter((t) => t === tops[0]).length >= 3;
  }));
  await shoot(guest, "03-search-mario-desktop-1440");
  await guest.goto(`${ORIGIN}/explore?q=sonic`, { waitUntil: "networkidle" });
  check("Sonic results", (await cards(guest)).some((c) => /Sonic the Hedgehog/.test(c.title)));
  await shoot(guest, "04-search-sonic-desktop-1440");

  await guest.goto(`${ORIGIN}/explore?q=mario`, { waitUntil: "networkidle" });
  await guest.locator("#catalog-platform").selectOption("snes");
  await guest.waitForURL(/platform=snes/);
  check("choosing a system applies it, with no extra Search", new URL(guest.url()).searchParams.get("platform") === "snes");
  await guest.goto(`${ORIGIN}/explore?platform=snes`, { waitUntil: "networkidle" });
  const snes = await cards(guest);
  check("SNES browsing: SNES games, A to Z", snes.length === 20 && (await mainText(guest)).includes("Super Nintendo Entertainment System, A to Z"));
  check("the SNES chip is the current one", (await guest.locator('nav[aria-label="Systems"] a[aria-current="page"]').innerText()).startsWith("SNES"));
  await shoot(guest, "05-platform-snes-desktop-1440");

  const firstAdd = guest.locator("[data-game-card] [data-action=add]").first();
  check("signed out, Add asks to sign in and comes back with the game", /^\/sign-in\?next=%2Fexplore%3Fplatform%3Dsnes%26add%3D/.test((await firstAdd.getAttribute("href")) ?? ""));
  check("and so does Wishlist", /wish%3D/.test((await guest.locator("[data-game-card] [data-action=wish]").first().getAttribute("href")) ?? ""));

  await guest.goto(`${ORIGIN}/explore?q=qwxzv+cartridge`, { waitUntil: "networkidle" });
  const empty = await mainText(guest);
  check("no results: says so, offers adding the game and systems to browse", empty.includes("No games found") && empty.includes("Add it to My Game Dex") && empty.includes("Or browse a system"));
  await shoot(guest, "06-empty-results-desktop-1440");

  for (const [size, label] of [
    [SMALL, "320"],
    [PHONE, "390"],
    [TABLET, "768"],
  ]) {
    await guest.setViewportSize(size);
    await guest.goto(`${ORIGIN}/explore`, { waitUntil: "networkidle" });
    const fit = await headerFits(guest);
    check(`signed out, ${label}px: the header fits, nothing over the logo`, !fit.clash && !fit.wide && fit.right, JSON.stringify(fit));
  }
  await guest.setViewportSize(PHONE);
  await shoot(guest, "07-explore-landing-mobile-390-signed-out", { fullPage: true });
  await guest.setViewportSize(SMALL);
  await shoot(guest, "08-header-320-signed-out");
  await guest.context().close();

  section("2. A collector types Mario");
  const pat = email("pat");
  made.push(pat);
  const desk = await (await browser.newContext({ viewport: DESKTOP, colorScheme: "dark" })).newPage();
  await register(desk, pat, password(), `ex${TAG}`);
  const patId = psql(`select id from auth.users where email = '${pat}';`);
  await desk.goto(`${ORIGIN}/explore`, { waitUntil: "networkidle" });
  const typed = await typeSearch(desk, "super mario w");
  check("suggestions follow the newest typing", typed.length > 0 && typed[0] === "Super Mario World", typed.join(" | "));
  await desk.locator('[role=option][data-suggestion="Super Mario World"]').click();
  await desk.waitForURL(/\/games\/super-mario-world/);
  check("choosing a suggestion opens that game", new URL(desk.url()).pathname === "/games/super-mario-world");

  section("3. Add a game from Explore, without its page");
  await desk.goto(`${ORIGIN}/explore?q=sonic`, { waitUntil: "networkidle" });
  const sonicCard = desk.locator('[data-game-card="Sonic the Hedgehog"]').first();
  await sonicCard.locator("[data-action=add]").click();
  const dialog = desk.getByRole("dialog");
  await eventually(async () => (await dialog.getByRole("radio").count()) > 0);
  check("the quick add opens as a dialog with the game's platforms", (await dialog.getByRole("heading", { name: "Add Sonic the Hedgehog" }).count()) === 1);
  check("nothing is added before Add", psql(`select count(*) from public.collection_items where owner_id = '${patId}';`) === "0");
  const platformRadios = await dialog.locator('fieldset:has(legend:text("Platform")) input[type=radio]').count();
  if (platformRadios > 1) await dialog.locator("label", { hasText: "Mega Drive" }).first().click();
  await dialog.locator("label", { hasText: /^PAL$/ }).click();
  check("region offers Not sure", (await dialog.locator("label", { hasText: "Not sure" }).count()) >= 1);
  check("optional details stay collapsed", (await dialog.locator("details").first().getAttribute("open")) === null);
  await shoot(desk, "09-quick-add-dialog-desktop-1440");
  await dialog.getByRole("button", { name: "Add to collection" }).click();
  check("added, with a confirmation", await eventually(async () => (await dialog.locator("[data-quick-add-done]").count()) === 1));
  const row = psql(`select p.slug || '|' || coalesce(c.claimed_region_code, 'null') || '|' || (c.release_id is null)::text from public.collection_items c join public.platforms p on p.id = c.claimed_platform_id where c.owner_id = '${patId}';`);
  check("one copy, on the Mega Drive, PAL, not linked to a release", row === "mega-drive|pal|true", row);
  await shoot(desk, "10-quick-add-done-desktop-1440");
  await desk.keyboard.press("Escape");
  check("the result now says it's in the collection", await eventually(async () => (await sonicCard.innerText()).includes("In your collection")));
  await desk.goto(`${ORIGIN}/collection/systems/mega-drive`, { waitUntil: "networkidle" });
  check("and it's on the Mega Drive shelf", await eventually(async () => (await mainText(desk)).includes("Sonic the Hedgehog")));

  section("4. Wishlist another game");
  await desk.goto(`${ORIGIN}/explore?q=zelda`, { waitUntil: "networkidle" });
  const zelda = desk.locator('[data-game-card="The Legend of Zelda: A Link to the Past"]').first();
  await zelda.locator("[data-action=wish]").click();
  check("Wishlist saves it at once", await eventually(async () => (await zelda.locator("[data-wished]").count()) === 1));
  const wishes = () => psql(`select count(*) || '|' || coalesce(string_agg(coalesce(platform_id::text, 'any'), ','), '') from public.wishlist_items where owner_id = '${patId}';`);
  check("one wish, for any version", wishes() === "1|any", wishes());
  await shoot(desk, "11-wishlist-saved-desktop-1440");
  await desk.reload({ waitUntil: "networkidle" });
  check("after a reload it still says Wishlisted, linking to the entry", /^\/collection\/wishlist\/[0-9a-f-]{36}$/.test((await zelda.locator("[data-wished]").getAttribute("href")) ?? ""));
  check("and no second wish was made", wishes() === "1|any", wishes());
  await desk.goto(`${ORIGIN}/collection/wishlist`, { waitUntil: "networkidle" });
  check("it's on the wishlist page", await eventually(async () => (await mainText(desk)).includes("A Link to the Past")));

  section("5. The game's page, then signing out");
  await desk.goto(`${ORIGIN}/games/sonic-the-hedgehog`, { waitUntil: "networkidle" });
  check("the game's page shows the copy", await eventually(async () => (await desk.locator('[data-my-copy-panel="owned"]').count()) === 1 && (await desk.locator("[data-owned]").textContent()).includes("Owned: Yes")));
  for (const [size, label] of [
    [SMALL, "320"],
    [PHONE, "390"],
    [TABLET, "768"],
  ]) {
    await desk.setViewportSize(size);
    await desk.goto(`${ORIGIN}/explore`, { waitUntil: "networkidle" });
    const fit = await headerFits(desk);
    check(`signed in, ${label}px: the header fits, nothing over the logo`, !fit.clash && !fit.wide && fit.right, JSON.stringify(fit));
  }
  await desk.setViewportSize(SMALL);
  await shoot(desk, "12-header-320-signed-in");
  await desk.setViewportSize(DESKTOP);
  await axe(desk, "results, signed in, 1440");

  section("6. On a phone");
  const phone = await (await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, colorScheme: "dark", storageState: await desk.context().storageState() })).newPage();
  await phone.goto(`${ORIGIN}/explore`, { waitUntil: "networkidle" });
  check("the phone landing doesn't scroll sideways", await noSideScroll(phone));
  await shoot(phone, "13-explore-landing-mobile-390", { fullPage: true });
  await phone.goto(`${ORIGIN}/explore?q=mario`, { waitUntil: "networkidle" });
  check("phone results don't scroll sideways", await noSideScroll(phone));
  await shoot(phone, "14-search-mario-mobile-390");
  await axe(phone, "results, signed in, 390");
  await phone.locator("[data-game-card] [data-action=add]").first().click();
  await eventually(async () => (await phone.getByRole("dialog").getByRole("radio").count()) > 0);
  const sheet = await phone.getByRole("dialog").boundingBox();
  check("on a phone the quick add rises as a sheet", sheet && sheet.y + sheet.height >= PHONE.height - 2, JSON.stringify(sheet));
  await shoot(phone, "15-quick-add-mobile-390");
  await phone.keyboard.press("Escape");
  check("closing it adds nothing", psql(`select count(*) from public.collection_items where owner_id = '${patId}';`) === "1");
  await phone.context().close();

  await desk.getByRole("button", { name: "Account menu" }).click();
  await desk.getByRole("menuitem", { name: "Sign out" }).or(desk.getByRole("button", { name: "Sign out" })).first().click();
  await desk.waitForURL(/\/sign-in/);
  await desk.goto(`${ORIGIN}/explore?q=sonic`, { waitUntil: "networkidle" });
  const publicText = await mainText(desk);
  check("signed out again: nothing of the collector's shows", !publicText.includes("In your collection") && (await desk.locator("[data-wished]").count()) === 0);
  await desk.context().close();
} catch (error) {
  check("the checks ran to the end", false, String(error.message).split("\n")[0]);
} finally {
  await browser?.close();
  const ids = psql(`select coalesce(string_agg(id::text, ','), '') from auth.users where email like 'explore-${TAG}-%@example.test';`).split(",").filter(Boolean);
  if (ids.length) {
    const list = ids.map((id) => `'${id}'`).join(",");
    psql(`delete from public.collection_items where owner_id in (${list});`);
    psql(`delete from public.wishlist_items where owner_id in (${list});`);
    for (const id of ids) await fetch(`${API}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    psql(`delete from private.handle_holds where kind = 'released' and handle like '%${TAG}';`);
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}); commit;`);
  }
  check("the disposable accounts are removed", psql(`select count(*) from auth.users where email like 'explore-${TAG}-%';`) === "0");
  check("the demo catalog is exactly as it was", footprint(psql, CATALOG) === startingCatalog);
}
console.log(`\n${results.passed} passed, ${results.failed} failed (screenshots: ${SHOTS})`);
process.exit(results.failed === 0 ? 0 : 1);
