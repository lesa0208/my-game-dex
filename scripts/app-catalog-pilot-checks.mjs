/**
 * M12c-A end-to-end checks: the real NES, SNES and PlayStation pilot, as a collector uses
 * it, in the built app over HTTP against the isolated test stack.
 *
 *   npm run build && MGD_STACK=test node scripts/app-catalog-pilot-checks.mjs
 *
 * Run only after a human catalog editor (editor B, never editor A) has verified and
 * published releases in the admin pages; no script does that. It checks whatever has been
 * published, against the evidence table (scripts/catalog-pilot-m12c-data.mjs):
 *   1. each published game is found by search;
 *   2. its page loads;
 *   3. it offers exactly the platforms,
 *   4. regions and
 *   5. editions of its published releases, and nothing still in review;
 *   6. a published release can be added, as itself;
 *   7. two releases stay two copies of two separate releases;
 *   8. a copy whose edition isn't known is kept unidentified, adding nothing to the catalog;
 *   9. sending a form twice adds one copy, and no game or release is duplicated;
 *  10. ownership on the game page and in search, and the collection summary, count them.
 * With nothing published it stops and says so: it never reports these as passed.
 *
 * Read-only for the catalog. Its collectors, their copies and their audit rows are
 * removed at the end, and every other collection on the stack is left exactly as it
 * was. Prints check names and statuses only.
 */
import { randomBytes } from "node:crypto";

import { appErrorLines, Browser, check, createUser, decode, deleteUsers, forms, formWith, psql, results, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { GAMES, HELD, RELEASES } from "./catalog-pilot-m12c-data.mjs";
import { stackName } from "./lib/stack.mjs";

if (stackName !== "test") {
  console.error("Refusing: the pilot checks run only on the isolated test stack (MGD_STACK=test).");
  process.exit(2);
}

const plain = (html) => decode(html.replace(/<script\b[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
const editionKey = (r) => `${r.facts.edition_kind ?? ""}~${r.facts.edition_name ?? ""}`;
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const distinct = (values) => [...new Set(values)];
const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
const title = (r) => GAMES.find((g) => g.key === r.game).title;
const users = [];
/** The handles this run's collectors chose: only their holds are removed at the end. */
const handles = [];
/** Checks that couldn't run because what they need isn't published: reported, never passed. */
const prerequisites = [];

/** A pilot release's row on the stack: matched by game, platform, region, edition, variant, code and barcode. */
function row(r) {
  const [id = "", status = ""] = psql(`select r.id || '|' || r.status from public.releases r join public.games g on g.id = r.game_id join public.platforms p on p.id = r.platform_id
    where g.title = ${lit(title(r))} and p.slug = ${lit(r.platform)} and r.region_code = ${lit(r.region)} and r.media_format_code = ${lit(r.format)}
      and coalesce(r.edition_name, '') = ${lit(r.facts.edition_name ?? "")} and coalesce(r.variant_name, '') = ${lit(r.facts.variant_name ?? "")}
      and coalesce(r.product_code, '') = ${lit(r.facts.product_code ?? "")} and coalesce(r.barcode, '') = ${lit(r.facts.barcode ?? "")};`).split("|");
  return { id, status };
}
for (const r of RELEASES) Object.assign(r, { row: row(r) });
const published = RELEASES.filter((r) => r.row.status === "published");
const liveGames = GAMES.filter((g) => published.some((r) => r.game === g.key));
const slugOf = (key) => psql(`select slug from public.games where title = ${lit(GAMES.find((g) => g.key === key).title)};`);

/** Every collection on the stack before the checks, to compare at the end. */
const collectionsBefore = psql("select count(*) || ':' || coalesce(md5(string_agg(c::text, '|' order by c.id)), '') from public.collection_items c;");

function choices(html, slug) {
  const out = [];
  for (const m of html.matchAll(new RegExp(`href="/games/${slug}\\?([^"]*)"`, "g"))) out.push(Object.fromEntries(new URLSearchParams(decode(m[1]))));
  return out;
}
const addForm = (html) => forms(html).find((f) => "release_id" in f.hidden && "item_id" in f.hidden && "components" in f.hidden);
const claimForm = (html) => forms(html).find((f) => "platform_id" in f.hidden && "game_id" in f.hidden && !("item_id" in f.hidden && f.names.includes("region")));

async function collector() {
  const user = await createUser({ prefix: "pilot" });
  users.push(user.id);
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  const handle = `pl_${randomBytes(5).toString("hex")}`;
  handles.push(handle);
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle });
  return { ...user, browser };
}

function catalogState() {
  section("The pilot in the catalog, as reviewed");
  check(`every pilot candidate is on the stack once (${RELEASES.length})`, RELEASES.every((r) => r.row.id && psql(`select count(*) from public.releases where id = ${lit(r.row.id)};`) === "1"));
  // Editors' releases only: a collector's own submission (private to them and editors) isn't the pilot's.
  check(`the ${HELD.length} held entries were never entered`, psql("select count(*) from public.releases where submitted_by is null;") === String(RELEASES.length));
  for (const g of GAMES) check(`${g.title}: one game, never a duplicate`, psql(`select count(*) from public.games where lower(title) = lower(${lit(g.title)});`) === "1");
  check("only class A releases are published", published.every((r) => r.class === "A"), published.filter((r) => r.class !== "A").map((r) => r.id).join(","));
  for (const r of published) {
    const by = psql(`select coalesce((select e.actor_id::text from private.audit_events e where e.action = 'catalog_record_created' and e.metadata ->> 'entity' = 'release' and (e.metadata ->> 'id')::uuid = r.id), 'none') || '|' || coalesce(r.verified_by::text, 'none')
      from public.releases r where r.id = ${lit(r.row.id)};`).split("|");
    check(`${r.id} was created by one editor and verified by another`, by[0] !== "none" && by[1] !== "none" && by[0] !== by[1]);
  }
  check("every published release has classified packaging and a pilot shell", psql("select count(*) from public.releases where status = 'published' and (packaging_code = 'unclassified' or media_format_code = 'rom-cartridge');") === "0");
  for (const g of GAMES) check(`${g.title} is ${liveGames.includes(g) ? "published with its release" : "still in review"}`, psql(`select status from public.games where title = ${lit(g.title)};`) === (liveGames.includes(g) ? "published" : "under_review"));
}

async function gamePages() {
  section("Search, game pages and the fast-add choices, against the evidence");
  const visitor = new Browser();
  for (const g of liveGames) {
    const slug = slugOf(g.key);
    const mine = published.filter((r) => r.game === g.key);
    const search = await visitor.get(`/explore?q=${encodeURIComponent(g.title)}`);
    check(`${g.title}: found by search`, search.html.includes(`href="/games/${slug}"`));
    const page = await visitor.get(`/games/${slug}`);
    check(`${g.title}: its page loads, titled`, page.response.status === 200 && plain(page.html).includes(g.title));
    const platforms = distinct(mine.map((r) => r.platform));
    check(`${g.title}: platform ${platforms.join(", ")} only`, platforms.length === 1 && plain(page.html).includes("2. Region"));
    const regions = distinct(mine.map((r) => r.region));
    const offeredRegions = distinct(choices(page.html, slug).filter((c) => c.region && !c.edition && !["other", "unsure"].includes(c.region)).map((c) => c.region));
    check(`${g.title}: regions ${regions.join(", ")}, as published`, sameSet(offeredRegions, regions), offeredRegions.join(","));
    for (const region of regions) {
      const step = await visitor.get(`/games/${slug}?platform=${platforms[0]}&region=${region}`);
      const offered = distinct(choices(step.html, slug).filter((c) => c.region === region && c.edition && !c.release && !["other", "unsure"].includes(c.edition)).map((c) => c.edition));
      const expected = distinct(mine.filter((r) => r.region === region).map(editionKey));
      check(`${g.title} ${region}: editions ${expected.join(", ")}`, sameSet(offered, expected), offered.join(","));
    }
  }
  // The results are judged by the games they link to: the no-results page repeats the
  // query, and a similar published title ("Super Mario World" for "Super Mario Bros.") may
  // rightly appear. Only published games have a page to link to.
  const publishedSlugs = new Set(psql("select coalesce(string_agg(slug, ',' order by slug), '') from public.games where status = 'published';").split(",").filter(Boolean));
  for (const g of GAMES.filter((x) => !liveGames.includes(x))) {
    const search = await visitor.get(`/explore?q=${encodeURIComponent(g.title)}`);
    const linked = distinct([...search.html.matchAll(/href="\/games\/([a-z0-9-]+)"/g)].map((m) => m[1]));
    check(`${g.title}, still in review, isn't in search`, linked.every((slug) => publishedSlugs.has(slug)), linked.join(","));
  }
}

/** The fast-add address that names exactly this published release. */
function pathTo(r) {
  const slug = slugOf(r.game);
  const siblings = published.filter((x) => x.game === r.game && x.region === r.region && editionKey(x) === editionKey(r));
  const q = new URLSearchParams({ platform: r.platform, region: r.region, edition: editionKey(r), ...(siblings.length > 1 ? { release: r.row.id } : {}) });
  return `/games/${slug}?${q}`;
}

async function collecting() {
  section("A collector adds copies");
  const user = await collector();
  const ps = published.find((r) => r.platform === "playstation");
  const added = [];
  // Every published release, each as itself.
  for (const r of published) {
    const path = pathTo(r);
    const page = await user.browser.get(path);
    const form = addForm(page.html);
    check(`${r.id} (${title(r)}, ${r.region}, ${r.facts.edition_name}): the choices name that release`, form?.hidden.release_id === r.row.id);
    if (!form) continue;
    await user.browser.submit(path, form, {});
    await user.browser.submit(path, form, {});
    added.push(r);
  }
  const copies = psql(`select coalesce(string_agg(release_id::text, ',' order by release_id), '') from public.collection_items where owner_id = ${lit(user.id)};`).split(",").filter(Boolean);
  check("each release was added once, as itself, though its form was sent twice", sameSet(copies, added.map((r) => r.row.id)));
  check(`${added.length} releases are ${added.length} copies of ${added.length} separate releases`, new Set(copies).size === copies.length && copies.length === added.length);
  // Check 7 needs two published releases of one game. It's reported as unmet, never as passed.
  const pair = liveGames.map((g) => added.filter((r) => r.game === g.key)).find((rs) => rs.length >= 2);
  if (pair) {
    check(`${title(pair[0])}: its releases ${pair.map((r) => r.id).join(" and ")} stay separate copies of separate releases`, pair.every((r) => copies.includes(r.row.id)) && new Set(pair.map((r) => r.row.id)).size === pair.length);
    // Ordered by region, then format, then code, each compared byte by byte ("C"), as below.
    const kept = psql(`select string_agg(r.region_code || '/' || r.media_format_code || '/' || coalesce(r.product_code, ''), ','
        order by r.region_code collate "C", r.media_format_code collate "C", coalesce(r.product_code, '') collate "C")
      from public.collection_items c join public.releases r on r.id = c.release_id
      where c.owner_id = ${lit(user.id)} and r.id in (${pair.map((r) => lit(r.row.id)).join(",")});`);
    const byte = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const expected = pair
      .map((r) => [r.region, r.format, r.facts.product_code ?? ""])
      .sort((a, b) => byte(a[0], b[0]) || byte(a[1], b[1]) || byte(a[2], b[2]))
      .map((f) => f.join("/"))
      .join(",");
    check("each copy keeps its own release: region, cartridge format and code", kept === expected, kept);
    // The summary counts the whole collection; the rows are the search's.
    const listHtml = (await user.browser.get(`/collection?q=${encodeURIComponent(title(pair[0]))}`)).html;
    const rows = distinct([...listHtml.matchAll(/href="\/collection\/([0-9a-f-]{36})/g)].map((m) => m[1]));
    const list = plain(listHtml);
    const labels = { "ntsc-uc": "NTSC-U/C", pal: "PAL", "ntsc-j": "NTSC-J" };
    check("My Collection lists both copies of the game, each with its region", rows.length === pair.length && pair.every((r) => list.includes(labels[r.region] ?? r.region)), `${rows.length} rows`);
  } else {
    prerequisites.push("check 7: no game has two published releases, so two releases of one game can't be added and compared");
    console.log("SKIP two releases of one game: no game has two published releases (an unmet prerequisite, not a pass)");
  }

  // A copy whose edition the collector doesn't know: kept unidentified, nothing invented.
  const base = ps ?? published[0];
  const unsurePath = `/games/${slugOf(base.game)}?platform=${base.platform}&region=${base.region}&edition=unsure`;
  const unsure = await user.browser.get(unsurePath);
  const claim = claimForm(unsure.html);
  check("with the edition not sure, no release is offered, only an unidentified copy", Boolean(claim) && !addForm(unsure.html));
  const releasesBefore = psql("select count(*) from public.releases;");
  if (claim) await user.browser.submit(unsurePath, claim, {});
  check("the copy is recorded unidentified, with the platform and region they know", psql(`select count(*) from public.collection_items c join public.platforms p on p.id = c.claimed_platform_id
    where c.owner_id = ${lit(user.id)} and c.release_id is null and p.slug = ${lit(base.platform)} and c.claimed_region_code = ${lit(base.region)} and c.claimed_edition_kind is null;`) === "1");
  check("and nothing was added to the catalog for it", psql("select count(*) from public.releases;") === releasesBefore && psql("select count(*) from public.games;") === String(GAMES.length));

  section("Ownership and the collection summary");
  const total = added.length + 1;
  for (const key of distinct([...added.map((r) => r.game), base.game])) {
    const n = added.filter((r) => r.game === key).length + (key === base.game ? 1 : 0);
    const label = n === 1 ? ["Owned: Yes", "Owned: 1 copy"] : [`Owned: ${n} copies`];
    const g = GAMES.find((x) => x.key === key);
    const page = plain((await user.browser.get(`/games/${slugOf(key)}`)).html);
    check(`${g.title}: the game page counts ${n}`, label.some((l) => page.includes(l)), page.match(/Owned: [^ ]+ ?\w*/)?.[0]);
    const search = plain((await user.browser.get(`/explore?q=${encodeURIComponent(g.title)}`)).html);
    check(`${g.title}: so does search`, label.some((l) => search.includes(l)), search.match(/Owned: [^ ]+ ?\w*/)?.[0]);
  }
  const platforms = distinct([...added.map((r) => r.platform), base.platform]).length;
  const summary = plain((await user.browser.get("/collection")).html);
  check(`the collection summary counts ${total} copies on ${platforms} platform${platforms === 1 ? "" : "s"}`, summary.includes(`${total} cop`) && summary.includes(`${platforms} platform`), summary.match(/\d+ cop\w+[^.]{0,60}/)?.[0]);
  const stranger = await collector();
  check("another collector owns none of it", !plain((await stranger.browser.get(`/games/${slugOf(base.game)}`)).html).includes("Owned:"));
}

if (!published.length) {
  console.log("Nothing in the pilot is published yet. These checks run after a human catalog editor reviews and publishes releases; none are reported as passed.");
  process.exit(2);
}
try {
  catalogState();
  await startApp(3272);
  await gamePages();
  await collecting();
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  stopApp();
  const ids = users.map((id) => lit(id)).join(",") || "null";
  psql(`delete from public.collection_items where owner_id in (${ids});`);
  const deleted = await deleteUsers();
  // Only the holds on this run's own handles, released when their accounts were deleted.
  if (handles.length) psql(`delete from private.handle_holds where kind = 'released' and handle in (${handles.map(lit).join(",")});`);
  if (deleted.length) psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${deleted.map(lit).join(",")}) or target_profile_id in (${deleted.map(lit).join(",")}); commit;`);
  check("every other collection on the stack is exactly as it was", psql("select count(*) || ':' || coalesce(md5(string_agg(c::text, '|' order by c.id)), '') from public.collection_items c;") === collectionsBefore);
  check("and the pilot is unchanged", RELEASES.every((r) => row(r).status === r.row.status));
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
for (const p of prerequisites) console.log(`UNMET PREREQUISITE ${p}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
