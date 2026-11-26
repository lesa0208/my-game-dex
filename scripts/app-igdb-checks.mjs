/**
 * M18a end-to-end checks, on the scratch stack only, with a local stand-in for IGDB and Twitch
 * (synthetic data; no network, no real credentials):
 *   1. The operator clears IGDB against a saved basis, and its media.
 *   2. scripts/igdb.mjs enrich, as catalog_importer: reads the catalog fixture's games, asks the
 *      stand-in (within the rate limit), decides, stages and attaches. A game whose only anchor
 *      is a remake stays held. No game is created or changed; IGDB ids sit beside Wikidata's.
 *      Run again, it attaches nothing twice.
 *   3. The game page and Explore show IGDB's description, metadata and cover, credited, with the
 *      catalog's own summary first; a held game shows nothing from IGDB. The browser never
 *      contacts IGDB or Twitch: images come from the app's own optimizer. axe on the page.
 *
 *   npm run build && MGD_STACK=scratch node scripts/app-igdb-checks.mjs
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { chromium } from "playwright-core";

import { appErrorLines, check, psql, results, root, section, startApp, stopApp } from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";

if (process.env.MGD_STACK !== "scratch") {
  console.error("Refusing: the IGDB checks run on the scratch stack only (MGD_STACK=scratch).");
  process.exit(2);
}

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const GAMES = ["starfall-odyssey", "quiet-meadow", "neon-drift-racing"];
const PLATFORM_IDS = { nes: 18, snes: 19, "mega-drive": 29, "game-boy": 33, "game-boy-color": 22, "game-boy-advance": 24, "nintendo-64": 4, playstation: 7, "playstation-2": 8, "sega-saturn": 32 };
const PLATFORM_NAMES = { 18: "Nintendo Entertainment System", 19: "Super Nintendo Entertainment System", 29: "Sega Mega Drive/Genesis", 33: "Game Boy", 22: "Game Boy Color", 24: "Game Boy Advance", 4: "Nintendo 64", 7: "PlayStation", 8: "PlayStation 2", 32: "Sega Saturn" };
const SUMMARY = "A synthetic description from the IGDB stand-in, for the M18a checks.";
const work = mkdtempSync(join(tmpdir(), "mgd-igdb-checks-"));
const basis = join(work, "igdb-basis.txt");
writeFileSync(basis, "Synthetic basis for the M18a scratch checks: not a real authorization.\n");

const sql = (s) => psql(s);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---- the stand-in -------------------------------------------------------------------
const seen = [];
let records = new Map();
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ at: Date.now(), url: req.url });
    const json = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url.startsWith("/oauth2/token")) return json(200, { access_token: `stand-in-${randomBytes(4).toString("hex")}`, expires_in: 3600, token_type: "bearer" });
    if (req.headers["client-id"] !== "standinclientidforthechecks01" || !String(req.headers.authorization).startsWith("Bearer stand-in-")) return json(401, { message: "Authorization Failure" });
    if (req.url === "/v4/platforms") return json(200, Object.entries(PLATFORM_NAMES).map(([id, name]) => ({ id: Number(id), name })));
    if (req.url === "/v4/platforms/count") return json(200, { count: 1 });
    if (req.url === "/v4/games") {
      const slugs = [...body.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
      return json(200, slugs.map((s) => records.get(s)).filter(Boolean));
    }
    return json(404, { message: "not found" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const STAND_IN = `http://127.0.0.1:${server.address().port}`;

const igdbEnv = {
  ...process.env,
  MGD_STACK: "scratch",
  IGDB_CLIENT_ID: "standinclientidforthechecks01",
  IGDB_CLIENT_SECRET: "StandInSecretForTheChecksOnly01",
  MGD_IGDB_ENV_FILE: join(work, "absent.env"),
  MGD_IGDB_API_URL: `${STAND_IN}/v4`,
  MGD_IGDB_TOKEN_URL: `${STAND_IN}/oauth2/token`,
};
// Asynchronous: the stand-in answers from this same process.
const igdb = async (...args) => (await promisify(execFile)(process.execPath, [join(root, "scripts", "igdb.mjs"), ...args], { env: igdbEnv, encoding: "utf8" })).stdout;

let browser;
let wikidataRun = null;
try {
  section("Setup: the catalog fixture, with Wikidata records stating IGDB slugs");
  installFixture();
  const games = Object.fromEntries(
    GAMES.map((slug) => {
      const [id, date, platforms] = sql(`select g.id, coalesce(g.first_release_date::text, ''), coalesce(string_agg(p.slug, ',' order by p.slug), '')
        from public.games g left join public.game_platforms gp on gp.game_id = g.id left join public.platforms p on p.id = gp.platform_id
        where g.slug = ${lit(slug)} and g.status = 'published' group by g.id;`).split("|");
      return [slug, { id, date, platforms: platforms.split(",").filter(Boolean) }];
    }),
  );
  check("the three fixture games are published", GAMES.every((s) => games[s].id), JSON.stringify(games));
  wikidataRun = sql(`insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, reason, finished_at)
    select 'wikidata', p.id, 'm18a-checks.json', encode(sha256(convert_to('m18a-checks-${randomBytes(4).toString("hex")}', 'UTF8')), 'hex'), now(), 'completed', 'M18a checks', now()
    from public.platforms p where p.slug = 'snes' returning id;`);
  for (const slug of GAMES) {
    const anchor = slug === "neon-drift-racing" ? "neon-drift-racing-remake" : slug;
    sql(`insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
      values ('wikidata', 'game', ${lit(`Qm18a-${slug}`)}, ${lit(JSON.stringify({ title: slug, source: { external_ids: { igdb: [anchor] } } }))}::jsonb,
        encode(sha256(convert_to(${lit(`m18a-${slug}-${wikidataRun}`)}, 'UTF8')), 'hex'), ${lit(wikidataRun)}, 'promoted', ${lit(games[slug].id)});`);
  }
  // The stand-in's games: two that match, and a remake under the third game's only anchor.
  const titleOf = (slug) => sql(`select title from public.games where slug = ${lit(slug)};`);
  const seconds = (date, fallbackYear) => Date.UTC(date ? Number(date.slice(0, 4)) : fallbackYear, date ? Number(date.slice(5, 7)) - 1 : 0, date ? Number(date.slice(8, 10)) : 1) / 1000;
  const record = (id, slug, game, over = {}) => ({
    id, slug, name: titleOf(game), url: `https://www.igdb.com/games/${slug}`, summary: SUMMARY,
    first_release_date: games[game].date ? seconds(games[game].date) : undefined, game_type: { type: "Main Game" },
    platforms: games[game].platforms.map((p) => ({ id: PLATFORM_IDS[p], name: PLATFORM_NAMES[PLATFORM_IDS[p]] })).filter((p) => p.id),
    genres: [{ name: "Adventure" }], themes: [{ name: "Fantasy" }],
    involved_companies: [{ developer: true, publisher: false, company: { name: "Stand-in Studio" } }, { developer: false, publisher: true, company: { name: "Stand-in Publishing" } }],
    cover: { image_id: `co${id}m18a`, width: 264, height: 374 }, screenshots: [{ image_id: `sc${id}m18a`, width: 889, height: 500 }],
    ...over,
  });
  records = new Map([
    ["starfall-odyssey", record(9101, "starfall-odyssey", "starfall-odyssey")],
    ["quiet-meadow", record(9102, "quiet-meadow", "quiet-meadow")],
    ["neon-drift-racing-remake", record(9103, "neon-drift-racing-remake", "neon-drift-racing", { game_type: { type: "Remake" } })],
  ]);
  const catalogBefore = sql(`select md5(string_agg(row(g.*)::text, ',' order by g.id)) || '/' || count(*) from public.games g;`);
  const aliasesBefore = sql("select count(*) from public.game_aliases;");

  section("1. Clearance");
  const config = await igdb("check");
  check("the credentials check says set, never the values", config.includes("IGDB_CLIENT_ID: set") && !config.includes(igdbEnv.IGDB_CLIENT_SECRET) && !config.includes(igdbEnv.IGDB_CLIENT_ID));
  let refused = "";
  try {
    await igdb("enrich", "--games", GAMES.join(","), "--basis-file", basis, "--reason", "M18a checks", "--out", join(work, "early"));
  } catch (error) {
    refused = String(error.stderr ?? error.message);
  }
  check("before clearance, an enrichment run is refused", /provider not cleared/.test(refused), refused.slice(0, 200));
  await igdb("clear", "--basis-file", basis, "--note", "synthetic basis for the M18a checks", "--media", "--media-note", "scratch display for the M18a checks");
  check("cleared, with its media", sql("select commercial_use_cleared || '/' || media_cleared from private.external_providers where code = 'igdb';") === "true/true");

  section("2. Enrichment");
  const before = seen.length;
  const out = await igdb("enrich", "--games", GAMES.join(","), "--basis-file", basis, "--reason", "M18a checks", "--out", join(work, "run1"));
  check("2 matched, 1 for review", out.includes("decisions: 2 matched, 1 for review"), out.split("\n").find((l) => l.startsWith("decisions")));
  const starts = seen.slice(before).map((s) => s.at);
  check("never more than 4 requests to the stand-in in any second", starts.every((s) => starts.filter((x) => x >= s && x < s + 1000).length <= 4), String(starts.length));
  check("the IGDB ids sit beside the Wikidata ids, one identity each",
    sql(`select string_agg(g.slug || '=' || x.external_id, ',' order by g.slug) from private.external_references x join public.games g on g.id = x.game_id where x.provider_code = 'igdb';`) === "quiet-meadow=9102,starfall-odyssey=9101");
  check("the remake is held for review, never attached",
    sql("select status || '/' || coalesce(matched_game_id::text, 'none') || '/' || (review_reason like 'IGDB match needs review%') from private.provider_records where provider_code = 'igdb' and external_id = '9103';") === "needs_review/none/true");
  check("no game created or changed, no alias added", sql(`select md5(string_agg(row(g.*)::text, ',' order by g.id)) || '/' || count(*) from public.games g;`) === catalogBefore && sql("select count(*) from public.game_aliases;") === aliasesBefore);
  const report = readFileSync(join(work, "run1", "report.md"), "utf8");
  check("the report lists each game's match, confidence, coverage and images", report.includes("| Quiet Meadow | matched |") && report.includes("high") && report.includes("summary, genres, themes, developers, publishers") && report.includes("cover, 1 screenshots"));
  const again = await igdb("enrich", "--games", GAMES.join(","), "--basis-file", basis, "--reason", "M18a checks, again", "--out", join(work, "run1"), "--snapshot", join(work, "run1", "igdb.json"));
  check("run again from the same snapshot: nothing attached twice", /"skipped": 2/.test(again) && sql("select count(*) from private.external_references where provider_code = 'igdb';") === "2", again.slice(-200));

  section("3. The pages");
  process.env.MGD_PROVIDER_MEDIA = "igdb";
  const origin = await startApp(3418);
  const channels = process.env.A11Y_BROWSER ? [process.env.A11Y_BROWSER] : ["msedge", "chrome"];
  for (const channel of channels) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // the next one
    }
  }
  if (!browser) throw new Error("no installed browser could be started");
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
  const outside = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (/igdb\.com$|twitch\.tv$/.test(host)) outside.push(r.url());
  });
  // The optimizer would fetch the stand-in's made-up image ids from IGDB: not in a check.
  await page.route("**/_next/image**", (route) => route.abort());
  await page.goto(`${origin}/games/quiet-meadow`, { waitUntil: "networkidle" });
  const main = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check("Quiet Meadow shows IGDB's description, credited", main.includes(SUMMARY) && main.includes("Description from IGDB.com"));
  check("and IGDB's developer, publisher, genre and theme under From IGDB", await page.locator("[data-provider-facts=igdb]").innerText().then((t) => /Stand-in Studio/.test(t) && /Stand-in Publishing/.test(t) && /Adventure/.test(t) && /Fantasy/.test(t)));
  const coverSrc = await page.locator('[data-game-image="igdb-cover"] img').getAttribute("src");
  check("its cover, from the app's own optimizer, as game artwork", Boolean(coverSrc?.startsWith("/_next/image?url=https%3A%2F%2Fimages.igdb.com%2Figdb%2Fimage%2Fupload%2Ft_cover_big_2x%2Fco9102m18a.jpg")) && main.includes("Game artwork, not a photo of a specific release"), coverSrc);
  check("never laid on a cartridge: no label overlay with the cover", (await page.locator('[data-game-image="igdb-cover"]').innerText()).includes("Artwork not available") === false);
  check("the Gallery tab holds IGDB's screenshot, credited", (await page.getByRole("tab", { name: /Gallery/ }).count()) === 1 && (await page.locator("[data-screenshot=igdb]").count()) === 1);
  check("the catalog's own facts are unchanged: no verified release invented", main.includes("No verified physical release recorded yet") || main.includes("Verified releases"));
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations.filter((v) => ["critical", "serious"].includes(v.impact)).map((v) => v.id));
  check("axe: no critical or serious findings on the enriched page", axe.length === 0, axe.join(","));

  await page.goto(`${origin}/games/starfall-odyssey`, { waitUntil: "networkidle" });
  const starfall = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  const own = sql("select coalesce(summary, '') from public.games where slug = 'starfall-odyssey';");
  check("Starfall Odyssey: the catalog's own summary first, IGDB's not shown", own ? starfall.includes(own.slice(0, 40)) && !starfall.includes(SUMMARY) : starfall.includes(SUMMARY));
  await page.goto(`${origin}/games/neon-drift-racing`, { waitUntil: "networkidle" });
  const neon = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check("Neon Drift Racing, held: nothing from IGDB", !neon.includes(SUMMARY) && (await page.locator("[data-provider-facts]").count()) === 0 && (await page.locator('[data-game-image="igdb-cover"]').count()) === 0);

  await page.goto(`${origin}/explore?q=quiet+meadow`, { waitUntil: "networkidle" });
  check("Explore: the card shows the cover, and the grid credits IGDB", (await page.locator('[data-game-card="Quiet Meadow"] [data-cover=igdb]').count()) === 1 && (await page.locator("[data-igdb-credit]").count()) >= 1);
  check("the browser never contacted IGDB or Twitch", outside.length === 0, outside.slice(0, 3).join(", "));

  const appErrors = appErrorLines();
  check("the app logged no errors", appErrors.length === 0, appErrors.slice(0, 3).join(" | "));
} catch (error) {
  check("the checks ran to the end", false, String(error.message).split("\n")[0]);
} finally {
  await browser?.close();
  await stopApp();
  server.close();
  // The scratch stack goes back as it was: IGDB records, links, runs and clearance removed.
  try {
    sql(`begin;
delete from private.import_run_records where import_run_id in (select id from private.import_runs where provider_code = 'igdb' or id = ${wikidataRun ? lit(wikidataRun) : "null"});
delete from private.external_references where provider_code = 'igdb';
delete from private.provider_records where provider_code = 'igdb' or import_run_id = ${wikidataRun ? lit(wikidataRun) : "null"};
delete from private.import_runs where provider_code = 'igdb' or id = ${wikidataRun ? lit(wikidataRun) : "null"};
update private.external_providers set commercial_use_cleared = false, terms_sha256 = null, media_cleared = false, media_note = null where code = 'igdb';
commit;`);
    removeFixture();
  } catch (error) {
    check("the scratch stack was put back", false, String(error.message).split("\n")[0]);
  }
}
console.log(`\napp-igdb-checks: ${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
