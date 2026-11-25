/**
 * Catalog records for staff (M10b): the search's parameters, and how a record's
 * history reads. Pure functions, so the unit tests cover them; the database decides
 * who may read what and which fields exist.
 */

export const SEARCH_KINDS = [
  { value: "games", label: "Games" },
  { value: "releases", label: "Releases" },
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number]["value"];

/** The catalog statuses a search can filter by, as editors see them. */
export const RECORD_STATUSES = [
  { value: "unverified", label: "Pending" },
  { value: "under_review", label: "In review" },
  { value: "published", label: "Published" },
  { value: "rejected", label: "Not approved" },
  { value: "excluded", label: "Excluded" },
  { value: "merged", label: "Merged" },
] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number]["value"];

export type SearchParams = {
  kind: SearchKind;
  query: string;
  platform: string | null;
  status: RecordStatus | null;
  cursor: string | null;
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The search as the URL asks for it. Anything it doesn't recognise is left out rather
 * than sent, so a bad link searches everything instead of failing.
 */
export function readSearchParams(search: Record<string, string | string[] | undefined>): SearchParams {
  const kind = first(search.kind) === "releases" ? "releases" : "games";
  const query = (first(search.q) ?? "").trim().slice(0, 100);
  const platform = first(search.platform);
  const status = first(search.status);
  const cursor = first(search.cursor);
  return {
    kind,
    query,
    platform: platform && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(platform) && platform.length <= 60 ? platform : null,
    status: RECORD_STATUSES.some((s) => s.value === status) ? (status as RecordStatus) : null,
    cursor: cursor && /^[A-Za-z0-9_-]{1,600}$/.test(cursor) ? cursor : null,
  };
}

/**
 * The search page's address for these parameters; empty ones are left out. Spaces are
 * %20, not +, so the address is also a valid return path after a verification.
 */
export function searchHref(p: Omit<SearchParams, "cursor"> & { cursor?: string | null }): string {
  const q = new URLSearchParams();
  if (p.query) q.set("q", p.query);
  if (p.kind !== "games") q.set("kind", p.kind);
  if (p.platform) q.set("platform", p.platform);
  if (p.status) q.set("status", p.status);
  if (p.cursor) q.set("cursor", p.cursor);
  const s = q.toString().replaceAll("+", "%20");
  return s ? `/admin/catalog/search?${s}` : "/admin/catalog/search";
}

export function recordStatusLabel(status: string): string {
  return RECORD_STATUSES.find((s) => s.value === status)?.label ?? status;
}

/** Field names in history and locks, in words. */
export const FIELD_LABELS: Record<string, string> = {
  title: "title",
  sort_title: "sort title",
  kind: "kind",
  summary: "summary",
  first_release_date: "first release date",
  first_release_precision: "first release date precision",
  region_code: "region",
  region_unknown_confirmed: "unknown region confirmation",
  edition_name: "edition",
  edition_kind: "edition kind",
  variant_name: "variant",
  product_code: "product code",
  barcode: "barcode",
  local_title: "local title",
  publisher_name: "publisher",
  media_format_code: "format",
  media_count: "number of media",
  media_playability: "playability",
  packaging: "packaging",
  packaging_code: "packaging type",
  languages: "languages",
  rating_labels: "rating labels",
  release_date: "release date",
  release_date_precision: "release date precision",
  markets: "markets",
  components: "contents",
  requirements: "hardware requirements",
  game: "game",
  platform: "platform",
};

export function recordFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.replaceAll("_", " ");
}

function fieldList(fields: unknown): string {
  if (!Array.isArray(fields) || fields.length === 0) return "";
  const names = fields.filter((f): f is string => typeof f === "string").map(recordFieldLabel);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type HistoryActor = { kind: "staff"; handle: string | null } | { kind: "submitter" } | { kind: "import" } | { kind: "system" };

export type HistoryEvent = {
  id: string;
  occurred_at: string;
  action: string;
  actor: HistoryActor;
  reason: string | null;
  details: Record<string, unknown>;
};

/** Who acted, in words: a handle for staff, never a submitter's name. */
export function actorLabel(actor: HistoryActor): string {
  switch (actor.kind) {
    case "staff":
      return actor.handle ? `@${actor.handle}` : "A former staff member";
    case "submitter":
      return "The submitter";
    case "import":
      return "An import";
    default:
      return "The system";
  }
}

/**
 * M12c-A: the creating editor's reason, shown on a record as an evidence note for the
 * reviewer. It's free text from the audit history, not structured source evidence
 * (release_evidence holds only what an import recorded), and nothing checks it. Null when
 * the creation isn't on this page of the history (it's then further down, in History).
 */
export function creationNote(items: Pick<HistoryEvent, "action" | "details" | "reason" | "occurred_at">[], entity: "game" | "release") {
  const created = items.find((e) => e.action === "catalog_record_created" && e.details.entity === entity);
  // Never who wrote it: a record names nobody above its history (M10b, D4).
  return created?.reason ? { reason: created.reason, occurred_at: created.occurred_at } : null;
}

const ENTITY_WORDS: Record<string, string> = { game: "the game", release: "the release", game_platform: "a platform pairing", game_relation: "a related game" };

/**
 * What happened, as one sentence without the actor. Unknown actions read as their
 * name. A merge reads from the side of the record whose history it is.
 */
export function eventSummary(event: Pick<HistoryEvent, "action" | "details">, recordId?: string): string {
  const d = event.details;
  const entity = ENTITY_WORDS[String(d.entity ?? "")] ?? "the record";
  const fields = fieldList(d.fields);
  switch (event.action) {
    case "catalog_record_created":
      return d.entity === "game_platform" ? "Added a platform pairing" : `Created ${entity}`;
    case "catalog_record_updated":
      if (d.entity === "game_relation") return "Changed a related game";
      return fields ? `Changed the ${fields}${d.verification_cleared === true ? ", which cleared its verification" : ""}` : `Changed ${entity}`;
    case "catalog_record_verified":
      return typeof d.revision === "number" ? `Verified ${entity} at revision ${d.revision}` : `Verified ${entity}`;
    case "catalog_record_published":
      return `Published ${entity}`;
    case "catalog_field_locked":
      return `Locked the ${recordFieldLabel(String(d.field ?? ""))} against imports`;
    case "catalog_field_unlocked":
      return `Unlocked the ${recordFieldLabel(String(d.field ?? ""))}`;
    case "catalog_record_withdrawn":
      return "Withdrew the release from the catalog";
    case "catalog_review_queued":
      return "Queued the release for reclassification";
    case "catalog_review_resolved":
      return "Resolved its reclassification";
    case "catalog_alias_added":
      return typeof d.alias_title === "string" ? `Added the title “${d.alias_title}”` : "Added a title";
    case "catalog_alias_removed":
      return typeof d.alias_title === "string" ? `Removed the title “${d.alias_title}”` : "Removed a title";
    case "catalog_submission_created":
      return "Submitted it";
    case "catalog_submission_updated":
      return "Changed the submission";
    case "catalog_submission_withdrawn":
      return "Withdrew the submission";
    case "catalog_submission_resubmitted":
      return "Resubmitted it";
    case "catalog_submission_review_started":
      return "Started reviewing the submission";
    case "catalog_submission_approved":
      return "Approved the submission";
    case "catalog_submission_changes_requested":
      return "Asked the submitter for changes";
    case "catalog_submission_rejected":
      return "Didn't approve the submission";
    case "catalog_source_confirmed":
      return typeof d.external_id === "string" ? `Confirmed Wikidata ${d.external_id} as the game's source` : "Confirmed a Wikidata match as the game's source";
    case "catalog_source_rejected":
      return typeof d.external_id === "string" ? `Rejected Wikidata ${d.external_id} as a match` : "Rejected a Wikidata match";
    case "catalog_release_excluded":
      return "Excluded the release";
    case "catalog_exclusion_restored":
      return "Restored the release from exclusion";
    case "catalog_release_merged":
      if (recordId && d.target_id === recordId) return "Merged another release into this one";
      return "Merged this release into another";
    default:
      return event.action.replaceAll("_", " ");
  }
}
