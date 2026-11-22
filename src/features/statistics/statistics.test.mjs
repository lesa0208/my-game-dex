// M13 collection statistics: the counting rules (compute.ts), offline.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { computeStatistics, NOT_IN_CATALOG, NOT_RECORDED, percent, standingOf } from "./compute.ts";

let n = 0;
const release = (game, platform, region, format = "snes-game-pak-na", status = "published") => ({ id: `r-${game}-${platform}-${region}-${format}-${status}`, game_id: game, platform_id: platform, region_code: region, media_format_code: format, status });
const copy = (r, extra = {}) => ({
  id: `c${String(++n).padStart(4, "0")}`,
  release_id: r?.id ?? null,
  claimed_game_id: null,
  claimed_platform_id: null,
  claimed_region_code: null,
  completeness: null,
  record_status: "active",
  release: r ? { game_id: r.game_id, platform_id: r.platform_id, region_code: r.region_code, media_format_code: r.media_format_code, status: r.status } : null,
  ...extra,
});
const claim = (game, platform, region = null, extra = {}) => copy(null, { claimed_game_id: game, claimed_platform_id: platform, claimed_region_code: region, ...extra });
const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x.copies]));

test("an empty collection counts nothing, and every share is 0%", () => {
  const s = computeStatistics([]);
  assert.deepEqual([s.copies, s.games, s.systems, s.copiesWithoutGame, s.copiesWithoutSystem], [0, 0, 0, 0, 0]);
  assert.deepEqual(s.systemsBreakdown, []);
  assert.deepEqual(byKey(s.completeness), { sealed: 0, complete: 0, incomplete: 0, loose: 0, not_recorded: 0 });
  assert.deepEqual(s.regions, []);
  assert.deepEqual(s.several, { games: 0, extraCopies: 0, releases: 0, top: [] });
  assert.equal(percent(0, 0), "0%");
});

test("one system: copies, distinct games and completeness", () => {
  const a = release("g1", "snes", "pal");
  const b = release("g2", "snes", "ntsc-uc");
  const s = computeStatistics([copy(a, { completeness: "complete" }), copy(b, { completeness: "loose" }), copy(b)]);
  assert.equal(s.copies, 3);
  assert.equal(s.games, 2);
  assert.equal(s.systems, 1);
  assert.deepEqual(s.systemsBreakdown.map((x) => [x.platformId, x.copies, x.games]), [["snes", 3, 2]]);
  assert.deepEqual(byKey(s.completeness), { sealed: 0, complete: 1, incomplete: 0, loose: 1, not_recorded: 1 });
});

test("several copies of one release are one game, several copies and one release with several", () => {
  const a = release("g1", "snes", "pal");
  const s = computeStatistics([copy(a, { completeness: "sealed" }), copy(a, { completeness: "complete" }), copy(a)]);
  assert.equal(s.copies, 3);
  assert.equal(s.games, 1);
  assert.deepEqual(s.several, { games: 1, extraCopies: 2, releases: 1, top: [{ gameId: "g1", copies: 3, releases: 1, systems: 1 }] });
});

test("one game on two systems: one game overall, one on each system; different releases aren't one release", () => {
  const snes = release("g1", "snes", "pal");
  const ps = release("g1", "playstation", "pal", "cd-rom");
  const other = release("g2", "playstation", "ntsc-j", "cd-rom");
  const s = computeStatistics([copy(snes), copy(ps), copy(ps), copy(other)]);
  assert.equal(s.games, 2);
  assert.equal(s.systems, 2);
  const rows = Object.fromEntries(s.systemsBreakdown.map((x) => [x.platformId, [x.copies, x.games]]));
  assert.deepEqual(rows, { playstation: [3, 2], snes: [1, 1] });
  assert.equal(s.systemsBreakdown.reduce((sum, x) => sum + x.games, 0), 3, "the systems' game counts add up to more than the total");
  assert.equal(s.systemsBreakdown[0].platformId, "playstation", "most copies first");
  assert.deepEqual(s.several.top, [{ gameId: "g1", copies: 3, releases: 2, systems: 2 }]);
  assert.equal(s.several.releases, 1);
  assert.deepEqual(byKey(s.formats), { "cd-rom": 3, "snes-game-pak-na": 1 });
});

test("mixed completeness: every level and 'not recorded' over all copies, per system too", () => {
  const a = release("g1", "snes", "pal");
  const b = release("g2", "nes", "pal", "nes-game-pak");
  const levels = ["sealed", "complete", "complete", "incomplete", "loose", null, null, "unexpected"];
  const s = computeStatistics([...levels.map((l) => copy(a, { completeness: l })), copy(b, { completeness: "sealed" })]);
  assert.deepEqual(byKey(s.completeness), { sealed: 2, complete: 2, incomplete: 1, loose: 1, not_recorded: 3 });
  assert.equal(s.completeness.reduce((sum, x) => sum + x.copies, 0), s.copies, "nothing is left out of the denominator");
  const snes = s.systemsBreakdown.find((x) => x.platformId === "snes");
  assert.deepEqual(byKey(snes.completeness), { sealed: 1, complete: 2, incomplete: 1, loose: 1, not_recorded: 3 });
  assert.deepEqual(s.completeness.map((x) => x.key), ["sealed", "complete", "incomplete", "loose", NOT_RECORDED]);
});

test("an unidentified copy counts under its claimed game, system and region, with no format", () => {
  const a = release("g1", "snes", "pal");
  const s = computeStatistics([copy(a), claim("g1", "snes", "ntsc-j"), claim("g3", "mega-drive"), claim("g4", null)]);
  assert.equal(s.games, 3);
  assert.equal(s.systems, 2);
  assert.equal(s.copiesWithoutSystem, 1);
  assert.deepEqual(byKey(s.regions), { pal: 1, "ntsc-j": 1, [NOT_RECORDED]: 2 });
  assert.deepEqual(byKey(s.formats), { "snes-game-pak-na": 1, [NOT_RECORDED]: 3 });
  assert.equal(s.standing.unidentified, 3);
  assert.deepEqual(s.several.top, [{ gameId: "g1", copies: 2, releases: 1, systems: 1 }]);
});

test("a copy whose release left the catalog is a copy with no game, system, region or format", () => {
  const a = release("g1", "snes", "pal");
  const gone = { ...copy(null), release_id: "r-gone", record_status: "invalid_preserved" };
  const unreadable = { ...copy(null), release_id: "r-hidden" };
  const s = computeStatistics([copy(a), gone, unreadable]);
  assert.equal(s.copies, 3);
  assert.equal(s.games, 1);
  assert.equal(s.copiesWithoutGame, 2);
  assert.equal(s.copiesWithoutSystem, 2);
  assert.deepEqual(byKey(s.regions), { pal: 1, [NOT_IN_CATALOG]: 2 });
  assert.deepEqual(byKey(s.formats), { "snes-game-pak-na": 1, [NOT_IN_CATALOG]: 2 });
  assert.equal(s.standing.invalid, 2);
});

test("a missing region or format on a release is 'not recorded', and the unknown buckets sort last", () => {
  const a = release("g1", "snes", null, null);
  const b = release("g2", "snes", "unknown");
  const c = release("g3", "snes", "pal");
  const s = computeStatistics([copy(a), copy(b), copy(c), copy(c)]);
  assert.deepEqual(s.regions.map((x) => [x.key, x.copies]), [["pal", 2], ["unknown", 1], [NOT_RECORDED, 1]]);
  assert.deepEqual(s.formats.map((x) => x.key), ["snes-game-pak-na", NOT_RECORDED]);
});

test("standing follows the collection summary's rules", () => {
  assert.equal(standingOf(copy(release("g", "p", "pal"))), "owned");
  assert.equal(standingOf(copy(release("g", "p", "pal", "f", "under_review"))), "pending");
  assert.equal(standingOf(copy(release("g", "p", "pal", "f", "rejected"))), "not_approved");
  assert.equal(standingOf(claim("g", "p")), "unidentified");
  assert.equal(standingOf({ ...copy(release("g", "p", "pal")), record_status: "invalid_preserved" }), "invalid");
  assert.equal(standingOf({ ...copy(null), release_id: "r-hidden" }), "invalid");
});

test("the five games with the most copies, most first, ties in a fixed order", () => {
  const copies = [];
  for (const [game, count] of [["g1", 2], ["g2", 5], ["g3", 3], ["g4", 3], ["g5", 2], ["g6", 4], ["g7", 1]]) {
    const r = release(game, "snes", "pal");
    for (let i = 0; i < count; i += 1) copies.push(copy(r));
  }
  const s = computeStatistics(copies);
  assert.deepEqual(s.several.top.map((g) => g.gameId), ["g2", "g6", "g3", "g4", "g1"]);
  assert.equal(s.several.games, 6);
  assert.equal(s.several.extraCopies, 1 + 4 + 2 + 2 + 1 + 3);
});

test("shares: whole percentages that never say 0% or 100% unless exact", () => {
  assert.equal(percent(1, 4), "25%");
  assert.equal(percent(1, 300), "<1%");
  assert.equal(percent(299, 300), ">99%");
  assert.equal(percent(3, 3), "100%");
  assert.equal(percent(0, 3), "0%");
  assert.equal(percent(2, 3), "67%");
});

test("the statistics read names the owner, pages by id and never reads private details", () => {
  // The code, without its comments (which say what is never read).
  const src = readFileSync(join(import.meta.dirname, "queries.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /^import "server-only";/);
  assert.match(src, /from\("collection_items"\)\.select\(COPY_COLUMNS\)\.eq\("owner_id", me\)\.order\("id"\)\.limit\(size\)/);
  assert.match(src, /query\.gt\("id", after\)/);
  assert.doesNotMatch(src, /collection_item_private|purchase_price|acquired_on|storage_location|notes|SECRET_KEY|service_role|createClient\(/);
  const columns = /const COPY_COLUMNS =\s*"([^"]+)"/.exec(src)[1];
  assert.doesNotMatch(columns, /price|acquired|notes|storage|visibility|owner_id/);
});
