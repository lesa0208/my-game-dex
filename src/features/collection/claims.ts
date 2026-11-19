import "server-only";

import { createSupabaseServerClient } from "@/features/auth/server";

import { claimErrorMessage } from "./details";
import type { CopyIdentity } from "./types";
import { UUID, UUID_V7 } from "./uuid";

/**
 * M12a: the data layer for unidentified copies, for the M12b forms. The owner is always
 * the verified session's user (auth.uid() in the database); nothing here names one. The
 * database checks and tidies everything again; these checks only stop obviously
 * malformed input before a round trip. Returns fixed messages, never database text.
 */

export type ClaimInput = {
  /** The copy's UUIDv7, made when the page was rendered, so a retry gets the same copy. */
  itemId: string;
  gameId: string;
  platformId: string;
  /** Null or omitted: the owner isn't sure. */
  regionCode?: string | null;
  editionKind?: string | null;
  editionName?: string | null;
  /** Optional details, as add_collection_item takes them. */
  details?: Record<string, unknown>;
};

export type ClaimOutcome =
  | { ok: true; created: boolean; itemId: string }
  | { ok: false; reason: "signed_out" | "error"; message: string; renewId: boolean };

const REGION = /^[a-z0-9-]{1,32}$/;
const KIND = /^[a-z_]{1,32}$/;
// The database allows 80 characters after tidying; this only bounds what is sent.
const MAX_EDITION_INPUT = 200;

const failed = (message: unknown, signedOut = false) => {
  const { text, renewId } = claimErrorMessage(message);
  return { ok: false as const, reason: signedOut ? ("signed_out" as const) : ("error" as const), message: text, renewId };
};

/** Adds an unidentified copy: a game and platform, with region and edition each optional. */
export async function addUnidentifiedCopy(input: ClaimInput): Promise<ClaimOutcome> {
  const region = input.regionCode?.trim() || null;
  const kind = input.editionKind?.trim() || null;
  const name = input.editionName ?? null;
  if (!UUID_V7.test(input.itemId) || !UUID.test(input.gameId) || !UUID.test(input.platformId)) return failed(null);
  if ((region && !REGION.test(region)) || (kind && !KIND.test(kind)) || (name && name.length > MAX_EDITION_INPUT)) return failed(null);

  const supabase = await createSupabaseServerClient();
  if (!supabase) return failed(null);
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, reason: "signed_out", message: "Sign in to add to your collection.", renewId: false };

  const { data, error } = await supabase.rpc("add_unidentified_copy", {
    p_item_id: input.itemId,
    p_game: input.gameId,
    p_platform: input.platformId,
    p_region: region,
    p_edition_kind: kind,
    p_edition_name: name,
    p_details: input.details ?? {},
  });
  if (error) return failed(error.message);
  return { ok: true, created: (data as { created?: unknown } | null)?.created === true, itemId: input.itemId };
}

export type IdentityOutcome =
  | { ok: true; changed: boolean; identity: "release" | "claim"; releaseId: string | null; recordStatus: string }
  | { ok: false; reason: "signed_out" | "error"; message: string };

function wellFormed(identity: CopyIdentity): boolean {
  if ("release_id" in identity) return UUID.test(identity.release_id);
  return (
    UUID.test(identity.game_id) &&
    UUID.test(identity.platform_id) &&
    (!identity.region_code || REGION.test(identity.region_code)) &&
    (!identity.edition_kind || KIND.test(identity.edition_kind)) &&
    (!identity.edition_name || identity.edition_name.length <= MAX_EDITION_INPUT)
  );
}

/**
 * Changes a copy's identity: identify it as a release, leave it unidentified, or correct
 * its claim. The platform never changes. Recorded in the copy's private history.
 */
export async function setMyCopyIdentity(itemId: string, identity: CopyIdentity): Promise<IdentityOutcome> {
  if (!UUID.test(itemId) || !wellFormed(identity)) return failed(null);
  const supabase = await createSupabaseServerClient();
  if (!supabase) return failed(null);
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, reason: "signed_out", message: "Sign in to change your collection." };

  const { data, error } = await supabase.rpc("set_my_copy_identity", { p_item: itemId, p_identity: identity });
  if (error) return failed(error.message);
  const result = data as { changed?: unknown; identity?: unknown; release_id?: unknown; record_status?: unknown } | null;
  return {
    ok: true,
    changed: result?.changed === true,
    identity: result?.identity === "claim" ? "claim" : "release",
    releaseId: typeof result?.release_id === "string" ? result.release_id : null,
    recordStatus: typeof result?.record_status === "string" ? result.record_status : "active",
  };
}
