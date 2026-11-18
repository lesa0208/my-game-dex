/**
 * M11a session-revocation checkpoint: what Auth does with "require current password"
 * (GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD), the hosted setting the
 * local CLI can't turn on. Starts a throwaway Auth server from the test stack's own
 * image and settings, plus that one setting, on the test stack's private network and a
 * loopback port; runs the cases against it; removes it. Changes nothing else.
 *
 *   npm run test-stack:run -- auth:password-policy-checks
 *
 * Test stack only (it reads the test Auth container's settings, passed to the new one
 * through its environment, never on a command line or printed). Throwaway accounts on
 * example.test. Nothing printed contains a token, key, password or address.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { decodeClaims, elevate, totp } from "./lib/mfa-session.mjs";
import { dbContainer, stackStatus } from "./lib/stack.mjs";

const status = stackStatus({ label: "the password policy checks" });
if (!dbContainer.endsWith("-test")) {
  console.error("Refusing: run against the test stack (MGD_STACK=test).");
  process.exit(1);
}
const project = dbContainer.replace(/^supabase_db_/, "");
const authContainer = `supabase_auth_${project}`;
const network = `supabase_network_${project}`;
const probeName = `mgd-auth-policy-probe-${randomBytes(3).toString("hex")}`;
const PORT = 55398;
const probe = `http://127.0.0.1:${PORT}`;
const api = status.API_URL;
const publishable = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
const service = { apikey: secretKey, Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" };
const psql = (sql) => execFileSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], { input: sql, encoding: "utf8" }).trim();

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` (${detail})` : ""}`);
}
const section = (t) => console.log(`\n${t}`);

/** Calls an Auth server: the stack's (through its gateway) or the probe (directly). */
async function call(base, method, path, { token, body, headers } = {}) {
  const r = await fetch(`${base}${path}`, { method, headers: headers ?? { apikey: publishable, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, code: json.error_code ?? json.code ?? null, body: json };
}
const stack = (m, p, o) => call(`${api}/auth/v1`, m, p, o);
const strict = (m, p, o) => call(probe, m, p, o);

function startProbe() {
  const env = execFileSync("docker", ["inspect", authContainer, "--format", "{{range .Config.Env}}{{println .}}{{end}}"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
  const image = execFileSync("docker", ["inspect", authContainer, "--format", "{{.Config.Image}}"], { encoding: "utf8" }).trim();
  // The Auth settings only: the image's own PATH and HOME stay the image's (and must not
  // replace this machine's PATH, which finds docker).
  const values = Object.fromEntries(env.filter(([name]) => !["PATH", "HOME", "HOSTNAME"].includes(name)));
  values.GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD = "true";
  // Names only on the command line; values come from this process's environment.
  const args = ["run", "-d", "--rm", "--name", probeName, "--network", network, "-p", `127.0.0.1:${PORT}:9999`];
  for (const name of Object.keys(values)) args.push("-e", name);
  args.push(image, "auth");
  const r = spawnSync("docker", args, { env: { ...process.env, ...values }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`couldn't start the probe Auth server: ${(r.stderr ?? "").trim().slice(0, 200)}`);
}
function stopProbe() {
  spawnSync("docker", ["rm", "-f", probeName], { encoding: "utf8" });
}

const tag = randomBytes(3).toString("hex");
const created = [];
const pw = () => `Pw-${randomBytes(12).toString("base64url")}`;
async function account(name) {
  const email = `dbpp-${tag}-${name}@example.test`;
  const password = pw();
  const made = await stack("POST", "/admin/users", { headers: service, body: { email, password, email_confirm: true } });
  if (made.status !== 200) throw new Error(`setup: account (${made.status})`);
  created.push(made.body.id);
  return { id: made.body.id, email, password };
}
const signIn = async (base, user, password = user.password) => (await call(base, "POST", "/token?grant_type=password", { body: { email: user.email, password } })).body;
const works = async (user, password) => (await stack("POST", "/token?grant_type=password", { body: { email: user.email, password } })).status === 200;

try {
  startProbe();
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    // A referenced timer, so a connection Docker holds open can't let the process exit mid-wait.
    up = await Promise.race([
      fetch(`${probe}/health`).then((r) => r.ok).catch(() => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  check("a probe Auth server with \"require current password\" is up (the same version as the stack)", up);
  check("the stack's own Auth has the setting off (the CLI can't set it)", !execFileSync("docker", ["inspect", authContainer, "--format", "{{range .Config.Env}}{{println .}}{{end}}"], { encoding: "utf8" }).includes("UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD=true"));

  section("A signed-in change");
  const a = await account("plain");
  let s = await signIn(probe, a);
  let r = await strict("PUT", "/user", { token: s.access_token, body: { password: pw() } });
  check("without the current password: refused", r.status === 400 && r.code === "current_password_required", `${r.status} ${r.code}`);
  r = await strict("PUT", "/user", { token: s.access_token, body: { password: pw(), current_password: "wrong-password-123" } });
  check("with a wrong current password: refused", r.status >= 400 && r.code === "current_password_invalid", `${r.status} ${r.code}`);
  check("and the password is unchanged", await works(a, a.password));
  const next = pw();
  r = await strict("PUT", "/user", { token: s.access_token, body: { password: next, current_password: a.password } });
  check("with the right current password: changed", r.status === 200, `${r.status} ${r.code}`);
  check("the old password no longer signs in, the new one does", !(await works(a, a.password)) && (await works(a, next)));
  a.password = next;
  const stackSession = await signIn(`${api}/auth/v1`, a);
  r = await stack("PUT", "/user", { token: stackSession.access_token, body: { password: pw(), current_password: "wrong-password-123" } });
  check("compatibility: with the setting off, Auth ignores current_password (the app checks it itself)", r.status === 200, `${r.status} ${r.code}`);

  section("Recovery by email");
  const b = await account("recover");
  const hash = (await stack("POST", "/admin/generate_link", { headers: service, body: { type: "recovery", email: b.email } })).body.hashed_token;
  const recovery = (await strict("POST", "/verify", { body: { type: "recovery", token_hash: hash } })).body;
  check("a recovery link signs in a recovery session (amr otp)", Boolean(recovery.access_token) && decodeClaims(recovery.access_token).amr?.some((m) => m.method === "otp"));
  const fresh = pw();
  r = await strict("PUT", "/user", { token: recovery.access_token, body: { password: fresh } });
  check("a reset without the old password is allowed: recovery sessions are exempt", r.status === 200, `${r.status} ${r.code}`);
  check("the new password works", await works(b, fresh));
  b.password = fresh;
  // A password session made later is not a recovery session, even for the same person.
  s = await signIn(probe, b);
  r = await strict("PUT", "/user", { token: s.access_token, body: { password: pw() } });
  check("an ordinary session afterwards needs the current password again", r.code === "current_password_required", `${r.status} ${r.code}`);
  // How long the exemption lasts in this version: a recovery session an hour old.
  const hash2 = (await stack("POST", "/admin/generate_link", { headers: service, body: { type: "recovery", email: b.email } })).body.hashed_token;
  const old = (await strict("POST", "/verify", { body: { type: "recovery", token_hash: hash2 } })).body;
  psql(`update auth.sessions set created_at = now() - interval '50 minutes' where id = '${decodeClaims(old.access_token).session_id}';`);
  r = await strict("PUT", "/user", { token: old.access_token, body: { password: pw() } });
  console.log(`  observed: a recovery session 50 minutes old ${r.status === 200 ? "may still reset without the old password (no 15-minute limit in v2.197)" : `is refused (${r.code}): a time limit applies`}`);

  section("With an authenticator, and staff");
  const t = await account("totp");
  const elevated = await elevate(`${api}`, publishable, await signIn(`${api}/auth/v1`, t));
  const aal1 = await signIn(probe, t);
  check("setup: one session at aal1, one at aal2", decodeClaims(aal1.access_token).aal === "aal1" && decodeClaims(elevated.access_token).aal === "aal2");
  r = await strict("PUT", "/user", { token: aal1.access_token, body: { password: pw(), current_password: t.password } });
  check("at aal1, even with the current password: refused (insufficient_aal)", r.status >= 400 && r.code === "insufficient_aal", `${r.status} ${r.code}`);
  r = await strict("PUT", "/user", { token: elevated.access_token, body: { password: pw() } });
  check("at aal2, without the current password: refused", r.code === "current_password_required", `${r.status} ${r.code}`);
  const tNext = pw();
  r = await strict("PUT", "/user", { token: elevated.access_token, body: { password: tNext, current_password: t.password } });
  check("at aal2 with the current password: changed", r.status === 200, `${r.status} ${r.code}`);
  t.password = tNext;
  const hash3 = (await stack("POST", "/admin/generate_link", { headers: service, body: { type: "recovery", email: t.email } })).body.hashed_token;
  const tRecovery = (await strict("POST", "/verify", { body: { type: "recovery", token_hash: hash3 } })).body;
  r = await strict("PUT", "/user", { token: tRecovery.access_token, body: { password: pw() } });
  check("a recovery session of an account with an authenticator still needs aal2 first", r.code === "insufficient_aal", `${r.status} ${r.code}`);
  void totp;

  const m = await account("staff");
  psql(`insert into public.staff_roles (user_id, role) values ('${m.id}', 'admin');`);
  const staffSession = await elevate(`${api}`, publishable, await signIn(`${api}/auth/v1`, m));
  const mNext = pw();
  r = await strict("PUT", "/user", { token: staffSession.access_token, body: { password: mNext, current_password: m.password } });
  check("an administrator changes their password the same way, nothing skipped", r.status === 200);
  check("and keeps their role (a password change touches no staff record)", psql(`select count(*) from public.staff_roles where user_id = '${m.id}';`) === "1");
} catch (error) {
  check(`the checks ran to the end (${error.message})`, false);
} finally {
  stopProbe();
  for (const id of created) await stack("DELETE", `/admin/users/${id}`, { headers: service });
  check("the probe Auth server is gone", !execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" }).includes(probeName));
  check("no test account is left behind", psql(`select count(*) from auth.users where email like 'dbpp-${tag}-%';`) === "0");
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
