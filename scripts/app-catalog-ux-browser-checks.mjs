/**
 * M15 catalog UX: live catalog search in a real browser, with JavaScript (headless Edge or
 * Chrome through playwright-core, which downloads none). Typing filters after a short pause with
 * no button; a burst of typing sends far fewer requests than keystrokes; focus stays in the box;
 * a filter change refreshes at once; a one-letter query keeps the results; the Search button is
 * hidden once JavaScript runs.
 *
 *   npm run build && MGD_TEST_STACK=scratch node scripts/test-stack.mjs run app:catalog-ux-browser-checks
 *
 * Local scratch only. Makes three games and one editor, and removes them.
 */
import { randomBytes } from "node:crypto";

import { chromium } from "playwright-core";

import { Browser, check, createUser, deleteUsers, formWith, psql, results, section, startApp, stopApp } from "./app-harness.mjs";
import { stackName } from "./lib/stack.mjs";
import { totp } from "./lib/mfa-session.mjs";

if (stackName !== "scratch") {
  console.error("Refusing: run on the disposable scratch stack.");
  process.exit(2);
}

const TAG = `ZquB${randomBytes(2).toString("hex")}`;
const TITLES = [`${TAG} Alpha Star`, `${TAG} Alpha Moon`, `${TAG} Beta Star`];
const users = [];
let browser;

for (const t of TITLES) {
  psql(`with g as (insert into public.games (title, sort_title, kind, status) values ('${t}', '${t}', 'game', 'under_review') returning id)
insert into public.game_platforms (game_id, platform_id, status) select g.id, (select id from public.platforms where slug = 'snes'), 'under_review' from g;`);
}

try {
  const origin = await startApp(3299);
  const user = await createUser({ prefix: "uxb", mfa: true });
  users.push(user.id);
  const http = new Browser();
  const { signInAs } = await import("./app-harness.mjs");
  await signInAs(http, user, "/home");
  const welcome = await http.get("/welcome");
  await http.submit("/welcome", formWith(welcome.html, "handle"), { handle: `uxb_${randomBytes(4).toString("hex")}` });
  psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', 'catalog_editor');`);

  for (const channel of ["msedge", "chrome"]) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {}
  }
  if (!browser) throw new Error("Needs Microsoft Edge or Google Chrome installed.");
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/sign-in?next=${encodeURIComponent("/home")}`, { waitUntil: "networkidle" });
  await page.fill("#email", user.email);
  await page.fill("#password", user.password);
  await page.click('main button[type="submit"]');
  await page.waitForURL((u) => u.pathname === "/settings/security/verify");
  if (await page.locator("#verify-factor").count()) await page.selectOption("#verify-factor", user.factorId);
  await page.fill("#verify-code", totp(user.totpSecret));
  await page.click('main button[type="submit"]');
  await page.waitForURL((u) => u.pathname === "/home");

  section("Live catalog search (JavaScript on)");
  await page.goto(`${origin}/admin/catalog/search?kind=games&platform=snes&status=under_review`, { waitUntil: "networkidle" });
  check("the Search button is hidden once JavaScript runs", !(await page.getByRole("button", { name: "Search", exact: true }).isVisible()));
  const searches = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/admin/catalog/search" && u.searchParams.get("q")) searches.push(u.searchParams.get("q"));
  });
  const box = page.locator("#records-q");
  await box.click();
  const query = `${TAG} Alpha`;
  await box.pressSequentially(query, { delay: 40 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  try {
    await page.waitForURL((u) => u.searchParams.get("q") === query, { timeout: 5000 });
  } catch (e) {
    console.log("DEBUG url", page.url(), "searches", JSON.stringify(searches), "box", await box.inputValue(), "live", await page.locator("form[data-live]").count(), "errors", errors.slice(0, 3).join(" | "));
    throw e;
  }
  await page.waitForFunction((t) => document.body.innerText.includes(t), TITLES[1], { timeout: 5000 });
  const text = await page.evaluate(() => document.body.innerText);
  check("typing filters the results with no button, keeping platform and status", text.includes(TITLES[0]) && text.includes(TITLES[1]) && !text.includes(TITLES[2]) && page.url().includes("platform=snes") && page.url().includes("status=under_review"));
  check("a burst of typing sends far fewer searches than keystrokes", searches.length > 0 && searches.length <= 3, `${searches.length} searches for ${query.length} keystrokes`);
  check("focus stays in the search box", await box.evaluate((el) => el === document.activeElement));
  check("the results say what the page holds, and for which search", text.includes(`2 games matching “${query}”, by title`));

  await page.selectOption("#records-status", "published");
  await page.waitForURL((u) => u.searchParams.get("status") === "published", { timeout: 5000 });
  await page.waitForFunction(() => document.body.innerText.includes("Nothing found"), null, { timeout: 5000 });
  check("changing a filter refreshes at once, keeping the query", new URL(page.url()).searchParams.get("q") === query);

  await page.selectOption("#records-status", "under_review");
  await page.waitForFunction((t) => document.body.innerText.includes(t), TITLES[0], { timeout: 5000 });
  const before = page.url();
  await box.fill("");
  await box.pressSequentially("Z", { delay: 40 });
  await page.waitForTimeout(800);
  const shortText = await page.evaluate(() => document.body.innerText);
  check("a one-letter query isn't searched, and the page says the results are still the previous search's", page.url() === before && shortText.includes("Type at least two letters to search. The results below are still for your previous search.") && shortText.includes(`matching “${query}”`));
  await box.press("Enter");
  await page.waitForTimeout(500);
  check("Enter with a one-letter query does nothing either", page.url() === before);
} finally {
  await browser?.close();
  stopApp();
  psql(`begin; delete from public.game_platforms where game_id in (select id from public.games where title like '${TAG}%'); delete from public.games where title like '${TAG}%'; commit;`);
  const deleted = await deleteUsers();
  const all = [...new Set([...deleted, ...users])].map((u) => `'${u}'`).join(",");
  if (all) psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${all}) or target_profile_id in (${all}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'uxb\\_%';");
  check("nothing is left behind", psql(`select count(*) from public.games where title like '${TAG}%';`) === "0");
}

console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
