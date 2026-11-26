/**
 * M17b Game Details: the hero (an approved image of the real item or an honest "no artwork" panel,
 * never a shelf or a made-up label), the platform choice, Add and Wishlist, the tabs, Other titles,
 * and the collector's own copies with View and Edit, on the running demo preview
 * (http://127.0.0.6:3006) in a real browser, with collectors who register through the sign-up page
 * and confirm from Mailpit: a visitor, a collector who adds the game from the hero, another
 * collector who sees none of it, a phone, and axe. Nothing invented: no ratings, rankings,
 * screenshots or community counts.
 *
 * Screenshots go to GAME_SCREENSHOTS (default ~/.my-game-dex/demo/m17b-screens).
 *
 *   MGD_STACK=demo node scripts/app-game-page-checks.mjs   (npm run app:game-page-checks)
 *
 * The demo stack and its running preview only. Its accounts are disposable ("gamepage-…@example.test")
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
const status = stackStatus({ label: "the game page checks" });
const MAILPIT = status.MAILPIT_URL ?? status.INBUCKET_URL ?? "http://127.0.0.1:59324";
const API = status.API_URL;
const SERVICE = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
const SHOTS = process.env.GAME_SCREENSHOTS ?? join(homedir(), ".my-game-dex", "demo", "m17b-screens");
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
const email = (who) => `gamepage-${TAG}-${who}@example.test`;
const password = () => `Game page ${randomBytes(9).toString("base64url")} shelf`;
const CATALOG = ["public.games", "public.game_platforms", "public.releases", "public.game_aliases"];
const startingCatalog = footprint(psql, CATALOG);
const DESKTOP = { width: 1440, height: 900 };
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

const made = [];
const heroImage = (page) => page.locator("[data-game-image]").first().getAttribute("data-game-image");
const tabNames = (page) => page.getByRole("tab").evaluateAll((tabs) => tabs.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
const shownPanel = (page) => page.getByRole("tabpanel").evaluateAll((panels) => panels.filter((p) => p.getClientRects().length > 0).map((p) => `panel-${p.dataset.panel}`));
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

  section("1. A visitor");
  const guest = await (await browser.newContext({ viewport: DESKTOP, colorScheme: "dark" })).newPage();
  await guest.goto(`${ORIGIN}/games/super-mario-world`, { waitUntil: "networkidle" });
  const smw = await mainText(guest);
  check("the hero: title, its system, Add to Collection and Wishlist", (await guest.getByRole("heading", { level: 1, name: "Super Mario World" }).count()) === 1 && (await guest.locator("[data-action=add]").count()) === 1 && (await guest.locator("[data-action=wish]").count()) === 1);
  check("the page opens on the game's earliest system (SNES), the other a click away", (await guest.locator('nav[aria-label="Game platform"] a[aria-current] [aria-hidden]').innerText()) === "SNES" && (await guest.locator('nav[aria-label="Game platform"] a[aria-current]').getAttribute("title")) === "Super Nintendo Entertainment System" && (await guest.locator('nav[aria-label="Game platform"] a').count()) === 2);
  const layout = await guest.evaluate(() => {
    const box = (el) => el?.getBoundingClientRect();
    const art = box(document.querySelector("[data-game-image]"));
    const title = box(document.querySelector("#game-title"));
    return art && title ? { order: art.right < title.left, top: Math.abs(art.top - title.top) } : null;
  });
  check("at 1440 the artwork stands left of the game, side by side", Boolean(layout?.order) && layout.top < 200, JSON.stringify(layout));
  check("no shelf under the artwork", (await guest.locator("article[aria-labelledby=game-title] .wood-top").count()) === 0);
  // M18a: Super Mario World is enriched from IGDB on the demo; Tetris (held for review) keeps the empty states, checked below.
  const caption = (await guest.locator("[data-artwork-caption]").textContent()).replace(/\s+/g, " ");
  check("IGDB's cover as standalone game artwork, credited, its full wording a tap away", (await heroImage(guest)) === "igdb-cover" && caption.includes("Game artwork · IGDB.com") && caption.includes("General game artwork, not verified for a specific platform, region or edition"));
  check("the cover keeps its own proportions, from a size never upscaled", await guest.locator('[data-game-image="igdb-cover"] img').evaluate((i) => { const r = i.getBoundingClientRect(); return i.complete && i.naturalWidth > 0 && Math.abs(r.width / r.height - i.naturalWidth / i.naturalHeight) < 0.01; }));
  check("the backdrop is the cover's own wash, the cover being authorized for the SNES", (await guest.locator("[data-hero-backdrop]").getAttribute("data-hero-backdrop")) === "artwork");
  check("a meta line: the catalog's year, then IGDB's developer and genre, marked as IGDB's", await guest.locator("[data-hero-meta]").evaluate((p) => p.textContent.startsWith("1990") && p.textContent.includes("(from IGDB)")));
  check("a description preview from IGDB, credited, with Read more", (await guest.locator('[data-hero-description="igdb"]').count()) === 1 && (await guest.locator('[data-hero-description="igdb"]').innerText()).includes("Description from IGDB.com"));
  check("key facts by the title: the first release date and verified releases", /First released/.test(await guest.locator("article[aria-labelledby=game-title]").innerText()) && smw.includes("Verified releases"));
  check("each fact said once: the first release date isn't repeated in Overview or Game Details", smw.split("November 21, 1990").length === 2 && !smw.includes("Release Information"));
  check("Game Details gives the detail behind them: each system by its full name, with its verified releases", await (async () => { const t = await guest.locator("[data-game-facts]").innerText(); return t.includes("Super Nintendo Entertainment System") && t.includes("Game Boy Advance") && t.includes("No verified release yet") && !t.includes("First released"); })());
  check("real tabs: Overview, Physical Releases, My Copies, and Gallery for IGDB's screenshots", JSON.stringify((await tabNames(guest)).map((t) => t.replace(/\s*\(\d+\)$/, ""))) === JSON.stringify(["Overview", "Physical Releases", "My Copies", "Gallery"]));
  check("Overview shows; the other tabs' content doesn't", JSON.stringify(await shownPanel(guest)) === JSON.stringify(["panel-overview"]));
  check("Overview: About the Game with IGDB's description, credited; Other titles folded away", smw.includes("About the Game") && smw.includes("Description from IGDB.com") && !smw.includes("No description yet.") && /Other titles \(\d+\)/.test(smw) && (await guest.locator("details:has(summary:text('Other titles'))").getAttribute("open")) === null);
  check("the other titles aren't between the title and the facts", !(await guest.locator("article[aria-labelledby=game-title]").innerText()).includes("Regional title"));
  check("no add steps or wishlist form on the page itself", (await guest.locator("#choose-release").count()) === 0 && (await guest.locator("#add-wish:visible").count()) === 0);
  const outsideIgdb = smw.replace((await guest.locator("[data-provider-facts]").innerText().catch(() => "")).replace(/\s+/g, " "), "");
  check("no invented ratings, rankings or community counts; genres only as IGDB's, under From IGDB", !/rating|ranked|#\d+ |community \(\d/i.test(smw) && !/genre/i.test(outsideIgdb) && /Genre/.test(await guest.locator("[data-provider-facts=igdb]").innerText()));
  const empty = await guest.context().newPage();
  await empty.goto(`${ORIGIN}/games/tetris`, { waitUntil: "networkidle" });
  const tetris = await mainText(empty);
  check("a game without IGDB data (Tetris, held): the plain cartridge shape, not a made-up label", (await heroImage(empty)) === "none" && !tetris.includes("Artwork not available") && tetris.includes("No artwork for this game yet.") && tetris.includes("Shown: a neutral GB cartridge, without a label.") && (await empty.locator("[data-neutral-shell]").count()) === 1);
  check("its label recess carries no words at all", (await empty.locator("[data-neutral-shell]").innerText()).trim() === "");
  check("and its backdrop stays the generic light, with no description preview invented", (await empty.locator("[data-hero-backdrop]").getAttribute("data-hero-backdrop")) === "generic" && (await empty.locator("[data-hero-description]").count()) === 0);
  check("and its tabs: Overview, Physical Releases, My Copies; no Gallery without images", JSON.stringify((await tabNames(empty)).map((t) => t.replace(/\s*\(\d+\)$/, ""))) === JSON.stringify(["Overview", "Physical Releases", "My Copies"]));
  check("and a quiet line for the missing description; nothing from IGDB", tetris.includes("No description yet.") && !tetris.includes("IGDB") && (await empty.locator("[data-provider-facts]").count()) === 0);
  await empty.close();
  check("a visitor sees no My Copy panel and no sign-up card in the hero, nothing of anyone's", (await guest.locator("[data-my-copy-panel]").count()) === 0 && !(await guest.locator("[data-hero]").innerText()).includes("Create Account") && !smw.includes("Owned:"));
  check("a two-column hero: no empty third column", await guest.evaluate(() => { const art = document.querySelector("[data-game-image]").getBoundingClientRect(); const hero = document.querySelector("[data-hero]").getBoundingClientRect(); const title = document.querySelector("#game-title").getBoundingClientRect(); return title.left > art.right && hero.right - title.right < hero.width * 0.4; }));
  check("no page-wide sideways scrolling at 1440", await noSideScroll(guest));
  await shoot(guest, "01-game-super-mario-world-desktop-1440");
  await shoot(guest, "02-game-super-mario-world-desktop-1440-full", { fullPage: true });
  await guest.locator("[data-game-tabs]").screenshot({ path: join(SHOTS, "04-overview-tab-desktop-1440.png") });
  await axe(guest, "game page, visitor, 1440");

  await guest.getByRole("tab", { name: /Physical Releases/ }).click();
  check("choosing a tab shows its content, and the address names it", JSON.stringify(await shownPanel(guest)) === JSON.stringify(["panel-releases"]) && new URL(guest.url()).hash === "#releases");
  const emptyReleases = await guest.locator('[data-panel="releases"]').innerText();
  check("Physical Releases says briefly, once, that none is verified yet", emptyReleases.split("No verified physical release recorded yet").length === 2 && emptyReleases.includes("You can still add your copy") && !emptyReleases.includes("none of its editions"));
  check("and a visitor can sign in to add their copy from there", (await guest.locator("[data-releases-empty]").getByRole("link", { name: "Sign in to add" }).count()) === 1);
  await guest.locator("[data-game-tabs]").screenshot({ path: join(SHOTS, "05-physical-releases-tab-desktop-1440.png") });
  await guest.getByRole("tab", { name: /Physical Releases/ }).focus();
  await guest.keyboard.press("ArrowRight");
  check("the arrow keys move between the tabs", await eventually(async () => JSON.stringify(await shownPanel(guest)) === JSON.stringify(["panel-my-copies"]), 3000), JSON.stringify(await shownPanel(guest)));
  await guest.goto(`${ORIGIN}/games/super-mario-world#releases`, { waitUntil: "networkidle" });
  check("a tab can be linked: #releases opens Physical Releases", await eventually(async () => JSON.stringify(await shownPanel(guest)) === JSON.stringify(["panel-releases"]), 5000));

  await guest.goto(`${ORIGIN}/games/space-invaders`, { waitUntil: "networkidle" });
  check("a game on seven systems: seven to choose, opening on its earliest (NES)", (await guest.locator('nav[aria-label="Game platform"] a').count()) === 7 && (await guest.locator('nav[aria-label="Game platform"] a[aria-current] [aria-hidden]').innerText()) === "NES");
  await shoot(guest, "07-game-multi-platform-space-invaders-desktop-1440");
  await guest.locator('nav[aria-label="Game platform"]').getByRole("link", { name: "PlayStation", exact: true }).click();
  await guest.waitForURL(/platform=playstation/);
  check("choosing another system shows it, with that system's case shape", (await guest.locator('nav[aria-label="Game platform"] a[aria-current] [aria-hidden]').innerText()).includes("PS1") && (await mainText(guest)).includes("Shown: a neutral PS1 case, without a label."));
  const old = await fetch(`${ORIGIN}/games/super-mario-world?platform=snes&region=pal`, { redirect: "manual" });
  check("an old step address goes to the step-by-step add", old.status === 308 && old.headers.get("location")?.endsWith("/games/super-mario-world/add?platform=snes&region=pal"), `${old.status} ${old.headers.get("location")}`);
  const phoneGuest = await (await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, colorScheme: "dark" })).newPage();
  await phoneGuest.goto(`${ORIGIN}/games/super-mario-world`, { waitUntil: "networkidle" });
  check("the phone page doesn't scroll sideways", await noSideScroll(phoneGuest));
  const phoneHero = await phoneGuest.evaluate(() => {
    const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    const title = box("#game-title");
    const add = box("main [data-action=add]");
    const wish = box("main [data-action=wish]");
    const art = box("[data-game-image]");
    return title && add && wish && art ? { addBottom: Math.round(add.bottom), wishBottom: Math.round(wish.bottom), titleAboveArt: title.bottom <= art.top, view: innerHeight } : null;
  });
  check("on a phone the title, system, Add to Collection and Wishlist come first, before the artwork", Boolean(phoneHero?.titleAboveArt) && phoneHero.addBottom < phoneHero.view * 0.7 && phoneHero.wishBottom < phoneHero.view * 0.7, JSON.stringify(phoneHero));
  check("and the artwork follows, prominent but within the screen", await phoneGuest.locator("[data-game-image]").evaluate((el) => el.getBoundingClientRect().width <= 260 && el.getBoundingClientRect().width > 160));
  await shoot(phoneGuest, "06-game-super-mario-world-mobile-390", { fullPage: true });
  await shoot(phoneGuest, "06-game-super-mario-world-mobile-390-first-screen");
  await axe(phoneGuest, "game page, visitor, 390");
  await phoneGuest.context().close();
  await guest.context().close();

  section("2. A collector who owns the game");
  const kim = email("kim");
  made.push(kim);
  const desk = await (await browser.newContext({ viewport: DESKTOP, colorScheme: "dark" })).newPage();
  await register(desk, kim, password(), `gp${TAG}`);
  const kimId = psql(`select id from auth.users where email = '${kim}';`);
  // Opened from Explore with the keyboard (a client-side navigation), as a collector would.
  await desk.goto(`${ORIGIN}/explore?q=super+mario+world&platform=snes`, { waitUntil: "networkidle" });
  await desk.locator('[data-game-card="Super Mario World"] h3 a').first().focus();
  await desk.keyboard.press("Enter");
  await desk.waitForURL(/\/games\/super-mario-world/);
  check("opened from Explore, the game's page renders for a signed-in collector", await eventually(async () => (await desk.locator("#game-title:visible").count()) === 1 && (await desk.locator("main [data-action=add]:visible").count()) >= 1, 15000), `${desk.url()} :: ${(await mainText(desk)).slice(0, 160)}`);
  await desk.goto(`${ORIGIN}/games/super-mario-world`, { waitUntil: "networkidle" });
  check("not owned yet: no My Copy panel, only the hero's Add to Collection and Wishlist", await eventually(async () => (await desk.locator("main [data-action=add]").count()) >= 1) && (await desk.locator("[data-my-copy-panel]").count()) === 0 && (await desk.locator("[data-hero] [data-action=add-copy]").count()) === 0);
  check("and Physical Releases, with none verified, still offers to add a copy", (await desk.locator("[data-releases-empty] [data-action=add-copy]").count()) === 1);
  await desk.locator("main [data-action=add]").click();
  const dialog = desk.getByRole("dialog");
  await eventually(async () => (await dialog.getByRole("radio").count()) > 0);
  check("the quick add opens with the page's system chosen, and an edition choice", (await dialog.locator("label:has(input:checked)", { hasText: "Super Nintendo" }).count()) === 1 && (await dialog.getByText("Edition").count()) >= 1 && (await dialog.getByRole("link", { name: "Step by step" }).count()) === 1);
  await dialog.locator("label").filter({ hasText: /^NTSC-U\/C$/ }).click();
  await dialog.locator("label").filter({ hasText: /^Another edition$/ }).click();
  await dialog.locator('input[name="edition_name"]').fill("Player's Choice");
  await dialog.locator("summary", { hasText: "Condition, completeness and purchase" }).click();
  await dialog.locator('select[name="completeness"]').selectOption("complete");
  await dialog.locator('select[name="overall_condition"]').selectOption("very_good");
  await shoot(desk, "08-quick-add-dialog-desktop-1440");
  await dialog.getByRole("button", { name: "Add to collection" }).click();
  check("added from the hero", await eventually(async () => (await dialog.locator("[data-quick-add-done]").count()) === 1));
  check("stored as recorded: SNES, NTSC-U/C, Player's Choice, no release", psql(`select p.slug || '|' || c.claimed_region_code || '|' || coalesce(c.claimed_edition_name, '') || '|' || (c.release_id is null) from public.collection_items c join public.platforms p on p.id = c.claimed_platform_id where c.owner_id = '${kimId}';`) === "snes|ntsc-uc|Player's Choice|true");
  await desk.keyboard.press("Escape");
  const panel = desk.locator('[data-my-copy-panel="owned"]');
  check("the hero says it's owned (Your copies, beside it on a wide screen)", await eventually(async () => (await desk.locator("[data-owned]").textContent().catch(() => "")).includes("Owned: Yes") && (await panel.count()) === 1));
  check("My Copy shows the copy: platform, region and edition as recorded", await eventually(async () => {
    const t = (await panel.innerText().catch(() => "")).replace(/\s+/g, " ");
    return /platform snes/i.test(t) && /region ntsc-u\/c/i.test(t) && /edition player's choice/i.test(t);
  }));
  check("its recorded completeness and condition, as badges", await eventually(async () => { const t = await panel.innerText().catch(() => ""); return t.includes("Complete in box") && t.includes("Very good") && !t.includes("not recorded"); }));
  check("no picture in Your copies: not the cover, not a cartridge", (await panel.locator("img, svg image, [data-copy-illustration]").count()) === 0 && !(await panel.innerText()).includes("Super Mario World"));
  check("nothing private in the panel: no price, purchase or notes", !/price|paid|purchase|notes?:/i.test(await panel.innerText()));
  check("compact: the panel is no taller than the hero's centre", await (async () => { const h = await panel.evaluate((el) => el.getBoundingClientRect().height); return h > 0 && h < 380; })());
  check("with Edit and View copy", (await panel.getByRole("link", { name: /^Edit, / }).count()) === 1 && (await panel.getByRole("link", { name: /^View copy, / }).count()) === 1);
  await panel.screenshot({ path: join(SHOTS, "03-my-copy-panel-owner.png") });
  await shoot(desk, "09-game-owned-desktop-1440");
  await shoot(desk, "09-game-owned-desktop-1440-full", { fullPage: true });
  await axe(desk, "game page, owner, 1440");
  const itemId = psql(`select id from public.collection_items where owner_id = '${kimId}';`);
  await panel.getByRole("link", { name: /^Edit, / }).click();
  await desk.waitForURL(new RegExp(`/collection/${itemId}\\?edit=1`));
  check("Edit opens the copy's edit form, open", (await desk.locator("details#edit").getAttribute("open")) !== null);
  await desk.goBack({ waitUntil: "networkidle" });
  await desk.getByRole("tab", { name: "My Copies" }).click();
  const tabCopy = desk.locator('[data-panel="my-copies"] [data-my-copy]').first();
  check("the My Copies tab lists it with View copy and Edit", await eventually(async () => (await tabCopy.count()) === 1) && (await tabCopy.getByRole("link", { name: /^Edit, / }).count()) === 1);
  check("and holds the wishlist's options", (await desk.locator('[data-panel="my-copies"] #game-wishlist').count()) === 1);
  await desk.getByRole("tab", { name: "Overview" }).click();
  await desk.locator("main [data-action=wish]").click();
  check("Wishlist from the hero", await eventually(async () => (await desk.locator("[data-wished]").count()) === 1));
  check("one wish, any version", psql(`select count(*) || '|' || coalesce(string_agg(coalesce(platform_id::text, 'any'), ','), '') from public.wishlist_items where owner_id = '${kimId}';`) === "1|any");
  await desk.getByRole("button", { name: /^More for / }).click();
  await desk.getByRole("menuitem", { name: /Wishlist options/ }).click();
  check("More → Wishlist options opens the My Copies tab at the wishlist", await eventually(async () => JSON.stringify(await shownPanel(desk)) === JSON.stringify(["panel-my-copies"]) && (await desk.locator("#game-wishlist").isVisible())));
  const phone = await (await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, colorScheme: "dark", storageState: await desk.context().storageState() })).newPage();
  await phone.goto(`${ORIGIN}/games/super-mario-world`, { waitUntil: "networkidle" });
  check("the owner's phone page doesn't scroll sideways", await noSideScroll(phone));
  await shoot(phone, "10-game-owned-mobile-390", { fullPage: true });
  await phone.context().close();

  section("3. Another collector");
  const lee = email("lee");
  made.push(lee);
  const other = await (await browser.newContext({ viewport: DESKTOP, colorScheme: "dark" })).newPage();
  await register(other, lee, password(), `gq${TAG}`);
  await other.goto(`${ORIGIN}/games/super-mario-world`, { waitUntil: "networkidle" });
  const theirs = await mainText(other);
  check("sees none of the first collector's copy or wish", !theirs.includes("Owned:") && !theirs.includes("Player's Choice") && (await other.locator("[data-wished]").count()) === 0);
  await other.context().close();
  await desk.context().close();
} catch (error) {
  check("the checks ran to the end", false, String(error.message).split("\n")[0]);
} finally {

  await browser?.close();
  const ids = psql(`select coalesce(string_agg(id::text, ','), '') from auth.users where email like 'gamepage-${TAG}-%@example.test';`).split(",").filter(Boolean);
  if (ids.length) {
    const list = ids.map((id) => `'${id}'`).join(",");
    psql(`delete from public.collection_items where owner_id in (${list});`);
    psql(`delete from public.wishlist_items where owner_id in (${list});`);
    for (const id of ids) await fetch(`${API}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    psql(`delete from private.handle_holds where kind = 'released' and handle like '%${TAG}';`);
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}); commit;`);
  }
  check("the disposable accounts are removed", psql(`select count(*) from auth.users where email like 'gamepage-${TAG}-%';`) === "0");
  check("the demo catalog is exactly as it was", footprint(psql, CATALOG) === startingCatalog);
}
console.log(`\n${results.passed} passed, ${results.failed} failed (screenshots: ${SHOTS})`);
process.exit(results.failed === 0 ? 0 : 1);
