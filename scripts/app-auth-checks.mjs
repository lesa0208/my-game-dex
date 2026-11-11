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
import { randomBytes, randomUUID } from "node:crypto";

import {
  api,
  appErrorLines,
  appLog,
  Browser,
  check,
  createUser,
  deleteUsers,
  formById,
  forms,
  formWith,
  isRedirect,
  location,
  psql,
  publishableKey,
  readSession,
  results,
  section,
  signInAs,
  startApp,
  stopApp,
  streamedRedirectTo,
  writeSession,
} from "./app-harness.mjs";

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
  await startApp(3210);
  await signedOut();
  await failedSignIns();
  await lifecycle();
  await suspended();
  await noSecretsInPages();
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  await deleteUsers();
  stopApp();
}

// The cross-site sign-in check makes Next.js log this refusal, which is the expected outcome.
const expected = /Invalid Server Actions request/;
check("the app logged the cross-site refusal", expected.test(appLog()));
const errorLines = appErrorLines(expected);
check("the app logged no other errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
