import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { imageCaption, imageFor, imageProblems } from "./game-images.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const base = {
  game: "chrono-trigger",
  platform: "snes",
  region: "ntsc-uc",
  release: null,
  kind: "cartridge",
  width: 1200,
  height: 760,
  alt: "Chrono Trigger cartridge for the Super Nintendo, North American release",
  source: { name: "Owner's photograph", url: null },
  license: "user_contributed",
  licenseDetail: "Photographed by its owner, who agreed to its use",
  attribution: null,
  approvedBy: "Editor",
  approvedOn: "2026-11-26",
};
const image = (id, extra = {}) => ({ ...base, id, file: `game-images/chrono-trigger/${id}.webp`, ...extra });

test("the registry lists only valid, approved images, and every file is there", () => {
  const registry = JSON.parse(readFileSync(join(root, "src", "assets", "game-images", "registry.json"), "utf8"));
  assert.ok(Array.isArray(registry.images));
  const ids = new Set();
  for (const entry of registry.images) {
    assert.deepEqual(imageProblems(entry), [], `${entry.id}: ${imageProblems(entry).join(", ")}`);
    assert.ok(existsSync(join(root, "public", entry.file)), `${entry.id}: missing ${entry.file}`);
    assert.ok(!ids.has(entry.id), `${entry.id} twice`);
    ids.add(entry.id);
  }
});

test("an image without its source, licence or approval is never listed", () => {
  assert.deepEqual(imageProblems(image("ok")), []);
  assert.ok(imageProblems(image("a", { license: "fair_use" })).includes("license"));
  assert.ok(imageProblems(image("b", { licenseDetail: " " })).includes("license detail"));
  assert.ok(imageProblems(image("c", { source: { name: "", url: null } })).includes("source"));
  assert.ok(imageProblems(image("d", { source: { name: "Site", url: "http://example.test/x.jpg" } })).includes("source url"));
  assert.ok(imageProblems(image("e", { approvedBy: "" })).includes("approved by"));
  assert.ok(imageProblems(image("f", { file: "https://example.test/hotlink.jpg" })).includes("file"));
  // And an invalid one isn't chosen even if it matches.
  assert.equal(imageFor([image("g", { license: "unknown" })], { game: "chrono-trigger", platform: "snes", region: "ntsc-uc", release: null }), null);
});

test("the exact release first, then platform and region, then any region on that platform", () => {
  const release = "0190a0a0-0000-7000-8000-000000000001";
  const images = [image("na"), image("pal", { region: "pal" }), image("any", { region: null }), image("rel", { release })];
  const q = (platform, region, rel = null) => imageFor(images, { game: "chrono-trigger", platform, region, release: rel })?.id ?? null;
  assert.equal(q("snes", "ntsc-uc", release), "rel");
  assert.equal(q("snes", "ntsc-uc"), "na");
  assert.equal(q("snes", "pal"), "pal");
  assert.equal(q("snes", "ntsc-j"), "any");
  assert.equal(q("snes", null), "any");
});

test("never another platform's image, nor another region's when the region is known", () => {
  const images = [image("na")];
  assert.equal(imageFor(images, { game: "chrono-trigger", platform: "playstation", region: null, release: null }), null);
  assert.equal(imageFor(images, { game: "chrono-trigger", platform: "snes", region: "pal", release: null }), null);
  assert.equal(imageFor(images, { game: "another-game", platform: "snes", region: null, release: null }), null);
});

test("with no platform chosen, only a game imaged on a single platform shows one", () => {
  assert.equal(imageFor([image("na")], { game: "chrono-trigger", platform: null, region: null, release: null })?.id, "na");
  assert.equal(imageFor([image("na"), image("ps", { platform: "playstation", region: null })], { game: "chrono-trigger", platform: null, region: null, release: null }), null);
});

test("the caption never claims to be the collector's copy", () => {
  assert.equal(imageCaption(image("na"), "NTSC-U/C"), "An example cartridge (NTSC-U/C), not necessarily your copy.");
  assert.equal(imageCaption(image("r", { release: "0190a0a0-0000-7000-8000-000000000001" }), null), "This release, not necessarily your copy.");
});
