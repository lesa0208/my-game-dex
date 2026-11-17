import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * The only use of the Supabase secret key in the app (M11a-1, ADR-063): two Auth Admin
 * calls for invitations, made only after a database function has authorized the
 * administrator in their own session (role, recent MFA, limits) and returned what to act
 * on. Nothing else: no deletion, no unbanning, no generated links, no data queries.
 *
 * - The key is the server-only SUPABASE_SECRET_KEY, never a NEXT_PUBLIC_ variable; this
 *   module can't be imported by client code ("server-only").
 * - A client is made per call, with no session kept, refreshed or read from a URL.
 * - Auth's responses are reduced to a fixed outcome here: nothing from them (and never the
 *   key, a token or an address) is logged or returned.
 *
 * Without the key (for example on a development stack it wasn't given to), invitations
 * are reported as unavailable and nothing is attempted.
 */

export type AuthAdminOutcome = "ok" | "unavailable" | "not_configured" | "failed";

function adminAuth() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }).auth.admin;
}

export function authAdminConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

/**
 * Asks Auth to send (or send again) an invitation email. "unavailable" means Auth already
 * holds a confirmed account for the address; the caller shows the same message as for a
 * sent invitation, so the page can't be used to learn which addresses have accounts.
 */
export async function sendInvitation(email: string): Promise<AuthAdminOutcome> {
  const auth = adminAuth();
  if (!auth) return "not_configured";
  try {
    const { error } = await auth.inviteUserByEmail(email);
    if (!error) return "ok";
    return error.status === 422 ? "unavailable" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Bans an invitee's account in Auth, so its invitation link and any later sign-in or
 * token refresh are refused. The user id must come from the database's revocation
 * function, never from a request. Whether the ban held is read back by the database
 * (reconcile_invitation), not taken from this result.
 */
export async function banInvitee(userId: string): Promise<AuthAdminOutcome> {
  const auth = adminAuth();
  if (!auth) return "not_configured";
  try {
    const { error } = await auth.updateUserById(userId, { ban_duration: "876000h" });
    return error ? "failed" : "ok";
  } catch {
    return "failed";
  }
}
