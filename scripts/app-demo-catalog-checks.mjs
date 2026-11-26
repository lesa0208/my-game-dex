/**
 * M16: the demo catalog, used as a collector would, in a real browser (headless Edge or Chrome via
 * playwright-core). Real Wikidata games across nine platforms: they are found by search and by
 * platform, and their physical copies are added with the fast add, though the catalog records no
 * release for them (the collector's own unidentified records), then seen on the system shelves.
 * Pages are audited with axe-core at a phone and a desktop width.
 *
 *   npm run build && MGD_STACK=demo npm run app:demo-catalog-checks
 *
 * The demo stack only (scripts/catalog-demo.mjs must have published it). It makes two throwaway
 * collectors and removes them, their copies and their audit rows at the end, and checks that the
 * catalog itself is exactly as it was. Prints check names, counts and timings, never keys.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { chromium } from "playwright-core";

import { api, appErrorLines, Browser, check, createUser, deleteUsers, formWith, psql, publishableKey, results, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { DEMO_PLATFORMS } from "./catalog-demo.mjs";
import { footprint } from "./lib/footprint.mjs";
import { projectId, stackName } from "./lib/stack.mjs";

if (stackName !== "demo" || projectId !== "my-game-dex-demo") {
  console.error("Refusing: run on the demo stack (MGD_STACK=demo).");
  process.exit(2);
}

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const CATALOG_TABLES = ["public.games", "public.game_platforms", "public.releases", "public.game_aliases"];
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const users = [];
const timings = [];
let browser;

async function collector(prefix) {
  const user = await createUser({ prefix });
  users.push(user.id);
  const http = new Browser();
  await signInAs(http, user, "/home");
  const welcome = await http.get("/welcome");
  await http.submit("/welcome", formWith(welcome.html, "handle"), { handle: `${prefix}_${randomBytes(5).toString("hex")}` });
  return user;
}

async function signedInPage(origin, user, viewport) {
  const page = await (await browser.newContext({ viewport, colorScheme: "dark" })).newPage();
  await page.goto(`${origin}/sign-in?next=${encodeURIComponent("/home")}`, { waitUntil: "networkidle" });
  await page.fill("#email", user.email);
  await page.fill("#password", user.password);
  await page.click('main button[type="submit"]');
  await page.waitForURL((u) => u.pathname === "/home");
  return page;
}

async function eventually(condition, ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await condition().catch(() => false)) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Each action counted; one that goes to another page waits for the new address (see app-collector-fast-add-checks.mjs). */
function actions(page, name) {
  let count = 0;
  let started = 0;
  const step = async (fn, navigates) => {
    if (!started) started = Date.now();
    count += 1;
    const before = page.url();
    await fn();
    if (navigates) await page.waitForURL((u) => u.href !== before, { timeout: 15000 });
    await page.waitForLoadState("networkidle");
  };
  return {
    type: (locator, text) => step(() => locator.fill(text), false),
    press: (key) => step(() => page.keyboard.press(key), true),
    click: (locator, navigates = true) => step(() => locator.click(), navigates),
    done() {
      const seconds = (Date.now() - started) / 1000;
      timings.push({ name, actions: count, seconds });
      return { count, seconds };
    },
  };
}

const addButton = (page) => page.locator("main").getByRole("button", { name: /^(Add to collection|Add another copy)$/ }).first();
const chip = (page, step, name) => page.getByRole("navigation", { name: step, exact: true }).getByRole("link", { name, exact: true }).first();
const firstResult = (page, title) => page.locator("main [data-game-card] h3 a:visible").filter({ hasText: title }).first();
const mainText = async (page) => (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
const confirmation = (page) => page.locator('main [role="status"]:visible');
async function waitForAdded(page, text = "Added") {
  await confirmation(page).filter({ hasText: text }).first().waitFor({ timeout: 15000 });
}
/** The collector's copies, as stored: the claimed platform, region and game title. */
const copiesOf = (userId) =>
  psql(`select p.slug || ':' || coalesce(c.claimed_region_code, 'not sure') || ':' || g.title from public.collection_items c
    join public.platforms p on p.id = c.claimed_platform_id join public.games g on g.id = c.claimed_game_id
    where c.owner_id = '${userId}' and c.release_id is null order by c.created_at, c.id;`).split("\n").filter(Boolean);

async function audit(page, name) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: axeSource });
  const found = await page.evaluate(async () => {
    const run = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
    return run.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.impact} ${v.id} ${String(v.nodes[0]?.target ?? "")}`);
  });
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
  const size = page.viewportSize()?.width === PHONE.width ? "phone" : "desktop";
  check(`${size} ${name}: no critical or serious axe findings`, found.length === 0, found.join("; "));
  check(`${size} ${name}: no sideways scrolling`, overflow.scroll <= overflow.view, `${overflow.scroll} > ${overflow.view}`);
}

const startingCatalog = footprint(psql, CATALOG_TABLES);

try {
  section("The catalog: hundreds of real games, on nine platforms, found by anyone");
  const published = Number(psql("select count(*) from public.games where status = 'published';"));
  check("at least 500 distinct real games are published in the demo", published >= 500, `${published}`);
  const rpc = async (fn, body) => (await fetch(`${api}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: publishableKey, Authorization: `Bearer ${publishableKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const platforms = await rpc("list_catalog_platforms", {});
  const counts = Object.fromEntries(DEMO_PLATFORMS.map((slug) => [slug, platforms.find((p) => p.slug === slug)?.game_count ?? 0]));
  check("every demo platform has at least 50 games anyone can browse", Object.values(counts).every((n) => n >= 50), JSON.stringify(counts));
  check("no release, barcode, edition or packaging was invented: the catalog records no release", psql("select count(*) from public.releases;") === "0");
  for (const [query, expected] of [["zelda", "The Legend of Zelda: Ocarina of Time"], ["mario kart", "Mario Kart 64"], ["sonic", "Sonic the Hedgehog"], ["final fantasy", "Final Fantasy VII"], ["pokemon", "Pokémon Yellow"], ["metal gear", "Metal Gear Solid"]]) {
    const found = await rpc("search_catalog", { p_query: query, p_platforms: null, p_limit: 50, p_cursor: null });
    check(`"${query}" finds ${expected}, among ${found.items?.length ?? 0}`, (found.items ?? []).some((i) => i.game?.title === expected));
  }
  // The source's other titles are the catalog's aliases: a regional, Japanese or alternate title finds the game.
  for (const [query, expected] of [["rockman x", "Mega Man X"], ["スーパーマリオワールド", "Super Mario World"], ["out of this world", "Another World"], ["the story of thor", "Beyond Oasis"]]) {
    const found = await rpc("search_catalog", { p_query: query, p_platforms: null, p_limit: 50, p_cursor: null });
    const hit = (found.items ?? []).find((i) => i.game?.title === expected);
    check(`another title, "${query}", finds ${expected}, saying which title matched`, Boolean(hit?.matched?.title), JSON.stringify(hit?.matched ?? null));
  }
  check("the source's other titles are kept as aliases", Number(psql("select count(*) from public.game_aliases;")) >= 1000);

  const origin = await startApp(3295);
  for (const channel of process.env.A11Y_BROWSER ? [process.env.A11Y_BROWSER] : ["msedge", "chrome"]) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // Try the next one.
    }
  }
  if (!browser) throw new Error("Needs Microsoft Edge or Google Chrome installed.");
  const alex = await collector("dma");
  const desk = await signedInPage(origin, alex, DESKTOP);

  section("Nintendo 64: a real game with no release recorded, added as the collector's own copy");
  {
    const act = actions(desk, "N64, Mario Kart 64, PAL");
    await desk.goto(`${origin}/explore?platform=nintendo-64`, { waitUntil: "networkidle" });
    check("the Nintendo 64 shelf of the catalog lists its games", (await desk.locator("main [data-game-card]:visible").count()) >= 20);
    await audit(desk, "platform browse");
    await act.type(desk.locator('main input[name="q"]:visible'), "mario kart 64");
    await act.press("Enter");
    await act.click(firstResult(desk, "Mario Kart 64"));
    check("its platform is chosen, and every region is one click away", await eventually(async () => (await chip(desk, "Region", "PAL").count()) === 1 && (await chip(desk, "Region", "Not sure").count()) === 1));
    check("nothing is offered as a release: the catalog has none", (await desk.locator("#add-release:visible").count()) === 0);
    await act.click(chip(desk, "Region", "PAL"));
    check("the edition starts as not sure, and says so", await eventually(async () => (await addButton(desk).count()) === 1 && (await mainText(desk)).includes("the catalog lists no edition here yet")));
    await audit(desk, "game page, ready to add");
    await act.click(addButton(desk), false);
    await waitForAdded(desk);
    const { count, seconds } = act.done();
    check("added: five actions from the search box (type, Enter, the result, PAL, Add)", count === 5, `${count} actions, ${seconds.toFixed(1)} s`);
    check("stored as the collector's own copy: Nintendo 64, PAL, no release, no edition", JSON.stringify(copiesOf(alex.id)) === JSON.stringify(["nintendo-64:pal:Mario Kart 64"]) &&
      psql(`select count(*) from public.collection_items where owner_id = '${alex.id}' and release_id is null and claimed_edition_kind is null and claimed_edition_name is null;`) === "1");
    check("the game's own copies show it at once", await eventually(async () => !(await desk.locator('aside[aria-label="Your collection"]:visible').innerText()).includes("Not in your collection yet")));
    const second = actions(desk, "a second copy");
    await second.click(addButton(desk), false);
    await waitForAdded(desk, "You now have 2 copies of this game");
    check("a second copy is one more click", second.done().count === 1);
  }

  section("The next Nintendo 64 game, from the confirmation");
  {
    const act = actions(desk, "N64, the next game, NTSC-U/C");
    await act.type(desk.getByRole("search", { name: "Next game" }).getByRole("searchbox"), "ocarina of time");
    await act.press("Enter");
    const result = firstResult(desk, "The Legend of Zelda: Ocarina of Time");
    check("the next game's search stays on the Nintendo 64", (await result.getAttribute("href"))?.endsWith("?platform=nintendo-64") === true);
    await act.click(result);
    await act.click(chip(desk, "Region", "NTSC-U/C"));
    await act.click(addButton(desk), false);
    await waitForAdded(desk);
    const { count } = act.done();
    check("added: five actions from the confirmation", count === 5, `${count} actions`);
    await confirmation(desk).getByRole("link", { name: "Your N64 shelf" }).click();
    await desk.waitForURL(/\/collection\/systems\/nintendo-64/);
    check("the Nintendo 64 shelf shows both games", await eventually(async () => (await mainText(desk)).includes("Mario Kart 64") && (await mainText(desk)).includes("Ocarina of Time")));
    await audit(desk, "Nintendo 64 shelf");
  }

  section("A game on three platforms: the collector picks theirs");
  {
    const act = actions(desk, "Sonic the Hedgehog, Mega Drive, from the header search");
    await desk.goto(`${origin}/home`, { waitUntil: "networkidle" });
    await act.type(desk.locator('header input[type="search"]'), "sonic the hedgehog");
    await act.press("Enter");
    await act.click(desk.locator("main [data-game-card] h3 a:visible").filter({ hasText: /^Sonic the Hedgehog$/ }).first());
    const platformChip = (name) => desk.getByRole("navigation", { name: "Platform", exact: true }).getByRole("link", { name: new RegExp(`^${name}\\b`) }).first();
    check(
      "its three platforms are offered, and none is chosen for the collector",
      (await eventually(async () => (await platformChip("Mega Drive").count()) === 1)) &&
        (await platformChip("PlayStation 2").count()) === 1 &&
        (await platformChip("Game Boy Advance").count()) === 1 &&
        (await desk.getByRole("navigation", { name: "Region", exact: true }).count()) === 0,
    );
    await act.click(platformChip("Mega Drive"));
    await act.click(chip(desk, "Region", "PAL"));
    await act.click(addButton(desk), false);
    await waitForAdded(desk);
    const { count } = act.done();
    check("added: six actions (type, Enter, the result, platform, region, Add)", count === 6, `${count} actions`);
    check("on the Mega Drive", copiesOf(alex.id).at(-1) === "mega-drive:pal:Sonic the Hedgehog");
  }

  section("On a phone: Game Boy, region not sure");
  {
    const phone = await signedInPage(origin, alex, PHONE);
    const act = actions(phone, "Game Boy, Pokémon Yellow, region not sure, on a phone");
    await phone.goto(`${origin}/explore?platform=game-boy`, { waitUntil: "networkidle" });
    await act.type(phone.locator('main input[name="q"]:visible'), "pokemon yellow");
    await act.press("Enter");
    await audit(phone, "search results");
    await act.click(firstResult(phone, "Pokémon Yellow"));
    const region = await phone.getByRole("navigation", { name: "Region", exact: true }).boundingBox();
    check("the region step is on the phone's first two screens", (region?.y ?? Infinity) < PHONE.height * 2, `at ${Math.round(region?.y ?? -1)} px`);
    await act.click(chip(phone, "Region", "Not sure"));
    await audit(phone, "game page, ready to add");
    await act.click(addButton(phone), false);
    await waitForAdded(phone);
    const { count } = act.done();
    check("added: five actions on a phone", count <= 6, `${count} actions`);
    check("on the Game Boy, region not sure", copiesOf(alex.id).at(-1) === "game-boy:not sure:Pokémon Yellow");
    await phone.goto(`${origin}/collection/systems`, { waitUntil: "networkidle" });
    const systems = await mainText(phone);
    check("the collection's systems list the Nintendo 64, the Mega Drive and the Game Boy", ["Nintendo 64", "Mega Drive", "Game Boy"].every((s) => systems.includes(s)));
    await audit(phone, "systems");
    await phone.context().close();
  }

  section("Another collector sees none of it");
  {
    const sam = await collector("dmb");
    const other = new Browser();
    await signInAs(other, sam, "/home");
    const shelf = await other.get("/collection/systems/nintendo-64");
    check("another collector's shelf is their own: no Mario Kart 64 copy", !shelf.html.includes("Mario Kart 64"));
  }
  await desk.context().close();
} catch (error) {
  check("the checks ran to the end", false, String(error.message).split("\n")[0]);
} finally {
  await browser?.close();
  stopApp();
  const ids = users.map((id) => `'${id}'`).join(",") || "null";
  psql(`delete from public.collection_items where owner_id in (${ids});`);
  const deleted = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and (handle like 'dma\\_%' or handle like 'dmb\\_%');");
  if (deleted.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${deleted.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${deleted.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  check("the demo catalog is exactly as it was: games, pairings, releases and titles", footprint(psql, CATALOG_TABLES) === startingCatalog);
}

console.log("\nActions and time per scenario (time includes every page load and save):");
for (const t of timings) console.log(`  ${t.name}: ${t.actions} actions, ${t.seconds.toFixed(1)} s`);
const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
