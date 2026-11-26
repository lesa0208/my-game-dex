import assert from "node:assert/strict";
import { test } from "node:test";

import { latestOnly, SUGGEST_LIMIT, suggestQuery, toSuggestions } from "./suggest.ts";

const game = (id, title, extra = {}) => ({
  kind: "game",
  match: "prefix",
  matched: null,
  game: { id, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, kind: "game", firstRelease: { value: "1990-11-21", precision: "day" } },
  platforms: [
    { slug: "snes", name: "Super Nintendo Entertainment System", shortName: "SNES", releaseCount: 0 },
    { slug: "game-boy-advance", name: "Game Boy Advance", shortName: "GBA", releaseCount: 0 },
  ],
  ...extra,
});

test("a query needs two characters, and is trimmed and cut", () => {
  assert.equal(suggestQuery(" m "), null);
  assert.equal(suggestQuery("ma"), "ma");
  assert.equal(suggestQuery("  super   mario "), "super mario");
  assert.equal(suggestQuery("x".repeat(150)).length, 100);
  assert.equal(suggestQuery("ゼル"), "ゼル");
});

test("results become suggestions in the search's own order, with year and platforms", () => {
  const out = toSuggestions([game("1", "Super Mario World"), game("2", "Super Mario Kart", { matched: { title: "Mario Kart", source: "alias" } })]);
  assert.deepEqual(
    out.map((s) => [s.title, s.year, s.platforms.join(","), s.note, s.href]),
    [
      ["Super Mario World", "1990", "SNES,GBA", null, "/games/super-mario-world"],
      ["Super Mario Kart", "1990", "SNES,GBA", "Also known as Mario Kart", "/games/super-mario-kart"],
    ],
  );
});

test("no year when the catalog records none; never more than the limit; no repeats", () => {
  const undated = game("9", "Tetris");
  undated.game.firstRelease = null;
  assert.equal(toSuggestions([undated])[0].year, null);
  const many = Array.from({ length: 20 }, (_, i) => game(String(i), `Game ${i}`));
  assert.equal(toSuggestions([...many, many[0]]).length, SUGGEST_LIMIT);
  assert.equal(toSuggestions([many[0], many[0]]).length, 1);
});

test("a product code match opens that release", () => {
  const [s] = toSuggestions([
    {
      kind: "release",
      match: "code",
      matchedIdentifier: "product_code",
      game: game("5", "Chrono Trigger").game,
      release: { id: "r1", platform: { slug: "snes", name: "SNES", shortName: "SNES" }, region: { code: "ntsc-uc", label: "NTSC-U/C" }, editionName: null, variantName: null, identifiers: { productCode: "SNS-ACTE-USA", barcode: null } },
    },
  ]);
  assert.equal(s.href, "/games/chrono-trigger?release=r1");
  assert.equal(s.note, "Product code SNS-ACTE-USA · NTSC-U/C");
});

test("within one strength, an own-title match comes before an alias match; stronger matches stay first", () => {
  const out = toSuggestions([
    game("1", "Super Mario Bros. 2", { matched: { title: "Mario 2", source: "alias" } }),
    game("2", "Mario Bros."),
    game("3", "Mario Golf"),
    game("4", "Super Mario World", { match: "words" }),
    game("5", "Mario", { match: "exact" }),
  ]);
  assert.deepEqual(
    out.map((s) => s.title),
    ["Mario", "Mario Bros.", "Mario Golf", "Super Mario Bros. 2", "Super Mario World"],
  );
});

test("only the newest request's answer counts", () => {
  const order = latestOnly();
  const first = order.next();
  const second = order.next();
  assert.equal(order.isLatest(first), false);
  assert.equal(order.isLatest(second), true);
});
