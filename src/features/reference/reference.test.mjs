// Run with: npm run imports:test. The reference pages' filters and labels (M10d), and
// that their lists match the database's types.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  PLATFORM_KIND_OPTIONS,
  filterPlatforms,
  matchesQuery,
  mediaCategoryLabel,
  platformFamilies,
  platformKindLabel,
  readPlatformKind,
  readQuery,
  requirementKindLabel,
} from "./form.ts";

const migrations = new URL("../../../supabase/migrations/", import.meta.url);
const sql = readdirSync(migrations)
  .sort()
  .map((f) => readFileSync(new URL(f, migrations), "utf8"))
  .join("\n");
const enumValues = (name) => {
  const type = new RegExp(`create type public\\.${name} as enum \\(([^)]+)\\)`).exec(sql);
  assert.ok(type, name);
  const added = [...sql.matchAll(new RegExp(`alter type public\\.${name} add value '([a-z_]+)'`, "g"))].map((m) => m[1]);
  return [...[...type[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), ...added].sort();
};

test("every platform kind, media category and requirement kind has a label", () => {
  assert.deepEqual(PLATFORM_KIND_OPTIONS.map((k) => k.value).sort(), enumValues("platform_kind"));
  for (const v of enumValues("media_category")) assert.notEqual(mediaCategoryLabel(v), v, v);
  for (const v of enumValues("hardware_requirement_kind")) assert.notEqual(requirementKindLabel(v), v, v);
  assert.equal(platformKindLabel("handheld"), "Handheld");
  assert.equal(platformKindLabel("unknown_kind"), "unknown_kind");
});

test("queries are trimmed, collapsed and bounded", () => {
  assert.equal(readQuery("  game   boy "), "game boy");
  assert.equal(readQuery("   "), null);
  assert.equal(readQuery(null), null);
  assert.equal(readQuery("x".repeat(80))?.length, 60);
  assert.equal(readPlatformKind("console"), "console");
  assert.equal(readPlatformKind("spaceship"), null);
});

test("matching ignores case and accents", () => {
  assert.ok(matchesQuery("pokemon", "Pokémon Stadium"));
  assert.ok(matchesQuery("SEGA", null, "Sega"));
  assert.ok(!matchesQuery("atari", "Sega"));
  assert.ok(matchesQuery(null, "anything"));
});

test("platforms filter by kind, family and text, sorted by family then year", () => {
  const p = (slug, family, kind, year, manufacturer = null) => ({ id: slug, slug, name: slug.toUpperCase(), short_name: null, manufacturer, family, kind, base_platform_id: null, released_year: year, notes: null });
  const all = [p("snes", "Nintendo Home", "console", 1990, "Nintendo"), p("gb", "Game Boy", "handheld", 1989, "Nintendo"), p("nes", "Nintendo Home", "console", 1983, "Nintendo"), p("md", "Sega Home", "console", 1988, "Sega")];
  assert.deepEqual(filterPlatforms(all, { kind: null, family: null, query: null }).map((x) => x.slug), ["gb", "nes", "snes", "md"]);
  assert.deepEqual(filterPlatforms(all, { kind: "handheld", family: null, query: null }).map((x) => x.slug), ["gb"]);
  assert.deepEqual(filterPlatforms(all, { kind: null, family: "Nintendo Home", query: null }).map((x) => x.slug), ["nes", "snes"]);
  assert.deepEqual(filterPlatforms(all, { kind: null, family: null, query: "sega" }).map((x) => x.slug), ["md"]);
  assert.deepEqual(platformFamilies(all), ["Game Boy", "Nintendo Home", "Sega Home"]);
});
