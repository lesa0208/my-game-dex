/**
 * M12 W2 end-to-end checks: the physical wishlist in the app. /collection/wishlist, an
 * entry's page, the wishlist on a game's page, navigation and the personal data export,
 * driven over HTTP as a browser without JavaScript would, against the production build,
 * the isolated test stack and its fictional catalog fixture. Throwaway accounts only;
 * wishes and copies are made through the app's own forms or W1's functions, as the
 * collector. Catalog changes (an exclusion, a merge, a withdrawn pairing, an excluded
 * game) are simulated in the fixture by postgres, as the fixture itself does, and undone.
 *
 * A real browser (Edge, or Chrome) then runs the pages with JavaScript: axe-core at phone
 * and desktop widths, keyboard use, the browser's back button and, with
 * WISHLIST_SCREENSHOTS=<folder>, screenshots.
 *
 *   npm run build && MGD_STACK=test npm run app:wishlist-checks
 *
 * Local only. Installs the catalog fixture and removes it, and every test account, at the
 * end, then checks nothing is left behind. Prints check names and statuses, never keys,
 * tokens, cookies or addresses.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { api, appErrorLines, Browser, check, createUser, decode, deleteUsers, formById, forms, isRedirect, location, psql, publishableKey, readSession, results, root, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { footprint } from "./lib/footprint.mjs";

/**
 * The page as a browser shows it: React streams parts of a page as segments (a
 * <template id="P:n"> where they go, and a hidden <div id="S:n"> later on, which its
 * script moves into place). This puts each segment where its placeholder is.
 */
function resolveSegments(html) {
  const segments = new Map([...html.matchAll(/<div hidden id="S:([^"]+)">([\s\S]*?)<\/div><script>\$RS\("S:\1"/g)].map((m) => [m[1], m[2]]));
  let out = html;
  for (let i = 0; i < 20 && /<template id="P:[^"]+"><\/template>/.test(out); i += 1) {
    out = out.replace(/<template id="P:([^"]+)"><\/template>/g, (whole, id) => segments.get(id) ?? whole);
  }
  return out;
}
for (const method of ["get", "submit"]) {
  const original = Browser.prototype[method];
  Browser.prototype[method] = async function (...args) {
    const result = await original.apply(this, args);
    return { ...result, raw: result.html, html: resolveSegments(result.html) };
  };
}

const plain = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;
const WISHLIST = "/collection/wishlist";

function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// The fixture's records
// ---------------------------------------------------------------------------

const one = (query) => {
  const value = psql(query);
  if (!value) throw new Error(`fixture record missing: ${query.slice(0, 80)}`);
  return value;
};
const gameId = (title) => one(`select id from public.games where title = ${sql(title)} and status = 'published' limit 1;`);
const slugOf = (title) => one(`select slug from public.games where title = ${sql(title)} and status = 'published' limit 1;`);
const releaseByCode = (code) => one(`select id from public.releases where product_code = ${sql(code)} and status = 'published' limit 1;`);
const platformId = (slug) => one(`select id from public.platforms where slug = ${sql(slug)};`);

let F = null;
function fixture() {
  return {
    starfall: { id: gameId("Starfall Odyssey"), slug: slugOf("Starfall Odyssey") },
    neon: { id: gameId("Neon Drift Racing"), slug: slugOf("Neon Drift Racing") },
    tessaly: { id: gameId("Echoes of Tessaly"), slug: slugOf("Echoes of Tessaly") },
    meadow: { id: gameId("Quiet Meadow"), slug: slugOf("Quiet Meadow") },
    us: releaseByCode("SNS-ZSFE-USA"),
    eu: releaseByCode("SNSP-ZSFP-EUR"),
    jp: releaseByCode("SHVC-ZSFJ-JPN"),
    ce: releaseByCode("SNS-ZSFE-USA-CE"),
    meadowRelease: one(`select r.id from public.releases r join public.games g on g.id = r.game_id where g.title = 'Quiet Meadow' and r.status = 'published' limit 1;`),
    snes: platformId("snes"),
    playstation: platformId("playstation"),
    saturn: platformId("sega-saturn"),
    nes: platformId("nes"),
  };
}

// ---------------------------------------------------------------------------
// Accounts and requests
// ---------------------------------------------------------------------------

async function collector(prefix) {
  const user = await createUser({ prefix });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  const handle = `wl_${randomBytes(5).toString("hex")}`;
  await browser.submit("/welcome", forms(welcome.html).find((f) => f.names.includes("handle")), { handle });
  return { ...user, handle, browser };
}

async function rpc(owner, name, body) {
  const { session } = readSession(owner.browser);
  const response = await fetch(`${api}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

const addCopy = async (owner, releaseId, details = {}) => (await rpc(owner, "add_collection_item", { p_item_id: uuidv7(), p_release: releaseId, p_details: details })).json?.item_id;
const wishes = (owner) => Number(psql(`select count(*) from public.wishlist_items where owner_id = ${sql(owner.id)};`));
const wishRow = (id) => {
  const row = psql(`select coalesce(release_id::text, '-') || '|' || coalesce(game_id::text, '-') || '|' || coalesce(platform_id::text, '-') || '|' || coalesce(region_code, '-') || '|' || priority || '|' || coalesce(completeness::text, '-') || '|' || coalesce(note, '-') from public.wishlist_items where id = ${sql(id)};`);
  if (!row) return null;
  const [release, game, platform, region, priority, completeness, note] = row.split("|");
  const n = (v) => (v === "-" ? null : v);
  return { release: n(release), game: n(game), platform: n(platform), region: n(region), priority: Number(priority), completeness: n(completeness), note: n(note) };
};
const findWish = (owner, where) => psql(`select id from public.wishlist_items where owner_id = ${sql(owner.id)} and ${where} limit 1;`);

const gamePath = (slug) => `/games/${slug}`;

/** Adds through the game page's "Add to wishlist" form, as a browser without JavaScript. */
async function addFromGame(user, slug, fields) {
  const page = await user.browser.get(gamePath(slug));
  const form = formById(page.html, "add-wish");
  if (!form) return { form: null, result: null };
  const result = await user.browser.submit(gamePath(slug), form, { priority: "2", completeness: "", note: "", ...fields });
  return { form, result };
}

/** A release's "Want this release" form on the game page. */
function wantForm(html, releaseId) {
  return forms(html).find((f) => f.hidden.level === "release" && f.hidden.release_id === releaseId) ?? null;
}

/** The edit form of an entry, with every field filled as the page shows it, then `changes`. */
async function editWish(user, id, changes) {
  const path = `${WISHLIST}/${id}`;
  const page = await user.browser.get(path);
  const form = formById(page.raw, "edit-wish");
  if (!form) return null;
  const shown = shownFields(page.raw);
  if (process.env.WISHLIST_DEBUG) writeFileSync(join(process.env.WISHLIST_DEBUG, `edit-${id}.html`), page.raw);
  const result = await user.browser.submit(path, form, { ...shown, ...changes });
  if (process.env.WISHLIST_DEBUG) {
    const start = result.html.indexOf('id="edit-wish"');
    const formHtml = result.html.slice(start, result.html.indexOf("</form>", start));
    const message = (role) => plain(new RegExp(`role="${role}"[^>]*>([\\s\\S]*?)</div>`).exec(formHtml)?.[1] ?? "");
    console.log("  edit", JSON.stringify({ ...shown, ...changes }).slice(0, 400), "->", message("alert"), "|", message("status"));
  }
  return result;
}

/** The values the edit form starts with: the checked level, selected options and the note. */
function shownFields(html) {
  const start = html.indexOf('id="edit-wish"');
  const form = html.slice(start, html.indexOf("</form>", start));
  const fields = {};
  // React writes the attributes in its own order (checked can come before value).
  const radios = [...form.matchAll(/<input\b[^>]*name="level"[^>]*>/g)].map((m) => m[0]);
  const level = radios.find((tag) => /\bchecked\b/.test(tag) || /type="hidden"/.test(tag));
  if (level) fields.level = /\bvalue="([^"]+)"/.exec(level)[1];
  for (const [, name, inner] of form.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...inner.matchAll(/<option\b[^>]*>/g)].map((m) => m[0]);
    const selected = options.find((tag) => /\bselected\b/.test(tag)) ?? options[0];
    fields[name] = selected ? decode(/\bvalue="([^"]*)"/.exec(selected)?.[1] ?? "") : "";
  }
  const note = /<textarea[^>]*name="note"[^>]*>([\s\S]*?)<\/textarea>/.exec(form);
  fields.note = note ? decode(note[1]) : "";
  return fields;
}

/** The remove form of an entry on a page. */
const removeForm = (html, id) => forms(html).find((f) => f.hidden.wish_id === id && f.names.length === 0) ?? null;

/** The entries the wishlist page lists, by their edit links, in order. */
const listed = (html) => [...new Set([...html.matchAll(/<article aria-labelledby="wish-([0-9a-f-]{36})"/g)].map((m) => m[1]))];
const nextCursor = (html) => decode(/href="\/collection\/wishlist\?([^"]*after=[^"]+)"[^>]*>Next page/.exec(html)?.[1] ?? "");

async function download(user) {
  const origin = `http://127.0.0.1:${PORT}`;
  const response = await fetch(`${origin}/settings/account/export`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: user.browser.cookieHeader(), origin, "content-type": "application/x-www-form-urlencoded" },
    body: "",
  });
  user.browser.store(response);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, text, data };
}

const PORT = 3290;

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const people = {};

async function signedOut() {
  section("Signed out");
  const visitor = new Browser();
  const list = await visitor.get(WISHLIST);
  check("the wishlist sends a visitor to sign in, and back", isRedirect(list.response) && location(list.response).includes("/sign-in") && decodeURIComponent(location(list.response)).includes(WISHLIST), location(list.response));
  const entry = await visitor.get(`${WISHLIST}/${uuidv7()}`);
  check("so does an entry's page", isRedirect(entry.response) && location(entry.response).includes("/sign-in"));
  const game = await visitor.get(gamePath(F.starfall.slug));
  const text = plain(game.html);
  check("the game page stays public, with sign-in to add to the wishlist", game.response.status === 200 && text.includes("Sign in to add to your wishlist"));
  check("and no wishlist controls or anyone's wishes", !formById(game.html, "add-wish") && !wantForm(game.html, F.us) && !game.html.includes('aria-label="Your wishes for this game"'));
  const anon = await fetch(`${api}/rest/v1/rpc/get_my_wishlist`, { method: "POST", headers: { apikey: publishableKey, Authorization: `Bearer ${publishableKey}`, "Content-Type": "application/json" }, body: "{}" });
  check("W1's functions refuse anon", anon.status === 401 || anon.status === 403, `status ${anon.status}`);
  const table = await fetch(`${api}/rest/v1/wishlist_items?select=id`, { headers: { apikey: publishableKey, Authorization: `Bearer ${publishableKey}` } });
  check("and the table is closed to anon", table.status === 401 || table.status === 403, `status ${table.status}`);
}

async function emptyAndAdding() {
  section("An empty wishlist");
  const owner = (people.owner = await collector("wlo"));
  const empty = await owner.browser.get(WISHLIST);
  check("a new collector's wishlist says it's empty, and where to find games", empty.response.status === 200 && plain(empty.html).includes("Your wishlist is empty") && empty.html.includes('href="/explore"'));

  section("Adding all four levels from the game page");
  const game = await owner.browser.get(gamePath(F.starfall.slug));
  check("the game page has the wishlist panel for the collector", plain(game.html).includes("Your wishlist") && plain(game.html).includes("This game isn't on your wishlist"));
  const add = formById(game.html, "add-wish");
  check("with one form for the four levels", Boolean(add) && ["level", "platform_id", "region_code", "release_id", "priority", "completeness", "note"].every((n) => add.names.includes(n)));
  check("the form offers only the game's published platforms", game.html.includes(`value="${F.snes}"`) && !new RegExp(`<option value="${F.nes}"`).test(game.html.slice(game.html.indexOf('id="add-wish"'))));
  check("the form posts to the server action without JavaScript", Object.keys(add?.hidden ?? {}).some((n) => n.startsWith("$ACTION_")));

  await owner.browser.submit(gamePath(F.starfall.slug), add, { level: "game", priority: "1", completeness: "", note: "Any copy will do" });
  const anyId = findWish(owner, `game_id = ${sql(F.starfall.id)} and platform_id is null and release_id is null`);
  check("any version: added, with no platform, region or release", Boolean(anyId) && wishRow(anyId)?.priority === 1 && wishRow(anyId)?.note === "Any copy will do");
  people.anyId = anyId;

  const repeat = await owner.browser.submit(gamePath(F.starfall.slug), add, { level: "game", priority: "1", completeness: "", note: "Any copy will do" });
  check("resubmitting the same form, as a retry does, adds nothing", repeat.response.status === 200 && wishes(owner) === 1);
  await addFromGame(owner, F.starfall.slug, { level: "game" });
  check("the same target from a fresh form isn't added twice", wishes(owner) === 1);

  await addFromGame(owner, F.starfall.slug, { level: "platform", platform_id: F.snes });
  const platformWish = findWish(owner, `game_id = ${sql(F.starfall.id)} and platform_id = ${sql(F.snes)} and region_code is null`);
  check("on a platform: the game on SNES", Boolean(platformWish));
  people.platformWish = platformWish;

  await addFromGame(owner, F.starfall.slug, { level: "region", platform_id: F.snes, region_code: "pal", completeness: "complete" });
  const regionWish = findWish(owner, `game_id = ${sql(F.starfall.id)} and platform_id = ${sql(F.snes)} and region_code = 'pal'`);
  check("on a platform from a region: SNES, PAL, complete in box or better", Boolean(regionWish) && wishRow(regionWish)?.completeness === "complete");
  people.regionWish = regionWish;

  await addFromGame(owner, F.starfall.slug, { level: "region", platform_id: F.snes, region_code: "ntsc-k" });
  const korea = findWish(owner, `game_id = ${sql(F.starfall.id)} and region_code = 'ntsc-k'`);
  check("a region with no catalogued release of the game can still be wanted", Boolean(korea));
  people.korea = korea;

  const page = await owner.browser.get(gamePath(F.starfall.slug));
  const want = wantForm(page.html, F.eu);
  check("each published release has its own “Want this release”", Boolean(want) && [F.us, F.jp, F.ce].every((id) => wantForm(page.html, id)));
  check("kept apart from adding a copy: it carries no copy details", want?.names.length === 0 && !("components" in (want?.hidden ?? {})));
  await owner.browser.submit(gamePath(F.starfall.slug), want, {});
  const exact = findWish(owner, `release_id = ${sql(F.eu)}`);
  check("one exact release: the PAL release", Boolean(exact) && wishRow(exact)?.game === null);
  people.exact = exact;
  await owner.browser.submit(gamePath(F.starfall.slug), want, {});
  check("wanting it again adds nothing", Number(psql(`select count(*) from public.wishlist_items where owner_id = ${sql(owner.id)} and release_id = ${sql(F.eu)};`)) === 1);

  await owner.browser.submit(gamePath(F.starfall.slug), wantForm(page.html, F.ce), {});
  await owner.browser.submit(gamePath(F.starfall.slug), wantForm(page.html, F.jp), {});
  people.ceWish = findWish(owner, `release_id = ${sql(F.ce)}`);
  people.jpWish = findWish(owner, `release_id = ${sql(F.jp)}`);
  check("several wanted editions of one game stay separate", Boolean(people.ceWish && people.jpWish && people.exact) && wishes(owner) === 7, `${wishes(owner)}`);

  const after = await owner.browser.get(gamePath(F.starfall.slug));
  const afterText = plain(after.html);
  const panel = after.html.slice(after.html.indexOf('aria-label="Your wishes for this game"'));
  check("the game page lists the collector's wishes for it", [anyId, platformWish, regionWish, exact].every((id) => panel.includes(`/collection/wishlist/${id}`)));
  check("a wanted release says so, with a link to edit it, instead of a second button", !wantForm(after.html, F.eu) && afterText.includes("On your wishlist") && after.html.includes(`href="/collection/wishlist/${exact}"`));
  check("the panel tells the levels apart", afterText.includes("Any physical version") && afterText.includes("SNES · any region") && afterText.includes("SNES · PAL · any edition") && afterText.includes("Exact release"));

  section("Refused targets");
  const before = wishes(owner);
  await addFromGame(owner, F.starfall.slug, { level: "platform", platform_id: F.playstation });
  check("a platform the catalog doesn't list for the game is refused", wishes(owner) === before);
  await addFromGame(owner, F.starfall.slug, { level: "region", platform_id: F.snes, region_code: "unknown" });
  await addFromGame(owner, F.starfall.slug, { level: "region", platform_id: F.snes, region_code: "atlantis" });
  check("so are the unknown region and one the catalog doesn't list", wishes(owner) === before);
  await addFromGame(owner, F.starfall.slug, { level: "region", platform_id: F.snes });
  check("and a region level without a region", wishes(owner) === before);
  const draft = psql(`select id from public.releases where product_code = 'SNS-ZSFE-DRAFT';`);
  await owner.browser.submit(gamePath(F.starfall.slug), { hidden: { ...want.hidden, item_id: uuidv7(), release_id: draft } }, {});
  check("and an unpublished release", wishes(owner) === before && !findWish(owner, `release_id = ${sql(draft)}`));
  await addFromGame(owner, F.starfall.slug, { level: "platform", platform_id: F.snes, region_code: "ntsc-j", note: "x".repeat(501) });
  check("and a note over 500 characters", wishes(owner) === before);
  const stale = await owner.browser.submit(gamePath(F.starfall.slug), { hidden: { ...add.hidden, item_id: uuidv7(Date.now() - 2 * 86400000) } }, { level: "game", priority: "2", completeness: "", note: "" });
  check("a stale request id adds nothing", stale.response.status === 200 && wishes(owner) === before);

  const other = (people.other = await collector("wlx"));
  const spoofed = await owner.browser.submit(gamePath(F.neon.slug), formById((await owner.browser.get(gamePath(F.neon.slug))).html, "add-wish"), { level: "game", priority: "2", completeness: "", note: "", owner_id: other.id, p_owner: other.id });
  check("naming another owner in the form changes nothing: the wish is the collector's own", spoofed.response.status === 200 && wishes(other) === 0 && Boolean(findWish(owner, `game_id = ${sql(F.neon.id)}`)));
  people.neonWish = findWish(owner, `game_id = ${sql(F.neon.id)} and platform_id is null`);
}

async function ownership() {
  section("Ownership and completeness");
  const owner = people.owner;
  const before = wishes(owner);
  await addCopy(owner, F.eu, { completeness: "complete" });
  await addCopy(owner, F.eu, {});
  await addCopy(owner, F.eu, { completeness: "loose" });
  await addCopy(owner, F.us, { completeness: "sealed" });
  check("adding copies never removes a wish", wishes(owner) === before);

  const list = await owner.browser.get(WISHLIST);
  const text = plain(list.html);
  const entry = (id) => {
    const start = list.html.indexOf(`aria-labelledby="wish-${id}"`);
    return plain(list.html.slice(start, list.html.indexOf("</article>", start)));
  };
  check("an exact release counts only copies of that release", entry(people.exact).includes("You own 3 copies of this release"), entry(people.exact).slice(0, 200));
  check("with no minimum, every copy counts", !entry(people.exact).includes("meet your minimum"));
  check("a region wish with a minimum: unknown completeness and loose copies don't meet it", entry(people.regionWish).includes("You own 3 copies that match") && entry(people.regionWish).includes("1 of them meets your minimum (Complete in box)") && entry(people.regionWish).includes("no completeness recorded don't count"));
  check("any version counts every copy of the game", entry(people.anyId).includes("You own 4 copies that match"));
  check("a region the collector owns nothing from shows no match", entry(people.korea).includes("You don't own a matching copy yet"));
  check("owning the game isn't owning the wanted edition", entry(people.ceWish).includes("You don't own this release yet"));
  check("a sealed copy meets a lower minimum", (await rpc(owner, "update_wishlist_item", { p_item: people.platformWish, p_changes: { completeness: "complete" } })).status === 200);
  const again = plain((await owner.browser.get(WISHLIST)).html);
  check("so two of the four SNES copies meet “complete in box”", again.includes("2 of them meet your minimum (Complete in box)"));
  check("the desired minimum is worded as a minimum, not as a copy", text.includes("Complete in box or better") && text.includes("Any completeness"));
}

async function wishlistPage() {
  section("The wishlist page");
  const owner = people.owner;
  const page = await owner.browser.get(WISHLIST);
  const text = plain(page.html);
  const ids = listed(page.html);
  check("it lists every wish, each once", ids.length === wishes(owner) && new Set(ids).size === ids.length, `${ids.length} of ${wishes(owner)}`);
  check("by priority: high first", ids[0] === people.anyId);
  check("it counts them and says they're private", text.includes(`${wishes(owner)} wishes in all`) && text.includes("only you can see your wishlist"));
  check("each wish links to its page and to the game", ids.every((id) => page.html.includes(`href="/collection/wishlist/${id}"`)) && page.html.includes(`href="/games/${F.starfall.slug}"`));
  check("the exact release shows its format and product code", text.includes("SNSP-ZSFP-EUR"));
  check("the note is shown, to its owner", text.includes("Any copy will do"));
  check("only an exact release is drawn as media; preferences are placeholders", (() => {
    const article = (id) => page.html.slice(page.html.indexOf(`aria-labelledby="wish-${id}"`), page.html.indexOf("</article>", page.html.indexOf(`aria-labelledby="wish-${id}"`)));
    return /data-media="snes-cart/.test(article(people.exact)) && /data-media="placeholder"/.test(article(people.regionWish)) && !/data-media="snes-cart/.test(article(people.regionWish)) && /data-media="placeholder"/.test(article(people.anyId));
  })());

  const search = await owner.browser.get(`${WISHLIST}?q=neon`);
  check("search by title", listed(search.html).length === 1 && listed(search.html)[0] === people.neonWish);
  const accents = await owner.browser.get(`${WISHLIST}?q=${encodeURIComponent("スターフォール")}`);
  check("search matches a release's local title", listed(accents.html).includes(people.jpWish));
  const region = await owner.browser.get(`${WISHLIST}?region=pal`);
  check("filter by region: wishes that name PAL", listed(region.html).length === 2 && [people.exact, people.regionWish].every((id) => listed(region.html).includes(id)));
  const platform = await owner.browser.get(`${WISHLIST}?platform=snes`);
  check("filter by platform: every wish naming SNES, none that names none", listed(platform.html).length === wishes(owner) - 2 && !listed(platform.html).includes(people.anyId));
  const priority = await owner.browser.get(`${WISHLIST}?priority=1`);
  check("filter by priority", listed(priority.html).length === 1 && listed(priority.html)[0] === people.anyId);
  const title = await owner.browser.get(`${WISHLIST}?sort=title`);
  check("sort by title", listed(title.html)[0] === people.neonWish);
  const added = await owner.browser.get(`${WISHLIST}?sort=added`);
  check("sort by recently added", listed(added.html)[0] === people.neonWish && listed(added.html).at(-1) === people.anyId);
  const none = await owner.browser.get(`${WISHLIST}?q=zzzz-nothing`);
  check("no match says so, with a way back", plain(none.html).includes("No wishes match") && none.html.includes("Clear search and filters"));
  const bad = await owner.browser.get(`${WISHLIST}?platform=SNES;drop&priority=9&sort=price`);
  check("a hand-edited URL falls back to the plain list", bad.response.status === 200 && listed(bad.html).length === wishes(owner));
  const cursor = await owner.browser.get(`${WISHLIST}?after=bm90LWEtY3Vyc29y`);
  check("a cursor from elsewhere starts again", plain(cursor.html).includes("This page has moved on"));

  section("Paging");
  // Filler wishes for one collector, made as postgres (W1's functions cover the rules):
  // Neon Drift Racing on its platforms from every region, distinct targets.
  const pager = (people.pager = await collector("wlp"));
  psql(`insert into public.wishlist_items (id, owner_id, game_id, platform_id, region_code, priority)
    select private.uuid_v7(), ${sql(pager.id)}, ${sql(F.neon.id)}, p.id, rc.code, 1 + (row_number() over ()) % 3
    from public.platforms p cross join public.region_codes rc where p.id in (${sql(F.playstation)}, ${sql(F.saturn)}) and rc.code <> 'unknown';
    insert into public.wishlist_items (id, owner_id, game_id, platform_id, region_code, priority)
    select private.uuid_v7(), ${sql(pager.id)}, ${sql(F.tessaly.id)}, ${sql(F.playstation)}, rc.code, 2 from public.region_codes rc where rc.code <> 'unknown';
    insert into public.wishlist_items (id, owner_id, game_id, platform_id, region_code, priority)
    select private.uuid_v7(), ${sql(pager.id)}, ${sql(F.starfall.id)}, ${sql(F.snes)}, rc.code, 3 from public.region_codes rc where rc.code <> 'unknown';`);
  const total = wishes(pager);
  const seen = [];
  let path = WISHLIST;
  let pages = 0;
  for (; pages < 5; pages += 1) {
    const p = await pager.browser.get(path);
    const items = listed(p.html);
    seen.push(...items);
    check(`page ${pages + 1}: at most 30 wishes in the page`, items.length > 0 && items.length <= 30, `${items.length}`);
    const next = nextCursor(p.html);
    if (!next) break;
    path = `${WISHLIST}?${next}`;
  }
  check(`every wish exactly once across pages (${total})`, seen.length === total && new Set(seen).size === total, `${seen.length}`);
  const firstPage = await pager.browser.get(`${WISHLIST}?sort=title&priority=2`);
  const later = nextCursor(firstPage.html);
  check("a filtered, sorted list pages too, keeping its filters", !later || (later.includes("priority=2") && later.includes("sort=title")));
}

async function editing() {
  section("Editing a wish");
  const owner = people.owner;
  const path = `${WISHLIST}/${people.platformWish}`;
  const page = await owner.browser.get(path);
  const text = plain(page.html);
  check("the entry's page shows the wish, its level and what the collector owns", page.response.status === 200 && text.includes("Your wish") && text.includes("SNES · any region") && text.includes("You own 4 copies that match"));
  check("with an edit form and a remove form", Boolean(formById(page.html, "edit-wish")) && Boolean(removeForm(page.html, people.platformWish)));
  check("and links to the game and back to the wishlist", page.html.includes(`href="/games/${F.starfall.slug}"`) && page.html.includes(`href="${WISHLIST}"`));

  await editWish(owner, people.platformWish, { priority: "1", completeness: "sealed", note: "Boxed,\r\nplease  " });
  check("priority, minimum and note are saved, the note tidied", JSON.stringify(wishRow(people.platformWish)) === JSON.stringify({ release: null, game: F.starfall.id, platform: F.snes, region: null, priority: 1, completeness: "sealed", note: "Boxed,\nplease" }), JSON.stringify(wishRow(people.platformWish)));
  await editWish(owner, people.platformWish, { note: "", completeness: "" });
  check("clearing the note and minimum clears them", wishRow(people.platformWish)?.note === null && wishRow(people.platformWish)?.completeness === null);
  await editWish(owner, people.platformWish, { level: "region", platform_id: F.snes, region_code: "ntsc-j" });
  check("the level and region can change", wishRow(people.platformWish)?.region === "ntsc-j");
  await editWish(owner, people.platformWish, { level: "release", release_id: F.us });
  check("and it can become one exact release", wishRow(people.platformWish)?.release === F.us && wishRow(people.platformWish)?.game === null);
  const dup = await editWish(owner, people.platformWish, { level: "release", release_id: F.eu });
  check("changing it to what another wish wants is refused, and nothing changes", wishRow(people.platformWish)?.release === F.us && dup?.response.status === 200);
  await editWish(owner, people.platformWish, { level: "platform", platform_id: F.playstation });
  check("so is a platform the catalog doesn't list for the game", wishRow(people.platformWish)?.release === F.us);
  await editWish(owner, people.platformWish, { level: "platform", platform_id: F.snes });
  check("and it can go back to a platform", wishRow(people.platformWish)?.release === null && wishRow(people.platformWish)?.platform === F.snes);
  const unchanged = await editWish(owner, people.platformWish, {});
  check("saving without a change keeps everything", unchanged?.response.status === 200 && wishRow(people.platformWish)?.platform === F.snes && wishRow(people.platformWish)?.priority === 1);

  section("Removing a wish");
  const list = await owner.browser.get(`${WISHLIST}?sort=title`);
  const form = removeForm(list.html, people.korea);
  check("every wish on the list has a remove form, naming it", Boolean(form) && plain(list.html).includes("from your wishlist"));
  const removed = await owner.browser.submit(`${WISHLIST}?sort=title`, form, {});
  check("removing returns to the list as it was, with a notice", removed.response.status === 303 && location(removed.response) === `${WISHLIST}?sort=title&notice=removed`, `${removed.response.status} ${location(removed.response)}`);
  check("and the wish is gone, nothing else", !wishRow(people.korea) && wishes(owner) === 7);
  check("the page says so", plain((await owner.browser.get(location(removed.response))).html).includes("The wish was removed from your wishlist"));
  const twice = await owner.browser.submit(`${WISHLIST}?sort=title`, form, {});
  check("removing it again says it was already removed", location(twice.response).endsWith("notice=already_removed"));
  const gone = await owner.browser.get(`${WISHLIST}/${people.korea}`);
  check("its page is no longer available", gone.html.includes("This wish isn't available") && !formById(gone.html, "edit-wish"));
  check("removing a wish doesn't touch the collection", Number(psql(`select count(*) from public.collection_items where owner_id = ${sql(owner.id)};`)) === 4);
}

async function lifecycle() {
  section("Catalog changes");
  const owner = people.owner;
  const entryText = (html, id) => {
    const start = html.indexOf(`aria-labelledby="wish-${id}"`);
    return plain(html.slice(start, html.indexOf("</article>", start)));
  };

  // An excluded release, as the exclusion function leaves it.
  psql(`update public.releases set status = 'excluded' where id = ${sql(F.ce)};`);
  try {
    const list = await owner.browser.get(WISHLIST);
    check("an excluded release's wish stays on the list, as the collector saw it", entryText(list.html, people.ceWish).includes("Collector's Edition") && entryText(list.html, people.ceWish).includes("no longer in the catalog"), entryText(list.html, people.ceWish).slice(-400));
    const page = await owner.browser.get(`${WISHLIST}/${people.ceWish}`);
    check("its page says so and offers a way on", plain(page.html).includes("choose another release, or remove it") && Boolean(formById(page.html, "edit-wish")));
    await editWish(owner, people.ceWish, { priority: "3", note: "Still looking" });
    check("its priority and note can change without losing the wanted release", wishRow(people.ceWish)?.release === F.ce && wishRow(people.ceWish)?.priority === 3 && wishRow(people.ceWish)?.note === "Still looking");
    await screenshotLater("07-wishlist-unavailable-release", owner, `${WISHLIST}?sort=title`);
    const exported = await download(owner);
    const wish = exported.data?.wishlist?.find((w) => w.id === people.ceWish);
    check("the export says the wanted release is unavailable, and still names it", wish?.catalog?.state === "unavailable" && wish?.wanted?.release_id === F.ce, JSON.stringify(wish?.catalog ?? null).slice(0, 120));
    people.exportedOnce = true;
  } finally {
    psql(`begin; set local session_replication_role = replica; update public.releases set status = 'published' where id = ${sql(F.ce)}; commit;`);
  }
  const restored = await owner.browser.get(WISHLIST);
  check("restored, it's available again", !entryText(restored.html, people.ceWish).includes("no longer in the catalog"));

  // A merged release: the Japanese release merged into the North American one.
  psql(`update public.releases set status = 'merged', merged_into_id = ${sql(F.us)}, merged_publicly = true where id = ${sql(F.jp)};`);
  try {
    const usAdd = await rpc(owner, "add_wishlist_item", { p_item_id: uuidv7(), p_target: { release_id: F.us }, p_details: {} });
    check("setup: the collector also wants the release it was merged into", usAdd.status === 200, JSON.stringify(usAdd.json));
    const list = await owner.browser.get(WISHLIST);
    const text = entryText(list.html, people.jpWish);
    check("a merged release's wish shows the release it was merged into, and says so", text.includes("NTSC-U/C") && text.includes("SNS-ZSFE-USA") && /another of your wishes wants the same thing/.test(text), text.slice(-400));
    check("the stored wish still names what was wanted", wishRow(people.jpWish)?.release === F.jp);
  } finally {
    psql(`begin; set local session_replication_role = replica; update public.releases set status = 'published', merged_into_id = null, merged_publicly = false where id = ${sql(F.jp)}; commit;`);
    psql(`delete from public.wishlist_items where owner_id = ${sql(owner.id)} and release_id = ${sql(F.us)};`);
  }

  // A withdrawn pairing: Neon Drift Racing on the Saturn.
  const saturnAdd = await rpc(owner, "add_wishlist_item", { p_item_id: uuidv7(), p_target: { game_id: F.neon.id, platform_id: F.saturn }, p_details: {} });
  check("setup: a wish for the game on the Saturn", saturnAdd.status === 200, JSON.stringify(saturnAdd.json));
  const saturnWish = findWish(owner, `game_id = ${sql(F.neon.id)} and platform_id = ${sql(F.saturn)}`);
  psql(`begin; set local session_replication_role = replica; update public.game_platforms set status = 'excluded' where game_id = ${sql(F.neon.id)} and platform_id = ${sql(F.saturn)}; commit;`);
  try {
    const list = await owner.browser.get(WISHLIST);
    check("a wish on a withdrawn pairing says the catalog no longer lists the game there", entryText(list.html, saturnWish).includes("no longer lists this game on Saturn"), entryText(list.html, saturnWish).slice(-300));
    const page = await owner.browser.get(`${WISHLIST}/${saturnWish}`);
    check("its page keeps the platform as the selected choice", new RegExp(`<option[^>]*value="${F.saturn}"[^>]*selected|<option[^>]*selected[^>]*value="${F.saturn}"`).test(page.html));
    await editWish(owner, saturnWish, { priority: "1" });
    check("and its priority can still change, the platform kept", wishRow(saturnWish)?.priority === 1 && wishRow(saturnWish)?.platform === F.saturn);
    await editWish(owner, saturnWish, { level: "game" });
    check("recovering to any version is refused while another wish already wants that, and nothing is lost", wishRow(saturnWish)?.platform === F.saturn);
    await editWish(owner, saturnWish, { level: "platform", platform_id: F.playstation });
    check("recovering to another of the game's platforms works", wishRow(saturnWish)?.platform === F.playstation);
  } finally {
    psql(`begin; set local session_replication_role = replica; update public.game_platforms set status = 'published' where game_id = ${sql(F.neon.id)} and platform_id = ${sql(F.saturn)}; commit;`);
  }
  psql(`delete from public.wishlist_items where id = ${sql(saturnWish)};`);

  // An excluded game.
  const tessalyAdd = await rpc(owner, "add_wishlist_item", { p_item_id: uuidv7(), p_target: { game_id: F.tessaly.id }, p_details: { note: "Three discs" } });
  check("setup: a wish for any version of a game", tessalyAdd.status === 200, JSON.stringify(tessalyAdd.json));
  const tessalyWish = findWish(owner, `game_id = ${sql(F.tessaly.id)}`);
  psql(`begin; set local session_replication_role = replica; update public.games set status = 'excluded' where id = ${sql(F.tessaly.id)}; commit;`);
  try {
    const list = await owner.browser.get(WISHLIST);
    const text = entryText(list.html, tessalyWish);
    check("an excluded game's wish keeps its title and note, without a link to a page that's gone", text.includes("Echoes of Tessaly") && text.includes("This game is no longer in the catalog") && text.includes("Three discs") && !list.html.includes(`href="/games/${F.tessaly.slug}"`), text.slice(-300));
    const page = await owner.browser.get(`${WISHLIST}/${tessalyWish}`);
    check("its page lets only the details change", plain(page.html).includes("what you want can't be changed") && !/name="level" value="platform"/.test(page.html));
    await editWish(owner, tessalyWish, { priority: "3" });
    check("and they do", wishRow(tessalyWish)?.priority === 3 && wishRow(tessalyWish)?.game === F.tessaly.id);
  } finally {
    psql(`begin; set local session_replication_role = replica; update public.games set status = 'published' where id = ${sql(F.tessaly.id)}; commit;`);
  }
  psql(`delete from public.wishlist_items where id = ${sql(tessalyWish)};`);

  // Missing metadata: the release with an unknown region.
  const meadow = await owner.browser.get(gamePath(F.meadow.slug));
  await owner.browser.submit(gamePath(F.meadow.slug), wantForm(meadow.html, F.meadowRelease), {});
  const meadowWish = findWish(owner, `release_id = ${sql(F.meadowRelease)}`);
  const list = await owner.browser.get(`${WISHLIST}?q=meadow`);
  const article = list.html.slice(list.html.indexOf(`aria-labelledby="wish-${meadowWish}"`), list.html.indexOf("</article>", list.html.indexOf(`aria-labelledby="wish-${meadowWish}"`)));
  check("a release with an unknown region is a placeholder, not a guessed shell, and says the region is unknown", Boolean(meadowWish) && /data-media="placeholder"/.test(article) && plain(article).includes("Region unknown"));
  check("nothing the catalog doesn't record is filled in", !/undefined|null|NaN/.test(plain(article)));
  psql(`delete from public.wishlist_items where id = ${sql(meadowWish)};`);
}

async function privacy() {
  section("Privacy");
  const owner = people.owner;
  const stranger = people.other;
  const theirs = await stranger.browser.get(WISHLIST);
  check("another collector's wishlist is their own: empty", plain(theirs.html).includes("Your wishlist is empty"));
  check("with none of the owner's wishes or notes", !listed(theirs.html).length && !theirs.html.includes(people.anyId) && !plain(theirs.html).includes("Any copy will do"));
  const entry = await stranger.browser.get(`${WISHLIST}/${people.anyId}`);
  check("the owner's wish page isn't available to them", entry.html.includes("This wish isn't available") && !entry.html.includes("Any copy will do") && !formById(entry.html, "edit-wish"));
  const game = await stranger.browser.get(gamePath(F.starfall.slug));
  check("the game page shows them only their own wishlist", plain(game.html).includes("This game isn't on your wishlist") && !game.html.includes(people.anyId));

  // Forms from the owner's pages, posted by the stranger.
  const ownerPage = await owner.browser.get(`${WISHLIST}/${people.anyId}`);
  const edit = formById(ownerPage.html, "edit-wish");
  await stranger.browser.submit(`${WISHLIST}/${people.anyId}`, edit, { ...shownFields(ownerPage.html), priority: "3", note: "hijacked" });
  check("posting the owner's edit form changes nothing", wishRow(people.anyId)?.note === "Any copy will do" && wishRow(people.anyId)?.priority === 1);
  const remove = removeForm(ownerPage.html, people.anyId);
  await stranger.browser.submit(`${WISHLIST}/${people.anyId}`, remove, {});
  check("posting the owner's remove form removes nothing", Boolean(wishRow(people.anyId)));
  const read = await fetch(`${api}/rest/v1/wishlist_items?select=id,note`, { headers: { apikey: publishableKey, Authorization: `Bearer ${readSession(stranger.browser).session.access_token}` } });
  const rows = await read.json();
  check("reading the table directly shows them no one else's rows", read.status === 200 && Array.isArray(rows) && rows.length === 0);
  const write = await fetch(`${api}/rest/v1/wishlist_items`, {
    method: "POST",
    headers: { apikey: publishableKey, Authorization: `Bearer ${readSession(stranger.browser).session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: uuidv7(), owner_id: owner.id, game_id: F.starfall.id }),
  });
  check("and writing it directly is refused", write.status === 401 || write.status === 403, `status ${write.status}`);
  const item = await rpc(stranger, "get_my_wishlist_item", { p_item: people.anyId });
  check("W1's read of one entry gives them nothing", item.status === 200 && item.json === null);

  section("A suspended account");
  const suspended = (people.suspended = await collector("wls"));
  await rpc(suspended, "add_wishlist_item", { p_item_id: uuidv7(), p_target: { game_id: F.neon.id }, p_details: {} });
  const theirWish = findWish(suspended, `game_id = ${sql(F.neon.id)}`);
  psql(`update public.profiles set account_status = 'suspended' where id = ${sql(suspended.id)};`);
  const page = await suspended.browser.get(gamePath(F.starfall.slug));
  check("the game page says the account can't add wishes, and has no add controls", plain(page.html).includes("Your account can't add wishes right now") && !formById(page.html, "add-wish") && !wantForm(page.html, F.us));
  const list = await suspended.browser.get(WISHLIST);
  check("their wishlist is still theirs to read", listed(list.html).includes(theirWish));
  const wishPage = await suspended.browser.get(`${WISHLIST}/${theirWish}`);
  check("its page says it can't be changed, but can be removed", plain(wishPage.html).includes("can't change its wishlist right now") && !formById(wishPage.html, "edit-wish") && Boolean(removeForm(wishPage.html, theirWish)));
  const ownerForm = formById((await owner.browser.get(gamePath(F.neon.slug))).html, "add-wish");
  await suspended.browser.submit(gamePath(F.neon.slug), { hidden: { ...ownerForm.hidden, item_id: uuidv7() } }, { level: "platform", platform_id: F.playstation, priority: "2", completeness: "", note: "" });
  check("a form posted anyway adds nothing", wishes(suspended) === 1);
  const removed = await suspended.browser.submit(`${WISHLIST}/${theirWish}`, removeForm(wishPage.html, theirWish), {});
  check("removing works for a suspended account", location(removed.response).endsWith("notice=removed") && wishes(suspended) === 0);
}

async function navigation() {
  section("Navigation");
  const owner = people.owner;
  const collection = await owner.browser.get("/collection");
  check("My Collection links to the wishlist", collection.html.includes(`href="${WISHLIST}"`));
  const list = await owner.browser.get(WISHLIST);
  const mobile = /<nav aria-label="Main" class="fixed[\s\S]*?<\/nav>/.exec(list.html)?.[0] ?? "";
  const navLinks = [...mobile.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  check("the mobile bottom navigation is unchanged: five items, no wishlist", JSON.stringify(navLinks) === JSON.stringify(["/home", "/explore", "/collection", "/community", "/profile"]), navLinks.join(" "));
  const sidebar = list.html.replace(mobile, "");
  check("the desktop sidebar has a Wishlist item", /<a[^>]*href="\/collection\/wishlist"[^>]*aria-label="Wishlist"/.test(sidebar) || /aria-label="Wishlist"[^>]*href="\/collection\/wishlist"/.test(sidebar));
  check("the wishlist links back to My Collection", list.html.includes('href="/collection"'));
  const game = await owner.browser.get(gamePath(F.starfall.slug));
  check("the game page links to the whole wishlist", game.html.includes(`href="${WISHLIST}"`) && plain(game.html).includes("See your whole wishlist"));
  for (const path of ["/collection", "/collection/systems", "/collection/systems/snes", gamePath(F.starfall.slug)]) {
    const r = await owner.browser.get(path);
    check(`${path} still works`, r.response.status === 200);
  }
}

async function exportCheck() {
  section("The personal data export");
  const owner = people.owner;
  const ex = await download(owner);
  const d = ex.data;
  check("it downloads, complete, as version 3", ex.status === 200 && d?.version === 3 && d?.complete === true, `status ${ex.status}`);
  check("in the documented key order, the wishlist after the collection", Array.isArray(d?.wishlist) && Object.keys(d).indexOf("wishlist") === Object.keys(d).indexOf("collection") + 1);
  const stored = Number(psql(`select count(*) from public.wishlist_items where owner_id = ${sql(owner.id)};`));
  check(`every wish, once each (${stored})`, d?.wishlist?.length === stored && new Set(d.wishlist.map((w) => w.id)).size === stored);
  const any = d?.wishlist?.find((w) => w.id === people.anyId);
  check("a wish keeps its level, target, priority, minimum, note and dates", any?.level === "game" && any?.wanted?.game_id === F.starfall.id && any?.priority?.value === 1 && any?.priority?.label === "high" && any?.minimum_completeness === null && any?.note === "Any copy will do" && Boolean(any?.created_at) && Boolean(any?.updated_at));
  const region = d?.wishlist?.find((w) => w.id === people.regionWish);
  check("a region wish names its platform and region", region?.level === "region" && region?.wanted?.platform?.slug === "snes" && region?.wanted?.region?.code === "pal" && region?.minimum_completeness === "complete");
  const exact = d?.wishlist?.find((w) => w.id === people.exact);
  check("an exact release names it, and how the catalog shows it", exact?.level === "release" && exact?.wanted?.release_id === F.eu && exact?.catalog?.state === "available" && exact?.catalog?.release?.product_code === "SNSP-ZSFP-EUR");
  check("nothing of another collector's, and no owner ids", !ex.text.includes(people.other.id) && !ex.text.includes("hijacked") && !/"owner_id"/.test(ex.text));
  const theirs = await download(people.other);
  check("another collector's export has only their own (empty) wishlist", theirs.data?.complete === true && Array.isArray(theirs.data?.wishlist) && theirs.data.wishlist.length === 0 && !theirs.text.includes(people.anyId));
  const pager = await download(people.pager);
  check(`a larger wishlist is exported in full (${wishes(people.pager)})`, pager.data?.complete === true && pager.data.wishlist.length === wishes(people.pager) && pager.data.wishlist.every((w) => w.catalog !== null));
}

async function performance() {
  section("A large wishlist");
  // A large wishlist: 3,000 distinct targets (published games on every platform and region,
  // most of them pairings the catalog doesn't have, so the heaviest state path is read
  // too). Made as postgres; removed with the account.
  const big = (people.big = await collector("wlb"));
  psql(`insert into public.wishlist_items (id, owner_id, game_id, platform_id, region_code, priority)
    select private.uuid_v7(), ${sql(big.id)}, g.id, p.id, rc.code, 1 + (row_number() over ()) % 3
    from public.games g cross join public.platforms p cross join public.region_codes rc
    where g.status = 'published' and rc.code <> 'unknown'
    limit 3000;
    analyze public.wishlist_items;`);
  const total = wishes(big);
  const times = [];
  let html = "";
  for (let i = 0; i < 3; i += 1) {
    const started = Date.now();
    html = (await big.browser.get(WISHLIST)).html;
    times.push(Date.now() - started);
  }
  times.sort((a, b) => a - b);
  console.log(`  ${total} wishes: the first page in ${times.join(", ")} ms`);
  check(`with ${total.toLocaleString("en")} wishes, the page holds one page of them, not all`, listed(html).length === 30 && plain(html).includes(`${total.toLocaleString("en")} wishes in all`));
  check("and loads in under 2 seconds (median)", times[1] < 2000, `${times[1]} ms`);
  const started = Date.now();
  const filtered = await big.browser.get(`${WISHLIST}?q=tessaly&sort=title`);
  check("a search over all of them, sorted by title, also loads in under 2 seconds", listed(filtered.html).length === 30 && Date.now() - started < 2000, `${Date.now() - started} ms`);

  // The export of the same list: three pages of stored rows (read by id, past PostgREST's
  // 1,000-row page) and thirty of catalog states. Every stored entry exactly once.
  const exportStarted = Date.now();
  const exported = await download(big);
  const exportMs = Date.now() - exportStarted;
  console.log(`  ${total} wishes: exported in ${exportMs} ms`);
  const storedIds = psql(`select id from public.wishlist_items where owner_id = ${sql(big.id)} order by id;`).split("\n").filter(Boolean);
  const exportedIds = (exported.data?.wishlist ?? []).map((w) => w.id);
  check(
    `the export of all ${total.toLocaleString("en")} has every stored wish exactly once, in id order, each with its catalog state`,
    exported.data?.complete === true && exportedIds.length === storedIds.length && exportedIds.every((id, i) => id === storedIds[i]) && exported.data.wishlist.every((w) => w.catalog !== null),
    `${exportedIds.length} of ${storedIds.length}`,
  );
  check("and finishes in under 10 seconds", exportMs < 10_000, `${exportMs} ms`);
}

// ---------------------------------------------------------------------------
// In a real browser: accessibility, keyboard, back button and screenshots
// ---------------------------------------------------------------------------

const screenshots = process.env.WISHLIST_SCREENSHOTS ?? null;
async function screenshotLater(name, user, path, options = {}) {
  // Catalog changes are undone right after, so this one is taken now.
  if (!screenshots || !browserApp) return;
  await shot(name, user, path, options);
}

let browserApp = null;
let axeSource = null;

async function launch() {
  const { chromium } = createRequire(join(root, "package.json"))("playwright-core");
  for (const channel of [process.env.A11Y_BROWSER, "msedge", "chrome"].filter(Boolean)) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // Try the next one.
    }
  }
  return null;
}

async function contextFor(user, viewport) {
  const context = await browserApp.newContext({ viewport, colorScheme: "dark" });
  if (user) await context.addCookies([...user.browser.cookies].map(([name, value]) => ({ name, value, url: `http://127.0.0.1:${PORT}` })));
  return context;
}

async function shot(name, user, path, { width = 1440, height = 900, full = true, element = null } = {}) {
  mkdirSync(screenshots, { recursive: true });
  const context = await contextFor(user, { width, height });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  if (element) await page.locator(element).first().screenshot({ path: join(screenshots, `${name}.png`) });
  else await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: full });
  await context.close();
}

async function audit(user, name, path) {
  for (const viewport of [{ tag: "phone", width: 390, height: 844 }, { tag: "desktop", width: 1280, height: 900 }]) {
    const context = await contextFor(user, viewport);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: "networkidle" });
    // Open every disclosure, so what's inside is audited too.
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
    await page.addScriptTag({ content: axeSource });
    const found = await page.evaluate(async () => {
      const run = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
      return run.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, target: String(v.nodes[0]?.target ?? "") }));
    });
    const blocking = found.filter((v) => v.impact === "critical" || v.impact === "serious");
    for (const v of found.filter((x) => !blocking.includes(x))) console.log(`  note ${viewport.tag} ${name}: ${v.impact} ${v.id} (${v.count})`);
    check(`${viewport.tag} ${name}: no critical or serious axe findings`, blocking.length === 0, blocking.map((v) => `${v.impact} ${v.id}(${v.count}) ${v.target}`).join("; "));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${viewport.tag} ${name}: no sideways scrolling and no console errors`, overflow <= 0 && errors.length === 0, `${overflow}px, ${errors.slice(0, 2).join(" | ")}`);
    await context.close();
  }
}

async function inBrowser() {
  section("In a real browser");
  browserApp = await launch();
  check("a browser (Edge or Chrome) started for the browser checks", Boolean(browserApp));
  if (!browserApp) return;
  axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  const owner = people.owner;

  await audit(owner, "wishlist", WISHLIST);
  await audit(owner, "wishlist, filtered", `${WISHLIST}?platform=snes&sort=title`);
  await audit(owner, "a wish's page", `${WISHLIST}/${people.exact}`);
  await audit(owner, "game page with the wishlist", gamePath(F.starfall.slug));
  await audit(people.other, "empty wishlist", WISHLIST);
  await audit(null, "game page, signed out", gamePath(F.starfall.slug));

  // Keyboard only: open the add form, choose "On a platform" with the arrow keys and add.
  const kb = (people.keyboard = await collector("wlk"));
  const context = await contextFor(kb, { width: 1280, height: 900 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}${gamePath(F.neon.slug)}`, { waitUntil: "networkidle" });
  const summary = page.locator("#game-wishlist").locator("xpath=..").locator(":scope > details > summary");
  await summary.focus();
  const open = await summary.evaluate((el) => el.parentElement.open);
  if (!open) await page.keyboard.press("Enter");
  const anyRadio = page.locator('#add-wish input[name="level"][value="game"]');
  await anyRadio.focus();
  await page.keyboard.press("ArrowDown");
  const level = await page.locator('#add-wish input[name="level"]:checked').getAttribute("value");
  check("keyboard: the arrow keys move between the levels", level === "platform", level);
  check("keyboard: choosing a platform level shows its platform field, and not the others", (await page.locator('#add-wish select[name="platform_id"]').isVisible()) && (await page.locator('#add-wish select[name="release_id"]').count()) === 0);
  await page.locator('#add-wish button[type="submit"]').focus();
  await page.keyboard.press("Enter");
  await page.locator('#add-wish [role="status"]').getByText("Added to your wishlist.").waitFor({ timeout: 10000 });
  check("keyboard: Enter on the button adds it, and the result is announced in a live region", wishes(kb) === 1 && Boolean(findWish(kb, `game_id = ${sql(F.neon.id)} and platform_id is not null`)));
  await page.locator('#add-wish button[type="submit"]').click();
  await page.locator('#add-wish [role="status"]').getByText("Already on your wishlist.").waitFor({ timeout: 10000 });
  check("with JavaScript, adding it again says it's already there, and links to it", wishes(kb) === 1 && (await page.locator('#add-wish [role="status"] a').getAttribute("href"))?.startsWith(WISHLIST));
  const want = page.getByRole("button", { name: /Want this release: Neon Drift Racing, PS1/ }).first();
  await want.focus();
  await page.keyboard.press("Enter");
  await page.getByText("Added to your wishlist", { exact: true }).first().waitFor({ timeout: 10000 });
  check("keyboard: “Want this release” adds the exact release, and becomes a link to it", wishes(kb) === 2);

  // The browser's own navigation: wishlist → game → back → wish page.
  await page.goto(`http://127.0.0.1:${PORT}${WISHLIST}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /Game details/ }).first().click();
  await page.waitForURL(/\/games\//);
  check("from the wishlist, Game details opens the game", page.url().includes(gamePath(F.neon.slug)));
  await page.goBack();
  await page.waitForURL(/\/collection\/wishlist$/);
  check("and the back button returns to the wishlist", page.url().endsWith(WISHLIST));
  await page.getByRole("link", { name: /^Edit your wish/ }).first().click();
  await page.waitForURL(/\/collection\/wishlist\/[0-9a-f-]{36}/);
  check("Edit opens the wish's page", /\/collection\/wishlist\/[0-9a-f-]{36}/.test(page.url()));
  await page.getByRole("link", { name: "Back to your wishlist" }).click();
  await page.waitForURL(/\/collection\/wishlist$/);
  check("and it links back", page.url().endsWith(WISHLIST));
  const active = await page.locator('nav[aria-label="Main"] a[aria-current="page"]').evaluateAll((links) => links.filter((a) => a.offsetParent !== null).map((a) => a.getAttribute("href")));
  check("on the wishlist, the sidebar marks Wishlist, not also My Collection", JSON.stringify(active) === JSON.stringify([WISHLIST]), active.join(" "));
  await context.close();

  if (screenshots) {
    await shot("01-wishlist-desktop", owner, WISHLIST);
    await shot("02-wishlist-empty", people.other, WISHLIST, { full: false });
    await shot("03-wish-any-version", owner, WISHLIST, { element: `article[aria-labelledby="wish-${people.anyId}"]` });
    await shot("04-wish-exact-release", owner, WISHLIST, { element: `article[aria-labelledby="wish-${people.exact}"]` });
    await shot("05-game-details-wishlist", owner, gamePath(F.starfall.slug));
    await shot("06-wish-edit", owner, `${WISHLIST}/${people.regionWish}`);
    await shot("08-wishlist-mobile", owner, WISHLIST, { width: 390, height: 844 });
    await shot("09-game-details-mobile", owner, gamePath(F.starfall.slug), { width: 390, height: 844 });
  }
}

// ---------------------------------------------------------------------------

const LEFTOVER_TABLES = ["public.wishlist_items", "public.collection_items", "public.games", "public.releases", "public.game_platforms"];
const startingFootprint = footprint(psql, LEFTOVER_TABLES);
const statuses = () => psql("select md5(string_agg(id::text || status::text || coalesce(merged_into_id::text, ''), ',' order by id)) from public.releases;");

try {
  installFixture();
  F = fixture();
  const releaseStatuses = statuses();
  await startApp(PORT);
  // Screenshots and audits need the browser before the catalog changes are undone.
  if (screenshots) browserApp = await launch();
  await signedOut();
  await emptyAndAdding();
  await ownership();
  await wishlistPage();
  await editing();
  await lifecycle();
  check("every simulated catalog change was undone", statuses() === releaseStatuses);
  await privacy();
  await navigation();
  await exportCheck();
  await performance();
  if (browserApp) await browserApp.close();
  await inBrowser();
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  await browserApp?.close().catch(() => {});
  stopApp();
  const ids = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'wl\\_%';");
  if (ids.length) {
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${ids.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${ids.map((id) => `'${id}'`).join(",")}); delete from private.request_slots where user_id in (${ids.map((id) => `'${id}'`).join(",")}); commit;`);
  }
  removeFixture();
  check("no wishes, copies or catalog data are left behind", footprint(psql, LEFTOVER_TABLES) === startingFootprint);
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
