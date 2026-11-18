import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * The only use of the Supabase secret key for Auth in the app (M11a-1, ADR-063 as amended
 * in M11a-2). The only other use is the M2 avatar workflow (src/features/avatars, called
 * from Settings → Profile since M11a-3, ADR-065), for the avatars bucket and
 * set_avatar_path only, never Auth. Here: the invitation steps that depend on what Auth holds, each taken only after a
 * database function has authorized the administrator in their own session (role, recent
 * MFA, limits) for that invitation. Nothing else: no deletion, no unbanning, no generated
 * links, no password operations and no other data.
 *
 * - Two Auth Admin calls: send an invitation, ban an invitee.
 * - Four database functions only service_role may call (M11a-2), so an administrator
 *   calling the API directly can't skip or fake a step: whether and where to send,
 *   recording what Auth did, the account to ban, and reconciling a revocation. Each
 *   takes an invitation id the administrator's own function has just accepted.
 * - The key is the server-only SUPABASE_SECRET_KEY, never a NEXT_PUBLIC_ variable; this
 *   module can't be imported by client code ("server-only").
 * - A client is made per call, with no session kept, refreshed or read from a URL.
 * - Responses are reduced to fixed outcomes here: nothing from them (and never the key, a
 *   token, an address or an account id) is logged or returned to a page.
 *
 * Without the key (for example on a development stack it wasn't given to), invitations
 * are reported as unavailable and nothing is attempted.
 */

export type AuthAdminOutcome = "ok" | "unavailable" | "not_configured" | "failed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

export function authAdminConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

/**
 * Asks Auth to send (or send again) an invitation email. "unavailable" means Auth already
 * holds a confirmed account for the address; the database checks that itself.
 */
export async function sendInvitation(email: string): Promise<AuthAdminOutcome> {
  const client = adminClient();
  if (!client) return "not_configured";
  try {
    const { error } = await client.auth.admin.inviteUserByEmail(email);
    if (!error) return "ok";
    return error.status === 422 ? "unavailable" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Bans an invitee's account in Auth, so its invitation link and any later sign-in or
 * token refresh are refused. The user id comes from invitationRevocationTarget, never
 * from a request. Whether the ban held is read back by the database
 * (reconcileInvitation), not taken from this result.
 */
export async function banInvitee(userId: string): Promise<AuthAdminOutcome> {
  const client = adminClient();
  if (!client) return "not_configured";
  try {
    const { error } = await client.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
    return error ? "failed" : "ok";
  } catch {
    return "failed";
  }
}

type Row = Record<string, unknown>;

async function invitationStep(fn: string, args: Row): Promise<Row | null> {
  const client = adminClient();
  if (!client) return null;
  try {
    const { data, error } = await client.rpc(fn, args);
    return error || !data || typeof data !== "object" ? null : (data as Row);
  } catch {
    return null;
  }
}

/** The address to hand to Auth for an invitation's email, or null when nothing is sent. */
export async function invitationDeliveryPlan(id: string): Promise<{ email: string } | null> {
  const plan = await invitationStep("invitation_delivery_plan", { p_id: id });
  return plan?.send === true && typeof plan.email === "string" ? { email: plan.email } : null;
}

export type DeliveryOutcome = "sent" | "unavailable" | "failed" | "skipped";

/** Records what the Auth call did; the database checks Auth itself. */
export async function recordInvitationDelivery(
  id: string,
  operation: "invite" | "resend",
  outcome: DeliveryOutcome,
): Promise<{ result: string; userId: string | null }> {
  const row = await invitationStep("record_invitation_delivery", { p_id: id, p_operation: operation, p_outcome: outcome });
  const userId = typeof row?.user_id === "string" && UUID.test(row.user_id) ? row.user_id : null;
  return { result: typeof row?.result === "string" ? row.result : "failed", userId };
}

/** The account to ban for a revocation in progress, if there is one. */
export async function invitationRevocationTarget(id: string): Promise<string | null> {
  const row = await invitationStep("invitation_revocation_target", { p_id: id });
  return typeof row?.user_id === "string" && UUID.test(row.user_id) ? row.user_id : null;
}

/** Asks the database whether the revocation now holds in Auth. */
export async function reconcileInvitation(id: string): Promise<string> {
  const row = await invitationStep("reconcile_invitation", { p_id: id });
  return typeof row?.result === "string" ? row.result : "revoke_pending";
}
