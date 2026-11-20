/**
 * The opt-in every mutation run needs (M12c-B1, after checkpoint four).
 *
 * Mutation testing is destructive on purpose:
 *   - the database runner applies security violations and resets the stack it targets
 *     (`supabase db reset`), and edits source files through its recovery journal;
 *   - the app runner edits source files and rebuilds .next.
 *
 * On 2026-11-20 the database runner ran by accident. It was named like an ordinary suite
 * (scripts/db-*-checks.mjs), so a loop over the database suites picked it up, and with
 * no arguments it selected every suite. It stopped before applying anything only because
 * the combined "all" selection failed its own name check.
 *
 * Since then:
 *   - the runners are named mutation-*-runner.mjs, outside the *-checks.mjs pattern;
 *   - a run needs MGD_MUTATION_TESTING=1 and an explicit selection (--suite or --set);
 *   - the database runner targets only the disposable scratch stack, never development,
 *     M12c-A or B1.
 * Recovery (--recover) and the offline self-tests stay available without opt-in: they
 * restore, or touch only their own temporary workspace (the self-test's interrupted child
 * is allowed only on a "mutation-selftest-*" folder under the system temporary directory).
 */

import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export const OPT_IN_VARIABLE = "MGD_MUTATION_TESTING";

/** The only stack the database runner may reset. */
export const MUTATION_DB_STACK = "scratch";

/** A path inside a "mutation-selftest-*" folder directly under the system temporary directory. */
function inSelfTestWorkspace(path) {
  const rel = relative(tmpdir(), resolve(String(path)));
  return !rel.startsWith("..") && !isAbsolute(rel) && /^mutation-selftest-[^\\/]+[\\/]/.test(rel);
}

const flagValue = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

/**
 * Throws unless this invocation is safe or explicitly opted in. Returns the mode it allowed:
 * "recover", "offline" or "run".
 *
 * kind "db":  a run needs the opt-in, `--suite <name>` or `--self-test database|all`, and
 *             MGD_STACK=scratch.
 * kind "app": a run needs the opt-in and `--set <name>`.
 * kind "campaign": a run needs the opt-in and MGD_STACK=scratch; `--dry-run` runs nothing.
 */
export function requireMutationOptIn({ kind, argv = process.argv.slice(2), env = process.env }) {
  if (argv.includes("--recover")) return "recover";
  if (kind === "db" && flagValue(argv, "--self-test") === "offline") return "offline";
  // The offline self-test's interrupted child: allowed only on its own temporary workspace.
  if (kind === "db" && argv[0] === "--self-test-child" && argv.slice(1, 3).length === 2 && argv.slice(1, 3).every(inSelfTestWorkspace)) return "offline";
  if (kind === "campaign" && argv.includes("--dry-run")) return "offline";

  const problems = [];
  if (env[OPT_IN_VARIABLE] !== "1") problems.push(`set ${OPT_IN_VARIABLE}=1 for this one command`);
  if (kind === "db") {
    const suite = flagValue(argv, "--suite");
    const selfTest = flagValue(argv, "--self-test");
    const selfTestChild = argv[0] === "--self-test-child";
    if (!selfTestChild && !(suite && !suite.startsWith("--")) && !["database", "all"].includes(selfTest)) {
      problems.push("name what to run: --suite <name> (or --self-test database|all)");
    }
    if ((env.MGD_STACK ?? "dev") !== MUTATION_DB_STACK) {
      problems.push(`target the disposable scratch stack only: MGD_STACK=${MUTATION_DB_STACK} (not "${env.MGD_STACK ?? "dev"}")`);
    }
  } else if (kind === "app") {
    const set = flagValue(argv, "--set");
    if (!(set && !set.startsWith("--"))) problems.push("name the mutation set: --set <name>");
  } else if (kind === "campaign") {
    if ((env.MGD_STACK ?? "dev") !== MUTATION_DB_STACK) {
      problems.push(`target the disposable scratch stack only: MGD_STACK=${MUTATION_DB_STACK} (not "${env.MGD_STACK ?? "dev"}")`);
    }
  } else {
    throw new Error(`Unknown mutation runner kind: ${kind}`);
  }
  if (problems.length) {
    throw new Error(`Refusing to run destructive mutation testing without an explicit opt-in: ${problems.join("; ")}. Nothing was changed.`);
  }
  return "run";
}
