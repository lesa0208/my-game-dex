// Run with: npm run shelf:test. The collection shelf's pure rules: sorting, filtering and
// statistics, the preview's sample items, how a real copy becomes a shelf item, and which
// physical shell it is drawn in.
import assert from "node:assert/strict";
import { test } from "node:test";

import { claimLine, completenessLabel, conditionLabel, copyStatusLabel, releaseLine } from "../collection/details.ts";
import {
  activeFilterCount,
  browseShelf,
  DEFAULT_FILTERS,
  filterOptions,
  labelArt,
  NOT_RECORDED,
  sampleItem,
  shelfStats,
  titleKey,
} from "./browse.ts";
import { consoleFor, copyItem, copyPlatform, physicalMedia, shelfFrame } from "./copies.ts";

// ---------------------------------------------------------------------------
// Browsing, on the preview's sample games
// ---------------------------------------------------------------------------

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
const items = games.map((g) => sampleItem(g, "snes-cart", `/collection/preview/snes/${g.slug}`));

test("titles shelve without a leading 'The', case or accents", () => {
  assert.equal(titleKey("The Legend of Zelda"), "legend of zelda");
  assert.equal(titleKey("Ãctraiser"), "actraiser");
  assert.deepEqual(
    browseShelf(items, "title", DEFAULT_FILTERS).map((g) => g.title),
    ["Ãctraiser", "Earthbound", "The Legend of Zelda", "Mega Man X"],
  );
});

test("each sort orders as described, with title as the tie-break", () => {
  assert.deepEqual(browseShelf(items, "year", DEFAULT_FILTERS).map((g) => g.year), [1990, 1991, 1993, 1995]);
  assert.equal(browseShelf(items, "acquired", DEFAULT_FILTERS)[0].title, "Earthbound");
  assert.deepEqual(
    browseShelf(items, "condition", DEFAULT_FILTERS).map((g) => g.condition.label),
    ["Mint", "Very good", "Good", "Fair"],
  );
});

test("filters combine, and browsing never changes the input", () => {
  const before = items.map((g) => g.title);
  assert.deepEqual(browseShelf(items, "title", { ...DEFAULT_FILTERS, completeness: "cib" }).map((g) => g.title), ["Earthbound", "The Legend of Zelda"]);
  assert.deepEqual(browseShelf(items, "title", { ...DEFAULT_FILTERS, completeness: "cib", favoritesOnly: true }).map((g) => g.title), ["The Legend of Zelda"]);
  assert.deepEqual(browseShelf(items, "title", { ...DEFAULT_FILTERS, region: "NTSC-J" }).map((g) => g.title), ["Mega Man X"]);
  assert.deepEqual(browseShelf(items, "title", { ...DEFAULT_FILTERS, query: "  ZELDA " }).map((g) => g.title), ["The Legend of Zelda"]);
  assert.deepEqual(browseShelf(items, "title", { ...DEFAULT_FILTERS, query: "nothing" }), []);
  assert.deepEqual(items.map((g) => g.title), before);
});

test("the active filter count ignores an empty search", () => {
  assert.equal(activeFilterCount(DEFAULT_FILTERS), 0);
  assert.equal(activeFilterCount({ ...DEFAULT_FILTERS, query: "   " }), 0);
  assert.equal(activeFilterCount({ query: "x", completeness: "cib", region: "PAL", favoritesOnly: true }), 4);
});

test("sample statistics count games, copies, favorites and the complete-in-box share", () => {
  assert.deepEqual(shelfStats(games), { games: 4, copies: 5, favorites: 1, completeShare: 50 });
  assert.deepEqual(shelfStats([]), { games: 0, copies: 0, favorites: 0, completeShare: 0 });
});

test("label art is stable for a seed and varies between seeds", () => {
  assert.deepEqual(labelArt("chrono-trigger"), labelArt("chrono-trigger"));
  const motifs = new Set(games.map((g) => labelArt(g.slug).motif));
  const hues = new Set(["a", "b", "c", "d", "e", "f"].map((s) => labelArt(s).from));
  assert.ok(motifs.size >= 2);
  assert.ok(hues.size >= 4);
});

// ---------------------------------------------------------------------------
// Physical shells for real copies
// ---------------------------------------------------------------------------

test("a SNES copy's shell follows its recorded format, then its region", () => {
  assert.deepEqual(physicalMedia("snes", "snes-game-pak-na", "ntsc-uc"), { kind: "snes-cart", region: "NTSC-U" });
  assert.deepEqual(physicalMedia("snes", "snes-cartridge-jp-pal", "pal"), { kind: "snes-cart", region: "PAL" });
  assert.deepEqual(physicalMedia("snes", "snes-cartridge-jp-pal", "ntsc-j"), { kind: "snes-cart", region: "NTSC-J" });
  // The generic cartridge: the platform and region decide the shape (M1 reference seed).
  assert.deepEqual(physicalMedia("snes", "rom-cartridge", "pal"), { kind: "snes-cart", region: "PAL" });
  assert.deepEqual(physicalMedia("snes", null, "ntsc-uc"), { kind: "snes-cart", region: "NTSC-U" });
  // No region, or one the art doesn't cover: not guessed.
  assert.equal(physicalMedia("snes", "rom-cartridge", null), null);
  assert.equal(physicalMedia("snes", null, "ntsc-k"), null);
});

test("shells the art doesn't show are never substituted", () => {
  assert.equal(physicalMedia("nes", "famicom-cartridge", "ntsc-j"), null, "a Famicom cartridge isn't an NES Game Pak");
  assert.equal(physicalMedia("nes", "rom-cartridge", "ntsc-j"), null);
  assert.deepEqual(physicalMedia("nes", "nes-game-pak", "pal"), { kind: "nes-cart", region: "NTSC-U" });
  assert.equal(physicalMedia("mega-drive", "rom-cartridge", "ntsc-j"), null, "Japanese Mega Drive shells differ");
  assert.deepEqual(physicalMedia("mega-drive", "rom-cartridge", "pal"), { kind: "md-cart", region: "NTSC-U" });
  assert.equal(physicalMedia("sega-saturn", "cd-rom", "ntsc-uc"), null, "North American Saturn cases differ");
  assert.deepEqual(physicalMedia("sega-saturn", "cd-rom", "ntsc-j")?.kind, "saturn-case");
  assert.equal(physicalMedia("sega-saturn", "cd-rom", null), null);
  assert.equal(physicalMedia("famicom-disk-system", "famicom-disk-card", "ntsc-j"), null);
  assert.equal(physicalMedia("gamecube", "gamecube-game-disc", "pal"), null);
});

test("one-shell platforms draw their shell in every region", () => {
  assert.equal(physicalMedia("nintendo-64", "rom-cartridge", null)?.kind, "n64-cart");
  assert.equal(physicalMedia("game-boy", "game-boy-game-pak", "ntsc-j")?.kind, "gb-cart");
  assert.equal(physicalMedia("playstation", "cd-rom", "ntsc-j")?.kind, "ps1-case");
  assert.equal(physicalMedia("playstation", null, null)?.kind, "ps1-case");
  assert.equal(physicalMedia("game-boy-color", "game-boy-game-pak", "pal"), null, "Game Boy Color shells differ");
});

test("consoles and shelf frames exist only for platforms with art", () => {
  assert.equal(consoleFor("sega-saturn"), "saturn");
  assert.equal(consoleFor("nintendo-64"), "n64");
  assert.equal(consoleFor("gamecube"), null);
  assert.equal(shelfFrame("playstation"), "ps1-case");
  assert.equal(shelfFrame("xbox"), null);
});

// ---------------------------------------------------------------------------
// Real copies as shelf items
// ---------------------------------------------------------------------------

const LABELS = { completeness: completenessLabel, condition: conditionLabel, status: copyStatusLabel, releaseLine, claimLine };
const conditions = (overall = null) => ({ overall, box: null, media: null, manual: null });

function release(id, { platform = "snes", region = "pal", regionLabel = "PAL", format = "snes-cartridge-jp-pal", edition = null } = {}) {
  return {
    id,
    platform: { slug: platform, name: platform.toUpperCase(), short_name: platform.toUpperCase() },
    region: { code: region, label: regionLabel },
    edition_name: edition,
    variant_name: null,
    local_title: null,
    format: { code: format, name: format },
    media_count: 1,
  };
}

function entry(id, extra = {}) {
  return {
    id,
    status: "owned",
    added_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    completeness: null,
    conditions: conditions(),
    copies_of_release: 1,
    game: { id: `g-${id}`, slug: `game-${id}`, title: `Game ${id}` },
    release: release(`r-${id}`),
    identity: "release",
    claim: null,
    acquired_on: null,
    price: null,
    storage_location: null,
    has_notes: false,
    ...extra,
  };
}

test("a copy of a release keeps its region, edition, completeness and condition", () => {
  const item = copyItem(entry("a", { completeness: "complete", conditions: conditions("very_good"), release: release("r1", { edition: "Platinum" }) }), {
    labels: LABELS,
    copyNumber: { number: 2, total: 3 },
  });
  assert.equal(item.href, "/collection/a");
  assert.equal(item.region, "PAL");
  assert.deepEqual(item.media, { kind: "snes-cart", region: "PAL" });
  assert.deepEqual(item.completeness, { value: "complete", label: "Complete in box", short: "CIB" });
  assert.deepEqual(item.condition, { label: "Very good", rank: 2 });
  assert.equal(item.details, "SNES · PAL · Platinum · Copy 2 of 3");
  assert.equal(item.note, null);
  assert.equal(item.favorite, false);
});

test("nothing missing is filled in", () => {
  const item = copyItem(entry("b", { release: release("r2", { region: "unknown", regionLabel: "UNKNOWN", format: "rom-cartridge" }) }), { labels: LABELS });
  assert.equal(item.region, null, "an unknown region is not recorded");
  assert.equal(item.media, null, "and so the shell isn't decided");
  assert.equal(item.completeness, null);
  assert.equal(item.condition, null);
  assert.equal(item.acquired, null);
  assert.equal(item.year, null);
});

test("an unidentified copy is placed by its claim and says it isn't linked to a release", () => {
  const claim = {
    platform: { slug: "playstation", name: "PlayStation", short_name: "PS1" },
    region: null,
    edition_kind: null,
    edition_name: "Platinum",
    catalog_pairing: true,
  };
  const copy = entry("c", { status: "unidentified", identity: "claim", release: null, claim, copies_of_release: 0 });
  assert.equal(copyPlatform(copy).slug, "playstation");
  const item = copyItem(copy, { labels: LABELS });
  assert.equal(item.media?.kind, "ps1-case");
  assert.equal(item.region, null);
  assert.equal(item.details, "PS1 · Region not sure · Platinum");
  assert.equal(item.note, "Not linked to a release");
});

test("a preserved copy uses the title its owner recorded, and never invents one", () => {
  const preserved = entry("d", { status: "invalid", game: null, release: null });
  assert.equal(copyItem(preserved, { labels: LABELS, preservedTitle: "Kept Game" }).title, "Kept Game");
  assert.equal(copyItem(preserved, { labels: LABELS }).title, "Title not available");
  assert.equal(copyItem(preserved, { labels: LABELS }).note, "No longer in the catalog");
});

test("copies of the same game share their placeholder label", () => {
  const one = copyItem(entry("e", { game: { id: "same", slug: "s", title: "Same" } }), { labels: LABELS });
  const two = copyItem(entry("f", { game: { id: "same", slug: "s", title: "Same" } }), { labels: LABELS });
  assert.equal(one.labelSeed, two.labelSeed);
  assert.notEqual(one.key, two.key);
});

test("filters offer only what the shelf has, with 'Not recorded' for gaps, and match it", () => {
  const shelf = [
    copyItem(entry("g", { completeness: "sealed" }), { labels: LABELS }),
    copyItem(entry("h", { completeness: "loose", release: release("r3", { region: "ntsc-uc", regionLabel: "NTSC-U/C", format: "snes-game-pak-na" }) }), { labels: LABELS }),
    copyItem(entry("i", { release: release("r4", { region: "unknown", regionLabel: "UNKNOWN" }) }), { labels: LABELS }),
  ];
  const options = filterOptions(shelf);
  assert.deepEqual(options.completeness.map((o) => o.label), ["Sealed", "Loose", "Not recorded"]);
  assert.deepEqual(options.regions.map((o) => o.label), ["NTSC-U/C", "PAL", "Not recorded"]);
  assert.deepEqual(browseShelf(shelf, "title", { ...DEFAULT_FILTERS, completeness: NOT_RECORDED }).map((i) => i.key), ["i"]);
  assert.deepEqual(browseShelf(shelf, "title", { ...DEFAULT_FILTERS, region: NOT_RECORDED }).map((i) => i.key), ["i"]);
});

test("sorting real copies puts unknown values last", () => {
  const shelf = [
    copyItem(entry("j", { acquired_on: null, added_at: "2026-11-03T00:00:00Z" }), { labels: LABELS }),
    copyItem(entry("k", { acquired_on: "2020-01-01", added_at: "2026-11-01T00:00:00Z", conditions: conditions("fair") }), { labels: LABELS }),
    copyItem(entry("l", { acquired_on: "2024-05-05", added_at: "2026-11-02T00:00:00Z", conditions: conditions("mint") }), { labels: LABELS }),
  ];
  assert.deepEqual(browseShelf(shelf, "acquired", DEFAULT_FILTERS).map((i) => i.key), ["l", "k", "j"]);
  assert.deepEqual(browseShelf(shelf, "added", DEFAULT_FILTERS).map((i) => i.key), ["j", "l", "k"]);
  assert.deepEqual(browseShelf(shelf, "condition", DEFAULT_FILTERS).map((i) => i.key), ["l", "k", "j"]);
});
