/**
 * M7b-2a end-to-end checks: moving a copy to another release in the built app, driven
 * over HTTP against the local stack and its catalog fixture. Forms are submitted the
 * way a browser without JavaScript would. Outcomes are judged by the database and the
 * pages rendered after.
 *
 *   npm run build && npm run app:relink-checks
 *
 * Local only. Removes every copy, test account and the fixture at the end. Prints check
 * names and statuses, never keys, tokens or cookies.
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

/** A UUIDv7 for a new copy, as the app makes them. */
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
const onRelease = (item) => psql(`select release_id from public.collection_items where id = '${item}';`);

async function collector() {
  const user = await createUser({ prefix: "rlk" });
  users.push(user.id);
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `rl_${randomBytes(5).toString("hex")}` });
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
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]));

try {
  installFixture();
  await startApp(3293);
  const us = release("SNS-ZSFE-USA");
  const eu = release("SNSP-ZSFP-EUR");
  const jp = release("SHVC-ZSFJ-JPN");
  const otherPlatform = psql("select r.id from public.releases r join public.platforms p on p.id = r.platform_id where r.status = 'published' and p.slug <> 'snes' limit 1;");

  section("Moving a copy, without JavaScript");
  const owner = await collector();
  const copy = await add(owner, us, {
    completeness: "complete", box_condition: "good", notes: "From a fair", purchase_price: "40", currency: "EUR",
    components: [{ kind: "insert", label: "Instruction manual", condition: "good" }, { kind: "map", label: "World map poster" }],
  });
  const keep = () => psql(`select concat_ws(' | ', (select (to_jsonb(c) - array['release_id', 'updated_at', 'record_status', 'invalidated_at'])::text from public.collection_items c where c.id = '${copy}'),
    (select to_jsonb(p)::text from public.collection_item_private p where p.item_id = '${copy}'),
    (select string_agg(to_jsonb(x)::text, ',' order by x.kind, x.label) from public.collection_item_components x where x.item_id = '${copy}'));`);
  const before = keep();
  const page = await owner.browser.get(`/collection/${copy}`);
  check("the copy's page offers to move it", plain(page.html).includes("Move to another release") && page.html.includes('id="move"'));
  const links = hrefs(page.html).filter((h) => h.includes("move_to="));
  check("listing the game's other releases for its platform, not the current one", links.some((h) => h.includes(eu)) && links.some((h) => h.includes(jp)) && !links.some((h) => h.includes(us)));
  check("and nothing for another platform", !links.some((h) => h.includes(otherPlatform)));
  const chooseEu = links.find((h) => h.includes(eu)).split("#")[0];
  const confirm = await owner.browser.get(chooseEu);
  const form = formById(confirm.html, "move-copy");
  check("choosing one asks to confirm, naming both releases", Boolean(form) && plain(confirm.html).includes("Confirm the move") && plain(confirm.html).includes("From") && plain(confirm.html).includes("SNSP-ZSFP-EUR"));
  check("and says what's kept", plain(confirm.html).includes("keeps its conditions, private details and every piece you recorded"));
  const someone = await collector();
  const forged = await someone.browser.submit(chooseEu, form, {});
  check("another collector's forged move is refused", forged.response.status !== 303 && onRelease(copy) === us);
  const pending = await fetch(`${api}/rest/v1/rpc/submit_release`, {
    method: "POST",
    headers: { apikey: publishableKey, Authorization: `Bearer ${readSession(someone.browser).session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_game: psql(`select game_id from public.releases where id = '${us}';`), p_platform: "snes", p_media_format: "rom-cartridge", p_region: "pal", p_details: { product_code: "RLK-HTTP" }, p_components: [], p_physical: true }),
  }).then((r) => r.json());
  const toHidden = await owner.browser.submit(chooseEu, form, { release_id: pending.release_id });
  // Without JavaScript a refusal's message isn't shown (an accepted limitation); the browser check sees it.
  check("a forged target of someone else's pending submission is refused", toHidden.response.status !== 303 && onRelease(copy) === us);
  const toOther = await owner.browser.submit(chooseEu, form, { release_id: otherPlatform });
  check("so is another platform", toOther.response.status !== 303 && onRelease(copy) === us);
  const moved = await owner.browser.submit(chooseEu, form, {});
  check("confirming moves it, back to its page", moved.response.status === 303 && location(moved.response) === `/collection/${copy}?notice=moved` && onRelease(copy) === eu);
  const after = await owner.browser.get(`/collection/${copy}?notice=moved`);
  check("which says so", plain(after.html).includes("Moved. Your copy is now on this release"));
  check("with its conditions, private details and piece records unchanged", keep() === before);
  check("pieces the new release doesn't list show as no longer listed, kept", plain(after.html).includes("No longer listed for this release") && plain(after.html).includes("World map poster"));

  section("A preserved copy");
  const preserved = await add(owner, jp, { notes: "Keep me" });
  psql(`begin; update public.releases set status = 'excluded' where id = '${jp}';
    update public.collection_items set record_status = 'invalid_preserved', invalidated_at = now() where id = '${preserved}';
    -- A piece recorded before the release changed, so it shows as no longer listed.
    set local session_replication_role = replica;
    insert into public.collection_item_components (item_id, owner_id, kind, label, condition) values ('${preserved}', '${owner.id}', 'insert', 'Old leaflet', 'good'); commit;`);
  const kept = await owner.browser.get(`/collection/${preserved}`);
  check("its page explains it's kept privately, and how to recover it", plain(kept.html).includes("This copy is kept privately") && plain(kept.html).includes("move it to the release you own"));
  check("with the move flow open", /<details id="move"[^>]* open/.test(kept.html));
  check("and no edit form, which the database would refuse", !plain(kept.html).includes("Edit this copy") && !kept.html.includes('id="edit-copy"'));
  check("nor removing a piece record, also refused", plain(kept.html).includes("Old leaflet") && !plain(kept.html).includes("Remove this record"));
  // Its owner reads the excluded release's platform and game (M7b-2b), so the picker is limited to them.
  const target = hrefs(kept.html).find((h) => h.includes(`move_to=${us}`));
  check("it lists the game's other releases for the copy's platform", Boolean(target) && !hrefs(kept.html).some((h) => h.includes(`move_to=${jp}`)));
  check("and limits the search to that platform", plain(kept.html).includes("Search the catalog for Super Nintendo Entertainment System games") && !plain(kept.html).includes("the search can't be limited"));
  const searched = await owner.browser.get(`/collection/${preserved}?move_q=starfall`);
  check("searching finds the game", hrefs(searched.html).some((h) => h.includes("move_game=starfall-odyssey") && !h.includes("move_to=")));
  const confirmKept = await owner.browser.get(target.split("#")[0]);
  const recovered = await owner.browser.submit(target.split("#")[0], formById(confirmKept.html, "move-copy"), {});
  check("moving it recovers it", recovered.response.status === 303
    && psql(`select release_id || ' ' || record_status from public.collection_items where id = '${preserved}';`) === `${us} active`);
  check("with its details", psql(`select notes from public.collection_item_private where item_id = '${preserved}';`) === "Keep me");
  const recoveredPage = await owner.browser.get(`/collection/${preserved}`);
  check("and it can be edited again", recoveredPage.html.includes('id="edit-copy"') && plain(recoveredPage.html).includes("Remove this record") && !plain(recoveredPage.html).includes("the search can't be limited"));
  psql(`update public.releases set status = 'published' where id = '${jp}';`);

  section("Who sees it");
  psql(`update public.profiles set account_status = 'suspended' where id = '${owner.id}';`);
  const suspended = await owner.browser.get(`/collection/${copy}`);
  check("a suspended owner isn't offered a move", !suspended.html.includes('id="move"'));
  psql(`update public.profiles set account_status = 'active' where id = '${owner.id}';`);
  const theirs = await someone.browser.get(`/collection/${copy}`);
  check("another collector can't see the copy at all", !theirs.html.includes('id="move"') && !plain(theirs.html).includes("From a fair"));
  const files = readdirSync(join(root, ".next", "static"), { recursive: true }).filter((f) => String(f).endsWith(".js"));
  const bundle = files.map((f) => readFileSync(join(root, ".next", "static", String(f)), "utf8")).join("\n");
  check("the browser bundle calls no relinking function directly", !/relink_my_copy/.test(bundle), `${files.length} files`);
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  stopApp();
  const ids = users.map((id) => `'${id}'`).join(",") || "null";
  psql(`begin;
delete from public.collection_items where owner_id in (${ids});
create temp table sub_requests on commit drop as select * from public.catalog_change_requests where submitted_by in (${ids});
delete from public.releases where submitted_by in (${ids}) or id in (select release_id from sub_requests);
delete from public.catalog_change_requests where id in (select id from sub_requests);
commit;`);
  const deleted = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'rl\\_%';");
  const all = [...new Set([...deleted, ...users])].map((id) => `'${id}'`).join(",");
  if (all) psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${all}) or target_profile_id in (${all}); commit;`);
  removeFixture();
  check("no copies or catalog data are left behind",
    psql("select (select count(*) from public.collection_items) + (select count(*) from public.games) + (select count(*) from public.releases) + (select count(*) from public.catalog_change_requests);") === "0");
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
