/**
 * The public catalog, as the search functions return it (M5c). Game and Release stay
 * separate: search finds games, and the release picker lists a game's releases. A
 * field the catalog doesn't know is null, never a default.
 */

export type CatalogDate = {
  /** "1994", "1994-03" or "1994-03-11", to the precision the catalog records. */
  value: string;
  precision: "day" | "month" | "year";
};

export type CatalogGame = {
  id: string;
  slug: string;
  title: string;
  kind: "game" | "compilation" | "expansion";
  firstRelease: CatalogDate | null;
};

export type CatalogPlatformCount = {
  slug: string;
  name: string;
  shortName: string;
  releaseCount: number;
};

export type GameResult = {
  kind: "game";
  match: "exact" | "prefix" | "words" | "similar" | "browse";
  /** Set when an alias or a release's local title matched, not the game's title. */
  matched: { title: string; source: "alias" | "local_title" } | null;
  game: CatalogGame;
  platforms: CatalogPlatformCount[];
};

export type ReleaseResult = {
  kind: "release";
  match: "code";
  matchedIdentifier: "product_code" | "barcode";
  game: CatalogGame;
  release: {
    id: string;
    platform: { slug: string; name: string; shortName: string };
    region: { code: string; label: string };
    editionName: string | null;
    variantName: string | null;
    identifiers: { productCode: string | null; barcode: string | null };
  };
};

export type SearchResult = GameResult | ReleaseResult;

export type SearchResponse = {
  status: "ok" | "empty" | "too_short";
  /** The platform filter that was applied: unknown slugs are dropped. */
  platforms: string[];
  items: SearchResult[];
  nextCursor: string | null;
};

export type CatalogPlatform = {
  slug: string;
  name: string;
  shortName: string;
  family: string;
  gameCount: number;
};

export type PickerRelease = {
  id: string;
  platform: { slug: string; name: string; shortName: string };
  region: { code: string; label: string };
  markets: { code: string; name: string }[];
  edition: { name: string | null; kind: string | null } | null;
  variantName: string | null;
  localTitle: string | null;
  publisherName: string | null;
  format: { code: string; name: string; category: string } | null;
  mediaCount: number | null;
  mediaPlayability: "playable_from_media" | "download_required" | null;
  packaging: string | null;
  identifiers: { productCode: string | null; barcode: string | null };
  languages: string[] | null;
  ratingLabels: string[] | null;
  releaseDate: CatalogDate | null;
  components: { kind: string; label: string | null; quantity: number; format: string | null }[];
  requirements: { code: string; label: string; level: string; note: string | null }[];
};

export type ReleasePicker = {
  game: CatalogGame & {
    aliases: { title: string; kind: string; languageCode: string | null; regionCode: string | null }[];
  };
  platforms: CatalogPlatformCount[];
  regions: { code: string; label: string; releaseCount: number }[];
  selection: { platform: string | null; region: string | null; releaseId: string | null };
  releases: PickerRelease[];
};
