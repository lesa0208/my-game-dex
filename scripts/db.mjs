/**
 * Local database workflow. Always targets a local Supabase stack: the development stack,
 * or with MGD_STACK=test the isolated test stack (scripts/lib/stack.mjs). Resetting and
 * testing refuse a protected development stack.
 *
 *   node scripts/db.mjs start | stop | status | reset | migrations | pgtap | suites | test | verify
 *
 * test and verify check that every migration file is applied in order and that every pgTAP
 * file ran and passed (M14b, scripts/lib/pgtap-report.mjs), then run the 23 API suites.
 * CI runs test on a disposable scratch stack (.github/workflows/ci.yml).
 *
 * All CLI output passes through a redactor, because the CLI prints local keys
 * and connection strings when non-interactive.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");

import { redact } from "./lib/redact.mjs";
import { checkPgtapReport } from "./lib/pgtap-report.mjs";
import { dbContainer, guardDevStack, requireStack, stackDir, stackName, workdirArgs } from "./lib/stack.mjs";

export { redact };

function requireDocker() {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    console.error("Docker isn't running. Start Docker Desktop and try again.");
    process.exit(1);
  }
}

function runCli(args, { capture = false } = {}) {
  let output = "";
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, ...workdirArgs], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const relay = (stream) => (chunk) => {
      const text = redact(chunk.toString());
      if (capture) output += text;
      stream.write(text);
    };
    child.stdout.on("data", relay(process.stdout));
    child.stderr.on("data", relay(process.stderr));
    child.on("close", (code) => resolve(capture ? { code: code ?? 1, output } : (code ?? 1)));
  });
}

/**
 * M14b: every migration file in this stack's supabase/migrations is applied, in order, and
 * nothing else is. A migration that fails stops the stack from starting; this also catches
 * one that was never picked up (a misnamed file) or a database built from other files.
 */
function checkMigrations() {
  const files = readdirSync(join(stackDir, "supabase", "migrations")).filter((name) => name.endsWith(".sql")).sort();
  const misnamed = files.filter((name) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(name));
  const result = spawnSync("docker", ["exec", dbContainer, "psql", "-U", "postgres", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c",
    "select version from supabase_migrations.schema_migrations order by version"], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`Couldn't read the applied migrations from ${dbContainer}.`);
    return 1;
  }
  const applied = result.stdout.split(/\r?\n/).filter(Boolean);
  const expected = files.map((name) => name.slice(0, 14));
  const problems = misnamed.map((name) => `${name} isn't named <14-digit version>_<name>.sql`);
  if (applied.join() !== expected.join()) {
    const missing = expected.filter((v) => !applied.includes(v));
    const extra = applied.filter((v) => !expected.includes(v));
    problems.push(`applied migrations differ from the files: ${missing.length} not applied (${missing.slice(0, 5).join(", ")}), ${extra.length} not in the files (${extra.slice(0, 5).join(", ")})`);
  }
  if (problems.length) {
    for (const problem of problems) console.error(`Migrations: ${problem}`);
    return 1;
  }
  console.log(`Migrations: all ${files.length} files applied in order (latest ${expected.at(-1)}).`);
  return 0;
}

/** M14b: pg_prove's own result, then a check that every test file ran and passed in full. */
async function runPgtap() {
  const { code, output } = await runCli(["test", "db"], { capture: true });
  const files = readdirSync(join(stackDir, "supabase", "tests", "database"));
  const { errors, files: ran, assertions } = checkPgtapReport(output, files);
  for (const error of errors) console.error(`pgTAP: ${error}`);
  if (code !== 0 || errors.length) {
    console.error(`pgTAP failed (exit ${code}, ${errors.length} problem${errors.length === 1 ? "" : "s"}).`);
    return 1;
  }
  console.log(`pgTAP: all ${ran} files ran and passed, ${assertions} assertions.`);
  return 0;
}

function runNode(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(root, "scripts", script)], { cwd: root, stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const steps = {
  start: () => runCli(["start"]),
  stop: () => runCli(["stop"]),
  status: () => runCli(["status"]),
  reset: () => runCli(["db", "reset"]),
  migrations: async () => checkMigrations(),
  pgtap: runPgtap,
  smoke: () => runNode("db-smoke.mjs"),
  identity: () => runNode("db-identity-checks.mjs"),
  authorization: () => runNode("db-authorization-checks.mjs"),
  audit: () => runNode("db-audit-checks.mjs"),
  notifications: () => runNode("db-notification-checks.mjs"),
  catalog: () => runNode("db-catalog-checks.mjs"),
  imports: () => runNode("db-import-checks.mjs"),
  releases: () => runNode("db-release-identity-checks.mjs"),
  claims: () => runNode("db-ownership-claim-checks.mjs"),
  wishlist: () => runNode("db-wishlist-checks.mjs"),
  search: () => runNode("db-search-checks.mjs"),
  collection: () => runNode("db-collection-checks.mjs"),
  submissions: () => runNode("db-submission-checks.mjs"),
  review: () => runNode("db-review-checks.mjs"),
  relink: () => runNode("db-relink-checks.mjs"),
  exclusion: () => runNode("db-exclusion-checks.mjs"),
  merge: () => runNode("db-merge-checks.mjs"),
  owner: () => runNode("db-owner-checks.mjs"),
  mfa: () => runNode("db-mfa-checks.mjs"),
  ownership: () => runNode("db-ownership-checks.mjs"),
  invitations: () => runNode("db-invitation-checks.mjs"),
  passwords: () => runNode("db-password-checks.mjs"),
  sessions: () => runNode("db-session-checks.mjs"),
};

async function runSteps(names) {
  const results = [];
  for (const name of names) {
    console.log(`\n--- ${name} ---`);
    const code = await steps[name]();
    results.push({ name, ok: code === 0 });
    if (code !== 0) break;
  }
  console.log("\n=== Summary ===");
  for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}`);
  for (const name of names.slice(results.length)) console.log(`SKIP  ${name}`);
  return results.length === names.length && results.every((result) => result.ok) ? 0 : 1;
}

async function main() {
  const command = process.argv[2];
  const suites = ["smoke", "identity", "authorization", "audit", "notifications", "catalog", "imports", "releases", "claims", "wishlist", "search", "collection", "submissions", "review", "relink", "exclusion", "merge", "owner", "mfa", "ownership", "invitations", "passwords", "sessions"];
  const plans = {
    start: ["start"],
    stop: ["stop"],
    status: ["status"],
    reset: ["reset"],
    migrations: ["migrations"],
    pgtap: ["migrations", "pgtap"],
    suites,
    test: ["migrations", "pgtap", ...suites],
    verify: ["start", "reset", "migrations", "pgtap", ...suites],
  };
  if (!plans[command]) {
    console.error("Usage: node scripts/db.mjs start|stop|status|reset|migrations|pgtap|suites|test|verify");
    process.exit(2);
  }
  if (!existsSync(cli)) {
    console.error("Supabase CLI not found. Run npm ci.");
    process.exit(1);
  }
  // M14b: CI sets MGD_EXPECT_STACK=scratch, so nothing here can run against another stack.
  if (process.env.MGD_EXPECT_STACK) requireStack(process.env.MGD_EXPECT_STACK, `db:${command}`);
  requireDocker();
  // M15: the pilot stack is never reset or tested; only its read-only migration check may run on it.
  // It is started only by test-stack.mjs, which refuses to recreate it or change it on a restart.
  if (stackName === "pilot" && command === "start") {
    console.error("Refusing: start the pilot with MGD_TEST_STACK=pilot node scripts/test-stack.mjs start (it checks the pilot exists and is unchanged).");
    process.exit(1);
  }
  if (!["start", "stop", "status"].includes(command)) guardDevStack(`db:${command}`, { editorial: command === "migrations" });
  console.log(`Stack: ${stackName}`);
  process.exit(await runSteps(plans[command]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
