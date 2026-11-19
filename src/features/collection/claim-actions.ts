"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { signInHref } from "@/features/auth/redirect";

import type { AddCopyState } from "./actions";
import { addUnidentifiedCopy, setMyCopyIdentity } from "./claims";
import { latestAcquisitionDate, readCopyDetails } from "./details";
import { copyHref, readCollectionParams } from "./list-params";
import { getMyGameOwnership } from "./queries";
import type { CopyIdentity } from "./types";
import { UUID, UUID_V7, uuidv7 } from "./uuid";

/**
 * M12b: the forms for unidentified copies. Adding one from a game's page (the fast add,
 * when the choice isn't one published release), and changing a copy's identity from its
 * page. The owner is always the session's user; the M12a functions check the account,
 * the copy's owner, the game and every value again.
 */

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The game's counted copies, for "You have 3 copies of this game". */
async function gameCopies(gameId: string): Promise<number | null> {
  const ownership = await getMyGameOwnership(gameId);
  return ownership ? ownership.copies : null;
}

/**
 * Adds an unidentified copy: the platform, and the region and edition the owner chose
 * (each may be "not sure"). As addCopy: the form carries the copy's UUIDv7 from the
 * render, so a double click or retry gets the same copy back, and an addition returns a
 * fresh id for "Add another copy". `count` is the owner's copies of the game.
 */
export async function addClaim(state: AddCopyState, formData: FormData): Promise<AddCopyState> {
  const itemId = field(formData, "item_id");
  const gameId = field(formData, "game_id");
  const platformId = field(formData, "platform_id");
  if (!UUID_V7.test(itemId) || !UUID.test(gameId) || !UUID.test(platformId)) {
    return { status: "error", message: "The copy couldn't be added. Try again.", itemId: uuidv7(), count: state.count };
  }
  const read = readCopyDetails((name) => field(formData, name), [], latestAcquisitionDate());
  if ("error" in read) return { status: "error", message: read.error, itemId, count: state.count };

  const outcome = await addUnidentifiedCopy({
    itemId,
    gameId,
    platformId,
    regionCode: field(formData, "region") || null,
    editionKind: field(formData, "edition_kind") || null,
    editionName: field(formData, "edition_name").trim() || null,
    details: read.details,
  });
  if (!outcome.ok) {
    if (outcome.reason === "signed_out") return { status: "signed_out", message: "Sign in to add copies to your collection.", itemId, count: null };
    return { status: "error", message: outcome.message, itemId: outcome.renewId ? uuidv7() : itemId, count: state.count };
  }
  return {
    status: outcome.created ? "added" : "already_added",
    message: outcome.created ? "Added to your collection." : "This copy was already added.",
    itemId: uuidv7(),
    count: await gameCopies(gameId),
  };
}

/** The same action for a native form post. As addCopyFromForm, nothing is returned. */
export async function addClaimFromForm(formData: FormData): Promise<void> {
  await addClaim({ status: "idle", message: null, itemId: "", count: null }, formData);
}

export type IdentityState = { status: "idle" | "error"; message: string | null };

/**
 * Changes a copy's identity from its page: corrects an unidentified copy's region or
 * edition (or says "not sure"), or leaves a copy of a release unidentified. The game and
 * platform come from the form only to be checked by set_my_copy_identity, which keeps
 * the platform the copy has and records the change in its private history. Linking to
 * a release is the "Move to another release" form, through the same function.
 * Success returns to the copy's page, saying it changed.
 */
export async function changeIdentity(_state: IdentityState, formData: FormData): Promise<IdentityState> {
  const itemId = field(formData, "item_id");
  const back = readCollectionParams(new URLSearchParams([...formData.entries()].filter((e): e is [string, string] => typeof e[1] === "string")));
  const identity: CopyIdentity = {
    game_id: field(formData, "game_id"),
    platform_id: field(formData, "platform_id"),
    region_code: field(formData, "region") || null,
    edition_kind: field(formData, "edition_kind") || null,
    edition_name: field(formData, "edition_name").trim() || null,
  };
  if (!UUID.test(itemId)) return { status: "error", message: "This copy isn't in your collection any more." };
  const outcome = await setMyCopyIdentity(itemId, identity);
  if (!outcome.ok) {
    if (outcome.reason === "signed_out") redirect(signInHref(copyHref(itemId, back)));
    return { status: "error", message: outcome.message };
  }
  refresh();
  const href = copyHref(itemId, back);
  redirect(`${href}${href.includes("?") ? "&" : "?"}notice=${outcome.changed ? "identity" : "identity_same"}`);
}

export async function changeIdentityFromForm(formData: FormData): Promise<void> {
  await changeIdentity({ status: "idle", message: null }, formData);
}
