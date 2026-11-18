/**
 * M11a-2 and M11a-3: proves the app checks detect real violations of the password and
 * session rules (set m11a2) and of the avatar and profile rules (set m11a3), which live in
 * the app's code rather than the database (db-mutation-checks.mjs covers the database).
 * For each violation: change one source file, build, run its suite (which must fail),
 * restore the file, and check it's byte-for-byte the original.
 *
 *   MGD_STACK=test node scripts/app-mutation-checks.mjs [--set m11a2|m11a3] [--log file] [--only name,...]
 *   node scripts/app-mutation-checks.mjs --recover
 *
 * Opens and closes with a clean baseline (a build and a passing suite). About four
 * minutes per violation. The build replaces .next, so stop any `next start` serving it
 * first. Source files are changed only through a recovery journal outside the repository;
 * after an interrupted run, --recover restores a file only if it still matches the exact
 * mutation recorded, and refuses otherwise. Never run Git commands while this runs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const journal = join(homedir(), ".my-game-dex", "app-mutation-recovery", "journal.json");
const sha = (text) => createHash("sha256").update(text).digest("hex");
const argument = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
const logFile = argument("--log");
function log(line) {
  const text = `${new Date().toTimeString().slice(0, 8)} ${line}`;
  console.log(text);
  if (logFile) appendFileSync(logFile, `${text}\n`);
}

const ACTIONS = "src/features/password/actions.ts";
const FORM = "src/features/password/form.ts";
const SERVER = "src/features/password/server.ts";
const WORKFLOW = "src/features/avatars/avatar-workflow.ts";
const PROFILE_PAGE = "src/app/(app)/settings/profile/page.tsx";

/**
 * M11a-3: the avatar workflow's new privileged step (removing leftovers with the secret
 * key), the action body limit raised for uploads, and the profile's user-supplied text
 * kept as text. Checked by app:profile-checks.
 */
// Not listed: dropping removeLeftovers' "never the current photo" filter. On every
// reachable path the current photo was uploaded moments before, so the ten-minute rule
// already keeps it, and the mutant survived (an equivalent mutant, 2026-11-18). The filter
// stays as a guard against the app's clock running ahead of Storage's.
const m11a3 = [
  {
    name: "leftover cleanup ignores a file's age",
    file: WORKFLOW,
    from: ` && now - Date.parse(object.created_at) > LEFTOVER_AGE_MS)`,
    to: ` && now - Date.parse(object.created_at) > -LEFTOVER_AGE_MS)`,
  },
  {
    name: "the action body limit is raised without bound",
    file: "next.config.ts",
    from: `      bodySizeLimit: 2 * 1024 * 1024 + 64 * 1024,`,
    to: `      bodySizeLimit: 20 * 1024 * 1024,`,
  },
  {
    name: "the bio is rendered as markup",
    file: PROFILE_PAGE,
    from: `<p className="mt-2 text-sm break-words whitespace-pre-line">{profile.bio}</p>`,
    to: `<p className="mt-2 text-sm break-words whitespace-pre-line" dangerouslySetInnerHTML={{ __html: profile.bio }} />`,
  },
].map((m) => ({ ...m, set: "m11a3", suite: "app-profile-checks.mjs" }));

/** Each: a violation of a rule M11a-2 relies on, as the smallest plausible code change. */
const m11a2 = [
  {
    name: "a reset needs no recovery session",
    file: ACTIONS,
    from: `  if ((await currentRecovery(auth?.claims)) !== "ok") redirect(RESET);\n`,
    to: `  void (await currentRecovery(auth?.claims));\n`,
  },
  {
    name: "the recovery mark isn't bound to the session",
    file: FORM,
    from: ` || !cookieSessionId || claims.session_id !== cookieSessionId) return "none";`,
    to: ` || !cookieSessionId) return "none";`,
  },
  {
    name: "a reset has no time limit",
    file: FORM,
    from: `  return nowSeconds - otp.timestamp <= RECOVERY_WINDOW_SECONDS && otp.timestamp <= nowSeconds + 60 ? "ok" : "expired";`,
    to: `  return "ok";`,
  },
  {
    name: "a change doesn't check the current password",
    file: ACTIONS,
    from: `  const checked = await checkCurrentPassword(email, current);\n`,
    to: `  const checked = (current ? "ok" : await checkCurrentPassword(email, current)) as string;\n`,
  },
  {
    name: "checking the current password leaves its session open",
    file: SERVER,
    from: `  if (data.session) await client.auth.signOut({ scope: "local" }).catch(() => undefined);\n`,
    to: ``,
  },
  {
    name: "a reset link carries on in whoever's session was here",
    file: ACTIONS,
    from: `  if (before?.claims?.sub) await supabase.auth.signOut({ scope: "local" });\n`,
    to: `  void before;\n`,
  },
  {
    name: "a reset request tells a rate-limited address apart",
    file: ACTIONS,
    from: `  await requestResetEmail(email);\n`,
    to: `  const asked = await fetch(\`\${process.env.SUPABASE_URL}/auth/v1/recover\`, { method: "POST", headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "", "Content-Type": "application/json" }, body: JSON.stringify({ email }) });\n  if (asked.status === 429) redirect(withParam(FORGOT, "error", "too_many"));\n  void requestResetEmail;\n`,
  },
  {
    name: "a reset request answers at once",
    file: ACTIONS,
    from: `const RESET_REQUEST_MIN_MS = 2000;`,
    to: `const RESET_REQUEST_MIN_MS = 0;`,
  },
  {
    name: "signing out everywhere signs out this device only",
    file: ACTIONS,
    from: `  const { error } = await supabase.auth.signOut({ scope: "global" });`,
    to: `  const { error } = await supabase.auth.signOut({ scope: "local" });`,
  },
  {
    name: "the recovery mark is readable by page scripts",
    file: SERVER,
    from: `    httpOnly: true,\n    sameSite: "lax",\n    secure: AUTH_COOKIE_OPTIONS.secure,\n    maxAge: RECOVERY_WINDOW_SECONDS,`,
    to: `    httpOnly: false,\n    sameSite: "lax",\n    secure: AUTH_COOKIE_OPTIONS.secure,\n    maxAge: RECOVERY_WINDOW_SECONDS,`,
  },
].map((m) => ({ ...m, set: "m11a2", suite: "app-password-checks.mjs" }));

export const mutations = [...m11a2, ...m11a3];

function run(command, args, label) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, MGD_STACK: "test" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, status: result.status, seconds: Math.round((Date.now() - started) / 1000), output, label };
}
const build = () => run(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "build"], "build");
const suite = (script) => run(process.execPath, [join(root, "scripts", script)], script);
const failures = (output) => output.split("\n").filter((line) => line.startsWith("FAIL")).slice(0, 4).map((line) => line.slice(0, 140));

function recover() {
  if (!existsSync(journal)) return log("No journal: nothing to recover.");
  const entry = JSON.parse(readFileSync(journal, "utf8"));
  const path = join(root, entry.file);
  const current = readFileSync(path, "utf8");
  if (sha(current) === entry.original) log(`${entry.file} is already the original.`);
  else if (sha(current) === entry.mutated) {
    writeFileSync(path, entry.content);
    log(`Restored ${entry.file}.`);
  } else throw new Error(`${entry.file} matches neither the original nor the recorded mutation: not overwritten.`);
  rmSync(journal);
}

function apply(mutation) {
  const path = join(root, mutation.file);
  const original = readFileSync(path, "utf8");
  if (original.split(mutation.from).length !== 2) throw new Error(`"${mutation.name}": the text to change isn't in ${mutation.file} exactly once.`);
  const mutated = original.replace(mutation.from, () => mutation.to);
  mkdirSync(dirname(journal), { recursive: true });
  writeFileSync(journal, JSON.stringify({ file: mutation.file, original: sha(original), mutated: sha(mutated), content: original }), { mode: 0o600 });
  writeFileSync(path, mutated);
  return () => {
    writeFileSync(path, original);
    if (sha(readFileSync(path, "utf8")) !== sha(original)) throw new Error(`${mutation.file} wasn't restored.`);
    rmSync(journal);
  };
}

function baseline(label, scripts) {
  const b = build();
  if (!b.ok) throw new Error(`${label} baseline: the build failed.`);
  for (const script of scripts) {
    const s = suite(script);
    if (!s.ok) throw new Error(`${label} baseline: ${script} failed: ${failures(s.output).join("; ")}`);
    log(`${label} baseline clean (build ${b.seconds}s, ${script} ${s.seconds}s: ${/(\d+) passed/.exec(s.output)?.[1]} passed)`);
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  if (process.argv.includes("--recover")) {
    recover();
    process.exit(0);
  }
  if (process.env.MGD_STACK !== "test") throw new Error("Run against the test stack: MGD_STACK=test.");
  if (existsSync(journal)) throw new Error("A journal from an interrupted run exists. Run --recover first.");
  const only = argument("--only")?.split(",");
  // --set m11a2 or m11a3 (M11a-3): one milestone's mutations, so earlier campaigns aren't rerun.
  const set = argument("--set");
  const inSet = set ? mutations.filter((m) => m.set === set) : mutations;
  if (set && inSet.length === 0) throw new Error(`No mutations in set "${set}".`);
  const selected = only ? inSet.filter((m) => only.includes(m.name)) : inSet;
  const scripts = [...new Set(selected.map((m) => m.suite))];
  const fingerprints = Object.fromEntries([...new Set(mutations.map((m) => m.file))].map((file) => [file, sha(readFileSync(join(root, file), "utf8"))]));
  const results = [];
  const started = Date.now();
  baseline("Opening", scripts);
  for (const [index, mutation] of selected.entries()) {
    log(`start [${index + 1}/${selected.length}] ${mutation.name}`);
    const restore = apply(mutation);
    let outcome;
    try {
      const b = build();
      if (!b.ok) outcome = { result: "not built", detail: "the mutation didn't compile" };
      else {
        const s = suite(mutation.suite);
        outcome = s.ok ? { result: "SURVIVED", detail: `${mutation.suite} passed` } : { result: "detected", detail: failures(s.output).join("; ") };
      }
    } finally {
      restore();
    }
    results.push({ name: mutation.name, ...outcome });
    log(`${outcome.result === "detected" ? "ok  " : "FAIL"} [${index + 1}/${selected.length}] ${mutation.name}: ${outcome.detail}`);
  }
  for (const [file, fingerprint] of Object.entries(fingerprints)) if (sha(readFileSync(join(root, file), "utf8")) !== fingerprint) throw new Error(`${file} differs from before the run.`);
  baseline("Closing", scripts);
  const detected = results.filter((r) => r.result === "detected").length;
  log(`\n${detected} of ${selected.length} violations detected, in ${((Date.now() - started) / 60000).toFixed(1)} min${only ? " (a partial run)" : ""}.`);
  process.exit(detected === selected.length && !only ? 0 : 1);
}
