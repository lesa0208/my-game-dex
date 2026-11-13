import "server-only";

import { cache } from "react";

import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";
import type { SubmissionDetails } from "@/features/submissions/queries";

import type { QueueFilter } from "./form";

/**
 * Catalog review (M7b-1), read with the editor's own session through the M7b-1
 * functions, which check for an active catalog editor themselves. Never cached across
 * requests: a review page must show the record as it is now.
 */

export type Submitter = { deleted: boolean; handle?: string | null; account_status?: string | null };

export type QueueItem = {
  id: string;
  kind: "new_release" | "new_game";
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
  title: string | null;
  platform: { slug: string; name: string; short_name: string } | null;
  region: { code: string; label: string } | null;
  format: { code: string; name: string } | null;
  edition_name: string | null;
  submitter: Submitter;
  own: boolean;
  resubmission: boolean;
};

export type ReviewRelease = {
  id: string;
  status: string;
  revision: number;
  verified: boolean;
  platform: { id: string; slug: string; name: string; short_name: string };
  region_code: string;
  region_unknown_confirmed: boolean;
  media_format_code: string;
  media_count: number | null;
  edition_name: string | null;
  edition_kind: string | null;
  variant_name: string | null;
  product_code: string | null;
  barcode: string | null;
  local_title: string | null;
  publisher_name: string | null;
  packaging: string | null;
  release_date: string | null;
  release_date_precision: string;
  components: { kind: string; label: string; quantity: number }[];
  pairing_status: string | null;
};

export type ReviewGame = {
  id: string;
  title: string;
  kind: string;
  status: string;
  revision: number;
  verified: boolean;
  slug: string | null;
  first_release_year: number | null;
};

export type ReviewItem = {
  request: {
    id: string;
    kind: "new_release" | "new_game";
    status: string;
    version: number;
    created_at: string;
    updated_at: string;
    note: string | null;
    reviewer_note: string | null;
    reviewed_at: string | null;
    reviewer: string | null;
    created_game: boolean;
    details: SubmissionDetails;
    previous_request_id: string | null;
    own: boolean;
  };
  submitter: Submitter;
  release: ReviewRelease | null;
  game: ReviewGame | null;
  history: { id: string; status: string; created_at: string; reviewed_at: string | null; reviewer_note: string | null; reviewer: string | null }[];
  duplicates: {
    id: string;
    status: string;
    game_title: string;
    game_slug: string | null;
    platform: string;
    region: string;
    format: string;
    edition_name: string | null;
    variant_name: string | null;
    product_code: string | null;
    barcode: string | null;
    same_product_code: boolean;
    same_barcode: boolean;
    request_id: string | null;
  }[];
  similar_games: { id: string; title: string; status: string; slug: string | null; similarity: number }[];
};

/** Whether the signed-in user may review: an active catalog editor or administrator. Once per request. */
export const canReview = cache(async (): Promise<boolean> => {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return false;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return false;
  const { data, error } = await supabase.rpc("can_review_submissions");
  return !error && data === true;
});

export async function getSubmissionQueue(status: QueueFilter, after: string | null): Promise<{ items: QueueItem[]; next_after: string | null } | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_submission_queue", { p_status: status, p_after: after && UUID.test(after) ? after : null, p_limit: 50 });
  if (error || typeof data !== "object" || data === null) return null;
  return data as { items: QueueItem[]; next_after: string | null };
}

/** Null when there's no such submission; undefined when it can't be read. */
export async function getSubmissionReview(id: string): Promise<ReviewItem | null | undefined> {
  if (!UUID.test(id)) return null;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return undefined;
  const { data, error } = await supabase.rpc("get_submission_review", { p_request: id });
  if (error) return undefined;
  return typeof data === "object" && data !== null ? (data as ReviewItem) : null;
}
