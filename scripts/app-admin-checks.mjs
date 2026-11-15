/**
 * M8d end-to-end checks: the unified /admin and Settings → Security in the built app,
 * driven over HTTP against the local stack, the way a browser without JavaScript
 * would. Every account has a real TOTP factor from local GoTrue and verifies it on the
 * app's own page. Outcomes are judged by the database and the pages rendered after.
 *
 *   npm run build && npm run app:admin-checks
 *
 * The Owner needs factors registered 24 hours ago (D13); as postgres the script records
 * them as 25 hours old (scripts/lib/test-owner.mjs), and refuses to run anywhere but
 * the local stack. Removes every account, Owner record, copy and the fixture at the
 * end. Prints check names and statuses, never keys, tokens, cookies or TOTP secrets.
 */
import { randomBytes } from "node:crypto";

import {
  api,
  appErrorLines,
  Browser,
  check,
  createUser,
  decode,
  deleteUsers,
  formWith,
  forms,
  location,
  psql,
  publishableKey,
  readSession,
  results,
  section,
  signInAs,
  startApp,
  stopApp,
  verifyBrowser,
} from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { addFactor, decodeClaims, reverify, totp } from "./lib/mfa-session.mjs";
import { matureFactors, removeTestOwner, requireNoOwner } from "./lib/test-owner.mjs";

requireNoOwner(psql, api);

const plain = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
/** What a visitor sees: the page's text, without scripts, which carry per-request data. */
const visible = (html) => plain(html.replace(/<script[\s\S]*?<\/script>/g, " "));
/** Where a page sends the browser: an HTTP redirect, or the one Next.js streams inside a Suspense boundary. */
const redirectsTo = (page) => location(page.response) || decode(/<meta[^>]+http-equiv="refresh"[^>]+content="\d+;\s*url=([^"]+)"/i.exec(page.html)?.[1] ?? "");
const NOT_AVAILABLE = "This page isn't available";
const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
function uuidv7(at = Date.now()) {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const people = [];
/** An account with a handle, signed in in its own browser; staff verify their factor on the app's page. */
async function person(role = null, { mfa = Boolean(role) } = {}) {
  const user = await createUser({ prefix: "adm", mfa });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const handle = `ad_${randomBytes(5).toString("hex")}`;
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle });
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  const p = { ...user, handle, browser };
  people.push(p);
  return p;
}
/** An aal2 session over the API for the user, with a second verified factor (for Owner candidates). */
async function secondFactor(user) {
  const signIn = await fetch(`${api}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  const aal2 = await reverify(api, publishableKey, { access_token: (await signIn.json()).access_token, factorId: user.factorId, totpSecret: user.totpSecret });
  await addFactor(api, publishableKey, aal2, "Backup key");
}
const sessionOf = (p) => decodeClaims(readSession(p.browser).session.access_token).session_id;
const stale = (p) => psql(`update auth.mfa_amr_claims set updated_at = now() - interval '11 minutes' where session_id = '${sessionOf(p)}';`);
const roles = (p) => psql(`select coalesce(string_agg(role::text, ',' order by role::text), '') from public.staff_roles where user_id = '${p.id}';`);
const statusOf = (p) => psql(`select account_status from public.profiles where id = '${p.id}';`);
const ownerId = () => psql("select coalesce((select user_id::text from private.platform_owner), 'none');");
/** Submits the page's form that has a hidden input with this value (a role, a user id, a transfer). */
async function submitFormWith(p, path, match, fields) {
  const page = await p.browser.get(path);
  const form = forms(page.html).find(match);
  if (!form) throw new Error(`no matching form on ${path}`);
  return p.browser.submit(path, form, fields);
}
/**
 * Every visible input, select and textarea on the page has a label tied to it, or an
 * accessible name (the header's search). The page's streamed content comes after
 * </main> in the HTML, so the whole document is checked, scripts aside.
 */
function labelled(page) {
  const html = page.replace(/<script[\s\S]*?<\/script>/g, "");
  const ids = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => decode(m[1])));
  return [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)]
    .filter(([, tag, attrs]) => !(tag === "input" && /\btype="hidden"/.test(attrs)))
    .every(([, , attrs]) => /\baria-label="[^"]+"/.test(attrs) || ids.has(decode(/\bid="([^"]+)"/.exec(attrs)?.[1] ?? "")));
}
/** The form that gives a role: a handle and a role to choose, not a removal (whose role is hidden). */
const grantForm = (html) => forms(html).find((f) => f.names.includes("handle") && f.names.includes("role"));
const oneHeading = (html) => (html.replace(/<script[\s\S]*?<\/script>/g, "").match(/<h1\b/g) ?? []).length === 1;

try {
  installFixture();
  await startApp(3297);

  // -------------------------------------------------------------------------
  section("1. The old review addresses redirect permanently (D10)");
  {
    const visitor = new Browser();
    const root = await visitor.get("/review");
    check("/review is a 308 to /admin/catalog", root.response.status === 308 && location(root.response) === "/admin/catalog", `${root.response.status} ${location(root.response)}`);
    const deep = await visitor.get("/review/merges/abc?notice=merged");
    check("a deeper address keeps its path and query", deep.response.status === 308 && location(deep.response) === "/admin/catalog/merges/abc?notice=merged", location(deep.response));
    const signedOut = await visitor.get("/admin");
    check("a visitor is sent to sign in from /admin", location(signedOut.response).includes("/sign-in?next=%2Fadmin"), location(signedOut.response));
  }

  const collector = await person();
  const editor = await person("catalog_editor");
  const moderator = await person("moderator");
  const admin = await person("admin");
  const owner = await person("admin");
  const heir = await person("admin");
  await secondFactor(owner);
  await secondFactor(heir);
  psql(`select private.assign_initial_owner('${owner.handle}', 'Admin checks: test owner');`);
  matureFactors(psql, owner.id);
  check("setup: a test Owner with two mature factors", ownerId() === owner.id && psql(`select private.mature_totp_factor_count('${owner.id}');`) === "2");
  // The owner signed in before their second factor; verifying again picks the first.
  await verifyBrowser(owner.browser, owner, "/admin");

  // -------------------------------------------------------------------------
  section("2. Who sees what (D8)");
  {
    const sections = ["/admin", "/admin/catalog", "/admin/accounts", "/admin/staff", "/admin/audit", "/admin/ownership"];
    for (const path of sections) {
      const page = await collector.browser.get(path);
      check(`a collector gets the unavailable page at ${path}`, plain(page.html).includes(NOT_AVAILABLE) && !page.html.includes("Admin sections"));
    }
    const allowed = { editor: ["/admin", "/admin/catalog"], moderator: ["/admin", "/admin/accounts"], admin: sections };
    for (const [name, who] of [["editor", editor], ["moderator", moderator], ["admin", admin]]) {
      for (const path of sections) {
        const page = await who.browser.get(path);
        const open = allowed[name].includes(path);
        check(`${name}: ${path} is ${open ? "open" : "unavailable"}`, open ? page.html.includes('aria-label="Admin sections"') : plain(page.html).includes(NOT_AVAILABLE) && !page.html.includes('aria-label="Admin sections"'));
      }
    }
    const nav = visible((await editor.browser.get("/admin")).html);
    check("an editor's admin sections are Overview and Catalog only", nav.includes("Catalog") && !/\bStaff\b|Audit log|Ownership/.test(nav.replace(/Admin sections/g, "")));
    const unverified = new Browser();
    const page = await unverified.get("/sign-in?next=%2Fadmin");
    const signedIn = await unverified.submit("/sign-in", formWith(page.html, "password"), { email: admin.email, password: admin.password });
    check("staff signing in with a password are asked for their authenticator next", location(signedIn.response) === "/settings/security/verify?next=%2Fadmin", location(signedIn.response));
    const aal1 = await unverified.get("/admin/staff");
    check("and at aal1, /admin sends them to verify rather than showing anything", redirectsTo(aal1).startsWith("/settings/security/verify?next=") && !visible(aal1.html).includes("Staff members"), redirectsTo(aal1));
    const back = await verifyBrowser(unverified, admin, "/admin/staff");
    check("verifying returns them to the page", location(back.response) === "/admin/staff");
    check("which then opens", visible((await unverified.get("/admin/staff")).html).includes("Staff members"));
  }

  // -------------------------------------------------------------------------
  section("3. Staff and the authority matrix, through the pages");
  {
    let page = await admin.browser.get("/admin/staff");
    const grant = grantForm(page.html);
    check("an admin's role choices leave out administrator", !/<option value="admin"/.test(page.html) && /<option value="moderator"/.test(page.html));
    check("an admin gets no remove form for their own role or the Owner's", !forms(page.html).some((f) => f.hidden.user_id === admin.id || f.hidden.user_id === owner.id));
    let res = await admin.browser.submit("/admin/staff", grant, { handle: collector.handle, role: "moderator", reason: "Admin checks grant" });
    check("an admin gives a collector the moderator role", location(res.response) === "/admin/staff?notice=granted" && roles(collector) === "moderator", location(res.response));
    res = await admin.browser.submit("/admin/staff", grant, { handle: collector.handle, role: "admin", reason: "Crafted" });
    check("a crafted admin grant is refused by the database, and says why", location(res.response) === "/admin/staff?error=owner_only" && roles(collector) === "moderator", location(res.response));
    page = await admin.browser.get("/admin/staff?error=owner_only");
    check("with a fixed message", visible(page.html).includes("Only the Owner can do this."));
    check("the refusal is audited", psql(`select count(*) from private.audit_events where actor_id = '${admin.id}' and action = 'staff_change_refused' and metadata ->> 'code' = 'owner_only';`) === "1");
    // A removal form for someone else, with its target changed to the admin themselves.
    const removal = forms(page.html).find((f) => "user_id" in f.hidden && "role" in f.hidden);
    res = await admin.browser.submit("/admin/staff", removal, { user_id: admin.id, role: "admin", reason: "Crafted" });
    check("a crafted removal of one's own role is refused (D7)", location(res.response).includes("error=") && roles(admin) === "admin", location(res.response));
    page = await owner.browser.get("/admin/staff");
    check("the Owner can choose administrator", /<option value="admin"/.test(page.html));
    res = await owner.browser.submit("/admin/staff", grantForm(page.html), { handle: collector.handle, role: "catalog_editor", reason: "Owner grant" });
    check("the Owner gives a role too", location(res.response) === "/admin/staff?notice=granted" && roles(collector) === "catalog_editor,moderator");
    res = await submitFormWith(owner, "/admin/staff", (f) => f.hidden.user_id === collector.id && f.hidden.role === "catalog_editor", { reason: "Not needed" });
    check("and removes it", location(res.response) === "/admin/staff?notice=revoked" && roles(collector) === "moderator");
    res = await submitFormWith(admin, "/admin/staff", (f) => f.hidden.user_id === collector.id && f.hidden.role === "moderator", { reason: "Back to collecting" });
    check("an admin removes a moderator role", location(res.response) === "/admin/staff?notice=revoked" && roles(collector) === "");
    const list = visible((await admin.browser.get("/admin/staff")).html);
    check("the staff list shows handles and roles, no emails", list.includes(`@${owner.handle}`) && list.includes("Owner") && !list.includes("@example.test"));
  }

  // -------------------------------------------------------------------------
  section("4. Accounts, by handle only (D11)");
  {
    let page = await moderator.browser.get(`/admin/accounts?handle=${collector.handle}`);
    check("a moderator finds a collector by handle", visible(page.html).includes(`@${collector.handle}`) && visible(page.html).includes("Suspend account"));
    let res = await moderator.browser.submit(`/admin/accounts?handle=${collector.handle}`, formWith(page.html, "reason"), { reason: "Spam reports" });
    check("and suspends them", location(res.response) === `/admin/accounts?handle=${collector.handle}&notice=suspended` && statusOf(collector) === "suspended", location(res.response));
    page = await moderator.browser.get(`/admin/accounts?handle=${collector.handle}`);
    res = await moderator.browser.submit(`/admin/accounts?handle=${collector.handle}`, formWith(page.html, "reason"), { reason: "Appeal accepted" });
    check("then reinstates them", res.response.status === 303 && statusOf(collector) === "active");
    page = await moderator.browser.get(`/admin/accounts?handle=${editor.handle}`);
    check("a moderator is offered nothing for a staff member", !forms(page.html).some((f) => "user_id" in f.hidden) && visible(page.html).includes("Only an administrator"));
    page = await moderator.browser.get(`/admin/accounts?handle=${owner.handle}`);
    check("nor for the Owner", !forms(page.html).some((f) => "user_id" in f.hidden) && visible(page.html).includes("protected"));
    // The suspension form for the collector, with its target changed to the Owner.
    const suspend = forms((await moderator.browser.get(`/admin/accounts?handle=${collector.handle}`)).html).find((f) => "user_id" in f.hidden);
    res = await moderator.browser.submit("/admin/accounts", suspend, { user_id: owner.id, status: "suspended", reason: "Crafted" });
    check("a crafted suspension of the Owner is refused and recorded as an Owner-protection refusal", location(res.response).includes("error=owner_protected") && statusOf(owner) === "active"
      && psql(`select count(*) from private.audit_events where actor_id = '${moderator.id}' and action = 'owner_protection_refused';`) === "1", location(res.response));
    page = await moderator.browser.get(`/admin/accounts?handle=${encodeURIComponent(collector.email)}`);
    check("an email finds nothing and isn't echoed", visible(page.html).includes("Enter a handle") && !page.html.includes(collector.email));
  }

  // -------------------------------------------------------------------------
  section("5. Step-up: fresh MFA for staff actions, never replayed");
  {
    stale(admin);
    const page = await admin.browser.get("/admin/staff");
    const res = await admin.browser.submit("/admin/staff", grantForm(page.html), { handle: collector.handle, role: "moderator", reason: "After step-up" });
    check("with a verification 11 minutes old, a grant sends the admin to verify", location(res.response) === "/settings/security/verify?next=%2Fadmin%2Fstaff", location(res.response));
    check("and changes nothing", roles(collector) === "" && psql(`select count(*) from private.audit_events where actor_id = '${admin.id}' and reason = 'After step-up';`) === "0");
    const verified = await verifyBrowser(admin.browser, admin, "/admin/staff");
    check("verifying returns to the staff page", location(verified.response) === "/admin/staff");
    check("without replaying the grant", roles(collector) === "");
    const again = await admin.browser.submit("/admin/staff", grantForm((await admin.browser.get("/admin/staff")).html), { handle: collector.handle, role: "moderator", reason: "After step-up" });
    check("submitting again grants it", location(again.response) === "/admin/staff?notice=granted" && roles(collector) === "moderator");
    const wrong = await admin.browser.submit("/settings/security/verify?next=%2Fadmin", formWith((await admin.browser.get("/settings/security/verify?next=%2Fadmin")).html, "code"), { code: "000000" });
    check("a wrong code is refused with a fixed message", location(wrong.response).includes("error=invalid_code"));
    const offsite = await admin.browser.get("/settings/security/verify?next=https%3A%2F%2Fevil.example");
    check("the verification page never sends anyone off the site", forms(offsite.html).every((f) => !f.hidden.next || f.hidden.next.startsWith("/")));
  }

  // -------------------------------------------------------------------------
  section("6. The audit log");
  {
    let page = await admin.browser.get("/admin/audit?action=staff_change_refused");
    check("an admin filters by action", visible(page.html).includes("Staff change refused") && visible(page.html).includes(`@${admin.handle}`));
    check("details are plain labels, with no ids or fingerprints", !UUIDS.test(visible(page.html)) && visible(page.html).includes("Refusal: owner_only"));
    page = await admin.browser.get(`/admin/audit?actor=${moderator.handle}&action=owner_protection_refused`);
    check("by who acted", visible(page.html).includes("Refused: Owner protected") && visible(page.html).includes(`about @${owner.handle}`));
    page = await admin.browser.get("/admin/audit?action=%27%3Bdrop");
    check("an unknown filter is refused, plainly", visible(page.html).includes("Check the filters"));
    page = await admin.browser.get("/admin/audit?from=2020-01-01&to=2026-12-31");
    check("as is a range over a year", visible(page.html).includes("Check the filters"));
    check("and the log shows no email", !(await admin.browser.get("/admin/audit")).html.includes("@example.test"));
  }

  // -------------------------------------------------------------------------
  section("7. Ownership: succession, transfer and stale authority");
  {
    let page = await owner.browser.get("/admin/ownership");
    check("the Owner sees the Owner's forms", visible(page.html).includes("Offer ownership") && visible(page.html).includes("Name successor"));
    check("another admin doesn't", !visible((await admin.browser.get("/admin/ownership")).html).includes("Offer ownership"));
    // In page order: offering ownership, then naming the successor.
    const [offerForm, successorForm] = forms(page.html).filter((f) => f.names.includes("handle"));
    let res = await owner.browser.submit("/admin/ownership", successorForm, { handle: heir.handle, reason: "Named successor" });
    check("the Owner names a successor", location(res.response) === "/admin/ownership?notice=successor_set" && psql("select successor_id from private.platform_owner;") === heir.id, location(res.response));
    const fingerprint = randomBytes(32).toString("hex");
    page = await owner.browser.get("/admin/ownership");
    res = await owner.browser.submit("/admin/ownership", formWith(page.html, "fingerprint"), { fingerprint, reason: "Signed document" });
    check("the Owner registers the succession document", location(res.response) === "/admin/ownership?notice=document_registered", location(res.response));
    page = await admin.browser.get("/admin/ownership");
    check("admins see the successor, and that a document is registered, never its fingerprint", visible(page.html).includes(`@${heir.handle}`) && visible(page.html).includes("Registered") && !page.html.includes(fingerprint));
    res = await owner.browser.submit("/admin/ownership", offerForm, { handle: heir.handle, reason: "Handing over" });
    check("the Owner offers ownership", location(res.response) === "/admin/ownership?notice=transfer_started" && psql("select count(*) from private.ownership_transfers where status = 'pending';") === "1", location(res.response));
    page = await heir.browser.get("/admin/ownership");
    check("the target sees the offer", visible(page.html).includes("Accept ownership"));
    stale(heir);
    res = await submitFormWith(heir, "/admin/ownership", (f) => "transfer_id" in f.hidden && !("as" in f.hidden), {});
    check("accepting with an old verification asks for a fresh one first", location(res.response) === "/settings/security/verify?next=%2Fadmin%2Fownership" && ownerId() === owner.id, location(res.response));
    await verifyBrowser(heir.browser, heir, "/admin/ownership");
    res = await submitFormWith(heir, "/admin/ownership", (f) => "transfer_id" in f.hidden && !("as" in f.hidden), {});
    check("then the target accepts", location(res.response) === "/admin/ownership?notice=transfer_accepted" && ownerId() === heir.id, location(res.response));
    check("the previous Owner stays an admin", roles(owner) === "admin");
    page = await owner.browser.get("/admin/ownership");
    check("the previous Owner's page no longer offers Owner actions", !visible(page.html).includes("Offer ownership"));
    // The offer form the previous Owner was shown before, submitted again from their session.
    res = await owner.browser.submit("/admin/ownership", offerForm, { handle: admin.handle, reason: "Stale" });
    check("a crafted form from the previous Owner's session gains nothing", !location(res.response).includes("notice=transfer_started") && psql("select count(*) from private.ownership_transfers where status = 'pending';") === "0", location(res.response));
    page = await heir.browser.get("/admin/ownership");
    check("the new Owner's authority waits for their factors to mature (D13)", visible(page.html).includes("two verified authenticator factors, each set up at least 24 hours ago"));
  }

  // -------------------------------------------------------------------------
  section("8. Settings → Security: real TOTP enrollment, maturity and removal");
  let secret = "";
  {
    const member = await person();
    let page = await member.browser.get("/settings/security");
    check("a member without a factor is offered to set one up", visible(page.html).includes("Set up an authenticator"));
    const enroll = formWith(page.html, "name");
    const started = await member.browser.submit("/settings/security", enroll, { name: "Phone" });
    // The enrollment's result comes back once, in the response the browser renders
    // with JavaScript: the QR code and the key, for this member only.
    const state = /\{\\?"status\\?":\\?"enrolled\\?",\\?"factorId\\?":\\?"([0-9a-f-]{36})\\?",\\?"qrCode\\?":\\?"(data:image\/svg\+xml[^"\\]*)[\s\S]*?\\?"secret\\?":\\?"([A-Z2-7]+)\\?"/.exec(started.html);
    const factorId = state?.[1] ?? "";
    secret = state?.[3] ?? "";
    check("enrolling returns a QR code and the setup key, once, to this response", Boolean(state) && secret.length >= 16 && /^[0-9a-f-]{36}$/.test(factorId));
    check("the key is in no cookie and no address", !member.browser.lastSetCookies.some((c) => c.includes(secret)) && !location(started.response).includes(secret));
    const before = psql("select extract(epoch from now())::bigint;");
    page = await member.browser.get("/settings/security");
    check("the page doesn't show the key again", !page.html.includes(secret));
    // Finishing without JavaScript: the unverified factor's form on the Security page.
    const finish = forms(page.html).find((f) => f.hidden.factor_id === factorId && f.names.includes("code"));
    const done = await member.browser.submit("/settings/security", finish, { code: totp(secret) });
    check("verifying the first code adds it", location(done.response) === "/settings/security?notice=verified" && psql(`select status from auth.mfa_factors where id = '${factorId}';`) === "verified", location(done.response));
    check("and registers it at the server's time (D13)", psql(`select (extract(epoch from registered_at)::bigint between ${before} and ${before} + 60)::text from private.mfa_factor_registrations where factor_id = '${factorId}';`) === "true");
    page = await member.browser.get("/settings/security");
    check("the page shows it as not mature yet", visible(page.html).includes("counts for Owner authority in about 24 hours") && !page.html.includes(secret));
    const again = new Browser();
    const signIn = await again.get("/sign-in");
    const out = await again.submit("/sign-in", formWith(signIn.html, "password"), { email: member.email, password: member.password });
    check("signing in afterwards asks for the authenticator", location(out.response).startsWith("/settings/security/verify"));
    const wrong = await member.browser.submit("/settings/security", formWith(page.html, "confirm") ?? forms(page.html).find((f) => "factor_id" in f.hidden), {});
    check("removing needs the confirmation box", location(wrong.response).includes("error=confirm_removal") && psql(`select count(*) from auth.mfa_factors where id = '${factorId}';`) === "1");
    const removed = await member.browser.submit("/settings/security", forms(page.html).find((f) => f.hidden.factor_id === factorId), { confirm: "yes" });
    check("a member removes their factor", location(removed.response) === "/settings/security?notice=removed" && psql(`select count(*) from auth.mfa_factors where id = '${factorId}';`) === "0", location(removed.response));
    page = await editor.browser.get("/settings/security");
    const last = await editor.browser.submit("/settings/security", forms(page.html).find((f) => "factor_id" in f.hidden), { confirm: "yes" });
    check("staff can't remove their last factor here", location(last.response).includes("error=last_factor") && psql(`select count(*) from auth.mfa_factors where user_id = '${editor.id}' and status = 'verified';`) === "1", location(last.response));
  }

  // -------------------------------------------------------------------------
  section("9. Recovery in the app: the target confirms, the Owner cancels");
  {
    const recovery = psql(`select private.begin_owner_recovery('reassign', '${admin.handle}', 'Admin checks R1');`);
    let page = await admin.browser.get("/settings/security");
    check("the recovery's target is asked to confirm it", visible(page.html).includes("An ownership recovery names you"));
    let res = await submitFormWith(admin, "/settings/security", (f) => f.hidden.recovery_id === recovery, {});
    check("and confirms it", location(res.response) === "/settings/security?notice=recovery_confirmed" && psql(`select confirmed_at is not null from private.owner_recoveries where id = '${recovery}';`) === "t", location(res.response));
    page = await moderator.browser.get("/admin");
    check("every staff member sees that a recovery is in progress", visible(page.html).includes("An ownership recovery is in progress"));
    page = await heir.browser.get("/admin/ownership");
    res = await submitFormWith(heir, "/admin/ownership", (f) => f.hidden.recovery_id === recovery, { reason: "I am here" });
    check("the Owner cancels it", location(res.response) === "/admin/ownership?notice=recovery_cancelled" && psql(`select status || '/' || cancelled_by_owner from private.owner_recoveries where id = '${recovery}';`) === "cancelled/true", location(res.response));
    check("and ownership is unchanged", ownerId() === heir.id);
  }

  // -------------------------------------------------------------------------
  section("10. No Owner bypass, and nothing private on admin pages");
  {
    const us = psql("select id from public.releases where product_code = 'SNS-ZSFE-USA';");
    const response = await fetch(`${api}/rest/v1/rpc/add_collection_item`, {
      method: "POST",
      headers: { apikey: publishableKey, Authorization: `Bearer ${readSession(collector.browser).session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_item_id: uuidv7(), p_release: us, p_details: { purchase_price: "41.17", currency: "EUR", notes: "Private note QXZ", storage_location: "Shelf Q" } }),
    });
    check("setup: a collector records a copy with private details", response.ok, `status ${response.status}`);
    const token = readSession(heir.browser).session.access_token;
    const read = async (path, profile) => (await (await fetch(`${api}/rest/v1/${path}`, { headers: { apikey: publishableKey, Authorization: `Bearer ${token}`, ...(profile ? { "Accept-Profile": profile } : {}) } })).text());
    const items = await read(`collection_items?select=id&owner_id=eq.${collector.id}`);
    const privateRows = await read(`collection_item_private?select=purchase_price`);
    check("the Owner can't read another member's collection", items === "[]", items.slice(0, 80));
    check("or their purchase details", !privateRows.includes("41.17"), privateRows.slice(0, 80));
    const pages = ["/admin", "/admin/staff", `/admin/accounts?handle=${collector.handle}`, "/admin/audit", "/admin/ownership", "/admin/catalog", "/settings/security"];
    for (const path of pages) {
      const page = await heir.browser.get(path);
      const text = page.html;
      check(`${path}: no email, purchase detail, private note or TOTP secret`, !text.includes("@example.test") && !text.includes("41.17") && !text.includes("Private note QXZ") && !text.includes(secret || "no-secret") && !/totp_secret|"secret"/.test(text));
      check(`${path}: every field is labelled, one main heading`, labelled(text) && oneHeading(text));
    }
  }

  const errors = appErrorLines();
  check("the app logged no errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  stopApp();
  removeTestOwner(psql);
  const ids = await deleteUsers();
  const list = ids.map((id) => `'${id}'`).join(",") || "null";
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ad\\_%';");
  removeFixture();
  check("no account, Owner record, transfer, recovery, registration or audit row is left behind",
    psql(`select (select count(*) from auth.users where id in (${list})) + (select count(*) from private.platform_owner) + (select count(*) from private.ownership_transfers)
      + (select count(*) from private.owner_recoveries) + (select count(*) from private.mfa_factor_registrations where user_id in (${list}))
      + (select count(*) from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}));`) === "0");
}

console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
