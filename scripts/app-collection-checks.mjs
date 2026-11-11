/**
 * M6c end-to-end checks: adding copies from a game page in the built app, driven over
 * HTTP against the local stack and its catalog fixture. Forms are submitted the way a
 * browser without JavaScript would, which runs the real page, Server Action, session
 * checks and M6b functions. Outcomes are judged by the database and by the page
 * rendered afterwards. Without JavaScript that page shows no message (React can't
 * carry an action's result into a resumed prerender), so the messages are covered by
 * `npm run collection:test` and checked visibly in a real browser.
 *
 *   npm run build && npm run app:collection-checks
 *
 * Local only. Installs the catalog fixture and removes it, and every test account, at
 * the end. Prints check names and statuses, never keys, tokens or cookies.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  appErrorLines,
  Browser,
  check,
  createUser,
  deleteUsers,
  formWith,
  psql,
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

const SLUG = "starfall-odyssey";
const release = (code) => psql(`select id from public.releases where product_code = '${code}';`);
const copies = (userId, releaseId) => Number(psql(`select count(*) from public.collection_items where owner_id = '${userId}' and release_id = '${releaseId}';`));
const page = (releaseId) => `/games/${SLUG}?release=${releaseId}`;
const addForm = (html) => formWith(html, "release_id");
const text = (html) => html.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");

/** A UUIDv7 for a given time. */
function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function collector({ handle = true } = {}) {
  const user = await createUser({ prefix: "addc" });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  if (handle) {
    const welcome = await browser.get("/welcome");
    await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `ac_${randomBytes(5).toString("hex")}` });
  }
  return { ...user, browser };
}

let published;
let draft;

async function signedOut() {
  section("Signed out");
  const visitor = new Browser();
  const { response, html } = await visitor.get(page(published));
  check("the game page stays public", response.status === 200 && html.includes("Starfall Odyssey") && html.includes('aria-label="Releases"'));
  check("it offers sign-in, returning to the selected release", html.includes(`/sign-in?next=${encodeURIComponent(page(published))}`));
  check("it has no add form and no count", !addForm(html) && !html.includes("Not in your collection yet") && !/You have \d+ cop/.test(html));
  check("it says that submitting missing releases is coming", text(html).includes("Can't find your release? Submitting missing games and releases"));
  const missing = await visitor.get(page(randomUUID()));
  check("an unknown release says it isn't available", missing.response.status === 200 && text(missing.html).includes("That release isn't available."));

  const user = await createUser({ prefix: "addc" });
  const browser = new Browser();
  const signIn = await browser.get(`/sign-in?next=${encodeURIComponent(page(published))}`);
  const back = await browser.submit("/sign-in", formWith(signIn.html, "password"), { email: user.email, password: user.password });
  check("signing in returns to the selected release", (back.response.headers.get("location") ?? "").endsWith(page(published)));
}

async function quickAdd() {
  section("Quick add");
  const owner = await collector();
  const first = await owner.browser.get(page(published));
  const form = addForm(first.html);
  check("the page shows the add form", Boolean(form) && /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(form?.hidden.item_id ?? "") && form.hidden.release_id === published);
  check("with the current count", first.html.includes("Not in your collection yet"));
  check("and the optional details collapsed", /<details\b(?![^>]*\bopen)[^>]*>/.test(first.html) && first.html.includes("More details"));

  const added = await owner.browser.submit(page(published), form, {});
  check("the form posts to the server action without JavaScript", Object.keys(form.hidden).some((name) => name.startsWith("$ACTION_")));
  check("without JavaScript the page shows no message afterwards (documented limitation)", !added.html.includes("Added to your collection."));
  check("one action adds a copy, and the page shows the new count", added.response.status === 200 && copies(owner.id, published) === 1 && added.html.includes("You have 1 copy of this release"));
  check("owned by the signed-in user, with completeness unrecorded and no details",
    psql(`select owner_id || ' ' || coalesce(completeness::text, 'null') || ' ' || (select count(*) from public.collection_item_private p where p.item_id = c.id) from public.collection_items c where c.id = '${form.hidden.item_id}';`) === `${owner.id} null 0`);

  const repeated = await owner.browser.submit(page(published), form, {});
  check("resubmitting the same form, as a retry or a reload does, adds nothing", repeated.response.status === 200 && copies(owner.id, published) === 1);
  const next = addForm(added.html);
  // Without JavaScript the page is rendered afresh after the action, with a new id. The
  // "Add another copy" button and messages need JavaScript; the browser check covers them.
  check("after adding, the next submission carries a new id", /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(next.hidden.item_id) && next.hidden.item_id !== form.hidden.item_id);
  const burst = await Promise.all(Array.from({ length: 5 }, () => owner.browser.submit(page(published), next, {})));
  check("five simultaneous submissions of one form add one copy", burst.every((r) => r.response.status === 200) && copies(owner.id, published) === 2);
  const another = addForm(burst[0].html);
  await owner.browser.submit(page(published), another, {});
  check("adding another copy on purpose works", copies(owner.id, published) === 3);
  check("the page then shows the count", (await owner.browser.get(page(published))).html.includes("You have 3 copies of this release"));

  const spoofed = addForm((await owner.browser.get(page(published))).html);
  const other = await createUser({ prefix: "addc" });
  await owner.browser.submit(page(published), spoofed, { owner_id: other.id, p_owner: other.id });
  check("an owner sent by the browser is ignored", psql(`select owner_id from public.collection_items where id = '${spoofed.hidden.item_id}';`) === owner.id);
  return owner;
}

async function details(owner) {
  section("Optional details");
  const form = addForm((await owner.browser.get(page(published))).html);
  const notes = `Fair find ${randomBytes(3).toString("hex")}`;
  const saved = await owner.browser.submit(page(published), form, {
    completeness: "complete", box_condition: "good", media_condition: "very_good", manual_condition: "not_included",
    component_0: "included", component_1: "missing", acquired_on: "2020-05-01", purchase_price: "37.42", currency: "EUR",
    notes, storage_location: "Shelf A",
  });
  check("a copy is added with its details", saved.response.status === 200 && psql(`select count(*) from public.collection_items where id = '${form.hidden.item_id}' and owner_id = '${owner.id}';`) === "1");
  check("the details are stored as given",
    psql(`select concat_ws(' ', c.completeness, c.box_condition, c.media_condition, c.manual_condition, p.acquired_on, p.purchase_price, p.currency, p.storage_location)
          from public.collection_items c join public.collection_item_private p on p.item_id = c.id where c.id = '${form.hidden.item_id}';`)
      === "complete good very_good not_included 2020-05-01 37.4200 EUR Shelf A");
  check("and the release's pieces",
    psql(`select string_agg(label || '=' || coalesce(condition::text, 'included'), ',' order by label) from public.collection_item_components where item_id = '${form.hidden.item_id}';`)
      === "Instruction manual=included,World map poster=not_included");
  check("the form is cleared for the next copy", !addForm(saved.html) || !saved.html.includes(notes));

  const next = addForm(saved.html);
  const before = copies(owner.id, published);
  const refused = await owner.browser.submit(page(published), next, { completeness: "loose", box_condition: "good", notes: "keep me" });
  const refusedPageWorks = (r) => r.response.status === 200 && Boolean(addForm(r.html));
  check("inconsistent details are refused", refusedPageWorks(refused) && copies(owner.id, published) === before);
  const noCurrency = await owner.browser.submit(page(published), next, { purchase_price: "10" });
  check("a price needs a currency", refusedPageWorks(noCurrency) && copies(owner.id, published) === before);
  const future = await owner.browser.submit(page(published), next, { acquired_on: "2999-01-01" });
  check("an acquisition date can't be in the future", refusedPageWorks(future) && copies(owner.id, published) === before);

  section("Refused requests");
  const unpublished = await owner.browser.submit(page(published), next, { release_id: draft });
  check("an unpublished release can't be added", refusedPageWorks(unpublished) && copies(owner.id, draft) === 0);
  const stale = await owner.browser.submit(page(published), next, { item_id: uuidv7(Date.now() - 2 * 86400000) });
  const renewed = addForm(stale.html);
  check("a page open too long is refused, and the page gets a fresh id", renewed.hidden.item_id !== next.hidden.item_id && copies(owner.id, published) === before);
  const garbage = await owner.browser.submit(page(published), next, { item_id: "not-an-id" });
  check("a malformed id is refused", refusedPageWorks(garbage) && copies(owner.id, published) === before);
  return notes;
}

async function privacy(owner, notes) {
  section("Nothing private on public pages");
  const someone = await collector();
  const theirs = await someone.browser.get(page(published));
  check("another collector sees only their own count", theirs.html.includes("Not in your collection yet"));
  const visitor = await new Browser().get(page(published));
  for (const [who, html] of [["another collector", theirs.html], ["a visitor", visitor.html]]) {
    check(`${who} sees none of the owner's details`, !html.includes(notes) && !html.includes("Shelf A") && !html.includes("37.42") && !html.includes(owner.id));
  }
  const own = await owner.browser.get(page(published));
  check("the owner's page doesn't show their private details either", !own.html.includes(notes) && !own.html.includes("Shelf A"));
  const session = readSession(owner.browser).session;
  check("no page contains the session's tokens", !own.html.includes(session.access_token) && !own.html.includes(session.refresh_token));

  const files = readdirSync(join(root, ".next", "static"), { recursive: true }).filter((f) => String(f).endsWith(".js"));
  const bundle = files.map((f) => readFileSync(join(root, ".next", "static", String(f)), "utf8")).join("\n");
  check("the browser bundle calls no collection function and has no Supabase client",
    !/add_collection_item|get_my_release_copies|collection_item_private|user_preferences|createServerClient|signInWithPassword/.test(bundle), `${files.length} files`);
}

async function accounts(owner) {
  section("Account states");
  const noHandle = await collector({ handle: false });
  const pending = await noHandle.browser.get(page(published));
  check("an account without a handle is asked to choose one", pending.html.includes("Choose your handle") && !addForm(pending.html));

  const form = addForm((await owner.browser.get(page(published))).html);
  const before = copies(owner.id, published);
  psql(`update public.profiles set account_status = 'suspended' where id = '${owner.id}';`);
  const suspendedPage = await owner.browser.get(page(published));
  check("a suspended account is told it can't add", text(suspendedPage.html).includes("Your account can't add copies right now.") && !addForm(suspendedPage.html));
  const replay = await owner.browser.submit(page(published), form, {});
  check("and a submission from an earlier page is refused", text(replay.html).includes("Your account can't add copies right now.") && !addForm(replay.html) && copies(owner.id, published) === before);
  psql(`update public.profiles set account_status = 'active' where id = '${owner.id}';`);

  const visitor = new Browser();
  const anonymous = await visitor.submit(page(published), form, {});
  check("a submission without a session is refused", anonymous.html.includes("Sign in to add to your collection") && copies(owner.id, published) === before);

  const stored = readSession(owner.browser);
  const forger = new Browser();
  const [header, payload] = stored.session.access_token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  writeSession(forger, stored.names, { ...stored.session, access_token: `${header}.${Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 3600 })).toString("base64url")}.${"A".repeat(43)}` });
  const forgedPage = await forger.get(page(published));
  check("a forged session sees the signed-out page", forgedPage.html.includes("Sign in to add to your collection") && !addForm(forgedPage.html));
  const forged = await forger.submit(page(published), form, {});
  check("and can't add", copies(owner.id, published) === before && !addForm(forged.html));
}

async function catalog() {
  section("The public catalog is unchanged");
  const visitor = new Browser();
  const search = await visitor.get("/explore?q=starfall");
  check("search still works signed out", search.response.status === 200 && search.html.includes("Starfall Odyssey"));
  const game = await visitor.get(`/games/${SLUG}`);
  check("the release picker still lists the releases", game.response.status === 200 && (game.html.match(/aria-current="true"/g) ?? []).length === 0 && game.html.includes("SNS-ZSFE-USA"));
  check("and asks for a release before adding", game.html.includes("Choose the release you have to add it to your collection."));
}

try {
  installFixture();
  published = release("SNS-ZSFE-USA");
  draft = release("SNS-ZSFE-DRAFT");
  await startApp(3220);
  await signedOut();
  const owner = await quickAdd();
  const notes = await details(owner);
  await privacy(owner, notes);
  await accounts(owner);
  await catalog();
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  stopApp();
  const ids = await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ac\\_%';");
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
