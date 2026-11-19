/**
 * Merging releases (M7b-2c): what an editor enters, the compared fields' labels and
 * values, the blockers, and the database's fixed errors as messages. No server-only
 * imports, so the unit tests and client forms can use it.
 */

export const OWNER_NOTE_MAX = 1000;
export const STAFF_REASON_MAX = 500;

type Read = (name: string) => string;
type Result<T> = { value: T } | { error: string };

export type MergeInput = {
  reason: string;
  ownerNote: string | null;
  acknowledged: string[];
  acknowledgeCopies: boolean;
};

/** The compared fields, in the order the preview lists them, with their labels. */
const FIELD_LABELS: Record<string, string> = {
  barcode: "Barcode",
  components: "Listed pieces",
  edition_kind: "Edition kind",
  edition_name: "Edition",
  game: "Game",
  hardware: "Hardware requirements",
  languages: "Languages",
  local_title: "Local title",
  markets: "Markets",
  media_count: "Media count",
  media_playability: "Media playability",
  packaging: "Packaging as recorded",
  packaging_code: "Packaging",
  product_code: "Product code",
  publisher_name: "Publisher",
  rating_labels: "Ratings",
  region_code: "Region",
  region_unknown_confirmed: "Region confirmed unknown",
  release_date: "Release date",
  release_date_precision: "Release date precision",
  variant_name: "Variant",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** A compared value, as text for the comparison table. */
export function fieldValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return "Not recorded";
  if (field === "game" && typeof value === "object") return String((value as { title?: unknown }).title ?? "A game");
  if (field === "components" && Array.isArray(value)) {
    if (!value.length) return "None listed";
    return value
      .map((p) => {
        const piece = p as { kind?: unknown; label?: unknown; quantity?: unknown };
        const quantity = typeof piece.quantity === "number" && piece.quantity > 1 ? ` ×${piece.quantity}` : "";
        return `${String(piece.label ?? piece.kind ?? "A piece")}${quantity}`;
      })
      .join(", ");
  }
  if (field === "hardware" && Array.isArray(value)) {
    if (!value.length) return "None";
    return value.map((h) => `${String((h as { code?: unknown }).code)} (${String((h as { level?: unknown }).level)})`).join(", ");
  }
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** What blocks a merge, for the editor. */
export function blockerText(kind: string): string {
  switch (kind) {
    case "platform":
      return "The releases are on different platforms. Only the same platform can be merged.";
    case "media_format":
      return "The releases have different physical formats. Only the same format can be merged.";
    case "other_game":
      return "A published release can only be merged into another release of its own game.";
    case "submission_not_in_review":
      return "This is a submission that isn't in review. Start its review first.";
    case "preserved_copy":
      return "A copy of it is kept privately after an exclusion. Merging would make it active again, so it's refused.";
    case "active_exclusion":
      return "One of these releases, or its game or platform pairing, is part of an active exclusion. Restore it first.";
    default:
      return "Something blocks this merge.";
  }
}

/** What an editor entered to merge, checked as the database will: every difference named. */
export function readMerge(read: Read, needs: { fields: string[]; copies: boolean }): Result<MergeInput> {
  const reason = read("reason").replace(/\s+/g, " ").trim();
  if (!reason) return { error: "Give a reason for the record. Only staff see it." };
  if (reason.length > STAFF_REASON_MAX) return { error: `The reason can be up to ${STAFF_REASON_MAX} characters.` };
  const note = read("owner_note").trim();
  if (note.length > OWNER_NOTE_MAX) return { error: `The note to owners can be up to ${OWNER_NOTE_MAX} characters.` };
  const acknowledged = needs.fields.filter((field) => read(`ack_${field}`) === "yes");
  const acknowledgeCopies = read("acknowledge_copies") === "yes";
  if (acknowledged.length !== needs.fields.length || (needs.copies && !acknowledgeCopies)) {
    return { error: "Confirm each difference and effect listed above before merging." };
  }
  return { value: { reason, ownerNote: note || null, acknowledged, acknowledgeCopies } };
}

/** The fixed errors from merge_release, as messages for staff. */
export function mergeErrorMessage(message: unknown): string {
  switch (message) {
    case "not permitted":
      return "Only active catalog editors can merge releases, and only administrators can merge a published one.";
    case "own submission":
      return "You submitted one of these, so another member of staff has to decide.";
    case "preview stale":
      return "One of these releases changed since you read this page. Review the differences again.";
    case "request conflict":
      return "Something changed while this was saving. Reload the page and try again.";
    case "merge blocked":
      return "Something listed above blocks this merge. Resolve it first.";
    case "acknowledgement required":
      return "Confirm each difference and effect listed above before merging.";
    case "release unavailable":
      return "This release can't be merged: it's already merged, excluded or rejected, or doesn't exist.";
    case "target unavailable":
      return "That release can't take a merge: it isn't published, or it's this release.";
    case "invalid merge":
    case "reason required":
      return "Check the reason and note, then try again.";
    default:
      return "It couldn't be saved. Try again.";
  }
}

/** The fields a form names as differences: known field names only, so nothing else is passed on. */
export function readFieldList(text: string): string[] {
  return text
    .split(",")
    .map((field) => field.trim())
    .filter((field) => Object.hasOwn(FIELD_LABELS, field));
}
