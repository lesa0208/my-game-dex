/**
 * M18a end-to-end checks, on the scratch stack only, with a local stand-in for IGDB and Twitch
 * (synthetic data; no network, no real credentials):
 *   1. The operator clears IGDB against a saved basis, and its media.
 *   2. scripts/igdb.mjs enrich, as catalog_importer: reads the catalog fixture's games, asks the
 *      stand-in (within the rate limit), decides, stages and attaches. A game whose only anchor
 *      is a remake stays held. No game is created or changed; IGDB ids sit beside Wikidata's.
 *      Run again, it attaches nothing twice.
 *   3. Security: no public Supabase client (the publishable key, signed out or signed in) can
 *      call the provider read or reach the provider records; the server's secret key can.
 *   4. The game page and Explore show IGDB's description, metadata and cover, credited, with the
 *      catalog's own summary first; a held game shows nothing from IGDB. A game-level cover is
 *      shown only on a platform IGDB lists for the game, captioned as general game artwork; on
 *      another platform the honest fallback stays. The browser never contacts IGDB or Twitch:
 *      images come from the app's own route. axe on the page.
 *   5. Image authorization (security fix): the route serves an image only while that asset is
 *      authorized; unattached, unknown and malformed images are 404; the image optimizer refuses
 *      IGDB and the route alike. Withdrawing media or clearance takes effect on the next request,
 *      for pages and images, and survives an app restart; the deployment flag alone isn't enough;
 *      the withdraw command removes the optimizer's stored copies; re-clearing brings the images back.
 *
 *   npm run build && MGD_STACK=scratch node scripts/app-igdb-checks.mjs
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { chromium } from "playwright-core";
import sharp from "sharp";

import { api, appErrorLines, check, createUser, deleteUsers, psql, publishableKey, results, root, section, service, startApp, stopApp } from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";

if (process.env.MGD_STACK !== "scratch") {
  console.error("Refusing: the IGDB checks run on the scratch stack only (MGD_STACK=scratch).");
  process.exit(2);
}

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const GAMES = ["starfall-odyssey", "quiet-meadow", "neon-drift-racing", "the-crystal-warden"];
const PLATFORM_IDS = { nes: 18, snes: 19, "mega-drive": 29, "game-boy": 33, "game-boy-color": 22, "game-boy-advance": 24, "nintendo-64": 4, playstation: 7, "playstation-2": 8, "sega-saturn": 32 };
const PLATFORM_NAMES = { 18: "Nintendo Entertainment System", 19: "Super Nintendo Entertainment System", 29: "Sega Mega Drive/Genesis", 33: "Game Boy", 22: "Game Boy Color", 24: "Game Boy Advance", 4: "Nintendo 64", 7: "PlayStation", 8: "PlayStation 2", 32: "Sega Saturn" };
const SUMMARY = "A synthetic description from the IGDB stand-in, for the M18a checks.";
const work = mkdtempSync(join(tmpdir(), "mgd-igdb-checks-"));
const basis = join(work, "igdb-basis.txt");
writeFileSync(basis, "Synthetic basis for the M18a scratch checks: not a real authorization.\n");

const sql = (s) => psql(s);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---- the stand-in -------------------------------------------------------------------
const JPEG = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#7a5cff" } }).jpeg().toBuffer();
const seen = [];
const imageFetches = [];
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
    // IGDB's image CDN: any well-formed address answers, as the real one does for real ids.
    const img = /^\/igdb\/image\/upload\/t_[a-z0-9_]+\/([a-z0-9]+)\.jpg$/.exec(req.url);
    if (img) {
      imageFetches.push(img[1]);
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      return res.end(JPEG);
    }
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

const rpc = (headers, body) => fetch(`${api}/rest/v1/rpc/get_game_provider_metadata`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

let browser;
async function eventually(condition, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await condition().catch(() => false)) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
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
  check("the four fixture games are published", GAMES.every((s) => games[s].id), JSON.stringify(games));
  check("Neon Drift Racing is on the PlayStation and the Saturn", games["neon-drift-racing"].platforms.join(",") === "playstation,sega-saturn", games["neon-drift-racing"].platforms.join(","));
  wikidataRun = sql(`insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, reason, finished_at)
    select 'wikidata', p.id, 'm18a-checks.json', encode(sha256(convert_to('m18a-checks-${randomBytes(4).toString("hex")}', 'UTF8')), 'hex'), now(), 'completed', 'M18a checks', now()
    from public.platforms p where p.slug = 'snes' returning id;`);
  const anchors = { "starfall-odyssey": "starfall-odyssey", "quiet-meadow": "quiet-meadow", "neon-drift-racing": "neon-drift-racing", "the-crystal-warden": "the-crystal-warden-remake" };
  for (const slug of GAMES) {
    sql(`insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
      values ('wikidata', 'game', ${lit(`Qm18a-${slug}`)}, ${lit(JSON.stringify({ title: slug, source: { external_ids: { igdb: [anchors[slug]] } } }))}::jsonb,
        encode(sha256(convert_to(${lit(`m18a-${slug}-${wikidataRun}`)}, 'UTF8')), 'hex'), ${lit(wikidataRun)}, 'promoted', ${lit(games[slug].id)});`);
  }
  // The stand-in's games: three that match (Neon listed on the PlayStation only), and a remake
  // under the Crystal Warden's only anchor.
  const titleOf = (slug) => sql(`select title from public.games where slug = ${lit(slug)};`);
  const seconds = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
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
    // Quiet Meadow: three screenshots of three shapes (16:9, 8:7, 4:3), for the Gallery's viewer.
    ["quiet-meadow", record(9102, "quiet-meadow", "quiet-meadow", { screenshots: [{ image_id: "sc9102m18a", width: 1280, height: 720 }, { image_id: "sc9102bm18a", width: 256, height: 224 }, { image_id: "sc9102cm18a", width: 640, height: 480 }] })],
    ["neon-drift-racing", record(9103, "neon-drift-racing", "neon-drift-racing", { platforms: [{ id: 7, name: "PlayStation" }] })],
    ["the-crystal-warden-remake", record(9104, "the-crystal-warden-remake", "the-crystal-warden", { game_type: { type: "Remake" } })],
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
  check("3 matched, 1 for review", out.includes("decisions: 3 matched, 1 for review"), out.split("\n").find((l) => l.startsWith("decisions")));
  const starts = seen.slice(before).map((s) => s.at);
  check("never more than 4 requests to the stand-in in any second", starts.every((s) => starts.filter((x) => x >= s && x < s + 1000).length <= 4), String(starts.length));
  check("the IGDB ids sit beside the Wikidata ids, one identity each",
    sql(`select string_agg(g.slug || '=' || x.external_id, ',' order by g.slug) from private.external_references x join public.games g on g.id = x.game_id where x.provider_code = 'igdb';`) === "neon-drift-racing=9103,quiet-meadow=9102,starfall-odyssey=9101");
  check("the remake is held for review, never attached",
    sql("select status || '/' || coalesce(matched_game_id::text, 'none') || '/' || (review_reason like 'IGDB match needs review%') from private.provider_records where provider_code = 'igdb' and external_id = '9104';") === "needs_review/none/true");
  check("no game created or changed, no alias added", sql(`select md5(string_agg(row(g.*)::text, ',' order by g.id)) || '/' || count(*) from public.games g;`) === catalogBefore && sql("select count(*) from public.game_aliases;") === aliasesBefore);
  const report = readFileSync(join(work, "run1", "report.md"), "utf8");
  check("the report lists each game's match, confidence, coverage and images", report.includes("| Quiet Meadow | matched |") && report.includes("high") && report.includes("summary, genres, themes, developers, publishers") && report.includes("cover, 1 screenshots"));
  check("and notes a platform the catalog lists that IGDB doesn't", report.includes("our platforms IGDB doesn't list: sega-saturn"));
  const again = await igdb("enrich", "--games", GAMES.join(","), "--basis-file", basis, "--reason", "M18a checks, again", "--out", join(work, "run1"), "--snapshot", join(work, "run1", "igdb.json"));
  check("run again from the same snapshot: nothing attached twice", /"skipped": 3/.test(again) && sql("select count(*) from private.external_references where provider_code = 'igdb';") === "3", again.slice(-200));

  section("3. Security: the provider read is the server's only");
  const ids = [games["quiet-meadow"].id];
  const asAnon = await rpc({ apikey: publishableKey, Authorization: `Bearer ${publishableKey}` }, { p_games: ids });
  const anonBody = await asAnon.text();
  check("a signed-out public client can't call it", !asAnon.ok && !anonBody.includes(SUMMARY), `${asAnon.status} ${anonBody.slice(0, 120)}`);
  const user = await createUser({ prefix: "igdb-check" });
  const signIn = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: publishableKey, "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: user.password }) });
  const token = (await signIn.json()).access_token;
  const asUser = await rpc({ apikey: publishableKey, Authorization: `Bearer ${token}` }, { p_games: ids });
  const userBody = await asUser.text();
  check("nor a signed-in collector", Boolean(token) && !asUser.ok && !userBody.includes(SUMMARY), `${asUser.status} ${userBody.slice(0, 120)}`);
  const records1 = await fetch(`${api}/rest/v1/provider_records?select=payload&provider_code=eq.igdb`, { headers: { apikey: publishableKey, Authorization: `Bearer ${token}`, "Accept-Profile": "private" } });
  const recordsBody = await records1.text();
  check("the provider records themselves aren't reachable through the API", !records1.ok && !recordsBody.includes(SUMMARY), `${records1.status} ${recordsBody.slice(0, 120)}`);
  const asServer = await rpc(service, { p_games: ids });
  const serverRows = asServer.ok ? await asServer.json() : [];
  check("the server's secret key can, for the pages", asServer.ok && serverRows[0]?.summary === SUMMARY && Array.isArray(serverRows[0]?.platform_ids), String(asServer.status));
  check("the database grants it to service_role only",
    sql("select string_agg(r, ',' order by r) from unnest(array['anon','authenticated','service_role','catalog_importer']) r where has_function_privilege(r, 'public.get_game_provider_metadata(uuid[])', 'execute');") === "service_role");

  section("4. The pages");
  process.env.MGD_PROVIDER_MEDIA = "igdb";
  process.env.MGD_IGDB_IMAGE_ORIGIN = `${STAND_IN}/igdb/image/upload`;
  let origin = await startApp(3418);
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
  const providerCalls = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (/igdb\.com$|twitch\.tv$/.test(host)) outside.push(r.url());
    if (r.url().includes("get_game_provider_metadata")) providerCalls.push(r.url());
  });
  await page.goto(`${origin}/games/quiet-meadow`, { waitUntil: "networkidle" });
  const main = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check("Quiet Meadow shows IGDB's description, credited", main.includes(SUMMARY) && main.includes("Description from IGDB.com"));
  check("and IGDB's developer, publisher, genre and theme under From IGDB", await page.locator("[data-provider-facts=igdb]").innerText().then((t) => /Stand-in Studio/.test(t) && /Stand-in Publishing/.test(t) && /Adventure/.test(t) && /Fantasy/.test(t)));
  const coverSrc = await page.locator('[data-game-image="igdb-cover"] img').getAttribute("src");
  check("its cover, from the app's own image route, as general game artwork", coverSrc === "/media/igdb/cover_big/co9102m18a.jpg" && (await page.locator("[data-artwork-caption]").textContent()).includes("General game artwork, not verified for a specific platform, region or edition"), coverSrc);
  check("the hero's backdrop is the authorized cover's wash, through the same route", (await page.locator("[data-hero-backdrop] img").getAttribute("src")) === "/media/igdb/cover_big/co9102m18a.jpg");
  check("and it loads", await page.locator('[data-game-image="igdb-cover"] img').evaluate((i) => i.complete && i.naturalWidth > 0));
  check("never laid on a cartridge: no label overlay with the cover", (await page.locator('[data-game-image="igdb-cover"]').innerText()).includes("Artwork not available") === false);
  await page.getByRole("tab", { name: /Gallery/ }).click();
  const gallery = await page.locator('[data-panel="gallery"]').innerText();
  check("the Gallery tab holds IGDB's screenshots, credited", (await page.locator("[data-screenshot=igdb]").count()) === 3 && gallery.includes("Game screenshots from IGDB.com, not tied to a platform or release"), gallery.slice(0, 160));
  // Game Details 2.0, Phase 3: thumbnails and viewer only through the app's route, at a proportional size.
  const thumbSrcs = await page.$$eval("[data-gallery-item] img", (imgs) => imgs.map((i) => i.getAttribute("src")));
  check("its thumbnails come from the app's route at IGDB's proportional size, never the cropped one", JSON.stringify(thumbSrcs) === JSON.stringify(["/media/igdb/720p/sc9102m18a.jpg", "/media/igdb/720p/sc9102bm18a.jpg", "/media/igdb/720p/sc9102cm18a.jpg"]), thumbSrcs.join(","));
  await page.locator("[data-gallery-item] button").first().click();
  const stage = () => page.locator("[data-gallery-stage]").getAttribute("data-gallery-stage").catch(() => null);
  const viewerPosition = async () => ((await page.locator("[data-gallery-position]").textContent().catch(() => "")) ?? "").trim();
  check("the viewer opens on the first, 1 of 3, shown from what the route just served", await eventually(async () => (await stage()) === "image" && (await viewerPosition()) === "1 of 3") && (await page.locator("[data-gallery-image]").getAttribute("src")).startsWith("blob:"));
  await page.keyboard.press("ArrowRight");
  check("and the Right arrow shows the second, 2 of 3", await eventually(async () => (await stage()) === "image" && (await viewerPosition()) === "2 of 3"));
  await page.keyboard.press("Escape");
  check("Escape closes it", await eventually(async () => (await page.getByRole("dialog").count()) === 0));
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations.filter((v) => ["critical", "serious"].includes(v.impact)).map((v) => v.id));
  check("axe: no critical or serious findings on the enriched page", axe.length === 0, axe.join(","));

  await page.goto(`${origin}/games/neon-drift-racing?platform=playstation`, { waitUntil: "networkidle" });
  check("Neon Drift Racing on the PlayStation, which IGDB lists: the cover", (await page.locator('[data-game-image="igdb-cover"]').count()) === 1);
  await page.goto(`${origin}/games/neon-drift-racing?platform=sega-saturn`, { waitUntil: "networkidle" });
  const saturn = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check("on the Saturn, which IGDB doesn't list: no cover, the honest fallback", (await page.locator('[data-game-image="igdb-cover"]').count()) === 0 && (await page.locator('[data-game-image="none"]').count()) === 1, saturn.slice(0, 160));
  check("and no wash of the cover behind it", (await page.locator("[data-hero-backdrop]").getAttribute("data-hero-backdrop")) === "generic" && (await page.locator('[data-hero-backdrop] img[src^="/media/igdb/"]').count()) === 0);
  check("the game's description stays, as IGDB's", saturn.includes(SUMMARY) && saturn.includes("Description from IGDB.com"));
  check("and no Gallery of IGDB's screenshots on a platform IGDB doesn't list", (await page.getByRole("tab", { name: /Gallery/ }).count()) === 0 && (await page.locator("[data-screenshot=igdb]").count()) === 0);

  await page.goto(`${origin}/games/starfall-odyssey`, { waitUntil: "networkidle" });
  const starfall = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  const own = sql("select coalesce(summary, '') from public.games where slug = 'starfall-odyssey';");
  check("Starfall Odyssey: the catalog's own summary first, IGDB's not shown", own ? starfall.includes(own.slice(0, 40)) && !starfall.includes(SUMMARY) : starfall.includes(SUMMARY));
  await page.goto(`${origin}/games/the-crystal-warden`, { waitUntil: "networkidle" });
  const warden = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check("The Crystal Warden, held: nothing from IGDB", !warden.includes(SUMMARY) && (await page.locator("[data-provider-facts]").count()) === 0 && (await page.locator('[data-game-image="igdb-cover"]').count()) === 0);

  await page.goto(`${origin}/explore?q=quiet+meadow`, { waitUntil: "networkidle" });
  check("Explore: the card shows the cover, and the grid credits IGDB", (await page.locator('[data-game-card="Quiet Meadow"] [data-cover=igdb]').count()) === 1 && (await page.locator("[data-igdb-credit]").count()) >= 1);
  await page.goto(`${origin}/explore?q=neon+drift&platform=sega-saturn`, { waitUntil: "networkidle" });
  check("Explore on the Saturn: Neon Drift Racing's card keeps its console, not the cover", (await page.locator('[data-game-card="Neon Drift Racing"]').count()) === 1 && (await page.locator('[data-game-card="Neon Drift Racing"] [data-cover=igdb]').count()) === 0);
  check("the browser never contacted IGDB or Twitch", outside.length === 0, outside.slice(0, 3).join(", "));
  check("nor called the provider read itself", providerCalls.length === 0, providerCalls.join(", "));
  const html = await (await fetch(`${origin}/games/quiet-meadow`)).text();
  check("no secret key in the page", !html.includes(service.apikey));

  section("5. Image authorization and withdrawal");
  const img = (path, headers = {}) => fetch(`${origin}${path}`, { headers, redirect: "manual" });
  const COVER = "/media/igdb/cover_big/co9102m18a.jpg";
  const ok1 = await img(COVER);
  const etag = ok1.headers.get("etag");
  check("an authorized image: 200, a JPEG, revalidated on every use", ok1.status === 200 && ok1.headers.get("content-type") === "image/jpeg" && /no-cache/.test(ok1.headers.get("cache-control") ?? "") && Boolean(etag), `${ok1.status} ${ok1.headers.get("cache-control")}`);
  check("and a browser's revalidation is a 304 while it stays authorized", (await img(COVER, { "If-None-Match": etag })).status === 304);
  const fetchedBefore = imageFetches.length;
  check("the remake's cover (staged, held, never attached): 404", (await img("/media/igdb/cover_big/co9104m18a.jpg")).status === 404);
  check("an unknown image: 404", (await img("/media/igdb/cover_big/co31337zz.jpg")).status === 404);
  check("a malformed id, another size or another extension: 404",
    (await img("/media/igdb/cover_big/..%2Fsecret.jpg")).status === 404 && (await img("/media/igdb/t_original/co9102m18a.jpg")).status === 404 && (await img("/media/igdb/cover_big/co9102m18a.png")).status === 404);
  check("nothing unauthorized was even fetched from IGDB", imageFetches.length === fetchedBefore, imageFetches.slice(fetchedBefore).join(","));
  const opt = (url) => img(`/_next/image?url=${encodeURIComponent(url)}&w=256&q=75`);
  check("the image optimizer refuses IGDB's own address", (await opt("https://images.igdb.com/igdb/image/upload/t_cover_big/co9102m18a.jpg")).status === 400);
  check("and refuses the image route (it would keep a copy on disk)", (await opt(COVER)).status === 400);

  const optimizerCache = join(root, ".next", "cache", "images");
  mkdirSync(optimizerCache, { recursive: true });
  writeFileSync(join(optimizerCache, "m18a-check-stored-copy"), "a copy kept from before the fix");
  const open = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
  await open.goto(`${origin}/games/quiet-meadow`, { waitUntil: "networkidle" });
  await open.getByRole("tab", { name: /Gallery/ }).click();
  await open.locator("[data-gallery-item] button").first().click();
  const openStage = () => open.locator("[data-gallery-stage]").getAttribute("data-gallery-stage").catch(() => null);
  check("before the withdrawal: the viewer open on an authorized screenshot", await eventually(async () => (await openStage()) === "image"));
  await igdb("withdraw", "--media-only", "--note", "M18a checks: media withdrawn");
  await open.keyboard.press("ArrowRight");
  check("withdrawn while the viewer is open: the next image is not shown, a safe 'not available' state instead", await eventually(async () => (await openStage()) === "unavailable") && (await open.locator("[data-gallery-image]").count()) === 0 && (await open.locator("[data-gallery-viewer] [role=status]").innerText()).includes("isn't available"));
  await open.keyboard.press("ArrowLeft");
  check("and going back to the image seen before: asked again, refused, not shown from a copy", await eventually(async () => (await openStage()) === "unavailable") && (await open.locator("[data-gallery-image]").count()) === 0);
  await open.keyboard.press("Escape");
  check("the viewer still closes", await eventually(async () => (await open.getByRole("dialog").count()) === 0));
  await open.context().close();
  check("withdrawing media: the same image is a 404 on the next request", (await img(COVER)).status === 404);
  check("even revalidating with the old ETag", (await img(COVER, { "If-None-Match": etag })).status === 404);
  check("the withdraw command removed the optimizer's stored copies", !existsSync(optimizerCache));
  await page.goto(`${origin}/games/quiet-meadow`, { waitUntil: "networkidle" });
  const noMedia = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check("the page shows no cover and no Gallery from the next request", (await page.locator('[data-game-image="igdb-cover"]').count()) === 0 && (await page.getByRole("tab", { name: /Gallery/ }).count()) === 0);
  check("while IGDB's text, still cleared, stays", noMedia.includes(SUMMARY));

  await igdb("withdraw", "--note", "M18a checks: clearance withdrawn");
  await page.goto(`${origin}/games/quiet-meadow`, { waitUntil: "networkidle" });
  const noData = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check("withdrawing clearance: no IGDB text or facts from the next request", !noData.includes(SUMMARY) && (await page.locator("[data-provider-facts]").count()) === 0 && noData.includes("No description yet."));
  await page.goto(`${origin}/explore?q=quiet+meadow`, { waitUntil: "networkidle" });
  check("and no cover on Explore", (await page.locator('[data-game-card="Quiet Meadow"]').count()) === 1 && (await page.locator("[data-cover=igdb]").count()) === 0);

  stopApp();
  await new Promise((r) => setTimeout(r, 1500));
  origin = await startApp(3419);
  check("after an app restart, still nothing: no stored copy brings it back", (await img(COVER)).status === 404 && !(await (await fetch(`${origin}/games/quiet-meadow`)).text()).includes(SUMMARY));

  await igdb("clear", "--basis-file", basis, "--note", "synthetic basis for the M18a checks, restored", "--media", "--media-note", "scratch display for the M18a checks, restored");
  check("cleared again: the existing authorized image is served again", (await img(COVER)).status === 200);
  await page.goto(`${origin}/games/quiet-meadow`, { waitUntil: "networkidle" });
  check("and the page shows it, and loads it", (await page.locator('[data-game-image="igdb-cover"] img').count()) === 1 && (await page.locator('[data-game-image="igdb-cover"] img').evaluate((i) => i.complete && i.naturalWidth > 0)));

  stopApp();
  await new Promise((r) => setTimeout(r, 1500));
  delete process.env.MGD_PROVIDER_MEDIA;
  origin = await startApp(3420);
  check("a deployment that doesn't allow provider media serves none, even authorized", (await img(COVER)).status === 404);
  stopApp();
  await new Promise((r) => setTimeout(r, 1500));
  process.env.MGD_PROVIDER_MEDIA = "igdb";
  check("and the flag alone authorizes nothing: an unattached image stays a 404 with it set", await (async () => { origin = await startApp(3421); return (await img("/media/igdb/cover_big/co9104m18a.jpg")).status === 404 && (await img(COVER)).status === 200; })());

  const appErrors = appErrorLines();
  check("the app logged no errors", appErrors.length === 0, appErrors.slice(0, 3).join(" | "));
} catch (error) {
  check("the checks ran to the end", false, String(error.message).split("\n")[0]);
} finally {
  await browser?.close();
  await stopApp();
  server.close();
  await deleteUsers();
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
