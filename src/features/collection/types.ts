/**
 * What the M6b read functions return, as the app uses it. Field names follow the
 * database's JSON. Private fields (acquisition, price, location, notes) are the
 * owner's own and only ever rendered on the owner's pages.
 */

/**
 * "unidentified" (M12a): a copy that names no release, only the owner's private claim of
 * a game and platform, with region and edition each optional. It is the owner's own
 * record, never a verified catalog release.
 */
export type CopyStatus = "owned" | "pending" | "not_approved" | "invalid" | "unidentified";

/** M12a: what an unidentified copy claims. Null region or edition: the owner isn't sure. */
export type CopyClaim = {
  platform: { slug: string; name: string; short_name: string };
  region: { code: string; label: string | null } | null;
  edition_kind: string | null;
  edition_name: string | null;
  /** Whether the catalog lists this platform for the game. False: the owner's own pairing, not a verified one. */
  catalog_pairing: boolean;
};

export type Conditions = {
  overall: string | null;
  box: string | null;
  media: string | null;
  manual: string | null;
};

export type CopyRelease = {
  id: string;
  platform: { slug: string; name: string; short_name: string };
  region: { code: string; label: string | null };
  edition_name: string | null;
  variant_name: string | null;
  local_title: string | null;
  format: { code: string | null; name: string | null };
  media_count: number | null;
};

export type CollectionEntry = {
  id: string;
  status: CopyStatus;
  added_at: string;
  updated_at: string;
  completeness: string | null;
  conditions: Conditions;
  /** 0 for an unidentified copy. */
  copies_of_release: number;
  game: { id: string; /** Null while the game is a pending submission. */ slug: string | null; title: string } | null;
  release: CopyRelease | null;
  /** M12a: "release" when the copy names one, "claim" when it's unidentified. */
  identity: "release" | "claim";
  claim: CopyClaim | null;
  acquired_on: string | null;
  price: { amount: string; currency: string } | null;
  storage_location: string | null;
  has_notes: boolean;
};

export type CollectionPage = { items: CollectionEntry[]; next_cursor: string | null };

export type CopyPiece = {
  kind: string;
  label: string | null;
  quantity: number | null;
  /** The release lists this piece. */
  listed: boolean;
  /** The owner recorded it for this copy. */
  recorded: boolean;
  /** When recorded: null for included, `not_included` for missing, or a grade. */
  condition: string | null;
};

export type CopyDetail = Omit<CollectionEntry, "has_notes" | "release"> & {
  release: (CopyRelease & { packaging: string | null; packaging_code?: string; identifiers: { product_code: string | null; barcode: string | null } }) | null;
  notes: string | null;
  components: CopyPiece[];
};

export type CollectionSummary = {
  total: number;
  owned: number;
  pending: number;
  not_approved: number;
  invalid: number;
  /** M12a: unidentified copies, counted apart from confirmed ones ("owned"). */
  unidentified: number;
  limit: number;
  platforms: { slug: string; name: string; short_name: string; count: number }[];
};

/**
 * M12a: the signed-in owner's copies of one game. "owned" is true when any copy is active,
 * whatever its catalog standing; preserved copies are listed but don't count.
 */
export type GameOwnership = {
  owned: boolean;
  copies: number;
  entries: {
    status: CopyStatus;
    release_id: string | null;
    platform: { slug: string; name: string; short_name: string };
    region: { code: string; label: string | null } | null;
    edition_kind: string | null;
    edition_name: string | null;
    catalog_pairing: boolean;
    count: number;
  }[];
};

/** M12a: a copy's identity as set_my_copy_identity takes it. */
export type CopyIdentity =
  | { release_id: string }
  | { game_id: string; platform_id: string; region_code?: string | null; edition_kind?: string | null; edition_name?: string | null };

/** M12a: one change of a copy's identity, from its private history. */
export type CopyHistoryEntry = {
  changed_at: string;
  source: "owner" | "catalog" | "maintenance";
  previous: Record<string, string | null>;
  current: Record<string, string | null>;
};

/** M12a: a claim preserved by an exclusion of its game, as its owner reads it. */
export type PreservedClaim = {
  game: { title: string };
  platform: { slug: string; name: string; short_name: string };
  region: { code: string; label: string | null } | null;
  edition_kind: string | null;
  edition_name: string | null;
  exclusion: { reason_code: string; note: string | null; excluded_at: string } | null;
};

/** Another copy of the same release, for telling copies apart. */
export type SiblingCopy = { id: string; added_at: string; completeness: string | null; conditions: Conditions };
