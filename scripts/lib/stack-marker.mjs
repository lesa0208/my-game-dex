/**
 * The protection marker of a guarded stack (M15 P1a hardening): the pilot
 * (~/.my-game-dex/protect-pilot-stack) and its disposable rehearsal twin
 * (~/.my-game-dex/protect-rehearsal-stack).
 *
 * It says which stack it protects, how far its creation got and which signing key it has:
 *
 *   { "stack": "pilot", "state": "creating" | "created", "kid": "<its own signing key's id>", "at": "…" }
 *
 * "creating" is written before `supabase start` first creates the database volume, so a volume
 * never exists unprotected; "created" once that first start succeeded, so a pilot whose volume
 * later disappears is never silently created again. The kid ties the marker to one pilot's keys:
 * a marker can't protect, or let a tool use, a pilot with other keys. Not a secret.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MARKER_STATES = Object.freeze(["creating", "created"]);

/** The marker's record: null when there is none, { state: "unreadable" } when it can't be parsed. */
export function readMarker(file, exists = existsSync, read = (f) => readFileSync(f, "utf8")) {
  if (!exists(file)) return null;
  try {
    const record = JSON.parse(read(file));
    if (!record || !MARKER_STATES.includes(record.state) || typeof record.stack !== "string") return { state: "unreadable" };
    return record;
  } catch {
    return { state: "unreadable" };
  }
}

export function writeMarker(file, { stack, state, kid }) {
  if (!MARKER_STATES.includes(state)) throw new Error(`Unknown marker state "${state}".`);
  mkdirSync(dirname(file), { recursive: true });
  const note = "Reset and destroy refuse this stack while this file exists, and it is used only while it matches. Removing it is part of a separately authorized recovery (docs/architecture/catalog-pilot-m15.md).";
  writeFileSync(file, `${JSON.stringify({ stack, state, kid: kid ?? null, at: new Date().toISOString(), note }, null, 2)}\n`);
}

/** Why a marker doesn't protect this stack with these keys (empty when it does). Pure, for tests. */
export function markerProblems(marker, { stack, kid, file }) {
  if (!marker) return [`its protection marker (${file}) is missing`];
  if (marker.state === "unreadable") return [`its protection marker (${file}) can't be read`];
  const problems = [];
  if (marker.stack !== stack) problems.push(`its protection marker names the ${marker.stack} stack`);
  if (kid !== undefined && marker.kid !== kid) problems.push("its protection marker belongs to a stack with other signing keys");
  return problems;
}
