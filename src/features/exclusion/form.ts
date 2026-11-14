/**
 * Excluding releases and restoring exclusions (M7b-2b): the fixed reason codes, the
 * rules for what an editor or administrator enters, and the database's fixed errors as
 * messages. No server-only imports, so the unit tests and client forms can use it.
 */

/** Why a release is outside the physical-only scope (D7). Owners of preserved copies see the label. */
export const EXCLUSION_REASONS = [
  { code: "download_code", label: "A download code, not a game on a medium" },
  { code: "game_key_card", label: "A game-key card, which holds no game" },
  { code: "installer_only", label: "Installer or launcher only" },
  { code: "no_game_data", label: "The medium holds no game data" },
  { code: "not_physical_release", label: "Not a physical release" },
  { code: "other", label: "Outside the catalog's physical-only scope" },
] as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number]["code"];

export function exclusionReasonLabel(code: string | null | undefined): string {
  return EXCLUSION_REASONS.find((r) => r.code === code)?.label ?? "Outside the catalog's physical-only scope";
}

export const OWNER_NOTE_MAX = 1000;
export const STAFF_REASON_MAX = 500;

type Read = (name: string) => string;
type Result<T> = { value: T } | { error: string };

export type ExclusionInput = {
  reasonCode: ExclusionReason;
  reason: string;
  ownerNote: string | null;
  acknowledgeCascade: boolean;
  acknowledgeCopies: boolean;
};

/** What an editor entered to exclude a release, checked as the database will. */
export function readExclusion(read: Read, needs: { cascade: boolean; copies: boolean }): Result<ExclusionInput> {
  const code = read("reason_code");
  const reasonCode = EXCLUSION_REASONS.find((r) => r.code === code)?.code;
  if (!reasonCode) return { error: "Choose why the release is outside the catalog's scope." };
  const reason = read("reason").replace(/\s+/g, " ").trim();
  if (!reason) return { error: "Give a reason for the record. Only staff see it." };
  if (reason.length > STAFF_REASON_MAX) return { error: `The reason can be up to ${STAFF_REASON_MAX} characters.` };
  const note = read("owner_note").trim();
  if (note.length > OWNER_NOTE_MAX) return { error: `The note to owners can be up to ${OWNER_NOTE_MAX} characters.` };
  const acknowledgeCascade = read("acknowledge_cascade") === "yes";
  const acknowledgeCopies = read("acknowledge_copies") === "yes";
  if ((needs.cascade && !acknowledgeCascade) || (needs.copies && !acknowledgeCopies)) {
    return { error: "Confirm each effect listed above before excluding." };
  }
  return { value: { reasonCode, reason, ownerNote: note || null, acknowledgeCascade, acknowledgeCopies } };
}

/** An administrator's reason for restoring an exclusion. */
export function readRestoreReason(read: Read): Result<string> {
  const reason = read("reason").replace(/\s+/g, " ").trim();
  if (!reason) return { error: "Give a reason for the record. Only staff see it." };
  if (reason.length > STAFF_REASON_MAX) return { error: `The reason can be up to ${STAFF_REASON_MAX} characters.` };
  return { value: reason };
}

/** The fixed errors from exclude_release and restore_exclusion, as messages for staff. */
export function exclusionErrorMessage(message: unknown): string {
  switch (message) {
    case "not permitted":
      return "Only active catalog editors can exclude releases, and only administrators can restore them.";
    case "own submission":
      return "You submitted this, so another member of staff has to decide.";
    case "own exclusion":
      return "You excluded this, so another administrator has to restore it.";
    case "preview stale":
      return "This release changed since you read this page. Review the effects again.";
    case "request conflict":
      return "Something changed while this was saving. Reload the page and try again.";
    case "exclusion blocked":
      return "Something listed above blocks this exclusion. Resolve it first.";
    case "acknowledgement required":
      return "Confirm each effect listed above before excluding.";
    case "release unavailable":
      return "This release can't be excluded: it's already excluded or merged, or doesn't exist.";
    case "exclusion unavailable":
      return "This exclusion has already been restored, or doesn't exist.";
    case "exclusion changed":
      return "A record this exclusion changed has changed again since, so it can't be restored as it was.";
    case "restore blocked":
      return "Restoring this would break the catalog's publication rules, for example because its game is excluded now.";
    case "invalid exclusion":
    case "invalid restoration":
    case "reason required":
      return "Check the reason and note, then try again.";
    default:
      return "It couldn't be saved. Try again.";
  }
}

/** A piece the copy's release lists, matched with what the owner recorded for it. */
export type ListedPiece = { kind: string; label: string; quantity: number | null };
export type RecordedPiece = { kind: string; label: string | null; quantity: number | null; listed: boolean; recorded: boolean; condition: string | null };

/**
 * A preserved copy's pieces, from the pieces its excluded release lists (which the
 * owner reads through get_my_preserved_release) and what they recorded. Recorded pieces
 * the release doesn't list stay, as no longer listed.
 */
export function withListedPieces(recorded: RecordedPiece[], listed: ListedPiece[]): RecordedPiece[] {
  const mine = recorded.filter((p) => p.recorded);
  const key = (p: { kind: string; label: string | null }) => `${p.kind}\u0000${p.label ?? ""}`;
  const byKey = new Map(mine.map((p) => [key(p), p]));
  const fromListed = listed.map((l) => {
    const own = byKey.get(key(l));
    return { kind: l.kind, label: l.label, quantity: l.quantity, listed: true, recorded: Boolean(own), condition: own?.condition ?? null };
  });
  const listedKeys = new Set(listed.map(key));
  const unlisted = mine.filter((p) => !listedKeys.has(key(p))).map((p) => ({ ...p, listed: false }));
  return [...fromListed, ...unlisted];
}

/** A catalog record's status, for staff pages. */
export function catalogStatusLabel(status: string): string {
  switch (status) {
    case "published":
      return "Published";
    case "unverified":
      return "Submitted, not yet reviewed";
    case "under_review":
      return "In review";
    case "rejected":
      return "Not approved";
    case "excluded":
      return "Excluded";
    case "merged":
      return "Merged";
    default:
      return status;
  }
}

/** "SNES · NTSC-U/C · Standard · SNS-ZSFE-USA". */
export function releaseLabelLine(r: { platform: { name: string }; region: string; edition_name: string | null; variant_name: string | null; product_code: string | null }) {
  return [r.platform.name, r.region, r.edition_name, r.variant_name, r.product_code].filter(Boolean).join(" · ");
}
