// Run with: npm run shelf:test. The visual shelf preview's pure rules: sorting, filtering,
// statistics and the generated label artwork.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeFilterCount,
  browseShelf,
  DEFAULT_FILTERS,
  labelArt,
  readSort,
  shelfStats,
  titleKey,
} from "./browse.ts";

const game = (title, extra = {}) => ({
  slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  year: 1994,
  genre: "RPG",
  publisher: "Studio",
  region: "NTSC-U",
  completeness: "loose",
  condition: "good",
  copies: 1,
  favorite: false,
  acquired: "2023-01-01",
  ...extra,
});

const games = [
  game("The Legend of Zelda", { year: 1991, completeness: "cib", condition: "very_good", favorite: true, acquired: "2021-05-08" }),
  game("Earthbound", { year: 1995, completeness: "cib", condition: "mint", acquired: "2024-09-02", copies: 2 }),
  game("Ãctraiser", { year: 1990, region: "PAL", acquired: "2023-02-11" }),
  game("Mega Man X", { year: 1993, completeness: "boxed", condition: "fair", region: "NTSC-J", acquired: "2022-08-27" }),
];

test("titles shelve without a leading 'The', case or accents", () => {
  assert.equal(titleKey("The Legend of Zelda"), "legend of zelda");
  assert.equal(titleKey("Ãctraiser"), "actraiser");
  assert.deepEqual(
    browseShelf(games, "title", DEFAULT_FILTERS).map((g) => g.title),
    ["Ãctraiser", "Earthbound", "The Legend of Zelda", "Mega Man X"],
  );
});

test("each sort orders as described, with title as the tie-break", () => {
  assert.deepEqual(browseShelf(games, "year", DEFAULT_FILTERS).map((g) => g.year), [1990, 1991, 1993, 1995]);
  assert.equal(browseShelf(games, "acquired", DEFAULT_FILTERS)[0].title, "Earthbound");
  assert.deepEqual(
    browseShelf(games, "condition", DEFAULT_FILTERS).map((g) => g.condition),
    ["mint", "very_good", "good", "fair"],
  );
});

test("filters combine, and browsing never changes the input", () => {
  const before = games.map((g) => g.title);
  assert.deepEqual(browseShelf(games, "title", { ...DEFAULT_FILTERS, completeness: "cib" }).map((g) => g.title), ["Earthbound", "The Legend of Zelda"]);
  assert.deepEqual(browseShelf(games, "title", { ...DEFAULT_FILTERS, completeness: "cib", favoritesOnly: true }).map((g) => g.title), ["The Legend of Zelda"]);
  assert.deepEqual(browseShelf(games, "title", { ...DEFAULT_FILTERS, region: "NTSC-J" }).map((g) => g.title), ["Mega Man X"]);
  assert.deepEqual(browseShelf(games, "title", { ...DEFAULT_FILTERS, query: "  ZELDA " }).map((g) => g.title), ["The Legend of Zelda"]);
  assert.deepEqual(browseShelf(games, "title", { ...DEFAULT_FILTERS, query: "nothing" }), []);
  assert.deepEqual(games.map((g) => g.title), before);
});

test("the active filter count ignores an empty search", () => {
  assert.equal(activeFilterCount(DEFAULT_FILTERS), 0);
  assert.equal(activeFilterCount({ ...DEFAULT_FILTERS, query: "   " }), 0);
  assert.equal(activeFilterCount({ query: "x", completeness: "cib", region: "PAL", favoritesOnly: true }), 4);
});

test("statistics count games, copies, favorites and the complete-in-box share", () => {
  assert.deepEqual(shelfStats(games), { games: 4, copies: 5, favorites: 1, completeShare: 50 });
  assert.deepEqual(shelfStats([]), { games: 0, copies: 0, favorites: 0, completeShare: 0 });
});

test("an unknown sort falls back to title order", () => {
  assert.equal(readSort("year"), "year");
  assert.equal(readSort("price"), "title");
  assert.equal(readSort(null), "title");
});

test("label art is stable for a slug and varies between slugs", () => {
  assert.deepEqual(labelArt("chrono-trigger"), labelArt("chrono-trigger"));
  const motifs = new Set(games.map((g) => labelArt(g.slug).motif));
  const hues = new Set(["a", "b", "c", "d", "e", "f"].map((s) => labelArt(s).from));
  assert.ok(motifs.size >= 2);
  assert.ok(hues.size >= 4);
});
