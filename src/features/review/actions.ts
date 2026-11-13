"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";
import { getSubmissionOptions } from "@/features/submissions/queries";

import { piecesEditable, readGameCorrections, readNote, readPieceCorrections, readReason, readReleaseCorrections, reviewErrorMessage } from "./form";
import { getSubmissionReview } from "./queries";

/**
 * Catalog review (M7b-1). Each action verifies the session itself, and the database
 * checks the editor's role, self-review, the request's version and the records'
 * revisions again. Versions and revisions come from the page the editor read, so a
 * stale page is refused rather than acting on something they didn't see. Messages are
 * fixed; nothing from the database reaches the page.
 */

export type ReviewState = { status: "idle" | "error" | "saved"; message: string | null };

const UNAVAILABLE: ReviewState = { status: "error", message: "The catalog isn't available right now. Try again later." };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
const whole = (text: string) => (/^\d{1,18}$/.test(text) ? Number(text) : null);
const thisYear = () => new Date().getUTCFullYear();

async function signedIn() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getClaims();
  return auth?.claims?.sub ? supabase : null;
}

type Decision = "start" | "approve" | "changes" | "reject";
const NOTICE: Record<Decision, string> = { start: "started", approve: "approved", changes: "changes_requested", reject: "rejected" };

/** Starts, approves, asks for changes or rejects, by the form's `decision`. Success lands on the review page. */
export async function decideSubmission(_state: ReviewState, formData: FormData): Promise<ReviewState> {
  const decision = field(formData, "decision") as Decision;
  if (!(decision in NOTICE)) return { status: "error", message: reviewErrorMessage(null) };
  const id = field(formData, "request_id");
  const version = whole(field(formData, "version"));
  if (!UUID.test(id) || version === null) return { status: "error", message: reviewErrorMessage("submission unavailable") };
  const reason = readReason((name) => field(formData, name));
  if ("error" in reason) return { status: "error", message: reason.error };
  const note = readNote((name) => field(formData, name), decision === "changes");
  if ("error" in note) return { status: "error", message: note.error };

  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  let error: { message: string } | null = null;
  if (decision === "start") {
    ({ error } = await supabase.rpc("start_submission_review", { p_request: id, p_expected_version: version, p_reason: reason.value }));
  } else if (decision === "approve") {
    const releaseRevision = whole(field(formData, "release_revision"));
    const gameText = field(formData, "game_revision");
    const gameRevision = gameText ? whole(gameText) : null;
    if (releaseRevision === null || (gameText && gameRevision === null)) return { status: "error", message: reviewErrorMessage("record changed") };
    ({ error } = await supabase.rpc("approve_submission", {
      p_request: id,
      p_expected_version: version,
      p_release_revision: releaseRevision,
      p_game_revision: gameRevision,
      p_reason: reason.value,
      p_note: note.value,
    }));
  } else if (decision === "changes") {
    ({ error } = await supabase.rpc("request_submission_changes", { p_request: id, p_expected_version: version, p_note: note.value, p_reason: reason.value }));
  } else {
    ({ error } = await supabase.rpc("reject_submission", { p_request: id, p_expected_version: version, p_reason: reason.value, p_note: note.value }));
  }
  if (error) return { status: "error", message: reviewErrorMessage(error.message) };
  refresh();
  redirect(`/review/${id}?notice=${NOTICE[decision]}`);
}

export async function decideSubmissionFromForm(formData: FormData): Promise<void> {
  await decideSubmission({ status: "idle", message: null }, formData);
}

/**
 * Saves an editor's corrections to a submission in review, through the M5a editor
 * functions (product owner decision 4). Only fields that differ from the record as
 * it is now are sent, and only if the record is still at the revision the page showed.
 */
export async function correctSubmission(_state: ReviewState, formData: FormData): Promise<ReviewState> {
  const targetText = field(formData, "target");
  const target = targetText === "game" || targetText === "pieces" ? targetText : "release";
  const id = field(formData, "request_id");
  const revision = whole(field(formData, "revision"));
  if (!UUID.test(id) || revision === null) return { status: "error", message: reviewErrorMessage("submission unavailable") };
  const reason = readReason((name) => field(formData, name));
  if ("error" in reason) return { status: "error", message: reason.error };

  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const item = await getSubmissionReview(id);
  if (item === undefined) return UNAVAILABLE;
  if (!item || !item.release) return { status: "error", message: reviewErrorMessage("submission unavailable") };
  if (item.request.status !== "in_review") return { status: "error", message: reviewErrorMessage("submission not in review") };
  const read = (name: string) => field(formData, name);

  if (target === "game") {
    if (!item.request.created_game || !item.game) return { status: "error", message: reviewErrorMessage("submission unavailable") };
    if (item.game.revision !== revision) return { status: "error", message: reviewErrorMessage("record changed") };
    const changes = readGameCorrections(read, item.game, thisYear());
    if ("error" in changes) return { status: "error", message: changes.error };
    if (Object.keys(changes.value).length === 0) return { status: "error", message: "Nothing has changed." };
    const { error } = await supabase.rpc("update_game", { p_game: item.game.id, p_changes: changes.value, p_reason: reason.value });
    if (error) return { status: "error", message: reviewErrorMessage(error.message) };
  } else if (target === "pieces") {
    if (item.release.revision !== revision) return { status: "error", message: reviewErrorMessage("record changed") };
    if (!piecesEditable(item.release.components)) return { status: "error", message: "This release lists pieces this form can't show, so it can't change them." };
    const pieces = readPieceCorrections(read, whole(field(formData, "piece_rows")) ?? 0, item.release.components);
    if ("error" in pieces) return { status: "error", message: pieces.error };
    if (!pieces.value) return { status: "error", message: "Nothing has changed." };
    const { error } = await supabase.rpc("set_release_components", { p_release: item.release.id, p_components: pieces.value, p_reason: reason.value });
    if (error) return { status: "error", message: reviewErrorMessage(error.message) };
  } else {
    if (item.release.revision !== revision) return { status: "error", message: reviewErrorMessage("record changed") };
    const options = await getSubmissionOptions();
    if (!options) return UNAVAILABLE;
    const changes = readReleaseCorrections(read, item.release, options.regions.map((r) => r.code), thisYear());
    if ("error" in changes) return { status: "error", message: changes.error };
    if (Object.keys(changes.value).length === 0) return { status: "error", message: "Nothing has changed." };
    const { error } = await supabase.rpc("update_release", { p_release: item.release.id, p_changes: changes.value, p_reason: reason.value });
    if (error) return { status: "error", message: reviewErrorMessage(error.message) };
  }
  refresh();
  redirect(`/review/${id}?notice=corrected`);
}

export async function correctSubmissionFromForm(formData: FormData): Promise<void> {
  await correctSubmission({ status: "idle", message: null }, formData);
}
