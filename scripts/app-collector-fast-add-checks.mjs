/**
 * Collector fast add, in a real browser with JavaScript (headless Edge or Chrome through
 * playwright-core, which downloads none): finding a physical game and adding it, copy after
 * copy and game after game, the way a collector adding a pile of games would. Each scenario
 * counts the collector's actions (typing a search counts as one, each key, click or scroll
 * as one) and times them, and checks the result in the database and on the pages the
 * collector sees next: the game's own copies, the platform's shelf and the collection.
 *
 * Scenarios, on fictional NES, SNES and PlayStation games (scripts/fixtures/
 * collector-fast-add-fixture.sql): one release; a region to choose; an edition to choose;
 * a game on two platforms; a second copy; the next game straight after; a barcode; a
 * product code typed with a space; "not sure"; optional details left out, then filled in;
 * keyboard only; a phone. Pages are audited with axe-core (WCAG 2.x A and AA; critical or
 * serious findings fail) at a phone width and a desktop width, with no sideways scrolling.
 *
 *   npm run build && MGD_TEST_STACK=scratch node scripts/test-stack.mjs run app:collector-fast-add-checks
 *
 * The scratch or test stack only, never the development stack or the pilot. Installs its
 * fixture, makes throwaway collectors, and removes all of it at the end; nothing it didn't
 * make is changed. Prints check names, counts and timings, never keys, tokens or cookies.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { chromium } from "playwright-core";

import { api, appErrorLines, Browser, check, createUser, deleteUsers, formWith, psql, publishableKey, readSession, results, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { footprint } from "./lib/footprint.mjs";
import { stackName } from "./lib/stack.mjs";

if (stackName !== "scratch" && stackName !== "test") {
  console.error("Refusing: run on the scratch or test stack.");
  process.exit(2);
}

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const LEFTOVER_TABLES = ["public.collection_items", "public.games", "public.releases", "public.collection_item_private", "private.collection_item_identity_events"];
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const users = [];
const timings = [];
let browser;

/** A collector's copies, as stored: the release's product code, or the claim's platform and region. */
const copiesOf = (userId) =>
  psql(`select coalesce(r.product_code, 'claim:' || p.slug || ':' || coalesce(c.claimed_region_code, 'not sure'))
    from public.collection_items c left join public.releases r on r.id = c.release_id left join public.platforms p on p.id = c.claimed_platform_id
    where c.owner_id = '${userId}' order by c.created_at, c.id;`)
    .split("\n")
    .filter(Boolean);

async function collector(prefix) {
  const user = await createUser({ prefix });
  users.push(user.id);
  const http = new Browser();
  await signInAs(http, user, "/home");
  const welcome = await http.get("/welcome");
  await http.submit("/welcome", formWith(welcome.html, "handle"), { handle: `${prefix}_${randomBytes(5).toString("hex")}` });
  return { ...user, http };
}

async function signedInPage(origin, user, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(`${origin}/sign-in?next=${encodeURIComponent("/home")}`, { waitUntil: "networkidle" });
  await page.fill("#email", user.email);
  await page.fill("#password", user.password);
  await page.click('main button[type="submit"]');
  await page.waitForURL((u) => u.pathname === "/home");
  return page;
}

/**
 * The collector's actions in one scenario: each counted, and the time from the first to the
 * last. An action that goes to another page (a search, a result, a step's choice) waits for
 * the new address and for everything it streams; Add stays on the page, and the scenario
 * waits for its confirmation.
 */
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
    press: (key, navigates = true) => step(() => page.keyboard.press(key), navigates),
    click: (locator, navigates = true) => step(() => locator.click(), navigates),
    done() {
      const seconds = (Date.now() - started) / 1000;
      timings.push({ name, actions: count, seconds });
      return { count, seconds };
    },
  };
}

/**
 * After moving between pages inside the app, Playwright's load states are already met, so
 * a condition on what the new page shows is polled until it holds (or 10 s pass).
 */
async function eventually(condition, ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await condition().catch(() => false)) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const mainText = async (page) => (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");

// Next.js keeps the page just left in the document, hidden, so going back is instant. Every
// locator here matches only what's shown: role locators skip hidden elements, and the rest
// say :visible.
const addButton = (page) => page.locator("main").getByRole("button", { name: /^(Add to collection|Add another copy)$/ }).first();
async function waitForAdded(page, text = "Added") {
  await page.locator('main [role="status"]:visible').filter({ hasText: text }).first().waitFor({ timeout: 15000 });
}
const yourCopies = async (page) => (await page.locator('aside[aria-label="Your collection"]:visible').innerText()).replace(/\s+/g, " ");
const chip = (page, step, name) => page.getByRole("navigation", { name: step, exact: true }).getByRole("link", { name, exact: false }).first();
const firstResult = (page, title) => page.locator("main ol a:visible").filter({ hasText: title }).first();
const mainSearch = (page) => page.locator('main input[name="q"]:visible');
const suggestions = (page) => page.locator("main p:visible").filter({ hasText: "Chosen for you" });
const addRelease = (page) => page.locator("#add-release:visible");
const confirmation = (page) => page.locator('main [role="status"]:visible');

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

const startingFootprint = footprint(psql, LEFTOVER_TABLES);

try {
  if (psql("select count(*) from auth.users where id = 'f1c5f1c5-0000-4000-8000-00000000c5c5';") !== "0") throw new Error("a catalog fixture is already installed: remove it first");
  installFixture("collector-fast-add-fixture.sql");
  const origin = await startApp(3296);
  for (const channel of process.env.A11Y_BROWSER ? [process.env.A11Y_BROWSER] : ["msedge", "chrome"]) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // Try the next one.
    }
  }
  if (!browser) throw new Error("Needs Microsoft Edge or Google Chrome installed.");

  const alex = await collector("cfa");
  const desk = await signedInPage(origin, alex, DESKTOP);

  section("NES, one release: search on the platform, and add with one click");
  {
    const act = actions(desk, "NES, one release");
    await desk.goto(`${origin}/explore?platform=nes`, { waitUntil: "networkidle" });
    await act.type(mainSearch(desk), "pixel knight");
    await act.press("Enter");
    const result = firstResult(desk, "Pixel Knight Saga");
    check("the result keeps the platform the search was filtered by", (await result.getAttribute("href")) === "/games/pixel-knight-saga?platform=nes");
    await act.click(result);
    check(
      "the game opens with its only release ready to add: nothing to choose",
      await eventually(async () => (await addButton(desk).count()) === 1 && (await addRelease(desk).innerText()).includes("NES · NTSC-U/C")),
      (await mainText(desk)).slice(0, 300),
    );
    check("the region and edition chosen for it say so, and how to change them", await eventually(async () => (await suggestions(desk).count()) === 2));
    const top = (await desk.locator("#choose-release").boundingBox())?.y ?? Infinity;
    check("adding is on the first screen, before the full list of releases", top < DESKTOP.height, `at ${Math.round(top)} px`);
    await audit(desk, "game page, release ready to add");
    await act.click(addButton(desk), false);
    await waitForAdded(desk);
    const { count, seconds } = act.done();
    check("added: four actions from the search box (type, Enter, the result, Add)", count === 4, `${count} actions, ${seconds.toFixed(1)} s`);
    check("the copy is that release, with no details invented", JSON.stringify(copiesOf(alex.id)) === JSON.stringify(["NES-PK-USA"]) &&
      psql(`select count(*) from public.collection_items where owner_id = '${alex.id}' and completeness is null and overall_condition is null;`) === "1" &&
      psql(`select count(*) from public.collection_item_private where owner_id = '${alex.id}' and coalesce(purchase_price::text, currency, notes, storage_location, acquired_on::text) is not null;`) === "0");
    check("the game's own copies show it at once, without reloading", await eventually(async () => !(await yourCopies(desk)).includes("Not in your collection yet") && (await yourCopies(desk)).includes("NES")));
    check("the confirmation links to the NES shelf and offers the next NES game's search", (await confirmation(desk).getByRole("link", { name: "Your NES shelf" }).count()) === 1 && (await desk.getByRole("search", { name: "Next game" }).count()) === 1);
    await audit(desk, "game page, just added");
  }

  section("The next NES game straight after, with a region to choose");
  {
    const act = actions(desk, "NES, the next game, a region to choose");
    await act.type(desk.getByRole("search", { name: "Next game" }).getByRole("searchbox"), "turbo bandit");
    await act.press("Enter");
    check("the next game's search stays on NES", new URL(desk.url()).searchParams.get("platform") === "nes" && new URL(desk.url()).searchParams.get("q") === "turbo bandit");
    await act.click(firstResult(desk, "Turbo Bandit"));
    const regions = await eventually(async () => (await chip(desk, "Region", "PAL").count()) === 1);
    check("two regions: nothing is chosen for the collector", regions && (await addButton(desk).count()) === 0 && (await suggestions(desk).count()) === 0, (await mainText(desk)).slice(0, 300));
    await act.click(chip(desk, "Region", "PAL"));
    check("PAL chosen: its only edition is chosen for them, labelled, and the release is ready", await eventually(async () => (await addButton(desk).count()) === 1 && (await suggestions(desk).count()) === 1));
    await act.click(addButton(desk), false);
    await waitForAdded(desk);
    const { count, seconds } = act.done();
    check("added: five actions from the last confirmation (type, Enter, the result, PAL, Add)", count === 5, `${count} actions, ${seconds.toFixed(1)} s`);
    check("the copy is the PAL release", copiesOf(alex.id).at(-1) === "NES-TB-EEC");
    await confirmation(desk).getByRole("link", { name: "Your NES shelf" }).click();
    await desk.waitForURL(/\/collection\/systems\/nes/);
    check("the NES shelf shows both games", await eventually(async () => (await mainText(desk)).includes("Pixel Knight Saga") && (await mainText(desk)).includes("Turbo Bandit")), (await mainText(desk)).slice(0, 300));
    await audit(desk, "NES shelf");
  }

  section("SNES: the header search, an edition, and two copies");
  {
    const act = actions(desk, "SNES, an edition, from the header search");
    await desk.goto(`${origin}/home`, { waitUntil: "networkidle" });
    await act.type(desk.locator('header input[type="search"]'), "aurora circuit");
    await act.press("Enter");
    await act.click(firstResult(desk, "Aurora Circuit"));
    check(
      "a game on one platform has it chosen; three regions are the collector's to pick",
      (await eventually(async () => (await chip(desk, "Region", "NTSC-U/C").count()) === 1)) && (await suggestions(desk).count()) === 0,
      (await mainText(desk)).slice(0, 300),
    );
    await act.click(chip(desk, "Region", "NTSC-U/C"));
    check("two North American editions: the collector picks one", (await eventually(async () => (await chip(desk, "Edition", "Player's Choice").count()) === 1)) && (await addButton(desk).count()) === 0);
    await act.click(chip(desk, "Edition", "Player's Choice"));
    await act.click(addButton(desk), false);
    await waitForAdded(desk);
    const { count, seconds } = act.done();
    check("added: six actions from the header search (type, Enter, the result, region, edition, Add)", count === 6, `${count} actions, ${seconds.toFixed(1)} s`);
    const second = actions(desk, "a second copy of the same release");
    await second.click(addButton(desk), false);
    await waitForAdded(desk, "You now have 2 copies of this release");
    check("a second copy is one more click, and the confirmation says there are two", second.done().count === 1);
    const ids = psql(`select count(distinct c.id) from public.collection_items c join public.releases r on r.id = c.release_id where c.owner_id = '${alex.id}' and r.product_code = 'SNS-AC-USA-PC';`);
    check("two separate copies of the Player's Choice release are stored", ids === "2");
    check("the game's own copies show both at once", await eventually(async () => (await yourCopies(desk)).includes("2 copies")), (await yourCopies(desk)).slice(0, 200));
  }

  section("Forgiving search");
  {
    await desk.goto(`${origin}/explore?q=${encodeURIComponent("aurora gp")}`, { waitUntil: "networkidle" });
    check("another title finds the game, and says which title matched", (await desk.locator("main ol").innerText()).includes("Also known as Aurora GP"));
    await desk.goto(`${origin}/explore?q=${encodeURIComponent("holow spire")}`, { waitUntil: "networkidle" });
    check("a spelling mistake still finds it", (await desk.locator("main ol").innerText()).includes("Hollow Spire"));
    await desk.goto(`${origin}/explore?q=${encodeURIComponent("slus 01999")}`, { waitUntil: "networkidle" });
    const text = await desk.locator("main").innerText();
    check("a product code typed with a space finds its release, and the page says how it read it", text.includes("Nothing matches “slus 01999” as typed") && text.includes("SLUS-01999") && text.includes("Hollow Spire"));
    await audit(desk, "search read another way");
    await desk.goto(`${origin}/explore?q=${encodeURIComponent("quasar zebra")}`, { waitUntil: "networkidle" });
    check(
      "a search that finds nothing offers to add the missing game",
      await eventually(async () => (await desk.locator("main").getByRole("link", { name: "Add it to My Game Dex" }).count()) >= 1),
      (await mainText(desk)).slice(-300),
    );
  }

  section("A game on two platforms, from a platform-filtered search");
  {
    const act = actions(desk, "PlayStation, a game on two platforms");
    await desk.goto(`${origin}/explore?platform=playstation`, { waitUntil: "networkidle" });
    await act.type(mainSearch(desk), "comet rally");
    await act.press("Enter");
    await act.click(firstResult(desk, "Comet Rally"));
    check("the filtered platform is chosen, and its only release is ready", await eventually(async () => (await addButton(desk).count()) === 1 && (await addRelease(desk).innerText()).includes("PS1")));
    await act.click(addButton(desk), false);
    await waitForAdded(desk);
    const { count } = act.done();
    check("added: four actions", count === 4, `${count} actions`);
    check("the copy is the PlayStation release, not the SNES one", copiesOf(alex.id).at(-1) === "SLUS-01888");
  }

  section("'Not sure' stays not sure");
  {
    await desk.goto(`${origin}/games/pixel-knight-saga?platform=nes&region=unsure`, { waitUntil: "networkidle" });
    check("with the region not sure, no release is offered and nothing is chosen for them", (await addRelease(desk).count()) === 0 && (await suggestions(desk).count()) === 0);
    await desk.goto(`${origin}/games/pixel-knight-saga?platform=nes&region=unsure&edition=unsure`, { waitUntil: "networkidle" });
    await addButton(desk).click();
    await waitForAdded(desk);
    check("the copy is added as the collector's own unidentified record, with the region not sure", copiesOf(alex.id).at(-1) === "claim:nes:not sure");
    check("and the confirmation still links to the NES shelf", (await confirmation(desk).getByRole("link", { name: "Your NES shelf" }).count()) === 1);
  }

  section("Keyboard only");
  {
    const keys = await signedInPage(origin, alex, DESKTOP);
    await keys.goto(`${origin}/explore?platform=snes`, { waitUntil: "networkidle" });
    // As a keyboard user would: the page's "Skip to content" link first, then Tab within the page.
    const presses = [];
    let keysPressed = 0;
    const press = async (key) => {
      await keys.keyboard.press(key);
      keysPressed += 1;
    };
    const tabTo = async (label, matches, limit = 80) => {
      let n = 0;
      while (n < limit && !(await keys.evaluate(matches))) {
        await press("Tab");
        n += 1;
      }
      presses.push(`${label} ${n}`);
      return keys.evaluate(matches);
    };
    const skip = async () => {
      const found = await tabTo("skip link", () => document.activeElement?.textContent?.trim() === "Skip to content", 3);
      if (found) await press("Enter");
      return found;
    };
    const skipped = [await skip()];
    const toSearch = await tabTo("to the search box", () => document.activeElement?.matches('main input[name="q"]') ?? false);
    await keys.keyboard.type("comet rally");
    await press("Enter");
    await keys.waitForURL(/q=comet/);
    // A person sees the results before moving on; focus is still in the search box.
    await eventually(async () => (await firstResult(keys, "Comet Rally").count()) === 1);
    const toResult = await tabTo("to the first result", () => document.activeElement?.matches("main ol a") ?? false);
    await press("Enter");
    await keys.waitForURL(/\/games\/comet-rally/);
    await eventually(async () => (await addButton(keys).count()) === 1);
    const toAdd = await tabTo("to Add", () => document.activeElement?.textContent?.trim() === "Add to collection", 20);
    await press("Enter");
    await waitForAdded(keys);
    check("the skip link, the search, the result and Add are each reached and used from the keyboard", skipped.every(Boolean) && toSearch && toResult && toAdd, presses.join(", "));
    check(
      "focus stays in the search box after searching, a few Tabs from the first result, and Add is a few Tabs into the game's page",
      (Number(/to the first result (\d+)/.exec(presses.join(","))?.[1]) ?? 99) <= 4 && (Number(/to Add (\d+)/.exec(presses.join(","))?.[1]) ?? 99) <= 15,
      presses.join(", "),
    );
    check("added from the keyboard: the SNES copy", copiesOf(alex.id).at(-1) === "SNS-CR-USA");
    const focusVisible = await keys.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== "none" || getComputedStyle(document.activeElement).boxShadow !== "none");
    check("focus stays visible on the control that was used", focusVisible);
    timings.push({ name: `keyboard only, SNES: ${keysPressed} key presses and the title typed (${presses.join(", ")})`, actions: keysPressed + 1, seconds: NaN });
    await keys.context().close();
  }

  section("A phone: a barcode, then details for another copy, which only the owner sees");
  {
    const phone = await signedInPage(origin, alex, PHONE);
    const act = actions(phone, "PlayStation by barcode, on a phone");
    await phone.goto(`${origin}/explore`, { waitUntil: "networkidle" });
    await act.type(mainSearch(phone), "0711719999901");
    await act.press("Enter");
    await audit(phone, "search results");
    await act.click(firstResult(phone, "Hollow Spire"));
    await eventually(async () => (await addButton(phone).count()) === 1);
    const button = await addButton(phone).boundingBox();
    check("the barcode's release is ready to add on the phone's first two screens", (button?.y ?? Infinity) < PHONE.height * 2, `Add at ${Math.round(button?.y ?? -1)} px`);
    if ((button?.y ?? 0) > PHONE.height) {
      // A person scrolls to it: one more action.
      await act.press("PageDown", false);
    }
    await audit(phone, "game page, release ready to add");
    await act.click(addButton(phone), false);
    await waitForAdded(phone);
    const { count, seconds } = act.done();
    check("added: four or five actions on a phone (type, Enter, the result, perhaps a scroll, Add)", count <= 5, `${count} actions, ${seconds.toFixed(1)} s`);
    check("the copy is the barcode's release", copiesOf(alex.id).at(-1) === "SLUS-01999");
    await audit(phone, "game page, just added");

    const details = actions(phone, "another copy with its details, on a phone");
    await details.click(phone.locator("main summary").filter({ hasText: "More details" }).first(), false);
    await phone.selectOption("#completeness", "complete");
    await phone.selectOption("#overall_condition", "very_good");
    await phone.fill("#purchase_price", "12.50");
    await phone.selectOption("#currency", "EUR");
    await details.click(addButton(phone), false);
    await waitForAdded(phone, "You now have 2 copies of this release");
    details.done();
    const stored = psql(`select c.completeness || '/' || c.overall_condition || '/' || p.purchase_price::numeric(10,2) || '/' || p.currency
      from public.collection_items c join public.collection_item_private p on p.item_id = c.id
      where c.owner_id = '${alex.id}' and p.purchase_price is not null;`);
    check("the details are stored with that copy only", stored === "complete/very_good/12.50/EUR", stored);
    const blank = psql(`select count(*) from public.collection_items c join public.releases r on r.id = c.release_id where c.owner_id = '${alex.id}' and r.product_code = 'SLUS-01999' and c.completeness is null;`);
    check("the first copy keeps nothing recorded: details are optional and can come later", blank === "1");

    // Another collector reads through the API with their own session: purchase data is the owner's alone.
    const sam = await collector("cfb");
    const token = readSession(sam.http)?.session?.access_token;
    const priced = psql(`select p.item_id from public.collection_item_private p where p.owner_id = '${alex.id}' and p.purchase_price is not null;`);
    const read = await fetch(`${api}/rest/v1/rpc/get_my_collection_item`, {
      method: "POST",
      headers: { apikey: publishableKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_item: priced }),
    });
    const body = await read.text();
    const direct = await fetch(`${api}/rest/v1/collection_items?select=id&id=eq.${priced}`, { headers: { apikey: publishableKey, Authorization: `Bearer ${token}` } });
    check("another collector can't read the copy's price paid, or the copy itself", !body.includes("12.5") && !body.includes("EUR") && (await direct.text()) === "[]", `${read.status}`);

    await phone.goto(`${origin}/collection/systems/playstation`, { waitUntil: "networkidle" });
    const shelf = await phone.locator("main").innerText();
    check("the PlayStation shelf shows Hollow Spire and Comet Rally", shelf.includes("Hollow Spire") && shelf.includes("Comet Rally"));
    await audit(phone, "PlayStation shelf");
    await phone.goto(`${origin}/collection`, { waitUntil: "networkidle" });
    const list = await phone.locator("main").innerText();
    check("the collection lists every game added", ["Pixel Knight Saga", "Turbo Bandit", "Aurora Circuit", "Comet Rally", "Hollow Spire"].every((t) => list.includes(t)));
    await audit(phone, "collection");
    await phone.context().close();
  }

  check("every copy added is a physical copy of a published release, or the collector's own unidentified record", psql(`select count(*) from public.collection_items c
    left join public.releases r on r.id = c.release_id
    where c.owner_id = '${alex.id}' and not ((c.release_id is not null and r.status = 'published') or (c.release_id is null and c.claimed_platform_id is not null));`) === "0");
  check("nothing in the catalog was changed by adding", psql("select count(*) from public.releases where status <> 'published';") === "0" && psql(`select count(*) from public.games where submitted_by = '${alex.id}';`) === "0");
  await desk.context().close();
} catch (error) {
  check("the checks ran to the end", false, error.message.split("\n")[0]);
} finally {
  await browser?.close();
  stopApp();
  const ids = users.map((id) => `'${id}'`).join(",") || "null";
  psql(`delete from public.collection_items where owner_id in (${ids});`);
  const deleted = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and (handle like 'cfa\\_%' or handle like 'cfb\\_%');");
  if (deleted.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${deleted.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${deleted.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  removeFixture();
  check("no copies, details, history or catalog data are left behind", footprint(psql, LEFTOVER_TABLES) === startingFootprint);
}

console.log("\nActions and time per scenario (time includes every page load and save):");
for (const t of timings) console.log(`  ${t.name}: ${t.actions} actions${Number.isNaN(t.seconds) ? "" : `, ${t.seconds.toFixed(1)} s`}`);
const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
