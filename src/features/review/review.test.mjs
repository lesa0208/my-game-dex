// Run with: npm run review:test. The review forms' pure rules and messages.
// scripts/app-review-checks.mjs tests the running app.
import assert from "node:assert/strict";
import { test } from "node:test";

import { EDITION_KINDS, GAME_KINDS, PIECE_KINDS } from "../submissions/form.ts";
import {
  EDITION_KIND_VALUES,
  GAME_KIND_VALUES,
  PIECE_KIND_VALUES,
  pieceRows,
  piecesEditable,
  queueFilter,
  readGameCorrections,
  readNote,
  readPieceCorrections,
  readReason,
  readReleaseCorrections,
  reviewErrorMessage,
  submitterLabel,
} from "./form.ts";

const form = (values) => (name) => values[name] ?? "";
const REGIONS = ["ntsc-j", "ntsc-uc", "pal", "unknown"];
const release = {
  edition_name: null,
  edition_kind: null,
  variant_name: null,
  product_code: "SNS-QZ",
  barcode: null,
  local_title: null,
  publisher_name: null,
  media_count: null,
  packaging: null,
  region_code: "pal",
  region_unknown_confirmed: false,
  release_date: "1994-01-01",
  release_date_precision: "year",
};
// What the correction form shows for that record, unchanged.
const asShown = { product_code: "SNS-QZ", region_code: "pal", release_year: "1994" };

test("the allowed values match the submission form's", () => {
  assert.deepEqual([...EDITION_KIND_VALUES], EDITION_KINDS.map((k) => k.value));
  assert.deepEqual([...GAME_KIND_VALUES], GAME_KINDS.map((k) => k.value));
  assert.deepEqual([...PIECE_KIND_VALUES], PIECE_KINDS.map((k) => k.value));
});

const listed = [{ kind: "insert", label: "Manual", quantity: 1 }, { kind: "map", label: "World map", quantity: 1 }];
const rows = (pieces) => Object.fromEntries(pieces.flatMap((p, i) => [[`piece_kind_${i}`, p.kind], [`piece_label_${i}`, p.label], [`piece_quantity_${i}`, String(p.quantity)]]));

test("an unchanged pieces form sends nothing, in any order", () => {
  assert.deepEqual(readPieceCorrections(form(rows(listed)), 6, listed), { value: null });
  assert.deepEqual(readPieceCorrections(form(rows([...listed].reverse())), 6, listed), { value: null });
});

test("pieces are added, changed and removed by clearing a name", () => {
  const changed = readPieceCorrections(form({ ...rows(listed), piece_label_1: "", piece_kind_2: "artwork", piece_label_2: " Poster ", piece_quantity_2: "" }), 6, listed);
  assert.deepEqual(changed.value, [{ kind: "insert", label: "Manual", quantity: 1 }, { kind: "artwork", label: "Poster", quantity: 1 }]);
  assert.deepEqual(readPieceCorrections(form({}), 6, listed).value, [], "clearing every name lists nothing");
});

test("pieces follow the submission form's rules", () => {
  assert.equal(readPieceCorrections(form({ piece_label_0: "x".repeat(121) }), 6, []).error, "A piece's name can be up to 120 characters.");
  assert.equal(readPieceCorrections(form({ piece_label_0: "Disc", piece_kind_0: "game_media" }), 6, []).error, "Choose a type for each piece from the list.");
  assert.equal(readPieceCorrections(form({ piece_label_0: "Manual", piece_quantity_0: "0" }), 6, []).error, "A piece's quantity is between 1 and 99.");
  assert.equal(readPieceCorrections(form({ piece_label_0: "Manual", piece_quantity_0: "1.5" }), 6, []).error, "A piece's quantity is between 1 and 99.");
  assert.equal(readPieceCorrections(form({ piece_label_0: "Manual", piece_label_1: "Manual" }), 6, []).error, "“Manual” is listed twice.");
});

test("rows beyond the limit are never read, and the form shows room to add", () => {
  assert.deepEqual(readPieceCorrections(form({ piece_label_30: "Extra" }), 99, []).value, null);
  assert.equal(pieceRows(0), 6);
  assert.equal(pieceRows(5), 8);
  assert.equal(pieceRows(29), 30);
});

test("a release listing a kind the form can't show isn't offered for editing", () => {
  assert.equal(piecesEditable(listed), true);
  assert.equal(piecesEditable([...listed, { kind: "game_media", label: "Disc 1", quantity: 1 }]), false);
});

test("a reason is always typed, never supplied", () => {
  assert.equal(readReason(form({})).error, "Give a reason for the record. Only editors see it.");
  assert.equal(readReason(form({ reason: "   " })).error, "Give a reason for the record. Only editors see it.");
  assert.equal(readReason(form({ reason: " Matches  the box " })).value, "Matches the box");
  assert.ok("error" in readReason(form({ reason: "x".repeat(501) })));
});

test("a note is required only when asking for changes", () => {
  assert.equal(readNote(form({}), false).value, null);
  assert.equal(readNote(form({}), true).error, "Tell the submitter what to change.");
  assert.ok("error" in readNote(form({ note: "x".repeat(2001) }), false));
});

test("an unchanged release form sends nothing", () => {
  assert.deepEqual(readReleaseCorrections(form(asShown), release, REGIONS, 2026), { value: {} });
});

test("only what changed is sent, and an emptied field is cleared", () => {
  const result = readReleaseCorrections(form({ ...asShown, edition_name: "Standard", edition_kind: "standard", media_count: "1", product_code: "" }), release, REGIONS, 2026);
  assert.deepEqual(result.value, { edition_name: "Standard", edition_kind: "standard", media_count: 1, product_code: null });
});

test("an unknown region is confirmed only when it's unknown", () => {
  const confirmed = readReleaseCorrections(form({ ...asShown, region_code: "unknown", region_unknown_confirmed: "on" }), release, REGIONS, 2026);
  assert.deepEqual(confirmed.value, { region_code: "unknown", region_unknown_confirmed: true });
  const ignored = readReleaseCorrections(form({ ...asShown, region_unknown_confirmed: "on" }), release, REGIONS, 2026);
  assert.deepEqual(ignored.value, {});
  assert.equal(readReleaseCorrections(form({ ...asShown, region_code: "mars" }), release, REGIONS, 2026).error, "Choose the region from the list.");
});

test("the release year changes the date only when the year does", () => {
  assert.deepEqual(readReleaseCorrections(form({ ...asShown, release_year: "1995" }), release, REGIONS, 2026).value, { release_date: "1995-01-01", release_date_precision: "year" });
  assert.deepEqual(readReleaseCorrections(form({ ...asShown, release_year: "" }), release, REGIONS, 2026).value, { release_date: null, release_date_precision: "unknown" });
  const precise = { ...release, release_date: "1994-03-18", release_date_precision: "day" };
  assert.deepEqual(readReleaseCorrections(form(asShown), precise, REGIONS, 2026).value, {}, "a more precise date is kept");
  assert.ok("error" in readReleaseCorrections(form({ ...asShown, release_year: "94" }), release, REGIONS, 2026));
});

test("release fields are checked like the submission form's", () => {
  assert.equal(readReleaseCorrections(form({ ...asShown, barcode: "12AB" }), release, REGIONS, 2026).error, "A barcode is 8 to 14 digits.");
  assert.ok("error" in readReleaseCorrections(form({ ...asShown, media_count: "0" }), release, REGIONS, 2026));
  assert.ok("error" in readReleaseCorrections(form({ ...asShown, edition_kind: "deluxe" }), release, REGIONS, 2026));
  assert.ok("error" in readReleaseCorrections(form({ ...asShown, edition_name: "x".repeat(121) }), release, REGIONS, 2026));
});

test("game corrections send only what changed", () => {
  const game = { title: "Moon Anthology", kind: "game", first_release_year: null };
  assert.deepEqual(readGameCorrections(form({ title: "Moon Anthology", kind: "game" }), game, 2026).value, {});
  assert.deepEqual(readGameCorrections(form({ title: "Moon Anthology II", kind: "compilation", first_release_year: "1996" }), game, 2026).value, {
    title: "Moon Anthology II",
    kind: "compilation",
    first_release_date: "1996-01-01",
    first_release_precision: "year",
  });
  assert.equal(readGameCorrections(form({ title: "", kind: "game" }), game, 2026).error, "Enter the game's title.");
});

test("the queue filter falls back to what needs review", () => {
  assert.equal(queueFilter("rejected"), "rejected");
  assert.equal(queueFilter("drop table"), "active");
  assert.equal(queueFilter(undefined), "active");
});

test("a submitter is a handle or a deleted account, never more", () => {
  assert.equal(submitterLabel({ deleted: true }), "A deleted account");
  assert.equal(submitterLabel({ deleted: false, handle: "kim", account_status: "active" }), "@kim");
  assert.equal(submitterLabel({ deleted: false, handle: "kim", account_status: "suspended" }), "@kim (suspended)");
});

test("database errors become fixed messages, and nothing else gets through", () => {
  assert.equal(reviewErrorMessage("own submission"), "You submitted this, so another editor has to review it.");
  assert.equal(reviewErrorMessage("request conflict"), reviewErrorMessage("record changed"));
  assert.equal(reviewErrorMessage('duplicate key value violates unique constraint "x"'), "The review couldn't be saved. Try again.");
});
