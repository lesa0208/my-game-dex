import "server-only";

import type { ExploreViewer } from "@/components/explore/result-actions";
import { getCurrentViewer } from "@/features/account/queries";
import { getMyOwnedGames } from "@/features/collection/queries";
import { getMyWishedGames } from "@/features/wishlist/queries";

/**
 * M17a: what Explore's cards need about the person looking, per request and never
 * cached: whether they can add, and which of these games they own and want, read with
 * their session through the owner-only functions (get_my_owned_games, get_my_wishlist).
 * Signed out, both maps are empty. A read that fails leaves its map empty: the cards
 * then offer the actions as usual, and the database refuses a duplicate wish.
 */
export async function getExploreContext(gameIds: string[]): Promise<{ viewer: ExploreViewer; owned: Map<string, number>; wished: Map<string, string> }> {
  const viewer = await getCurrentViewer().catch(() => null);
  if (!viewer) return { viewer: "signed_out", owned: new Map(), wished: new Map() };
  const state: ExploreViewer = !viewer.handle ? "needs_handle" : !viewer.isActive ? "inactive" : "ready";
  const [owned, wished] = await Promise.all([getMyOwnedGames(gameIds).catch(() => null), getMyWishedGames(gameIds).catch(() => null)]);
  return { viewer: state, owned: owned ?? new Map(), wished: wished ?? new Map() };
}
