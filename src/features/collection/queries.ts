import "server-only";

import { createSupabaseServerClient } from "@/features/auth/server";

import type { CollectionParams } from "./list-params";
import type { CollectionPage, CollectionSummary, CopyDetail, SiblingCopy } from "./types";
import { UUID } from "./uuid";

/**
 * The signed-in user's own collection data, read with their session through the M6b
 * functions and the owner-only policies, which run with the user's rights. Per user
 * and per request: never cached, and never rendered on a public page.
 */

export const PAGE_SIZE = 50;

export type CollectionOutcome<T> = { ok: true; data: T } | { ok: false; reason: "unavailable" | "invalid_cursor" };

const unavailable = { ok: false, reason: "unavailable" } as const;

/** How many copies of a release the signed-in user has, or null if it can't be read. */
export async function getMyReleaseCopyCount(releaseId: string): Promise<number | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_my_release_copies", { p_release: releaseId });
  if (error || typeof data !== "object" || data === null) return null;
  const count = (data as { count?: unknown }).count;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

/** The currency the user chose as their default in preferences (M2), if any. */
export async function getMyDefaultCurrency(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.from("user_preferences").select("default_currency").maybeSingle();
  const value = (data as { default_currency?: unknown } | null)?.default_currency;
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
}

export async function getMyCollectionSummary(): Promise<CollectionOutcome<CollectionSummary>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return unavailable;
  const { data, error } = await supabase.rpc("get_my_collection_summary");
  if (error || typeof data !== "object" || data === null) return unavailable;
  return { ok: true, data: data as CollectionSummary };
}

/** One page of the user's copies. Filtering, sorting and paging all happen in the database. */
export async function getMyCollection(params: CollectionParams): Promise<CollectionOutcome<CollectionPage>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return unavailable;
  const { data, error } = await supabase.rpc("get_my_collection", {
    p_query: params.query || null,
    p_platform: params.platform,
    p_completeness: params.completeness,
    p_status: params.status,
    p_sort: params.sort,
    p_limit: PAGE_SIZE,
    p_cursor: params.cursor,
  });
  if (error) return { ok: false, reason: error.message === "invalid cursor" ? "invalid_cursor" : "unavailable" };
  if (typeof data !== "object" || data === null || !Array.isArray((data as CollectionPage).items)) return unavailable;
  return { ok: true, data: data as CollectionPage };
}

/** A copy's place among the user's copies of its release, oldest first: "Copy 2 of 3". */
export type CopyNumber = { number: number; total: number };

/**
 * Numbers the copies on a page that share a release with others. One query reads every
 * copy of the page's shared releases, through the owner-only policy, and both numbers
 * of "Copy 2 of 3" come from it, so they always agree. Numbering is by date added, so
 * it's the same whatever the sort, filters or page. If the releases have more copies
 * than one query reads, nothing is numbered: the list then says "N copies of this
 * release" instead of a number that might be wrong.
 */
export async function getCopyNumbers(items: { id: string; release: { id: string } | null; copies_of_release: number }[]): Promise<Map<string, CopyNumber>> {
  const numbers = new Map<string, CopyNumber>();
  const shared = [...new Set(items.filter((i) => i.release && i.copies_of_release > 1).map((i) => i.release!.id))];
  if (!shared.length) return numbers;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return numbers;
  // At most this many rows are read. The API may return fewer than asked for (its own
  // row cap), so the result counts as complete only when the database's exact count of
  // matching rows equals the rows that arrived.
  const LIMIT = 1000;
  const { data, error, count } = await supabase
    .from("collection_items")
    .select("id, release_id", { count: "exact" })
    .in("release_id", shared)
    .order("created_at")
    .order("id")
    .limit(LIMIT);
  if (error || !data || count === null || count !== data.length) return numbers;
  const rows = data as { id: string; release_id: string }[];
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.release_id, (totals.get(row.release_id) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const row of rows) {
    const number = (seen.get(row.release_id) ?? 0) + 1;
    seen.set(row.release_id, number);
    numbers.set(row.id, { number, total: totals.get(row.release_id)! });
  }
  return numbers;
}

/** One of the user's copies in full, or null when there's no such copy of theirs. */
export async function getMyCopy(itemId: string): Promise<CollectionOutcome<CopyDetail | null>> {
  if (!UUID.test(itemId)) return { ok: true, data: null };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return unavailable;
  const { data, error } = await supabase.rpc("get_my_collection_item", { p_item: itemId });
  if (error) return unavailable;
  return { ok: true, data: typeof data === "object" && data !== null ? (data as CopyDetail) : null };
}

/**
 * The user's copies of a release, newest first (up to 100), each with its number:
 * the oldest copy is copy 1.
 */
export async function getMyReleaseCopies(releaseId: string): Promise<{ count: number; copies: (SiblingCopy & { number: number })[] } | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_my_release_copies", { p_release: releaseId });
  if (error || typeof data !== "object" || data === null) return null;
  const { count, copies } = data as { count: number; copies: SiblingCopy[] };
  return { count, copies: copies.map((copy, index) => ({ ...copy, number: count - index })) };
}

/** The category of a media format ("cartridge", "optical_disc"), from the public reference data. */
export async function getMediaCategory(code: string | null): Promise<string | null> {
  if (!code) return null;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.from("media_formats").select("category").eq("code", code).maybeSingle();
  const category = (data as { category?: unknown } | null)?.category;
  return typeof category === "string" ? category : null;
}
