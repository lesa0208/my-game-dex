// The collection shelf: types and the pure rules for browsing a system's shelf, shared by
// the visual preview (sample data) and the signed-in collector's real copies. No imports
// with the "@/" alias, so `npm run shelf:test` can load it directly.

/** How a system's games are physically stored, which decides how they are drawn. */
export type MediaKind = "snes-cart" | "nes-cart" | "gb-cart" | "n64-cart" | "md-cart" | "ps1-case" | "saturn-case";

/** A console drawing in src/components/shelf/console-art.tsx. */
export type ConsoleKind = "snes" | "nes" | "gameboy" | "gbc" | "gba" | "n64" | "megadrive" | "playstation" | "ps2" | "saturn";

/** The regional shells the media art distinguishes (only the SNES cartridge differs). */
export type Region = "NTSC-U" | "PAL" | "NTSC-J";

/**
 * One physical item on a shelf: a sample game in the preview, or one of the collector's
 * copies. Everything not known is null, never guessed.
 */
export type ShelfItem = {
  key: string;
  href: string;
  title: string;
  /** The shell it is drawn in. Null when the physical format isn't known: drawn as a neutral placeholder. */
  media: { kind: MediaKind; region: Region } | null;
  /** Seeds the placeholder label art, so an item's label never changes between renders. */
  labelSeed: string;
  favorite: boolean;
  /** The region as recorded ("PAL", "NTSC-U/C"), for display and the region filter. */
  region: string | null;
  completeness: { value: string; label: string; short: string } | null;
  /** Lower rank is better. */
  condition: { label: string; rank: number } | null;
  /** YYYY-MM-DD. */
  acquired: string | null;
  /** When the copy was added, as an ISO timestamp. */
  added: string | null;
  year: number | null;
  /** The known facts under its title in the list ("PS1 · PAL · Platinum"). */
  details: string;
  /** Its standing, when it needs saying ("Not linked to a release"). */
  note: string | null;
  /** The physical format as recorded, or null. */
  format: string | null;
};

export type ShelfSort = "title" | "year" | "acquired" | "added" | "condition";

export const SORT_LABELS: Record<ShelfSort, string> = {
  title: "Title (A–Z)",
  year: "Release year",
  acquired: "Recently acquired",
  added: "Recently added",
  condition: "Best condition",
};

/** A filter value matching items with nothing recorded. */
export const NOT_RECORDED = "not_recorded";

export type ShelfFilters = {
  query: string;
  completeness: string;
  region: string;
  favoritesOnly: boolean;
};

export const DEFAULT_FILTERS: ShelfFilters = { query: "", completeness: "all", region: "all", favoritesOnly: false };

/** Titles sort as collectors shelve them: case, accents and a leading "The" ignored. */
export function titleKey(title: string) {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .trim();
}

/** Items with the value first; those without it last. */
function nullsLast<T>(get: (item: ShelfItem) => T | null, order: (a: T, b: T) => number) {
  return (a: ShelfItem, b: ShelfItem) => {
    const x = get(a);
    const y = get(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return order(x, y);
  };
}

function compare(sort: ShelfSort) {
  const byTitle = (a: ShelfItem, b: ShelfItem) => titleKey(a.title).localeCompare(titleKey(b.title), "en") || a.key.localeCompare(b.key);
  const then = (first: (a: ShelfItem, b: ShelfItem) => number) => (a: ShelfItem, b: ShelfItem) => first(a, b) || byTitle(a, b);
  switch (sort) {
    case "year":
      return then(nullsLast((i) => i.year, (x, y) => x - y));
    case "acquired":
      return then(nullsLast((i) => i.acquired, (x, y) => y.localeCompare(x)));
    case "added":
      return then(nullsLast((i) => i.added, (x, y) => y.localeCompare(x)));
    case "condition":
      return then(nullsLast((i) => i.condition?.rank ?? null, (x, y) => x - y));
    default:
      return byTitle;
  }
}

function matches(value: string | null, filter: string) {
  return filter === "all" || (filter === NOT_RECORDED ? value === null : value === filter);
}

/** The items on the shelf after the filters, in the chosen order. Never changes `items`. */
export function browseShelf(items: readonly ShelfItem[], sort: ShelfSort, filters: ShelfFilters) {
  const query = titleKey(filters.query);
  return items
    .filter(
      (item) =>
        (!query || titleKey(item.title).includes(query)) &&
        matches(item.completeness?.value ?? null, filters.completeness) &&
        matches(item.region, filters.region) &&
        (!filters.favoritesOnly || item.favorite),
    )
    .sort(compare(sort));
}

export function activeFilterCount(filters: ShelfFilters) {
  return (
    (filters.query.trim() ? 1 : 0) +
    (filters.completeness === "all" ? 0 : 1) +
    (filters.region === "all" ? 0 : 1) +
    (filters.favoritesOnly ? 1 : 0)
  );
}

export type FilterOption = { value: string; label: string };

/**
 * The filter choices a shelf offers: only completeness levels and regions some item
 * has, in the order first seen (completeness) or alphabetically (regions), plus "Not
 * recorded" when an item has none.
 */
export function filterOptions(items: readonly ShelfItem[]) {
  const completeness = new Map<string, FilterOption & { rank: number }>();
  const regions = new Set<string>();
  let completenessMissing = false;
  let regionMissing = false;
  for (const item of items) {
    if (item.completeness) completeness.set(item.completeness.value, { value: item.completeness.value, label: item.completeness.short, rank: completeness.size });
    else completenessMissing = true;
    if (item.region) regions.add(item.region);
    else regionMissing = true;
  }
  const missing = { value: NOT_RECORDED, label: "Not recorded" };
  return {
    completeness: [...[...completeness.values()].map(({ value, label }) => ({ value, label })), ...(completenessMissing ? [missing] : [])],
    regions: [...[...regions].sort((a, b) => a.localeCompare(b, "en")).map((r) => ({ value: r, label: r })), ...(regionMissing ? [missing] : [])],
  };
}

export type LabelMotif = "peaks" | "sun" | "stars" | "grid" | "waves" | "planet" | "castle" | "bolt";

const MOTIFS: readonly LabelMotif[] = ["peaks", "sun", "stars", "grid", "waves", "planet", "castle", "bolt"];

function hash(text: string) {
  let h = 2166136261;
  for (const char of text) {
    h ^= char.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Original placeholder label artwork, decided by a seed so it never changes between
 * renders: two hues and a motif. No real cover art is used.
 */
export function labelArt(seed: string) {
  const h = hash(seed);
  const hue = h % 360;
  return {
    from: `oklch(0.42 0.16 ${hue})`,
    to: `oklch(0.2 0.09 ${(hue + 40 + ((h >>> 9) % 80)) % 360})`,
    glow: `oklch(0.82 0.15 ${(hue + 180) % 360})`,
    motif: MOTIFS[(h >>> 3) % MOTIFS.length],
  };
}

// ---------------------------------------------------------------------------
// The visual preview's sample data (src/dev/seed/shelf.ts)
// ---------------------------------------------------------------------------

export type ShelfSystem = {
  slug: string;
  name: string;
  shortName: string;
  maker: string;
  /** First release year. */
  released: number;
  media: MediaKind;
  console: ConsoleKind;
  /** Two accent colours for the system's tile and labels, as hex. */
  accent: [string, string];
};

export type Completeness = "cib" | "boxed" | "loose";
export type Condition = "mint" | "very_good" | "good" | "fair";

export type ShelfGame = {
  slug: string;
  title: string;
  year: number;
  genre: string;
  publisher: string;
  region: Region;
  completeness: Completeness;
  condition: Condition;
  /** Copies of this game the collector owns, at least 1. */
  copies: number;
  favorite: boolean;
  /** ISO date the first copy was acquired. */
  acquired: string;
  notes?: string;
};

/** The sorts the preview offers. */
export const SAMPLE_SORTS: readonly ShelfSort[] = ["title", "year", "acquired", "condition"];

export const COMPLETENESS: readonly { value: Completeness; label: string; short: string }[] = [
  { value: "cib", label: "Complete in box", short: "CIB" },
  { value: "boxed", label: "Boxed, no manual", short: "Boxed" },
  { value: "loose", label: "Loose cartridge", short: "Loose" },
];

export const CONDITIONS: readonly { value: Condition; label: string }[] = [
  { value: "mint", label: "Mint" },
  { value: "very_good", label: "Very good" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
];

export function completenessLabel(value: Completeness, short = false) {
  const entry = COMPLETENESS.find((c) => c.value === value);
  return short ? (entry?.short ?? value) : (entry?.label ?? value);
}

export function conditionLabel(value: Condition) {
  return CONDITIONS.find((c) => c.value === value)?.label ?? value;
}

/** A sample game as a shelf item. */
export function sampleItem(game: ShelfGame, media: MediaKind, href: string): ShelfItem {
  const completeness = COMPLETENESS.find((c) => c.value === game.completeness)!;
  return {
    key: game.slug,
    href,
    title: game.title,
    media: { kind: media, region: game.region },
    labelSeed: game.slug,
    favorite: game.favorite,
    region: game.region,
    completeness: { ...completeness },
    condition: { label: conditionLabel(game.condition), rank: CONDITIONS.findIndex((c) => c.value === game.condition) },
    acquired: game.acquired,
    added: null,
    year: game.year,
    details: `${game.year} · ${game.publisher} · ${game.genre}`,
    note: null,
    format: null,
  };
}

export type ShelfStats = { games: number; copies: number; favorites: number; completeShare: number };

export function shelfStats(games: readonly ShelfGame[]): ShelfStats {
  const copies = games.reduce((sum, game) => sum + game.copies, 0);
  const complete = games.filter((game) => game.completeness === "cib").length;
  return {
    games: games.length,
    copies,
    favorites: games.filter((game) => game.favorite).length,
    completeShare: games.length ? Math.round((complete / games.length) * 100) : 0,
  };
}
