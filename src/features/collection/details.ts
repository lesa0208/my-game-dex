/**
 * A copy's details, read from the add and edit forms and checked against the same
 * rules the database enforces (M6b), so a mistake gets a specific message, plus the
 * labels that show them. Every field is optional: a field left empty is left out (or,
 * when editing, cleared), never filled in, and completeness stays unrecorded unless
 * the owner chooses one. Pure, so it can be tested alone.
 */

import type { CopyPiece, CopyRelease, CopyStatus } from "./types";

export const COMPLETENESS = [
  { value: "loose", label: "Loose (medium only)" },
  { value: "incomplete", label: "Incomplete" },
  { value: "complete", label: "Complete in box" },
  { value: "sealed", label: "Sealed" },
] as const;

export const CONDITIONS = [
  { value: "mint", label: "Mint" },
  { value: "near_mint", label: "Near mint" },
  { value: "very_good", label: "Very good" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
  { value: "poor", label: "Poor" },
] as const;

/** Box and manual can be absent from a copy. The medium never is: a copy is the game. */
export const NOT_INCLUDED = { value: "not_included", label: "Not included" } as const;

export type CopyComponent = { kind: string; label: string };

export type CopyDetails = {
  completeness?: string;
  overall_condition?: string;
  box_condition?: string;
  media_condition?: string;
  manual_condition?: string;
  acquired_on?: string;
  purchase_price?: string;
  currency?: string;
  notes?: string;
  storage_location?: string;
  components?: { kind: string; label: string; condition: string | null }[];
};

const completenessValues = new Set<string>(COMPLETENESS.map((c) => c.value));
const gradeValues = new Set<string>(CONDITIONS.map((c) => c.value));

/**
 * The latest acquisition date accepted, as YYYY-MM-DD: tomorrow in UTC, the same day
 * of leeway for time zones the database allows.
 */
export function latestAcquisitionDate(now: number = Date.now()) {
  return new Date(now + 86400000).toISOString().slice(0, 10);
}

/** The key a component's form field uses. */
export function componentField(index: number) {
  return `component_${index}`;
}

type Read = (name: string) => string;

/**
 * Builds the details for `add_collection_item` from the form. `components` are the
 * release's listed pieces, from the catalog, so only those can be recorded. Returns
 * the details, or the first problem as a message for the owner.
 */
export function readCopyDetails(read: Read, components: CopyComponent[], today: string): { details: CopyDetails } | { error: string } {
  const details: CopyDetails = {};
  const text = (name: string) => read(name).trim();

  const completeness = text("completeness");
  if (completeness) {
    if (!completenessValues.has(completeness)) return { error: "Choose a completeness from the list." };
    details.completeness = completeness;
  }

  for (const [field, absentAllowed] of [["overall_condition", false], ["box_condition", true], ["media_condition", false], ["manual_condition", true]] as const) {
    const value = text(field);
    if (!value) continue;
    if (!gradeValues.has(value) && !(absentAllowed && value === NOT_INCLUDED.value)) return { error: "Choose a condition from the list." };
    details[field] = value;
  }

  // The physical-copy rules, as in the database.
  if (details.completeness === "loose" && ((details.box_condition ?? "not_included") !== "not_included" || (details.manual_condition ?? "not_included") !== "not_included")) {
    return { error: "A loose copy is the cartridge or disc only, so it has no box or manual condition." };
  }
  if (details.completeness === "complete" && details.box_condition === "not_included") {
    return { error: "A copy that's complete in box has its box." };
  }
  if (details.completeness === "sealed" && (details.media_condition || details.manual_condition)) {
    return { error: "A sealed copy's cartridge, disc or manual can't be graded without opening it." };
  }

  const acquired = text("acquired_on");
  if (acquired) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(acquired) || Number.isNaN(Date.parse(`${acquired}T00:00:00Z`))) return { error: "Enter the acquisition date as a date." };
    if (acquired < "1970-01-01") return { error: "The acquisition date can't be before 1970." };
    if (acquired > today) return { error: "The acquisition date can't be in the future." };
    details.acquired_on = acquired;
  }

  const price = text("purchase_price").replace(",", ".");
  const currency = text("currency").toUpperCase();
  if (price) {
    if (!/^\d{1,10}(\.\d{1,4})?$/.test(price)) return { error: "Enter the price as a number, such as 24.99." };
    if (!/^[A-Z]{3}$/.test(currency)) return { error: "Choose the currency you paid in." };
    details.purchase_price = price;
    details.currency = currency;
  }

  const notes = read("notes").replace(/\r\n/g, "\n");
  if (notes.trim()) {
    if (notes.length > 5000) return { error: "Notes can be up to 5,000 characters." };
    details.notes = notes;
  }

  const location = text("storage_location");
  if (location) {
    if (location.length > 120) return { error: "The storage location can be up to 120 characters." };
    details.storage_location = location;
  }

  const recorded: NonNullable<CopyDetails["components"]> = [];
  components.forEach((component, index) => {
    const state = text(componentField(index));
    if (state === "included") recorded.push({ ...component, condition: null });
    else if (state === "missing") recorded.push({ ...component, condition: "not_included" });
    // A graded piece, as recorded before; the forms offer it only to keep it.
    else if (gradeValues.has(state)) recorded.push({ ...component, condition: state });
  });
  if (recorded.length) details.components = recorded;

  return { details };
}

const CHANGE_KEYS = [
  "completeness",
  "overall_condition",
  "box_condition",
  "media_condition",
  "manual_condition",
  "acquired_on",
  "purchase_price",
  "currency",
  "notes",
  "storage_location",
] as const;

export type CopyChanges = { [K in (typeof CHANGE_KEYS)[number]]: string | null } & {
  components?: NonNullable<CopyDetails["components"]>;
};

/** A piece the release lists, with what the owner recorded for it so far. */
export type ListedPiece = CopyComponent & { recorded: boolean; condition: string | null };

/**
 * Builds the changes for `update_collection_item` from the edit form, with the same
 * checks as adding. Every field is sent, so one left empty is cleared (null). The
 * pieces are sent only when they changed: sending them replaces every recorded piece,
 * and a piece the release no longer lists couldn't be recorded again.
 */
export function readCopyChanges(read: Read, pieces: ListedPiece[], today: string): { changes: CopyChanges } | { error: string } {
  const result = readCopyDetails(read, pieces.map(({ kind, label }) => ({ kind, label })), today);
  if ("error" in result) return result;
  const { details } = result;

  const changes = Object.fromEntries(CHANGE_KEYS.map((key) => [key, details[key] ?? null])) as unknown as CopyChanges;
  const wanted = details.components ?? [];
  const before = pieces.filter((p) => p.recorded);
  const key = (p: { kind: string; label: string; condition: string | null }) => `${p.kind}\u0000${p.label}\u0000${p.condition ?? ""}`;
  const same = wanted.length === before.length && wanted.every((w) => before.some((b) => key(b) === key(w)));
  if (!same) changes.components = wanted;
  return { changes };
}

/** The fixed errors from `update_collection_item`, as messages for the owner. */
export function editErrorMessage(message: unknown): string {
  switch (message) {
    case "account not active":
      return "Your account can't edit copies right now. You can still remove them.";
    case "item unavailable":
      return "This copy isn't in your collection any more.";
    case "item preserved":
      return "This copy's release is no longer in the catalog, so the copy can't be edited. You can still remove it.";
    case "invalid details":
      return "Some details don't fit together. Check them and try again.";
    case "component unavailable":
      return "One of the pieces isn't listed for this release any more. Reload the page and try again.";
    default:
      return "Your changes couldn't be saved. Try again.";
  }
}

/** The fixed errors from relink_my_copy (M7b-2a), as messages for the owner. */
export function relinkErrorMessage(message: unknown): string {
  switch (message) {
    case "account not active":
      return "Your account can't change copies right now. You can still remove them.";
    case "item unavailable":
      return "This copy isn't in your collection any more.";
    case "release unavailable":
      return "That release can't hold copies. Choose another one.";
    case "other platform":
      return "A copy can only move to a release for the same platform. For another platform, add it as a new copy.";
    case "request conflict":
      return "This copy changed while you were choosing. Reload the page and try again.";
    default:
      return "The copy couldn't be moved. Try again.";
  }
}

/** The fixed errors from the M6b functions, as messages for the owner. */
export function addErrorMessage(message: unknown): { text: string; renewId: boolean } {
  switch (message) {
    case "account not active":
      return { text: "Your account can't add copies right now.", renewId: false };
    case "release unavailable":
      return { text: "This release can't be added to a collection.", renewId: false };
    case "collection limit reached":
      return { text: "Your collection has reached its limit of 100,000 copies.", renewId: false };
    case "invalid details":
      return { text: "Some details don't fit together. Check them and try again.", renewId: false };
    case "component unavailable":
      return { text: "One of the pieces isn't listed for this release any more. Reload the page and try again.", renewId: false };
    // The id is too old (a page left open for a day) or belongs to another request.
    case "invalid item id":
    case "request conflict":
      return { text: "This page was open too long. Add the copy again.", renewId: true };
    default:
      return { text: "The copy couldn't be added. Try again.", renewId: false };
  }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * Labels for a copy's values. "Not recorded" means the owner hasn't said; "Not
 * included" means they said the part isn't there. Catalog fields the release doesn't
 * have are left out, never filled in. Pure, so it can be tested alone.
 */

export const NOT_RECORDED = "Not recorded";

export function completenessLabel(value: string | null) {
  return COMPLETENESS.find((c) => c.value === value)?.label ?? NOT_RECORDED;
}

export function conditionLabel(value: string | null) {
  if (value === NOT_INCLUDED.value) return NOT_INCLUDED.label;
  return CONDITIONS.find((c) => c.value === value)?.label ?? NOT_RECORDED;
}

/** A recorded piece: "Included", "Included, good" or "Missing". */
export function pieceStateLabel(piece: Pick<CopyPiece, "recorded" | "condition">) {
  if (!piece.recorded) return NOT_RECORDED;
  if (piece.condition === null) return "Included";
  if (piece.condition === NOT_INCLUDED.value) return "Missing";
  return `Included, ${conditionLabel(piece.condition).toLowerCase()}`;
}

/** The value a piece's form field starts with. */
export function pieceFieldValue(piece: Pick<CopyPiece, "recorded" | "condition">) {
  if (!piece.recorded) return "";
  if (piece.condition === null) return "included";
  if (piece.condition === NOT_INCLUDED.value) return "missing";
  return piece.condition;
}

const STATUS_LABELS: Record<CopyStatus, string | null> = {
  owned: null,
  pending: "Awaiting review",
  not_approved: "Not approved",
  invalid: "No longer in the catalog",
};

/** Null for an ordinary copy, which needs no label. */
export function copyStatusLabel(status: CopyStatus) {
  return STATUS_LABELS[status] ?? null;
}

/** "SNES · NTSC-U/C · Collector's Edition": only what the catalog records. */
export function releaseLine(release: Pick<CopyRelease, "platform" | "region" | "edition_name" | "variant_name">) {
  const region = release.region.code === "unknown" ? "Region unknown" : release.region.label;
  return [release.platform.short_name, region, release.edition_name, release.variant_name].filter(Boolean).join(" · ");
}

/** The medium's name for its condition field, from the format's category. */
export function mediumLabel(category: string | null | undefined) {
  switch (category) {
    case "cartridge":
      return "Cartridge";
    case "optical_disc":
      return "Disc";
    case "solid_state_card":
      return "Game card";
    case "magnetic_disk":
      return "Disk";
    case "magnetic_tape":
      return "Tape";
    default:
      return "Medium";
  }
}

const dayFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** "1 May 2020", from YYYY-MM-DD or a timestamp (as its UTC date). */
export function formatDay(value: string) {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? value : dayFormat.format(date);
}

/** "€37.42", keeping up to the four decimals stored. */
export function formatPrice(price: { amount: string; currency: string }) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: price.currency, maximumFractionDigits: 4 }).format(Number(price.amount));
  } catch {
    return `${priceInput(price.amount)} ${price.currency}`;
  }
}

/** The stored amount for the edit field: "37.4200" reads as "37.42", "12.5000" as "12.50". */
export function priceInput(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${trimmed}`;
}

export function copiesLabel(count: number) {
  return `${count} ${count === 1 ? "copy" : "copies"}`;
}
