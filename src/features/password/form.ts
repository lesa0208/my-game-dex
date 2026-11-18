/**
 * Password recovery and account security (M11a-2): what a person enters, whether a
 * session may reset its password, and the fixed messages pages show. Pure, so the unit
 * tests cover it. Nothing Auth says reaches a page, and never a token.
 */

/** A recovery link's token hash: what Auth puts in the email, in a URL-safe alphabet. */
export const TOKEN_HASH = /^[A-Za-z0-9_-]{10,200}$/;

/** The same rules as an invitee's first password (features/invitations/form): Auth's minimum, and bcrypt's 72 bytes. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX_BYTES = 72;

/** A new password's problem as a page error code, or null when it can be sent to Auth. */
export function newPasswordProblem(password: unknown, confirm: unknown): string | null {
  if (typeof password !== "string" || typeof confirm !== "string" || !password) return "enter_twice";
  if (password.length < PASSWORD_MIN) return "too_short";
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return "too_long";
  if (password !== confirm) return "mismatch";
  return null;
}

/** How long after opening a reset link its session may still choose a new password. */
export const RECOVERY_WINDOW_SECONDS = 3600;

/** The cookie that ties a recovery to the browser that opened its link: the session's id only. */
export const RECOVERY_COOKIE = "mgd-recovery";

/** A plausible address, trimmed and lowercased; null otherwise. Says nothing about accounts. */
export function readEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

type Claims = { session_id?: unknown; amr?: unknown } | null | undefined;

/**
 * Whether this session may choose a new password without the current one: it must be the
 * session a reset link created in this browser (the cookie names its id) and the link must
 * have been opened within the window. A reset link signs in with a one-time code ("otp"
 * in the token's methods); a password sign-in, or a session from elsewhere, can't reset.
 */
export function recoveryState(claims: Claims, cookieSessionId: string | null | undefined, nowSeconds: number): "ok" | "none" | "expired" {
  if (!claims || typeof claims.session_id !== "string" || !cookieSessionId || claims.session_id !== cookieSessionId) return "none";
  const methods = Array.isArray(claims.amr) ? claims.amr : [];
  const otp = methods.find((m): m is { method: string; timestamp: number } => typeof m === "object" && m !== null && (m as { method?: unknown }).method === "otp");
  if (!otp || typeof otp.timestamp !== "number") return "none";
  return nowSeconds - otp.timestamp <= RECOVERY_WINDOW_SECONDS && otp.timestamp <= nowSeconds + 60 ? "ok" : "expired";
}

/** Auth's answer to a password update, as a page error code. */
export function passwordErrorCode(error: { code?: string; status?: number } | null | undefined): string {
  switch (error?.code) {
    case "weak_password":
      return "weak_password";
    case "same_password":
      return "same_password";
    case "reauthentication_needed":
    case "reauthentication_not_valid":
      return "reauthenticate";
    case "insufficient_aal":
      return "verify_first";
    case "over_request_rate_limit":
      return "too_many";
    default:
      return error?.status === 429 ? "too_many" : "failed";
  }
}

const ERRORS: Record<string, string> = {
  enter_twice: "Enter your new password twice.",
  too_short: `Use at least ${PASSWORD_MIN} characters.`,
  too_long: `Use at most ${PASSWORD_MAX_BYTES} bytes (about ${PASSWORD_MAX_BYTES} plain letters).`,
  mismatch: "The two passwords don't match.",
  invalid_email: "Enter the email address you sign in with.",
  weak_password: "That password is too weak. Use a longer one, or mix in more kinds of characters.",
  same_password: "That's already your password. Choose a new one.",
  wrong_password: "Your current password is incorrect.",
  current_required: "Enter your current password.",
  reauthenticate: "You signed in more than a day ago. Sign in again, then change your password.",
  verify_first: "Verify with your authenticator first.",
  too_many: "Too many attempts. Wait a few minutes, then try again.",
  unavailable: "This isn't available right now. Try again later.",
  failed: "Your password couldn't be changed. Try again.",
};

export function passwordError(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(ERRORS, code) ? ERRORS[code] : null;
}

const NOTICES: Record<string, string> = {
  password_changed: "Your password was changed. Other devices were signed out; one that's in use right now can keep working for up to an hour.",
  password_reset: "Your password was reset. Other devices were signed out; one that's in use right now can keep working for up to an hour.",
  signed_out_everywhere: "You were signed out on every device. A device that's in use right now can keep working for up to an hour.",
};

export function passwordNotice(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(NOTICES, code) ? NOTICES[code] : null;
}

/** What /forgot-password says after any request, whether or not the address has an account. */
export const RESET_REQUESTED =
  "If an account uses this address, we've sent it a link to reset the password. It works once, for an hour. It can take a few minutes to arrive; you can ask again after a minute.";
