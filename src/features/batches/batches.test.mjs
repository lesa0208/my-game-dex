// Run with: npm run batches:test. The review-batch pages' pure rules and messages (M14c-2).
// scripts/app-review-batch-checks.mjs tests the running app; 55_m14c2_review_batch_reads the database.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CRITICAL_ERRORS as IMPORTER_CRITICAL_ERRORS, DISTRIBUTION_FORMAT_TABLE, FLAG_REASONS as IMPORTER_FLAG_REASONS, FLAGS } from "../../../scripts/wikidata-entities.mjs";
import {
  batchStatusFilter,
  blockerText,
  CRITICAL_ERRORS,
  DISTRIBUTION_FORMATS,
  evidenceNoteOk,
  FLAG_REASONS,
  flagReason,
  itemLink,
  memberFilter,
  outcomeErrorMessage,
  outcomeMessage,
  outcomeMessageCode,
  readOutcome,
  RECORD_BLOCKS,
  sourceLinks,
} from "./form.ts";

const EV = "Cartridge and box photographed; label checked against the listing";
const form = (values) => (name) => values[name] ?? "";
const ALL = ["correct", "incorrect", "excluded"];

test("the flag reasons, critical errors and formats are the importer's own", () => {
  assert.deepEqual(FLAG_REASONS, IMPORTER_FLAG_REASONS);
  assert.deepEqual(Object.keys(FLAG_REASONS).sort(), Object.keys(FLAGS).sort());
  assert.deepEqual(CRITICAL_ERRORS, IMPORTER_CRITICAL_ERRORS);
  assert.deepEqual(
    DISTRIBUTION_FORMATS,
    Object.fromEntries(Object.entries(DISTRIBUTION_FORMAT_TABLE).map(([q, f]) => [q, { label: f.label, physical: f.class === "physical" }])),
  );
});

test("an unknown flag is described, never hidden", () => {
  assert.match(flagReason("something_new"), /don't describe/);
});

test("what counts as evidence matches private.evidence_note_ok", () => {
  for (const [note, ok] of [
    [null, false],
    ["", false],
    ["                         ", false],
    ["\t\n  \r\n\t   \n\t\t  \n", false],
    ["Cartridge photo ok.", false],
    ["Cartridge photo ok!!", true],
    ["   short note    here   ", false],
    ["!!!!!!!!!!....------,,,,,", false],
    ["a.b.c.d.e.f.g.h.i.....", false],
    ["a.b.c.d.e.f.g.h.i.j...", true],
    ["x".repeat(500), true],
    ["x".repeat(501), false],
    [`Line one of the evidence\nline two of it`, true],
    ["カートリッジと箱を確認しました。ラベルは一覧と一致しています。", true],
    [EV, true],
  ]) {
    assert.equal(evidenceNoteOk(note), ok, JSON.stringify(note));
  }
});

test("source links are built only from values of a fixed shape", () => {
  assert.deepEqual(sourceLinks("wikidata", "Q370055", 2569010217), {
    item: "https://www.wikidata.org/wiki/Q370055",
    revision: "https://www.wikidata.org/w/index.php?oldid=2569010217",
  });
  assert.deepEqual(sourceLinks("wikidata", "Q370055", null), { item: "https://www.wikidata.org/wiki/Q370055", revision: null });
  for (const id of ["javascript:alert(1)", "Q0", "Q12x", "https://evil.test/Q1", "q1", ""]) assert.deepEqual(sourceLinks("wikidata", id, 1), { item: null, revision: null }, id);
  assert.deepEqual(sourceLinks("igdb", "Q1", 1), { item: null, revision: null });
  assert.equal(sourceLinks("wikidata", "Q1", -4).revision, null);
  assert.equal(sourceLinks("wikidata", "Q1", 1.5).revision, null);
  assert.equal(itemLink("Q7889"), "https://www.wikidata.org/wiki/Q7889");
  assert.equal(itemLink("<b>Q1</b>"), null);
});

test("the outcome form: an outcome it offers, and a confirmation", () => {
  assert.deepEqual(readOutcome(form({}), ALL), { error: "Choose an outcome." });
  assert.deepEqual(readOutcome(form({ outcome: "approved" }), ALL), { error: "Choose an outcome." });
  assert.deepEqual(readOutcome(form({ outcome: "correct" }), ["excluded"]), { error: "Choose an outcome." });
  assert.match(readOutcome(form({ outcome: "excluded" }), ALL).error, /Confirm the outcome/);
  assert.deepEqual(readOutcome(form({ outcome: "excluded", confirm: "on" }), ALL), { value: { outcome: "excluded", criticalError: null, note: null } });
});

test("a correct outcome needs evidence, its confirmation, and no critical error", () => {
  assert.match(readOutcome(form({ outcome: "correct", confirm: "on" }), ALL).error, /physical evidence/);
  assert.match(readOutcome(form({ outcome: "correct", note: "too short", confirm: "on" }), ALL).error, /physical evidence/);
  assert.match(readOutcome(form({ outcome: "correct", note: "x".repeat(501), confirm: "on" }), ALL).error, /physical evidence/);
  assert.match(readOutcome(form({ outcome: "correct", note: EV }), ALL).error, /checked this evidence yourself/);
  assert.match(readOutcome(form({ outcome: "correct", note: EV, critical_error: "wrong_platform", confirm: "on" }), ALL).error, /no critical error/);
  // The note is kept exactly as typed; the database trims its ends.
  const typed = `  ${EV}\n  with the manual  `;
  assert.deepEqual(readOutcome(form({ outcome: "correct", note: typed, confirm: "on" }), ALL), { value: { outcome: "correct", criticalError: null, note: typed } });
});

test("incorrect and excluded keep optional notes and controlled critical errors", () => {
  assert.deepEqual(readOutcome(form({ outcome: "incorrect", critical_error: "wrong_platform", confirm: "on" }), ALL), {
    value: { outcome: "incorrect", criticalError: "wrong_platform", note: null },
  });
  assert.match(readOutcome(form({ outcome: "incorrect", critical_error: "made_up", confirm: "on" }), ALL).error, /from the list/);
  assert.match(readOutcome(form({ outcome: "incorrect", note: "x".repeat(1001), confirm: "on" }), ALL).error, /1,000/);
  assert.deepEqual(readOutcome(form({ outcome: "incorrect", note: "   ", confirm: "on" }), ALL), { value: { outcome: "incorrect", criticalError: null, note: null } });
});

test("filters fall back to a known value", () => {
  assert.equal(batchStatusFilter("rejected"), "rejected");
  assert.equal(batchStatusFilter("<script>"), "open");
  assert.equal(memberFilter("critical"), "critical");
  assert.equal(memberFilter(undefined), "needs_review");
});

test("database errors become fixed messages; nothing else from the database is shown", () => {
  for (const code of ["not permitted", "reauthentication required", "own record", "evidence required", "outcome recorded", "batch approval started", "record unavailable", "invalid changes", "changed"]) {
    assert.notEqual(outcomeErrorMessage(code), outcomeErrorMessage(null), code);
  }
  assert.equal(outcomeErrorMessage('duplicate key value violates unique constraint "x" (secret detail)'), "The outcome couldn't be recorded. Try again.");
  assert.deepEqual(Object.keys(RECORD_BLOCKS).sort(), ["approval_started", "not_open", "not_required", "outcome_final", "you_created_batch", "you_created_record"]);
});

test("blockers read in words, singular and plural", () => {
  assert.equal(blockerText("pending_outcomes", 1), "1 member still needs its individual review.");
  assert.equal(blockerText("pending_outcomes", 12), "12 members still need their individual review.");
  assert.match(blockerText("stale", 2), /2 members have changed/);
  assert.match(blockerText("publication_rights", 1), /1 source isn't cleared/);
  assert.equal(blockerText("unknown_code", 1), "Something else holds the approval.");
});

test("a critical error must be one of the list's own entries, not an inherited name", () => {
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.match(readOutcome(form({ outcome: "incorrect", critical_error: name, confirm: "on" }), ALL).error, /from the list/, name);
  }
});

test("without JavaScript, a refusal travels by its code, and only fixed texts come back", () => {
  const evidence = readOutcome(form({ outcome: "correct", note: "short", confirm: "on" }), ALL).error;
  assert.equal(outcomeMessageCode(evidence), "evidence");
  assert.equal(outcomeMessage("evidence"), evidence);
  assert.equal(outcomeMessageCode(RECORD_BLOCKS.outcome_final), "block_outcome_final");
  assert.equal(outcomeMessage("block_outcome_final"), RECORD_BLOCKS.outcome_final);
  assert.equal(outcomeMessageCode("anything else"), "failed");
  for (const code of ["<script>alert(1)</script>", "constructor", "block_constructor", "block_", "", null]) assert.equal(outcomeMessage(code), null, String(code));
  assert.equal(outcomeMessage(outcomeMessageCode(outcomeErrorMessage("stale"))), outcomeErrorMessage("stale"));
});
