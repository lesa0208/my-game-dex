// Run with: npm run catalog:test. The decisions behind catalog-b1-review.mjs publish (M14c-3).
import assert from "node:assert/strict";
import { test } from "node:test";

import { choosePlatforms, confirmsGame, describePairings, reportPublish } from "./lib/publish-plan.mjs";

const pairing = (slug, publication, physical = null, status = "under_review") => ({
  platform: { slug, name: slug.toUpperCase() },
  status,
  physical,
  publication,
});
const evidence = {
  game: { id: "0193a1b2-0000-7000-8000-000000000001", revision: 4 },
  pairings: [
    pairing("snes", { eligible: true, reason: null, you_may_publish: true, your_reason: null }, { verifier: { handle: "reviewer_b", you: false }, note: "Cartridge and box photographed" }),
    pairing("nes", { eligible: true, reason: null, you_may_publish: false, your_reason: "you_confirmed" }, { verifier: { handle: null, you: true }, note: null }),
    pairing("gb", { eligible: false, reason: "physical_evidence_unconfirmed", you_may_publish: false, your_reason: null }),
    pairing("md", { eligible: false, reason: "published", you_may_publish: false, your_reason: null }, null, "published"),
  ],
};

test("each pairing says where it stands, and whether you may publish it", () => {
  const d = describePairings(evidence);
  assert.deepEqual(d.map((p) => [p.slug, p.mayPublish]), [["snes", true], ["nes", false], ["gb", false], ["md", false]]);
  assert.match(d[0].physical, /confirmed by @reviewer_b: "Cartridge and box photographed"/);
  assert.match(d[1].standing, /you confirmed its evidence/);
  assert.match(d[2].standing, /physical existence isn't confirmed/);
  assert.match(d[3].standing, /already public/);
  assert.deepEqual(describePairings(null), []);
});

test("only platforms you may publish can be chosen, and nothing is chosen for you", () => {
  assert.deepEqual(choosePlatforms("snes", evidence), { slugs: ["snes"] });
  assert.deepEqual(choosePlatforms(" SNES , snes ", evidence), { slugs: ["snes"] });
  assert.match(choosePlatforms("", evidence).error, /No platform chosen/);
  assert.match(choosePlatforms("nes", evidence).error, /you confirmed its evidence/);
  assert.match(choosePlatforms("snes,gb", evidence).error, /GB: can't be published/);
  assert.match(choosePlatforms("psx", evidence).error, /isn't one of this game's platforms/);
});

test("the confirmation is the game's first 8 characters, exactly", () => {
  assert.equal(confirmsGame("0193a1b2", evidence.game.id), true);
  assert.equal(confirmsGame(" 0193a1b2 ", evidence.game.id), true);
  assert.equal(confirmsGame("0193A1B2", evidence.game.id), false);
  assert.equal(confirmsGame("yes", evidence.game.id), false);
  assert.equal(confirmsGame(undefined, evidence.game.id), false);
});

test("the result is reported as the database gave it, never as success otherwise", () => {
  assert.equal(reportPublish({ ok: true, data: true }).ok, true);
  for (const r of [{ ok: true, data: false }, { ok: true, data: null }, { ok: false, error: "own record" }, null, undefined]) assert.equal(reportPublish(r).ok, false, JSON.stringify(r));
  assert.equal(reportPublish({ ok: false, error: "own record" }).message, "Refused: own record. Nothing was published.");
});

test("catalog text printed to the terminal has no control characters, and the evidence times come from the read", async () => {
  const { printable, verifiedAt } = await import("./lib/publish-plan.mjs");
  assert.equal(printable("Game\u001b[2J\u001b[31mPublished.\u0007 \u202eevil"), "Game[2J[31mPublished. evil");
  assert.equal(printable("x".repeat(400)).length, 300);
  const ev = { pairings: [{ platform: { slug: "snes" }, physical: { verified_at: "2026-11-23T10:00:00.123456+00:00" } }, { platform: { slug: "nes" }, physical: null }] };
  assert.deepEqual(verifiedAt(ev, ["snes", "nes", "gb"]), ["2026-11-23T10:00:00.123456+00:00", null, null]);
  const hostile = { pairings: [{ platform: { slug: "snes", name: "SNES\u001b[0m" }, status: "under_review", physical: { verifier: { handle: "x" }, note: "note\u001b]0;title\u0007" }, publication: { eligible: true, you_may_publish: true } }] };
  assert.doesNotMatch(JSON.stringify(describePairings(hostile)), /\u001b|\u0007/);
});
