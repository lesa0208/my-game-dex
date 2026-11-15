/**
 * The unified /admin (M8d): what staff enter, the database's refusal codes and fixed
 * errors as messages, labels, and the few audit details shown. No server-only imports,
 * so the unit tests can use it. Every message is fixed: nothing from the database
 * reaches a page.
 */

export const STAFF_REASON_MAX = 500;
export const HANDLE_INPUT = /^[A-Za-z0-9_]{3,24}$/;

export type StaffRole = "admin" | "catalog_editor" | "moderator";
export const ROLES: readonly StaffRole[] = ["catalog_editor", "moderator", "admin"];
const ROLE_LABELS: Record<StaffRole, string> = { admin: "Administrator", catalog_editor: "Catalog editor", moderator: "Moderator" };

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as StaffRole] ?? role;
}

export function isRole(value: string): value is StaffRole {
  return (ROLES as readonly string[]).includes(value);
}

export function statusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "suspended":
      return "Suspended";
    case "deactivated":
      return "Deactivated";
    default:
      return status;
  }
}

/**
 * The refusals the staff functions return (M8c, A4), as messages. A refusal is
 * audited; the page says plainly why nothing changed.
 */
const REFUSALS: Record<string, string> = {
  owner_protected: "The Owner's account and roles can't be changed here.",
  owner_only: "Only the Owner can do this.",
  owner_ineligible: "Owner actions need two verified authenticator factors, each set up at least 24 hours ago, and an account in good standing.",
  self_change: "Nobody can change their own roles or status. Ask another administrator.",
  admin_required: "Only an administrator can change the status of a staff member.",
  target_ineligible: "That account can't take this on: it needs to be an active administrator with two verified authenticator factors.",
  transfer_pending: "A transfer is already waiting to be accepted. Cancel it first.",
  transfer_expired: "This transfer has expired. The Owner can start a new one.",
  recovery_pending: "An ownership recovery is in progress, so Owner actions are paused until it ends.",
  recovery_disputed: "This recovery is disputed, so only an operator can cancel it. Follow the dispute procedure.",
};

export function refusalMessage(code: unknown): string {
  return (typeof code === "string" && REFUSALS[code]) || "Nothing changed: this isn't allowed.";
}

/** The fixed errors the admin functions raise, as messages. */
export function adminErrorMessage(message: unknown): string {
  switch (message) {
    case "not permitted":
      return "Your account can't do this. Check that you're signed in with your authenticator.";
    case "user unavailable":
      return "That account can't hold a role right now: it isn't active, verified or doesn't have a handle.";
    case "transfer unavailable":
      return "This transfer is no longer waiting for you.";
    case "recovery unavailable":
      return "This recovery is no longer pending.";
    case "reason required":
      return "Give a reason for the record, up to 500 characters.";
    case "invalid handle":
      return "Enter a handle: 3 to 24 letters, numbers or underscores.";
    case "invalid fingerprint":
      return "Enter the document's SHA-256 fingerprint: 64 hexadecimal digits.";
    case "invalid filter":
      return "Check the filters: an action from the list, handles, and a range of at most a year.";
    default:
      return "It couldn't be saved. Try again.";
  }
}

/** The errors and notices an admin page shows, from its URL. Unknown codes show nothing. */
const ERRORS: Record<string, string> = {
  ...Object.fromEntries(Object.keys(REFUSALS).map((code) => [code, REFUSALS[code]])),
  not_found: "No account has that handle.",
  invalid_input: "Check what you entered and try again.",
  not_permitted: adminErrorMessage("not permitted"),
  user_unavailable: adminErrorMessage("user unavailable"),
  transfer_unavailable: adminErrorMessage("transfer unavailable"),
  recovery_unavailable: adminErrorMessage("recovery unavailable"),
  reason_required: adminErrorMessage("reason required"),
  invalid_fingerprint: adminErrorMessage("invalid fingerprint"),
  failed: adminErrorMessage(null),
};
const NOTICES: Record<string, string> = {
  granted: "The role was granted.",
  revoked: "The role was removed.",
  suspended: "The account was suspended.",
  reinstated: "The account was reinstated.",
  unchanged: "Nothing needed to change.",
  transfer_started: "The transfer was offered. It expires in 72 hours unless accepted.",
  transfer_accepted: "You are now the Owner.",
  transfer_cancelled: "The transfer was cancelled.",
  transfer_declined: "You declined the transfer.",
  successor_set: "The successor was updated.",
  document_registered: "The succession document's fingerprint was updated.",
  recovery_cancelled: "The recovery was cancelled. An operator can still open a disputed recovery.",
  recovery_confirmed: "You confirmed the recovery. An operator completes it after the hold.",
  verified: "Verified.",
};

export function pageError(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(ERRORS, code) ? ERRORS[code] : null;
}

export function pageNotice(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(NOTICES, code) ? NOTICES[code] : null;
}

/** A raised error as the code a page shows. */
export function errorCode(message: unknown): string {
  switch (message) {
    case "not permitted":
      return "not_permitted";
    case "user unavailable":
      return "user_unavailable";
    case "transfer unavailable":
      return "transfer_unavailable";
    case "recovery unavailable":
      return "recovery_unavailable";
    case "reason required":
      return "reason_required";
    case "invalid fingerprint":
      return "invalid_fingerprint";
    case "invalid handle":
    case "invalid role":
    case "invalid status":
    case "invalid transfer":
    case "invalid recovery":
      return "invalid_input";
    default:
      return "failed";
  }
}

/**
 * The page to come back to after an action or a verification: a path under /admin or
 * /settings on this site, with plain segments and an optional query. Anything else,
 * such as another site, "//host" or an encoded trick, falls back to a fixed page.
 */
export function returnPath(value: unknown, fallback = "/admin"): string {
  if (typeof value !== "string" || value.length > 512) return fallback;
  return /^\/(admin|settings)(\/[A-Za-z0-9_-]+)*\/?(\?[A-Za-z0-9_\-=&.%]*)?$/.test(value) ? value : fallback;
}

/** Adds one query parameter to a path, replacing notice and error from an earlier action. */
export function withParam(path: string, name: "notice" | "error", value: string): string {
  const url = new URL(path, "http://next.invalid");
  url.searchParams.delete("notice");
  url.searchParams.delete("error");
  url.searchParams.set(name, value);
  return `${url.pathname}${url.search}`;
}

/** Where a fresh verification is asked for, coming back to `next` afterwards (never replaying the action). */
export function stepUpHref(next: string): string {
  return `/settings/security/verify?next=${encodeURIComponent(returnPath(next))}`;
}

export function readReason(value: string): string | null {
  const reason = value.replace(/\s+/g, " ").trim();
  return reason && reason.length <= STAFF_REASON_MAX ? reason : null;
}

export function readHandle(value: string): string | null {
  const handle = value.trim().replace(/^@/, "");
  return HANDLE_INPUT.test(handle) ? handle.toLowerCase() : null;
}

export function readFingerprint(value: string): string | null {
  const fingerprint = value.replace(/\s+/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : null;
}

/** Audit actions an administrator can filter by, with labels. */
export const AUDIT_ACTIONS: readonly { value: string; label: string }[] = [
  { value: "staff_role_granted", label: "Role granted" },
  { value: "staff_role_revoked", label: "Role removed" },
  { value: "account_suspended", label: "Account suspended" },
  { value: "account_reinstated", label: "Account reinstated" },
  { value: "staff_change_refused", label: "Staff change refused" },
  { value: "owner_protection_refused", label: "Refused: Owner protected" },
  { value: "operator_action", label: "Operator action" },
  { value: "owner_assigned", label: "Owner assigned" },
  { value: "ownership_transfer_started", label: "Transfer offered" },
  { value: "ownership_transfer_accepted", label: "Transfer accepted" },
  { value: "ownership_transfer_cancelled", label: "Transfer cancelled" },
  { value: "owner_successor_set", label: "Successor changed" },
  { value: "owner_succession_registered", label: "Succession document registered" },
  { value: "owner_recovery_started", label: "Recovery opened" },
  { value: "owner_recovery_confirmed", label: "Recovery confirmed" },
  { value: "owner_recovery_cancelled", label: "Recovery cancelled" },
  { value: "owner_recovery_completed", label: "Recovery completed" },
  { value: "owner_status_set_by_operator", label: "Owner status set by operator" },
  { value: "catalog_record_created", label: "Catalog record created" },
  { value: "catalog_record_updated", label: "Catalog record updated" },
  { value: "catalog_record_verified", label: "Catalog record verified" },
  { value: "catalog_record_published", label: "Catalog record published" },
  { value: "catalog_record_withdrawn", label: "Catalog record withdrawn" },
  { value: "catalog_field_locked", label: "Field locked" },
  { value: "catalog_field_unlocked", label: "Field unlocked" },
  { value: "catalog_alias_added", label: "Alias added" },
  { value: "catalog_alias_removed", label: "Alias removed" },
  { value: "catalog_import_run", label: "Import run" },
  { value: "catalog_provider_cleared", label: "Provider data cleared" },
  { value: "catalog_review_queued", label: "Queued for review" },
  { value: "catalog_review_resolved", label: "Review resolved" },
  { value: "catalog_submission_created", label: "Submission created" },
  { value: "catalog_submission_updated", label: "Submission updated" },
  { value: "catalog_submission_withdrawn", label: "Submission withdrawn" },
  { value: "catalog_submission_resubmitted", label: "Submission resubmitted" },
  { value: "catalog_submission_review_started", label: "Review started" },
  { value: "catalog_submission_approved", label: "Submission approved" },
  { value: "catalog_submission_changes_requested", label: "Changes requested" },
  { value: "catalog_submission_rejected", label: "Submission rejected" },
  { value: "catalog_release_excluded", label: "Release excluded" },
  { value: "catalog_exclusion_restored", label: "Exclusion restored" },
  { value: "catalog_release_merged", label: "Release merged" },
];

export function auditActionLabel(action: string): string {
  return AUDIT_ACTIONS.find((a) => a.value === action)?.label ?? action;
}

export function isAuditAction(value: string): boolean {
  return AUDIT_ACTIONS.some((a) => a.value === value);
}

/**
 * The audit details shown: a short allow-list of plain values (codes, roles, statuses,
 * counts). Ids, fingerprints and anything else in the metadata stay out of the page.
 */
const DETAIL_LABELS: Record<string, string> = {
  code: "Refusal",
  operation: "Attempted",
  role: "Role",
  from: "From",
  to: "To",
  status: "Status",
  kind: "Kind",
  by: "By",
  cause: "Cause",
  reason_code: "Reason code",
  previous_status: "Previous status",
  copies: "Copies",
  entity: "Record",
};

export function auditDetails(metadata: unknown): { label: string; value: string }[] {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return [];
  const m = metadata as Record<string, unknown>;
  return Object.keys(DETAIL_LABELS)
    .filter((key) => typeof m[key] === "string" || typeof m[key] === "number" || typeof m[key] === "boolean")
    .map((key) => ({ label: DETAIL_LABELS[key], value: key === "role" ? roleLabel(String(m[key])) : String(m[key]).slice(0, 80) }));
}

/** A day typed as YYYY-MM-DD, as the start of that day in UTC, or null. */
export function readDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value ? null : day;
}

/**
 * Whether the Owner's authority is held back by something a fresh verification can't
 * fix (two mature factors, good standing, no recovery). An old verification only
 * means the action asks for one, so the page still offers it.
 */
export function ownerAuthorityBlocked(refusal: string | null): boolean {
  return refusal !== null && refusal !== "reauthentication_required";
}
