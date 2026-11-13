/**
 * M7b-2b end-to-end checks: excluding a release and restoring it in the built app,
 * driven over HTTP against the local stack and its catalog fixture. Forms are
 * submitted the way a browser without JavaScript would. Outcomes are judged by the
 * database and the pages rendered after.
 *
 *   npm run build && npm run app:exclusion-checks
 *
 * Local only. Removes every exclusion, copy, test account and the fixture at the end.
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
} from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";

function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const plain = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const users = [];
const release = (code) => psql(`select id from public.releases where product_code = '${code}';`);
const status = (item) => psql(`select record_status from public.collection_items where id = '${item}';`);
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]));
const NOT_AVAILABLE = "This page isn't available";

async function person(role = null) {
  const user = await createUser({ prefix: "exa" });
  users.push(user.id);
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `xa_${randomBytes(5).toString("hex")}` });
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { ...user, browser };
}
async function add(owner, releaseId, details = {}) {
  const { session } = readSession(owner.browser);
  const response = await fetch(`${api}/rest/v1/rpc/add_collection_item`, {
    method: "POST",
    headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_item_id: uuidv7(), p_release: releaseId, p_details: details }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`add failed: ${body.message}`);
  return body.item_id;
}
const FIELDS = { reason_code: "download_code", reason: "A download code in a box", owner_note: "This box holds only a download code.", acknowledge_copies: "yes" };

try {
  installFixture();
  await startApp(3294);
  // us has a release merged into it, so it can't be excluded (D10); eu is excluded here.
  const us = release("SNS-ZSFE-USA");
  const eu = release("SNSP-ZSFP-EUR");
  const jp = release("SHVC-ZSFJ-JPN");

  const editor = await person("catalog_editor");
  const admin = await person("admin");
  const owner = await person();
  const someone = await person();
  const copy = await add(owner, eu, { completeness: "complete", notes: "From a fair" });
  // A piece recorded before the release's listed pieces changed: kept, as no longer listed.
  psql(`begin; set local session_replication_role = replica;
    insert into public.collection_item_components (item_id, owner_id, kind, label, condition) values ('${copy}', '${owner.id}', 'insert', 'Instruction manual', 'good'); commit;`);
  const keep = () => psql(`select concat_ws(' | ', (select (to_jsonb(c) - array['record_status', 'invalidated_at'])::text from public.collection_items c where c.id = '${copy}'),
    (select to_jsonb(p)::text from public.collection_item_private p where p.item_id = '${copy}'),
    (select string_agg(to_jsonb(x)::text, ',' order by x.kind, x.label) from public.collection_item_components x where x.item_id = '${copy}'));`);
  const before = keep();

  section("Who can reach it");
  const game = await editor.browser.get(`/games/starfall-odyssey?release=${eu}`);
  check("an editor sees “Exclude from the catalog” on a release", hrefs(game.html).includes(`/review/exclude/${eu}`));
  const gameAsCollector = await owner.browser.get(`/games/starfall-odyssey?release=${eu}`);
  check("a collector doesn't", !hrefs(gameAsCollector.html).some((h) => h.startsWith("/review/exclude/")));
  const refused = await owner.browser.get(`/review/exclude/${eu}`);
  check("and gets the page for an address that doesn't exist", plain(refused.html).includes(NOT_AVAILABLE) && !plain(refused.html).includes("Starfall"));
  const visitor = await new Browser().get(`/review/exclude/${eu}`);
  check("a visitor is sent to sign in", visitor.response.status === 307 || /sign-in/.test(location(visitor.response)) || /sign-in/.test(visitor.html));

  section("The preview and confirmation");
  const blocked = await editor.browser.get(`/review/exclude/${us}`);
  check("a release others were merged into can't be excluded, and the page says why", plain(blocked.html).includes("It can't be excluded yet") && plain(blocked.html).includes("A release merged into it") && !formById(blocked.html, "exclude-release"));
  const page = await editor.browser.get(`/review/exclude/${eu}`);
  const form = formById(page.html, "exclude-release");
  check("the editor sees what excluding it does", plain(page.html).includes("1 copy of 1 collector will be kept privately") && Boolean(form));
  check("with a fixed reason, a note to owners, a staff reason and a confirmation", form && ["reason_code", "owner_note", "reason", "acknowledge_copies"].every((n) => form.names.includes(n)));
  const unconfirmed = await editor.browser.submit(`/review/exclude/${eu}`, form, { ...FIELDS, acknowledge_copies: "" });
  check("without the confirmation it's refused", unconfirmed.response.status !== 303 && psql(`select status from public.releases where id = '${eu}';`) === "published");
  const stale = await editor.browser.submit(`/review/exclude/${eu}`, form, { ...FIELDS, token: "0".repeat(32) });
  check("a stale preview is refused", stale.response.status !== 303 && psql(`select status from public.releases where id = '${eu}';`) === "published");
  const forged = await owner.browser.submit(`/review/exclude/${eu}`, form, FIELDS);
  check("a collector's forged exclusion is refused", forged.response.status !== 303 && psql(`select status from public.releases where id = '${eu}';`) === "published");
  const done = await editor.browser.submit(`/review/exclude/${eu}`, form, FIELDS);
  check("confirmed, it's excluded", done.response.status === 303 && location(done.response) === `/review/exclude/${eu}?notice=excluded&copies=1` && status(copy) === "invalid_preserved");
  const confirmation = await editor.browser.get(location(done.response));
  check("which the page says", plain(confirmation.html).includes("Excluded. 1 copy is kept privately"));
  check("and the copy is unchanged", keep() === before);

  section("The owner");
  const list = await owner.browser.get("/collection");
  check("My Collection says a copy is kept privately", plain(list.html).includes("1 copy is kept privately because its release left the catalog"));
  check("linking to them", hrefs(list.html).some((h) => h.includes("status=invalid")));
  check("and the list still names the game", plain(list.html).includes("Starfall Odyssey") && !plain(list.html).includes("Release no longer available"));
  const filtered = await owner.browser.get("/collection?status=invalid");
  check("the filter shows it, without the banner", plain(filtered.html).includes("Starfall Odyssey") && !plain(filtered.html).includes("kept privately because"));
  const mine = await owner.browser.get(`/collection/${copy}`);
  const text = plain(mine.html);
  check("its page explains why, with the owner note", text.includes("Removed from the catalog: A download code, not a game on a medium") && text.includes("This box holds only a download code."));
  check("and shows the release it was", text.includes("Release, no longer in the catalog") && text.includes("SNSP-ZSFP-EUR"));
  check("with the piece the owner recorded", text.includes("Instruction manual"));
  check("and no edit form or piece removal", !mine.html.includes('id="edit-copy"') && !text.includes("Remove this record"));
  check("never naming staff or their reason", !text.includes("A download code in a box") && !text.includes(editor.email ?? "@@"));
  const moveLinks = hrefs(mine.html).filter((h) => h.includes("move_to="));
  check("the move picker lists the game's releases for the copy's platform", moveLinks.some((h) => h.includes(jp)) && moveLinks.some((h) => h.includes(us)) && !moveLinks.some((h) => h.includes(eu)));
  check("so the search is limited to that platform", text.includes("Search the catalog for Super Nintendo Entertainment System games") && !text.includes("the search can't be limited"));
  const theirs = await someone.browser.get(`/collection/${copy}`);
  check("another collector can't see any of it", !plain(theirs.html).includes("This box holds only a download code.") && !plain(theirs.html).includes("From a fair"));

  section("Restoring");
  const exclusion = psql(`select id from private.catalog_exclusions where release_id = '${eu}' and restored_at is null;`);
  check("an editor can't open the exclusions", plain((await editor.browser.get("/review/exclusions")).html).includes(NOT_AVAILABLE));
  check("nor one exclusion", plain((await editor.browser.get(`/review/exclusions/${exclusion}`)).html).includes(NOT_AVAILABLE));
  const queue = await admin.browser.get("/review");
  check("an administrator finds them from the review queue", hrefs(queue.html).includes("/review/exclusions"));
  const all = await admin.browser.get("/review/exclusions");
  check("listed", hrefs(all.html).includes(`/review/exclusions/${exclusion}`));
  const detail = await admin.browser.get(`/review/exclusions/${exclusion}`);
  const restoreForm = formById(detail.html, "restore-exclusion");
  check("with what restoring would do", plain(detail.html).includes("1 copy still preserved by this exclusion will count again") && Boolean(restoreForm));
  check("the staff reason is shown to the administrator", plain(detail.html).includes("A download code in a box"));
  const restored = await admin.browser.submit(`/review/exclusions/${exclusion}`, restoreForm, { reason: "Excluded by mistake" });
  check("restoring brings it back", restored.response.status === 303 && location(restored.response) === `/review/exclusions/${exclusion}?notice=restored`
    && psql(`select status from public.releases where id = '${eu}';`) === "published" && status(copy) === "active");
  check("which the page says", plain((await admin.browser.get(location(restored.response))).html).includes("Restored. 1 copy came back"));
  check("the copy is exactly as it was", keep() === before);
  const after = await owner.browser.get("/collection");
  check("and My Collection no longer shows the banner", !plain(after.html).includes("kept privately because"));
  const editable = await owner.browser.get(`/collection/${copy}`);
  check("the copy can be edited again", editable.html.includes('id="edit-copy"'));

  section("Own exclusions and submissions");
  const adminExcludes = await admin.browser.get(`/review/exclude/${jp}`);
  const own = await admin.browser.submit(`/review/exclude/${jp}`, formById(adminExcludes.html, "exclude-release"), { ...FIELDS, acknowledge_copies: "" });
  check("an administrator may exclude, as an editor", own.response.status === 303 && psql(`select status from public.releases where id = '${jp}';`) === "excluded");
  const ownId = psql(`select id from private.catalog_exclusions where release_id = '${jp}' and restored_at is null;`);
  const ownPage = await admin.browser.get(`/review/exclusions/${ownId}`);
  check("but isn't offered restoring their own exclusion", plain(ownPage.html).includes("You excluded this, so another administrator has to restore it.") && !ownPage.html.includes('id="restore-exclusion"'));
  const forcedRestore = await admin.browser.submit(`/review/exclusions/${exclusion}`, restoreForm, { exclusion_id: ownId, version: "1", reason: "Mine" });
  check("and a forged restoration is refused", forcedRestore.response.status !== 303 && psql(`select status from public.releases where id = '${jp}';`) === "excluded");
  psql(`begin; set local session_replication_role = replica; update public.releases set status = 'published' where id = '${jp}'; delete from private.catalog_exclusions where id = '${ownId}'; commit;`);

  const { session } = readSession(owner.browser);
  const submitted = await fetch(`${api}/rest/v1/rpc/submit_release`, {
    method: "POST",
    headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_game: psql(`select game_id from public.releases where id = '${eu}';`), p_platform: "snes", p_media_format: "rom-cartridge", p_region: "ntsc-j", p_details: { product_code: "EXA-SUB" }, p_components: [], p_physical: true }),
  }).then((r) => r.json());
  const review = await editor.browser.get(`/review/${submitted.submission_id}`);
  check("a submission's review page offers excluding it", hrefs(review.html).includes(`/review/exclude/${submitted.release_id}`));
  const ownReview = await editor.browser.get(`/review/exclude/${submitted.release_id}`);
  check("whose page names the submission it closes", plain(ownReview.html).includes("Its submission is closed for good"));

  const files = readdirSync(join(root, ".next", "static"), { recursive: true }).filter((f) => String(f).endsWith(".js"));
  const bundle = files.map((f) => readFileSync(join(root, ".next", "static", String(f)), "utf8")).join("\n");
  check("the browser bundle calls no exclusion function directly", !/exclude_release|restore_exclusion|get_exclusion|get_my_preserved/.test(bundle), `${files.length} files`);
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  stopApp();
  const ids = users.map((id) => `'${id}'`).join(",") || "null";
  psql(`begin;
set local session_replication_role = replica;
delete from private.catalog_exclusions where excluded_by in (${ids});
delete from public.collection_items where owner_id in (${ids});
create temp table sub_requests on commit drop as select * from public.catalog_change_requests where submitted_by in (${ids});
delete from public.releases where submitted_by in (${ids}) or id in (select release_id from sub_requests);
delete from public.catalog_change_requests where id in (select id from sub_requests);
update public.releases set status = 'published' where status = 'excluded' and product_code in ('SNSP-ZSFP-EUR', 'SHVC-ZSFJ-JPN');
commit;`);
  const deleted = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'xa\\_%';");
  const all = [...new Set([...deleted, ...users])].map((id) => `'${id}'`).join(",");
  if (all) psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${all}) or target_profile_id in (${all}); commit;`);
  removeFixture();
  check("no exclusions, copies or catalog data are left behind",
    psql("select (select count(*) from private.catalog_exclusions) + (select count(*) from public.collection_items) + (select count(*) from public.games) + (select count(*) from public.releases) + (select count(*) from public.catalog_change_requests);") === "0");
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
