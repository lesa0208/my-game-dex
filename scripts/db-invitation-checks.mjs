/**
 * M11a-1 invitation checks through the real local Auth, REST API and Mailpit. They play
 * the server's part exactly as src/features/invitations/actions.ts does: a database
 * function first (in the administrator's own MFA session), then the Auth Admin call with
 * the secret key, then the database records and checks the outcome.
 *
 *   npm run test-stack:run -- db:invitation-checks                     (sign-up on)
 *   MGD_TEST_SIGNUP=off npm run test-stack:reset && npm run test-stack:run -- db:invitation-checks
 *
 * Destructive: it creates and bans accounts and edits the ledger to move time on, so it
 * refuses a protected development stack (scripts/lib/stack.mjs). Throwaway accounts on
 * example.test only. Nothing printed contains a token, key, password or address.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

import { elevate } from "./lib/mfa-session.mjs";
import { dbContainer, root, stackConfig, stackStatus } from "./lib/stack.mjs";

const { createClient } = createRequire(`${root}/package.json`)("@supabase/supabase-js");
const status = stackStatus({ label: "the invitation checks" });
const api = status.API_URL;
const mailpit = status.MAILPIT_URL;
const anonKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
const signupOn = !/\[auth\][\s\S]*?\nenable_signup\s*=\s*false/.test(stackConfig);

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `: ${detail}` : ""}`);
}
const section = (title) => console.log(`\n=== ${title}`);
const psql = (sql) => execFileSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], { input: sql, encoding: "utf8" }).trim();
const client = () => createClient(api, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const adminAuth = createClient(api, secretKey, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;
const tag = randomBytes(3).toString("hex");
const address = (name) => `inv-${tag}-${name}@example.test`;
const pw = () => `Inv-${randomBytes(12).toString("base64url")}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const created = [];

/** A signed-in client for a new confirmed account with a handle and an optional role (TOTP-verified when staff). */
async function person(role = null) {
  const email = address(role ?? "collector");
  const password = pw();
  const { data, error } = await adminAuth.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`setup: ${error.code}`);
  created.push(data.user.id);
  psql(`update public.profiles set handle = 'iv${tag}${created.length}', handle_changed_at = now() where id = '${data.user.id}';`);
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${data.user.id}', '${role}');`);
  const c = client();
  const { data: signedIn } = await c.auth.signInWithPassword({ email, password });
  let session = signedIn.session;
  if (role) {
    session = await elevate(api, anonKey, signedIn.session);
    await c.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  }
  return { id: data.user.id, email, password, c, session };
}
const rpc = async (who, fn, args = {}) => {
  const { data, error } = await who.c.rpc(fn, args);
  return error ? { error: error.message } : data;
};

/** The newest invitation email to an address after `after`, as the link's token_hash and URL. Never printed. */
async function inviteMail(email, after) {
  for (let i = 0; i < 60; i += 1) {
    const r = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages = [] } = r.ok ? await r.json() : {};
    for (const m of messages.filter((x) => Date.parse(x.Created) >= after - 2000)) {
      const body = await (await fetch(`${mailpit}/api/v1/message/${m.ID}`)).json();
      const html = `${body.HTML}`.replace(/&amp;/g, "&");
      const link = /href="([^"]*\/auth\/confirm\?token_hash=([A-Za-z0-9_-]+)&type=invite)"/.exec(html);
      if (link) return { url: link[1], tokenHash: link[2], count: messages.length };
    }
    await pause(250);
  }
  return null;
}

/** The server's part of an invitation: database, then Auth, then the database records it. */
async function invite(admin, email, reason = "Invitation checks") {
  const made = await rpc(admin, "create_account_invitation", { p_email: email, p_reason: reason });
  if (!made?.id) return { made };
  const sentAt = Date.now();
  const { error } = await adminAuth.inviteUserByEmail(email);
  const delivery = await rpc(admin, "record_invitation_delivery", { p_id: made.id, p_operation: "invite", p_sent: !error });
  const mail = error ? null : await inviteMail(email, sentAt);
  return { made, id: made.id, delivery, mail, authError: error };
}
const userIdOf = (email) => psql(`select id from auth.users where lower(email) = lower('${email}');`);
const state = (id) => psql(`select state from private.account_invitations where id = '${id}';`);

async function revoke(admin, id, { ban = true } = {}) {
  const asked = await rpc(admin, "request_invitation_revocation", { p_id: id, p_reason: "Invitation checks revoke" });
  if (asked?.result === "revoke_pending" && ban) await adminAuth.updateUserById(asked.user_id, { ban_duration: "876000h" });
  const settled = asked?.result === "revoke_pending" ? await rpc(admin, "reconcile_invitation", { p_id: id }) : asked;
  return { asked, settled };
}

try {
  section(`Configuration (${signupOn ? "A: sign-up on, the development setting" : "B: invite-only, [auth] enable_signup = false, email provider on"})`);
  {
    const { error } = await client().auth.signUp({ email: address("selfsignup"), password: pw() });
    if (signupOn) check("public sign-up is open in configuration A (the historical identity checks rely on it)", !error, error?.code);
    else check("public sign-up is refused in configuration B", error?.code === "signup_disabled", error?.code);
    if (!error) created.push(userIdOf(address("selfsignup")));
  }
  const admin = await person("admin");
  const moderator = await person("moderator");
  const editor = await person("catalog_editor");
  const collector = await person();

  section("Who may invite, over the API");
  for (const [label, who] of [["a collector", collector], ["a catalog editor", editor], ["a moderator", moderator]]) {
    check(`${label} can't invite`, (await rpc(who, "create_account_invitation", { p_email: address("x"), p_reason: "x" }))?.error === "not permitted");
  }
  {
    // A password-only (aal1) session of the same administrator.
    const aal1 = client();
    await aal1.auth.signInWithPassword({ email: admin.email, password: admin.password });
    const { error } = await aal1.rpc("create_account_invitation", { p_email: address("x"), p_reason: "x" });
    check("an administrator without a verified (aal2) session can't invite", error?.message === "not permitted", error?.message);
    const anon = await client().rpc("create_account_invitation", { p_email: address("x"), p_reason: "x" });
    check("anon can't call it at all", /permission denied/.test(anon.error?.message ?? ""), anon.error?.message);
  }

  section("Invitation to handle");
  const first = address("first");
  const one = await invite(admin, first);
  check("an administrator invites; the database records it before Auth sends", typeof one.id === "string" && one.delivery?.result === "sent", JSON.stringify(one.delivery));
  check("Mailpit receives the email, with the app's confirmation link (token_hash), not Auth's verify link", Boolean(one.mail?.url?.includes("/auth/confirm?token_hash=")));
  const invitee = client();
  const accepted = await invitee.auth.verifyOtp({ type: "invite", token_hash: one.mail.tokenHash });
  check("verifying the token signs the invitee in", Boolean(accepted.data?.session) && !accepted.error, accepted.error?.code);
  check("and accepting confirms the email address", psql(`select email_confirmed_at is not null from auth.users where lower(email) = '${first}';`) === "t");
  check("the same token can't be used again", Boolean((await client().auth.verifyOtp({ type: "invite", token_hash: one.mail.tokenHash })).error));
  const me = { c: invitee };
  check("the invitee can't claim a handle before setting a password", (await rpc(me, "claim_handle", { p_handle: `iv${tag}h1` }))?.error === "account not eligible");
  check("the marker refuses before Auth records a password", (await rpc(me, "complete_my_password_setup"))?.refusal === "password_not_set");
  const password = pw();
  check("the invitee sets a password", !(await invitee.auth.updateUser({ password })).error);
  check("and the marker records it", (await rpc(me, "complete_my_password_setup"))?.result === "recorded");
  check("repeating it changes nothing", (await rpc(me, "complete_my_password_setup"))?.result === "unchanged");
  check("submitting the same password again (after a lost response) is answered by Auth, and the marker stays", (await invitee.auth.updateUser({ password })).error?.code === "same_password");
  check("the handle is claimed with the existing workflow", (await rpc(me, "claim_handle", { p_handle: `iv${tag}h1` })) === `iv${tag}h1`);
  check("the invitee signs in with email and password", !(await client().auth.signInWithPassword({ email: first, password })).error);
  check("and is an ordinary collector, with no staff role", psql(`select count(*) from public.staff_roles where user_id = '${userIdOf(first)}';`) === "0");
  {
    const list = await rpc(admin, "get_account_invitations");
    const mine = list.invitations.find((i) => i.id === one.id);
    check("the list shows it as joined, with the address masked", mine?.status === "active" && mine.email !== first && /\*\*\*@/.test(mine.email));
    check("and no address appears anywhere in the list", !JSON.stringify(list).includes(`inv-${tag}`));
  }

  section("Existing accounts and addresses");
  {
    const again = await rpc(admin, "create_account_invitation", { p_email: first, p_reason: "Again" });
    check("inviting an address that has an account gets the generic answer, with nothing created", again?.result === "accepted" && !again.id);
    const { error } = await adminAuth.inviteUserByEmail(first);
    check("and Auth itself refuses to invite a confirmed account (422)", error?.status === 422, error?.code);
  }

  section("Concurrent acceptance of one invitation");
  {
    const email = address("race");
    const r = await invite(admin, email);
    const sessions = (await Promise.all(Array.from({ length: 6 }, async () => {
      const c = client();
      const v = await c.auth.verifyOtp({ type: "invite", token_hash: r.mail.tokenHash });
      return v.data?.session ? c : null;
    }))).filter(Boolean);
    check("Auth lets several simultaneous verifications of one token through (as M11a-0 found)", sessions.length >= 1, `${sessions.length}`);
    console.log(`     ${sessions.length} of 6 simultaneous verifications got a session`);
    const pass = pw();
    await Promise.all(sessions.map((c) => c.auth.updateUser({ password: pass })));
    const marks = await Promise.all(sessions.map((c) => rpc({ c }, "complete_my_password_setup")));
    check("every session's password step ends recorded or unchanged, none in error", marks.every((m) => m?.result === "recorded" || m?.result === "unchanged"), JSON.stringify(marks));
    check("the marker is set exactly once on one ledger row", psql(`select count(*) from private.account_invitations where email = '${email}' and password_set_at is not null;`) === "1");
    const claims = await Promise.all(sessions.map((c, i) => rpc({ c }, "claim_handle", { p_handle: `iv${tag}r${i}` })));
    const handle = psql(`select handle from public.profiles where id = '${userIdOf(email)}';`);
    check("concurrent handle claims leave one account with one handle, by claim_handle's own rules", /^iv[0-9a-f]+r\d$/.test(handle) && psql(`select count(*) from auth.users where lower(email) = '${email}';`) === "1", `${handle} ${JSON.stringify(claims)}`);
  }

  section("Resending");
  {
    const email = address("resend");
    const r = await invite(admin, email);
    const tooSoon = await rpc(admin, "request_invitation_resend", { p_id: r.id, p_reason: "Lost it" });
    check("a resend within 10 minutes is refused", tooSoon?.refusal === "resend_too_soon", JSON.stringify(tooSoon));
    psql(`update private.account_invitations set last_sent_at = now() - interval '11 minutes' where id = '${r.id}';`);
    const asked = await rpc(admin, "request_invitation_resend", { p_id: r.id, p_reason: "Lost it" });
    check("after 10 minutes it's allowed, and the database gives the server the address", asked?.ok === true && asked.email === email);
    const sentAt = Date.now();
    const { error } = await adminAuth.inviteUserByEmail(email);
    const delivery = await rpc(admin, "record_invitation_delivery", { p_id: r.id, p_operation: "resend", p_sent: !error });
    const second = await inviteMail(email, sentAt);
    check("a new email arrives and the resend is recorded", delivery?.result === "sent" && second?.tokenHash && second.tokenHash !== r.mail.tokenHash);
    check("the first link stops working", Boolean((await client().auth.verifyOtp({ type: "invite", token_hash: r.mail.tokenHash })).error));
    check("asking again at once is refused", (await rpc(admin, "request_invitation_resend", { p_id: r.id, p_reason: "Again" }))?.refusal === "resend_too_soon");
    psql(`update private.account_invitations set last_sent_at = now() - interval '1 hour', last_resend_requested_at = now() - interval '1 hour', resend_count = 5 where id = '${r.id}';`);
    check("after five resends, no more", (await rpc(admin, "request_invitation_resend", { p_id: r.id, p_reason: "Again" }))?.refusal === "resend_limit");
    // An expired link: Auth's one-hour limit, moved on by editing the token's age on this test stack.
    psql(`update auth.users set invited_at = now() - interval '2 hours', confirmation_sent_at = now() - interval '2 hours' where lower(email) = '${email}';
      update auth.one_time_tokens set created_at = now() - interval '2 hours' where user_id = (select id from auth.users where lower(email) = '${email}');`);
    const expired = await client().auth.verifyOtp({ type: "invite", token_hash: second.tokenHash });
    check("a link older than an hour is refused", expired.error?.code === "otp_expired", expired.error?.code);
    check("and the list shows the invitation as expired", (await rpc(admin, "get_account_invitations")).invitations.find((i) => i.id === r.id)?.status === "expired");
  }

  section("Revocation");
  {
    const email = address("revoke");
    const r = await invite(admin, email);
    const { asked, settled } = await revoke(admin, r.id);
    check("revocation is recorded first, then the account banned, then the ban read back", asked?.result === "revoke_pending" && settled?.result === "revoked", JSON.stringify(settled));
    const after = await client().auth.verifyOtp({ type: "invite", token_hash: r.mail.tokenHash });
    check("the banned invitee's link is refused by Auth", after.error?.code === "user_banned", after.error?.code);
    check("and the account isn't deleted", psql(`select count(*) from auth.users where lower(email) = '${email}';`) === "1");
    check("a revoked invitation can't be resent", (await rpc(admin, "request_invitation_resend", { p_id: r.id, p_reason: "x" }))?.refusal === "invitation_closed");
  }
  {
    // The ban never happens (Auth failed), and the invitee accepts with the still-valid token.
    const email = address("noban");
    const r = await invite(admin, email);
    const { settled } = await revoke(admin, r.id, { ban: false });
    check("without a ban in Auth, the revocation stays pending", settled?.result === "revoke_pending", JSON.stringify(settled));
    const c = client();
    const v = await c.auth.verifyOtp({ type: "invite", token_hash: r.mail.tokenHash });
    check("Auth still lets the invitee in (the token is valid there)", Boolean(v.data?.session), v.error?.code);
    await c.auth.updateUser({ password: pw() });
    check("but the database refuses their password step", (await rpc({ c }, "complete_my_password_setup"))?.refusal === "invitation_revoked");
    check("and their handle claim, so onboarding can't finish", (await rpc({ c }, "claim_handle", { p_handle: `iv${tag}nb` }))?.error === "account not eligible");
    check("the app sees it as revoked", (await rpc({ c }, "get_my_onboarding"))?.revoked === true);
    const target = await rpc(admin, "retry_invitation_revocation", { p_id: r.id });
    check("retrying asks the database which account to ban", target?.user_id === userIdOf(email));
    await adminAuth.updateUserById(target.user_id, { ban_duration: "876000h" });
    const settled2 = await rpc(admin, "reconcile_invitation", { p_id: r.id });
    check("with the ban confirmed, it's recorded as revoked after acceptance", settled2?.result === "revoked_after_acceptance", JSON.stringify(settled2));
    check("the account still exists, banned, never deleted or unbanned", psql(`select (banned_until > now())::text from auth.users where lower(email) = '${email}';`) === "true");
    const refreshed = await c.auth.refreshSession();
    check("the invitee's session can't be refreshed after the ban", Boolean(refreshed.error), refreshed.error?.code);
  }
  {
    // Acceptance racing revocation, five times: accept while the revocation is recorded, banned and reconciled.
    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      const email = address(`racerev${i}`);
      const r = await invite(admin, email);
      const c = client();
      const [v] = await Promise.all([c.auth.verifyOtp({ type: "invite", token_hash: r.mail.tokenHash }), revoke(admin, r.id)]);
      if (v.data?.session) await c.auth.updateUser({ password: pw() });
      const claim = v.data?.session ? await rpc({ c }, "claim_handle", { p_handle: `iv${tag}x${i}` }) : null;
      outcomes.push({ state: state(r.id), accepted: Boolean(v.data?.session), claimed: typeof claim === "string", exists: psql(`select count(*) from auth.users where lower(email) = '${email}';`) });
    }
    console.log(`     ${outcomes.map((o) => `${o.accepted ? "accepted" : "refused"}/${o.state}`).join(" | ")}`);
    check("every race ends revoked, or revoked after acceptance", outcomes.every((o) => o.state === "revoked" || o.state === "revoked_after_acceptance"), JSON.stringify(outcomes));
    check("no account is ever deleted", outcomes.every((o) => o.exists === "1"));
    check("and no racing invitee ever claims a handle", outcomes.every((o) => !o.claimed));
  }
  {
    const r = await rpc(admin, "request_invitation_revocation", { p_id: one.id, p_reason: "Too late" });
    check("an invitee who has joined can't be revoked: suspend instead", r?.refusal === "already_active");
  }

  section("Limits");
  {
    psql(`insert into private.account_invitations (email, invited_by, reason) select 'inv-${tag}-bulk' || g || '@example.test', '${admin.id}', 'Bulk' from generate_series(1, 20) g;`);
    check("an administrator with 20 open invitations can't send another", (await rpc(admin, "create_account_invitation", { p_email: address("over"), p_reason: "x" }))?.refusal === "invitation_limit");
    psql(`delete from private.account_invitations where email like 'inv-${tag}-bulk%';`);
  }

  if (!signupOn) {
    section("Configuration B: recovery still works");
    const sentAt = Date.now();
    const { error } = await client().auth.resetPasswordForEmail(first);
    check("a password reset can be asked for", !error, error?.code);
    let token = null;
    for (let i = 0; i < 60 && !token; i += 1) {
      const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${first}"`)}`);
      for (const m of ((await res.json()).messages ?? []).filter((x) => Date.parse(x.Created) >= sentAt - 2000)) {
        const body = await (await fetch(`${mailpit}/api/v1/message/${m.ID}`)).json();
        const t = /[?&]token=([A-Za-z0-9_-]+)&(?:amp;)?type=recovery/.exec(`${body.HTML}`);
        if (t) token = t[1];
      }
      if (!token) await pause(250);
    }
    const c = client();
    const v = token ? await c.auth.verifyOtp({ type: "recovery", token_hash: token }) : { error: { code: "no email" } };
    check("the recovery email's token signs the person in to recover", Boolean(v.data?.session), v.error?.code);
    const fresh = pw();
    check("a new password can be set", !(await c.auth.updateUser({ password: fresh })).error);
    check("and used to sign in", !(await client().auth.signInWithPassword({ email: first, password: fresh })).error);
  }
} catch (error) {
  failed += 1;
  console.log(`FAIL the checks stopped: ${error.message}`);
} finally {
  // Throwaway accounts and their invitations only (example.test, this run's tag).
  psql(`delete from private.account_invitations where email like 'inv-${tag}-%';`);
  const ids = psql(`select string_agg(id::text, ',') from auth.users where email like 'inv-${tag}-%';`).split(",").filter(Boolean);
  for (const id of ids) await adminAuth.deleteUser(id);
  const left = psql(`select count(*) from auth.users where email like 'inv-${tag}-%';`);
  console.log(`\nCleanup: ${ids.length} throwaway accounts deleted, ${left} left.`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
