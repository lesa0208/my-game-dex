/**
 * Physical Releases 2.0 (Phase 4A): the release cards on a game's Physical Releases tab, in a
 * real browser (headless Edge or Chrome through playwright-core), against a SYNTHETIC catalog
 * (scripts/fixtures/physical-releases-fixture.sql): fictional "Fixture" games whose releases
 * cover SNES in three regions with editions and variants, NES and Famicom, Mega Drive and
 * Genesis, PlayStation on three discs, Saturn, an unknown region, a release with almost
 * nothing recorded and a format with no drawn shell.
 *
 * Checks that each card shows exactly what the catalog records, in its place, and nothing it
 * doesn't; that its picture is the system's neutral shell (or a plain shape), never a generated
 * label, an IGDB cover or another release's photo; the collector's read-only relation to each
 * release; and accessibility (axe-core, WCAG 2.x A and AA, at phone, tablet and desktop widths,
 * no sideways scrolling, keyboard use of More details, 44 px phone targets). With
 * PR_SCREENSHOTS=<folder>, it also takes the review screenshots, captioned as synthetic.
 *
 *   npm run build && MGD_STACK=scratch npm run app:physical-releases-checks
 *
 * The scratch stack only: refuses any other. Installs its fixture and a throwaway collector,
 * and removes all of it at the end, then checks nothing is left behind. Never publishes
 * anything outside scratch. Prints check names and statuses, never keys, tokens or cookies.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { chromium } from "playwright-core";

import { api, appErrorLines, Browser, check, createUser, deleteUsers, formWith, psql, publishableKey, readSession, results, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { footprint } from "./lib/footprint.mjs";
import { stackName } from "./lib/stack.mjs";

if (stackName !== "scratch") {
  console.error("Refusing: the synthetic physical-release fixture is for the scratch stack only (MGD_STACK=scratch).");
  process.exit(2);
}

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const LEFTOVER_TABLES = ["public.collection_items", "public.games", "public.releases", "public.release_markets", "public.release_components", "public.collection_item_private", "private.collection_item_identity_events"];
const SIZES = { desktop: { width: 1440, height: 1000 }, tablet: { width: 820, height: 1180 }, phone: { width: 390, height: 844 }, small: { width: 320, height: 640 } };
const SHOTS = process.env.PR_SCREENSHOTS || null;
const GAMES = { vale: "fixture-quest-lantern-vale", turbo: "fixture-racer-turbo", tower: "fixture-chronicle-glass-tower", loose: "fixture-loose-ends" };
const users = [];
let browser;

function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A fixture release's id, by its (fictional) product code and variant. */
const releaseId = (code, variant = null) =>
  psql(`select id from public.releases where product_code = '${code}' and variant_name ${variant ? `= '${variant}'` : "is null"} and status = 'published' limit 1;`);

async function collector(prefix) {
  const user = await createUser({ prefix });
  users.push(user.id);
  const http = new Browser();
  await signInAs(http, user, "/home");
  const welcome = await http.get("/welcome");
  await http.submit("/welcome", formWith(welcome.html, "handle"), { handle: `${prefix}_${randomBytes(5).toString("hex")}` });
  return { ...user, http };
}

async function rpc(owner, name, body) {
  const { session } = readSession(owner.http);
  const response = await fetch(`${api}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${name} failed: ${json.message}`);
  return json;
}

async function page(viewport, user = null) {
  const context = await browser.newContext({ viewport, colorScheme: "dark", deviceScaleFactor: SHOTS ? 2 : 1 });
  const p = await context.newPage();
  if (user) {
    await p.goto(`${origin}/sign-in?next=${encodeURIComponent("/home")}`, { waitUntil: "networkidle" });
    await p.fill("#email", user.email);
    await p.fill("#password", user.password);
    await p.click('main button[type="submit"]');
    await p.waitForURL((u) => u.pathname === "/home");
  }
  return p;
}

/** A game's Physical Releases tab, every image loaded. */
async function releasesTab(p, slug) {
  await p.goto(`${origin}/games/${slug}#releases`, { waitUntil: "networkidle" });
  await p.locator("[data-physical-releases]:visible").first().waitFor();
  // The shells below the fold load lazily: load them now, for the checks and full-page screenshots.
  await p.evaluate(() => document.querySelectorAll("[data-release-media] img[loading=lazy]").forEach((i) => (i.loading = "eager")));
  await p.waitForFunction(() => [...document.querySelectorAll("[data-release-media] img")].every((i) => i.complete && i.naturalWidth > 0));
}

const card = (p, id) => p.locator(`[data-release-card="${id}"]:visible`);

/** A card's facts as { label: value }, from its own list or its More details. */
async function facts(p, id, where = "[data-release-facts]") {
  return card(p, id)
    .locator(`${where} [data-fact]`)
    .evaluateAll((rows) => Object.fromEntries(rows.map((r) => [r.querySelector("dt").textContent.trim(), r.querySelector("dd").textContent.trim()])));
}
const more = (p, id) => facts(p, id, "[data-release-more]");
/** The product code shown under the card's heading, or null. */
const code = async (p, id) => {
  const el = card(p, id).locator("[data-release-product-code]");
  return (await el.count()) ? (await el.locator("span").nth(1).innerText()).trim() : null;
};
const media = (p, id) => card(p, id).locator("[data-release-media]").getAttribute("data-release-media");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function audit(p, name) {
  if (!(await p.evaluate(() => Boolean(window.axe)))) await p.addScriptTag({ content: axeSource });
  const found = await p.evaluate(async () => {
    const run = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
    return run.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.impact} ${v.id} ${String(v.nodes[0]?.target ?? "")}`);
  });
  const overflow = await p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
  const width = p.viewportSize()?.width;
  check(`${width}px ${name}: no critical or serious axe findings`, found.length === 0, found.join("; "));
  check(`${width}px ${name}: no sideways scrolling`, overflow.scroll <= overflow.view, `${overflow.scroll} > ${overflow.view}`);
}

/**
 * A review screenshot, captioned in the picture itself as synthetic: an element (the caption
 * placed inside it, at its top), the whole page, or the viewport scrolled to a part of it.
 */
async function shot(p, file, { element = null, scrollTo = null, full = false } = {}) {
  if (!SHOTS) return;
  const caption = "SYNTHETIC FIXTURE: fictional test data on the scratch stack, not real releases";
  const style = { padding: "4px 8px", background: "#facc15", color: "#111", font: "600 12px/1.4 system-ui", textAlign: "center", borderRadius: "6px", margin: "0 0 8px" };
  const path = join(SHOTS, file);
  await p.evaluate(() => document.querySelectorAll("[data-synthetic-caption]").forEach((el) => el.remove()));
  // The resting state: no focus ring left from the last click or key.
  await p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  if (element) {
    // A list is captured with its section, the caption above it (never as one of its items).
    if (await element.evaluate((el) => el.tagName === "UL")) element = element.locator("xpath=..");
    await element.evaluate((el, [text, css]) => {
      const tag = document.createElement("div");
      tag.setAttribute("data-synthetic-caption", "");
      tag.textContent = text;
      Object.assign(tag.style, css);
      el.prepend(tag);
    }, [caption, style]);
    await element.scrollIntoViewIfNeeded();
    await element.screenshot({ path });
    await p.evaluate(() => document.querySelectorAll("[data-synthetic-caption]").forEach((el) => el.remove()));
    return;
  }
  await p.evaluate(([text, css, inTab]) => {
    const tag = document.createElement("div");
    tag.setAttribute("data-synthetic-caption", "");
    tag.textContent = text;
    Object.assign(tag.style, css);
    // In the page's flow, never over a control: at the top of the releases tab, or of the page.
    const host = inTab ? [...document.querySelectorAll("[data-physical-releases]")].find((el) => el.getClientRects().length) : document.querySelector("main");
    host?.prepend(tag);
  }, [caption, style, !full]);
  if (scrollTo) {
    await scrollTo.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await p.evaluate(() => window.scrollBy(0, -72));
    await p.waitForTimeout(200);
  }
  await p.screenshot({ path, fullPage: full });
  await p.evaluate(() => document.querySelectorAll("[data-synthetic-caption]").forEach((el) => el.remove()));
}

let origin;
const startingFootprint = footprint(psql, LEFTOVER_TABLES);

try {
  if (psql("select count(*) from auth.users where id = 'f1c5f1c5-0000-4000-8000-00000000c5c5';") !== "0") throw new Error("a catalog fixture is already installed: remove it first");
  installFixture("physical-releases-fixture.sql");
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  origin = await startApp(3297);
  for (const channel of process.env.A11Y_BROWSER ? [process.env.A11Y_BROWSER] : ["msedge", "chrome"]) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // Try the next one.
    }
  }
  if (!browser) throw new Error("Needs Microsoft Edge or Google Chrome installed.");

  const ids = {
    us: releaseId("SNS-ZZLV-USA"),
    nfr: releaseId("SNS-ZZLV-USA", "Not for Resale"),
    pc: releaseId("SNS-ZZLV-USA-1"),
    ce: releaseId("SNS-ZZLV-USA-CE"),
    eu: releaseId("SNSP-ZZLV-EUR"),
    ukv: releaseId("SNSP-ZZLV-UKV", "UKV"),
    jp: releaseId("SHVC-ZZLV"),
    nesUs: releaseId("NES-ZZ-USA"),
    nesEu: releaseId("NES-ZZ-EEC"),
    fc: releaseId("HVC-ZZ"),
    gen: releaseId("MK-ZZ01"),
    mdEu: releaseId("MK-ZZ01-50"),
    mdJp: releaseId("G-ZZ01"),
    psUs: releaseId("SLUS-90001"),
    psGh: releaseId("SLUS-90001GH"),
    psEu: releaseId("SLES-90001"),
    psJp: releaseId("SLPS-90001"),
    saturn: releaseId("T-ZZ001G"),
    ps2: psql("select r.id from public.releases r join public.platforms p on p.id = r.platform_id where p.slug = 'playstation-2' and r.status = 'published' limit 1;"),
    gb: releaseId("DMG-ZZ-USA"),
  };
  check("the synthetic fixture is installed on scratch: 20 published releases of 4 Fixture games", Object.values(ids).every(Boolean) && psql("select count(*) from public.releases where status = 'published';") === "20" && psql("select count(*) from public.games where title not like 'Fixture %';") === "0");

  const desk = await page(SIZES.desktop);

  section("1. SNES: one card per regional release, each with its own shell");
  {
    await releasesTab(desk, GAMES.vale);
    const group = desk.locator('[data-release-group="snes"]:visible');
    check("the SNES group lists all 7 releases, each its own card, none merged", (await group.locator("[data-release-card]").count()) === 7);
    check("headings nest: Physical releases (h2), the platform (h3), each release (h4)", (await desk.getByRole("heading", { level: 2, name: "Physical releases" }).count()) === 1 && (await group.getByRole("heading", { level: 3 }).innerText()).startsWith("Super Nintendo") && (await group.getByRole("heading", { level: 4 }).count()) === 7);
    check("each card is named by its platform and region", (await card(desk, ids.us).getAttribute("aria-labelledby")) && (await card(desk, ids.us).getByRole("heading", { level: 4 }).innerText()).replace(/\s+/g, " ") === "SNES NTSC-U/C");
    check("regions as recorded: NTSC-U/C, PAL and NTSC-J cards", (await card(desk, ids.eu).getByRole("heading").innerText()).includes("PAL") && (await card(desk, ids.jp).getByRole("heading").innerText()).includes("NTSC-J"));
    check("North America: the neutral North American Game Pak; Europe and Japan: the PAL / Super Famicom cartridge", (await media(desk, ids.us)) === "shell:snes-cart:NTSC-U" && (await media(desk, ids.eu)) === "shell:snes-cart:PAL" && (await media(desk, ids.jp)) === "shell:snes-cart:NTSC-J");
    const usFacts = await facts(desk, ids.us);
    check(
      "the North American card's facts, exactly as recorded and in order",
      same(usFacts, { Format: "North American SNES Game Pak", Packaging: "Cardboard box", Barcode: "2000000000015", Released: "November 18, 1994", Publisher: "Placeholder Interactive" }),
      JSON.stringify(usFacts),
    );
    check("its product code stands under the heading, labelled", (await code(desk, ids.us)) === "SNS-ZZLV-USA" && (await card(desk, ids.us).locator("[data-release-product-code]").innerText()).replace(/\s+/g, " ") === "Product code SNS-ZZLV-USA");
    check("the physical object is a real part of the card: its stage is at least 160 px wide on desktop", (await card(desk, ids.us).locator("[data-release-media]").evaluate((el) => el.getBoundingClientRect().width)) >= 160);
    const usMore = await more(desk, ids.us);
    check(
      "its More details: markets, language, contents and rating, as recorded",
      usMore["Sold in"]?.split(", ").sort().join(", ") === "Canada, United States" && usMore.Languages === "English" && usMore.Includes?.split(", ").sort().join(", ") === "Fold-out world map, Instruction manual" && usMore["Age ratings"] === "Fixture rating: All ages" && !("Requires" in usMore),
      JSON.stringify(usMore),
    );
    check("More details starts closed and opens with the keyboard", !(await card(desk, ids.us).locator("details").evaluate((d) => d.open)) && (await (async () => {
      await card(desk, ids.us).locator("summary").focus();
      await desk.keyboard.press("Enter");
      return card(desk, ids.us).locator("details").evaluate((d) => d.open);
    })()));
    const euFacts = await facts(desk, ids.eu);
    check("the PAL card: its own format, code, barcode, date and publisher", same(euFacts, { Format: "Super Famicom / PAL SNES Cartridge", Packaging: "Cardboard box", Barcode: "2000000000039", Released: "March 23, 1995", Publisher: "Placeholder Interactive Europe" }) && (await code(desk, ids.eu)) === "SNSP-ZZLV-EUR", JSON.stringify(euFacts));
    check("the PAL card's languages: English, German, French", (await more(desk, ids.eu)).Languages === "English, German, French");
    check("the Japanese card: the title on the box, and the date to the month only", (await card(desk, ids.jp).locator("[data-release-local-title]").innerText()) === "Title on the box: フィクスチャー・クエスト" && (await facts(desk, ids.jp)).Released === "August 1994");
    check("no card has a barcode, date or publisher it doesn't record", !("Barcode" in (await facts(desk, ids.jp))) && !("Released" in (await facts(desk, ids.nfr))) && !("Barcode" in (await facts(desk, ids.ukv))));
    await shot(desk, "01-snes-regional-cards-desktop.png", { element: card(desk, ids.us).locator("xpath=ancestor::ul[1]") });
  }

  section("2. SNES: editions and variants");
  {
    check("no Standard Edition label is invented: no edition chip on the standard North American card, and no card says Standard", !/\bStandard\b/.test(await desk.locator('[data-release-group="snes"]:visible').innerText()) && (await card(desk, ids.us).locator("[data-release-edition]").count()) === 0 && (await card(desk, ids.us).locator("[data-release-variant]").count()) === 0);
    check("a reprint: Player's Choice (Reprint)", (await card(desk, ids.pc).locator("[data-release-edition]").innerText()) === "Player's Choice (Reprint)");
    check("a collector's edition by its name", (await card(desk, ids.ce).locator("[data-release-edition]").innerText()) === "Collector's Edition");
    check("its extras under More details", (await more(desk, ids.ce)).Includes?.split(", ").sort().join(", ") === "Art print, Cloth map, Instruction manual");
    check("variants of the standard edition: Not for Resale, and UKV", (await card(desk, ids.nfr).locator("[data-release-variant]").innerText()) === "Variant: Not for Resale" && (await card(desk, ids.ukv).locator("[data-release-variant]").innerText()) === "Variant: UKV");
    check("a variant shares its product code but stays its own card", (await code(desk, ids.nfr)) === "SNS-ZZLV-USA" && ids.nfr !== ids.us);
    check("the edition and variant are a labelled list", (await card(desk, ids.pc).getByRole("list", { name: "Edition and variant" }).count()) === 1);
    await shot(desk, "02b-snes-collectors-edition-card-desktop.png", { element: card(desk, ids.ce) });
    await shot(desk, "02c-snes-variant-card-desktop.png", { element: card(desk, ids.nfr) });
    await card(desk, ids.ce).locator("summary").click();
    await shot(desk, "02-snes-editions-variants-desktop.png", { element: desk.locator('[data-release-group="snes"]:visible') });
  }

  section("3. NES and Famicom, Mega Drive and Genesis: cartridge formats");
  {
    await releasesTab(desk, GAMES.turbo);
    check("NES Game Paks in North America and Europe: the NES shell", (await media(desk, ids.nesUs)) === "shell:nes-cart:NTSC-U" && (await media(desk, ids.nesEu)) === "shell:nes-cart:NTSC-U");
    check("the Famicom cartridge: no drawn shell, so a plain neutral shape, never the NES one", (await media(desk, ids.fc)) === "placeholder" && (await facts(desk, ids.fc)).Format === "Famicom Cartridge");
    check("Genesis and PAL Mega Drive: the Mega Drive shell", (await media(desk, ids.gen)) === "shell:md-cart:NTSC-U" && (await media(desk, ids.mdEu)) === "shell:md-cart:NTSC-U");
    check("the Japanese Mega Drive cartridge: a plain shape, its shell isn't drawn", (await media(desk, ids.mdJp)) === "placeholder");
    check("Mega Drive packaging as recorded: Plastic case", (await facts(desk, ids.gen)).Packaging === "Plastic case" && (await code(desk, ids.gen)) === "MK-ZZ01");
    check("the date at its recorded precision: 1991, June 1990, December 1989", (await facts(desk, ids.gen)).Released === "1991" && (await facts(desk, ids.nesUs)).Released === "June 1990" && (await facts(desk, ids.fc)).Released === "December 1989");
    check("a card with little recorded says only that: the PAL NES card", same(await facts(desk, ids.nesEu), { Format: "NES Game Pak", Packaging: "Cardboard box" }) && (await code(desk, ids.nesEu)) === "NES-ZZ-EEC");
    await shot(desk, "03-nes-mega-drive-cartridges-desktop.png", { element: desk.locator("[data-physical-releases]:visible") });
  }

  section("4. PlayStation: disc case and three discs; Saturn");
  {
    await releasesTab(desk, GAMES.tower);
    check("PlayStation: the neutral jewel case", (await media(desk, ids.psUs)) === "shell:ps1-case:NTSC-U" && (await media(desk, ids.psEu)) === "shell:ps1-case:NTSC-U");
    const psFacts = await facts(desk, ids.psUs);
    check("three discs and their case, as recorded: 3 × CD-ROM, Double-depth jewel case", psFacts.Format === "3 × CD-ROM" && psFacts.Packaging === "Double-depth jewel case" && (await code(desk, ids.psUs)) === "SLUS-90001" && psFacts.Released === "September 8, 1998", JSON.stringify(psFacts));
    const psMore = await more(desk, ids.psUs);
    check("its contents: one manual, three disc booklets", psMore.Includes?.split(", ").sort().join(", ") === "3 × Disc booklet, Instruction manual", JSON.stringify(psMore));
    check("Greatest Hits is its own card, as a reprint", (await card(desk, ids.psGh).locator("[data-release-edition]").innerText()) === "Greatest Hits (Reprint)");
    check("Europe: five languages", (await more(desk, ids.psEu)).Languages === "English, German, French, Spanish, Italian");
    const saturn = { media: await media(desk, ids.saturn), facts: await facts(desk, ids.saturn), more: await more(desk, ids.saturn) };
    check("Saturn: the Saturn case, two discs, and the 4 MB RAM cartridge it needs", saturn.media === "shell:saturn-case:NTSC-J" && saturn.facts.Format === "2 × CD-ROM" && saturn.more.Requires === "4 MB RAM cartridge", JSON.stringify(saturn));
    await card(desk, ids.psUs).locator("summary").click();
    await shot(desk, "04b-playstation-multi-disc-card-desktop.png", { element: card(desk, ids.psUs) });
    await shot(desk, "04-playstation-multi-disc-desktop.png", { element: desk.locator('[data-release-group="playstation"]:visible') });
  }

  section("5 and 6. Unknown region, incomplete records, no drawn shell; no photo anywhere");
  {
    await releasesTab(desk, GAMES.loose);
    check("an unknown region says so: Region unknown", (await card(desk, ids.ps2).getByRole("heading").innerText()).includes("Region unknown"));
    check("a format with no drawn shell (a PlayStation 2 DVD): a plain shape", (await media(desk, ids.ps2)) === "placeholder");
    check("only what's recorded: the format, and packaging Unknown as an editor recorded it; no product code", same(await facts(desk, ids.ps2), { Format: "DVD-ROM", Packaging: "Unknown" }) && (await code(desk, ids.ps2)) === null);
    check("nothing else is shown or invented: no More details, no edition or variant", (await card(desk, ids.ps2).locator("[data-release-more]").count()) === 0 && (await card(desk, ids.ps2).locator("[data-release-edition], [data-release-variant]").count()) === 0);
    check("the Game Boy card: the Game Boy shell and its product code", (await media(desk, ids.gb)) === "shell:gb-cart:NTSC-U" && (await code(desk, ids.gb)) === "DMG-ZZ-USA");
    await shot(desk, "06-release-without-artwork-desktop.png", { element: desk.locator("[data-physical-releases]:visible") });
  }

  section("Artwork: neutral shells only; no generated labels, IGDB images or stand-in photos");
  {
    for (const slug of Object.values(GAMES)) {
      await releasesTab(desk, slug);
      const tab = desk.locator("[data-physical-releases]:visible");
      const shells = await tab.locator("[data-release-media]").evaluateAll((els) =>
        els.map((el) => ({ kind: el.getAttribute("data-release-media"), text: el.textContent.trim(), igdb: [...el.querySelectorAll("img")].some((i) => /igdb/i.test(i.currentSrc || i.src)), hidden: el.getAttribute("aria-hidden") })),
      );
      check(`${slug}: every picture is a neutral shell or plain shape, with no words on it`, shells.length > 0 && shells.every((s) => (s.kind.startsWith("shell:") || s.kind === "placeholder") && s.text === "" && s.hidden === "true"));
      check(`${slug}: no generated label art and no IGDB image on any card`, (await tab.locator("[data-media], [data-label-art]").count()) === 0 && shells.every((s) => !s.igdb));
      check(`${slug}: the tab says once that a release without an approved photo is drawn plain`, (await tab.locator("[data-releases-media-note]").count()) === 1);
    }
    check("the approved-image registry has no photo for any fixture release: no photo slot is shown (test image deferred)", (await desk.locator("[data-release-media^='photo:'], [data-release-photo-credit]").count()) === 0);
  }

  section("The collector's relation to each release, read only");
  {
    await releasesTab(desk, GAMES.vale);
    check("signed out: no ownership on any card, and no unidentified-copy note", (await desk.locator("[data-release-owned], [data-platform-unidentified]").count()) === 0);
    const alex = await collector("prc");
    for (let i = 0; i < 2; i += 1) await rpc(alex, "add_collection_item", { p_item_id: uuidv7(), p_release: ids.us, p_details: {} });
    await rpc(alex, "add_unidentified_copy", {
      p_item_id: uuidv7(),
      p_game: psql(`select id from public.games where slug = '${GAMES.vale}';`),
      p_platform: psql("select id from public.platforms where slug = 'snes';"),
      p_region: null,
      p_edition_kind: null,
      p_edition_name: null,
    });
    const before = footprint(psql, ["public.collection_items", "private.collection_item_identity_events"]);
    const mine = await page(SIZES.desktop, alex);
    await releasesTab(mine, GAMES.vale);
    await mine.locator("[data-release-owned]").first().waitFor();
    check("the North American card says You own 2 of this release", (await card(mine, ids.us).locator("[data-release-owned]").getAttribute("data-release-owned")) === "2" && (await card(mine, ids.us).locator("[data-release-owned]").evaluate((a) => [...a.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim())) === "You own 2 of this release");
    check("no other card claims a copy", (await mine.locator("[data-release-owned]:visible").count()) === 1);
    check("its accessible name says they're copies linked to this exact release, and where to see them", /You own 2 of this release: copies linked to this exact release\. See My Copies/.test((await card(mine, ids.us).locator("[data-release-owned]").evaluate((a) => a.textContent)).replace(/\s+/g, " ")));
    check("the SNES group notes the copy whose exact release isn't identified, without assigning it", (await mine.locator('[data-release-group="snes"] [data-platform-unidentified]').getAttribute("data-platform-unidentified")) === "1" && (await mine.locator("[data-platform-unidentified]").innerText()).includes("1 of your copies on SNES isn't linked to a release yet (exact release not identified), so no card below counts it."));
    check("each card's add action is worded for the collector: Add to collection", (await card(mine, ids.us).locator("[data-release-add]").evaluate((a) => [...a.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim())) === "Add to collection" && (await card(mine, ids.us).getByRole("link", { name: /^Add to collection ?, a copy of this release: SNES, NTSC-U\/C$/ }).count()) === 1);
    check("Want this release stays a separate action beside it", (await card(mine, ids.us).getByRole("button", { name: /^Want this release: / }).count()) === 1);
    check("Add to collection still opens the add steps with this release chosen (no new write path)", new URL(await card(mine, ids.us).locator("[data-release-add]").getAttribute("href"), origin).searchParams.get("release") === ids.us);
    // The desktop grid as a person sees it (a full-page capture repeats the sticky header mid-page).
    await mine.setViewportSize({ width: 1440, height: 1800 });
    await shot(mine, "07-desktop-signed-in-1440.png", { scrollTo: mine.locator("[data-physical-releases]:visible") });
    await mine.setViewportSize(SIZES.desktop);
    await card(mine, ids.us).locator("[data-release-owned]").click();
    check("You own 2 opens the My Copies tab", await mine.waitForFunction(() => location.hash === "#my-copies" && document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes("My Copies"), null, { timeout: 5000 }).then(() => true, async () => false), await mine.evaluate(() => location.hash + " " + document.querySelector('[role="tab"][aria-selected="true"]')?.textContent));
    check("viewing changed no copy: nothing written to the collection or its history", footprint(psql, ["public.collection_items", "private.collection_item_identity_events"]) === before);
    await audit(mine, "signed in, Physical Releases");

    // Tablet and phones, signed in: one column, every target reachable.
    for (const [name, size] of [["tablet", SIZES.tablet], ["phone", SIZES.phone], ["small", SIZES.small]]) {
      const p = await page(size, alex);
      await releasesTab(p, GAMES.vale);
      await p.locator("[data-release-owned]").first().waitFor();
      const columns = await p.locator('[data-release-group="snes"] ul').first().evaluate((ul) => getComputedStyle(ul).gridTemplateColumns.split(" ").length);
      check(`${size.width}px: the cards are one column`, columns === 1);
      if (name !== "tablet") {
        const heights = await p.locator('[data-release-card] [data-release-add]:visible, [data-release-card] summary:visible, [data-release-actions] button:visible').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
        check(`${size.width}px: Add to collection, Want this release and More details are at least 44 px tall`, heights.length > 0 && heights.every((h) => h >= 44));
        check(`${size.width}px: Add to collection is shown on phones, named for its release`, (await card(p, ids.ukv).getByRole("link", { name: /^Add to collection ?, a copy of this release: SNES, PAL, UKV$/ }).isVisible()));
        // Scrolled to the very end, the fixed bottom navigation covers none of the last card.
        await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await p.waitForTimeout(300);
        const clear = await p.evaluate(() => {
          const nav = [...document.querySelectorAll("nav")].find((n) => getComputedStyle(n).position === "fixed" && n.getClientRects().length && n.getBoundingClientRect().bottom >= innerHeight - 1);
          const last = [...document.querySelectorAll("[data-release-card]")].filter((c) => c.getClientRects().length).at(-1)?.getBoundingClientRect();
          return nav && last ? Math.round(nav.getBoundingClientRect().top - last.bottom) : null;
        });
        check(`${size.width}px: at the end of the list, the bottom navigation doesn't cover the last card`, clear !== null && clear >= 0, String(clear));
        const wide = await p.locator("[data-release-card]:visible dd, [data-release-card]:visible h4").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.slice(0, 40)));
        check(`${size.width}px: no fact or heading is cut off`, wide.length === 0, wide.join(" | "));
      }
      await audit(p, "signed in, Physical Releases");
      if (name === "tablet") await shot(p, "07b-tablet-820.png", { scrollTo: p.locator("[data-physical-releases]:visible") });
      if (name === "phone") {
        await card(p, ids.us).locator("summary").click();
        await shot(p, "08-phone-390.png", { scrollTo: p.locator("[data-physical-releases]:visible") });
        await shot(p, "08a-phone-390-card-details.png", { scrollTo: card(p, ids.us) });
      }
      if (name === "small") {
        await shot(p, "08b-phone-320.png", { scrollTo: p.locator("[data-physical-releases]:visible") });
        await shot(p, "08b-phone-320-card.png", { scrollTo: card(p, ids.eu) });
      }
      await p.context().close();
    }
    await mine.context().close();
  }

  section("Accessibility of every fixture page, signed out, phone and desktop");
  {
    for (const slug of Object.values(GAMES)) {
      await releasesTab(desk, slug);
      await audit(desk, `${slug} Physical Releases`);
    }
    const phone = await page(SIZES.phone);
    for (const slug of [GAMES.tower, GAMES.loose]) {
      await releasesTab(phone, slug);
      await audit(phone, `${slug} Physical Releases`);
    }
    await releasesTab(phone, GAMES.tower);
    await shot(phone, "08c-phone-390-playstation.png", { scrollTo: card(phone, ids.psUs) });
    await phone.context().close();
    await desk.context().close();
  }
} catch (error) {
  const at = error.stack?.split("\n").find((line) => line.includes("physical-releases-checks")) ?? "";
  check("the checks ran to the end", false, `${error.message.split("\n")[0]} ${at.trim()}`);
} finally {
  await browser?.close();
  stopApp();
  const ids = users.map((id) => `'${id}'`).join(",") || "null";
  psql(`delete from public.collection_items where owner_id in (${ids});`);
  const deleted = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'prc\\_%';");
  if (deleted.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${deleted.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${deleted.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  removeFixture();
  check("no copies, history or synthetic catalog data are left behind", footprint(psql, LEFTOVER_TABLES) === startingFootprint);
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
