import type { Viewer } from "@/types/user";

/**
 * The signed-in account as `get_my_account()` (M2) returns it, checked field by
 * field, and the messages for the handle claim. Pure, so it can be tested without
 * a server.
 */

/** The same rule as `claim_handle`, checked before lowercasing. */
export const HANDLE_PATTERN = /^[A-Za-z0-9_]{3,24}$/;

const STATUSES = new Set(["active", "suspended", "deactivated"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Null when the row isn't the signed-in user's, or doesn't have the expected shape. */
export function parseAccount(row: unknown, userId: string): Viewer | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (r.id !== userId || typeof r.account_status !== "string" || !STATUSES.has(r.account_status)) return null;
  const handle = text(r.handle);
  return {
    id: userId,
    handle,
    displayName: text(r.display_name) ?? handle ?? "New collector",
    accountStatus: r.account_status as Viewer["accountStatus"],
    isActive: r.is_active === true,
    handleChangedAt: text(r.handle_changed_at),
    handleCorrectionUntil: text(r.handle_correction_until),
  };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * When `claim_handle` will next allow a change, or null if it allows one now: during
 * the first claim's 24-hour correction window, or 30 days after the last change.
 * Only for display. The database decides.
 */
export function nextHandleChange(
  viewer: Pick<Viewer, "handleChangedAt" | "handleCorrectionUntil">,
  now: number = Date.now(),
): Date | null {
  if (viewer.handleCorrectionUntil && Date.parse(viewer.handleCorrectionUntil) > now) return null;
  if (!viewer.handleChangedAt) return null;
  const allowedAt = Date.parse(viewer.handleChangedAt) + 30 * DAY;
  return allowedAt > now ? new Date(allowedAt) : null;
}

export type HandleError = "invalid" | "unavailable" | "too_soon" | "not_eligible" | "failed";

/** The fixed errors `claim_handle` raises. Anything else is a generic failure. */
export function handleErrorFrom(message: unknown): HandleError {
  switch (message) {
    case "invalid handle":
      return "invalid";
    case "handle unavailable":
      return "unavailable";
    case "handle change not available yet":
      return "too_soon";
    case "account not eligible":
      return "not_eligible";
    default:
      return "failed";
  }
}

export const HANDLE_ERROR_MESSAGES: Record<HandleError, string> = {
  invalid: "Use 3 to 24 letters, numbers or underscores.",
  unavailable: "That handle isn't available. Try another one.",
  too_soon: "You can change your handle again 30 days after you last set it.",
  not_eligible: "Your account can't claim a handle right now.",
  failed: "Your handle couldn't be saved. Try again.",
};
