/**
 * M11a-2 app checks: password recovery, changing a password and signing out everywhere,
 * driven through the built app over HTTP as a browser without JavaScript would, against
 * the local test stack with Mailpit (the reset email uses supabase/templates/recovery.html).
 *
 *   npm run build && npm run test-stack:run -- app:password-checks
 *
 * Destructive, so it refuses a protected development stack. Throwaway accounts only;
 * nothing printed contains a token, key, password or address.
 */
import { randomBytes } from "node:crypto";

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
  streamedRedirectTo,
  stopApp,
  verifyBrowser,
  writeSession,
} from "./app-harness.mjs";
import { decodeClaims } from "./lib/mfa-session.mjs";
import { stackStatus } from "./lib/stack.mjs";

const stack = stackStatus({ label: "the password app checks" });
const mailpit = stack.MAILPIT_URL;
const api = stack.API_URL;
const publishable = stack.PUBLISHABLE_KEY ?? stack.ANON_KEY;
await startApp(3298);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
/** Whether an administrator's staff page really shows (the unavailable page's text is in every page's payload). */
const staffWorks = (html) => visible(html).includes("Invite someone");
const newPassword = () => `Pw-${randomBytes(12).toString("base64url")}`;

/** A throwaway account with a handle (prefix pw_), signed in in its own browser. */
async function person({ mfa = false, role = null } = {}) {
  const user = await createUser({ prefix: "apppw", mfa: mfa || Boolean(role) });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `pw_${randomBytes(5).toString("hex")}` });
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  const handle = psql(`select handle from public.profiles where id = '${user.id}';`);
  return { ...user, browser, handle };
}

/** Another device: a second browser signed in to the same account. */
async function device(user) {
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  return browser;
}

/** Whether a password signs in, over the API; a session it creates is ended at once. */
async function apiSignIn(email, password) {
  const r = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: publishable, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const body = await r.json().catch(() => ({}));
  if (body.access_token) await fetch(`${api}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: publishable, Authorization: `Bearer ${body.access_token}` } });
  return r.status;
}
const sessions = (id) => Number(psql(`select count(*) from auth.sessions where user_id = '${id}';`));

/** Whether a browser's session can still be renewed in Auth (its refresh token). Spends it when it can. */
async function canRefresh(browser) {
  const session = readSession(browser)?.session;
  if (!session) return false;
  const r = await fetch(`${api}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: publishable, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
  return r.ok;
}

/** Makes a browser's access token look expired, so the next request renews it (or can't). */
function expire(browser) {
  const stored = readSession(browser);
  writeSession(browser, stored.names, { ...stored.session, expires_at: Math.floor(Date.now() / 1000) - 60 });
}
const sessionId = (browser) => decodeClaims(readSession(browser).session.access_token).session_id;

/** The path of the newest reset link sent to an address after `after`. Never printed. */
async function resetLink(email, after) {
  for (let i = 0; i < 40; i += 1) {
    const r = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages = [] } = r.ok ? await r.json() : {};
    for (const m of messages.filter((x) => Date.parse(x.Created) >= after - 2000)) {
      const body = await (await fetch(`${mailpit}/api/v1/message/${m.ID}`)).json();
      const link = /href="[^"]*(\/auth\/confirm\?token_hash=[A-Za-z0-9_-]+&(?:amp;)?type=recovery)"/.exec(`${body.HTML}`);
      if (link) return { path: link[1].replace(/&amp;/g, "&"), subject: m.Subject, html: `${body.HTML}` };
    }
    await pause(250);
  }
  return null;
}
async function mailCount(email) {
  const r = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return r.ok ? ((await r.json()).messages ?? []).length : -1;
}

/** Asks for a reset on /forgot-password, as a browser would. */
async function requestReset(browser, email) {
  const page = await browser.get("/forgot-password");
  const started = Date.now();
  const res = await browser.submit("/forgot-password", formWith(page.html, "email"), { email });
  return { res, ms: Date.now() - started, sent: started };
}

/** Opens a reset link and presses its button. */
async function openLink(browser, path) {
  const page = await browser.get(path);
  const form = formWith(page.html, "token_hash");
  return { page, res: form ? await browser.submit(path, form, {}) : null };
}

/** The reset page's form, then the new password through it. */
async function choose(browser, password, confirm = password) {
  const page = await browser.get("/reset-password");
  const form = formWith(page.html, "confirm");
  return { page, res: form ? await browser.submit("/reset-password", form, { password, confirm }) : null };
}

const recoveryTokens = (id) => psql(`select count(*) from auth.one_time_tokens where user_id = '${id}' and token_type = 'recovery_token';`);

let resetFormTemplate = null;
let changeFormTemplate = null;

try {
  section("Asking for a reset says the same for every address");
  const known = await person();
  const other = await device(known);
  {
    const signIn = await new Browser().get("/sign-in");
    check("the sign-in page links to /forgot-password", /href="\/forgot-password"/.test(signIn.html));
    const page = await new Browser().get("/forgot-password");
    check("/forgot-password has a labelled email form", page.response.status === 200 && /<label[^>]*for="email"/.test(page.html) && Boolean(formWith(page.html, "email")));
    check("and mentions the authenticator and the operator for a lost one", /authenticator/.test(visible(page.html)) && /operator/.test(visible(page.html)));

    const before = await mailCount(known.email);
    const a = await requestReset(new Browser(), known.email);
    const unknownEmail = `apppw-nobody-${randomBytes(4).toString("hex")}@example.test`;
    const b = await requestReset(new Browser(), unknownEmail);
    const again = await requestReset(new Browser(), known.email);
    check("an address with an account gets the generic answer", location(a.res.response) === "/forgot-password?status=sent", location(a.res.response));
    check("so does one without", location(b.res.response) === location(a.res.response));
    check("and asking again within a minute (Auth's per-address limit) too", location(again.res.response) === location(a.res.response));
    check("each answer takes at least two seconds", a.ms >= 2000 && b.ms >= 2000 && again.ms >= 2000, `${a.ms} ${b.ms} ${again.ms}`);
    check("and they're within 300 ms of each other", Math.max(a.ms, b.ms, again.ms) - Math.min(a.ms, b.ms, again.ms) < 300, `${a.ms} ${b.ms} ${again.ms}`);
    const sentPage = await new Browser().get("/forgot-password?status=sent");
    check("the answer doesn't say whether the address has an account", visible(sentPage.html).includes("If an account uses this address"));
    check("the answers set no Auth cookie", !a.res.response.headers.getSetCookie().some((c) => c.startsWith("sb-")));
    const link = await resetLink(known.email, a.sent);
    check("Mailpit receives the reset email, linking to the app's confirmation page", Boolean(link) && link.subject === "Reset your My Game Dex password");
    await pause(1500);
    check("only one email for the two requests a minute apart", (await mailCount(known.email)) === before + 1);
    check("the address without an account gets nothing", (await mailCount(unknownEmail)) === 0);
    const bad = await requestReset(new Browser(), "not-an-address");
    check("a malformed address is told so (about the format only)", location(bad.res.response) === "/forgot-password?error=invalid_email");
    check("no page shows the address", !sentPage.html.includes("apppw-"));

    section("Opening the reset link");
    const resetter = new Browser();
    const opened = await resetter.get(link.path);
    check("opening the link shows a button, and nothing else happens", opened.response.status === 200 && visible(opened.html).includes("Continue to reset your password"));
    check("the GET didn't use the token", recoveryTokens(known.id) === "1");
    check("the page asks browsers not to send the link on as a referrer", /<meta name="referrer" content="no-referrer"/.test(opened.html));
    check("a browser that hasn't opened a link can't reset", visible((await new Browser().get("/reset-password")).html).includes("Open the link from your reset email"));
    const crossSite = await resetter.submit(link.path, formWith(opened.html, "token_hash"), {}, { origin: "https://evil.example" });
    check("the button posted from another site is refused, and the token is kept", !isRedirect(crossSite.response) && recoveryTokens(known.id) === "1", `status ${crossSite.response.status}`);
    const pressed = await resetter.submit(link.path, formWith(opened.html, "token_hash"), {});
    check("pressing it verifies the token and goes to /reset-password", location(pressed.response) === "/reset-password", location(pressed.response));
    check("the token is spent", recoveryTokens(known.id) === "0");
    const marker = pressed.response.headers.getSetCookie().find((c) => c.startsWith("mgd-recovery="));
    check("the browser is marked with the session's id, httpOnly, for an hour", Boolean(marker) && /HttpOnly/i.test(marker) && /Max-Age=3600/i.test(marker) && marker.startsWith(`mgd-recovery=${sessionId(resetter)}`));
    check("no URL or cookie after the link carries the token", !location(pressed.response).includes("token") && !pressed.response.headers.getSetCookie().some((c) => c.includes(link.path.split("token_hash=")[1].split("&")[0])));
    const used = await new Browser().get(link.path);
    const reuse = await new Browser().submit(link.path, formWith(used.html, "token_hash"), {});
    check("the link can't be used again", location(reuse.response) === "/auth/confirm?type=recovery&status=invalid");
    check("which shows the generic page, offering a new link", visible((await new Browser().get("/auth/confirm?type=recovery&status=invalid")).html).includes("This link can't be used"));

    section("Choosing the new password");
    const resetPage = await resetter.get("/reset-password");
    resetFormTemplate = formWith(resetPage.html, "confirm");
    check("the reset page has a labelled new-password form, naming the account", Boolean(resetFormTemplate) && /autocomplete="new-password"/i.test(resetPage.html) && visible(resetPage.html).includes(`@${known.handle}`));
    const short = await choose(resetter, "short");
    check("a short password is refused", location(short.res.response) === "/reset-password?error=too_short", location(short.res.response));
    check("and the page says why, next to the form", visible((await resetter.get("/reset-password?error=too_short")).html).includes("Use at least 12 characters") && /aria-describedby="page-error password-hint"/.test((await resetter.get("/reset-password?error=too_short")).html));
    const mismatch = await choose(resetter, newPassword(), newPassword());
    check("two different passwords are refused", location(mismatch.res.response) === "/reset-password?error=mismatch");
    const same = await choose(resetter, known.password);
    check("the current password is refused as the new one", location(same.res.response) === "/reset-password?error=same_password", location(same.res.response));
    check("which the page explains", visible((await resetter.get("/reset-password?error=same_password")).html).includes("already your password"));
    check("no refusal puts a password in the URL", ![short, mismatch, same].some((r) => location(r.res.response).includes("Pw-")));
    const fresh = newPassword();
    const done = await choose(resetter, fresh);
    check("a good password is saved, then on to the account page", location(done.res.response) === "/settings/account?notice=password_reset", location(done.res.response));
    check("the recovery mark is cleared", done.res.response.headers.getSetCookie().some((c) => c.startsWith("mgd-recovery=;") || (c.startsWith("mgd-recovery=") && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c))));
    check("the account page says other devices were signed out", visible((await resetter.get("/settings/account?notice=password_reset")).html).includes("your other devices were signed out"));
    check("the old password no longer signs in", (await apiSignIn(known.email, known.password)) === 400);
    check("the new one does", (await apiSignIn(known.email, fresh)) === 200);
    check("the other device can't renew its session", !(await canRefresh(other)));
    known.password = fresh;
    check("the reset page can't be used again", visible((await resetter.get("/reset-password")).html).includes("Open the link from your reset email"));
    check("the resetting browser stays signed in", (await resetter.get("/collection")).response.status === 200);
  }

  section("The other device, after a reset: what Auth really does");
  {
    const user = await person();
    const second = await device(user);
    const { sent } = await requestReset(new Browser(), user.email);
    const link = await resetLink(user.email, sent);
    const b = new Browser();
    await openLink(b, link.path);
    await choose(b, newPassword());
    // Since the session-revocation checkpoint: its unexpired token reaches no protected data,
    // so the app treats the device as signed out at once.
    const stillOpen = await second.get("/collection");
    check("the other device is signed out at once, although its token hasn't expired", streamedRedirectTo(stillOpen.html, "/sign-in") || location(stillOpen.response).startsWith("/sign-in"), `${stillOpen.response.status} ${location(stillOpen.response)}`);
    check("and its page shows nothing of the account", !stillOpen.html.includes(user.handle));
    expire(second);
    const after = await second.get("/collection");
    check("once it expires it can't be renewed either", location(after.response).startsWith("/sign-in"), location(after.response));
  }

  section("Links that can't be used");
  {
    const user = await person();
    const first = await requestReset(new Browser(), user.email);
    const link = await resetLink(user.email, first.sent);
    psql(`update auth.one_time_tokens set created_at = now() - interval '2 hours' where user_id = '${user.id}'; update auth.users set recovery_sent_at = now() - interval '2 hours' where id = '${user.id}';`);
    const expired = await openLink(new Browser(), link.path);
    check("an expired link is refused", location(expired.res.response) === "/auth/confirm?type=recovery&status=invalid");
    const second = await requestReset(new Browser(), user.email);
    const older = await resetLink(user.email, second.sent);
    psql(`update auth.users set recovery_sent_at = now() - interval '2 minutes' where id = '${user.id}';`);
    const third = await requestReset(new Browser(), user.email);
    let newest = await resetLink(user.email, third.sent);
    for (let i = 0; i < 8 && newest?.path === older?.path; i += 1) newest = await resetLink(user.email, third.sent);
    check("a newer link was sent", Boolean(newest) && newest.path !== older.path);
    check("an older link stops working when a newer one is sent", location((await openLink(new Browser(), older.path)).res.response) === "/auth/confirm?type=recovery&status=invalid");
    for (const [label, path] of [["a malformed token", "/auth/confirm?token_hash=x&type=recovery"], ["a made-up token", `/auth/confirm?token_hash=${"a".repeat(56)}&type=recovery`]]) {
      const page = await new Browser().get(path);
      const form = formWith(page.html, "token_hash");
      const shown = visible(page.html).includes("This link can't be used");
      const refused = form ? location((await new Browser().submit(path, form, {})).response) === "/auth/confirm?type=recovery&status=invalid" : shown;
      check(`${label} is refused`, refused);
    }
    check("the newest link still works", location((await openLink(new Browser(), newest.path)).res.response) === "/reset-password");
    const banned = await person();
    psql(`update auth.users set banned_until = now() + interval '100 years' where id = '${banned.id}';`);
    const asked = await requestReset(new Browser(), banned.email);
    check("a banned account gets the generic answer", location(asked.res.response) === "/forgot-password?status=sent");
    const bannedLink = await resetLink(banned.email, asked.sent);
    check("and its link can't sign it in", !bannedLink || location((await openLink(new Browser(), bannedLink.path)).res.response) === "/auth/confirm?type=recovery&status=invalid");
  }

  section("No session confusion");
  {
    const victim = await person();
    const intruder = await person();
    const { sent } = await requestReset(new Browser(), intruder.email);
    const link = await resetLink(intruder.email, sent);
    const victimId = sessionId(victim.browser);
    const opened = await victim.browser.get(link.path);
    check("opening a link while signed in says who is signed in, and that continuing signs them out", visible(opened.html).includes(`signed in as @${victim.handle}`) && visible(opened.html).includes("signs you out"));
    await victim.browser.submit(link.path, formWith(opened.html, "token_hash"), {});
    check("continuing ended the signed-in account's session in Auth", psql(`select count(*) from auth.sessions where id = '${victimId}';`) === "0");
    const page = await victim.browser.get("/reset-password");
    check("and the reset page names the link's account, not the previous one", visible(page.html).includes(`@${intruder.handle}`) && !visible(page.html).includes(`@${victim.handle}`));

    // A recovery mark from one session doesn't carry over to another.
    const marked = new Browser();
    const again = await requestReset(new Browser(), victim.email);
    const victimLink = await resetLink(victim.email, again.sent);
    await openLink(marked, victimLink.path);
    const mark = marked.cookies.get("mgd-recovery");
    const signedIn = await device(victim);
    signedIn.cookies.set("mgd-recovery", mark);
    check("a password sign-in with another session's mark can't reset", visible((await signedIn.get("/reset-password")).html).includes("Open the link from your reset email"));
    const pw = newPassword();
    const forcedGood = await signedIn.submit("/reset-password", resetFormTemplate, { password: pw, confirm: pw });
    check("posting the reset form from such a session changes nothing", location(forcedGood.response) === "/reset-password" && (await apiSignIn(victim.email, pw)) === 400);
    const copied = new Browser();
    for (const name of marked.authCookieNames()) copied.cookies.set(name, marked.cookies.get(name));
    check("the session's cookies without the browser's mark can't reset", visible((await copied.get("/reset-password")).html).includes("Open the link from your reset email"));
    const crossed = new Browser();
    for (const name of marked.authCookieNames()) crossed.cookies.set(name, marked.cookies.get(name));
    crossed.cookies.set("mgd-recovery", victim.browser.cookies.get("mgd-recovery"));
    check("nor can a reset session with another reset's mark", Boolean(victim.browser.cookies.get("mgd-recovery")) && visible((await crossed.get("/reset-password")).html).includes("Open the link from your reset email"));

    // Interrupted: the reset page works again later in the same browser, but not after the hour.
    check("an interrupted reset can be resumed in the same browser", Boolean(formWith((await marked.get("/reset-password")).html, "confirm")));
    psql(`update auth.mfa_amr_claims set created_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' where session_id = '${sessionId(marked)}';`);
    expire(marked);
    const late = await marked.get("/reset-password");
    check("but not more than an hour after the link was opened", visible(late.html).includes("This reset has expired"));
  }

  section("A reset with an authenticator");
  {
    const admin = await person({ role: "admin" });
    const factorsBefore = psql(`select count(*) from auth.mfa_factors where user_id = '${admin.id}' and status = 'verified';`);
    const { sent } = await requestReset(new Browser(), admin.email);
    const link = await resetLink(admin.email, sent);
    const b = new Browser();
    const pressed = (await openLink(b, link.path)).res;
    check("the link signs in at aal1 and goes to /reset-password", location(pressed.response) === "/reset-password" && decodeClaims(readSession(b).session.access_token).aal === "aal1");
    const page = await b.get("/reset-password");
    const text = visible(page.html);
    check("the page explains the authenticator is needed, and shows no password form", text.includes("uses an authenticator app") && !formWith(page.html, "confirm"));
    check("it links to the usual verification, coming back here", page.html.includes(`/settings/security/verify?next=${encodeURIComponent("/reset-password")}`));
    check("and tells someone who lost it to contact the operator, removing nothing", text.includes("Lost your authenticator?") && text.includes("operator"));
    const pw = newPassword();
    const forced = await b.submit("/reset-password", resetFormTemplate, { password: pw, confirm: pw });
    check("posting the reset form at aal1 goes to verify, changing nothing", location(forced.response) === `/settings/security/verify?next=${encodeURIComponent("/reset-password")}` && (await apiSignIn(admin.email, pw)) === 400);
    const direct = await fetch(`${api}/auth/v1/user`, { method: "PUT", headers: { apikey: publishable, Authorization: `Bearer ${readSession(b).session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    check("Auth itself refuses the aal1 recovery session's password change", direct.status === 401 && (await direct.json()).error_code === "insufficient_aal");
    check("the recovery session has no staff abilities", !staffWorks((await b.get("/admin/invitations")).html));
    const verified = await verifyBrowser(b, admin, "/reset-password");
    check("verifying the authenticator returns to /reset-password", location(verified.response) === "/reset-password");
    const done = await choose(b, pw);
    check("then the new password can be chosen", location(done.res.response) === "/settings/account?notice=password_reset", location(done.res.response));
    check("the authenticator is kept", psql(`select count(*) from auth.mfa_factors where user_id = '${admin.id}' and status = 'verified';`) === factorsBefore);
    check("the old password no longer signs in", (await apiSignIn(admin.email, admin.password)) === 400);
    check("and the administrator's verified session works as before", staffWorks((await b.get("/admin/invitations")).html));
    check("their other device can't renew its session", !(await canRefresh(admin.browser)));
  }

  section("Changing the password while signed in");
  {
    const user = await person();
    const second = await device(user);
    const page = await user.browser.get("/settings/account");
    changeFormTemplate = formWith(page.html, "current_password");
    check("/settings/account has a labelled change form", page.response.status === 200 && Boolean(changeFormTemplate) && /<label[^>]*for="current-password"/.test(page.html) && /autocomplete="current-password"/i.test(page.html));
    check("settings link to it", /href="\/settings\/account"/.test((await user.browser.get("/settings")).html));
    const change = (b, fields) => b.submit("/settings/account", changeFormTemplate, fields);
    const pw = newPassword();
    const before = sessions(user.id);
    const wrong = await change(user.browser, { current_password: "not-the-password", password: pw, confirm: pw });
    check("a wrong current password is refused", location(wrong.response) === "/settings/account?error=wrong_password" && (await apiSignIn(user.email, pw)) === 400, location(wrong.response));
    check("plainly", visible((await user.browser.get("/settings/account?error=wrong_password")).html).includes("Your current password is incorrect."));
    check("and leaves no extra session behind", sessions(user.id) === before);
    const missing = await change(user.browser, { current_password: "", password: pw, confirm: pw });
    check("an empty current password is refused", location(missing.response) === "/settings/account?error=current_required");
    const short = await change(user.browser, { current_password: user.password, password: "short", confirm: "short" });
    check("a short new password is refused", location(short.response) === "/settings/account?error=too_short");
    const same = await change(user.browser, { current_password: user.password, password: user.password, confirm: user.password });
    check("the same password is refused", location(same.response) === "/settings/account?error=same_password", location(same.response));
    check("no refusal leaks Auth's words or a password", ![wrong, missing, short, same].some((r) => /invalid_credentials|Invalid login|Pw-|not-the-password/i.test(location(r.response) + r.html)));
    const evilPw = newPassword();
    const evil = await user.browser.submit("/settings/account", changeFormTemplate, { current_password: user.password, password: evilPw, confirm: evilPw }, { origin: "https://evil.example" });
    check("a change posted from another site is refused", !isRedirect(evil.response) && (await apiSignIn(user.email, evilPw)) === 400, `status ${evil.response.status}`);
    await change(user.browser, { current_password: user.password, password: pw, confirm: pw });
    check("a good change went through, back to the page with a notice", (await apiSignIn(user.email, pw)) === 200 && (await apiSignIn(user.email, user.password)) === 400);
    check("the other device can't renew its session", !(await canRefresh(second)));
    check("the changing device stays signed in", (await user.browser.get("/collection")).response.status === 200);
    check("only this device's session is left", sessions(user.id) === 1);
    user.password = pw;
    const pw2 = newPassword();
    const ok = await change(user.browser, { current_password: user.password, password: pw2, confirm: pw2 });
    check("the change redirects with its notice", location(ok.response) === "/settings/account?notice=password_changed", location(ok.response));
    user.password = pw2;

    psql(`update auth.sessions set created_at = now() - interval '25 hours' where id = '${sessionId(user.browser)}';`);
    const pw3 = newPassword();
    const old = await change(user.browser, { current_password: user.password, password: pw3, confirm: pw3 });
    check("a session from more than a day ago must sign in again (Auth's rule)", location(old.response) === "/settings/account?error=reauthenticate" && (await apiSignIn(user.email, pw3)) === 400, location(old.response));
    const offer = await user.browser.get("/settings/account?error=reauthenticate");
    check("the page explains, and offers to sign in again", visible(offer.html).includes("signed in more than a day ago") && visible(offer.html).includes("Sign in again"));
    check("the current password checked for it left no session behind", sessions(user.id) === 1);

    const signedOut = new Browser();
    const anon = await signedOut.submit("/settings/account", changeFormTemplate, { current_password: user.password, password: pw3, confirm: pw3 });
    check("signed out, the change goes to sign in", (location(anon.response).startsWith("/sign-in") || anon.html.includes("/sign-in")) && (await apiSignIn(user.email, pw3)) === 400);
  }

  section("Changing the password with an authenticator");
  {
    const admin = await person({ role: "admin" });
    const factorsBefore = psql(`select count(*) from auth.mfa_factors where user_id = '${admin.id}' and status = 'verified';`);
    // Signed in with the password only: aal1.
    const aal1 = new Browser();
    const signIn = await aal1.get("/sign-in?next=%2Fsettings%2Faccount");
    await aal1.submit("/sign-in", formWith(signIn.html, "password"), { email: admin.email, password: admin.password });
    const page = await aal1.get("/settings/account");
    check("at aal1 the page asks to verify first, with no change form", visible(page.html).includes("verify a code") && !formWith(page.html, "current_password"));
    const pw = newPassword();
    const forced = await aal1.submit("/settings/account", changeFormTemplate, { current_password: admin.password, password: pw, confirm: pw });
    check("posting the form at aal1 goes to verify, changing nothing", location(forced.response) === `/settings/security/verify?next=${encodeURIComponent("/settings/account")}` && (await apiSignIn(admin.email, pw)) === 400);
    const ok = await admin.browser.submit("/settings/account", changeFormTemplate, { current_password: admin.password, password: pw, confirm: pw });
    check("at aal2 the change works", location(ok.response) === "/settings/account?notice=password_changed", location(ok.response));
    check("the authenticator is kept", psql(`select count(*) from auth.mfa_factors where user_id = '${admin.id}' and status = 'verified';`) === factorsBefore);
    check("the administrator keeps their access in this session", staffWorks((await admin.browser.get("/admin/invitations")).html));
    check("the aal1 device can't renew its session", !(await canRefresh(aal1)));
  }

  section("Signing out on all devices");
  {
    const admin = await person({ role: "admin" });
    const second = await device(admin);
    const third = await device(admin);
    check("the other device's staff pages work before", staffWorks((await second.get("/admin/invitations")).html));
    const page = await admin.browser.get("/settings/account");
    check("the page offers both, explained apart", visible(page.html).includes("Sign out on this device only") && visible(page.html).includes("Sign out on all devices"));
    // Ordinary sign-out ends this device only.
    const count = sessions(admin.id);
    await third.submit("/settings/account", { hidden: formHidden(await third.get("/settings/account"), "Sign out") }, {});
    check("ordinary sign-out ends this device's session only", sessions(admin.id) === count - 1 && third.authCookieNames().length === 0);
    const everywhere = await admin.browser.submit("/settings/account", { hidden: formHidden(page, "Sign out on all devices") }, {}, {});
    check("signing out everywhere goes to sign in with a notice", location(everywhere.response) === "/sign-in?notice=signed_out_everywhere", location(everywhere.response));
    check("which says every device was signed out", visible((await new Browser().get("/sign-in?notice=signed_out_everywhere")).html).includes("You were signed out on every device."));
    check("this browser's session cookies are cleared", admin.browser.authCookieNames().length === 0);
    check("no session of the account is left in Auth", psql(`select count(*) from auth.sessions where user_id = '${admin.id}';`) === "0");
    check("the other device can't renew its session", !(await canRefresh(second)));
    check("its staff pages stop at once (they need a live session)", !staffWorks((await second.get("/admin/invitations")).html));
    const stillOpen = await second.get("/collection");
    check("its ordinary pages stop at once too (since the session-revocation checkpoint)", streamedRedirectTo(stillOpen.html, "/sign-in") || location(stillOpen.response).startsWith("/sign-in"), `${stillOpen.response.status} ${location(stillOpen.response)}`);
    expire(second);
    check("and once its token expires it stays signed out", location((await second.get("/collection")).response).startsWith("/sign-in"));
    const evilUser = await person();
    const evilPage = await evilUser.browser.get("/settings/account");
    const evil = await evilUser.browser.submit("/settings/account", { hidden: formHidden(evilPage, "Sign out on all devices") }, {}, { origin: "https://evil.example" });
    check("signing out everywhere from another site is refused", !isRedirect(evil.response) && sessions(evilUser.id) >= 1 && evilUser.browser.authCookieNames().length > 0);
  }
} catch (error) {
  check(`the checks ran to the end (${error.message})`, false);
} finally {
  stopApp();
  await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'pw\\_%';");
  check("no handle holds are left behind", psql("select count(*) from private.handle_holds where handle like 'pw\\_%';") === "0");
  check("no test account is left behind", psql("select count(*) from auth.users where email like 'apppw-%';") === "0");
}

/** The hidden fields of the form whose button says `label`. */
function formHidden(page, label) {
  const forms = [...page.html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)];
  const form = forms.find(([, inner]) => visible(inner).trim().endsWith(label) || visible(inner).includes(`${label}`) && !/name="(current_password|email)"/.test(inner));
  const hidden = {};
  for (const [input] of (form?.[1] ?? "").matchAll(/<input\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(input)?.[1];
    if (name && /type="hidden"/.test(input)) hidden[decode(name)] = decode(/\bvalue="([^"]*)"/.exec(input)?.[1] ?? "");
  }
  return hidden;
}

// Expected: the cross-site posts, and renewing sessions this suite ended on purpose.
const expected = /Invalid Server Actions request|Invalid Refresh Token: Refresh Token Not Found|__isAuthError: true/;
check("the app logged the cross-site refusals", expected.test(appLog()));
const errorLines = appErrorLines(expected);
check("the app logged no other errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
