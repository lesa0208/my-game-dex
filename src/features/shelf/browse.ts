// The visual collection shelf (preview): types and the pure rules for browsing a system's
// shelf. No imports with the "@/" alias, so `npm run shelf:test` can load it directly.

/** How a system's games are physically stored, which decides how they are drawn. */
export type MediaKind = "snes-cart" | "nes-cart" | "gb-cart" | "n64-cart" | "md-cart" | "ps1-case" | "saturn-case";

/** A console drawing in src/components/shelf/console-art.tsx. */
export type ConsoleKind = "snes" | "nes" | "gameboy" | "n64" | "megadrive" | "playstation" | "saturn";

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
export type Region = "NTSC-U" | "PAL" | "NTSC-J";

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

export type ShelfSort = "title" | "year" | "acquired" | "condition";

export type ShelfFilters = {
  query: string;
  completeness: Completeness | "all";
  region: Region | "all";
  favoritesOnly: boolean;
};

export const DEFAULT_FILTERS: ShelfFilters = { query: "", completeness: "all", region: "all", favoritesOnly: false };

export const SORTS: readonly { value: ShelfSort; label: string }[] = [
  { value: "title", label: "Title (A–Z)" },
  { value: "year", label: "Release year" },
  { value: "acquired", label: "Recently acquired" },
  { value: "condition", label: "Best condition" },
];

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

export const REGIONS: readonly Region[] = ["NTSC-U", "PAL", "NTSC-J"];

export function completenessLabel(value: Completeness, short = false) {
  const entry = COMPLETENESS.find((c) => c.value === value);
  return short ? (entry?.short ?? value) : (entry?.label ?? value);
}

export function conditionLabel(value: Condition) {
  return CONDITIONS.find((c) => c.value === value)?.label ?? value;
}

/** Titles sort as collectors shelve them: case, accents and a leading "The" ignored. */
export function titleKey(title: string) {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .trim();
}

const CONDITION_RANK: Record<Condition, number> = { mint: 0, very_good: 1, good: 2, fair: 3 };

function compare(sort: ShelfSort) {
  const byTitle = (a: ShelfGame, b: ShelfGame) => titleKey(a.title).localeCompare(titleKey(b.title), "en");
  switch (sort) {
    case "year":
      return (a: ShelfGame, b: ShelfGame) => a.year - b.year || byTitle(a, b);
    case "acquired":
      return (a: ShelfGame, b: ShelfGame) => b.acquired.localeCompare(a.acquired) || byTitle(a, b);
    case "condition":
      return (a: ShelfGame, b: ShelfGame) => CONDITION_RANK[a.condition] - CONDITION_RANK[b.condition] || byTitle(a, b);
    default:
      return byTitle;
  }
}

/** The games on the shelf after the filters, in the chosen order. Never changes `games`. */
export function browseShelf(games: readonly ShelfGame[], sort: ShelfSort, filters: ShelfFilters) {
  const query = titleKey(filters.query);
  return games
    .filter(
      (game) =>
        (!query || titleKey(game.title).includes(query)) &&
        (filters.completeness === "all" || game.completeness === filters.completeness) &&
        (filters.region === "all" || game.region === filters.region) &&
        (!filters.favoritesOnly || game.favorite),
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

/** Reads a sort from a query value, falling back to title order. */
export function readSort(value: string | null | undefined): ShelfSort {
  return SORTS.some((s) => s.value === value) ? (value as ShelfSort) : "title";
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
 * Original label artwork for a mock cartridge, decided by its slug so it never changes
 * between renders: two hues and a motif. No real cover art is used.
 */
export function labelArt(slug: string) {
  const h = hash(slug);
  const hue = h % 360;
  return {
    from: `oklch(0.42 0.16 ${hue})`,
    to: `oklch(0.2 0.09 ${(hue + 40 + ((h >>> 9) % 80)) % 360})`,
    glow: `oklch(0.82 0.15 ${(hue + 180) % 360})`,
    motif: MOTIFS[(h >>> 3) % MOTIFS.length],
  };
}
