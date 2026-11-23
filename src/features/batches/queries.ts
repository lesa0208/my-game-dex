import "server-only";

import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";

import type { BatchStatusFilter, MemberCategory, MemberFilter, Outcome } from "./form";

/**
 * Review batches for catalog staff (M14c-2), read with the staff member's own session through
 * the M14c-2 functions, which check the caller themselves: catalog editors and administrators
 * with a verified session. Bounded pages, never cached, and nothing assessed here: blockers and
 * what the viewer may do come from the database.
 */

export type Loaded<T> = { ok: true; data: T } | { ok: false; reason: "unavailable" | "refused" };

function failure(error: { code?: string }): Loaded<never> {
  return error.code === "P0001" || error.code === "42501" || error.code === "22023" ? { ok: false, reason: "refused" } : { ok: false, reason: "unavailable" };
}

type Platform = { slug: string; name: string; short_name: string };
export type Person = { handle: string | null; you: boolean } | null;

export type BatchSummary = {
  id: string;
  status: "open" | "approved" | "rejected";
  created_at: string;
  decided_at: string | null;
  platform: Platform;
  source: { provider: string; provider_name: string | null; name: string; fetched_at: string | null };
  creator: Person;
  items: number;
  flagged: number;
  sampled: number;
  required: number;
  recorded: number;
  pending: number;
  critical_signals: number;
  critical_errors: number;
  approvals: { recorded: number; required: number };
};

export type BatchList = { status: "ok" | "unknown_platform"; items: BatchSummary[]; next_after: string | null };

export type Blocker = { code: "pending_outcomes" | "sample_failed" | "critical_errors_unresolved" | "evidence_missing" | "stale" | "publication_rights"; count: number };

export type BatchOverview = {
  id: string;
  status: BatchSummary["status"];
  reason: string;
  created_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  creator: Person;
  platform: Platform;
  source: {
    run_id: string;
    provider: string;
    provider_name: string | null;
    name: string;
    snapshot_sha256: string;
    fetched_at: string | null;
    finished_at: string | null;
    terms_sha256: string | null;
  };
  content_sha256: string;
  seed: string;
  sampling: { sample_size: number; acceptance_number: number; tolerable_error: number; confidence: number };
  counts: {
    items: number;
    critical: number;
    flagged: number;
    sampled: number;
    unsampled: number;
    with_info_flags: number;
    required: number;
    pending: number;
    recorded: number;
    correct: number;
    incorrect: number;
    excluded: number;
    critical_errors: number;
    sample_errors: number;
  };
  approvals: { required: number; recorded: number; by: { person: Person; at: string }[] };
  blockers: Blocker[];
  ready: boolean;
  you: { review: string | null; approve: string | null };
};

export type MemberSummary = {
  game: { id: string; title: string; status: string };
  pairing_status: string | null;
  category: MemberCategory;
  sampled: boolean;
  flags: string[];
  info_flags: string[];
  critical_flags: string[];
  source: { provider: string; external_id: string } | null;
  requires_outcome: boolean;
  outcome: Outcome | null;
  critical_error: string | null;
  note: string | null;
  recorded_at: string | null;
  reviewer: Person;
  stale: boolean | null;
};

export type MemberList = { batch: { id: string; status: string }; filter: MemberFilter; items: MemberSummary[]; next_after: string | null };

export type SourceRecord = {
  title: string | null;
  titles: string[];
  ja_titles: string[];
  first_release: { value: string; precision: string | null } | null;
  revision: number | null;
  platform_first_release: { value: string; precision: string | null } | null;
  distribution_formats: string[];
  instance_of: string[];
  platforms: number | null;
  external_ids: { igdb: string[]; mobygames: string[] };
  detail: boolean;
};

export type MemberContext = {
  batch: { id: string; status: string; content_sha256: string; created_at: string; platform: Platform; approvals: number };
  member: Omit<MemberSummary, "game" | "pairing_status" | "source"> & { frozen_game_revision: number };
  game: { id: string; title: string; kind: string; status: string; revision: number; slug: string | null; first_release: { value: string; precision: string } | null; identity_verified: boolean };
  pairing: { status: string; physical_confirmed: boolean; releases: { total: number; published: number } } | null;
  source: {
    provider: string;
    provider_name: string | null;
    external_id: string;
    payload_sha256: string;
    snapshot_sha256: string | null;
    record: SourceRecord;
    assessment: { assessor: string | null; assessor_version: string | null; problems: string[] };
  } | null;
  conflicts: {
    same_title: { id: string; title: string; status: string; on_platform: boolean; in_batch: boolean }[];
    shared_ids: { id: string; title: string }[];
    linked_elsewhere: { id: string; title: string; status: string }[];
  };
  batches: { id: string; status: string; created_at: string; decided_at: string | null; sampled: boolean; flagged: boolean; outcome: Outcome | null; critical_error: string | null; recorded_at: string | null }[];
  trail: { at: string; person: Person; outcome: Outcome; critical_error: string | null; note: string | null }[];
  you: { record: string | null; options: Outcome[]; keep_critical_error: string | null };
};

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<Loaded<T | null>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return failure(error);
  return { ok: true, data: typeof data === "object" && data !== null ? (data as T) : null };
}

export const PAGE_SIZE = 25;

/** One page of batches, newest first. */
export function listReviewBatches(status: BatchStatusFilter, platform: string | null, after: string | null) {
  return rpc<BatchList>("list_review_batches", {
    p_status: status === "all" ? null : status,
    p_platform: platform,
    p_after: after && UUID.test(after) ? after : null,
    p_limit: PAGE_SIZE,
  });
}

/** One batch: provenance, progress, blockers and what the viewer may do. Null when there's none. */
export function getReviewBatchOverview(id: string) {
  if (!UUID.test(id)) return Promise.resolve({ ok: true, data: null } as Loaded<BatchOverview | null>);
  return rpc<BatchOverview>("get_review_batch_overview", { p_batch: id });
}

/** One page of a batch's members. */
export function listReviewBatchMembers(id: string, filter: MemberFilter, after: string | null) {
  if (!UUID.test(id)) return Promise.resolve({ ok: true, data: null } as Loaded<MemberList | null>);
  return rpc<MemberList>("list_review_batch_members", { p_batch: id, p_filter: filter, p_after: after && UUID.test(after) ? after : null, p_limit: PAGE_SIZE });
}

/** One member's review context. Null when the game isn't a member of the batch. */
export function getReviewBatchMember(batch: string, game: string) {
  if (!UUID.test(batch) || !UUID.test(game)) return Promise.resolve({ ok: true, data: null } as Loaded<MemberContext | null>);
  return rpc<MemberContext>("get_review_batch_member", { p_batch: batch, p_game: game });
}
