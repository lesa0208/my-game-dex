"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { readReason, stepUpHref, withParam } from "@/features/admin/form";
import { authAdminConfigured, banInvitee, sendInvitation } from "@/features/auth-admin/server";
import { signInHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";

import { invitationErrorCode, invitationRefusal, readInvitationEmail } from "./form";

/**
 * Invitation actions for /admin/invitations (M11a-1). Each runs without JavaScript and
 * redirects back with a fixed notice or error code. The order is always:
 *
 *   1. a database function, in the administrator's own session, authorizes (role,
 *      recent MFA, limits) and records the step, with its audit row;
 *   2. only then the Auth Admin call (features/auth-admin/server), with what that
 *      function returned, never an id or address from the request beyond the new
 *      invitation's address, which the database has just accepted;
 *   3. the outcome is recorded by the database, which checks Auth itself.
 *
 * A step that fails partway leaves a state the page shows and can retry: "Couldn't send",
 * or "Revoking" (blocked in the app, ban not yet confirmed). Revocation never deletes an
 * account. When the database asks for a fresh verification, the administrator verifies
 * and comes back to the page; nothing is replayed.
 */

const BACK = "/admin/invitations";

type Result = { ok?: boolean; result?: string; refusal?: string; id?: string; email?: string; user_id?: string };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function done(kind: "notice" | "error", code: string): never {
  refresh();
  redirect(withParam(BACK, kind, code));
}

async function signedIn() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) done("error", "failed");
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) redirect(signInHref(BACK));
  return supabase;
}

/** Calls an invitation function; a raised error redirects (to verify, or with its code). */
async function call(fn: string, args: Record<string, unknown>): Promise<Result> {
  const supabase = await signedIn();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (error.message === "reauthentication required") redirect(stepUpHref(BACK));
    done("error", invitationErrorCode(error.message));
  }
  return (data ?? {}) as Result;
}

/** Bans the account the database named and asks the database whether the ban holds. */
async function settleRevocation(id: string, userId: string): Promise<string> {
  await banInvitee(userId);
  const settled = await call("reconcile_invitation", { p_id: id });
  return typeof settled.result === "string" ? settled.result : "revoke_pending";
}

function revocationOutcome(result: string): never {
  if (result === "revoked") done("notice", "revoked");
  if (result === "revoked_after_acceptance") done("notice", "revoked_after_acceptance");
  done("error", "revoke_pending");
}

function reasonOrBack(formData: FormData): string {
  const reason = readReason(field(formData, "reason"));
  if (!reason) done("error", "reason_required");
  return reason;
}

export async function createInvitation(formData: FormData): Promise<void> {
  if (!authAdminConfigured()) done("error", "not_configured");
  const email = readInvitationEmail(field(formData, "email"));
  if (!email) done("error", "invalid_email");
  const reason = reasonOrBack(formData);
  const created = await call("create_account_invitation", { p_email: email, p_reason: reason });
  if (created.ok !== true) done("error", invitationRefusal(created.refusal));
  // No id: the address already has an account or an open invitation. Same message as a send.
  if (typeof created.id !== "string" || !UUID.test(created.id)) done("notice", "invited");
  const sent = await sendInvitation(email);
  const delivery = await call("record_invitation_delivery", { p_id: created.id, p_operation: "invite", p_sent: sent === "ok" });
  if (delivery.result === "revoke_pending" && typeof delivery.user_id === "string" && UUID.test(delivery.user_id)) {
    revocationOutcome(await settleRevocation(created.id, delivery.user_id));
  }
  if (sent === "unavailable") done("notice", "invited");
  if (delivery.result !== "sent") done("error", "send_failed");
  done("notice", "invited");
}

export async function resendInvitation(formData: FormData): Promise<void> {
  if (!authAdminConfigured()) done("error", "not_configured");
  const id = field(formData, "invitation_id");
  if (!UUID.test(id)) done("error", "invitation_unavailable");
  const reason = reasonOrBack(formData);
  const asked = await call("request_invitation_resend", { p_id: id, p_reason: reason });
  if (asked.ok !== true || typeof asked.email !== "string") done("error", invitationRefusal(asked.refusal));
  const sent = await sendInvitation(asked.email);
  const delivery = await call("record_invitation_delivery", { p_id: id, p_operation: "resend", p_sent: sent === "ok" });
  if (delivery.result === "revoke_pending" && typeof delivery.user_id === "string" && UUID.test(delivery.user_id)) {
    revocationOutcome(await settleRevocation(id, delivery.user_id));
  }
  if (sent !== "ok" && sent !== "unavailable") done("error", "send_failed");
  done("notice", "resent");
}

export async function revokeInvitation(formData: FormData): Promise<void> {
  const id = field(formData, "invitation_id");
  if (!UUID.test(id)) done("error", "invitation_unavailable");
  const reason = reasonOrBack(formData);
  const asked = await call("request_invitation_revocation", { p_id: id, p_reason: reason });
  if (asked.ok !== true) done("error", invitationRefusal(asked.refusal));
  if (asked.result === "unchanged") done("notice", "unchanged");
  if (asked.result === "revoked") done("notice", "revoked");
  // Recorded and already blocking onboarding; now the ban in Auth, read back by the database.
  if (!authAdminConfigured() || typeof asked.user_id !== "string" || !UUID.test(asked.user_id)) done("error", "revoke_pending");
  revocationOutcome(await settleRevocation(id, asked.user_id));
}

export async function retryRevocation(formData: FormData): Promise<void> {
  const id = field(formData, "invitation_id");
  if (!UUID.test(id)) done("error", "invitation_unavailable");
  const target = await call("retry_invitation_revocation", { p_id: id });
  if (target.ok !== true || typeof target.user_id !== "string" || !UUID.test(target.user_id)) done("error", invitationRefusal(target.refusal));
  if (!authAdminConfigured()) done("error", "revoke_pending");
  revocationOutcome(await settleRevocation(id, target.user_id));
}
