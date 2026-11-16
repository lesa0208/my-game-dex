/**
 * M8 browser and accessibility checks: the unified /admin and Settings → Security in a
 * real browser with JavaScript, against the production build and the local stack.
 *
 *   npm run build && npm run app:a11y-checks
 *
 * Needs Microsoft Edge or Google Chrome installed; playwright-core drives the installed
 * browser and downloads none. A11Y_BROWSER=msedge or chrome picks one; by default Edge
 * is tried, then Chrome. If neither starts, the run says so and fails: missing coverage
 * is never reported as a pass.
 *
 * Every audited page is checked at a phone width (390 px) and a desktop width (1280 px)
 * with axe-core (WCAG 2.0–2.2 A and AA rules; critical or serious findings fail) and for
 * sideways scrolling, in Dark Mode: the only supported appearance (class="dark" on
 * <html>, with no way to change it). Light Mode is unsupported. As a diagnostic only,
 * the same checks run with that class removed, on the light tokens in globals.css; their
 * findings are listed and counted apart, never as passes and never as release checks,
 * and say nothing about Light Mode being accessible. A11Y_LIGHT=enforce turns them into
 * failing checks, for future Light Mode work.
 *
 * Throwaway accounts only, on the local stack; the test Owner's factors are recorded as
 * 25 hours old by postgres (scripts/lib/test-owner.mjs). Everything is removed at the
 * end. No screenshots, traces or videos are taken, and nothing printed contains a key,
 * token, cookie, TOTP secret or email address: failure details are redacted.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { chromium } from "playwright-core";

import { api, appErrorLines, Browser, check, createUser, deleteUsers, formWith, psql, publishableKey, results, section, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { addFactor, decodeClaims, reverify, totp } from "./lib/mfa-session.mjs";
import { matureFactors, removeTestOwner, requireNoOwner } from "./lib/test-owner.mjs";

requireNoOwner(psql, api);

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const WIDTHS = [
  { tag: "phone", width: 390, height: 844 },
  { tag: "desktop", width: 1280, height: 900 },
];
const SCHEMES = ["dark", "light"];
// Light Mode is unsupported: its results are diagnostics, not checks, unless asked.
const ENFORCE_LIGHT = process.env.A11Y_LIGHT === "enforce";
const lightFindings = [];
let lightStates = 0;
const NOT_AVAILABLE = "This page isn't available";
const PREFIX = "a11y";

// ---------------------------------------------------------------------------
// Redaction: secrets seen during the run, and anything shaped like one
// ---------------------------------------------------------------------------

const secrets = new Set();
function redact(text) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join("[REDACTED]");
  return out
    .replace(/[\w.+-]+@example\.test/g, "[EMAIL]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[REDACTED]")
    .replace(/\b[A-Z2-7]{16,}\b/g, "[REDACTED]")
    .replace(/otpauth:[^\s"']+/g, "[REDACTED]")
    .slice(0, 600);
}
const ok = (name, pass, detail = "") => check(name, pass, pass ? "" : redact(detail));

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

async function launch() {
  const channels = process.env.A11Y_BROWSER ? [process.env.A11Y_BROWSER] : ["msedge", "chrome"];
  const tried = [];
  for (const channel of channels) {
    try {
      const browser = await chromium.launch({ channel, headless: true });
      console.log(`Browser: ${channel} ${browser.version()}, headless`);
      return { browser, channel };
    } catch (error) {
      tried.push(`${channel}: ${String(error.message).split("\n")[0].slice(0, 120)}`);
    }
  }
  console.error(`NOT RUN: no installed browser could be started (${tried.join("; ")}).`);
  console.error("Install Microsoft Edge or Google Chrome, or set A11Y_BROWSER to an installed channel.");
  stopApp();
  process.exit(2);
}

/** Applies a scheme to the page that's open: the app's dark class, or the light tokens. */
async function applyScheme(page, scheme) {
  await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), scheme === "dark");
}

/** axe-core and the sideways-scroll check on the page as it is, in both schemes. */
async function audit(page, name, tag) {
  await page.waitForLoadState("networkidle");
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: axeSource });
  for (const scheme of SCHEMES) {
    await applyScheme(page, scheme);
    const found = await page.evaluate(async () => {
      const run = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
      return run.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, target: String(v.nodes[0]?.target ?? ""), message: v.nodes[0]?.any?.[0]?.message ?? v.nodes[0]?.all?.[0]?.message ?? "" }));
    });
    const blocking = found.filter((v) => v.impact === "critical" || v.impact === "serious");
    const minor = found.filter((v) => !blocking.includes(v));
    for (const v of minor) console.log(`note ${tag} ${scheme} ${name}: ${v.impact} ${v.id} (${v.count}) ${redact(v.target)}`);
    const describe = (v) => `${v.impact} ${v.id}(${v.count}) ${v.target} ${v.message}`;
    const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
    if (scheme === "light" && !ENFORCE_LIGHT) {
      // A diagnostic: listed and summarized at the end, never counted as a pass.
      lightStates += 1;
      for (const v of blocking) lightFindings.push(redact(`${tag} ${name}: ${describe(v)}`));
      if (overflow.scroll > overflow.view) lightFindings.push(`${tag} ${name}: sideways scrolling ${overflow.scroll} > ${overflow.view}`);
      continue;
    }
    const mode = scheme === "dark" ? "Dark Mode" : "Light Mode (enforced diagnostic)";
    ok(`${tag} ${mode} ${name}: no critical or serious axe findings`, blocking.length === 0, blocking.map(describe).join("; "));
    ok(`${tag} ${mode} ${name}: no sideways scrolling`, overflow.scroll <= overflow.view, `${overflow.scroll} > ${overflow.view}`);
  }
  await applyScheme(page, "dark");
}

/** One h1, and every visible field has an accessible name. */
async function structure(page, name, tag) {
  const facts = await page.evaluate(() => {
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const fields = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter(visible);
    const unnamed = fields.filter((el) => !(el.labels?.length || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))).map((el) => el.id || el.name || el.tagName);
    const buttons = [...document.querySelectorAll("button, a[href]")].filter(visible).filter((el) => !(el.innerText.trim() || el.getAttribute("aria-label") || el.getAttribute("title"))).map((el) => el.outerHTML.slice(0, 80));
    return { h1: document.querySelectorAll("h1").length, unnamed, buttons };
  });
  ok(`${tag} ${name}: one main heading`, facts.h1 === 1, `${facts.h1} h1`);
  ok(`${tag} ${name}: every field and control has an accessible name`, facts.unnamed.length === 0 && facts.buttons.length === 0, [...facts.unnamed, ...facts.buttons].join(", "));
}

/**
 * Tabs through the page from the top: the first stop is the skip link, which shows when
 * focused and moves focus to the main content; every stop after it is visible and has a
 * focus indicator (an outline or a ring); and focus reaches the main content.
 */
async function keyboard(page, name, tag) {
  // Blurring doesn't move where the browser's Tab order starts (a click sets it), so a
  // temporary, unfocusable-by-Tab marker at the top of the page is focused instead.
  const fromTop = () =>
    page.evaluate(() => {
      window.scrollTo(0, 0);
      let marker = document.getElementById("a11y-start");
      if (!marker) {
        marker = document.createElement("span");
        marker.id = "a11y-start";
        marker.tabIndex = -1;
        document.body.prepend(marker);
      }
      marker.focus();
    });
  await fromTop();
  await page.keyboard.press("Tab");
  const skip = await page.evaluate(() => {
    const el = document.activeElement;
    const box = el.getBoundingClientRect();
    return { text: el.textContent.trim(), href: el.getAttribute("href"), shown: box.width > 1 && box.height > 1 && box.top >= 0 };
  });
  ok(`${tag} ${name}: the first Tab reaches a visible skip link`, skip.text === "Skip to content" && skip.href === "#main-content" && skip.shown, JSON.stringify(skip));
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  const afterSkip = await page.evaluate(() => Boolean(document.activeElement?.closest("#main-content")));
  ok(`${tag} ${name}: the skip link takes the next Tab into the main content`, afterSkip);

  await fromTop();
  const bad = [];
  let reachedMain = false;
  await page.evaluate(() => (window.__a11yStops = []));
  let stops = 0;
  for (let stop = 0; stop < 40; stop += 1) {
    await page.keyboard.press("Tab");
    const s = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el.id === "a11y-start") return null;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      // The focused look, compared below with the same element unfocused.
      window.__a11yStops.push({ el, focused: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}|${style.boxShadow}|${style.borderColor}` });
      return { visible: box.width > 0 && box.height > 0, main: Boolean(el.closest("#main-content")) };
    });
    if (!s) break;
    stops += 1;
    if (s.main) reachedMain = true;
    if (!s.visible) bad.push(`stop ${stop + 1} (not visible)`);
  }
  // With the marker focused, none of the stops is; a stop has a focus indicator when its
  // look changes on focus, or it shows a real outline (the browser's own focus ring).
  bad.push(
    ...(await page.evaluate(() => {
      document.getElementById("a11y-start").focus();
      const out = [];
      for (const { el, focused } of window.__a11yStops) {
        const style = getComputedStyle(el);
        const unfocused = `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}|${style.boxShadow}|${style.borderColor}`;
        const [outlineStyle, outlineWidth] = focused.split(" ");
        const outline = outlineStyle !== "none" && parseFloat(outlineWidth) > 0;
        if (focused === unfocused && !outline) out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} ${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)} (no focus indicator)`);
      }
      delete window.__a11yStops;
      document.getElementById("a11y-start").remove();
      return out;
    })),
  );
  ok(`${tag} ${name}: Tab moves through the page (${stops} stops)`, stops >= 3, `${stops} stops`);
  ok(`${tag} ${name}: every focused control shows a visible focus indicator`, bad.length === 0, bad.join("; "));
  ok(`${tag} ${name}: keyboard focus reaches the main content`, reachedMain);
}

/** Signs in through the pages with JavaScript, verifying the factor on the app's page. */
async function signIn(browser, viewport, user) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(`${origin}/sign-in?next=${encodeURIComponent("/home")}`, { waitUntil: "networkidle" });
  await page.fill("#email", user.email);
  await page.fill("#password", user.password);
  await page.click('main button[type="submit"]');
  if (user.totpSecret) {
    await page.waitForURL((u) => u.pathname === "/settings/security/verify");
    if (await page.locator("#verify-factor").count()) await page.selectOption("#verify-factor", user.factorId);
    await page.fill("#verify-code", totp(user.totpSecret));
    await page.click('main button[type="submit"]');
  }
  await page.waitForURL((u) => u.pathname === "/home");
  return { context, page };
}

/** The session id in the browser's auth cookie, to age its verification. Never printed. */
async function sessionId(context) {
  const cookies = (await context.cookies()).filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name)).sort((a, b) => a.name.localeCompare(b.name));
  const value = cookies.map((c) => c.value).join("");
  const session = JSON.parse(Buffer.from(value.slice("base64-".length), "base64url").toString("utf8"));
  return decodeClaims(session.access_token).session_id;
}

const visibleText = (page) => page.evaluate(() => document.body.innerText);
const sectionsShown = (page) => page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Admin sections"] a')].map((a) => a.textContent.trim()));
const roles = (user) => psql(`select coalesce(string_agg(role::text, ',' order by role::text), '') from public.staff_roles where user_id = '${user.id}';`);

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const handles = new Map();
/** A throwaway account with a handle; staff get a TOTP factor and their role. */
async function person(role = null, { mfa = Boolean(role) } = {}) {
  const user = await createUser({ prefix: PREFIX, mfa });
  if (user.totpSecret) secrets.add(user.totpSecret);
  secrets.add(user.password);
  // The handle is chosen on the welcome page, over HTTP, as a person would.
  const http = new Browser();
  await signInAs(http, user, "/home");
  const handle = `ay_${randomBytes(5).toString("hex")}`;
  const welcome = await http.get("/welcome");
  await http.submit("/welcome", formWith(welcome.html, "handle"), { handle });
  if (psql(`select handle from public.profiles where id = '${user.id}';`) !== handle) throw new Error("setup: the handle wasn't saved");
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  handles.set(user.id, handle);
  return { ...user, handle };
}
async function secondFactor(user) {
  const response = await fetch(`${api}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  const aal2 = await reverify(api, publishableKey, { access_token: (await response.json()).access_token, factorId: user.factorId, totpSecret: user.totpSecret });
  await addFactor(api, publishableKey, aal2, "Backup key");
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

// The app first: startApp exits when the build is missing or stale, before a browser starts.
const origin = await startApp(3296);
let browser;
try {
  ({ browser } = await launch());
} catch (error) {
  stopApp();
  throw error;
}

try {
  const collector = await person();
  const editor = await person("catalog_editor");
  const moderator = await person("moderator");
  const admin = await person("admin");
  const owner = await person("admin");
  await secondFactor(owner);
  psql(`select private.assign_initial_owner('${owner.handle}', 'Browser checks: test owner');`);
  matureFactors(psql, owner.id);
  ok("setup: a test Owner with two mature factors", psql("select user_id from private.platform_owner;") === owner.id && psql(`select private.mature_totp_factor_count('${owner.id}');`) === "2");

  const ADMIN_PAGES = ["/admin", "/admin/catalog", "/admin/accounts", "/admin/staff", "/admin/audit", "/admin/ownership"];

  for (const viewport of WIDTHS) {
    const tag = viewport.tag;

    // -----------------------------------------------------------------------
    section(`${tag}: 1. A collector can't reach /admin`);
    {
      const c = await signIn(browser, viewport, collector);
      for (const path of ADMIN_PAGES) {
        await c.page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        const text = await visibleText(c.page);
        ok(`${tag} collector at ${path}: the unavailable page, no admin sections`, text.includes(NOT_AVAILABLE) && (await sectionsShown(c.page)).length === 0);
      }
      await c.page.goto(`${origin}/admin`, { waitUntil: "networkidle" });
      await audit(c.page, "unavailable page", tag);
      await c.context.close();
    }

    // -----------------------------------------------------------------------
    section(`${tag}: 2. Each role sees its own sections`);
    {
      const expected = {
        editor: { who: editor, sections: ["Overview", "Catalog"], pages: ["/admin", "/admin/catalog"] },
        moderator: { who: moderator, sections: ["Overview", "Accounts"], pages: ["/admin", "/admin/accounts"] },
        admin: { who: admin, sections: ["Overview", "Catalog", "Accounts", "Staff", "Audit log", "Ownership"], pages: ADMIN_PAGES },
      };
      for (const [name, { who, sections, pages }] of Object.entries(expected)) {
        const s = await signIn(browser, viewport, who);
        await s.page.goto(`${origin}/admin`, { waitUntil: "networkidle" });
        const shown = await sectionsShown(s.page);
        ok(`${tag} ${name}: the admin sections are ${sections.join(", ")}`, JSON.stringify(shown) === JSON.stringify(sections), shown.join(", "));
        for (const path of ADMIN_PAGES) {
          await s.page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
          const open = pages.includes(path);
          const text = await visibleText(s.page);
          ok(`${tag} ${name}: ${path} is ${open ? "open" : "unavailable"}`, open ? !text.includes(NOT_AVAILABLE) && (await sectionsShown(s.page)).length > 0 : text.includes(NOT_AVAILABLE) && (await sectionsShown(s.page)).length === 0);
        }
        if (name === "editor") {
          await s.page.goto(`${origin}/admin`, { waitUntil: "networkidle" });
          await audit(s.page, "editor overview", tag);
        }
        if (name === "moderator") {
          await s.page.goto(`${origin}/admin/accounts?handle=${collector.handle}`, { waitUntil: "networkidle" });
          await audit(s.page, "moderator account lookup", tag);
          await structure(s.page, "moderator account lookup", tag);
        }
        await s.context.close();
      }
    }

    // -----------------------------------------------------------------------
    section(`${tag}: 3. The admin's pages`);
    {
      const a = await signIn(browser, viewport, admin);
      for (const [name, path] of [
        ["overview", "/admin"],
        ["staff", "/admin/staff"],
        ["staff with a refusal", "/admin/staff?error=owner_only"],
        ["account lookup", `/admin/accounts?handle=${owner.handle}`],
        ["audit log", "/admin/audit"],
        ["ownership", "/admin/ownership"],
        ["catalog review", "/admin/catalog"],
        ["verification", "/settings/security/verify?next=%2Fadmin"],
        ["security settings", "/settings/security"],
      ]) {
        await a.page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        await audit(a.page, `admin ${name}`, tag);
        await structure(a.page, `admin ${name}`, tag);
      }
      await a.page.goto(`${origin}/admin/staff`, { waitUntil: "networkidle" });
      await keyboard(a.page, "admin staff page", tag);
      await a.page.goto(`${origin}/settings/security/verify?next=%2Fadmin`, { waitUntil: "networkidle" });
      await keyboard(a.page, "verification page", tag);
      await a.context.close();

      const o = await signIn(browser, viewport, owner);
      for (const [name, path] of [["ownership", "/admin/ownership"], ["security settings", "/settings/security"]]) {
        await o.page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        await audit(o.page, `Owner ${name}`, tag);
        await structure(o.page, `Owner ${name}`, tag);
      }
      await o.page.goto(`${origin}/admin/ownership`, { waitUntil: "networkidle" });
      ok(`${tag} the Owner's ownership page offers the Owner's forms`, (await visibleText(o.page)).includes("Offer ownership"));
      await keyboard(o.page, "Owner ownership page", tag);
      await o.context.close();
    }

    // -----------------------------------------------------------------------
    section(`${tag}: 4. Setting up an authenticator with JavaScript`);
    {
      const member = await person();
      const m = await signIn(browser, viewport, member);
      await m.page.goto(`${origin}/settings/security`, { waitUntil: "networkidle" });
      await audit(m.page, "security, no authenticator", tag);
      await structure(m.page, "security, no authenticator", tag);
      await m.page.click('button:has-text("Add an authenticator")');
      await m.page.waitForSelector("[data-totp-secret]");
      const secret = (await m.page.textContent("[data-totp-secret]")).trim();
      secrets.add(secret);
      ok(`${tag} enrolling shows a setup key and a QR code with a text alternative`, secret.length >= 16 && (await m.page.locator('img[src^="data:image/svg+xml"][alt]').count()) === 1);
      await audit(m.page, "security, enrolling", tag);
      await structure(m.page, "security, enrolling", tag);
      await keyboard(m.page, "security, enrolling", tag);
      // The code is typed and submitted with the keyboard.
      await m.page.focus("#enroll-code");
      await m.page.keyboard.type(totp(secret));
      await m.page.keyboard.press("Enter");
      await m.page.waitForURL((u) => u.searchParams.get("notice") === "verified");
      ok(`${tag} the first code verifies the factor and registers it`, psql(`select count(*) from auth.mfa_factors where user_id = '${member.id}' and status = 'verified';`) === "1" && psql(`select count(*) from private.mfa_factor_registrations where user_id = '${member.id}';`) === "1");
      ok(`${tag} and the key isn't on the page any more`, !(await m.page.content()).includes(secret));
      ok(`${tag} nor in a cookie or the address`, !(await m.context.cookies()).some((c) => c.value.includes(secret)) && !m.page.url().includes(secret));
      await audit(m.page, "security, verified", tag);
      await structure(m.page, "security, verified", tag);
      await m.context.close();
      const again = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await again.newPage();
      await page.goto(`${origin}/sign-in`, { waitUntil: "networkidle" });
      await page.fill("#email", member.email);
      await page.fill("#password", member.password);
      await page.click('main button[type="submit"]');
      await page.waitForURL((u) => u.pathname === "/settings/security/verify");
      ok(`${tag} signing in again asks for the authenticator`, true);
      await again.close();
    }
  }

  // -------------------------------------------------------------------------
  section("5. Step-up before a sensitive action, never replayed, by keyboard");
  {
    const target = await person();
    const a = await signIn(browser, WIDTHS[1], admin);
    psql(`update auth.mfa_amr_claims set updated_at = now() - interval '11 minutes' where session_id = '${await sessionId(a.context)}';`);
    await a.page.goto(`${origin}/admin/staff`, { waitUntil: "networkidle" });
    await a.page.focus("#grant-handle");
    await a.page.keyboard.type(target.handle);
    await a.page.keyboard.press("Tab");
    ok("the role choice is the next stop after the handle", await a.page.evaluate(() => document.activeElement?.id === "grant-role"));
    await a.page.selectOption("#grant-role", "moderator");
    await a.page.focus("#grant-reason");
    await a.page.keyboard.type("Browser step-up check");
    await a.page.keyboard.press("Tab");
    const onButton = await a.page.evaluate(() => document.activeElement?.textContent?.trim());
    ok("the submit button is the next stop after the reason", onButton === "Give role", onButton);
    await a.page.keyboard.press("Enter");
    await a.page.waitForURL((u) => u.pathname === "/settings/security/verify");
    ok("with a verification 11 minutes old, giving a role asks for the authenticator", new URL(a.page.url()).searchParams.get("next") === "/admin/staff", a.page.url());
    ok("and changes nothing", roles(target) === "" && psql(`select count(*) from private.audit_events where actor_id = '${admin.id}' and reason = 'Browser step-up check';`) === "0");
    await audit(a.page, "step-up verification", "desktop");
    await a.page.focus("#verify-code");
    await a.page.keyboard.type(totp(admin.totpSecret));
    await a.page.keyboard.press("Enter");
    await a.page.waitForURL((u) => u.pathname === "/admin/staff");
    await a.page.waitForLoadState("networkidle");
    ok("verifying returns to the staff page", new URL(a.page.url()).pathname === "/admin/staff");
    ok("without replaying the grant", roles(target) === "" && !new URL(a.page.url()).searchParams.has("notice"));
    await a.page.fill("#grant-handle", target.handle);
    await a.page.selectOption("#grant-role", "moderator");
    await a.page.fill("#grant-reason", "Browser step-up check");
    await a.page.getByRole("button", { name: "Give role", exact: true }).click();
    await a.page.waitForURL((u) => u.searchParams.get("notice") === "granted");
    ok("submitting again, now verified, gives the role", roles(target) === "moderator");
    await audit(a.page, "staff after a grant", "desktop");
    await a.context.close();
  }

  const errors = appErrorLines();
  ok("the app logged no errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  ok("the checks ran to the end", false, error.message);
} finally {
  await browser.close();
  stopApp();
  removeTestOwner(psql);
  const ids = await deleteUsers();
  const list = ids.map((id) => `'${id}'`).join(",") || "null";
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ay\\_%';");
  ok("no account, Owner record, registration, hold or audit row is left behind",
    psql(`select (select count(*) from auth.users where id in (${list})) + (select count(*) from private.platform_owner) + (select count(*) from private.ownership_transfers)
      + (select count(*) from private.owner_recoveries) + (select count(*) from private.mfa_factor_registrations where user_id in (${list}))
      + (select count(*) from private.handle_holds where handle like 'ay\\_%')
      + (select count(*) from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}));`) === "0");
}

console.log(`\nDark Mode (supported): every check above. ${results.passed} passed, ${results.failed} failed.`);
if (lightStates) {
  const kinds = new Map();
  for (const line of lightFindings) {
    const kind = /: (?:critical|serious) ([\w-]+)\(/.exec(line)?.[1] ?? (/sideways scrolling/.test(line) ? "sideways-scrolling" : "other");
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  console.log(`\nLight Mode diagnostics (unsupported; not a release check; not counted above; not evidence of WCAG conformance).`);
  console.log(`  ${lightStates} page states checked, ${lightFindings.length} findings${kinds.size ? ` (${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}. A11Y_LIGHT=enforce makes them failing checks.`);
  for (const line of lightFindings) console.log(`  light ${line}`);
}
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
