/**
 * Import monitoring (M10d, D8): filters, labels and messages for the read-only
 * /admin/imports pages, and the reason for resolving a reclassification item, the one
 * write here (through the existing, audited resolve_catalog_review).
 */

export const RUN_STATUSES = [
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "abandoned", label: "Abandoned" },
] as const;

export const RECORD_STATUSES = [
  { value: "needs_review", label: "Needs review" },
  { value: "failed", label: "Failed" },
  { value: "promoted", label: "Created a candidate" },
  { value: "matched", label: "Matched" },
  { value: "ignored", label: "Ignored" },
  { value: "fetched", label: "Staged, not applied" },
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const runStatusLabel = (s: string) => RUN_STATUSES.find((x) => x.value === s)?.label ?? s;
export const recordStatusLabel = (s: string) => RECORD_STATUSES.find((x) => x.value === s)?.label ?? s;

/** A run status from the list, or null. */
export function readRunStatus(value: string | null): string | null {
  return value && RUN_STATUSES.some((s) => s.value === value) ? value : null;
}

/** A staged entry's status from the list, or null. */
export function readRecordStatus(value: string | null): string | null {
  return value && RECORD_STATUSES.some((s) => s.value === value) ? value : null;
}

/** A provider code as the database allows it, or null. */
export function readProvider(value: string | null): string | null {
  return value && value.length <= 40 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) ? value : null;
}

/** A record id, or null. */
export function readId(value: string | null): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

/** A position to page after: a whole number from 0, or null. */
export function readPosition(value: string | null): number | null {
  if (!value || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

/** The counters a run keeps as it stages entries (M5b), in words. Unknown keys keep their own name. */
const STAT_LABELS: Record<string, string> = {
  staged_new: "New entries",
  staged_unchanged: "Unchanged entries",
  staged_changed: "Changed entries",
  staged_ignored: "Ignored entries",
  staged_repeated: "Repeated entries",
};
export function statLabel(key: string): string {
  return STAT_LABELS[key] ?? key.replace(/_/g, " ");
}

/** The pilot report's "entity:status" and "entity:tier" keys, in words. */
export function reportKeyLabel(key: string): string {
  const [entity, value] = key.split(":");
  const what = entity === "game" ? "Game" : entity === "release" ? "Release" : entity;
  const tiers: Record<string, string> = { A: "tier A (exact)", B: "tier B (word breaks)", C: "tier C (suggested)", new: "new" };
  return `${what} entries, ${tiers[value] ?? recordStatusLabel(value ?? "").toLowerCase()}`;
}

/** A SHA-256, shortened for display. The full value is in the title attribute. */
export function shortHash(hash: string | null): string | null {
  return hash ? `${hash.slice(0, 12)}…` : null;
}

/** The reason for resolving a reclassification item: 1 to 500 characters, spaces collapsed. */
export function readResolution(value: string): { value: string } | { error: string } {
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) return { error: "Say how the item was resolved. Other catalog staff can see it in the record's history." };
  if (v.length > 500) return { error: "Keep the resolution to 500 characters." };
  return { value: v };
}

/** The database's fixed errors for the resolution, as messages. Nothing else is shown. */
export function resolveErrorMessage(message: unknown): string {
  switch (message) {
    case "record unavailable":
      return "This item was already resolved, or is no longer in the queue.";
    case "reason required":
      return "Say how the item was resolved.";
    case "not permitted":
      return "Only active catalog editors can resolve items.";
    default:
      return "The item couldn't be resolved. Try again.";
  }
}

/** The fixed notices and errors the queue page shows from its URL. */
export const QUEUE_NOTICES: Record<string, string> = { resolved: "The item was resolved and recorded in the audit log." };
export const QUEUE_ERRORS: Record<string, string> = {
  unavailable: resolveErrorMessage("record unavailable"),
  reason: resolveErrorMessage("reason required"),
  failed: resolveErrorMessage(null),
};

/** A run's status tone: a running run whose lease expired has stopped without finishing. */
export function runTone(run: { status: string; lease_live: boolean }): "good" | "warning" | "problem" | "neutral" {
  if (run.status === "completed") return "good";
  if (run.status === "failed") return "problem";
  if (run.status === "running") return run.lease_live ? "neutral" : "warning";
  return "neutral";
}
