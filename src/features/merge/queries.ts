import "server-only";

import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";
import type { ReleaseLabel } from "@/features/exclusion/queries";

/**
 * Merges (M7b-2c), read with the signed-in user's own session through the M7b-2c
 * functions, which check the caller's role themselves: editors for previews and
 * history, the submitter for their merged submission. Never cached: these pages must
 * show the records as they are now.
 */

export type MergeDifference = { field: string; source: unknown; target: unknown; critical: boolean };

export type MergePreview = {
  source_id: string;
  target_id: string;
  kind: "published" | "submission" | "unpublished";
  source: ReleaseLabel;
  target: ReleaseLabel;
  request_id: string | null;
  differences: MergeDifference[];
  blocking: { kind: string }[];
  retire: { id: string; previous_status: string; status: string } | null;
  repoint_releases: string[];
  repoint_requests: string[];
  references: { id: string; provider_code: string; entity_type: string; external_id: string; target_had_provider: boolean }[];
  copies: number;
  owners: number;
  token: string;
  requires_admin: boolean;
  own_submission: boolean;
};

export type MergeCandidate = ReleaseLabel & { same_game: boolean; same_code: boolean };

export type MergeSummary = {
  id: string;
  kind: string;
  merged_at: string;
  copies_moved: number;
  owners_affected: number;
  source: ReleaseLabel;
  target: ReleaseLabel;
};

export type MergeDetail = MergeSummary & {
  merged_by: string | null;
  staff_reason: string;
  owner_note: string | null;
  previous_status: string;
  request_id: string | null;
  differences: MergeDifference[];
  repointed_releases: string[];
  repointed_requests: string[];
  retired_game: { id: string; previous_status: string; status: string } | null;
  references: { provider_code: string; entity_type: string; external_id: string; target_had_provider: boolean }[];
  references_moved: number;
};

type Outcome<T> = { ok: true; data: T } | { ok: false; reason: "unavailable" | "refused"; message?: string };

function refusal(error: { code?: string; message: string }): Outcome<never> {
  return error.code === "P0001" || error.code === "42501" ? { ok: false, reason: "refused", message: error.message } : { ok: false, reason: "unavailable" };
}

/** The preview of merging source into target, for an editor. */
export async function getMergePreview(source: string, target: string): Promise<Outcome<MergePreview>> {
  if (!UUID.test(source)) return { ok: false, reason: "refused", message: "release unavailable" };
  if (!UUID.test(target)) return { ok: false, reason: "refused", message: "target unavailable" };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc("get_merge_preview", { p_source: source, p_target: target });
  if (error) return refusal(error);
  return { ok: true, data: data as MergePreview };
}

/** Published releases a source could be merged into, for an editor. */
export async function getMergeCandidates(source: string): Promise<Outcome<MergeCandidate[]>> {
  if (!UUID.test(source)) return { ok: false, reason: "refused", message: "release unavailable" };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc("get_merge_candidates", { p_source: source });
  if (error) return refusal(error);
  return { ok: true, data: Array.isArray(data) ? (data as MergeCandidate[]) : [] };
}

/** Merges, newest first, for an editor; `refused` for anyone else. */
export async function getMerges(after: string | null): Promise<Outcome<{ items: MergeSummary[]; next_after: string | null }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc("get_merges", { p_after: after && UUID.test(after) ? after : null, p_limit: 50 });
  if (error) return refusal(error);
  return { ok: true, data: data as { items: MergeSummary[]; next_after: string | null } };
}

/** One merge for an editor: null when there's none. */
export async function getMerge(id: string): Promise<Outcome<MergeDetail | null>> {
  if (!UUID.test(id)) return { ok: true, data: null };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc("get_merge", { p_merge: id });
  if (error) return refusal(error);
  return { ok: true, data: typeof data === "object" && data !== null ? (data as MergeDetail) : null };
}

/** Where the signed-in submitter's merged submission went, while that release is public. */
export async function getMyMergedSubmission(submissionId: string): Promise<{ release_id: string; game_slug: string } | null> {
  if (!UUID.test(submissionId)) return null;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_my_merged_submission", { p_submission: submissionId });
  return !error && typeof data === "object" && data !== null ? (data as { release_id: string; game_slug: string }) : null;
}

/** Copies of the signed-in owner's that merges moved in the last 30 days, from their notifications. */
export async function getMyRecentMergedCopies(): Promise<number> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return 0;
  const { data, error } = await supabase.rpc("get_my_notifications", { p_limit: 100 });
  if (error || !Array.isArray(data)) return 0;
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return (data as { type: string; created_at: string; read_at: string | null; data: { copies?: unknown } }[])
    .filter((n) => n.type === "catalog_merge" && !n.read_at && Date.parse(n.created_at) >= since)
    .reduce((sum, n) => sum + (typeof n.data?.copies === "number" ? n.data.copies : 0), 0);
}
