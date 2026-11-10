// Run with: node --experimental-strip-types --test src/features/catalog/parse.test.mjs
// (npm run catalog:test). The parsers keep only known fields and refuse other shapes.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CatalogShapeError, parseReleasePicker, parseSearchResponse } from "./parse.ts";

const game = { id: "g1", slug: "starfall-odyssey", title: "Starfall Odyssey", kind: "game", first_release: { value: "1993", precision: "year" } };

test("a search response keeps only its known fields", () => {
  const parsed = parseSearchResponse({
    status: "ok",
    platforms: ["snes"],
    next_cursor: null,
    extra: "dropped",
    items: [
      {
        kind: "game",
        match: "prefix",
        matched: { title: "Hoshifuru Odyssey", source: "alias" },
        game: { ...game, verified_by: "editor", status: "published" },
        platforms: [{ slug: "snes", name: "Super Nintendo Entertainment System", short_name: "SNES", release_count: 4, submitted_by: "x" }],
      },
    ],
  });
  assert.deepEqual(Object.keys(parsed.items[0].game).sort(), ["firstRelease", "id", "kind", "slug", "title"]);
  assert.equal(JSON.stringify(parsed).includes("verified_by"), false);
  assert.equal(JSON.stringify(parsed).includes("submitted_by"), false);
  assert.equal(JSON.stringify(parsed).includes("dropped"), false);
});

test("a release result is parsed as a release", () => {
  const parsed = parseSearchResponse({
    status: "ok",
    platforms: [],
    next_cursor: "abc",
    items: [
      {
        kind: "release",
        match: "code",
        matched_identifier: "product_code",
        game,
        release: {
          id: "r1",
          platform: { slug: "snes", name: "SNES", short_name: "SNES" },
          region: { code: "ntsc-uc", label: "NTSC-U/C" },
          edition_name: "Standard",
          variant_name: null,
          identifiers: { product_code: "SNS-ZSFE-USA", barcode: null },
        },
      },
    ],
  });
  const item = parsed.items[0];
  assert.equal(item.kind, "release");
  assert.equal(item.release.identifiers.productCode, "SNS-ZSFE-USA");
  assert.equal(parsed.nextCursor, "abc");
});

test("an unexpected shape is refused, not guessed", () => {
  assert.throws(() => parseSearchResponse({ status: "ok", platforms: [], items: [{ kind: "game", match: "nearly", matched: null, game, platforms: [] }], next_cursor: null }), CatalogShapeError);
  assert.throws(() => parseSearchResponse({ status: "maybe", platforms: [], items: [], next_cursor: null }), CatalogShapeError);
  assert.throws(() => parseSearchResponse([]), CatalogShapeError);
  assert.throws(() => parseSearchResponse({ status: "ok", platforms: [], items: [{ kind: "release", game }], next_cursor: null }), CatalogShapeError);
});

test("no public game is null, and unknown release details stay null", () => {
  assert.equal(parseReleasePicker(null), null);
  const picker = parseReleasePicker({
    game: { ...game, aliases: [] },
    platforms: [{ slug: "snes", name: "SNES", short_name: "SNES", release_count: 1 }],
    regions: [{ code: "unknown", label: "UNKNOWN", release_count: 1 }],
    selection: { platform: "snes", region: null, release_id: null },
    releases: [
      {
        id: "r1",
        platform: { slug: "snes", name: "SNES", short_name: "SNES" },
        region: { code: "unknown", label: "UNKNOWN" },
        markets: [],
        edition: { name: "Standard", kind: "standard" },
        variant_name: null,
        local_title: null,
        publisher_name: null,
        format: { code: "rom-cartridge", name: "ROM cartridge", category: "cartridge" },
        media_count: 1,
        media_playability: null,
        packaging: null,
        identifiers: { product_code: null, barcode: null },
        languages: null,
        rating_labels: null,
        release_date: null,
        components: [],
        requirements: [],
        verified_by: "never shown",
      },
    ],
  });
  assert.ok(picker);
  const release = picker.releases[0];
  assert.equal(release.packaging, null);
  assert.equal(release.releaseDate, null);
  assert.equal(release.languages, null);
  assert.equal(release.identifiers.barcode, null);
  assert.equal("verified_by" in release, false);
});
