/**
 * A copy's details, read from the add and edit forms and checked against the same
 * rules the database enforces (M6b), so a mistake gets a specific message, plus the
 * labels that show them. Every field is optional: a field left empty is left out (or,
 * when editing, cleared), never filled in, and completeness stays unrecorded unless
 * the owner chooses one. Pure, so it can be tested alone.
 */

import type { CopyPiece, CopyRelease, CopyStatus, CopyClaim } from "./types";

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
  pending: "Awaiting catalog approval",
  not_approved: "Not approved",
  invalid: "No longer in the catalog",
  unidentified: "Exact release not identified",
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

const EDITION_KINDS: Record<string, string> = {
  standard: "Standard",
  limited: "Limited edition",
  collector: "Collector's edition",
  reprint: "Reprint",
  bundle: "Bundle",
  promotional: "Promotional",
  other: "Other edition",
};

/** M12b: the edition types an owner can choose for an unidentified copy, in the database's order. */
export const EDITION_KIND_OPTIONS: { value: string; label: string }[] = Object.entries(EDITION_KINDS).map(([value, label]) => ({ value, label }));

/**
 * M12b: names collectors often use for an edition, offered as suggestions while typing.
 * Only suggestions: what the owner types is kept as their own words, and nothing here is
 * a catalog edition or says that one exists for a game.
 */
export const EDITION_NAME_SUGGESTIONS = [
  "Standard",
  "Black Label",
  "Platinum",
  "Greatest Hits",
  "Player's Choice",
  "PlayStation the Best",
  "Nintendo Selects",
  "Collector's Edition",
  "Limited Edition",
] as const;

/**
 * M12a: "PS1 · PAL · Platinum" for an unidentified copy: what the owner says, and "not
 * sure" where they didn't. The edition is the name they gave, or else its kind.
 */
export function claimLine(claim: Pick<CopyClaim, "platform" | "region" | "edition_kind" | "edition_name">) {
  return [claim.platform.short_name, claim.region?.label ?? "Region not sure", claimEdition(claim) ?? "Edition not sure"].join(" · ");
}

/**
 * M12b: the five standings of a copy in "what you own", each named, so a confirmed
 * release is never confused with a copy that isn't one.
 */
const OWNERSHIP_STATUS: Record<CopyStatus, string> = {
  owned: "Confirmed",
  pending: "Awaiting catalog approval",
  not_approved: "Not approved",
  unidentified: "Exact release not identified",
  invalid: "Preserved, not counted",
};

export function ownershipStatusLabel(status: CopyStatus) {
  return OWNERSHIP_STATUS[status] ?? "Not counted";
}

/** "Owned: 3 copies", "Owned: Yes" (one copy), or "Not in your collection" for no counted copy. */
export function ownershipHeadline(copies: number) {
  if (copies <= 0) return "Not in your collection";
  return copies === 1 ? "Owned: Yes" : `Owned: ${copies.toLocaleString("en")} copies`;
}

/**
 * M12b: one line of what the owner has of a game, "SNES · PAL · Platinum": the release's
 * or the claim's platform, region and edition. A claim says "not sure" where its owner
 * did; a release leaves out an edition the catalog doesn't name.
 */
export function ownershipEntryLine(entry: {
  status: CopyStatus;
  release_id: string | null;
  platform: { short_name: string };
  region: { code: string; label: string | null } | null;
  edition_kind: string | null;
  edition_name: string | null;
}) {
  const claim = entry.release_id === null;
  const region = entry.region ? (entry.region.code === "unknown" ? "Region unknown" : (entry.region.label ?? entry.region.code)) : claim ? "Region not sure" : null;
  const edition = entry.edition_name ?? (entry.edition_kind ? (EDITION_KINDS[entry.edition_kind] ?? null) : null) ?? (claim ? "Edition not sure" : null);
  return [entry.platform.short_name, region, edition].filter(Boolean).join(" · ");
}

/**
 * M12b: one side of a change in a copy's private history: a release, or what the owner
 * said ("PAL · Platinum", "Region not sure · Edition not sure"). The platform never
 * changes, so it isn't repeated.
 */
export function historyIdentityText(identity: Record<string, string | null> | null, regionLabels: Map<string, string>) {
  if (!identity) return "Not recorded";
  if (identity.release_id) return "Linked to a release in the catalog";
  const region = identity.region_code ? (regionLabels.get(identity.region_code) ?? identity.region_code) : "Region not sure";
  const edition = identity.edition_name ?? (identity.edition_kind ? (EDITION_KINDS[identity.edition_kind] ?? identity.edition_kind) : null) ?? "Edition not sure";
  return `Exact release not identified: ${region} · ${edition}`;
}

/** M12b: who made a change in a copy's history. */
export function historySourceLabel(source: string) {
  switch (source) {
    case "owner":
      return "You";
    case "catalog":
      return "The catalog, when it merged a duplicate release";
    default:
      return "Site maintenance";
  }
}

/** M12a: a claim's edition as its owner gave it: the name, or else its kind. Null: not sure. */
export function claimEdition(claim: Pick<CopyClaim, "edition_kind" | "edition_name">) {
  return claim.edition_name ?? (claim.edition_kind ? (EDITION_KINDS[claim.edition_kind] ?? null) : null);
}

/** M12a: the fixed errors from add_unidentified_copy and set_my_copy_identity, as messages for the owner. */
export function claimErrorMessage(message: unknown): { text: string; renewId: boolean } {
  switch (message) {
    case "account not active":
      return { text: "Your account can't change copies right now.", renewId: false };
    case "game unavailable":
      return { text: "This game can't be added to a collection right now.", renewId: false };
    case "platform unavailable":
      return { text: "Choose a platform from the list.", renewId: false };
    case "invalid region":
      return { text: "Choose a region from the list, or Not sure.", renewId: false };
    case "invalid edition":
      return { text: "The edition name is too long or has characters that can't be used.", renewId: false };
    case "item unavailable":
      return { text: "This copy isn't in your collection any more.", renewId: false };
    case "release unavailable":
      return { text: "That release can't hold copies. Choose another one.", renewId: false };
    case "other platform":
      return { text: "A copy stays on its platform. For another platform, add it as a new copy.", renewId: false };
    case "collection limit reached":
      return { text: "Your collection has reached its limit of 100,000 copies.", renewId: false };
    case "invalid details":
      return { text: "Some details don't fit together. Check them and try again.", renewId: false };
    case "invalid item id":
    case "request conflict":
      return { text: "This page was open too long. Try again.", renewId: true };
    default:
      return { text: "The copy couldn't be saved. Try again.", renewId: false };
  }
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
