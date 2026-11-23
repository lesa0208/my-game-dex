/**
 * Review batches (M14c-2): the filters, labels and messages of the review pages, the form's
 * reading of an outcome, and the links built from a source record. Pure, so it can be tested
 * alone. Nothing here decides who may record what: record_batch_outcome does, and the pages
 * show what the database's own assessment says. The evidence check below only tells the editor,
 * before they submit, what the database will refuse.
 */

export const BATCH_STATUS_FILTERS = [
  { value: "open", label: "Open" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
] as const;
export type BatchStatusFilter = (typeof BATCH_STATUS_FILTERS)[number]["value"];

export function batchStatusFilter(value: unknown): BatchStatusFilter {
  return BATCH_STATUS_FILTERS.find((f) => f.value === value)?.value ?? "open";
}

export const BATCH_STATUS_LABELS: Record<string, string> = { open: "Open", approved: "Approved", rejected: "Rejected" };

export const MEMBER_FILTERS = [
  { value: "needs_review", label: "Awaiting review" },
  { value: "critical", label: "Critical risk" },
  { value: "flagged", label: "Flagged" },
  { value: "sampled", label: "Sampled" },
  { value: "reviewed", label: "Reviewed" },
  { value: "unsampled", label: "Not sampled" },
  { value: "all", label: "All" },
] as const;
export type MemberFilter = (typeof MEMBER_FILTERS)[number]["value"];

export function memberFilter(value: unknown): MemberFilter {
  return MEMBER_FILTERS.find((f) => f.value === value)?.value ?? "needs_review";
}

export type MemberCategory = "critical" | "flagged" | "sampled" | "unsampled";

export const CATEGORY_LABELS: Record<MemberCategory, string> = {
  critical: "Critical risk",
  flagged: "Flagged",
  sampled: "Sampled",
  unsampled: "Not sampled",
};

export const CATEGORY_DETAILS: Record<MemberCategory, string> = {
  critical: "A flag points to a possible critical error. It needs your individual review, and finding it correct needs evidence.",
  flagged: "Flagged by the validators. It needs your individual review.",
  sampled: "Drawn in the batch's random sample. It needs your individual review, and one not found correct fails the sample.",
  unsampled: "Not flagged and not sampled, so nobody reviews it individually. On approval its identity is verified only: its platform pairing stays unconfirmed and unpublished until an editor confirms physical existence with evidence.",
};

export type Outcome = "correct" | "incorrect" | "excluded";
export const OUTCOMES: Outcome[] = ["correct", "incorrect", "excluded"];

export const OUTCOME_LABELS: Record<Outcome, string> = { correct: "Correct", incorrect: "Incorrect", excluded: "Excluded" };

export const OUTCOME_DETAILS: Record<Outcome, string> = {
  correct: "The identity, its platform and physical existence are right, and you have evidence of a physical copy.",
  incorrect: "Something about it is wrong. It isn't published with the batch, and an incorrect sampled member fails the sample.",
  excluded: "It doesn't belong in the physical catalog (or in this batch). It isn't published with the batch.",
};

/** The critical-error categories record_batch_outcome accepts (catalog_review_batch_items.critical_error). */
export const CRITICAL_ERRORS = {
  wrong_identity_or_type: "Incorrect game identity or game type (not a game, a compilation or edition taken for a game, two games as one)",
  wrong_platform: "Wrong platform association",
  physical_eligibility_unsupported: "Physical-catalog eligibility not supported (digital-only, broadcast, prototype, homebrew, unreleased)",
  distinct_games_merged: "Distinct games merged into one identity",
  conflicting_duplicate_identities: "Duplicate identities that would create conflicting canonical games",
  conflicting_identifiers: "Conflicting authoritative identifiers",
  missing_provenance: "Missing provenance for a required validation fact",
} as const;
export type CriticalError = keyof typeof CRITICAL_ERRORS;

export function criticalErrorLabel(code: string | null): string | null {
  return code ? ((CRITICAL_ERRORS as Record<string, string>)[code] ?? code.replace(/_/g, " ")) : null;
}

/**
 * Why a validator flag holds or marks a record (scripts/wikidata-entities.mjs FLAG_REASONS; a
 * unit test keeps them the same). An unknown flag is shown by its code, never hidden.
 */
export const FLAG_REASONS: Record<string, string> = {
  mul_label_only: "Title comes only from Wikidata's language-neutral label; an English title needs confirming.",
  no_release_date: "No release date stated; the release (and that it happened at all) needs evidence.",
  year_precision_only: "Release date is only a year; the date needs a precise source.",
  platform_date_before_launch: "The platform release date is before the platform launched: possibly the wrong platform.",
  platform_date_after_era: "The platform release date is long after the platform's era: an aftermarket or late release, a reissue or a data error; the specific physical release needs evidence.",
  other_instance_of: "Wikidata also types it as something other than a video game (for example an unlicensed or pirate game, software or a compilation).",
  distribution_format_unclassified: "States a distribution format nobody has classified yet.",
  distribution_non_physical: "Every distribution format stated for this platform is non-physical (digital): possibly a digital-only title on this platform.",
  external_ids_multiple: "Carries several IGDB or MobyGames ids: possibly provider duplicates, per-platform or regional records, or distinct games merged into one item.",
  entity_detail_pending: "Only query-snapshot fields are available; the full entity record is missing.",
  title_collision_in_batch: "Another record in this batch has the same title key: a possible duplicate or a distinct game with the same name.",
  external_id_shared_in_batch: "Shares an IGDB or MobyGames id with another record in this batch.",
  catalog_title_match_same_platform: "A catalog game on the same platform has the same title.",
  catalog_title_match_other_platform: "A catalog game on another platform has the same title.",
  title_collision_unicode_artifact: "Collided only under the old key, which dropped a character such as \"Ⅱ\"; the titles differ.",
  catalog_source_id_linked: "Its Wikidata id is already linked to a catalog game.",
  many_platforms: "Stated on more than four platforms: the item may describe a franchise entry with several distinct versions.",
  distribution_also_non_physical: "Also states a digital distribution format; that alone doesn't rule out a physical release.",
  distribution_medium_not_platform: "States a physical medium this platform doesn't use (for example a disc for a cartridge system): the statement is about another platform's version.",
};

export function flagReason(flag: string): string {
  return FLAG_REASONS[flag] ?? "A flag these pages don't describe yet. Check the source record.";
}

/** A flag's code in words, for a compact list. */
export function flagLabel(flag: string): string {
  const words = flag.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Wikidata distribution formats as the importer classifies them (scripts/wikidata-entities.mjs; a unit test keeps them the same). */
export const DISTRIBUTION_FORMATS: Record<string, { label: string; physical: boolean }> = {
  Q5293: { label: "floppy disk", physical: true },
  Q7982: { label: "CD-ROM", physical: true },
  Q34467: { label: "compact disc", physical: true },
  Q47770: { label: "Blu-ray Disc", physical: true },
  Q149757: { label: "compact cassette", physical: true },
  Q160710: { label: "read-only memory", physical: true },
  Q234870: { label: "optical disc", physical: true },
  Q269415: { label: "digital distribution", physical: false },
  Q633454: { label: "ROM cartridge", physical: true },
  Q849572: { label: "GD-ROM", physical: true },
  Q17048824: { label: "Super Nintendo Entertainment System Game Pak", physical: true },
  Q54820071: { label: "digital download", physical: false },
};

export function distributionFormatLabel(q: string): string {
  const f = DISTRIBUTION_FORMATS[q];
  return f ? `${f.label} (${f.physical ? "physical medium" : "digital"})` : `${q} (not classified)`;
}

/**
 * Links to a source record, built only from values of a fixed shape: a Wikidata item id and a
 * positive revision number. Anything else gets no link. Provider text is never a URL here.
 */
export function sourceLinks(provider: string, externalId: string | null, revision: number | null): { item: string | null; revision: string | null } {
  if (provider !== "wikidata" || !externalId || !/^Q[1-9]\d{0,11}$/.test(externalId)) return { item: null, revision: null };
  return {
    item: `https://www.wikidata.org/wiki/${externalId}`,
    revision: revision !== null && Number.isSafeInteger(revision) && revision > 0 ? `https://www.wikidata.org/w/index.php?oldid=${revision}` : null,
  };
}

export function itemLink(q: string): string | null {
  return /^Q[1-9]\d{0,11}$/.test(q) ? `https://www.wikidata.org/wiki/${q}` : null;
}

/** As private.evidence_note_ok decides (M14c-1): 20 to 500 characters once whitespace is collapsed, 10 of them letters or digits. */
export function evidenceNoteOk(note: string | null): boolean {
  if (note === null) return false;
  if ([...note].length > 500) return false;
  const collapsed = note.replace(/^\s+|\s+$/g, "").replace(/\s+/g, " ");
  if ([...collapsed].length < 20) return false;
  return [...note.replace(/[^\p{L}\p{N}]/gu, "")].length >= 10;
}

export const EVIDENCE_GUIDANCE =
  "Say what shows a physical copy exists on this platform, and where you saw it: for example the cartridge, box or manual photographed, its label or product code, and a catalog, auction or museum listing you checked. A provider listing alone isn't evidence.";

type Read = (name: string) => string;
type Result<T> = { value: T } | { error: string };

/**
 * Every message the outcome form can show, by a fixed code. The page without JavaScript gets an
 * error back by its code in the URL, so only these texts can ever appear there.
 */
export const OUTCOME_MESSAGES = {
  choose: "Choose an outcome.",
  critical_list: "Choose a critical error from the list, or none.",
  critical_correct: "A member found correct has no critical error.",
  evidence: "Describe the physical evidence you checked: at least 20 characters, with at least 10 letters or digits, and at most 500.",
  note_long: "The note can be up to 1,000 characters.",
  confirm_correct: "Confirm that you checked this evidence yourself.",
  confirm: "Confirm the outcome: it can't be undone.",
  not_permitted: "Only active catalog editors with a verified session can review batches.",
  reauthenticate: "Recording an outcome needs a recent verification with your authenticator.",
  own_record: "You created this batch, or this game or its pairing, so another editor reviews it.",
  outcome_recorded: "An outcome is already recorded for this member, and it can't change that way. Reload the page to see it.",
  approval_started: "An approval has been recorded for this batch, so its outcomes are locked.",
  unavailable: "This member can't take an outcome: the batch is closed, or the member isn't reviewed individually. Reload the page.",
  invalid: "Check the outcome, the critical error and the note, and try again.",
  changed: "This member changed since you opened it. Reload the page and check it again.",
  stale: "This member changed since the batch was frozen, or left review, so no outcome is recorded for it: the batch has to be rejected.",
  failed: "The outcome couldn't be recorded. Try again.",
} as const;
export type OutcomeMessage = keyof typeof OUTCOME_MESSAGES;

/** The code of a fixed message (or of a RECORD_BLOCKS reason, as "block_<reason>"), for the URL. */
export function outcomeMessageCode(text: string | null): string {
  const code = Object.entries(OUTCOME_MESSAGES).find(([, t]) => t === text)?.[0];
  if (code) return code;
  const block = Object.entries(RECORD_BLOCKS).find(([, t]) => t === text)?.[0];
  return block ? `block_${block}` : "failed";
}

/** The message for a code from the URL; unknown codes show nothing. */
export function outcomeMessage(code: string | null): string | null {
  if (!code) return null;
  if (Object.hasOwn(OUTCOME_MESSAGES, code)) return OUTCOME_MESSAGES[code as OutcomeMessage];
  const block = code.startsWith("block_") ? code.slice(6) : null;
  return block && Object.hasOwn(RECORD_BLOCKS, block) ? RECORD_BLOCKS[block] : null;
}

export type OutcomeInput = { outcome: Outcome; criticalError: CriticalError | null; note: string | null };

/**
 * The outcome form, read: the outcome, an optional critical error (never with "correct"), and
 * the note exactly as typed (the database trims its ends). "Correct" needs evidence, and every
 * outcome needs its confirmation box ticked. Checks only what the form itself can know.
 */
export function readOutcome(read: Read, options: readonly string[]): Result<OutcomeInput> {
  const outcome = read("outcome") as Outcome;
  if (!OUTCOMES.includes(outcome) || !options.includes(outcome)) return { error: OUTCOME_MESSAGES.choose };
  const critical = read("critical_error");
  if (critical && !Object.hasOwn(CRITICAL_ERRORS, critical)) return { error: OUTCOME_MESSAGES.critical_list };
  if (critical && outcome === "correct") return { error: OUTCOME_MESSAGES.critical_correct };
  const raw = read("note");
  const note = raw.trim() ? raw : null;
  if (outcome === "correct") {
    if (!evidenceNoteOk(note)) return { error: OUTCOME_MESSAGES.evidence };
  } else if (raw.length > 1000) {
    return { error: OUTCOME_MESSAGES.note_long };
  }
  if (read("confirm") !== "on") return { error: outcome === "correct" ? OUTCOME_MESSAGES.confirm_correct : OUTCOME_MESSAGES.confirm };
  return { value: { outcome, criticalError: (critical || null) as CriticalError | null, note } };
}

/** Why the caller can't record an outcome for a member (get_review_batch_member's you.record). */
export const RECORD_BLOCKS: Record<string, string> = {
  not_open: "This batch is closed, so its outcomes can't change.",
  you_created_batch: "You created this batch, so another editor reviews its members.",
  approval_started: "An approval has been recorded for this batch, so its outcomes are locked.",
  not_required: "Nobody reviews this member individually: it isn't flagged or sampled.",
  you_created_record: "You created or submitted this game or its platform pairing, so another editor reviews it.",
  outcome_final: "Its outcome is recorded and final. A mistaken finding is undone only by rejecting the batch and reviewing a new one.",
};

/** What approve_review_batch would refuse now (get_review_batch_overview's blockers). */
export function blockerText(code: string, count: number): string {
  const n = count.toLocaleString("en");
  switch (code) {
    case "pending_outcomes":
      return `${n} ${count === 1 ? "member still needs its" : "members still need their"} individual review.`;
    case "sample_failed":
      return `The sample failed: ${n} sampled ${count === 1 ? "member wasn't" : "members weren't"} found correct, more than the acceptance number allows (or one has a critical error). The batch has to be rejected; nothing is accepted automatically.`;
    case "critical_errors_unresolved":
      return `${n} ${count === 1 ? "member has" : "members have"} a critical error marked incorrect. Exclude ${count === 1 ? "it" : "them"}, or reject the batch.`;
    case "evidence_missing":
      return `${n} ${count === 1 ? "member was" : "members were"} found correct without a qualifying evidence note (recorded before notes were required). The batch has to be rejected and reviewed again.`;
    case "stale":
      return `${n} ${count === 1 ? "member has" : "members have"} changed since the batch was frozen, or left review. The batch has to be rejected.`;
    case "publication_rights":
      return `${n} ${count === 1 ? "source isn't" : "sources aren't"} cleared for publication under the terms ${count === 1 ? "it was" : "they were"} imported with.`;
    default:
      return "Something else holds the approval.";
  }
}

/** Why the caller couldn't approve, whatever the blockers (overview's you.approve). */
export const APPROVE_BLOCKS: Record<string, string> = {
  not_open: "This batch is closed.",
  you_created_batch: "You created this batch, so another editor approves it.",
  you_created_member: "You created or submitted one of its members, so another editor approves it.",
  you_already_approved: "You have already approved it; it needs another approver.",
};

/** Why the caller can't record outcomes anywhere in this batch (overview's you.review). */
export const REVIEW_BLOCKS: Record<string, string> = {
  not_open: "This batch is closed, so its outcomes can't change.",
  you_created_batch: "You created this batch, so you can't review its members. Another editor does.",
  approval_started: "An approval has been recorded, so the outcomes are locked.",
};

/** The database's fixed errors for recording an outcome, as messages. Nothing else from the database is shown. */
export function outcomeErrorMessage(message: unknown): string {
  const codes: Record<string, OutcomeMessage> = {
    "not permitted": "not_permitted",
    "reauthentication required": "reauthenticate",
    "own record": "own_record",
    "evidence required": "evidence",
    "outcome recorded": "outcome_recorded",
    "batch approval started": "approval_started",
    "record unavailable": "unavailable",
    "invalid changes": "invalid",
    changed: "changed",
    stale: "stale",
  };
  return OUTCOME_MESSAGES[typeof message === "string" && Object.hasOwn(codes, message) ? codes[message] : "failed"];
}

/** The tone of a batch status, never shown by colour alone. */
export function batchTone(status: string): "good" | "warning" | "problem" | "neutral" {
  return status === "approved" ? "good" : status === "rejected" ? "problem" : "warning";
}

/** A ratio as a percentage, as the sampling policy states it. */
export function percent(value: number): string {
  return `${(value * 100).toLocaleString("en", { maximumFractionDigits: 2 })}%`;
}

// ---------------------------------------------------------------------------
// Approving and rejecting a batch (M14c-3).
// ---------------------------------------------------------------------------

export type Decision = "approve" | "reject";

/** Every message the decision forms can show, by a fixed code (as OUTCOME_MESSAGES). */
export const DECISION_MESSAGES = {
  reason: "Give a reason for the record. Other catalog staff can see it.",
  reason_long: "The reason can be up to 500 characters.",
  confirm_id: "Type the batch's first 8 characters exactly, to confirm.",
  acknowledge: "Confirm that you've read what this does.",
  changed: "This batch changed since you opened it: an outcome or an approval was recorded, or it was decided. Reload the page and check it again.",
  not_permitted: "Only active catalog editors with a verified session can decide batches.",
  reauthenticate: "Deciding a batch needs a recent verification with your authenticator.",
  unavailable: "This batch is closed, so it can't be approved or rejected. Reload the page.",
  own_record: "You created this batch or one of its members, so another editor approves it.",
  already_approved: "You have already approved this batch. It needs another editor's approval.",
  not_reviewed: "Some members still need their individual review. The batch wasn't approved.",
  sample_failed: "The sample failed, so the batch can't be approved. Reject it.",
  critical: "A critical error is marked incorrect, so the batch can't be approved.",
  evidence: "A member found correct has no qualifying evidence note, so the batch can't be approved. Reject it, and review it again.",
  stale: "A member changed since the batch was frozen, or left review, so the batch can't be approved. Reject it.",
  rights: "A source isn't cleared for publication under the terms it was imported with, so the batch can't be approved.",
  failed: "The batch couldn't be decided. Nothing was changed. Try again.",
} as const;
export type DecisionMessage = keyof typeof DECISION_MESSAGES;

/** The database's fixed errors for approve_review_batch and reject_review_batch, as message codes. */
export function decisionErrorCode(message: unknown): DecisionMessage {
  const codes: Record<string, DecisionMessage> = {
    "not permitted": "not_permitted",
    "reauthentication required": "reauthenticate",
    "record unavailable": "unavailable",
    "own record": "own_record",
    "already approved": "already_approved",
    "batch not reviewed": "not_reviewed",
    "sample failed": "sample_failed",
    "critical errors unresolved": "critical",
    "evidence required": "evidence",
    "batch stale": "stale",
    "provider not cleared": "rights",
    "reason required": "reason",
    "batch changed": "changed",
    changed: "changed",
  };
  return typeof message === "string" && Object.hasOwn(codes, message) ? codes[message] : "failed";
}

/** A decision message for a code from the URL; unknown codes show nothing. */
export function decisionMessage(code: string | null): string | null {
  return code && Object.hasOwn(DECISION_MESSAGES, code) ? DECISION_MESSAGES[code as DecisionMessage] : null;
}

/**
 * The decision form, read: a reason (typed, kept in the audit log), the batch's first 8
 * characters typed exactly, and the acknowledgement box. Nothing is preselected, and the
 * database decides everything else when it runs.
 */
export function readDecision(read: (name: string) => string, batchId: string): { value: { reason: string } } | { error: DecisionMessage } {
  const reason = read("reason").replace(/\s+/g, " ").trim();
  if (!reason) return { error: "reason" };
  if (reason.length > 500) return { error: "reason_long" };
  if (read("confirm_id").trim() !== batchId.slice(0, 8)) return { error: "confirm_id" };
  if (read("acknowledge") !== "on") return { error: "acknowledge" };
  return { value: { reason } };
}

/** What approving would do to members, as get_batch_approval_preview names it. */
export const EFFECT_LABELS: Record<string, string> = {
  publish: "Confirmed and published",
  await_publication: "Confirmed, waiting for another editor to publish",
  reviewer_gone: "Confirmed without a verifier: can't be published until confirmed again",
  confirm: "Confirmed at the final approval",
  identity_only: "Identity verified only: no physical evidence, not published",
  not_accepted: "Not accepted: nothing changes",
  pending: "Needs its review first",
};

export const EFFECT_DETAILS: Record<string, string> = {
  publish: "Found correct with evidence by another editor. Its identity is verified, its physical existence on the platform confirmed with the reviewer's evidence, and it becomes public as an identity, with no physical release.",
  await_publication: "Found correct, and you reviewed it. Its identity is verified and its physical existence confirmed, but whoever confirmed the evidence never publishes it: another editor publishes it from the publication queue.",
  reviewer_gone: "Found correct, but its reviewer's account has since been deleted. Its identity is verified and its pairing marked confirmed with no verifier, which publication refuses: an editor has to confirm its physical existence again before anyone can publish it.",
  confirm: "Found correct. This approval isn't the final one, so nothing is verified yet. At the final approval it is confirmed, and published unless the final approver reviewed it.",
  identity_only: "Not flagged and not sampled, so nobody checked it individually. At the final approval its identity is verified, but its pairing stays unconfirmed and unpublished until an editor confirms its physical existence with evidence.",
  not_accepted: "Found incorrect or excluded. Approval leaves it as it is.",
  pending: "It needs its individual review, so the batch can't be approved yet.",
};

/** Approval's result, as approve_review_batch returns it, for the notice after it. */
export type ApprovalResult =
  | { status: "awaiting_approval"; approvals: number; required: number }
  | { status: "approved"; published: number; awaiting_physical_evidence: number; awaiting_independent_publication: number };

/** The notice after a decision, from the URL's numbers (bounded); unknown values show nothing. */
export function decisionNotice(params: { notice: string | null; n: (name: string) => number | null }): string | null {
  const count = (name: string) => {
    const v = params.n(name);
    return v === null ? null : v.toLocaleString("en");
  };
  switch (params.notice) {
    case "approval_recorded": {
      const a = count("approvals");
      const r = count("required");
      return a && r ? `Your approval is recorded: ${a} of ${r} approvals. The batch is still open; nothing is verified or published until the last approval.` : null;
    }
    case "approved": {
      const p = count("published");
      const e = count("awaiting_evidence");
      const i = count("awaiting_publication");
      return p && e && i
        ? `Approved. ${p} published as identities; ${i} confirmed and waiting for another editor to publish; ${e} verified as identities only, waiting for physical evidence.`
        : null;
    }
    case "rejected":
      return "Rejected. The batch is closed for good; its outcomes and audit history are kept, and its games and source records are unchanged.";
    default:
      return null;
  }
}
