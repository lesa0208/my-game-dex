/**
 * The personal data export (M11a-4a): its format, how each record is shaped, and the
 * page's messages. Pure, so it can be tested without a server. src/features/export/server.ts
 * reads the data, as the person, and streams what this shapes.
 *
 * Format "my-game-dex-export", version 2 (M12a: a copy may be unidentified, with status
 * "unidentified" or "invalid", a null release and a "claim"): one JSON object, written in this key order:
 *   format, version, exported_at, notice, account, profile, preferences, authenticators,
 *   collection (an array), submissions (an array), not_included, complete (true, last).
 * A file without "complete": true at the end was cut off and is incomplete.
 */

export const EXPORT_FORMAT = "my-game-dex-export";
export const EXPORT_VERSION = 2;
/** Copies read per page (each page is four bounded reads). PostgREST returns up to 1,000 rows. */
export const EXPORT_PAGE = 200;
/** The database's ceiling per account (M6): a loop that passes it is refused rather than run on. */
export const EXPORT_MAX_COPIES = 100_000;
/** Submissions per page of my_catalog_submissions (its own maximum), and a ceiling on pages. */
export const SUBMISSIONS_PAGE = 100;
export const SUBMISSIONS_MAX_PAGES = 1_000;
/** get_my_preserved_titles takes at most 100 copies at a time. */
export const PRESERVED_BATCH = 100;

export const EXPORT_NOTICE =
  "A copy of the information My Game Dex holds for your account, in a structured format. It is a technical export, not a complete answer to a legal request for your data: what that must include is still being reviewed.";

/** What this version doesn't contain, said in the file so nobody takes it for everything. */
export const NOT_INCLUDED = [
  "Follows, follow requests and blocks",
  "Notifications",
  "Security and audit records, including sign-in history",
  "Your password, sign-in tokens and authenticator secrets, which are never exported",
  "Other people's data, including the reviewers of your submissions",
];

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * A copy's status as the collection pages show it (M6/M7): from the copy and its release,
 * if readable. M12a: a copy that names no release is "unidentified" while active.
 */
export function copyStatus(recordStatus: unknown, releaseStatus: unknown, unidentified = false): "owned" | "pending" | "not_approved" | "invalid" | "unidentified" {
  if (recordStatus === "invalid_preserved") return "invalid";
  if (unidentified) return "unidentified";
  if (releaseStatus === "published") return "owned";
  if (releaseStatus === "rejected") return "not_approved";
  if (typeof releaseStatus !== "string") return "invalid";
  return "pending";
}

export type Lookups = {
  releases: Map<string, Row>;
  games: Map<string, Row>;
  platforms: Map<string, Row>;
  regions: Map<string, Row>;
  formats: Map<string, Row>;
  /** get_my_preserved_titles, for copies whose release was excluded from the catalog. */
  preserved: Map<string, Row>;
};

function platformOf(lookups: Lookups, id: unknown): Row | null {
  const p = typeof id === "string" ? lookups.platforms.get(id) : undefined;
  return p ? { slug: p.slug ?? null, name: p.name ?? null, short_name: p.short_name ?? null } : null;
}

/** The release and game a copy is of, as far as the person may read them. */
function releaseOf(item: Row, lookups: Lookups): { release: Row | null; game: Row | null } {
  const r = lookups.releases.get(String(item.release_id));
  if (r) {
    const g = lookups.games.get(String(r.game_id));
    const region = lookups.regions.get(String(r.region_code));
    const format = lookups.formats.get(String(r.media_format_code));
    return {
      release: {
        id: r.id,
        status: r.status,
        platform: platformOf(lookups, r.platform_id),
        region: { code: r.region_code ?? null, label: region?.label ?? null },
        edition_name: r.edition_name ?? null,
        edition_kind: r.edition_kind ?? null,
        variant_name: r.variant_name ?? null,
        local_title: r.local_title ?? null,
        publisher_name: r.publisher_name ?? null,
        format: { code: r.media_format_code ?? null, name: format?.name ?? null },
        media_count: r.media_count ?? null,
        packaging: r.packaging ?? null,
        packaging_code: r.packaging_code ?? null,
        languages: r.languages ?? null,
        release_date: r.release_date ?? null,
        release_date_precision: r.release_date_precision ?? null,
        identifiers: { product_code: r.product_code ?? null, barcode: r.barcode ?? null },
      },
      game: g ? { id: g.id, slug: g.status === "published" ? (g.slug ?? null) : null, title: g.title ?? null, kind: g.kind ?? null } : null,
    };
  }
  const p = lookups.preserved.get(String(item.id));
  if (p) {
    return {
      release: {
        id: item.release_id,
        status: "excluded",
        platform: p.platform ?? null,
        region: p.region ?? null,
        edition_name: p.edition_name ?? null,
        variant_name: p.variant_name ?? null,
        local_title: p.local_title ?? null,
      },
      game: { title: p.title ?? null },
    };
  }
  return { release: { id: item.release_id, status: "unavailable" }, game: null };
}

/** One copy, with its owner-only details and pieces. Every copy is its own entry, duplicates included. */
export function shapeCopy(item: Row, priv: Row | undefined, pieces: Row[], lookups: Lookups): Row {
  const claimed = item.release_id == null;
  const { release, game } = claimed ? { release: null, game: claimedGame(item, lookups) } : releaseOf(item, lookups);
  return {
    id: item.id,
    status: copyStatus(item.record_status, lookups.releases.get(String(item.release_id))?.status, claimed),
    record_status: item.record_status,
    invalidated_at: item.invalidated_at ?? null,
    added_at: item.created_at,
    updated_at: item.updated_at,
    visibility: item.visibility,
    completeness: item.completeness ?? null,
    conditions: { overall: item.overall_condition ?? null, box: item.box_condition ?? null, media: item.media_condition ?? null, manual: item.manual_condition ?? null },
    components: pieces
      .map((c) => ({ kind: c.kind, label: c.label, condition: c.condition ?? null }))
      .sort((a, b) => `${a.kind}\u0000${a.label}`.localeCompare(`${b.kind}\u0000${b.label}`)),
    private: priv
      ? {
          acquired_on: priv.acquired_on ?? null,
          price: priv.purchase_price == null ? null : { amount: String(priv.purchase_price), currency: priv.currency ?? null },
          storage_location: priv.storage_location ?? null,
          notes: priv.notes ?? null,
        }
      : null,
    game,
    release,
    // M12a: what an unidentified copy claims; null for a copy that names a release.
    claim: claimed ? claimOf(item, lookups) : null,
  };
}

/** M12a: an unidentified copy's game: as the catalog shows it, or as preserved after an exclusion. */
function claimedGame(item: Row, lookups: Lookups): Row | null {
  const g = lookups.games.get(String(item.claimed_game_id));
  if (g) return { id: g.id, slug: g.status === "published" ? (g.slug ?? null) : null, title: g.title ?? null, kind: g.kind ?? null };
  const p = lookups.preserved.get(String(item.id));
  return p ? { title: p.title ?? null } : null;
}

/** M12a: what an unidentified copy claims. Null region or edition: the owner wasn't sure. */
function claimOf(item: Row, lookups: Lookups): Row {
  const code = str(item.claimed_region_code);
  return {
    platform: platformOf(lookups, item.claimed_platform_id),
    region: code ? { code, label: lookups.regions.get(code)?.label ?? null } : null,
    edition_kind: item.claimed_edition_kind ?? null,
    edition_name: item.claimed_edition_name ?? null,
  };
}

/** One of the person's submissions, from get_my_submission: what they see on its page, no reviewer. */
export function shapeSubmission(s: Row): Row {
  return {
    id: s.id,
    kind: s.kind,
    status: s.status,
    created_at: s.created_at,
    updated_at: s.updated_at,
    note: s.note ?? null,
    reviewer_note: s.reviewer_note ?? null,
    created_game: s.created_game ?? null,
    details: s.details ?? null,
    game_id: s.game_id ?? null,
    release_id: s.release_id ?? null,
    previous_id: s.previous_id ?? null,
    next_id: s.next_id ?? null,
  };
}

/** The profile as get_my_account returns it, without derived or internal fields. */
export function shapeProfile(a: Row): Row {
  return {
    handle: a.handle ?? null,
    display_name: a.display_name ?? null,
    bio: a.bio ?? null,
    country_code: a.country_code ?? null,
    avatar_path: a.avatar_path ?? null,
    collection_visibility: a.collection_visibility ?? null,
    follow_approval_required: a.follow_approval_required ?? null,
    allow_search_indexing: a.allow_search_indexing ?? null,
    account_status: a.account_status ?? null,
    handle_changed_at: a.handle_changed_at ?? null,
  };
}

/** Preferences, without the row's own key (the account id, said once under "account"). */
export function shapePreferences(p: Row | null): Row | null {
  if (!p) return null;
  const rest: Row = {};
  for (const [key, value] of Object.entries(p)) if (key !== "user_id") rest[key] = value;
  return rest;
}

/** Authenticators by kind, status and dates only. Never a secret, a QR code or a factor's challenge. */
export function shapeFactors(factors: Row[]): Row[] {
  return factors.map((f) => ({ type: f.factor_type ?? null, status: f.status ?? null, name: str(f.friendly_name), created_at: f.created_at ?? null }));
}

/** The download's name: the handle when there is one (it's [a-z0-9_]), and the UTC date. */
export function exportFilename(handle: string | null, now: Date): string {
  const safe = handle && /^[a-z0-9_]{3,24}$/.test(handle) ? handle : "account";
  return `my-game-dex-${safe}-${now.toISOString().slice(0, 10)}.json`;
}

const ERRORS: Record<string, string> = {
  export_too_many: "You've downloaded your data three times in the last hour. Try again later.",
  export_failed: "Your data couldn't be exported. Nothing was downloaded. Try again.",
  export_unavailable: "Exports aren't available right now. Try again later.",
  export_too_large: "Your collection is larger than an export can hold. Contact us for a copy.",
};

export function exportError(code: string | null): string | null {
  return code && Object.hasOwn(ERRORS, code) ? ERRORS[code] : null;
}
