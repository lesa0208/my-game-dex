/**
 * M10c end-to-end checks: catalog editing in the built app, driven over HTTP against
 * the local stack and its catalog fixture. Forms are submitted the way a browser
 * without JavaScript would; outcomes are judged by the database and the pages
 * rendered after. Covers who reaches the editing pages, creating games and releases,
 * no self-review (D2), verification ending with an edit (D-7), the recent-verification
 * step-up without replay (D3), catalog metadata, and that no page names a creator.
 *
 *   npm run build && npm run app:editing-checks
 *
 * Local only. Removes every record, test account and the fixture at the end. Prints
 * check names and statuses, never keys, tokens or cookies.
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
  location,
  psql,
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
import { decodeClaims } from "./lib/mfa-session.mjs";

const plain = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const visible = (html) => plain(html.replace(/<script[\s\S]*?<\/script>/g, " "));
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]));
const NOT_AVAILABLE = "This page isn't available";
const TAG = `Edt${randomBytes(3).toString("hex")}`;
const users = [];
const handles = new Map();

async function person(role = null) {
  const user = await createUser({ prefix: "edt", mfa: Boolean(role) });
  users.push(user.id);
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  const handle = `ed_${randomBytes(5).toString("hex")}`;
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle });
  handles.set(user.id, handle);
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { ...user, handle, browser };
}
const game = (title) => psql(`select id from public.games where title = '${title}';`);
const release = (code) => psql(`select id from public.releases where product_code = '${code}';`);
const status = (table, id) => psql(`select status from public.${table} where id = '${id}';`);
const verifiedBy = (table, id) => psql(`select coalesce(verified_by::text, 'none') from public.${table} where id = '${id}';`);
const origin = (column, id) => psql(`select origin || '/' || coalesce(creator_id::text, '-') from private.catalog_record_origins where ${column} = '${id}';`);
/** Makes the browser's TOTP verification 11 minutes old. Only postgres can age the claim like this. */
function age(user) {
  const sessionId = decodeClaims(readSession(user.browser).session.access_token).session_id;
  psql(`update auth.mfa_amr_claims set updated_at = now() - interval '11 minutes' where session_id = '${sessionId}';`);
}
const stepUpTo = (path) => `/settings/security/verify?next=${encodeURIComponent(path)}`;

try {
  installFixture();
  await startApp(3296);
  const creator = await person("catalog_editor");
  const reviewer = await person("catalog_editor");
  const admin = await person("admin");
  const collector = await person();
  const moderator = await person("moderator");

  section("Who can reach the editing pages");
  const asCreator = await creator.browser.get("/admin/catalog/games/new");
  check("an editor gets the new-game form", Boolean(formById(asCreator.html, "new-game")));
  check("next to the warning that staff reasons are visible to other catalog staff", plain(asCreator.html).includes("Visible to other catalog staff."));
  check("a collector gets the page for an address that doesn't exist", plain((await collector.browser.get("/admin/catalog/games/new")).html).includes(NOT_AVAILABLE));
  const asModerator = await moderator.browser.get("/admin/catalog/games/new");
  check("so does a moderator", !formById(asModerator.html, "new-game"));
  const visitor = await new Browser().get("/admin/catalog/games/new");
  check("a visitor is sent to sign in", visitor.response.status === 307 || /sign-in/.test(location(visitor.response)) || /sign-in/.test(visitor.html));
  const search = await creator.browser.get("/admin/catalog/search");
  check("the catalog search links to adding a game", hrefs(search.html).includes("/admin/catalog/games/new"));

  section("Creating a game and a release");
  const form = formById(asCreator.html, "new-game");
  const noReason = await creator.browser.submit("/admin/catalog/games/new", form, { title: `${TAG} Lantern Path`, kind: "game", first_release_year: "1994", reason: "" });
  check("without a reason, nothing is created", noReason.response.status !== 303 && game(`${TAG} Lantern Path`) === "");
  const created = await creator.browser.submit("/admin/catalog/games/new", form, { title: `${TAG} Lantern Path`, kind: "game", first_release_year: "1994", reason: "From the box" });
  const g = game(`${TAG} Lantern Path`);
  check("an editor creates a game, and lands on its record", created.response.status === 303 && location(created.response) === `/admin/catalog/games/${g}?notice=created`, location(created.response));
  check("in review, recorded as created by that editor", status("games", g) === "under_review" && origin("game_id", g) === `staff/${creator.id}`);
  const forged = await collector.browser.submit("/admin/catalog/games/new", form, { title: `${TAG} Forged`, kind: "game", reason: "Forged" });
  check("a collector's forged submission creates nothing", forged.response.status !== 303 && game(`${TAG} Forged`) === "");
  const own = await creator.browser.get(`/admin/catalog/games/${g}`);
  check("its record tells the creator another editor verifies it, with no form to do it", plain(own.html).includes("You created this record, so another editor verifies and publishes it") && !formById(own.html, "verify-game"));
  check("and offers editing it and adding a release", hrefs(own.html).includes(`/admin/catalog/games/${g}/edit`) && hrefs(own.html).includes(`/admin/catalog/releases/new?game=${g}`));
  const newRelease = await creator.browser.get(`/admin/catalog/releases/new?game=${g}`);
  const releaseForm = formById(newRelease.html, "new-release");
  check("the new-release form names its game", Boolean(releaseForm) && plain(newRelease.html).includes(`New release of ${TAG} Lantern Path`));
  const details = { platform: "snes", format: "rom-cartridge", region_code: "ntsc-uc", edition_name: "Standard", edition_kind: "standard", media_count: "1", reason: "From the box" };
  const badFormat = await creator.browser.submit(`/admin/catalog/releases/new?game=${g}`, releaseForm, { ...details, format: "umd", product_code: `${TAG}-BAD` });
  check("a format the platform doesn't use is refused", badFormat.response.status !== 303 && release(`${TAG}-BAD`) === "");
  const addRelease = await creator.browser.submit(`/admin/catalog/releases/new?game=${g}`, releaseForm, { ...details, product_code: `${TAG}-1`, publisher_name: "Lumen Works" });
  const r = release(`${TAG}-1`);
  check("an editor adds a physical release, and lands on its record", addRelease.response.status === 303 && location(addRelease.response) === `/admin/catalog/releases/${r}?notice=created`);
  check("in review, recorded as theirs", status("releases", r) === "under_review" && origin("release_id", r) === `staff/${creator.id}`);

  section("Verifying and publishing, never by the creator (D2)");
  const gamePage = await reviewer.browser.get(`/admin/catalog/games/${g}`);
  const verifyGame = formById(gamePage.html, "verify-game");
  check("another editor gets the form to verify the game", Boolean(verifyGame));
  const selfVerify = await creator.browser.submit(`/admin/catalog/games/${g}`, verifyGame, { reason: "Mine" });
  check("the creator's forged verification is refused by the database", selfVerify.response.status !== 303 && verifiedBy("games", g) === "none");
  const verified = await reviewer.browser.submit(`/admin/catalog/games/${g}`, verifyGame, { reason: "Title and year checked" });
  check("the other editor verifies it", verified.response.status === 303 && location(verified.response) === `/admin/catalog/games/${g}?notice=verified` && verifiedBy("games", g) === reviewer.id);
  const releasePage = await reviewer.browser.get(`/admin/catalog/releases/${r}`);
  const verifyRelease = formById(releasePage.html, "verify-release");
  check("and gets the form to verify the release", Boolean(verifyRelease));
  await reviewer.browser.submit(`/admin/catalog/releases/${r}`, verifyRelease, { reason: "Serial checked" });
  check("which they verify", verifiedBy("releases", r) === reviewer.id);
  const publishPage = await reviewer.browser.get(`/admin/catalog/releases/${r}`);
  const publishForm = formById(publishPage.html, "publish-release");
  check("then get the form to publish it", Boolean(publishForm));
  const selfPublish = await creator.browser.submit(`/admin/catalog/releases/${r}`, publishForm, { reason: "Mine" });
  check("the creator's forged publication is refused by the database", selfPublish.response.status !== 303 && status("releases", r) === "under_review");
  check("and their record page has no form to publish", !formById((await creator.browser.get(`/admin/catalog/releases/${r}`)).html, "publish-release"));
  const published = await reviewer.browser.submit(`/admin/catalog/releases/${r}`, publishForm, { reason: "Ready" });
  check("the other editor publishes it, with its game", published.response.status === 303 && status("releases", r) === "published" && status("games", g) === "published");
  const slug = psql(`select slug from public.games where id = '${g}';`);
  check("which a visitor now sees", visible((await new Browser().get(`/games/${slug}`)).html).includes(`${TAG} Lantern Path`));

  section("A change ends a verification (D-7)");
  const r2Form = formById((await creator.browser.get(`/admin/catalog/releases/new?game=${g}`)).html, "new-release");
  await creator.browser.submit(`/admin/catalog/releases/new?game=${g}`, r2Form, { ...details, region_code: "pal", product_code: `${TAG}-2` });
  const r2 = release(`${TAG}-2`);
  await reviewer.browser.submit(`/admin/catalog/releases/${r2}`, formById((await reviewer.browser.get(`/admin/catalog/releases/${r2}`)).html, "verify-release"), { reason: "Checked" });
  check("a second release is verified", verifiedBy("releases", r2) === reviewer.id);
  const editPage = await creator.browser.get(`/admin/catalog/releases/${r2}/edit`);
  const editForm = formById(editPage.html, "edit-release");
  check("the creator may edit it", Boolean(editForm));
  const edit = { region_code: "pal", edition_name: "Standard", edition_kind: "standard", media_count: "1", product_code: `${TAG}-2`, publisher_name: "Lumen Works Europe", reason: "From the box" };
  const saved = await creator.browser.submit(`/admin/catalog/releases/${r2}/edit`, editForm, edit);
  check("a descriptive edit is saved", saved.response.status === 303 && psql(`select publisher_name from public.releases where id = '${r2}';`) === "Lumen Works Europe");
  check("and ends the verification", verifiedBy("releases", r2) === "none" && psql(`select verified_at is null from public.releases where id = '${r2}';`) === "t");
  const unchanged = await creator.browser.submit(`/admin/catalog/releases/${r2}/edit`, formById((await creator.browser.get(`/admin/catalog/releases/${r2}/edit`)).html, "edit-release"), edit);
  check("saving it unchanged is refused as nothing changed", unchanged.response.status !== 303);
  const stale = await creator.browser.submit(`/admin/catalog/releases/${r2}/edit`, editForm, { ...edit, publisher_name: "Stale page" });
  check("a form from before the edit is refused: the record changed since", stale.response.status !== 303 && psql(`select publisher_name from public.releases where id = '${r2}';`) === "Lumen Works Europe");

  section("A recent verification, without replay (D3)");
  const r2Verify = formById((await reviewer.browser.get(`/admin/catalog/releases/${r2}`)).html, "verify-release");
  age(reviewer);
  const gatedRecord = await reviewer.browser.get(`/admin/catalog/releases/${r2}`);
  check("with a verification 11 minutes old, the record asks to verify first, with no form",
    !formById(gatedRecord.html, "verify-release") && hrefs(gatedRecord.html).includes(stepUpTo(`/admin/catalog/releases/${r2}`)));
  const staleVerify = await reviewer.browser.submit(`/admin/catalog/releases/${r2}`, r2Verify, { reason: "Again" });
  check("a verification submitted anyway goes to step-up, and changes nothing", location(staleVerify.response) === stepUpTo(`/admin/catalog/releases/${r2}`) && verifiedBy("releases", r2) === "none",
    location(staleVerify.response));
  const unpublishedEdit = await reviewer.browser.get(`/admin/catalog/releases/${r2}/edit`);
  check("editing an unpublished release needs only the live session", Boolean(formById(unpublishedEdit.html, "edit-release")));
  const publishedEdit = await reviewer.browser.get(`/admin/catalog/releases/${r}/edit`);
  check("editing a published one asks to verify first", !formById(publishedEdit.html, "edit-release") && hrefs(publishedEdit.html).includes(stepUpTo(`/admin/catalog/releases/${r}/edit`)));
  check("while its locks, which aren't public, stay available", Boolean(formById(publishedEdit.html, "set-release-lock")));
  const back = await verifyBrowser(reviewer.browser, reviewer, `/admin/catalog/releases/${r2}`);
  check("verifying returns to the same record, with nothing done for them", location(back.response) === `/admin/catalog/releases/${r2}` && verifiedBy("releases", r2) === "none");
  const again = await reviewer.browser.get(`/admin/catalog/releases/${r2}`);
  const againForm = formById(again.html, "verify-release");
  check("the form is back, at the record's current revision", Boolean(againForm) && againForm.hidden.revision === psql(`select revision from public.releases where id = '${r2}';`));
  const reverified = await reviewer.browser.submit(`/admin/catalog/releases/${r2}`, againForm, { reason: "Checked again" });
  check("and verifies it now", reverified.response.status === 303 && verifiedBy("releases", r2) === reviewer.id);
  const pubEdit = formById((await reviewer.browser.get(`/admin/catalog/releases/${r}/edit`)).html, "edit-release");
  const pubSaved = await reviewer.browser.submit(`/admin/catalog/releases/${r}/edit`, pubEdit, { ...edit, region_code: "ntsc-uc", product_code: `${TAG}-1`, publisher_name: "Lumen Works", packaging: "Box", reason: "Seen on the box" });
  check("a published release is edited with a recent verification, and stays published", pubSaved.response.status === 303 && status("releases", r) === "published" && psql(`select packaging from public.releases where id = '${r}';`) === "Box");

  section("Catalog metadata");
  const gameEdit = await reviewer.browser.get(`/admin/catalog/games/${g}/edit`);
  const alias = await reviewer.browser.submit(`/admin/catalog/games/${g}/edit`, formById(gameEdit.html, "add-alias"), { alias_title: `${TAG} Lantern Road`, alias_kind: "alternate", alias_language: "", alias_region: "", reason: "Box title" });
  check("an editor adds another title", alias.response.status === 303 && psql(`select count(*) from public.game_aliases where game_id = '${g}' and title = '${TAG} Lantern Road';`) === "1");
  const other = game("Twin Harbor").split("\n")[0];
  const relation = await reviewer.browser.submit(`/admin/catalog/games/${g}/edit`, formById((await reviewer.browser.get(`/admin/catalog/games/${g}/edit`)).html, "set-relation"), { relation: "remake_of", target_id: other, position: "", relation_note: "", reason: "A remake" });
  check("relates the game to another", relation.response.status === 303 && psql(`select count(*) from public.game_relations where source_game_id = '${g}' and target_game_id = '${other}';`) === "1");
  const platform = await reviewer.browser.submit(`/admin/catalog/games/${g}/edit`, formById((await reviewer.browser.get(`/admin/catalog/games/${g}/edit`)).html, "add-platform"), { platform: "nes", reason: "Also on NES" });
  check("adds a platform, in review", platform.response.status === 303 && psql(`select gp.status from public.game_platforms gp join public.platforms p on p.id = gp.platform_id where gp.game_id = '${g}' and p.slug = 'nes';`) === "under_review");
  const lock = await reviewer.browser.submit(`/admin/catalog/games/${g}/edit`, formById((await reviewer.browser.get(`/admin/catalog/games/${g}/edit`)).html, "set-lock"), { field: "title", locked: "yes", reason: "Confirmed" });
  check("and locks the title against imports", lock.response.status === 303 && psql(`select count(*) from private.catalog_field_locks where game_id = '${g}' and field_name = 'title';`) === "1");
  const markets = await reviewer.browser.submit(`/admin/catalog/releases/${r}/edit`, formById((await reviewer.browser.get(`/admin/catalog/releases/${r}/edit`)).html, "set-markets"), { markets: "us, ca", reason: "From the box" });
  check("records the markets a release was sold in", markets.response.status === 303 && psql(`select string_agg(market_code, ',' order by market_code) from public.release_markets where release_id = '${r}';`) === "CA,US");
  const badMarkets = await reviewer.browser.submit(`/admin/catalog/releases/${r}/edit`, formById((await reviewer.browser.get(`/admin/catalog/releases/${r}/edit`)).html, "set-markets"), { markets: "US, XX", reason: "Typo" });
  check("an unknown market code is refused", badMarkets.response.status !== 303 && psql(`select count(*) from public.release_markets where release_id = '${r}';`) === "2");
  const pieces = formById((await reviewer.browser.get(`/admin/catalog/releases/${r}/edit`)).html, "set-pieces");
  const piecesSaved = await reviewer.browser.submit(`/admin/catalog/releases/${r}/edit`, pieces, { piece_kind_0: "insert", piece_label_0: "Instruction manual", piece_quantity_0: "1", reason: "From the box" });
  check("and what's in the box", piecesSaved.response.status === 303 && psql(`select string_agg(label, ',') from public.release_components where release_id = '${r}';`) === "Instruction manual");
  check("each change is in the record's history", visible((await reviewer.browser.get(`/admin/catalog/games/${g}`)).html).includes("A remake"));

  section("Nothing names who created or verified a record");
  // Each page carries its viewer's own session; nothing about anyone else. History names
  // staff by handle for what they did (M10b, D4); the record itself names nobody.
  for (const [who, viewer] of [["the creator", creator], ["another editor", reviewer], ["an administrator", admin]]) {
    const browser = viewer.browser;
    const pages = await Promise.all([`/admin/catalog/games/${g}`, `/admin/catalog/releases/${r}`, `/admin/catalog/games/${g}/edit`, `/admin/catalog/releases/${r}/edit`].map((p) => browser.get(p)));
    const html = pages.map((p) => p.html).join("\n");
    const others = [creator, reviewer, admin].filter((u) => u.id !== viewer.id).flatMap((u) => [u.id, u.email]);
    check(`${who}'s pages carry no other account's id or email, and no creator or verifier field`,
      ![...others, "creator_id", "verified_by", "created_by"].some((x) => html.includes(x)));
  }

  const above = visible((await reviewer.browser.get(`/admin/catalog/releases/${r}`)).html.split('id="history"')[0]);
  check("above its history, a record names neither its creator nor its verifier", !above.includes(creator.handle) && !above.includes(reviewer.handle));

  const files = readdirSync(join(root, ".next", "static"), { recursive: true }).filter((f) => String(f).endsWith(".js"));
  const bundle = files.map((f) => readFileSync(join(root, ".next", "static", String(f)), "utf8")).join("\n");
  check("the browser bundle calls no catalog editing function directly",
    !/create_game|create_release|update_game|update_release|verify_game|verify_release|publish_release|set_release_markets|set_catalog_field_lock|add_game_alias/.test(bundle), `${files.length} files`);
  const errors = appErrorLines();
  check("the app logged no errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  stopApp();
  // Not in replica mode, so the records take their provenance, pairings and pieces with them.
  psql(`begin;
create temp table our_games on commit drop as select id from public.games where title like '${TAG}%';
delete from private.catalog_field_locks where game_id in (select id from our_games) or release_id in (select id from public.releases where game_id in (select id from our_games));
delete from public.release_components where release_id in (select id from public.releases where game_id in (select id from our_games));
delete from public.release_markets where release_id in (select id from public.releases where game_id in (select id from our_games));
delete from public.releases where game_id in (select id from our_games);
delete from public.game_relations where source_game_id in (select id from our_games) or target_game_id in (select id from our_games);
delete from public.game_aliases where game_id in (select id from our_games);
delete from public.games where id in (select id from our_games);
commit;`);
  const ids = await deleteUsers();
  const list = ids.map((id) => `'${id}'`).join(",") || "null";
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ed\\_%';");
  removeFixture();
  check("no record, account, provenance, hold or audit row is left behind",
    psql(`select (select count(*) from public.games where title like '${TAG}%') + (select count(*) from auth.users where id in (${list}))
      + (select count(*) from private.catalog_record_origins o where not exists (select 1 from public.games g where g.id = o.game_id) and not exists (select 1 from public.releases r where r.id = o.release_id))
      + (select count(*) from private.handle_holds where handle like 'ed\\_%') + (select count(*) from private.audit_events where actor_id in (${list}));`) === "0");
  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  process.exit(results.failed ? 1 : 0);
}
