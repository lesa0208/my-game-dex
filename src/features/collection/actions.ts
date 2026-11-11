"use server";

import { createSupabaseServerClient } from "@/features/auth/server";

import { addErrorMessage, type CopyComponent, latestAcquisitionDate, readCopyDetails } from "./details";
import { getMyReleaseCopyCount } from "./queries";
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
