import "server-only";

import { createSupabaseServerClient } from "@/features/auth/server";

/**
 * Import monitoring and the system view (M10d), read with the administrator's own
 * session through functions that check the caller themselves (D8). Never cached: each
 * request is the database's live answer.
 */

export type ImportProvider = {
  code: string;
  name: string;
  terms_url: string | null;
  terms_sha256: string | null;
  terms_reviewed_at: string | null;
  commercial_use_cleared: boolean;
  cleared_note: string | null;
  updated_at: string;
  runs: number;
  runs_running: number;
  last_run_at: string | null;
  source_records: number;
};

export type ImportRun = {
  id: string;
  provider_code: string;
  provider_name: string | null;
  platform: { slug: string; name: string } | null;
  source_name: string;
  source_sha256: string;
  source_fetched_at: string;
  terms_sha256: string | null;
  status: string;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
  lease_live: boolean;
  lease_expires_at: string | null;
  stats: Record<string, number>;
};

export type ImportRunDetail = {
  run: ImportRun;
  report: Record<string, unknown>;
  failed: number;
  needs_review: number;
  reclassifications: {
    id: string;
    release_id: string;
    action: "withdrawn" | "queued";
    reason: string;
    created_at: string;
    resolved_at: string | null;
    resolution: string | null;
  }[];
  reclassifications_total: number;
};

export type ImportRecord = {
  position: number;
  id: string;
  entity_type: "game" | "release";
  external_id: string;
  title: string | null;
  status: string;
  match_tier: string | null;
  review_reason: string | null;
  ignored: string | null;
  error: string | null;
  possible_duplicate: boolean;
  shared_serial: boolean;
  matched_game_id: string | null;
  matched_release_id: string | null;
};

export type SystemStatus = {
  cap: number;
  checked_at: string;
  migrations: { applied: number; latest: string | null } | null;
  importer: { login_enabled: boolean; runs_running: number; leases_expired: number; last_run_at: string | null };
  providers: { total: number; cleared: number };
  reference: { platforms: number; media_formats: number; region_codes: number; markets: number; hardware_requirements: number };
  catalog: { games_published: number; releases_published: number };
};

async function call<T>(fn: string, args: Record<string, unknown>, valid: (data: unknown) => boolean): Promise<T | { error: string }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "failed" };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { error: error.message === "invalid filter" ? "invalid_filter" : "failed" };
  return valid(data) ? (data as T) : { error: "failed" };
}

export const getImportProviders = () => call<ImportProvider[]>("get_import_providers", {}, Array.isArray);

export const getImportRuns = (filters: { provider: string | null; status: string | null; before: string | null }) =>
  call<ImportRun[]>("get_import_runs", { p_limit: 25, p_before: filters.before, p_provider: filters.provider, p_status: filters.status }, Array.isArray);

/** One run; null when there's no such run. */
export const getImportRun = (id: string) =>
  call<ImportRunDetail | null>("get_import_run", { p_run: id }, (d) => d === null || (typeof d === "object" && typeof (d as ImportRunDetail).run?.id === "string"));

export const getImportRunRecords = (id: string, status: string | null, after: number | null) =>
  call<ImportRecord[]>("get_import_run_records", { p_run: id, p_status: status, p_limit: 50, p_after: after }, Array.isArray);

export const getSystemStatus = () =>
  call<SystemStatus>("get_system_status", {}, (d) => typeof d === "object" && d !== null && typeof (d as SystemStatus).cap === "number");

export type QueueItem = {
  id: string;
  release_id: string;
  reason: string;
  created_at: string;
  release: { status: string; product_code: string | null; game: { id: string; title: string } | null; platform: { name: string } | null } | null;
};

/**
 * The open reclassification items (M5b), oldest first, for catalog editors, through
 * the existing get_catalog_review_queue, with each release as the editor may read it.
 */
export async function getReclassificationQueue(): Promise<QueueItem[] | { error: string }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "failed" };
  const { data, error } = await supabase.rpc("get_catalog_review_queue", { p_limit: 200 });
  if (error || !Array.isArray(data)) return { error: "failed" };
  const items = data as Omit<QueueItem, "release">[];
  if (!items.length) return [];
  const { data: releases, error: releaseError } = await supabase
    .from("releases")
    .select("id, status, product_code, pairing:game_platforms(game:games(id, title), platform:platforms(name))")
    .in(
      "id",
      items.map((i) => i.release_id),
    );
  if (releaseError) return { error: "failed" };
  // A release names its game through its platform pairing (M5).
  type Row = { id: string; status: string; product_code: string | null; pairing: { game: { id: string; title: string } | null; platform: { name: string } | null } | null };
  const byId = new Map(
    ((releases ?? []) as unknown as Row[]).map((r) => [r.id, { status: r.status, product_code: r.product_code, game: r.pairing?.game ?? null, platform: r.pairing?.platform ?? null }]),
  );
  return items.map((i) => ({ ...i, release: byId.get(i.release_id) ?? null }));
}
