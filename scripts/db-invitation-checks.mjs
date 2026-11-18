/**
 * M11a-1 and M11a-2 invitation checks through the real local Auth, REST API and Mailpit.
 * They play the server's part exactly as src/features/invitations/actions.ts does: a
 * database function first (in the administrator's own MFA session), then the server's
 * steps with the secret key (what to send, the Auth Admin call, recording what Auth did,
 * the account to ban, reconciling), which the database checks itself.
 *
 * M11a-2 adds: an address with an account must look exactly like one without, to an
 * administrator using the API directly; a handle claim and a revocation in either order
 * (two database sessions, one held open); and a revoked invitee's existing token can't
 * write as a collector.
 *
 *   npm run test-stack:run -- db:invitation-checks                     (sign-up on)
 *   MGD_TEST_SIGNUP=off npm run test-stack:reset && npm run test-stack:run -- db:invitation-checks
 *
 * Destructive: it creates and bans accounts and edits the ledger to move time on, so it
 * refuses a protected development stack (scripts/lib/stack.mjs). Throwaway accounts on
 * example.test only. Nothing printed contains a token, key, password or address.
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

import { installFixture, removeFixture } from "./catalog-fixture.mjs";
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
const serverClient = createClient(api, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const adminAuth = serverClient.auth.admin;
/** One of the server's steps (service_role), as features/auth-admin/server calls it. */
const srv = async (fn, args = {}) => {
  const { data, error } = await serverClient.rpc(fn, args);
  return error ? { error: error.message } : data;
};
/** A SQL session held open: runs `sql` in a transaction that sleeps `holdSeconds` before committing. */
function heldSession(claims, sql, holdSeconds) {
  const script = `begin;
select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);
set local role authenticated;
${sql}
select pg_sleep(${holdSeconds});
commit;
`;
  return new Promise((resolve) => {
    const child = spawn("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-At"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", () => resolve(out.trim()));
    child.stdin.end(script);
  });
}
const claimsOf = (session) => JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString());
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const tag = randomBytes(3).toString("hex");
const address = (name) => `inv-${tag}-${name}@example.test`;
const pw = () => `Inv-${randomBytes(12).toString("base64url")}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const created = [];
let fixtureInstalled = false;

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

/** The server's part of an email: what to send, Auth, then the database records what Auth did. */
async function deliver(id, operation) {
  const plan = await srv("invitation_delivery_plan", { p_id: id });
  let outcome = "skipped";
  let error = null;
  if (plan?.send === true) {
    ({ error } = await adminAuth.inviteUserByEmail(plan.email));
    outcome = !error ? "sent" : error.status === 422 ? "unavailable" : "failed";
  }
  const delivery = await srv("record_invitation_delivery", { p_id: id, p_operation: operation, p_outcome: outcome });
  return { plan, outcome, delivery, error };
}
/** The server's part of an invitation: database, then the server's steps. */
async function invite(admin, email, reason = "Invitation checks", { mail: wantMail = true } = {}) {
  const made = await rpc(admin, "create_account_invitation", { p_email: email, p_reason: reason });
  if (!made?.id) return { made };
  const sentAt = Date.now();
  const { delivery, outcome, error } = await deliver(made.id, "invite");
  const mail = outcome === "sent" && wantMail ? await inviteMail(email, sentAt) : null;
  return { made, id: made.id, delivery, outcome, mail, authError: error };
}
/** The server's part of a revocation: the account to ban, the ban, then reconciliation. */
async function settle(id, { ban = true } = {}) {
  const target = await srv("invitation_revocation_target", { p_id: id });
  if (target?.user_id && ban) await adminAuth.updateUserById(target.user_id, { ban_duration: "876000h" });
  return { target, settled: await srv("reconcile_invitation", { p_id: id }) };
}
const mailCount = async (email) => {
  const r = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return r.ok ? ((await r.json()).messages ?? []).length : -1;
};
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
/** What an administrator's list shows for an invitation, without what differs for any two rows. */
const entryOf = (list, id) => {
  const e = list.invitations.find((i) => i.id === id);
  if (!e) return null;
  return JSON.stringify(omit(e, ["id", "email", "created_at", "last_sent_at", "next_resend_at", "revoked_at"]));
};
const userIdOf = (email) => psql(`select id from auth.users where lower(email) = lower('${email}');`);
const state = (id) => psql(`select state from private.account_invitations where id = '${id}';`);

async function revoke(admin, id, { ban = true } = {}) {
  const asked = await rpc(admin, "request_invitation_revocation", { p_id: id, p_reason: "Invitation checks revoke" });
  const settled = asked?.result === "revoke_pending" ? (await settle(id, { ban })).settled : asked;
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

  section("An address with an account looks like any other (M11a-2)");
  {
    const before = await rpc(admin, "get_account_invitations");
    const mailBefore = await mailCount(first);
    const fresh = address("fresh");
    const known = await invite(admin, first, "Parity");
    const unknown = await invite(admin, fresh, "Parity");
    const strip = (x) => JSON.stringify({ ...x, id: typeof x?.id });
    check("creating answers the same, with an id, for an address with an account and one without", strip(known.made) === strip(unknown.made) && typeof known.id === "string", `${strip(known.made)} ${strip(unknown.made)}`);
    check("the server is never told to send to the address with an account", known.outcome === "skipped" && unknown.outcome === "sent");
    check("and the delivery is recorded the same way", JSON.stringify(known.delivery) === JSON.stringify(unknown.delivery), `${JSON.stringify(known.delivery)} ${JSON.stringify(unknown.delivery)}`);
    await pause(1500);
    check("no email reaches the existing account", (await mailCount(first)) === mailBefore);
    const after = await rpc(admin, "get_account_invitations");
    check("both appear in the list, each counted", after.invitations.length === before.invitations.length + 2 && after.limits.mine === before.limits.mine + 2);
    check("with entries that say the same", entryOf(after, known.id) === entryOf(after, unknown.id), `${entryOf(after, known.id)} ${entryOf(after, unknown.id)}`);
    const log = await rpc(admin, "get_audit_log", { p_limit: 20, p_category: "accounts" });
    const seen = (action) => log.filter((e) => e.action === action).slice(0, 2).map((e) => JSON.stringify(omit(e, ["id", "occurred_at"])));
    check("the audit log's invitation rows read the same", seen("account_invited")[0] === seen("account_invited")[1], seen("account_invited").join(" "));
    check("and its delivery rows", seen("account_invitation_delivery")[0] === seen("account_invitation_delivery")[1], seen("account_invitation_delivery").join(" "));
    check("no audit detail marks either one", !/withheld|invitee|address_unavailable/.test(JSON.stringify(log)));
    for (const fn of ["invitation_delivery_plan", "record_invitation_delivery", "invitation_revocation_target", "reconcile_invitation"]) {
      const args = fn === "record_invitation_delivery" ? { p_id: known.id, p_operation: "invite", p_outcome: "sent" } : { p_id: known.id };
      check(`an administrator calling ${fn} directly is refused`, /permission denied/.test((await rpc(admin, fn, args))?.error ?? ""));
    }
    psql(`update private.account_invitations set last_sent_at = now() - interval '11 minutes' where id in ('${known.id}', '${unknown.id}');`);
    const askedKnown = await rpc(admin, "request_invitation_resend", { p_id: known.id, p_reason: "Parity" });
    const askedUnknown = await rpc(admin, "request_invitation_resend", { p_id: unknown.id, p_reason: "Parity" });
    check("resending answers the same, with no address", JSON.stringify(askedKnown) === JSON.stringify(askedUnknown) && !JSON.stringify(askedKnown).includes("@"), `${JSON.stringify(askedKnown)} ${JSON.stringify(askedUnknown)}`);
    const reKnown = await deliver(known.id, "resend");
    const reUnknown = await deliver(unknown.id, "resend");
    check("and its delivery too, still without an email to the account", JSON.stringify(reKnown.delivery) === JSON.stringify(reUnknown.delivery) && reKnown.outcome === "skipped");
    check("a second resend at once is refused the same way",
      JSON.stringify(await rpc(admin, "request_invitation_resend", { p_id: known.id, p_reason: "x" })) === JSON.stringify(await rpc(admin, "request_invitation_resend", { p_id: unknown.id, p_reason: "x" })));
    const revKnown = await rpc(admin, "request_invitation_revocation", { p_id: known.id, p_reason: "Parity" });
    const revUnknown = await rpc(admin, "request_invitation_revocation", { p_id: unknown.id, p_reason: "Parity" });
    check("revoking answers the same, naming no account", JSON.stringify(revKnown) === JSON.stringify(revUnknown) && !("user_id" in (revKnown ?? {})), `${JSON.stringify(revKnown)} ${JSON.stringify(revUnknown)}`);
    const setKnown = await settle(known.id);
    const setUnknown = await settle(unknown.id);
    check("only the real invitee is banned; the account with that address is untouched", !setKnown.target?.user_id && Boolean(setUnknown.target?.user_id)
      && psql(`select banned_until is null from auth.users where lower(email) = '${first}';`) === "t");
    check("both end revoked, alike in the list", setKnown.settled?.result === "revoked" && setUnknown.settled?.result === "revoked"
      && entryOf(await rpc(admin, "get_account_invitations"), known.id) === entryOf(await rpc(admin, "get_account_invitations"), unknown.id));
    check("and the existing account can still sign in, its own onboarding unchanged",
      !(await client().auth.signInWithPassword({ email: first, password })).error
      && JSON.stringify(await rpc(me, "get_my_onboarding")) === JSON.stringify({ invited: true, revoked: false, password_set: true }));
  }
  {
    // An account made between the invitation's record and its email: Auth answers 422.
    const late = address("late");
    const made = await rpc(admin, "create_account_invitation", { p_email: late, p_reason: "Late" });
    const { data: lateUser } = await adminAuth.createUser({ email: late, password: pw(), email_confirm: true });
    if (lateUser?.user) created.push(lateUser.user.id);
    const { outcome, delivery } = await deliver(made.id, "invite");
    check("an account made after the invitation was recorded: Auth refuses (422), recorded like a send", outcome === "unavailable" && delivery?.result === "sent", `${outcome} ${JSON.stringify(delivery)}`);
    check("and the row is withheld, never linked to that account", psql(`select (withheld and invited_user_id is null)::text from private.account_invitations where id = '${made.id}';`) === "true");
  }
  {
    // A real outage: Auth fails for a real invitation, and a withheld one follows while it lasts.
    const down = address("down");
    const made = await rpc(admin, "create_account_invitation", { p_email: down, p_reason: "Outage" });
    const failed = await srv("record_invitation_delivery", { p_id: made.id, p_operation: "invite", p_outcome: "failed" });
    const known = await rpc(admin, "create_account_invitation", { p_email: collector.email, p_reason: "Outage" });
    const k = await deliver(known.id, "invite");
    check("while emails are failing, a real invitation shows the failure and so does a withheld one", failed?.result === "send_failed" && k.delivery?.result === "send_failed", `${JSON.stringify(failed)} ${JSON.stringify(k.delivery)}`);
    const ok = await invite(admin, address("up"), "Outage over", { mail: false });
    const known2 = await rpc(admin, "create_account_invitation", { p_email: collector.email, p_reason: "Outage over" });
    const k2 = await deliver(known2.id, "invite");
    check("once an email gets through, both show as sent again", ok.delivery?.result === "sent" && k2.delivery?.result === "sent");
  }
  {
    // Timing: what an administrator could measure. A withheld row skips the Auth call.
    const known = [];
    const unknown = [];
    for (let i = 0; i < 5; i += 1) {
      for (const [list, email] of [[known, collector.email], [unknown, address(`time${i}`)]]) {
        const t0 = performance.now();
        await invite(admin, email, "Timing", { mail: false });
        list.push(performance.now() - t0);
      }
    }
    console.log(`     server path, median of 5: address with an account ${median(known).toFixed(0)} ms, without ${median(unknown).toFixed(0)} ms (Auth's invite call and Mailpit's SMTP)`);
    check("timing is measured (the residual difference is documented in security-rls.md)", known.length === 5 && unknown.length === 5);
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
    check("after 10 minutes it's allowed; the administrator gets no address, the server's step does", asked?.ok === true && !("email" in asked));
    const sentAt = Date.now();
    const { delivery } = await deliver(r.id, "resend");
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
    const retry = await rpc(admin, "retry_invitation_revocation", { p_id: r.id });
    const { target, settled: settled2 } = await settle(r.id);
    check("retrying is allowed, and the server's step names the account to ban", retry?.ok === true && !("user_id" in retry) && target?.user_id === userIdOf(email));
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

  section("A handle claim and a revocation, in either order (M11a-2)");
  {
    // An invitee who has accepted and set a password, ready to claim a handle.
    async function readyInvitee(name) {
      const email = address(name);
      const r = await invite(admin, email);
      const c = client();
      await c.auth.verifyOtp({ type: "invite", token_hash: r.mail.tokenHash });
      await c.auth.updateUser({ password: pw() });
      await rpc({ c }, "complete_my_password_setup");
      const { data } = await c.auth.getSession();
      return { email, id: r.id, c, session: data.session };
    }
    const adminClaims = { ...claimsOf(admin.session), role: "authenticated" };

    // 1. The claim commits first: it holds the invitation's lock while the revocation waits.
    const one = await readyInvitee("claimfirst");
    const held = heldSession({ ...claimsOf(one.session), role: "authenticated" }, `select public.claim_handle('iv${tag}cf');`, 2);
    await pause(700);
    const t0 = performance.now();
    const asked = await rpc(admin, "request_invitation_revocation", { p_id: one.id, p_reason: "Race" });
    const waited = performance.now() - t0;
    const claimOut = await held;
    check("claim first: the claim succeeds", claimOut.includes(`iv${tag}cf`), claimOut);
    check("and the revocation, which waited for the lock, sees the handle and refuses: suspend instead", asked?.refusal === "already_active" && waited > 900, `${JSON.stringify(asked)} ${waited.toFixed(0)} ms`);
    check("the invitation is untouched", state(one.id) === "sent");

    // 2. The revocation commits first: the claim waits for the lock, then sees the revocation.
    const two = await readyInvitee("revokefirst");
    const heldRevoke = heldSession(adminClaims, `select public.request_invitation_revocation('${two.id}', 'Race');`, 2);
    await pause(700);
    const t1 = performance.now();
    const claim = await rpc({ c: two.c }, "claim_handle", { p_handle: `iv${tag}rf` });
    const waited2 = performance.now() - t1;
    const revokeOut = await heldRevoke;
    check("revocation first: the revocation is recorded", revokeOut.includes("revoke_pending"), revokeOut);
    check("and the claim, which waited for the lock, is refused", claim?.error === "account not eligible" && waited2 > 900, `${JSON.stringify(claim)} ${waited2.toFixed(0)} ms`);
    check("no handle was claimed", psql(`select coalesce(handle, '') from public.profiles where id = '${userIdOf(two.email)}';`) === "");

    // 3. With the revocation committed, the invitee's token from before it can't write as a collector.
    const w = two.c;
    const account = (await w.rpc("get_my_account")).data?.[0];
    check("their existing token reads an inactive account, which every collector write requires to be active", account && account.is_active === false, JSON.stringify(account));
    // A real published release (the catalog fixture), which an active collector can add.
    installFixture();
    fixtureInstalled = true;
    const release = psql("select id from public.releases where product_code = 'SNS-ZSFE-USA';");
    const control = await collector.c.from("collection_items").insert({ id: psql("select private.uuid_v7();"), owner_id: collector.id, release_id: release });
    check("(an active collector can add a copy of the fixture's release)", !control.error, control.error?.code);
    const ins = await w.from("collection_items").insert({ id: psql("select private.uuid_v7();"), owner_id: userIdOf(two.email), release_id: release });
    check("but the revoked invitee's token can't (row-level security)", ins.error?.code === "42501", `${ins.error?.code} ${ins.error?.message}`);
    const sub = await w.rpc("submit_game", { p_title: "Race game", p_kind: "game", p_first_release_year: 2001, p_platform: "x", p_media_format: "x", p_region: "x" });
    check("nor submit a catalog record", sub.error?.message === "account not active", sub.error?.message);
    const prof = await w.from("profiles").update({ display_name: "Race" }).eq("id", userIdOf(two.email)).select();
    check("nor edit their profile", Boolean(prof.error) || (prof.data ?? []).length === 0, prof.error?.code);
    check("nor finish onboarding", (await rpc({ c: w }, "get_my_onboarding"))?.revoked === true && (await rpc({ c: w }, "claim_handle", { p_handle: `iv${tag}rg` }))?.error === "account not eligible");
    const { settled } = await settle(two.id);
    check("the ban then completes the revocation", settled?.result === "revoked_after_acceptance", JSON.stringify(settled));
    check("and the same token still can't write", (await w.from("collection_items").insert({ id: psql("select private.uuid_v7();"), owner_id: userIdOf(two.email), release_id: release })).error?.code === "42501");
    check("nor be refreshed", Boolean((await w.auth.refreshSession()).error));
  }

  section("Limits");
  {
    psql(`insert into private.account_invitations (email, invited_by, reason) select 'inv-${tag}-bulk' || g || '@example.test', '${admin.id}', 'Bulk' from generate_series(1, 20) g;`);
    check("an administrator with 20 open invitations can't send another", (await rpc(admin, "create_account_invitation", { p_email: address("over"), p_reason: "x" }))?.refusal === "invitation_limit");
    check("to an address with an account either: the same refusal", (await rpc(admin, "create_account_invitation", { p_email: collector.email, p_reason: "x" }))?.refusal === "invitation_limit");
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
  if (fixtureInstalled) removeFixture();
  // Throwaway accounts and their invitations only (example.test, this run's tag).
  psql(`delete from private.account_invitations where email like 'inv-${tag}-%';`);
  const ids = psql(`select coalesce(string_agg(id::text, ','), '') from auth.users where email like 'inv-${tag}-%';`).split(",").filter(Boolean);
  for (const id of ids) await adminAuth.deleteUser(id);
  // The audit rows these accounts made or were about (the log is append-only, so with
  // triggers off, as the other checks do), and the holds their released handles left.
  const list = ids.map((id) => `'${id}'`).join(",") || "null";
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}); commit;`);
  psql(`delete from private.handle_holds where kind = 'released' and handle like 'iv${tag}%';`);
  const left = psql(`select count(*) from auth.users where email like 'inv-${tag}-%';`);
  console.log(`\nCleanup: ${ids.length} throwaway accounts deleted, ${left} left.`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
