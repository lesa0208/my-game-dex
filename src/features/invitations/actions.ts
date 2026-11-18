"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { readReason, stepUpHref, withParam } from "@/features/admin/form";
import {
  authAdminConfigured,
  banInvitee,
  type DeliveryOutcome,
  invitationDeliveryPlan,
  invitationRevocationTarget,
  reconcileInvitation,
  recordInvitationDelivery,
  sendInvitation,
} from "@/features/auth-admin/server";
import { signInHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";

import { invitationErrorCode, invitationRefusal, readInvitationEmail } from "./form";

/**
 * Invitation actions for /admin/invitations (M11a-1, M11a-2). Each runs without JavaScript
 * and redirects back with a fixed notice or error code. The order is always:
 *
 *   1. a database function, in the administrator's own session, authorizes (role,
 *      recent MFA, limits) and records the step, with its audit row;
 *   2. only then the server's privileged steps (features/auth-admin/server), for the
 *      invitation that function accepted: what to send and where, the Auth call, and
 *      recording what Auth did, which the database checks itself.
 *
 * Every accepted address gets the same answers, whether or not it already has an account
 * (for which nothing is ever sent), so the page can't be used to learn which addresses
 * have accounts. A step that fails partway leaves a state the page shows and can retry:
 * "Couldn't send", or "Revoking" (blocked in the app, ban not yet confirmed). Revocation
 * never deletes an account. When the database asks for a fresh verification, the
 * administrator verifies and comes back to the page; nothing is replayed.
 */

const BACK = "/admin/invitations";

type Result = { ok?: boolean; result?: string; refusal?: string; id?: string };

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

/** Bans the account the database names, if any, and asks the database whether the revocation holds. */
async function settleRevocation(id: string): Promise<string> {
  const userId = await invitationRevocationTarget(id);
  if (userId) await banInvitee(userId);
  return reconcileInvitation(id);
}

/**
 * How long sending an invitation's email takes at least, whether or not an email is sent.
 * Without it, an address with an account (no Auth call, no SMTP) would answer measurably
 * faster than one without. A send slower than this still stands out (security-rls.md).
 */
const DELIVERY_MIN_MS = 2000;

/** Sends an invitation's email if the database says to, and records what Auth did. */
async function deliver(id: string, operation: "invite" | "resend"): Promise<string> {
  const started = Date.now();
  const plan = await invitationDeliveryPlan(id);
  let outcome: DeliveryOutcome = "skipped";
  if (plan) {
    const sent = await sendInvitation(plan.email);
    outcome = sent === "ok" ? "sent" : sent === "unavailable" ? "unavailable" : "failed";
  }
  const rest = DELIVERY_MIN_MS - (Date.now() - started);
  if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
  const delivery = await recordInvitationDelivery(id, operation, outcome);
  if (delivery.result === "revoke_pending") revocationOutcome(await settleRevocation(id));
  return delivery.result;
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
  if (created.ok !== true || typeof created.id !== "string" || !UUID.test(created.id)) done("error", invitationRefusal(created.refusal));
  if ((await deliver(created.id, "invite")) !== "sent") done("error", "send_failed");
  done("notice", "invited");
}

export async function resendInvitation(formData: FormData): Promise<void> {
  if (!authAdminConfigured()) done("error", "not_configured");
  const id = field(formData, "invitation_id");
  if (!UUID.test(id)) done("error", "invitation_unavailable");
  const reason = reasonOrBack(formData);
  const asked = await call("request_invitation_resend", { p_id: id, p_reason: reason });
  if (asked.ok !== true) done("error", invitationRefusal(asked.refusal));
  if ((await deliver(id, "resend")) !== "sent") done("error", "send_failed");
  done("notice", "resent");
}

export async function revokeInvitation(formData: FormData): Promise<void> {
  const id = field(formData, "invitation_id");
  if (!UUID.test(id)) done("error", "invitation_unavailable");
  const reason = reasonOrBack(formData);
  const asked = await call("request_invitation_revocation", { p_id: id, p_reason: reason });
  if (asked.ok !== true) done("error", invitationRefusal(asked.refusal));
  if (asked.result === "unchanged") done("notice", "unchanged");
  // Recorded and already blocking onboarding; now the ban in Auth, read back by the database.
  if (!authAdminConfigured()) done("error", "revoke_pending");
  revocationOutcome(await settleRevocation(id));
}

export async function retryRevocation(formData: FormData): Promise<void> {
  const id = field(formData, "invitation_id");
  if (!UUID.test(id)) done("error", "invitation_unavailable");
  const target = await call("retry_invitation_revocation", { p_id: id });
  if (target.ok !== true) done("error", invitationRefusal(target.refusal));
  if (!authAdminConfigured()) done("error", "revoke_pending");
  revocationOutcome(await settleRevocation(id));
}
