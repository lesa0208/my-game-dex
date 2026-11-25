/**
 * M15 submission enrichment, collector to editor, in the built app over HTTP (no JavaScript, as the
 * harness's browser), with a local stand-in for Wikidata so every answer is known: a match, two
 * possible matches, no match, and an outage that recovers. The stand-in serves a real, trimmed
 * Wikidata record (Super Mario World, Q853143, CC0) and copies of it under other titles.
 *
 *   - The collector: title, platform and region, "Not sure" for the cartridge shell, the lookup
 *     notice, a published game offered first (and "isn't one of these"), the physical-only
 *     confirmation still required, the copy added at once, their submission's status in plain words.
 *   - The lookup: run by the server after the response, stored with provenance, at most a few
 *     requests per submission, retried after an outage, looked up again after a title change.
 *   - The editor: the prepared review (source claims, the catalog game that already uses the item,
 *     a suggested shell, what is still missing), "Look up again", nothing chosen or published.
 *   - Nobody else can write or read it: a collector's direct call is refused.
 *
 *   npm run build && MGD_TEST_STACK=scratch node scripts/test-stack.mjs run app:enrichment-checks
 *
 * Local scratch only. Makes its own games, accounts and submissions, and removes them all.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { Browser, api, appErrorLines, check, createUser, decode, deleteUsers, formById, formWith, location, psql, publishableKey, readSession, results, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { chromium } from "playwright-core";

import { totp } from "./lib/mfa-session.mjs";
import { stackName } from "./lib/stack.mjs";

if (stackName !== "scratch") {
  console.error("Refusing: run on the disposable scratch stack (MGD_TEST_STACK=scratch node scripts/test-stack.mjs run app:enrichment-checks).");
  process.exit(2);
}

const PORT = 3296;
const TAG = `Zqx${randomBytes(3).toString("hex")}`;
const plain = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The stand-in for Wikidata
// ---------------------------------------------------------------------------

const MARIO = JSON.parse(readFileSync(new URL("./fixtures/wikidata-b1/real-q853143-trimmed.json", import.meta.url), "utf8")).entities.Q853143;
const copyOf = (id, title) => ({ ...structuredClone(MARIO), id, lastrevid: 4242, labels: { en: { language: "en", value: title } }, aliases: {} });
const TITLES = {
  mario: "Super Mario World",
  twin: `${TAG} Twin Star`,
  none: `${TAG} Nothing Here`,
  flaky: `${TAG} Flaky Comet`,
  renamed: `${TAG} Renamed Comet`,
  published: `${TAG} Already Published`,
  browser: `${TAG} Browser Quest`,
};
const ENTITIES = {
  Q853143: MARIO,
  Q990000201: copyOf("Q990000201", TITLES.twin),
  Q990000202: copyOf("Q990000202", `${TITLES.twin} II`),
  Q990000301: copyOf("Q990000301", TITLES.flaky),
  Q990000401: copyOf("Q990000401", TITLES.renamed),
  Q990000501: copyOf("Q990000501", TITLES.browser),
};
const SEARCH = {
  [TITLES.mario]: ["Q853143"],
  [TITLES.twin]: ["Q990000201", "Q990000202"],
  [TITLES.none]: [],
  [TITLES.flaky]: ["Q990000301"],
  [TITLES.renamed]: ["Q990000401"],
  [TITLES.browser]: ["Q990000501"],
};
const LABELS = { Q170420: "Nintendo EAD", Q8093: "Nintendo" };
const seen = []; // every request: { action, search, ids }
let flakyDown = true;

const wikidata = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.searchParams;
  const action = p.get("action");
  seen.push({ action, search: p.get("search"), ids: p.get("ids"), agent: req.headers["user-agent"] });
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname !== "/w/api.php") return send(404, {});
  if (action === "wbsearchentities") {
    if (p.get("search") === TITLES.flaky && flakyDown) return send(503, { error: "down" });
    return send(200, { search: (SEARCH[p.get("search")] ?? []).map((id) => ({ id })) });
  }
  if (action === "wbgetentities") {
    const ids = (p.get("ids") ?? "").split("|");
    if (p.get("props") === "labels") return send(200, { entities: Object.fromEntries(ids.filter((id) => LABELS[id]).map((id) => [id, { labels: { en: { value: LABELS[id] } } }])) });
    return send(200, { entities: Object.fromEntries(ids.filter((id) => ENTITIES[id]).map((id) => [id, ENTITIES[id]])) });
  }
  return send(400, { error: "unknown action" });
});
await new Promise((resolve) => wikidata.listen(0, "127.0.0.1", resolve));
process.env.MGD_WIKIDATA_API_URL = `http://127.0.0.1:${wikidata.address().port}/w/api.php`;
process.env.WIKIDATA_USER_AGENT = "MyGameDexChecks/1.0 (https://example.test/checks)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const users = [];
const requests = [];
let browser;
let origin;
async function account(role) {
  const user = await createUser({ prefix: "enr", mfa: Boolean(role) });
  users.push(user.id);
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `en_${randomBytes(5).toString("hex")}` });
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { ...user, browser };
}
const lookup = (id) => psql(`select status || '|' || attempts || '|' || coalesce(looked_up_title, '') || '|' || jsonb_array_length(candidates) from private.submission_enrichments where submission_id = '${id}';`);
async function settled(id, seconds = 15) {
  for (let i = 0; i < seconds * 4; i++) {
    const row = lookup(id);
    if (row && !row.startsWith("pending")) return row;
    await sleep(250);
  }
  return lookup(id);
}
/** Waits for the stored lookup to differ from `from` (a status|attempts|title|count line). */
async function changed(id, from, seconds = 15) {
  for (let i = 0; i < seconds * 4; i++) {
    const row = lookup(id);
    if (row !== from && !row.startsWith("pending")) return row;
    await sleep(250);
  }
  return lookup(id);
}
async function submitNew(collector, fields) {
  const page = await collector.browser.get("/submit");
  const form = formById(page.html, "new-submission");
  const posted = await collector.browser.submit("/submit", form, { platform: "snes", physical: "on", add_copy: "on", ...fields });
  const id = location(posted.response).split("/")[2]?.split("?")[0];
  if (/^[0-9a-f-]{36}$/.test(id ?? "")) requests.push(id);
  return { id, posted, form };
}

// A published game the collector's title matches, and a catalog game whose source is Q853143.
const PUBLISHED = psql(`
with g as (insert into public.games (slug, title, sort_title, kind, status, verified_at) values ('${TAG.toLowerCase()}-already-published', '${TITLES.published}', '${TITLES.published}', 'game', 'published', now()) returning id),
p as (insert into public.game_platforms (game_id, platform_id, status) select g.id, (select id from public.platforms where slug = 'snes'), 'published' from g returning game_id)
insert into public.releases (game_id, platform_id, region_code, media_format_code, media_playability, edition_name, edition_kind, media_count, packaging_code, status, verified_at, release_date_precision)
select p.game_id, (select id from public.platforms where slug = 'snes'), 'pal', 'snes-cartridge-jp-pal', 'unknown', 'Standard', 'standard', 1, 'cardboard-box', 'published', now(), 'unknown' from p
returning game_id;`).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l.trim()))?.trim();
const IMPORTED = psql(`
with g as (insert into public.games (title, sort_title, kind, status) values ('${TAG} Mario Import', '${TAG} Mario Import', 'game', 'under_review') returning id),
r as (insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, finished_at)
      values ('wikidata', (select id from public.platforms where slug = 'snes'), '${TAG}.json', repeat('f', 64), now(), 'completed', now()) returning id)
insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
select 'wikidata', 'game', 'Q853143', jsonb_build_object('title', 'Super Mario World', 'titles', jsonb_build_array('Super Mario World')), repeat('9', 64), r.id, 'promoted', g.id from g, r
returning matched_game_id;`).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l.trim()))?.trim();
const before = psql("select count(*) filter (where status = 'published') || '/' || count(*) from public.games;");

try {
  origin = await startApp(PORT);
  const editor = await account("catalog_editor");
  const collector = await account();

  section("The collector's form");
  const page = await collector.browser.get("/submit");
  const ptext = plain(page.html);
  const form = formById(page.html, "new-submission");
  check("three things to fill in: title, platform and region, then the physical confirmation", form && ["title", "platform", "region", "physical"].every((n) => form.names.includes(n)) && page.html.indexOf('name="title"') < page.html.indexOf('name="platform"') && page.html.indexOf('name="platform"') < page.html.indexOf('name="region"'));
  check("the region can be Unknown", /value="unknown"[^>]*>Unknown, not confirmed/.test(page.html));
  check("on SNES the cartridge shell can be 'Not sure'", /value="rom-cartridge"[^>]*>Not sure \(the editors identify it\)/.test(page.html));
  check("the form says the title and platform are looked up in Wikidata, and nothing else is sent", ptext.includes("looks up the title and platform you enter in Wikidata") && ptext.includes("Nothing else about you or your copy is sent"));

  section("The catalog is searched first");
  const dup = await submitNew(collector, { title: TITLES.published, media_format: "rom-cartridge", region: "pal" });
  check("a title the published catalog has submits nothing", !dup.id && psql(`select count(*) from public.games where title = '${TITLES.published}';`) === "1" && Boolean(PUBLISHED));
  const asked = await collector.browser.get(location(dup.posted.response).replace(/^https?:\/\/[^/]+/, ""));
  const atext = plain(asked.html);
  check("instead the collector is shown the game, with what they typed kept", atext.includes("This game may already be in the catalog") && asked.html.includes(`/games/${TAG.toLowerCase()}-already-published`) && /value="pal"[^>]*selected|selected[^>]*value="pal"/.test(asked.html) && asked.html.includes(`value="${TITLES.published}"`), location(dup.posted.response));
  check("and told how to add their copy from it", atext.includes("Open the game to add your copy"));
  const notListed = await collector.browser.submit("/submit", formById(asked.html, "new-submission"), { title: `${TITLES.published} Turbo`, platform: "snes", media_format: "rom-cartridge", region: "pal", physical: "on", not_listed: "on" });
  const notListedId = location(notListed.response).split("/")[2]?.split("?")[0];
  if (notListedId) requests.push(notListedId);
  check("'My game isn't one of these' submits it as a new game", /^[0-9a-f-]{36}$/.test(notListedId ?? ""));
  const noPhysical = await submitNew(collector, { title: `${TAG} No Physical`, media_format: "rom-cartridge", region: "pal", physical: "" });
  check("the physical-only confirmation is still required", !noPhysical.id && psql(`select count(*) from public.games where title = '${TAG} No Physical';`) === "0");

  section("A match: submitted with only title, platform and region");
  const before1 = seen.length;
  const mario = await submitNew(collector, { title: TITLES.mario, media_format: "rom-cartridge", region: "ntsc-uc" });
  check("the submission is made at once, with the copy in the collection", /^[0-9a-f-]{36}$/.test(mario.id ?? "") && location(mario.posted.response).includes("notice=submitted_copy"));
  check("its release keeps the shell unclassified and unverified: nothing false is recorded", psql(`select r.media_format_code || '/' || r.status || '/' || r.region_code from public.releases r join public.catalog_change_requests s on s.release_id = r.id where s.id = '${mario.id}';`) === "rom-cartridge/unverified/ntsc-uc");
  const marioRow = await settled(mario.id);
  check("the server looked it up after the response and stored one match", marioRow === `single_match|1|${TITLES.mario}|1`, marioRow);
  const stored = JSON.parse(psql(`select candidates::text from private.submission_enrichments where submission_id = '${mario.id}';`))[0];
  check("with provenance: the item, its revision, the licence and the retrieval time", stored.external_id === "Q853143" && stored.revision === MARIO.lastrevid && stored.licence.includes("CC0 1.0") && Boolean(stored.retrieved_at));
  check("and the developer's and publisher's names", psql(`select labels ->> 'Q170420' from private.submission_enrichments where submission_id = '${mario.id}';`) === "Nintendo EAD");
  const marioCalls = seen.slice(before1);
  check("three requests to Wikidata at most, with the operator's User-Agent", marioCalls.length <= 3 && marioCalls.every((c) => c.agent === process.env.WIKIDATA_USER_AGENT), `${marioCalls.length} requests`);
  const mine = plain((await collector.browser.get(`/submissions/${mario.id}`)).html);
  check("the collector reads that it was prepared for the editors, and the shell as not known yet", mine.includes("We found information about this game in Wikidata and prepared it for the editors") && mine.includes("Not sure yet: the editors identify the cartridge shell"));
  check("the collector never sees the candidates", !mine.includes("Q853143"));

  section("The editor's prepared review");
  const review = await editor.browser.get(`/admin/catalog/${mario.id}`);
  const rtext = plain(review.html);
  const at = (s) => rtext.indexOf(s);
  check("'Prepared for review' comes right after what was submitted", at("Prepared for review") > at("What was submitted") && at("Prepared for review") < at("The record now"));
  check("the Wikidata item, as a source claim, with its developer, publisher and dates", rtext.includes("Source claim") && rtext.includes("Super Mario World") && rtext.includes("Wikidata Q853143") && rtext.includes("Nintendo EAD") && /Publisher\s+Nintendo/.test(rtext) && rtext.includes("1990"));
  check("its provenance: retrieved, revision, licence, and not evidence of the physical release", rtext.includes(`revision ${MARIO.lastrevid}`) && rtext.includes("CC0 1.0") && rtext.includes("not evidence of this physical release"));
  check("the catalog game that already uses this Wikidata item is named: a likely duplicate", rtext.includes("This Wikidata item is already the source of") && rtext.includes(`${TAG} Mario Import`) && review.html.includes(`/admin/catalog/games/${IMPORTED}`));
  check("the shell the region suggests, marked as a suggestion to check", rtext.includes("Suggested by the submission") && rtext.includes("North American SNES Game Pak") && rtext.includes("not evidence"));
  check("what is still missing before publication, physical evidence included", rtext.includes("Still needed before it can be published") && rtext.includes("The exact physical format") && rtext.includes("which no source provides"));
  check("the submitted format reads as not sure, not as a ROM cartridge", rtext.includes("Not sure: the cartridge shell isn't identified yet"));
  check("reading it chose nothing and published nothing", psql(`select s.status || '/' || g.status || '/' || g.title from public.catalog_change_requests s join public.games g on g.id = s.game_id where s.id = '${mario.id}';`) === `open/unverified/${TITLES.mario}`);

  section("Two possible matches");
  const twin = await submitNew(collector, { title: TITLES.twin, media_format: "rom-cartridge", region: "unknown" });
  check("stored as ambiguous, with both candidates", (await settled(twin.id)) === `ambiguous|1|${TITLES.twin}|2`);
  const ttext = plain((await editor.browser.get(`/admin/catalog/${twin.id}`)).html);
  check("the editor is told none is chosen, and sees both", ttext.includes("2 possible matches. None is chosen") && ttext.includes("Q990000201") && ttext.includes("Q990000202"));
  check("an unknown region suggests no shell", !ttext.includes("Suggested by the submission"));

  section("No match");
  const none = await submitNew(collector, { title: TITLES.none, media_format: "rom-cartridge", region: "pal" });
  check("stored as no match", (await settled(none.id)) === `no_match|1|${TITLES.none}|0`);
  check("the editor is told everything has to come from them", plain((await editor.browser.get(`/admin/catalog/${none.id}`)).html).includes("Wikidata has no video game with this title on this platform"));
  check("the collector is told the editors will research it", plain((await collector.browser.get(`/submissions/${none.id}`)).html).includes("the editors will research it"));

  section("Wikidata down, then back");
  const flaky = await submitNew(collector, { title: TITLES.flaky, media_format: "snes-game-pak-na", region: "ntsc-uc" });
  check("the submission is saved even though Wikidata didn't answer", /^[0-9a-f-]{36}$/.test(flaky.id ?? "") && (await settled(flaky.id)).startsWith("failed|1|"));
  check("the collector is told it will be tried again", plain((await collector.browser.get(`/submissions/${flaky.id}`)).html).includes("We'll try again"));
  flakyDown = false;
  // The automatic retry runs from the page with JavaScript (a server action), so a real browser.
  for (const channel of ["msedge", "chrome"]) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {}
  }
  if (!browser) throw new Error("Needs Microsoft Edge or Google Chrome installed.");
  const tab = await (await browser.newContext()).newPage();
  await tab.goto(`${origin}/sign-in?next=${encodeURIComponent("/home")}`, { waitUntil: "networkidle" });
  await tab.fill("#email", editor.email);
  await tab.fill("#password", editor.password);
  await tab.click('main button[type="submit"]');
  await tab.waitForURL((u) => u.pathname === "/settings/security/verify");
  if (await tab.locator("#verify-factor").count()) await tab.selectOption("#verify-factor", editor.factorId);
  await tab.fill("#verify-code", totp(editor.totpSecret));
  await tab.click('main button[type="submit"]');
  await tab.waitForURL((u) => u.pathname === "/home");
  await tab.goto(`${origin}/admin/catalog/${flaky.id}`, { waitUntil: "networkidle" });
  await sleep(2000);
  check("opening the review soon after doesn't retry it: a failed lookup waits 15 minutes", lookup(flaky.id).startsWith("failed|1|"), lookup(flaky.id));
  psql(`update private.submission_enrichments set last_attempt_at = now() - interval '16 minutes' where submission_id = '${flaky.id}';`);
  const failedRow = lookup(flaky.id);
  await tab.goto(`${origin}/admin/catalog/${flaky.id}`, { waitUntil: "networkidle" });
  const retried = await changed(flaky.id, failedRow);
  check("opening it later retries it by itself, and it succeeds", retried === `single_match|2|${TITLES.flaky}|1`, `${failedRow} -> ${retried}`);
  await tab.waitForFunction(() => document.body.innerText.includes("Wikidata has one game with exactly this title"), null, { timeout: 15000 }).catch(() => undefined);
  check("and the page shows the answer without the editor reloading", (await tab.evaluate(() => document.body.innerText)).includes("Wikidata has one game with exactly this title"));
  check("a specific shell the collector knew is shown as given, with no suggestion", !plain((await editor.browser.get(`/admin/catalog/${flaky.id}`)).html).includes("Suggested by the submission"));

  section("The collector's form with JavaScript");
  const shots = process.env.MGD_SCREENSHOTS;
  const ctab = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  await ctab.goto(`${origin}/sign-in?next=${encodeURIComponent("/submit")}`, { waitUntil: "networkidle" });
  await ctab.fill("#email", collector.email);
  await ctab.fill("#password", collector.password);
  await ctab.click('main button[type="submit"]');
  await ctab.waitForURL((u) => u.pathname === "/submit");
  await ctab.waitForLoadState("networkidle");
  await ctab.fill("#title", TITLES.browser);
  await ctab.selectOption("#platform", "snes");
  const legend = await ctab.locator("fieldset legend", { hasText: "different shells" }).count();
  const notSureChecked = await ctab.locator('input[name="media_format"][value="rom-cartridge"]').isChecked();
  check("choosing SNES asks about the shell, with 'Not sure' already chosen", legend === 1 && notSureChecked);
  check("no format list is shown before the shell question", (await ctab.locator("#media_format").count()) === 0);
  await ctab.selectOption("#region", "ntsc-uc");
  await ctab.check("#physical");
  if (shots) await ctab.screenshot({ path: `${shots}/collector-form.png`, fullPage: true });
  await ctab.click('form#new-submission button[type="submit"]');
  await ctab.waitForURL((u) => u.pathname.startsWith("/submissions/"), { timeout: 15000 });
  const jsId = new URL(ctab.url()).pathname.split("/")[2];
  if (/^[0-9a-f-]{36}$/.test(jsId)) requests.push(jsId);
  check("three answers and the confirmation are all it took", /^[0-9a-f-]{36}$/.test(jsId) && psql(`select r.media_format_code || '/' || r.region_code from public.releases r join public.catalog_change_requests s on s.release_id = r.id where s.id = '${jsId}';`) === "rom-cartridge/ntsc-uc");
  check("its lookup is stored", (await settled(jsId)) === `single_match|1|${TITLES.browser}|1`);
  await ctab.waitForFunction(() => document.body.innerText.includes("We found information about this game"), null, { timeout: 15000 }).catch(() => undefined);
  check("the collector's page shows it was prepared", (await ctab.evaluate(() => document.body.innerText)).includes("We found information about this game"));
  if (shots) await ctab.screenshot({ path: `${shots}/collector-submission.png`, fullPage: true });
  await tab.setViewportSize({ width: 1280, height: 900 });
  await tab.goto(`${origin}/admin/catalog/${mario.id}`, { waitUntil: "networkidle" });
  if (shots) await tab.screenshot({ path: `${shots}/editor-review.png`, fullPage: true });

  section("Look up again, and a changed title");
  const lookAgain = formById((await editor.browser.get(`/admin/catalog/${none.id}`)).html, "lookup-again");
  const callsBefore = seen.length;
  const asked2 = lookAgain ? await editor.browser.submit(`/admin/catalog/${none.id}`, lookAgain, {}) : null;
  let answered = false;
  for (let i = 0; i < 60 && !answered; i++) {
    answered = seen.slice(callsBefore).some((c) => c.search === TITLES.none) && !lookup(none.id).startsWith("pending");
    if (!answered) await sleep(250);
  }
  check("an editor's 'Look up again' asks Wikidata again", Boolean(lookAgain) && answered && lookup(none.id) === `no_match|1|${TITLES.none}|0` && location(asked2.response).includes("notice=lookup"), `${lookup(none.id)} ${location(asked2?.response ?? { headers: new Headers() })}`);
  const edit = formById((await collector.browser.get(`/submissions/${twin.id}`)).html, "edit-submission");
  await collector.browser.submit(`/submissions/${twin.id}`, edit, { title: TITLES.renamed, media_format: "rom-cartridge", region: "unknown", game_kind: "game", first_release_year: "", note: "" });
  check("the collector can rename their new-game submission (the guard fix)", psql(`select g.title from public.catalog_change_requests s join public.games g on g.id = s.game_id where s.id = '${twin.id}';`) === TITLES.renamed);
  check("and the new title is looked up, replacing the old answer", (await settled(twin.id)) === `single_match|1|${TITLES.renamed}|1`);

  section("Nobody else can write or read it");
  const session = readSession(collector.browser)?.session;
  const rpc = (name, body) => fetch(`${api}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: publishableKey, Authorization: `Bearer ${session?.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const forged = await rpc("record_submission_enrichment", { p_submission: none.id, p_claim: "00000000-0000-0000-0000-000000000000", p_result: { status: "single_match", candidates: [] } });
  const claimed = await rpc("claim_submission_enrichments", { p_submission: none.id, p_limit: 1 });
  const peek = await rpc("get_submission_enrichment", { p_submission: mario.id });
  check("a collector's own session can't record, claim or read lookups", [forged.status, claimed.status, peek.status].every((s) => s === 401 || s === 403 || s === 404) || (peek.status === 400), `${forged.status} ${claimed.status} ${peek.status}`);
  check("nothing was published, and the only new games are the submissions' own", psql("select count(*) filter (where status = 'published') || '/' || count(*) from public.games;") === `${before.split("/")[0]}/${Number(before.split("/")[1]) + requests.length}`);
  check("the app logged no errors", appErrorLines().length === 0, appErrorLines().slice(0, 3).join(" | "));
} finally {
  await browser?.close();
  stopApp();
  wikidata.close();
  const ids = users.map((u) => `'${u}'`).join(",") || "null";
  const subs = requests.filter(Boolean).map((r) => `'${r}'`).join(",") || "null";
  psql(`begin;
delete from public.collection_items where owner_id in (${ids});
create temp table sub_requests on commit drop as select * from public.catalog_change_requests where submitted_by in (${ids}) or id in (${subs});
delete from public.releases where submitted_by in (${ids}) or id in (select release_id from sub_requests);
delete from public.game_platforms where submitted_by in (${ids}) or game_id in (select game_id from sub_requests where created_game);
delete from public.catalog_change_requests where id in (select id from sub_requests);
delete from public.games where submitted_by in (${ids}) or id in (select game_id from sub_requests where created_game);
commit;`);
  psql(`begin; set local session_replication_role = replica;
delete from private.catalog_record_origins where game_id in (select id from public.games where title like '${TAG}%') or release_id in (select r.id from public.releases r join public.games g on g.id = r.game_id where g.title like '${TAG}%');
delete from private.game_title_keys where game_id in (select id from public.games where title like '${TAG}%');
delete from private.catalog_verifications where game_id in (select id from public.games where title like '${TAG}%') or release_id in (select r.id from public.releases r join public.games g on g.id = r.game_id where g.title like '${TAG}%');
delete from public.releases where game_id in (select id from public.games where title like '${TAG}%');
delete from public.game_platforms where game_id in (select id from public.games where title like '${TAG}%');
delete from private.provider_records where import_run_id in (select id from private.import_runs where source_name = '${TAG}.json');
delete from private.import_runs where source_name = '${TAG}.json';
delete from public.games where title like '${TAG}%';
commit;`);
  const deleted = await deleteUsers();
  const all = [...new Set([...deleted, ...users])].map((u) => `'${u}'`).join(",");
  if (all) psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${all}) or target_profile_id in (${all}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'en\\_%';");
  check("nothing is left behind", psql(`select count(*) from public.games where title like '${TAG}%';`) === "0" && psql("select count(*) from public.catalog_change_requests where id in (" + (requests.filter(Boolean).map((r) => `'${r}'`).join(",") || "null") + ");") === "0"
    && psql("select count(*) from private.catalog_record_origins o where not exists (select 1 from public.games g where g.id = o.game_id) and not exists (select 1 from public.releases r where r.id = o.release_id);") === "0"
    && psql("select count(*) from private.catalog_verifications v where not exists (select 1 from public.games g where g.id = v.game_id) and not exists (select 1 from public.releases r where r.id = v.release_id);") === "0"
    && psql("select count(*) from private.audit_events where actor_id is null and action::text like 'catalog_submission%';") === "0" && psql("select count(*) from private.submission_enrichments e left join public.catalog_change_requests s on s.id = e.submission_id where s.id is null;") === "0");
}

console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
