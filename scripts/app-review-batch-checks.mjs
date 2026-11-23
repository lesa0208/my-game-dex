/**
 * M14c-2 end-to-end checks: the review-batch pages and recording an outcome, in the built app
 * over HTTP and in a real browser, against a stack with 20261212100000_m14c2_review_batch_reads.
 *
 *   npm run build && MGD_TEST_STACK=scratch node scripts/test-stack.mjs run app:review-batch-checks
 *
 * Everything here is synthetic and temporary: an import run of 30 fictional games ("Zqb …"),
 * created as the catalog fixture's editor (who made the batch, so can't review it), and a
 * throwaway catalog editor with a real authenticator who reviews. Its outcomes are test data,
 * never editorial decisions. Nothing is approved or published.
 *
 * Covered: the empty list; the list, its filters and pages; a batch's provenance, progress,
 * blockers and member pages; sampled, flagged and critical members; the three kinds of
 * evidence; allow-listed, escaped source fields; evidence-note validation; recording a valid
 * outcome with its exact note; a duplicate submission; two at once; a stale page; a stale
 * authenticator check and step-up; collectors, visitors and direct API calls; keyboard use;
 * status and error messages; axe at phone and desktop widths with no sideways scrolling.
 *
 * Local only. Refuses every stack but scratch. Removes the fixture, its batch and every test
 * account at the end, and checks nothing is left behind.
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
  console.error("Refusing: these checks need the M14c-2 migration, which is only on the scratch stack (MGD_TEST_STACK=scratch).");
  process.exit(1);
}

const PORT = 3296;
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;
const EVIDENCE = "Cartridge, box and manual photographed; label and end label match the listing";
const HOSTILE = "<script>alert(1)</script>";
const TAG = "m14c2-app";

function resolveSegments(html) {
  const segments = new Map([...html.matchAll(/<div hidden id="S:([^"]+)">([\s\S]*?)<\/div><script>(?:(?!<\/script>)[\s\S])*?\$RS\("S:\1"/g)].map((m) => [m[1], m[2]]));
  let out = html;
  for (let i = 0; i < 20 && /<template id="P:[^"]+"><\/template>/.test(out); i += 1) {
    out = out.replace(/<template id="P:([^"]+)"><\/template>/g, (whole, id) => segments.get(id) ?? whole);
  }
  return out;
}
const plain = (html) => decode(resolveSegments(html).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const title = (n) => `Zqb Member ${String(n).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// The fixture: an import run of 30 games on the SNES, frozen in one batch.
// ---------------------------------------------------------------------------

let saved = null;
let B = null;

function makeBatch() {
  saved = {
    policy: psql("select row_to_json(p)::text from private.catalog_review_policy p;"),
    provider: psql("select row_to_json(p)::text from private.external_providers p where code = 'wikidata';"),
  };
  const terms = "encode(digest('m14c2-app-terms', 'sha256'), 'hex')";
  const snapshot = `encode(digest(${sql(TAG)}, 'sha256'), 'hex')`;
  const payload = (n) => {
    const flags = n === 1 ? ["other_instance_of"] : n === 2 ? ["mul_label_only"] : n === 3 ? ["many_platforms"] : [];
    const critical = n === 1 ? ["wrong_identity_or_type"] : [];
    const source = n === 4
      ? { revision: 2569010217, platforms: ["Q183259"], instance_of: ["Q7889"], distribution_formats: ["Q633454", "javascript:alert(1)"], external_ids: { igdb: ["zqb-member-04", "<b>x</b>"] }, platform_first_release: { value: "1993-11-19", precision: "day" }, developers: ["M14C2-APP-RAW"] }
      : { revision: 1000 + n };
    return JSON.stringify({
      title: title(n),
      ...(n === 4 ? { titles: [title(n), HOSTILE], ja_titles: ["ズキュービー・メンバー"], first_release_date: "1993-11-19", first_release_precision: "day", secret: "M14C2-APP-RAW" } : {}),
      source,
      risk_assessment: { contract: "mgd-risk-assessment", version: 1, assessor: "m14c2-app", assessor_version: "1",
        source: { provider: "wikidata", external_id: `Q7140${String(n).padStart(4, "0")}`, revision: 1000 + n, snapshot_sha256: "SNAPSHOT" },
        flags, critical },
    });
  };
  const values = Array.from({ length: 30 }, (_, i) => i + 1);
  psql(`begin;
update private.catalog_review_policy set tolerable_error = 0.45, confidence = 0.8;
select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', ${terms}, 'M14c-2 app checks');
insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, status, finished_at, reason)
values ('wikidata', (select id from public.platforms where slug = 'snes'), ${sql(TAG)}, ${snapshot}, now(), ${terms}, 'completed', now(), 'M14c-2 app checks');
${values.map((n) => `
with g as (insert into public.games (title, sort_title, kind, status, first_release_date, first_release_precision)
           values (${sql(title(n))}, ${sql(title(n))}, 'game', 'under_review', '1993-01-01'::date + ${n}, 'day') returning id),
     gp as (insert into public.game_platforms (game_id, platform_id, status) select g.id, (select id from public.platforms where slug = 'snes'), 'under_review' from g returning game_id),
     pr as (insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
            select 'wikidata', 'game', 'Q7140${String(n).padStart(4, "0")}', replace(${sql(payload(n))}, 'SNAPSHOT', ${snapshot})::jsonb, encode(digest('${TAG}-${n}', 'sha256'), 'hex'),
                   (select id from private.import_runs where source_name = ${sql(TAG)}), 'promoted', g.id from g returning id, matched_game_id)
insert into private.import_run_records (import_run_id, provider_record_id, position) select (select id from private.import_runs where source_name = ${sql(TAG)}), pr.id, ${n} from pr;`).join("")}
insert into private.external_references (provider_code, external_id, game_id)
  select 'wikidata', pr.external_id, pr.matched_game_id from private.provider_records pr where pr.import_run_id = (select id from private.import_runs where source_name = ${sql(TAG)});
commit;`);
  // As the fixture editor, through the editor function: the role can't read private tables, so the ids go in as values.
  const run = psql(`select id from private.import_runs where source_name = ${sql(TAG)};`);
  const snes = psql("select id from public.platforms where slug = 'snes';");
  psql(`begin;
update auth.mfa_amr_claims set created_at = now(), updated_at = now() where session_id = '${FIXTURE_EDITOR}';
select set_config('request.jwt.claims', jsonb_build_object('sub', '${FIXTURE_EDITOR}', 'role', 'authenticated', 'aal', 'aal2', 'session_id', '${FIXTURE_EDITOR}')::text, true);
set local role authenticated;
select public.create_review_batch(${sql(run)}, ${sql(snes)}, 'M14c-2 app checks');
reset role;
commit;`);
  B = psql(`select b.id from private.catalog_review_batches b join private.import_runs r on r.id = b.import_run_id where r.source_name = ${sql(TAG)};`);
  const ids = (where) => psql(`select string_agg(i.game_id::text, ',' order by g.title) from private.catalog_review_batch_items i join public.games g on g.id = i.game_id where i.batch_id = '${B}' and ${where};`).split(",").filter(Boolean);
  return {
    critical: ids("cardinality(i.critical_flags) > 0")[0],
    flagged: ids("cardinality(i.flags) > 0 and cardinality(i.critical_flags) = 0")[0],
    sampled: ids("i.sampled"),
    unsampled: ids("not i.sampled and cardinality(i.flags) = 0"),
    rich: psql(`select id from public.games where title = ${sql(title(4))};`),
  };
}

function removeBatch() {
  const games = `(select id from public.games where title like 'Zqb Member %')`;
  psql(`begin;
set local session_replication_role = replica;
delete from private.audit_events where reason = 'M14c-2 app checks' or metadata ->> 'batch_id' = ${sql(B ?? "")} or metadata ->> 'game_id' in (select id::text from ${games}) or metadata ->> 'id' in (select id::text from ${games});
delete from private.catalog_review_batch_approvals where batch_id in (select b.id from private.catalog_review_batches b join private.import_runs r on r.id = b.import_run_id where r.source_name = ${sql(TAG)});
delete from private.catalog_review_batch_items where batch_id in (select b.id from private.catalog_review_batches b join private.import_runs r on r.id = b.import_run_id where r.source_name = ${sql(TAG)});
delete from private.catalog_review_batches where import_run_id in (select id from private.import_runs where source_name = ${sql(TAG)});
delete from private.external_references where game_id in ${games};
delete from private.import_run_records where import_run_id in (select id from private.import_runs where source_name = ${sql(TAG)});
delete from private.provider_records where import_run_id in (select id from private.import_runs where source_name = ${sql(TAG)});
delete from private.import_runs where source_name = ${sql(TAG)};
delete from private.catalog_pairing_origins where game_id in ${games};
delete from private.catalog_verifications where game_id in ${games};
delete from private.catalog_record_origins where game_id in ${games};
delete from public.game_platforms where game_id in ${games};
delete from public.games where title like 'Zqb Member %';
${saved ? `update private.catalog_review_policy p set (tolerable_error, confidence, acceptance_number, second_approval_above, updated_at) =
  (select tolerable_error, confidence, acceptance_number, second_approval_above, updated_at from json_populate_record(null::private.catalog_review_policy, ${sql(saved.policy)}));
update private.external_providers p set (name, terms_url, terms_sha256, terms_reviewed_at, commercial_use_cleared, cleared_note, created_at, updated_at, rights_survive_withdrawal, rights_terms_sha256, rights_note, rights_recorded_at) =
  (select name, terms_url, terms_sha256, terms_reviewed_at, commercial_use_cleared, cleared_note, created_at, updated_at, rights_survive_withdrawal, rights_terms_sha256, rights_note, rights_recorded_at
   from json_populate_record(null::private.external_providers, ${sql(saved.provider)}))
where code = 'wikidata';` : ""}
commit;`);
}

// ---------------------------------------------------------------------------
// People.
// ---------------------------------------------------------------------------

const people = {};
async function withHandle(user) {
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", forms(welcome.html).find((f) => f.names.includes("handle")), { handle: `rb_${randomBytes(5).toString("hex")}` });
  return { ...user, browser, handle: psql(`select handle from public.profiles where id = '${user.id}';`) };
}
async function rpc(owner, name, body) {
  const headers = { apikey: publishableKey, "Content-Type": "application/json" };
  if (owner) headers.Authorization = `Bearer ${readSession(owner.browser).session.access_token}`;
  const response = await fetch(`${api}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}
const memberPath = (game) => `/admin/catalog/batches/${B}/members/${game}`;
const outcomes = (game) => psql(`select count(*) from private.audit_events where action = 'catalog_batch_outcome_recorded' and metadata ->> 'batch_id' = '${B}' and metadata ->> 'game_id' = '${game}';`);
const outcomeOf = (game) => psql(`select coalesce(outcome, 'none') || '|' || coalesce(critical_error, '') || '|' || coalesce(note, '') from private.catalog_review_batch_items where batch_id = '${B}' and game_id = '${game}';`);
/** Makes the browser's TOTP verification 11 minutes old, as the editing checks do. Only postgres can age the claim like this. */
function staleMfa(user) {
  const sessionId = decodeClaims(readSession(user.browser).session.access_token).session_id;
  psql(`update auth.mfa_amr_claims set updated_at = now() - interval '11 minutes' where session_id = '${sessionId}';`);
}

let M = null;

async function emptyList() {
  section("The batch list, with no batches");
  const s = people.staff;
  const page = await s.browser.get("/admin/catalog/batches");
  const text = plain(page.html);
  check("staff can open it", page.response.status === 200 && text.includes("Review batches"));
  check("with none, it says no batch is waiting, and how batches come about", text.includes("No review batches") && text.includes("No batch is waiting for review"));
  check("and that an accepted identity isn't a physical game", text.includes("An accepted identity isn't a physical game"));
  const catalog = await s.browser.get("/admin/catalog");
  check("the catalog page links to it", resolveSegments(catalog.html).includes('href="/admin/catalog/batches"'));
}

async function list() {
  section("The batch list");
  const s = people.staff;
  const text = plain((await s.browser.get("/admin/catalog/batches")).html);
  const required = 2 + M.sampled.length;
  check("the open batch is listed, with its platform and source", text.includes(`Batch ${B.slice(0, 8)} · Super Nintendo Entertainment System`) && text.includes(TAG));
  check("with its members, flagged and sampled counts", text.includes("Members 30") && text.includes(`Flagged · sampled 2 · ${M.sampled.length}`));
  check("its review progress and critical signals", text.includes(`Reviews recorded 0 of ${required} · ${required} pending`) && text.includes("Critical 1 signal"));
  const creator = psql(`select handle from public.profiles where id = '${FIXTURE_EDITOR}';`);
  check("its creator, by handle only", text.includes(`by @${creator}`) && !text.includes("@example.test"));
  check("filtered to approved batches, it isn't", !plain((await s.browser.get("/admin/catalog/batches?status=approved")).html).includes(B.slice(0, 8)));
  check("filtered to another platform, it isn't", !plain((await s.browser.get("/admin/catalog/batches?platform=nes")).html).includes(B.slice(0, 8)));
  const odd = await s.browser.get("/admin/catalog/batches?platform=%3Cscript%3E&status=bogus");
  check("odd filters fall back safely", odd.response.status === 200 && plain(odd.html).includes(B.slice(0, 8)) && !odd.html.includes("<script>alert"));
}

async function batchPage() {
  section("The batch page");
  const s = people.staff;
  const page = await s.browser.get(`/admin/catalog/batches/${B}`);
  const text = plain(page.html);
  const snapshot = psql(`select source_sha256 from private.import_runs where source_name = ${sql(TAG)};`);
  const content = psql(`select content_sha256 from private.catalog_review_batches where id = '${B}';`);
  check("it loads, with its provenance: source, snapshot hash and frozen content hash",
    page.response.status === 200 && text.includes(`Source Wikidata: ${TAG}`) && text.includes(snapshot) && text.includes(content));
  check("its sampling policy and required reviews", text.includes("45% tolerable error at 80% confidence; acceptance number 0") && text.includes(`Required reviews ${2 + M.sampled.length}`));
  check("its blockers, assessed by the database", text.includes(`${2 + M.sampled.length} members still need their individual review.`));
  check("that it says identity acceptance isn't physical proof", text.includes("is not proof that a physical copy exists"));
  check("and offers no approval, rejection or publication: no form acts on the batch",
    forms(resolveSegments(page.html)).every((f) => !Object.values(f.hidden).includes(B) && !f.names.includes("reason")) &&!page.html.includes("approve_review_batch") && !page.html.includes("reject_review_batch"));
  // The member links in the list, in page order (a streamed page holds each once, after resolving).
  const first = (html) => [...new Set([...resolveSegments(html).matchAll(/href="\/admin\/catalog\/batches\/[^/"]+\/members\/([0-9a-f-]{36})"/g)].map((m) => m[1]))];
  const pending = first(page.html);
  check("by default it lists members awaiting review, the critical one first", pending[0] === M.critical && pending.length === 2 + M.sampled.length,
    `${pending.length} ${pending[0] === M.critical}`);
  check("with the filters' counts", text.includes(`Awaiting review ${2 + M.sampled.length}`) && text.includes("Critical risk 1") && text.includes(`Not sampled ${M.unsampled.length}`));
  const all1 = await s.browser.get(`/admin/catalog/batches/${B}?filter=all`);
  const p1 = first(all1.html);
  const next = /href="(\/admin\/catalog\/batches\/[^"]+filter=all&amp;after=[0-9a-f-]{36})"/.exec(resolveSegments(all1.html))?.[1];
  check("all members: a page of 25, and a next page", p1.length === 25 && Boolean(next));
  const p2 = next ? first((await s.browser.get(decode(next))).html) : [];
  check("whose second page holds the other 5, none twice", p2.length === 5 && new Set([...p1, ...p2]).size === 30);
  const critical = first((await s.browser.get(`/admin/catalog/batches/${B}?filter=critical`)).html);
  check("the critical filter holds the critical member only", critical.length === 1 && critical[0] === M.critical);
  check("a cursor that isn't a member is refused, not guessed", plain((await s.browser.get(`/admin/catalog/batches/${B}?filter=all&after=00000000-0000-4000-8000-000000000000`)).html).includes("can't be shown"));
  const unknown = await s.browser.get("/admin/catalog/batches/00000000-0000-4000-8000-000000000000");
  check("an unknown batch is not found", unknown.response.status === 404 || unknown.html.includes("NEXT_HTTP_ERROR_FALLBACK;404"));
}

async function memberPages() {
  section("Member pages");
  const s = people.staff;
  const crit = plain((await s.browser.get(memberPath(M.critical))).html);
  check("a critical member: its category, flag and why it matters", crit.includes("Critical risk") && crit.includes("Other instance of") && crit.includes("Wikidata also types it as something other than a video game"));
  check("its possible critical error, which a person decides", crit.includes("Possible critical error") && crit.includes("Incorrect game identity or game type"));
  check("the three kinds of evidence, kept apart", ["Game identity evidence", "Physical existence evidence", "Physical release evidence"].every((h) => crit.includes(h)));
  check("physical existence not confirmed, and a listing isn't proof", crit.includes("Not confirmed.") && crit.includes("A platform listing or a stated format is not that evidence"));
  check("no physical release, and the batch never makes one", crit.includes("No physical release is recorded") && crit.includes("A batch never creates or verifies a release"));
  check("the outcome form, for an editor with a recent check", crit.includes("Your outcome") && crit.includes("Record the outcome"));

  const rich = await s.browser.get(memberPath(M.rich));
  const raw = resolveSegments(rich.html);
  const r = plain(rich.html);
  check("source links are built from the record's id and staged revision only",
    raw.includes('href="https://www.wikidata.org/wiki/Q71400004"') && raw.includes('href="https://www.wikidata.org/w/index.php?oldid=2569010217"') && /rel="noopener noreferrer nofollow"/.test(raw));
  const markup = raw.replace(/<script[\s\S]*?<\/script>/g, "");
  check("provider text is shown as text, never as markup", markup.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !markup.includes(HOSTILE));
  check("allow-listed fields only: no raw payload, odd ids or unsafe formats",
    !r.includes("M14C2-APP-RAW") && !r.includes("javascript:") && !raw.includes("&lt;b&gt;x") && r.includes("ROM cartridge (physical medium)") && r.includes("zqb-member-04"));
  check("Japanese titles are marked as Japanese", raw.includes('lang="ja"') && r.includes("ズキュービー・メンバー"));

  const unsampled = plain((await s.browser.get(memberPath(M.unsampled[0]))).html);
  check("an unsampled member: not reviewed individually, and never confirmed physically by the batch",
    unsampled.includes("Not sampled") && unsampled.includes("isn't flagged or sampled") && unsampled.includes("never confirms its physical existence") && !unsampled.includes("Record the outcome"));
  const other = await s.browser.get(`/admin/catalog/batches/${B}/members/00000000-0000-4000-8000-000000000000`);
  check("a game that isn't a member is not found", other.response.status === 404 || other.html.includes("NEXT_HTTP_ERROR_FALLBACK;404"));
}

/**
 * Posts a served form as a browser without JavaScript would: only fields the page actually has.
 * A field the form doesn't render is refused here, so no check can pass by sending one.
 */
function post(browser, path, form, fields) {
  const missing = Object.keys(fields).filter((name) => !form.names.includes(name) && !(name in form.hidden));
  if (missing.length) throw new Error(`the served form has no ${missing.join(", ")} field`);
  return browser.submit(path, form, fields);
}

async function recording() {
  section("Recording outcomes (without JavaScript)");
  const s = people.staff;
  const critPage = await s.browser.get(memberPath(M.critical));
  const form = formById(critPage.html, "record-outcome");
  check("the form carries the member and what the page showed, and preselects nothing", Boolean(form) && form.hidden.batch_id === B && form.hidden.game_id === M.critical && form.hidden.seen_outcome === "" && !("outcome" in form.hidden));
  check("and, as served, has every field it needs: outcome, critical error, note and confirmation",
    ["outcome", "critical_error", "note", "confirm"].every((n) => form.names.includes(n)), form?.names.join(","));
  const posted = await post(s.browser, memberPath(M.critical), form, { outcome: "incorrect", critical_error: "wrong_identity_or_type", note: "A cartridge-based utility, not a game", confirm: "on" });
  check("an incorrect outcome with a critical error is recorded", outcomeOf(M.critical) === "incorrect|wrong_identity_or_type|A cartridge-based utility, not a game", `${posted.response.status} ${outcomeOf(M.critical)}`);
  check("and lands back on the member, with a notice", isRedirect(posted.response) && location(posted.response).includes("notice=recorded"));
  const again = await post(s.browser, memberPath(M.critical), form, { outcome: "excluded", note: "", confirm: "on" });
  check("the same form, sent again, changes nothing (the page is out of date)", outcomes(M.critical) === "1" && outcomeOf(M.critical).startsWith("incorrect|"), `${again.response.status}`);
  const after = await s.browser.get(memberPath(M.critical));
  const text = plain(after.html);
  check("the page now offers only excluded, keeping the critical error", formById(after.html, "record-outcome")?.hidden.seen_outcome === "incorrect" && text.includes("Recorded with the earlier finding"));
  const keep = formById(after.html, "record-outcome");
  await post(s.browser, memberPath(M.critical), keep, { outcome: "excluded", critical_error: "wrong_identity_or_type", note: "", confirm: "on" });
  check("excluding it then is recorded, with its trail", outcomeOf(M.critical).startsWith("excluded|wrong_identity_or_type") && outcomes(M.critical) === "2");
  const final = plain((await s.browser.get(memberPath(M.critical))).html);
  check("after which its outcome is final, and the page says so", final.includes("Its outcome is recorded and final") && !final.includes("Record the outcome"));
  check("its review history lists both, oldest first", /Incorrect[\s\S]*Excluded/.test(final.slice(final.indexOf("Review history"))));

  // A correct outcome needs its evidence, as the database decides.
  const flaggedForm = formById((await s.browser.get(memberPath(M.flagged))).html, "record-outcome");
  const short = await post(s.browser, memberPath(M.flagged), flaggedForm, { outcome: "correct", note: "looks fine", confirm: "on" });
  check("a correct outcome with a short note isn't recorded", outcomeOf(M.flagged) === "none||");
  check("and comes back to the member with the evidence message, by its code", isRedirect(short.response) && location(short.response).endsWith("?error=evidence"), location(short.response));
  const told = plain((await s.browser.get(`${memberPath(M.flagged)}?error=evidence`)).html);
  check("which the page shows as an alert", told.includes("The outcome wasn't recorded") && told.includes("Describe the physical evidence you checked"));
  const forged = await s.browser.get(`${memberPath(M.flagged)}?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
  check("an error code that isn't one shows nothing", !plain(forged.html).includes("The outcome wasn't recorded") && !resolveSegments(forged.html).includes("<script>alert(1)"));
  await post(s.browser, memberPath(M.flagged), flaggedForm, { outcome: "correct", note: EVIDENCE });
  check("nor one without its confirmation", outcomeOf(M.flagged) === "none||");
  const direct = await rpc(s, "record_batch_outcome", { p_batch: B, p_game: M.flagged, p_outcome: "correct", p_critical_error: null, p_note: "          " });
  check("and the database refuses it too, called directly", direct.status >= 400 && direct.text.includes("evidence required") && outcomeOf(M.flagged) === "none||");

  // Two at once: exactly one is recorded.
  const twoForm = formById((await s.browser.get(memberPath(M.sampled[1]))).html, "record-outcome");
  await Promise.all([
    post(s.browser, memberPath(M.sampled[1]), twoForm, { outcome: "correct", note: EVIDENCE, confirm: "on" }),
    post(s.browser, memberPath(M.sampled[1]), twoForm, { outcome: "excluded", note: "", confirm: "on" }),
  ]);
  check("two submissions at once: exactly one outcome is recorded", outcomes(M.sampled[1]) === "1" && /^(correct|excluded)\|/.test(outcomeOf(M.sampled[1])), outcomeOf(M.sampled[1]));

  // A stale page: the game changed after the page was read.
  const staleForm = formById((await s.browser.get(memberPath(M.sampled[2]))).html, "record-outcome");
  psql(`update public.games set revision = revision + 1 where id = '${M.sampled[2]}';`);
  await post(s.browser, memberPath(M.sampled[2]), staleForm, { outcome: "correct", note: EVIDENCE, confirm: "on" });
  check("a page read before the game changed records nothing", outcomes(M.sampled[2]) === "0");
  const stalePage = plain((await s.browser.get(memberPath(M.sampled[2]))).html);
  check("the member now says it changed since the batch was frozen, with no form", stalePage.includes("Changed since the batch was frozen") && !stalePage.includes("Record the outcome"));
  const batch = plain((await s.browser.get(`/admin/catalog/batches/${B}`)).html);
  check("and the batch shows it as a blocker", batch.includes("1 member has changed since the batch was frozen"));
}

async function stepUp() {
  section("A stale authenticator check");
  const s = people.staff;
  const form = formById((await s.browser.get(memberPath(M.flagged))).html, "record-outcome");
  staleMfa(s);
  const page = plain((await s.browser.get(memberPath(M.flagged))).html);
  check("the member page asks for a fresh verification instead of the form", page.includes("Recording an outcome needs a recent verification") && page.includes("Verify to continue") && !page.includes("Record the outcome"));
  const posted = await post(s.browser, memberPath(M.flagged), form, { outcome: "excluded", note: "", confirm: "on" });
  const target = location(posted.response);
  check("a form sent anyway records nothing, and goes to verification, coming back to the member",
    outcomeOf(M.flagged) === "none||" && isRedirect(posted.response) && target.includes("/settings/security/verify") && decodeURIComponent(target).includes(memberPath(M.flagged)), target);
  const verified = await verifyBrowser(s.browser, s, memberPath(M.flagged));
  check("after verifying, the editor is sent back to the member",
    (isRedirect(verified.response) && location(verified.response).includes(memberPath(M.flagged))) || streamedRedirectTo(verified.html, memberPath(M.flagged)), `${verified.response.status}`);
  check("with the form again, nothing replayed", plain((await s.browser.get(memberPath(M.flagged))).html).includes("Record the outcome") && outcomeOf(M.flagged) === "none||");
}

async function outsiders() {
  section("Collectors, visitors and direct calls");
  const c = people.collector;
  for (const path of ["/admin/catalog/batches", `/admin/catalog/batches/${B}`, memberPath(M.flagged)]) {
    const page = await c.browser.get(path);
    check(`a collector gets nothing at ${path.replace(B, "<batch>").replace(M.flagged, "<member>")}`,
      (page.response.status === 404 || page.html.includes("NEXT_HTTP_ERROR_FALLBACK;404")) && !plain(page.html).includes(TAG) && !plain(page.html).includes(title(2)));
  }
  const visitor = await new Browser().get(`/admin/catalog/batches/${B}`);
  check("a visitor is sent to sign in", isRedirect(visitor.response) || visitor.html.includes("/sign-in"));
  const staffForm = formById((await people.staff.browser.get(memberPath(M.flagged))).html, "record-outcome");
  await c.browser.submit(memberPath(M.flagged), staffForm, { outcome: "excluded", note: "", confirm: "on" });
  check("a collector posting an editor's form records nothing", outcomeOf(M.flagged) === "none||");
  for (const [name, body] of [["list_review_batches", {}], ["get_review_batch_overview", { p_batch: B }], ["list_review_batch_members", { p_batch: B }], ["get_review_batch_member", { p_batch: B, p_game: M.flagged }]]) {
    const asCollector = await rpc(c, name, body);
    const asVisitor = await rpc(null, name, body);
    check(`neither a collector nor a visitor can call ${name}`, asCollector.status >= 400 && asVisitor.status >= 400 && !asCollector.text.includes(TAG) && !asVisitor.text.includes(title(2)));
  }
  const table = await fetch(`${api}/rest/v1/catalog_review_batches?select=*`, { headers: { apikey: publishableKey, Authorization: `Bearer ${readSession(c.browser).session.access_token}` } });
  check("and no client can read the batch tables", !table.ok || (await table.text()) === "[]");
  const direct = await rpc(c, "record_batch_outcome", { p_batch: B, p_game: M.flagged, p_outcome: "excluded", p_critical_error: null, p_note: null });
  check("nor record an outcome directly", direct.status >= 400 && outcomeOf(M.flagged) === "none||");
}

// ---------------------------------------------------------------------------
// In a real browser: the form with JavaScript, the keyboard, axe.
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
  const s = people.staff;

  // Recording a correct outcome with the keyboard only.
  const ctx = await context(s);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}${memberPath(M.sampled[0])}`, { waitUntil: "networkidle" });
  await page.locator('#record-outcome input[name="outcome"]').first().focus();
  await page.keyboard.press("Space");
  const chosen = await page.evaluate(() => document.querySelector('#record-outcome input[name="outcome"]:checked')?.value ?? null);
  check("the outcome is chosen with the keyboard (Space on the focused option)", chosen === "correct", String(chosen));
  await page.keyboard.press("Tab");
  check("Tab moves on to the evidence note", await page.evaluate(() => document.activeElement?.getAttribute("name") === "note"));
  await page.keyboard.type("Looks right");
  const hint = await page.locator('#record-outcome p[id$="-note-check"]').textContent();
  check("the note's check says what's missing", /of at least 20 characters/.test(hint ?? ""), hint ?? "");
  const spoken = await page.locator('#record-outcome [aria-live="polite"]').textContent();
  check("and only its state is announced, not each keystroke", spoken === "The evidence note isn't long enough yet." && !(await page.locator('#record-outcome p[id$="-note-check"][aria-live]').count()), spoken ?? "");
  await page.keyboard.press("Tab");
  check("Tab moves on to the confirmation", await page.evaluate(() => document.activeElement?.getAttribute("name") === "confirm"));
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  check("and on to the submit button", await page.evaluate(() => document.activeElement?.textContent?.trim() === "Record the outcome"));
  await page.keyboard.press("Enter");
  const alert = page.locator('#record-outcome [role="alert"]');
  await alert.filter({ hasText: "Describe the physical evidence" }).waitFor({ timeout: 10000 }).catch(() => {});
  check("a short note is refused with an announced message, and nothing is recorded", ((await alert.textContent()) ?? "").includes("Describe the physical evidence") && outcomes(M.sampled[0]) === "0");
  await page.locator('#record-outcome textarea[name="note"]').fill(EVIDENCE);
  await page.locator('#record-outcome button[type="submit"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/notice=recorded/, { timeout: 15000 }).catch(() => {});
  check("with evidence, it is recorded, and the page says so", page.url().includes("notice=recorded") && ((await page.locator('[role="status"]').allTextContents()).join(" ")).includes("Outcome recorded."));
  check("the note is kept exactly as typed, by this editor", outcomeOf(M.sampled[0]) === `correct||${EVIDENCE}` && psql(`select reviewed_by from private.catalog_review_batch_items where batch_id = '${B}' and game_id = '${M.sampled[0]}';`) === s.id);
  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();

  const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  for (const [name, path] of [
    ["batch list", "/admin/catalog/batches"],
    ["batch list, nothing matching", "/admin/catalog/batches?status=approved"],
    ["batch page", `/admin/catalog/batches/${B}`],
    ["batch page, all members", `/admin/catalog/batches/${B}?filter=all`],
    ["critical member, outcome final", memberPath(M.critical)],
    ["flagged member, with the form", memberPath(M.flagged)],
    ["member with hostile source text", memberPath(M.rich)],
    ["unsampled member", memberPath(M.unsampled[0])],
  ]) {
    for (const viewport of [{ tag: "phone", width: 390, height: 844 }, { tag: "desktop", width: 1280, height: 900 }]) {
      const c = await context(s, viewport);
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

const LEFTOVER_TABLES = ["public.games", "public.game_platforms", "public.releases", "private.import_runs", "private.provider_records", "private.external_references",
  "private.catalog_review_batches", "private.catalog_review_batch_items", "private.catalog_review_batch_approvals", "private.catalog_review_policy", "private.external_providers"];
const startingFootprint = footprint(psql, LEFTOVER_TABLES);

try {
  installFixture();
  await startApp(PORT);
  people.staff = await withHandle(await createUser({ prefix: "rb-staff", mfa: true }));
  psql(`insert into public.staff_roles (user_id, role) values ('${people.staff.id}', 'catalog_editor');`);
  people.collector = await withHandle(await createUser({ prefix: "rb-collector" }));
  await emptyList();
  M = makeBatch();
  check("the fixture batch has a critical, a flagged, three sampled and unsampled members", Boolean(M.critical && M.flagged) && M.sampled.length === 3 && M.unsampled.length > 20, JSON.stringify({ s: M.sampled.length, u: M.unsampled.length }));
  await list();
  await batchPage();
  await memberPages();
  await recording();
  await stepUp();
  await outsiders();
  await inBrowser();
  check("nothing was approved or published", psql(`select count(*) from public.games where title like 'Zqb Member %' and (status = 'published' or verified_at is not null);`) === "0"
    && psql(`select status from private.catalog_review_batches where id = '${B}';`) === "open");
} catch (error) {
  check("the checks ran to the end", false, `${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ""}`);
} finally {
  await browserApp?.close().catch(() => {});
  stopApp();
  removeBatch();
  const ids = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'rb\\_%';");
  if (ids.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${ids.map((id) => `'${id}'`).join(",")}); delete from private.request_slots where user_id in (${ids.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  removeFixture();
  check("no batch, source record or catalog data is left behind, and the policy and provider are as they were", footprint(psql, LEFTOVER_TABLES) === startingFootprint);
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed ? 1 : 0);
