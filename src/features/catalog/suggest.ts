// M17a: search suggestions while typing, shared by the Explore search and the header
// search. Pure, with relative imports only, so `npm run catalog:test` loads it directly.
//
// Suggestions come from the same search_catalog function as the full results page, in
// its own order: an exact title (or identifier) first, then title and alias prefixes,
// then whole words, then similar titles. Nothing is ranked by popularity; there is no
// such data.

import type { SearchResult } from "./types";

/** Typing fewer characters than this asks for nothing. */
export const SUGGEST_MIN_LENGTH = 2;
/** How many suggestions are shown at most. */
export const SUGGEST_LIMIT = 8;
/** The longest query sent; longer input is cut, as the results page does. */
export const SUGGEST_MAX_LENGTH = 100;

export type Suggestion = {
  /** Unique within one list. */
  key: string;
  /** The game's page; for a product code or barcode, with that release chosen. */
  href: string;
  title: string;
  /** "1990", when the catalog records a first release. */
  year: string | null;
  /** The game's platforms' short names, in the catalog's order. */
  platforms: string[];
  /** Why it matched, when it wasn't the title: "Also known as Mario 4", "Product code SNS-MW-USA". */
  note: string | null;
};

/** The query as it will be sent, or null when it's too short to suggest anything. */
export function suggestQuery(input: string): string | null {
  const query = input.trim().replace(/\s+/g, " ").slice(0, SUGGEST_MAX_LENGTH);
  return [...query].length >= SUGGEST_MIN_LENGTH ? query : null;
}

/** How strong a match is: an identifier or exact title, a prefix, whole words, then similar. */
const STRENGTH: Record<SearchResult["match"], number> = { code: 0, exact: 1, prefix: 2, words: 3, similar: 4, browse: 5 };

/**
 * Search results as suggestions: at most SUGGEST_LIMIT, one per game or release, in the
 * search's order, except that within the same strength a game whose own title matched
 * comes before one that matched by another title ("Mario Bros." before "Super Mario
 * Bros. 2", found as "Mario 2"). The sort is stable, so the search's order stays otherwise.
 */
export function toSuggestions(results: readonly SearchResult[]): Suggestion[] {
  const items = results
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const strength = STRENGTH[a.item.match] - STRENGTH[b.item.match];
      const byAlias = Number(a.item.kind === "game" && a.item.matched !== null) - Number(b.item.kind === "game" && b.item.matched !== null);
      return strength || byAlias || a.index - b.index;
    })
    .map(({ item }) => item);
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const item of items) {
    const key = item.kind === "release" ? `release:${item.release.id}` : `game:${item.game.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const year = item.game.firstRelease ? item.game.firstRelease.value.slice(0, 4) : null;
    if (item.kind === "release") {
      const code = item.matchedIdentifier === "barcode" ? `Barcode ${item.release.identifiers.barcode}` : `Product code ${item.release.identifiers.productCode}`;
      out.push({
        key,
        href: `/games/${item.game.slug}?release=${item.release.id}`,
        title: item.game.title,
        year,
        platforms: [item.release.platform.shortName],
        note: `${code} · ${item.release.region.label}`,
      });
    } else {
      const note = item.matched ? `${item.matched.source === "alias" ? "Also known as" : "Released as"} ${item.matched.title}` : null;
      out.push({ key, href: `/games/${item.game.slug}`, title: item.game.title, year, platforms: item.platforms.map((p) => p.shortName), note });
    }
    if (out.length === SUGGEST_LIMIT) break;
  }
  return out;
}

/**
 * Keeps suggestions in step with typing: each request gets a number, and only the
 * newest request's answer may replace the list, so a slow early response can't
 * overwrite a later one.
 */
export function latestOnly() {
  let latest = 0;
  return {
    next: () => ++latest,
    isLatest: (ticket: number) => ticket === latest,
  };
}
