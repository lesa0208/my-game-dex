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
  check("the hero: title, platforms to choose, first release, Add and Wishlist", (await guest.getByRole("heading", { level: 1, name: "Super Mario World" }).count()) === 1 && smw.includes("November 21, 1990") && (await guest.locator('nav[aria-label="Game platform"] a').count()) === 2 && (await guest.locator("[data-action=add]").count()) === 1 && (await guest.locator("[data-action=wish]").count()) === 1);
  check("no shelf under the hero image", (await guest.locator("article[aria-labelledby=game-title] .wood-top").count()) === 0);
  check("no approved image exists, so it says so, never a made-up label", (await heroImage(guest)) === "none" && smw.includes("No artwork for Super Mario World yet"));
  const aliasesInHero = await guest.locator("article[aria-labelledby=game-title]").innerText();
  check("the other titles aren't between the title and the facts", !aliasesInHero.includes("Regional title"));
  check("they're folded under Other titles", /Other titles \(\d+\)/.test(smw) && (await guest.locator("details:has(summary:text('Other titles'))").getAttribute("open")) === null);
  check("tabs jump to the page's parts", (await guest.locator('nav[aria-label="On this page"] a').evaluateAll((as) => as.map((a) => a.getAttribute("href")).join())) === "#overview,#add-copy,#releases,#your-copies");
  check("no gallery when there are no approved images", (await guest.locator("#gallery").count()) === 0);
  check("no invented ratings, rankings, screenshots or community counts", !/rating|ranked|#\d+ |screenshots|community \(\d/i.test(smw));
  check("a visitor is offered Create Account and Sign In, and nothing of anyone's collection", smw.includes("Do you own Super Mario World?") && smw.includes("Create Account") && !smw.includes("Owned:") && (await guest.locator("[data-my-copy]").count()) === 0);
  check("no page-wide sideways scrolling at 1440", await noSideScroll(guest));
  await shoot(guest, "01-game-super-mario-world-desktop-1440");
  await shoot(guest, "01-game-super-mario-world-desktop-1440-full", { fullPage: true });
  await axe(guest, "game page, visitor, 1440");
  await guest.goto(`${ORIGIN}/games/space-invaders`, { waitUntil: "networkidle" });
  check("a game on seven systems: seven platform choices, none assumed", (await guest.locator('nav[aria-label="Game platform"] a').count()) === 7 && (await guest.locator('nav[aria-label="Game platform"] a[aria-current]').count()) === 0);
  await guest.locator('nav[aria-label="Game platform"] a', { hasText: /^\s*NES\s*$/ }).click();
  await guest.waitForURL(/platform=nes/);
  check("choosing one shows it, with its console for the system only", (await guest.locator('nav[aria-label="Game platform"] a[aria-current]').innerText()).includes("NES") && (await mainText(guest)).includes("The Nintendo Entertainment System console, for the system only"));
  await shoot(guest, "02-game-multi-platform-space-invaders-desktop-1440");
  await shoot(guest, "03-game-no-artwork-desktop-1440", { fullPage: false });
  const phoneGuest = await (await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, colorScheme: "dark" })).newPage();
  await phoneGuest.goto(`${ORIGIN}/games/super-mario-world`, { waitUntil: "networkidle" });
  check("the phone page doesn't scroll sideways", await noSideScroll(phoneGuest));
  await shoot(phoneGuest, "04-game-super-mario-world-mobile-390", { fullPage: true });
  await axe(phoneGuest, "game page, visitor, 390");
  await phoneGuest.context().close();
  await guest.context().close();

  section("2. A collector who owns the game");
  const kim = email("kim");
  made.push(kim);
  const desk = await (await browser.newContext({ viewport: DESKTOP, colorScheme: "dark" })).newPage();
  await register(desk, kim, password(), `gp${TAG}`);
  const kimId = psql(`select id from auth.users where email = '${kim}';`);
  await desk.goto(`${ORIGIN}/games/super-mario-world?platform=snes`, { waitUntil: "networkidle" });
  check("not owned yet: the hero offers Add to Collection", (await desk.locator("[data-owned]").count()) === 0 && (await desk.locator("[data-action=add]").innerText()).includes("Add to Collection"));
  await desk.locator("[data-action=add]").click();
  const dialog = desk.getByRole("dialog");
  await eventually(async () => (await dialog.getByRole("radio").count()) > 0);
  check("the quick add opens with the page's platform chosen", (await dialog.locator("label:has(input:checked)", { hasText: "Super Nintendo" }).count()) === 1);
  await dialog.locator("label", { hasText: /^NTSC-U\/C$/ }).click();
  await dialog.getByRole("button", { name: "Add to collection" }).click();
  check("added from the hero", await eventually(async () => (await dialog.locator("[data-quick-add-done]").count()) === 1));
  await desk.keyboard.press("Escape");
  check("the hero now says it's owned", await eventually(async () => (await desk.locator("[data-owned]").count()) === 1 && (await desk.locator("[data-owned]").innerText()).includes("Owned: Yes")));
  const copy = desk.locator("[data-my-copy]").first();
  check("Your copies lists it with its platform and region, and View and Edit", await eventually(async () => /SNES/.test(await copy.innerText()) && /NTSC-U\/C/.test(await copy.innerText())) && (await copy.getByRole("link", { name: /^View copy, / }).count()) === 1 && (await copy.getByRole("link", { name: /^Edit, / }).count()) === 1);
  check("only what was recorded: no condition or completeness yet, said once", (await copy.innerText()).includes("No condition or completeness recorded yet") && !(await copy.innerText()).includes("not recorded"));
  check("no visitor panel for a collector", (await desk.locator("#visitor-panel").count()) === 0);
  await shoot(desk, "05-game-owned-desktop-1440");
  await shoot(desk, "05-game-owned-desktop-1440-full", { fullPage: true });
  await axe(desk, "game page, owner, 1440");
  const itemId = psql(`select id from public.collection_items where owner_id = '${kimId}';`);
  await copy.getByRole("link", { name: /^Edit, / }).click();
  await desk.waitForURL(new RegExp(`/collection/${itemId}\\?edit=1`));
  check("Edit opens the copy's edit form, open", (await desk.locator("details#edit").getAttribute("open")) !== null);
  await desk.goBack({ waitUntil: "networkidle" });
  await desk.locator("[data-my-copy]").first().getByRole("link", { name: /^View copy, / }).click();
  await desk.waitForURL(new RegExp(`/collection/${itemId}$`));
  const closed = await eventually(async () => (await desk.locator("details#edit").getAttribute("open")) === null, 6000);
  check("View opens the copy, with its edit form closed", closed, `${new URL(desk.url()).pathname}${new URL(desk.url()).search} open=${await desk.locator("details#edit").getAttribute("open")} count=${await desk.locator("details#edit").count()}`);
  await desk.goto(`${ORIGIN}/games/super-mario-world?platform=snes`, { waitUntil: "networkidle" });
  await desk.locator("[data-action=wish]").click();
  check("Wishlist from the hero too", await eventually(async () => (await desk.locator("[data-wished]").count()) === 1));
  check("one wish, any version", psql(`select count(*) || '|' || coalesce(string_agg(coalesce(platform_id::text, 'any'), ','), '') from public.wishlist_items where owner_id = '${kimId}';`) === "1|any");
  const phone = await (await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, colorScheme: "dark", storageState: await desk.context().storageState() })).newPage();
  await phone.goto(`${ORIGIN}/games/super-mario-world?platform=snes`, { waitUntil: "networkidle" });
  check("the owner's phone page doesn't scroll sideways", await noSideScroll(phone));
  await shoot(phone, "06-game-owned-mobile-390", { fullPage: true });
  await phone.context().close();

  section("3. Another collector");
  const lee = email("lee");
  made.push(lee);
  const other = await (await browser.newContext({ viewport: DESKTOP, colorScheme: "dark" })).newPage();
  await register(other, lee, password(), `gq${TAG}`);
  await other.goto(`${ORIGIN}/games/super-mario-world?platform=snes`, { waitUntil: "networkidle" });
  const theirs = await mainText(other);
  check("sees none of the first collector's copy or wish", !theirs.includes("Owned:") && (await other.locator("[data-my-copy]").count()) === 0 && (await other.locator("[data-wished]").count()) === 0);
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
