import "server-only";

import { cacheLife } from "next/cache";

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
  if (response.status === 400) {
    const body: unknown = await response.json().catch(() => null);
    const message = typeof body === "object" && body !== null && "message" in body ? String(body.message) : "";
    const reason = QUERY_ERRORS[message];
    if (reason) return { ok: false, reason };
  }
  if (!response.ok) throw new Error(`The catalog request failed with status ${response.status}.`);
  return { ok: true, data: await response.json() };
}

export const SEARCH_PAGE_SIZE = 20;

export async function searchCatalog(query: string, platform: string | null, cursor: string | null): Promise<CatalogOutcome<SearchResponse>> {
  "use cache";
  cacheLife("minutes");
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
  const outcome = await rpc("get_release_picker", {
    p_game: game,
    p_platform: platform,
    p_region: region,
    // An id that isn't a UUID can't name a release, and would fail the call.
    p_release: release && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(release) ? release : null,
  });
  return outcome.ok ? { ok: true, data: parseReleasePicker(outcome.data) } : outcome;
}
