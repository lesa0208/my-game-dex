/**
 * M15 P1a: the isolated SNES pilot stack's tooling. Every test is pure or runs in a temporary
 * folder; none starts, reads or writes a stack, and none creates the pilot. The few that run a
 * tool with MGD_STACK=pilot to see it refuse run only while the pilot doesn't exist (before P1).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { editorEmailProblem } from "./lib/editorial-accounts.mjs";
import { PILOT_REFUSED, PILOT_SOURCES, pilotSourceProblems } from "./lib/pilot-sources.mjs";
import { BASE_API_PORT, EDITORIAL_STACKS, PILOT_PROTECTION_MARKER, STACKS, editorialTarget } from "./lib/stack.mjs";
import { markerProblems, readMarker, writeMarker } from "./lib/stack-marker.mjs";
import { ENV_FILE, KEY_VARIABLES, OWN_KEY_CONFIG_LINES, SIGNING_KEYS_FILE, ensureStackKeys, generateStackKeys, ownKeyProblems, readStackKeys, runningKeyProblems, runningKeyProblemsSync } from "./lib/stack-keys.mjs";
import { CHECKPOINTS, BACKUP_DIR, DUMP_FILES, backupTarget, checkpointName, dumpPlan, manifestEntries, snapshotPlan, stamp } from "./pilot-backup.mjs";
import { VARIANTS, driftProblems, guardCreate, guardPersistent, guardRun, portSharingProblem, startStack, testConfig, volumeExists } from "./test-stack.mjs";

const scripts = import.meta.dirname;
const repo = join(scripts, "..");
const node = (file, argv, env) => execFileSync(process.execPath, [join(scripts, file), ...argv], { stdio: "pipe", env: { ...process.env, ...env }, cwd: repo });
const stderrOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return `${error.stderr ?? ""}${error.message}`;
  }
  assert.fail("expected a refusal");
};
/** After P1 the real pilot exists: tests never run a tool against it. */
const pilotExists = existsSync(join(repo, ".supabase-pilot", "supabase", "config.toml"));
const beforeP1 = { skip: pilotExists && "the real pilot exists: no test runs a tool against it" };
const withoutStack = () => {
  const env = { ...process.env };
  delete env.MGD_STACK;
  return env;
};

test("editorial targets: only b1 and pilot, named explicitly, with their own project", () => {
  assert.deepEqual(Object.keys(EDITORIAL_STACKS).sort(), ["b1", "pilot"]);
  assert.throws(() => editorialTarget(null, "my-game-dex", "x"), /needs an explicit stack/);
  assert.throws(() => editorialTarget("", "my-game-dex", "x"), /needs an explicit stack/);
  for (const name of ["dev", "test", "scratch", "prod", "PILOT", "__proto__", "constructor"]) {
    assert.throws(() => editorialTarget(name, STACKS[name]?.project, "x"), /writes only to an editorial stack/, name);
  }
  assert.throws(() => editorialTarget("pilot", "my-game-dex-b1"), /names project "my-game-dex-b1"/);
  assert.throws(() => editorialTarget("b1", "my-game-dex-pilot"), /names project "my-game-dex-pilot"/);
  assert.throws(() => editorialTarget("pilot", "my-game-dex"), /not "my-game-dex-pilot"/);
  const pilot = editorialTarget("pilot", "my-game-dex-pilot");
  assert.equal(pilot.name, "pilot");
  assert.equal(pilot.disposableEditor, false, "the pilot has no disposable editor");
  assert.ok(Object.isFrozen(EDITORIAL_STACKS.pilot));
});

test("B1 keeps exactly its pre-M15 endpoints, folder and disposable editor A", () => {
  const b1 = editorialTarget("b1", "my-game-dex-b1");
  assert.deepEqual({ ...b1 }, { name: "b1", apiPort: 57321, preview: "http://127.0.0.4:3004", work: "m12c-b1", disposableEditor: true, label: "B1" });
  assert.deepEqual(STACKS.b1, { project: "my-game-dex-b1", dir: ".supabase-b1", offset: 3000 });
  assert.equal(VARIANTS.b1.allowReset, "MGD_ALLOW_B1_RESET");
  assert.equal(VARIANTS.b1.marker, undefined, "B1 gains no marker");
  assert.equal(VARIANTS.b1.site, undefined, "B1's Auth links are unchanged");
  assert.equal(VARIANTS.b1.signup, undefined, "B1's sign-up setting is unchanged");
});

test("the pilot: its own project, folder, ports, preview and work folder, colliding with no stack", () => {
  assert.deepEqual(STACKS.pilot, { project: "my-game-dex-pilot", dir: ".supabase-pilot", offset: 4000, ownKeys: true, marker: PILOT_PROTECTION_MARKER });
  // Its disposable twin: its own project, folder, ports and marker too, never an editorial target.
  assert.deepEqual(STACKS.rehearsal, { project: "my-game-dex-rehearsal", dir: ".supabase-rehearsal", offset: 5000, ownKeys: true, marker: join(homedir(), ".my-game-dex", "protect-rehearsal-stack") });
  for (const name of ["pilot", "rehearsal"]) assert.equal(STACKS[name].marker, VARIANTS[name].marker, `${name}: one marker for the tools and test-stack.mjs`);
  assert.ok(!Object.hasOwn(EDITORIAL_STACKS, "rehearsal"));
  for (const name of ["dev", "test", "scratch", "b1"]) assert.ok(!STACKS[name].ownKeys, `${name} keeps the CLI's keys`);
  assert.equal(EDITORIAL_STACKS.pilot.apiPort, 58321);
  assert.equal(EDITORIAL_STACKS.pilot.preview, "http://127.0.0.5:3005");
  for (const key of ["project", "dir"]) assert.equal(new Set(Object.keys(STACKS).map((n) => STACKS[n][key])).size, Object.keys(STACKS).length, `${key} unique`);
  // M16: the demo catalog uses the rehearsal stack's ports, which its firewall rule already blocks;
  // the two never run at once (portSharingProblem, checked by start). No other stack shares a port.
  assert.equal(STACKS.demo.offset, STACKS.rehearsal.offset);
  assert.equal(VARIANTS.demo.sharesPortsWith, "rehearsal");
  assert.equal(VARIANTS.rehearsal.sharesPortsWith, "demo");
  const runningOnly = (name) => (project) => (project === name ? `supabase_db_${name}` : "");
  assert.ok(portSharingProblem(VARIANTS.demo, runningOnly("my-game-dex-rehearsal")), "the demo refuses to start while the rehearsal runs");
  assert.ok(portSharingProblem(VARIANTS.rehearsal, runningOnly("my-game-dex-demo")), "and the rehearsal while the demo runs");
  assert.equal(portSharingProblem(VARIANTS.demo, () => ""), null);
  assert.equal(portSharingProblem(VARIANTS.pilot, runningOnly("my-game-dex-demo")), null, "the pilot shares nothing");
  assert.equal(VARIANTS.demo.testTarget, false, "the demo is never a test target");
  const names = Object.keys(STACKS).filter((n) => n !== "demo");
  for (const key of ["offset"]) assert.equal(new Set(names.map((n) => STACKS[n][key])).size, names.length, `${key} unique`);
  // Every port of every stack (the dev ports plus the offset) is distinct from every other stack's.
  const source = readFileSync(join(repo, "supabase", "config.toml"), "utf8");
  const ports = [...source.matchAll(/^(?:port|shadow_port|inspector_port)\s*=\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
  assert.ok(ports.length >= 5);
  const all = names.flatMap((n) => ports.map((p) => p + STACKS[n].offset));
  assert.equal(new Set(all).size, all.length, "no port is shared between two stacks");
  for (const n of names) assert.ok(Math.max(...ports) + STACKS[n].offset < 65536);
  // Preview origins: distinct hosts (cookies are per host), and never the development port 3000.
  const previews = Object.values(EDITORIAL_STACKS).map((t) => new URL(t.preview));
  assert.equal(new Set(previews.map((u) => u.hostname)).size, previews.length);
  for (const u of previews) {
    assert.match(u.hostname, /^127\.\d+\.\d+\.\d+$/);
    assert.notEqual(u.hostname, "127.0.0.1");
    assert.notEqual(u.port, "3000");
  }
  assert.equal(BASE_API_PORT + STACKS.pilot.offset, 58321);
  assert.notEqual(EDITORIAL_STACKS.pilot.work, EDITORIAL_STACKS.b1.work, "separate credential and packet folders");
});

test("the pilot's generated config: its project, moved ports, sign-up off, Auth links to its preview", () => {
  // A Windows checkout may have CRLF line endings.
  const source = readFileSync(join(repo, "supabase", "config.toml"), "utf8").replace(/\r\n/g, "\n");
  const v = VARIANTS.pilot;
  const config = testConfig(source, { signup: v.signup, project: v.project, offset: v.offset, site: v.site, seed: v.seed });
  assert.match(config, /\[db\.seed\]\n[\s\S]*?\nenabled = false\n/, "the pilot never loads a seed");
  assert.match(config, /^project_id = "my-game-dex-pilot"$/m);
  assert.match(config, /\[api\][\s\S]*?\nport = 58321\n/);
  assert.match(config, /\[db\][\s\S]*?\nport = 58322\n/);
  assert.match(config, /\[auth\][\s\S]*?\nsite_url = "http:\/\/127\.0\.0\.5:3005"\n/);
  assert.match(config, /\[auth\][\s\S]*?\nadditional_redirect_urls = \["http:\/\/127\.0\.0\.5:3005"\]\n/);
  assert.match(config, /\[auth\][\s\S]*?\nenable_signup = false\n/);
  // Only commented-out lines may still name the development app.
  const live = config.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(live, /127\.0\.0\.1:3000/, "no Auth link points at the development app");
  assert.doesNotMatch(config, /my-game-dex-b1|"my-game-dex"/);
  // Without `site`, as for test, scratch and B1, Auth's links are left as development's.
  const b1 = testConfig(source, { project: "my-game-dex-b1", offset: 3000 });
  assert.match(b1, /\[db\.seed\]\n[\s\S]*?\nenabled = true\n/, "other stacks keep the development seed setting");
  assert.equal(/site_url = "([^"]+)"/.exec(b1)[1], /site_url = "([^"]+)"/.exec(source)[1]);
});

test("reset and destroy: the pilot marker always blocks; otherwise each stack's own explicit yes", () => {
  const pilot = VARIANTS.pilot;
  assert.equal(pilot.marker, PILOT_PROTECTION_MARKER);
  assert.equal(pilot.marker, join(homedir(), ".my-game-dex", "protect-pilot-stack"));
  const yes = { MGD_ALLOW_PILOT_RESET: "1", MGD_ALLOW_B1_RESET: "1" };
  for (const command of ["reset", "destroy"]) {
    assert.throws(() => guardPersistent(command, pilot, "pilot", yes, () => true), /it is protected/, `${command} with the marker`);
    assert.throws(() => guardPersistent(command, pilot, "pilot", {}, () => false), /MGD_ALLOW_PILOT_RESET=1/);
    assert.throws(() => guardPersistent(command, pilot, "pilot", { MGD_ALLOW_B1_RESET: "1" }, () => false), /MGD_ALLOW_PILOT_RESET=1/, "B1's yes isn't the pilot's");
    assert.doesNotThrow(() => guardPersistent(command, pilot, "pilot", { MGD_ALLOW_PILOT_RESET: "1" }, () => false));
    // B1, as before: its own yes, no marker.
    assert.throws(() => guardPersistent(command, VARIANTS.b1, "b1", { MGD_ALLOW_PILOT_RESET: "1" }, () => true), /MGD_ALLOW_B1_RESET=1/);
    assert.doesNotThrow(() => guardPersistent(command, VARIANTS.b1, "b1", { MGD_ALLOW_B1_RESET: "1" }, () => true));
    for (const name of ["test", "scratch"]) assert.doesNotThrow(() => guardPersistent(command, VARIANTS[name], name, {}, () => true));
  }
});

test("the pilot is created only on request, and is never a test target", () => {
  const yes = { MGD_CREATE_PILOT: "1" };
  const state = (configExists, volumeExists) => ({ configExists, volumeExists });
  assert.throws(() => guardCreate("pilot", {}, state(false, false)), /created only at checkpoint P1/);
  assert.equal(guardCreate("pilot", yes, state(false, false)), "create");
  assert.equal(guardCreate("pilot", {}, state(true, true)), "restart", "an existing pilot restarts");
  assert.throws(() => guardCreate("pilot", yes, state(true, true)), /already exists/);
  // A config whose volume is gone (destroy, a prune, a lost disk) is never silently rebuilt.
  assert.throws(() => guardCreate("pilot", {}, state(true, false)), /volume doesn't \(it was deleted, or its creation stopped early\)/);
  assert.throws(() => guardCreate("pilot", {}, state(false, true)), /volume exists but its config doesn't/);
  assert.throws(() => guardCreate("pilot", yes, state(false, true)), /already exists/);
  for (const name of ["test", "scratch", "b1"]) assert.equal(guardCreate(name, {}, state(false, false)), "prepare");
  // db.mjs never starts the pilot or its twin (it would bypass the marker, the keys and the drift check).
  const db = readFileSync(join(scripts, "db.mjs"), "utf8");
  assert.match(db, /if \(STACKS\[stackName\]\.ownKeys && command === "start"\) \{/);
  assert.match(db, /env: \{ \.\.\.cliEnv\(\), NO_COLOR: "1" \}/, "no shell key variable reaches the CLI");
  // A reset never makes keys; a snapshot's restart is never a creation, whichever flag the shell has.
  assert.match(readFileSync(join(scripts, "test-stack.mjs"), "utf8"), /if \(VARIANTS\[STACK\]\.ownKeys\) ensureStackKeys\(target, \{ create: false,/);
  assert.match(readFileSync(join(scripts, "pilot-backup.mjs"), "utf8"), /delete env\.MGD_CREATE_PILOT;\n\s*delete env\.MGD_CREATE_REHEARSAL;/);
  assert.throws(() => guardRun(VARIANTS.pilot, "pilot"), /never a test target/);
  for (const name of ["test", "scratch", "b1"]) assert.doesNotThrow(() => guardRun(VARIANTS[name], name));
  // The commands themselves, before anything else happens.
  const out = stderrOf(() => node("test-stack.mjs", ["run", "db:test"], { MGD_TEST_STACK: "pilot" }));
  assert.match(out, /never a test target/);
});

test("a pilot restart never changes its config or migrations", () => {
  const config = "# GENERATED by scripts/test-stack.mjs\n# Sign-up: off (invite-only)\nproject_id = \"my-game-dex-pilot\"\n";
  const same = { existingConfig: config, generatedConfig: "project_id = \"my-game-dex-pilot\"\r\n", existingMigrations: { "1.sql": "a" }, repoMigrations: { "1.sql": "a" } };
  assert.deepEqual(driftProblems(same), []);
  assert.match(driftProblems({ ...same, generatedConfig: "project_id = \"x\"\n" })[0], /would change the pilot's config/);
  assert.match(driftProblems({ ...same, repoMigrations: { "1.sql": "a", "2.sql": "b" } })[0], /this checkout has 2\.sql/);
  assert.match(driftProblems({ ...same, repoMigrations: {} })[0], /the pilot has 1\.sql/);
  assert.match(driftProblems({ ...same, repoMigrations: { "1.sql": "changed" } })[0], /1\.sql differs/);
  // The start command goes through startStack (tested below), with the real drift check.
  const tool = readFileSync(join(scripts, "test-stack.mjs"), "utf8");
  // M16: the port-sharing guard runs first, then the same guarded start.
  assert.match(tool, /case "start": \{\n\s*const shared = portSharingProblem\(\);\n\s*if \(shared\) throw new Error\(shared\);\n\s*return startStack\(STACK, VARIANTS\[STACK\], process\.env, startIo\(VARIANTS\[STACK\]\)\);/);
  assert.match(tool, /function startIo\(variant\) \{[\s\S]*?drift: \(\) => driftProblems\(\{[\s\S]*?existingMigrations: readMigrations\(join\(target, "migrations"\)\),\n\s*repoMigrations: readMigrations\(join\(root, "supabase", "migrations"\)\)/);
  assert.match(tool, /volumeExists: \(\) => Boolean\(variant\.createFlag\) && volumeExists\(/, "the pilot and its twin check their real volume");
});

/** A fake of everything start does, recording the order; `state` is what exists. */
function fakeStart(state, { launchCode = 0, drift = [], keysMissing = false, kid = "kid-1", running = [] } = {}) {
  const calls = [];
  const io = {
    configExists: () => state.config,
    volumeExists: () => state.volume,
    readMarker: () => state.marker ?? null,
    protect: ({ state: s, kid: k }) => {
      calls.push(`protect:${s}`);
      state.marker = { stack: state.name ?? "pilot", state: s, kid: k };
    },
    prepare: () => {
      calls.push("prepare");
      state.config = true;
    },
    drift: () => drift,
    ensureKeys: ({ create }) => {
      calls.push(`keys:${create ? "create" : "require"}`);
      if (!create && keysMissing) throw new Error("own signing keys are missing");
      return { kid };
    },
    launch: async () => {
      calls.push("launch");
      state.volume = true; // `supabase start` creates the volume, whether or not it then succeeds
      return launchCode;
    },
    verifyRunning: async () => {
      calls.push("verify");
      return running;
    },
    stop: async () => calls.push("stop"),
  };
  return { io, calls };
}

const quietly = async (fn) => {
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    return { value: await fn(), errors };
  } finally {
    console.error = original;
  }
};

test("pilot startup fails closed: protected before its volume exists, and never restarted unprotected", async () => {
  const pilot = VARIANTS.pilot;
  const yes = { MGD_CREATE_PILOT: "1" };
  const created = { stack: "pilot", state: "created", kid: "kid-1" };
  // Normal creation: config and keys, the marker ("creating") BEFORE the first start creates the
  // volume, then the running keys checked, then "created".
  let state = { config: false, volume: false, marker: null };
  let run = fakeStart(state);
  assert.equal(await startStack("pilot", pilot, yes, run.io), 0);
  assert.deepEqual(run.calls, ["prepare", "keys:create", "protect:creating", "launch", "verify", "protect:created"]);
  assert.deepEqual(state.marker, created);

  // A failed start (exit 1) after the volume was created: protected ("creating"), never "created".
  state = { config: false, volume: false, marker: null };
  run = fakeStart(state, { launchCode: 1 });
  const failed = await quietly(() => startStack("pilot", pilot, yes, run.io));
  assert.equal(failed.value, 1);
  assert.deepEqual(state, { config: true, volume: true, marker: { stack: "pilot", state: "creating", kid: "kid-1" } }, "a partial pilot is a protected one");
  assert.match(failed.errors.join("\n"), /failed \(exit 1\)\. It stays protected[\s\S]*Nothing was deleted/);
  // Retrying with the flag is refused (it exists); a plain start resumes it, and then marks it created.
  await assert.rejects(startStack("pilot", pilot, yes, fakeStart({ ...state }).io), /already exists/);
  run = fakeStart(state);
  assert.equal(await startStack("pilot", pilot, {}, run.io), 0);
  assert.deepEqual(run.calls, ["keys:require", "launch", "verify", "protect:created"], "a resume prepares nothing and creates no key");

  // Killed inside the first start: the marker was already written.
  state = { config: false, volume: false, marker: null };
  run = fakeStart(state);
  run.io.launch = async () => {
    state.volume = true;
    throw new Error("killed");
  };
  await assert.rejects(startStack("pilot", pilot, yes, run.io), /killed/);
  assert.equal(state.marker.state, "creating");
  // Killed before the volume existed: config and "creating" marker, no volume. A plain start says
  // to finish with the flag; with the flag it creates (never over an existing volume).
  await assert.rejects(startStack("pilot", pilot, {}, fakeStart({ config: true, volume: false, marker: { ...state.marker } }).io), /creation stopped before its database existed[\s\S]*MGD_CREATE_PILOT=1/);
  run = fakeStart({ config: true, volume: false, marker: { ...state.marker } });
  assert.equal(await startStack("pilot", pilot, yes, run.io), 0);

  // M1: created once, then its volume vanished (a prune, a lost disk): never created again, flag or not.
  for (const env of [{}, yes]) {
    run = fakeStart({ config: true, volume: false, marker: { ...created } });
    await assert.rejects(startStack("pilot", pilot, env, run.io), /was created \(its protection marker says so\) but its database volume is gone/);
    assert.deepEqual(run.calls, []);
  }
  run = fakeStart({ config: false, volume: false, marker: { state: "unreadable" } });
  await assert.rejects(startStack("pilot", pilot, yes, run.io), /was created/, "an unreadable marker counts as created");

  // A restart with the marker missing, unreadable, another stack's, or for other keys (M6).
  for (const [marker, pattern] of [
    [null, /protection marker \(.*\) is missing/],
    [{ state: "unreadable" }, /can't be read/],
    [{ ...created, stack: "rehearsal" }, /names the rehearsal stack/],
    [{ ...created, kid: "kid-0" }, /other signing keys/],
  ]) {
    run = fakeStart({ config: true, volume: true, marker });
    await assert.rejects(startStack("pilot", pilot, {}, run.io), pattern);
    assert.ok(!run.calls.includes("launch") && !run.calls.includes("prepare"), "nothing starts or is regenerated");
  }
  // A restart with its own keys missing, or from a checkout that would change it.
  run = fakeStart({ config: true, volume: true, marker: { ...created } }, { keysMissing: true });
  await assert.rejects(startStack("pilot", pilot, {}, run.io), /own signing keys are missing/);
  assert.ok(!run.calls.includes("launch"));
  run = fakeStart({ config: true, volume: true, marker: { ...created } }, { drift: ["0001.sql differs"] });
  await assert.rejects(startStack("pilot", pilot, {}, run.io), /0001\.sql differs/);
  assert.deepEqual(run.calls, []);

  // M3: running with keys other than its own (the CLI's shared ones): stopped again at once.
  state = { config: true, volume: true, marker: { ...created } };
  run = fakeStart(state, { running: ["its Auth publishes signing keys other than its own"] });
  await assert.rejects(startStack("pilot", pilot, {}, run.io), /Stopped the pilot stack again: it isn't running with its own keys/);
  assert.deepEqual(run.calls, ["keys:require", "launch", "verify", "stop"]);
  // And a first creation running with other keys is never marked created.
  state = { config: false, volume: false, marker: null };
  run = fakeStart(state, { running: ["x"] });
  await assert.rejects(startStack("pilot", pilot, yes, run.io), /isn't running with its own keys/);
  assert.equal(state.marker.state, "creating");

  // M5: preflight runs every restart check and never starts; there is nothing to check without a pilot.
  run = fakeStart({ config: true, volume: true, marker: { ...created } });
  assert.equal(await startStack("pilot", pilot, {}, run.io, { preflight: true }), 0);
  assert.deepEqual(run.calls, ["keys:require"]);
  await assert.rejects(startStack("pilot", pilot, {}, fakeStart({ config: true, volume: true, marker: null }).io, { preflight: true }), /is missing/);
  await assert.rejects(startStack("pilot", pilot, yes, fakeStart({ config: false, volume: false, marker: null }).io, { preflight: true }), /no pilot stack to check/);

  // Other stacks start exactly as before: no marker, no keys, no checks.
  for (const name of ["test", "scratch", "b1"]) {
    run = fakeStart({ config: false, volume: false, marker: null }, { launchCode: 1 });
    assert.equal(await startStack(name, VARIANTS[name], {}, run.io), 1);
    assert.deepEqual(run.calls, ["prepare", "launch"], name);
  }
  // The twin starts as the pilot does, with its own flag and marker.
  const twin = VARIANTS.rehearsal;
  assert.equal(twin.createFlag, "MGD_CREATE_REHEARSAL");
  assert.notEqual(twin.marker, pilot.marker);
  await assert.rejects(startStack("rehearsal", twin, yes, fakeStart({ config: false, volume: false }).io), /set MGD_CREATE_REHEARSAL=1/, "the pilot's flag doesn't create the twin");
  state = { name: "rehearsal", config: false, volume: false, marker: null };
  run = fakeStart(state);
  assert.equal(await startStack("rehearsal", twin, { MGD_CREATE_REHEARSAL: "1" }, run.io), 0);
  assert.deepEqual(run.calls, ["prepare", "keys:create", "protect:creating", "launch", "verify", "protect:created"]);
  await assert.rejects(startStack("pilot", pilot, { MGD_CREATE_REHEARSAL: "1" }, fakeStart({ config: false, volume: false }).io), /created only at checkpoint P1/, "the twin's flag doesn't create the pilot");
});

test("Docker errors never read as a missing volume", () => {
  const missing = () => {
    throw Object.assign(new Error("x"), { stderr: "Error response from daemon: get supabase_db_x: no such volume" });
  };
  const down = () => {
    throw Object.assign(new Error("x"), { stderr: "error during connect: open //./pipe/docker_engine: The system cannot find the file specified." });
  };
  assert.equal(volumeExists("supabase_db_x", () => ""), true);
  assert.equal(volumeExists("supabase_db_x", missing), false);
  assert.throws(() => volumeExists("supabase_db_x", down), /Docker didn't say whether the volume supabase_db_x exists[\s\S]*Nothing was changed/);
  assert.throws(() => volumeExists("supabase_db_x", () => {
    throw new Error("spawn docker ENOENT");
  }), /Docker didn't say/);
});

test("markers: which stack, how far its creation got, and whose keys", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mgd-marker-"));
  try {
    const file = join(tmp, "protect-pilot-stack");
    assert.equal(readMarker(file), null);
    writeMarker(file, { stack: "pilot", state: "creating", kid: "k1" });
    assert.deepEqual({ ...readMarker(file), at: undefined, note: undefined }, { stack: "pilot", state: "creating", kid: "k1", at: undefined, note: undefined });
    assert.deepEqual(markerProblems(readMarker(file), { stack: "pilot", kid: "k1", file }), []);
    assert.match(markerProblems(readMarker(file), { stack: "pilot", kid: "k2", file })[0], /other signing keys/);
    assert.match(markerProblems(readMarker(file), { stack: "rehearsal", kid: "k1", file })[0], /names the pilot stack/);
    assert.match(markerProblems(null, { stack: "pilot", file })[0], /is missing/);
    // P1a's plain-text marker, or anything else unparseable, is "unreadable": protected, never used.
    writeFileSync(file, "Reset and destroy refuse the pilot stack while this file exists.\n");
    assert.deepEqual(readMarker(file), { state: "unreadable" });
    assert.throws(() => writeMarker(file, { stack: "pilot", state: "done", kid: "k1" }), /Unknown marker state/);
    // reset and destroy still refuse while any marker exists, readable or not.
    assert.throws(() => guardPersistent("destroy", VARIANTS.pilot, "pilot", { MGD_ALLOW_PILOT_RESET: "1" }, (f) => f === VARIANTS.pilot.marker), /it is protected/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // Every tool checks the marker and the running keys through stackStatus().
  const source = readFileSync(join(scripts, "lib", "stack.mjs"), "utf8");
  assert.match(source, /assertStackStatus\(status\);\n\s*assertOwnKeys\(status\);\n\s*return status;/);
});

test("own signing keys: generated once, owner-only, never overwritten, never in the config", () => {
  const source = readFileSync(join(repo, "supabase", "config.toml"), "utf8").replace(/\r\n/g, "\n");
  const own = testConfig(source, { project: "my-game-dex-pilot", offset: 4000, ownKeys: true });
  const auth = own.split("\n[auth]\n")[1].split("\n").slice(0, 4);
  assert.deepEqual(auth, [...OWN_KEY_CONFIG_LINES]);
  assert.match(own, /\[storage\.s3_protocol\]\nenabled = false\n/, "S3 (whose keys can't change) is off");
  assert.doesNotMatch(own, /sb_secret_|sb_publishable_|"d":/, "the config names the keys, never their values");
  const plain = testConfig(source, { project: "my-game-dex-b1", offset: 3000 });
  assert.doesNotMatch(plain, /^(jwt_secret|signing_keys_path|secret_key|publishable_key)\s*=/m, "other stacks are unchanged");
  assert.match(plain, /\[storage\.s3_protocol\]\nenabled = true\n/);
  assert.equal(VARIANTS.pilot.ownKeys, true);
  for (const name of ["test", "scratch", "b1"]) assert.ok(!VARIANTS[name].ownKeys);

  const tmp = mkdtempSync(join(tmpdir(), "mgd-keys-"));
  try {
    assert.throws(() => ensureStackKeys(tmp, { create: false, label: "the pilot" }), /own signing keys are missing/, "a restart never generates keys");
    assert.equal(ensureStackKeys(tmp, { create: true }).state, "created");
    const first = readFileSync(join(tmp, ENV_FILE), "utf8") + readFileSync(join(tmp, SIGNING_KEYS_FILE), "utf8");
    assert.equal(ensureStackKeys(tmp, { create: true }).state, "kept");
    assert.equal(readFileSync(join(tmp, ENV_FILE), "utf8") + readFileSync(join(tmp, SIGNING_KEYS_FILE), "utf8"), first, "never overwritten");
    if (process.platform !== "win32") for (const f of [ENV_FILE, SIGNING_KEYS_FILE]) assert.equal(statSync(join(tmp, f)).mode & 0o777, 0o600);
    const keys = readStackKeys(tmp);
    const [jwk] = JSON.parse(readFileSync(join(tmp, SIGNING_KEYS_FILE), "utf8"));
    assert.deepEqual([jwk.kty, jwk.crv, jwk.alg, jwk.use], ["EC", "P-256", "ES256", "sig"]);
    assert.ok(jwk.d && jwk.x && jwk.y && keys.kids[0] === jwk.kid);
    assert.match(keys.env[KEY_VARIABLES.publishable_key], /^sb_publishable_[\w-]{32}$/);
    assert.match(keys.env[KEY_VARIABLES.secret_key], /^sb_secret_[\w-]{32}$/);
    assert.ok(keys.env[KEY_VARIABLES.jwt_secret].length >= 64);
    // Independent each time.
    const other = generateStackKeys();
    assert.ok(!other.env.includes(keys.env[KEY_VARIABLES.secret_key]) && !other.signing.includes(jwk.d));
    // One file without the other is refused, either way round.
    rmSync(join(tmp, ENV_FILE));
    assert.throws(() => ensureStackKeys(tmp, { create: true }), /only one of its key files/);

    // A running stack must report exactly its own keys.
    writeFileSync(join(tmp, ENV_FILE), other.env);
    writeFileSync(join(tmp, SIGNING_KEYS_FILE), other.signing);
    const mine = readStackKeys(tmp);
    const signed = (kid) => `${Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url")}.e30.sig`;
    const status = {
      PUBLISHABLE_KEY: mine.env[KEY_VARIABLES.publishable_key], SECRET_KEY: mine.env[KEY_VARIABLES.secret_key], JWT_SECRET: mine.env[KEY_VARIABLES.jwt_secret],
      ANON_KEY: signed(mine.kids[0]), SERVICE_ROLE_KEY: signed(mine.kids[0]),
    };
    assert.deepEqual(ownKeyProblems(status, mine), []);
    assert.deepEqual(ownKeyProblems({ ...status, JWT_SECRET: "******" }, mine), [], "a masked JWT secret is fine");
    const shared = { ...status, SECRET_KEY: "sb_secret_shared", ANON_KEY: signed("b81269f1-21d8-4f2e-b719-c2240a840d90") };
    assert.deepEqual(ownKeyProblems(shared, mine), ["its secret key isn't its own", "its anon key isn't signed with its own signing key"]);
    assert.equal(ownKeyProblems({}, mine).length, 4);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // The key files are git-ignored wherever a stack with its own keys keeps them.
  const ignored = execFileSync("git", ["check-ignore", ".supabase-pilot/supabase/.env", ".supabase-pilot/supabase/signing_keys.json", ".supabase-rehearsal/supabase/.env"], { cwd: repo, encoding: "utf8" });
  assert.equal(ignored.trim().split(/\r?\n/).length, 3);
});

test("only the read-only migrations check of db.mjs may name the pilot", () => {
  const source = readFileSync(join(scripts, "db.mjs"), "utf8");
  assert.match(source, /guardDevStack\(`db:\$\{command\}`, \{ editorial: command === "migrations" \}\)/);
  for (const file of ["catalog-b1.mjs", "catalog-b1-review.mjs", "pilot-preview.mjs"]) {
    assert.match(readFileSync(join(scripts, file), "utf8"), /editorial: true/, file);
  }
  // The backups are editorial for the pilot target only.
  assert.match(readFileSync(join(scripts, "pilot-backup.mjs"), "utf8"), /editorial: target\.name === "pilot"/);
  // No other script says it is editorial, so every check, fixture, suite and runner refuses the pilot.
  const others = execFileSync("git", ["grep", "--untracked", "-l", "-E", "editorial: (true|target)", "--", "scripts"], { cwd: repo, encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(others.filter((f) => !f.endsWith(".test.mjs") && f !== "scripts/lib/stack.mjs"), ["scripts/catalog-b1-review.mjs", "scripts/catalog-b1.mjs", "scripts/pilot-backup.mjs", "scripts/pilot-preview.mjs"]);
});

test("with a pilot config present, stack.mjs refuses the pilot to everything but the editorial tools", () => {
  // A temporary copy of the repository's shape: nothing is written into the repository, so the
  // real pilot stays uncreated and guardCreate still refuses it.
  const tmp = mkdtempSync(join(tmpdir(), "mgd-pilot-"));
  try {
    mkdirSync(join(tmp, "scripts", "lib"), { recursive: true });
    cpSync(join(scripts, "lib", "stack.mjs"), join(tmp, "scripts", "lib", "stack.mjs"));
    for (const lib of ["stack-keys.mjs", "stack-marker.mjs"]) cpSync(join(scripts, "lib", lib), join(tmp, "scripts", "lib", lib));
    const source = readFileSync(join(repo, "supabase", "config.toml"), "utf8");
    mkdirSync(join(tmp, "supabase"));
    writeFileSync(join(tmp, "supabase", "config.toml"), source);
    mkdirSync(join(tmp, ".supabase-pilot", "supabase"), { recursive: true });
    const v = VARIANTS.pilot;
    writeFileSync(join(tmp, ".supabase-pilot", "supabase", "config.toml"), testConfig(source, { signup: false, project: v.project, offset: v.offset, site: v.site }));
    const probe = join(tmp, "probe.mjs");
    writeFileSync(probe, `
      const s = await import("./scripts/lib/stack.mjs");
      let refused = null;
      try { s.guardDevStack("a check"); } catch (e) { refused = e.message; }
      s.guardDevStack("the editorial review", { editorial: true });
      const t = s.editorialTarget(s.explicitStack, s.projectId, "x");
      console.log(JSON.stringify({ refused, project: s.projectId, container: s.dbContainer, workdir: s.workdirArgs, target: t }));`);
    const out = JSON.parse(execFileSync(process.execPath, [probe], { cwd: tmp, encoding: "utf8", env: { ...process.env, MGD_STACK: "pilot" } }));
    assert.match(out.refused, /against the pilot stack: it keeps real editorial decisions/);
    assert.equal(out.project, "my-game-dex-pilot");
    assert.equal(out.container, "supabase_db_my-game-dex-pilot");
    assert.deepEqual(out.workdir, ["--workdir", join(tmp, ".supabase-pilot")]);
    assert.equal(out.target.apiPort, 58321);
    // A config naming another project is refused outright.
    writeFileSync(join(tmp, ".supabase-pilot", "supabase", "config.toml"), testConfig(source, { project: "my-game-dex-b1", offset: 4000 }));
    assert.throws(() => execFileSync(process.execPath, [probe], { cwd: tmp, stdio: "pipe", env: { ...process.env, MGD_STACK: "pilot" } }), /names project "my-game-dex-b1"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("both editorial CLIs refuse development, test, scratch, an unknown and a missing stack", beforeP1, () => {
  const cases = [
    ["dev", /writes only to an editorial stack|isn't prepared/],
    ["test", /writes only to an editorial stack|isn't prepared/],
    ["scratch", /writes only to an editorial stack|isn't prepared/],
    ["prod", /MGD_STACK must be one of/],
    [null, /needs an explicit stack/],
    ["pilot", /doesn't exist yet/],
  ];
  for (const [stack, expected] of cases) {
    const env = stack === null ? withoutStack() : { ...process.env, MGD_STACK: stack };
    for (const [file, argv] of [["catalog-b1.mjs", ["report"]], ["catalog-b1-review.mjs", ["status"]]]) {
      let out = "";
      try {
        execFileSync(process.execPath, [join(scripts, file), ...argv], { stdio: "pipe", env, cwd: repo });
        assert.fail(`${file} on ${stack} ran`);
      } catch (error) {
        out = `${error.stderr ?? ""}`;
      }
      assert.match(out, expected, `${file} on ${stack ?? "(unset)"}`);
    }
  }
});

test("pilot accounts: real people only; editor A, @example.test and automatic sessions are B1's", () => {
  const pilot = EDITORIAL_STACKS.pilot;
  const b1 = EDITORIAL_STACKS.b1;
  assert.equal(editorEmailProblem("reviewer@example.test", b1), null);
  assert.match(editorEmailProblem("someone@mail.example", b1), /@example\.test/);
  assert.match(editorEmailProblem("reviewer@example.test", pilot), /real person/);
  assert.equal(editorEmailProblem("first.last+pilot@mail.example", pilot), null);
  for (const bad of ["", "no-at-sign", "a@b", "a b@c.d", "a@-.", `${"x".repeat(65)}@c.d`, "a@c.d\n", "a'@c.d", "a@c.d;drop"]) {
    assert.ok(editorEmailProblem(bad, pilot), JSON.stringify(bad));
  }
  const review = readFileSync(join(scripts, "catalog-b1-review.mjs"), "utf8");
  const body = (name) => {
    const start = review.indexOf(`async function ${name}(`);
    assert.ok(start > 0, name);
    return review.slice(start, review.indexOf("\n}\n", start));
  };
  // editor-a refuses the pilot before it creates or reads anything.
  assert.match(body("cmdEditorA").split("\n").slice(1, 3).join("\n"), /if \(!TARGET\.disposableEditor\) fail\(/);
  // On the pilot, create-batch signs in as the named human editor, with their own reason.
  const create = body("cmdCreateBatch");
  assert.match(create, /if \(TARGET\.disposableEditor\) \{\s*\(\{ session \} = await editorASession\(\)\);/);
  assert.match(create, /\} else \{[\s\S]*session = await ownerSession\(email\);[\s\S]*await ask\("Your reason/);
  // The creator's refused-write probes run with B1's disposable editor only, never a real session.
  const probes = /if \(TARGET\.disposableEditor\) \{[\s\S]*?checks\.push\(([\s\S]*?)\);\s*\} else \{/.exec(create);
  assert.ok(probes, "the write probes are inside the disposable-editor branch");
  assert.match(probes[1], /"record_batch_outcome"[\s\S]*"approve_review_batch"/);
  const rest = create.replace(probes[0], "");
  assert.doesNotMatch(rest, /"(record_batch_outcome|approve_review_batch|reject_review_batch|publish_game_identity)/, "no other decision call in create-batch");
  // Every decision is a human's: a terminal, their own password and authenticator, a typed reason and confirmation.
  for (const name of ["ownerSession"]) assert.match(body(name), /requireTerminal\(\);[\s\S]*await hidden\([\s\S]*verifyFactor/);
  const decide = body("decide");
  assert.match(decide, /requireTerminal\(\);/);
  assert.match(decide, /await ownerSession\(email\)/);
  assert.match(decide, /await ask\("Your reason/);
  assert.match(decide, /await ask\(`Type the batch's first 8 characters/);
  const publish = body("cmdPublish");
  assert.match(publish, /requireTerminal\(\);[\s\S]*await ownerSession\(email\)[\s\S]*confirmsGame\(await ask\(/);
  // No other call of the approval or publication functions anywhere in the tooling.
  const calls = execFileSync("git", ["grep", "--untracked", "-n", "-E", "\"(approve_review_batch_as_seen|publish_game_identity_as_seen)\"", "--", "scripts/*.mjs", ":!scripts/*.test.mjs"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
  assert.equal(calls.length, 2, calls.join("\n"));
  for (const line of calls) assert.match(line, /^scripts\/catalog-b1-review\.mjs:/);
  // Every decision RPC in the editorial tools: in the review CLI's human commands, or B1's probes.
  const decisions = execFileSync("git", ["grep", "--untracked", "-n", "-E", "\"(record_batch_outcome|approve_review_batch|reject_review_batch|publish_game_identity|verify_game_platform|record_provider_rights)[a-z_]*\"", "--", "scripts/catalog-b1-review.mjs", "scripts/catalog-b1.mjs", "scripts/pilot-*.mjs", "scripts/lib/*.mjs", ":!scripts/*.test.mjs"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
  for (const line of decisions) assert.match(line, /^scripts\/catalog-b1-review\.mjs:/, line);
  // editor A's session (the only stored one) is never used to approve or publish.
  assert.doesNotMatch(decide + publish, /editorASession/);
});

test("credentials: each stack keeps its own folder, outside the repository", () => {
  const review = readFileSync(join(scripts, "catalog-b1-review.mjs"), "utf8");
  assert.match(review, /const WORK = join\(homedir\(\), "\.my-game-dex", "catalog-pilot", TARGET\.work\);/);
  assert.doesNotMatch(review, /"catalog-pilot", "m12c-b1"/, "no hard-coded B1 folder in the review CLI");
  assert.doesNotMatch(review, /57321|127\.0\.0\.4|3004/, "no hard-coded B1 endpoint in the review CLI");
  const stage = readFileSync(join(scripts, "catalog-b1.mjs"), "utf8");
  assert.doesNotMatch(stage, /57321|127\.0\.0\.4|3004/, "no hard-coded B1 endpoint in the staging CLI");
  assert.ok(!BACKUP_DIR.startsWith(repo));
  assert.equal(BACKUP_DIR, join(homedir(), ".my-game-dex", "backups", "pilot"));
});

test("the pilot's sources: the pinned files only, never the superseded fetch", () => {
  assert.deepEqual(Object.keys(PILOT_SOURCES).sort(), ["entities", "formats", "notes", "selection", "terms"]);
  for (const hash of Object.values(PILOT_SOURCES)) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(PILOT_SOURCES.entities, "96a8ac561e5f96efe73bbb51815b38a400f7b8f5b6916894d4f58e9e3920da92");
  assert.equal(PILOT_SOURCES.notes, "c24d2a0a72e0ae2d423edafa672375a3aca12bc8491056108af8fab31e2f1c68");
  const superseded = "4e87b22e5abb962349b4774431d3f895132ae2fb17fb2e8af164b569f656d8cd";
  assert.ok(Object.hasOwn(PILOT_REFUSED, superseded));
  const hashes = { e: PILOT_SOURCES.entities, s: PILOT_SOURCES.selection, old: superseded, other: "0".repeat(64) };
  const hash = (path) => {
    if (path === "unreadable") throw new Error("ENOENT");
    return hashes[path];
  };
  assert.deepEqual(pilotSourceProblems({ entities: "e", selection: "s" }, hash), []);
  assert.match(pilotSourceProblems({ entities: "old" }, hash)[0], /superseded first entity fetch/);
  assert.match(pilotSourceProblems({ entities: "other" }, hash)[0], /isn't the pinned/);
  assert.match(pilotSourceProblems({ entities: "s" }, hash)[0], /isn't the pinned/, "a pinned file in the wrong role");
  assert.match(pilotSourceProblems({ entities: true }, hash)[0], /missing/);
  assert.match(pilotSourceProblems({ entities: "unreadable" }, hash)[0], /can't be read/);
  assert.match(pilotSourceProblems({ artwork: "e" }, hash)[0], /not a pilot source/);
  // The notes in the repository are the pinned ones, and staging checks every source on the pilot.
  assert.deepEqual(pilotSourceProblems({ notes: join(repo, "docs", "proposals", "m12c-b1", "editorial-review-snes-150.json") }), []);
  const stage = readFileSync(join(scripts, "catalog-b1.mjs"), "utf8");
  assert.match(stage, /requirePilotSources\(target, \{ entities: [^}]*selection: [^}]*notes: [^}]*terms: [^}]*\}\)/);
});

test("checkpoint backups and snapshots: allow-listed names, never overwritten, outside the repository", () => {
  // A manifest lists exactly this backup's files, plain names, each once.
  const name = "pilot-empty-20261123T201959Z";
  const h = "a".repeat(64);
  const manifest = DUMP_FILES.map((suffix) => `${h} *${name}.${suffix}`).join("\n");
  assert.equal(manifestEntries(manifest, `${name}.sha256`).length, DUMP_FILES.length);
  assert.throws(() => manifestEntries(manifest.split("\n").slice(1).join("\n"), `${name}.sha256`), /incomplete: no created\.txt/);
  assert.throws(() => manifestEntries(`${manifest}\n${h} *../${name}.dump`, `${name}.sha256`), /Malformed/);
  assert.throws(() => manifestEntries(`${manifest}\n${h} *other.dump`, `${name}.sha256`), /Malformed/);
  assert.throws(() => manifestEntries(`${manifest}\n${h} *${name}.dump`, `${name}.sha256`), /twice/);
  assert.throws(() => manifestEntries(manifest, "notes.sha256"), /isn't a pilot backup manifest/);
  assert.deepEqual([...CHECKPOINTS], ["empty", "staged", "batch", "reviewed", "approved", "published", "audited"]);
  for (const bad of ["", "dev", "../x", "empty;rm", "EMPTY", true, undefined]) assert.throws(() => checkpointName(bad), /--checkpoint must be one of/);
  const at = new Date("2026-11-23T20:19:59.123Z");
  assert.equal(stamp(at), "20261123T201959Z");
  const plan = dumpPlan("empty", at, () => false);
  assert.equal(plan.dump, join(BACKUP_DIR, "pilot-empty-20261123T201959Z.dump"));
  assert.throws(() => dumpPlan("empty", at, (p) => p.endsWith(".dump")), /Nothing is ever overwritten/);
  assert.throws(() => dumpPlan("empty", at, (p) => p.endsWith(".sha256")), /Nothing is ever overwritten/);
  const snap = snapshotPlan("approved", at, () => false);
  assert.equal(snap.volume, "mgd_pilot_db_snapshot_approved_20261123t201959z");
  assert.match(snap.volume, /^[a-z0-9_]+$/);
  assert.doesNotMatch(snap.volume, /^mgd_dev_db_snapshot_|^mgd_demo_/, "never a development snapshot's or demo volume's name");
  assert.throws(() => snapshotPlan("approved", at, (n) => n === snap.volume), /Nothing is ever overwritten/);
  const full = readFileSync(join(scripts, "pilot-backup.mjs"), "utf8");
  const tool = full.slice(full.indexOf("*/"));
  assert.doesNotMatch(tool, /pg_restore --clean|"--clean"|volume", "rm"|"restore":|db", "reset"/, "no restore, reset or deletion in the backup tool");
  assert.match(tool, /flag: "wx"/, "files are created exclusively");
  // Before P1 the tool refuses: the pilot doesn't exist.
  // A dump is binary: it is never re-encoded as text on its way to pg_restore.
  assert.doesNotMatch(tool, /latin1|encoding: "utf8"/);
  assert.match(tool, /"ON_ERROR_STOP=1"/);
  if (!pilotExists) assert.match(stderrOf(() => node("pilot-backup.mjs", ["dump", "--checkpoint", "empty"], {})), /doesn't exist yet/);

  // A failed dump's name is never reused, and its files never verify (no manifest).
  assert.throws(() => dumpPlan("empty", at, (p) => p.endsWith(".FAILED.txt")), /Nothing is ever overwritten/);
  assert.throws(() => dumpPlan("empty", at, (p) => p.endsWith(".roles.sql")), /Nothing is ever overwritten/);
  assert.match(tool, /catch \(error\) \{\n\s*writeFileSync\(`\$\{plan\.base\}\.FAILED\.txt`[\s\S]*?throw new Error[\s\S]*?\}\n\s*write\("sha256"/, "the manifest is written last, only after every file");
  // The targets: the pilot (fixed), or its rehearsal twin (its own names, volume and folder).
  const pilot = backupTarget("pilot");
  assert.deepEqual({ ...pilot }, { name: "pilot", prefix: "pilot", volume: "supabase_db_my-game-dex-pilot", backupDir: BACKUP_DIR, snapshotPrefix: "mgd_pilot_db_snapshot" });
  const away = join(tmpdir(), "mgd-rehearsal-backups");
  const twin = backupTarget("rehearsal", { backupDir: away });
  assert.equal(twin.volume, "supabase_db_my-game-dex-rehearsal");
  assert.equal(dumpPlan("empty", at, () => false, twin).dump, join(away, "rehearsal-empty-20261123T201959Z.dump"));
  assert.equal(snapshotPlan("empty", at, () => false, twin).volume, "mgd_rehearsal_db_snapshot_empty_20261123t201959z");
  for (const name of ["dev", "test", "scratch", "b1", "", undefined]) assert.throws(() => backupTarget(name, { backupDir: away }), /only of the pilot/);
  assert.throws(() => backupTarget("pilot", { backupDir: away }), /only to its own folder/);
  for (const inside of [BACKUP_DIR, join(BACKUP_DIR, "x")]) assert.throws(() => backupTarget("rehearsal", { backupDir: inside }), /never writes into the pilot's/);
  assert.throws(() => backupTarget("rehearsal", { backupDir: "relative" }), /absolute/);
  const rehearsal = `rehearsal-empty-20261123T201959Z`;
  const own = DUMP_FILES.map((suffix) => `${h} *${rehearsal}.${suffix}`).join("\n");
  assert.equal(manifestEntries(own, `${rehearsal}.sha256`, "rehearsal").length, DUMP_FILES.length);
  assert.throws(() => manifestEntries(own, `${rehearsal}.sha256`), /isn't a pilot backup manifest/, "the pilot's verify never accepts a rehearsal's");
  assert.throws(() => manifestEntries(manifest, `${name}.sha256`, "rehearsal"), /isn't a rehearsal backup manifest/);
  assert.throws(() => manifestEntries(manifest, `${name}.sha256`, "dev"), /isn't a dev backup manifest/);
  // A stack whose container isn't the target's is refused before anything is written.
  assert.equal((tool.match(/if \(stack\.dbContainer !== target\.volume\) throw/g) ?? []).length, 3, "connect, dump and snapshot");
  // The command line builds only the pilot target; only the rehearsal script builds the twin.
  assert.match(tool, /const PILOT = backupTarget\("pilot"\);\nconst cmdDump = async \(o\) => dump\(PILOT, o\.checkpoint, await connect\(PILOT\)\);\nconst cmdSnapshot = async \(o\) => snapshot\(PILOT,/);
  const twins = execFileSync("git", ["grep", "--untracked", "-l", "backupTarget(\"rehearsal\"", "--", "scripts/*.mjs", ":!scripts/*.test.mjs"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(twins, ["scripts/pilot-rehearsal.mjs"]);
  // Stopping and restarting for a snapshot goes through test-stack.mjs (its start guards), never the CLI directly.
  assert.match(tool, /function stackCommand\(stack, target, command\) \{[\s\S]*?delete env\.MGD_CREATE_PILOT;[\s\S]*?"scripts", "test-stack\.mjs"\), command\]/);
  assert.doesNotMatch(tool, /stack\.cli, command/);
});

test("the rehearsal touches only its twin and scratch, and prints no key", () => {
  const source = readFileSync(join(scripts, "pilot-rehearsal.mjs"), "utf8");
  const body = source.slice(source.indexOf("*/"));
  assert.match(body, /if \(process\.env\.MGD_STACK && process\.env\.MGD_STACK !== "rehearsal"\) throw/);
  assert.match(body, /if \(stack\.stackName !== "rehearsal" \|\| stack\.projectId !== stack\.REHEARSAL_PROJECT_ID\) throw/);
  assert.doesNotMatch(body, /my-game-dex-pilot|my-game-dex-b1|my-game-dex-test|\.supabase-pilot|\.supabase-b1|\.supabase-test|MGD_TEST_STACK: "pilot"|backupTarget\("pilot"/);
  assert.doesNotMatch(body, /console\.log\([^)]*(SECRET_KEY|JWT_SECRET|PUBLISHABLE_KEY|SERVICE_ROLE_KEY|ANON_KEY|\.token)\b/, "no key or token is printed");
  // Its cleanup removes only the rehearsal's own snapshot volumes.
  assert.match(body, /\/\^mgd_rehearsal_db_snapshot_\[a-z\]\+_\\d\{8\}t\\d\{6\}z\$\/\.test\(v\)/);
  if (!existsSync(join(repo, ".supabase-rehearsal", "supabase", "config.toml"))) {
    assert.match(stderrOf(() => node("pilot-rehearsal.mjs", ["isolation"], {})), /rehearsal stack isn't prepared/);
  }
  assert.match(stderrOf(() => node("pilot-rehearsal.mjs", ["isolation"], { MGD_STACK: "pilot" })), /only on the rehearsal stack/);
});

test("the pilot preview: its own loopback address and port, never port 3000", () => {
  const preview = readFileSync(join(scripts, "pilot-preview.mjs"), "utf8");
  assert.match(preview, /process\.env\.MGD_STACK = "pilot";/);
  assert.match(preview, /"-p", origin\.port, "-H", origin\.hostname/);
  assert.match(preview, /ENABLE_SEED_DATA: "false"/, "never the demo data");
  assert.doesNotMatch(preview.slice(preview.indexOf("*/")), /3000|127\.0\.0\.1/);
  if (!pilotExists) assert.match(stderrOf(() => node("pilot-preview.mjs", [], {})), /doesn't exist yet/);
});

test("stackStatus's own-key check, run: marker, key files and the running keys", () => {
  // A temporary copy of the libraries, with its own home folder: nothing real is read or written.
  const tmp = mkdtempSync(join(tmpdir(), "mgd-ownkeys-"));
  try {
    mkdirSync(join(tmp, "scripts", "lib"), { recursive: true });
    for (const lib of ["stack.mjs", "stack-keys.mjs", "stack-marker.mjs"]) cpSync(join(scripts, "lib", lib), join(tmp, "scripts", "lib", lib));
    const source = readFileSync(join(repo, "supabase", "config.toml"), "utf8");
    mkdirSync(join(tmp, "supabase"));
    writeFileSync(join(tmp, "supabase", "config.toml"), source);
    const supabaseDir = join(tmp, ".supabase-pilot", "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    const v = VARIANTS.pilot;
    writeFileSync(join(supabaseDir, "config.toml"), testConfig(source, { signup: false, project: v.project, offset: v.offset, site: v.site, ownKeys: true }));
    const { kid } = ensureStackKeys(supabaseDir, { create: true });
    const keys = readStackKeys(supabaseDir);
    const signed = `${Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url")}.e30.sig`;
    const status = { API_URL: "http://127.0.0.1:58321", PUBLISHABLE_KEY: keys.env[KEY_VARIABLES.publishable_key], SECRET_KEY: keys.env[KEY_VARIABLES.secret_key], ANON_KEY: signed, SERVICE_ROLE_KEY: signed };
    const probe = join(tmp, "probe.mjs");
    writeFileSync(probe, `
      const s = await import("./scripts/lib/stack.mjs");
      const status = ${JSON.stringify(status)};
      const running = process.env.PROBE_RESULT ? [process.env.PROBE_RESULT] : [];
      try { s.assertOwnKeys(status, "pilot", { probe: () => running }); console.log("accepted"); } catch (e) { console.log(e.message); }`);
    const home = join(tmp, "home");
    const run = (extra = {}) => execFileSync(process.execPath, [probe], { cwd: tmp, encoding: "utf8", env: { ...process.env, MGD_STACK: "pilot", HOME: home, USERPROFILE: home, ...extra } }).trim();
    const marker = join(home, ".my-game-dex", "protect-pilot-stack");
    assert.match(run(), /isn't protected and running with its own keys: its protection marker .* is missing/);
    writeMarker(marker, { stack: "pilot", state: "created", kid: "00000000-0000-4000-8000-000000000000" });
    assert.match(run(), /belongs to a stack with other signing keys/);
    // A creation that never finished isn't used until a guarded start marks it created.
    writeMarker(marker, { stack: "pilot", state: "creating", kid });
    assert.match(run(), /its creation didn't finish: start it once more/);
    writeMarker(marker, { stack: "pilot", state: "created", kid });
    assert.equal(run(), "accepted");
    assert.match(run({ PROBE_RESULT: "its Auth publishes signing keys other than its own" }), /its Auth publishes signing keys other than its own/, "the running stack decides, not its config");
    // A key file emptied or truncated is refused, never used.
    writeFileSync(join(supabaseDir, ENV_FILE), "# truncated\nMGD_STACK_JWT_SECRET=\n");
    assert.match(run(), /key files .* can't be used: .*incomplete or malformed \(\.env: MGD_STACK_JWT_SECRET\)/);
    writeFileSync(join(supabaseDir, SIGNING_KEYS_FILE), "[");
    assert.throws(() => readStackKeys(supabaseDir), /malformed \(signing_keys\.json\)|malformed \(\.env/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the running-key probe: against a fake Auth, with timeouts, retries and a clear refusal", async () => {
  const { createServer } = await import("node:http");
  const keys = { env: { [KEY_VARIABLES.secret_key]: "sb_secret_mine" }, kids: ["kid-mine"] };
  let behaviour = "own";
  const server = createServer((request, response) => {
    if (behaviour === "hang") return; // accepts, never answers
    if (behaviour === "down") {
      response.writeHead(503);
      return response.end();
    }
    if (request.url.startsWith("/auth/v1/.well-known/jwks.json")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ keys: [{ kid: behaviour === "shared" ? "b81269f1-21d8-4f2e-b719-c2240a840d90" : "kid-mine" }] }));
    }
    response.writeHead(request.headers.apikey === "sb_secret_mine" && behaviour !== "shared" ? 200 : 401);
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await runningKeyProblems(api, keys, { attempts: 2, wait: 10 }), []);
    behaviour = "shared";
    assert.deepEqual(await runningKeyProblems(api, keys, { attempts: 2, wait: 10 }), ["its Auth publishes signing keys other than its own", "its own secret key doesn't open its Auth admin API (401)"]);
    behaviour = "down";
    assert.match((await runningKeyProblems(api, keys, { attempts: 2, wait: 10 }))[0], /couldn't be checked: Auth answered 503/);
    behaviour = "hang";
    const started = Date.now();
    assert.match((await runningKeyProblems(api, keys, { attempts: 1, wait: 10 }))[0], /couldn't be checked/);
    assert.ok(Date.now() - started < 15000, "a hanging Auth is given up on (5 s per request)");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  // The synchronous form never throws: a dead address becomes a refusal, not a crash.
  const sync = runningKeyProblemsSync("http://127.0.0.1:9", keys);
  assert.equal(sync.length, 1);
  assert.match(sync[0], /couldn't be checked/);
});
