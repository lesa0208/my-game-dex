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
import sharp from "sharp";

import { api, appErrorLines, Browser, check, createUser, deleteUsers, formById, formWith, location, psql, publishableKey, results, section, service, signInAs, startApp, stopApp } from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { addFactor, claimsFor, decodeClaims, reverify, totp } from "./lib/mfa-session.mjs";
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
// A11Y_LIGHT_DETAIL=file writes every failing element of each light-mode finding, as JSON
// lines, for triage (which controls fail, and on which pages). Diagnostic only.
const LIGHT_DETAIL = process.env.A11Y_LIGHT_DETAIL ?? null;
const lightDetail = [];
const lightFindings = [];
let lightStates = 0;
const NOT_AVAILABLE = "This page isn't available";
const PREFIX = "a11y";
/** The product code of the release a collector submits (M10a), to find and remove it. */
const SUBMISSION_CODE = `QZB-${process.pid}`;
/** M14c-1: the two games whose record pages show the evidence section, to find and remove them. */
const EVIDENCE_GAMES = [`Zqx A11y Evidence Confirmed ${process.pid}`, `Zqx A11y Evidence Missing ${process.pid}`];
/** Whether the stack has M14c-1's evidence read (stacks without the B1 migrations don't). */
const hasEvidenceRead = () => psql("select count(*) from pg_proc where proname = 'get_game_pairing_evidence';") === "1";
/** M14c-2: the review-batch reads (20261212100000_m14c2_review_batch_reads). Their pages are audited with data in app:review-batch-checks. */
const hasBatchReads = () => psql("select count(*) from pg_proc where proname = 'list_review_batches';") === "1";
/** M14c-3: the publication queue (20261213100000_m14c3_publication_reads). Approval and publication are audited with data in app:publication-checks. */
const hasPublicationQueue = () => psql("select count(*) from pg_proc where proname = 'list_publication_queue';") === "1";

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

/**
 * Expands every collapsed section (<details>) for the checks, so what's inside them is
 * checked too, and returns a function that collapses them again. Collapsed content
 * keeps a layout box but no rendered text, so it would otherwise look like an unnamed
 * control, and axe would skip it.
 */
async function expandDetails(page) {
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("details:not([open])")) {
      d.dataset.a11yClosed = "true";
      d.open = true;
    }
  });
  return () =>
    page.evaluate(() => {
      for (const d of document.querySelectorAll("details[data-a11y-closed]")) {
        d.open = false;
        delete d.dataset.a11yClosed;
      }
    });
}

/** axe-core and the sideways-scroll check on the page, with its sections expanded, in both schemes. */
async function audit(page, name, tag) {
  await page.waitForLoadState("networkidle");
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: axeSource });
  const collapse = await expandDetails(page);
  for (const scheme of SCHEMES) {
    await applyScheme(page, scheme);
    const found = await page.evaluate(async () => {
      const run = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
      return run.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, target: String(v.nodes[0]?.target ?? ""), nodes: v.nodes.map((n) => ({ target: String(n.target), html: n.html.slice(0, 160), message: n.any?.[0]?.message ?? n.all?.[0]?.message ?? "" })), message: v.nodes[0]?.any?.[0]?.message ?? v.nodes[0]?.all?.[0]?.message ?? "" }));
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
      if (LIGHT_DETAIL) for (const v of blocking) for (const n of v.nodes) lightDetail.push(JSON.stringify({ tag, page: name, rule: v.id, target: redact(n.target), html: redact(n.html), message: redact(n.message) }));
      if (overflow.scroll > overflow.view) lightFindings.push(`${tag} ${name}: sideways scrolling ${overflow.scroll} > ${overflow.view}`);
      continue;
    }
    const mode = scheme === "dark" ? "Dark Mode" : "Light Mode (enforced diagnostic)";
    ok(`${tag} ${mode} ${name}: no critical or serious axe findings`, blocking.length === 0, blocking.map(describe).join("; "));
    ok(`${tag} ${mode} ${name}: no sideways scrolling`, overflow.scroll <= overflow.view, `${overflow.scroll} > ${overflow.view}`);
  }
  await applyScheme(page, "dark");
  await collapse();
}

/** One h1, and every visible field has an accessible name, with the page's sections expanded. */
async function structure(page, name, tag) {
  const collapse = await expandDetails(page);
  const facts = await page.evaluate(() => {
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const fields = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter(visible);
    const unnamed = fields.filter((el) => !(el.labels?.length || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))).map((el) => el.id || el.name || el.tagName);
    const buttons = [...document.querySelectorAll("button, a[href]")].filter(visible).filter((el) => !(el.innerText.trim() || el.getAttribute("aria-label") || el.getAttribute("title"))).map((el) => el.outerHTML.slice(0, 80));
    // Rendered headings only: after a client-side navigation Next.js can keep the previous
    // page mounted with display: none, out of the accessibility tree (seen in M11a-1).
    return { h1: [...document.querySelectorAll("h1")].filter(visible).length, unnamed, buttons };
  });
  await collapse();
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
  return { ...user, handle, http };
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
// M12c-A: the stack may hold deliberate catalog records (the staged pilot). What the checks
// make is removed; what was there before must be exactly as it was, not absent.
const CATALOG_TABLES = ["public.releases", "public.catalog_change_requests", "private.catalog_merges", "private.catalog_exclusions", "private.catalog_record_origins",
  "private.catalog_verifications", "private.import_runs", "private.provider_records", "private.catalog_reclassifications"];
const catalogFootprint = () =>
  psql(`select ${CATALOG_TABLES.map((t) => `(select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') from ${t} x)`).join(" || '/' || ")};`);
const startingCatalog = catalogFootprint();
const origin = await startApp(3296);
let browser;
try {
  ({ browser } = await launch());
} catch (error) {
  stopApp();
  throw error;
}

try {
  installFixture();
  const collector = await person();
  const editor = await person("catalog_editor");
  const moderator = await person("moderator");
  const admin = await person("admin");
  const owner = await person("admin");
  await secondFactor(owner);
  psql(`select private.assign_initial_owner('${owner.handle}', 'Browser checks: test owner');`);
  matureFactors(psql, owner.id);
  // A moderation history for the collector, as the M8 functions record it (M10e pages).
  psql(`insert into private.audit_events (occurred_at, actor_id, action, target_profile_id, reason, metadata) values
    (now() - interval '3 days', '${moderator.id}', 'account_suspended', '${collector.id}', 'Browser checks: spam', '{"from": "active", "to": "suspended"}'),
    (now() - interval '2 days', '${admin.id}', 'account_reinstated', '${collector.id}', 'Browser checks: appeal', '{"from": "suspended", "to": "active"}'),
    (now() - interval '1 day', '${moderator.id}', 'staff_change_refused', '${admin.id}', 'Refused: admin_required', '{"code": "admin_required", "operation": "set_account_status", "status": "suspended"}');`);
  ok("setup: a test Owner with two mature factors", psql("select user_id from private.platform_owner;") === owner.id && psql(`select private.mature_totp_factor_count('${owner.id}');`) === "2");

  const ADMIN_PAGES = ["/admin", "/admin/catalog", "/admin/reference", "/admin/imports", "/admin/accounts", "/admin/invitations", "/admin/staff", "/admin/audit", "/admin/ownership", "/admin/system"];

  // M10a: a collector's submission and the fixture's releases, for the catalog pages.
  const form = await collector.http.get("/submit?game=starfall-odyssey");
  const posted = await collector.http.submit("/submit?game=starfall-odyssey", formById(form.html, "new-submission"), {
    platform: "snes", media_format: "rom-cartridge", region: "pal", product_code: SUBMISSION_CODE, physical: "on",
  });
  const submission = location(posted.response).split("/")[2]?.split("?")[0] ?? "";
  const releaseUs = psql("select id from public.releases where product_code = 'SNS-ZSFE-USA';");
  const releaseEu = psql("select id from public.releases where product_code = 'SNSP-ZSFP-EUR';");
  ok("setup: a submission and two fixture releases", [submission, releaseUs, releaseEu].every((id) => /^[0-9a-f-]{36}$/.test(id)));
  const CATALOG_PAGES = [
    ["submission review", `/admin/catalog/${submission}`],
    ["merge candidates", `/admin/catalog/merge/${releaseUs}`],
    ["merge preview", `/admin/catalog/merge/${releaseEu}?into=${releaseUs}`],
    ["exclusion preview", `/admin/catalog/exclude/${releaseUs}`],
    ["merge history", "/admin/catalog/merges"],
  ];

  // M10b: a real merge and a real exclusion, made through the database functions as an
  // administrator and an editor would, so their detail pages are opened with data.
  // Nobody reviews, merges or excludes a record they created (M10c): the editor creates
  // the duplicate and the administrator publishes and merges it; the administrator
  // creates the download code and the editor excludes it.
  const as = (user, sql) => psql(`begin; select set_config('request.jwt.claims', '${claimsFor(user.id)}', true); set local role authenticated; ${sql}; commit;`)
    .split("\n").filter((l) => l && l !== "BEGIN" && l !== "COMMIT").at(-1);
  const gameId = psql("select game_id from public.releases where product_code = 'SNS-ZSFE-USA';");
  const snes = psql("select id from public.platforms where slug = 'snes';");
  const dup = as(editor, `select public.create_release('${gameId}', '${snes}', 'rom-cartridge', 'ntsc-uc', '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "product_code": "AYB-DUP"}', 'Browser checks: a duplicate')`);
  as(admin, `select public.verify_release(r.id, 'Browser checks', r.revision) from public.releases r where r.id = '${dup}'`);
  // M11b-1b: not published, since a new release can't be published on the generic cartridge; a merge doesn't need it.
  const merged = as(admin, `select public.merge_release('${dup}', '${releaseUs}', p ->> 'token', 'Browser checks: the same release', null,
    array(select d ->> 'field' from jsonb_array_elements(p -> 'differences') d), true)::text from (select public.get_merge_preview('${dup}', '${releaseUs}') as p) x`);
  const mergeId = psql(`select id from private.catalog_merges where source_release_id = '${dup}';`);
  const excluded = as(admin, `select public.create_release('${gameId}', '${snes}', 'rom-cartridge', 'pal', '{"product_code": "AYB-EXC"}', 'Browser checks: a download code')`);
  as(editor, `select public.exclude_release('${excluded}', p ->> 'token', 'download_code', 'Browser checks: not a physical release')::text from (select public.get_exclusion_preview('${excluded}') as p) x`);
  const exclusionId = psql(`select id from private.catalog_exclusions where release_id = '${excluded}';`);
  ok("setup: a real merge and a real exclusion", /^[0-9a-f-]{36}$/.test(mergeId) && /^[0-9a-f-]{36}$/.test(exclusionId)
    && psql(`select status from public.releases where id = '${dup}';`) === "merged" && psql(`select status from public.releases where id = '${excluded}';`) === "excluded", merged ?? "");
  // M14c-1: the staff evidence section in its two review states, on a stack with the
  // evidence read: a game whose SNES pairing an editor confirmed with evidence, and one whose
  // pairing nobody has confirmed. Made through the editor functions, as the editor (creator)
  // and the administrator (reviewer); nothing is published. Removed at the end.
  if (hasEvidenceRead()) {
    const confirmed = as(editor, `select public.create_game('${EVIDENCE_GAMES[0]}', 'game', null, null, '1994-03-01', 'day', 'Browser checks')`);
    const unconfirmed = as(editor, `select public.create_game('${EVIDENCE_GAMES[1]}', 'game', null, null, '1994-03-02', 'day', 'Browser checks')`);
    as(editor, `select public.set_game_platform('${confirmed}', '${snes}', 'Browser checks')`);
    as(editor, `select public.set_game_platform('${unconfirmed}', '${snes}', 'Browser checks')`);
    as(admin, `select public.verify_game(g.id, 'Browser checks', g.revision) from public.games g where g.id = '${confirmed}'`);
    as(admin, `select public.verify_game_platform(g.id, '${snes}', '{"source": "editor", "reference": "Browser check photo set", "physical_eligibility": "confirmed", "note": "Cartridge, box and manual photographed; label matches"}', 'Browser checks', g.revision) from public.games g where g.id = '${confirmed}'`);
    ok("setup: a pairing confirmed with evidence, and one not confirmed",
      psql(`select string_agg(coalesce(gp.verification_basis ->> 'note', '-'), '|' order by g.title) from public.game_platforms gp join public.games g on g.id = gp.game_id where g.id in ('${confirmed}', '${unconfirmed}');`)
        === "Cartridge, box and manual photographed; label matches|-");
    CATALOG_PAGES.push(
      ["game record, physical existence confirmed", `/admin/catalog/games/${confirmed}`],
      ["game record, physical existence not confirmed", `/admin/catalog/games/${unconfirmed}`],
    );
  }
  CATALOG_PAGES.push(
    ["merge detail", `/admin/catalog/merges/${mergeId}`],
    ["catalog search", "/admin/catalog/search?q=starfall"],
    ["release search", "/admin/catalog/search?q=starfall&kind=releases"],
    ["game record", `/admin/catalog/games/${gameId}`],
    ["release record", `/admin/catalog/releases/${releaseUs}`],
    ["merged release record", `/admin/catalog/releases/${dup}`],
    // M10c: the editing pages, on a published game and release (forms behind a recent verification).
    ["new game", "/admin/catalog/games/new"],
    ["game editing", `/admin/catalog/games/${gameId}/edit`],
    ["new release", `/admin/catalog/releases/new?game=${gameId}`],
    ["release editing", `/admin/catalog/releases/${releaseUs}/edit`],
  );

  // M10d: an import run as the importer leaves it, with a staged entry and an item in the
  // reclassification queue, so the import and queue pages are opened with data.
  const importRun = psql(`insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, stats, started_at, finished_at, reason)
    values ('no-intro', '${snes}', 'AYB snapshot.dat', repeat('a', 64), now(), 'completed', '{"staged_new": 1}', now(), now(), 'Browser checks') returning id;`);
  const importRecord = psql(`insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, match_tier, matched_release_id)
    values ('no-intro', 'release', 'ayb-1', '{"title": "Starfall Odyssey"}', repeat('1', 64), '${importRun}', 'promoted', 'A', '${releaseUs}') returning id;`);
  psql(`insert into private.import_run_records (import_run_id, provider_record_id, position) values ('${importRun}', '${importRecord}', 0);
    insert into private.catalog_reclassifications (release_id, provider_record_id, import_run_id, action, reason) values ('${releaseUs}', '${importRecord}', '${importRun}', 'queued', 'Browser checks: the source now tags it a prototype');`);
  ok("setup: an import run with a queued reclassification", /^[0-9a-f-]{36}$/.test(importRun) && /^[0-9a-f-]{36}$/.test(importRecord));
  CATALOG_PAGES.push(["reclassification queue", "/admin/catalog/reclassifications"]);
  if (hasBatchReads()) CATALOG_PAGES.push(["review batches", "/admin/catalog/batches"], ["review batches, filtered", "/admin/catalog/batches?status=all&platform=snes"]);
  if (hasPublicationQueue()) CATALOG_PAGES.push(["publication queue", "/admin/catalog/publication"], ["publication queue, all", "/admin/catalog/publication?state=all"]);
  const REFERENCE_PAGES = [
    ["reference summary", "/admin/reference"],
    ["platforms", "/admin/reference/platforms"],
    ["filtered platforms", "/admin/reference/platforms?kind=handheld"],
    ["platform", "/admin/reference/platforms/snes"],
    ["media formats", "/admin/reference/formats"],
    ["regions and markets", "/admin/reference/regions?q=united"],
    ["hardware requirements", "/admin/reference/requirements"],
  ];

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
        editor: { who: editor, sections: ["Overview", "Catalog", "Reference"], pages: ["/admin", "/admin/catalog", "/admin/reference"] },
        moderator: { who: moderator, sections: ["Overview", "Accounts"], pages: ["/admin", "/admin/accounts"] },
        admin: { who: admin, sections: ["Overview", "Catalog", "Reference", "Imports", "Accounts", "Invitations", "Staff", "Audit log", "Ownership", "System"], pages: ADMIN_PAGES },
      };
      for (const [name, { who, sections, pages }] of Object.entries(expected)) {
        const s = await signIn(browser, viewport, who);
        await s.page.goto(`${origin}/admin`, { waitUntil: "networkidle" });
        const shown = await sectionsShown(s.page);
        ok(`${tag} ${name}: the admin sections are ${sections.join(", ")}`, JSON.stringify(shown) === JSON.stringify(sections), shown.join(", "));
        const counts = await s.page.evaluate(() => ["overview-catalog", "overview-accounts", "overview-administration"].filter((id) => document.getElementById(id)).map((id) => id.slice(9)).join(","));
        const expectedCounts = { editor: "catalog", moderator: "accounts", admin: "catalog,accounts,administration" }[name];
        ok(`${tag} ${name}: the overview shows the ${expectedCounts} counts only`, counts === expectedCounts, counts);
        for (const path of ADMIN_PAGES) {
          await s.page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
          const open = pages.includes(path);
          const text = await visibleText(s.page);
          ok(`${tag} ${name}: ${path} is ${open ? "open" : "unavailable"}`, open ? !text.includes(NOT_AVAILABLE) && (await sectionsShown(s.page)).length > 0 : text.includes(NOT_AVAILABLE) && (await sectionsShown(s.page)).length === 0);
        }
        if (name === "editor") {
          await s.page.goto(`${origin}/admin`, { waitUntil: "networkidle" });
          await audit(s.page, "editor overview", tag);
          await structure(s.page, "editor overview", tag);
        }
        if (name === "moderator") {
          await s.page.goto(`${origin}/admin`, { waitUntil: "networkidle" });
          await audit(s.page, "moderator overview", tag);
          await structure(s.page, "moderator overview", tag);
          await s.page.goto(`${origin}/admin/accounts?handle=${collector.handle}`, { waitUntil: "networkidle" });
          await audit(s.page, "moderator account lookup", tag);
          await structure(s.page, "moderator account lookup", tag);
          // M10 integration review: the history without the reasons staff wrote, and saying so.
          const history = await visibleText(s.page);
          ok(`${tag} moderator: the account history withholds staff reasons and says so`, !history.includes("Browser checks:") && history.includes("shown to administrators only")
            && /Account suspended/.test(history));
        }
        await s.context.close();
      }
    }

    // -----------------------------------------------------------------------
    section(`${tag}: 2b. The catalog pages, in the admin frame (M10a)`);
    {
      const e = await signIn(browser, viewport, editor);
      for (const [name, path] of CATALOG_PAGES) {
        await e.page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        const current = await e.page.evaluate(() => document.querySelector('nav[aria-label="Admin sections"] a[aria-current="page"]')?.textContent?.trim() ?? "");
        ok(`${tag} editor ${name}: in the admin frame, with Catalog as the current section`, current === "Catalog", current);
        await audit(e.page, `editor ${name}`, tag);
        await structure(e.page, `editor ${name}`, tag);
      }
      await e.page.goto(`${origin}/admin/catalog/${submission}`, { waitUntil: "networkidle" });
      await keyboard(e.page, "submission review page", tag);
      await e.page.goto(`${origin}/admin/catalog/exclusions`, { waitUntil: "networkidle" });
      ok(`${tag} an editor gets the unavailable page for exclusions`, (await visibleText(e.page)).includes(NOT_AVAILABLE) && (await sectionsShown(e.page)).length === 0);
      // M10b: the records with real data, and the history's links between them.
      await e.page.goto(`${origin}/admin/catalog/merges/${mergeId}`, { waitUntil: "networkidle" });
      const mergeText = await visibleText(e.page);
      ok(`${tag} the merge detail shows the real merge and the merged release's history`,
        mergeText.includes("Starfall Odyssey merged") && mergeText.includes("History of the merged release") && mergeText.includes("Merged this release into another"));
      await e.page.goto(`${origin}/admin/catalog/releases/${releaseUs}`, { waitUntil: "networkidle" });
      ok(`${tag} the kept release's history shows the merge, linked`, (await visibleText(e.page)).includes("Merged another release into this one")
        && (await e.page.locator(`#history a[href="/admin/catalog/merges/${mergeId}"]`).count()) > 0);
      await keyboard(e.page, "release record page", tag);
      await e.page.goto(`${origin}/admin/catalog/search?q=starfall&kind=releases`, { waitUntil: "networkidle" });
      await keyboard(e.page, "catalog search page", tag);
      await e.page.goto(`${origin}/admin/catalog/releases/${excluded}`, { waitUntil: "networkidle" });
      const excludedText = await visibleText(e.page);
      ok(`${tag} an editor sees the excluded release and its exclusion, but no exclusion record or staff reason`,
        excludedText.includes("Excluded the release") && !excludedText.includes("not a physical release") && (await e.page.locator('a[href^="/admin/catalog/exclusions/"]').count()) === 0);
      await e.context.close();
    }

    section(`${tag}: 2c. The reference pages (M10d)`);
    {
      const e = await signIn(browser, viewport, editor);
      for (const [name, path] of REFERENCE_PAGES) {
        await e.page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        const current = await e.page.evaluate(() => document.querySelector('nav[aria-label="Admin sections"] a[aria-current="page"]')?.textContent?.trim() ?? "");
        ok(`${tag} editor ${name}: in the admin frame, with Reference as the current section`, current === "Reference", current);
        await audit(e.page, `editor ${name}`, tag);
        await structure(e.page, `editor ${name}`, tag);
      }
      await e.page.goto(`${origin}/admin/reference/platforms`, { waitUntil: "networkidle" });
      await keyboard(e.page, "platforms page", tag);
      await e.context.close();
    }

    section(`${tag}: 2d. An invitee's pages (M11a-1)`);
    {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "dark" });
      const page = await context.newPage();
      for (const [name, path] of [["invitation confirmation", "/auth/confirm?token_hash=abcdefghijklmnopqrstuvwx&type=invite"], ["an unusable invitation link", "/auth/confirm?type=invite"]]) {
        await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        await audit(page, name, tag);
        await structure(page, name, tag);
      }
      await page.goto(`${origin}/auth/confirm?token_hash=abcdefghijklmnopqrstuvwx&type=invite`, { waitUntil: "networkidle" });
      await keyboard(page, "invitation confirmation", tag);
      // The invitee's real path: Auth issues an invitation, the ledger records it, and the
      // confirmation page's button (a POST, with JavaScript here) accepts it.
      const inviteeEmail = `${PREFIX}-invitee-${tag}-${randomBytes(3).toString("hex")}@example.test`;
      const issued = await (await fetch(`${api}/auth/v1/admin/generate_link`, { method: "POST", headers: service, body: JSON.stringify({ type: "invite", email: inviteeEmail }) })).json();
      psql(`insert into private.account_invitations (email, invited_by, state, reason, first_sent_at, last_sent_at)
        values ('${inviteeEmail}', '${admin.id}', 'sent', 'Browser checks', now(), now());`);
      await page.goto(`${origin}/auth/confirm?token_hash=${issued.hashed_token ?? issued.properties?.hashed_token}&type=invite`, { waitUntil: "networkidle" });
      await page.click('main button[type="submit"]');
      await page.waitForURL((u) => u.pathname === "/welcome/password");
      // /welcome redirects here from its streamed section, so the URL changes before the form renders.
      await page.waitForSelector("#password", { state: "visible" });
      await page.waitForLoadState("networkidle");
      ok(`${tag} accepting an invitation takes the invitee to set a password`, new URL(page.url()).pathname === "/welcome/password");
      await audit(page, "password step", tag);
      await structure(page, "password step", tag);
      await keyboard(page, "password step", tag);
      await context.close();
    }

    section(`${tag}: 2e. Password recovery and account security (M11a-2)`);
    {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "dark" });
      const page = await context.newPage();
      for (const [name, path] of [
        ["forgot password", "/forgot-password"],
        ["forgot password, malformed address", "/forgot-password?error=invalid_email"],
        ["forgot password, answered", "/forgot-password?status=sent"],
        ["reset confirmation", "/auth/confirm?token_hash=abcdefghijklmnopqrstuvwx&type=recovery"],
        ["an unusable reset link", "/auth/confirm?type=recovery&status=invalid"],
        ["reset page without a link", "/reset-password"],
        ["sign in after signing out everywhere", "/sign-in?notice=signed_out_everywhere"],
      ]) {
        await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        await audit(page, name, tag);
        await structure(page, name, tag);
      }
      await page.goto(`${origin}/forgot-password`, { waitUntil: "networkidle" });
      await keyboard(page, "forgot password", tag);

      // A real reset, with JavaScript: Auth issues the link, its button (a POST) verifies it,
      // and the new password is typed and submitted with the keyboard.
      const member = await person();
      const issued = await (await fetch(`${api}/auth/v1/admin/generate_link`, { method: "POST", headers: service, body: JSON.stringify({ type: "recovery", email: member.email }) })).json();
      await page.goto(`${origin}/auth/confirm?token_hash=${issued.hashed_token ?? issued.properties?.hashed_token}&type=recovery`, { waitUntil: "networkidle" });
      await keyboard(page, "reset confirmation", tag);
      await page.click('main button[type="submit"]');
      await page.waitForURL((u) => u.pathname === "/reset-password");
      await page.waitForSelector("#password", { state: "visible" });
      await page.waitForLoadState("networkidle");
      ok(`${tag} pressing the reset link's button goes to choose a new password`, new URL(page.url()).pathname === "/reset-password");
      await audit(page, "reset page", tag);
      await structure(page, "reset page", tag);
      await keyboard(page, "reset page", tag);
      await page.fill("#password", "short");
      await page.fill("#confirm", "short");
      await page.keyboard.press("Enter");
      await page.waitForURL((u) => u.searchParams.get("error") === "too_short");
      await page.waitForSelector("#password", { state: "visible" });
      ok(`${tag} a short password comes back with the reason, linked to the field`, (await visibleText(page)).includes("Use at least 12 characters") && (await page.getAttribute("#password", "aria-describedby")) === "page-error password-hint" && (await page.locator("#page-error").count()) === 1);
      await audit(page, "reset page with an error", tag);
      const fresh = `Pw-${randomBytes(12).toString("base64url")}`;
      secrets.add(fresh);
      await page.focus("#password");
      await page.keyboard.type(fresh);
      await page.focus("#confirm");
      await page.keyboard.type(fresh);
      await page.keyboard.press("Enter");
      await page.waitForURL((u) => u.pathname === "/settings/account" && u.searchParams.get("notice") === "password_reset");
      await page.waitForLoadState("networkidle");
      ok(`${tag} the new password is saved, then the account page says so`, (await visibleText(page)).includes("Your password was reset"));
      await audit(page, "password and sessions, after a reset", tag);
      await structure(page, "password and sessions", tag);
      await keyboard(page, "password and sessions", tag);
      for (const [name, path] of [
        ["password and sessions, wrong current password", "/settings/account?error=wrong_password"],
        ["password and sessions, sign in again", "/settings/account?error=reauthenticate"],
      ]) {
        await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        await audit(page, name, tag);
        await structure(page, name, tag);
      }
      await context.close();

      // With an authenticator, the reset page explains the verification first.
      const guarded = await person(null, { mfa: true });
      const mfaContext = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "dark" });
      const mfaPage = await mfaContext.newPage();
      const link = await (await fetch(`${api}/auth/v1/admin/generate_link`, { method: "POST", headers: service, body: JSON.stringify({ type: "recovery", email: guarded.email }) })).json();
      await mfaPage.goto(`${origin}/auth/confirm?token_hash=${link.hashed_token ?? link.properties?.hashed_token}&type=recovery`, { waitUntil: "networkidle" });
      await mfaPage.click('main button[type="submit"]');
      await mfaPage.waitForURL((u) => u.pathname === "/reset-password");
      await mfaPage.waitForLoadState("networkidle");
      ok(`${tag} with an authenticator, the reset page asks to verify first`, (await visibleText(mfaPage)).includes("Lost your authenticator?") && (await mfaPage.locator("#password").count()) === 0);
      await audit(mfaPage, "reset page, authenticator first", tag);
      await structure(mfaPage, "reset page, authenticator first", tag);
      await keyboard(mfaPage, "reset page, authenticator first", tag);
      await mfaContext.close();
    }

    section(`${tag}: 2f. Settings, profile and photo (M11a-3)`);
    {
      const member = await person();
      const { context, page } = await signIn(browser, viewport, member);
      for (const [name, path] of [
        ["settings", "/settings"],
        ["profile", "/settings/profile"],
        ["profile, saved", "/settings/profile?notice=profile_saved"],
        ["profile, refused name", "/settings/profile?error=display_name_reserved"],
        ["profile, refused bio", "/settings/profile?error=bio_too_long"],
        ["profile, refused photo", "/settings/profile?error=avatar_type"],
      ]) {
        await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        await audit(page, name, tag);
        await structure(page, name, tag);
      }
      await page.goto(`${origin}/settings`, { waitUntil: "networkidle" });
      await keyboard(page, "settings", tag);
      await page.goto(`${origin}/profile`);
      await page.waitForURL((u) => u.pathname === "/settings/profile");
      ok(`${tag} /profile opens the profile editor`, new URL(page.url()).pathname === "/settings/profile");
      await page.waitForLoadState("networkidle");
      await keyboard(page, "profile", tag);

      // The controls line up: the name input is the admin height, the buttons too.
      const sizes = await page.evaluate(() => ({
        input: document.querySelector('input[name="display_name"]').getBoundingClientRect().height,
        buttons: [...document.querySelectorAll("main button[type=submit]")].map((b) => Math.round(b.getBoundingClientRect().height)),
      }));
      ok(`${tag} profile: inputs and buttons share one height`, Math.round(sizes.input) === 40 && sizes.buttons.every((h) => h === 40), JSON.stringify(sizes));

      // With JavaScript: the counter follows the typing, and a value over the limit is
      // caught before sending, with the reason linked to the field and focus on it.
      const name = page.locator('input[name="display_name"]');
      await name.fill("x".repeat(51));
      ok(`${tag} the counter shows the count against the limit`, (await visibleText(page)).includes("51 / 50"));
      await page.click("main button:has-text('Save profile')");
      await page.waitForTimeout(300);
      const caught = await page.evaluate(() => {
        const input = document.querySelector('input[name="display_name"]');
        const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
        return { url: location.search, invalid: input.getAttribute("aria-invalid"), focused: document.activeElement === input, described: ids.some((id) => document.getElementById(id)?.textContent?.includes("Use up to 50 characters")) };
      });
      ok(`${tag} a too-long name is caught before sending, described and focused`, caught.url === "" && caught.invalid === "true" && caught.focused && caught.described, JSON.stringify(caught));
      await audit(page, "profile, name caught before sending", tag);
      await name.fill("A Collector 🎮");
      await page.fill('textarea[name="bio"]', "Boxed handhelds.\nAnd a few consoles.");
      await page.click("main button:has-text('Save profile')");
      await page.waitForURL((u) => u.searchParams.get("notice") === "profile_saved");
      await page.waitForLoadState("networkidle");
      ok(`${tag} with JavaScript the profile saves and says so`, (await visibleText(page)).includes("Your profile is saved.") && (await visibleText(page)).includes("A Collector 🎮"));

      // A photo: previewed when chosen, uploaded, shown, then removed.
      const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 30, g: 140, b: 90 } } }).png().toBuffer();
      const big = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 + 10)]);
      await page.setInputFiles('input[name="avatar"]', { name: "big.png", mimeType: "image/png", buffer: big });
      ok(`${tag} a file over 2 MB is flagged as soon as it's chosen`, (await visibleText(page)).includes("That file is over 2 MB") && (await page.getAttribute('input[name="avatar"]', "aria-invalid")) === "true");
      await page.setInputFiles('input[name="avatar"]', { name: "photo.png", mimeType: "image/png", buffer: png });
      ok(`${tag} a chosen photo is previewed`, (await page.locator('img[alt="The chosen photo, before uploading"]').count()) === 1);
      await page.click("main button:has-text('Upload photo')");
      await page.waitForURL((u) => u.searchParams.get("notice") === "avatar_saved");
      await page.waitForLoadState("networkidle");
      // next/image loads lazily and decodes asynchronously: wait for the file itself.
      await page.waitForFunction(() => {
        const img = document.querySelector('img[alt="Your current photo"]');
        return Boolean(img?.complete && img.naturalWidth > 0);
      }, null, { timeout: 10_000 }).catch(() => undefined);
      const shown = await page.evaluate(() => {
        const img = document.querySelector('img[alt="Your current photo"]');
        return { src: img?.getAttribute("src") ?? "", complete: Boolean(img?.complete), width: img?.naturalWidth ?? -1, loading: img?.getAttribute("loading") ?? "" };
      });
      const fromBucket = /^http:\/\/127\.0\.0\.1:\d+\/storage\/v1\/object\/public\/avatars\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/.test(shown.src);
      ok(`${tag} the uploaded photo is shown, at 512 pixels from the avatars bucket`, shown.complete && shown.width === 512 && fromBucket, JSON.stringify({ complete: shown.complete, width: shown.width, loading: shown.loading, fromBucket }));
      await audit(page, "profile with a photo", tag);
      await structure(page, "profile with a photo", tag);
      await page.click('button[aria-label="Account menu"]');
      ok(`${tag} the account menu shows the photo and links to the profile editor`, (await page.locator('[role="menu"] a[href="/settings/profile"]').count()) === 1 && (await page.locator('button[aria-label="Account menu"] img').count()) === 1);
      await page.keyboard.press("Escape");
      await page.click("main button:has-text('Remove photo')");
      await page.waitForURL((u) => u.searchParams.get("notice") === "avatar_removed");
      await page.waitForLoadState("networkidle");
      ok(`${tag} the photo is removed, and the initial shows again`, (await page.locator('img[alt="Your current photo"]').count()) === 0 && (await visibleText(page)).includes("No photo yet"));
      ok(`${tag} and its file is gone`, psql(`select count(*) from storage.objects where bucket_id = 'avatars' and name like '${member.id}/%';`) === "0");

      // M11a-4a: downloading your data, with JavaScript, from the keyboard.
      await page.goto(`${origin}/settings/account`, { waitUntil: "networkidle" });
      await audit(page, "account, with the data download", tag);
      await structure(page, "account, with the data download", tag);
      const button = page.locator("main button:has-text('Download my data')");
      await button.focus();
      const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
      const saved = await file.path();
      const exported = JSON.parse(readFileSync(saved, "utf8"));
      ok(`${tag} the data download arrives as a file, complete, for this account`, file.suggestedFilename().startsWith(`my-game-dex-${member.handle}-`) && exported.complete === true && exported.account?.id === member.id);
      ok(`${tag} and the page stays where it was`, new URL(page.url()).pathname === "/settings/account");
      await page.goto(`${origin}/settings/account?error=export_too_many`, { waitUntil: "networkidle" });
      ok(`${tag} a refused download says why`, (await visibleText(page)).includes("three times in the last hour"));
      await audit(page, "account, download refused", tag);
      await context.close();
    }

    section(`${tag}: 2g. The fast add, ownership and a copy's identity (M12b)`);
    {
      const member = await person();
      const { context, page } = await signIn(browser, viewport, member);
      const game = "/games/starfall-odyssey";
      for (const [name, path] of [
        ["fast add, platform and region", game],
        ["fast add, editions", `${game}?platform=snes&region=ntsc-uc`],
        ["fast add, one release", `${game}?platform=snes&region=ntsc-uc&edition=${encodeURIComponent("collector~Collector's Edition")}`],
        ["fast add, without a release", `${game}?platform=snes&region=pal&edition=unsure`],
        ["fast add, naming the edition", `${game}?platform=snes&region=ntsc-uc&edition=other`],
        ["fast add, another platform", `${game}?platform=other`],
        ["fast add, another region", `${game}?platform=snes&region=other`],
        ["submitting a missing game", "/submit?title=Ayb%20Lantern%20Moon"],
        ["fast add, a linked release that doesn't match", `${game}?platform=snes&region=ntsc-uc&edition=unsure&release=${psql("select id from public.releases where product_code = 'SNS-ZSFE-USA-CE';")}`],
      ]) {
        await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        await audit(page, name, tag);
        await structure(page, name, tag);
      }
      await page.goto(`${origin}${game}?platform=snes&region=pal&edition=unsure`, { waitUntil: "networkidle" });
      await keyboard(page, "fast add, without a release", tag);

      // With JavaScript: a double click adds one copy, and the page says it was added.
      const add = page.locator("#add-claim ~ form button[type=submit], section[aria-labelledby=add-claim] button[type=submit]").first();
      await add.dblclick();
      await page.getByText("Added to your collection.").waitFor({ timeout: 15000 });
      const copies = () => Number(psql(`select count(*) from public.collection_items where owner_id = '${member.id}';`));
      ok(`${tag} a double click adds one copy without a release, and says so`, copies() === 1, `${copies()} copies`);
      ok(`${tag} the button then offers another copy`, (await add.innerText()).includes("Add another copy"));
      await add.click();
      await page.getByText("You have 2 copies of this game").waitFor({ timeout: 15000 });
      ok(`${tag} which adds a second copy on purpose`, copies() === 2);

      // Ownership, on the game page and in search results.
      await page.goto(`${origin}${game}`, { waitUntil: "networkidle" });
      ok(`${tag} the game page says what the collector owns`, (await visibleText(page)).includes("Owned: 2 copies"));
      await audit(page, "game page with ownership", tag);
      await page.goto(`${origin}/explore?q=starfall`, { waitUntil: "networkidle" });
      ok(`${tag} so do search results`, (await visibleText(page)).includes("Owned: 2 copies"));
      await audit(page, "search results with ownership", tag);

      // A copy's identity, changed with JavaScript, then its history.
      const item = psql(`select id from public.collection_items where owner_id = '${member.id}' order by id limit 1;`);
      await page.goto(`${origin}/collection/${item}`, { waitUntil: "networkidle" });
      await audit(page, "copy without a release", tag);
      await structure(page, "copy without a release", tag);
      await page.locator("#identity summary").click();
      await page.locator("#identity select[name=region]").selectOption("ntsc-j");
      await page.locator("#identity input[name=edition_name]").fill("Platinum");
      await page.locator("#identity button[type=submit]").click();
      await page.getByText("Saved. Your copy's details are updated").waitFor({ timeout: 15000 });
      ok(`${tag} the owner changes the region and edition`, psql(`select claimed_region_code || '/' || claimed_edition_name from public.collection_items where id = '${item}';`) === "ntsc-j/Platinum");
      await audit(page, "copy with its history", tag);
      await keyboard(page, "copy with its history", tag);
      await context.close();
    }

    section(`${tag}: 3. The admin's pages`);
    {
      const a = await signIn(browser, viewport, admin);
      for (const [name, path] of [
        ["overview", "/admin"],
        ["staff", "/admin/staff"],
        ["staff with a refusal", "/admin/staff?error=owner_only"],
        ["account lookup", `/admin/accounts?handle=${owner.handle}`],
        ["account search", "/admin/accounts?handle=ay_"],
        ["account with history", `/admin/accounts?handle=${collector.handle}`],
        ["account search refused", "/admin/accounts?handle=x"],
        ["audit log", "/admin/audit"],
        ["invitations", "/admin/invitations"],
        ["invitations with a refusal", "/admin/invitations?error=resend_too_soon"],
        ["audit log by kind and outcome", "/admin/audit?kind=accounts&outcome=succeeded"],
        ["audit log with a refused filter", "/admin/audit?kind=everything"],
        ["ownership", "/admin/ownership"],
        ["imports", "/admin/imports"],
        ["import run", `/admin/imports/runs/${importRun}`],
        ["system", "/admin/system"],
        ["catalog review", "/admin/catalog"],
        ["exclusions", "/admin/catalog/exclusions"],
        ["exclusion detail", `/admin/catalog/exclusions/${exclusionId}`],
        ["excluded release record", `/admin/catalog/releases/${excluded}`],
        ["verification", "/settings/security/verify?next=%2Fadmin"],
        ["security settings", "/settings/security"],
      ]) {
        await a.page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        await audit(a.page, `admin ${name}`, tag);
        await structure(a.page, `admin ${name}`, tag);
      }
      await a.page.goto(`${origin}/admin/catalog/exclusions/${exclusionId}`, { waitUntil: "networkidle" });
      ok(`${tag} the exclusion detail shows the real exclusion, linked to its release record`, (await visibleText(a.page)).includes("Browser checks: not a physical release")
        && (await a.page.locator(`a[href="/admin/catalog/releases/${excluded}"]`).count()) > 0);
      await a.page.goto(`${origin}/admin/catalog/releases/${excluded}`, { waitUntil: "networkidle" });
      ok(`${tag} an administrator's release record lists the exclusion, linked`, (await a.page.locator(`#release-exclusions a[href="/admin/catalog/exclusions/${exclusionId}"]`).count()) > 0
        && (await a.page.locator(`#history a[href="/admin/catalog/exclusions/${exclusionId}"]`).count()) > 0);
      await a.page.goto(`${origin}/admin/staff`, { waitUntil: "networkidle" });
      await keyboard(a.page, "admin staff page", tag);
      await a.page.goto(`${origin}/admin/accounts?handle=${collector.handle}`, { waitUntil: "networkidle" });
      await keyboard(a.page, "account with history", tag);
      ok(`${tag} the account shows its moderation summary and history`, (await visibleText(a.page)).includes("Browser checks: appeal") && /Reinstated\s+Once/.test(await visibleText(a.page)));
      await a.page.goto(`${origin}/admin/audit?kind=accounts`, { waitUntil: "networkidle" });
      await keyboard(a.page, "filtered audit log", tag);
      await a.page.goto(`${origin}/admin/invitations`, { waitUntil: "networkidle" });
      await keyboard(a.page, "invitations page", tag);
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

  // -------------------------------------------------------------------------
  section("6. Step-up from a catalog page, with JavaScript (M10a)");
  {
    const context = await browser.newContext({ viewport: { width: WIDTHS[1].width, height: WIDTHS[1].height } });
    const page = await context.newPage();
    await page.goto(`${origin}/sign-in`, { waitUntil: "networkidle" });
    await page.fill("#email", editor.email);
    await page.fill("#password", editor.password);
    await page.click('main button[type="submit"]');
    await page.waitForURL((u) => u.pathname === "/settings/security/verify");
    // Signed in with a password only, the editor opens a submission directly.
    await page.goto(`${origin}/admin/catalog/${submission}`);
    await page.waitForURL((u) => u.pathname === "/settings/security/verify" && u.searchParams.get("next") !== "/home");
    ok("an editor at aal1 opening a submission is sent to verify, and back to it afterwards", new URL(page.url()).searchParams.get("next") === `/admin/catalog/${submission}`, page.url());
    ok("and the submission isn't on the page meanwhile", !(await page.content()).includes(SUBMISSION_CODE));
    await page.fill("#verify-code", totp(editor.totpSecret));
    await page.click('main button[type="submit"]');
    await page.waitForURL((u) => u.pathname === `/admin/catalog/${submission}`);
    // The page streams in after the client-side navigation; wait for the frame itself.
    await page.waitForSelector('nav[aria-label="Admin sections"]', { timeout: 15000 }).catch(() => {});
    const opened = { sections: (await sectionsShown(page)).join(","), code: (await page.content()).includes(SUBMISSION_CODE) };
    ok("after verifying, the submission opens in the admin frame", opened.sections.includes("Catalog") && opened.code, JSON.stringify(opened));
    await context.close();
  }

  const errors = appErrorLines();
  ok("the app logged no errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  ok("the checks ran to the end", false, error.message);
} finally {
  await browser.close();
  stopApp();
  removeTestOwner(psql);
  // M10b's merge and exclusion are permanent by design; this test data goes with the triggers off.
  psql(`begin; set local session_replication_role = replica;
delete from private.catalog_merge_references where merge_id in (select m.id from private.catalog_merges m join public.releases r on r.id = m.source_release_id where r.product_code = 'AYB-DUP');
delete from private.catalog_merge_copies where merge_id in (select m.id from private.catalog_merges m join public.releases r on r.id = m.source_release_id where r.product_code = 'AYB-DUP');
delete from private.catalog_merges where source_release_id in (select id from public.releases where product_code = 'AYB-DUP');
delete from private.catalog_exclusion_copies where exclusion_id in (select e.id from private.catalog_exclusions e join public.releases r on r.id = e.release_id where r.product_code = 'AYB-EXC');
delete from private.catalog_exclusions where release_id in (select id from public.releases where product_code = 'AYB-EXC');
delete from private.catalog_verifications where release_id in (select id from public.releases where product_code in ('AYB-DUP', 'AYB-EXC'));
delete from private.catalog_record_origins where release_id in (select id from public.releases where product_code in ('AYB-DUP', 'AYB-EXC'));
delete from public.releases where product_code in ('AYB-DUP', 'AYB-EXC');
commit;`);
  // M14c-1's two games, with everything that records them.
  if (hasEvidenceRead()) {
    const games = `(select id from public.games where title in (${EVIDENCE_GAMES.map((t) => `'${t}'`).join(", ")}))`;
    psql(`begin; set local session_replication_role = replica;
delete from private.catalog_pairing_origins where game_id in ${games};
delete from public.game_platforms where game_id in ${games};
delete from private.game_title_keys where game_id in ${games};
delete from private.catalog_verifications where game_id in ${games};
delete from private.catalog_record_origins where game_id in ${games};
delete from public.game_aliases where game_id in ${games};
delete from public.games where id in ${games};
commit;`);
  }
  psql(`begin;
delete from private.catalog_reclassifications where reason like 'Browser checks%';
delete from private.import_run_records where import_run_id in (select id from private.import_runs where source_name = 'AYB snapshot.dat');
delete from private.provider_records where import_run_id in (select id from private.import_runs where source_name = 'AYB snapshot.dat');
delete from private.import_runs where source_name = 'AYB snapshot.dat';
commit;`);
  // The submission and its release, before the accounts, while they still name their submitter.
  const submitters = [...handles.keys()].map((id) => `'${id}'`).join(",") || "null";
  psql(`begin;
create temp table m10a_requests on commit drop as select * from public.catalog_change_requests where submitted_by in (${submitters});
delete from public.releases where product_code = '${SUBMISSION_CODE}' or id in (select release_id from m10a_requests);
delete from public.catalog_change_requests where id in (select id from m10a_requests);
commit;`);
  psql(`delete from private.account_invitations where email like '${PREFIX}-%';`);
  for (const id of psql(`select coalesce(string_agg(id::text, ','), '') from auth.users where email like '${PREFIX}-invitee-%';`).split(",").filter(Boolean)) {
    await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
  }
  const ids = await deleteUsers();
  const list = ids.map((id) => `'${id}'`).join(",") || "null";
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'ay\\_%';");
  removeFixture();
  ok("no account, Owner record, registration, hold, submission or audit row is left behind",
    catalogFootprint() === startingCatalog &&
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
if (LIGHT_DETAIL) (await import("node:fs")).writeFileSync(LIGHT_DETAIL, lightDetail.join("\n") + "\n");
process.exit(results.failed === 0 ? 0 : 1);
