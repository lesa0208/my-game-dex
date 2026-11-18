"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { withParam } from "@/features/admin/form";
import { signInHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";

import { BIO_MAX, DISPLAY_NAME_MAX, normalizeBio, normalizeDisplayName, profileErrorFrom, profileProblem } from "./form";

/**
 * Saves the display name and bio (M11a-3). Runs as the person, with the publishable key,
 * so the M2 rules apply unchanged: the column grants (only these, and a few settings
 * this page doesn't send, are writable), profiles_update_own (your own row, and only
 * while the account is active) and the CHECKs and trigger on the values. Nothing here
 * uses the secret key. Errors come back as fixed codes in the page's URL, so they show
 * without JavaScript; Next.js refuses a Server Action from another site.
 */

const PROFILE = "/settings/profile";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function updateProfile(formData: FormData): Promise<void> {
  const rawName = field(formData, "display_name");
  const rawBio = field(formData, "bio");
  // Far over either limit: refused before normalizing, so nobody makes the server
  // normalize a megabyte. Within it, the exact rule decides below.
  if (rawName.length > DISPLAY_NAME_MAX * 8) redirect(withParam(PROFILE, "error", "display_name_too_long"));
  if (rawBio.length > BIO_MAX * 8) redirect(withParam(PROFILE, "error", "bio_too_long"));

  const displayName = normalizeDisplayName(rawName);
  const bio = normalizeBio(rawBio);
  const problem = profileProblem(displayName, bio);
  if (problem) redirect(withParam(PROFILE, "error", problem));

  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect(withParam(PROFILE, "error", "failed"));
  const { data: auth } = await supabase.auth.getClaims();
  const userId = auth?.claims?.sub;
  if (typeof userId !== "string") redirect(signInHref(PROFILE));

  // The id comes from the verified token, never from the form. RLS limits the update to
  // that row anyway, and returns no row when the account isn't active.
  const { data, error } = await supabase.from("profiles").update({ display_name: displayName, bio }).eq("id", userId).select("id");
  if (error) redirect(withParam(PROFILE, "error", profileErrorFrom(error)));
  if (!Array.isArray(data) || data.length !== 1) redirect(withParam(PROFILE, "error", "not_active"));

  refresh();
  redirect(withParam(PROFILE, "notice", "profile_saved"));
}
