/**
 * Invitations (M11a-1): input, statuses and the fixed messages pages show. Pure, so the
 * unit tests cover it; the database checks everything again.
 */

/** The same rule as private.normalize_invitation_email: trimmed, lowercased, a plausible address. */
export function readInvitationEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

export type InvitationStatus =
  | "sending"
  | "sent"
  | "send_failed"
  | "expired"
  | "accepted"
  | "password_set"
  | "active"
  | "revoke_pending"
  | "revoked"
  | "revoked_after_acceptance";

export const INVITATION_STATUSES: Record<InvitationStatus, { label: string; tone: "good" | "warning" | "problem" | "neutral"; hint: string }> = {
  sending: { label: "Not sent yet", tone: "warning", hint: "Recorded, but sending didn't finish. Resend it, or revoke it." },
  sent: { label: "Sent", tone: "neutral", hint: "Waiting for the person to accept. The link works for an hour." },
  send_failed: { label: "Couldn't send", tone: "problem", hint: "Auth didn't send it. Try resending." },
  expired: { label: "Link expired", tone: "warning", hint: "The link was valid for an hour. Resend it to send a new one." },
  accepted: { label: "Accepted", tone: "neutral", hint: "They opened the link, but haven't set a password yet." },
  password_set: { label: "Password set", tone: "neutral", hint: "They set a password, but haven't chosen a handle yet." },
  active: { label: "Joined", tone: "good", hint: "They have an account. Manage it in Accounts." },
  revoke_pending: { label: "Revoking", tone: "warning", hint: "Recorded and blocked here, but the ban in Auth isn't confirmed. Retry it." },
  revoked: { label: "Revoked", tone: "neutral", hint: "The invitation can't be used." },
  revoked_after_acceptance: {
    label: "Revoked after acceptance",
    tone: "problem",
    hint: "They accepted before the revocation took effect. The account is banned and can't finish joining; nothing was deleted. See the runbook.",
  },
};

export function isInvitationStatus(value: unknown): value is InvitationStatus {
  return typeof value === "string" && Object.hasOwn(INVITATION_STATUSES, value);
}

/** Which actions the page offers for a status; the database decides again. */
export function invitationActions(status: InvitationStatus): { resend: boolean; revoke: boolean; retry: boolean } {
  return {
    resend: status === "sent" || status === "send_failed" || status === "expired",
    revoke: status === "sending" || status === "sent" || status === "send_failed" || status === "expired" || status === "accepted" || status === "password_set",
    retry: status === "revoke_pending",
  };
}

const NOTICES: Record<string, string> = {
  invited: "If this address has no account, an invitation is on its way. It works for an hour.",
  resent: "If the address has no account yet, a new invitation is on its way. The previous link no longer works.",
  revoked: "The invitation was revoked.",
  revoked_after_acceptance: "They accepted before the revocation took effect. The account is banned and can't finish joining; nothing was deleted.",
  unchanged: "Nothing needed to change.",
};

const ERRORS: Record<string, string> = {
  invalid_email: "Enter an email address.",
  reason_required: "Give a reason. It's kept in the audit log.",
  invitation_limit: "You have 20 open invitations. Wait for some to be accepted, or revoke some.",
  invitation_limit_total: "There are 200 open invitations. Wait for some to be accepted, or revoke some.",
  resend_too_soon: "Wait 10 minutes after the last email before resending.",
  resend_limit: "This invitation has been resent five times, the most allowed.",
  already_accepted: "It was already accepted, so it can't be resent.",
  already_active: "They've already joined. Suspend the account in Accounts instead.",
  invitation_closed: "That invitation can't be changed any more.",
  invitation_unavailable: "That invitation wasn't found.",
  send_failed: "The invitation was recorded, but sending it failed. Try resending.",
  revoke_pending: "The revocation is recorded and blocks the invitation here, but the ban in Auth isn't confirmed yet. Retry it.",
  not_configured: "Invitations can't be sent: this server has no Auth admin key configured.",
  not_permitted: "You can't do that.",
  failed: "That didn't work. Try again.",
};

export function invitationNotice(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(NOTICES, code) ? NOTICES[code] : null;
}

export function invitationError(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(ERRORS, code) ? ERRORS[code] : null;
}

/** A raised database error as the code a page shows; anything unexpected says nothing specific. */
export function invitationErrorCode(message: unknown): string {
  switch (message) {
    case "invalid email":
      return "invalid_email";
    case "reason required":
      return "reason_required";
    case "invitation unavailable":
      return "invitation_unavailable";
    case "not permitted":
      return "not_permitted";
    default:
      return "failed";
  }
}

/** A refusal from a function's result, if it's one the page knows. */
export function invitationRefusal(value: unknown): string {
  return typeof value === "string" && Object.hasOwn(ERRORS, value) ? value : "failed";
}

export const PASSWORD_MIN = 12;
/** bcrypt, which Auth uses, ignores bytes past 72. */
export const PASSWORD_MAX_BYTES = 72;

/** A new password's problem, or null when it can be sent to Auth. */
export function passwordProblem(password: unknown, confirm: unknown): string | null {
  if (typeof password !== "string" || typeof confirm !== "string") return "Enter your new password twice.";
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return `Use at most ${PASSWORD_MAX_BYTES} bytes (about ${PASSWORD_MAX_BYTES} plain letters).`;
  if (password !== confirm) return "The two passwords don't match.";
  return null;
}
