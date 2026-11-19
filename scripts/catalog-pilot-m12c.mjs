/**
 * M12c-A: stages the first real physical catalog pilot on the ISOLATED TEST STACK only,
 * through the existing catalog workflow (scripts/catalog-pilot-m12c-data.mjs holds the
 * evidence and the candidates):
 *
 *   MGD_STACK=test node scripts/catalog-pilot-m12c.mjs clear-wikidata --terms-file <saved Wikidata:Licensing page>
 *   MGD_STACK=test node scripts/catalog-pilot-m12c.mjs import --snapshots <dir> --terms-file <same page>
 *   MGD_STACK=test node scripts/catalog-pilot-m12c.mjs stage
 *   MGD_STACK=test node scripts/catalog-pilot-m12c.mjs report
 *
 * - clear-wikidata: the operator procedure (record_provider_clearance), bound to the hash
 *   of the saved terms page, as M11b-D1 approved. Wikidata only: TheGamesDB, ScreenScraper,
 *   No-Intro and Redump stay uncleared.
 * - import: the M5b importer (scripts/catalog-import.mjs), connecting only as
 *   catalog_importer, with a fixed selection of the pilot's Wikidata items per platform.
 *   It creates unpublished game candidates and nothing else.
 * - stage: one disposable catalog editor (editor A) with a verified authenticator creates
 *   every A and B release candidate through the API (create_release, set_release_markets)
 *   with a reason citing the evidence, then shows that their own attempt to verify is
 *   refused (no self-review).
 *
 * Review and publication are NOT automated. They need a second, human catalog editor, who
 * re-reads each release's saved evidence in the admin catalog pages and verifies and
 * publishes it there (verify_game, verify_release, publish_release, each with recent MFA).
 * A script acting as that reviewer would fabricate the verification the review guard
 * exists to require, so this pilot stops at staged candidates until one is available.
 * - report: what's staged, published and held, read-only.
 *
 * The human reviewer's account (editor B). The product owner runs these themselves, in
 * their own terminal, only when they decide to; nothing runs them automatically:
 *
 *   MGD_STACK=test node scripts/catalog-pilot-m12c.mjs reviewer-account --email <name>@example.test
 *   MGD_STACK=test node scripts/catalog-pilot-m12c.mjs reviewer-password --email <name>@example.test
 *   MGD_STACK=test node scripts/catalog-pilot-m12c.mjs grant-reviewer --email <name>@example.test
 *   MGD_STACK=test node scripts/catalog-pilot-m12c.mjs revoke-reviewer --email <name>@example.test
 *
 * - reviewer-account: a confirmed test account. The password is typed at a hidden prompt
 *   on an interactive terminal (twice), sent only to the local Auth server, and never
 *   stored or printed. It has no staff role and no authenticator yet: the reviewer signs
 *   in on the test preview and enrolls their own authenticator under Settings → Security.
 * - grant-reviewer: the catalog_editor role, as for editor A, only for an account that
 *   isn't editor A, created none of the pilot's records, has a handle and has a verified
 *   authenticator of its own.
 * - revoke-reviewer: removes that role when the review is over.
 *
 * Nothing here writes a catalog row as postgres. postgres only records the clearance (an
 * operator procedure), reads, and gives the disposable test accounts their staff role,
 * as the review checks do. Every catalog change goes through the editors' own sessions,
 * so publication rules, MFA, RLS and the review guard all apply.
 *
 * Editor A's sign-in details are kept outside the repository, for the admin screens, in
 * ~/.my-game-dex/catalog-pilot/m12c-a/editors.local.json. Nothing secret is printed.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { GAMES, HELD, RELEASES, creationReason } from "./catalog-pilot-m12c-data.mjs";
import { elevate, reverify } from "./lib/mfa-session.mjs";
import { dbContainer, root, stackName, stackStatus } from "./lib/stack.mjs";

if (stackName !== "test") {
  console.error("Refusing: the M12c-A pilot runs only on the isolated test stack (MGD_STACK=test).");
  process.exit(2);
}
const status = stackStatus({ label: "the M12c-A catalog pilot" });
const api = status.API_URL;
const publishable = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const serviceKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
const dbPort = new URL(status.DB_URL).port;
const WORK = join(homedir(), ".my-game-dex", "catalog-pilot", "m12c-a");
const EDITORS = join(WORK, "editors.local.json");

const fail = (message) => {
  console.error(message);
  process.exit(2);
};
const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  }).trim();
const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// clear-wikidata
// ---------------------------------------------------------------------------

function clearWikidata(o) {
  if (!o["terms-file"] || o["terms-file"] === true) fail("--terms-file is required: the saved Wikidata:Licensing page.");
  const hash = sha256(readFileSync(o["terms-file"]));
  if (!readFileSync(o["terms-file"], "utf8").includes("released into the public domain under")) fail("That file isn't the Wikidata:Licensing page.");
  psql(`select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', ${lit(hash)},
    ${lit("M12c-A test stack: M11b-D1 approved Wikidata (CC0 structured data) for game identity. Saved terms copy read 2026-11-19. Game identity only: never evidence of a physical release.")});`);
  console.log(`wikidata cleared on the test stack against terms sha256 ${hash}`);
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

function latestSnapshot(dir, platform) {
  const files = readdirSync(dir).filter((f) => f.startsWith(`wikidata-${platform}-`) && f.endsWith(".json")).sort();
  return files.length ? join(dir, files.at(-1)) : null;
}

function importGames(o) {
  for (const k of ["snapshots", "terms-file"]) if (!o[k] || o[k] === true) fail(`--${k} is required.`);
  mkdirSync(WORK, { recursive: true });
  const platforms = [...new Set(GAMES.map((g) => g.platform))];
  const password = randomBytes(24).toString("base64url");
  const env = { ...process.env, CATALOG_IMPORTER_PASSWORD: password, MSYS_NO_PATHCONV: "1" };
  execFileSync(process.execPath, [join(root, "scripts", "catalog-import-role.mjs"), "enable"], { env, stdio: ["ignore", "ignore", "inherit"] });
  try {
    for (const platform of platforms) {
      const file = latestSnapshot(o.snapshots, platform);
      if (!file) fail(`No wikidata-${platform}-*.json snapshot in ${o.snapshots}. Fetch it with catalog-import.mjs fetch-wikidata.`);
      const wanted = GAMES.filter((g) => g.platform === platform).map((g) => g.qid);
      const snapshot = JSON.parse(readFileSync(file, "utf8")).results.bindings.map((b) => b.item.value.split("/").pop());
      const missing = wanted.filter((q) => !snapshot.includes(q));
      if (missing.length) fail(`${file} lacks ${missing.join(", ")}: check the items before importing.`);
      const selection = join(WORK, `selection-${platform}.json`);
      writeFileSync(selection, `${JSON.stringify({ selector: "m12c-a fixed pilot list", games: wanted, releases: [] }, null, 2)}\n`);
      console.log(`\n${platform}: ${wanted.length} games from ${file.split(/[\\/]/).pop()}`);
      execFileSync(process.execPath, [join(root, "scripts", "catalog-import.mjs"), "import", "--provider", "wikidata", "--platform", platform, "--file", file,
        "--terms-file", o["terms-file"], "--ids", selection, "--reason", `M12c-A pilot: game identity for ${wanted.length} ${platform} games (fixed list, docs/architecture/catalog-pilot-m12c.md)`], {
        env: { ...env, CATALOG_IMPORTER_DATABASE_URL: `postgresql://catalog_importer:${encodeURIComponent(password)}@127.0.0.1:${dbPort}/postgres` },
        stdio: ["ignore", "inherit", "inherit"],
      });
    }
  } finally {
    execFileSync(process.execPath, [join(root, "scripts", "catalog-import-role.mjs"), "disable"], { env, stdio: ["ignore", "ignore", "inherit"] });
  }
}

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

async function rpc(session, fn, body) {
  const response = await fetch(`${api}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: publishable, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: json?.message ?? `status ${response.status}` };
  return { ok: true, data: json };
}
async function must(session, fn, body) {
  const result = await rpc(session, fn, body);
  if (!result.ok) throw new Error(`${fn} refused: ${result.error}`);
  return result.data;
}

/** A disposable catalog editor on the test stack, with a verified authenticator and a handle. */
async function editor(label) {
  const email = `m12c-${label}-${randomUUID()}@example.test`;
  const password = `pw-${randomBytes(18).toString("base64url")}`;
  const created = await fetch(`${api}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`could not create editor ${label}: status ${created.status}`);
  const user = await created.json();
  const signIn = await fetch(`${api}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishable, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signIn.ok) throw new Error(`could not sign in editor ${label}`);
  const session = await elevate(api, publishable, await signIn.json(), `Editor ${label}`);
  await must(session, "claim_handle", { p_handle: `m12c_${label}_${randomBytes(3).toString("hex")}` });
  // Test-stack account setup, as the review checks do. No catalog row is touched here.
  psql(`insert into public.staff_roles (user_id, role) values (${lit(user.id)}, 'catalog_editor');`);
  return { label, id: user.id, email, password, session };
}

const revision = (table, id) => psql(`select revision from public.${table} where id = ${lit(id)};`);

async function stage() {
  const already = psql(`select count(*) from private.audit_events where action = 'catalog_record_created' and metadata ->> 'entity' = 'release' and reason like 'M12c-A %';`);
  if (already !== "0") fail(`The pilot is already staged (${already} records). Reset the test stack to stage it again.`);
  const games = Object.fromEntries(GAMES.map((g) => [g.key, psql(`select x.game_id from private.external_references x where x.provider_code = 'wikidata' and x.entity_type = 'game' and x.external_id = ${lit(g.qid)};`)]));
  const missing = GAMES.filter((g) => !games[g.key]);
  if (missing.length) fail(`Import these games first: ${missing.map((g) => g.title).join(", ")}.`);
  const platforms = Object.fromEntries(psql("select slug || '=' || id from public.platforms;").split("\n").map((l) => l.split("=")));

  const a = await editor("a");
  mkdirSync(WORK, { recursive: true });
  writeFileSync(EDITORS, `${JSON.stringify([a].map(({ label, id, email, password, session }) => ({ label, id, email, password, factorId: session.factorId, totpSecret: session.totpSecret })), null, 2)}\n`, { mode: 0o600 });
  console.log(`Editor A created on the test stack (sign-in details in ${EDITORS}, not printed).`);

  console.log("\nEditor A stages the candidates");
  const staged = {};
  for (const r of RELEASES) {
    const id = await must(a.session, "create_release", {
      p_game: games[r.game], p_platform: platforms[r.platform], p_media_format_code: r.format, p_region_code: r.region, p_details: r.facts, p_reason: creationReason(r),
    });
    if (r.markets.length) await must(a.session, "set_release_markets", { p_release: id, p_markets: r.markets, p_reason: `M12c-A ${r.id}: the countries the source names for this release` });
    staged[r.id] = id;
    console.log(`  ${r.id} ${r.class} staged`);
  }

  console.log("\nNo self-review: editor A can't verify or publish what they created");
  const own = RELEASES.find((r) => r.class === "A");
  a.session = await reverify(api, publishable, a.session);
  const verify = await rpc(a.session, "verify_release", { p_release: staged[own.id], p_reason: "M12c-A: the creator trying to verify", p_expected_revision: Number(revision("releases", staged[own.id])) });
  console.log(`  verify_release by its creator: ${verify.ok ? "ALLOWED (unexpected)" : `refused (${verify.error})`}`);
  const publish = await rpc(a.session, "publish_release", { p_release: staged[own.id], p_reason: "M12c-A: the creator trying to publish", p_expected_revision: Number(revision("releases", staged[own.id])) });
  console.log(`  publish_release by its creator: ${publish.ok ? "ALLOWED (unexpected)" : `refused (${publish.error})`}`);
  if (verify.ok || publish.ok) fail("Stopping: the review guard let a creator verify or publish their own release.");
  console.log(`\n${RELEASES.filter((x) => x.class === "A").length} A candidates await a second, human editor's review; ${RELEASES.filter((x) => x.class === "B").length} B candidates have a gap to close first; ${HELD.length} held entries were not entered.`);
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function report() {
  const rows = psql(`select g.title || '|' || g.status || '|' || coalesce(g.slug, '') || '|' || p.slug || '|' || r.media_format_code || '|' || r.region_code || '|' ||
      coalesce(r.edition_name, '') || '|' || coalesce(r.variant_name, '') || '|' || coalesce(r.product_code, '') || '|' || coalesce(r.barcode, '') || '|' || r.packaging_code || '|' || r.status || '|' ||
      coalesce((select string_agg(m.market_code, ',' order by m.market_code) from public.release_markets m where m.release_id = r.id), '')
    from public.releases r join public.games g on g.id = r.game_id join public.platforms p on p.id = r.platform_id
    order by p.slug, g.title, r.region_code, r.product_code nulls last, r.barcode;`);
  console.log("game|game status|slug|platform|format|region|edition|variant|code|barcode|packaging|release status|markets");
  console.log(rows);
  console.log(psql(`select 'games ' || count(*) filter (where status = 'published') || ' published, ' || count(*) filter (where status = 'under_review') || ' in review' from public.games;`));
  console.log(psql(`select 'releases ' || count(*) filter (where status = 'published') || ' published, ' || count(*) filter (where status = 'under_review') || ' in review' from public.releases;`));
  console.log(psql(`select 'held (not entered): ' || ${lit(HELD.map((h) => h.id).join(", "))};`));
}

// ---------------------------------------------------------------------------
// The human reviewer (editor B), run by the product owner
// ---------------------------------------------------------------------------

function reviewerEmail(o) {
  const email = typeof o.email === "string" ? o.email.trim().toLowerCase() : "";
  if (!/^[a-z0-9._+-]{1,64}@example\.test$/.test(email)) fail("--email must be a disposable test address ending in @example.test.");
  return email;
}

/** A line typed without echo, on an interactive terminal only. */
function hidden(prompt) {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          input.setRawMode(false);
          input.pause();
          input.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          input.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on("data", onData);
  });
}

async function reviewerAccount(o) {
  const email = reviewerEmail(o);
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("Run this yourself in an interactive terminal: the password is typed at a hidden prompt.");
  if (psql(`select count(*) from auth.users where lower(email) = ${lit(email)};`) !== "0") fail("That address already has an account on the test stack.");
  const password = await hidden("Choose a password for the reviewer account (12+ characters, not shown): ");
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 72) fail("The password must be at least 12 characters and at most 72 bytes.");
  if ((await hidden("Type it again: ")) !== password) fail("The two passwords differ. Nothing was created.");
  const created = await fetch(`${api}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) fail(`The test Auth server refused the account (status ${created.status}). Nothing was created.`);
  console.log(`Created ${email} on the test stack, with no staff role and no authenticator.
Next, on http://127.0.0.1:3002:
  1. Sign in with it, and choose a handle.
  2. Settings → Security: add an authenticator, scanning the code with your own authenticator app.
  3. Then grant the role: MGD_STACK=test node scripts/catalog-pilot-m12c.mjs grant-reviewer --email ${email}`);
}

/**
 * Sets a new password for the reviewer's own test account, at the same hidden prompt, and
 * confirms at once that it signs in. It says how many characters arrived (never which),
 * so a paste or keyboard problem in the terminal shows up here and not at sign-in.
 */
async function reviewerPassword(o) {
  const email = reviewerEmail(o);
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("Run this yourself in an interactive terminal: the password is typed at a hidden prompt.");
  const id = reviewerId(email);
  if (editorIds().includes(id)) fail("Refusing: that is editor A.");
  const password = await hidden("New password for the reviewer account (12+ characters, not shown): ");
  console.log(`${[...password].length} characters received.`);
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 72) fail("The password must be at least 12 characters and at most 72 bytes. Nothing was changed.");
  if ((await hidden("Type it again: ")) !== password) fail("The two passwords differ. Nothing was changed.");
  const updated = await fetch(`${api}/auth/v1/admin/users/${id}`, {
    method: "PUT",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!updated.ok) fail(`The test Auth server refused the change (status ${updated.status}). Nothing was changed.`);
  const signIn = await fetch(`${api}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishable, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signIn.ok) fail(`The password was set, but signing in with it failed (status ${signIn.status}).`);
  const session = await signIn.json();
  await fetch(`${api}/auth/v1/logout`, { method: "POST", headers: { apikey: publishable, Authorization: `Bearer ${session.access_token}` } });
  console.log(`Password set, and it signs in. Sign in on http://127.0.0.1:3002 with ${email}.`);
}

function editorIds() {
  try {
    return JSON.parse(readFileSync(EDITORS, "utf8")).map((e) => e.id);
  } catch {
    return [];
  }
}

function reviewerId(email) {
  const id = psql(`select id from auth.users where lower(email) = ${lit(email)};`);
  if (!id) fail("No account with that address on the test stack. Create it with reviewer-account first.");
  return id;
}

function grantReviewer(o) {
  const email = reviewerEmail(o);
  const id = reviewerId(email);
  let editorA = [];
  try {
    editorA = JSON.parse(readFileSync(EDITORS, "utf8")).map((e) => e.id);
  } catch {
    // No staged editor recorded on this machine: the created-records check still applies.
  }
  if (editorA.includes(id)) fail("Refusing: that is editor A, who created the candidates.");
  const created = psql(`select count(*) from private.audit_events where actor_id = ${lit(id)} and action = 'catalog_record_created';`);
  if (created !== "0") fail("Refusing: that account created catalog records, so it can't be their reviewer.");
  if (!psql(`select coalesce(handle, '') from public.profiles where id = ${lit(id)};`)) fail("Sign in on the test preview and choose a handle first.");
  if (psql(`select count(*) from auth.mfa_factors where user_id = ${lit(id)} and factor_type = 'totp' and status = 'verified';`) === "0") {
    fail("Add your own authenticator under Settings → Security on the test preview first.");
  }
  if (psql(`select count(*) from public.staff_roles where user_id = ${lit(id)} and role = 'catalog_editor';`) !== "0") fail("That account is already a catalog editor.");
  // Test-stack account setup, as for editor A. Verification and publication stay the reviewer's.
  psql(`insert into public.staff_roles (user_id, role) values (${lit(id)}, 'catalog_editor');`);
  console.log(`${email} is a catalog editor on the test stack. Sign in again on http://127.0.0.1:3002 and open Admin → Catalog.`);
}

function revokeReviewer(o) {
  const email = reviewerEmail(o);
  const id = reviewerId(email);
  const removed = psql(`with d as (delete from public.staff_roles where user_id = ${lit(id)} and role = 'catalog_editor' returning 1) select count(*) from d;`);
  console.log(removed === "0" ? "That account had no catalog editor role." : `${email} is no longer a catalog editor. Its history stays in the audit log.`);
}

const o = args(process.argv.slice(2));
const commands = { "clear-wikidata": clearWikidata, import: importGames, stage, report, "reviewer-account": reviewerAccount, "reviewer-password": reviewerPassword, "grant-reviewer": grantReviewer, "revoke-reviewer": revokeReviewer };
const command = commands[o._[0]];
if (!command) fail("Usage: MGD_STACK=test node scripts/catalog-pilot-m12c.mjs clear-wikidata|import|stage|report|reviewer-account|reviewer-password|grant-reviewer|revoke-reviewer. See the header of this file.");
try {
  await command(o);
} catch (error) {
  fail(`Stopped: ${error.message}`);
}
