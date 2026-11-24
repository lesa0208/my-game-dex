/**
 * M15 P1a hardening: rehearsals of the pilot's credential isolation and backups, on its disposable
 * twin only. The twin is the rehearsal stack (MGD_TEST_STACK=rehearsal node scripts/test-stack.mjs
 * start): the pilot's own-key setup (scripts/lib/stack-keys.mjs) and the same database image, but
 * disposable. The other side of the isolation proof is the scratch stack, which has the CLI's
 * shared keys, which are development's. Nothing here reads or writes the pilot, development, the
 * test stack or B1.
 *
 *   node scripts/pilot-rehearsal.mjs isolation
 *       Credentials of scratch (A) against the rehearsal twin (B): tokens, the secret and
 *       service_role keys, a token forged with A's JWT secret, an MFA (aal2) session and the S3 keys,
 *       each refused by B. B's own session, MFA and keys still work.
 *   node scripts/pilot-rehearsal.mjs backup --dir <absolute folder, outside the pilot's backups>
 *       pilot-backup.mjs's own dump, verify and snapshot on the twin. Also: pg_restore --list, a
 *       restore into an empty database in a throwaway container from the same image, tampered and
 *       interrupted backups, the backup folder's permissions, and the manual recovery from the
 *       snapshot (stop, copy back, start through the start guards, compare).
 *       Run it on data a pilot could hold: reset the twin, then `isolation` (users, an MFA factor),
 *       then `backup`. Not after the database suites: their cleanup deletes under
 *       session_replication_role = replica, which skips foreign-key cascades and leaves rows a
 *       faithful restore (--exit-on-error) rightly refuses.
 *   node scripts/pilot-rehearsal.mjs cleanup
 *       removes only what a rehearsal made: mgd_rehearsal_db_snapshot_* volumes and its throwaway
 *       restore container. The twin itself is destroyed with test-stack.mjs.
 *
 * No key is printed: checks print a status code or a yes/no. The synthetic users are
 * rehearsal-…@example.test.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { cliEnv, readStackKeys } from "./lib/stack-keys.mjs";
import { readMarker, writeMarker } from "./lib/stack-marker.mjs";

if (process.env.MGD_STACK && process.env.MGD_STACK !== "rehearsal") throw new Error(`Refusing: rehearsals run only on the rehearsal stack, not MGD_STACK=${process.env.MGD_STACK}.`);
process.env.MGD_STACK = "rehearsal";
const backup = await import("./pilot-backup.mjs");
const stack = await import("./lib/stack.mjs");
if (stack.stackName !== "rehearsal" || stack.projectId !== stack.REHEARSAL_PROJECT_ID) throw new Error("Refusing: this isn't the rehearsal stack.");

const RESTORE_CONTAINER = "mgd-rehearsal-restore-check";
const SCRATCH_API_PORT = stack.BASE_API_PORT + stack.STACKS.scratch.offset;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const docker = (argv, input) => execFileSync("docker", argv, { input, maxBuffer: 1024 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const kidOf = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString()).kid ?? null;
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

/** Scratch's status: its config names the scratch project, and its API is scratch's loopback port. */
function scratchStatus() {
  const dir = join(stack.root, stack.STACKS.scratch.dir);
  const config = readFileSync(join(dir, "supabase", "config.toml"), "utf8");
  if (/project_id\s*=\s*"([^"]+)"/.exec(config)?.[1] !== stack.SCRATCH_PROJECT_ID) throw new Error("Refusing: .supabase-scratch doesn't name the scratch project.");
  const status = JSON.parse(execFileSync(process.execPath, [stack.cli, "status", "-o", "json", "--workdir", dir], { cwd: stack.root, env: cliEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const url = new URL(status.API_URL);
  if (url.hostname !== "127.0.0.1" || Number(url.port) !== SCRATCH_API_PORT) throw new Error("Refusing: that isn't the scratch stack's API.");
  return status;
}

async function call(base, path, { key, bearer, method = "GET", body, headers = {} } = {}) {
  const h = { ...headers };
  if (key) h.apikey = key;
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  if (body) h["Content-Type"] = "application/json";
  // A fresh connection each time: a pooled one dies when the stack restarts (snapshot, recovery).
  h.Connection = "close";
  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
      break;
    } catch (error) {
      if (attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    // not JSON
  }
  return { status: response.status, json };
}

const refused = (status) => status === 401 || status === 403 || status === 400;
const password = () => `Rh-${randomBytes(18).toString("base64url")}-9a`;

async function user(s, label) {
  const email = `rehearsal-${label}-${randomBytes(4).toString("hex")}@example.test`;
  const pw = password();
  const created = await call(s.API_URL, "/auth/v1/admin/users", { key: s.SECRET_KEY, method: "POST", body: { email, password: pw, email_confirm: true } });
  if (created.status !== 200) throw new Error(`Creating a synthetic user on ${label} failed: ${created.status}`);
  const signin = await call(s.API_URL, "/auth/v1/token?grant_type=password", { key: s.PUBLISHABLE_KEY, method: "POST", body: { email, password: pw } });
  if (signin.status !== 200) throw new Error(`Signing in on ${label} failed: ${signin.status}`);
  return { email, token: signin.json.access_token };
}

function hs256(secret, payload) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

function totp(base32, time = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of base32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, "0");
}

/** A SigV4-signed S3 ListBuckets, as any S3 client would send it with these keys. */
async function s3ListBuckets(base, id, secret, region) {
  const url = new URL("/storage/v1/s3/", base);
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const date = amzDate.slice(0, 8);
  const payload = sha256("");
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const canonical = `GET\n${url.pathname}\n\nhost:${url.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amzDate}\n\n${signed}\n${payload}`;
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonical)}`;
  let k = createHmac("sha256", `AWS4${secret}`).update(date).digest();
  for (const part of [region, "s3", "aws4_request"]) k = createHmac("sha256", k).update(part).digest();
  const signature = createHmac("sha256", k).update(toSign).digest("hex");
  const response = await fetch(url, {
    headers: { "x-amz-date": amzDate, "x-amz-content-sha256": payload, Authorization: `AWS4-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=${signed}, Signature=${signature}` },
  });
  return response.status;
}

async function isolation() {
  const a = scratchStatus();
  const b = stack.stackStatus({ label: "the rehearsal" }); // refuses unless B reports its own keys
  const B = b.API_URL;
  console.log(`A: scratch ${a.API_URL} (the CLI's shared keys, as development). B: rehearsal ${B} (its own keys).\n`);

  check("B's own keys differ from A's: publishable, secret, JWT secret, anon, service_role",
    ["PUBLISHABLE_KEY", "SECRET_KEY", "JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY"].every((k) => a[k] && b[k] && a[k] !== b[k]));
  check("B's anon and service_role keys are signed with its own key, not A's", kidOf(b.ANON_KEY) !== kidOf(a.ANON_KEY) && kidOf(b.SERVICE_ROLE_KEY) === kidOf(b.ANON_KEY));

  const ua = await user(a, "a");
  const ub = await user(b, "b");
  // A's legacy anon key is HS256 (no kid); its sessions are signed with the CLI's shared ES256 key.
  check("B's sessions are signed with B's own key, A's with another", kidOf(ub.token) === kidOf(b.ANON_KEY) && kidOf(ua.token) !== kidOf(ub.token), `A ${kidOf(ua.token)?.slice(0, 8)}…, B ${kidOf(ub.token)?.slice(0, 8)}…`);

  // 3. A legitimate session on B works.
  let r = await call(B, "/auth/v1/user", { key: b.PUBLISHABLE_KEY, bearer: ub.token });
  check("B's own session: Auth accepts it", r.status === 200, `${r.status}`);
  r = await call(B, "/rest/v1/profiles?select=id&limit=1", { key: b.PUBLISHABLE_KEY, bearer: ub.token });
  check("B's own session: the Data API accepts it", r.status === 200, `${r.status}`);
  r = await call(B, "/storage/v1/bucket", { key: b.PUBLISHABLE_KEY, bearer: ub.token });
  check("B's own session: Storage accepts it", r.status === 200, `${r.status}`);

  // 1. A token issued by A is refused by B.
  r = await call(B, "/auth/v1/user", { key: b.PUBLISHABLE_KEY, bearer: ua.token });
  check("A's session token: B's Auth refuses it", refused(r.status), `${r.status}`);
  r = await call(B, "/rest/v1/profiles?select=id&limit=1", { key: b.PUBLISHABLE_KEY, bearer: ua.token });
  check("A's session token: B's Data API refuses it", refused(r.status), `${r.status}`);
  r = await call(B, "/storage/v1/bucket", { key: b.PUBLISHABLE_KEY, bearer: ua.token });
  check("A's session token: B's Storage refuses it", refused(r.status), `${r.status}`);
  r = await call(a.API_URL, "/auth/v1/user", { key: a.PUBLISHABLE_KEY, bearer: ub.token });
  check("and the reverse: B's session token, A's Auth refuses it", refused(r.status), `${r.status}`);

  // 2. A privileged credential from A cannot authorize privileged operations on B.
  r = await call(B, "/auth/v1/admin/users", { key: a.SECRET_KEY });
  check("A's secret key: B's Auth admin refuses it", refused(r.status), `${r.status}`);
  // B's Data API (like every local stack's) answers a request without a key it knows as anonymous,
  // not with an error: so A's keys must get exactly what no key gets, and nothing that B's own
  // secret key (the service_role) gets.
  const view = async (key) => {
    const response = await fetch(`${B}/rest/v1/profiles?select=id`, { headers: { ...(key ? { apikey: key } : {}), Prefer: "count=exact" } });
    return `${response.status} ${response.headers.get("content-range")} ${await response.text()}`;
  };
  const anonymous = await view(null);
  const privileged = await view(b.SECRET_KEY);
  r = { status: await view(a.SECRET_KEY) };
  check("A's secret key: B's Data API treats it as no key at all (anonymous, not service_role)", r.status === anonymous && r.status !== privileged, anonymous.split(" ").slice(0, 2).join(" "));
  check("A's publishable key: B's Data API treats it as no key at all", (await view(a.PUBLISHABLE_KEY)) === anonymous);
  r = await call(B, "/storage/v1/bucket", { key: a.SECRET_KEY });
  check("A's secret key: B's Storage refuses it", refused(r.status), `${r.status}`);
  r = await call(B, "/auth/v1/admin/users", { key: a.SERVICE_ROLE_KEY, bearer: a.SERVICE_ROLE_KEY });
  check("A's legacy service_role key: B's Auth admin refuses it", refused(r.status), `${r.status}`);
  r = await call(B, "/rest/v1/profiles?select=id&limit=1", { key: b.PUBLISHABLE_KEY, bearer: a.SERVICE_ROLE_KEY });
  check("A's legacy service_role key: B's Data API refuses it", refused(r.status), `${r.status}`);
  r = await call(B, "/storage/v1/bucket", { key: b.PUBLISHABLE_KEY, bearer: a.SERVICE_ROLE_KEY });
  check("A's legacy service_role key: B's Storage refuses it", refused(r.status), `${r.status}`);
  const now = Math.floor(Date.now() / 1000);
  const forged = hs256(a.JWT_SECRET, { role: "service_role", iss: "supabase-demo", iat: now, exp: now + 600 });
  r = await call(B, "/auth/v1/admin/users", { key: b.PUBLISHABLE_KEY, bearer: forged });
  check("a service_role token signed with A's JWT secret: B's Auth admin refuses it", refused(r.status), `${r.status}`);
  r = await call(B, "/rest/v1/profiles?select=id&limit=1", { key: b.PUBLISHABLE_KEY, bearer: forged });
  check("a service_role token signed with A's JWT secret: B's Data API refuses it", refused(r.status), `${r.status}`);
  r = await call(B, "/auth/v1/admin/users", { key: b.SECRET_KEY });
  check("B's own secret key still works on B (Auth admin)", r.status === 200, `${r.status}`);

  // 4. MFA on B: enrol, challenge, verify; the aal2 session works on B and is refused by A.
  const enrol = await call(B, "/auth/v1/factors", { key: b.PUBLISHABLE_KEY, bearer: ub.token, method: "POST", body: { factor_type: "totp", friendly_name: "rehearsal" } });
  let aal2 = null;
  if (enrol.status === 200) {
    const challenge = await call(B, `/auth/v1/factors/${enrol.json.id}/challenge`, { key: b.PUBLISHABLE_KEY, bearer: ub.token, method: "POST", body: {} });
    const verify = await call(B, `/auth/v1/factors/${enrol.json.id}/verify`, { key: b.PUBLISHABLE_KEY, bearer: ub.token, method: "POST", body: { challenge_id: challenge.json?.id, code: totp(enrol.json.totp.secret) } });
    aal2 = verify.status === 200 ? verify.json.access_token : null;
  }
  check("MFA on B: a TOTP factor enrols and verifies, giving an aal2 session", aal2 && claims(aal2).aal === "aal2", `${enrol.status}`);
  if (aal2) {
    r = await call(B, "/auth/v1/factors", { key: b.PUBLISHABLE_KEY, bearer: aal2, method: "POST", body: { factor_type: "totp", friendly_name: "second" } });
    const user = await call(B, "/auth/v1/user", { key: b.PUBLISHABLE_KEY, bearer: aal2 });
    check("MFA on B: the aal2 session is B's own, accepted by B", user.status === 200 && kidOf(aal2) === kidOf(b.ANON_KEY), `${user.status}`);
    r = await call(a.API_URL, "/auth/v1/user", { key: a.PUBLISHABLE_KEY, bearer: aal2 });
    check("MFA on B: A refuses B's aal2 session", refused(r.status), `${r.status}`);
  }

  // The S3 protocol: its keys are the CLI's own on every stack, so it is off on B.
  const onA = await s3ListBuckets(a.API_URL, a.S3_PROTOCOL_ACCESS_KEY_ID, a.S3_PROTOCOL_ACCESS_KEY_SECRET, a.S3_PROTOCOL_REGION);
  const onB = await s3ListBuckets(B, a.S3_PROTOCOL_ACCESS_KEY_ID, a.S3_PROTOCOL_ACCESS_KEY_SECRET, a.S3_PROTOCOL_REGION);
  check("A's S3 keys: A accepts a signed ListBuckets (the shared keys work where S3 is on)", onA === 200, `${onA}`);
  check("A's S3 keys: B refuses them (S3 is off on B)", onB !== 200 && onB >= 400, `${onB}`);
  check("B's status carries no S3 keys", !b.S3_PROTOCOL_ACCESS_KEY_ID && !b.S3_PROTOCOL_ACCESS_KEY_SECRET);
}

// Backups -----------------------------------------------------------------------------------------

const psqlIn = (container, db, sql) => docker(["exec", "-i", container, "psql", "-U", "postgres", "-d", db, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], Buffer.from(sql)).toString();
const integrity = (name) => readFileSync(join(stack.root, "scripts", "sql", "integrity", `${name}.sql`), "utf8");
const MIGRATIONS_SQL = "select version||' '||name||' '||md5(array_to_string(statements, E'\\n')) from supabase_migrations.schema_migrations order by version;";
/** Who may do what: table privileges and function EXECUTE for the API roles, and RLS flags. */
const PRIVILEGES_SQL = `select n.nspname||'.'||c.relname||' '||r||' '||concat_ws(',',
    case when has_table_privilege(r, c.oid, 'select') then 's' end, case when has_table_privilege(r, c.oid, 'insert') then 'i' end,
    case when has_table_privilege(r, c.oid, 'update') then 'u' end, case when has_table_privilege(r, c.oid, 'delete') then 'd' end)
    ||' rls='||c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join unnest(array['anon','authenticated','service_role']) r
  where n.nspname in ('public','private') and c.relkind in ('r','p','v')
union all
select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||r||' x='||has_function_privilege(r, p.oid, 'execute')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join unnest(array['anon','authenticated','service_role']) r
  where n.nspname in ('public','private')
order by 1;`;
const lines = (text) => new Set(text.split(/\r?\n/).filter(Boolean));
const differ = (x, y) => [...lines(x)].filter((l) => !lines(y).has(l)).length + [...lines(y)].filter((l) => !lines(x).has(l)).length;

function waitFor(fn, seconds, what) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    try {
      if (fn()) return;
    } catch {
      // not yet
    }
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}.`);
    execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"]);
  }
}

async function backups(o) {
  if (typeof o.dir !== "string") throw new Error("--dir <absolute folder> is required.");
  const target = backup.backupTarget("rehearsal", { backupDir: o.dir });
  const live = await backup.connect(target);
  const container = live.dbContainer;

  // A complete dump, verified.
  const made = await backup.dump(target, "empty", live);
  check("dump: every file and a manifest written", existsSync(made.manifest) && Object.keys(made.files).length === backup.DUMP_FILES.length + 1, `${Object.keys(made.files).length} files, the manifest included`);
  check("verify: every file matches its manifest", backup.verifyManifest(made.manifest, "rehearsal").length === 0);
  const toc = docker(["exec", "-i", container, "pg_restore", "-l"], readFileSync(made.dump)).toString();
  const entries = toc.split("\n").filter((l) => /^\d+;/.test(l));
  check("pg_restore --list reads the dump", entries.length > 1000, `${entries.length} entries, ${entries.filter((l) => / TABLE DATA /.test(l)).length} table data`);

  // Never overwritten.
  const when = /-(\d{8}T\d{6}Z)$/.exec(made.base)[1];
  const date = new Date(`${when.slice(0, 4)}-${when.slice(4, 6)}-${when.slice(6, 8)}T${when.slice(9, 11)}:${when.slice(11, 13)}:${when.slice(13, 15)}Z`);
  let again = null;
  try {
    backup.dumpPlan("empty", date, existsSync, target);
  } catch (error) {
    again = error;
  }
  check("a second backup with the same name is refused", /Nothing is ever overwritten/.test(again?.message ?? ""));
  let overwrite = null;
  try {
    writeFileSync(made.dump, "x", { flag: "wx" });
  } catch (error) {
    overwrite = error.code;
  }
  check("the dump file itself can't be overwritten by the tool's writes (wx)", overwrite === "EEXIST");

  // Private: the backups, and the stack's own key files.
  const keyDir = join(stack.root, stack.STACKS.rehearsal.dir, "supabase");
  for (const [label, file] of [["the backup files", made.dump], ["the key file .env", join(keyDir, ".env")], ["the key file signing_keys.json", join(keyDir, "signing_keys.json")]]) privateCheck(label, file);

  // Tampering.
  const tamper = join(o.dir, "tampered");
  mkdirSync(tamper, { recursive: true });
  for (const name of readdirSync(o.dir).filter((n) => n.startsWith(basename(made.base)))) cpSync(join(o.dir, name), join(tamper, name));
  const copy = join(tamper, basename(made.dump));
  const bytes = readFileSync(copy);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  writeFileSync(copy, bytes);
  check("verify finds a changed byte in the dump", backup.verifyManifest(join(tamper, basename(made.manifest)), "rehearsal").includes(basename(made.dump)));
  const manifest = readFileSync(made.manifest, "utf8");
  const refusedWith = (text, pattern) => {
    try {
      backup.manifestEntries(text, basename(made.manifest), "rehearsal");
      return false;
    } catch (error) {
      return pattern.test(error.message);
    }
  };
  check("verify refuses a manifest with a file left out", refusedWith(manifest.split("\n").slice(1).join("\n"), /incomplete/));
  check("verify refuses a manifest naming a file outside the backup", refusedWith(`${manifest}${"0".repeat(64)} *../${basename(made.dump)}\n`, /Malformed/));
  check("verify refuses a manifest listing a file twice", refusedWith(`${manifest}${manifest.split("\n")[0]}\n`, /twice/));
  check("a pilot verify refuses a rehearsal manifest (and so the reverse)", (() => {
    try {
      backup.manifestEntries(manifest, basename(made.manifest), "pilot");
      return false;
    } catch {
      return true;
    }
  })());

  // Interrupted backups: a failure mid-way (the database paused), and the process killed.
  docker(["pause", container]);
  let failed = null;
  try {
    await backup.dump(target, "staged", live);
  } catch (error) {
    failed = error;
  } finally {
    docker(["unpause", container]);
  }
  // Answering again before the next check.
  waitFor(() => Boolean(live.stackStatus({ label: "the rehearsal" })), 60, "the rehearsal stack after the pause");
  const failedBase = readdirSync(o.dir).filter((n) => n.startsWith("rehearsal-staged-") && n.endsWith(".FAILED.txt")).map((n) => n.slice(0, -".FAILED.txt".length))[0];
  check("a dump that fails mid-way says so, and is marked FAILED", /failed and is incomplete/.test(failed?.message ?? "") && failedBase);
  check("a failed dump has no manifest, so it can never verify", failedBase && !existsSync(join(o.dir, `${failedBase}.sha256`)));
  const killed = await killedDump(o.dir);
  check("a dump killed mid-way leaves no manifest", killed.started && !killed.manifest, killed.detail);

  // Restore into an empty database in a throwaway container from the same image.
  restoreCheck(made);

  // The twin's start guards, on the real running stack (exactly the pilot's).
  guardChecks();

  // Snapshot, then the manual recovery from it.
  await snapshotAndRecover(target, live);
}

function privateCheck(label, file) {
  if (process.platform === "win32") {
    const acl = execFileSync("icacls", [file], { encoding: "utf8" });
    const principals = acl.split(/\r?\n/).map((l) => l.replace(file, "").trim()).filter((l) => l.includes(":")).map((l) => l.split(":")[0]);
    const others = principals.filter((p) => !/^(NT AUTHORITY\\SYSTEM|BUILTIN\\Administrators)$/i.test(p) && !p.toLowerCase().endsWith(`\\${process.env.USERNAME?.toLowerCase()}`));
    check(`${label}: readable by this user, SYSTEM and Administrators only (Windows ACL; mode 600 has no effect there)`, others.length === 0, principals.join(", "));
  } else {
    check(`${label}: owner-only (600)`, (statSync(file).mode & 0o777) === 0o600);
  }
}

/** Its restart checks refuse a missing marker and another stack's marker, then pass again. */
function guardChecks() {
  const file = stack.STACKS.rehearsal.marker;
  const preflight = () => {
    try {
      execFileSync(process.execPath, [join(stack.root, "scripts", "test-stack.mjs"), "preflight"], { cwd: stack.root, env: { ...process.env, MGD_TEST_STACK: "rehearsal" }, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
      return "";
    } catch (error) {
      return String(error.stderr ?? error.message);
    }
  };
  const tool = () => {
    try {
      stack.stackStatus({ label: "the rehearsal" });
      return "";
    } catch (error) {
      return error.message;
    }
  };
  const original = readFileSync(file, "utf8");
  const record = readMarker(file);
  check("its marker says it was created, with its own key's kid", record?.state === "created" && record.kid === readStackKeys(join(stack.root, stack.STACKS.rehearsal.dir, "supabase")).kids[0]);
  check("restart checks pass on the running twin", preflight() === "", preflight().trim().slice(0, 200));
  try {
    rmSync(file);
    check("restart refused with its marker missing", /protection marker .* is missing/.test(preflight()));
    check("every tool refuses it with its marker missing", /marker .* is missing/.test(tool()));
    writeMarker(file, { stack: "rehearsal", state: "created", kid: "00000000-0000-4000-8000-000000000000" });
    check("restart refused with a marker for other keys", /other signing keys/.test(preflight()));
    check("every tool refuses it with a marker for other keys", /other signing keys/.test(tool()));
  } finally {
    writeFileSync(file, original);
  }
  check("restart checks pass again with its own marker back", preflight() === "");
  check("and the tools accept it again", tool() === "");
}

async function killedDump(dir) {
  const before = new Set(readdirSync(dir));
  const child = spawn(process.execPath, [import.meta.filename, "dump-only", "--dir", dir], { cwd: stack.root, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const started = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const fresh = readdirSync(dir).filter((n) => !before.has(n) && n.startsWith("rehearsal-batch-"));
      if (fresh.some((n) => n.endsWith(".created.txt"))) {
        child.kill("SIGKILL");
        clearInterval(timer);
        resolve(true);
      }
    }, 5);
    child.on("exit", () => {
      clearInterval(timer);
      resolve(false);
    });
  });
  await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.on("exit", resolve)));
  const fresh = readdirSync(dir).filter((n) => !before.has(n) && n.startsWith("rehearsal-batch-"));
  return { started, manifest: fresh.some((n) => n.endsWith(".sha256")), detail: `left ${fresh.map((n) => n.replace(/^rehearsal-batch-\d{8}T\d{6}Z\./, "")).join(", ") || "nothing"}${started ? "" : `; the child: ${stderr.trim().slice(0, 300)}`}` };
}

function restoreCheck(made) {
  const base = made.base;
  docker(["rm", "-f", "-v", RESTORE_CONTAINER]).toString();
  docker(["run", "-d", "--name", RESTORE_CONTAINER, "--label", "mgd.purpose=rehearsal-restore-check", "-e", `POSTGRES_PASSWORD=${randomBytes(18).toString("base64url")}`, backup.POSTGRES_IMAGE]);
  try {
    const ready = () => docker(["exec", RESTORE_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-At", "-c", "select count(*) from pg_roles where rolname = 'authenticator'"]).toString().trim() === "1";
    waitFor(ready, 120, "the throwaway database");
    execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 4000)"]); // the image's init restarts PostgreSQL once
    waitFor(ready, 60, "the throwaway database after its init");
    docker(["exec", "-i", RESTORE_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1"], Buffer.from(`
      do $$ begin
        if not exists (select from pg_roles where rolname = 'catalog_importer') then create role catalog_importer nologin; end if;
        if not exists (select from pg_roles where rolname = 'supabase_functions_admin') then create role supabase_functions_admin nologin; end if;
        if not exists (select from pg_roles where rolname = 'supabase_realtime_admin') then create role supabase_realtime_admin nologin; end if;
      end $$;
      create database restore_check owner postgres;`));
    let restoreError = null;
    try {
      docker(["exec", "-i", RESTORE_CONTAINER, "pg_restore", "-U", "supabase_admin", "-d", "restore_check", "--exit-on-error"], readFileSync(made.dump));
    } catch (error) {
      restoreError = String(error.stderr ?? error.message).split("\n").find((l) => /error/i.test(l)) ?? "failed";
    }
    check("restore into a new, empty database (owner postgres) in a throwaway container: no error", !restoreError, restoreError ?? "exit 0");
    const fingerprint = psqlIn(RESTORE_CONTAINER, "restore_check", integrity("fingerprint"));
    const source = readFileSync(`${base}.fingerprint.txt`, "utf8");
    check("restored rows: every table's row count and content hash equal the source's", differ(fingerprint, source) === 0, `${lines(source).size} tables`);
    check("restored migration history equals the source's", psqlIn(RESTORE_CONTAINER, "restore_check", MIGRATIONS_SQL) === readFileSync(`${base}.migrations.txt`, "utf8"), `${lines(readFileSync(`${base}.migrations.txt`, "utf8")).size} migrations`);
    const roles = [...readFileSync(`${base}.roles.sql`, "utf8").matchAll(/^CREATE ROLE ([\w"]+);/gm)].map((m) => m[1].replace(/"/g, ""));
    const have = lines(docker(["exec", RESTORE_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-At", "-c", "select rolname from pg_roles"]).toString());
    const missing = roles.filter((r) => !have.has(r));
    check("every role of the source exists where it was restored", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : `${roles.length} roles`);
    const privileges = { source: psqlIn(stack.dbContainer, "postgres", PRIVILEGES_SQL), restored: psqlIn(RESTORE_CONTAINER, "restore_check", PRIVILEGES_SQL) };
    check("restored ACLs: anon, authenticated and service_role have the same table, function and RLS rights", differ(privileges.source, privileges.restored) === 0, `${lines(privileges.source).size} rights compared`);
    const security = psqlIn(RESTORE_CONTAINER, "restore_check", integrity("security"));
    // pg_dump leaves out an ACL equal to the default, so a table's explicit owner-only ACL
    // ({owner=arwdDxtm/owner}) comes back as the default ("-"): the same rights. Anything else differs.
    const trim = (text) => new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const [was, now] = [trim(readFileSync(`${base}.security.txt`, "utf8")), trim(security)];
    const gone = [...was].filter((l) => !now.has(l));
    const added = [...now].filter((l) => !was.has(l));
    const explained = (l) => {
      const m = /^rel (\S+) (\S+) \{(\S+)=arwdDxtm\/(\S+)\} (rls=\w+)$/.exec(l);
      return m && m[2] === m[3] && m[3] === m[4] && now.has(`rel ${m[1]} ${m[2]} - ${m[5]}`);
    };
    check("security inventory: equal, apart from owner-only table ACLs restored as the equivalent default",
      gone.every(explained) && added.length === gone.length, `${gone.length} table ACL(s) normalised, ${gone.filter((l) => !explained(l)).length} other difference(s)`);

    // Keys in the dump: read as SQL inside the throwaway container.
    const text = docker(["exec", "-i", RESTORE_CONTAINER, "pg_restore", "-f", "-"], readFileSync(made.dump));
    const keys = readStackKeys(join(stack.root, stack.STACKS.rehearsal.dir, "supabase"));
    const holds = Object.entries(keys.env).filter(([, v]) => text.includes(v)).map(([k]) => k);
    console.log(`INFO  key values readable in the dump: ${holds.length ? holds.join(", ") : "none"}`);
  } finally {
    docker(["rm", "-f", "-v", RESTORE_CONTAINER]);
  }
}

async function snapshotAndRecover(target, live) {
  const taken = await backup.snapshot(target, "empty", live);
  const control = docker(["run", "--rm", "-v", `${taken.volume}:/d:ro`, "--entrypoint", "pg_controldata", backup.POSTGRES_IMAGE, "/d"]).toString();
  check("snapshot: taken from a clean shutdown, contents and metadata equal, the stack restarted unchanged", /cluster state:\s+shut down\b/.test(control) && taken.after.fingerprint === taken.before.fingerprint);

  // A change after the snapshot, then the documented manual recovery: stop, copy back, start.
  const b = live.stackStatus({ label: "the rehearsal" });
  await user(b, "after-snapshot");
  const changed = psqlIn(live.dbContainer, "postgres", integrity("fingerprint"));
  check("a change after the snapshot shows in the data", changed !== taken.after.fingerprint);
  const run = (command) => execFileSync(process.execPath, [join(stack.root, "scripts", "test-stack.mjs"), command], { cwd: stack.root, env: { ...process.env, MGD_TEST_STACK: "rehearsal", MGD_CREATE_REHEARSAL: "" }, stdio: ["ignore", "ignore", "inherit"] });
  run("stop");
  docker(["run", "--rm", "-v", `${taken.volume}:/from:ro`, "-v", `${target.volume}:/to`, "alpine", "sh", "-c", "find /to -mindepth 1 -delete && cp -a /from/. /to/"]);
  const digest = (v) => docker(["run", "--rm", "-v", `${v}:/d:ro`, "alpine", "sh", "-c", "cd /d && find . -type f | sort | xargs -r sha256sum | sha256sum"]).toString();
  check("recovery: the volume copied back equals the snapshot", digest(taken.volume) === digest(target.volume));
  run("start");
  const recovered = psqlIn(live.dbContainer, "postgres", integrity("fingerprint"));
  check("recovery: started through its guards, the data is the snapshot's again (the later change is gone)", recovered === taken.after.fingerprint);
  const status = live.stackStatus({ label: "the rehearsal" });
  const again = await call(status.API_URL, "/auth/v1/admin/users", { key: status.SECRET_KEY });
  check("recovery: its own keys work again after the copy back", again.status === 200, `${again.status}`);
}

function cleanup() {
  const volumes = docker(["volume", "ls", "-q"]).toString().split(/\r?\n/).filter((v) => /^mgd_rehearsal_db_snapshot_[a-z]+_\d{8}t\d{6}z$/.test(v));
  for (const v of volumes) docker(["volume", "rm", v]);
  try {
    docker(["rm", "-f", "-v", RESTORE_CONTAINER]);
  } catch {
    // not there
  }
  console.log(`Removed ${volumes.length} rehearsal snapshot volume(s).`);
}

const o = args(process.argv.slice(2));
const commands = {
  isolation,
  backup: backups,
  // Only for the interruption check: a dump this process is killed in the middle of.
  "dump-only": async (opts) => {
    const target = backup.backupTarget("rehearsal", { backupDir: opts.dir });
    await backup.dump(target, "batch", await backup.connect(target));
  },
  cleanup,
};
if (!commands[o._[0]]) {
  console.error("Usage: node scripts/pilot-rehearsal.mjs isolation | backup --dir <absolute folder> | cleanup");
  process.exit(2);
}
try {
  await commands[o._[0]](o);
} catch (error) {
  console.error(`Stopped: ${error.message}`);
  process.exit(1);
}
if (results.length) {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} of ${results.length} checks passed.`);
  if (failed) process.exit(1);
}
