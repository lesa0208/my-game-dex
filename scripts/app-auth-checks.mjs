/**
 * M6a end-to-end checks: the built app's sign-in, session, handle claim, protected
 * pages and sign-out, driven over HTTP against the local Supabase stack. Forms are
 * submitted the way a browser without JavaScript would, which exercises the real
 * proxy, pages and Server Actions.
 *
 *   npm run build && npm run app:auth-checks
 *
 * Local only. Starts `next start` on a spare port with the local stack's URL and
 * publishable key. Prints check names and statuses, never keys, tokens or cookies.
 * Test users are created through the local Auth admin API and deleted at the end.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const status = JSON.parse(execFileSync(process.execPath, [cli, "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const api = status.API_URL;
const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const serviceKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
if (!api || !publishableKey || !serviceKey) {
  console.error("Couldn't read the local stack's status. Is it running? Try npm run db:start.");
  process.exit(1);
}
const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

// The checks run against the production build, so it must exist and be newer than
// every source file. Otherwise they would test old code.
function newestSource(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs);
  }
  return newest;
}
const buildId = join(root, ".next", "BUILD_ID");
if (!existsSync(buildId)) {
  console.error("No production build found. Run npm run build first.");
  process.exit(1);
}
if (statSync(buildId).mtimeMs < newestSource(join(root, "src"))) {
  console.error("The production build is older than the source. Run npm run build first.");
  process.exit(1);
}

const port = 3210;
const origin = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
  cwd: root,
  // `next start` serves the production build, with NODE_ENV=production.
  env: { ...process.env, NODE_ENV: "production", SUPABASE_URL: api, SUPABASE_PUBLISHABLE_KEY: publishableKey, ENABLE_SEED_DATA: "false" },
  stdio: ["ignore", "ignore", "pipe"],
});
let appErrors = "";
app.stderr.on("data", (chunk) => (appErrors += chunk.toString()));

async function waitForApp() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${origin}/explore`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The app didn't start. Run npm run build first.");
}

/** A browser-like client: a cookie jar, no JavaScript, redirects followed by hand. */
class Browser {
  constructor() {
    this.cookies = new Map();
    this.lastSetCookies = [];
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  store(response) {
    this.lastSetCookies = response.headers.getSetCookie();
    for (const line of this.lastSetCookies) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = /max-age=0\b/i.test(line) || /expires=thu, 01 jan 1970/i.test(line);
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async get(path) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual", headers: { cookie: this.cookieHeader() } });
    this.store(response);
    return { response, html: (await response.text()).replace(/<!-- -->/g, "") };
  }

  /** Submits a form from a page's HTML, as a browser would without JavaScript. */
  async submit(path, form, fields, headers = {}) {
    const body = new FormData();
    for (const [name, value] of Object.entries({ ...form.hidden, ...fields })) body.append(name, value);
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: this.cookieHeader(), origin, ...headers },
      body,
    });
    this.store(response);
    return { response, html: (await response.text()).replace(/<!-- -->/g, "") };
  }

  authCookieNames() {
    return [...this.cookies.keys()].filter((name) => name.startsWith("sb-"));
  }
}

const decode = (value) =>
  value.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Every form on a page, with its hidden inputs and the names of its other inputs. */
function forms(html) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(([, attributes, inner]) => {
    const hidden = {};
    const names = [];
    for (const [input] of inner.matchAll(/<input\b[^>]*>/g)) {
      const name = /\bname="([^"]*)"/.exec(input)?.[1];
      if (!name) continue;
      const decoded = decode(name);
      if (/\btype="hidden"/.test(input)) hidden[decoded] = decode(/\bvalue="([^"]*)"/.exec(input)?.[1] ?? "");
      else names.push(decoded);
    }
    return { id: /\bid="([^"]*)"/.exec(attributes)?.[1] ?? null, hidden, names };
  });
}
const formWith = (html, name) => forms(html).find((form) => form.names.includes(name) || name in form.hidden);
const formById = (html, id) => forms(html).find((form) => form.id === id);
const location = (response) => response.headers.get("location") ?? "";
const isRedirect = (response) => response.status >= 300 && response.status < 400;
/** A redirect thrown while streaming is sent as a page that redirects in the browser. */
const streamedRedirectTo = (html, target) =>
  html.includes(`"${target}"`) || html.includes(`url=${target}`) || html.includes(target.replace(/\?/g, "\\u003f"));

// ---------------------------------------------------------------------------
// Test accounts
// ---------------------------------------------------------------------------

const createdUsers = new Set();
const newPassword = () => `pw-${randomUUID()}`;

async function createUser({ confirmed = true } = {}) {
  const email = `app-${randomUUID()}@example.test`;
  const password = newPassword();
  const response = await fetch(`${api}/auth/v1/admin/users`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({ email, password, email_confirm: confirmed }),
  });
  const user = await response.json();
  if (!response.ok) throw new Error(`could not create a test user: status ${response.status}`);
  createdUsers.add(user.id);
  return { id: user.id, email, password };
}

async function cleanup() {
  for (const id of createdUsers) {
    await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
  }
}

/** Decodes the session cookie, joining chunks, to test refresh and forgery. Never printed. */
function readSession(browser) {
  const names = browser.authCookieNames().filter((name) => /-auth-token(\.\d+)?$/.test(name)).sort();
  const value = names.map((name) => browser.cookies.get(name)).join("");
  if (!value.startsWith("base64-")) return null;
  return { names, session: JSON.parse(Buffer.from(value.slice(7), "base64url").toString("utf8")) };
}

function writeSession(browser, names, session) {
  for (const name of names) browser.cookies.delete(name);
  const base = names[0].replace(/\.\d+$/, "");
  browser.cookies.set(base, `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`);
}

async function signInAs(browser, user, next = "/settings") {
  const page = await browser.get(`/sign-in?next=${encodeURIComponent(next)}`);
  return browser.submit("/sign-in", formWith(page.html, "password"), { email: user.email, password: user.password });
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function signedOut() {
  section("Signed out");
  const browser = new Browser();
  for (const path of ["/collection", "/profile", "/settings", "/welcome"]) {
    const { response } = await browser.get(path);
    check(`${path} redirects to sign in`, isRedirect(response) && location(response).endsWith(`/sign-in?next=${encodeURIComponent(path)}`), `${response.status} ${location(response)}`);
  }
  const query = await browser.get("/settings?tab=handle");
  check("the return path keeps its query", location(query.response).endsWith(`/sign-in?next=${encodeURIComponent("/settings?tab=handle")}`), location(query.response));

  for (const path of ["/home", "/explore"]) {
    const { response, html } = await browser.get(path);
    check(`${path} stays public`, response.status === 200, `status ${response.status}`);
    check(`${path} offers sign in`, html.includes('href="/sign-in"'));
  }
  check("no session cookie is set for a visitor", browser.authCookieNames().length === 0);

  const page = await browser.get("/sign-in?next=https%3A%2F%2Fevil.example%2F");
  check("an outside return path is replaced", formWith(page.html, "password")?.hidden.next === "/home", formWith(page.html, "password")?.hidden.next);
  const slashes = await browser.get("/sign-in?next=%2F%2Fevil.example");
  check("a protocol-relative return path is replaced", formWith(slashes.html, "password")?.hidden.next === "/home");
  check("no sign-up or password reset page exists", (await browser.get("/sign-up")).response.status === 404 && (await browser.get("/reset-password")).response.status === 404);
}

async function failedSignIns() {
  section("Failed sign-ins");
  const user = await createUser();
  const browser = new Browser();
  const page = await browser.get("/sign-in");
  const form = formWith(page.html, "password");

  const wrong = await browser.submit("/sign-in", form, { email: user.email, password: "not-the-password" });
  check("a wrong password is refused", wrong.response.status === 200 && wrong.html.includes("Your email or password is incorrect."), `status ${wrong.response.status}`);
  const unknown = await browser.submit("/sign-in", form, { email: `nobody-${randomUUID()}@example.test`, password: "not-the-password" });
  check("an unknown email gets the same answer", unknown.html.includes("Your email or password is incorrect."));
  check("a refused sign-in sets no session", browser.authCookieNames().length === 0);
  check("errors don't echo Auth's own messages", !/invalid_credentials|Invalid login credentials/i.test(wrong.html + unknown.html));

  const unconfirmed = await createUser({ confirmed: false });
  const pending = await browser.submit("/sign-in", form, { email: unconfirmed.email, password: unconfirmed.password });
  check("an unverified email can't sign in", pending.html.includes("Confirm your email") && browser.authCookieNames().length === 0);

  const crossSite = await browser.submit("/sign-in", form, { email: user.email, password: user.password }, { origin: "https://evil.example" });
  check("a sign-in posted from another site is refused", !isRedirect(crossSite.response) && browser.authCookieNames().length === 0, `status ${crossSite.response.status}`);
}

async function lifecycle() {
  section("Sign in, claim a handle, use the account, sign out");
  const user = await createUser();
  const browser = new Browser();

  const signedIn = await signInAs(browser, user, "/collection");
  check("sign-in redirects to the return path", isRedirect(signedIn.response) && location(signedIn.response).endsWith("/collection"), `${signedIn.response.status} ${location(signedIn.response)}`);
  const authCookies = signedIn.response.headers.getSetCookie().filter((line) => line.startsWith("sb-"));
  check("sign-in sets the session cookie", authCookies.length > 0 && browser.authCookieNames().length > 0);
  check("the session cookie is httpOnly", authCookies.length > 0 && authCookies.every((line) => /;\s*httponly/i.test(line)));
  check("the session cookie is SameSite=Lax", authCookies.length > 0 && authCookies.every((line) => /;\s*samesite=lax/i.test(line)));
  check("the session cookie is Secure in production", authCookies.length > 0 && authCookies.every((line) => /;\s*secure/i.test(line)));

  const noHandle = await browser.get("/collection");
  check("an account without a handle is sent to claim one", streamedRedirectTo(noHandle.html, "/welcome?next=%2Fcollection") || location(noHandle.response).includes("/welcome"), `status ${noHandle.response.status}`);

  const welcome = await browser.get("/welcome?next=%2Fcollection");
  const handleForm = formWith(welcome.html, "handle");
  check("the handle form is shown", Boolean(handleForm));
  const invalid = await browser.submit("/welcome?next=%2Fcollection", handleForm, { handle: "ab" });
  check("an invalid handle is refused", invalid.html.includes("Use 3 to 24 letters, numbers or underscores."));
  const reserved = await browser.submit("/welcome?next=%2Fcollection", handleForm, { handle: "collection" });
  check("a reserved handle is refused", reserved.html.includes("That handle isn&#x27;t available") || reserved.html.includes("That handle isn't available"));

  const handle = `app_${randomBytes(5).toString("hex")}`;
  const claimed = await browser.submit("/welcome?next=%2Fcollection", handleForm, { handle: handle.toUpperCase() });
  check("claiming a handle returns to the page", isRedirect(claimed.response) && location(claimed.response).endsWith("/collection"), `${claimed.response.status} ${location(claimed.response)}`);
  check("the handle is saved in lowercase", psql(`select handle from public.profiles where id = '${user.id}'`) === handle);

  const collection = await browser.get("/collection");
  check("a protected page opens with a handle", collection.response.status === 200 && collection.html.includes("My Collection") && !streamedRedirectTo(collection.html, "/welcome"));
  const settings = await browser.get("/settings");
  check("settings show the signed-in account", settings.html.includes(`@${handle}`));
  check("the header shows the account menu", settings.html.includes('aria-label="Account menu"') && !settings.html.includes('href="/sign-in"'));
  const back = await browser.get("/sign-in");
  check("sign-in sends a signed-in user on", streamedRedirectTo(back.html, "/home") || isRedirect(back.response));

  // The settings form uses the same rules: a handle can be corrected within 24 hours.
  const corrected = `${handle}x`;
  const changed = await browser.submit("/settings", formWith(settings.html, "handle"), { handle: corrected });
  check("the handle can be corrected in settings", isRedirect(changed.response) && psql(`select handle from public.profiles where id = '${user.id}'`) === corrected);
  const after = await browser.get("/settings");
  check("after the correction, settings show the next allowed date", after.html.includes("You can change it again on") && !formWith(after.html, "handle"));

  // A valid session is only verified, never refreshed or rewritten, on ordinary requests.
  const stored = readSession(browser);
  check("the session cookie holds a session", Boolean(stored?.session?.refresh_token));
  const authWrites = [];
  for (const path of ["/home", "/explore", "/settings", "/collection", "/sign-in"]) {
    await browser.get(path);
    authWrites.push(...browser.lastSetCookies.filter((line) => line.startsWith("sb-")));
  }
  check("a valid session isn't refreshed on each request", authWrites.length === 0, `${authWrites.length} cookie writes`);
  check("a valid session keeps its refresh token", readSession(browser).session.refresh_token === stored.session.refresh_token);

  // Static files skip the proxy, so even an expired session isn't refreshed for them.
  const asset = /\/_next\/static\/[^"']+\.js/.exec(settings.html)?.[0];
  const staticClient = new Browser();
  writeSession(staticClient, stored.names, { ...stored.session, expires_at: Math.floor(Date.now() / 1000) - 60 });
  const assetResponse = asset ? await staticClient.get(asset) : null;
  check(
    "static files don't touch the session",
    assetResponse?.response.status === 200 && staticClient.lastSetCookies.length === 0,
    asset ? `status ${assetResponse?.response.status}` : "no script found",
  );

  // An expired access token is refreshed by the proxy and the new cookies are sent back.
  const oldRefresh = stored.session.refresh_token;
  writeSession(browser, stored.names, { ...stored.session, expires_at: Math.floor(Date.now() / 1000) - 60 });
  const refreshed = await browser.get("/settings");
  const renewed = readSession(browser);
  check("an expired session is refreshed", refreshed.response.status === 200 && refreshed.html.includes(`@${corrected}`), `status ${refreshed.response.status}`);
  check("the refresh writes new tokens", Boolean(renewed) && renewed.session.refresh_token !== oldRefresh && renewed.session.expires_at > Date.now() / 1000);
  check("a refreshed response isn't cacheable", /no-store/.test(refreshed.response.headers.get("cache-control") ?? ""), refreshed.response.headers.get("cache-control") ?? "none");
  const again = await browser.get("/collection");
  check("the session keeps working after the refresh", again.response.status === 200 && !streamedRedirectTo(again.html, "/sign-in"));

  // A forged token isn't trusted, even with a valid-looking session around it.
  const forger = new Browser();
  const [header, payload] = renewed.session.access_token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const forgedToken = `${header}.${Buffer.from(JSON.stringify({ ...claims, sub: randomUUID() })).toString("base64url")}.${"A".repeat(43)}`;
  forger.cookies.set(renewed.names[0].replace(/\.\d+$/, ""), `base64-${Buffer.from(JSON.stringify({ ...renewed.session, access_token: forgedToken, refresh_token: "forged" })).toString("base64url")}`);
  const forged = await forger.get("/settings");
  check("a forged session cookie is treated as signed out", isRedirect(forged.response) && location(forged.response).includes("/sign-in"), `${forged.response.status} ${location(forged.response)}`);

  // A Server Action checks the session itself, whatever page it was rendered on.
  const stranger = new Browser();
  const strangerClaim = await stranger.submit("/welcome", handleForm, { handle: `app_${randomBytes(5).toString("hex")}` });
  check("a handle claim without a session is refused", isRedirect(strangerClaim.response) && location(strangerClaim.response).includes("/sign-in"), `${strangerClaim.response.status} ${location(strangerClaim.response)}`);

  // Sign out ends the session in Auth too, so its refresh token stops working.
  const current = readSession(browser).session.refresh_token;
  const signOutForm = formById(after.html, "sign-out-form") ?? forms(after.html).find((form) => Object.keys(form.hidden).some((name) => name.startsWith("$ACTION_ID_")) && form.names.length === 0);
  const signedOutResponse = await browser.submit("/settings", signOutForm, {});
  check("sign-out redirects to sign in", isRedirect(signedOutResponse.response) && location(signedOutResponse.response).endsWith("/sign-in"), `${signedOutResponse.response.status} ${location(signedOutResponse.response)}`);
  check("sign-out clears the session cookie", browser.authCookieNames().length === 0, browser.authCookieNames().join(","));
  const afterSignOut = await browser.get("/settings");
  check("protected pages need signing in again", isRedirect(afterSignOut.response) && location(afterSignOut.response).includes("/sign-in"));
  const reuse = await fetch(`${api}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: current }),
  });
  check("the signed-out session's refresh token is revoked", !reuse.ok, `status ${reuse.status}`);
}

async function suspended() {
  section("Suspended account");
  const user = await createUser();
  const browser = new Browser();
  await signInAs(browser, user, "/welcome");
  const handle = `app_${randomBytes(5).toString("hex")}`;
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle });
  psql(`update public.profiles set account_status = 'suspended' where id = '${user.id}'`);

  const settings = await browser.get("/settings");
  check(
    "a suspended account can still open settings",
    settings.response.status === 200 && /This account isn(&#x27;|')t active/.test(settings.html),
  );
  check("a suspended account isn't offered a handle change", !formWith(settings.html, "handle"));
  const forced = await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `${handle}z` });
  check("a suspended account can't change its handle", psql(`select handle from public.profiles where id = '${user.id}'`) === handle, `status ${forced.response.status}`);
}

async function noSecretsInPages() {
  section("Pages");
  const user = await createUser();
  const browser = new Browser();
  await signInAs(browser, user, "/welcome");
  const welcome = await browser.get("/welcome");
  const html = welcome.html;
  const session = readSession(browser).session;
  check("no page contains the access token", !html.includes(session.access_token));
  check("no page contains the refresh token", !html.includes(session.refresh_token));
  check("no page contains the publishable key", !html.includes(publishableKey));
  check("no page contains the user's email", !html.includes(user.email));
}

try {
  await waitForApp();
  await signedOut();
  await failedSignIns();
  await lifecycle();
  await suspended();
  await noSecretsInPages();
} catch (error) {
  failed += 1;
  console.log(`FAIL the checks stopped: ${error.message}`);
} finally {
  await cleanup();
  app.kill();
}

// The cross-site sign-in check makes Next.js log this refusal, which is the expected outcome.
const expected = /Invalid Server Actions request/;
check("the app logged the cross-site refusal", expected.test(appErrors));
const errorLines = [...new Set(appErrors.split("\n").filter((line) => /Error|⨯/.test(line) && !expected.test(line)))];
if (errorLines.length > 0) failed += 1;
if (errorLines.length > 0) {
  console.log(`\nThe app logged ${errorLines.length} distinct error lines:`);
  // Redacted, in case an error ever quotes a token or key.
  for (const line of errorLines.slice(0, 10)) {
    console.log(`  ${line.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[REDACTED]").replace(/sb_(secret|publishable)_[\w-]+/g, "[REDACTED]").slice(0, 300)}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
