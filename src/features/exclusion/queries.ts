import "server-only";

import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";

/**
 * Exclusions (M7b-2b), read with the signed-in user's own session through the M7b-2b
 * functions, which check the caller's role themselves: editors for a preview,
 * administrators for exclusions, the owner for a preserved copy. Never cached: these
 * pages must show the records as they are now.
 */

export type ReleaseLabel = {
  id: string;
  status: string;
  game: { id: string; title: string; slug: string | null; status: string };
  platform: { id: string; slug: string; name: string };
  region: string;
  edition_name: string | null;
  variant_name: string | null;
  product_code: string | null;
};

export type CascadeEntry =
  | { entity: "game"; id: string; title: string; previous_status: string; contained: boolean }
  | { entity: "pairing"; game_id: string; platform_id: string; title: string; platform: string; previous_status: string };

export type Blocker =
  | { kind: "submission"; id: string; label: ReleaseLabel | null; request_id: string | null }
  | { kind: "merged_release"; id: string; label: ReleaseLabel | null; request_id: string | null }
  | { kind: "merged_game"; id: string; label: string | null };

export type ExclusionPreview = {
  release_id: string;
  status: string;
  release: ReleaseLabel;
  request_id: string | null;
  copies: number;
  owners: number;
  cascade: CascadeEntry[];
  blocking: Blocker[];
  own_submission: boolean;
  token: string;
};

export type ExclusionSummary = {
  id: string;
  excluded_at: string;
  reason_code: string;
  previous_status: string;
  copies_preserved: number;
  owners_affected: number;
  restored_at: string | null;
  copies_restored: number | null;
  release: ReleaseLabel;
};

export type ExclusionDetail = Omit<ExclusionSummary, "release"> & {
  version: number;
  staff_reason: string;
  owner_note: string | null;
  request_id: string | null;
  release: ReleaseLabel;
  cascade: CascadeEntry[];
  copies: { still_preserved: number; moved: number; removed: number };
  restore_reason: string | null;
  own_exclusion: boolean;
  own_submission: boolean;
  blocker: string | null;
};

/** What a preserved copy's owner reads about its excluded release (D3). */
export type PreservedRelease = {
  release: {
    id: string;
    platform: { slug: string; name: string; short_name: string };
    region: { code: string; label: string | null };
    edition_name: string | null;
    variant_name: string | null;
    local_title: string | null;
    format: { code: string | null; name: string | null };
    media_count: number | null;
    packaging: string | null;
    identifiers: { product_code: string | null; barcode: string | null };
  };
  game: { title: string; slug: string | null };
  components: { kind: string; label: string; quantity: number | null }[];
  exclusion: { reason_code: string; note: string | null; excluded_at: string } | null;
};

export type PreservedTitle = {
  title: string;
  local_title: string | null;
  platform: { slug: string; name: string; short_name: string };
  region: { code: string; label: string | null };
  edition_name: string | null;
  variant_name: string | null;
};

type Outcome<T> = { ok: true; data: T } | { ok: false; reason: "unavailable" | "refused"; message?: string };

/** The preview of excluding a release, for an editor. Refused (not permitted, or no such release) reads as `refused`. */
export async function getExclusionPreview(releaseId: string): Promise<Outcome<ExclusionPreview>> {
  if (!UUID.test(releaseId)) return { ok: false, reason: "refused", message: "release unavailable" };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc("get_exclusion_preview", { p_release: releaseId });
  if (error) return error.code === "P0001" || error.code === "42501" ? { ok: false, reason: "refused", message: error.message } : { ok: false, reason: "unavailable" };
  return { ok: true, data: data as ExclusionPreview };
}

/** Exclusions, newest first, for an administrator; `refused` for anyone else. */
export async function getExclusions(status: "active" | "restored", after: string | null): Promise<Outcome<{ items: ExclusionSummary[]; next: string | null }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc("get_exclusions", { p_status: status, p_after: after && UUID.test(after) ? after : null, p_limit: 50 });
  if (error) return error.code === "42501" ? { ok: false, reason: "refused" } : { ok: false, reason: "unavailable" };
  return { ok: true, data: data as { items: ExclusionSummary[]; next: string | null } };
}

/** One exclusion for an administrator: null when there's none, `refused` for anyone else. */
export async function getExclusion(id: string): Promise<Outcome<ExclusionDetail | null>> {
  if (!UUID.test(id)) return { ok: true, data: null };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc("get_exclusion", { p_exclusion: id });
  if (error) return error.code === "42501" ? { ok: false, reason: "refused" } : { ok: false, reason: "unavailable" };
  return { ok: true, data: typeof data === "object" && data !== null ? (data as ExclusionDetail) : null };
}

/** What the owner may read about their preserved copy's release, or null. */
export async function getMyPreservedRelease(itemId: string): Promise<PreservedRelease | null> {
  if (!UUID.test(itemId)) return null;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_my_preserved_release", { p_item: itemId });
  return !error && typeof data === "object" && data !== null ? (data as PreservedRelease) : null;
}

/** Titles of the owner's preserved copies in a list, by copy id. */
export async function getMyPreservedTitles(itemIds: string[]): Promise<Map<string, PreservedTitle>> {
  const ids = itemIds.filter((id) => UUID.test(id)).slice(0, 100);
  if (!ids.length) return new Map();
  const supabase = await createSupabaseServerClient();
  if (!supabase) return new Map();
  const { data, error } = await supabase.rpc("get_my_preserved_titles", { p_items: ids });
  if (error || typeof data !== "object" || data === null) return new Map();
  return new Map(Object.entries(data as Record<string, PreservedTitle>));
}

/** Whether the signed-in user is an active administrator, who may see and restore exclusions. */
export async function isAdministrator(): Promise<boolean> {
  const outcome = await getExclusions("active", null);
  return outcome.ok;
}
