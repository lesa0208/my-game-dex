/**
 * M14c-3 end-to-end checks: approving and rejecting review batches, and publishing confirmed
 * identities, in the built app over HTTP and in a real browser, against a stack with
 * 20261213100000_m14c3_publication_reads.
 *
 *   npm run build && MGD_TEST_STACK=scratch node scripts/test-stack.mjs run app:publication-checks
 *
 * Everything is synthetic and temporary: five small import runs of fictional games ("Zqp …"),
 * batched by the catalog fixture's editor, reviewed by a throwaway reviewer, and decided by two
 * throwaway approvers, all signed in with their own authenticators. Their decisions are test
 * data, never editorial ones.
 *
 * Batches: M needs two approvals; K is rejected; L is raced (approve against reject); J is
 * approved by its own reviewer, so its members wait for an independent publisher; N stays open
 * for the browser checks.
 *
 * Local only. Refuses every stack but scratch. Removes the fixture, its batches, its games and
 * every test account at the end, and checks nothing is left behind.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { api, appErrorLines, Browser, check, createUser, decode, deleteUsers, formById, forms, isRedirect, location, psql, publishableKey, readSession, results, root, section, signInAs, startApp, stopApp, streamedRedirectTo, verifyBrowser } from "./app-harness.mjs";
import { FIXTURE_EDITOR, installFixture, removeFixture } from "./catalog-fixture.mjs";
import { footprint } from "./lib/footprint.mjs";
import { decodeClaims } from "./lib/mfa-session.mjs";
import { stackName } from "./lib/stack.mjs";

if (stackName !== "scratch") {
  console.error("Refusing: these checks need the M14c-3 migration, which is only on the scratch stack (MGD_TEST_STACK=scratch).");
  process.exit(1);
}

const PORT = 3297;
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;
const EVIDENCE = "Cartridge, box and manual photographed; label and end label match the listing";
const PREFIX = "m14c3-app";

function resolveSegments(html) {
  const segments = new Map([...html.matchAll(/<div hidden id="S:([^"]+)">([\s\S]*?)<\/div><script>(?:(?!<\/script>)[\s\S])*?\$RS\("S:\1"/g)].map((m) => [m[1], m[2]]));
  let out = html;
  for (let i = 0; i < 20 && /<template id="P:[^"]+"><\/template>/.test(out); i += 1) {
    out = out.replace(/<template id="P:([^"]+)"><\/template>/g, (whole, id) => segments.get(id) ?? whole);
  }
  return out;
}
const plain = (html) => decode(resolveSegments(html).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
/** A form on a streamed page, after its segments are resolved. */
const served = (html, id) => formById(resolveSegments(html), id);
const notFound = (page) => page.response.status === 404 || page.html.includes("NEXT_HTTP_ERROR_FALLBACK;404");

// ---------------------------------------------------------------------------
// The fixture: five runs, each frozen in a batch by the fixture editor.
// ---------------------------------------------------------------------------

let saved = null;
const B = {};

function makeRun(tag, titles, flagged = 1) {
  const run = `${PREFIX}-${tag}`;
  const terms = "encode(digest('m14c3-app-terms', 'sha256'), 'hex')";
  const snapshot = `encode(digest(${sql(run)}, 'sha256'), 'hex')`;
  psql(`begin;
insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, status, finished_at, reason)
values ('wikidata', (select id from public.platforms where slug = 'snes'), ${sql(run)}, ${snapshot}, now(), ${terms}, 'completed', now(), 'M14c-3 app checks');
${titles.map((t, k) => {
    const q = `Q73${tag.charCodeAt(0)}${String(k + 1).padStart(3, "0")}`;
    const flags = k < flagged ? ["mul_label_only"] : [];
    const payload = JSON.stringify({ title: t, source: { revision: 100 + k },
      risk_assessment: { contract: "mgd-risk-assessment", version: 1, assessor: "m14c3-app", assessor_version: "1",
        source: { provider: "wikidata", external_id: q, revision: 100 + k, snapshot_sha256: "SNAPSHOT" }, flags, critical: [] } });
    return `
with g as (insert into public.games (title, sort_title, kind, status, first_release_date, first_release_precision)
           values (${sql(t)}, ${sql(t)}, 'game', 'under_review', '1995-01-01'::date + ${k}, 'day') returning id),
     gp as (insert into public.game_platforms (game_id, platform_id, status) select g.id, (select id from public.platforms where slug = 'snes'), 'under_review' from g returning game_id),
     pr as (insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
            select 'wikidata', 'game', ${sql(q)}, replace(${sql(payload)}, 'SNAPSHOT', ${snapshot})::jsonb, encode(digest(${sql(`${run}-${k}`)}, 'sha256'), 'hex'),
                   (select id from private.import_runs where source_name = ${sql(run)}), 'promoted', g.id from g returning id)
insert into private.import_run_records (import_run_id, provider_record_id, position) select (select id from private.import_runs where source_name = ${sql(run)}), pr.id, ${k} from pr;`;
  }).join("")}
commit;`);
  const runId = psql(`select id from private.import_runs where source_name = ${sql(run)};`);
  const snes = psql("select id from public.platforms where slug = 'snes';");
  psql(`begin;
update auth.mfa_amr_claims set created_at = now(), updated_at = now() where session_id = '${FIXTURE_EDITOR}';
select set_config('request.jwt.claims', jsonb_build_object('sub', '${FIXTURE_EDITOR}', 'role', 'authenticated', 'aal', 'aal2', 'session_id', '${FIXTURE_EDITOR}')::text, true);
set local role authenticated;
select public.create_review_batch(${sql(runId)}, ${sql(snes)}, 'M14c-3 app checks');
reset role;
commit;`);
  B[tag] = psql(`select b.id from private.catalog_review_batches b where b.import_run_id = ${sql(runId)};`);
}

function setup() {
  saved = {
    policy: psql("select row_to_json(p)::text from private.catalog_review_policy p;"),
    provider: psql("select row_to_json(p)::text from private.external_providers p where code = 'wikidata';"),
  };
  psql(`begin;
update private.catalog_review_policy set tolerable_error = 0.45, confidence = 0.8;
select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', encode(digest('m14c3-app-terms', 'sha256'), 'hex'), 'M14c-3 app checks');
commit;`);
  psql("update private.catalog_review_policy set second_approval_above = 1;");
  makeRun("m", ["Zqp Multi A", "Zqp Multi B", "Zqp Multi C", "Zqp Multi D", "Zqp Multi E"]);
  makeRun("p", ["Zqp Pair A", "Zqp Pair B", "Zqp Pair C"]);
  psql(`update private.catalog_review_policy set second_approval_above = ${JSON.parse(saved.policy).second_approval_above};`);
  makeRun("k", ["Zqp Kept A", "Zqp Kept B", "Zqp Kept C"]);
  makeRun("l", ["Zqp Race A", "Zqp Race B", "Zqp Race C"]);
  makeRun("j", ["Zqp Judge A", "Zqp Judge B", "Zqp Judge C", "Zqp Judge D", "Zqp Judge E", "Zqp Judge F"], 2);
  makeRun("n", ["Zqp Next A", "Zqp Next B", "Zqp Next C"]);
}

function cleanup() {
  const games = "(select id from public.games where title like 'Zqp %')";
  const runs = `(select id from private.import_runs where source_name like '${PREFIX}-%')`;
  const batches = `(select id from private.catalog_review_batches where import_run_id in ${runs})`;
  psql(`begin;
set local session_replication_role = replica;
delete from private.audit_events where reason in ('M14c-3 app checks', 'Approved in the app checks', 'Rejected in the app checks', 'Published in the app checks')
  or metadata ->> 'batch_id' in (select id::text from ${batches}) or metadata ->> 'game_id' in (select id::text from ${games}) or metadata ->> 'id' in (select id::text from ${games});
delete from private.catalog_review_batch_approvals where batch_id in ${batches};
delete from private.catalog_review_batch_items where batch_id in ${batches};
delete from private.catalog_review_batches where id in ${batches};
delete from private.import_run_records where import_run_id in ${runs};
delete from private.provider_records where import_run_id in ${runs};
delete from private.import_runs where id in ${runs};
delete from private.catalog_pairing_origins where game_id in ${games};
delete from private.catalog_verifications where game_id in ${games};
delete from private.catalog_record_origins where game_id in ${games};
delete from public.game_platforms where game_id in ${games};
delete from public.games where title like 'Zqp %';
${saved ? `update private.catalog_review_policy p set (tolerable_error, confidence, acceptance_number, second_approval_above, updated_at) =
  (select tolerable_error, confidence, acceptance_number, second_approval_above, updated_at from json_populate_record(null::private.catalog_review_policy, ${sql(saved.policy)}));
update private.external_providers p set (name, terms_url, terms_sha256, terms_reviewed_at, commercial_use_cleared, cleared_note, created_at, updated_at, rights_survive_withdrawal, rights_terms_sha256, rights_note, rights_recorded_at) =
  (select name, terms_url, terms_sha256, terms_reviewed_at, commercial_use_cleared, cleared_note, created_at, updated_at, rights_survive_withdrawal, rights_terms_sha256, rights_note, rights_recorded_at
   from json_populate_record(null::private.external_providers, ${sql(saved.provider)}))
where code = 'wikidata';` : ""}
commit;`);
}

// ---------------------------------------------------------------------------
// People and helpers.
// ---------------------------------------------------------------------------

const people = {};
async function person(prefix, role) {
  const user = await createUser({ prefix, mfa: Boolean(role) });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", forms(welcome.html).find((f) => f.names.includes("handle")), { handle: `pq_${randomBytes(5).toString("hex")}` });
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { ...user, browser };
}
async function rpc(owner, name, body) {
  const headers = { apikey: publishableKey, "Content-Type": "application/json" };
  if (owner) headers.Authorization = `Bearer ${readSession(owner.browser).session.access_token}`;
  const response = await fetch(`${api}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}
function staleMfa(user) {
  const sessionId = decodeClaims(readSession(user.browser).session.access_token).session_id;
  psql(`update auth.mfa_amr_claims set updated_at = now() - interval '11 minutes' where session_id = '${sessionId}';`);
}
/** Posts a served form as a browser without JavaScript would: only fields the page has. */
function post(browser, path, form, fields) {
  const missing = Object.keys(fields).filter((name) => !form.names.includes(name) && !(name in form.hidden));
  if (missing.length) throw new Error(`the served form has no ${missing.join(", ")} field`);
  return browser.submit(path, form, fields);
}
const batchPath = (tag) => `/admin/catalog/batches/${B[tag]}`;
const prefix = (tag) => B[tag].slice(0, 8);
const status = (tag) => psql(`select status from private.catalog_review_batches where id = '${B[tag]}';`);
const approvals = (tag) => psql(`select count(*) from private.catalog_review_batch_approvals where batch_id = '${B[tag]}';`);
const game = (title) => psql(`select id from public.games where title = ${sql(title)};`);
const pairing = (title) => psql(`select g.status || '/' || gp.status || '/' || (gp.verified_at is not null) from public.games g join public.game_platforms gp on gp.game_id = g.id where g.title = ${sql(title)};`);
const audit = (action, tag) => psql(`select count(*) from private.audit_events where action = '${action}' and metadata ->> 'batch_id' = '${B[tag]}';`);
/** The reviewer records "correct", with evidence, for every member that needs an outcome. */
async function reviewAll(tag) {
  const ids = psql(`select string_agg(game_id::text, ',' order by game_id) from private.catalog_review_batch_items where batch_id = '${B[tag]}' and (sampled or cardinality(flags) > 0);`).split(",").filter(Boolean);
  for (const id of ids) await rpc(people.reviewer, "record_batch_outcome", { p_batch: B[tag], p_game: id, p_outcome: "correct", p_critical_error: null, p_note: EVIDENCE });
  return ids.length;
}
const correct = (tag) => Number(psql(`select count(*) from private.catalog_review_batch_items where batch_id = '${B[tag]}' and outcome = 'correct';`));
const identityOnly = (tag) => Number(psql(`select count(*) from private.catalog_review_batch_items where batch_id = '${B[tag]}' and outcome is null and not sampled and cardinality(flags) = 0;`));

// ---------------------------------------------------------------------------

async function emptyQueue() {
  section("The publication queue, empty");
  const page = await people.a1.browser.get("/admin/catalog/publication");
  const text = plain(page.html);
  check("staff can open it", page.response.status === 200 && text.includes("Publication queue"));
  check("with nothing ready, it says so", text.includes("No confirmed identity is waiting for publication."));
  check("it explains that confirming and publishing take two editors", text.includes("Confirming and publishing take two editors"));
  check("the catalog page links to it", resolveSegments((await people.a1.browser.get("/admin/catalog")).html).includes('href="/admin/catalog/publication"'));
}

async function twoApprovals() {
  section("A batch that needs two approvals");
  const a1 = people.a1;
  const reviewed = await reviewAll("m");
  check("the batch needs two approvals, and its members are reviewed (setup)", psql(`select required_approvals from private.catalog_review_batches where id = '${B.m}';`) === "2" && reviewed > 0);
  const page = await a1.browser.get(batchPath("m"));
  const text = plain(page.html);
  check("the page shows the approvals so far and that this one wouldn't be final",
    text.includes("0 of 2 approvals recorded.") && text.includes("Your approval would be recorded and the batch would stay open"));
  check("it predicts each member's effect, and labels the prediction as one", text.includes(`Confirmed at the final approval: ${correct("m")}`) && text.includes("A prediction, as the database assesses it now"));
  check("it shows the right to publish, and that no release is ever made", text.includes("Right to publish: Wikidata cleared") && text.includes("No approval creates, verifies or publishes a physical release"));
  const form = served(page.html, "approve-batch");
  check("the approval form carries what the page showed, and asks for a reason, the prefix and an acknowledgement",
    Boolean(form) && form.hidden.seen_approvals === "0" && ["reason", "confirm_id", "acknowledge"].every((n) => form.names.includes(n)) && text.includes("Record my approval"));
  const wrong = await post(a1.browser, batchPath("m"), form, { reason: "Approved in the app checks", confirm_id: "00000000", acknowledge: "on" });
  check("a wrong prefix records nothing, and says why", approvals("m") === "0" && location(wrong.response).endsWith("?error=confirm_id"));
  const unack = await post(a1.browser, batchPath("m"), form, { reason: "Approved in the app checks", confirm_id: prefix("m") });
  check("nor does a missing acknowledgement", approvals("m") === "0" && location(unack.response).endsWith("?error=acknowledge"));
  const ok = await post(a1.browser, batchPath("m"), form, { reason: "Approved in the app checks", confirm_id: prefix("m"), acknowledge: "on" });
  check("the first approval is recorded, and the batch stays open", approvals("m") === "1" && status("m") === "open" && location(ok.response).includes("notice=approval_recorded&approvals=1&required=2"));
  const after = plain((await a1.browser.get(location(ok.response))).html);
  check("the page says 1 of 2, and that nothing is verified or published yet", after.includes("Your approval is recorded: 1 of 2 approvals. The batch is still open"), `${location(ok.response)} :: ${after.slice(after.indexOf("Review batch"), after.indexOf("Review batch") + 300)}`);
  check("nothing of it is verified or published", psql(`select count(*) from public.games where title like 'Zqp Multi %' and (verified_at is not null or status = 'published');`) === "0");
  const again = await post(a1.browser, batchPath("m"), form, { reason: "Approved in the app checks", confirm_id: prefix("m"), acknowledge: "on" });
  check("the same form sent again records nothing (the page is out of date)", approvals("m") === "1" && location(again.response).endsWith("?error=changed"));
  check("the first approver now gets no approval form", after.includes("You have already approved it; it needs another approver.") && !served((await a1.browser.get(batchPath("m"))).html, "approve-batch"));
  const direct = await rpc(a1, "approve_review_batch", { p_batch: B.m, p_reason: "Approved in the app checks" });
  check("and the database refuses a second approval from them directly", direct.status >= 400 && direct.text.includes("already approved") && approvals("m") === "1");
  const locked = await rpc(people.reviewer, "record_batch_outcome", { p_batch: B.m, p_game: game("Zqp Multi A"), p_outcome: "excluded", p_critical_error: null, p_note: null });
  check("outcomes are locked once an approval is recorded", locked.status >= 400 && locked.text.includes("batch approval started"));

  const a2 = people.a2;
  const p2 = await a2.browser.get(batchPath("m"));
  const t2 = plain(p2.html);
  check("for the second approver, the approval would be final, and publish the members found correct",
    t2.includes("1 of 2 approvals recorded.") && t2.includes("Your approval would be the final one") && t2.includes(`Confirmed and published: ${correct("m")}`) && t2.includes("Approve and publish"));
  const final = await post(a2.browser, batchPath("m"), served(p2.html, "approve-batch"), { reason: "Approved in the app checks", confirm_id: prefix("m"), acknowledge: "on" });
  const target = location(final.response);
  check("the final approval approves the batch", status("m") === "approved" && approvals("m") === "2");
  check("and reports what it did, as the database returned it",
    target.includes(`notice=approved&published=${correct("m")}&awaiting_evidence=${identityOnly("m")}&awaiting_publication=0`), target);
  check("the members found correct are public; the others only verified as identities",
    psql(`select count(*) from public.games where title like 'Zqp Multi %' and status = 'published';`) === String(correct("m"))
      && psql(`select count(*) from public.game_platforms gp join private.catalog_review_batch_items i on i.game_id = gp.game_id and i.platform_id = gp.platform_id where i.batch_id = '${B.m}' and i.outcome is null and (gp.status = 'published' or gp.verified_at is not null);`) === "0");
  check("both approvals are audited", audit("catalog_batch_approval_recorded", "m") === "1" && audit("catalog_batch_approved", "m") === "1");
  const closed = plain((await a2.browser.get(batchPath("m"))).html);
  check("an approved batch offers no approval or rejection", !closed.includes("Approve the batch") && !closed.includes("Reject the batch"));
  check("and no physical release was created", psql(`select count(*) from public.releases r join public.games g on g.id = r.game_id where g.title like 'Zqp %';`) === "0");
}

async function rejection() {
  section("Rejecting a batch");
  const a1 = people.a1;
  const page = await a1.browser.get(batchPath("k"));
  const text = plain(page.html);
  check("rejection is offered, apart, and says it is final and deletes nothing",
    text.includes("Reject the batch") && text.includes("Rejection is final for this batch") && text.includes("nothing is deleted"));
  const form = served(page.html, "reject-batch");
  // A stale page: an outcome is recorded after the page was read.
  await rpc(people.reviewer, "record_batch_outcome", { p_batch: B.k, p_game: psql(`select game_id from private.catalog_review_batch_items where batch_id = '${B.k}' and (sampled or cardinality(flags) > 0) order by game_id limit 1;`), p_outcome: "correct", p_critical_error: null, p_note: EVIDENCE });
  const stale = await post(a1.browser, batchPath("k"), form, { reason: "Rejected in the app checks", confirm_id: prefix("k"), acknowledge: "on" });
  check("a page read before an outcome was recorded rejects nothing", status("k") === "open" && location(stale.response).endsWith("?error=changed"));
  const fresh = served((await a1.browser.get(batchPath("k"))).html, "reject-batch");
  const wrong = await post(a1.browser, batchPath("k"), fresh, { reason: "Rejected in the app checks", confirm_id: prefix("m"), acknowledge: "on" });
  check("another batch's prefix rejects nothing", status("k") === "open" && location(wrong.response).endsWith("?error=confirm_id"));
  const ok = await post(a1.browser, batchPath("k"), fresh, { reason: "Rejected in the app checks", confirm_id: prefix("k"), acknowledge: "on" });
  check("rejected, with its notice", status("k") === "rejected" && location(ok.response).endsWith("?notice=rejected"));
  check("its games and source records are kept, in review",
    psql("select count(*) from public.games where title like 'Zqp Kept %' and status = 'under_review';") === "3"
      && psql(`select count(*) from private.provider_records where import_run_id = (select import_run_id from private.catalog_review_batches where id = '${B.k}');`) === "3");
  const again = await rpc(a1, "reject_review_batch", { p_batch: B.k, p_reason: "Rejected in the app checks" });
  check("a rejected batch can't be rejected again", again.status >= 400 && audit("catalog_batch_rejected", "k") === "1");
}

async function race() {
  section("Approving and rejecting at once");
  await reviewAll("l");
  const [pa, pr] = await Promise.all([people.a1.browser.get(batchPath("l")), people.a2.browser.get(batchPath("l"))]);
  const fa = served(pa.html, "approve-batch");
  const fr = served(pr.html, "reject-batch");
  const [ra, rr] = await Promise.all([
    post(people.a1.browser, batchPath("l"), fa, { reason: "Approved in the app checks", confirm_id: prefix("l"), acknowledge: "on" }),
    post(people.a2.browser, batchPath("l"), fr, { reason: "Rejected in the app checks", confirm_id: prefix("l"), acknowledge: "on" }),
  ]);
  const s = status("l");
  const decisions = Number(audit("catalog_batch_approved", "l")) + Number(audit("catalog_batch_rejected", "l"));
  check("exactly one decision wins, and the batch is in exactly that state", (s === "approved" || s === "rejected") && decisions === 1, `${s} ${decisions}`);
  const loser = s === "approved" ? location(rr.response) : location(ra.response);
  check("and the other editor is told nothing was changed", /\?error=(unavailable|changed)$/.test(loser), loser);

  // Two approvers who each saw no approval on a batch needing two: only one is recorded; the
  // other is told it changed, so nobody makes the final, publishing approval without seeing it.
  await reviewAll("p");
  const [p1, p2] = await Promise.all([people.a1.browser.get(batchPath("p")), people.a2.browser.get(batchPath("p"))]);
  const [r1, r2] = await Promise.all([
    post(people.a1.browser, batchPath("p"), served(p1.html, "approve-batch"), { reason: "Approved in the app checks", confirm_id: prefix("p"), acknowledge: "on" }),
    post(people.a2.browser, batchPath("p"), served(p2.html, "approve-batch"), { reason: "Approved in the app checks", confirm_id: prefix("p"), acknowledge: "on" }),
  ]);
  const both = [location(r1.response), location(r2.response)];
  check("two approvers at once on a batch needing two: one approval is recorded, the batch stays open, nothing is published",
    approvals("p") === "1" && status("p") === "open" && psql("select count(*) from public.games where title like 'Zqp Pair %' and (status = 'published' or verified_at is not null);") === "0", both.join(" | "));
  check("and the other is told the batch changed", both.filter((l) => l.includes("notice=approval_recorded")).length === 1 && both.filter((l) => l.endsWith("?error=changed")).length === 1, both.join(" | "));
  const published = psql("select count(*) from public.games where title like 'Zqp Race %' and status = 'published';");
  check("and the games follow it: published only if it was approved", s === "approved" ? published === String(correct("l")) : published === "0", `${s} ${published}`);
}

async function stepUp() {
  section("A stale authenticator check");
  const a1 = people.a1;
  await reviewAll("n");
  const form = served((await a1.browser.get(batchPath("n"))).html, "approve-batch");
  staleMfa(a1);
  const page = plain((await a1.browser.get(batchPath("n"))).html);
  check("the batch page asks for a fresh verification instead of the forms", page.includes("Approving needs a recent verification") && page.includes("Rejecting needs a recent verification") && !page.includes("Approve and publish"));
  const posted = await post(a1.browser, batchPath("n"), form, { reason: "Approved in the app checks", confirm_id: prefix("n"), acknowledge: "on" });
  const target = location(posted.response);
  check("a form sent anyway decides nothing, and goes to verification, coming back to the batch",
    status("n") === "open" && approvals("n") === "0" && target.includes("/settings/security/verify") && decodeURIComponent(target).includes(batchPath("n")), target);
  const verified = await verifyBrowser(a1.browser, a1, batchPath("n"));
  check("after verifying, the editor is back on the batch, with nothing submitted for them",
    ((isRedirect(verified.response) && location(verified.response).includes(batchPath("n"))) || streamedRedirectTo(verified.html, batchPath("n"))) && status("n") === "open" && approvals("n") === "0");
}

async function publication() {
  section("Independent publication");
  await reviewAll("j");
  // The reviewer approves their own batch: the members they confirmed wait for someone else.
  const approved = await rpc(people.reviewer, "approve_review_batch", { p_batch: B.j, p_reason: "Approved in the app checks" });
  check("approved by its reviewer: nothing is published, the confirmed members wait (setup)",
    approved.status === 200 && JSON.parse(approved.text).published === 0 && JSON.parse(approved.text).awaiting_independent_publication === correct("j"));
  const ready = psql(`select string_agg(g.id::text || '|' || g.title, ',' order by g.title) from private.catalog_review_batch_items i join public.games g on g.id = i.game_id where i.batch_id = '${B.j}' and i.outcome = 'correct';`)
    .split(",").map((x) => ({ id: x.split("|")[0], title: x.split("|")[1] }));
  people.ready = ready;
  const q = plain((await people.a1.browser.get("/admin/catalog/publication")).html);
  check("the queue lists them as ready, for an editor who may publish them", ready.every((r) => q.includes(`${r.title} · Super Nintendo Entertainment System`)) && q.includes("You may publish it."));
  const qr = plain((await people.reviewer.browser.get("/admin/catalog/publication")).html);
  check("and tells the reviewer who confirmed them that another editor publishes them", qr.includes("You confirmed its evidence, so another editor publishes it."));
  const waiting = plain((await people.a1.browser.get("/admin/catalog/publication?state=awaiting_evidence")).html);
  check("unsampled members wait for physical evidence, and can't be published", waiting.includes("Awaiting physical evidence") && waiting.includes("physical existence not confirmed"));

  const asReviewer = await people.reviewer.browser.get(`/admin/catalog/games/${ready[0].id}`);
  const rt = plain(asReviewer.html);
  check("on the game record, the reviewer gets no publish form, and is told why",
    rt.includes("Identity publication") && rt.includes("Ready, for another editor. You confirmed its evidence") && !served(asReviewer.html, "publish-identity"));
  const own = await rpc(people.reviewer, "publish_game_identity", { p_game: ready[0].id, p_platforms: [psql("select id from public.platforms where slug = 'snes';")], p_reason: "Published in the app checks", p_expected_revision: Number(psql(`select revision from public.games where id = '${ready[0].id}';`)) });
  check("and the database refuses them directly", own.status >= 400 && own.text.includes("own record") && pairing(ready[0].title) === "under_review/under_review/true");

  const page = await people.a1.browser.get(`/admin/catalog/games/${ready[0].id}`);
  const form = served(page.html, "publish-identity");
  const text = plain(page.html);
  check("an independent editor gets the form: the platform unticked, a reason and a confirmation",
    Boolean(form) && form.names.includes("platform") && form.names.includes("reason") && form.names.includes("confirm") && !/name="platform"[^>]*checked/.test(resolveSegments(page.html)));
  check("with the evidence, who confirmed it, and that an identity is never a release",
    text.includes(`“${EVIDENCE}”`) && text.includes("Ready: you may publish it.") && text.includes("It never creates an edition, region, format, box, cartridge, disc or product code."));
  const none = await post(people.a1.browser, `/admin/catalog/games/${ready[0].id}`, form, { reason: "Published in the app checks", confirm: "on" });
  check("nothing ticked publishes nothing", pairing(ready[0].title).startsWith("under_review/") && location(none.response).includes("error=choose"));
  const forged = await people.a1.browser.submit(`/admin/catalog/games/${ready[0].id}`, form, { platform: "nes", reason: "Published in the app checks", confirm: "on" });
  check("a platform the page didn't offer is refused", pairing(ready[0].title).startsWith("under_review/") && location(forged.response).includes("error=not_eligible"));
  const unconfirmed = await post(people.a1.browser, `/admin/catalog/games/${ready[0].id}`, form, { platform: "snes", reason: "Published in the app checks" });
  check("nor without the confirmation", pairing(ready[0].title).startsWith("under_review/") && location(unconfirmed.response).includes("error=confirm"));
  // A stale page: the game changed after the page was read.
  const staleForm = served((await people.a1.browser.get(`/admin/catalog/games/${ready[1].id}`)).html, "publish-identity");
  psql(`update public.games set revision = revision + 1 where id = '${ready[1].id}';`);
  const stale = await post(people.a1.browser, `/admin/catalog/games/${ready[1].id}`, staleForm, { platform: "snes", reason: "Published in the app checks", confirm: "on" });
  check("a page read before the game changed publishes nothing", pairing(ready[1].title).startsWith("under_review/") && location(stale.response).includes("error=changed"));
  const shown = plain((await people.a1.browser.get(`/admin/catalog/games/${ready[1].id}?error=changed`)).html);
  check("which the page says, as an alert", shown.includes("Nothing was published. This game changed since you opened it"));

  // Evidence confirmed again after the page was read: same game revision, newer evidence.
  const evidenceForm = served((await people.a1.browser.get(`/admin/catalog/games/${ready[2].id}`)).html, "publish-identity");
  psql(`update public.game_platforms set verified_at = verified_at + interval '1 second', verification_basis = verification_basis || '{"note": "A later note about another copy of the cartridge"}' where game_id = '${ready[2].id}' and platform_id = (select id from public.platforms where slug = 'snes');`);
  const changedEvidence = await post(people.a1.browser, `/admin/catalog/games/${ready[2].id}`, evidenceForm, { platform: "snes", reason: "Published in the app checks", confirm: "on" });
  check("evidence confirmed again after the page was read: nothing is published", pairing(ready[2].title).startsWith("under_review/") && location(changedEvidence.response).includes("error=changed"));

  await people.collector.browser.submit(`/admin/catalog/games/${ready[0].id}`, form, { platform: "snes", reason: "Published in the app checks", confirm: "on" });
  check("a collector posting the editor's form publishes nothing", pairing(ready[0].title).startsWith("under_review/"));
  const published = await post(people.a1.browser, `/admin/catalog/games/${ready[0].id}`, form, { platform: "snes", reason: "Published in the app checks", confirm: "on" });
  check("an independent editor publishes it", pairing(ready[0].title) === "published/published/true" && location(published.response).includes("notice=identity_published"));
  const slug = psql(`select slug from public.games where id = '${ready[0].id}';`);
  const pub = await new Browser().get(`/games/${slug}`);
  check("it is public, as an identity with no verified release", pub.response.status === 200 && plain(pub.html).includes("No verified physical release recorded yet"));
  const publishedQueue = plain((await people.a1.browser.get("/admin/catalog/publication?state=published")).html);
  check("and the queue lists it as published", publishedQueue.includes(`${ready[0].title} · Super Nintendo Entertainment System`));
}

async function outsiders() {
  section("Collectors, visitors and direct calls");
  const c = people.collector;
  for (const path of ["/admin/catalog/publication", batchPath("n")]) {
    const page = await c.browser.get(path);
    check(`a collector gets nothing at ${path.replace(B.n, "<batch>")}`, notFound(page) && !plain(page.html).includes("Zqp"));
  }
  const visitor = await new Browser().get("/admin/catalog/publication");
  check("a visitor is sent to sign in", isRedirect(visitor.response) || visitor.html.includes("/sign-in"));
  const form = served((await people.a2.browser.get(batchPath("n"))).html, "approve-batch");
  await c.browser.submit(batchPath("n"), form, { reason: "Approved in the app checks", confirm_id: prefix("n"), acknowledge: "on" });
  check("a collector posting an editor's approval form decides nothing", status("n") === "open" && approvals("n") === "0");
  for (const [name, body] of [["get_batch_approval_preview", { p_batch: B.n }], ["list_publication_queue", {}], ["approve_review_batch", { p_batch: B.n, p_reason: "x" }], ["reject_review_batch", { p_batch: B.n, p_reason: "x" }]]) {
    const asCollector = await rpc(c, name, body);
    const asVisitor = await rpc(null, name, body);
    check(`neither a collector nor a visitor can call ${name}`, asCollector.status >= 400 && asVisitor.status >= 400);
  }
  check("and the batch is still open", status("n") === "open");
}

// ---------------------------------------------------------------------------
// In a real browser.
// ---------------------------------------------------------------------------

let browserApp = null;
async function context(user, viewport = { width: 1280, height: 900 }) {
  const ctx = await browserApp.newContext({ viewport, colorScheme: "dark" });
  if (user) await ctx.addCookies([...user.browser.cookies].map(([n, value]) => ({ name: n, value, url: `http://127.0.0.1:${PORT}` })));
  return ctx;
}

async function inBrowser() {
  section("In a real browser");
  const { chromium } = createRequire(join(root, "package.json"))("playwright-core");
  for (const channel of [process.env.A11Y_BROWSER, "msedge", "chrome"].filter(Boolean)) {
    try {
      browserApp = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // Try the next one.
    }
  }
  check("a browser (Edge or Chrome) started", Boolean(browserApp));
  if (!browserApp) return;
  const a2 = people.a2;
  const target = people.ready[2] ?? people.ready[0];

  // Publishing with the keyboard only.
  const ctx = await context(a2);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/admin/catalog/games/${target.id}`, { waitUntil: "networkidle" });
  await page.locator('#publish-identity input[name="platform"]').first().focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  check("Tab moves from the platform to the reason", await page.evaluate(() => document.activeElement?.getAttribute("name") === "reason"));
  await page.keyboard.type("Published in the app checks");
  await page.keyboard.press("Tab");
  check("and on to the confirmation", await page.evaluate(() => document.activeElement?.getAttribute("name") === "confirm"));
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
  // The box is required: the browser itself refuses the form, says why, and sends nothing.
  check("without the confirmation, the browser refuses the form, and nothing is published",
    (await page.evaluate(() => document.querySelector('#publish-identity input[name="confirm"]')?.validity.valueMissing === true)) && !page.url().includes("notice=") && pairing(target.title).startsWith("under_review/"));
  await page.locator('#publish-identity input[name="confirm"]').focus();
  await page.keyboard.press("Space");
  await page.locator('#publish-identity button[type="submit"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/notice=identity_published/, { timeout: 15000 }).catch(() => {});
  check("with it, published, and the page says so", page.url().includes("notice=identity_published") && pairing(target.title) === "published/published/true"
    && (await page.locator('[role="status"]').allTextContents()).join(" ").includes("Published as an identity."));
  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();

  const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  for (const [name, path, user] of [
    ["publication queue", "/admin/catalog/publication", a2],
    ["publication queue, awaiting evidence", "/admin/catalog/publication?state=awaiting_evidence", a2],
    ["publication queue, nothing here", "/admin/catalog/publication?state=verifier_gone", a2],
    ["batch with approval and rejection forms", batchPath("n"), a2],
    ["batch after the first of two approvals", `${batchPath("n")}?notice=approval_recorded&approvals=1&required=2`, a2],
    ["approved batch", `${batchPath("m")}?notice=approved&published=1&awaiting_evidence=2&awaiting_publication=0`, a2],
    ["game record with the publish form", `/admin/catalog/games/${(people.ready[3] ?? people.ready[1]).id}`, a2],
    ["game record, publication error", `/admin/catalog/games/${(people.ready[3] ?? people.ready[1]).id}?error=own_record`, a2],
  ]) {
    for (const viewport of [{ tag: "phone", width: 390, height: 844 }, { tag: "desktop", width: 1280, height: 900 }]) {
      const c = await context(user, viewport);
      const p = await c.newPage();
      const errs = [];
      p.on("pageerror", (e) => errs.push(e.message));
      p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
      await p.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: "networkidle" });
      await p.addScriptTag({ content: axe });
      const found = await p.evaluate(async () => {
        const run = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
        return run.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, where: v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ") }));
      });
      const blocking = found.filter((v) => v.impact === "critical" || v.impact === "serious");
      check(`${viewport.tag} ${name}: no critical or serious axe findings`, blocking.length === 0, blocking.map((v) => `${v.impact} ${v.id}(${v.count}) at ${v.where}`).join("; "));
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${viewport.tag} ${name}: no sideways scrolling and no console errors`, overflow <= 0 && errs.length === 0, `${overflow}px ${errs.slice(0, 2).join(" | ")}`);
      await c.close();
    }
  }
}

// ---------------------------------------------------------------------------

const LEFTOVER_TABLES = ["public.games", "public.game_platforms", "public.releases", "private.import_runs", "private.provider_records",
  "private.catalog_review_batches", "private.catalog_review_batch_items", "private.catalog_review_batch_approvals", "private.catalog_review_policy", "private.external_providers"];
const startingFootprint = footprint(psql, LEFTOVER_TABLES);

try {
  installFixture();
  await startApp(PORT);
  people.reviewer = await person("pq-reviewer", "catalog_editor");
  people.a1 = await person("pq-approver-1", "catalog_editor");
  people.a2 = await person("pq-approver-2", "catalog_editor");
  people.collector = await person("pq-collector", null);
  await emptyQueue();
  setup();
  check("six batches were made (setup)", Object.values(B).every((id) => /^[0-9a-f-]{36}$/.test(id)) && Object.keys(B).length === 6);
  await twoApprovals();
  await rejection();
  await race();
  await stepUp();
  await publication();
  await outsiders();
  await inBrowser();
} catch (error) {
  check("the checks ran to the end", false, `${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ""}`);
} finally {
  await browserApp?.close().catch(() => {});
  stopApp();
  cleanup();
  const ids = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'pq\\_%';");
  if (ids.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${ids.map((id) => `'${id}'`).join(",")}); delete from private.request_slots where user_id in (${ids.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  removeFixture();
  check("no batch, game or source record is left behind, and the policy and provider are as they were", footprint(psql, LEFTOVER_TABLES) === startingFootprint);
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed ? 1 : 0);
