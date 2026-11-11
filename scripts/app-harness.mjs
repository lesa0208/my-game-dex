/**
 * Shared harness for the end-to-end app checks (app-auth-checks.mjs and
 * app-collection-checks.mjs): the local stack's status, the production app on a spare
 * port, a browser-like HTTP client without JavaScript, and throwaway test accounts.
 *
 * Local only. Nothing here prints keys, tokens or cookies.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const results = { passed: 0, failed: 0 };
export function check(name, ok, detail = "") {
  if (ok) results.passed += 1;
  else results.failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` (${detail})` : ""}`);
}
export const section = (title) => console.log(`\n${title}`);

export function psql(sql) {
  return execFileSync("docker", ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

// ---------------------------------------------------------------------------
// The local stack
// ---------------------------------------------------------------------------

const status = JSON.parse(execFileSync(process.execPath, [cli, "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
export const api = status.API_URL;
export const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const serviceKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
if (!api || !publishableKey || !serviceKey) {
  console.error("Couldn't read the local stack's status. Is it running? Try npm run db:start.");
  process.exit(1);
}
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(api).hostname)) {
  console.error("Refusing: the stack's API isn't on a loopback address.");
  process.exit(1);
}
export const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

function newestSource(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs);
  }
  return newest;
}

let origin = null;
let app = null;
let appErrors = "";

/**
 * Starts `next start` on the production build, which must exist and be newer than every
 * source file, or the checks would test old code. Exits if it doesn't.
 */
export async function startApp(port) {
  const buildId = join(root, ".next", "BUILD_ID");
  if (!existsSync(buildId)) {
    console.error("No production build found. Run npm run build first.");
    process.exit(1);
  }
  if (statSync(buildId).mtimeMs < newestSource(join(root, "src"))) {
    console.error("The production build is older than the source. Run npm run build first.");
    process.exit(1);
  }
  origin = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    // `next start` serves the production build, with NODE_ENV=production.
    env: { ...process.env, NODE_ENV: "production", SUPABASE_URL: api, SUPABASE_PUBLISHABLE_KEY: publishableKey, ENABLE_SEED_DATA: "false" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  app.stderr.on("data", (chunk) => (appErrors += chunk.toString()));
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${origin}/explore`, { redirect: "manual" });
      if (response.status < 500) return origin;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The app didn't start. Run npm run build first.");
}

export function stopApp() {
  app?.kill();
}

/** Error lines the app logged, other than ones a check provoked on purpose. Redacted. */
export function appErrorLines(expected = null) {
  return [...new Set(appErrors.split("\n").filter((line) => /Error|⨯/.test(line) && !(expected && expected.test(line))))].map((line) =>
    line.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[REDACTED]").replace(/sb_(secret|publishable)_[\w-]+/g, "[REDACTED]").slice(0, 300),
  );
}
export const appLog = () => appErrors;

/** A browser-like client: a cookie jar, no JavaScript, redirects followed by hand. */
export class Browser {
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

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export const decode = (value) =>
  value.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Every form on a page, with its hidden inputs and the names of its other fields. */
export function forms(html) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(([, attributes, inner]) => {
    const hidden = {};
    const names = [];
    for (const [input] of inner.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)) {
      const name = /\bname="([^"]*)"/.exec(input)?.[1];
      if (!name) continue;
      const decoded = decode(name);
      if (/^<input\b/.test(input) && /\btype="hidden"/.test(input)) hidden[decoded] = decode(/\bvalue="([^"]*)"/.exec(input)?.[1] ?? "");
      else names.push(decoded);
    }
    return { id: /\bid="([^"]*)"/.exec(attributes)?.[1] ?? null, hidden, names };
  });
}
export const formWith = (html, name) => forms(html).find((form) => form.names.includes(name) || name in form.hidden);
export const formById = (html, id) => forms(html).find((form) => form.id === id);
export const location = (response) => response.headers.get("location") ?? "";
export const isRedirect = (response) => response.status >= 300 && response.status < 400;
/** A redirect thrown while streaming is sent as a page that redirects in the browser. */
export const streamedRedirectTo = (html, target) =>
  html.includes(`"${target}"`) || html.includes(`url=${target}`) || html.includes(target.replace(/\?/g, "\\u003f"));

// ---------------------------------------------------------------------------
// Test accounts
// ---------------------------------------------------------------------------

const createdUsers = new Set();

export async function createUser({ confirmed = true, prefix = "app" } = {}) {
  const email = `${prefix}-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
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

export async function deleteUsers() {
  for (const id of createdUsers) {
    await fetch(`${api}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: service });
  }
  return [...createdUsers];
}

/** Decodes the session cookie, joining chunks, to test refresh and forgery. Never printed. */
export function readSession(browser) {
  const names = browser.authCookieNames().filter((name) => /-auth-token(\.\d+)?$/.test(name)).sort();
  const value = names.map((name) => browser.cookies.get(name)).join("");
  if (!value.startsWith("base64-")) return null;
  return { names, session: JSON.parse(Buffer.from(value.slice(7), "base64url").toString("utf8")) };
}

export function writeSession(browser, names, session) {
  for (const name of names) browser.cookies.delete(name);
  const base = names[0].replace(/\.\d+$/, "");
  browser.cookies.set(base, `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`);
}

export async function signInAs(browser, user, next = "/settings") {
  const page = await browser.get(`/sign-in?next=${encodeURIComponent(next)}`);
  return browser.submit("/sign-in", formWith(page.html, "password"), { email: user.email, password: user.password });
}
