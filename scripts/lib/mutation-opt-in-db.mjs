// Imported first by the db mutation runner, so the opt-in is checked before any other module
// loads: lib/stack.mjs reads the stack's files when imported, and on a machine without them
// (CI) it would otherwise fail first, with the wrong reason. See lib/mutation-guard.mjs.
import { requireMutationOptIn } from "./mutation-guard.mjs";

requireMutationOptIn({ kind: "db" });
