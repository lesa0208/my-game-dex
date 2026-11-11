/**
 * M6d end-to-end checks: My Collection in the built app, driven over HTTP against the
 * local stack and its catalog fixture. Pages are read and forms submitted the way a
 * browser without JavaScript would, which runs the real pages, Server Actions, session
 * checks and M6b functions. Outcomes are judged by the database and by the pages
 * rendered afterwards. Messages shown with JavaScript are checked in a real browser.
 *
 *   npm run build && npm run app:my-collection-checks
 *
 * Local only. Installs the catalog fixture and removes it, and every test account, at
 * the end. Prints check names and statuses, never keys, tokens or cookies.
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
  forms,
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
  writeSession,
} from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";

const release = (code) => psql(`select id from public.releases where product_code = '${code}';`);
const releaseOf = (title) => psql(`select r.id from public.releases r join public.games g on g.id = r.game_id where g.title = '${title}' limit 1;`);
const count = (sql) => Number(psql(sql));
const copiesOf = (userId, releaseId) => count(`select count(*) from public.collection_items where owner_id = '${userId}' and release_id = '${releaseId}';`);
const text = (html) => decode(html);
const plain = (html) => decode(html.replace(/<[^>]+>/g, ""));
const ITEM_LINK = /href="\/collection\/([0-9a-f-]{36})(?:\?([^"]*))?"/g;
const rowIds = (html) => [...html.matchAll(ITEM_LINK)].map((m) => m[1]);
const rowTitles = (html) => [...html.matchAll(/<p class="font-medium text-pretty">([^<]*)<\/p>/g)].map((m) => decode(m[1]));
const nextLink = (html) => decode(/href="(\/collection\?[^"]*after=[^"]*)"[^>]*>Next page/.exec(html)?.[1] ?? "");

function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function collector(prefix = "myc") {
  const user = await createUser({ prefix });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `mc_${randomBytes(5).toString("hex")}` });
  return { ...user, browser };
}

/** Adds a copy as the user, through the M6b function and their own session. */
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

/** Every field of the edit form, as a browser sends them: the copy as it is, then the changes. */
function editFields(form, values) {
  const blank = {
    completeness: "", media_condition: "", box_condition: "", manual_condition: "", overall_condition: "",
    acquired_on: "", storage_location: "", purchase_price: "", currency: "", notes: "",
  };
  for (const name of form.names.filter((n) => n.startsWith("component_"))) blank[name] = "";
  return { ...blank, ...values };
}

let starfall;
let starfallCe;
let sequel;
let warden;
let neon;
let poketrail;
let meadow;
let orphan;

async function signedOut() {
  section("Signed out");
  const visitor = new Browser();
  const list = await visitor.get("/collection?platform=snes");
  check("My Collection sends a visitor to sign in, and back", isRedirect(list.response) && location(list.response).includes(`next=${encodeURIComponent("/collection?platform=snes")}`));
  const item = await visitor.get(`/collection/${uuidv7()}`);
  check("so does a copy's page", isRedirect(item.response) && location(item.response).includes("/sign-in"));
}

async function empty() {
  section("An empty collection");
  const user = await collector();
  const { response, html } = await user.browser.get("/collection");
  check("says it's empty and points to Explore", response.status === 200 && text(html).includes("Your collection is empty") && html.includes('href="/explore"'));
  check("and shows no summary, filters or list", !html.includes('aria-labelledby="collection-summary"') && !html.includes('role="search" aria-label="Your collection"') && rowIds(html).length === 0);
  return user;
}

async function listing() {
  section("Listing and pagination");
  const owner = await collector();
  const detailed = await add(owner, starfall, {
    completeness: "complete", box_condition: "good", media_condition: "very_good", acquired_on: "2021-03-04",
    purchase_price: "37.42", currency: "EUR", notes: "Signed by the artist", storage_location: "Shelf A",
    components: [{ kind: "insert", label: "Instruction manual", condition: null }],
  });
  const second = await add(owner, starfall, { completeness: "loose", acquired_on: "2019-01-01" });
  const third = await add(owner, starfall);
  await add(owner, starfallCe);
  await add(owner, warden, { completeness: "incomplete" });
  await add(owner, neon, { completeness: "loose", acquired_on: "2023-06-01" });
  await add(owner, poketrail, { completeness: "sealed" });
  await add(owner, meadow);
  for (let i = 0; i < 52; i += 1) await add(owner, sequel);
  // A copy whose release the catalog has since excluded, as M7 will.
  psql(`insert into public.collection_items (id, owner_id, release_id) values ('${uuidv7()}', '${owner.id}', '${orphan}');`);
  const total = count(`select count(*) from public.collection_items where owner_id = '${owner.id}';`);

  const first = await owner.browser.get("/collection");
  check("the summary counts physical copies, and platforms", text(first.html).includes(`${total} copies`) && text(first.html).includes("Physical copies on 4 platforms"));
  check("and copies no longer in the catalog", text(first.html).includes("including 1 no longer in the catalog"));
  const page1 = rowIds(first.html);
  check("the first page has 50 copies, newest first", page1.length === 50 && page1[0] === psql(`select id from public.collection_items where owner_id = '${owner.id}' order by created_at desc, id desc limit 1;`));
  const next = nextLink(first.html);
  check("with a link to the next page", next.startsWith("/collection?after="));
  const second2 = await owner.browser.get(next);
  const page2 = rowIds(second2.html);
  check("the next page has the rest, with none repeated", page2.length === total - 50 && page2.every((id) => !page1.includes(id)));
  check("and a way back to the first page, and no further page", second2.html.includes(">First page<") && !nextLink(second2.html));

  const allIds = new Set(psql(`select id from public.collection_items where owner_id = '${owner.id}';`).split("\n"));
  check("together they are exactly the user's copies", [...page1, ...page2].every((id) => allIds.has(id)) && page1.length + page2.length === allIds.size);

  const all = `${first.html}${second2.html}`;
  check("copies of one release are numbered, oldest first", text(all).includes("Copy 1 of 3") && text(all).includes("Copy 3 of 3"));
  check("numbers are the same whatever the sort or filter", (await (async () => {
    const t = text((await owner.browser.get("/collection?sort=title")).html) + text((await owner.browser.get("/collection?q=starfall&platform=snes&sort=acquired")).html);
    return t.includes("Copy 1 of 3") && t.includes("Copy 2 of 3") && t.includes("Copy 3 of 3");
  })()));
  const loose = text((await owner.browser.get("/collection?completeness=loose&platform=snes")).html);
  check("a filtered list numbers a copy among all copies of its release", loose.includes("Copy 2 of 3") && !loose.includes("Copy 1 of 1"));
  check("each copy shows what tells it apart", text(all).includes("Complete in box · Shelf A") && text(all).includes("Loose (medium only)"));
  check("a copy no longer in the catalog says so", text(all).includes("No longer in the catalog") && text(all).includes("Release no longer available"));
  check("covers are the catalog placeholder: no artwork is invented", !/<img\b/.test(first.html));

  return { owner, total, detailed, second, third };
}

async function filters({ owner, total }) {
  section("Search, filters and sorting");
  const get = async (query) => (await owner.browser.get(`/collection?${query}`)).html;

  const crystal = await get("q=crystal");
  check("a title search finds the copy", rowIds(crystal).length === 1 && rowTitles(crystal)[0] === "The Crystal Warden");
  check("ignoring accents", rowTitles(await get("q=poketrail"))[0] === "Pokétrail Rangers");
  check("a platform filter shows only that platform", rowTitles(await get("platform=playstation")).join() === "Neon Drift Racing");
  check("completeness filters, including sealed", rowTitles(await get("completeness=sealed")).join() === "Pokétrail Rangers");
  const unrecorded = await get("completeness=not_recorded&platform=snes");
  check("and not recorded", rowIds(unrecorded).length === 50 && !text(unrecorded).includes("Complete in box ·"));
  check("a status filter", rowTitles(await get("status=invalid")).join() === "Release no longer available" && rowIds(await get("status=owned")).length === 50);

  // The expected order, worked out separately in SQL from the catalog's sort keys.
  const expected = (order) => psql(`select string_agg(c.id::text, ',' order by ${order}) from (select c.* from public.collection_items c
      left join public.releases r on r.id = c.release_id left join public.games g on g.id = r.game_id and g.status = 'published'
      left join public.platforms pl on pl.id = r.platform_id and r.status = 'published'
      where c.owner_id = '${owner.id}' order by ${order} limit 50) c
      left join public.releases r on r.id = c.release_id left join public.games g on g.id = r.game_id and g.status = 'published'
      left join public.platforms pl on pl.id = r.platform_id and r.status = 'published';`);
  const titleOrder = "lower(coalesce(g.sort_title, g.title, '')), c.id";
  check("sorting by title", rowIds(await get("sort=title")).join(",") === expected(titleOrder));
  const platformOrder = "lower(coalesce(pl.name, '')), lower(coalesce(g.sort_title, g.title, '')), c.id";
  check("sorting by platform, then title", rowIds(await get("sort=platform")).join(",") === expected(platformOrder));
  const byAcquired = rowTitles(await get("sort=acquired"));
  check("sorting by acquisition date, most recent first", byAcquired.slice(0, 3).join() === "Neon Drift Racing,Starfall Odyssey,Starfall Odyssey");

  const snes = await get("platform=snes&sort=title");
  const more = nextLink(snes);
  check("paging keeps the search and sort", more.includes("platform=snes") && more.includes("sort=title"));
  const snesPage2 = await get(more.slice("/collection?".length));
  check("and the next page follows them", rowIds(snesPage2).length > 0 && rowIds(snesPage2).every((id) => !rowIds(snes).includes(id)));
  const [, query] = ITEM_LINK.exec(snesPage2) ?? [];
  ITEM_LINK.lastIndex = 0;
  const firstLink = [...snesPage2.matchAll(ITEM_LINK)][0];
  check("each copy links to its page with the view", Boolean(firstLink?.[2]?.includes("platform=snes") && firstLink[2].includes("after=")), query);
  const item = await owner.browser.get(`/collection/${firstLink[1]}?${decode(firstLink[2])}`);
  check("whose Back link returns to that view", decode(item.html).includes(`href="/collection?${decode(firstLink[2])}"`));

  const stale = await get(`platform=playstation&${more.slice(more.indexOf("after="))}`);
  check("a cursor from another view is refused safely", text(stale).includes("This page has moved on"));
  const hostile = await owner.browser.get("/collection?completeness=mint&status=gone&sort=price&platform=%27%3B");
  check("unknown filter values fall back to the full list", hostile.response.status === 200 && rowIds(hostile.html).length === 50);
  check("the filters are a plain form that works without JavaScript", /<form[^>]*action="\/collection"[^>]*role="search"/.test(snes) || /<form[^>]*role="search"[^>]*action="\/collection"/.test(snes));
  check("and the list never holds more than one page", rowIds((await owner.browser.get("/collection")).html).length === 50 && total > 50);
}

async function details({ owner, detailed, second }) {
  section("A copy's details");
  const { html, response } = await owner.browser.get(`/collection/${detailed}`);
  const page = text(html);
  check("the page shows the game, release and copy", response.status === 200 && page.includes("Starfall Odyssey") && page.includes("SNES · NTSC-U/C") && page.includes("Copy 1 of 3 of this release"));
  check("its completeness and conditions", page.includes("Complete in box") && page.includes("Cartridge condition") && page.includes("Very good"));
  check("parts not recorded say so, not that they're missing", page.includes("Manual</dt><dd class=\"break-words\">Not recorded"));
  check("the release's listed pieces, as recorded", page.includes("Instruction manual</dt><dd class=\"break-words\">Included") && page.includes("World map poster</dt><dd class=\"break-words\">Not recorded"));
  check("the owner's private details", page.includes("March 4, 2021") && page.includes("€37.42") && page.includes("Shelf A") && page.includes("Signed by the artist"));
  check("the release's catalog facts", page.includes("SNS-ZSFE-USA") && page.includes("0451234500017") && page.includes("ROM cartridge"));
  check("and no packaging the catalog doesn't record", !page.includes("Packaging"));
  const ce = await owner.browser.get(`/collection/${psql(`select id from public.collection_items where owner_id = '${owner.id}' and release_id = '${starfallCe}';`)}`);
  check("a release that records packaging shows it", text(ce.html).includes("Packaging</dt><dd class=\"break-words\">Big box") && text(ce.html).includes("Art book"));
  const bare = await owner.browser.get(`/collection/${psql(`select id from public.collection_items where owner_id = '${owner.id}' and release_id = '${warden}';`)}`);
  check("a release without listed pieces shows none", !text(bare.html).includes("Pieces listed for this release"));
  check("the other copies of the release are listed, to tell them apart", page.includes("Your 3 copies of this release") && html.includes(`href="/collection/${second}"`));
  check("with edit and remove for this copy", Boolean(formById(html, "edit-copy")) && Boolean(formById(html, "remove-copy")));
}

async function editing({ owner, detailed }) {
  section("Editing");
  const page = await owner.browser.get(`/collection/${detailed}`);
  const form = formById(page.html, "edit-copy");
  const path = `/collection/${detailed}`;
  const row = () => psql(`select concat_ws('|', coalesce(completeness::text, '-'), coalesce(box_condition::text, '-'), coalesce(media_condition::text, '-'), release_id, owner_id) from public.collection_items where id = '${detailed}';`);
  const privateRow = () => psql(`select concat_ws('|', coalesce(acquired_on::text, '-'), coalesce(purchase_price::text, '-'), coalesce(currency, '-'), coalesce(notes, '-'), coalesce(storage_location, '-')) from public.collection_item_private where item_id = '${detailed}';`);
  const pieces = () => psql(`select coalesce(string_agg(label || '=' || coalesce(condition::text, 'included'), ',' order by label), '') from public.collection_item_components where item_id = '${detailed}';`);

  check("the form starts with what's recorded", page.html.includes('value="37.42"') && decode(page.html).includes(">Signed by the artist</textarea>"));
  await owner.browser.submit(path, form, editFields(form, {
    completeness: "loose", box_condition: "not_included", media_condition: "good",
    acquired_on: "2021-03-04", storage_location: "Box 3", notes: "", currency: "EUR", component_0: "included",
  }));
  check("saving changes the copy", row() === `loose|not_included|good|${starfall}|${owner.id}`);
  check("and an emptied field is cleared, with a price's currency", privateRow() === "2021-03-04|-|-|-|Box 3");
  const after = await owner.browser.get(path);
  check("the page then shows the saved details", text(after.html).includes("Box 3") && !text(after.html).includes("Signed by the artist") && text(after.html).includes("Loose (medium only)"));

  await owner.browser.submit(path, form, editFields(form, { component_0: "included", component_1: "missing" }));
  check("pieces can be recorded as missing", pieces() === "Instruction manual=included,World map poster=not_included");
  // Fields are matched to pieces by name, not position: here the form lists them the other way round.
  const reversed = JSON.stringify([{ kind: "map", label: "World map poster" }, { kind: "insert", label: "Instruction manual" }]);
  await owner.browser.submit(path, form, editFields(form, { components: reversed, component_0: "included", component_1: "missing" }));
  check("each piece field is matched to its piece by name", pieces() === "Instruction manual=not_included,World map poster=included");
  check("and clearing everything else removes the private details", privateRow() === "");
  await owner.browser.submit(path, form, editFields(form, {}));
  check("pieces can be cleared", pieces() === "" && row() === `-|-|-|${starfall}|${owner.id}`);

  const before = row();
  await owner.browser.submit(path, form, editFields(form, { completeness: "loose", box_condition: "good" }));
  check("inconsistent details are refused", row() === before);
  await owner.browser.submit(path, form, editFields(form, { purchase_price: "12", currency: "" }));
  check("a price without a currency is refused", privateRow() === "");
  const other = await createUser({ prefix: "myc" });
  await owner.browser.submit(path, form, editFields(form, { release_id: warden, owner_id: other.id, p_owner: other.id, record_status: "invalid_preserved", completeness: "sealed" }));
  check("the release, owner and status can't be changed", row() === `sealed|-|-|${starfall}|${owner.id}` && psql(`select record_status from public.collection_items where id = '${detailed}';`) === "active");
  await new Browser().submit(path, form, editFields(form, { completeness: "complete" }));
  check("an edit without a session changes nothing", row().startsWith("sealed|"));
}

async function removing({ owner, third }) {
  section("Removing");
  const before = copiesOf(owner.id, starfall);
  const path = `/collection/${third}?platform=snes&sort=title`;
  const page = await owner.browser.get(path);
  const form = formById(page.html, "remove-copy");
  check("the confirmation names the copy", plain(page.html).includes("This removes copy 3 of Starfall Odyssey (SNES · NTSC-U/C · Standard), added "));
  check("and carries the list's view", form.hidden.platform === "snes" && form.hidden.sort === "title");
  const removed = await owner.browser.submit(path, form, {});
  check("removing goes back to the list as it was, with a notice", removed.response.status === 303 && location(removed.response) === "/collection?platform=snes&sort=title&notice=removed");
  check("only that copy is removed", copiesOf(owner.id, starfall) === before - 1 && count(`select count(*) from public.collection_items where id = '${third}';`) === 0);
  const list = await owner.browser.get(location(removed.response));
  check("the list says so, and its counts follow", text(list.html).includes("The copy was removed from your collection.") && text(list.html).includes("Copy 2 of 2") && !text(list.html).includes("of 3"));
  const gone = await owner.browser.get(`/collection/${third}`);
  check("the removed copy's page is unavailable", text(gone.html).includes("This copy isn't available"));
  const again = await owner.browser.submit(path, form, {});
  check("removing it again is safe", location(again.response).endsWith("notice=already_removed") && copiesOf(owner.id, starfall) === before - 1);
  const game = await owner.browser.get(`/games/starfall-odyssey?release=${starfall}`);
  check("and the game page's count follows", text(game.html).includes("You have 2 copies of this release"));
}

async function accounts({ owner, detailed }) {
  section("Other users and suspended accounts");
  const someone = await collector();
  const theirs = await someone.browser.get(`/collection/${detailed}`);
  check("another user's copy is unavailable, like one that doesn't exist", text(theirs.html).includes("This copy isn't available") && !text(theirs.html).includes("Starfall Odyssey"));
  const missing = await someone.browser.get(`/collection/${uuidv7()}`);
  check("and reads the same as a missing one", text(missing.html).includes("This copy isn't available"));
  const garbage = await someone.browser.get("/collection/not-a-copy");
  check("so does a malformed address", text(garbage.html).includes("This copy isn't available"));
  check("their own list shows none of the owner's copies", text((await someone.browser.get("/collection")).html).includes("Your collection is empty"));

  const ownerPage = await owner.browser.get(`/collection/${detailed}`);
  const editForm = formById(ownerPage.html, "edit-copy");
  const removeForm = formById(ownerPage.html, "remove-copy");
  await someone.browser.submit(`/collection/${detailed}`, editForm, editFields(editForm, { completeness: "complete" }));
  check("they can't edit it", psql(`select completeness from public.collection_items where id = '${detailed}';`) === "sealed");
  const theirRemove = await someone.browser.submit(`/collection/${detailed}`, removeForm, {});
  check("or remove it, and learn nothing from trying", count(`select count(*) from public.collection_items where id = '${detailed}';`) === 1 && location(theirRemove.response).endsWith("notice=already_removed"));

  psql(`update public.profiles set account_status = 'suspended' where id = '${owner.id}';`);
  const list = await owner.browser.get("/collection");
  check("a suspended account still sees its collection", list.response.status === 200 && rowIds(list.html).length === 50);
  const item = await owner.browser.get(`/collection/${detailed}`);
  check("and its copies, without the edit form", text(item.html).includes("Your account can't edit copies right now.") && !formById(item.html, "edit-copy") && Boolean(formById(item.html, "remove-copy")));
  await owner.browser.submit(`/collection/${detailed}`, editForm, editFields(editForm, { completeness: "complete" }));
  check("an edit from an earlier page is refused", psql(`select completeness from public.collection_items where id = '${detailed}';`) === "sealed");
  const removed = await owner.browser.submit(`/collection/${detailed}`, formById(item.html, "remove-copy"), {});
  check("but it can remove a copy", location(removed.response).endsWith("notice=removed") && count(`select count(*) from public.collection_items where id = '${detailed}';`) === 0);
  psql(`update public.profiles set account_status = 'active' where id = '${owner.id}';`);

  const stored = readSession(owner.browser);
  const forger = new Browser();
  const [header, payload] = stored.session.access_token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  writeSession(forger, stored.names, { ...stored.session, access_token: `${header}.${Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 3600 })).toString("base64url")}.${"A".repeat(43)}` });
  const forged = await forger.get("/collection");
  check("a forged session is sent to sign in", isRedirect(forged.response) && location(forged.response).includes("/sign-in"));
}

async function privacy({ owner }) {
  section("Privacy");
  await add(owner, neon, { notes: "Private note 9f3", storage_location: "Attic 7", purchase_price: "99.10", currency: "GBP" });
  const own = await owner.browser.get("/collection");
  check("private pages aren't cached", /no-store|private/.test(own.response.headers.get("cache-control") ?? ""), own.response.headers.get("cache-control"));
  check("the list holds no notes", !own.html.includes("Private note 9f3"));
  const visitor = new Browser();
  for (const path of [`/games/neon-drift-racing`, "/explore?q=neon", "/collection"]) {
    const { html } = await visitor.get(path);
    check(`${path} shows none of it to a visitor`, !html.includes("Private note 9f3") && !html.includes("Attic 7") && !html.includes("99.10") && !html.includes(owner.id));
  }
  const someone = await collector();
  const theirGame = await someone.browser.get("/games/neon-drift-racing");
  check("or to another collector", !theirGame.html.includes("Attic 7") && !theirGame.html.includes("Private note 9f3"));
  const session = readSession(owner.browser).session;
  check("no page contains the session's tokens", !own.html.includes(session.access_token) && !own.html.includes(session.refresh_token));

  const files = readdirSync(join(root, ".next", "static"), { recursive: true }).filter((f) => String(f).endsWith(".js"));
  const bundle = files.map((f) => readFileSync(join(root, ".next", "static", String(f)), "utf8")).join("\n");
  check("the browser bundle calls no collection function and has no Supabase client",
    !/get_my_collection|update_collection_item|remove_collection_item|add_collection_item|collection_item_private|createServerClient|signInWithPassword/.test(bundle), `${files.length} files`);
}

async function unlistedPieces() {
  section("Pieces the release no longer lists");
  const owner = await collector();
  const recorded = { components: [{ kind: "insert", label: "Art book", condition: null }, { kind: "map", label: "Cloth map", condition: "not_included" }] };
  const item = await add(owner, starfallCe, recorded);
  const twin = await add(owner, starfallCe, recorded);
  // A catalog editor drops a piece from the release's listing.
  psql(`delete from public.release_components where release_id = '${starfallCe}' and label = 'Cloth map';`);
  const pieces = (id) => psql(`select string_agg(label || '=' || coalesce(condition::text, 'included'), ',' order by label) from public.collection_item_components where item_id = '${id}';`) || "none";
  const path = `/collection/${item}`;
  const recordForm = (html, label) => forms(html).find((f) => f.hidden.label === label && "kind" in f.hidden);

  const page = await owner.browser.get(path);
  check("the copy shows its record of the piece as no longer listed", plain(page.html).includes("No longer listed for this release") && plain(page.html).includes("Cloth map") && pieces(item) === "Art book=included,Cloth map=not_included");
  const removeRecord = recordForm(page.html, "Cloth map");
  check("with a control to remove that record, and no other", Boolean(removeRecord) && removeRecord.hidden.kind === "map" && !recordForm(page.html, "Art book") && page.html.includes('aria-label="Remove this record: Cloth map"'));
  const form = formById(page.html, "edit-copy");
  check("listed pieces are editable again", form.names.includes("component_0") && !form.names.includes("component_1"));

  await owner.browser.submit(path, form, editFields(form, { component_0: "missing", notes: "Edited" }));
  check("editing a listed piece keeps the record of the unlisted one", pieces(item) === "Art book=not_included,Cloth map=not_included" && psql(`select notes from public.collection_item_private where item_id = '${item}';`) === "Edited");
  await owner.browser.submit(path, form, editFields(form, { notes: "Edited" }));
  check("clearing the listed pieces keeps it too", pieces(item) === "Cloth map=not_included");
  await owner.browser.submit(path, form, editFields(form, { components: JSON.stringify([{ kind: "insert", label: "Art book" }, { kind: "map", label: "Cloth map" }]), component_0: "included", component_1: "" }));
  check("a forged form can't clear it through the edit", pieces(item) === "Art book=included,Cloth map=not_included");

  await owner.browser.submit(path, removeRecord, { label: "Art book", kind: "insert" });
  check("the removal control can't remove a listed piece", pieces(item) === "Art book=included,Cloth map=not_included");
  await owner.browser.submit(path, removeRecord, { kind: "map';--" });
  check("or take a malformed piece", pieces(item) === "Art book=included,Cloth map=not_included");
  const someone = await collector();
  await someone.browser.submit(`/collection/${twin}`, removeRecord, { item_id: twin });
  check("another user can't remove the owner's record", pieces(twin) === "Art book=included,Cloth map=not_included");

  psql(`update public.profiles set account_status = 'suspended' where id = '${owner.id}';`);
  const suspended = await owner.browser.get(path);
  check("a suspended owner sees the record but no control to remove it", plain(suspended.html).includes("Cloth map") && !recordForm(suspended.html, "Cloth map"));
  await owner.browser.submit(path, removeRecord, {});
  check("and a removal from an earlier page is refused", pieces(item) === "Art book=included,Cloth map=not_included");
  psql(`update public.profiles set account_status = 'active' where id = '${owner.id}';`);

  await owner.browser.submit(path, removeRecord, {});
  check("the owner removes the record on purpose", pieces(item) === "Art book=included");
  check("from that copy only", pieces(twin) === "Art book=included,Cloth map=not_included");
  const after = await owner.browser.get(path);
  check("and the page no longer shows it", !plain(after.html).includes("Cloth map") && !plain(after.html).includes("No longer listed"));
  const again = await owner.browser.submit(path, removeRecord, {});
  check("removing it again is safe", again.response.status === 200 && pieces(item) === "Art book=included" && pieces(twin) === "Art book=included,Cloth map=not_included");
}

async function numbering() {
  section("Copy numbers");
  const owner = await collector();
  // More copies of one release than the numbering query reads (2,000).
  const at = Date.now() - 60000;
  const ids = Array.from({ length: 2001 }, (_, i) => uuidv7(at + i * 10));
  psql(`insert into public.collection_items (id, owner_id, release_id, created_at) select x.id::uuid, '${owner.id}', '${warden}', now() - interval '1 hour' + x.n * interval '1 millisecond' from unnest(array[${ids.map((id) => `'${id}'`).join(",")}]) with ordinality as x(id, n);`);
  const list = await owner.browser.get("/collection");
  check("over the limit, the list shows the count and no copy numbers", text(list.html).includes("2001 copies of this release") && !/Copy \d+ of/.test(text(list.html)));
  const newest = await owner.browser.get(`/collection/${ids.at(-1)}`);
  check("the newest copy's page numbers it exactly", text(newest.html).includes("Copy 2001 of 2001 of this release"));
  const oldest = await owner.browser.get(`/collection/${ids[0]}`);
  check("a copy beyond the newest 100 gets no number, rather than a wrong one", text(oldest.html).includes("Your copy of this release") && !/Copy \d+ of \d+ of this release/.test(text(oldest.html)));
  const byTitle = await owner.browser.get("/collection?sort=title&after=");
  check("and no sort shows a number either", !/Copy \d+ of/.test(text(byTitle.html)), text(byTitle.html).match(/.{80}Copy \d+ of.{80}/)?.[0]);
}

async function regressions() {
  section("The catalog and adding are unchanged");
  const visitor = new Browser();
  check("search still works signed out", (await visitor.get("/explore?q=starfall")).html.includes("Starfall Odyssey"));
  const game = await visitor.get(`/games/starfall-odyssey?release=${starfall}`);
  check("the game page stays public, with sign-in to add", game.response.status === 200 && game.html.includes("Sign in to add to your collection"));
  const user = await collector();
  const page = await user.browser.get(`/games/starfall-odyssey?release=${starfall}`);
  const form = formWith(page.html, "release_id");
  await user.browser.submit(`/games/starfall-odyssey?release=${starfall}`, form, {});
  check("adding from the game page still works", copiesOf(user.id, starfall) === 1);
  check("and the copy appears in My Collection", rowIds((await user.browser.get("/collection")).html).length === 1);
}

try {
  installFixture();
  starfall = release("SNS-ZSFE-USA");
  starfallCe = release("SNS-ZSFE-USA-CE");
  sequel = release("SNS-ZS2E-USA");
  warden = release("MK-1701");
  neon = release("SLUS-00999");
  poketrail = release("DMG-APTE-USA");
  meadow = releaseOf("Quiet Meadow");
  orphan = release("SNS-ORSE-USA");
  await startApp(3260);
  await signedOut();
  await empty();
  const state = await listing();
  await filters(state);
  await details(state);
  await editing(state);
  await removing(state);
  await accounts(state);
  await privacy(state);
  await unlistedPieces();
  await numbering();
  await regressions();
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  stopApp();
  const ids = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'mc\\_%';");
  if (ids.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${ids.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  removeFixture();
  check("no copies or catalog data are left behind", psql("select (select count(*) from public.collection_items) + (select count(*) from public.games);") === "0");
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
