/**
 * Local database workflow. Always targets the local Supabase stack.
 *
 *   node scripts/db.mjs start | stop | status | reset | test | verify
 *
 * All CLI output passes through a redactor, because the CLI prints local keys
 * and connection strings when non-interactive.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");

export function redact(text) {
  return text
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s"]+:)[^@\s"]+@/g, "$1[REDACTED]@")
    .replace(/"([A-Z0-9_]*(?:SECRET|KEY|PASSWORD|TOKEN)[A-Z0-9_]*)"\s*:\s*"[^"]*"/g, '"$1":"[REDACTED]"');
}

function requireDocker() {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    console.error("Docker isn't running. Start Docker Desktop and try again.");
    process.exit(1);
  }
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(redact(chunk.toString())));
    child.stderr.on("data", (chunk) => process.stderr.write(redact(chunk.toString())));
    child.on("close", (code) => resolve(code ?? 1));
  });
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
  pgtap: () => runCli(["test", "db"]),
  smoke: () => runNode("db-smoke.mjs"),
  identity: () => runNode("db-identity-checks.mjs"),
  authorization: () => runNode("db-authorization-checks.mjs"),
  audit: () => runNode("db-audit-checks.mjs"),
  notifications: () => runNode("db-notification-checks.mjs"),
  catalog: () => runNode("db-catalog-checks.mjs"),
  imports: () => runNode("db-import-checks.mjs"),
  search: () => runNode("db-search-checks.mjs"),
  collection: () => runNode("db-collection-checks.mjs"),
  submissions: () => runNode("db-submission-checks.mjs"),
  review: () => runNode("db-review-checks.mjs"),
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
  const plans = {
    start: ["start"],
    stop: ["stop"],
    status: ["status"],
    reset: ["reset"],
    test: ["pgtap", "smoke", "identity", "authorization", "audit", "notifications", "catalog", "imports", "search", "collection", "submissions", "review"],
    verify: ["start", "reset", "pgtap", "smoke", "identity", "authorization", "audit", "notifications", "catalog", "imports", "search", "collection", "submissions", "review"],
  };
  if (!plans[command]) {
    console.error("Usage: node scripts/db.mjs start|stop|status|reset|test|verify");
    process.exit(2);
  }
  if (!existsSync(cli)) {
    console.error("Supabase CLI not found. Run npm ci.");
    process.exit(1);
  }
  requireDocker();
  process.exit(await runSteps(plans[command]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
