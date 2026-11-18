"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { withParam } from "@/features/admin/form";
import { signInHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";

import { newPasswordProblem, passwordErrorCode, readEmail, TOKEN_HASH } from "./form";
import { checkCurrentPassword, clearRecovery, currentRecovery, markRecovery, requestResetEmail } from "./server";

/**
 * Password recovery, changing a password and signing out everywhere (M11a-2). Every
 * action runs as the person, with the publishable key, so Auth applies its own rules:
 * single-use, hour-long reset links; a TOTP-verified (aal2) session to change the
 * password of an account with an authenticator; a recent sign-in for a change. The
 * pages see fixed codes only; nothing from Auth, and never a token, reaches a page, a
 * URL after the link itself, or a log. Next.js refuses a Server Action from another site.
 */

const FORGOT = "/forgot-password";
const RESET = "/reset-password";
const ACCOUNT = "/settings/account";

/** How long asking for a reset email takes at least, so an address with an account answers no slower. */
const RESET_REQUEST_MIN_MS = 2000;

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

const verifyHref = (next: string) => `/settings/security/verify?next=${encodeURIComponent(next)}`;

/** Whether this session must still verify an authenticator (it has one, and isn't aal2). */
async function needsAuthenticator(supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>): Promise<boolean> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return true;
  return data.nextLevel === "aal2" && data.currentLevel !== "aal2";
}

/**
 * Asks for a reset email. The answer is the same whatever happens: an address with an
 * account, one without, one asked for a minute ago (Auth's per-address limit), a banned
 * account, or Auth failing to send. Only a malformed address is told so.
 */
export async function requestPasswordReset(formData: FormData): Promise<void> {
  const email = readEmail(field(formData, "email"));
  if (!email) redirect(withParam(FORGOT, "error", "invalid_email"));
  const started = Date.now();
  await requestResetEmail(email);
  const rest = RESET_REQUEST_MIN_MS - (Date.now() - started);
  if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
  redirect(`${FORGOT}?status=sent`);
}

/**
 * Verifies a reset link's token, which only this POST does (the link's GET shows a button
 * and spends nothing, so a mail scanner can't use it). Whoever is signed in here is signed
 * out first, so a link can't quietly carry on in someone else's session, and the reset is
 * tied to the new session and this browser.
 */
export async function verifyRecovery(formData: FormData): Promise<void> {
  const tokenHash = field(formData, "token_hash");
  const invalid = "/auth/confirm?type=recovery&status=invalid";
  if (field(formData, "type") !== "recovery" || !TOKEN_HASH.test(tokenHash)) redirect(invalid);
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/auth/confirm?type=recovery&status=unavailable");
  const { data: before } = await supabase.auth.getClaims();
  if (before?.claims?.sub) await supabase.auth.signOut({ scope: "local" });
  await clearRecovery();

  const { error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
  if (error) {
    refresh();
    redirect(invalid);
  }
  const { data: after } = await supabase.auth.getClaims();
  const sessionId = after?.claims?.session_id;
  if (typeof sessionId !== "string") redirect(invalid);
  await markRecovery(sessionId);
  refresh();
  redirect(RESET);
}

/**
 * Chooses a new password with a reset link's session. The database isn't asked: Auth
 * checks the session, and requires aal2 when the account has an authenticator (checked
 * here first, to send the person to verify). Auth ends every other session. Problems
 * come back as a fixed code in the URL, so the page shows them without JavaScript.
 */
export async function resetPassword(formData: FormData): Promise<void> {
  const password = field(formData, "password");
  const problem = newPasswordProblem(password, field(formData, "confirm"));
  if (problem) redirect(withParam(RESET, "error", problem));
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect(withParam(RESET, "error", "unavailable"));
  const { data: auth } = await supabase.auth.getClaims();
  if ((await currentRecovery(auth?.claims)) !== "ok") redirect(RESET);
  if (await needsAuthenticator(supabase)) redirect(verifyHref(RESET));

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    const code = passwordErrorCode(error);
    if (code === "verify_first") redirect(verifyHref(RESET));
    redirect(withParam(RESET, "error", code === "reauthenticate" ? "failed" : code));
  }
  await clearRecovery();
  refresh();
  const { data: account } = await supabase.rpc("get_my_account");
  const handle = (Array.isArray(account) ? account[0] : null) as { handle?: string | null } | null;
  redirect(handle?.handle ? withParam(ACCOUNT, "notice", "password_reset") : "/welcome");
}

/**
 * Changes the password of the signed-in account: the current password first, checked in
 * a detached session, then Auth's own rules (aal2 with an authenticator; a sign-in in
 * the last day, or it asks to sign in again). Auth ends every other session.
 */
export async function changePassword(formData: FormData): Promise<void> {
  const current = field(formData, "current_password");
  const password = field(formData, "password");
  if (!current || current.length > 1024) redirect(withParam(ACCOUNT, "error", "current_required"));
  const problem = newPasswordProblem(password, field(formData, "confirm"));
  if (problem) redirect(withParam(ACCOUNT, "error", problem));
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect(withParam(ACCOUNT, "error", "unavailable"));
  const { data: auth } = await supabase.auth.getClaims();
  const email = auth?.claims?.email;
  if (!auth?.claims?.sub) redirect(signInHref(ACCOUNT));
  if (typeof email !== "string" || !email) redirect(withParam(ACCOUNT, "error", "failed"));
  if (await needsAuthenticator(supabase)) redirect(verifyHref(ACCOUNT));

  const checked = await checkCurrentPassword(email, current);
  if (checked !== "ok") redirect(withParam(ACCOUNT, "error", checked === "wrong" ? "wrong_password" : checked));

  // The current password goes to Auth too, so the change still works once hosted Auth
  // requires it ("require current password"), and Auth, not only this page, checks it.
  // With the setting off Auth ignores it (auth-password-policy-checks.mjs).
  const { error } = await supabase.auth.updateUser({ password, current_password: current });
  if (error) {
    const code = passwordErrorCode(error);
    if (code === "verify_first") redirect(verifyHref(ACCOUNT));
    redirect(withParam(ACCOUNT, "error", code));
  }
  refresh();
  redirect(withParam(ACCOUNT, "notice", "password_changed"));
}

/** Signs out here, and asks to sign in again, back to the account page (a stale session can't change the password). */
export async function signInAgain(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (supabase) await supabase.auth.signOut({ scope: "local" });
  refresh();
  redirect(signInHref(ACCOUNT));
}

/**
 * Ends every session of this account in Auth, this one included: no device can refresh
 * afterwards. Since the session-revocation checkpoint, an access token already issued
 * reaches no protected data either: the database checks the session is still Auth's.
 */
export async function signOutEverywhere(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect(withParam(ACCOUNT, "error", "unavailable"));
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) redirect(signInHref(ACCOUNT));
  const { error } = await supabase.auth.signOut({ scope: "global" });
  if (error) redirect(withParam(ACCOUNT, "error", "unavailable"));
  await clearRecovery();
  refresh();
  redirect("/sign-in?notice=signed_out_everywhere");
}
