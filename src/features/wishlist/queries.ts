import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { cache } from "react";

import { createSupabaseServerClient } from "@/features/auth/server";
import { CATALOG_TAG } from "@/features/catalog/queries";
import { UUID } from "@/features/collection/uuid";

import type { WishlistParams } from "./params";
import type { WishlistItem, WishlistPage } from "./types";

/**
 * The signed-in collector's own wishlist, read with their session through W1's
 * functions, which check the live session and read only the caller's entries. Per user
 * and per request: never cached across requests, never on a public page.
 */

export const WISHLIST_PAGE_SIZE = 30;

export type WishlistOutcome<T> = { ok: true; data: T } | { ok: false; reason: "unavailable" | "invalid_cursor" | "signed_out" };

const unavailable = { ok: false, reason: "unavailable" } as const;

/** One page, filtered, sorted and paged in the database: the browser never holds more. */
export async function getMyWishlist(params: WishlistParams): Promise<WishlistOutcome<WishlistPage>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return unavailable;
  const { data, error } = await supabase.rpc("get_my_wishlist", {
    p_query: params.query || null,
    p_platform: params.platform,
    p_region: params.region,
    p_priority: params.priority,
    p_sort: params.sort,
    p_limit: WISHLIST_PAGE_SIZE,
    p_cursor: params.cursor,
  });
  if (error) return { ok: false, reason: error.message === "invalid cursor" ? "invalid_cursor" : error.message === "not permitted" ? "signed_out" : "unavailable" };
  if (typeof data !== "object" || data === null || !Array.isArray((data as WishlistPage).items)) return unavailable;
  return { ok: true, data: data as WishlistPage };
}

/** Entries read per page, and pages at most, when matching search results to the wishlist. */
const WISHED_PAGE = 100;
const WISHED_PAGES = 5;

/**
 * M17a: which of these games the signed-in collector already wants, at any level (any
 * version, a platform, a region or one release), each with one of its entries, so a
 * result can say "On your wishlist" instead of offering a duplicate. Read through W1's
 * own get_my_wishlist (the caller's entries only), a page at a time: no new function.
 * Null when signed out or it can't be read.
 */
export async function getMyWishedGames(gameIds: readonly string[]): Promise<Map<string, string> | null> {
  const wanted = new Set(gameIds.filter((id) => UUID.test(id)));
  if (!wanted.size) return new Map();
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return null;
  const found = new Map<string, string>();
  let cursor: string | null = null;
  for (let page = 0; page < WISHED_PAGES; page += 1) {
    const { data, error } = await supabase.rpc("get_my_wishlist", {
      p_query: null,
      p_platform: null,
      p_region: null,
      p_priority: null,
      p_sort: "added",
      p_limit: WISHED_PAGE,
      p_cursor: cursor,
    });
    if (error || typeof data !== "object" || data === null || !Array.isArray((data as WishlistPage).items)) return null;
    const list = data as WishlistPage;
    for (const item of list.items) if (wanted.has(item.game.id) && !found.has(item.game.id)) found.set(item.game.id, item.id);
    cursor = list.next_cursor;
    if (!cursor) return found;
  }
  // Longer than this reads: what was found stands, and a wanted game not found here is
  // still refused as a duplicate by add_wishlist_item.
  return found;
}

/**
 * The collector's entries for one game, for its page: one call, shared by every part of
 * the page that shows them (React's per-request cache). Null when signed out or it
 * can't be read.
 */
export const getMyWishlistForGame = cache(async (gameId: string): Promise<WishlistItem[] | null> => {
  if (!UUID.test(gameId)) return null;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return null;
  const { data, error } = await supabase.rpc("get_my_wishlist_for_game", { p_game: gameId });
  if (error || typeof data !== "object" || data === null || !Array.isArray((data as { items?: unknown }).items)) return null;
  return (data as { items: WishlistItem[] }).items;
});

/** One of the collector's entries, or null when there's no such entry of theirs. */
export const getMyWishlistItem = cache(async (id: string): Promise<WishlistOutcome<WishlistItem | null>> => {
  if (!UUID.test(id)) return { ok: true, data: null };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return unavailable;
  const { data, error } = await supabase.rpc("get_my_wishlist_item", { p_item: id });
  if (error) return { ok: false, reason: error.message === "not permitted" ? "signed_out" : "unavailable" };
  return { ok: true, data: typeof data === "object" && data !== null ? (data as WishlistItem) : null };
});

export type WishPlatform = { id: string; slug: string; name: string; shortName: string };

/**
 * The platforms a game can be wanted on: its published pairings (W1 accepts no other),
 * whether or not a release on them is catalogued yet. Public and cached, read as anon:
 * RLS shows anon only published pairings. Null when the catalog isn't connected.
 */
export async function getGameWishPlatforms(gameId: string): Promise<WishPlatform[] | null> {
  "use cache";
  cacheLife("minutes");
  cacheTag(CATALOG_TAG);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !UUID.test(gameId)) return null;
  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/game_platforms?select=platform:platforms(id,slug,name,short_name)&status=eq.published&game_id=eq.${gameId}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!response.ok) return null;
  const rows: unknown = await response.json().catch(() => null);
  if (!Array.isArray(rows)) return null;
  return rows
    .map((row: { platform?: { id: string; slug: string; name: string; short_name: string } | null }) => row.platform)
    .filter((p): p is { id: string; slug: string; name: string; short_name: string } => Boolean(p?.id))
    .map((p) => ({ id: p.id, slug: p.slug, name: p.name, shortName: p.short_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
