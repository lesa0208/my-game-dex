"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";

import { mergeErrorMessage, readFieldList, readMerge } from "./form";

/**
 * Merging a release (M7b-2c). The action checks the session itself; the database
 * checks the caller's role, self-review, the preview's token, every acknowledged
 * difference and every rule again. Messages are fixed: nothing from the database
 * reaches the page.
 */

export type MergeState = { status: "idle" | "error"; message: string | null };

const UNAVAILABLE: MergeState = { status: "error", message: "The catalog isn't available right now. Try again later." };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Merges the source into the target the form names, with the token of the preview the editor read. */
export async function mergeRelease(_state: MergeState, formData: FormData): Promise<MergeState> {
  const source = field(formData, "source_id");
  const target = field(formData, "target_id");
  const token = field(formData, "token");
  if (!UUID.test(source) || !UUID.test(target) || !/^[0-9a-f]{32}$/.test(token)) return { status: "error", message: mergeErrorMessage("preview stale") };
  const input = readMerge((name) => field(formData, name), { fields: readFieldList(field(formData, "fields")), copies: field(formData, "needs_copies") === "yes" });
  if ("error" in input) return { status: "error", message: input.error };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return UNAVAILABLE;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return UNAVAILABLE;
  const { data, error } = await supabase.rpc("merge_release", {
    p_source: source,
    p_target: target,
    p_token: token,
    p_reason: input.value.reason,
    p_owner_note: input.value.ownerNote,
    p_acknowledged: input.value.acknowledged,
    p_acknowledge_copies: input.value.acknowledgeCopies,
  });
  if (error) return { status: "error", message: mergeErrorMessage(error.message) };
  const id = (data as { merge_id?: unknown })?.merge_id;
  if (typeof id !== "string" || !UUID.test(id)) return { status: "error", message: mergeErrorMessage(null) };
  refresh();
  redirect(`/review/merges/${id}?notice=merged`);
}

export async function mergeReleaseFromForm(formData: FormData): Promise<void> {
  await mergeRelease({ status: "idle", message: null }, formData);
}
