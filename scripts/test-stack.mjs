/**
 * The isolated local test stack (M11a-0): a second Supabase project, "my-game-dex-test",
 * with its own containers, volumes, network and ports, so destructive suites never touch
 * the development stack and its data.
 *
 *   node scripts/test-stack.mjs start            prepare, then start the test stack
 *   node scripts/test-stack.mjs stop             stop it, keeping its data
 *   node scripts/test-stack.mjs status           its URLs, keys redacted
 *   node scripts/test-stack.mjs reset            re-apply every migration to the test database
 *   node scripts/test-stack.mjs destroy          stop it and delete its volumes
 *   node scripts/test-stack.mjs run <script> ... run an npm script against it (MGD_STACK=test)
 *   node scripts/test-stack.mjs protect-dev      make destructive scripts refuse the dev stack
 *
 * The test project lives in .supabase-test/ (git-ignored), regenerated on every start and
 * reset: config.toml is supabase/config.toml with the project id changed, every port moved
 * up by 1000, and Studio, analytics and the edge runtime off; migrations, pgTAP tests and
 * email templates are copied from supabase/. The invitation email uses
 * supabase/templates/invite.html (M11a-1) and the reset email supabase/templates/recovery.html
 * (M11a-2), set in supabase/config.toml for both stacks. Every CLI call passes
 * --workdir .supabase-test, and the generated config is checked to name the test project
 * before anything runs.
 *
 * MGD_TEST_STACK=scratch selects a third, disposable stack instead (M12c-A): project
 * "my-game-dex-scratch" in .supabase-scratch/, every port moved up by 2000, and run sets
 * MGD_STACK=scratch. It's for running every suite on a clean database while the test
 * stack keeps records worth keeping; destroy removes its containers and volumes.
 *
 * MGD_TEST_STACK=b1 selects the persistent B1 ingestion-test stack (M12c-B1): project
 * "my-game-dex-b1" in .supabase-b1/, every port moved up by 3000, and run sets MGD_STACK=b1.
 * It keeps B1 batches and their review history, so reset and destroy refuse unless
 * MGD_ALLOW_B1_RESET=1 is also set.
 *
 * MGD_TEST_SIGNUP=off at start or reset makes the test stack invite-only, as a hosted
 * project will be: [auth] enable_signup = false, with the email provider left on (turning
 * that off also blocks password sign-in and recovery; M11a-0).
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { redact } from "./lib/redact.mjs";

const root = join(import.meta.dirname, "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const VARIANTS = {
  test: { project: "my-game-dex-test", offset: 1000, dir: ".supabase-test", persistent: false },
  scratch: { project: "my-game-dex-scratch", offset: 2000, dir: ".supabase-scratch", persistent: false },
  b1: { project: "my-game-dex-b1", offset: 3000, dir: ".supabase-b1", persistent: true },
};
const STACK = process.env.MGD_TEST_STACK ?? "test";
if (!Object.hasOwn(VARIANTS, STACK)) throw new Error('MGD_TEST_STACK may only be "scratch" or "b1".');
const TEST_PROJECT_ID = VARIANTS[STACK].project;
const OFFSET = VARIANTS[STACK].offset;
const dir = join(root, VARIANTS[STACK].dir);

/** A persistent stack's data is review history: resetting or destroying it needs an explicit yes. */
function guardPersistent(command) {
  if (VARIANTS[STACK].persistent && process.env.MGD_ALLOW_B1_RESET !== "1") {
    throw new Error(`Refusing to ${command} the ${STACK} stack: it keeps import batches and their review history. Set MGD_ALLOW_B1_RESET=1 to confirm.`);
  }
}
const target = join(dir, "supabase");
const PORT_KEYS = new Set(["port", "shadow_port", "inspector_port"]);
const DISABLED = new Set(["studio", "analytics", "edge_runtime"]);

/** The test config: the development config with a new project id, moved ports and fewer services. */
export function testConfig(source, { signup = true } = {}) {
  let section = "";
  const config = source
    .split("\n")
    .map((line) => {
      const header = /^\[([^\]]+)\]\s*$/.exec(line);
      if (header) section = header[1];
      if (/^project_id\s*=/.test(line)) return `project_id = "${TEST_PROJECT_ID}"`;
      const setting = /^(\w+)\s*=\s*(\d+)\s*$/.exec(line);
      if (setting && PORT_KEYS.has(setting[1])) return `${setting[1]} = ${Number(setting[2]) + OFFSET}`;
      if (DISABLED.has(section) && /^enabled\s*=/.test(line)) return "enabled = false";
      if (section === "auth" && /^enable_signup\s*=/.test(line)) return `enable_signup = ${signup}`;
      return line;
    })
    .join("\n");
  // The invitation and reset templates are in supabase/config.toml since the M11a local
  // activation, so both stacks use them; the test config inherits them unchanged.
  return `${config}\n`;
}

function prepare() {
  const signup = process.env.MGD_TEST_SIGNUP !== "off";
  const config = testConfig(readFileSync(join(root, "supabase", "config.toml"), "utf8"), { signup });
  if (!config.includes(`project_id = "${TEST_PROJECT_ID}"`)) throw new Error("The generated config doesn't name the test project.");
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, "config.toml"),
    `# GENERATED by scripts/test-stack.mjs from supabase/config.toml. Do not edit.\n# Sign-up: ${signup ? "on (the development setting)" : "off (invite-only)"}\n${config}`,
  );
  for (const name of ["migrations", "tests", "templates"]) {
    rmSync(join(target, name), { recursive: true, force: true });
    cpSync(join(root, "supabase", name), join(target, name), { recursive: true });
  }
}

function assertTestProject() {
  const config = readFileSync(join(target, "config.toml"), "utf8");
  if (/project_id\s*=\s*"([^"]+)"/.exec(config)?.[1] !== TEST_PROJECT_ID) throw new Error(`Refusing: ${dir} doesn't name the ${STACK} project.`);
}

function supabase(args) {
  assertTestProject();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, "--workdir", dir], { cwd: root, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => process.stdout.write(redact(chunk.toString())));
    child.stderr.on("data", (chunk) => process.stderr.write(redact(chunk.toString())));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function runNpm(script, extra) {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  if (!Object.hasOwn(scripts, script)) throw new Error(`No npm script named "${script}".`);
  if (extra.some((a) => !/^[\w.:=/@-]+$/.test(a))) throw new Error("Only plain arguments can be passed through.");
  return new Promise((resolve) => {
    // The script name is checked against package.json, so the shell sees only known words.
    const child = spawn(`npm run ${script}${extra.length ? ` -- ${extra.join(" ")}` : ""}`, { cwd: root, shell: true, stdio: "inherit", env: { ...process.env, MGD_STACK: STACK } });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "start":
      prepare();
      return supabase(["start"]);
    case "stop":
      if (!existsSync(target)) return 0;
      return supabase(["stop"]);
    case "status":
      return supabase(["status"]);
    case "reset":
      guardPersistent("reset");
      prepare();
      return supabase(["db", "reset"]);
    case "destroy":
      guardPersistent("destroy");
      if (!existsSync(target)) return 0;
      return supabase(["stop", "--no-backup"]);
    case "run":
      if (!existsSync(target)) throw new Error("The test stack isn't prepared. Run npm run test-stack:start.");
      return runNpm(rest[0], rest.slice(1));
    case "protect-dev": {
      const marker = join(homedir(), ".my-game-dex", "protect-dev-stack");
      mkdirSync(join(marker, ".."), { recursive: true });
      writeFileSync(marker, "Destructive scripts refuse the development stack while this file exists. Delete it to allow them.\n");
      console.log("The development stack is protected: destructive scripts now refuse it unless MGD_ALLOW_DEV_STACK=1.");
      return 0;
    }
    default:
      console.error("Usage: node scripts/test-stack.mjs start|stop|status|reset|destroy|run <npm script>|protect-dev");
      return 2;
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
