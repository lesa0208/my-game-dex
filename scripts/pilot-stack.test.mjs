/**
 * M15 P1a: the isolated SNES pilot stack's tooling. Every test is pure or runs in a temporary
 * folder; none starts, reads or writes a stack, and none creates the pilot. The few that run a
 * tool with MGD_STACK=pilot to see it refuse run only while the pilot doesn't exist (before P1).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { editorEmailProblem } from "./lib/editorial-accounts.mjs";
import { PILOT_REFUSED, PILOT_SOURCES, pilotSourceProblems } from "./lib/pilot-sources.mjs";
import { BASE_API_PORT, EDITORIAL_STACKS, PILOT_PROTECTION_MARKER, STACKS, editorialTarget } from "./lib/stack.mjs";
import { CHECKPOINTS, BACKUP_DIR, DUMP_FILES, checkpointName, dumpPlan, manifestEntries, snapshotPlan, stamp } from "./pilot-backup.mjs";
import { VARIANTS, driftProblems, guardCreate, guardPersistent, guardRun, testConfig } from "./test-stack.mjs";

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
  assert.deepEqual(STACKS.pilot, { project: "my-game-dex-pilot", dir: ".supabase-pilot", offset: 4000 });
  assert.equal(EDITORIAL_STACKS.pilot.apiPort, 58321);
  assert.equal(EDITORIAL_STACKS.pilot.preview, "http://127.0.0.5:3005");
  const names = Object.keys(STACKS);
  for (const key of ["project", "dir", "offset"]) assert.equal(new Set(names.map((n) => STACKS[n][key])).size, names.length, `${key} unique`);
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
  assert.throws(() => guardCreate("pilot", {}, state(true, false)), /volume doesn't \(it was deleted\)/);
  assert.throws(() => guardCreate("pilot", {}, state(false, true)), /volume exists but its config doesn't/);
  assert.throws(() => guardCreate("pilot", yes, state(false, true)), /already exists/);
  for (const name of ["test", "scratch", "b1"]) assert.equal(guardCreate(name, {}, state(false, false)), "prepare");
  // db.mjs never starts the pilot (it would recreate a deleted one).
  assert.match(readFileSync(join(scripts, "db.mjs"), "utf8"), /if \(stackName === "pilot" && command === "start"\) \{/);
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
  const tool = readFileSync(join(scripts, "test-stack.mjs"), "utf8");
  assert.match(tool, /if \(mode === "restart"\) \{[\s\S]*?driftProblems\([\s\S]*?return supabase\(\["start"\]\);\s*\}/, "a restart doesn't prepare()");
  assert.match(tool, /if \(mode === "create" && code === 0\) protectPilot\(\);/, "protected from creation");
});

test("only the read-only migrations check of db.mjs may name the pilot", () => {
  const source = readFileSync(join(scripts, "db.mjs"), "utf8");
  assert.match(source, /guardDevStack\(`db:\$\{command\}`, \{ editorial: command === "migrations" \}\)/);
  for (const file of ["catalog-b1.mjs", "catalog-b1-review.mjs", "pilot-preview.mjs", "pilot-backup.mjs"]) {
    assert.match(readFileSync(join(scripts, file), "utf8"), /editorial: true/, file);
  }
  // No other script says it is editorial, so every check, fixture, suite and runner refuses the pilot.
  const others = execFileSync("git", ["grep", "--untracked", "-l", "editorial: true", "--", "scripts"], { cwd: repo, encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(others.filter((f) => !f.endsWith(".test.mjs") && f !== "scripts/lib/stack.mjs"), ["scripts/catalog-b1-review.mjs", "scripts/catalog-b1.mjs", "scripts/pilot-backup.mjs", "scripts/pilot-preview.mjs"]);
});

test("with a pilot config present, stack.mjs refuses the pilot to everything but the editorial tools", () => {
  // A temporary copy of the repository's shape: nothing is written into the repository, so the
  // real pilot stays uncreated and guardCreate still refuses it.
  const tmp = mkdtempSync(join(tmpdir(), "mgd-pilot-"));
  try {
    mkdirSync(join(tmp, "scripts", "lib"), { recursive: true });
    cpSync(join(scripts, "lib", "stack.mjs"), join(tmp, "scripts", "lib", "stack.mjs"));
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
});

test("the pilot preview: its own loopback address and port, never port 3000", () => {
  const preview = readFileSync(join(scripts, "pilot-preview.mjs"), "utf8");
  assert.match(preview, /process\.env\.MGD_STACK = "pilot";/);
  assert.match(preview, /"-p", origin\.port, "-H", origin\.hostname/);
  assert.match(preview, /ENABLE_SEED_DATA: "false"/, "never the demo data");
  assert.doesNotMatch(preview.slice(preview.indexOf("*/")), /3000|127\.0\.0\.1/);
  if (!pilotExists) assert.match(stderrOf(() => node("pilot-preview.mjs", [], {})), /doesn't exist yet/);
});
