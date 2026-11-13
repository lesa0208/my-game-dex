// Run with: npm run exclusion:test. The exclusion forms' rules, the reason codes, the
// error messages and how a preserved copy's pieces are matched. scripts/app-exclusion-checks.mjs
// tests the running app, and the database tests the rules again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { EXCLUSION_REASONS, exclusionErrorMessage, exclusionReasonLabel, readExclusion, readRestoreReason, withListedPieces } from "./form.ts";

const reader = (values) => (name) => values[name] ?? "";

test("the reason codes are exactly the database's", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20261114100000_m7b2b_exclusion_types.sql", import.meta.url), "utf8");
  const values = /create type private\.exclusion_reason as enum \(([^)]*)\)/.exec(sql)[1].match(/'([a-z_]+)'/g).map((v) => v.slice(1, -1));
  assert.deepEqual(EXCLUSION_REASONS.map((r) => r.code), values);
  assert.equal(exclusionReasonLabel("game_key_card"), "A game-key card, which holds no game");
  assert.equal(exclusionReasonLabel("unknown"), "Outside the catalog's physical-only scope");
});

test("an exclusion needs a fixed reason, a staff reason, a short note and every acknowledgement", () => {
  const ok = { reason_code: "download_code", reason: "  A code   in a box ", owner_note: "  Not a game.  ", acknowledge_copies: "yes", acknowledge_cascade: "yes" };
  assert.deepEqual(readExclusion(reader(ok), { cascade: true, copies: true }), {
    value: { reasonCode: "download_code", reason: "A code in a box", ownerNote: "Not a game.", acknowledgeCascade: true, acknowledgeCopies: true },
  });
  assert.ok("error" in readExclusion(reader({ ...ok, reason_code: "digital" }), { cascade: false, copies: false }));
  assert.ok("error" in readExclusion(reader({ ...ok, reason: "   " }), { cascade: false, copies: false }));
  assert.ok("error" in readExclusion(reader({ ...ok, reason: "x".repeat(501) }), { cascade: false, copies: false }));
  assert.ok("error" in readExclusion(reader({ ...ok, owner_note: "x".repeat(1001) }), { cascade: false, copies: false }));
  assert.equal(readExclusion(reader({ ...ok, owner_note: "x".repeat(1000) }), { cascade: false, copies: false }).value.ownerNote.length, 1000);
  assert.equal(readExclusion(reader({ ...ok, owner_note: " " }), { cascade: false, copies: false }).value.ownerNote, null);
  assert.ok("error" in readExclusion(reader({ ...ok, acknowledge_copies: "" }), { cascade: false, copies: true }));
  assert.ok("error" in readExclusion(reader({ ...ok, acknowledge_cascade: "" }), { cascade: true, copies: false }));
  assert.ok("value" in readExclusion(reader({ ...ok, acknowledge_cascade: "", acknowledge_copies: "" }), { cascade: false, copies: false }));
});

test("a restoration needs a reason", () => {
  assert.deepEqual(readRestoreReason(reader({ reason: " Wrong call " })), { value: "Wrong call" });
  assert.ok("error" in readRestoreReason(reader({ reason: "" })));
});

test("every refusal has its own fixed message, and nothing else passes through", () => {
  const known = ["not permitted", "own submission", "own exclusion", "preview stale", "request conflict", "exclusion blocked", "acknowledgement required",
    "release unavailable", "exclusion unavailable", "exclusion changed", "restore blocked"];
  const messages = known.map(exclusionErrorMessage);
  assert.equal(new Set(messages).size, known.length);
  assert.equal(exclusionErrorMessage('could not obtain lock on row in relation "profiles"'), "It couldn't be saved. Try again.");
  assert.ok(!messages.some((m) => /\blocks?\b|\bprofiles?\b|nowait/i.test(m)));
});

test("a preserved copy's pieces are matched with what its excluded release listed", () => {
  const recorded = [
    { kind: "insert", label: "Manual", quantity: null, listed: false, recorded: true, condition: "good" },
    { kind: "map", label: "Old map", quantity: null, listed: false, recorded: true, condition: null },
  ];
  const listed = [
    { kind: "insert", label: "Manual", quantity: 1 },
    { kind: "artwork", label: "Poster", quantity: 1 },
  ];
  assert.deepEqual(withListedPieces(recorded, listed), [
    { kind: "insert", label: "Manual", quantity: 1, listed: true, recorded: true, condition: "good" },
    { kind: "artwork", label: "Poster", quantity: 1, listed: true, recorded: false, condition: null },
    { kind: "map", label: "Old map", quantity: null, listed: false, recorded: true, condition: null },
  ]);
  assert.deepEqual(withListedPieces(recorded, []).map((p) => p.listed), [false, false]);
});
