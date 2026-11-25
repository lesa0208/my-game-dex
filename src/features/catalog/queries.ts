import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { parsePlatforms, parseReleasePicker, parseSearchResponse } from "./parse";
import type { CatalogPlatform, ReleasePicker, SearchResponse } from "./types";

/**
 * Reads the public catalog through the M5c search functions, on the server only.
 *
 * Calls are made as anon with the project's publishable key: search shows only
 * published records, the same to everyone, so no user session is needed or sent,
 * and results can be cached. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY on the
 * server (see .env.example); without them the catalog reports itself unavailable.
 */

export type CatalogOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "unavailable" | "invalid_cursor" | "query_too_long" };

const QUERY_ERRORS: Record<string, "invalid_cursor" | "query_too_long"> = {
  "invalid cursor": "invalid_cursor",
  "query too long": "query_too_long",
};

async function rpc(fn: string, args: Record<string, unknown>): Promise<CatalogOutcome<unknown>> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return { ok: false, reason: "unavailable" };

  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  let code = "";
  if (response.status === 400) {
    const body: unknown = await response.json().catch(() => null);
    const message = typeof body === "object" && body !== null && "message" in body ? String(body.message) : "";
    const reason = QUERY_ERRORS[message];
    if (reason) return { ok: false, reason };
    code = typeof body === "object" && body !== null && "code" in body ? String(body.code).slice(0, 8) : "";
  }
  // The server log names the function and the database's error code, never the arguments.
  if (!response.ok) throw new Error(`The catalog request ${fn} failed with status ${response.status}${code ? ` (${code})` : ""}.`);
  return { ok: true, data: await response.json() };
}

/**
 * The tag on every cached public catalog read. A merge expires it (M7b-2c), so pages
 * read after it show the catalog as it is, not as cached before.
 */
export const CATALOG_TAG = "catalog";

export const SEARCH_PAGE_SIZE = 20;

export async function searchCatalog(query: string, platform: string | null, cursor: string | null): Promise<CatalogOutcome<SearchResponse>> {
  "use cache";
  cacheLife("minutes");
  cacheTag(CATALOG_TAG);
  const outcome = await rpc("search_catalog", {
    p_query: query || null,
    p_platforms: platform ? [platform] : null,
    p_limit: SEARCH_PAGE_SIZE,
    p_cursor: cursor,
  });
  return outcome.ok ? { ok: true, data: parseSearchResponse(outcome.data) } : outcome;
}

export async function listCatalogPlatforms(): Promise<CatalogOutcome<CatalogPlatform[]>> {
  "use cache";
  cacheLife("hours");
  cacheTag(CATALOG_TAG);
  const outcome = await rpc("list_catalog_platforms", {});
  return outcome.ok ? { ok: true, data: parsePlatforms(outcome.data) } : outcome;
}

export async function getReleasePicker(
  game: string,
  platform: string | null,
  region: string | null,
  release: string | null,
): Promise<CatalogOutcome<ReleasePicker | null>> {
  "use cache";
  cacheLife("minutes");
  cacheTag(CATALOG_TAG);
  const outcome = await rpc("get_release_picker", {
    p_game: game,
    p_platform: platform,
    p_region: region,
    // An id that isn't a UUID can't name a release, and would fail the call.
    p_release: release && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(release) ? release : null,
  });
  return outcome.ok ? { ok: true, data: parseReleasePicker(outcome.data) } : outcome;
}

/**
 * A published game's summary, as the catalog records it, or null when it has none. Read
 * as anon like the rest of the public catalog: the column is granted to anon and RLS
 * shows only published and merged games (M5), so nothing unpublished is ever returned.
 */
export async function getGameSummary(gameId: string): Promise<string | null> {
  "use cache";
  cacheLife("minutes");
  cacheTag(CATALOG_TAG);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gameId)) return null;
  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/games?select=summary&status=eq.published&id=eq.${gameId}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!response.ok) return null;
  const rows: unknown = await response.json().catch(() => null);
  const summary = Array.isArray(rows) ? (rows[0] as { summary?: unknown } | undefined)?.summary : null;
  return typeof summary === "string" && summary.trim() ? summary.trim() : null;
}

/**
 * Where an address naming a merged release should go: the release it was merged into,
 * and its game. Null for anything else, a release merged while unpublished included,
 * exactly as for an unknown id (M7b-2c D3, D14). Not cached: it's asked only for an id
 * the game page can't show, and must answer as of now, not as of before a merge.
 */
export async function resolveMergedRelease(release: string): Promise<{ gameSlug: string; releaseId: string } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(release)) return null;
  const outcome = await rpc("resolve_merged_release", { p_release: release });
  if (!outcome.ok || typeof outcome.data !== "object" || outcome.data === null) return null;
  const data = outcome.data as { game_slug?: unknown; release_id?: unknown };
  return typeof data.game_slug === "string" && typeof data.release_id === "string" ? { gameSlug: data.game_slug, releaseId: data.release_id } : null;
}
