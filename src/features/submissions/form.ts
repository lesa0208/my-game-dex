/**
 * Catalog submissions (M7a): the submit and edit forms, read and checked with the same
 * rules the database enforces, so a mistake gets a specific message, and the fixed
 * messages for the database's errors. Nothing here fills in a value the submitter
 * didn't give: an empty field stays unknown. Pure, so it can be tested alone.
 */

export const GAME_KINDS = [
  { value: "game", label: "Game" },
  { value: "compilation", label: "Compilation" },
  { value: "expansion", label: "Expansion" },
] as const;

export const EDITION_KINDS = [
  { value: "standard", label: "Standard" },
  { value: "limited", label: "Limited" },
  { value: "collector", label: "Collector's" },
  { value: "reprint", label: "Reprint" },
  { value: "bundle", label: "Bundle" },
  { value: "promotional", label: "Promotional" },
  { value: "other", label: "Other" },
] as const;

/** Original materials that come with a release. Extra discs go in the media count. */
export const PIECE_KINDS = [
  { value: "insert", label: "Insert or manual" },
  { value: "map", label: "Map" },
  { value: "artwork", label: "Artwork" },
  { value: "other", label: "Other" },
] as const;

/** How many piece rows the form has. */
export const PIECE_ROWS = 6;

export const REGION_UNKNOWN = "unknown";

export const STATUS_LABELS: Record<string, string> = {
  submitted: "Awaiting review",
  in_review: "In review",
  published: "Published",
  changes_requested: "Changes requested",
  rejected: "Not approved",
  merged: "Merged into another release",
  excluded: "Not added to the catalog",
  withdrawn: "Withdrawn",
  unavailable: "No longer available",
};

export function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? STATUS_LABELS.unavailable;
}

export type Piece = { kind: string; label: string; quantity: number };
export type ReleaseDetails = {
  edition_name?: string;
  edition_kind?: string;
  variant_name?: string;
  product_code?: string;
  barcode?: string;
  local_title?: string;
  publisher_name?: string;
  media_count?: number;
  packaging?: string;
  release_date?: string;
  release_date_precision?: string;
};

export type SubmissionInput = {
  title: string | null;
  gameKind: string;
  firstReleaseYear: number | null;
  platform: string;
  mediaFormat: string;
  region: string;
  details: ReleaseDetails;
  components: Piece[];
  note: string | null;
};

type Read = (name: string) => string;
type Result<T> = { value: T } | { error: string };

const oneOf = (list: readonly { value: string }[], value: string) => list.some((item) => item.value === value);

function year(text: string, currentYear: number): number | null | undefined {
  if (!text) return null;
  if (!/^\d{4}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= 1950 && value <= currentYear + 1 ? value : undefined;
}

/** The release fields both forms share. */
function readRelease(read: Read, currentYear: number): Result<{ details: ReleaseDetails; components: Piece[] }> {
  const text = (name: string) => read(name).trim();
  const details: ReleaseDetails = {};
  const limited = (name: keyof ReleaseDetails, max: number, label: string): string | null => {
    const value = text(name);
    if (!value) return null;
    if (value.length > max) return `${label} can be up to ${max} characters.`;
    (details as Record<string, string>)[name] = value;
    return null;
  };
  for (const [name, max, label] of [
    ["edition_name", 120, "The edition name"],
    ["variant_name", 120, "The variant"],
    ["product_code", 40, "The product code"],
    ["local_title", 200, "The title on the package"],
    ["publisher_name", 120, "The publisher"],
    ["packaging", 80, "The packaging"],
  ] as const) {
    const problem = limited(name, max, label);
    if (problem) return { error: problem };
  }

  const editionKind = text("edition_kind");
  if (editionKind) {
    if (!oneOf(EDITION_KINDS, editionKind)) return { error: "Choose an edition type from the list." };
    details.edition_kind = editionKind;
  }
  const barcode = text("barcode").replace(/\s+/g, "");
  if (barcode) {
    if (!/^\d{8,14}$/.test(barcode)) return { error: "A barcode is 8 to 14 digits." };
    details.barcode = barcode;
  }
  const media = text("media_count");
  if (media) {
    if (!/^\d+$/.test(media) || Number(media) < 1 || Number(media) > 30) return { error: "The number of discs or cartridges is between 1 and 30." };
    details.media_count = Number(media);
  }
  const released = year(text("release_year"), currentYear);
  if (released === undefined) return { error: `Enter the release year as four digits, from 1950 to ${currentYear + 1}.` };
  if (released !== null) {
    details.release_date = `${released}-01-01`;
    details.release_date_precision = "year";
  }

  const components: Piece[] = [];
  for (let i = 0; i < PIECE_ROWS; i += 1) {
    const label = text(`piece_label_${i}`);
    if (!label) continue;
    if (label.length > 120) return { error: "A piece's name can be up to 120 characters." };
    const kind = text(`piece_kind_${i}`) || "insert";
    if (!oneOf(PIECE_KINDS, kind)) return { error: "Choose a type for each piece from the list." };
    const quantityText = text(`piece_quantity_${i}`);
    const quantity = quantityText ? Number(quantityText) : 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return { error: "A piece's quantity is between 1 and 99." };
    if (components.some((c) => c.kind === kind && c.label === label)) return { error: `“${label}” is listed twice.` };
    components.push({ kind, label, quantity });
  }
  return { value: { details, components } };
}

function readNote(read: Read): Result<string | null> {
  const note = read("note").replace(/\r\n/g, "\n").trim();
  if (note.length > 1000) return { error: "The note can be up to 1,000 characters." };
  return { value: note || null };
}

/** A new submission: a missing release of a game (`release`), or a new game with its first release (`game`). */
export function readSubmission(read: Read, mode: "release" | "game", currentYear: number): Result<SubmissionInput> {
  const text = (name: string) => read(name).trim();
  let title: string | null = null;
  let gameKind = "game";
  let firstReleaseYear: number | null = null;
  if (mode === "game") {
    title = text("title");
    if (!title) return { error: "Enter the game's title." };
    if (title.length > 200) return { error: "The title can be up to 200 characters." };
    gameKind = text("game_kind") || "game";
    if (!oneOf(GAME_KINDS, gameKind)) return { error: "Choose game, compilation or expansion." };
    const first = year(text("first_release_year"), currentYear);
    if (first === undefined) return { error: `Enter the first release year as four digits, from 1950 to ${currentYear + 1}.` };
    firstReleaseYear = first;
  }

  const platform = text("platform");
  if (!platform) return { error: "Choose the platform." };
  const mediaFormat = text("media_format");
  if (!mediaFormat) return { error: "Choose the physical format." };
  const region = text("region");
  if (!region) return { error: "Choose the region, or “Unknown” if you're not sure." };

  const release = readRelease(read, currentYear);
  if ("error" in release) return release;
  const note = readNote(read);
  if ("error" in note) return note;
  if (read("physical") !== "on") return { error: "Confirm that this is a physical game release." };

  return { value: { title, gameKind, firstReleaseYear, platform, mediaFormat, region, ...release.value, note: note.value } };
}

/** Changes for `update_my_submission`. Every field is sent, so an emptied one is cleared. */
export function readSubmissionChanges(read: Read, createdGame: boolean, currentYear: number): Result<Record<string, unknown>> {
  const text = (name: string) => read(name).trim();
  const changes: Record<string, unknown> = {};
  if (createdGame) {
    const title = text("title");
    if (!title) return { error: "Enter the game's title." };
    if (title.length > 200) return { error: "The title can be up to 200 characters." };
    const gameKind = text("game_kind") || "game";
    if (!oneOf(GAME_KINDS, gameKind)) return { error: "Choose game, compilation or expansion." };
    const first = year(text("first_release_year"), currentYear);
    if (first === undefined) return { error: `Enter the first release year as four digits, from 1950 to ${currentYear + 1}.` };
    Object.assign(changes, { title, game_kind: gameKind, first_release_year: first });
  }
  const mediaFormat = text("media_format");
  if (!mediaFormat) return { error: "Choose the physical format." };
  const region = text("region");
  if (!region) return { error: "Choose the region, or “Unknown” if you're not sure." };
  const release = readRelease(read, currentYear);
  if ("error" in release) return release;
  const note = readNote(read);
  if ("error" in note) return note;
  return { value: { ...changes, media_format: mediaFormat, region, details: release.value.details, components: release.value.components, note: note.value ?? "" } };
}

/** The database's fixed errors, as messages for the submitter. */
export function submissionErrorMessage(message: unknown): string {
  switch (message) {
    case "account not active":
      return "Your account can't submit to the catalog right now.";
    case "submission limit reached":
      return "You've reached today's limit of 10 submissions. Try again later.";
    case "game unavailable":
      return "That game isn't available to submit a release of. Find it in the catalog, or submit it as a new game.";
    case "already submitted":
      return "You've already submitted this release. You can change your earlier submission instead.";
    case "submission unavailable":
      return "This submission isn't available.";
    case "submission locked":
      return "This submission is being reviewed, so it can't change any more.";
    case "submission in use":
      return "Remove your copies of this release from your collection first. Then you can withdraw it.";
    case "invalid submission":
      return "Some details aren't valid. Check them and try again.";
    default:
      return "The submission couldn't be saved. Try again.";
  }
}
