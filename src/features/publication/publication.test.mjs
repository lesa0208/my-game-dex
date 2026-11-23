// Run with: npm run publication:test. The decision and publish forms' rules and messages (M14c-3).
import assert from "node:assert/strict";
import { test } from "node:test";

import { decisionErrorCode, decisionMessage, decisionNotice, DECISION_MESSAGES, readDecision } from "../batches/form.ts";
import { publishErrorCode, publishMessage, PUBLISH_MESSAGES, queueState, readPublish } from "./form.ts";

const form = (values) => (name) => values[name] ?? "";
const BATCH = "1a2b3c4d-0000-4000-8000-000000000000";

test("a decision needs a reason, the batch's first 8 characters exactly, and the acknowledgement", () => {
  assert.deepEqual(readDecision(form({}), BATCH), { error: "reason" });
  assert.deepEqual(readDecision(form({ reason: "   " }), BATCH), { error: "reason" });
  assert.deepEqual(readDecision(form({ reason: "x".repeat(501) }), BATCH), { error: "reason_long" });
  for (const typed of ["", "1a2b3c4", "1A2B3C4D", "1a2b3c4d-", BATCH]) assert.deepEqual(readDecision(form({ reason: "Checked", confirm_id: typed, acknowledge: "on" }), BATCH), { error: "confirm_id" }, typed);
  assert.deepEqual(readDecision(form({ reason: "Checked", confirm_id: "1a2b3c4d" }), BATCH), { error: "acknowledge" });
  assert.deepEqual(readDecision(form({ reason: "  Checked   every   member ", confirm_id: " 1a2b3c4d ", acknowledge: "on" }), BATCH), { value: { reason: "Checked every member" } });
});

test("the database's decision errors become fixed messages; nothing else is shown", () => {
  for (const m of ["not permitted", "reauthentication required", "record unavailable", "own record", "already approved", "batch not reviewed", "sample failed", "critical errors unresolved", "evidence required", "batch stale", "provider not cleared"]) {
    assert.notEqual(decisionErrorCode(m), "failed", m);
  }
  assert.equal(decisionErrorCode("duplicate key value violates something secret"), "failed");
  assert.equal(decisionErrorCode("constructor"), "failed");
  assert.equal(decisionMessage("sample_failed"), DECISION_MESSAGES.sample_failed);
  for (const c of ["<script>", "constructor", "", null]) assert.equal(decisionMessage(c), null, String(c));
});

test("the notice after a decision comes only from bounded numbers", () => {
  const n = (values) => (name) => (name in values ? values[name] : null);
  assert.match(decisionNotice({ notice: "approval_recorded", n: n({ approvals: 1, required: 2 }) }), /1 of 2 approvals\. The batch is still open/);
  assert.match(decisionNotice({ notice: "approved", n: n({ published: 3, awaiting_evidence: 10, awaiting_publication: 0 }) }), /^Approved\. 3 published as identities; 0 confirmed and waiting for another editor to publish; 10 verified as identities only/);
  assert.equal(decisionNotice({ notice: "approved", n: n({ published: 3 }) }), null);
  assert.match(decisionNotice({ notice: "rejected", n: n({}) }), /closed for good/);
  assert.equal(decisionNotice({ notice: "<script>", n: n({}) }), null);
});

test("publishing: only offered platforms, ticked by the editor, with a reason and confirmation", () => {
  const ok = { reason: "Evidence checked", confirm: "on" };
  assert.deepEqual(readPublish([], form(ok), ["snes"]), { error: "choose" });
  assert.deepEqual(readPublish(["nes"], form(ok), ["snes"]), { error: "not_eligible" });
  assert.deepEqual(readPublish(["snes", "nes"], form(ok), ["snes"]), { error: "not_eligible" });
  assert.deepEqual(readPublish(Array.from({ length: 21 }, (_, i) => `p${i}`), form(ok), []), { error: "choose" });
  assert.deepEqual(readPublish(["snes"], form({ confirm: "on" }), ["snes"]), { error: "reason" });
  assert.deepEqual(readPublish(["snes"], form({ reason: "Evidence checked" }), ["snes"]), { error: "confirm" });
  assert.deepEqual(readPublish(["snes", " snes "], form(ok), ["snes", "nes"]), { value: { platforms: ["snes"], reason: "Evidence checked" } });
});

test("publication errors become fixed messages, and the queue falls back to ready", () => {
  for (const m of ["own record", "record changed", "pairing not verified", "game not verified", "record unavailable", "reauthentication required"]) assert.notEqual(publishErrorCode(m), "failed", m);
  assert.equal(publishErrorCode("raw sql detail"), "failed");
  assert.equal(publishMessage("own_record"), PUBLISH_MESSAGES.own_record);
  assert.equal(publishMessage("toString"), null);
  assert.equal(queueState("verifier_gone"), "verifier_gone");
  assert.equal(queueState("<b>"), "ready");
});
