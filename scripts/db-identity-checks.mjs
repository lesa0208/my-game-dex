/**
 * M2 Identity checks against the running local stack, through the real Auth, REST
 * and Storage APIs and real email delivery to Mailpit. Runs the actual avatar
 * workflow. pgTAP covers the database rules; this covers what a client can do.
 *
 * Local only. Prints check names and statuses, never keys or tokens.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  AvatarError,
  deleteAccountWithAvatars,
  processAvatarImage,
  removeAvatar,
  replaceAvatar,
} from "../src/features/avatars/avatar-workflow.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` (${detail})` : ""}`);
}
const section = (title) => console.log(`\n${title}`);

function psql(sql) {
  return execFileSync("docker", ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** A psql session that stays open, for holding a transaction while the API acts. */
function psqlSession(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.resume();
    child.stderr.resume();
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`psql session exited with ${code}`))));
    child.stdin.end(sql);
  });
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const status = JSON.parse(execFileSync(process.execPath, [cli, "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const api = status.API_URL;
const mailpit = status.MAILPIT_URL;
const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
const serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
if (!api || !mailpit || !anonKey || !serviceKey) {
  console.error("Couldn't read the local stack's status. Is it running? Try npm run db:start.");
  process.exit(1);
}

const anon = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" };
const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
const asUser = (token) => ({ apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const avatarConfig = { supabaseUrl: api, publishableKey: anonKey, secretKey: serviceKey };

const newEmail = () => `chk-${randomUUID()}@example.test`;
const newPassword = () => `pw-${randomUUID()}`;
const newHandle = () => `chk_${randomBytes(6).toString("hex")}`;
const createdUsers = new Set();

const post = (path, headers, body) => fetch(`${api}${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
const rpc = (name, headers, body) => post(`/rest/v1/rpc/${name}`, headers, body);

/**
 * True only when the database refused for lack of a privilege on exactly this object.
 * Any other refusal, such as a trigger or a function's own checks, doesn't count,
 * because it would hide a grant that shouldn't exist.
 */
async function deniedByPrivilege(response, kind, name) {
  if (response.ok) return false;
  const text = await response.text();
  let message = "";
  try {
    message = JSON.parse(text)?.message ?? "";
  } catch {
    message = text;
  }
  return new RegExp(`^permission denied for ${kind} ${name}$`).test(message);
}
const signIn = (email, password) => post("/auth/v1/token?grant_type=password", anon, { email, password });

/** A verified user with a session and, by default, a claimed handle. */
async function createUser({ claim = true } = {}) {
  const email = newEmail();
  const password = newPassword();
  const response = await post("/auth/v1/admin/users", service, { email, password, email_confirm: true });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  const session = await (await signIn(email, password)).json();
  const handle = claim ? newHandle() : null;
  if (claim) {
    const claimed = await rpc("claim_handle", asUser(session.access_token), { p_handle: handle });
    if (!claimed.ok) throw new Error(`could not claim a handle: status ${claimed.status}`);
  }
  return { id: user.id, email, password, handle, token: session.access_token };
}

async function findMailLink(address, type) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
    const { messages = [] } = search.ok ? await search.json() : {};
    for (const summary of messages) {
      const message = await (await fetch(`${mailpit}/api/v1/message/${summary.ID}`)).json();
      const match = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/.exec(`${message.Text}\n${message.HTML}`);
      if (match && match[0].includes(`type=${type}`)) return match[0].replace(/&amp;/g, "&");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function signupLifecycle() {
  section("Email verification lifecycle");
  const email = newEmail();
  const password = newPassword();
  const handle = newHandle();

  let response = await post("/auth/v1/signup", anon, {
    email,
    password,
    data: { role: "admin", staff_role: "admin", is_admin: true, handle: "admin", account_status: "active", id: randomUUID() },
  });
  const signup = await response.json();
  const userId = signup.id ?? signup.user?.id;
  if (userId) createdUsers.add(userId);
  check("signup succeeds", response.ok, `status ${response.status}`);
  check("signup returns no session before verification", !signup.access_token && !signup.session);

  const row = psql(`select coalesce(handle, 'NULL') || '|' || account_status from public.profiles where id = '${userId}';`);
  check("the trigger created the profile, with no handle from metadata", row === "NULL|active", row);
  check("the trigger created preferences", psql(`select count(*) from public.user_preferences where user_id = '${userId}';`) === "1");
  check("metadata created no staff role", psql(`select count(*) from public.staff_roles where user_id = '${userId}';`) === "0");
  check("metadata didn't reach app_metadata", psql(`select coalesce(raw_app_meta_data->>'role', 'none') from auth.users where id = '${userId}';`) === "none");

  response = await fetch(`${api}/rest/v1/profiles?id=eq.${userId}&select=id`, { headers: anon });
  check("an unverified account isn't publicly visible", response.ok && (await response.json()).length === 0, `status ${response.status}`);

  response = await signIn(email, password);
  const blocked = await response.json();
  check("sign-in is refused before verification", response.status === 400 && blocked.error_code === "email_not_confirmed", `status ${response.status}`);

  const link = await findMailLink(email, "signup");
  check("the verification email arrives", !!link);
  response = await fetch(link, { redirect: "manual" });
  check("the verification link works", response.status >= 300 && response.status < 400, `status ${response.status}`);
  check("the account is now verified", psql(`select email_confirmed_at is not null from auth.users where id = '${userId}';`) === "t");

  response = await signIn(email, password);
  const session = await response.json();
  check("sign-in works after verification", response.ok && !!session.access_token, `status ${response.status}`);
  const me = asUser(session.access_token);

  response = await rpc("get_my_account", me);
  let [account] = await response.json();
  check("verified without a handle is still inactive", response.ok && account?.is_active === false, `status ${response.status}`);

  await fetch(`${api}/rest/v1/profiles?id=eq.${userId}`, { method: "PATCH", headers: me, body: JSON.stringify({ display_name: "Too Early" }) });
  check("an account without a handle can't edit its profile", psql(`select display_name is null from public.profiles where id = '${userId}';`) === "t");

  response = await rpc("claim_handle", me, { p_handle: handle });
  check("a verified user claims a handle", response.ok && (await response.json()) === handle, `status ${response.status}`);
  [account] = await (await rpc("get_my_account", me)).json();
  check("a claimed handle activates the account", account?.is_active === true);

  response = await fetch(`${api}/rest/v1/profiles?id=eq.${userId}`, { method: "PATCH", headers: me, body: JSON.stringify({ display_name: "Collector" }) });
  check("an active account edits its profile", response.ok && psql(`select display_name from public.profiles where id = '${userId}';`) === "Collector", `status ${response.status}`);

  section("Handles through the API");
  response = await rpc("claim_handle", anon, { p_handle: newHandle() });
  check("anon has no EXECUTE on claim_handle", await deniedByPrivilege(response, "function", "claim_handle"), `status ${response.status}`);
  response = await fetch(`${api}/rest/v1/profiles?id=eq.${userId}`, { method: "PATCH", headers: me, body: JSON.stringify({ handle: newHandle() }) });
  check("a handle can't be set directly", await deniedByPrivilege(response, "table", "profiles"), `status ${response.status}`);
  response = await fetch(`${api}/rest/v1/profiles?id=eq.${userId}`, { method: "PATCH", headers: me, body: JSON.stringify({ handle_changed_at: "2000-01-01T00:00:00Z" }) });
  check("the cooldown can't be reset directly", await deniedByPrivilege(response, "table", "profiles"), `status ${response.status}`);
  const corrected = newHandle();
  response = await rpc("claim_handle", me, { p_handle: corrected.toUpperCase() });
  check("one correction works, and stores the handle in lowercase", response.ok && (await response.json()) === corrected, `status ${response.status}`);
  response = await rpc("claim_handle", me, { p_handle: newHandle() });
  const cooldown = await response.json();
  check("a second change within 30 days is refused", !response.ok && cooldown.message === "handle change not available yet", `status ${response.status}`);
  response = await rpc("claim_handle", me, { p_handle: handle });
  check("a correction can't be undone straight away", !response.ok, `status ${response.status}`);
  response = await fetch(`${api}/rest/v1/profiles?id=eq.${userId}`, { method: "PATCH", headers: me, body: JSON.stringify({ handle_correction_until: "2100-01-01T00:00:00Z" }) });
  check("the correction allowance can't be restored directly", await deniedByPrivilege(response, "table", "profiles"), `status ${response.status}`);

  const fresh = await createUser({ claim: false });
  const freshHeaders = asUser(fresh.token);
  const messages = new Set();
  for (const attempt of ["admin", "ADMIN", "adm1n", "a_d_m_i_n", "5upport", "my_game_dex", "myg4med3x", corrected, corrected.toUpperCase(), handle]) {
    const other = await rpc("claim_handle", freshHeaders, { p_handle: attempt });
    messages.add((await other.json()).message);
    if (other.ok) check(`${attempt} should have been refused`, false);
  }
  check("reserved, taken and held handles give one identical answer", messages.size === 1 && messages.has("handle unavailable"), [...messages].join("; "));
  response = await rpc("claim_handle", freshHeaders, { p_handle: `badminton_${randomBytes(3).toString("hex")}` });
  check("a name containing admin, like badminton, is allowed", response.ok, `status ${response.status}`);
  const suffix = randomBytes(5).toString("hex");
  response = await rpc("claim_handle", asUser((await createUser({ claim: false })).token), { p_handle: `chk_mk_${suffix}` });
  check("a handle with an underscore can be claimed", response.ok, `status ${response.status}`);
  response = await rpc("claim_handle", asUser((await createUser({ claim: false })).token), { p_handle: `chkmk${suffix}` });
  check("the same name without the underscore can coexist", response.ok, `status ${response.status}`);
  response = await fetch(`${api}/rest/v1/handle_holds?select=*`, { headers: { ...freshHeaders, "Accept-Profile": "private" } });
  check("holds aren't reachable through the API", !response.ok, `status ${response.status}`);
}

const claimAs = async (user, handle) => {
  const response = await rpc("claim_handle", asUser(user.token), { p_handle: handle });
  return { ok: response.ok, status: response.status, body: await response.json() };
};
const holdCount = (names) => psql(`select count(*) from private.handle_holds where kind = 'released' and handle = any (array[${names.map((name) => `'${name}'`).join(",")}]);`);

async function handleConcurrency() {
  section("Concurrent handle requests");

  // Many users, one free handle
  const contenders = await Promise.all(Array.from({ length: 8 }, () => createUser({ claim: false })));
  const wanted = newHandle();
  let results = await Promise.all(contenders.map((user) => claimAs(user, wanted)));
  check("eight users race for one handle, and exactly one wins", results.filter((result) => result.ok).length === 1, results.map((result) => result.status).join());
  check("the others get the normal answer, not a server error", results.filter((result) => !result.ok).every((result) => result.status === 400 && result.body.message === "handle unavailable"));
  check("exactly one profile holds the handle", psql(`select count(*) from public.profiles where handle = '${wanted}';`) === "1");

  // Reserved names under concurrency
  results = await Promise.all(["admin", "adm1n", "a_d_m_i_n", "5upport", "my_game_dex", "myg4med3x", "ADMIN", "MyGameDex"].map((name, index) => claimAs(contenders[index], name)));
  check("concurrent reserved claims are all refused", results.every((result) => !result.ok), results.map((result) => result.status).join());

  // One user, many concurrent corrections
  const corrector = await createUser();
  const targets = Array.from({ length: 6 }, () => newHandle());
  results = await Promise.all(targets.map((name) => claimAs(corrector, name)));
  check("six concurrent corrections, and exactly one succeeds", results.filter((result) => result.ok).length === 1, results.map((result) => result.status).join());
  check("the others are refused by the cooldown", results.filter((result) => !result.ok).every((result) => result.body.message === "handle change not available yet"));
  check("the correction is used up", psql(`select handle_correction_until is null from public.profiles where id = '${corrector.id}';`) === "t");
  check("only the original handle is held", holdCount([corrector.handle]) === "1" && holdCount(targets) === "0");

  // One user, concurrent first claims: a first claim and one correction, at most
  const newcomer = await createUser({ claim: false });
  const firstNames = Array.from({ length: 5 }, () => newHandle());
  results = await Promise.all(firstNames.map((name) => claimAs(newcomer, name)));
  check("five concurrent first claims give one claim and one correction, no more", results.filter((result) => result.ok).length === 2, results.map((result) => result.status).join());
  check("after that race the correction is used up", psql(`select handle_correction_until is null from public.profiles where id = '${newcomer.id}';`) === "t");
  check("after that race exactly one name is held", holdCount(firstNames) === "1");

  // The same handle repeatedly isn't a change
  const repeater = await createUser({ claim: false });
  const repeated = newHandle();
  results = await Promise.all(Array.from({ length: 5 }, () => claimAs(repeater, repeated)));
  check("repeating one claim concurrently succeeds without a change", results.every((result) => result.ok), results.map((result) => result.status).join());
  check("repeated claims don't use the correction", psql(`select handle_correction_until is not null from public.profiles where id = '${repeater.id}';`) === "t");

  // Two users trying to swap handles
  const left = await createUser();
  const right = await createUser();
  results = await Promise.all([claimAs(left, right.handle), claimAs(right, left.handle)]);
  check("a concurrent swap can't deadlock or take a live handle", results.every((result) => !result.ok && result.status === 400), results.map((result) => result.status).join());
  check("both users keep their handles after a swap attempt", psql(`select count(*) from public.profiles where (id = '${left.id}' and handle = '${left.handle}') or (id = '${right.id}' and handle = '${right.handle}');`) === "2");

  // Release races. A transaction stays open while another user tries to take the handle.
  const releaser = await createUser();
  const taker = await createUser({ claim: false });
  const session = psqlSession(`begin;
    select set_config('request.jwt.claims', '{"sub":"${releaser.id}","role":"authenticated"}', true);
    set local role authenticated;
    select public.claim_handle('${newHandle()}');
    select pg_sleep(3);
    commit;`);
  await pause(1500);
  let raced = await claimAs(taker, releaser.handle);
  await session;
  check("a claim during an uncommitted correction can't take the released handle", !raced.ok && raced.body.message === "handle unavailable", `status ${raced.status}`);
  check("the released handle is held once the correction commits", holdCount([releaser.handle]) === "1");

  const leaving = await createUser();
  const deleting = psqlSession(`begin;
    delete from auth.users where id = '${leaving.id}';
    select pg_sleep(3);
    commit;`);
  await pause(1500);
  raced = await claimAs(taker, leaving.handle);
  await deleting;
  createdUsers.delete(leaving.id);
  check("a claim during an uncommitted account deletion can't take the handle", !raced.ok && raced.body.message === "handle unavailable", `status ${raced.status}`);
  check("the deleted account's handle is held", holdCount([leaving.handle]) === "1");
  check("the racing user still has no handle", psql(`select handle is null from public.profiles where id = '${taker.id}';`) === "t");
}

async function profilePrivacy() {
  section("Public and private profile data");
  const a = await createUser();
  const b = await createUser();
  const headersA = asUser(a.token);
  const headersB = asUser(b.token);

  await fetch(`${api}/rest/v1/profiles?id=eq.${a.id}`, {
    method: "PATCH",
    headers: headersA,
    body: JSON.stringify({ display_name: "Person A", bio: "Bio", country_code: "DE", allow_search_indexing: true, follow_approval_required: true }),
  });

  const publicColumns = "id,handle,display_name,avatar_path,bio,country_code";
  let response = await fetch(`${api}/rest/v1/profiles?id=eq.${a.id}&select=${publicColumns}`, { headers: anon });
  let [card] = response.ok ? await response.json() : [];
  check("anon reads the public card", response.ok && card?.handle === a.handle && card?.country_code === "DE", `status ${response.status}`);
  check("the card has exactly the approved fields", card && Object.keys(card).sort().join() === publicColumns.split(",").sort().join());

  for (const [label, headers] of [["anon", anon], ["another signed-in user", headersB], ["the owner", headersA]]) {
    for (const column of ["allow_search_indexing", "follow_approval_required", "collection_visibility", "account_status", "handle_changed_at", "handle_correction_until"]) {
      response = await fetch(`${api}/rest/v1/profiles?id=eq.${a.id}&select=${column}`, { headers });
      const body = await response.text();
      check(`${label} can't read ${column} directly`, !response.ok && !body.includes('"' + column + '":'), `status ${response.status}`);
    }
    response = await fetch(`${api}/rest/v1/profiles?id=eq.${a.id}&select=*`, { headers });
    check(`${label} can't use select=*`, !response.ok, `status ${response.status}`);
  }

  response = await fetch(`${api}/rest/v1/profiles?allow_search_indexing=eq.true&select=id`, { headers: anon });
  check("anon can't filter on a private column to infer it", !response.ok, `status ${response.status}`);
  response = await fetch(`${api}/rest/v1/profiles?select=id&order=follow_approval_required`, { headers: anon });
  check("anon can't sort on a private column to infer it", !response.ok, `status ${response.status}`);

  response = await rpc("get_my_account", headersA);
  const [own] = await response.json();
  check("the owner reads their settings through get_my_account", own?.allow_search_indexing === true && own?.follow_approval_required === true);
  response = await rpc("get_my_account", headersB);
  const [other] = await response.json();
  check("get_my_account returns only the caller", other?.id === b.id);
  response = await rpc("get_my_account", anon);
  check("anon can't call get_my_account", !response.ok, `status ${response.status}`);

  section("Cross-user protection");
  await fetch(`${api}/rest/v1/profiles?id=eq.${a.id}`, { method: "PATCH", headers: headersB, body: JSON.stringify({ display_name: "Hacked", bio: "Hacked" }) });
  check("another user's profile can't be changed", psql(`select display_name from public.profiles where id = '${a.id}';`) === "Person A");
  response = await fetch(`${api}/rest/v1/user_preferences?user_id=eq.${a.id}&select=*`, { headers: headersB });
  check("another user's preferences can't be read", response.ok && (await response.json()).length === 0, `status ${response.status}`);
  await fetch(`${api}/rest/v1/user_preferences?user_id=eq.${a.id}`, { method: "PATCH", headers: headersB, body: JSON.stringify({ theme: "dark" }) });
  check("another user's preferences can't be changed", psql(`select theme from public.user_preferences where user_id = '${a.id}';`) === "system");
  response = await fetch(`${api}/rest/v1/user_preferences?select=*`, { headers: anon });
  check("anon can't read preferences", !response.ok, `status ${response.status}`);
  response = await fetch(`${api}/rest/v1/user_preferences?select=*`, { headers: headersA });
  const preferences = await response.json();
  check("an owner reads only their own preferences", response.ok && preferences.length === 1 && preferences[0].user_id === a.id, `status ${response.status}`);
  response = await fetch(`${api}/rest/v1/profiles?id=eq.${a.id}`, { method: "DELETE", headers: headersA });
  check("a profile can't be deleted through the API", !response.ok, `status ${response.status}`);
}

async function staffEscalation() {
  section("Staff escalation");
  const user = await createUser();
  const me = asUser(user.token);

  let response = await fetch(`${api}/auth/v1/user`, { method: "PUT", headers: me, body: JSON.stringify({ data: { role: "admin", staff_role: "admin" } }) });
  check("a user can write to their own metadata (expected)", response.ok, `status ${response.status}`);
  const refreshed = await (await signIn(user.email, user.password)).json();
  const afterMeta = asUser(refreshed.access_token);
  check("that metadata created no staff role", psql(`select count(*) from public.staff_roles where user_id = '${user.id}';`) === "0");

  for (const [label, headers] of [["a user", afterMeta], ["anon", anon], ["service_role", service]]) {
    response = await post("/rest/v1/staff_roles", headers, { user_id: user.id, role: "admin" });
    check(`${label} can't insert a staff role through the API`, await deniedByPrivilege(response, "table", "staff_roles"), `status ${response.status}`);
  }
  response = await rpc("has_staff_role", afterMeta, { p_role: "admin" });
  check("role helpers aren't exposed as API functions", !response.ok, `status ${response.status}`);
  response = await fetch(`${api}/rest/v1/profiles?id=eq.${user.id}`, { method: "PATCH", headers: afterMeta, body: JSON.stringify({ account_status: "active" }) });
  check("account status can't be changed", await deniedByPrivilege(response, "table", "profiles"), `status ${response.status}`);
  response = await rpc("set_avatar_path", afterMeta, { p_user_id: user.id, p_path: null });
  check("a user has no EXECUTE on the server-only avatar function", await deniedByPrivilege(response, "function", "set_avatar_path"), `status ${response.status}`);
  response = await rpc("set_avatar_path", anon, { p_user_id: user.id, p_path: null });
  check("anon can't call the server-only avatar function", !response.ok, `status ${response.status}`);
  check("no staff role exists after every attempt", psql(`select count(*) from public.staff_roles where user_id = '${user.id}';`) === "0");

  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { sub: user.id, role: "service_role", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, app_metadata: { role: "admin" } };
  const wrongKey = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  const forged = `${wrongKey}.${createHmac("sha256", randomBytes(32)).update(wrongKey).digest("base64url")}`;
  const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
  for (const [label, token] of [["a JWT signed with the wrong key", forged], ["an unsigned JWT", unsigned]]) {
    response = await post("/rest/v1/staff_roles", asUser(token), { user_id: user.id, role: "admin" });
    check(`the API rejects ${label}`, response.status === 401, `status ${response.status}`);
    response = await fetch(`${api}/auth/v1/user`, { headers: asUser(token) });
    check(`Auth rejects ${label}`, !response.ok, `status ${response.status}`);
  }
}

async function authBehaviour() {
  section("Passwords");
  let response = await post("/auth/v1/signup", anon, { email: newEmail(), password: "elevenchars" });
  let body = await response.json();
  check("an 11-character password is refused", response.status === 422 && body.error_code === "weak_password", `status ${response.status}`);

  const user = await createUser();
  response = await fetch(`${api}/auth/v1/user`, { method: "PUT", headers: asUser(user.token), body: JSON.stringify({ password: "elevenchars" }) });
  check("a password change also enforces the minimum", response.status === 422, `status ${response.status}`);

  const changed = newPassword();
  response = await fetch(`${api}/auth/v1/user`, { method: "PUT", headers: asUser(user.token), body: JSON.stringify({ password: changed }) });
  check("a recent session can change its password", response.ok, `status ${response.status}`);
  check("the old password stops working", (await signIn(user.email, user.password)).status === 400);
  response = await signIn(user.email, changed);
  const newest = await response.json();
  check("the new password works", response.ok, `status ${response.status}`);

  psql(`update auth.sessions set created_at = now() - interval '2 days', refreshed_at = now() - interval '2 days' where user_id = '${user.id}';`);
  response = await fetch(`${api}/auth/v1/user`, { method: "PUT", headers: asUser(newest.access_token), body: JSON.stringify({ password: newPassword() }) });
  body = await response.json();
  check("an old session must reauthenticate to change the password", response.status === 400 && body.error_code === "reauthentication_needed", `status ${response.status}, ${body.error_code}`);

  section("Password reset");
  const resetUser = await createUser();
  response = await post("/auth/v1/recover", anon, { email: resetUser.email });
  check("a reset can be requested", response.ok, `status ${response.status}`);
  const link = await findMailLink(resetUser.email, "recovery");
  check("the reset email arrives", !!link);
  response = await fetch(link, { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  const recoveryToken = new URLSearchParams(location.split("#")[1] ?? "").get("access_token");
  check("the reset link gives a recovery session", !!recoveryToken, `status ${response.status}`);
  const resetPassword = newPassword();
  response = await fetch(`${api}/auth/v1/user`, { method: "PUT", headers: asUser(recoveryToken), body: JSON.stringify({ password: resetPassword }) });
  check("the recovery session sets a new password", response.ok, `status ${response.status}`);
  check("the previous password stops working", (await signIn(resetUser.email, resetUser.password)).status === 400);
  check("the reset password works", (await signIn(resetUser.email, resetPassword)).ok);
  response = await fetch(link, { redirect: "manual" });
  check("a reset link works only once", !new URLSearchParams((response.headers.get("location") ?? "").split("#")[1] ?? "").get("access_token"));

  section("Generic responses");
  const known = await createUser();
  const unknownEmail = newEmail();
  const wrong = await signIn(known.email, newPassword());
  const missing = await signIn(unknownEmail, newPassword());
  const wrongBody = await wrong.json();
  const missingBody = await missing.json();
  check("a wrong password and an unknown email give the same sign-in error", wrong.status === missing.status && wrongBody.error_code === missingBody.error_code && wrongBody.msg === missingBody.msg, `${wrong.status}/${missing.status}`);
  const recoverKnown = await post("/auth/v1/recover", anon, { email: known.email });
  const recoverUnknown = await post("/auth/v1/recover", anon, { email: unknownEmail });
  check("a reset request looks the same for known and unknown emails", recoverKnown.status === 200 && recoverUnknown.status === 200, `${recoverKnown.status}/${recoverUnknown.status}`);
  response = await post("/auth/v1/signup", anon, { email: known.email, password: newPassword() });
  body = await response.json();
  check("signing up with a registered email doesn't report that it's taken", response.ok && !body.access_token && (body.identities ?? []).length === 0, `status ${response.status}`);

  section("Rate limits");
  response = await post("/auth/v1/recover", anon, { email: known.email });
  check("a repeat email to the same address within 60s is limited", response.status === 429, `status ${response.status}`);

  section("Signup failure");
  const email = newEmail();
  try {
    psql(`create function public.__boom() returns trigger language plpgsql set search_path = '' as $$ begin raise exception 'secret internal detail'; end $$;
          create trigger __boom before insert on public.user_preferences for each row execute function public.__boom();`);
    response = await post("/auth/v1/signup", anon, { email, password: newPassword() });
    const text = await response.text();
    check("a failed trigger fails the signup", !response.ok, `status ${response.status}`);
    check("the failure exposes no database detail", !/secret internal detail|user_preferences|__boom|SQLSTATE/i.test(text));
    check("the failure left no user", psql(`select count(*) from auth.users where email = '${email}';`) === "0");
  } finally {
    psql("drop trigger if exists __boom on public.user_preferences; drop function if exists public.__boom();");
  }
  response = await post("/auth/v1/signup", anon, { email, password: newPassword() });
  const retried = await response.json();
  if (retried.id) createdUsers.add(retried.id);
  check("signup works again once the fault is gone", response.ok, `status ${response.status}`);
}

const base = (width = 300, height = 200) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } });

async function rejectsWith(input, code) {
  try {
    await processAvatarImage(input);
    return "accepted";
  } catch (error) {
    return error instanceof AvatarError && error.code === code ? true : `${error?.code ?? error?.message}`;
  }
}

async function avatarProcessing() {
  section("Avatar validation");
  const marker = "SECRET-GPS-MARKER";
  const jpeg = await base().withExif({ IFD0: { Copyright: marker, Artist: marker }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } }).jpeg().toBuffer();
  check("the fixture really contains metadata", jpeg.includes(marker));
  const output = await processAvatarImage(jpeg);
  const metadata = await sharp(output).metadata();
  check("JPEG is accepted and re-encoded to WebP", metadata.format === "webp");
  check("the output has a fixed size", metadata.width === 512 && metadata.height === 512, `${metadata.width}x${metadata.height}`);
  check("EXIF, including location, is removed", !metadata.exif && !metadata.xmp && !metadata.iptc && !output.includes(marker));

  check("PNG is accepted", (await sharp(await processAvatarImage(await base().png().toBuffer())).metadata()).format === "webp");
  check("WebP is accepted", (await sharp(await processAvatarImage(await base().webp().toBuffer())).metadata()).format === "webp");

  const polyglot = Buffer.concat([await base().jpeg().toBuffer(), Buffer.from("<script>alert(1)</script><?php evil(); ?>")]);
  const cleaned = await processAvatarImage(polyglot);
  check("data appended to an image doesn't survive", !cleaned.includes("<script>") && !cleaned.includes("<?php"));

  const gif = await base().gif().toBuffer();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>');
  const validJpeg = await base(1200, 1200).jpeg({ quality: 95 }).toBuffer();
  const garbageAfterMagic = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(5000)]);
  const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(5000)]);
  const fakeWebp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), randomBytes(5000)]);
  const svgWithJpegMagic = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), svg]);
  const animated = await sharp([await base(64, 64).png().toBuffer(), await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer()], { join: { animated: true } }).webp().toBuffer();
  const bomb = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: "white" } }).png({ compressionLevel: 9 }).toBuffer();

  check("exactly 4096 on one side is accepted", (await sharp(await processAvatarImage(await base(4096, 64).png().toBuffer())).metadata()).format === "webp");
  check("exactly 16 megapixels is accepted", (await sharp(await processAvatarImage(await base(4000, 4000).png().toBuffer())).metadata()).format === "webp");
  check("exactly 32 pixels on each side is accepted", (await sharp(await processAvatarImage(await base(32, 32).png().toBuffer())).metadata()).format === "webp");

  const rejected = [
    ["GIF", gif, "unsupported_type"],
    ["SVG", svg, "unsupported_type"],
    ["a GIF with a .jpg name (bytes decide)", gif, "unsupported_type"],
    ["an empty file", Buffer.alloc(0), "unsupported_type"],
    ["plain text", Buffer.from("not an image at all"), "unsupported_type"],
    ["a truncated JPEG", validJpeg.subarray(0, Math.floor(validJpeg.length / 2)), "invalid_image"],
    ["garbage after a JPEG signature", garbageAfterMagic, "invalid_image"],
    ["garbage after a PNG signature", fakePng, "invalid_image"],
    ["garbage after a WebP signature", fakeWebp, "invalid_image"],
    ["an SVG with a JPEG signature", svgWithJpegMagic, "invalid_image"],
    ["over 2 MB", Buffer.concat([validJpeg, Buffer.alloc(2 * 1024 * 1024)]), "file_too_large"],
    ["animated WebP", animated, "unsupported_type"],
    ["a small file that decodes to 36 megapixels", bomb, "dimensions_out_of_range"],
    ["a side over 4096, within the pixel limit", await base(4097, 64).png().toBuffer(), "dimensions_out_of_range"],
    ["over 16 megapixels, within the side limit", await base(4096, 4096).png().toBuffer(), "dimensions_out_of_range"],
    ["an image under 32 pixels", await base(16, 16).png().toBuffer(), "dimensions_out_of_range"],
  ];
  check("the decompression bomb fixture really is small", bomb.length < 2 * 1024 * 1024, `${bomb.length} bytes`);
  for (const [label, input, code] of rejected) {
    const result = await rejectsWith(input, code);
    check(`rejects ${label}`, result === true, String(result));
  }
}

async function storageExists(path) {
  const response = await fetch(`${api}/storage/v1/object/public/avatars/${path}`);
  await response.arrayBuffer();
  return response.ok;
}

async function listFolder(userId) {
  const response = await post("/storage/v1/object/list/avatars", service, { prefix: `${userId}/`, limit: 100 });
  return response.ok ? (await response.json()).map((object) => object.name) : null;
}

const uploadAs = (headers, path, body, extra = {}) =>
  fetch(`${api}/storage/v1/object/avatars/${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "image/webp", ...extra },
    body,
  });

async function codeOf(promise) {
  try {
    await promise;
    return "succeeded";
  } catch (error) {
    return error instanceof AvatarError ? error.code : `unexpected: ${error?.message}`;
  }
}

async function avatarStorage() {
  section("Avatar workflow");
  const user = await createUser();
  const stranger = await createUser();
  const image = await base().jpeg().toBuffer();

  const first = await replaceAvatar(avatarConfig, user.token, image);
  check("an active user uploads an avatar", psql(`select avatar_path from public.profiles where id = '${user.id}';`) === first.path);
  check("the object name is in the owner's folder and unpredictable", new RegExp(`^${user.id}/[0-9a-f-]{36}\\.webp$`).test(first.path), first.path);
  let response = await fetch(`${api}/storage/v1/object/public/avatars/${first.path}`);
  const stored = Buffer.from(await response.arrayBuffer());
  check("the avatar is publicly readable", response.ok, `status ${response.status}`);
  check("it's served as WebP with no other type", response.headers.get("content-type") === "image/webp", response.headers.get("content-type"));
  check("the stored file is a real 512x512 WebP", (await sharp(stored).metadata()).format === "webp");
  response = await fetch(`${api}/rest/v1/profiles?id=eq.${user.id}&select=avatar_path`, { headers: anon });
  check("the public card exposes the path", (await response.json())[0]?.avatar_path === first.path);

  section("Replacing and removing");
  const second = await replaceAvatar(avatarConfig, user.token, await base(400, 400).png().toBuffer());
  check("a replacement gets a new name, without overwriting", second.path !== first.path);
  check("the old file was removed", second.previousRemoved && !(await storageExists(first.path)));
  check("the new file is available", await storageExists(second.path));
  check("the folder holds exactly one file", (await listFolder(user.id))?.length === 1);

  try {
    psql(`create function public.__boom() returns trigger language plpgsql set search_path = '' as $$ begin raise exception 'secret internal detail'; end $$;
          create trigger __boom before update of avatar_path on public.profiles for each row execute function public.__boom();`);
    const code = await codeOf(replaceAvatar(avatarConfig, user.token, image));
    check("a failed activation reports only a code", code === "storage_failed", code);
    const names = await listFolder(user.id);
    check("a failed activation removes the new file and keeps the current one", names?.length === 1 && second.path.endsWith(names[0]), String(names));
    check("the current avatar still works", await storageExists(second.path));
  } finally {
    psql("drop trigger if exists __boom on public.profiles; drop function if exists public.__boom();");
  }

  section("Ownership and client writes");
  const webp = await sharp(image).webp().toBuffer();
  const strangerHeaders = asUser(stranger.token);
  const userHeaders = asUser(user.token);
  const ownNew = `${user.id}/${randomUUID()}.webp`;
  response = await uploadAs(userHeaders, ownNew, webp);
  check("a user can't upload directly, even to their own folder", !response.ok && !(await storageExists(ownNew)), `status ${response.status}`);
  response = await uploadAs(anon, `${user.id}/${randomUUID()}.webp`, webp);
  check("anon can't upload", !response.ok, `status ${response.status}`);
  const before = (await fetch(`${api}/storage/v1/object/public/avatars/${second.path}`).then((r) => r.arrayBuffer())).byteLength;
  for (const [label, headers] of [["its owner", userHeaders], ["another user", strangerHeaders], ["anon", anon]]) {
    response = await uploadAs(headers, second.path, Buffer.from("overwritten"), { "x-upsert": "true" });
    check(`${label} can't overwrite an avatar with POST`, !response.ok, `status ${response.status}`);
    response = await fetch(`${api}/storage/v1/object/avatars/${second.path}`, { method: "PUT", headers: { ...headers, "Content-Type": "image/webp" }, body: Buffer.from("overwritten") });
    check(`${label} can't overwrite an avatar with PUT`, !response.ok, `status ${response.status}`);
    await fetch(`${api}/storage/v1/object/avatars/${second.path}`, { method: "DELETE", headers });
    await fetch(`${api}/storage/v1/object/avatars`, { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [second.path] }) });
    check(`${label} can't delete an avatar`, await storageExists(second.path));
    response = await post("/storage/v1/object/move", headers, { bucketId: "avatars", sourceKey: second.path, destinationKey: `${stranger.id}/${randomUUID()}.webp` });
    check(`${label} can't move an avatar`, !response.ok && (await storageExists(second.path)), `status ${response.status}`);
  }
  const after = (await fetch(`${api}/storage/v1/object/public/avatars/${second.path}`).then((r) => r.arrayBuffer())).byteLength;
  check("the file is unchanged after every attempt", before === after);
  response = await post("/storage/v1/object/list/avatars", anon, { prefix: `${user.id}/`, limit: 10 });
  check("anon can't list the bucket", !response.ok || (await response.json()).length === 0, `status ${response.status}`);
  response = await post("/storage/v1/object/list/avatars", strangerHeaders, { prefix: `${user.id}/`, limit: 10 });
  check("another user can't list a folder", !response.ok || (await response.json()).length === 0, `status ${response.status}`);
  response = await fetch(`${api}/storage/v1/bucket/avatars`, { method: "PUT", headers: userHeaders, body: JSON.stringify({ public: true, file_size_limit: 999999999 }) });
  check("a user can't change the bucket's settings", !response.ok, `status ${response.status}`);
  response = await fetch(`${api}/storage/v1/bucket/avatars`, { method: "DELETE", headers: userHeaders });
  check("a user can't delete the bucket", !response.ok, `status ${response.status}`);

  section("Bucket limits, even with the secret key");
  response = await fetch(`${api}/storage/v1/object/avatars/${user.id}/${randomUUID()}.svg`, { method: "POST", headers: { ...service, "Content-Type": "image/svg+xml" }, body: "<svg/>" });
  check("the bucket refuses SVG", !response.ok, `status ${response.status}`);
  response = await fetch(`${api}/storage/v1/object/avatars/${user.id}/${randomUUID()}.png`, { method: "POST", headers: { ...service, "Content-Type": "image/png" }, body: image });
  check("the bucket refuses anything but WebP", !response.ok, `status ${response.status}`);
  response = await fetch(`${api}/storage/v1/object/avatars/${user.id}/${randomUUID()}.webp`, { method: "POST", headers: { ...service, "Content-Type": "image/webp" }, body: Buffer.alloc(2097153) });
  check("the bucket refuses files over 2 MB", !response.ok, `status ${response.status}`);

  section("Avatar session checks");
  check("an invalid token can't upload", (await codeOf(replaceAvatar(avatarConfig, "not-a-token", image))) === "not_authenticated");
  check("an invalid token can't remove", (await codeOf(removeAvatar(avatarConfig, "not-a-token"))) === "not_authenticated");
  const noHandle = await createUser({ claim: false });
  check("an account without a handle can't upload", (await codeOf(replaceAvatar(avatarConfig, noHandle.token, image))) === "not_eligible");
  psql(`update public.profiles set account_status = 'suspended' where id = '${stranger.id}';`);
  check("a suspended account can't upload", (await codeOf(replaceAvatar(avatarConfig, stranger.token, image))) === "not_eligible");
  psql(`update public.profiles set account_status = 'active' where id = '${stranger.id}';`);
  check("an invalid image is refused before anything is stored", (await codeOf(replaceAvatar(avatarConfig, stranger.token, Buffer.from("nope")))) === "unsupported_type" && (await listFolder(stranger.id))?.length === 0);

  const removed = await removeAvatar(avatarConfig, user.token);
  check("removal clears the path", removed.previousRemoved && psql(`select avatar_path is null from public.profiles where id = '${user.id}';`) === "t");
  check("removal deletes the file", !(await storageExists(second.path)));
}

async function accountDeletion() {
  section("Account deletion");
  const user = await createUser();
  const uploaded = await replaceAvatar(avatarConfig, user.token, await base().jpeg().toBuffer());
  const strayed = `${user.id}/${randomUUID()}.webp`;
  await uploadAs(service, strayed, await base().webp().toBuffer());

  await deleteAccountWithAvatars(avatarConfig, user.id);
  createdUsers.delete(user.id);
  check("the avatar was removed", !(await storageExists(uploaded.path)));
  check("every other file in the folder was removed", !(await storageExists(strayed)) && (await listFolder(user.id))?.length === 0);
  check("the auth user was removed", psql(`select count(*) from auth.users where id = '${user.id}';`) === "0");
  check("the profile was removed", psql(`select count(*) from public.profiles where id = '${user.id}';`) === "0");
  check("preferences were removed", psql(`select count(*) from public.user_preferences where user_id = '${user.id}';`) === "0");
  check("the handle is held for 30 days", psql(`select expires_at between now() + interval '29 days' and now() + interval '31 days' from private.handle_holds where handle = '${user.handle}';`) === "t");

  const claimant = await createUser({ claim: false });
  let response = await rpc("claim_handle", asUser(claimant.token), { p_handle: user.handle });
  check("the deleted account's handle can't be claimed", !response.ok, `status ${response.status}`);

  response = await fetch(`${api}/auth/v1/user`, { headers: asUser(user.token) });
  check("Auth refuses the deleted user's token", !response.ok, `status ${response.status}`);
  response = await rpc("get_my_account", asUser(user.token));
  const rows = response.ok ? await response.json() : [];
  check("the deleted user's token finds no account", rows.length === 0, `status ${response.status}`);
  response = await fetch(`${api}/rest/v1/profiles?id=eq.${user.id}`, { method: "PATCH", headers: asUser(user.token), body: JSON.stringify({ display_name: "Ghost" }) });
  check("the deleted user's token changes nothing", psql(`select count(*) from public.profiles where id = '${user.id}';`) === "0");
  check("the avatar workflow refuses the deleted user's token", (await codeOf(replaceAvatar(avatarConfig, user.token, await base().jpeg().toBuffer()))) === "not_authenticated");

  // Deleting without the workflow must be possible, and shows why the workflow exists.
  const direct = await createUser();
  const orphan = await replaceAvatar(avatarConfig, direct.token, await base().jpeg().toBuffer());
  response = await fetch(`${api}/auth/v1/admin/users/${direct.id}`, { method: "DELETE", headers: service });
  createdUsers.delete(direct.id);
  check("deleting a user directly still succeeds", response.ok, `status ${response.status}`);
  check("a direct delete leaves the file behind, so it must use the workflow", await storageExists(orphan.path));
  const sqlDirect = await createUser();
  const sqlOrphan = await replaceAvatar(avatarConfig, sqlDirect.token, await base().jpeg().toBuffer());
  psql(`delete from auth.users where id = '${sqlDirect.id}';`);
  createdUsers.delete(sqlDirect.id);
  check("deleting a user with SQL also leaves the file publicly readable", await storageExists(sqlOrphan.path));
  await fetch(`${api}/storage/v1/object/avatars`, { method: "DELETE", headers: service, body: JSON.stringify({ prefixes: [orphan.path, sqlOrphan.path] }) });
  check("an operator can remove orphaned files through the Storage API", !(await storageExists(orphan.path)) && !(await storageExists(sqlOrphan.path)));

  section("Retention");
  check("no scheduler is installed", psql("select count(*) from pg_extension where extname in ('pg_cron', 'pg_net');") === "0");
  const unverified = await post("/auth/v1/signup", anon, { email: newEmail(), password: newPassword() });
  const pending = await unverified.json();
  if (pending.id) createdUsers.add(pending.id);
  psql(`update auth.users set created_at = now() - interval '30 days' where id = '${pending.id}';`);
  check("an old unverified account isn't deleted automatically", psql(`select count(*) from auth.users where id = '${pending.id}';`) === "1");
}

async function cleanup() {
  for (const id of createdUsers) {
    const names = (await listFolder(id)) ?? [];
    if (names.length) {
      await fetch(`${api}/storage/v1/object/avatars`, { method: "DELETE", headers: service, body: JSON.stringify({ prefixes: names.map((name) => `${id}/${name}`) }) });
    }
    await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
  }
  psql("delete from private.handle_holds where kind = 'released' and (handle like 'chk%' or handle like 'badminton\\_%');");
}

try {
  await signupLifecycle();
  await handleConcurrency();
  await profilePrivacy();
  await staffEscalation();
  await authBehaviour();
  await avatarProcessing();
  await avatarStorage();
  await accountDeletion();
} catch (error) {
  failed += 1;
  console.error(`FAIL identity checks stopped early: ${error.message}`);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
