"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import type { FormState } from "@/features/auth/actions";
import { signInHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";

import { passwordProblem } from "./form";

/**
 * The invitee's side of M11a-1: accepting an invitation and setting a password. Both
 * return or redirect with fixed messages only; nothing Auth or the database says, and
 * never a token, reaches the page or a log.
 */

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Verifies an invitation link's token, which only this POST does: the confirmation page's
 * GET shows a button and uses nothing, so a mail scanner fetching the link can't spend the
 * single-use token. Verifying signs the invitee in (cookies set by the server client).
 */
export async function acceptInvitation(formData: FormData): Promise<void> {
  const tokenHash = field(formData, "token_hash");
  if (field(formData, "type") !== "invite" || !/^[A-Za-z0-9_-]{10,200}$/.test(tokenHash)) redirect("/auth/confirm?status=invalid");
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/auth/confirm?status=unavailable");
  const { error } = await supabase.auth.verifyOtp({ type: "invite", token_hash: tokenHash });
  if (error) redirect("/auth/confirm?status=invalid");
  refresh();
  redirect("/welcome/password");
}

/**
 * Sets the invitee's password, then has the database record it, which it believes only
 * from Auth's own log of the change. Safe to repeat: if the password was set but the
 * record wasn't, submitting the same password again ("same password" from Auth) just
 * records it. A revoked invitation can't continue.
 */
export async function setInvitationPassword(_state: FormState, formData: FormData): Promise<FormState> {
  const password = field(formData, "password");
  const problem = passwordProblem(password, field(formData, "confirm"));
  if (problem) return { error: problem };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "Setting a password isn't available right now. Try again later." };
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) redirect(signInHref("/welcome/password"));

  const { data: state } = await supabase.rpc("get_my_onboarding");
  if ((state as { revoked?: boolean } | null)?.revoked === true) return { error: "This invitation was revoked, so the account can't be set up." };

  const { error } = await supabase.auth.updateUser({ password });
  if (error && error.code !== "same_password") {
    if (error.code === "weak_password") return { error: "That password is too weak. Use a longer one, or mix in more kinds of characters." };
    if (error.code === "reauthentication_needed") return { error: "This session is too old to set a password. Open your invitation link again, or ask for a new one." };
    return { error: "Your password couldn't be saved. Try again." };
  }
  const { data, error: recordError } = await supabase.rpc("complete_my_password_setup");
  const result = data as { ok?: boolean; refusal?: string } | null;
  if (recordError || result?.ok !== true) {
    if (result?.refusal === "invitation_revoked") return { error: "This invitation was revoked, so the account can't be set up." };
    return { error: "Your password was saved, but this step didn't finish. Submit it again." };
  }
  refresh();
  redirect("/welcome");
}
