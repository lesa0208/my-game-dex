/**
 * M12c-A end-to-end checks: the real NES, SNES and PlayStation pilot, as a collector uses
 * it, in the built app over HTTP against the isolated test stack. Run after
 * scripts/catalog-pilot-m12c.mjs has staged the pilot AND a second, human catalog editor
 * has verified and published its A releases in the admin pages (no script does that).
 * Not yet run: the pilot is staged, and publication waits on that reviewer.
 *
 *   npm run build && MGD_STACK=test node scripts/app-catalog-pilot-checks.mjs
 *
 * Every expectation comes from the evidence table (scripts/catalog-pilot-m12c-data.mjs),
 * so the pages are judged against what the sources state: each published game is found,
 * its page offers exactly the platforms, regions and editions of its published releases,
 * copies can be added (several editions stay separate releases, and a copy whose edition
 * isn't known is kept unidentified), nothing is duplicated, and ownership and the
 * collection summary count the copies.
 *
 * Read-only for the catalog. Its collectors, their copies and their audit rows are
 * removed at the end; the pilot itself stays. Prints check names and statuses only.
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
const editionKey = (kind, name) => `${kind ?? ""}~${name ?? ""}`;
const users = [];
const published = RELEASES.filter((r) => r.class === "A");
const staged = RELEASES.filter((r) => r.class === "B");
const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

/** The fast-add links on a game page, as their query parameters. */
function choices(html, slug) {
  const out = [];
  for (const m of html.matchAll(new RegExp(`href="/games/${slug}\\?([^"]*)"`, "g"))) out.push(Object.fromEntries(new URLSearchParams(decode(m[1]))));
  return out;
}
const distinct = (values) => [...new Set(values)];
const idOf = (r) => psql(`select r.id from public.releases r join public.games g on g.id = r.game_id where g.title = '${GAMES.find((g) => g.key === r.game).title.replace(/'/g, "''")}'
  and r.region_code = '${r.region}' and r.status = 'published' and coalesce(r.product_code, '') = '${r.facts.product_code ?? ""}' and coalesce(r.barcode, '') = '${r.facts.barcode ?? ""}';`);

async function collector() {
  const user = await createUser({ prefix: "pilot" });
  users.push(user.id);
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `pl_${randomBytes(5).toString("hex")}` });
  return { ...user, browser };
}
const addForm = (html) => forms(html).find((f) => "release_id" in f.hidden && "item_id" in f.hidden);
const claimForm = (html) => forms(html).find((f) => "platform_id" in f.hidden && "game_id" in f.hidden && !("item_id" in f.hidden && f.names.includes("region")));

function catalogState() {
  section("The pilot is in the catalog as reviewed");
  for (const g of GAMES) {
    const titled = psql(`select count(*) from public.games where lower(title) = lower('${g.title.replace(/'/g, "''")}');`);
    check(`${g.title}: one game, never a duplicate`, titled === "1", titled);
  }
  const live = GAMES.filter((g) => published.some((r) => r.game === g.key));
  for (const g of live) check(`${g.title} is published, from Wikidata ${g.qid}`, psql(`select g.status from public.games g join private.external_references x on x.game_id = g.id where x.provider_code = 'wikidata' and x.external_id = '${g.qid}';`) === "published");
  for (const g of GAMES.filter((x) => !live.includes(x))) check(`${g.title} has no publishable release yet, so it stays in review`, psql(`select status from public.games where title = '${g.title}';`) === "under_review");
  check(`all ${published.length} A releases are published, each once`, published.every((r) => idOf(r).split("\n").filter(Boolean).length === 1));
  check(`the ${staged.length} B candidates stay in review, unverified`, psql(`select count(*) from public.releases where status = 'under_review' and verified_at is null;`) === String(staged.length));
  check(`the ${HELD.length} held entries were never entered`, psql("select count(*) from public.releases;") === String(published.length + staged.length));
  check("every published release has a classified packaging and a pilot shell", psql("select count(*) from public.releases where status = 'published' and (packaging_code = 'unclassified' or media_format_code = 'rom-cartridge');") === "0");
  const authors = psql(`select count(*) filter (where e.actor_id is null) || '/' || count(*) filter (where e.actor_id = r.verified_by) || '/' || count(*)
    from public.releases r join private.audit_events e on e.action = 'catalog_record_created' and e.metadata ->> 'entity' = 'release' and (e.metadata ->> 'id')::uuid = r.id
    where r.status = 'published';`);
  check("each was created by one editor and verified by another", authors === `0/0/${published.length}`, authors);
  check("no published release is a collector's submission", psql("select count(*) from public.releases where status = 'published' and submitted_by is not null;") === "0");
}

async function gamePages() {
  section("Search, game pages and the fast-add choices match the evidence");
  const visitor = new Browser();
  for (const g of GAMES.filter((x) => published.some((r) => r.game === x.key))) {
    const slug = psql(`select slug from public.games where title = '${g.title}';`);
    const mine = published.filter((r) => r.game === g.key);
    const search = await visitor.get(`/explore?q=${encodeURIComponent(g.title)}`);
    check(`${g.title}: found by search`, search.html.includes(`href="/games/${slug}"`));
    const page = await visitor.get(`/games/${slug}`);
    check(`${g.title}: its page loads, titled`, page.response.status === 200 && new RegExp(`<h1[^>]*>[^<]*${g.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(page.html));
    // One platform in the catalog: it's chosen, so the page goes on to the region.
    const platforms = distinct(mine.map((r) => r.platform));
    check(`${g.title}: platform ${platforms.join(", ")} only`, platforms.length === 1 && plain(page.html).includes("2. Region"));
    const regionLinks = choices(page.html, slug).filter((c) => c.region && !c.edition && ![("other"), "unsure"].includes(c.region)).map((c) => c.region);
    const regions = distinct(mine.map((r) => r.region));
    check(`${g.title}: regions ${regions.join(", ")}, as released`, sameSet(distinct(regionLinks), regions), distinct(regionLinks).join(","));
    for (const region of regions) {
      const step = await visitor.get(`/games/${slug}?platform=${platforms[0]}&region=${region}`);
      const offered = distinct(choices(step.html, slug).filter((c) => c.region === region && c.edition && !c.release && !["other", "unsure"].includes(c.edition)).map((c) => c.edition));
      const expected = distinct(mine.filter((r) => r.region === region).map((r) => editionKey(r.facts.edition_kind, r.facts.edition_name)));
      check(`${g.title} ${region}: editions ${expected.join(", ")}`, sameSet(offered, expected), offered.join(","));
      for (const key of expected) {
        const count = mine.filter((r) => r.region === region && editionKey(r.facts.edition_kind, r.facts.edition_name) === key).length;
        if (count < 2) continue;
        const choose = await visitor.get(`/games/${slug}?platform=${platforms[0]}&region=${region}&edition=${encodeURIComponent(key)}`);
        const listed = distinct(choices(choose.html, slug).filter((c) => c.release).map((c) => c.release));
        check(`${g.title} ${region} ${key}: its ${count} releases are listed to choose from, none picked`, listed.length >= count && !addForm(choose.html), listed.length);
      }
    }
  }
  const nes = await visitor.get("/explore?q=Super%20Mario%20Bros.");
  check("an NES game still in review isn't in search", !plain(nes.html).includes("Super Mario Bros.") || !/href="\/games\/super-mario-bros"/.test(nes.html));
}

async function collecting() {
  section("A collector adds copies");
  const user = await collector();
  const alttp = psql("select slug from public.games where title = 'The Legend of Zelda: A Link to the Past';");
  const pc = published.find((r) => r.id === "S9");
  const std = published.find((r) => r.id === "S8");
  const add = async (path) => {
    const page = await user.browser.get(path);
    const form = addForm(page.html);
    if (form) await user.browser.submit(path, form, {});
    return form;
  };
  const stdPath = `/games/${alttp}?platform=snes&region=ntsc-uc&edition=${encodeURIComponent("standard~Standard")}`;
  const pcPath = `/games/${alttp}?platform=snes&region=ntsc-uc&edition=${encodeURIComponent("reprint~Player's Choice")}`;
  const stdForm = await add(stdPath);
  check("the Standard edition names one release, and is added", stdForm?.hidden.release_id === idOf(std));
  const pcForm = await add(pcPath);
  check("the Player's Choice reprint names its own release, and is added", pcForm?.hidden.release_id === idOf(pc));
  await user.browser.submit(pcPath, pcForm, {});
  const copies = psql(`select string_agg(release_id::text, ',' order by release_id) from public.collection_items where owner_id = '${user.id}';`).split(",").filter(Boolean);
  check("the two editions stay two separate releases", copies.length === 2 && new Set(copies).size === 2);
  check("sending the same form again added nothing more", copies.length === 2);

  // A copy whose edition the collector doesn't know: kept unidentified, nothing invented.
  const crash = psql("select slug from public.games where title = 'Crash Bandicoot';");
  const unsurePath = `/games/${crash}?platform=playstation&region=ntsc-j&edition=unsure`;
  const unsure = await user.browser.get(unsurePath);
  const claim = claimForm(unsure.html);
  check("with the edition not sure, no release is offered, only an unidentified copy", Boolean(claim) && !addForm(unsure.html));
  await user.browser.submit(unsurePath, claim, {});
  check("the copy is recorded unidentified, with the region they know", psql(`select count(*) from public.collection_items c join public.platforms p on p.id = c.claimed_platform_id
    where c.owner_id = '${user.id}' and c.release_id is null and p.slug = 'playstation' and c.claimed_region_code = 'ntsc-j' and c.claimed_edition_kind is null;`) === "1");
  check("and no catalog record was made for it", psql("select count(*) from public.releases;") === String(published.length + staged.length) && psql("select count(*) from public.catalog_change_requests;") === "0");

  section("Ownership and the collection summary");
  const page = plain((await user.browser.get(`/games/${alttp}`)).html);
  check("the game page counts the collector's copies", page.includes("Owned: 2 copies"), page.match(/Owned: [^ ]+ ?\w*/)?.[0]);
  const search = plain((await user.browser.get("/explore?q=Link%20to%20the%20Past")).html);
  check("search shows ownership on the game", search.includes("Owned: 2 copies"));
  const crashSearch = plain((await user.browser.get("/explore?q=Crash%20Bandicoot")).html);
  check("an unidentified copy counts as owned", crashSearch.includes("Owned: Yes") || crashSearch.includes("Owned: 1"), crashSearch.match(/Owned: [^ ]+ ?\w*/)?.[0]);
  const summary = plain((await user.browser.get("/collection")).html);
  check("the collection summary counts 3 copies on 2 platforms", summary.includes("3 copies") && summary.includes("2 platforms"), summary.match(/\d+ cop\w+[^.]{0,60}/)?.[0]);
  const stranger = await collector();
  check("another collector owns none of it", !plain((await stranger.browser.get(`/games/${alttp}`)).html).includes("Owned: 2"));
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
  const ids = users.map((id) => `'${id}'`).join(",") || "null";
  psql(`delete from public.collection_items where owner_id in (${ids});`);
  const deleted = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'pl\\_%';");
  if (deleted.length) psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${deleted.map((id) => `'${id}'`).join(",")}) or target_profile_id in (${deleted.map((id) => `'${id}'`).join(",")}); commit;`);
  check("the collectors left nothing behind, and the pilot is unchanged", psql("select count(*) from public.collection_items;") === "0" && psql("select count(*) from public.releases where status = 'published';") === String(published.length));
}

const errorLines = appErrorLines();
check("the app logged no errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
