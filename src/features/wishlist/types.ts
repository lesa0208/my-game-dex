/**
 * M12 W2: the wishlist as W1's functions return it (private.wishlist_json). Every entry
 * is the signed-in collector's own; nothing here is ever another collector's.
 */

export type WishlistLevel = "game" | "platform" | "region" | "release";

/** As add_wishlist_item and update_wishlist_item take it. */
export type WishlistTarget = { release_id?: string; game_id?: string; platform_id?: string; region_code?: string };

export type WishlistItem = {
  id: string;
  kind: "release" | "game";
  /** available; unavailable: its record left the catalog; platform_unavailable: the game's pairing did. */
  state: "available" | "unavailable" | "platform_unavailable";
  /** Its record was merged, and it shows the record it was merged into. */
  merged: boolean;
  /** Another of the owner's entries shows the same target (after a merge). */
  duplicate: boolean;
  priority: 1 | 2 | 3;
  /** The lowest acceptable completeness, or null for any. */
  completeness: "loose" | "incomplete" | "complete" | "sealed" | null;
  note: string | null;
  added_at: string;
  updated_at: string;
  /** The slug only while the game is published. */
  game: { id: string; title: string; slug: string | null };
  platform: { slug: string; name: string; short_name: string } | null;
  region: { code: string; label: string | null } | null;
  release: {
    id: string;
    edition_kind: string | null;
    edition_name: string | null;
    variant_name: string | null;
    local_title: string | null;
    format: { code: string | null; name: string | null } | null;
    media_count: number | null;
    packaging_code: string | null;
    product_code: string | null;
  } | null;
  /** The owner's matching copies that aren't preserved, and how many meet the minimum. */
  owned: { copies: number; meeting_completeness: number };
};

export type WishlistPage = { items: WishlistItem[]; next_cursor: string | null; total: number };
