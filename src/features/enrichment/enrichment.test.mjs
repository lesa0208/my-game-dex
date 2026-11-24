// Run with: npm run enrichment:test. Submission enrichment's pure rules (M15 catalog UX), with the
// importer's own parser on a real, trimmed Wikidata record (Super Mario World, Q853143, CC0).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { entityToEntry } from "../../../scripts/wikidata-entities.mjs";
import { WIKIDATA_LICENCE, candidateFromEntry, comparableTitle, enrichmentSummary, isValidUserAgent } from "./match.ts";

const SNES = "Q183259";
const NES = "Q172742";
const mario = JSON.parse(readFileSync(new URL("../../../scripts/fixtures/wikidata-b1/real-q853143-trimmed.json", import.meta.url), "utf8")).entities.Q853143;
const AT = "2026-11-24T12:00:00.000Z";

test("a User-Agent needs a tool, a version and a contact: none is ever invented", () => {
  assert.equal(isValidUserAgent(undefined), false);
  assert.equal(isValidUserAgent("curl/8.0"), false);
  assert.equal(isValidUserAgent("MyGameDex/0.1"), false);
  assert.equal(isValidUserAgent("MyGameDex/0.1 (https://example.org/contact) node-fetch/1"), true);
  assert.equal(isValidUserAgent("MyGameDex/0.1 (ops@example.org)"), true);
});

test("a real Wikidata game on its platform becomes a candidate, with its id, revision, licence and time", () => {
  const c = candidateFromEntry(entityToEntry(mario, SNES), "super mario world", AT);
  assert.ok(c);
  assert.equal(c.external_id, "Q853143");
  assert.equal(c.url, "https://www.wikidata.org/wiki/Q853143");
  assert.equal(c.title_matches, true);
  assert.equal(c.retrieved_at, AT);
  assert.equal(c.licence, WIKIDATA_LICENCE);
  assert.ok(c.titles.includes("Super Mario World"));
  assert.ok(Array.isArray(c.developers) && Array.isArray(c.publishers));
});

test("an item the importer would ignore is never a candidate (not on this platform)", () => {
  assert.equal(candidateFromEntry(entityToEntry(mario, NES), "Super Mario World", AT), null);
  assert.equal(candidateFromEntry({ external_id: "Q1", ignore_reason: "not a video game", payload: { title: "X" } }, "X", AT), null);
});

test("a different title is a candidate to choose, never a match", () => {
  const c = candidateFromEntry(entityToEntry(mario, SNES), "Super Mario Bros", AT);
  assert.ok(c);
  assert.equal(c.title_matches, false);
});

test("titles compare as typed: case, punctuation, width and a leading article don't matter", () => {
  assert.equal(comparableTitle("The Legend of Zelda: A Link to the Past"), comparableTitle("legend of zelda   a link to the past"));
  assert.equal(comparableTitle("ＳＵＰＥＲ　Ｒ－ＴＹＰＥ"), comparableTitle("Super R-Type"));
  assert.notEqual(comparableTitle("Super Momotaro Dentetsu II"), comparableTitle("Super Momotaro Dentetsu III"));
});

test("every outcome reads as a sentence, and a missing contact says so", () => {
  for (const status of ["not_configured", "unsupported_platform", "failed", "no_match", "single_match", "ambiguous"]) {
    assert.match(enrichmentSummary({ status, provider: "wikidata", at: AT, candidates: [] }), /\.$/);
  }
  assert.match(enrichmentSummary({ status: "not_configured", provider: "wikidata", at: AT, candidates: [] }), /WIKIDATA_USER_AGENT/);
  assert.equal(enrichmentSummary(null), "Not looked up.");
});
