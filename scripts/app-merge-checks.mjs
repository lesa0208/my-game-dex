/**
 * M7b-2c end-to-end checks: merging a published duplicate and a submission in the
 * built app, driven over HTTP against the local stack and its catalog fixture. Forms
 * are submitted the way a browser without JavaScript would. Outcomes are judged by the
 * database and the pages rendered after.
 *
 *   npm run build && npm run app:merge-checks
 *
 * Local only. Removes every merge, copy, test account and the fixture at the end.
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
  verifyBrowser,
} from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { claimsFor, decodeClaims } from "./lib/mfa-session.mjs";

function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const plain = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
/** What a visitor sees: the page's text, without scripts, which carry per-request data. */
const visible = (html) => plain(html.replace(/<script[\s\S]*?<\/script>/g, " "));
/** Where a page sends the browser: an HTTP redirect, or the one Next.js streams inside a Suspense boundary. */
const redirectsTo = (page) => location(page.response) || decode(/<meta[^>]+http-equiv="refresh"[^>]+content="\d+;\s*url=([^"]+)"/i.exec(page.html)?.[1] ?? "");
const users = [];
const release = (code) => psql(`select id from public.releases where product_code = '${code}';`);
const releaseStatus = (id) => psql(`select status from public.releases where id = '${id}';`);
const onRelease = (item) => psql(`select release_id from public.collection_items where id = '${item}';`);
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]));
const NOT_AVAILABLE = "This page isn't available";

async function person(role = null) {
  const user = await createUser({ prefix: "mga", mfa: Boolean(role) });
  users.push(user.id);
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `xg_${randomBytes(5).toString("hex")}` });
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { ...user, browser };
}
async function rpcAs(user, fn, args) {
  const { session } = readSession(user.browser);
  const response = await fetch(`${api}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${fn} failed: ${body.message}`);
  return body;
}
const add = async (owner, releaseId, details = {}) => (await rpcAs(owner, "add_collection_item", { p_item_id: uuidv7(), p_release: releaseId, p_details: details })).item_id;
/** Every field the form names, acknowledged: what a browser sends once every box is ticked. */
const acknowledgeAll = (form) => Object.fromEntries(form.names.filter((n) => n.startsWith("ack_") || n === "acknowledge_copies").map((n) => [n, "yes"]));

try {
  installFixture();
  await startApp(3295);
  const us = release("SNS-ZSFE-USA");
  const game = psql(`select game_id from public.releases where id = '${us}';`);

  const editor = await person("catalog_editor");
  const admin = await person("admin");
  const owner = await person();
  const someone = await person();
  // A published duplicate of us, made by the editor and, as nobody reviews their own
  // record (M10c), verified and published by the administrator.
  // M11b-1b: the duplicate is on the legacy cartridge, like the fixture release it is merged
  // into, so that format is reopened for publication only inside this transaction.
  const dup = psql(`begin; update public.platform_media_formats set accepts_new_publications = true where media_format_code = 'rom-cartridge';
    select set_config('request.jwt.claims', '${claimsFor(editor.id)}', true); set local role authenticated;
    select public.create_release('${game}', (select id from public.platforms where slug = 'snes'), 'rom-cartridge', 'ntsc-uc',
      '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "product_code": "MGA-DUP", "packaging_code": "cardboard-box"}', 'Merge checks');
    select set_config('request.jwt.claims', '${claimsFor(admin.id)}', true);
    select public.verify_release(r.id, 'Merge checks', r.revision) from public.releases r where r.product_code = 'MGA-DUP';
    select public.publish_release(r.id, 'Merge checks', r.revision) from public.releases r where r.product_code = 'MGA-DUP';
    reset role; update public.platform_media_formats f set accepts_new_publications = false from public.platforms p
      where p.id = f.platform_id and p.slug in ('nes', 'snes') and f.media_format_code = 'rom-cartridge';
    select id from public.releases where product_code = 'MGA-DUP'; commit;`).split("\n").filter((l) => /^[0-9a-f-]{36}$/.test(l)).at(-1);
  const copy = await add(owner, dup, { completeness: "complete", notes: "From a fair" });
  // A piece recorded that neither release lists: kept through the merge, as no longer listed.
  psql(`begin; set local session_replication_role = replica;
    insert into public.collection_item_components (item_id, owner_id, kind, label, condition) values ('${copy}', '${owner.id}', 'insert', 'Instruction manual', 'good'); commit;`);
  const keep = () => psql(`select concat_ws(' | ', (select (to_jsonb(c) - 'release_id')::text from public.collection_items c where c.id = '${copy}'),
    (select to_jsonb(p)::text from public.collection_item_private p where p.item_id = '${copy}'),
    (select string_agg(to_jsonb(x)::text, ',' order by x.kind, x.label) from public.collection_item_components x where x.item_id = '${copy}'));`);
  const before = keep();

  section("Who can reach it");
  const gamePage = await editor.browser.get(`/games/starfall-odyssey?release=${dup}`);
  check("an editor sees “Merge into another release” on a release", hrefs(gamePage.html).includes(`/admin/catalog/merge/${dup}`));
  const asCollector = await owner.browser.get(`/games/starfall-odyssey?release=${dup}`);
  check("a collector doesn't", !hrefs(asCollector.html).some((h) => h.startsWith("/admin/catalog/merge/")));
  const refused = await owner.browser.get(`/admin/catalog/merge/${dup}`);
  check("and gets the page for an address that doesn't exist", plain(refused.html).includes(NOT_AVAILABLE) && !plain(refused.html).includes("MGA-DUP"));
  const visitor = await new Browser().get(`/admin/catalog/merge/${dup}`);
  check("a visitor is sent to sign in", visitor.response.status === 307 || /sign-in/.test(location(visitor.response)) || /sign-in/.test(visitor.html));
  check("a collector can't open the merge history", plain((await owner.browser.get("/admin/catalog/merges")).html).includes(NOT_AVAILABLE));
  // Visitors' pages, read before the merge, so the public catalog has them cached.
  const cachedRelease = await new Browser().get(`/games/starfall-odyssey?release=${dup}`);
  const cachedSearch = await new Browser().get("/explore?q=MGA-DUP");
  check("before the merge, a visitor sees the duplicate on the game page and in search", visible(cachedRelease.html).includes("MGA-DUP") && hrefs(cachedSearch.html).some((h) => h.includes(`release=${dup}`)));

  section("Choosing and comparing");
  const choose = await editor.browser.get(`/admin/catalog/merge/${dup}`);
  check("the editor chooses among releases of the same game, platform and format", hrefs(choose.html).includes(`/admin/catalog/merge/${dup}?into=${us}`));
  const asEditor = await editor.browser.get(`/admin/catalog/merge/${dup}?into=${us}`);
  const text = plain(asEditor.html);
  check("the comparison lists each differing field with both values", text.includes("Product code") && text.includes("MGA-DUP") && text.includes("SNS-ZSFE-USA"));
  check("flagging the product code to check carefully", text.includes("Check carefully") && text.includes("usually means a different physical product"));
  check("and what merging does to the copies", text.includes("1 copy of 1 collector move to the kept release"));
  check("an editor can't merge a published release, and the page says so", text.includes("needs an administrator") && !formById(asEditor.html, "merge-release"));
  const page = await admin.browser.get(`/admin/catalog/merge/${dup}?into=${us}`);
  const form = formById(page.html, "merge-release");
  const fields = form ? form.names.filter((n) => n.startsWith("ack_")) : [];
  check("an administrator gets the form, with one confirmation per difference", Boolean(form) && fields.length >= 2 && fields.includes("ack_product_code") && form.names.includes("acknowledge_copies"));
  const all = { ...acknowledgeAll(form), reason: "The same cartridge", owner_note: "Your copy now points to the main record." };
  const oneShort = await admin.browser.submit(`/admin/catalog/merge/${dup}?into=${us}`, form, { ...all, [fields[0]]: "" });
  check("one difference unconfirmed, it's refused", oneShort.response.status !== 303 && releaseStatus(dup) === "published");
  const forgedFields = await admin.browser.submit(`/admin/catalog/merge/${dup}?into=${us}`, form, { ...all, fields: fields.slice(1).map((f) => f.slice(4)).join(",") });
  check("a form claiming fewer differences is refused by the database", forgedFields.response.status !== 303 && releaseStatus(dup) === "published");
  const stale = await admin.browser.submit(`/admin/catalog/merge/${dup}?into=${us}`, form, { ...all, token: "0".repeat(32) });
  check("a stale preview is refused", stale.response.status !== 303 && releaseStatus(dup) === "published");
  const byEditor = await editor.browser.submit(`/admin/catalog/merge/${dup}?into=${us}`, form, all);
  check("an editor's forged merge of a published release is refused", byEditor.response.status !== 303 && releaseStatus(dup) === "published");
  const byCollector = await owner.browser.submit(`/admin/catalog/merge/${dup}?into=${us}`, form, all);
  check("and a collector's", byCollector.response.status !== 303 && releaseStatus(dup) === "published");
  // M8d (D3): with a verification 11 minutes old, the admin verifies first, comes back
  // to this preview and merges again. Only postgres can age the claim like this.
  const sessionId = decodeClaims(readSession(admin.browser).session.access_token).session_id;
  psql(`update auth.mfa_amr_claims set updated_at = now() - interval '11 minutes' where session_id = '${sessionId}';`);
  const stepUp = await admin.browser.submit(`/admin/catalog/merge/${dup}?into=${us}`, form, all);
  check("a published merge with an old verification sends the admin to verify first",
    location(stepUp.response) === `/settings/security/verify?next=${encodeURIComponent(`/admin/catalog/merge/${dup}?into=${us}`)}` && releaseStatus(dup) === "published" && onRelease(copy) === dup, location(stepUp.response));
  const back = await verifyBrowser(admin.browser, admin, `/admin/catalog/merge/${dup}?into=${us}`);
  check("verifying returns to the same preview, with nothing merged yet", location(back.response) === `/admin/catalog/merge/${dup}?into=${us}` && releaseStatus(dup) === "published");
  const done = await admin.browser.submit(`/admin/catalog/merge/${dup}?into=${us}`, form, all);
  const mergeId = psql(`select id from private.catalog_merges where source_release_id = '${dup}';`);
  check("confirmed, it's merged", done.response.status === 303 && location(done.response) === `/admin/catalog/merges/${mergeId}?notice=merged` && releaseStatus(dup) === "merged" && onRelease(copy) === us);
  check("which the page says", plain((await admin.browser.get(location(done.response))).html).includes("Merged. 1 copy moved"));
  check("and the copy is unchanged", keep() === before);
  const history = await editor.browser.get("/admin/catalog/merges");
  check("editors find it in the merge history", hrefs(history.html).includes(`/admin/catalog/merges/${mergeId}`));
  const detail = plain((await editor.browser.get(`/admin/catalog/merges/${mergeId}`)).html);
  check("with the reason and the differences acknowledged", detail.includes("The same cartridge") && detail.includes("MGA-DUP → SNS-ZSFE-USA"));

  section("Links and owners");
  // The same address a visitor read before the merge: the merge expired the cached catalog.
  const old = await new Browser().get(`/games/starfall-odyssey?release=${dup}`);
  check("a link to the merged release, cached before, now redirects to the kept one", redirectsTo(old) === `/games/starfall-odyssey?release=${us}`, `${old.response.status} ${redirectsTo(old)}`);
  const searchAfter = await new Browser().get("/explore?q=MGA-DUP");
  check("and a search cached before no longer finds the merged release", !hrefs(searchAfter.html).some((h) => h.includes(`release=${dup}`)));
  // Even a page still showing it can't put a copy on it: the database refuses.
  const { session: ownerSession } = readSession(owner.browser);
  const attempt = (fn, args) =>
    fetch(`${api}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: publishableKey, Authorization: `Bearer ${ownerSession.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }).then(async (r) => ({ status: r.status, message: (await r.json())?.message }));
  const addToMerged = await attempt("add_collection_item", { p_item_id: uuidv7(), p_release: dup, p_details: {} });
  check("adding a copy to the merged release is refused", addToMerged.status >= 400 && addToMerged.message === "release unavailable");
  const relinkToMerged = await attempt("relink_my_copy", { p_item: copy, p_release: dup });
  check("and so is moving a copy to it", relinkToMerged.status >= 400 && relinkToMerged.message === "release unavailable" && onRelease(copy) === us);
  const list = await owner.browser.get("/collection");
  check("My Collection says a copy moved to the main record", plain(list.html).includes("1 of your copies was moved to the catalog's main record"));
  const mine = plain((await owner.browser.get(`/collection/${copy}`)).html);
  check("its page shows the kept release, with everything recorded", mine.includes("SNS-ZSFE-USA") && mine.includes("Instruction manual") && mine.includes("From a fair"));
  check("another collector sees no banner", !plain((await someone.browser.get("/collection")).html).includes("moved to the catalog's main record"));

  section("A submission");
  const submitted = await rpcAs(owner, "submit_release", { p_game: game, p_platform: "snes", p_media_format: "rom-cartridge", p_region: "ntsc-uc", p_details: { product_code: "MGA-SECRET-CODE", local_title: "Mga Secret Title" }, p_components: [], p_physical: true });
  const subCopy = await add(owner, submitted.release_id, { notes: "Mine" });
  const version = psql(`select version from public.catalog_change_requests where id = '${submitted.submission_id}';`);
  await rpcAs(editor, "start_submission_review", { p_request: submitted.submission_id, p_expected_version: Number(version), p_reason: "Checking" });
  const review = await editor.browser.get(`/admin/catalog/${submitted.submission_id}`);
  check("its review page offers merging it into the release it duplicates", hrefs(review.html).includes(`/admin/catalog/merge/${submitted.release_id}?into=${us}`) && hrefs(review.html).includes(`/admin/catalog/merge/${submitted.release_id}`));
  const subPage = await editor.browser.get(`/admin/catalog/merge/${submitted.release_id}?into=${us}`);
  const subForm = formById(subPage.html, "merge-release");
  check("an editor may merge a submission", Boolean(subForm) && plain(subPage.html).includes("Its submission is closed as merged"));
  const subDone = await editor.browser.submit(`/admin/catalog/merge/${submitted.release_id}?into=${us}`, subForm, { ...acknowledgeAll(subForm), reason: "Already cataloged", owner_note: "We already had it." });
  check("and merges it", subDone.response.status === 303 && releaseStatus(submitted.release_id) === "merged" && onRelease(subCopy) === us);
  const ownSubmission = plain((await owner.browser.get(`/submissions/${submitted.submission_id}`)).html);
  check("the submitter reads that it was merged, with the note", ownSubmission.includes("your submission was merged into it") && ownSubmission.includes("We already had it."));
  const subLinks = hrefs((await owner.browser.get(`/submissions/${submitted.submission_id}`)).html);
  check("and where it went", subLinks.includes(`/games/starfall-odyssey?release=${us}`));
  const hidden = await new Browser().get(`/games/starfall-odyssey?release=${submitted.release_id}`);
  const unknown = await new Browser().get(`/games/starfall-odyssey?release=${uuidv7()}`);
  check("a link to the merged submission doesn't redirect", hidden.response.status === 200 && unknown.response.status === 200 && !redirectsTo(hidden));
  check("and the page is the same as for an id that doesn't exist", visible(hidden.html) === visible(unknown.html));
  const titleOf = (html) => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? null;
  check("with the same page title", titleOf(hidden.html) === titleOf(unknown.html));
  check("and nothing of the submission anywhere in the response, scripts and metadata included",
    !["MGA-SECRET-CODE", "Mga Secret Title", "We already had it."].some((text) => hidden.html.includes(text)));
  check("nor in the headers", ![...hidden.response.headers.values()].some((v) => v.includes(submitted.release_id) || v.includes("MGA-SECRET")));

  const files = readdirSync(join(root, ".next", "static"), { recursive: true }).filter((f) => String(f).endsWith(".js"));
  const bundle = files.map((f) => readFileSync(join(root, ".next", "static", String(f)), "utf8")).join("\n");
  check("the browser bundle calls no merge function directly", !/merge_release|get_merge|resolve_merged_release|get_my_merged_submission/.test(bundle), `${files.length} files`);
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  stopApp();
  const ids = users.map((id) => `'${id}'`).join(",") || "null";
  // Merge records are permanent by design; this test data goes with the triggers off.
  psql(`begin; set local session_replication_role = replica;
delete from private.catalog_merge_references;
delete from private.catalog_merge_copies;
delete from private.catalog_merges;
update public.releases set status = 'published', merged_into_id = null, merged_publicly = false where product_code = 'MGA-DUP';
commit;`);
  psql(`begin;
delete from public.collection_items where owner_id in (${ids});
create temp table sub_requests on commit drop as select * from public.catalog_change_requests where submitted_by in (${ids});
delete from public.catalog_change_requests where id in (select id from sub_requests);
delete from public.release_components where release_id in (select id from public.releases where product_code = 'MGA-DUP' or id in (select release_id from sub_requests));
delete from public.releases where product_code = 'MGA-DUP' or id in (select release_id from sub_requests);
commit;`);
  const deleted = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'xg\\_%';");
  const everyone = [...new Set([...deleted, ...users])].map((id) => `'${id}'`).join(",");
  if (everyone) psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${everyone}) or target_profile_id in (${everyone}); commit;`);
  removeFixture();
  check("no merges, copies or catalog data are left behind",
    psql("select (select count(*) from private.catalog_merges) + (select count(*) from public.collection_items) + (select count(*) from public.games) + (select count(*) from public.releases) + (select count(*) from public.catalog_change_requests);") === "0");
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
