/**
 * M11a session revocation: proves the session checks detect real weakenings of the new
 * authorization. For each: change the test database (one function or policy, as SQL),
 * run the session suites (pgTAP and db-session-checks), which must fail, then reset the
 * test database from the migrations. No source file is changed.
 *
 *   MGD_STACK=test node scripts/db-session-mutations.mjs [--only name,...]
 *
 * Test stack only. Opens and closes with a reset and passing suites.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dbContainer } from "./lib/stack.mjs";

if (process.env.MGD_STACK !== "test" || !dbContainer.endsWith("-test")) {
  console.error("Run against the test stack: MGD_STACK=test.");
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const psql = (sql) => execFileSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], { input: sql, encoding: "utf8" }).trim();
const def = (sig) => psql(`select pg_get_functiondef('${sig}'::regprocedure);`).split("\r\n").join("\n");
const without = (sig, text) => {
  const d = def(sig);
  if (d.split(text).length !== 2) throw new Error(`${sig}: the text to remove isn't there once`);
  return `${d.replace(text, "")};`;
};
const LIVE = " and (select private.session_is_live())";

/** Each: a name and the SQL that weakens one check (built from the current definitions). */
const mutations = [
  ["the session check always passes", () => "create or replace function private.session_is_live() returns boolean language sql stable security definer set search_path = '' as $m$ select true $m$;"],
  ["the session can be anyone's", () => without("private.session_is_live()", " and s.user_id = v_me")],
  ["an expired session (not_after) passes", () => without("private.session_is_live()", "\n      and (s.not_after is null or s.not_after > pg_catalog.now())")],
  ["writes don't check the session (is_active_user)", () => without("private.is_active_user()", LIVE)],
  ["purchase details are read without a session", () => "alter policy collection_item_private_read_own on public.collection_item_private using (owner_id = (select auth.uid()));"],
  ["copies are deleted without a session", () => "alter policy collection_items_delete_own on public.collection_items using (owner_id = (select auth.uid()));"],
  ["a submission is read without a session", () => without("public.get_my_submission(uuid)", LIVE)],
  ["blocking doesn't check the session (require_verified_user)", () => without("private.require_verified_user()", " or not (select private.session_is_live())")],
];

function run(args, label) {
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, MGD_STACK: "test" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { ok: r.status === 0, output, seconds: Math.round((Date.now() - started) / 1000), label };
}
const reset = () => run([join(root, "scripts", "test-stack.mjs"), "reset"], "reset");
const pgtap = () => run([join(root, "node_modules", "supabase", "dist", "supabase.js"), "test", "db", "--workdir", ".supabase-test"], "pgtap");
const checks = () => run([join(root, "scripts", "db-session-checks.mjs")], "db-session-checks");
const failures = (o) => o.split("\n").filter((l) => /^FAIL|^# Failed test/.test(l)).slice(0, 3).map((l) => l.slice(0, 120)).join("; ");
const log = (line) => console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`);

function baseline(label) {
  if (!reset().ok) throw new Error(`${label}: the reset failed`);
  const p = pgtap();
  const c = checks();
  if (!p.ok || !c.ok) throw new Error(`${label} baseline failed: ${failures(p.output + c.output)}`);
  log(`${label} baseline clean (pgTAP ${p.seconds}s, db-session-checks ${c.seconds}s: ${/(\d+) passed/.exec(c.output)?.[1]} passed)`);
}

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
const selected = only ? mutations.filter(([n]) => only.includes(n)) : mutations;
const started = Date.now();
let detected = 0;
baseline("Opening");
for (const [index, [name, build]] of selected.entries()) {
  log(`start [${index + 1}/${selected.length}] ${name}`);
  let outcome;
  try {
    psql(build());
    const p = pgtap();
    const c = checks();
    outcome = p.ok && c.ok ? { ok: false, detail: "both suites passed" } : { ok: true, detail: failures(p.output + c.output) };
  } catch (error) {
    outcome = { ok: false, detail: `not applied: ${error.message.split("\n")[0]}` };
  } finally {
    if (!reset().ok) throw new Error("the reset after a mutation failed; the test database may be weakened");
  }
  if (outcome.ok) detected += 1;
  log(`${outcome.ok ? "ok  " : "FAIL"} [${index + 1}/${selected.length}] ${name}: ${outcome.detail}`);
}
baseline("Closing");
log(`\n${detected} of ${selected.length} weakenings detected, in ${((Date.now() - started) / 60000).toFixed(1)} min${only ? " (a partial run)" : ""}.`);
process.exit(detected === selected.length && !only ? 0 : 1);
