/**
 * M11a-2 password checks through the real local Auth and REST API: what Auth itself does
 * with password recovery, password changes and sign-out, which the pages rely on and the
 * docs describe (docs/architecture/security-rls.md, "Password recovery and sessions").
 * A hosted project must behave the same; run this against staging before the beta.
 *
 *   npm run test-stack:run -- db:password-checks                     (sign-up on)
 *   MGD_TEST_SIGNUP=off npm run test-stack:reset && npm run test-stack:run -- db:password-checks
 *
 * Destructive (it bans accounts and moves Auth's timestamps), so it refuses a protected
 * development stack. Throwaway accounts on example.test only. Nothing printed contains a
 * token, key, password or address.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { decodeClaims, elevate, totp } from "./lib/mfa-session.mjs";
import { dbContainer, stackConfig, stackStatus } from "./lib/stack.mjs";

const status = stackStatus({ label: "the password checks" });
const api = status.API_URL;
const publishable = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
const signupOn = !/\[auth\][\s\S]*?\nenable_signup\s*=\s*false/.test(stackConfig);
const service = { apikey: secretKey, Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" };

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` (${detail})` : ""}`);
}
const section = (title) => console.log(`\n${title}`);
const psql = (sql) => execFileSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], { input: sql, encoding: "utf8" }).trim();

async function auth(method, path, { token, body, headers } = {}) {
  const response = await fetch(`${api}/auth/v1${path}`, {
    method,
    headers: headers ?? { apikey: publishable, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, code: json.error_code ?? null, body: json };
}
async function rpc(token, fn, args = {}) {
  const response = await fetch(`${api}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: publishable, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const created = [];
const tag = randomBytes(3).toString("hex");
const password = () => `Pw-${randomBytes(12).toString("base64url")}`;
async function account(name, { handle = false } = {}) {
  const email = `dbpw-${tag}-${name}@example.test`;
  const pw = password();
  const made = await auth("POST", "/admin/users", { headers: service, body: { email, password: pw, email_confirm: true } });
  if (made.status !== 200) throw new Error(`setup: couldn't create an account (${made.status})`);
  created.push(made.body.id);
  const user = { id: made.body.id, email, password: pw };
  if (handle) {
    const s = await signIn(user);
    const claimed = await rpc(s.access_token, "claim_handle", { p_handle: `dp_${randomBytes(5).toString("hex")}` });
    if (claimed.status >= 300) throw new Error("setup: couldn't claim a handle");
  }
  return user;
}
async function signIn(user, pw = user.password) {
  const r = await auth("POST", "/token?grant_type=password", { body: { email: user.email, password: pw } });
  return r.status === 200 ? r.body : null;
}
const refresh = (session) => auth("POST", "/token?grant_type=refresh_token", { body: { refresh_token: session.refresh_token } });
const recoveryHash = async (user) => (await auth("POST", "/admin/generate_link", { headers: service, body: { type: "recovery", email: user.email } })).body.hashed_token;
const verify = (hash) => auth("POST", "/verify", { body: { type: "recovery", token_hash: hash } });
const methods = (token) => decodeClaims(token).amr?.map((a) => a.method) ?? [];

try {
  console.log(`Sign-up is ${signupOn ? "on" : "off (invite-only, as a hosted project will be)"}.`);

  section("Asking for a reset: Auth's answers");
  {
    const a = await account("ask");
    const known = await auth("POST", "/recover", { body: { email: a.email } });
    const unknown = await auth("POST", "/recover", { body: { email: `dbpw-${tag}-nobody@example.test` } });
    check("an address with an account and one without get the same answer", known.status === 200 && unknown.status === 200);
    const again = await auth("POST", "/recover", { body: { email: a.email } });
    check("documented: asking again within a minute is refused for an address with an account only", again.status === 429 && again.code === "over_email_send_rate_limit", `${again.status} ${again.code}`);
    check("which is why the page gives one answer whatever Auth says", (await auth("POST", "/recover", { body: { email: `dbpw-${tag}-nobody@example.test` } })).status === 200);
  }

  section("A reset link: single-use, an hour, the newest only");
  {
    const a = await account("link");
    const old = await signIn(a);
    const hash = await recoveryHash(a);
    const used = await verify(hash);
    check("verifying the link signs in, with a one-time code and no password", used.status === 200 && methods(used.body.access_token).join() === "otp" && decodeClaims(used.body.access_token).aal === "aal1");
    check("the link can't be used again", (await verify(hash)).code === "otp_expired");
    check("a made-up link is refused", (await verify("a".repeat(56))).code === "otp_expired");
    const fresh = password();
    const updated = await auth("PUT", "/user", { token: used.body.access_token, body: { password: fresh } });
    check("the recovery session can set a new password", updated.status === 200);
    check("the old password stops working", (await signIn(a)) === null);
    check("the new one works", (await signIn(a, fresh)) !== null);
    check("the session from before the reset can't refresh", (await refresh(old)).code === "refresh_token_not_found");
    check("nor read the account in Auth", (await auth("GET", "/user", { token: old.access_token })).code === "session_not_found");
    check("the recovery session itself goes on", (await refresh(used.body)).status === 200);
    const stale = await recoveryHash(a);
    psql(`update auth.one_time_tokens set created_at = now() - interval '2 hours' where user_id = '${a.id}'; update auth.users set recovery_sent_at = now() - interval '2 hours' where id = '${a.id}';`);
    check("a link more than an hour old is refused", (await verify(stale)).code === "otp_expired");
    const older = await recoveryHash(a);
    const newer = await recoveryHash(a);
    check("an older link stops working when a newer one is issued", (await verify(older)).code === "otp_expired");
    check("the newer one works", (await verify(newer)).status === 200);
    const banned = await account("banned");
    const bannedHash = await recoveryHash(banned);
    psql(`update auth.users set banned_until = now() + interval '100 years' where id = '${banned.id}';`);
    check("a banned account's link can't sign it in", (await verify(bannedHash)).code === "user_banned");
  }

  section("A reset with an authenticator: Auth requires it");
  {
    const m = await account("mfa");
    const aal2 = await elevate(api, publishable, await signIn(m));
    const other = await signIn(m);
    const recovery = (await verify(await recoveryHash(m))).body;
    check("the recovery session is aal1", decodeClaims(recovery.access_token).aal === "aal1");
    const pw = password();
    const refused = await auth("PUT", "/user", { token: recovery.access_token, body: { password: pw } });
    check("Auth refuses its password change", refused.status === 401 && refused.code === "insufficient_aal", `${refused.status} ${refused.code}`);
    check("and staff functions refuse it", (await rpc(recovery.access_token, "get_account_invitations")).status >= 400);
    const challenge = await auth("POST", `/factors/${aal2.factorId}/challenge`, { token: recovery.access_token, body: {} });
    const stepped = await auth("POST", `/factors/${aal2.factorId}/verify`, { token: recovery.access_token, body: { challenge_id: challenge.body.id, code: totp(aal2.totpSecret) } });
    check("verifying the authenticator takes the recovery session to aal2, keeping its one-time code", stepped.status === 200 && decodeClaims(stepped.body.access_token).aal === "aal2" && methods(stepped.body.access_token).includes("otp"));
    check("and the session's id stays the same (the app's recovery mark still matches)", decodeClaims(stepped.body.access_token).session_id === decodeClaims(recovery.access_token).session_id);
    check("then the password can be changed", (await auth("PUT", "/user", { token: stepped.body.access_token, body: { password: pw } })).status === 200);
    check("the authenticator is kept", psql(`select count(*) from auth.mfa_factors where user_id = '${m.id}' and status = 'verified';`) === "1");
    check("the other session can't refresh", (await refresh(other)).code === "refresh_token_not_found");
  }

  section("Changing a password while signed in");
  {
    const a = await account("change");
    const mine = await signIn(a);
    const other = await signIn(a);
    const pw = password();
    check("a session signed in within the day can change it", (await auth("PUT", "/user", { token: mine.access_token, body: { password: pw } })).status === 200);
    check("every other session ends", (await refresh(other)).code === "refresh_token_not_found");
    check("this one goes on", (await refresh(mine)).status === 200);
    check("the old password stops working", (await signIn(a)) === null);
    const later = await signIn(a, pw);
    psql(`update auth.sessions set created_at = now() - interval '25 hours' where id = '${decodeClaims(later.access_token).session_id}';`);
    const old = await auth("PUT", "/user", { token: later.access_token, body: { password: password() } });
    check("a session from more than a day ago must reauthenticate (secure_password_change)", old.status === 400 && old.code === "reauthentication_needed", `${old.status} ${old.code}`);
    check("the same password is refused as such", (await auth("PUT", "/user", { token: (await signIn(a, pw)).access_token, body: { password: pw } })).code === "same_password");
  }

  section("Signing out: this device, others, everywhere, and the access token already issued");
  {
    const a = await account("signout", { handle: true });
    const target = await account("target", { handle: true });
    const one = await signIn(a);
    const two = await signIn(a);
    const local = await auth("POST", "/logout?scope=local", { token: one.access_token });
    check("signing out this device ends its session only", local.status === 204 && (await refresh(one)).code === "refresh_token_not_found" && (await refresh(two)).status === 200);
    const three = await signIn(a);
    const four = await signIn(a);
    const everywhere = await auth("POST", "/logout?scope=global", { token: three.access_token });
    check("signing out everywhere ends every session", everywhere.status === 204 && psql(`select count(*) from auth.sessions where user_id = '${a.id}';`) === "0");
    check("no device can refresh", (await refresh(four)).code === "refresh_token_not_found");
    check("Auth refuses the ended session's access token", (await auth("GET", "/user", { token: four.access_token })).code === "session_not_found");
    // Since the session-revocation checkpoint (db-session-checks.mjs covers every path).
    const read = await rpc(four.access_token, "get_my_account");
    check("the database refuses that unexpired access token at once: no account to read", read.status === 200 && Array.isArray(read.body) && read.body.length === 0);
    const write = await rpc(four.access_token, "block_user", { p_target: target.id });
    check("nor a collector's write", write.status === 403 && psql(`select count(*) from public.blocked_users where blocker_id = '${a.id}';`) === "0", `${write.status}`);
    psql(`delete from public.blocked_users where blocker_id = '${a.id}';`);
    const expiry = decodeClaims(four.access_token).exp - decodeClaims(four.access_token).iat;
    check("an access token lasts an hour at most (jwt_expiry)", expiry <= 3600, `${expiry}s`);

    const admin = await account("admin", { handle: true });
    psql(`insert into public.staff_roles (user_id, role) values ('${admin.id}', 'admin');`);
    const verified = await elevate(api, publishable, await signIn(admin));
    check("an administrator's verified session reads the invitations", (await rpc(verified.access_token, "get_account_invitations")).status === 200);
    const elsewhere = await signIn(admin);
    await auth("POST", "/logout?scope=global", { token: elsewhere.access_token });
    const after = await rpc(verified.access_token, "get_account_invitations");
    check("after signing out everywhere, staff functions refuse its token at once (a live session is required)", after.status >= 400, `${after.status}`);
  }
} catch (error) {
  check(`the checks ran to the end (${error.message})`, false);
} finally {
  for (const id of created) await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
  psql("delete from private.handle_holds where kind = 'released' and handle like 'dp\\_%';");
  check("no test account or handle hold is left behind", psql(`select count(*) from auth.users where email like 'dbpw-${tag}-%';`) === "0" && psql("select count(*) from private.handle_holds where handle like 'dp\\_%';") === "0");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
