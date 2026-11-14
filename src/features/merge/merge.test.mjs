// Run with: npm run merge:test. The merge form's rules, the compared fields and how
// their values read, the blockers and the error messages. scripts/app-merge-checks.mjs
// tests the running app, and the database tests the rules again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { blockerText, fieldLabel, fieldValue, mergeErrorMessage, readFieldList, readMerge } from "./form.ts";

const reader = (values) => (name) => values[name] ?? "";

test("every field the database compares has a label", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20261115100200_m7b2c_merge.sql", import.meta.url), "utf8");
  const body = /create function private\.merge_fields[\s\S]*?\$\$;/.exec(sql)[0];
  const fields = [...body.matchAll(/^\s+'([a-z_]+)',/gm)].map((m) => m[1]).filter((f) => !["id", "title", "kind", "label", "quantity", "media_format_code", "code", "level"].includes(f));
  assert.ok(fields.length >= 20, `found ${fields.length} fields`);
  for (const field of fields) assert.notEqual(fieldLabel(field), field, `no label for ${field}`);
  assert.deepEqual(readFieldList(fields.join(",")), fields);
});

test("only known field names pass through the form", () => {
  assert.deepEqual(readFieldList("product_code, barcode,evil,__proto__,"), ["product_code", "barcode"]);
  assert.deepEqual(readFieldList(""), []);
});

test("a merge needs a staff reason, a short note and every difference acknowledged by name", () => {
  const needs = { fields: ["edition_name", "product_code"], copies: true };
  const full = { reason: "  Same   cartridge ", owner_note: " Moved ", ack_edition_name: "yes", ack_product_code: "yes", acknowledge_copies: "yes" };
  assert.deepEqual(readMerge(reader(full), needs), {
    value: { reason: "Same cartridge", ownerNote: "Moved", acknowledged: ["edition_name", "product_code"], acknowledgeCopies: true },
  });
  assert.match(readMerge(reader({ ...full, reason: " " }), needs).error, /reason/);
  assert.match(readMerge(reader({ ...full, reason: "x".repeat(501) }), needs).error, /500/);
  assert.match(readMerge(reader({ ...full, owner_note: "x".repeat(1001) }), needs).error, /1000/);
  assert.match(readMerge(reader({ ...full, ack_product_code: "" }), needs).error, /each difference/);
  assert.match(readMerge(reader({ ...full, acknowledge_copies: "" }), needs).error, /each difference/);
  assert.deepEqual(readMerge(reader({ reason: "Same" }), { fields: [], copies: false }), {
    value: { reason: "Same", ownerNote: null, acknowledged: [], acknowledgeCopies: false },
  });
});

test("compared values read as text", () => {
  assert.equal(fieldValue("product_code", null), "Not recorded");
  assert.equal(fieldValue("game", { id: "x", title: "Hidden Gem" }), "Hidden Gem");
  assert.equal(fieldValue("components", [{ kind: "insert", label: "Manual", quantity: 1 }, { kind: "insert", label: "Poster", quantity: 2 }]), "Manual, Poster ×2");
  assert.equal(fieldValue("components", []), "None listed");
  assert.equal(fieldValue("hardware", [{ code: "n64-expansion-pak", level: "required" }]), "n64-expansion-pak (required)");
  assert.equal(fieldValue("languages", ["en", "fr"]), "en, fr");
  assert.equal(fieldValue("region_unknown_confirmed", false), "No");
  assert.equal(fieldValue("media_count", 2), "2");
});

test("every blocker and database error has a fixed message", () => {
  for (const kind of ["platform", "media_format", "other_game", "submission_not_in_review", "preserved_copy", "active_exclusion"]) {
    assert.notEqual(blockerText(kind), blockerText("anything else"), kind);
  }
  const fallback = mergeErrorMessage("something internal");
  for (const message of ["not permitted", "own submission", "preview stale", "request conflict", "merge blocked", "acknowledgement required", "release unavailable", "target unavailable", "invalid merge"]) {
    assert.notEqual(mergeErrorMessage(message), fallback, message);
  }
  assert.equal(mergeErrorMessage(undefined), fallback);
});
