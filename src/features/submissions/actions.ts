"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";

import { readSubmission, readSubmissionChanges, submissionErrorMessage } from "./form";
import { getMySubmission } from "./queries";

/**
 * Catalog submissions (M7a). Each action verifies the session itself, and the M7a
 * functions check the account, the limit, ownership and every field again. Nothing
 * from the form names a submitter, a status or a verification: those aren't fields.
 * Messages are fixed; nothing from the database reaches the page.
 */

export type SubmissionState = {
  status: "idle" | "error" | "duplicate" | "saved";
  message: string | null;
  /** For a duplicate: the published release, which is public. */
  href?: string;
};

const UNAVAILABLE: SubmissionState = { status: "error", message: "The catalog isn't available right now. Try again later." };
const SIGNED_OUT: SubmissionState = { status: "error", message: "Sign in to submit to the catalog." };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
const thisYear = () => new Date().getUTCFullYear();

export async function submitToCatalog(_state: SubmissionState, formData: FormData): Promise<SubmissionState> {
  const mode = field(formData, "mode") === "game" ? "game" : "release";
  const gameId = field(formData, "game_id");
  if (mode === "release" && !UUID.test(gameId)) return { status: "error", message: submissionErrorMessage("game unavailable") };
  const read = readSubmission((name) => field(formData, name), mode, thisYear());
  if ("error" in read) return { status: "error", message: read.error };
  const input = read.value;

  const supabase = await createSupabaseServerClient();
  if (!supabase) return UNAVAILABLE;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return SIGNED_OUT;

  const shared = {
    p_platform: input.platform,
    p_media_format: input.mediaFormat,
    p_region: input.region,
    p_details: input.details,
    p_components: input.components,
    p_note: input.note,
    p_physical: true,
  };
  const { data, error } =
    mode === "game"
      ? await supabase.rpc("submit_game", { p_title: input.title, p_kind: input.gameKind, p_first_release_year: input.firstReleaseYear, ...shared })
      : await supabase.rpc("submit_release", { p_game: gameId, ...shared });
  if (error) return { status: "error", message: submissionErrorMessage(error.message) };

  const outcome = data as { outcome?: string; submission_id?: string; release_id?: string };
  if (outcome.outcome === "published_duplicate" && outcome.release_id) {
    const { data: release } = await supabase.from("releases").select("id, game:games(slug)").eq("id", outcome.release_id).maybeSingle();
    const slug = (release?.game as { slug?: string } | null)?.slug;
    return {
      status: "duplicate",
      message: "This release is already in the catalog, so there's nothing to submit. You can add your copy from its page.",
      href: slug ? `/games/${slug}?release=${outcome.release_id}` : undefined,
    };
  }
  if (outcome.outcome !== "submitted" || !outcome.submission_id) return { status: "error", message: submissionErrorMessage(null) };
  refresh();
  redirect(`/submissions/${outcome.submission_id}?notice=submitted`);
}

/** The same action for a native form post. A submission still redirects to its page. */
export async function submitToCatalogFromForm(formData: FormData): Promise<void> {
  await submitToCatalog({ status: "idle", message: null }, formData);
}

/**
 * Saves changes to an unreviewed submission. Whether its game is a new one comes from
 * the submission, as the caller, not from the form.
 */
export async function updateMySubmission(_state: SubmissionState, formData: FormData): Promise<SubmissionState> {
  const id = field(formData, "submission_id");
  if (!UUID.test(id)) return { status: "error", message: submissionErrorMessage("submission unavailable") };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return UNAVAILABLE;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return SIGNED_OUT;

  const current = await getMySubmission(id);
  if (current === undefined) return UNAVAILABLE;
  if (!current) return { status: "error", message: submissionErrorMessage("submission unavailable") };
  const read = readSubmissionChanges((name) => field(formData, name), current.created_game, thisYear());
  if ("error" in read) return { status: "error", message: read.error };

  const { error } = await supabase.rpc("update_my_submission", { p_submission: id, p_changes: read.value });
  if (error) return { status: "error", message: submissionErrorMessage(error.message) };
  refresh();
  return { status: "saved", message: "Your submission is updated." };
}

export async function updateMySubmissionFromForm(formData: FormData): Promise<void> {
  await updateMySubmission({ status: "idle", message: null }, formData);
}

/**
 * Sends a submission back for review (M7b-1): after changes were requested, as the
 * same submission; after a rejection, as a new one linked to it, which counts toward
 * today's limit. Lands on the submission that's now waiting.
 */
export async function resubmitMySubmission(_state: SubmissionState, formData: FormData): Promise<SubmissionState> {
  const id = field(formData, "submission_id");
  if (!UUID.test(id)) return { status: "error", message: submissionErrorMessage("submission unavailable") };
  const note = field(formData, "note").replace(/\r\n/g, "\n").trim();
  if (note.length > 1000) return { status: "error", message: "The note can be up to 1,000 characters." };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return UNAVAILABLE;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return SIGNED_OUT;

  const { data, error } = await supabase.rpc("resubmit_my_submission", { p_submission: id, p_note: note || null });
  if (error) return { status: "error", message: submissionErrorMessage(error.message) };
  const next = (data as { submission_id?: string } | null)?.submission_id;
  if (!next || !UUID.test(next)) return { status: "error", message: submissionErrorMessage(null) };
  refresh();
  redirect(`/submissions/${next}?notice=resubmitted`);
}

/** Withdraws an unreviewed submission, then shows it as withdrawn. */
export async function withdrawMySubmission(_state: SubmissionState, formData: FormData): Promise<SubmissionState> {
  const id = field(formData, "submission_id");
  if (!UUID.test(id)) return { status: "error", message: submissionErrorMessage("submission unavailable") };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return UNAVAILABLE;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return SIGNED_OUT;

  const { error } = await supabase.rpc("withdraw_my_submission", { p_submission: id });
  if (error) return { status: "error", message: submissionErrorMessage(error.message) };
  refresh();
  redirect(`/submissions/${id}?notice=withdrawn`);
}
