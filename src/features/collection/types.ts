/**
 * What the M6b read functions return, as the app uses it. Field names follow the
 * database's JSON. Private fields (acquisition, price, location, notes) are the
 * owner's own and only ever rendered on the owner's pages.
 */

export type CopyStatus = "owned" | "pending" | "not_approved" | "invalid";

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
  copies_of_release: number;
  game: { id: string; slug: string; title: string } | null;
  release: CopyRelease | null;
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
  release: (CopyRelease & { packaging: string | null; identifiers: { product_code: string | null; barcode: string | null } }) | null;
  notes: string | null;
  components: CopyPiece[];
};

export type CollectionSummary = {
  total: number;
  owned: number;
  pending: number;
  not_approved: number;
  invalid: number;
  limit: number;
  platforms: { slug: string; name: string; short_name: string; count: number }[];
};

/** Another copy of the same release, for telling copies apart. */
export type SiblingCopy = { id: string; added_at: string; completeness: string | null; conditions: Conditions };
