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

// Game Details 2.0, Phase 3: the Gallery's items.
test("the Gallery: an approved photo keeps its source, licence and credit; IGDB's screenshots go through the app's route", async () => {
  const { galleryItems, screenshotSize, viewerMaxWidth } = await import("./gallery.ts");
  const { LICENSE_LABELS } = await import("./game-images.ts");
  const photo = image("snes-ntsc-uc-cartridge", { source: { name: "Example Archive", url: "https://example.test/item" }, license: "licensed", licenseDetail: "CC BY 4.0", attribution: "Photo: A. Collector" });
  const items = galleryItems({
    title: "Chrono Trigger",
    photos: [photo],
    licenseLabels: LICENSE_LABELS,
    platformName: (s) => (s === "snes" ? "SNES" : null),
    regionName: (c) => (c === "ntsc-uc" ? "NTSC-U/C" : null),
    screenshots: [
      { imageId: "scabc", width: 256, height: 224 },
      { imageId: "scdef", width: 1920, height: 1080 },
      { imageId: "scghi", width: null, height: null },
    ],
    igdbUrl: "https://www.igdb.com/games/chrono-trigger",
  });
  assert.equal(items.length, 4);
  const [p, s1, s2, s3] = items;
  assert.deepEqual(
    { src: p.src, width: p.width, height: p.height, alt: p.alt, label: p.label, credit: p.credit },
    { src: "/game-images/chrono-trigger/snes-ntsc-uc-cartridge.webp", width: 1200, height: 760, alt: photo.alt, label: "SNES · NTSC-U/C · Cartridge", credit: { name: "Example Archive", url: "https://example.test/item", license: "Licensed · CC BY 4.0", attribution: "Photo: A. Collector" } },
  );
  // Never IGDB's own address, and never the cropped "screenshot_big".
  assert.equal(s1.src, "/media/igdb/720p/scabc.jpg");
  assert.equal(s2.src, "/media/igdb/1080p/scdef.jpg");
  assert.equal(s3.src, "/media/igdb/720p/scghi.jpg");
  assert.ok(items.every((i) => !/igdb\.com|screenshot_big/.test(i.src)));
  assert.deepEqual([s1.width, s1.height], [256, 224]);
  assert.equal(s1.alt, "Screenshot 1 of 3 from Chrono Trigger");
  assert.deepEqual(s1.credit, { name: "IGDB.com", url: "https://www.igdb.com/games/chrono-trigger", license: null, attribution: null });
  assert.equal(screenshotSize({ imageId: "x", width: 1280, height: 720 }), "720p");
  // The viewer: a small original up to three times its size, a large one at its own, never past 1280.
  assert.equal(viewerMaxWidth(256), 768);
  assert.equal(viewerMaxWidth(512), 1024);
  assert.equal(viewerMaxWidth(1000), 1000);
  assert.equal(viewerMaxWidth(1595), 1280);
  assert.equal(viewerMaxWidth(null), 1280);
});

test("the Gallery: no sources, no items; nothing filled in", async () => {
  const { galleryItems } = await import("./gallery.ts");
  const { LICENSE_LABELS } = await import("./game-images.ts");
  assert.deepEqual(galleryItems({ title: "Tetris", photos: [], licenseLabels: LICENSE_LABELS, platformName: () => null, regionName: () => null, screenshots: [], igdbUrl: null }), []);
});
