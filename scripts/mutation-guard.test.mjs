/**
 * The mutation runners can't run by accident (M12c-B1, after checkpoint four).
 *
 *   node --test scripts/mutation-guard.test.mjs     (npm run mutation:guard-test)
 *
 * Offline: no stack, no network. The runners are started only without the opt-in, and each
 * must refuse before it writes anything.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MUTATION_DB_STACK, OPT_IN_VARIABLE, requireMutationOptIn } from "./lib/mutation-guard.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const ok = { [OPT_IN_VARIABLE]: "1", MGD_STACK: "scratch" };

test("the database runner refuses without the opt-in, a named suite and the scratch stack", () => {
  const refuse = (argv, env) => assert.throws(() => requireMutationOptIn({ kind: "db", argv, env }), /Refusing to run destructive mutation testing/);
  refuse([], {});
  refuse([], ok);
  refuse(["--suite", "m6"], { MGD_STACK: "scratch" });
  refuse(["--suite"], ok);
  refuse(["--suite", "--log", "x"], ok);
  for (const stack of [undefined, "dev", "test", "b1"]) refuse(["--suite", "m6"], { [OPT_IN_VARIABLE]: "1", ...(stack ? { MGD_STACK: stack } : {}) });
  refuse(["--suite", "m6"], { ...ok, [OPT_IN_VARIABLE]: "true" });
  refuse(["--self-test", "database"], { [OPT_IN_VARIABLE]: "1", MGD_STACK: "test" });
  assert.equal(MUTATION_DB_STACK, "scratch");
});

test("an explicit, scoped database run is allowed; recovery and offline self-tests need no opt-in", () => {
  assert.equal(requireMutationOptIn({ kind: "db", argv: ["--suite", "m6"], env: ok }), "run");
  assert.equal(requireMutationOptIn({ kind: "db", argv: ["--self-test", "database"], env: ok }), "run");
  assert.equal(requireMutationOptIn({ kind: "db", argv: ["--self-test-child", "dir", "target"], env: ok }), "run");
  assert.equal(requireMutationOptIn({ kind: "db", argv: ["--recover"], env: {} }), "recover");
  assert.equal(requireMutationOptIn({ kind: "db", argv: ["--self-test", "offline"], env: {} }), "offline");
});

test("the offline self-test's child runs only on its own temporary workspace", () => {
  const ws = join(tmpdir(), "mutation-selftest-abc123");
  assert.equal(requireMutationOptIn({ kind: "db", argv: ["--self-test-child", join(ws, "recovery"), join(ws, "target.txt")], env: {} }), "offline");
  const repoFile = join(scripts, "..", "src", "app", "page.tsx");
  for (const argv of [
    ["--self-test-child", join(ws, "recovery"), repoFile],
    ["--self-test-child", join(tmpdir(), "elsewhere"), join(ws, "target.txt")],
    ["--self-test-child", join(ws, "recovery")],
    ["--self-test-child", join(tmpdir(), "mutation-selftest-abc123-x", "..", "..", "x"), join(ws, "t")],
  ]) {
    assert.throws(() => requireMutationOptIn({ kind: "db", argv, env: {} }), /Refusing/, argv.join(" "));
  }
});

test("the app runner and the campaign need the opt-in too", () => {
  assert.throws(() => requireMutationOptIn({ kind: "app", argv: [], env: { [OPT_IN_VARIABLE]: "1" } }), /--set/);
  assert.throws(() => requireMutationOptIn({ kind: "app", argv: ["--set", "m12b"], env: {} }), new RegExp(OPT_IN_VARIABLE));
  assert.equal(requireMutationOptIn({ kind: "app", argv: ["--set", "m12b"], env: { [OPT_IN_VARIABLE]: "1" } }), "run");
  assert.throws(() => requireMutationOptIn({ kind: "campaign", argv: [], env: { [OPT_IN_VARIABLE]: "1", MGD_STACK: "test" } }), /scratch/);
  assert.equal(requireMutationOptIn({ kind: "campaign", argv: ["--dry-run"], env: {} }), "offline");
  assert.equal(requireMutationOptIn({ kind: "campaign", argv: [], env: ok }), "run");
  assert.throws(() => requireMutationOptIn({ kind: "other", argv: [], env: ok }), /Unknown/);
});

test("no ordinary suite is a mutation runner: *-checks.mjs never resets a stack or applies violations", () => {
  const checks = readdirSync(scripts).filter((f) => /-checks\.mjs$/.test(f));
  assert.ok(checks.length >= 20, "the ordinary suites are still found");
  for (const f of checks) {
    const text = readFileSync(join(scripts, f), "utf8");
    assert.ok(!/security-mutations|mutation-guard|mutation-(db|app)-runner/.test(text), `${f} references mutation tooling`);
    assert.ok(!/["']db["'],\s*["']reset["']|db reset/.test(text), `${f} resets a stack`);
  }
  for (const runner of ["mutation-db-runner.mjs", "mutation-app-runner.mjs", "mutation-campaign.mjs"]) {
    assert.ok(existsSync(join(scripts, runner)), runner);
    assert.ok(readFileSync(join(scripts, runner), "utf8").includes("requireMutationOptIn({ kind:"), `${runner} calls the guard`);
  }
  assert.ok(!existsSync(join(scripts, "db-mutation-checks.mjs")) && !existsSync(join(scripts, "app-mutation-checks.mjs")), "the old names are gone");
});

// Each runner started the way the accident happened: no arguments, no opt-in.
const recoveryDirs = [join(homedir(), ".my-game-dex", "mutation-recovery"), join(homedir(), ".my-game-dex", "app-mutation-recovery")];
const snapshot = () =>
  recoveryDirs.flatMap((d) =>
    existsSync(d)
      ? readdirSync(d, { recursive: true }).map((f) => {
          const p = join(d, String(f));
          return `${p}:${statSync(p).mtimeMs}`;
        })
      : [],
  );

for (const [runner, args] of [
  ["mutation-db-runner.mjs", []],
  ["mutation-db-runner.mjs", ["--suite", "m6"]],
  ["mutation-app-runner.mjs", []],
  ["mutation-campaign.mjs", []],
]) {
  test(`${runner} ${args.join(" ") || "(no arguments)"} refuses without the opt-in and writes nothing`, () => {
    const before = snapshot();
    const env = { ...process.env, MGD_STACK: "scratch" };
    delete env[OPT_IN_VARIABLE];
    const r = spawnSync(process.execPath, [join(scripts, runner), ...args], { env, encoding: "utf8", timeout: 30000 });
    assert.notEqual(r.status, 0, `${runner} exited 0`);
    assert.match(`${r.stdout}${r.stderr}`, /Refusing to run destructive mutation testing/);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Log: |baseline|Applying/);
    assert.deepEqual(snapshot(), before, "a recovery directory or log changed");
  });
}
