"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { createSupabaseServerClient } from "@/features/auth/server";
import { searchCatalog } from "@/features/catalog/queries";
import { UUID, UUID_V7 } from "@/features/collection/uuid";
import { runSubmissionEnrichment } from "@/features/enrichment/server";

import { catalogMatches, readSubmission, readSubmissionChanges, submissionErrorMessage, type CatalogMatch } from "./form";
import { getMySubmission, getMySubmissionEnrichment } from "./queries";

/**
 * Catalog submissions (M7a). Each action verifies the session itself, and the M7a
 * functions check the account, the limit, ownership and every field again. Nothing
 * from the form names a submitter, a status or a verification: those aren't fields.
 * Messages are fixed; nothing from the database reaches the page.
 */

export type SubmissionState = {
  status: "idle" | "error" | "duplicate" | "saved" | "matches";
  message: string | null;
  /** For a duplicate: the published release, which is public. */
  href?: string;
  /** M15: published games the new game may be, found before anything is submitted. */
  matches?: CatalogMatch[];
};

const UNAVAILABLE: SubmissionState = { status: "error", message: "The catalog isn't available right now. Try again later." };
const SIGNED_OUT: SubmissionState = { status: "error", message: "Sign in to submit to the catalog." };
const EXPIRED: SubmissionState = { status: "error", message: "This form is out of date. Reload the page and submit again." };

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

  // M12b: the id made when the form was rendered, kept on a failure. It names the
  // submission request, so sending the form again (a double click, a retry after a lost
  // response) returns the submission it made instead of making another (submit_*_once),
  // and it names the copy added with it, which add_collection_item adds once.
  const requestId = field(formData, "copy_item_id");
  if (!UUID_V7.test(requestId)) return EXPIRED;

  const supabase = await createSupabaseServerClient();
  if (!supabase) return UNAVAILABLE;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return SIGNED_OUT;

  // M15: a new game is checked against the published catalog first, by its title, aliases and
  // local titles on the chosen platform. If it may already be there, nothing is submitted: the
  // collector opens the game (and adds their copy, or submits the missing release there), or
  // says it isn't one of these. A search that fails doesn't stop the submission: editors see
  // possible duplicates too.
  if (mode === "game" && input.title && field(formData, "not_listed") !== "on") {
    const title = input.title;
    const found = await searchCatalog(title, input.platform, null).catch(() => null);
    const matches = found?.ok ? catalogMatches(found.data, title, input.platform) : [];
    if (matches.length) {
      return {
        status: "matches",
        message: matches.length === 1 ? "This game may already be in the catalog." : "These games may already be in the catalog.",
        matches,
      };
    }
  }

  const shared = {
    p_request: requestId,
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
      ? await supabase.rpc("submit_game_once", { p_title: input.title, p_kind: input.gameKind, p_first_release_year: input.firstReleaseYear, ...shared })
      : await supabase.rpc("submit_release_once", { p_game: gameId, ...shared });
  if (error) return { status: "error", message: submissionErrorMessage(error.message) };

  const outcome = data as { outcome?: string; submission_id?: string; release_id?: string };
  if (outcome.outcome === "published_duplicate" && outcome.release_id) {
    // A release names its game through its platform pairing (M5): releases have no
    // foreign key to games of their own, so embedding games directly fails (PGRST200).
    const { data: release } = await supabase.from("releases").select("id, pairing:game_platforms(game:games(slug))").eq("id", outcome.release_id).maybeSingle();
    const slug = (release?.pairing as { game?: { slug?: string } | null } | null)?.game?.slug;
    return {
      status: "duplicate",
      message: "This release is already in the catalog, so there's nothing to submit. You can add your copy from its page.",
      href: slug ? `/games/${slug}?release=${outcome.release_id}` : undefined,
    };
  }
  if (outcome.outcome !== "submitted" || !outcome.submission_id) return { status: "error", message: submissionErrorMessage(null) };

  // M15: approved sources are looked up after the response, so the collector doesn't wait. The
  // submission already waits for it (a database trigger); a lookup that fails or never runs is
  // retried later.
  if (mode === "game") {
    const submissionId = outcome.submission_id;
    after(() => runSubmissionEnrichment({ submissionId }));
  }

  // M12b: the submitter's copy goes into their collection at once, on their own pending
  // release, through the ordinary add (M6b: can_use_release allows the submitter's own
  // submission). Its id is the request's, so a retry adds it if the first send didn't,
  // and never a second one. If adding fails, the submission stands and its page says so
  // and offers the add.
  let notice = "submitted";
  const copyId = requestId;
  if (field(formData, "add_copy") === "on" && outcome.release_id) {
    const { error: copyError } = await supabase.rpc("add_collection_item", { p_item_id: copyId, p_release: outcome.release_id, p_details: {} });
    notice = copyError ? "submitted_no_copy" : "submitted_copy";
  }
  refresh();
  redirect(`/submissions/${outcome.submission_id}?notice=${notice}`);
}

/** The same action for a native form post. A submission still redirects to its page. */
export async function submitToCatalogFromForm(formData: FormData): Promise<void> {
  const state = await submitToCatalog({ status: "idle", message: null }, formData);
  // M15: without JavaScript the possible matches are shown by the page itself, with what was typed.
  if (state.status === "matches") {
    const params = new URLSearchParams({ title: field(formData, "title").trim(), platform: field(formData, "platform"), region: field(formData, "region"), check: "1" });
    redirect(`/submit?${params}`);
  }
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
  // A changed title waits for a new lookup (the database re-queues it); run it now.
  if (current.created_game) after(() => runSubmissionEnrichment({ submissionId: id }));
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

/**
 * M15: runs the lookup of the caller's own new-game submission after the response, if it is due
 * (it failed, or never ran). The caller's own submissions only; the claim decides what is due.
 */
export async function runMyDueLookup(submissionId: string): Promise<void> {
  if (!UUID.test(submissionId)) return;
  const status = (await getMySubmissionEnrichment(submissionId))?.status;
  if (status !== "pending" && status !== "failed") return;
  after(() => runSubmissionEnrichment({ submissionId }));
}
