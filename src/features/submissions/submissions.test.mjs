// Run with: npm run submissions:test. The submission forms' pure rules and messages.
// scripts/app-submission-checks.mjs tests the running app.
import assert from "node:assert/strict";
import { test } from "node:test";

import { readSubmission, readSubmissionChanges, statusLabel, submissionErrorMessage } from "./form.ts";

const form = (values) => (name) => values[name] ?? "";
const base = { platform: "snes", media_format: "rom-cartridge", region: "pal", physical: "on" };

test("a release needs a platform, a physical format and a region, and confirmation", () => {
  assert.deepEqual(readSubmission(form(base), "release", 2026), {
    value: { title: null, gameKind: "game", firstReleaseYear: null, platform: "snes", mediaFormat: "rom-cartridge", region: "pal", details: {}, components: [], note: null },
  });
  for (const missing of ["platform", "media_format", "region", "physical"]) {
    assert.ok("error" in readSubmission(form({ ...base, [missing]: "" }), "release", 2026), missing);
  }
  assert.equal(readSubmission(form({ ...base, physical: "" }), "release", 2026).error, "Confirm that this is a physical game release.");
});

test("an unknown region is allowed, and nothing is filled in", () => {
  const result = readSubmission(form({ ...base, region: "unknown" }), "release", 2026);
  assert.equal(result.value.region, "unknown");
  assert.deepEqual(result.value.details, {});
});

test("a new game needs a title; its kind defaults to game and its year stays unknown", () => {
  assert.equal(readSubmission(form(base), "game", 2026).error, "Enter the game's title.");
  const result = readSubmission(form({ ...base, title: "  Moon Anthology " }), "game", 2026);
  assert.deepEqual([result.value.title, result.value.gameKind, result.value.firstReleaseYear], ["Moon Anthology", "game", null]);
  assert.equal(readSubmission(form({ ...base, title: "X", game_kind: "compilation", first_release_year: "1997" }), "game", 2026).value.gameKind, "compilation");
  assert.ok("error" in readSubmission(form({ ...base, title: "X", game_kind: "dlc" }), "game", 2026));
  assert.ok("error" in readSubmission(form({ ...base, title: "X", first_release_year: "1949" }), "game", 2026));
  assert.ok("error" in readSubmission(form({ ...base, title: "X", first_release_year: "2028" }), "game", 2026));
  assert.equal(readSubmission(form({ ...base, title: "X", first_release_year: "2027" }), "game", 2026).value.firstReleaseYear, 2027);
});

test("optional details are checked, and a year is stored as a year", () => {
  const result = readSubmission(form({ ...base, edition_name: " Limited ", edition_kind: "limited", barcode: "0451 2345 0001 7", media_count: "3", release_year: "1994" }), "release", 2026);
  assert.deepEqual(result.value.details, { edition_name: "Limited", edition_kind: "limited", barcode: "0451234500017", media_count: 3, release_date: "1994-01-01", release_date_precision: "year" });
  assert.equal(readSubmission(form({ ...base, barcode: "12AB" }), "release", 2026).error, "A barcode is 8 to 14 digits.");
  assert.ok("error" in readSubmission(form({ ...base, media_count: "31" }), "release", 2026));
  assert.ok("error" in readSubmission(form({ ...base, edition_kind: "deluxe" }), "release", 2026));
  assert.ok("error" in readSubmission(form({ ...base, product_code: "x".repeat(41) }), "release", 2026));
});

test("pieces come from the filled-in rows, once each", () => {
  const result = readSubmission(form({ ...base, piece_label_0: "Poster", piece_label_2: "World map", piece_kind_2: "map", piece_quantity_2: "2" }), "release", 2026);
  assert.deepEqual(result.value.components, [{ kind: "insert", label: "Poster", quantity: 1 }, { kind: "map", label: "World map", quantity: 2 }]);
  assert.ok("error" in readSubmission(form({ ...base, piece_label_0: "Poster", piece_label_1: "Poster" }), "release", 2026));
  assert.ok("error" in readSubmission(form({ ...base, piece_label_0: "Disc 2", piece_kind_0: "game_media" }), "release", 2026));
  assert.ok("error" in readSubmission(form({ ...base, piece_label_0: "Poster", piece_quantity_0: "0" }), "release", 2026));
});

test("a note is at most 1,000 characters", () => {
  assert.equal(readSubmission(form({ ...base, note: "  Seen at a fair " }), "release", 2026).value.note, "Seen at a fair");
  assert.ok("error" in readSubmission(form({ ...base, note: "n".repeat(1001) }), "release", 2026));
});

test("edits send every field, so emptied ones are cleared, and no platform", () => {
  const result = readSubmissionChanges(form({ media_format: "rom-cartridge", region: "pal" }), false, 2026);
  assert.deepEqual(result.value, { media_format: "rom-cartridge", region: "pal", details: {}, components: [], note: "" });
  assert.equal("platform" in result.value, false);
  const game = readSubmissionChanges(form({ title: "Renamed", media_format: "rom-cartridge", region: "pal" }), true, 2026);
  assert.deepEqual([game.value.title, game.value.game_kind, game.value.first_release_year], ["Renamed", "game", null]);
});

test("statuses and errors read as fixed messages", () => {
  assert.equal(statusLabel("submitted"), "Awaiting review");
  assert.equal(statusLabel("rejected"), "Not approved");
  assert.equal(statusLabel("whatever"), "No longer available");
  assert.equal(submissionErrorMessage("submission limit reached"), "You've reached today's limit of 10 submissions. Try again later.");
  assert.equal(submissionErrorMessage("game unavailable").startsWith("That game isn't available"), true);
  assert.equal(submissionErrorMessage('duplicate key value violates "releases_pkey"'), "The submission couldn't be saved. Try again.");
});
