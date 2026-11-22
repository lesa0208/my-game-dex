// Collection statistics (M13): the counting rules, applied to the collector's own copies
// as the server reads them. Pure, with no "@/" imports, so `npm run statistics:test` can
// load it alone. Labels are applied by the page; here everything is a code or an id.
//
// Counting rules
// - A copy is one owned physical item (one collection_items row): every copy counts,
//   whatever its catalog standing, as in My Collection's total.
// - A copy's game is its release's game, or for a copy not linked to a release
//   (unidentified, M12a) the game it is claimed as. A copy whose release the collector
//   can no longer read (it left the catalog) has no known game: it counts as a copy, but
//   not as a game, since two such copies can't be told apart.
// - A copy's system is its release's platform, or its claimed platform, exactly as the
//   collection summary (and so the Systems screen) assigns it.
// - Distinct games count each game once, however many copies, releases or systems it
//   has. Per system, a game counts once on every system it has copies on, so the
//   systems' game counts can add up to more than the total.
// - Completeness, region and media format are what's recorded: the copy's completeness;
//   the release's region and format (for an unidentified copy, its claimed region, and
//   no format). Nothing missing is inferred: it is "not recorded". A copy whose release
//   left the catalog is counted under "not in the catalog" for region and format.
// - Every share is of all copies (or of all the system's copies), never of only those
//   with the detail recorded.

export const COMPLETENESS_ORDER = ["sealed", "complete", "incomplete", "loose"] as const;
export type Completeness = (typeof COMPLETENESS_ORDER)[number];
export const NOT_RECORDED = "not_recorded";
export const NOT_IN_CATALOG = "not_in_catalog";

/** A copy as read for statistics: no private details (prices, dates, notes) at all. */
export type StatCopy = {
  id: string;
  release_id: string | null;
  claimed_game_id: string | null;
  claimed_platform_id: string | null;
  claimed_region_code: string | null;
  completeness: string | null;
  record_status: string;
  /** The release, when the collector can read it; null when it isn't readable. */
  release: { game_id: string; platform_id: string; region_code: string | null; media_format_code: string | null; status: string } | null;
};

/** The catalog standing of a copy, as get_my_collection_summary defines it. */
export type Standing = "owned" | "pending" | "not_approved" | "unidentified" | "invalid";

export type CompletenessKey = Completeness | typeof NOT_RECORDED;
export type Counted<K extends string = string> = { key: K; copies: number };

export type SystemStats = {
  platformId: string;
  copies: number;
  games: number;
  completeness: Counted<CompletenessKey>[];
};

export type GameWithCopies = { gameId: string; copies: number; releases: number; systems: number };

export type Statistics = {
  copies: number;
  games: number;
  systems: number;
  /** Copies with no known game (their release left the catalog): not in `games`. */
  copiesWithoutGame: number;
  /** Copies with no known system: on no system's row. */
  copiesWithoutSystem: number;
  standing: Record<Standing, number>;
  completeness: Counted<CompletenessKey>[];
  systemsBreakdown: SystemStats[];
  regions: Counted[];
  formats: Counted[];
  several: {
    /** Games with two or more copies. */
    games: number;
    /** Copies beyond the first of each game. */
    extraCopies: number;
    /** Releases with two or more copies. */
    releases: number;
    /** The games with the most copies (two or more), most first. */
    top: GameWithCopies[];
  };
};

export function standingOf(copy: StatCopy): Standing {
  if (copy.record_status === "invalid_preserved") return "invalid";
  if (copy.release_id === null) return "unidentified";
  if (!copy.release) return "invalid";
  if (copy.release.status === "published") return "owned";
  if (copy.release.status === "rejected") return "not_approved";
  return "pending";
}

const gameOf = (c: StatCopy) => c.release?.game_id ?? (c.release_id === null ? c.claimed_game_id : null);
const systemOf = (c: StatCopy) => c.release?.platform_id ?? c.claimed_platform_id;
const regionOf = (c: StatCopy) => (c.release ? (c.release.region_code ?? NOT_RECORDED) : c.release_id === null ? (c.claimed_region_code ?? NOT_RECORDED) : NOT_IN_CATALOG);
const formatOf = (c: StatCopy) => (c.release ? (c.release.media_format_code ?? NOT_RECORDED) : c.release_id === null ? NOT_RECORDED : NOT_IN_CATALOG);
const completenessOf = (c: StatCopy): CompletenessKey =>
  (COMPLETENESS_ORDER as readonly string[]).includes(c.completeness ?? "") ? (c.completeness as Completeness) : NOT_RECORDED;

const COMPLETENESS_KEYS: CompletenessKey[] = [...COMPLETENESS_ORDER, NOT_RECORDED];

function tally<K extends string>(counts: Map<K, number>, key: K) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Largest first, ties by key; the two "unknown" buckets always last. */
function ranked(counts: Map<string, number>): Counted[] {
  const special = (k: string) => (k === NOT_RECORDED ? 1 : k === NOT_IN_CATALOG ? 2 : 0);
  return [...counts]
    .map(([key, copies]) => ({ key, copies }))
    .sort((a, b) => special(a.key) - special(b.key) || b.copies - a.copies || a.key.localeCompare(b.key));
}

const inOrder = (counts: Map<CompletenessKey, number>): Counted<CompletenessKey>[] => COMPLETENESS_KEYS.map((key) => ({ key, copies: counts.get(key) ?? 0 }));

export const TOP_GAMES = 5;

export function computeStatistics(copies: readonly StatCopy[]): Statistics {
  const games = new Set<string>();
  const systems = new Map<string, { copies: number; games: Set<string>; completeness: Map<CompletenessKey, number> }>();
  const completeness = new Map<CompletenessKey, number>();
  const regions = new Map<string, number>();
  const formats = new Map<string, number>();
  const standing: Record<Standing, number> = { owned: 0, pending: 0, not_approved: 0, unidentified: 0, invalid: 0 };
  const perGame = new Map<string, { copies: number; releases: Set<string>; systems: Set<string> }>();
  const perRelease = new Map<string, number>();
  let withoutGame = 0;
  let withoutSystem = 0;

  for (const copy of copies) {
    const game = gameOf(copy);
    const system = systemOf(copy);
    const level = completenessOf(copy);
    standing[standingOf(copy)] += 1;
    tally(completeness, level);
    tally(regions, regionOf(copy));
    tally(formats, formatOf(copy));
    if (copy.release_id) perRelease.set(copy.release_id, (perRelease.get(copy.release_id) ?? 0) + 1);

    if (game) {
      games.add(game);
      const g = perGame.get(game) ?? { copies: 0, releases: new Set<string>(), systems: new Set<string>() };
      g.copies += 1;
      if (copy.release_id) g.releases.add(copy.release_id);
      if (system) g.systems.add(system);
      perGame.set(game, g);
    } else {
      withoutGame += 1;
    }

    if (system) {
      const s = systems.get(system) ?? { copies: 0, games: new Set<string>(), completeness: new Map<CompletenessKey, number>() };
      s.copies += 1;
      if (game) s.games.add(game);
      tally(s.completeness, level);
      systems.set(system, s);
    } else {
      withoutSystem += 1;
    }
  }

  const several = [...perGame].filter(([, g]) => g.copies > 1);
  return {
    copies: copies.length,
    games: games.size,
    systems: systems.size,
    copiesWithoutGame: withoutGame,
    copiesWithoutSystem: withoutSystem,
    standing,
    completeness: inOrder(completeness),
    systemsBreakdown: [...systems]
      .map(([platformId, s]) => ({ platformId, copies: s.copies, games: s.games.size, completeness: inOrder(s.completeness) }))
      .sort((a, b) => b.copies - a.copies || a.platformId.localeCompare(b.platformId)),
    regions: ranked(regions),
    formats: ranked(formats),
    several: {
      games: several.length,
      extraCopies: several.reduce((sum, [, g]) => sum + g.copies - 1, 0),
      releases: [...perRelease.values()].filter((n) => n > 1).length,
      top: several
        .map(([gameId, g]) => ({ gameId, copies: g.copies, releases: g.releases.size, systems: g.systems.size }))
        .sort((a, b) => b.copies - a.copies || a.gameId.localeCompare(b.gameId))
        .slice(0, TOP_GAMES),
    },
  };
}

/**
 * A share as a whole percentage for display: never "0%" for a part that has copies (it
 * says "<1%"), and never "100%" for a part that isn't everything (">99%").
 */
export function percent(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  if (part >= whole) return "100%";
  const value = (part / whole) * 100;
  if (value < 1) return "<1%";
  if (value > 99) return ">99%";
  return `${Math.round(value)}%`;
}
