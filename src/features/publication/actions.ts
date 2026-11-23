"use server";

import { refresh, updateTag } from "next/cache";
import { redirect } from "next/navigation";

import { stepUpHref } from "@/features/admin/form";
import { createSupabaseServerClient } from "@/features/auth/server";
import { CATALOG_TAG } from "@/features/catalog/queries";
import { UUID } from "@/features/collection/uuid";
import type { EditState } from "@/features/editing/actions";
import { getGamePairingEvidence } from "@/features/records/queries";

import { PUBLISH_MESSAGES, type PublishMessage, publishErrorCode, readPublish } from "./form";

/**
 * Publishing confirmed game/platform identities (M14c-3), with the editor's own session, through
 * publish_game_identity, which decides: the role, a recent authenticator check, the expected
 * revision, the game's verification, each pairing's evidence, and that nobody publishes what
 * they created or whose evidence they confirmed.
 *
 * Only platforms the editor ticked are sent, and only ones the game record says they may publish
 * now: the record is read again first, and nothing is sent if its revision changed, a chosen
 * platform is no longer theirs to publish, or its evidence was confirmed again since the page
 * showed it (which the database then checks again, under its locks). Publishing an identity never creates or verifies a
 * physical release. Nothing is replayed after a step-up.
 */

const UNAVAILABLE: EditState = { status: "error", message: "The catalog isn't available right now. Try again later." };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
const whole = (text: string) => (/^\d{1,18}$/.test(text) ? Number(text) : null);
// Not exported: every export of a "use server" file is an action a client can call.
const gamePath = (game: string) => `/admin/catalog/games/${game}`;
const error = (code: PublishMessage): EditState => ({ status: "error", message: PUBLISH_MESSAGES[code] });

export async function publishIdentity(_state: EditState, formData: FormData): Promise<EditState> {
  const game = field(formData, "game_id");
  const seenRevision = whole(field(formData, "seen_revision"));
  if (!UUID.test(game) || seenRevision === null) return error("unavailable");
  const back = gamePath(game);

  const supabase = await createSupabaseServerClient();
  if (!supabase) return UNAVAILABLE;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return UNAVAILABLE;

  // The record as it is now, read with the editor's session.
  const current = await getGamePairingEvidence(game);
  if (!current.ok) return current.reason === "refused" ? error("not_permitted") : UNAVAILABLE;
  if (!current.data) return error("unavailable");
  if (current.data.game.revision !== seenRevision) return error("changed");
  const allowed = current.data.pairings.filter((p) => p.publication.you_may_publish).map((p) => p.platform.slug);
  const input = readPublish(formData.getAll("platform").filter((v): v is string => typeof v === "string"), (name) => field(formData, name), allowed);
  if ("error" in input) return error(input.error);

  // The evidence each chosen platform showed: the time it was recorded, as the page carried it.
  const seenAt = input.value.platforms.map((slug) => field(formData, `seen_at_${slug}`));
  const nowAt = input.value.platforms.map((slug) => current.data?.pairings.find((p) => p.platform.slug === slug)?.physical?.verified_at ?? "");
  if (seenAt.some((at, i) => !at || at !== nowAt[i])) return error("changed");

  const { data: rows, error: platformError } = await supabase.from("platforms").select("id, slug").in("slug", input.value.platforms);
  const ids = input.value.platforms.map((slug) => rows?.find((r) => r.slug === slug)?.id);
  if (platformError || ids.some((id) => !id)) return error("not_eligible");

  // publish_game_identity_as_seen refuses unless each pairing is still verified exactly when the
  // page showed it, under the pairing's lock, then publishes through publish_game_identity.
  const { error: rpcError } = await supabase.rpc("publish_game_identity_as_seen", {
    p_game: game,
    p_platforms: ids,
    p_reason: input.value.reason,
    p_expected_revision: seenRevision,
    p_expected_verified_at: seenAt,
  });
  if (rpcError) {
    if (rpcError.message === "reauthentication required") return { status: "stepup", message: PUBLISH_MESSAGES.reauthenticate, href: stepUpHref(back) };
    return error(publishErrorCode(rpcError.message));
  }
  updateTag(CATALOG_TAG);
  refresh();
  redirect(`${back}?notice=identity_published#identity-publication`);
}

/** Without JavaScript: a stale verification goes to step-up; a refusal comes back with its fixed message's code. */
export async function publishIdentityFromForm(formData: FormData): Promise<void> {
  const state = await publishIdentity({ status: "idle", message: null }, formData);
  if (state.status === "stepup" && state.href) redirect(state.href);
  const game = field(formData, "game_id");
  if (state.status === "error" && UUID.test(game)) {
    const code = (Object.entries(PUBLISH_MESSAGES).find(([, t]) => t === state.message)?.[0] ?? "failed") as PublishMessage;
    redirect(`${gamePath(game)}?error=${code}#identity-publication`);
  }
}
