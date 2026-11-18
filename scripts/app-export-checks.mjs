/**
 * M11a-4a app checks: the personal data export (POST /settings/account/export) and the
 * avatar upload limits, driven through the built app over HTTP as a browser without
 * JavaScript would, against the local test stack and its catalog fixture.
 *
 *   npm run build && npm run test-stack:run -- app:export-checks
 *
 * Destructive, so it refuses a protected development stack. Throwaway accounts only;
 * nothing printed contains a token, key, password or address.
 */
import { randomBytes, randomUUID } from "node:crypto";

import sharp from "sharp";

import {
  appErrorLines,
  appLog,
  Browser,
  check,
  createUser,
  decode,
  deleteUsers,
  formWith,
  isRedirect,
  location,
  psql,
  readSession,
  results,
  section,
  signInAs,
  startApp,
  stopApp,
  verifyBrowser,
} from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { stackStatus } from "./lib/stack.mjs";

const stack = stackStatus({ label: "the export app checks" });
const api = stack.API_URL;
const publishable = stack.PUBLISHABLE_KEY ?? stack.ANON_KEY;
const secret = stack.SECRET_KEY ?? stack.SERVICE_ROLE_KEY;
const service = { apikey: secret, Authorization: `Bearer ${secret}` };
const origin = await startApp(3300);

const ACCOUNT = "/settings/account";
const EXPORT = "/settings/account/export";
const BULK = 1_050;
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;
const visible = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const errorOf = (to) => new URL(to || "/", "http://x").searchParams.get("error");
const tokenOf = (user) => readSession(user.browser)?.session?.access_token ?? "";

function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A throwaway account with a handle (prefix ex_), signed in in its own browser. */
async function person({ mfa = false } = {}) {
  const user = await createUser({ prefix: "appex", mfa });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `ex_${randomBytes(5).toString("hex")}` });
  const handle = psql(`select handle from public.profiles where id = ${sql(user.id)};`);
  return { ...user, browser, handle };
}

async function rpc(user, fn, args) {
  const r = await fetch(`${api}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: publishable, Authorization: `Bearer ${tokenOf(user)}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${fn} failed: ${body?.message ?? r.status}`);
  return body;
}
const add = (user, release, details = {}) => rpc(user, "add_collection_item", { p_item_id: uuidv7(), p_release: release, p_details: details }).then((b) => b.item_id);

/** Posts the page's export form, as the browser would. Returns the response and its text. */
async function download(user, headers = {}, path = EXPORT) {
  const response = await fetch(`${origin}${path}`, { method: "POST", redirect: "manual", headers: { cookie: user.browser.cookieHeader(), origin, "content-type": "application/x-www-form-urlencoded", ...headers }, body: "" });
  user.browser.store(response);
  let text = "";
  let broken = false;
  try {
    text = await response.text();
  } catch {
    broken = true;
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { response, text, data, broken, to: location(response) };
}
const clearSlots = (user, kind) => psql(`delete from private.request_slots where user_id = ${sql(user.id)} and kind = ${sql(kind)};`);

let releases;

try {
  installFixture();
  const release = (code) => psql(`select id from public.releases where product_code = ${sql(code)};`);
  releases = { us: release("SNS-ZSFE-USA"), eu: release("SNSP-ZSFP-EUR"), ce: release("SNS-ZSFE-USA-CE"), warden: release("MK-1701") };
  // Six listed pieces on the Collector's Edition, so a page of copies holds more than 1,000 pieces.
  psql(`insert into public.release_components (release_id, kind, label) select ${sql(releases.ce)}, k::public.component_kind, l from (values ('insert','Poster'),('insert','Sticker sheet'),('map','World map'),('artwork','Art card'),('other','Pin badge'),('other','Soundtrack CD')) v(k, l);`);
  const starfall = psql(`select game_id from public.releases where id = ${sql(releases.us)};`);

  section("The page");
  const a = await person();
  const page = await a.browser.get(ACCOUNT);
  check("the account page offers a download, as a plain form post", visible(page.html).includes("Your data") && /<form[^>]*action="\/settings\/account\/export"[^>]*method="post"/.test(page.html));
  check("it says what's in it and what it isn't", visible(page.html).includes("isn't a complete answer to a legal request") && visible(page.html).includes("what you paid"));
  check("an error code shows its message", visible((await a.browser.get(`${ACCOUNT}?error=export_too_many`)).html).includes("three times in the last hour"));

  section("Setup: a collection and a submission");
  const twinA = await add(a, releases.us, { completeness: "complete", box_condition: "good", media_condition: "very_good", acquired_on: "2021-03-04", purchase_price: "49.5", currency: "EUR", notes: "A-NOTE first copy", storage_location: "Shelf A" });
  const twinB = await add(a, releases.us, { completeness: "loose", acquired_on: "2022-01-02", purchase_price: "12", currency: "USD", notes: "A-NOTE second copy" });
  const ce = await add(a, releases.ce, { completeness: "complete", box_condition: "good" });
  await rpc(a, "update_collection_item", { p_item: ce, p_changes: { components: [{ kind: "insert", label: "Poster", condition: "good" }, { kind: "map", label: "World map", condition: "not_included" }] } });
  // Many copies, added as the person (their session and RLS), to cross every page boundary.
  psql(`begin;
create temp table ex_ids on commit drop as select private.uuid_v7() as id, g from generate_series(1, ${BULK}) g;
grant select on ex_ids to authenticated;
select set_config('request.jwt.claims', ${sql(JSON.stringify({ sub: a.id, role: "authenticated" }))}, true);
set local role authenticated;
insert into public.collection_items (id, owner_id, release_id, completeness) select x.id, ${sql(a.id)}, case when x.g % 2 = 0 then ${sql(releases.ce)}::uuid else ${sql(releases.eu)}::uuid end, 'complete' from ex_ids x;
insert into public.collection_item_private (item_id, owner_id, notes) select c.id, c.owner_id, 'bulk note' from public.collection_items c where c.owner_id = ${sql(a.id)} and c.release_id = ${sql(releases.eu)};
insert into public.collection_item_components (item_id, owner_id, kind, label, condition)
  select c.id, c.owner_id, k.kind, k.label, 'good' from public.collection_items c join public.release_components k on k.release_id = c.release_id
  where c.owner_id = ${sql(a.id)} and c.release_id = ${sql(releases.ce)} and c.id <> ${sql(ce)};
commit;`);
  const submitted = await rpc(a, "submit_release", { p_game: starfall, p_platform: "game-boy", p_media_format: "game-boy-game-pak", p_region: "pal", p_details: { edition_name: "Export Edition" }, p_components: [], p_note: "A-SUBMISSION-NOTE", p_physical: true });
  check("setup: the person has a submission", Boolean(submitted?.submission_id), JSON.stringify(submitted?.outcome ?? submitted));

  const b = await person();
  const bCopy = await add(b, releases.us, { notes: "B-SECRET-NOTE", purchase_price: "999", currency: "GBP", storage_location: "B's vault" });
  await rpc(b, "submit_release", { p_game: starfall, p_platform: "game-boy", p_media_format: "game-boy-game-pak", p_region: "ntsc-uc", p_details: { edition_name: "B Edition" }, p_components: [], p_note: "B-SUBMISSION-NOTE", p_physical: true });

  section("A's export");
  const started = Date.now();
  const ex = await download(a);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const h = (name) => ex.response.headers.get(name) ?? "";
  check("it downloads", ex.response.status === 200 && Boolean(ex.data), `status ${ex.response.status} ${ex.to}`);
  check("as JSON, an attachment named for the handle and date", h("content-type") === "application/json; charset=utf-8" && h("content-disposition") === `attachment; filename="my-game-dex-${a.handle}-${new Date().toISOString().slice(0, 10)}.json"`, h("content-disposition"));
  check("never stored or indexed", /no-store/.test(h("cache-control")) && /private/.test(h("cache-control")) && /noindex/.test(h("x-robots-tag")) && h("x-content-type-options") === "nosniff" && h("referrer-policy") === "no-referrer");
  const d = ex.data ?? {};
  check("it names its format and ends complete", d.format === "my-game-dex-export" && d.version === 1 && d.complete === true && ex.text.trimEnd().endsWith('"complete":true}'));
  check("it says it isn't a complete legal answer, and what's left out", /not a complete answer to a legal request/.test(d.notice ?? "") && Array.isArray(d.not_included) && d.not_included.length >= 4);
  check("the account is the signed-in person", d.account?.id === a.id && d.account?.email === a.email);
  check("the profile and handle", d.profile?.handle === a.handle && d.profile?.collection_visibility === "private" && d.profile?.account_status === "active");
  check("the preferences, without the row's key", d.preferences?.locale === "en" && !("user_id" in (d.preferences ?? {})));

  const expected = psql(`select string_agg(id::text, ',' order by id) from public.collection_items where owner_id = ${sql(a.id)};`).split(",");
  const got = (d.collection ?? []).map((c) => c.id);
  check(`every copy, once each, across pages (${expected.length} copies, ${seconds}s)`, got.length === expected.length && new Set(got).size === got.length && JSON.stringify([...got].sort()) === JSON.stringify([...expected].sort()), `${got.length} of ${expected.length}`);
  const copies = new Map((d.collection ?? []).map((c) => [c.id, c]));
  check("two copies of one release are two entries", copies.get(twinA)?.release?.id === releases.us && copies.get(twinB)?.release?.id === releases.us);
  const first = copies.get(twinA);
  check("a copy's game, platform, region, format and identifiers", first?.game?.title === "Starfall Odyssey" && first?.release?.platform?.slug === "snes" && Boolean(first?.release?.region?.code) && Boolean(first?.release?.format?.code) && first?.release?.identifiers?.product_code === "SNS-ZSFE-USA");
  check("its completeness and condition", first?.completeness === "complete" && first?.conditions?.box === "good" && first?.conditions?.media === "very_good" && first?.status === "owned");
  check("its private purchase details", first?.private?.price?.currency === "EUR" && Number(first?.private?.price?.amount) === 49.5 && first?.private?.acquired_on === "2021-03-04" && first?.private?.notes === "A-NOTE first copy" && first?.private?.storage_location === "Shelf A");
  check("a copy without private details says none", copies.get(ce)?.private === null);
  const ceCopy = copies.get(ce);
  check("an edition's name and the pieces recorded, with their condition", ceCopy?.release?.edition_name === "Collector's Edition" && JSON.stringify(ceCopy?.components) === JSON.stringify([{ kind: "insert", label: "Poster", condition: "good" }, { kind: "map", label: "World map", condition: "not_included" }]));
  const pieceCount = Number(psql(`select count(*) from public.collection_item_components where owner_id = ${sql(a.id)};`));
  check(`every recorded piece (${pieceCount}, more than 1,000 in one page of copies)`, (d.collection ?? []).reduce((n, c) => n + (c.components?.length ?? 0), 0) === pieceCount && pieceCount > 1000);
  const privCount = Number(psql(`select count(*) from public.collection_item_private where owner_id = ${sql(a.id)};`));
  check("every copy's private details", (d.collection ?? []).filter((c) => c.private).length === privCount);
  const subs = d.submissions ?? [];
  check("the person's submission, with its note and status", subs.length === 1 && subs[0].id === submitted?.submission_id && subs[0].note === "A-SUBMISSION-NOTE" && typeof subs[0].status === "string" && subs[0].details?.edition_name === "Export Edition", JSON.stringify(subs.map((s) => s.status)));

  section("Nothing that isn't A's, and nothing secret");
  check("nothing of B's: copy, note, price, place or submission", !ex.text.includes(bCopy) && !ex.text.includes("B-SECRET-NOTE") && !ex.text.includes("B's vault") && !ex.text.includes("B-SUBMISSION-NOTE") && !ex.text.includes(b.id) && !ex.text.includes(b.handle));
  const session = readSession(a.browser)?.session ?? {};
  check("no token, key or password", !ex.text.includes(session.access_token ?? "@@") && !ex.text.includes(session.refresh_token ?? "@@") && !ex.text.includes(secret) && !ex.text.includes(publishable) && !ex.text.includes(a.password) && !/eyJ[\w-]+\.[\w-]+\./.test(ex.text));
  check("no audit or staff fields", !/"(actor_id|reviewed_by|submitted_by|verified_by|staff_reason|audit|session_id|encrypted_password)"/.test(ex.text));

  const bx = await download(b);
  check("B's own export holds B's data and none of A's", bx.data?.account?.id === b.id && bx.data?.collection?.length === 1 && bx.data.collection[0].private?.notes === "B-SECRET-NOTE" && !bx.text.includes("A-NOTE") && !bx.text.includes(twinA) && !bx.text.includes(a.id));
  const named = await download(b, {}, `${EXPORT}?user=${a.id}&user_id=${a.id}`);
  check("naming another account in the request changes nothing", named.data?.account?.id === b.id && !named.text.includes(a.id));

  section("Who may download, and how");
  const visitor = new Browser();
  const out = await fetch(`${origin}${EXPORT}`, { method: "POST", redirect: "manual", headers: { origin } });
  check("signed out: sent to sign in, no file", isRedirect(out.status ? out : out) && location(out).includes("/sign-in") && !(await out.text()).includes('"format"'));
  void visitor;
  check("a GET isn't an export", (await fetch(`${origin}${EXPORT}`, { redirect: "manual", headers: { cookie: a.browser.cookieHeader() } })).status === 405);
  clearSlots(a, "data_export");
  for (const [label, headers] of [
    ["from another site", { origin: "https://evil.example" }],
    ["without an Origin", { origin: "" }],
    ["marked cross-site by the browser", { "sec-fetch-site": "cross-site" }],
  ]) {
    const r = await download(a, headers);
    check(`a request ${label} is refused`, r.response.status === 403 && !r.text.includes('"format"'), `status ${r.response.status}`);
  }
  check("refused requests use none of the hourly allowance", Number(psql(`select count(*) from private.request_slots where user_id = ${sql(a.id)} and kind = 'data_export';`)) === 0);

  section("Three an hour");
  const c = await person();
  for (let i = 1; i <= 3; i += 1) check(`download ${i} of 3`, (await download(c)).data?.complete === true);
  const fourth = await download(c);
  check("the fourth is refused, saying why", fourth.response.status === 303 && errorOf(fourth.to) === "export_too_many" && !fourth.text.includes('"format"'), fourth.to);
  check("and shown on the page", visible((await c.browser.get(fourth.to)).html).includes("three times in the last hour"));

  section("An authenticator, and an ended session");
  const m = await person({ mfa: true });
  const aal1 = new Browser();
  await aal1.submit("/sign-in", formWith((await aal1.get("/sign-in")).html, "password"), { email: m.email, password: m.password });
  const unverified = await download({ ...m, browser: aal1 });
  check("with an authenticator not yet verified: sent to verify, no file", unverified.response.status === 303 && unverified.to.startsWith("/settings/security/verify?next=%2Fsettings%2Faccount"), unverified.to);
  check("the page asks to verify first", visible((await aal1.get(ACCOUNT)).html).includes("verify a code before downloading your data"));
  await verifyBrowser(aal1, m, ACCOUNT);
  check("after verifying, it downloads", (await download({ ...m, browser: aal1 })).data?.complete === true);

  const e = await person();
  const elsewhere = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: publishable, "Content-Type": "application/json" }, body: JSON.stringify({ email: e.email, password: e.password }) }).then((x) => x.json());
  await fetch(`${api}/auth/v1/logout?scope=global`, { method: "POST", headers: { apikey: publishable, Authorization: `Bearer ${elsewhere.access_token}` } });
  const ended = await download(e);
  check("after signing out everywhere, an old device's unexpired token gets no file", ended.response.status === 303 && ended.to.includes("/sign-in") && !ended.text.includes('"format"'), `${ended.response.status} ${ended.to}`);

  const s = await person();
  psql(`update public.profiles set account_status = 'suspended' where id = ${sql(s.id)};`);
  const suspended = await download(s);
  check("a suspended account can still download its data", suspended.data?.complete === true && suspended.data?.profile?.account_status === "suspended");
  psql(`update public.profiles set account_status = 'active' where id = ${sql(s.id)};`);

  section("Failures");
  clearSlots(a, "data_export");
  try {
    psql("revoke select on public.user_preferences from authenticated;");
    const early = await download(a);
    check("a failure before the download starts says so on the page", early.response.status === 303 && errorOf(early.to) === "export_failed", `${early.response.status} ${early.to}`);
  } finally {
    psql("grant select on public.user_preferences to authenticated;");
  }
  try {
    psql("revoke execute on function public.my_catalog_submissions(uuid, integer) from authenticated;");
    const late = await download(a);
    check("a failure part way ends the download unfinished: never complete", late.data?.complete !== true && !late.text.includes('"complete":true'), `status ${late.response.status} ${late.text.length} bytes`);
  } finally {
    psql("grant execute on function public.my_catalog_submissions(uuid, integer) to authenticated;");
  }
  check("both grants are back", psql("select has_table_privilege('authenticated', 'public.user_preferences', 'select') and has_function_privilege('authenticated', 'public.my_catalog_submissions(uuid, integer)', 'execute');") === "t");

  section("Photo uploads: ten an hour, and the body limit");
  const p = await person();
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "teal" } }).png().toBuffer();
  const form = formWith((await p.browser.get("/settings/profile")).html, "avatar");
  let lastOk = "";
  for (let i = 0; i < 10; i += 1) lastOk = location((await p.browser.submit("/settings/profile", form, { avatar: new File([png], "p.png", { type: "image/png" }) })).response);
  const path = psql(`select avatar_path from public.profiles where id = ${sql(p.id)};`);
  check("ten uploads in an hour work", lastOk.includes("notice=avatar_saved") && path.startsWith(`${p.id}/`), lastOk);
  const eleventh = location((await p.browser.submit("/settings/profile", form, { avatar: new File([png], "p.png", { type: "image/png" }) })).response);
  check("the eleventh is refused before it's read, and the photo stays", errorOf(eleventh) === "avatar_too_many" && psql(`select avatar_path from public.profiles where id = ${sql(p.id)};`) === path, eleventh);
  check("removing the photo isn't limited", location((await p.browser.submit("/settings/profile", { hidden: removeHidden((await p.browser.get("/settings/profile")).html) }, {})).response).includes("notice=avatar_removed"));

  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(1_500_000)]);
  const accountForm = formWith((await p.browser.get(ACCOUNT)).html, "current_password");
  const overAccount = await p.browser.submit(ACCOUNT, accountForm, { current_password: "x", password: "y", confirm: "y", padding: big.toString("base64").slice(0, 1_400_000) });
  check("any other page refuses a body over 1 MB before reading it", overAccount.response.status === 413, `status ${overAccount.response.status}`);
  clearSlots(p, "avatar_upload");
  const onProfile = await p.browser.submit("/settings/profile", formWith((await p.browser.get("/settings/profile")).html, "avatar"), { avatar: new File([big], "big.jpg", { type: "image/jpeg" }) });
  check("the profile page still takes a photo over 1 MB (it's read, and found not to be an image)", errorOf(location(onProfile.response)) === "avatar_invalid", `${onProfile.response.status} ${location(onProfile.response)}`);
  const exportBig = await fetch(`${origin}${EXPORT}`, { method: "POST", redirect: "manual", headers: { cookie: a.browser.cookieHeader(), origin }, body: big });
  check("the export refuses a large body too", exportBig.status === 413);
} catch (error) {
  check(`the checks ran to the end (${error.message})`, false);
} finally {
  stopApp();
  const ids = psql("select id from auth.users where email like 'appex-%';").split("\n").filter(Boolean);
  for (const id of ids) {
    const list = await fetch(`${api}/storage/v1/object/list/avatars`, { method: "POST", headers: { ...service, "Content-Type": "application/json" }, body: JSON.stringify({ prefix: `${id}/`, limit: 100 }) }).then((r) => r.json()).catch(() => []);
    if (list.length) await fetch(`${api}/storage/v1/object/avatars`, { method: "DELETE", headers: { ...service, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: list.map((o) => `${id}/${o.name}`) }) });
  }
  if (ids.length) {
    const list = ids.map(sql).join(",");
    psql(`begin;
delete from public.collection_items where owner_id in (${list});
create temp table ex_games on commit drop as select distinct game_id as id from public.catalog_change_requests where submitted_by in (${list}) and created_game and game_id is not null;
delete from public.releases where submitted_by in (${list}) or id in (select release_id from public.catalog_change_requests where submitted_by in (${list}));
delete from public.catalog_change_requests where submitted_by in (${list});
delete from public.game_platforms where submitted_by in (${list});
delete from public.games where id in (select id from ex_games) or submitted_by in (${list});
commit;`);
  }
  await deleteUsers();
  removeFixture();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ex\\_%';");
  check("no test account is left behind", psql("select count(*) from auth.users where email like 'appex-%';") === "0");
  check("no request counts are left behind", psql("select count(*) from private.request_slots s where not exists (select 1 from public.profiles p where p.id = s.user_id);") === "0");
  check("no test photo is left behind", ids.length === 0 || psql(`select count(*) from storage.objects where bucket_id = 'avatars' and (${ids.map((id) => `name like '${id}/%'`).join(" or ")});`) === "0");
}

/** The hidden fields of the "Remove photo" form. */
function removeHidden(html) {
  const match = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].find(([, inner]) => visible(inner).includes("Remove photo"));
  const hidden = {};
  for (const [input] of (match?.[1] ?? "").matchAll(/<input\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(input)?.[1];
    if (name && /type="hidden"/.test(input)) hidden[decode(name)] = decode(/\bvalue="([^"]*)"/.exec(input)?.[1] ?? "");
  }
  return hidden;
}
void randomUUID;

// Expected: the part-way failure this suite causes on purpose, and refused or ended sessions.
const expected = /export: a read failed part way|failed to pipe response|\[cause\]: Error: export failed|Invalid Refresh Token|__isAuthError: true|session_not_found|Invalid Server Actions request/;
check("the app logged the part-way failure, and nothing about it", /export: a read failed part way; the download was ended unfinished/.test(appLog()));
const errorLines = appErrorLines(expected);
check("the app logged no other errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
