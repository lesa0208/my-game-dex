import "server-only";

import { createSupabaseServerClient } from "@/features/auth/server";
import type { CatalogDate } from "@/features/catalog/types";
import { UUID } from "@/features/collection/uuid";

import type { HistoryEvent, SearchParams } from "./form";

/**
 * Catalog records for staff (M10b), read with the staff member's own session through
 * the M10b functions, which check the caller themselves: catalog editors and
 * administrators only, with a verified session. Never cached: these pages show the
 * records as they are now.
 */

type Outcome<T> = { ok: true; data: T } | { ok: false; reason: "unavailable" | "refused"; message?: string };

function failure(error: { code?: string; message: string }): Outcome<never> {
  return error.code === "P0001" || error.code === "42501" || error.code === "22023"
    ? { ok: false, reason: "refused", message: error.message }
    : { ok: false, reason: "unavailable" };
}

type Platform = { slug: string; name: string; short_name: string };
type Region = { code: string; label: string };

export type ReleaseSummary = {
  id: string;
  game: { id: string; title: string; status: string } | null;
  platform: Platform | null;
  region: Region | null;
  edition_name: string | null;
  variant_name: string | null;
  product_code: string | null;
  format: string | null;
  status: string;
  verified: boolean;
  merged_into_id: string | null;
};

export type GameSummary = {
  id: string;
  title: string;
  kind: string;
  slug: string | null;
  status: string;
  verified: boolean;
  merged_into_id: string | null;
  first_release: CatalogDate | null;
  platforms: string[];
  releases: { total: number; published: number };
};

export type SearchResult =
  | { status: "ok"; kind: "games"; items: GameSummary[]; next_cursor: string | null }
  | { status: "ok"; kind: "releases"; items: ReleaseSummary[]; next_cursor: string | null }
  | { status: "too_short" | "unknown_platform"; kind: SearchParams["kind"]; items: []; next_cursor: null };

/** One page of games or releases, any status. */
export async function searchCatalogRecords(p: SearchParams): Promise<Outcome<SearchResult>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc("search_catalog_records", {
    p_kind: p.kind,
    p_query: p.query || null,
    p_platform: p.platform,
    p_status: p.status,
    p_limit: 25,
    p_cursor: p.cursor,
  });
  if (error) return failure(error);
  const d = data as { status: SearchResult["status"]; items: unknown[]; next_cursor: string | null };
  return { ok: true, data: { ...d, kind: p.kind } as SearchResult };
}

export type SourceReference = { provider: string; external_id: string };
export type FieldLock = { field: string; locked_at: string };
export type LinkedSubmission = { id: string; kind: string; status: string; created_at: string };

/**
 * What the caller may do with a record (M10c), naming nobody: how it came to exist,
 * whether the caller created or verified it, and whether its verification matches the
 * record as it is.
 */
export type RecordReview = { origin: "staff" | "submission" | "import" | "system" | "unknown"; you_created: boolean; you_verified: boolean; verification_current: boolean };

export type GameRecord = {
  id: string;
  slug: string | null;
  title: string;
  sort_title: string;
  kind: string;
  summary: string | null;
  first_release: CatalogDate | null;
  status: string;
  verified_at: string | null;
  revision: number;
  review: RecordReview;
  created_at: string;
  updated_at: string;
  merged_into: { id: string; title: string; status: string } | null;
  aliases: { id: string; title: string; kind: string; language_code: string | null; region_code: string | null }[];
  platforms: (Platform & { status: string })[];
  relations: { direction: "outgoing" | "incoming"; relation: string; position: number | null; game: { id: string; title: string; status: string } }[];
  release_count: number;
  releases: ReleaseSummary[];
  external_references: SourceReference[];
  field_locks: FieldLock[];
  submissions: LinkedSubmission[];
};

export type ReleaseRecord = {
  id: string;
  game: { id: string; title: string; slug: string | null; status: string } | null;
  platform: Platform | null;
  region: Region | null;
  region_unknown_confirmed: boolean;
  markets: { code: string; name: string }[];
  edition: { name: string | null; kind: string | null } | null;
  variant_name: string | null;
  local_title: string | null;
  publisher_name: string | null;
  format: { code: string; name: string; category: string } | null;
  media_count: number | null;
  media_playability: string | null;
  packaging: string | null;
  packaging_code: string;
  identifiers: { product_code: string | null; barcode: string | null };
  languages: string[] | null;
  rating_labels: string[] | null;
  release_date: CatalogDate | null;
  components: { kind: string; label: string; quantity: number; format: string | null }[];
  requirements: { code: string; label: string; level: string; note: string | null }[];
  status: string;
  verified_at: string | null;
  revision: number;
  review: RecordReview;
  merged_publicly: boolean;
  created_at: string;
  updated_at: string;
  merged_into: ReleaseSummary | null;
  pairing_status: string | null;
  external_references: SourceReference[];
  evidence: { field: string; provider: string; sources: number }[];
  field_locks: FieldLock[];
  merges: { id: string; merged_at: string; kind: string; role: "source" | "target"; other: ReleaseSummary | null }[];
  submissions: LinkedSubmission[];
  /** Administrators only; null for editors. */
  exclusions: { id: string; excluded_at: string; reason_code: string; restored_at: string | null }[] | null;
};

async function record<T>(fn: "get_game_record" | "get_release_record", arg: "p_game" | "p_release", id: string): Promise<Outcome<T | null>> {
  if (!UUID.test(id)) return { ok: true, data: null };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc(fn, { [arg]: id });
  if (error) return failure(error);
  return { ok: true, data: typeof data === "object" && data !== null ? (data as T) : null };
}

/** One game for staff: null when there's none. */
export function getGameRecord(id: string) {
  return record<GameRecord>("get_game_record", "p_game", id);
}

/** One release for staff: null when there's none. */
export function getReleaseRecord(id: string) {
  return record<ReleaseRecord>("get_release_record", "p_release", id);
}

export type RecordHistory = { items: HistoryEvent[]; next_before: string | null };

/** A page of one record's history, newest first; null when there's no such record. */
export async function getRecordHistory(entity: "game" | "release", id: string, before: string | null, limit = 25): Promise<Outcome<RecordHistory | null>> {
  if (!UUID.test(id)) return { ok: true, data: null };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc("get_catalog_record_history", {
    p_entity: entity,
    p_id: id,
    p_limit: limit,
    p_before: before && UUID.test(before) ? before : null,
  });
  if (error) return error.message === "record unavailable" ? { ok: true, data: null } : failure(error);
  return { ok: true, data: data as RecordHistory };
}
