/**
 * M16: self-registration exists only where the app server's own setting opens it
 * (MGD_SELF_REGISTRATION=open, features/auth/registration.ts), in the built app.
 *
 * - Closed (every server but the demo preview): /sign-up is a real 404, the sign-in page says
 *   accounts are by invitation and links to no sign-up, and the header offers no Sign up.
 * - Open: the page, its link from sign-in and the header's Sign up are there.
 * - The action refuses on its own: a sign-up form loaded while open is submitted after the server
 *   restarts closed, with its request sent to another page that serves the same action (so not
 *   even the proxy's 404 stops it). It answers "invitation only", and no account exists.
 *
 *   npm run build && MGD_TEST_STACK=scratch node scripts/test-stack.mjs run app:sign-up-checks
 *
 * The scratch or test stack only. The whole journey, with a real confirmation email, is
 * app:sign-up-journey-checks, on the demo preview.
 */
import { randomBytes } from "node:crypto";

import { chromium } from "playwright-core";

import { Browser, check, decode, psql, results, section, startApp, stopApp } from "./app-harness.mjs";
import { stackName } from "./lib/stack.mjs";

if (stackName !== "scratch" && stackName !== "test") {
  console.error("Refusing: run on the scratch or test stack.");
  process.exit(2);
}
const PORT = 3294;
const plain = (html) => decode(html.replace(/<script\b[\s\S]*?<\/script>/g, " ").replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const address = `signup-closed-${randomBytes(4).toString("hex")}@example.test`;
let browser;

try {
  section("Closed (the default): invitation only");
  let origin = await startApp(PORT);
  const anon = new Browser();
  check("the sign-up page is a real 404", (await anon.get("/sign-up")).response.status === 404);
  const signIn = plain((await anon.get("/sign-in")).html);
  check("the sign-in page says accounts are by invitation, and links to no sign-up", signIn.includes("Accounts are invitation only") && !signIn.includes("Create an account"));
  check("the header offers no Sign up", !plain((await anon.get("/explore")).html).includes("Sign up"));
  stopApp();

  section("Open: the page and its ways in");
  origin = await startApp(PORT, { selfRegistration: "open" });
  const visitor = new Browser();
  const page = await visitor.get("/sign-up");
  check("the sign-up page exists", page.response.status === 200 && plain(page.html).includes("Create account"));
  check("the sign-in page links to it", plain((await visitor.get("/sign-in")).html).includes("Create an account"));
  check("the header offers Sign up", plain((await visitor.get("/explore")).html).includes("Sign up"));

  for (const channel of process.env.A11Y_BROWSER ? [process.env.A11Y_BROWSER] : ["msedge", "chrome"]) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // Try the next one.
    }
  }
  if (!browser) throw new Error("Needs Microsoft Edge or Google Chrome installed.");
  const tab = await (await browser.newContext()).newPage();
  await tab.goto(`${origin}/sign-up`, { waitUntil: "networkidle" });
  await tab.locator("#email").waitFor();

  section("The action refuses by itself where registration is closed");
  stopApp();
  origin = await startApp(PORT);
  // The form's request goes to /auth/confirm, which serves the same action, so the proxy's
  // 404 for /sign-up can't be what refuses it.
  let rerouted = false;
  await tab.route(`${origin}/sign-up`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    rerouted = true;
    return route.continue({ url: `${origin}/auth/confirm` });
  });
  await tab.fill("#email", address);
  await tab.fill("#password", "a sound password for this");
  await tab.fill("#confirm", "a sound password for this");
  await tab.getByRole("button", { name: "Create account" }).click();
  const answered = await tab.getByText("Accounts are invitation only here.").waitFor({ timeout: 15000 }).then(() => true, () => false);
  check("the form's request reached the action through another page", rerouted);
  check("the action answers that accounts are by invitation", answered);
  check("and no account was created", psql(`select count(*) from auth.users where email = '${address}';`) === "0");
} catch (error) {
  check("the checks ran to the end", false, String(error.message).split("\n")[0]);
} finally {
  await browser?.close();
  stopApp();
  psql(`delete from auth.users where email = '${address}';`);
}
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
