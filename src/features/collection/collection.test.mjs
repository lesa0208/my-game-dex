// Run with: npm run collection:test. The add form's pure rules: copy ids, and the
// details it sends. scripts/app-collection-checks.mjs tests the running app.
import assert from "node:assert/strict";
import { test } from "node:test";

import { addErrorMessage, componentField, latestAcquisitionDate, readCopyDetails } from "./details.ts";
import { keepingIdOnFailure, UNCONFIRMED } from "./retry.ts";
import { UUID_V7, uuidv7 } from "./uuid.ts";

test("copy ids are UUIDv7s carrying the time they were made", () => {
  const at = Date.parse("2026-11-11T12:34:56.789Z");
  const id = uuidv7(at);
  assert.match(id, UUID_V7);
  assert.equal(parseInt(id.slice(0, 8) + id.slice(9, 13), 16), at);
});

test("every copy id is new", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
  assert.equal(ids.size, 1000);
});

const form = (values) => (name) => values[name] ?? "";
const pieces = [
  { kind: "insert", label: "Poster" },
  { kind: "map", label: "World map" },
];
const today = "2026-11-12";

test("an empty form adds a copy with nothing recorded", () => {
  assert.deepEqual(readCopyDetails(form({}), pieces, today), { details: {} });
});

test("completeness is sent only when chosen", () => {
  assert.deepEqual(readCopyDetails(form({ completeness: "complete", box_condition: "good" }), [], today), {
    details: { completeness: "complete", box_condition: "good" },
  });
  assert.ok("error" in readCopyDetails(form({ completeness: "boxed" }), [], today));
});

test("the physical-copy rules match the database", () => {
  for (const values of [
    { completeness: "loose", box_condition: "good" },
    { completeness: "loose", manual_condition: "fair" },
    { completeness: "complete", box_condition: "not_included" },
    { completeness: "sealed", media_condition: "mint" },
    { media_condition: "not_included" },
    { overall_condition: "not_included" },
  ]) {
    assert.ok("error" in readCopyDetails(form(values), [], today), JSON.stringify(values));
  }
  assert.deepEqual(readCopyDetails(form({ completeness: "loose", box_condition: "not_included", media_condition: "good" }), [], today), {
    details: { completeness: "loose", box_condition: "not_included", media_condition: "good" },
  });
});

test("private details are checked and normalized", () => {
  assert.ok("error" in readCopyDetails(form({ purchase_price: "10" }), [], today), "a price needs a currency");
  assert.deepEqual(readCopyDetails(form({ currency: "EUR" }), [], today), { details: {} }, "a preselected currency alone records nothing");
  assert.ok("error" in readCopyDetails(form({ purchase_price: "10.12345", currency: "EUR" }), [], today));
  assert.ok("error" in readCopyDetails(form({ purchase_price: "-1", currency: "EUR" }), [], today));
  assert.ok("error" in readCopyDetails(form({ acquired_on: "2026-11-13" }), [], today), "no future dates");
  assert.ok("error" in readCopyDetails(form({ acquired_on: "1969-12-31" }), [], today));
  assert.ok("error" in readCopyDetails(form({ notes: "n".repeat(5001) }), [], today));
  assert.ok("error" in readCopyDetails(form({ storage_location: "s".repeat(121) }), [], today));
  assert.deepEqual(
    readCopyDetails(form({ purchase_price: "24,5", currency: "eur", acquired_on: "2020-01-02", notes: "  From a fair\r\n", storage_location: "  Shelf A " }), [], today),
    { details: { acquired_on: "2020-01-02", purchase_price: "24.5", currency: "EUR", notes: "  From a fair\n", storage_location: "Shelf A" } },
  );
  assert.deepEqual(readCopyDetails(form({ currency: "EUR", notes: "   " }), [], today), { details: {} }, "a currency alone or blank notes record nothing");
});

test("only the release's listed pieces are recorded", () => {
  const result = readCopyDetails(form({ [componentField(0)]: "included", [componentField(1)]: "missing", [componentField(2)]: "included" }), pieces, today);
  assert.deepEqual(result, {
    details: {
      components: [
        { kind: "insert", label: "Poster", condition: null },
        { kind: "map", label: "World map", condition: "not_included" },
      ],
    },
  });
});

test("the latest acquisition date allows a day for time zones", () => {
  assert.equal(latestAcquisitionDate(Date.parse("2026-11-11T23:30:00Z")), "2026-11-12");
});

test("database errors become fixed messages, and only stale ids are replaced", () => {
  assert.equal(addErrorMessage("request conflict").renewId, true);
  assert.equal(addErrorMessage("invalid item id").renewId, true);
  assert.equal(addErrorMessage("release unavailable").renewId, false);
  assert.equal(addErrorMessage("account not active").text, "Your account can't add copies right now.");
  assert.equal(addErrorMessage('relation "collection_items" violates something').text, "The copy couldn't be added. Try again.");
});

test("refusals give the reason the form shows", () => {
  const reason = (values) => readCopyDetails(form(values), [], today).error;
  assert.match(reason({ completeness: "loose", box_condition: "good" }), /^A loose copy is the cartridge or disc only/);
  assert.equal(reason({ purchase_price: "10" }), "Choose the currency you paid in.");
  assert.match(reason({ acquired_on: "2999-01-01" }), /can't be in the future/);
  assert.equal(addErrorMessage("release unavailable").text, "This release can't be added to a collection.");
  assert.match(addErrorMessage("invalid item id").text, /^This page was open too long\./);
});

test("a request that fails on the way keeps the id, so a retry adds nothing new", async () => {
  const state = { status: "added", message: "Added to your collection.", itemId: uuidv7(), count: 1 };
  const lost = keepingIdOnFailure(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual(await lost(state, new FormData()), { ...state, status: "error", message: UNCONFIRMED });

  const answered = { status: "already_added", message: "This copy was already added.", itemId: uuidv7(), count: 1 };
  assert.equal(await keepingIdOnFailure(async () => answered)(state, new FormData()), answered);
});
