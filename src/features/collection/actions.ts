"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { signInHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";

import {
  addErrorMessage,
  type CopyComponent,
  componentField,
  editErrorMessage,
  latestAcquisitionDate,
  type ListedPiece,
  pieceFieldValue,
  readCopyChanges,
  readCopyDetails,
} from "./details";
import { collectionHref, copyHref, readCollectionParams } from "./list-params";
import { getMyCopy, getMyReleaseCopyCount } from "./queries";
import { UUID, UUID_V7, uuidv7 } from "./uuid";

/**
 * Adds one physical copy of a release to the signed-in user's collection.
 *
 * The owner is always the verified session's user: `add_collection_item` (M6b) takes
 * it from auth.uid(), and nothing from the form names an owner. The form carries the
 * copy's UUIDv7, made when the page was rendered. A double click, retry or resubmission
 * sends the same id and gets the same copy back. A successful addition returns a fresh
 * id, which the form uses for "Add another copy".
 *
 * Returns only fixed messages and the user's own count, never database text.
 */

export type AddCopyState = {
  status: "idle" | "added" | "already_added" | "error" | "signed_out";
  message: string | null;
  /** The id the form sends next. */
  itemId: string;
  /** The user's copies of this release, when known. */
  count: number | null;
};

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The release's listed pieces, as the page rendered them. The database checks them again. */
function components(formData: FormData): CopyComponent[] {
  try {
    const parsed: unknown = JSON.parse(field(formData, "components") || "[]");
    if (!Array.isArray(parsed) || parsed.length > 60) return [];
    return parsed.filter((c): c is CopyComponent => typeof c?.kind === "string" && typeof c?.label === "string").slice(0, 60);
  } catch {
    return [];
  }
}

export async function addCopy(state: AddCopyState, formData: FormData): Promise<AddCopyState> {
  const itemId = field(formData, "item_id");
  const releaseId = field(formData, "release_id");
  // A malformed id can't be retried safely, so a fresh one replaces it.
  if (!UUID_V7.test(itemId) || !UUID.test(releaseId)) {
    return { status: "error", message: "The copy couldn't be added. Try again.", itemId: uuidv7(), count: state.count };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "error", message: "Your collection isn't available right now. Try again later.", itemId, count: state.count };
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return { status: "signed_out", message: "Sign in to add copies to your collection.", itemId, count: null };

  const read = readCopyDetails((name) => field(formData, name), components(formData), latestAcquisitionDate());
  if ("error" in read) return { status: "error", message: read.error, itemId, count: state.count };

  const { data, error } = await supabase.rpc("add_collection_item", { p_item_id: itemId, p_release: releaseId, p_details: read.details });
  if (error) {
    if (error.code === "42501" && error.message === "not permitted") return { status: "signed_out", message: "Sign in to add copies to your collection.", itemId, count: null };
    const { text, renewId } = addErrorMessage(error.message);
    return { status: "error", message: text, itemId: renewId ? uuidv7() : itemId, count: state.count };
  }

  const created = typeof data === "object" && data !== null && (data as { created?: unknown }).created === true;
  const count = await getMyReleaseCopyCount(releaseId);
  return {
    status: created ? "added" : "already_added",
    message: created ? "Added to your collection." : "This copy was already added.",
    itemId: uuidv7(),
    count,
  };
}

/**
 * The same action for a native form post, before JavaScript loads or without it. The
 * copy is added or refused exactly as above. Nothing is returned, because the page
 * rendered afterwards can't show it: Next.js resumes the prerendered shell, and
 * React's resume doesn't take an action's result.
 */
export async function addCopyFromForm(formData: FormData): Promise<void> {
  await addCopy({ status: "idle", message: null, itemId: "", count: null }, formData);
}

// ---------------------------------------------------------------------------
// Editing and removing (M6d)
// ---------------------------------------------------------------------------

const UNLISTED_PIECES_KEPT =
  "This copy has records of pieces its release no longer lists. To keep them, its pieces can't be changed for now. Your other changes weren't saved either: set the pieces back and save again.";

export type EditCopyState = { status: "idle" | "saved" | "error" | "signed_out"; message: string | null };

/**
 * Saves the edit form for one of the signed-in user's copies.
 *
 * The copy is read again first, as the user, through `get_my_collection_item`: a copy
 * that isn't theirs reads as missing, and the release's current pieces come from the
 * catalog, not the form. The form's fields are matched to those pieces by kind and
 * label; a piece the form didn't show keeps what was recorded. A copy with records of
 * pieces its release no longer lists can't have its pieces changed, so those records
 * are never deleted. `update_collection_item`
 * (M6b) then checks the account, the copy's owner and every rule again. The release,
 * owner and status aren't fields at all.
 */
export async function updateCopy(_state: EditCopyState, formData: FormData): Promise<EditCopyState> {
  const itemId = field(formData, "item_id");
  if (!UUID.test(itemId)) return { status: "error", message: editErrorMessage("item unavailable") };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "error", message: "Your collection isn't available right now. Try again later." };
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return { status: "signed_out", message: "Sign in to edit your copies." };

  const current = await getMyCopy(itemId);
  if (!current.ok) return { status: "error", message: "Your collection isn't available right now. Try again later." };
  if (!current.data) return { status: "error", message: editErrorMessage("item unavailable") };

  const pieces: ListedPiece[] = current.data.components
    .filter((p): p is typeof p & { label: string } => p.listed && p.label !== null)
    .map((p) => ({ kind: p.kind, label: p.label, recorded: p.recorded, condition: p.condition }));
  // The pieces as the form showed them, in its order.
  const shown = components(formData);
  const read = (name: string) => {
    const match = /^component_(\d+)$/.exec(name);
    if (!match) return field(formData, name);
    const piece = pieces[Number(match[1])];
    const at = shown.findIndex((s) => s.kind === piece.kind && s.label === piece.label);
    return at === -1 ? pieceFieldValue(piece) : field(formData, componentField(at));
  };

  const result = readCopyChanges(read, pieces, latestAcquisitionDate());
  if ("error" in result) return { status: "error", message: result.error };
  // Sending pieces replaces every recorded piece, and a piece the release no longer lists
  // can't be recorded again (M6b), so changing pieces would delete those records. Until
  // the database can keep them, pieces can't change on such a copy.
  if (result.changes.components && current.data.components.some((p) => !p.listed && p.recorded)) {
    return { status: "error", message: UNLISTED_PIECES_KEPT };
  }

  const { error } = await supabase.rpc("update_collection_item", { p_item: itemId, p_changes: result.changes });
  if (error) {
    if (error.code === "42501" && error.message === "not permitted") return { status: "signed_out", message: "Sign in to edit your copies." };
    return { status: "error", message: editErrorMessage(error.message) };
  }
  refresh();
  return { status: "saved", message: "Changes saved." };
}

/** The same action for a native form post. The page rendered afterwards shows the saved details, without a message. */
export async function updateCopyFromForm(formData: FormData): Promise<void> {
  await updateCopy({ status: "idle", message: null }, formData);
}

export type RemoveCopyState = { status: "idle" | "error"; message: string | null };

/**
 * Removes one of the signed-in user's copies, then returns to the collection list as
 * the user left it. `remove_collection_item` (M6b) deletes only the caller's own copy
 * and is allowed for a suspended account. A copy that's already gone, or was never
 * theirs, gets the same answer, so removing twice is safe and reveals nothing.
 */
export async function removeCopy(_state: RemoveCopyState, formData: FormData): Promise<RemoveCopyState> {
  const itemId = field(formData, "item_id");
  const back = readCollectionParams(new URLSearchParams([...formData.entries()].filter((e): e is [string, string] => typeof e[1] === "string")));

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "error", message: "Your collection isn't available right now. Try again later." };
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) redirect(signInHref(UUID.test(itemId) ? copyHref(itemId, back) : "/collection"));

  let notice: "removed" | "already_removed" = "already_removed";
  if (UUID.test(itemId)) {
    const { error } = await supabase.rpc("remove_collection_item", { p_item: itemId });
    if (error && error.message !== "item unavailable") return { status: "error", message: "The copy couldn't be removed. Try again." };
    if (!error) notice = "removed";
  }
  refresh();
  redirect(collectionHref(back, notice));
}
