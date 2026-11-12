/**
 * Catalog review (M7b-1): the queue's filters, the correction forms read against the
 * record as it is now, so only what an editor changed is sent, and the fixed messages
 * for the database's errors. Nothing is filled in on the editor's behalf: a reason is
 * always typed. Pure, so it can be tested alone.
 */

/** The values the submission form offers (features/submissions/form.ts); a unit test keeps them the same. */
export const EDITION_KIND_VALUES = ["standard", "limited", "collector", "reprint", "bundle", "promotional", "other"] as const;
export const GAME_KIND_VALUES = ["game", "compilation", "expansion"] as const;

export const QUEUE_FILTERS = [
  { value: "active", label: "To review" },
  { value: "open", label: "Not started" },
  { value: "in_review", label: "In review" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "rejected", label: "Not approved" },
  { value: "approved", label: "Published" },
  { value: "withdrawn", label: "Withdrawn" },
  { value: "all", label: "All" },
] as const;

export type QueueFilter = (typeof QUEUE_FILTERS)[number]["value"];

export function queueFilter(value: unknown): QueueFilter {
  return QUEUE_FILTERS.find((f) => f.value === value)?.value ?? "active";
}

/** A request's status as editors see it. */
export const REQUEST_STATUS_LABELS: Record<string, string> = {
  open: "Awaiting review",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Published",
  rejected: "Not approved",
  withdrawn: "Withdrawn",
  merged: "Merged",
  excluded: "Excluded",
};

export function requestStatusLabel(status: string) {
  return REQUEST_STATUS_LABELS[status] ?? status;
}

/** A catalog record's status (a game, release or pairing), as editors see it. */
export const CATALOG_STATUS_LABELS: Record<string, string> = {
  unverified: "Pending",
  under_review: "In review",
  published: "Published",
  rejected: "Not approved",
  excluded: "Excluded",
  merged: "Merged",
};

export function catalogStatusLabel(status: string) {
  return CATALOG_STATUS_LABELS[status] ?? status;
}

/** How a submitter's account appears to editors: a handle and its status, never an email. */
export function submitterLabel(submitter: { deleted: boolean; handle?: string | null; account_status?: string | null } | null) {
  if (!submitter || submitter.deleted) return "A deleted account";
  const handle = submitter.handle ? `@${submitter.handle}` : "An account without a handle";
  return submitter.account_status && submitter.account_status !== "active" ? `${handle} (${submitter.account_status})` : handle;
}

type Read = (name: string) => string;
type Result<T> = { value: T } | { error: string };

const oneOf = (list: readonly string[], value: string) => list.includes(value);

/** The editor's reason, which the audit log keeps: required, up to 500 characters. */
export function readReason(read: Read): Result<string> {
  const reason = read("reason").replace(/\s+/g, " ").trim();
  if (!reason) return { error: "Give a reason for the record. Only editors see it." };
  if (reason.length > 500) return { error: "The reason can be up to 500 characters." };
  return { value: reason };
}

/** A note for the submitter, up to 2,000 characters. */
export function readNote(read: Read, required: boolean): Result<string | null> {
  const note = read("note").replace(/\r\n/g, "\n").trim();
  if (required && !note) return { error: "Tell the submitter what to change." };
  if (note.length > 2000) return { error: "The note can be up to 2,000 characters." };
  return { value: note || null };
}

export type ReleaseRecord = {
  edition_name: string | null;
  edition_kind: string | null;
  variant_name: string | null;
  product_code: string | null;
  barcode: string | null;
  local_title: string | null;
  publisher_name: string | null;
  media_count: number | null;
  packaging: string | null;
  region_code: string;
  region_unknown_confirmed: boolean;
  release_date: string | null;
  release_date_precision: string;
};

export type GameRecord = { title: string; kind: string; first_release_year: number | null };

function year(text: string, currentYear: number): number | null | undefined {
  if (!text) return null;
  if (!/^\d{4}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= 1950 && value <= currentYear + 1 ? value : undefined;
}

/**
 * Changes for update_release: every field read, compared with the record, and only
 * those that differ sent. An emptied field is cleared. The release year is compared
 * by year, so a more precise date isn't lost unless the year changes.
 */
export function readReleaseCorrections(read: Read, current: ReleaseRecord, regions: string[], currentYear: number): Result<Record<string, unknown>> {
  const text = (name: string) => read(name).trim();
  const wanted: Record<string, unknown> = {};
  for (const [name, max, label] of [
    ["edition_name", 120, "The edition name"],
    ["variant_name", 120, "The variant"],
    ["product_code", 40, "The product code"],
    ["local_title", 200, "The title on the package"],
    ["publisher_name", 120, "The publisher"],
    ["packaging", 80, "The packaging"],
  ] as const) {
    const value = text(name);
    if (value.length > max) return { error: `${label} can be up to ${max} characters.` };
    wanted[name] = value || null;
  }
  const editionKind = text("edition_kind");
  if (editionKind && !oneOf(EDITION_KIND_VALUES, editionKind)) return { error: "Choose an edition type from the list." };
  wanted.edition_kind = editionKind || null;
  const barcode = text("barcode").replace(/\s+/g, "");
  if (barcode && !/^\d{8,14}$/.test(barcode)) return { error: "A barcode is 8 to 14 digits." };
  wanted.barcode = barcode || null;
  const media = text("media_count");
  if (media && (!/^\d+$/.test(media) || Number(media) < 1 || Number(media) > 30)) return { error: "The number of discs or cartridges is between 1 and 30." };
  wanted.media_count = media ? Number(media) : null;
  const region = text("region_code");
  if (!regions.includes(region)) return { error: "Choose the region from the list." };
  wanted.region_code = region;
  // The confirmation applies only to an unknown region; the database clears it otherwise.
  wanted.region_unknown_confirmed = region === "unknown" && read("region_unknown_confirmed") === "on";

  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted)) {
    if ((current as Record<string, unknown>)[key] !== value) changes[key] = value;
  }
  const released = year(text("release_year"), currentYear);
  if (released === undefined) return { error: `Enter the release year as four digits, from 1950 to ${currentYear + 1}.` };
  const currentYearText = current.release_date ? current.release_date.slice(0, 4) : null;
  if ((released === null ? null : String(released)) !== currentYearText) {
    changes.release_date = released === null ? null : `${released}-01-01`;
    changes.release_date_precision = released === null ? "unknown" : "year";
  }
  return { value: changes };
}

/** Changes for update_game, for a submitted new game: title, type and first release year. */
export function readGameCorrections(read: Read, current: GameRecord, currentYear: number): Result<Record<string, unknown>> {
  const title = read("title").trim();
  if (!title) return { error: "Enter the game's title." };
  if (title.length > 200) return { error: "The title can be up to 200 characters." };
  const kind = read("kind").trim();
  if (!oneOf(GAME_KIND_VALUES, kind)) return { error: "Choose game, compilation or expansion." };
  const first = year(read("first_release_year").trim(), currentYear);
  if (first === undefined) return { error: `Enter the first release year as four digits, from 1950 to ${currentYear + 1}.` };
  const changes: Record<string, unknown> = {};
  if (title !== current.title) changes.title = title;
  if (kind !== current.kind) changes.kind = kind;
  if (first !== current.first_release_year) {
    changes.first_release_date = first === null ? null : `${first}-01-01`;
    changes.first_release_precision = first === null ? "unknown" : "year";
  }
  return { value: changes };
}

/** The database's fixed errors, as messages for editors. Nothing else from the database is shown. */
export function reviewErrorMessage(message: unknown): string {
  switch (message) {
    case "not permitted":
      return "Only active catalog editors can review submissions.";
    case "own submission":
      return "You submitted this, so another editor has to review it.";
    case "request conflict":
    case "record changed":
      return "This submission changed since you opened it. Reload the page and check it again.";
    case "submission unavailable":
      return "This submission can't take that action in its current state. Reload the page.";
    case "submission not in review":
      return "Start the review before correcting the submission.";
    case "review required":
      return "A submission is published only by approving it here.";
    case "submitter unavailable":
      return "The submitter's account was deleted, so nobody can make changes. Correct it yourself, or reject it.";
    case "already published":
      return "An identical release is already in the catalog, so this one can't be published as well. Reject it, and say which release it duplicates.";
    case "release incomplete":
      return "To publish, the release needs an edition name, an edition type and the number of discs or cartridges, and an unknown region must be confirmed.";
    case "game not verified":
      return "This release's game is still awaiting its own review. Approve the game's submission first.";
    case "reason required":
      return "Give a reason for the record.";
    case "invalid review":
      return "Check the note for the submitter: it's needed here, and can be up to 2,000 characters.";
    case "invalid changes":
      return "Some corrections aren't valid. Check them and try again.";
    case "record unavailable":
      return "This record can't be changed any more.";
    default:
      return "The review couldn't be saved. Try again.";
  }
}
