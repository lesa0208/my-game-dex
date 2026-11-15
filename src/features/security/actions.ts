"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { withParam } from "@/features/admin/form";
import { safeNextPath, signInHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";

import { authErrorCode, readCode, readFactorName } from "./form";

/**
 * Settings → Security (M8d): TOTP through Supabase Auth, and the step-up verification
 * staff actions ask for. Auth verifies every code; nothing here replaces it. After
 * each verification the factors are registered (register_my_verified_factors), which
 * starts their 24-hour maturity for Owner authority (D13).
 *
 * The secret of a new factor is returned once, to the enrollment form that asked for
 * it, so it can be scanned or typed. It never goes into a URL, a cookie, a log or the
 * database's own tables.
 */

const SECURITY = "/settings/security";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

async function signedInClient(back: string) {
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect(withParam(back, "error", "unavailable"));
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) redirect(signInHref(back));
  return supabase;
}

export type EnrollState =
  | { status: "idle" | "error"; message: string | null }
  | { status: "enrolled"; factorId: string; qrCode: string; secret: string; name: string };

const ENROLL_ERRORS: Record<string, string> = {
  name_taken: "You already have an authenticator with that name. Choose another name.",
  verify_first: "Verify with an authenticator you already have before adding another.",
  invalid_input: "Give the authenticator a name of up to 40 characters.",
  unavailable: "Two-step verification isn't available right now. Try again later.",
  failed: "It couldn't be set up. Try again.",
};

/** Starts enrolling a TOTP factor and returns its QR code and secret to the form, once. */
export async function enrollFactor(_state: EnrollState, formData: FormData): Promise<EnrollState> {
  const name = readFactorName(field(formData, "name"));
  if (!name) return { status: "error", message: ENROLL_ERRORS.invalid_input };
  const supabase = await signedInClient(SECURITY);
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: name });
  if (error || !data || data.type !== "totp") return { status: "error", message: ENROLL_ERRORS[authErrorCode(error)] ?? ENROLL_ERRORS.failed };
  return { status: "enrolled", factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret, name };
}

/** Verifies a new factor with its first code, then registers it. */
export async function verifyEnrollment(formData: FormData): Promise<void> {
  const factorId = field(formData, "factor_id");
  const code = readCode(field(formData, "code"));
  if (!UUID.test(factorId) || !code) redirect(withParam(SECURITY, "error", "invalid_code"));
  const supabase = await signedInClient(SECURITY);
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) redirect(withParam(SECURITY, "error", authErrorCode(error)));
  // The session is now aal2: its first registration can't come earlier than this.
  await supabase.rpc("register_my_verified_factors");
  refresh();
  redirect(withParam(SECURITY, "notice", "verified"));
}

/**
 * A fresh verification with an existing factor (step-up), then back to `next`, where
 * the member submits their action again. Also how a session reaches aal2 after
 * signing in with a password.
 */
export async function verifyStepUp(formData: FormData): Promise<void> {
  const next = safeNextPath(field(formData, "next"), SECURITY);
  const here = `/settings/security/verify?next=${encodeURIComponent(next)}`;
  const factorId = field(formData, "factor_id");
  const code = readCode(field(formData, "code"));
  if (!UUID.test(factorId) || !code) redirect(withParam(here, "error", "invalid_code"));
  const supabase = await signedInClient(here);
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) redirect(withParam(here, "error", authErrorCode(error)));
  await supabase.rpc("register_my_verified_factors");
  refresh();
  redirect(next);
}

/**
 * Removes a factor. Auth requires an aal2 session for a verified one. Staff can't
 * remove their last verified factor here, which would end their staff access; the
 * database doesn't depend on this, it simply refuses staff without one.
 */
export async function removeFactor(formData: FormData): Promise<void> {
  const factorId = field(formData, "factor_id");
  if (!UUID.test(factorId)) redirect(withParam(SECURITY, "error", "invalid_input"));
  if (field(formData, "confirm") !== "yes") redirect(withParam(SECURITY, "error", "confirm_removal"));
  const supabase = await signedInClient(SECURITY);
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError || !factors) redirect(withParam(SECURITY, "error", "failed"));
  const target = factors.all.find((f) => f.id === factorId);
  if (!target) redirect(withParam(SECURITY, "error", "invalid_input"));
  if (target.status === "verified" && factors.totp.length <= 1) {
    const { data: access } = await supabase.rpc("get_my_admin_access");
    if (Array.isArray((access as { roles?: unknown } | null)?.roles) && ((access as { roles: unknown[] }).roles.length > 0)) {
      redirect(withParam(SECURITY, "error", "last_factor"));
    }
  }
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) redirect(withParam(SECURITY, "error", authErrorCode(error)));
  refresh();
  redirect(withParam(SECURITY, "notice", "removed"));
}
