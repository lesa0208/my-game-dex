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
 * MGD_TEST_STACK=pilot selects the persistent SNES pilot stack (M15): project "my-game-dex-pilot"
 * in .supabase-pilot/, every port moved up by 4000, sign-up always off (accounts are created for
 * real editors by the operator tools only), and Auth's links pointing at the pilot preview
 * (http://127.0.0.5:3005), and no seed. It is created only at checkpoint P1: start refuses to
 * create it unless MGD_CREATE_PILOT=1, and refuses a config whose database volume is gone. A
 * restart never regenerates it: it is refused if this checkout's config or migrations differ from
 * the pilot's. run refuses it: it is never a test target. reset and destroy refuse while
 * ~/.my-game-dex/protect-pilot-stack exists (written when the pilot is created, and by
 * protect-pilot), and otherwise unless MGD_ALLOW_PILOT_RESET=1.
 *
 * MGD_TEST_STACK=demo selects the local demo catalog (M16): project "my-game-dex-demo" in
 * .supabase-demo/, the rehearsal stack's ports (blocked from the network by its firewall rule; the
 * two never run at once), sign-up on with Auth's links pointing at the demo preview
 * (http://127.0.0.6:3006), no development seed, never a test target. It keeps its catalog: reset and
 * destroy need MGD_ALLOW_DEMO_RESET=1.
 *
 * MGD_TEST_SIGNUP=off at start or reset makes the test stack invite-only, as a hosted
 * project will be: [auth] enable_signup = false, with the email provider left on (turning
 * that off also blocks password sign-in and recovery; M11a-0).
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { redact } from "./lib/redact.mjs";
import { OWN_KEY_CONFIG_LINES, cliEnv, ensureStackKeys, readStackKeys, runningKeyProblems } from "./lib/stack-keys.mjs";
import { markerProblems, readMarker, writeMarker } from "./lib/stack-marker.mjs";

const root = join(import.meta.dirname, "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const VARIANTS = {
  test: { project: "my-game-dex-test", offset: 1000, dir: ".supabase-test", persistent: false },
  scratch: { project: "my-game-dex-scratch", offset: 2000, dir: ".supabase-scratch", persistent: false },
  b1: { project: "my-game-dex-b1", offset: 3000, dir: ".supabase-b1", persistent: true, allowReset: "MGD_ALLOW_B1_RESET" },
  // M15: real editorial decisions. Invite-only, its own preview origin, never a test target.
  pilot: {
    project: "my-game-dex-pilot", offset: 4000, dir: ".supabase-pilot", persistent: true, allowReset: "MGD_ALLOW_PILOT_RESET",
    marker: join(homedir(), ".my-game-dex", "protect-pilot-stack"), signup: false, seed: false, site: "http://127.0.0.5:3005", testTarget: false,
    ownKeys: true, createFlag: "MGD_CREATE_PILOT",
  },
  // M15 P1a hardening: a disposable twin of the pilot, to rehearse its keys, its guarded start and
  // restart, its backups and its recovery (scripts/pilot-rehearsal.mjs). It starts exactly as the
  // pilot does (its own keys, a marker, created only on request, restarts refused on drift); it
  // differs in being disposable (destroy needs no yes, and removes its marker) and in keeping
  // sign-up and the seed, so every database suite runs on it.
  rehearsal: {
    project: "my-game-dex-rehearsal", offset: 5000, dir: ".supabase-rehearsal", persistent: false,
    marker: join(homedir(), ".my-game-dex", "protect-rehearsal-stack"), ownKeys: true, createFlag: "MGD_CREATE_REHEARSAL",
  },
  // M16: the local demo catalog (scripts/catalog-demo.mjs). Keeps its imported catalog, so reset and
  // destroy need MGD_ALLOW_DEMO_RESET=1. Sign-up on, with Auth's links pointing at the demo preview
  // (http://127.0.0.6:3006); no development seed; never a test target. It uses the rehearsal stack's
  // ports, which the MGD-Rehearsal-Block-In firewall rule already blocks from the network, so start
  // refuses while the rehearsal stack runs (and the rehearsal refuses while the demo runs).
  demo: {
    project: "my-game-dex-demo", offset: 5000, dir: ".supabase-demo", persistent: true, allowReset: "MGD_ALLOW_DEMO_RESET",
    seed: false, site: "http://127.0.0.6:3006", testTarget: false, sharesPortsWith: "rehearsal",
  },
};
VARIANTS.rehearsal.sharesPortsWith = "demo";
export { VARIANTS };
const STACK = process.env.MGD_TEST_STACK ?? "test";
if (!Object.hasOwn(VARIANTS, STACK)) throw new Error('MGD_TEST_STACK may only be "scratch", "b1", "pilot", "rehearsal" or "demo".');

/** The stacks sharing ports never run at once: refuse while the other one has any container running. */
export function portSharingProblem(variant = VARIANTS[STACK], running = (project) => execFileSync("docker", ["ps", "--filter", `label=com.supabase.cli.project=${project}`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim()) {
  if (!variant.sharesPortsWith) return null;
  const other = VARIANTS[variant.sharesPortsWith];
  return running(other.project) ? `Refusing: the ${variant.sharesPortsWith} stack (${other.project}) is running on the same ports. Stop it first.` : null;
}
const TEST_PROJECT_ID = VARIANTS[STACK].project;
const OFFSET = VARIANTS[STACK].offset;
const dir = join(root, VARIANTS[STACK].dir);

/**
 * A persistent stack's data is review history: resetting or destroying it needs an explicit yes,
 * and for the pilot also no protection marker (a separately authorized recovery removes it first).
 */
export function guardPersistent(command, variant = VARIANTS[STACK], name = STACK, env = process.env, markerExists = existsSync) {
  if (!variant.persistent) return;
  if (variant.marker && markerExists(variant.marker)) {
    throw new Error(`Refusing to ${command} the ${name} stack: it is protected (${variant.marker} exists). Recovery is a separately authorized procedure (docs/architecture/catalog-pilot-m15.md).`);
  }
  if (env[variant.allowReset] !== "1") {
    throw new Error(`Refusing to ${command} the ${name} stack: it keeps import batches and their review history. Set ${variant.allowReset}=1 to confirm.`);
  }
}

/**
 * The pilot is created once, at checkpoint P1, by an explicit request; never as a side effect.
 * What exists is its database volume, not its generated config: a config whose volume was deleted
 * (destroy, a Docker prune, a lost disk) is not a pilot to restart, and recreating it is a
 * separately authorized recovery. Returns "create", "restart" or, for other stacks, "prepare".
 */
export function guardCreate(name = STACK, env = process.env, { configExists, volumeExists, marker = null } = {}, variant = VARIANTS[name]) {
  if (!variant?.createFlag) return "prepare";
  const flag = variant.createFlag;
  const create = env[flag] === "1";
  const recovery = "(docs/architecture/catalog-pilot-m15.md)";
  if (volumeExists && create) throw new Error(`Refusing: the ${name} stack already exists. Unset ${flag} to restart it.`);
  if (volumeExists && !configExists) {
    throw new Error(`Refusing: the ${name} stack's database volume exists but its config doesn't. Restoring the config is part of a separately authorized recovery ${recovery}.`);
  }
  if (volumeExists) return "restart";
  // Its first start succeeded once (or its marker can't be read): the volume was deleted since.
  if (marker && marker.state !== "creating") {
    throw new Error(`Refusing: the ${name} stack was created (its protection marker says so) but its database volume is gone. Creating it again is a separately authorized recovery ${recovery}.`);
  }
  if (configExists && !create) {
    throw new Error(
      marker?.state === "creating"
        ? `Refusing: the ${name} stack's creation stopped before its database existed. Run the same start with ${flag}=1 to finish creating it.`
        : `Refusing: the ${name} stack's config exists but its database volume doesn't (it was deleted, or its creation stopped early). Creating it is a separately authorized recovery ${recovery}.`,
    );
  }
  if (!create) {
    throw new Error(name === "pilot"
      ? "Refusing to create the pilot stack: it is created only at checkpoint P1, with the product owner's approval. Set MGD_CREATE_PILOT=1 then."
      : `Refusing to create the ${name} stack: set ${flag}=1 to create it.`);
  }
  return "create";
}

/**
 * A restart of the pilot never changes it: the config this checkout would generate and its
 * migrations must equal the pilot's own, or the restart is refused (migrating or reconfiguring the
 * pilot is a separate, authorized activation). Maps are file name → contents. Pure, for tests.
 */
export function driftProblems({ existingConfig, generatedConfig, existingMigrations, repoMigrations }) {
  const problems = [];
  const body = (text) => text.replace(/\r\n/g, "\n").split("\n").filter((line) => !line.startsWith("# GENERATED") && !line.startsWith("# Sign-up:")).join("\n");
  if (body(existingConfig) !== body(generatedConfig)) problems.push("this checkout's supabase/config.toml would change the pilot's config");
  const names = new Set([...Object.keys(existingMigrations), ...Object.keys(repoMigrations)]);
  for (const name of [...names].sort()) {
    if (!Object.hasOwn(repoMigrations, name)) problems.push(`the pilot has ${name}, which this checkout doesn't`);
    else if (!Object.hasOwn(existingMigrations, name)) problems.push(`this checkout has ${name}, which the pilot doesn't`);
    else if (existingMigrations[name] !== repoMigrations[name]) problems.push(`${name} differs`);
  }
  return problems;
}

const readMigrations = (folder) => Object.fromEntries(
  (existsSync(folder) ? readdirSync(folder) : []).filter((n) => n.endsWith(".sql")).sort().map((n) => [n, readFileSync(join(folder, n), "utf8")]),
);

/**
 * Whether a Docker volume exists. Only Docker's own "no such volume" answer means no: any other
 * failure (the daemon down, another context, a timeout) throws, so an existing pilot is never
 * mistaken for a missing one and recreated over. `run` is injectable for tests.
 */
export function volumeExists(name, run = (argv) => execFileSync("docker", argv, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" })) {
  try {
    run(["volume", "inspect", name]);
    return true;
  } catch (error) {
    if (/no such volume/i.test(String(error.stderr ?? ""))) return false;
    throw new Error(`Refusing: Docker didn't say whether the volume ${name} exists (${String(error.stderr || error.message).trim().slice(0, 200)}). Nothing was changed.`);
  }
}

/**
 * Starting a stack, fail-closed for a guarded one (the pilot and its rehearsal twin). `io` does the
 * work, so every path is testable without Docker: configExists, volumeExists, readMarker, protect
 * ({ state, kid }), prepare, drift, ensureKeys ({ create }) → { kid }, launch → exit code,
 * verifyRunning → problems, stop.
 *
 * - Creating writes the protection marker ("creating", with its own key's kid) BEFORE the first
 *   `supabase start`, which creates the database volume: so the volume never exists unprotected,
 *   whatever happens later. A start that fails or is killed leaves a protected, partial stack: the
 *   next start resumes it (a restart if its volume exists, else again with the create flag).
 * - Only once a start has succeeded, with the running stack shown to use its own keys, does the
 *   marker say "created". From then on a missing volume is never created again (guardCreate).
 * - A restart refuses while the marker is missing, unreadable or another stack's (another kid),
 *   while this checkout would change its config or migrations, and while its own keys are missing
 *   or malformed. Nothing is regenerated, reset or recreated to fix any of these.
 * - After every start of a stack with its own keys, the running stack must show them (its Auth
 *   publishes only its own signing key, and its own secret key works); if not, it is stopped.
 * - `preflight` runs every restart check and stops short of starting (a snapshot runs it before it
 *   stops the pilot, so it never stops one it couldn't start again).
 * - Other stacks start as before.
 */
export async function startStack(name, variant, env, io, { preflight = false } = {}) {
  const marker = variant.marker ? io.readMarker() : null;
  const mode = guardCreate(name, env, { configExists: io.configExists(), volumeExists: io.volumeExists(), marker }, variant);
  let kid = null;
  if (mode === "restart") {
    const problems = markerProblems(marker, { stack: name, file: variant.marker });
    if (problems.length) {
      throw new Error(
        `Refusing to start the ${name} stack: ${problems.join("; ")}. If an authorized recovery removed or replaced it, finish that procedure first. ` +
          `Otherwise confirm this is the stack it should be, with nothing reset, and restore its protection: MGD_TEST_STACK=${name} node scripts/test-stack.mjs protect-pilot (docs/architecture/catalog-pilot-m15.md).`,
      );
    }
    const drift = io.drift();
    if (drift.length) {
      throw new Error(`Refusing to restart the ${name} stack from this checkout: ${drift.join("; ")}. Restart it from the checkout it was created from; migrating or reconfiguring it is a separate, authorized activation.`);
    }
    if (variant.ownKeys) kid = io.ensureKeys({ create: false }).kid;
    const others = markerProblems(marker, { stack: name, kid, file: variant.marker });
    if (others.length) throw new Error(`Refusing to start the ${name} stack: ${others.join("; ")} than this checkout's (docs/architecture/catalog-pilot-m15.md).`);
    if (preflight) return 0;
  } else {
    if (preflight) throw new Error(`Refusing: there is no ${name} stack to check.`);
    io.prepare();
    if (variant.ownKeys) kid = io.ensureKeys({ create: true }).kid;
    if (mode === "create") io.protect({ state: "creating", kid });
  }
  const code = await io.launch();
  if (code !== 0) {
    if (mode === "create" || marker?.state === "creating") {
      console.error(
        `Starting the new ${name} stack failed (exit ${code}). It stays protected (${variant.marker}); its database volume may exist. ` +
          "Run the start again (it says whether the create flag is needed), or follow the recovery procedure (docs/architecture/catalog-pilot-m15.md). Nothing was deleted.",
      );
    }
    return code;
  }
  if (variant.ownKeys) {
    const problems = await io.verifyRunning();
    if (problems.length) {
      await io.stop();
      throw new Error(`Stopped the ${name} stack again: it isn't running with its own keys (${problems.join("; ")}). Nothing was deleted.`);
    }
  }
  if (variant.marker && (mode === "create" || marker?.state === "creating")) io.protect({ state: "created", kid });
  return 0;
}

/** The pilot is never a test target: no npm script runs against it through this tool. */
export function guardRun(variant = VARIANTS[STACK], name = STACK) {
  if (variant.testTarget === false) throw new Error(`Refusing: the ${name} stack is never a test target. Its tools run directly (docs/architecture/catalog-pilot-m15.md).`);
}
const target = join(dir, "supabase");
const PORT_KEYS = new Set(["port", "shadow_port", "inspector_port"]);
const DISABLED = new Set(["studio", "analytics", "edge_runtime"]);

/**
 * The test config: the development config with a new project id, moved ports and fewer services.
 * With `site` (the pilot), Auth's links (site_url and the allowed redirects) go to that origin.
 * With `seed: false` (the pilot), no seed file is ever loaded.
 * With `ownKeys` (the pilot and its rehearsal twin), Auth reads its own signing key, JWT secret and
 * API keys (scripts/lib/stack-keys.mjs: the config names them, never their values), and Storage's
 * S3 protocol, whose keys are the CLI's shared ones, is off.
 */
export function testConfig(source, { signup = true, project = TEST_PROJECT_ID, offset = OFFSET, site = null, seed = true, ownKeys = false } = {}) {
  let section = "";
  const config = source
    .split("\n")
    .flatMap((line) => {
      const header = /^\[([^\]]+)\]\s*$/.exec(line);
      if (header) section = header[1];
      if (ownKeys && header && section === "auth") return [line, ...OWN_KEY_CONFIG_LINES];
      if (ownKeys && section === "auth" && /^(jwt_secret|publishable_key|secret_key|signing_keys_path|anon_key|service_role_key)\s*=/.test(line)) return [];
      if (ownKeys && section === "storage.s3_protocol" && /^enabled\s*=/.test(line)) return ["enabled = false"];
      if (/^project_id\s*=/.test(line)) return `project_id = "${project}"`;
      const setting = /^(\w+)\s*=\s*(\d+)\s*$/.exec(line);
      if (setting && PORT_KEYS.has(setting[1])) return `${setting[1]} = ${Number(setting[2]) + offset}`;
      if (site && section === "auth" && /^site_url\s*=/.test(line)) return `site_url = "${site}"`;
      if (site && section === "auth" && /^additional_redirect_urls\s*=/.test(line)) return `additional_redirect_urls = ["${site}"]`;
      if (DISABLED.has(section) && /^enabled\s*=/.test(line)) return "enabled = false";
      if (!seed && section === "db.seed" && /^enabled\s*=/.test(line)) return "enabled = false";
      if (section === "auth" && /^enable_signup\s*=/.test(line)) return `enable_signup = ${signup}`;
      return [line];
    })
    .join("\n");
  // The invitation and reset templates are in supabase/config.toml since the M11a local
  // activation, so both stacks use them; the test config inherits them unchanged.
  return `${config}\n`;
}

function generatedConfig() {
  const variant = VARIANTS[STACK];
  const signup = variant.signup ?? process.env.MGD_TEST_SIGNUP !== "off";
  const config = testConfig(readFileSync(join(root, "supabase", "config.toml"), "utf8"), { signup, site: variant.site ?? null, seed: variant.seed ?? true, ownKeys: variant.ownKeys ?? false });
  if (!config.includes(`project_id = "${TEST_PROJECT_ID}"`)) throw new Error("The generated config doesn't name the test project.");
  return { signup, config };
}

function prepare() {
  const { signup, config } = generatedConfig();
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

/** Writes this stack's protection marker: how far its creation got, and its own key's kid. */
function protect({ state, kid }) {
  writeMarker(VARIANTS[STACK].marker, { stack: STACK, state, kid });
  console.log(`The ${STACK} stack is protected (${state}): reset and destroy refuse it, and it is used only with its own keys.`);
}

/** The start's real work, for startStack. */
function startIo(variant) {
  const apiUrl = `http://127.0.0.1:${54321 + variant.offset}`;
  return {
    configExists: () => existsSync(join(target, "config.toml")),
    volumeExists: () => Boolean(variant.createFlag) && volumeExists(`supabase_db_${TEST_PROJECT_ID}`),
    readMarker: () => readMarker(variant.marker),
    protect,
    prepare,
    drift: () => driftProblems({
      existingConfig: readFileSync(join(target, "config.toml"), "utf8"),
      generatedConfig: generatedConfig().config,
      existingMigrations: readMigrations(join(target, "migrations")),
      repoMigrations: readMigrations(join(root, "supabase", "migrations")),
    }),
    ensureKeys: ({ create }) => ensureStackKeys(target, { create, label: `the ${STACK} stack` }),
    launch: () => supabase(["start"]),
    verifyRunning: () => runningKeyProblems(apiUrl, readStackKeys(target, `the ${STACK} stack`)),
    stop: () => supabase(["stop"]),
  };
}

function assertTestProject() {
  const config = readFileSync(join(target, "config.toml"), "utf8");
  if (/project_id\s*=\s*"([^"]+)"/.exec(config)?.[1] !== TEST_PROJECT_ID) throw new Error(`Refusing: ${dir} doesn't name the ${STACK} project.`);
}

function supabase(args) {
  assertTestProject();
  return new Promise((resolve) => {
    // No MGD_STACK_* key variable from the shell: a stack's own keys come only from its own .env.
    const child = spawn(process.execPath, [cli, ...args, "--workdir", dir], { cwd: root, env: { ...cliEnv(), NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
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
    case "start": {
      const shared = portSharingProblem();
      if (shared) throw new Error(shared);
      return startStack(STACK, VARIANTS[STACK], process.env, startIo(VARIANTS[STACK]));
    }
    case "preflight":
      // Every restart check of an existing guarded stack, without starting it (pilot-backup snapshot).
      if (!VARIANTS[STACK].createFlag) throw new Error("preflight is for the pilot and its rehearsal twin only.");
      return startStack(STACK, VARIANTS[STACK], { ...process.env, [VARIANTS[STACK].createFlag]: "" }, startIo(VARIANTS[STACK]), { preflight: true });
    case "stop":
      if (!existsSync(target)) return 0;
      return supabase(["stop"]);
    case "status":
      return supabase(["status"]);
    case "reset":
      guardPersistent("reset");
      prepare();
      // A reset keeps a stack's own keys and never makes new ones (its marker records their kid).
      if (VARIANTS[STACK].ownKeys) ensureStackKeys(target, { create: false, label: `the ${STACK} stack` });
      return supabase(["db", "reset"]);
    case "destroy":
      guardPersistent("destroy");
      if (!existsSync(target)) return 0;
      {
        const code = await supabase(["stop", "--no-backup"]);
        // The disposable twin only: once its volumes are gone, its marker goes too (the pilot's
        // never does; destroy refuses it while the marker exists).
        if (code === 0 && STACK === "rehearsal" && !volumeExists(`supabase_db_${TEST_PROJECT_ID}`)) rmSync(VARIANTS.rehearsal.marker, { force: true });
        return code;
      }
    case "run":
      guardRun();
      if (!existsSync(target)) throw new Error("The test stack isn't prepared. Run npm run test-stack:start.");
      return runNpm(rest[0], rest.slice(1));
    case "protect-dev": {
      const marker = join(homedir(), ".my-game-dex", "protect-dev-stack");
      mkdirSync(join(marker, ".."), { recursive: true });
      writeFileSync(marker, "Destructive scripts refuse the development stack while this file exists. Delete it to allow them.\n");
      console.log("The development stack is protected: destructive scripts now refuse it unless MGD_ALLOW_DEV_STACK=1.");
      return 0;
    }
    case "protect-pilot": {
      // An explicit recovery step: protects the pilot this checkout has, with its own keys.
      if (STACK !== "pilot") throw new Error("protect-pilot needs MGD_TEST_STACK=pilot.");
      protect({ state: "created", kid: ensureStackKeys(target, { create: false, label: "the pilot stack" }).kid });
      return 0;
    }
    default:
      console.error("Usage: node scripts/test-stack.mjs start|preflight|stop|status|reset|destroy|run <npm script>|protect-dev|protect-pilot");
      return 2;
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
