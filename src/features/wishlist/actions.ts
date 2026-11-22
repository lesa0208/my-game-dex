"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { signInHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID, UUID_V7, uuidv7 } from "@/features/collection/uuid";
import { getSubmissionOptions } from "@/features/submissions/queries";

import { readDetails, readTarget, sameTarget, wishErrorMessage } from "./format";
import { readWishlistParams, wishHref, wishlistHref } from "./params";
import { getMyWishlistItem } from "./queries";
import type { WishlistItem, WishlistTarget } from "./types";

/**
 * Adding, editing and removing wishlist entries, through W1's definer functions only:
 * add_wishlist_item, update_wishlist_item and remove_wishlist_item take the owner from
 * the verified session (auth.uid()), check it's live and, for adding and editing, that
 * the account is active, and check every catalog reference again. Nothing from a form
 * names an owner, and the app has no write grant on the table.
 *
 * Messages are fixed text from wishErrorMessage, never the database's own.
 */

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

const read = (formData: FormData) => (name: string) => field(formData, name).trim();

export type AddWishState = {
  status: "idle" | "added" | "already" | "error" | "signed_out";
  message: string | null;
  /** The id the form sends next: the idempotency key for add_wishlist_item. */
  itemId: string;
  /** The entry that was added, or that already wanted this. */
  wishId: string | null;
};

/**
 * Adds one entry. The form carries a UUIDv7 made when the page was rendered; a double
 * click or retry sends it again and gets the same entry back. A target already on the
 * wishlist isn't added twice: W1 returns the existing entry, and the form links to it.
 */
export async function addWish(state: AddWishState, formData: FormData): Promise<AddWishState> {
  const itemId = field(formData, "item_id");
  if (!UUID_V7.test(itemId)) return { status: "error", message: "The wish couldn't be added. Try again.", itemId: uuidv7(), wishId: null };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ...state, status: "error", message: "Your wishlist isn't available right now. Try again later.", itemId };
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return { status: "signed_out", message: "Sign in to add games to your wishlist.", itemId, wishId: null };

  const target = readTarget(read(formData));
  if ("error" in target) return { ...state, status: "error", message: target.error, itemId };
  const details = readDetails(read(formData));
  if ("error" in details) return { ...state, status: "error", message: details.error, itemId };

  const { data, error } = await supabase.rpc("add_wishlist_item", { p_item_id: itemId, p_target: target.target, p_details: details.details });
  if (error) {
    const { text, renewId, signedOut } = wishErrorMessage(error.message);
    if (signedOut) return { status: "signed_out", message: text, itemId, wishId: null };
    return { ...state, status: "error", message: text, itemId: renewId ? uuidv7() : itemId };
  }
  const result = (data ?? {}) as { item_id?: unknown; created?: unknown };
  const wishId = typeof result.item_id === "string" ? result.item_id : null;
  refresh();
  if (result.created === true) return { status: "added", message: "Added to your wishlist.", itemId: uuidv7(), wishId };
  // The same request again, or the target already wanted: nothing new was added.
  return { status: "already", message: wishId === itemId ? "Added to your wishlist." : "Already on your wishlist.", itemId: uuidv7(), wishId };
}

/** The same for a native form post, before JavaScript loads or without it. */
export async function addWishFromForm(formData: FormData): Promise<void> {
  await addWish({ status: "idle", message: null, itemId: "", wishId: null }, formData);
}

export type EditWishState = { status: "idle" | "saved" | "unchanged" | "error" | "signed_out"; message: string | null };

/** The target an entry shows now, in add_wishlist_item's terms. */
function shownTarget(item: WishlistItem, platformId: string | null): WishlistTarget {
  if (item.kind === "release" && item.release) return { release_id: item.release.id };
  return { game_id: item.game.id, ...(platformId ? { platform_id: platformId } : {}), ...(platformId && item.region ? { region_code: item.region.code } : {}) };
}

/**
 * Saves the edit form. The entry is read again first, as the collector: one that isn't
 * theirs reads as missing. The target is sent only when the form asks for a different
 * one, so an entry whose record left the catalog can still have its priority, minimum
 * or note changed without being refused for its target, and its original preference
 * is never replaced unless the collector chooses another. W1 checks everything again.
 */
export async function updateWish(_state: EditWishState, formData: FormData): Promise<EditWishState> {
  const id = field(formData, "wish_id");
  if (!UUID.test(id)) return { status: "error", message: wishErrorMessage("item unavailable").text };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "error", message: "Your wishlist isn't available right now. Try again later." };
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return { status: "signed_out", message: "Sign in to edit your wishlist." };

  const current = await getMyWishlistItem(id);
  if (!current.ok) return { status: "error", message: "Your wishlist isn't available right now. Try again later." };
  if (!current.data) return { status: "error", message: wishErrorMessage("item unavailable").text };

  const target = readTarget(read(formData));
  if ("error" in target) return { status: "error", message: target.error };
  const details = readDetails(read(formData));
  if ("error" in details) return { status: "error", message: details.error };

  // The entry names its platform by slug; the catalog's reference data gives its id.
  const platforms = current.data.platform ? ((await getSubmissionOptions())?.platforms ?? []) : [];
  const shownPlatform = platforms.find((p) => p.slug === current.data?.platform?.slug)?.id ?? null;
  const changes: Record<string, unknown> = { ...details.details };
  if (!sameTarget(target.target, shownTarget(current.data, shownPlatform))) changes.target = target.target;

  const { data, error } = await supabase.rpc("update_wishlist_item", { p_item: id, p_changes: changes });
  if (error) {
    const { text, signedOut } = wishErrorMessage(error.message);
    return { status: signedOut ? "signed_out" : "error", message: text };
  }
  refresh();
  const changed = (data as { changed?: unknown } | null)?.changed === true;
  return changed ? { status: "saved", message: "Your wish was saved." } : { status: "unchanged", message: "Nothing to save: your wish is as it was." };
}

export type RemoveWishState = { status: "idle" | "error"; message: string | null };

/**
 * Removes one entry, then returns to the wishlist as the collector left it. Works
 * without JavaScript: success is a redirect. An entry already gone says so.
 */
export async function removeWish(_state: RemoveWishState, formData: FormData): Promise<RemoveWishState> {
  const id = field(formData, "wish_id");
  const back = readWishlistParams(new URLSearchParams([...formData.entries()].filter((e): e is [string, string] => typeof e[1] === "string" && e[0] !== "wish_id")));

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "error", message: "Your wishlist isn't available right now. Try again later." };
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) redirect(signInHref(UUID.test(id) ? wishHref(id, back) : "/collection/wishlist"));

  let notice: "removed" | "already_removed" = "already_removed";
  if (UUID.test(id)) {
    const { error } = await supabase.rpc("remove_wishlist_item", { p_item: id });
    if (error && error.message !== "item unavailable") return { status: "error", message: "The wish couldn't be removed. Try again." };
    if (!error) notice = "removed";
  }
  refresh();
  redirect(wishlistHref(back, notice));
}
