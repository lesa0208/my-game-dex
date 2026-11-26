/**
 * M16: a new collector's whole journey on the running demo preview (http://127.0.0.6:3006), in a
 * real browser (headless Edge or Chrome via playwright-core), through the app's own pages only:
 * sign up, confirm the email from the message in the demo's Mailpit, choose a handle, find and
 * add three real games (Super Mario World on the SNES, Sonic the Hedgehog on the Mega Drive,
 * Crash Bandicoot on the PlayStation), see them in the collection and on the system shelves, sign
 * out, sign back in, and find them again. No account is made or confirmed by any other route.
 *
 * Also: refused passwords and addresses, a second sign-up with the same address (same answer, the
 * account unchanged), signing in before confirming, a confirmation link opened by a plain GET (a
 * mail scanner) spending nothing, used, tampered and expired links, protected pages while signed
 * out, no staff role for a new account, and another new collector seeing none of it.
 *
 *   MGD_STACK=demo node scripts/app-sign-up-journey-checks.mjs   (npm run app:sign-up-journey-checks)
 *
 * The demo stack and its running preview only. Its accounts are disposable ("journey-…@example.test")
 * and removed at the end with their copies; to make one link expire, the database's own record of
 * when that disposable account's link was sent is moved back two hours. Nothing else is written,
 * and the demo catalog is checked to be exactly as it was. Prints check names, never a password,
 * token, link or cookie.
 */
import { randomBytes } from "node:crypto";

import { chromium } from "playwright-core";

import { footprint } from "./lib/footprint.mjs";
import { projectId, stackName, stackStatus } from "./lib/stack.mjs";

if (stackName !== "demo" || projectId !== "my-game-dex-demo") {
  console.error("Refusing: run on the demo stack (MGD_STACK=demo).");
  process.exit(2);
}
const ORIGIN = process.env.DEMO_ORIGIN ?? "http://127.0.0.6:3006";
const status = stackStatus({ label: "the sign-up journey checks" });
const MAILPIT = status.MAILPIT_URL ?? status.INBUCKET_URL ?? "http://127.0.0.1:59324";
const API = status.API_URL;
const SERVICE = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
const { execFileSync } = await import("node:child_process");
const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_my-game-dex-demo", "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" }).trim();

const results = { passed: 0, failed: 0 };
function check(name, ok, detail = "") {
  if (ok) results.passed += 1;
  else results.failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}
const section = (title) => console.log(`\n${title}`);
const TAG = randomBytes(4).toString("hex");
const email = (who) => `journey-${TAG}-${who}@example.test`;
const password = () => `Journey ${randomBytes(9).toString("base64url")} shelf`;
const CATALOG = ["public.games", "public.game_platforms", "public.releases", "public.game_aliases"];
const startingCatalog = footprint(psql, CATALOG);
let browser;

async function eventually(condition, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await condition().catch(() => false)) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The newest confirmation email to an address, from the demo's Mailpit: its subject and its link. */
async function confirmationMail(address, { after = 0, wait = 20000 } = {}) {
  const until = Date.now() + wait;
  while (Date.now() < until) {
    const found = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)).json();
    const fresh = (found.messages ?? []).filter((m) => Date.parse(m.Created) > after).sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created));
    if (fresh.length) {
      const message = await (await fetch(`${MAILPIT}/api/v1/message/${fresh[0].ID}`)).json();
      const href = /href="([^"]*\/auth\/confirm\?[^"]*)"/.exec(message.HTML ?? "")?.[1]?.replace(/&amp;/g, "&");
      return { subject: message.Subject, link: href ? new URL(href) : null, count: fresh.length };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

const mailCount = async (address) => ((await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)).json()).messages ?? []).length;
const mainText = async (page) => (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
const visible = (page, selector) => page.locator(`${selector}:visible`);

async function signUpVia(page, address, pass, confirm = pass) {
  await page.goto(`${ORIGIN}/sign-up`, { waitUntil: "networkidle" });
  await page.fill("#email", address);
  await page.fill("#password", pass);
  await page.fill("#confirm", confirm);
  await page.getByRole("button", { name: "Create account" }).click();
}

async function signInVia(page, address, pass) {
  await page.goto(`${ORIGIN}/sign-in`, { waitUntil: "networkidle" });
  await page.fill("#email", address);
  await page.fill("#password", pass);
  await page.locator('main button[type="submit"]').click();
}

/** Adds a copy as a collector does: the header search, the result, the platform if asked, a region, Add. */
async function addGame(page, { query, title, platform, region }) {
  await page.locator('header input[type="search"]').fill(query);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/explore\?/);
  const result = page.locator("main [data-game-card] h3 a:visible").filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first();
  await result.waitFor({ timeout: 15000 });
  await result.click();
  await page.waitForURL(/\/games\//);
  const regions = page.getByRole("navigation", { name: "Region", exact: true });
  if (!(await eventually(async () => (await regions.count()) === 1, 3000))) {
    await page.getByRole("navigation", { name: "Platform", exact: true }).getByRole("link", { name: new RegExp(`^${platform}\\b`) }).first().click();
  }
  await regions.getByRole("link", { name: region, exact: true }).first().click();
  const add = page.locator("main").getByRole("button", { name: /^Add to collection$/ }).first();
  await eventually(async () => (await add.count()) === 1);
  await add.click();
  return eventually(async () => (await visible(page, 'main [role="status"]').filter({ hasText: "Added" }).count()) > 0);
}

const made = [];
try {
  for (const channel of process.env.A11Y_BROWSER ? [process.env.A11Y_BROWSER] : ["msedge", "chrome"]) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // Try the next one.
    }
  }
  if (!browser) throw new Error("Needs Microsoft Edge or Google Chrome installed.");
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" })).newPage();
  const alexEmail = email("alex");
  const alexPassword = password();
  made.push(alexEmail);

  section("1-3. A signed-out visitor finds Sign up, and registers");
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
  check("the app's header offers Sign up to a signed-out visitor", (await page.getByRole("link", { name: "Sign up" }).count()) >= 1);
  await page.getByRole("link", { name: "Sign up" }).first().click();
  await page.waitForURL(/\/sign-up$/);
  check("it opens the sign-up page", (await mainText(page)).includes("Create an account"));
  check(
    "which states the password rule and links back to sign in",
    await eventually(async () => (await mainText(page)).includes("At least 12 characters") && (await page.locator("main").getByRole("link", { name: "Sign in", exact: true }).count()) >= 1),
    (await mainText(page)).slice(0, 300),
  );
  const sentAt = Date.now() - 2000;
  await page.fill("#email", alexEmail);
  await page.fill("#password", alexPassword);
  await page.fill("#confirm", alexPassword);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/sign-up\?status=sent/);
  check("after submitting: check your email, and nothing about whether the address had an account", (await mainText(page)).includes("Check your email") && (await mainText(page)).includes("If this address can be used for a new account"));

  section("4. The confirmation email, in the demo's Mailpit");
  const mail = await confirmationMail(alexEmail, { after: sentAt });
  check("Mailpit receives the confirmation email", mail?.subject === "Confirm your My Game Dex account", mail?.subject ?? "none");
  check("its link goes to the app's confirmation page, on the demo preview", mail?.link?.origin === ORIGIN && mail.link.pathname === "/auth/confirm" && mail.link.searchParams.get("type") === "email");

  section("Before confirming");
  await signInVia(page, alexEmail, alexPassword);
  check("signing in before confirming is refused, asking to confirm the email", await eventually(async () => (await mainText(page)).includes("Confirm your email with the link we sent")));
  const scanned = await fetch(mail.link.href, { redirect: "manual" });
  const scannedBody = await scanned.text();
  check("a plain GET of the link (a mail scanner) only shows a button", scanned.status === 200 && scannedBody.includes("Confirm my email"));

  section("5. Confirming, and choosing a handle");
  await page.goto(mail.link.href, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Confirm my email" }).click();
  await page.waitForURL(/\/welcome/);
  check("confirming signs the new collector in and asks for a handle", (await mainText(page)).toLowerCase().includes("handle"));
  const handle = `jr${TAG}`;
  await page.locator('main input[name="handle"]').fill(handle);
  await page.locator('main form:has(input[name="handle"]) button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/welcome"));
  check("with a handle, they reach the app", new URL(page.url()).pathname === "/home", page.url());
  const alexId = psql(`select id from auth.users where email = '${alexEmail}';`);
  check("an ordinary collector: confirmed, with a profile and the handle, and no staff role", psql(`select (u.email_confirmed_at is not null)::text || '/' || p.handle || '/' || (select count(*) from public.staff_roles s where s.user_id = u.id) from auth.users u join public.profiles p on p.id = u.id where u.id = '${alexId}';`) === `true/${handle}/0`);
  const admin = await page.goto(`${ORIGIN}/admin`, { waitUntil: "networkidle" });
  check("and the admin area isn't theirs", admin.status() === 404 || !(await mainText(page)).includes("Catalog"), String(admin.status()));

  section("6-11. Three real games, three platforms");
  await page.goto(`${ORIGIN}/home`, { waitUntil: "networkidle" });
  check("Super Mario World, a Super Nintendo copy", await addGame(page, { query: "super mario world", title: "Super Mario World", platform: "Super Nintendo", region: "NTSC-U/C" }));
  check("Sonic the Hedgehog, a Mega Drive copy", await addGame(page, { query: "sonic the hedgehog", title: "Sonic the Hedgehog", platform: "Mega Drive", region: "PAL" }));
  check("Crash Bandicoot, a PlayStation copy", await addGame(page, { query: "crash bandicoot", title: "Crash Bandicoot", platform: "PlayStation", region: "NTSC-U/C" }));
  const stored = psql(`select string_agg(p.slug || ':' || g.title, ',' order by p.slug) from public.collection_items c join public.platforms p on p.id = c.claimed_platform_id join public.games g on g.id = c.claimed_game_id where c.owner_id = '${alexId}';`);
  check("stored as the collector's own physical copies, on the right platforms", stored === "mega-drive:Sonic the Hedgehog,playstation:Crash Bandicoot,snes:Super Mario World", stored);

  section("12. My Collection");
  await page.goto(`${ORIGIN}/collection`, { waitUntil: "networkidle" });
  const collection = await mainText(page);
  check("My Collection lists all three", ["Super Mario World", "Sonic the Hedgehog", "Crash Bandicoot"].every((t) => collection.includes(t)));

  section("13. Systems and their shelves");
  await page.goto(`${ORIGIN}/collection/systems`, { waitUntil: "networkidle" });
  const systems = await mainText(page);
  check("Systems shows the SNES, the Mega Drive and the PlayStation", ["SNES", "Mega Drive", "PS1"].every((s) => systems.includes(s)), systems.slice(0, 200));
  for (const [slug, title] of [["snes", "Super Mario World"], ["mega-drive", "Sonic the Hedgehog"], ["playstation", "Crash Bandicoot"]]) {
    await page.goto(`${ORIGIN}/collection/systems/${slug}`, { waitUntil: "networkidle" });
    check(`the ${slug} shelf holds ${title}`, (await mainText(page)).includes(title));
  }

  section("14-16. Sign out, sign back in, the collection is still there");
  await page.goto(`${ORIGIN}/home`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).or(page.getByRole("button", { name: "Sign out" })).first().click();
  await page.waitForURL(/\/sign-in/);
  check("signing out ends the session", (await page.getByRole("link", { name: "Sign up" }).count()) >= 1);
  const guarded = await page.goto(`${ORIGIN}/collection`, { waitUntil: "networkidle" });
  check("a protected page sends a signed-out visitor to sign in", new URL(page.url()).pathname === "/sign-in" && guarded.ok());
  await signInVia(page, alexEmail, alexPassword);
  await page.waitForURL((u) => u.pathname === "/collection" || u.pathname === "/home");
  await page.goto(`${ORIGIN}/collection`, { waitUntil: "networkidle" });
  const again = await mainText(page);
  check("signed back in with the same email and password, all three copies are there", ["Super Mario World", "Sonic the Hedgehog", "Crash Bandicoot"].every((t) => again.includes(t)));
  await page.context().close();

  section("Refused passwords and addresses");
  const form = await (await browser.newContext()).newPage();
  const refused = async (address, pass, confirm, text) => {
    await signUpVia(form, address, pass, confirm);
    return eventually(async () => (await mainText(form)).includes(text), 8000);
  };
  const nobody = email("nobody");
  check("11 characters is too short", await refused(nobody, "eleven-char", "eleven-char", "Use at least 12 characters."));
  check("two different passwords", await refused(nobody, "a sound password one", "a sound password two", "The two passwords don't match."));
  check("more than 72 bytes is too long", await refused(nobody, "x".repeat(73), "x".repeat(73), "Use at most 72 bytes"));
  check("an address that isn't one", await refused("not-an-address", "a sound password here", "a sound password here", "Enter the email address you sign in with."));
  check("and none of them made an account", psql(`select count(*) from auth.users where email in ('${nobody}', 'not-an-address');`) === "0");

  section("The same address again");
  const before = await mailCount(alexEmail);
  await signUpVia(form, alexEmail, password());
  await form.waitForURL(/\/sign-up\?status=sent/);
  check("signing up again with a confirmed address gets the same answer as a new one", (await mainText(form)).includes("Check your email"));
  check("it makes no second account, and the first keeps its password", psql(`select count(*) from auth.users where email = '${alexEmail}';`) === "1");
  await signInVia(form, alexEmail, alexPassword);
  await form.waitForURL((u) => u.pathname === "/home");
  check("(the original password still signs in)", new URL(form.url()).pathname === "/home");
  check("and no new confirmation email is sent for it", (await mailCount(alexEmail)) === before);
  await form.context().close();

  section("Used, tampered and expired links");
  const reuse = await (await browser.newContext()).newPage();
  await reuse.goto(mail.link.href, { waitUntil: "networkidle" });
  await reuse.getByRole("button", { name: "Confirm my email" }).click();
  await reuse.waitForURL(/status=invalid/);
  check("a link already used can't be used again, and says what to do", (await mainText(reuse)).includes("This link can't be used") && (await mainText(reuse)).includes("sign up again"));
  const tampered = new URL(mail.link.href);
  tampered.searchParams.set("token_hash", `${tampered.searchParams.get("token_hash").slice(0, -4)}AAAA`);
  await reuse.goto(tampered.href, { waitUntil: "networkidle" });
  await reuse.getByRole("button", { name: "Confirm my email" }).click();
  await reuse.waitForURL(/status=invalid/);
  check("a tampered link is refused the same way", (await mainText(reuse)).includes("This link can't be used"));
  const late = email("late");
  made.push(late);
  const lateAt = Date.now() - 2000;
  await signUpVia(reuse, late, password());
  await reuse.waitForURL(/status=sent/);
  const lateMail = await confirmationMail(late, { after: lateAt });
  psql(`update auth.users set confirmation_sent_at = now() - interval '2 hours' where email = '${late}';`);
  await reuse.goto(lateMail.link.href, { waitUntil: "networkidle" });
  await reuse.getByRole("button", { name: "Confirm my email" }).click();
  await reuse.waitForURL(/status=invalid/);
  check("a link older than an hour is refused, and the account stays unconfirmed", (await mainText(reuse)).includes("This link can't be used") && psql(`select (email_confirmed_at is null)::text from auth.users where email = '${late}';`) === "true");
  await reuse.context().close();

  section("Another new collector sees none of it");
  const samEmail = email("sam");
  const samPassword = password();
  made.push(samEmail);
  const sam = await (await browser.newContext()).newPage();
  const samAt = Date.now() - 2000;
  await signUpVia(sam, samEmail, samPassword);
  await sam.waitForURL(/status=sent/);
  const samMail = await confirmationMail(samEmail, { after: samAt });
  await sam.goto(samMail.link.href, { waitUntil: "networkidle" });
  await sam.getByRole("button", { name: "Confirm my email" }).click();
  await sam.waitForURL(/\/welcome/);
  await sam.locator('main input[name="handle"]').fill(`js${TAG}`);
  await sam.locator('main form:has(input[name="handle"]) button[type="submit"]').click();
  await sam.waitForURL((u) => u.pathname === "/home");
  await sam.goto(`${ORIGIN}/collection`, { waitUntil: "networkidle" });
  const samCollection = await mainText(sam);
  check("their collection is empty: none of the first collector's games", !["Super Mario World", "Sonic the Hedgehog", "Crash Bandicoot"].some((t) => samCollection.includes(t)));
  const alexItem = psql(`select id from public.collection_items where owner_id = '${alexId}' limit 1;`);
  const foreign = await sam.goto(`${ORIGIN}/collection/${alexItem}`, { waitUntil: "networkidle" });
  check("the first collector's copy page is not found for them", foreign.status() === 404 || (await mainText(sam)).toLowerCase().includes("not found") || (await mainText(sam)).includes("isn't in your collection"), String(foreign.status()));
  await sam.goto(`${ORIGIN}/collection/systems/snes`, { waitUntil: "networkidle" });
  check("and their SNES shelf doesn't hold it", !(await mainText(sam)).includes("Super Mario World"));
  await sam.context().close();
} catch (error) {
  check("the checks ran to the end", false, String(error.message).split("\n")[0]);
} finally {
  await browser?.close();
  const ids = made.length ? psql(`select coalesce(string_agg(id::text, ','), '') from auth.users where email in (${made.map((m) => `'${m}'`).join(",")}) or email like 'journey-${TAG}-%@example.test';`).split(",").filter(Boolean) : [];
  if (ids.length) {
    const list = ids.map((id) => `'${id}'`).join(",");
    psql(`delete from public.collection_items where owner_id in (${list});`);
    for (const id of ids) await fetch(`${API}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    psql(`delete from private.handle_holds where kind = 'released' and handle like '%${TAG}';`);
    psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}); commit;`);
  }
  check("the disposable accounts are removed", psql(`select count(*) from auth.users where email like 'journey-${TAG}-%';`) === "0");
  check("the demo catalog is exactly as it was", footprint(psql, CATALOG) === startingCatalog);
}
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
