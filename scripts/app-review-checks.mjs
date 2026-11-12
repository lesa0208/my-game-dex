/**
 * M7b-1 end-to-end checks: catalog review in the built app, driven over HTTP against
 * the local stack and its catalog fixture. Forms are submitted the way a browser
 * without JavaScript would, which runs the real pages, Server Actions, session checks
 * and M7b-1 functions. Outcomes are judged by the database and the pages rendered after.
 * Editors are temporary test accounts with temporary staff roles.
 *
 *   npm run build && npm run app:review-checks
 *
 * Local only. Removes every submitted record, test account and the fixture at the end.
 * Prints check names and statuses, never keys, tokens or cookies.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
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
const requests = [];
const count = (sql) => Number(psql(sql));
const status = (id) => psql(`select status from public.catalog_change_requests where id = '${id}';`);

async function account(role) {
  const user = await createUser({ prefix: "rvw" });
  users.push(user.id);
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  const handle = `rw_${randomBytes(5).toString("hex")}`;
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle });
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { ...user, handle, browser };
}

let serial = 0;
/** Submits a missing release of Starfall Odyssey through the app, as a browser would. */
async function submitRelease(owner, extra = {}) {
  serial += 1;
  const page = await owner.browser.get("/submit?game=starfall-odyssey");
  const posted = await owner.browser.submit("/submit?game=starfall-odyssey", formById(page.html, "new-submission"), {
    platform: "snes", media_format: "rom-cartridge", region: "pal", product_code: `QZW-${process.pid}-${serial}`, physical: "on", ...extra,
  });
  const id = location(posted.response).split("/")[2]?.split("?")[0];
  requests.push(id);
  return id;
}
async function decide(editor, id, decision, values) {
  const page = await editor.browser.get(`/review/${id}`);
  const form = formById(page.html, `decision-${decision}`);
  if (!form) return { response: null, form: null };
  const posted = await editor.browser.submit(`/review/${id}`, form, values);
  return { response: posted.response, form };
}
const releaseOf = (id) => psql(`select release_id from public.catalog_change_requests where id = '${id}';`);

try {
  installFixture();
  await startApp(3291);

  section("Who can review");
  const owner = await account();
  const collector = await account();
  const moderator = await account("moderator");
  const editor = await account("catalog_editor");
  const editor2 = await account("catalog_editor");
  const first = await submitRelease(owner, { note: "Bought at a fair" });
  const visitor = new Browser();
  const out = await visitor.get("/review");
  check("a visitor is sent to sign in", isRedirect(out.response) && location(out.response).includes(`next=${encodeURIComponent("/review")}`));
  for (const [name, who] of [["a collector", collector], ["a moderator", moderator]]) {
    const queue = await who.browser.get("/review");
    const one = await who.browser.get(`/review/${first}`);
    // The page streams, so the status is already sent; what matters is what it shows.
    check(`${name} gets the unavailable page, for the queue and a submission`, [queue, one].every((p) => plain(p.html).includes("This page isn't available")
      && !plain(p.html).includes("Review submissions") && !plain(p.html).includes("Bought at a fair") && !plain(p.html).includes("Starfall Odyssey")));
  }
  // The menu's items render only when it opens, so this reads the flag the page sends it.
  check("the account menu offers reviewing to editors only",
    (await editor.browser.get("/home")).html.includes('canReview\\":true') && (await collector.browser.get("/home")).html.includes('canReview\\":false'));

  section("The queue and a review page");
  const queue = await editor.browser.get("/review");
  check("an editor sees the submission, from its submitter's handle", plain(queue.html).includes("Starfall Odyssey") && plain(queue.html).includes(`@${owner.handle}`));
  const page = await editor.browser.get(`/review/${first}`);
  check("the review page shows what was submitted and the record now", plain(page.html).includes("What was submitted") && plain(page.html).includes("The record now") && plain(page.html).includes("Bought at a fair"));
  check("never an email address", !queue.html.includes(owner.email) && !page.html.includes(owner.email) && !page.html.includes("@example.test"));
  check("possible duplicates are listed", plain(page.html).includes("Possible duplicates") && page.html.includes("SNS-ZSFE-USA"));
  check("only starting is offered before the review starts", Boolean(formById(page.html, "decision-start")) && !formById(page.html, "decision-approve") && !formById(page.html, "correct-release"));

  section("Starting, correcting and approving, without JavaScript");
  const started = await decide(editor, first, "start", { reason: "Checking it" });
  check("starting lands on the review page", started.response?.status === 303 && location(started.response) === `/review/${first}?notice=started`);
  check("it's in review", status(first) === "in_review");
  const mine = await owner.browser.get(`/submissions/${first}`);
  check("the submitter sees it in review, and can't change or withdraw it", plain(mine.html).includes("In review") && !formById(mine.html, "edit-submission") && !formById(mine.html, "withdraw-submission"));
  const stale = await editor2.browser.submit(`/review/${first}`, started.form, { reason: "Me too" });
  check("a second start from an old page changes nothing", stale.response.status !== 303 && count(`select count(*) from private.audit_events where action = 'catalog_submission_review_started' and metadata ->> 'request_id' = '${first}';`) === 1);

  let review = await editor.browser.get(`/review/${first}`);
  const correction = formById(review.html, "correct-release");
  check("the review offers corrections and decisions", Boolean(correction) && ["decision-approve", "decision-changes", "decision-reject"].every((f) => formById(review.html, f)));
  const early = await decide(editor, first, "approve", { reason: "Looks right" });
  check("approving an incomplete release is refused, and says why", early.response?.status !== 303 && status(first) === "in_review");
  const fields = { edition_name: "Standard", edition_kind: "standard", media_count: "1", region_code: "pal", product_code: correction.values?.product_code ?? "", release_year: "" };
  const productCode = psql(`select product_code from public.releases where id = '${releaseOf(first)}';`);
  const corrected = await editor.browser.submit(`/review/${first}`, correction, { ...fields, product_code: productCode, reason: "From the photos" });
  check("a correction is saved", location(corrected.response) === `/review/${first}?notice=corrected`
    && psql(`select edition_name || ' ' || edition_kind || ' ' || media_count from public.releases where id = '${releaseOf(first)}';`) === "Standard standard 1");
  const repeat = await editor.browser.submit(`/review/${first}`, correction, { ...fields, product_code: productCode, edition_name: "Deluxe", reason: "Again" });
  check("a correction from a page read before the last one is refused", repeat.response.status !== 303
    && psql(`select edition_name from public.releases where id = '${releaseOf(first)}';`) === "Standard");
  const approved = await decide(editor, first, "approve", { reason: "Matches the box", note: "Thanks for the photos." });
  check("approving lands on the review page", location(approved.response) === `/review/${first}?notice=approved` && status(first) === "approved");
  check("the release is published", psql(`select status from public.releases where id = '${releaseOf(first)}';`) === "published");
  const theirs = await owner.browser.get(`/submissions/${first}`);
  check("the submitter sees it published, with the note and a link", plain(theirs.html).includes("Published") && plain(theirs.html).includes("Thanks for the photos.") && plain(theirs.html).includes("See it in the catalog"));
  check("but not who reviewed it", !plain(theirs.html).includes(editor.handle));
  check("they have a notification", count(`select count(*) from public.notifications where recipient_id = '${owner.id}' and type = 'catalog_submission' and data ->> 'status' = 'published';`) === 1);
  check("and anyone can find the release", (await visitor.get("/games/starfall-odyssey")).html.includes(productCode));

  section("Asking for changes, and answering them");
  const second = await submitRelease(owner);
  await decide(editor, second, "start", { reason: "Checking it" });
  const noNote = await decide(editor, second, "changes", { reason: "Needs the edition", note: "" });
  check("asking for changes needs a note", noNote.response?.status !== 303 && status(second) === "in_review");
  await decide(editor, second, "changes", { reason: "Needs the edition", note: "Which edition is it?" });
  check("it goes back to the submitter", status(second) === "changes_requested");
  let back = await owner.browser.get(`/submissions/${second}`);
  check("who reads the note and can change it", plain(back.html).includes("The editors asked for changes") && plain(back.html).includes("Which edition is it?") && Boolean(formById(back.html, "edit-submission")));
  await owner.browser.submit(`/submissions/${second}`, formById(back.html, "edit-submission"), { media_format: "rom-cartridge", region: "pal", edition_name: "Players Choice", note: "It's the Players Choice one" });
  check("their change is saved", psql(`select edition_name from public.releases where id = '${releaseOf(second)}';`) === "Players Choice");
  back = await owner.browser.get(`/submissions/${second}`);
  const sentBack = await owner.browser.submit(`/submissions/${second}`, formById(back.html, "resubmit-submission"), {});
  check("sending it back reopens the same submission", location(sentBack.response) === `/submissions/${second}?notice=resubmitted` && status(second) === "open");

  section("Rejecting, and resubmitting");
  await decide(editor, second, "start", { reason: "Again" });
  await decide(editor, second, "reject", { reason: "No such edition", note: "We couldn't confirm this edition." });
  check("it's rejected", status(second) === "rejected");
  const rejected = await owner.browser.get(`/submissions/${second}`);
  check("the submitter reads why, and can resubmit", plain(rejected.html).includes("Why it wasn't approved") && plain(rejected.html).includes("We couldn't confirm this edition.") && Boolean(formById(rejected.html, "resubmit-submission")));
  const again = await owner.browser.submit(`/submissions/${second}`, formById(rejected.html, "resubmit-submission"), { note: "Photo of the spine attached" });
  const third = location(again.response).split("/")[2]?.split("?")[0];
  requests.push(third);
  check("resubmitting makes a new, linked submission", third && third !== second && status(third) === "open"
    && psql(`select previous_request_id from public.catalog_change_requests where id = '${third}';`) === second);
  check("which links back to the rejected one", (await owner.browser.get(`/submissions/${third}`)).html.includes(`href="/submissions/${second}"`));
  check("and editors see both rounds", plain((await editor.browser.get(`/review/${third}`)).html).includes("Earlier rounds"));

  section("No self-review, and a deleted submitter");
  const own = await submitRelease(editor);
  const ownPage = await editor.browser.get(`/review/${own}`);
  check("an editor's own submission offers them no decisions", plain(ownPage.html).includes("You submitted this, so another editor has to review it.") && !formById(ownPage.html, "decision-start"));
  const forged = await editor.browser.submit(`/review/${own}`, started.form, { request_id: own, version: psql(`select version from public.catalog_change_requests where id = '${own}';`), reason: "Mine" });
  check("and a forged start is refused", forged.response.status !== 303 && status(own) === "open");
  const leaving = await account();
  const orphan = await submitRelease(leaving);
  psql(`delete from auth.users where id = '${leaving.id}';`);
  await decide(editor, orphan, "start", { reason: "Checking it" });
  const orphanPage = await editor.browser.get(`/review/${orphan}`);
  check("a submission from a deleted account says so, and can't be sent back", plain(orphanPage.html).includes("A deleted account") && plain(orphanPage.html).includes("The submitter's account was deleted")
    && !formById(orphanPage.html, "decision-changes") && Boolean(formById(orphanPage.html, "decision-reject")));

  section("Nothing reaches the browser");
  const files = readdirSync(join(root, ".next", "static"), { recursive: true }).filter((f) => String(f).endsWith(".js"));
  const bundle = files.map((f) => readFileSync(join(root, ".next", "static", String(f)), "utf8")).join("\n");
  check("the browser bundle calls no review function directly", !/approve_submission|reject_submission|request_submission_changes|start_submission_review|get_submission_review|update_release/.test(bundle), `${files.length} files`);
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  stopApp();
  const ids = users.map((id) => `'${id}'`).join(",") || "null";
  const subs = requests.filter(Boolean).map((id) => `'${id}'`).join(",") || "null";
  psql(`begin;
delete from public.collection_items where owner_id in (${ids});
create temp table sub_requests on commit drop as select * from public.catalog_change_requests where submitted_by in (${ids}) or id in (${subs});
delete from public.releases where submitted_by in (${ids}) or id in (select release_id from sub_requests);
delete from public.game_platforms where submitted_by in (${ids}) or game_id in (select game_id from sub_requests where created_game);
delete from public.catalog_change_requests where id in (select id from sub_requests);
delete from public.games where submitted_by in (${ids}) or id in (select game_id from sub_requests where created_game);
commit;`);
  const deleted = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'rw\\_%';");
  const all = [...new Set([...deleted, ...users])].map((id) => `'${id}'`).join(",");
  if (all) psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${all}) or target_profile_id in (${all}); commit;`);
  removeFixture();
  check("no submissions, copies, notifications or catalog data are left behind",
    psql("select (select count(*) from public.catalog_change_requests) + (select count(*) from public.collection_items) + (select count(*) from public.games) + (select count(*) from public.releases) + (select count(*) from public.notifications);") === "0");
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
