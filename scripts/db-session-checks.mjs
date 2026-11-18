/**
 * M11a session revocation, through the real local Auth and REST API: after a session
 * ends (sign-out here or everywhere, a password change, a reset, a deletion), its access
 * token must stop reaching protected data at once, although it hasn't expired; public
 * reads stay as they are; staff and Owner checks are unchanged; and a statement already
 * running when a session ends is told apart from one that starts afterwards.
 *
 *   npm run test-stack:run -- db:session-checks
 *
 * Destructive (deletes sessions, assigns and removes a test Owner), so it refuses a
 * protected development stack and one that already has an Owner. Throwaway accounts on
 * example.test only. Nothing printed contains a token, key, password or address.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { decodeClaims, elevate } from "./lib/mfa-session.mjs";
import { dbContainer, stackStatus } from "./lib/stack.mjs";
import { makeTestOwner, removeTestOwner, requireNoOwner } from "./lib/test-owner.mjs";

const status = stackStatus({ label: "the session checks" });
const api = status.API_URL;
const publishable = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
const service = { apikey: secretKey, Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" };

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` (${detail})` : ""}`);
}
const section = (title) => console.log(`\n${title}`);
const psqlArgs = ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"];
const psql = (sql) => execFileSync("docker", psqlArgs, { input: sql, encoding: "utf8" }).trim();
const sql = (v) => `'${String(v).replace(/'/g, "''")}'`;
requireNoOwner(psql, api);

async function auth(method, path, { token, body, headers } = {}) {
  const r = await fetch(`${api}/auth/v1${path}`, { method, headers: headers ?? { apikey: publishable, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const h = (token) => ({ apikey: publishable, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
async function rpc(token, fn, args = {}) {
  const r = await fetch(`${api}/rest/v1/rpc/${fn}`, { method: "POST", headers: h(token), body: JSON.stringify(args) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function rest(token, path, init = {}) {
  const r = await fetch(`${api}/rest/v1/${path}`, { ...init, headers: { ...h(token), ...(init.headers ?? {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const tag = randomBytes(3).toString("hex");
const created = [];
const pw = () => `Pw-${randomBytes(12).toString("base64url")}`;
async function account(name) {
  const email = `dbss-${tag}-${name}@example.test`;
  const password = pw();
  const made = await auth("POST", "/admin/users", { headers: service, body: { email, password, email_confirm: true } });
  if (made.status !== 200) throw new Error(`setup: account (${made.status})`);
  created.push(made.body.id);
  const user = { id: made.body.id, email, password, handle: `ss_${randomBytes(5).toString("hex")}` };
  const s = await signIn(user);
  if ((await rpc(s.access_token, "claim_handle", { p_handle: user.handle })).status >= 300) throw new Error("setup: handle");
  return user;
}
async function signIn(user, password = user.password) {
  const r = await auth("POST", "/token?grant_type=password", { body: { email: user.email, password } });
  if (r.status !== 200) throw new Error(`setup: sign-in (${r.status})`);
  return r.body;
}
const logout = (token, scope) => auth("POST", `/logout?scope=${scope}`, { token });
function uuidv7() {
  const b = randomBytes(16);
  const at = Date.now();
  for (let i = 0; i < 6; i += 1) b[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

let fx;
/** A collector with copies, private details, pieces and a submission, as the app makes them. */
async function collector(name) {
  const user = await account(name);
  const s = await signIn(user);
  const add = async (release, details) => (await rpc(s.access_token, "add_collection_item", { p_item_id: uuidv7(), p_release: release, p_details: details })).body?.item_id;
  user.copy = await add(fx.ce, { notes: "private note", purchase_price: "10", currency: "EUR", storage_location: "Shelf" });
  await rpc(s.access_token, "update_collection_item", { p_item: user.copy, p_changes: { components: [{ kind: "insert", label: "Poster", condition: "good" }] } });
  user.spare = await add(fx.us, {});
  const sub = await rpc(s.access_token, "submit_release", { p_game: fx.game, p_platform: "game-boy", p_media_format: "game-boy-game-pak", p_region: "pal", p_details: { edition_name: `Session ${name}` }, p_components: [], p_note: "session note", p_physical: true });
  user.submission = sub.body?.submission_id;
  user.subRelease = sub.body?.release_id ?? psql(`select release_id from public.catalog_change_requests where id = ${sql(user.submission)};`);
  if (!user.copy || !user.spare || !user.submission) throw new Error(`setup: collection (${JSON.stringify(sub.body)})`);
  await logout(s.access_token, "local");
  return user;
}

/**
 * Which protected paths a token still reaches, and which public ones. Writes are made
 * only where harmless (a second spare copy is added and removed). Returns {name: boolean}.
 */
async function probe(token, user, other) {
  const out = {};
  const len = (r) => (Array.isArray(r.body) ? r.body.length : 0);
  out["read copies"] = len(await rest(token, "collection_items?select=id")) > 0;
  out["read purchase details"] = len(await rest(token, "collection_item_private?select=notes")) > 0;
  out["read pieces"] = len(await rest(token, "collection_item_components?select=label")) > 0;
  out["read preferences"] = len(await rest(token, "user_preferences?select=locale")) === 1;
  out["get_my_collection"] = ((await rpc(token, "get_my_collection")).body?.items?.length ?? 0) > 0;
  out["get_my_collection_item"] = Boolean((await rpc(token, "get_my_collection_item", { p_item: user.copy })).body?.id);
  out["get_my_release_copies"] = ((await rpc(token, "get_my_release_copies", { p_release: fx.ce })).body?.count ?? 0) > 0;
  out["get_my_account"] = len(await rpc(token, "get_my_account")) === 1;
  out["my_catalog_submissions"] = ((await rpc(token, "my_catalog_submissions")).body?.items?.length ?? 0) > 0;
  out["get_my_submission"] = Boolean((await rpc(token, "get_my_submission", { p_submission: user.submission })).body?.id);
  out["read own unpublished release"] = len(await rest(token, `releases?id=eq.${user.subRelease}&select=id`)) === 1;
  out["get_my_factor_status"] = (await rpc(token, "get_my_factor_status")).status === 200;
  out["get_my_notifications"] = (await rpc(token, "get_my_notifications", { p_limit: 5 })).status === 200;
  out["get_my_onboarding"] = (await rpc(token, "get_my_onboarding")).status === 200;
  const before = psql(`select coalesce(notes, '') from public.collection_item_private where item_id = ${sql(user.copy)};`);
  const edit = await rpc(token, "update_collection_item", { p_item: user.copy, p_changes: { notes: `edited ${randomBytes(3).toString("hex")}` } });
  out["update a copy"] = edit.status === 200 && psql(`select coalesce(notes, '') from public.collection_item_private where item_id = ${sql(user.copy)};`) !== before;
  const added = await rpc(token, "add_collection_item", { p_item_id: uuidv7(), p_release: fx.us, p_details: {} });
  out["add a copy"] = added.status === 200 && Boolean(added.body?.item_id);
  if (added.body?.item_id) psql(`delete from public.collection_items where id = ${sql(added.body.item_id)};`);
  const extra = psql(`insert into public.collection_items (id, owner_id, release_id) values (${sql(uuidv7())}, ${sql(user.id)}, ${sql(fx.us)}) returning id;`).split("\n")[0];
  await rpc(token, "remove_collection_item", { p_item: extra });
  out["remove a copy"] = psql(`select count(*) from public.collection_items where id = ${sql(extra)};`) === "0";
  psql(`delete from public.collection_items where id = ${sql(extra)};`);
  const del = await rest(token, `collection_items?id=eq.${user.spare}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  out["delete a copy through the table"] = len(del) === 1;
  if (len(del) === 1) user.spare = psql(`insert into public.collection_items (id, owner_id, release_id) values (${sql(uuidv7())}, ${sql(user.id)}, ${sql(fx.us)}) returning id;`).split("\n")[0];
  const bio = `bio ${randomBytes(3).toString("hex")}`;
  out["update the profile"] = len(await rest(token, `profiles?id=eq.${user.id}&select=id`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ bio }) })) === 1;
  out["update preferences"] = len(await rest(token, `user_preferences?user_id=eq.${user.id}&select=user_id`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ timezone: "Europe/Berlin" }) })) === 1;
  out["block someone"] = (await rpc(token, "block_user", { p_target: other.id })).status < 300;
  await rpc(token, "unblock_user", { p_target: other.id });
  out["take a request slot"] = (await rpc(token, "take_request_slot", { p_kind: "data_export" })).body?.allowed === true;
  psql(`delete from private.request_slots where user_id = ${sql(user.id)};`);
  out["withdraw a submission"] = null; // not probed: irreversible; refused by begin_submission (get_my_account), pgTAP covers the guard
  delete out["withdraw a submission"];
  // Public: what anyone may read, signed in or not.
  out["PUBLIC published release"] = len(await rest(token, `releases?id=eq.${fx.us}&select=id`)) === 1;
  out["PUBLIC profile card"] = len(await rest(token, `profiles?id=eq.${other.id}&select=handle`)) === 1;
  out["PUBLIC catalog search"] = ((await rpc(token, "search_catalog", { p_query: "starfall" })).body?.items?.length ?? 0) > 0;
  return out;
}
const protectedKeys = (p) => Object.keys(p).filter((k) => !k.startsWith("PUBLIC"));
const allProtected = (p) => protectedKeys(p).every((k) => p[k]);
const noneProtected = (p) => protectedKeys(p).every((k) => !p[k]);
const publicOk = (p) => Object.keys(p).filter((k) => k.startsWith("PUBLIC")).every((k) => p[k]);
const which = (p, want) => Object.entries(p).filter(([k, v]) => !k.startsWith("PUBLIC") && v !== want).map(([k]) => k).join(", ");

/** Runs SQL in its own psql session, in the background; resolves with its output. */
function background(input) {
  return new Promise((resolve) => {
    const child = spawn("docker", psqlArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    child.stdin.end(input);
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  installFixture();
  const rel = (code) => psql(`select id from public.releases where product_code = ${sql(code)};`);
  fx = { us: rel("SNS-ZSFE-USA"), ce: rel("SNS-ZSFE-USA-CE") };
  fx.game = psql(`select game_id from public.releases where id = ${sql(fx.us)};`);
  psql(`insert into public.release_components (release_id, kind, label) values (${sql(fx.ce)}, 'insert', 'Poster');`);

  const c = await collector("c");
  const other = await account("other");

  section("Two devices, one signed out here");
  const d1 = await signIn(c);
  const d2 = await signIn(c);
  let p = await probe(d1.access_token, c, other);
  check("a live session reaches every protected path", allProtected(p), which(p, true));
  check("and the public ones", publicOk(p));
  check("both devices' sessions exist", Number(psql(`select count(*) from auth.sessions where user_id = ${sql(c.id)};`)) >= 2);
  check("signing out on one device", (await logout(d2.access_token, "local")).status === 204);
  p = await probe(d2.access_token, c, other);
  check("that device's unexpired token reaches no protected path", noneProtected(p), which(p, false));
  check("but still reads what's public", publicOk(p), JSON.stringify(p));
  check("its token hasn't expired: this is the session check, not expiry", decodeClaims(d2.access_token).exp > Date.now() / 1000 + 60);
  p = await probe(d1.access_token, c, other);
  check("the other device keeps working", allProtected(p), which(p, true));

  section("Signing out on every device");
  const d3 = await signIn(c);
  check("signing out everywhere", (await logout(d3.access_token, "global")).status === 204);
  check("ends every session", psql(`select count(*) from auth.sessions where user_id = ${sql(c.id)};`) === "0");
  for (const [label, token] of [["the first device", d1.access_token], ["the device that signed out", d3.access_token]]) {
    p = await probe(token, c, other);
    check(`${label}: no protected path, at once`, noneProtected(p), which(p, false));
    check(`${label}: public reads unchanged`, publicOk(p));
  }

  section("A password change, and a reset");
  const e1 = await signIn(c);
  const e2 = await signIn(c);
  c.password = pw();
  check("a password change", (await auth("PUT", "/user", { token: e1.access_token, body: { password: c.password } })).status === 200);
  p = await probe(e2.access_token, c, other);
  check("the other device is refused everywhere protected", noneProtected(p), which(p, false));
  p = await probe(e1.access_token, c, other);
  check("the device that changed it keeps working", allProtected(p), which(p, true));
  const f1 = await signIn(c);
  const hash = (await auth("POST", "/admin/generate_link", { headers: service, body: { type: "recovery", email: c.email } })).body.hashed_token;
  const recovery = (await auth("POST", "/verify", { body: { type: "recovery", token_hash: hash } })).body;
  c.password = pw();
  check("a reset through a recovery link", (await auth("PUT", "/user", { token: recovery.access_token, body: { password: c.password } })).status === 200);
  for (const [label, token] of [["a device signed in before", f1.access_token], ["the earlier device", e1.access_token]]) {
    p = await probe(token, c, other);
    check(`${label} is refused everywhere protected`, noneProtected(p), which(p, false));
  }
  p = await probe(recovery.access_token, c, other);
  check("the recovery session itself keeps working", allProtected(p), which(p, true));
  await logout(recovery.access_token, "global");

  section("Accounts that aren't active, invited ones, deleted ones");
  const live = await signIn(c);
  psql(`update public.profiles set account_status = 'suspended' where id = ${sql(c.id)};`);
  p = await probe(live.access_token, c, other);
  check("suspended, live session: still reads its own data", p["read copies"] && p["read purchase details"] && p["get_my_account"]);
  check("and still removes its own copies (always allowed)", p["remove a copy"]);
  check("but writes nothing else (blocking, which only reduces access, stays allowed: M4-D7)", !p["update a copy"] && !p["add a copy"] && !p["update the profile"] && !p["update preferences"] && p["block someone"]);
  await logout(live.access_token, "global");
  p = await probe(live.access_token, c, other);
  check("suspended, ended session: nothing protected", noneProtected(p), which(p, false));
  psql(`update public.profiles set account_status = 'active' where id = ${sql(c.id)};`);

  const inviteEmail = `dbss-${tag}-invitee@example.test`;
  const link = (await auth("POST", "/admin/generate_link", { headers: service, body: { type: "invite", email: inviteEmail } })).body;
  created.push(link.id);
  const invitee = (await auth("POST", "/verify", { body: { type: "invite", token_hash: link.hashed_token } })).body;
  check("an invitee who hasn't finished reads their onboarding", (await rpc(invitee.access_token, "get_my_onboarding")).status === 200);
  await logout(invitee.access_token, "global");
  check("until the session ends", (await rpc(invitee.access_token, "get_my_onboarding")).status >= 400);
  check("and can't claim a handle with it", (await rpc(invitee.access_token, "claim_handle", { p_handle: `ss_${randomBytes(5).toString("hex")}` })).status >= 400);

  const gone = await account("gone");
  const goneSession = await signIn(gone);
  await auth("DELETE", `/admin/users/${gone.id}`, { headers: service });
  const goneAccount = await rpc(goneSession.access_token, "get_my_account");
  check("a deleted account's unexpired token reads nothing", Array.isArray(goneAccount.body) ? goneAccount.body.length === 0 : goneAccount.status >= 400);
  check("and writes nothing", (await rpc(goneSession.access_token, "take_request_slot", { p_kind: "data_export" })).status >= 400);

  section("Staff and the Owner");
  for (const [role, fn, args] of [["moderator", "search_accounts", { p_query: "ss_", p_limit: 5 }], ["catalog_editor", "search_catalog_records", { p_kind: "games", p_query: "starfall" }], ["admin", "get_staff_overview", {}]]) {
    const s = await account(role);
    psql(`insert into public.staff_roles (user_id, role) values (${sql(s.id)}, ${sql(role)});`);
    // Auth ends a user's other sessions when their first authenticator is verified, so
    // the aal1 session (a password sign-in, not yet verified) is made afterwards.
    const elevated = await elevate(api, publishable, await signIn(s));
    const aal1 = await signIn(s);
    check(`${role}: setup: one session at each level`, decodeClaims(aal1.access_token).aal === "aal1" && decodeClaims(elevated.access_token).aal === "aal2");
    check(`${role}: aal1 is refused staff work, as before`, (await rpc(aal1.access_token, fn, args)).status >= 400);
    check(`${role}: aal1 still reads its own data`, (await rest(aal1.access_token, "user_preferences?select=locale")).body?.length === 1);
    check(`${role}: aal2 does staff work`, (await rpc(elevated.access_token, fn, args)).status === 200);
    check(`${role}: and reads its staff role`, (await rest(elevated.access_token, "staff_roles?select=role")).body?.length === 1);
    await logout(aal1.access_token, "global");
    check(`${role}: after signing out everywhere, staff work is refused`, (await rpc(elevated.access_token, fn, args)).status >= 400);
    check(`${role}: and its staff role isn't readable`, (await rest(elevated.access_token, "staff_roles?select=role")).body?.length === 0);
  }
  const o = await account("owner");
  psql(`insert into public.staff_roles (user_id, role) values (${sql(o.id)}, 'admin');`);
  const ownerSession = await makeTestOwner(psql, { api, anonKey: publishable, session: await elevate(api, publishable, await signIn(o)), handle: o.handle, userId: o.id });
  check("the Owner reads ownership status", (await rpc(ownerSession.access_token, "get_ownership_status")).status === 200);
  check("the Owner can't be deleted (unchanged)", (await rpc(ownerSession.access_token, "get_my_account")).body?.length === 1 && psql(`select public.account_deletion_blocked(${sql(o.id)})::text;`) === "true");
  await logout(ownerSession.access_token, "global");
  check("after the Owner signs out everywhere, Owner functions refuse the old token", (await rpc(ownerSession.access_token, "get_ownership_status")).status >= 400);
  check("and the Owner record is untouched", psql(`select count(*) from private.platform_owner where user_id = ${sql(o.id)};`) === "1");
  removeTestOwner(psql);

  section("Concurrency: a statement running when the session ends, and one after");
  {
    const s = await signIn(c);
    const claims = JSON.stringify(decodeClaims(s.access_token));
    psql(`update public.user_preferences set timezone = null, locale = 'en' where user_id = ${sql(c.id)};`);
    const asUser = `select set_config('request.jwt.claims', ${sql(claims)}, true); set local role authenticated;`;
    // One statement that starts before the sign-out and finishes after it.
    const running = background(`begin; ${asUser}
with u as (update public.user_preferences set timezone = 'Europe/Paris' where user_id = ${sql(c.id)} and pg_sleep(3) is not null returning 1) select count(*) from u;
commit;`);
    // Two statements in one transaction: one before, one after.
    const split = background(`begin; ${asUser}
update public.user_preferences set locale = 'fr' where user_id = ${sql(c.id)};
select pg_sleep(3);
with u as (update public.user_preferences set default_currency = 'EUR' where user_id = ${sql(c.id)} returning 1) select count(*) from u;
commit;`);
    await pause(1200);
    const ended = await logout(s.access_token, "global");
    check("the sign-out completes while those statements run (Auth doesn't wait for them)", ended.status === 204 && psql(`select count(*) from auth.sessions where user_id = ${sql(c.id)};`) === "0");
    const [r1, r2] = await Promise.all([running, split]);
    const prefs = psql(`select coalesce(timezone, '-') || ' ' || locale || ' ' || coalesce(default_currency, '-') from public.user_preferences where user_id = ${sql(c.id)};`);
    check("a statement already running when the session ended completes", r1.code === 0 && prefs.startsWith("Europe/Paris"), `${r1.err} ${prefs}`);
    check("in the same transaction, the statement before commits and the one after changes nothing", r2.code === 0 && prefs === "Europe/Paris fr -", prefs);
    const after = await rest(s.access_token, `user_preferences?user_id=eq.${c.id}&select=user_id`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ timezone: "Asia/Tokyo" }) });
    check("a new request afterwards is refused", Array.isArray(after.body) && after.body.length === 0);
  }

  section("Request slots can't be used for anyone else");
  {
    const s = await signIn(other);
    const r = await rpc(s.access_token, "take_request_slot", { p_kind: "data_export", p_user: c.id });
    check("there's no way to name another account", r.status >= 400);
    for (let i = 0; i < 3; i += 1) await rpc(s.access_token, "take_request_slot", { p_kind: "data_export" });
    check("the caller's own count is what's limited", (await rpc(s.access_token, "take_request_slot", { p_kind: "data_export" })).body?.allowed === false && psql(`select count(*) from private.request_slots where user_id = ${sql(c.id)};`) === "0");
    check("and the counts can't be read or changed directly", (await rest(s.access_token, "request_slots?select=*")).status >= 400);
    await logout(s.access_token, "global");
  }
} catch (error) {
  check(`the checks ran to the end (${error.message})`, false);
} finally {
  try {
    removeTestOwner(psql);
  } catch {
    // Nothing to remove.
  }
  const ids = created.filter(Boolean).map(sql).join(",");
  if (ids) {
    psql(`begin;
delete from public.collection_items where owner_id in (${ids});
create temp table ss_games on commit drop as select distinct game_id as id from public.catalog_change_requests where submitted_by in (${ids}) and created_game and game_id is not null;
delete from public.releases where submitted_by in (${ids}) or id in (select release_id from public.catalog_change_requests where submitted_by in (${ids}));
delete from public.catalog_change_requests where submitted_by in (${ids});
delete from public.game_platforms where submitted_by in (${ids});
delete from public.games where id in (select id from ss_games) or submitted_by in (${ids});
commit;`);
    for (const id of created.filter(Boolean)) await auth("DELETE", `/admin/users/${id}`, { headers: service });
  }
  removeFixture();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ss\\_%';");
  check("no test account is left behind", psql(`select count(*) from auth.users where email like 'dbss-${tag}-%';`) === "0");
  check("no Owner is left behind", psql("select count(*) from private.platform_owner;") === "0");
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
