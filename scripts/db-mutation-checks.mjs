/**
 * Proves the tests detect real violations. For each entry in security-mutations.mjs,
 * this applies the violation to the local stack, runs the tests, records the result
 * and resets the database.
 *
 *   node scripts/db-mutation-checks.mjs [--suite m2|m3|m4|m4b|m5a|m5b|m5c|m6|m7a|m7b1|m7b2a|m7b2b|all] [--out results.json] [--log run.log] [--artifacts dir] [--only name|#N,...]
 *   node scripts/db-mutation-checks.mjs --recover
 *   node scripts/db-mutation-checks.mjs --self-test offline|database|all
 *
 * About two minutes per violation. Local only. Progress goes to the terminal and,
 * unbuffered, to the log file. Don't pipe the output through a filter: that can
 * buffer it until exit.
 *
 * With --artifacts, the full pgTAP and API output of each violation that fails or
 * survives is saved there, one file each; the output of violations detected as
 * expected is discarded. scripts/mutation-campaign.mjs runs several suites this way.
 *
 * Every selected violation gets a result. The run exits non-zero if a violation can't
 * be applied, doesn't change what it targets, isn't detected, passes a suite expected
 * to fail, exceeds its time limit, isn't fully restored afterwards, or if a subprocess
 * exits abnormally. A run with --only never counts as complete.
 *
 * Source files are only ever changed through a recovery journal, kept outside the
 * repository. After an interrupted run, a file is restored only if it still matches the
 * exact mutation recorded. Anything else is a conflict: the run stops, and nothing is
 * overwritten.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { suites } from "./security-mutations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];

/** No single subprocess may take longer than this. */
const SUBPROCESS_TIMEOUT_MS = 4 * 60 * 1000;
/** Applying, testing and resetting one violation must finish within this. */
const VIOLATION_TIMEOUT_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

/** Outside the repository, and readable only by the current user. */
const DEFAULT_RECOVERY_DIR = join(homedir(), ".my-game-dex", "mutation-recovery", projectId);

const argument = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};
const pause = (ms) => new Promise((resolveTimer) => setTimeout(resolveTimer, ms));
const clock = () => new Date().toTimeString().slice(0, 8);
const minutes = (ms) => `${(ms / 60000).toFixed(1)} min`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

let logFile = null;
/** Written synchronously, so progress is visible even if the terminal output is buffered. */
function log(line) {
  const text = `${clock()} ${line}`;
  console.log(text);
  if (logFile) appendFileSync(logFile, `${text}\n`);
}

// ---------------------------------------------------------------------------
// Recovery journal
// ---------------------------------------------------------------------------

class RecoveryConflict extends Error {}

/** Writes a file and flushes it to disk, so a journal survives a crash. */
function writeDurable(path, content) {
  const descriptor = openSync(path, "w", 0o600);
  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

function ensureRecoveryDir(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const inside = relative(root, directory);
  if (!inside.startsWith("..") && !resolve(directory).startsWith("\\\\")) {
    throw new Error("the recovery directory must be outside the repository");
  }
  return directory;
}

const journalPath = (directory) => join(directory, "journal.json");
const backupPath = (directory) => join(directory, "original.bak");
const lockPath = (directory) => join(directory, "run.lock");

/**
 * Applies a source mutation through the journal. The backup and the journal entry are
 * on disk before the file is touched, so an interruption at any point is recoverable.
 */
function applyCodeMutation(directory, mutation) {
  if (existsSync(journalPath(directory))) throw new RecoveryConflict("a journal entry already exists; run --recover first");
  const file = resolve(root, mutation.code.file);
  const original = readFileSync(file, "utf8");
  // Patterns are written with \n. A Windows checkout may use \r\n, so follow the file.
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const from = mutation.code.from.replace(/\n/g, eol);
  if (!original.includes(from)) throw new Error("code pattern missing");
  const mutated = original.replace(from, mutation.code.to.replace(/\n/g, eol));
  if (mutated === original) throw new Error("the mutation doesn't change the file");

  writeDurable(backupPath(directory), original);
  writeDurable(journalPath(directory), JSON.stringify({
    pid: process.pid,
    started: new Date().toISOString(),
    mutation: mutation.name,
    file,
    originalSha256: sha256(original),
    mutatedSha256: sha256(mutated),
  }));
  writeFileSync(file, mutated);
  if (sha256(readFileSync(file, "utf8")) !== sha256(mutated)) throw new Error("the mutated file didn't write correctly");
  return { file, originalSha256: sha256(original), mutatedSha256: sha256(mutated) };
}

/**
 * Restores from the journal, if there is one. Returns what it did. Throws a
 * RecoveryConflict, without changing anything, when the file matches neither recorded
 * state, which means someone edited it.
 */
function recoverFromJournal(directory) {
  const path = journalPath(directory);
  if (!existsSync(path)) return { action: "none" };
  const entry = JSON.parse(readFileSync(path, "utf8"));
  if (!existsSync(backupPath(directory))) throw new RecoveryConflict(`journal for ${entry.file} has no backup`);
  const backup = readFileSync(backupPath(directory), "utf8");
  if (sha256(backup) !== entry.originalSha256) throw new RecoveryConflict(`backup for ${entry.file} doesn't match the journal`);

  const current = existsSync(entry.file) ? sha256(readFileSync(entry.file, "utf8")) : null;
  if (current === entry.mutatedSha256) {
    writeFileSync(entry.file, backup);
    if (sha256(readFileSync(entry.file, "utf8")) !== entry.originalSha256) throw new RecoveryConflict(`restoring ${entry.file} didn't produce the original`);
    rmSync(backupPath(directory));
    rmSync(path);
    return { action: "restored", file: entry.file, mutation: entry.mutation };
  }
  if (current === entry.originalSha256) {
    rmSync(backupPath(directory));
    rmSync(path);
    return { action: "already original", file: entry.file, mutation: entry.mutation };
  }
  throw new RecoveryConflict(`${relative(root, entry.file) || entry.file} matches neither its original nor the recorded mutation "${entry.mutation}". It may hold legitimate edits, so nothing was changed. The original is kept in ${backupPath(directory)}.`);
}

/** One run at a time per recovery directory. */
function acquireRunLock(directory) {
  const path = lockPath(directory);
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8"));
    if (pid && pid !== process.pid && isAlive(pid)) throw new RecoveryConflict(`another mutation run is active (process ${pid})`);
  }
  writeDurable(path, String(process.pid));
  return () => {
    if (existsSync(path) && Number(readFileSync(path, "utf8")) === process.pid) rmSync(path);
  };
}

// ---------------------------------------------------------------------------
// Subprocesses
// ---------------------------------------------------------------------------

/** Ends a process and everything it started. */
function killTree(pid) {
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Runs a node subprocess with a hard limit and a heartbeat. Never waits forever. */
function runProcess(label, args, timeout = SUBPROCESS_TIMEOUT_MS) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    let timedOut = false;
    const heartbeat = setInterval(() => log(`      still running: ${label}, ${minutes(Date.now() - started)}`), HEARTBEAT_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeout);
    const finish = (status, signal, error) => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      const abnormal = error ? `could not start: ${error.code ?? error.message}` : timedOut ? `timed out after ${minutes(timeout)}` : signal ? `ended by ${signal}` : status === null ? "no exit status" : null;
      resolveRun({ status, text, abnormal, elapsed: Date.now() - started, pid: child.pid });
    };
    child.on("close", (status, signal) => finish(status, signal));
    child.on("error", (error) => finish(null, null, error));
  });
}

function psql(statement, role = "postgres", timeout = 60000) {
  return execFileSync("docker", ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", role, "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout }).trim();
}

/** Records what the database was doing when something took too long. */
function lockSnapshot() {
  try {
    const rows = psql(`select pid || ' ' || coalesce(wait_event_type, '-') || '/' || coalesce(wait_event, '-') || ' blocked_by=' || pg_blocking_pids(pid)::text || ' age=' || coalesce((now() - xact_start)::text, '-') || ' ' || left(regexp_replace(query, '\\s+', ' ', 'g'), 100)
      from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid() and state <> 'idle';`, "postgres", 15000);
    log(`      database activity:${rows ? `\n${rows.split("\n").map((row) => `        ${row}`).join("\n")}` : " none"}`);
  } catch (error) {
    log(`      database activity unavailable: ${String(error.message).split("\n")[0]}`);
  }
}

// ---------------------------------------------------------------------------
// Database state
// ---------------------------------------------------------------------------

/**
 * A deterministic fingerprint of the security-relevant configuration: RLS, grants,
 * default privileges, policies, functions, triggers, constraints, indexes, enum values
 * and Storage buckets. It's an extra check on top of resets and the tests, never a
 * replacement for them. Object names only, never OIDs, so it's stable across resets.
 */
const FINGERPRINT_SQL = String.raw`
with parts(item) as (
  select 'schema ' || n.nspname || ' ' || coalesce((select string_agg(a::text, ',' order by a::text collate "C") from unnest(n.nspacl) a), '-')
  from pg_namespace n where n.nspname in ('public', 'private', 'storage', 'auth', 'extensions', 'catalog_import')
  union all
  select 'relation ' || n.nspname || '.' || c.relname || ' ' || c.relkind::text || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
    || ' owner=' || pg_get_userbyid(c.relowner) || ' acl=' || coalesce((select string_agg(a::text, ',' order by a::text collate "C") from unnest(c.relacl) a), '-')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  union all
  select 'column ' || n.nspname || '.' || c.relname || '.' || a.attname || ' ' || (select string_agg(x::text, ',' order by x::text collate "C") from unnest(a.attacl) x)
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and a.attacl is not null and not a.attisdropped
  union all
  select 'policy ' || schemaname || '.' || tablename || '.' || policyname || ' ' || permissive || ' ' || array_to_string(roles, ',') || ' ' || cmd || ' using=' || coalesce(qual, '-') || ' check=' || coalesce(with_check, '-')
  from pg_policies where schemaname in ('public', 'private', 'storage')
  union all
  select 'function ' || p.oid::regprocedure::text || ' definer=' || p.prosecdef || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-') || ' owner=' || pg_get_userbyid(p.proowner)
    || ' volatility=' || p.provolatile::text || ' body=' || md5(p.prosrc)
    || ' acl=' || coalesce((select string_agg(a::text, ',' order by a::text collate "C") from unnest(p.proacl) a), '-')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private', 'catalog_import')
  union all
  select 'trigger ' || n.nspname || '.' || c.relname || '.' || t.tgname || ' enabled=' || t.tgenabled::text || ' ' || md5(pg_get_triggerdef(t.oid))
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and n.nspname in ('public', 'private', 'auth', 'storage')
  union all
  select 'constraint ' || n.nspname || '.' || c.relname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid)
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private')
  union all
  select 'index ' || schemaname || '.' || indexname || ' ' || indexdef from pg_indexes where schemaname in ('public', 'private')
  union all
  select 'enum ' || t.typname || ' ' || (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)
  from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype = 'e'
  union all
  select 'default-acl ' || pg_get_userbyid(d.defaclrole) || ' ' || coalesce(n.nspname, '*') || ' ' || d.defaclobjtype::text || ' ' || coalesce((select string_agg(a::text, ',' order by a::text collate "C") from unnest(d.defaclacl) a), '-')
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  union all
  select 'bucket ' || b.id || ' public=' || b.public || ' size=' || coalesce(b.file_size_limit::text, '-') || ' types=' || coalesce(array_to_string(b.allowed_mime_types, ','), '-') from storage.buckets b
  union all
  select 'extension ' || extname || ' ' || extversion from pg_extension
  union all
  -- The importer role (M5b). Its login is set per environment, so it isn't part of this.
  select 'role ' || r.rolname || ' super=' || r.rolsuper || ' inherit=' || r.rolinherit || ' createrole=' || r.rolcreaterole || ' createdb=' || r.rolcreatedb
    || ' bypassrls=' || r.rolbypassrls || ' replication=' || r.rolreplication || ' limit=' || r.rolconnlimit || ' config=' || coalesce(array_to_string(r.rolconfig, ','), '-')
    || ' member_of=' || coalesce((select string_agg(pg_get_userbyid(m.roleid), ',' order by pg_get_userbyid(m.roleid)) from pg_auth_members m where m.member = r.oid), '-')
  from pg_roles r where r.rolname = 'catalog_importer'
)
select md5(string_agg(item, E'\n' order by item collate "C")) || ' ' || count(*) from parts;`;

const fingerprint = () => psql(FINGERPRINT_SQL);

/** Test data that must be gone after a clean run of the checks, and after every reset. */
const LEFTOVER_SQL = `
select concat_ws(' ',
  nullif('auth_users=' || (select count(*) from auth.users), 'auth_users=0'),
  nullif('profiles=' || (select count(*) from public.profiles), 'profiles=0'),
  nullif('preferences=' || (select count(*) from public.user_preferences), 'preferences=0'),
  nullif('staff_roles=' || (select count(*) from public.staff_roles), 'staff_roles=0'),
  nullif('follows=' || (select count(*) from public.follows), 'follows=0'),
  nullif('blocks=' || (select count(*) from public.blocked_users), 'blocks=0'),
  nullif('audit_events=' || (select count(*) from private.audit_events), 'audit_events=0'),
  nullif('notifications=' || (select count(*) from public.notifications), 'notifications=0'),
  nullif('games=' || (select count(*) from public.games), 'games=0'),
  nullif('releases=' || (select count(*) from public.releases), 'releases=0'),
  nullif('aliases=' || (select count(*) from public.game_aliases), 'aliases=0'),
  nullif('collection_items=' || (select count(*) from public.collection_items), 'collection_items=0'),
  nullif('collection_private=' || (select count(*) from public.collection_item_private), 'collection_private=0'),
  nullif('change_requests=' || (select count(*) from public.catalog_change_requests), 'change_requests=0'),
  nullif('provider_records=' || (select count(*) from private.provider_records), 'provider_records=0'),
  nullif('import_runs=' || (select count(*) from private.import_runs), 'import_runs=0'),
  nullif('importer_login=' || (select rolcanlogin from pg_roles where rolname = 'catalog_importer'), 'importer_login=false'),
  nullif('released_holds=' || (select count(*) from private.handle_holds where kind = 'released'), 'released_holds=0'),
  nullif('reserved_holds=' || (select count(*) from private.handle_holds where kind = 'reserved'), 'reserved_holds=44'),
  nullif('storage_objects=' || (select count(*) from storage.objects), 'storage_objects=0'),
  nullif('auth_sessions=' || (select count(*) from auth.sessions), 'auth_sessions=0'),
  nullif('temporary_objects=' || (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relname like '\\_\\_%'), 'temporary_objects=0'),
  nullif('temporary_functions=' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.proname like '\\_\\_%'), 'temporary_functions=0')
);`;

const leftovers = () => psql(LEFTOVER_SQL);

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

/** Names of failed assertions in pg_prove output, for showing what detected a violation. */
function failedPgtapAssertions(text) {
  const names = [];
  for (const match of text.matchAll(/^#\s+Failed test (?:\d+:\s*)?["']?(.*?)["']?\s*$/gm)) names.push(match[1]);
  for (const match of text.matchAll(/^not ok \d+ - (.*)$/gm)) names.push(match[1]);
  return [...new Set(names)];
}

/** Parses a suite's outcome. A result it can't interpret is abnormal, never a pass. */
/**
 * The raw output of the latest pgTAP and API runs, saved with --artifacts for a
 * violation that fails or survives, and otherwise discarded.
 */
const lastRaw = { pgtap: "", api: "" };

/**
 * Saves what's needed to analyse a violation that failed or survived: what was
 * applied, its problems, and the raw test output. Writes nothing for a violation
 * detected as expected. Returns the file, or null.
 */
function writeArtifact(folder, suiteName, index, mutation, result, raw) {
  if (!folder || !result.problems.length) return null;
  const file = join(folder, `${suiteName}-${String(index + 1).padStart(2, "0")}-${mutation.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.txt`);
  writeFileSync(file, [`Violation: ${mutation.name}`, `Suite: ${suiteName}`, `Expected to fail: ${mutation.expect}`, `Problems: ${result.problems.join("; ")}`,
    "", "----- applied -----", mutation.sql ?? JSON.stringify(mutation.code, null, 1), "", "----- pgTAP -----", raw.pgtap, "", "----- API checks -----", raw.api].join("\n"));
  return file;
}

async function runPgtap(timeout) {
  const run = await runProcess("pgTAP", [cli, "test", "db"], timeout);
  lastRaw.pgtap = run.text;
  if (run.abnormal) return { abnormal: `pgTAP ${run.abnormal}`, elapsed: run.elapsed };
  if (!/^Files=\d+, Tests=\d+/m.test(run.text)) return { abnormal: `pgTAP produced no summary (exit ${run.status})`, elapsed: run.elapsed };
  const failedFiles = [...run.text.matchAll(/(\d\d_\w+)\.test\.sql\s+\(Wstat[^\n]*Failed: (\d+)\)/g)].map((match) => `${match[1]}:${match[2]}`);
  const passedLine = /^Result: PASS/m.test(run.text);
  if (passedLine !== (run.status === 0) || passedLine === failedFiles.length > 0) return { abnormal: `pgTAP result disagrees with its exit code (${run.status})`, elapsed: run.elapsed };
  return { failed: !passedLine, detail: failedFiles, assertions: failedPgtapAssertions(run.text), elapsed: run.elapsed };
}

async function runApi(timeout) {
  const failures = [];
  let failedCount = 0;
  let elapsed = 0;
  const stages = {};
  lastRaw.api = "";
  for (const script of ["scripts/db-identity-checks.mjs", "scripts/db-authorization-checks.mjs", "scripts/db-audit-checks.mjs", "scripts/db-notification-checks.mjs", "scripts/db-catalog-checks.mjs", "scripts/db-import-checks.mjs", "scripts/db-search-checks.mjs", "scripts/db-collection-checks.mjs", "scripts/db-submission-checks.mjs", "scripts/db-review-checks.mjs", "scripts/db-relink-checks.mjs", "scripts/db-exclusion-checks.mjs"]) {
    const run = await runProcess(script, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script], timeout);
    elapsed += run.elapsed;
    stages[script] = run.elapsed;
    lastRaw.api += `\n===== ${script} (exit ${run.status}) =====\n${run.text}`;
    if (run.abnormal) return { abnormal: `${script} ${run.abnormal}`, elapsed, stages };
    const summary = /^(\d+) passed, (\d+) failed$/m.exec(run.text);
    if (!summary) return { abnormal: `${script} produced no summary (exit ${run.status})`, elapsed, stages };
    failures.push(...(run.text.match(/^FAIL [^\n]*/gm) ?? []).map((line) => line.slice(5, 120)));
    failedCount += Number(summary[2]);
    if (Number(summary[2]) > 0 !== (run.status !== 0)) return { abnormal: `${script} disagrees with its exit code (${run.status})`, elapsed, stages };
  }
  return { failed: failedCount > 0, detail: failures, count: failedCount, elapsed, stages };
}

async function resetDatabase() {
  const run = await runProcess("database reset", [cli, "db", "reset"]);
  if (run.abnormal || run.status !== 0) {
    lockSnapshot();
    throw new Error(`database reset failed: ${run.abnormal ?? `exit ${run.status}`}`);
  }
  await pause(4000);
  return run.elapsed;
}

// ---------------------------------------------------------------------------
// One violation
// ---------------------------------------------------------------------------

/**
 * Runs one violation within its time limit, and returns the reasons it failed the run.
 * `context` supplies the recovery directory, the clean fingerprint and, for self-tests,
 * replacement suite runners.
 */
async function runMutation(mutation, context) {
  const { directory, cleanFingerprint, timeout = SUBPROCESS_TIMEOUT_MS, deadline = Date.now() + VIOLATION_TIMEOUT_MS, runners = { pgtap: runPgtap, api: runApi }, checkDatabase = true } = context;
  const problems = [];
  const outcome = { name: mutation.name, expect: mutation.expect };
  const remaining = () => Math.max(1, Math.min(timeout, deadline - Date.now()));
  let applied = null;
  try {
    try {
      if (mutation.sql) {
        psql(`${mutation.sql}\nnotify pgrst, 'reload schema';`, mutation.role);
        if (fingerprint() === cleanFingerprint) problems.push("applied, but changed nothing in the security configuration");
      } else {
        applied = applyCodeMutation(directory, mutation);
        if (checkDatabase && fingerprint() !== cleanFingerprint) problems.push("a source mutation changed the database");
      }
    } catch (error) {
      if (error instanceof RecoveryConflict) throw error;
      problems.push(`could not be applied: ${String(error.stderr || error.message).split("\n")[0].slice(0, 160)}`);
      return { ...outcome, problems };
    }
    await pause(1500);

    const pgtap = await runners.pgtap(remaining());
    const api = Date.now() < deadline ? await runners.api(remaining()) : { abnormal: `API checks not started: the violation's ${minutes(VIOLATION_TIMEOUT_MS)} limit was reached` };
    for (const result of [pgtap, api]) if (result.abnormal) problems.push(result.abnormal);
    if (checkDatabase && problems.some((problem) => /timed out|limit was reached/.test(problem))) lockSnapshot();
    outcome.pgtapFiles = pgtap.detail ?? [];
    outcome.pgtapAssertions = pgtap.assertions ?? [];
    outcome.apiFailures = api.detail ?? [];
    outcome.timings = { pgtap: pgtap.elapsed ?? 0, ...(api.stages ?? {}) };

    if (!pgtap.abnormal && !api.abnormal) {
      if (!pgtap.failed && !api.failed) problems.push("not detected by any test");
      if (["pgtap", "both"].includes(mutation.expect) && !pgtap.failed) problems.push("pgTAP unexpectedly passed");
      if (["api", "both"].includes(mutation.expect) && !api.failed) problems.push("API checks unexpectedly passed");
      if (pgtap.failed && !api.failed && !outcome.pgtapAssertions.length) problems.push("pgTAP failed without naming a failed assertion");
      if (api.failed && !pgtap.failed && outcome.apiFailures.every((failure) => /stopped early/.test(failure))) problems.push("API checks only crashed, without a failed assertion");
    }
    return { ...outcome, problems };
  } finally {
    if (applied) {
      const recovered = recoverFromJournal(directory);
      if (recovered.action !== "restored") throw new RecoveryConflict(`after ${mutation.name}, recovery reported "${recovered.action}" instead of restoring`);
      if (sha256(readFileSync(applied.file, "utf8")) !== applied.originalSha256) throw new RecoveryConflict(`${applied.file} wasn't restored to its original content`);
    }
  }
}

/** Resets, then proves the database is back to the clean configuration with no test data. */
async function resetAndVerify(cleanFingerprint, label) {
  const elapsed = await resetDatabase();
  const problems = [];
  const current = fingerprint();
  if (current !== cleanFingerprint) problems.push(`configuration differs from the clean state (${current} instead of ${cleanFingerprint})`);
  const left = leftovers();
  if (left) problems.push(`data left behind: ${left}`);
  if (problems.length) throw new Error(`${label}: reset didn't restore a clean state: ${problems.join("; ")}`);
  return elapsed;
}

async function assertBaseline(label) {
  const pgtap = await runPgtap();
  const api = await runApi();
  const reasons = [pgtap.abnormal, api.abnormal, pgtap.failed && "pgTAP failed", api.failed && "API checks failed"].filter(Boolean);
  // With nothing broken, the checks must clean up after themselves.
  const left = leftovers();
  if (left) reasons.push(`the checks left data behind: ${left}`);
  if (reasons.length) throw new Error(`${label} baseline isn't clean: ${reasons.join("; ")}`);
  log(`${label} baseline clean (pgTAP ${(pgtap.elapsed / 1000).toFixed(0)}s, identity ${(api.stages["scripts/db-identity-checks.mjs"] / 1000).toFixed(0)}s, authorization ${(api.stages["scripts/db-authorization-checks.mjs"] / 1000).toFixed(0)}s, no data left behind)`);
  return { pgtap: pgtap.elapsed, ...api.stages };
}

// ---------------------------------------------------------------------------
// Self-tests
// ---------------------------------------------------------------------------

/** Used by the interrupted-run self-test: applies a mutation, then waits to be killed. */
async function selfTestChild(directory, file) {
  applyCodeMutation(directory, { name: "self-test: interrupted", code: { file, from: "ORIGINAL", to: "MUTATED" } });
  writeFileSync(join(directory, "child-ready"), String(process.pid));
  await pause(60000);
}

async function offlineSelfTests() {
  const results = [];
  const record = (label, ok, detail = "") => {
    results.push(ok);
    log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `: ${detail}` : ""}`);
  };
  const workspace = mkdtempSync(join(tmpdir(), "mutation-selftest-"));
  const directory = ensureRecoveryDir(join(workspace, "recovery"));
  const target = join(workspace, "target.txt");
  const original = "line one\nORIGINAL\nline three\n";
  const reset = () => {
    writeFileSync(target, original);
    for (const name of readdirSync(directory)) rmSync(join(directory, name));
  };
  const codeMutation = { name: "self-test: code", expect: "api", code: { file: target, from: "ORIGINAL", to: "MUTATED" } };
  const fake = (result) => async () => result;
  const failing = { failed: true, detail: ["x"], assertions: ["x"], elapsed: 1 };
  const passing = { failed: false, detail: [], assertions: [], elapsed: 1 };

  try {
    // Process-tree cleanup: a subprocess that starts its own child, then runs past its limit.
    const pidFile = join(workspace, "grandchild.pid");
    const tree = await runProcess("self-test tree", ["-e", `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `], 2000);
    await pause(1500);
    const grandchild = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
    record("a subprocess over its limit is reported as timed out", /timed out/.test(tree.abnormal ?? ""), tree.abnormal);
    record("the subprocess itself is ended", !isAlive(tree.pid));
    record("and so is the child it started", grandchild !== null && !isAlive(grandchild), String(grandchild));

    // Restoration after a failure, an undetected result, an exception and a timeout.
    reset();
    let outcome = await runMutation(codeMutation, { directory, checkDatabase: false, runners: { pgtap: fake(passing), api: fake(failing) } });
    record("a detected source mutation restores the file", readFileSync(target, "utf8") === original && outcome.problems.length === 0, outcome.problems.join("; "));
    record("and leaves no journal or backup", readdirSync(directory).length === 0, readdirSync(directory).join(","));

    reset();
    outcome = await runMutation(codeMutation, { directory, checkDatabase: false, runners: { pgtap: fake(passing), api: fake(passing) } });
    record("an undetected mutation is reported, and the file restored", outcome.problems.includes("not detected by any test") && readFileSync(target, "utf8") === original);

    // Diagnostics: kept for a violation that survives, never for one detected as expected.
    const artifactsDir = join(workspace, "artifacts");
    mkdirSync(artifactsDir);
    const raw = { pgtap: "not ok 7 - SELF-TEST PGTAP OUTPUT", api: "===== SELF-TEST API OUTPUT =====" };
    const saved = writeArtifact(artifactsDir, "selftest", 2, codeMutation, outcome, raw);
    const savedText = saved && existsSync(saved) ? readFileSync(saved, "utf8") : "";
    record("a surviving violation's output is saved", savedText.includes("Violation: self-test: code") && savedText.includes("not detected by any test")
      && savedText.includes("SELF-TEST PGTAP OUTPUT") && savedText.includes("SELF-TEST API OUTPUT") && savedText.includes("ORIGINAL"), saved ?? "no file");
    reset();
    const detected = await runMutation(codeMutation, { directory, checkDatabase: false, runners: { pgtap: fake(passing), api: fake(failing) } });
    record("a detected violation's output is discarded", writeArtifact(artifactsDir, "selftest", 3, codeMutation, detected, raw) === null && readdirSync(artifactsDir).length === 1);
    record("and with no folder, nothing is written", writeArtifact(null, "selftest", 4, codeMutation, outcome, raw) === null);

    reset();
    let threw = false;
    try {
      await runMutation(codeMutation, { directory, checkDatabase: false, runners: { pgtap: async () => { throw new Error("suite crashed"); }, api: fake(failing) } });
    } catch {
      threw = true;
    }
    record("a crash during testing still restores the file", threw && readFileSync(target, "utf8") === original && readdirSync(directory).length === 0);

    reset();
    const slow = async (limit) => {
      const run = await runProcess("self-test slow suite", ["-e", "setInterval(() => {}, 1000)"], limit);
      return { abnormal: run.abnormal, elapsed: run.elapsed };
    };
    outcome = await runMutation(codeMutation, { directory, checkDatabase: false, timeout: 500, runners: { pgtap: slow, api: fake(failing) } });
    record("a timeout during testing is reported", outcome.problems.some((problem) => /timed out/.test(problem)), outcome.problems.join("; "));
    record("and the file is restored after it", readFileSync(target, "utf8") === original && readdirSync(directory).length === 0);

    reset();
    outcome = await runMutation(codeMutation, { directory, checkDatabase: false, deadline: Date.now() - 1, runners: { pgtap: fake(passing), api: fake(failing) } });
    record("a violation over its overall limit is reported", outcome.problems.some((problem) => /limit was reached/.test(problem)), outcome.problems.join("; "));
    record("and the file is restored after it", readFileSync(target, "utf8") === original);

    reset();
    outcome = await runMutation({ ...codeMutation, code: { file: target, from: "NOT PRESENT", to: "x" } }, { directory, checkDatabase: false, runners: { pgtap: fake(failing), api: fake(failing) } });
    record("a missing pattern is reported and changes nothing", outcome.problems.some((problem) => /could not be applied/.test(problem)) && readFileSync(target, "utf8") === original && readdirSync(directory).length === 0);

    reset();
    outcome = await runMutation({ ...codeMutation, code: { file: target, from: "ORIGINAL", to: "ORIGINAL" } }, { directory, checkDatabase: false, runners: { pgtap: fake(failing), api: fake(failing) } });
    record("a mutation that changes nothing is refused", outcome.problems.some((problem) => /doesn't change the file/.test(problem)));

    reset();
    outcome = await runMutation(codeMutation, { directory, checkDatabase: false, runners: { pgtap: fake(passing), api: fake({ failed: true, detail: ["identity checks stopped early: boom"], count: 1, elapsed: 1 }) } });
    record("a crash alone doesn't count as detection", outcome.problems.some((problem) => /only crashed/.test(problem)), outcome.problems.join("; "));

    // A real interruption: a separate process applies a mutation and is killed.
    const interrupt = async () => {
      reset();
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--self-test-child", directory, target], { cwd: root, stdio: "ignore", detached: process.platform !== "win32" });
      for (let attempt = 0; attempt < 100 && !existsSync(join(directory, "child-ready")); attempt += 1) await pause(100);
      killTree(child.pid);
      await pause(500);
      rmSync(join(directory, "child-ready"), { force: true });
      return !isAlive(child.pid);
    };

    record("setup: an interrupted run leaves a mutated file", (await interrupt()) && readFileSync(target, "utf8").includes("MUTATED") && existsSync(journalPath(directory)));
    let recovered = recoverFromJournal(directory);
    record("recovery restores a file that still matches the recorded mutation", recovered.action === "restored" && readFileSync(target, "utf8") === original);
    record("and removes the journal and backup", readdirSync(directory).length === 0);

    await interrupt();
    writeFileSync(target, original);
    recovered = recoverFromJournal(directory);
    record("a file already back to its original only clears the journal", recovered.action === "already original" && readFileSync(target, "utf8") === original && readdirSync(directory).length === 0);

    await interrupt();
    const legitimate = "line one\nMUTATED\nline three\nsomeone's legitimate edit\n";
    writeFileSync(target, legitimate);
    let conflict = null;
    try {
      recoverFromJournal(directory);
    } catch (error) {
      conflict = error;
    }
    record("a file edited after the interruption is a recovery conflict", conflict instanceof RecoveryConflict, conflict?.message);
    record("and the edit is never overwritten", readFileSync(target, "utf8") === legitimate);
    record("and the journal and backup are kept", existsSync(journalPath(directory)) && readFileSync(backupPath(directory), "utf8") === original);
    conflict = null;
    try {
      applyCodeMutation(directory, codeMutation);
    } catch (error) {
      conflict = error;
    }
    record("and no new mutation starts while it's unresolved", conflict instanceof RecoveryConflict && readFileSync(target, "utf8") === legitimate);

    reset();
    writeFileSync(join(directory, "journal.json"), JSON.stringify({ file: target, mutation: "x", originalSha256: sha256("something else"), mutatedSha256: sha256("y") }));
    writeFileSync(backupPath(directory), original);
    conflict = null;
    try {
      recoverFromJournal(directory);
    } catch (error) {
      conflict = error;
    }
    record("a backup that doesn't match its journal is a conflict, not a restore", conflict instanceof RecoveryConflict && readFileSync(target, "utf8") === original);

    reset();
    record("with no journal, an uncommitted edit is left alone", recoverFromJournal(directory).action === "none");

    // Location and access
    let refused = false;
    try {
      ensureRecoveryDir(join(root, "supabase", ".mutation-recovery-test"));
    } catch {
      refused = true;
    }
    rmSync(join(root, "supabase", ".mutation-recovery-test"), { recursive: true, force: true });
    record("a recovery directory inside the repository is refused", refused);
    record("the default recovery directory is outside the repository", relative(root, DEFAULT_RECOVERY_DIR).startsWith(".."), DEFAULT_RECOVERY_DIR);
    if (process.platform === "win32") {
      const acl = spawnSync("icacls", [directory], { encoding: "utf8" }).stdout ?? "";
      record("the recovery directory isn't open to Everyone or all Users", !/\\(Everyone|Users):/i.test(acl) && !/BUILTIN\\Users/i.test(acl), acl.split("\n").slice(0, 4).join(" | "));
    } else {
      record("the recovery directory is private to the user", (readdirSync(directory), true));
    }

    // Run lock
    const release = acquireRunLock(directory);
    writeFileSync(lockPath(directory), String(tree.pid));
    record("a stale lock from a dead process doesn't block a run", (() => { try { acquireRunLock(directory)(); return true; } catch { return false; } })());
    const lockedBy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(lockPath(directory), String(lockedBy.pid));
    record("a live run blocks a second run", (() => { try { acquireRunLock(directory); return false; } catch (error) { return error instanceof RecoveryConflict; } })());
    killTree(lockedBy.pid);
    release();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  const failures = results.filter((ok) => !ok).length;
  log(`offline self-tests: ${results.length - failures} of ${results.length} passed`);
  return failures;
}

async function databaseSelfTests(directory) {
  const results = [];
  const record = (label, ok, detail = "") => {
    results.push(ok);
    log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `: ${detail}` : ""}`);
  };
  await resetDatabase();
  const clean = fingerprint();
  record("the fingerprint is deterministic", fingerprint() === clean && fingerprint() === clean);
  await resetDatabase();
  record("and identical after a second reset", fingerprint() === clean);
  record("a reset leaves no test data", leftovers() === "", leftovers());

  const probes = [
    ["RLS", "alter table public.follows disable row level security;"],
    ["a table grant", "grant select on public.follows to authenticated;"],
    ["a column grant", "grant select (allow_search_indexing) on public.profiles to anon;"],
    ["a schema grant", "grant usage on schema private to authenticated;"],
    ["a policy", "create policy __p on public.follows for select to authenticated using (true);"],
    ["a function body", "create or replace function private.page_size(p_limit integer, p_before_at timestamptz, p_before_id uuid) returns integer language plpgsql immutable set search_path = '' as $$ begin return p_limit; end; $$;"],
    ["a function setting", "alter function public.request_follow(uuid) reset search_path;"],
    ["function EXECUTE", "grant execute on function public.get_followers(uuid,integer,timestamptz,uuid) to anon;"],
    ["a trigger being disabled", "alter table public.blocked_users disable trigger remove_follows_on_block;"],
    ["a constraint", "alter table public.follows drop constraint follows_check;"],
    ["an index", "create index __i on public.follows (status);"],
    ["Storage settings", "update storage.buckets set public = false where id = 'avatars';"],
    ["a Storage policy", "create policy __s on storage.objects for select to anon using (true);", "supabase_admin"],
    ["default privileges", "alter default privileges for role postgres in schema public grant select on tables to anon;"],
  ];
  for (const [label, statement, role] of probes) {
    psql(statement, role ?? "postgres");
    record(`the fingerprint detects a change to ${label}`, fingerprint() !== clean);
    await resetDatabase();
  }
  record("after those changes, a reset restores the clean fingerprint", fingerprint() === clean);

  psql(`insert into auth.users (id, aud, role, email, instance_id) values (gen_random_uuid(), 'authenticated', 'authenticated', 'leftover@example.test', '00000000-0000-0000-0000-000000000000');`);
  record("leftover Auth users are detected", /auth_users=1/.test(leftovers()), leftovers());
  await resetDatabase();
  record("and removed by a reset", leftovers() === "");

  // The real suites, on a violation from each kind
  const sqlViolation = suites.m3.find((mutation) => mutation.name === "follows readable by clients");
  let outcome = await runMutation(sqlViolation, { directory, cleanFingerprint: clean });
  record("a real database violation is applied, changes the fingerprint and is detected", outcome.problems.length === 0, outcome.problems.join("; "));
  record("its failed assertions are named", outcome.pgtapAssertions.length > 0 && outcome.apiFailures.length > 0, `${outcome.pgtapAssertions.length}/${outcome.apiFailures.length}`);
  await resetAndVerify(clean, "after the database violation");
  record("and a reset restores the clean state", true);

  const codeViolation = suites.m2.find((mutation) => mutation.name === "code: metadata kept");
  const workflow = resolve(root, codeViolation.code.file);
  const before = sha256(readFileSync(workflow, "utf8"));
  outcome = await runMutation(codeViolation, { directory, cleanFingerprint: clean });
  record("a real source violation is detected without touching the database", outcome.problems.length === 0, outcome.problems.join("; "));
  record("and the source file is byte-for-byte restored", sha256(readFileSync(workflow, "utf8")) === before && !existsSync(journalPath(directory)));
  await resetAndVerify(clean, "after the source violation");

  outcome = await runMutation({ name: "self-test: no-op", expect: "both", sql: "select 1;", role: "postgres" }, { directory, cleanFingerprint: clean });
  record("a violation that changes nothing is reported as not applied", outcome.problems.some((problem) => /changed nothing/.test(problem)), outcome.problems.join("; "));
  await resetAndVerify(clean, "after the no-op");

  const timings = await assertBaseline("Self-test");
  await resetAndVerify(clean, "after the baseline");

  const failures = results.filter((ok) => !ok).length;
  log(`database self-tests: ${results.length - failures} of ${results.length} passed`);
  return { failures, timings };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.argv[2] === "--self-test-child") {
    await selfTestChild(process.argv[3], process.argv[4]);
    return 0;
  }

  const directory = ensureRecoveryDir(argument("--recovery-dir") ?? DEFAULT_RECOVERY_DIR);
  logFile = argument("--log") ?? join(directory, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  writeDurable(logFile, "");
  log(`Log: ${logFile}`);

  const selfTest = argument("--self-test");
  if (selfTest === "offline") return (await offlineSelfTests()) ? 1 : 0;

  const releaseLock = acquireRunLock(directory);
  try {
    const recovered = recoverFromJournal(directory);
    if (recovered.action !== "none") log(`Recovered from an interrupted run: ${recovered.action} ${recovered.file} (${recovered.mutation})`);
    if (process.argv.includes("--recover")) {
      log(recovered.action === "none" ? "Nothing to recover." : "Recovery complete.");
      return 0;
    }

    const status = JSON.parse(execFileSync(process.execPath, [cli, "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(status.API_URL ?? "")) {
      log("Refusing to run: this tool only targets the local stack.");
      return 1;
    }

    if (selfTest === "database" || selfTest === "all") {
      const offline = selfTest === "all" ? await offlineSelfTests() : 0;
      const { failures } = await databaseSelfTests(directory);
      return offline + failures ? 1 : 0;
    }

    const suiteName = argument("--suite") ?? "all";
    const selected = suiteName === "all" ? Object.values(suites).flat() : suites[suiteName];
    if (!selected) {
      log(`Unknown suite: ${suiteName}`);
      return 2;
    }
    if (new Set(selected.map((mutation) => mutation.name)).size !== selected.length) {
      log("Violation names must be unique.");
      return 2;
    }
    const only = argument("--only");
    // A name, or #N for the suite's Nth violation (as numbered in artifact file names),
    // which also selects a violation whose name has a comma in it.
    const byPosition = (name) => (/^#\d+$/.test(name) ? selected[Number(name.slice(1)) - 1]?.name ?? name : name);
    const wanted = only ? only.split(",").map((name) => byPosition(name.trim())) : null;
    const unknown = wanted ? wanted.filter((name) => !selected.some((mutation) => mutation.name === name)) : [];
    if (unknown.length) {
      log(`Unknown violations: ${unknown.join(", ")}`);
      return 2;
    }
    const mutations = wanted ? selected.filter((mutation) => wanted.includes(mutation.name)) : selected;
    if (!mutations.length) {
      log("No violations selected.");
      return 2;
    }

    const artifacts = argument("--artifacts") ?? null;
    if (artifacts) mkdirSync(artifacts, { recursive: true });
    const started = Date.now();
    const results = [];
    log(`Running ${mutations.length} violations from suite ${suiteName}. Limits: ${minutes(VIOLATION_TIMEOUT_MS)} per violation, ${minutes(SUBPROCESS_TIMEOUT_MS)} per subprocess.`);
    await resetDatabase();
    const clean = fingerprint();
    if (fingerprint() !== clean) throw new Error("the fingerprint isn't deterministic");
    const leftover = leftovers();
    if (leftover) throw new Error(`a fresh reset left data behind: ${leftover}`);
    log(`Clean fingerprint: ${clean}`);
    await assertBaseline("Starting");
    await resetAndVerify(clean, "after the starting baseline");

    for (const [index, mutation] of mutations.entries()) {
      const position = `[${index + 1}/${mutations.length}]`;
      const done = results.length;
      const eta = done ? ` ETA ${minutes(((Date.now() - started) / done) * (mutations.length - done))}` : "";
      log(`start ${position} ${mutation.name}${eta}`);
      lastRaw.pgtap = "(not run)";
      lastRaw.api = "(not run)";
      const result = await runMutation(mutation, { directory, cleanFingerprint: clean });
      const saveArtifact = () => {
        const file = writeArtifact(artifacts, suiteName, index, mutation, result, lastRaw);
        if (file) result.artifact = file;
      };
      try {
        result.timings = { ...result.timings, reset: await resetAndVerify(clean, mutation.name) };
      } catch (error) {
        result.problems.push(error.message);
        saveArtifact();
        results.push(result);
        throw error;
      }
      saveArtifact();
      results.push(result);
      const seconds = Object.values(result.timings ?? {}).reduce((sum, value) => sum + value, 0) / 1000;
      log(`${result.problems.length ? "FAIL" : "ok  "} ${position} ${mutation.name} (${seconds.toFixed(0)}s)${result.problems.length ? `: ${result.problems.join("; ")}` : ""}`);
    }
    await assertBaseline("Closing");
    await resetAndVerify(clean, "after the closing baseline");

    const failed = results.filter((result) => result.problems.length);
    const out = argument("--out");
    if (out) writeFileSync(out, JSON.stringify(results, null, 1));
    log("");
    log("Every result:");
    for (const result of results) log(`  ${result.problems.length ? "FAIL" : "ok  "} ${result.name}${result.problems.length ? `: ${result.problems.join("; ")}` : ""}`);
    log("");
    log(`${results.length - failed.length} of ${results.length} violations detected as expected, in one run of ${minutes(Date.now() - started)}.`);
    if (only) log("PARTIAL: run with --only. This isn't a complete result.");
    return failed.length ? 1 : 0;
  } finally {
    releaseLock();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  log(`FAIL mutation run stopped: ${error.message}`);
  process.exitCode = 1;
}
