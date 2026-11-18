/**
 * M11a-1 app checks: /admin/invitations and an invitee's onboarding, driven through the
 * built app over HTTP as a browser without JavaScript would, against a local stack with
 * Mailpit. The app gets the stack's secret key from the harness, as a server would.
 *
 *   npm run build && npm run test-stack:run -- app:invitation-checks
 *
 * Destructive, so it refuses a protected development stack. Throwaway accounts only;
 * nothing printed contains a token, key, password or address.
 */
import { randomBytes } from "node:crypto";

import { Browser, check, createUser, decode, deleteUsers, formWith, forms, location, psql, readSession, results, section, signInAs, startApp, stopApp, streamedRedirectTo } from "./app-harness.mjs";
import { decodeClaims } from "./lib/mfa-session.mjs";
import { stackStatus } from "./lib/stack.mjs";

const stack = stackStatus({ label: "the invitation app checks" });
const mailpit = stack.MAILPIT_URL;
await startApp(3299);
const tag = randomBytes(3).toString("hex");
const address = (name) => `appinv-${tag}-${name}@example.test`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function person(role = null) {
  const user = await createUser({ prefix: "appinv", mfa: Boolean(role) });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `ai_${randomBytes(5).toString("hex")}` });
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { ...user, browser };
}
const sessionOf = (p) => decodeClaims(readSession(p.browser).session.access_token).session_id;
const stale = (p) => psql(`update auth.mfa_amr_claims set updated_at = now() - interval '11 minutes', created_at = now() - interval '11 minutes' where session_id = '${sessionOf(p)}';`);
const visible = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const unavailable = (html) => /This page isn(&#x27;|')t available/.test(html);

/** The path of the newest invitation link sent to an address after `after`. Never printed. */
async function inviteLink(email, after) {
  for (let i = 0; i < 60; i += 1) {
    const r = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages = [] } = r.ok ? await r.json() : {};
    for (const m of messages.filter((x) => Date.parse(x.Created) >= after - 2000)) {
      const body = await (await fetch(`${mailpit}/api/v1/message/${m.ID}`)).json();
      const link = /href="[^"]*(\/auth\/confirm\?token_hash=[A-Za-z0-9_-]+&(?:amp;)?type=invite)"/.exec(`${body.HTML}`);
      if (link) return link[1].replace(/&amp;/g, "&");
    }
    await pause(250);
  }
  return null;
}
async function createFromPage(admin, email, reason = "App checks") {
  const page = await admin.browser.get("/admin/invitations");
  const sent = Date.now();
  const res = await admin.browser.submit("/admin/invitations", formWith(page.html, "email"), { email, reason });
  return { res, sent };
}
const confirmed = (email) => psql(`select coalesce((select (email_confirmed_at is not null)::text from auth.users where lower(email) = '${email}'), 'none');`);

try {
  const admin = await person("admin");
  const moderator = await person("moderator");
  const collector = await person();

  section("Who reaches /admin/invitations");
  {
    const page = await admin.browser.get("/admin/invitations");
    check("an administrator opens the invitations page", page.response.status === 200 && visible(page.html).includes("Invite someone"));
    check("the admin navigation lists Invitations for administrators", /<nav aria-label="Admin sections">[\s\S]*?href="\/admin\/invitations"/.test(page.html));
    check("a moderator gets the unavailable page", unavailable((await moderator.browser.get("/admin/invitations")).html));
    check("and so does a collector", unavailable((await collector.browser.get("/admin/invitations")).html));
    check("a moderator's navigation has no Invitations", !/href="\/admin\/invitations"/.test((await moderator.browser.get("/admin")).html));
  }

  section("Inviting, then onboarding");
  const email = address("first");
  const { res, sent } = await createFromPage(admin, email);
  check("submitting the form redirects back with the generic notice", location(res.response) === "/admin/invitations?notice=invited", location(res.response));
  const link = await inviteLink(email, sent);
  check("Mailpit receives an email linking to the app's confirmation page", Boolean(link));
  const invitee = new Browser();
  const confirm = await invitee.get(link);
  check("opening the link shows a button to accept, and nothing else happens", confirm.response.status === 200 && visible(confirm.html).includes("Accept the invitation"));
  check("the GET didn't use the token: the address isn't confirmed yet", confirmed(email) === "false");
  check("the page asks browsers not to send the link on as a referrer", /<meta name="referrer" content="no-referrer"/.test(confirm.html));
  const accepted = await invitee.submit(link, formWith(confirm.html, "token_hash"));
  check("accepting (the POST) verifies it and goes to the password step", location(accepted.response) === "/welcome/password", location(accepted.response));
  check("now the address is confirmed", confirmed(email) === "true");
  {
    // The redirect happens inside the page's streamed section, so it can arrive either way.
    const w = await invitee.get("/welcome");
    check("the handle page sends the invitee to set a password first", location(w.response).startsWith("/welcome/password") || streamedRedirectTo(w.html, "/welcome/password"));
  }
  {
    const page = await invitee.get("/welcome/password");
    check("the password page has a labelled new-password form", page.response.status === 200 && /<label[^>]*for="password"/.test(page.html) && /autocomplete="new-password"/i.test(page.html));
    const short = await invitee.submit("/welcome/password", formWith(page.html, "password"), { password: "short", confirm: "short" });
    check("a short password is refused, and the invitee stays on the page", short.response.status === 200 && !location(short.response));
    const pass = `App-${randomBytes(12).toString("base64url")}`;
    const set = await invitee.submit("/welcome/password", formWith(page.html, "password"), { password: pass, confirm: pass });
    check("a good password is set and recorded, then on to the handle", location(set.response) === "/welcome", location(set.response));
    check("the marker is recorded once", psql(`select count(*) from private.account_invitations where email = '${email}' and password_set_at is not null;`) === "1");
    const welcome = await invitee.get("/welcome");
    const handle = `ai_${randomBytes(5).toString("hex")}`;
    const claimed = await invitee.submit("/welcome", formWith(welcome.html, "handle"), { handle });
    check("the invitee chooses a handle with the existing form and reaches the app", location(claimed.response) === "/home", location(claimed.response));
    check("and can open their collection", (await invitee.get("/collection")).response.status === 200);
    check("the confirmation link can't be used again", location((await invitee.submit(link, formWith(confirm.html, "token_hash"))).response) === "/auth/confirm?status=invalid");
  }
  {
    const page = await admin.browser.get("/admin/invitations");
    const text = visible(page.html);
    check("the list shows the invitee as joined, the address masked", text.includes("Joined") && text.includes("a***@e***.test"));
    check("no address appears on the page", !page.html.includes(`appinv-${tag}`));
  }

  section("Links that can't be used");
  for (const [label, path] of [["a malformed token", "/auth/confirm?token_hash=x&type=invite"], ["another link type", "/auth/confirm?token_hash=abcdefghijklmnop&type=magiclink"], ["no token", "/auth/confirm"]]) {
    check(`${label} gets the generic page`, visible((await new Browser().get(path)).html).includes("This link can't be used"));
  }

  section("Resending and revoking from the page");
  {
    const second = address("second");
    const made = await createFromPage(admin, second);
    const secondLink = await inviteLink(second, made.sent);
    const id = psql(`select id from private.account_invitations where email = '${second}';`);
    let page = await admin.browser.get("/admin/invitations");
    check("a fresh invitation offers no resend for 10 minutes", visible(page.html).includes("It can be resent after"));
    psql(`update private.account_invitations set last_sent_at = now() - interval '11 minutes' where id = '${id}';`);
    page = await admin.browser.get("/admin/invitations");
    // Each invitation's forms come in page order: resend (when offered), then revoke.
    const resend = forms(page.html).filter((f) => f.hidden.invitation_id === id)[0];
    const resent = await admin.browser.submit("/admin/invitations", resend, { reason: "Lost the email" });
    check("after 10 minutes it can be resent from the page", location(resent.response) === "/admin/invitations?notice=resent", location(resent.response));
    const fresh = await inviteLink(second, Date.now() - 4000);
    check("a new link is sent", Boolean(fresh) && fresh !== secondLink);
    const oldTab = new Browser();
    const oldPage = await oldTab.get(secondLink);
    check("and the old link stops working", location((await oldTab.submit(secondLink, formWith(oldPage.html, "token_hash"))).response) === "/auth/confirm?status=invalid");
    page = await admin.browser.get("/admin/invitations");
    const revokeForm = forms(page.html).filter((f) => f.hidden.invitation_id === id).at(-1);
    const revoked = await admin.browser.submit("/admin/invitations", revokeForm, { reason: "Wrong address" });
    check("revoking from the page bans the invitee and confirms it", location(revoked.response) === "/admin/invitations?notice=revoked", location(revoked.response));
    const b = new Browser();
    const p = await b.get(fresh);
    check("the revoked invitation's link no longer works", location((await b.submit(fresh, formWith(p.html, "token_hash"))).response) === "/auth/confirm?status=invalid");
    check("the account still exists: nothing was deleted", psql(`select count(*) from auth.users where lower(email) = '${second}';`) === "1");
    check("the list shows it as revoked", visible((await admin.browser.get("/admin/invitations")).html).includes("Revoked"));
  }

  section("An address with an account looks like any other on the page (M11a-2)");
  {
    // The collector's address has an account; the other has none. Same reason, same page.
    const other = address("parity");
    const before = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${collector.email}"`)}`).then((r) => r.json());
    const timed = async (email) => {
      const t0 = performance.now();
      const made = await createFromPage(admin, email, "Parity");
      return { ...made, ms: performance.now() - t0 };
    };
    const known = await timed(collector.email);
    const unknown = await timed(other);
    check("both are answered with the same notice", location(known.res.response) === "/admin/invitations?notice=invited" && location(unknown.res.response) === location(known.res.response),
      `${location(known.res.response)} ${location(unknown.res.response)}`);
    console.log(`     time to answer: address with an account ${known.ms.toFixed(0)} ms, without ${unknown.ms.toFixed(0)} ms`);
    check("both take at least the 2-second floor, within 250 ms of each other", known.ms >= 2000 && unknown.ms >= 2000 && Math.abs(known.ms - unknown.ms) < 250);
    check("the address without an account gets its email", Boolean(await inviteLink(other, unknown.sent)));
    await pause(1000);
    const after = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${collector.email}"`)}`).then((r) => r.json());
    check("the account's address gets none", (after.messages ?? []).length === (before.messages ?? []).length);
    const page = await admin.browser.get("/admin/invitations");
    const ids = psql(`select string_agg(id::text, ',' order by email = '${other}') from private.account_invitations where email in ('${collector.email.toLowerCase()}', '${other}') and reason = 'Parity';`).split(",");
    // Each list item, without its masked address and times.
    const item = (id) => {
      const start = page.html.lastIndexOf("<li", page.html.indexOf(id));
      const end = page.html.indexOf("</li>", page.html.indexOf(id));
      return visible(page.html.slice(start, end)).replace(/\S+\*\*\*@\S+/g, "").replace(/\d/g, "#");
    };
    check("and the two list entries read the same", ids.length === 2 && item(ids[0]) === item(ids[1]), `${item(ids[0])} | ${item(ids[1])}`);
  }

  section("A stale verification asks for a new one, and nothing is replayed");
  {
    stale(admin);
    const third = address("third");
    const { res: r } = await createFromPage(admin, third);
    check("creating with an 11-minute-old verification goes to verify, then back to the page", location(r.response) === "/settings/security/verify?next=%2Fadmin%2Finvitations", location(r.response));
    check("and records nothing", psql(`select count(*) from private.account_invitations where email = '${third}';`) === "0");
  }
} catch (error) {
  check(`the checks ran to the end (${error.message})`, false);
} finally {
  stopApp();
  psql(`delete from private.account_invitations where email like 'appinv-${tag}-%' or reason = 'Parity';`);
  const ids = psql(`select string_agg(id::text, ',') from auth.users where email like 'appinv-${tag}-%';`).split(",").filter(Boolean);
  const key = stack.SECRET_KEY ?? stack.SERVICE_ROLE_KEY;
  for (const id of ids) await fetch(`${stack.API_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: key, Authorization: `Bearer ${key}` } });
  await deleteUsers();
}

console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
