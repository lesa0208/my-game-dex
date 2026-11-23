"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { stepUpHref } from "@/features/admin/form";
import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";
import type { EditState } from "@/features/editing/actions";

import { outcomeErrorMessage, outcomeMessageCode, readOutcome, RECORD_BLOCKS } from "./form";
import { getReviewBatchMember } from "./queries";

/**
 * Recording a batch member's outcome (M14c-2), with the editor's own session, through
 * record_batch_outcome, which decides: the role, a recent authenticator check, the batch's
 * state, self-review, the evidence a "correct" outcome needs, and that findings only become more
 * conservative. Nothing is decided here that the database doesn't decide again.
 *
 * The form carries the member's outcome and game revision as the page showed them. If either
 * changed since, nothing is sent: the editor reloads and checks it again. Duplicate and
 * concurrent submissions are refused by the database ("outcome recorded"). A stale
 * verification is never worked around: the form keeps the note while the editor verifies, and
 * they submit again. Nothing is replayed, and nothing is ever submitted for them.
 */

const UNAVAILABLE: EditState = { status: "error", message: "The catalog isn't available right now. Try again later." };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
const whole = (text: string) => (/^\d{1,18}$/.test(text) ? Number(text) : null);

// Not exported: every export of a "use server" file is an action a client can call.
const memberPath = (batch: string, game: string) => `/admin/catalog/batches/${batch}/members/${game}`;

export async function recordOutcome(_state: EditState, formData: FormData): Promise<EditState> {
  const batch = field(formData, "batch_id");
  const game = field(formData, "game_id");
  const seenRevision = whole(field(formData, "seen_revision"));
  const seenOutcome = field(formData, "seen_outcome") || null;
  if (!UUID.test(batch) || !UUID.test(game) || seenRevision === null) return { status: "error", message: outcomeErrorMessage("record unavailable") };
  const back = memberPath(batch, game);

  const supabase = await createSupabaseServerClient();
  if (!supabase) return UNAVAILABLE;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return UNAVAILABLE;

  // The member as it is now, read with the editor's session: refuse a stale page.
  const current = await getReviewBatchMember(batch, game);
  if (!current.ok) return current.reason === "refused" ? { status: "error", message: outcomeErrorMessage("not permitted") } : UNAVAILABLE;
  if (!current.data) return { status: "error", message: outcomeErrorMessage("record unavailable") };
  if (current.data.game.revision !== seenRevision || (current.data.member.outcome ?? null) !== seenOutcome) return { status: "error", message: outcomeErrorMessage("changed") };
  if (current.data.you.record) return { status: "error", message: RECORD_BLOCKS[current.data.you.record] ?? outcomeErrorMessage(null) };
  // A UI rule, stricter than record_batch_outcome: a stale member makes the batch unapprovable,
  // so an outcome for it would mean nothing. The page shows no form for one either.
  if (current.data.member.stale) return { status: "error", message: outcomeErrorMessage("stale") };

  const input = readOutcome((name) => field(formData, name), current.data.you.options);
  if ("error" in input) return { status: "error", message: input.error };

  const { error } = await supabase.rpc("record_batch_outcome", {
    p_batch: batch,
    p_game: game,
    p_outcome: input.value.outcome,
    p_critical_error: input.value.criticalError,
    p_note: input.value.note,
  });
  if (error) {
    if (error.message === "reauthentication required") return { status: "stepup", message: outcomeErrorMessage(error.message), href: stepUpHref(back) };
    return { status: "error", message: outcomeErrorMessage(error.message) };
  }
  refresh();
  redirect(`${back}?notice=recorded`);
}

/**
 * Without JavaScript: a stale verification goes straight to step-up, coming back to the member,
 * and any other refusal comes back to the member with its fixed message's code (never its text).
 * Nothing is replayed.
 */
export async function recordOutcomeFromForm(formData: FormData): Promise<void> {
  const state = await recordOutcome({ status: "idle", message: null }, formData);
  if (state.status === "stepup" && state.href) redirect(state.href);
  const batch = field(formData, "batch_id");
  const game = field(formData, "game_id");
  if (state.status === "error" && UUID.test(batch) && UUID.test(game)) redirect(`${memberPath(batch, game)}?error=${outcomeMessageCode(state.message)}`);
}
