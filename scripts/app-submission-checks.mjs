/**
 * M7a end-to-end checks: catalog submissions in the built app, driven over HTTP against
 * the local stack and its catalog fixture. Forms are submitted the way a browser
 * without JavaScript would, which runs the real pages, Server Actions, session checks
 * and M7a functions. Outcomes are judged by the database and the pages rendered after.
 *
 *   npm run build && npm run app:submission-checks
 *
 * Local only. Removes every submitted record, test account and the fixture at the end.
 * Prints check names and statuses, never keys, tokens or cookies.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  api,
  appErrorLines,
  Browser,
  check,
  createUser,
  decode,
  deleteUsers,
  formById,
  formWith,
  isRedirect,
  location,
  psql,
  publishableKey,
  readSession,
  results,
  root,
  section,
  signInAs,
  startApp,
  stopApp,
} from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";

const plain = (html) => decode(html.replace(/<[^>]+>/g, ""));
const users = [];
const count = (sql) => Number(psql(sql));

async function collector() {
  const user = await createUser({ prefix: "subm" });
  users.push(user.id);
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `sm_${randomBytes(5).toString("hex")}` });
  return { ...user, browser };
}

const NEW_GAME = { title: "Qzs Comet Rally", game_kind: "game", first_release_year: "", platform: "snes", media_format: "rom-cartridge", region: "pal", physical: "on", piece_label_0: "Instruction manual", piece_kind_0: "insert", note: "Seen at a fair" };

let starfall;

async function signedOut() {
  section("Signed out, and where submitting starts");
  const visitor = new Browser();
  for (const path of ["/submit", "/submissions"]) {
    const { response } = await visitor.get(path);
    check(`${path} sends a visitor to sign in`, isRedirect(response) && location(response).includes(`next=${encodeURIComponent(path)}`));
  }
  const game = await visitor.get("/games/starfall-odyssey");
  check("a game page links to submitting a missing release", game.html.includes('href="/submit?game=starfall-odyssey"'));
  const nothing = await visitor.get("/explore?q=qzsnothinghere");
  check("a search with no results links to submitting a game", nothing.html.includes('href="/submit"'));
}

async function newGame() {
  section("Submitting a new game");
  const owner = await collector();
  const page = await owner.browser.get("/submit");
  const form = formById(page.html, "new-submission");
  check("the form is for a new game, with the required fields", form?.hidden.mode === "game" && ["title", "platform", "media_format", "region", "physical"].every((n) => form.names.includes(n)));
  check("unknown region is a choice", page.html.includes('value="unknown"'));
  check("it says who will see it", plain(page.html).includes("Only you and catalog editors can see it until it's published"));
  const posted = await owner.browser.submit("/submit", form, NEW_GAME);
  const target = location(posted.response);
  check("submitting lands on the submission's page", posted.response.status === 303 && /^\/submissions\/[0-9a-f-]{36}\?notice=submitted$/.test(target), `${posted.response.status} ${target}`);
  const id = target.split("/")[2].split("?")[0];
  check("the game and release are unverified and the submitter's",
    psql(`select g.status || ' ' || r.status || ' ' || (g.submitted_by = '${owner.id}') || ' ' || (r.submitted_by = '${owner.id}') || ' ' || coalesce(g.slug, 'no-slug') from public.catalog_change_requests s join public.releases r on r.id = s.release_id join public.games g on g.id = r.game_id where s.id = '${id}';`)
      === "unverified unverified true true no-slug");
  check("with its listed piece and note", count(`select count(*) from public.release_components c join public.catalog_change_requests s on s.release_id = c.release_id where s.id = '${id}' and c.label = 'Instruction manual';`) === 1
    && psql(`select reason from public.catalog_change_requests where id = '${id}';`) === "Seen at a fair");
  const shown = await owner.browser.get(target);
  const text = plain(shown.html);
  check("the page thanks them and says it's private", text.includes("Submitted. Thank you") && text.includes("Only you and catalog editors can see this submission") && text.includes("Awaiting review"));
  check("and lists it under their submissions", plain((await owner.browser.get("/submissions")).html).includes("Qzs Comet Rally"));
  return { owner, id };
}

async function privacy({ owner, id }) {
  section("Nobody else sees it");
  const someone = await collector();
  const theirs = await someone.browser.get(`/submissions/${id}`);
  check("another collector gets the unavailable page", plain(theirs.html).includes("This submission isn't available") && !plain(theirs.html).includes("Comet Rally"));
  check("and an empty list", plain((await someone.browser.get("/submissions")).html).includes("You haven't submitted anything yet"));
  const visitor = new Browser();
  const search = await visitor.get("/explore?q=comet+rally");
  check("search doesn't show it, to a visitor", !plain(search.html).includes("Comet Rally"));
  check("or to the submitter", !plain((await owner.browser.get("/explore?q=comet+rally")).html).includes("Qzs Comet Rally"));
  const session = readSession(owner.browser).session;
  check("no page contains the session's tokens", !(await owner.browser.get(`/submissions/${id}`)).html.includes(session.access_token));
  const files = readdirSync(join(root, ".next", "static"), { recursive: true }).filter((f) => String(f).endsWith(".js"));
  const bundle = files.map((f) => readFileSync(join(root, ".next", "static", String(f)), "utf8")).join("\n");
  check("the browser bundle calls no submission function directly", !/submit_release|submit_game|update_my_submission|withdraw_my_submission|catalog_submissions/.test(bundle), `${files.length} files`);
}

async function copyOfPending({ owner, id }) {
  section("A copy of the pending release");
  const page = await owner.browser.get(`/submissions/${id}`);
  const add = formWith(page.html, "release_id");
  check("the submission offers to add your copy", Boolean(add));
  await owner.browser.submit(`/submissions/${id}`, add, {});
  const release = psql(`select release_id from public.catalog_change_requests where id = '${id}';`);
  check("the copy is added", count(`select count(*) from public.collection_items where owner_id = '${owner.id}' and release_id = '${release}';`) === 1);
  const list = await owner.browser.get("/collection");
  check("My Collection shows it as awaiting review", plain(list.html).includes("Qzs Comet Rally") && plain(list.html).includes("Awaiting review"));
  const copy = psql(`select id from public.collection_items where owner_id = '${owner.id}' and release_id = '${release}';`);
  check("its page links back to the submission", (await owner.browser.get(`/collection/${copy}`)).html.includes(`href="/submissions/${id}"`));
  const after = await owner.browser.get(`/submissions/${id}`);
  check("while the copy exists, the submission can't be withdrawn", plain(after.html).includes("first remove your copy") && !formById(after.html, "withdraw-submission"));
}

async function missingRelease() {
  section("Submitting a missing release, editing and withdrawing");
  const owner = await collector();
  const page = await owner.browser.get("/submit?game=starfall-odyssey");
  const form = formById(page.html, "new-submission");
  check("the form is for a release of that game", form?.hidden.mode === "release" && form.hidden.game_id === starfall && plain(page.html).includes("A physical release of Starfall Odyssey"));
  const posted = await owner.browser.submit("/submit?game=starfall-odyssey", form, { platform: "snes", media_format: "rom-cartridge", region: "unknown", edition_name: "Players Choice", physical: "on" });
  const id = location(posted.response).split("/")[2]?.split("?")[0];
  check("it's submitted, with the region unknown and unconfirmed",
    psql(`select r.region_code || ' ' || r.region_unknown_confirmed || ' ' || r.game_id from public.catalog_change_requests s join public.releases r on r.id = s.release_id where s.id = '${id}';`) === `unknown false ${starfall}`);

  const shown = await owner.browser.get(`/submissions/${id}`);
  const edit = formById(shown.html, "edit-submission");
  check("an unreviewed submission can be changed", Boolean(edit) && !edit.names.includes("platform"));
  await owner.browser.submit(`/submissions/${id}`, edit, { media_format: "rom-cartridge", region: "pal", edition_name: "Players Choice", packaging: "Cardboard box", note: "Bought new" });
  check("the change is saved", psql(`select r.region_code || ' ' || r.packaging || ' ' || s.reason from public.catalog_change_requests s join public.releases r on r.id = s.release_id where s.id = '${id}';`) === "pal Cardboard box Bought new");
  await owner.browser.submit(`/submissions/${id}`, edit, { media_format: "cd-rom", region: "pal", note: "Wrong" });
  check("a refused change saves nothing", psql(`select reason from public.catalog_change_requests where id = '${id}';`) === "Bought new");

  const before = count(`select count(*) from public.catalog_change_requests where submitted_by = '${owner.id}';`);
  const edition = psql("select edition_name from public.releases where product_code = 'SNS-ZSFE-USA';");
  await owner.browser.submit("/submit?game=starfall-odyssey", form, { platform: "snes", media_format: "rom-cartridge", region: "ntsc-uc", edition_name: edition, product_code: "SNS-ZSFE-USA", physical: "on" });
  check("a release that's already published isn't submitted again", count(`select count(*) from public.catalog_change_requests where submitted_by = '${owner.id}';`) === before);
  await owner.browser.submit("/submit?game=starfall-odyssey", form, { platform: "snes", media_format: "rom-cartridge", region: "pal" });
  check("without the physical confirmation, nothing is submitted", count(`select count(*) from public.catalog_change_requests where submitted_by = '${owner.id}';`) === before);

  const page2 = await owner.browser.get(`/submissions/${id}`);
  const withdraw = formById(page2.html, "withdraw-submission");
  check("the withdrawal confirmation names it", plain(page2.html).includes("This withdraws Starfall Odyssey (SNES · PAL · Players Choice) before review"));
  const withdrawn = await owner.browser.submit(`/submissions/${id}`, withdraw, {});
  check("withdrawing returns to it, marked withdrawn", location(withdrawn.response) === `/submissions/${id}?notice=withdrawn`
    && plain((await owner.browser.get(location(withdrawn.response))).html).includes("Withdrawn"));
  check("its release is removed, the published game isn't", count(`select count(*) from public.catalog_change_requests s join public.releases r on r.id = s.release_id where s.id = '${id}';`) === 0
    && count(`select count(*) from public.games where id = '${starfall}';`) === 1);
  const someone = await collector();
  await someone.browser.submit(`/submissions/${id}`, withdraw, {});
  check("another user's forged withdrawal changes nothing", count(`select count(*) from public.catalog_change_requests where id = '${id}' and status = 'withdrawn';`) === 1);
  return { owner, form };
}

async function hiddenAndLimits({ form }) {
  section("Hidden games, suspended accounts and the limit");
  const user = await collector();
  const hidden = await user.browser.get("/submit?game=hidden-prototype-quest");
  check("an unpublished game isn't offered", plain(hidden.html).includes("That game isn't available") && !formById(hidden.html, "new-submission"));
  const pendingOfOther = psql("select game_id from public.catalog_change_requests where request_type = 'new_game' limit 1;");
  const theirs = await user.browser.get(`/submit?pending=${pendingOfOther}`);
  check("neither is someone else's pending game, which reads the same", plain(theirs.html).includes("That game isn't available"));

  psql(`update public.profiles set account_status = 'suspended' where id = '${user.id}';`);
  const suspended = await user.browser.get("/submit");
  check("a suspended account is told it can't submit", plain(suspended.html).includes("You can't submit right now") && !formById(suspended.html, "new-submission"));
  await user.browser.submit("/submit?game=starfall-odyssey", form, { platform: "snes", media_format: "rom-cartridge", region: "pal", edition_name: "Forged", physical: "on" });
  check("and a submission from an earlier page is refused", count(`select count(*) from public.catalog_change_requests where submitted_by = '${user.id}';`) === 0);
  psql(`update public.profiles set account_status = 'active' where id = '${user.id}';`);

  const { session } = readSession(user.browser);
  for (let i = 0; i < 10; i += 1) {
    await fetch(`${api}/rest/v1/rpc/submit_release`, {
      method: "POST",
      headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_game: starfall, p_platform: "snes", p_media_format: "rom-cartridge", p_region: "pal", p_details: { edition_name: `Limit ${i}` }, p_physical: true }),
    });
  }
  const limited = await user.browser.get("/submit");
  check("after ten in a day, the form says when they can submit again", plain(limited.html).includes("You've reached today's limit") && plain(limited.html).includes("You can submit again after") && !formById(limited.html, "new-submission"));
  check("and so does their list", plain((await user.browser.get("/submissions")).html).includes("You've reached today's limit of 10"));
  await user.browser.submit("/submit?game=starfall-odyssey", form, { platform: "snes", media_format: "rom-cartridge", region: "pal", edition_name: "Eleventh", physical: "on" });
  check("an eleventh from an earlier page is refused", count(`select count(*) from public.catalog_change_requests where submitted_by = '${user.id}';`) === 10);
}

async function regressions() {
  section("The catalog and collection are unchanged");
  const visitor = new Browser();
  check("search still works", (await visitor.get("/explore?q=starfall")).html.includes("Starfall Odyssey"));
  const release = psql("select id from public.releases where product_code = 'SNS-ZSFE-USA';");
  const user = await collector();
  const page = await user.browser.get(`/games/starfall-odyssey?release=${release}`);
  await user.browser.submit(`/games/starfall-odyssey?release=${release}`, formWith(page.html, "release_id"), {});
  check("adding a published release still works", count(`select count(*) from public.collection_items where owner_id = '${user.id}' and release_id = '${release}';`) === 1);
  const picker = await visitor.get(`/games/starfall-odyssey`);
  check("the release picker lists no submitted release", !plain(picker.html).includes("Players Choice") && !plain(picker.html).includes("Limit 3"));
}

try {
  installFixture();
  starfall = psql("select id from public.games where title = 'Starfall Odyssey' and status = 'published';");
  await startApp(3290);
  await signedOut();
  const first = await newGame();
  await privacy(first);
  await copyOfPending(first);
  const second = await missingRelease();
  await hiddenAndLimits(second);
  await regressions();
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  stopApp();
  const ids = users.map((id) => `'${id}'`).join(",") || "null";
  psql(`begin;
delete from public.collection_items where owner_id in (${ids});
create temp table sub_games on commit drop as select distinct game_id as id from public.catalog_change_requests where submitted_by in (${ids}) and created_game and game_id is not null;
delete from public.releases where submitted_by in (${ids}) or id in (select release_id from public.catalog_change_requests where submitted_by in (${ids}));
delete from public.game_platforms where submitted_by in (${ids});
delete from public.games where id in (select id from sub_games) or submitted_by in (${ids});
delete from public.catalog_change_requests where submitted_by in (${ids});
commit;`);
  const deleted = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'sm\\_%';");
  if (deleted.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${deleted.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${deleted.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  removeFixture();
  check("no submissions, copies or catalog data are left behind",
    psql("select (select count(*) from public.catalog_change_requests) + (select count(*) from public.collection_items) + (select count(*) from public.games) + (select count(*) from public.releases);") === "0");
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
