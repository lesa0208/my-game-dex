/**
 * Runs several mutation suites one after another, unattended, through
 * db-mutation-checks.mjs. Everything each suite prints goes to its own log file; the
 * terminal shows only each violation's result, the baselines and each suite's total.
 * The full test output of a violation that fails or survives is saved, one file each;
 * the output of violations detected as expected is discarded. A short summary is
 * written at the end, and its location is recorded in `latest.txt`.
 *
 *   npm run mutation:campaign                      the approved M7b-2b campaign
 *   npm run mutation:campaign -- --dry-run         checks and prints the plan, runs nothing
 *   npm run mutation:campaign -- --steps m6,m7b1   only these suites, in this order
 *   npm run mutation:campaign -- --dir <path>      where to write, instead of a new folder
 *
 * A step is a suite name, or `suite:violation name` for one violation of it. Local
 * only, like db-mutation-checks.mjs, which also refuses anything but the local stack.
 * If a suite stops (rather than reporting undetected violations), the campaign stops
 * too, because the database may need attention. Rerun the remaining suites with
 * --steps.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { suites } from "./security-mutations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STEPS = ["m7b2b", "m7b2a", "m6", "m7b1", "m5a:game published without a physical release"];
/** Minutes per violation, measured on this machine with the current test suites. */
const MINUTES_PER_VIOLATION = 4.6;

const argument = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};
const clock = () => new Date().toTimeString().slice(0, 8);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const minutes = (ms) => `${Math.round(ms / 60000)} min`;

const steps = (argument("--steps")?.split(",") ?? DEFAULT_STEPS).map((text) => {
  const [suite, ...rest] = text.trim().split(":");
  return { suite, only: rest.length ? rest.join(":").trim() : null };
});
for (const step of steps) {
  if (!suites[step.suite]) throw new Error(`Unknown suite: ${step.suite}`);
  if (step.only && !suites[step.suite].some((m) => m.name === step.only)) throw new Error(`Unknown violation in ${step.suite}: ${step.only}`);
}
const count = (step) => (step.only ? 1 : suites[step.suite].length);
const label = (step) => (step.only ? `${step.suite} (${step.only})` : step.suite);

const base = join(homedir(), ".my-game-dex", "mutation-campaigns");
const directory = resolve(argument("--dir") ?? join(base, stamp()));
const failures = join(directory, "failures");

function say(line) {
  const text = `${clock()} ${line}`;
  console.log(text);
  appendFileSync(join(directory, "campaign.log"), `${text}\n`);
}

/** Things that would waste hours if found later. */
function preflight() {
  const problems = [];
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    problems.push("Docker isn't running. Start Docker Desktop, then npm run db:start.");
  }
  try {
    const status = JSON.parse(execFileSync(process.execPath, [join(root, "node_modules", "supabase", "dist", "supabase.js"), "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(status.API_URL ?? "")) problems.push("The Supabase stack isn't the local one.");
  } catch {
    problems.push("The local Supabase stack isn't running. Run npm run db:start.");
  }
  // Source mutations change files under the recovery journal; edits made meanwhile would conflict.
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  if (dirty) problems.push("The working tree has uncommitted changes. Commit or stash them first: some violations edit source files.");
  return problems;
}

function runStep(step) {
  return new Promise((resolveStep) => {
    const name = step.only ? `${step.suite}-only` : step.suite;
    const args = ["scripts/db-mutation-checks.mjs", "--suite", step.suite, "--log", join(directory, `${name}.log`), "--out", join(directory, `${name}.json`), "--artifacts", failures];
    if (step.only) args.push("--only", step.only);
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let stopped = false;
    let total = null;
    const onLine = (line) => {
      const text = line.replace(/^\d\d:\d\d:\d\d /, "");
      if (/^FAIL mutation run stopped/.test(text)) stopped = true;
      const summary = /^(\d+) of (\d+) violations detected as expected, in one run of ([\d.]+) min/.exec(text);
      if (summary) total = { detected: Number(summary[1]), of: Number(summary[2]), minutes: Number(summary[3]) };
      // Only results, baselines, totals and stops; never the test output.
      if (/^(ok  |FAIL) \[\d+\/\d+\]|^FAIL |baseline|violations detected as expected|^PARTIAL/.test(text)) say(`${step.suite} ${text.slice(0, 300)}`);
    };
    const read = (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) onLine(line);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("close", (code) => {
      if (buffer) onLine(buffer);
      resolveStep({ code, stopped, total });
    });
  });
}

mkdirSync(failures, { recursive: true });
const planned = steps.reduce((sum, step) => sum + count(step), 0);
say(`Mutation campaign: ${steps.map((s) => `${label(s)} (${count(s)})`).join(", ")}`);
say(`${planned} violations, about ${Math.round((planned * MINUTES_PER_VIOLATION) / 6) / 10} hours. Writing to ${directory}`);
const problems = preflight();
for (const problem of problems) say(`NOT READY: ${problem}`);
if (problems.length) process.exit(2);
if (process.argv.includes("--dry-run")) {
  say("Dry run: ready. Nothing was run.");
  process.exit(0);
}
mkdirSync(base, { recursive: true });
writeFileSync(join(base, "latest.txt"), `${directory}\n`);

const started = Date.now();
const results = [];
for (const step of steps) {
  say(`=== ${label(step)}: ${count(step)} violations, about ${Math.round(count(step) * MINUTES_PER_VIOLATION)} min`);
  const stepStarted = Date.now();
  const outcome = await runStep(step);
  const result = { suite: step.suite, only: step.only, exit: outcome.code, stopped: outcome.stopped, ...outcome.total, elapsed: minutes(Date.now() - stepStarted) };
  results.push(result);
  say(`=== ${label(step)}: ${outcome.total ? `${outcome.total.detected} of ${outcome.total.of} detected` : "no total"}${outcome.stopped ? ", STOPPED" : ""}, ${result.elapsed}`);
  if (outcome.stopped || !outcome.total) {
    say("Stopping the campaign: this suite didn't finish. See its log; run npm run db:mutation -- --recover if a source file was being mutated.");
    break;
  }
}

const lines = [
  `Mutation campaign, ${new Date(started).toISOString()}, ${minutes(Date.now() - started)}`,
  `Folder: ${directory}`,
  "",
  ...results.map((r) => `${r.stopped || !r.of ? "STOPPED" : r.detected === r.of ? "ok     " : "FAILED "} ${r.only ? `${r.suite} (${r.only})` : r.suite}: ${r.of ? `${r.detected} of ${r.of} detected` : "no total"}, ${r.elapsed}`),
  ...steps.slice(results.length).map((s) => `NOT RUN ${label(s)}`),
  "",
];
const failed = results.flatMap((r) => {
  try {
    const name = r.only ? `${r.suite}-only` : r.suite;
    return JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8"))
      .filter((x) => x.problems.length)
      .map((x) => `  ${r.suite}: ${x.name}: ${x.problems.join("; ").slice(0, 300)}${x.artifact ? `\n    output: ${x.artifact}` : ""}`);
  } catch {
    return [];
  }
});
lines.push(failed.length ? "Violations that failed or survived:" : "Every violation that ran was detected as expected.", ...failed, "");
writeFileSync(join(directory, "summary.txt"), lines.join("\n"));
writeFileSync(join(directory, "summary.json"), JSON.stringify(results, null, 1));
console.log(`\n${lines.join("\n")}`);
const complete = results.length === steps.length && results.every((r) => !r.stopped && r.of && r.detected === r.of);
process.exit(complete ? 0 : 1);
