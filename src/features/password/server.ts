import "server-only";

import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { AUTH_COOKIE_OPTIONS, supabaseConfig } from "@/features/auth/cookies";

import { RECOVERY_COOKIE, RECOVERY_WINDOW_SECONDS, recoveryState } from "./form";

/**
 * Server-only pieces of password recovery and account security (M11a-2). Everything here
 * uses the publishable key, as the person themselves: never the secret key or the Auth
 * Admin API, so nothing can skip what Auth requires of a reset or a change.
 */

/**
 * A one-off Auth client that keeps nothing: no cookies, no storage, no refresh. Used to
 * ask for a reset email (so a signed-out visitor gets no cookie) and to check a current
 * password without touching the signed-in session.
 */
function detachedClient() {
  const config = supabaseConfig();
  if (!config) return null;
  return createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "implicit" },
  });
}

/** Asks Auth to send a reset email. The outcome isn't returned: it would tell who has an account. */
export async function requestResetEmail(email: string): Promise<void> {
  const client = detachedClient();
  if (!client) return;
  try {
    // The link comes from the recovery email template (supabase/templates/recovery.html).
    await client.auth.resetPasswordForEmail(email);
  } catch {
    // Same answer as success.
  }
}

/**
 * Whether `password` is this account's current password: a password sign-in in a detached
 * client, whose session is ended at once. Changing the password would end it anyway, as
 * Auth ends every other session; this also ends it when the change doesn't happen.
 */
export async function checkCurrentPassword(email: string, password: string): Promise<"ok" | "wrong" | "too_many" | "unavailable"> {
  const client = detachedClient();
  if (!client) return "unavailable";
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (data.session) await client.auth.signOut({ scope: "local" }).catch(() => undefined);
  if (!error && data.session) return "ok";
  if (error?.status === 429) return "too_many";
  if (error?.code === "invalid_credentials" || (error?.status && error.status < 500)) return "wrong";
  return "unavailable";
}

/** Notes in this browser that the session `sessionId` came from opening a reset link. */
export async function markRecovery(sessionId: string): Promise<void> {
  (await cookies()).set(RECOVERY_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: AUTH_COOKIE_OPTIONS.secure,
    maxAge: RECOVERY_WINDOW_SECONDS,
  });
}

export async function recoveryMark(): Promise<string | null> {
  return (await cookies()).get(RECOVERY_COOKIE)?.value ?? null;
}

export async function clearRecovery(): Promise<void> {
  (await cookies()).delete(RECOVERY_COOKIE);
}

/** Whether the signed-in session may choose a new password now: see recoveryState. */
export async function currentRecovery(claims: Parameters<typeof recoveryState>[0]): Promise<ReturnType<typeof recoveryState>> {
  return recoveryState(claims, await recoveryMark(), Math.floor(Date.now() / 1000));
}
