/**
 * The optional details of a new copy, read from the add form and checked against the
 * same rules the database enforces (M6b), so a mistake gets a specific message. Every
 * field is optional: a field left empty is left out, never filled in, and completeness
 * stays unrecorded unless the owner chooses one. Pure, so it can be tested alone.
 */

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
  });
  if (recorded.length) details.components = recorded;

  return { details };
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
