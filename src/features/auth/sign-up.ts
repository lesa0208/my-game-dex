"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { newPasswordProblem, passwordError, readEmail, TOKEN_HASH } from "@/features/password/form";

import type { FormState } from "./actions";
import { selfRegistrationOpen } from "./registration";
import { createSupabaseServerClient } from "./server";

/**
 * Self-registration (M16), where this server allows it (features/auth/registration.ts), and the
 * confirmation of a new account's email. Both use Supabase Auth as sign-in does: no second
 * account system. Every answer is a fixed message: nothing Auth says reaches the page.
 *
 * - The action checks the server's own setting itself, so a request to it where self-registration
 *   isn't open is refused before Auth is asked, whatever page sent it.
 * - The same rules as every other new password: at least 12 characters, at most 72 bytes, typed
 *   twice (features/password/form.ts), and Auth's own checks after them.
 * - The email must be confirmed before the account can sign in (Auth's enable_confirmations).
 * - Whether an address already has an account is never said: a new address, an unconfirmed one
 *   (Auth sends its link again) and a confirmed one all get the same answer, after the same
 *   minimum time, and the existing account is unchanged.
 * - A new account is an ordinary collector's: no staff role, no Owner (the database's
 *   handle_new_user makes only its profile and preferences).
 */

/** Every sign-up answer takes at least this long, whatever happened, so its timing tells nothing. */
const SIGN_UP_MIN_MS = 800;
const CLOSED = "Accounts are invitation only here.";
const UNAVAILABLE = "Creating an account isn't available right now. Try again later.";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function signUp(_state: FormState, formData: FormData): Promise<FormState> {
  if (!selfRegistrationOpen()) return { error: CLOSED };
  const email = readEmail(field(formData, "email"));
  if (!email) return { error: passwordError("invalid_email") };
  const problem = newPasswordProblem(field(formData, "password"), field(formData, "confirm"));
  if (problem) return { error: passwordError(problem) };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: UNAVAILABLE };
  const { data: current } = await supabase.auth.getClaims();
  if (current?.claims?.sub) return { error: "You're signed in. Sign out first to create another account." };

  const started = Date.now();
  const { error } = await supabase.auth.signUp({ email, password: field(formData, "password") });
  const rest = SIGN_UP_MIN_MS - (Date.now() - started);
  if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
  if (error) {
    if (error.code === "weak_password") return { error: passwordError("weak_password") };
    if (error.code === "email_address_invalid") return { error: passwordError("invalid_email") };
    if (error.code === "signup_disabled") return { error: CLOSED };
    if (error.status === 429 || error.code === "over_email_send_rate_limit" || error.code === "over_request_rate_limit") return { error: passwordError("too_many") };
    // An address that already has an account gets the same answer as a new one.
    if (error.code !== "user_already_exists" && error.code !== "email_exists") return { error: UNAVAILABLE };
  }
  redirect("/sign-up?status=sent");
}

/**
 * Verifies a new account's confirmation link, which only this POST does: the confirmation page's
 * GET shows a button and spends nothing, so a mail scanner fetching the link can't use the
 * single-use token (as for invitations and password resets). Whoever is signed in on this device
 * is signed out first. Confirming signs the new collector in; they choose their handle next.
 */
export async function confirmSignUp(formData: FormData): Promise<void> {
  const tokenHash = field(formData, "token_hash");
  const invalid = "/auth/confirm?type=email&status=invalid";
  if (field(formData, "type") !== "email" || !TOKEN_HASH.test(tokenHash)) redirect(invalid);
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/auth/confirm?type=email&status=unavailable");
  const { data: before } = await supabase.auth.getClaims();
  if (before?.claims?.sub) await supabase.auth.signOut({ scope: "local" });
  const { error } = await supabase.auth.verifyOtp({ type: "email", token_hash: tokenHash });
  if (error) {
    refresh();
    redirect(invalid);
  }
  refresh();
  redirect("/welcome");
}
