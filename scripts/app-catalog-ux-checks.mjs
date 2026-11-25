/**
 * M15 catalog UX checks, in the built app over HTTP (no JavaScript, as the harness's browser):
 *   - Catalog records search: the plain GET form still works without JavaScript, with its button
 *     and its filters, finds a game by an alternative title, and says what the page holds.
 *   - A game's page: the essentials first (platform, release dates, developer, publisher, other
 *     titles), its warnings in plain words, its source and licence, what is still unknown, the
 *     review actions in their own section, and the technical details collapsed.
 *   - The submission form: title, platform and region first; everything else optional and
 *     collapsed; a submission with only those (and the format, which a browser without
 *     JavaScript chooses from the full list) succeeds.
 *   - The editor's view of that submission: what was prepared for review (here: still waiting,
 *     since no Wikidata contact is configured, which the page says; the stored lookups themselves
 *     are app-enrichment-checks.mjs's), and decisions with predefined reasons.
 *
 *   npm run build && MGD_TEST_STACK=scratch node scripts/test-stack.mjs run app:catalog-ux-checks
 *
 * Local scratch only. Makes its own game, source record and accounts, and removes them all.
 */
import { randomBytes } from "node:crypto";

import { Browser, appErrorLines, check, createUser, decode, deleteUsers, formById, formWith, location, psql, results, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { stackName } from "./lib/stack.mjs";

if (stackName !== "scratch") {
  console.error("Refusing: run on the disposable scratch stack (MGD_TEST_STACK=scratch node scripts/test-stack.mjs run app:catalog-ux-checks).");
  process.exit(2);
}

const PORT = 3297;
// With the operator's Wikidata contact set, the app looks things up live (read only); without it, it says lookups are off.
const LIVE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+ \([^)]*(@|https?:\/\/)[^)]*\)/.test((process.env.WIKIDATA_USER_AGENT ?? "").trim());
console.log(`Wikidata lookups: ${LIVE ? "live (operator contact set)" : "off (no contact)"}`);
const TAG = `Zqu${randomBytes(3).toString("hex")}`;
const TITLE = `${TAG} Lantern Quest`;
const ALT = `${TAG} Chochin no Bouken`;
const users = [];
const requests = [];
const plain = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

async function account(role) {
  const user = await createUser({ prefix: "uxc", mfa: Boolean(role) });
  users.push(user.id);
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `ux_${randomBytes(5).toString("hex")}` });
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { ...user, browser };
}

/** An imported game as the importer leaves it: under review, a SNES pairing, its source record and title keys. */
function seedImportedGame() {
  return psql(`
with g as (insert into public.games (title, sort_title, kind, status) values ('${TITLE}', '${TITLE}', 'game', 'under_review') returning id),
p as (insert into public.game_platforms (game_id, platform_id, status) select g.id, (select id from public.platforms where slug = 'snes'), 'under_review' from g returning game_id),
r as (insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, finished_at)
      values ('wikidata', (select id from public.platforms where slug = 'snes'), '${TAG}-snapshot.json', repeat('c', 64), now(), 'completed', now()) returning id),
x as (insert into private.external_references (provider_code, external_id, game_id) select 'wikidata', 'Q990000001', g.id from g returning game_id)
insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
select 'wikidata', 'game', 'Q990000001', jsonb_build_object(
  'title', '${TITLE}', 'titles', jsonb_build_array('${TITLE}', '${ALT}'), 'ja_titles', jsonb_build_array('提灯の冒険'),
  'first_release_date', '1993-04-09', 'first_release_precision', 'day',
  'source', jsonb_build_object('revision', 7, 'developers', jsonb_build_array('Q170420'), 'publishers', '[]'::jsonb, 'platforms', jsonb_build_array('Q183259'),
    'release_dates', jsonb_build_array(jsonb_build_object('value', '1993-04-09', 'precision', 'day', 'platforms', jsonb_build_array('Q183259'), 'places', jsonb_build_array('Q17'))),
    'distribution', jsonb_build_array(jsonb_build_object('format', 'Q54820071', 'platforms', '[]'::jsonb, 'distributors', '[]'::jsonb)),
    'external_ids', jsonb_build_object('igdb', jsonb_build_array('a', 'b'), 'mobygames', '[]'::jsonb)),
  'risk_assessment', jsonb_build_object('flags', jsonb_build_array('distribution_non_physical', 'external_ids_multiple'), 'critical', jsonb_build_array('conflicting_identifiers', 'physical_eligibility_unsupported'))),
  repeat('d', 64), r.id, 'promoted', g.id from g, r, p, x
returning matched_game_id;`).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l.trim()))?.trim();
}

let game;
try {
  game = seedImportedGame();
  psql(`select private.import_add_title_keys('${game}', pr) from private.provider_records pr where pr.external_id = 'Q990000001';`);
  await startApp(PORT);
  const editor = await account("catalog_editor");
  const collector = await account();

  section("Catalog records search (no JavaScript)");
  const search = await editor.browser.get(`/admin/catalog/search?kind=games&platform=snes&status=under_review&q=${encodeURIComponent(ALT)}`);
  const searchText = plain(search.html);
  check("the search form still submits without JavaScript: a GET form with a Search button", /<form(?=[^>]*action="\/admin\/catalog\/search")(?=[^>]*method="get")[^>]*>/.test(search.html) && /type="submit"[^>]*>Search</.test(search.html.replace(/<!-- -->/g, "")));
  check("the button hides only once JavaScript takes over", search.html.includes("group-data-[live=on]/live:hidden"));
  check("an alternative title finds the game, with the platform and status filters kept", searchText.includes(TITLE) && /value="snes"[^>]*selected|selected[^>]*value="snes"/.test(search.html));
  check("the results say what the page holds, and for which search", searchText.includes(`1 game matching “${ALT}”, by title`));
  check("a live region is ready for 'Searching…'", /role="status"[^>]*aria-live="polite"/.test(search.html));

  section("A game's page");
  const page = await editor.browser.get(`/admin/catalog/games/${game}`);
  const text = plain(page.html);
  const at = (s) => text.indexOf(s);
  check("warnings come first, in plain words, critical first", at("Warnings (") > 0 && at("Possible error:") > at("Warnings (") && text.includes("Its external ids disagree") && text.includes("only digital releases for this platform"));
  check("the essentials: platform, release date with its market, developer, publisher, other titles", text.includes("Super Nintendo") || text.includes("SNES") ? at("9 Apr 1993") > 0 && text.includes("Q17") && text.includes("Q170420") && /Publisher\s+Not known/.test(text) && text.includes(ALT) && text.includes("提灯の冒険") : false, text.slice(at("The game"), at("The game") + 400));
  check("formats are labelled as a source's claim, digital ones marked", text.includes("digital download (digital)") && text.includes("not evidence of a physical release"));
  check("what is still unknown is listed, never filled in", /Still unknown: [^.]*Publisher[^.]*Physical release/.test(text));
  check("the source, its licence and its import date are shown", text.includes("Wikidata Q990000001") && text.includes("CC0 1.0") && text.includes("imported"));
  if (LIVE) check("with the Wikidata contact, the developer's name comes from Wikidata, with its id", /Developer\s+\S[^Q]*\(Q170420\)/.test(text), text.slice(at("Developer"), at("Developer") + 80));
  else check("without a Wikidata contact, names stay ids and the page says why", text.includes("Names from Wikidata appear once the operator sets the Wikidata contact"));
  check("review actions sit in their own section, after the facts", at("Review actions") > at("The game") && at("Review actions") > at("Physical releases ("));
  check("technical details are collapsed under Advanced details", /<details[^>]*id="advanced"(?![^>]*open)/.test(page.html) && at("Revision") > at("Advanced details") && at("File SHA-256") > at("Advanced details"));
  check("reading the page changed nothing", psql(`select status || ' ' || revision || ' ' || (verified_at is null) from public.games where id = '${game}';`) === "under_review 1 true");
  const other = await collector.browser.get(`/admin/catalog/games/${game}`);
  check("a collector can't open it", !plain(other.html).includes(TITLE));

  section("Submitting a missing game");
  const form = await collector.browser.get(`/submit?title=${encodeURIComponent(`${TAG} Comet Rally`)}`);
  const ftext = form.html;
  const f = formById(ftext, "new-submission");
  const first = (n) => ftext.indexOf(`name="${n}"`);
  check("title, platform and region come first; type and year are inside the optional details", first("title") < first("platform") && first("platform") < first("region") && first("game_kind") > ftext.indexOf("More details") && first("first_release_year") > ftext.indexOf("More details"));
  check("the optional section says it isn't needed", plain(ftext).includes("You don't need any of this"));
  check("the physical-only confirmation is kept", f?.names.includes("physical"));
  const posted = await collector.browser.submit("/submit", f, { title: `${TAG} Comet Rally`, platform: "snes", media_format: "snes-cartridge-jp-pal", region: "pal", physical: "on" });
  const id = location(posted.response).split("/")[2]?.split("?")[0];
  requests.push(id);
  check("a submission with only the title, platform, format and region succeeds, the type defaulting to game", /^[0-9a-f-]{36}$/.test(id ?? "") && psql(`select g.kind from public.catalog_change_requests r join public.games g on g.id = r.game_id where r.id = '${id}';`) === "game");

  section("The editor's view of the submission");
  // M15: the lookup runs after the response and is stored; wait for it when lookups are live.
  for (let i = 0; LIVE && i < 60 && psql(`select status from private.submission_enrichments where submission_id = '${id}';`) === "pending"; i++) await new Promise((r) => setTimeout(r, 250));
  const review = await editor.browser.get(`/admin/catalog/${id}`);
  const rtext = plain(review.html);
  if (LIVE) check("it shows what external sources found: a made-up title has no Wikidata match", rtext.includes("Prepared for review") && rtext.includes("Wikidata has no video game with this title on this platform"));
  else check("it shows what was prepared, and that lookups wait without a Wikidata contact", rtext.includes("Prepared for review") && rtext.includes("external lookups are off until the operator sets the Wikidata contact"));
  if (LIVE) {
    const real = await collector.browser.get("/submit");
    const realPosted = await collector.browser.submit("/submit", formById(real.html, "new-submission"), { title: "Wild Guns", platform: "snes", media_format: "snes-cartridge-jp-pal", region: "pal", physical: "on" });
    const realId = location(realPosted.response).split("/")[2]?.split("?")[0];
    requests.push(realId);
    for (let i = 0; i < 60 && psql(`select status from private.submission_enrichments where submission_id = '${realId}';`) === "pending"; i++) await new Promise((r) => setTimeout(r, 250));
    const realText = plain((await editor.browser.get(`/admin/catalog/${realId}`)).html);
    check("a real title is matched to its Wikidata item, with dates, licence and retrieval time, and nothing chosen", realText.includes("Q682463") && realText.includes("same title") && realText.includes("CC0 1.0") && realText.includes("Retrieved") && /check it's the same game|None is chosen/.test(realText), realText.slice(realText.indexOf("Prepared for review"), realText.indexOf("Prepared for review") + 300));
    check("the lookup changed nothing in the submission", psql(`select status || ' ' || (select title from public.games g where g.id = r.game_id) from public.catalog_change_requests r where r.id = '${realId}';`) === "open Wild Guns");
  }
  check("its decisions offer predefined reasons and an optional comment", review.html.includes('name="reason_choice"') && rtext.includes("Comment (optional, needed for Other)"));
  const start = formById(review.html, "decision-start");
  const started = start ? await editor.browser.submit(`/admin/catalog/${id}`, start, { reason_choice: "Starting the review", reason: "" }) : null;
  check("a chosen reason alone is accepted, and recorded as the editor chose it", Boolean(started) && psql(`select status from public.catalog_change_requests where id = '${id}';`) === "in_review"
    && psql(`select count(*) from private.audit_events where action::text like '%review%' and reason = 'Starting the review' and actor_id = '${editor.id}';`) !== "0");
} finally {
  stopApp();
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
  if (game) {
    psql(`begin; set local session_replication_role = replica;
delete from private.game_title_keys where game_id = '${game}';
delete from private.catalog_record_origins where game_id = '${game}';
delete from private.provider_records where external_id = 'Q990000001';
delete from private.external_references where game_id = '${game}';
delete from private.import_runs where source_name = '${TAG}-snapshot.json';
delete from public.game_platforms where game_id = '${game}';
delete from public.games where id = '${game}';
commit;`);
  }
  const deleted = await deleteUsers();
  const all = [...new Set([...deleted, ...users])].map((u) => `'${u}'`).join(",");
  if (all) psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${all}) or target_profile_id in (${all}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ux\\_%';");
  check("nothing made by these checks is left behind, not even an orphaned provenance row", psql(`select count(*) from public.games where title like 'Zqu%';`) === "0" && psql("select count(*) from private.provider_records where external_id = 'Q990000001';") === "0"
    && psql("select count(*) from private.catalog_record_origins o where not exists (select 1 from public.games g where g.id = o.game_id) and not exists (select 1 from public.releases r where r.id = o.release_id);") === "0");
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
