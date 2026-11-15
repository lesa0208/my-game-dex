/**
 * Settings → Security (M8d): what a member enters for TOTP, and Auth's outcomes as
 * fixed messages. No server-only imports, so the unit tests can use it. Nothing from
 * Auth reaches a page, and a TOTP secret is never part of a URL or a message.
 */

export const FACTOR_NAME_MAX = 40;

/** A six-digit code, spaces allowed while typing; null otherwise. */
export function readCode(value: string): string | null {
  const code = value.replace(/\s+/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

/** A name for the authenticator, so a member can tell their factors apart. */
export function readFactorName(value: string): string | null {
  const name = value.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= FACTOR_NAME_MAX ? name : null;
}

const ERRORS: Record<string, string> = {
  invalid_code: "That code didn't match. Check the time on your device and enter the current code.",
  invalid_input: "Check what you entered and try again.",
  name_taken: "You already have an authenticator with that name. Choose another name.",
  verify_first: "Verify with an authenticator you already have before adding or removing one.",
  last_factor: "Staff need a verified authenticator, so your last one can't be removed. Add another first.",
  confirm_removal: "Confirm that you want to remove this authenticator.",
  unavailable: "Two-step verification isn't available right now. Try again later.",
  failed: "It couldn't be saved. Try again.",
};

export function securityError(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(ERRORS, code) ? ERRORS[code] : null;
}

const NOTICES: Record<string, string> = {
  verified: "Verified. Your authenticator is set up.",
  removed: "The authenticator was removed.",
  recovery_confirmed: "You confirmed the recovery. An operator completes it after the hold.",
  unchanged: "Nothing needed to change.",
};

export function securityNotice(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(NOTICES, code) ? NOTICES[code] : null;
}

/** Auth's error for a verification or enrollment, as a page error code. */
export function authErrorCode(error: { code?: string; status?: number } | null | undefined): string {
  switch (error?.code) {
    case "mfa_verification_failed":
    case "mfa_verification_rejected":
    case "mfa_challenge_expired":
      return "invalid_code";
    case "mfa_factor_name_conflict":
      return "name_taken";
    case "insufficient_aal":
      return "verify_first";
    case "mfa_factor_not_found":
    case "validation_failed":
      return "invalid_input";
    default:
      return error?.status === 429 ? "unavailable" : "failed";
  }
}

/** When a registered factor counts for Owner authority (D13), in words. */
export function maturityText(factor: { status: string; registered_at: string | null; matures_at: string | null; mature: boolean }, now = Date.now()): string {
  if (factor.status !== "verified") return "Not verified yet";
  if (!factor.registered_at || !factor.matures_at) return "Verified, not yet registered for Owner authority";
  if (factor.mature) return "Verified and registered more than 24 hours ago";
  const hours = Math.max(1, Math.ceil((Date.parse(factor.matures_at) - now) / 3600000));
  return `Verified; counts for Owner authority in about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}
