"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";

import { exclusionErrorMessage, readExclusion, readRestoreReason } from "./form";

/**
 * Excluding a release and restoring an exclusion (M7b-2b). Each action checks the
 * session itself; the database checks the caller's role, self-review, the preview's
 * token or the exclusion's version, and every rule again. Messages are fixed: nothing
 * from the database reaches the page.
 */

export type ExclusionState = { status: "idle" | "error"; message: string | null };

const UNAVAILABLE: ExclusionState = { status: "error", message: "The catalog isn't available right now. Try again later." };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

async function signedIn() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getClaims();
  return auth?.claims?.sub ? supabase : null;
}

/** Excludes the release the form names, with the token of the preview the editor read. */
export async function excludeRelease(_state: ExclusionState, formData: FormData): Promise<ExclusionState> {
  const releaseId = field(formData, "release_id");
  const token = field(formData, "token");
  if (!UUID.test(releaseId) || !/^[0-9a-f]{32}$/.test(token)) return { status: "error", message: exclusionErrorMessage("preview stale") };
  const input = readExclusion((name) => field(formData, name), { cascade: field(formData, "needs_cascade") === "yes", copies: field(formData, "needs_copies") === "yes" });
  if ("error" in input) return { status: "error", message: input.error };

  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const { data, error } = await supabase.rpc("exclude_release", {
    p_release: releaseId,
    p_token: token,
    p_reason_code: input.value.reasonCode,
    p_reason: input.value.reason,
    p_owner_note: input.value.ownerNote,
    p_acknowledge_cascade: input.value.acknowledgeCascade,
    p_acknowledge_copies: input.value.acknowledgeCopies,
  });
  if (error) return { status: "error", message: exclusionErrorMessage(error.message) };
  const copies = typeof (data as { copies?: unknown })?.copies === "number" ? (data as { copies: number }).copies : 0;
  refresh();
  redirect(`/review/exclude/${releaseId}?notice=excluded&copies=${copies}`);
}

export async function excludeReleaseFromForm(formData: FormData): Promise<void> {
  await excludeRelease({ status: "idle", message: null }, formData);
}

/** Restores the exclusion the form names, at the version the administrator read. */
export async function restoreExclusion(_state: ExclusionState, formData: FormData): Promise<ExclusionState> {
  const id = field(formData, "exclusion_id");
  const versionText = field(formData, "version");
  const version = /^\d{1,9}$/.test(versionText) ? Number(versionText) : null;
  if (!UUID.test(id) || version === null) return { status: "error", message: exclusionErrorMessage("request conflict") };
  const reason = readRestoreReason((name) => field(formData, name));
  if ("error" in reason) return { status: "error", message: reason.error };

  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const { error } = await supabase.rpc("restore_exclusion", { p_exclusion: id, p_expected_version: version, p_reason: reason.value });
  if (error) return { status: "error", message: exclusionErrorMessage(error.message) };
  refresh();
  redirect(`/review/exclusions/${id}?notice=restored`);
}

export async function restoreExclusionFromForm(formData: FormData): Promise<void> {
  await restoreExclusion({ status: "idle", message: null }, formData);
}
