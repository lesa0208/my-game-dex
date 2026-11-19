/**
 * M12b end-to-end checks: the fast add (platform, region, edition, add), ownership on
 * game pages and search results, changing a copy's identity, and the missing-game
 * fallback, in the built app over HTTP against the local stack and its catalog fixture.
 * Pages are read and forms submitted as a browser without JavaScript would, which runs
 * the real pages, Server Actions, session checks and database functions. Outcomes are
 * judged by the database and by the pages rendered afterwards.
 *
 *   npm run build && npm run app:fast-add-checks
 *
 * Local only. Installs the catalog fixture and removes it, every test account, and
 * everything they submitted, at the end. Prints check names and statuses, never keys,
 * tokens or cookies.
 */
import { randomBytes } from "node:crypto";

import {
  appErrorLines,
  Browser,
  check,
  createUser,
  decode,
  deleteUsers,
  forms,
  formWith,
  psql,
  results,
  section,
  signInAs,
  startApp,
  stopApp,
} from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";

// The page's text, without its scripts, which carry the streamed render data too.
const plain = (html) => decode(html.replace(/<script\b[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
const count = (sql) => Number(psql(sql));
const release = (code) => psql(`select id from public.releases where product_code = '${code}';`);
const GAME = "/games/starfall-odyssey";
const q = (params) => `${GAME}?${new URLSearchParams(params)}`;
const users = [];

async function collector(prefix = "fa") {
  const user = await createUser({ prefix });
  users.push(user.id);
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `fa_${randomBytes(5).toString("hex")}` });
  return { ...user, browser };
}

/** The user's copies of the fixture game, as stored: release product code, or the claim. */
function copiesOf(userId) {
  return psql(`select coalesce(r.product_code, 'claim:' || p.slug || ':' || coalesce(c.claimed_region_code, '?') || ':' || coalesce(c.claimed_edition_kind::text, '?') || ':' || coalesce(c.claimed_edition_name, '?'))
    from public.collection_items c left join public.releases r on r.id = c.release_id left join public.platforms p on p.id = c.claimed_platform_id
    where c.owner_id = '${userId}' order by 1;`)
    .split("\n")
    .filter(Boolean);
}

const claimForm = (html) => forms(html).find((f) => "platform_id" in f.hidden && "game_id" in f.hidden && !("item_id" in f.hidden && f.names.includes("region")));
const addForm = (html) => forms(html).find((f) => "release_id" in f.hidden && "item_id" in f.hidden);

let starfallUs;
let starfallCe;
let starfallId;

async function steps() {
  section("The steps offer the catalog's choices first, then another or not sure");
  const visitor = new Browser();
  const first = plain((await visitor.get(GAME)).html);
  check("the game page asks for the platform first, and offers another", first.includes("Add to your collection") && first.includes("1. Platform") && first.includes("Another platform"));
  check("a game on one platform has it chosen, so the region comes next", first.includes("2. Region") && first.includes("NTSC-U/C") && first.includes("PAL") && first.includes("NTSC-J"));
  check("with another region and Not sure", first.includes("Another region") && first.includes("Not sure"));
  check("the edition waits for the region", !first.includes("3. Edition"));

  const us = plain((await visitor.get(q({ platform: "snes", region: "ntsc-uc" }))).html);
  check("a region with two releases offers their editions, with counts", us.includes("3. Edition") && us.includes("Collector's Edition") && us.includes("Standard 1"));
  check("and another edition, or Not sure", us.includes("Another edition") && us.includes("Not sure"));
  const jp = plain((await visitor.get(q({ platform: "snes", region: "ntsc-j" }))).html);
  check("each region's editions are its own", !jp.includes("Collector's Edition"));

  const other = await visitor.get(q({ platform: "other" }));
  const otherForm = forms(other.html).find((f) => f.names.includes("platform"));
  check("another platform is chosen from the full list, without JavaScript", Boolean(otherForm) && /<option value="nes">/.test(other.html) && !/<option value="snes">/.test(other.html));
  const nes = plain((await visitor.get(q({ platform: "nes" }))).html);
  check("a platform the catalog doesn't list for the game says so", nes.includes("not in the catalog") && nes.includes("Your copy is kept as your own, unverified record"));
  check("and lists no catalog releases there", !nes.includes("Releases in the catalog"));
  const regionList = await visitor.get(q({ platform: "snes", region: "other" }));
  check("another region lists the regions the catalog lacks for it", /<option value="pal-m">/.test(regionList.html) && !/<option value="pal">/.test(regionList.html) && !/<option value="unknown">/.test(regionList.html));

  const signedOut = plain((await visitor.get(q({ platform: "snes", region: "pal", edition: "unsure" }))).html);
  check("signed out, the add asks to sign in", signedOut.includes("Sign in to add to your collection"));
  check("and nothing about anyone's collection is shown", !signedOut.includes("Owned:") && !signedOut.includes("Not in your collection"));
}

async function adding() {
  section("Adding: one published release as itself, anything else unidentified");
  const user = await collector();
  // Exactly one release: the Collector's Edition.
  const ce = await user.browser.get(q({ platform: "snes", region: "ntsc-uc", edition: "collector~Collector's Edition" }));
  const ceForm = addForm(ce.html);
  check("a choice that names one release offers it", plain(ce.html).includes("Your release: SNES · NTSC-U/C · Collector's Edition") && ceForm?.hidden.release_id === starfallCe);
  await user.browser.submit(q({ platform: "snes", region: "ntsc-uc", edition: "collector~Collector's Edition" }), ceForm, {});
  check("and adds that release", copiesOf(user.id).join() === "SNS-ZSFE-USA-CE");
  await user.browser.submit(q({ platform: "snes", region: "ntsc-uc", edition: "collector~Collector's Edition" }), ceForm, {});
  check("submitting the same form again (a double click) adds nothing more", copiesOf(user.id).length === 1);
  const again = await user.browser.get(q({ platform: "snes", region: "ntsc-uc", edition: "collector~Collector's Edition" }));
  await user.browser.submit(q({ platform: "snes", region: "ntsc-uc", edition: "collector~Collector's Edition" }), addForm(again.html), {});
  check("a second copy of the same edition, from a fresh page, is added", copiesOf(user.id).join() === "SNS-ZSFE-USA-CE,SNS-ZSFE-USA-CE");

  // The region's other release is the Standard edition.
  const plainUs = await user.browser.get(q({ platform: "snes", region: "ntsc-uc", edition: "standard~Standard" }));
  check("the region's other edition is its own choice", addForm(plainUs.html)?.hidden.release_id === starfallUs);

  // Region known, edition not sure.
  const pal = await user.browser.get(q({ platform: "snes", region: "pal", edition: "unsure" }));
  const palForm = claimForm(pal.html);
  check("a region with the edition not sure is added without a release", Boolean(palForm) && plain(pal.html).includes("Your copy: Super Nintendo Entertainment System · PAL · Edition not sure") && !addForm(pal.html));
  check("and says it's the owner's record, not a verified release", plain(pal.html).includes("not a verified release, and nothing is added to the catalog"));
  await user.browser.submit(q({ platform: "snes", region: "pal", edition: "unsure" }), palForm, { notes: "From a car boot sale", completeness: "complete" });
  await user.browser.submit(q({ platform: "snes", region: "pal", edition: "unsure" }), palForm, {});
  check("it's added once, with what the owner knows", copiesOf(user.id).filter((c) => c.startsWith("claim:")).join() === "claim:snes:pal:?:?");
  check("and the details they gave", psql(`select p.notes || '/' || c.completeness from public.collection_items c join public.collection_item_private p on p.item_id = c.id where c.owner_id = '${user.id}' and c.release_id is null;`) === "From a car boot sale/complete");

  // Region not sure, an edition from the catalog's names.
  const unsureRegion = await user.browser.get(q({ platform: "snes", region: "unsure", edition: "collector~Collector's Edition" }));
  await user.browser.submit(q({ platform: "snes", region: "unsure", edition: "collector~Collector's Edition" }), claimForm(unsureRegion.html), {});
  // Both not sure.
  const neither = await user.browser.get(q({ platform: "snes", region: "unsure", edition: "unsure" }));
  await user.browser.submit(q({ platform: "snes", region: "unsure", edition: "unsure" }), claimForm(neither.html), {});
  // Region known, an edition the catalog doesn't have, named by the owner.
  const named = await user.browser.get(q({ platform: "snes", region: "ntsc-uc", edition: "other" }));
  const namedForm = claimForm(named.html);
  check("another edition is named by the owner, with suggestions", namedForm?.names.includes("edition_name") && namedForm.names.includes("edition_kind") && named.html.includes('<option value="Greatest Hits">'));
  await user.browser.submit(q({ platform: "snes", region: "ntsc-uc", edition: "other" }), namedForm, { edition_name: "  Greatest   Hits ", edition_kind: "reprint" });
  check(
    "all four combinations of region and edition are stored as chosen, the name tidied",
    copiesOf(user.id).filter((c) => c.startsWith("claim:")).join() ===
      "claim:snes:?:?:?,claim:snes:?:collector:Collector's Edition,claim:snes:ntsc-uc:reprint:Greatest Hits,claim:snes:pal:?:?",
    copiesOf(user.id).join(),
  );
  check("no release, edition or pairing is created", count(`select count(*) from public.releases r join public.games g on g.id = r.game_id where g.title = 'Starfall Odyssey' and r.status = 'published';`) === 4);

  // A platform the catalog doesn't list for the game.
  const nes = await user.browser.get(q({ platform: "nes", region: "pal", edition: "unsure" }));
  await user.browser.submit(q({ platform: "nes", region: "pal", edition: "unsure" }), claimForm(nes.html), {});
  check("a copy on a platform the catalog doesn't list is added as the owner's own", copiesOf(user.id).includes("claim:nes:pal:?:?"));
  check("without creating a pairing", count(`select count(*) from public.game_platforms where game_id = '${starfallId}' and platform_id = (select id from public.platforms where slug = 'nes');`) === 0);
  return user;
}

async function ownership(user) {
  section("Ownership on the game page and in search results");
  const page = plain((await user.browser.get(GAME)).html);
  check("the game page says how many copies the collector has", page.includes("Owned: 7 copies"), page.match(/Owned: [^ ]+ ?\w*/)?.[0]);
  check("by platform, region and edition, counted together", page.includes("SNES · NTSC-U/C · Collector's Edition ×2"));
  check("confirmed releases and copies without one are labelled apart", page.includes("Confirmed") && page.includes("Not linked to a release"));
  check("a claim says when its platform isn't the catalog's", page.includes("platform not in the catalog for this game"));

  const search = plain((await user.browser.get("/explore?q=starfall")).html);
  check("search results show the collector's copies", search.includes("Owned: 7 copies"));
  check("only on the game they own", (search.match(/Owned:/g) ?? []).length === 1);
  const stranger = await collector("fb");
  const theirs = plain((await stranger.browser.get("/explore?q=starfall")).html);
  check("another collector sees none of it", !theirs.includes("Owned:"));
  check("nor on the game page", !plain((await stranger.browser.get(GAME)).html).includes("Owned:"));
  check("a visitor neither", !plain((await new Browser().get("/explore?q=starfall")).html).includes("Owned:"));
}

async function identity(user) {
  section("Changing what a copy is, later");
  const claimId = psql(`select id from public.collection_items where owner_id = '${user.id}' and claimed_platform_id = (select id from public.platforms where slug = 'snes') and claimed_region_code = 'pal';`);
  const before = psql(`select c.completeness || '/' || p.notes || '/' || c.created_at from public.collection_items c join public.collection_item_private p on p.item_id = c.id where c.id = '${claimId}';`);
  const page = await user.browser.get(`/collection/${claimId}`);
  const form = forms(page.html).find((f) => "item_id" in f.hidden && "game_id" in f.hidden && f.names.includes("region"));
  check("an unidentified copy's page offers to change its region and edition", plain(page.html).includes("Change the region or edition") && Boolean(form));
  check("and to link it to a release in the catalog", plain(page.html).includes("Link to a release in the catalog"));
  await user.browser.submit(`/collection/${claimId}`, form, { region: "ntsc-j", edition_name: "Platinum", edition_kind: "reprint" });
  check("the owner identifies the region and edition", copiesOf(user.id).includes("claim:snes:ntsc-j:reprint:Platinum"));
  check("everything else about the copy stays", psql(`select c.completeness || '/' || p.notes || '/' || c.created_at from public.collection_items c join public.collection_item_private p on p.item_id = c.id where c.id = '${claimId}';`) === before);
  const after = plain((await user.browser.get(`/collection/${claimId}?notice=identity`)).html);
  check("the page says it's saved", after.includes("Saved. Your copy's details are updated"));
  check("and its private history shows what it was", after.includes("What this copy was (1 change)") && after.includes("From: Not linked to a release: PAL · Edition not sure") && after.includes("To: Not linked to a release: NTSC-J · Platinum"));
  await user.browser.submit(`/collection/${claimId}`, form, { region: "", edition_name: "", edition_kind: "" });
  check("the owner can go back to not sure", copiesOf(user.id).filter((c) => c === "claim:snes:?:?:?").length === 2);

  // A copy of a release, left unidentified on request.
  const ceId = psql(`select c.id from public.collection_items c join public.releases r on r.id = c.release_id where c.owner_id = '${user.id}' and r.product_code = 'SNS-ZSFE-USA-CE' order by c.id limit 1;`);
  const cePage = await user.browser.get(`/collection/${ceId}`);
  const unlink = forms(cePage.html).find((f) => "item_id" in f.hidden && "game_id" in f.hidden && f.names.includes("region"));
  check("a copy of a release offers to keep it without one", plain(cePage.html).includes("Not sure it's this release?") && Boolean(unlink));
  check("starting from the release's region and edition", /<option value="ntsc-uc" selected=""/.test(cePage.html) && cePage.html.includes('value="Collector&#x27;s Edition"'));
  await user.browser.submit(`/collection/${ceId}`, unlink, { region: "ntsc-uc", edition_name: "Collector's Edition", edition_kind: "collector" });
  check("it becomes unidentified, as asked, and nothing else", psql(`select coalesce(release_id::text, 'none') || '/' || claimed_region_code || '/' || claimed_edition_name from public.collection_items where id = '${ceId}';`) === "none/ntsc-uc/Collector's Edition");
  check("which the history records as the owner's change", psql(`select source from private.collection_item_identity_events where item_id = '${ceId}';`) === "owner");

  const stranger = await collector("fc");
  const forged = await stranger.browser.submit(`/collection/${claimId}`, form, { region: "pal" });
  check("another collector can't change it", forged.response.status < 500 && copiesOf(user.id).filter((c) => c === "claim:snes:?:?:?").length === 2);
}

async function missingGame() {
  section("A game the catalog doesn't have: submit it, and track the copy at once");
  const user = await collector("fd");
  const none = plain((await user.browser.get("/explore?q=Zqx Lantern Moon")).html);
  check("a search with no results offers to add the game", none.includes("No games found") && none.includes("Add it to My Game Dex"));
  check("as do results that aren't it", plain((await user.browser.get("/explore?q=starfall")).html).includes("Can't find your game?"));
  const submit = await user.browser.get(`/submit?title=${encodeURIComponent("Zqx Lantern Moon")}`);
  const form = formWith(submit.html, "title");
  check("the form starts from the searched title", submit.html.includes('value="Zqx Lantern Moon"'));
  check("and offers to add the copy now, checked", /id="add_copy"[^>]*checked=""/.test(submit.html) || /checked=""[^>]*id="add_copy"/.test(submit.html));
  check("asking only for the basics, with the rest optional", ["title", "platform", "media_format", "region", "physical", "add_copy"].every((n) => form.names.includes(n)));
  await user.browser.submit("/submit", form, { title: "Zqx Lantern Moon", game_kind: "game", platform: "snes", media_format: "rom-cartridge", region: "unknown", physical: "on", add_copy: "on" });
  const releaseId = psql(`select release_id from public.catalog_change_requests where submitted_by = '${user.id}';`);
  check("the game is submitted for review, not published", psql(`select r.status from public.releases r where r.id = '${releaseId}';`) === "unverified");
  check("and the copy is in the collection at once", count(`select count(*) from public.collection_items where owner_id = '${user.id}' and release_id = '${releaseId}';`) === 1);
  const submissionId = psql(`select id from public.catalog_change_requests where submitted_by = '${user.id}';`);
  check("the submission's page says so", plain((await user.browser.get(`/submissions/${submissionId}?notice=submitted_copy`)).html).includes("your copy is in your collection, awaiting catalog approval"));
  const list = plain((await user.browser.get("/collection")).html);
  check("My Collection shows it as awaiting catalog approval", list.includes("Zqx Lantern Moon") && list.includes("Awaiting catalog approval"));
  await user.browser.submit("/submit", form, { title: "Zqx Lantern Moon", game_kind: "game", platform: "snes", media_format: "rom-cartridge", region: "pal", physical: "on", add_copy: "on" });
  check("a retry of the same form can't add a second copy", count(`select count(*) from public.collection_items where owner_id = '${user.id}';`) === 1);
  const fresh = formWith((await user.browser.get("/submit")).html, "title");
  await user.browser.submit("/submit", fresh, { title: "Zqx Ember Gate", game_kind: "game", platform: "snes", media_format: "rom-cartridge", region: "pal", physical: "on" });
  check("unchecked, the submission is made without a copy", count(`select count(*) from public.catalog_change_requests where submitted_by = '${user.id}';`) === 3 && count(`select count(*) from public.collection_items where owner_id = '${user.id}';`) === 1);
  const stranger = await collector("fe");
  check("nobody else sees the pending game", !plain((await stranger.browser.get("/explore?q=Zqx Lantern")).html).includes("Zqx Lantern Moon"));
}

try {
  installFixture();
  starfallUs = release("SNS-ZSFE-USA");
  starfallCe = release("SNS-ZSFE-USA-CE");
  starfallId = psql("select id from public.games where title = 'Starfall Odyssey';");
  await startApp(3270);
  await steps();
  const user = await adding();
  await ownership(user);
  await identity(user);
  await missingGame();
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
  psql("delete from private.handle_holds where kind = 'released' and handle like 'fa\\_%';");
  if (deleted.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${deleted.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${deleted.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  removeFixture();
  check(
    "no submissions, copies, history or catalog data are left behind",
    psql("select (select count(*) from public.catalog_change_requests) + (select count(*) from public.collection_items) + (select count(*) from public.games) + (select count(*) from public.releases) + (select count(*) from private.collection_item_identity_events);") === "0",
  );
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
