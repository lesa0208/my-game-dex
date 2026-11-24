// Run with: npm run enrichment:test. Submission enrichment's pure rules (M15 catalog UX), with the
// importer's own parser on a real, trimmed Wikidata record (Super Mario World, Q853143, CC0).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { entityToEntry } from "../../../scripts/wikidata-entities.mjs";
import {
  WIKIDATA_LICENCE,
  candidateFromEntry,
  collectorLookupText,
  comparableTitle,
  enrichmentSummary,
  isValidUserAgent,
  publicationGaps,
  storedSummary,
  suggestedShell,
  unclassifiedFormat,
} from "./match.ts";

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

// M15 submission enrichment ----------------------------------------------------------------------

const FORMATS = [
  { platform: "snes", code: "snes-game-pak-na", acceptsNewPublications: true },
  { platform: "snes", code: "snes-cartridge-jp-pal", acceptsNewPublications: true },
  { platform: "snes", code: "rom-cartridge", acceptsNewPublications: false },
  { platform: "playstation-2", code: "cd-rom", acceptsNewPublications: true },
  { platform: "playstation-2", code: "dvd-rom", acceptsNewPublications: true },
  { platform: "game-boy", code: "game-boy-game-pak", acceptsNewPublications: true },
];

test("'Not sure' is the platform's unclassified shell only where one exists, never a made-up format", () => {
  assert.equal(unclassifiedFormat(FORMATS, "snes"), "rom-cartridge");
  assert.equal(unclassifiedFormat(FORMATS, "playstation-2"), null, "no unclassified format: the question stays");
  assert.equal(unclassifiedFormat(FORMATS, "game-boy"), null, "one format: nothing to ask");
  assert.equal(unclassifiedFormat(FORMATS, "unknown-platform"), null);
});

test("the region suggests a cartridge shell on NES and SNES only, and an unknown region suggests nothing", () => {
  assert.equal(suggestedShell("snes", "ntsc-uc"), "snes-game-pak-na");
  assert.equal(suggestedShell("snes", "pal"), "snes-cartridge-jp-pal");
  assert.equal(suggestedShell("snes", "ntsc-j"), "snes-cartridge-jp-pal");
  assert.equal(suggestedShell("nes", "ntsc-j"), "famicom-cartridge");
  assert.equal(suggestedShell("snes", "unknown"), null);
  assert.equal(suggestedShell("playstation-2", "pal"), null);
});

const BARE = { media_format_code: "rom-cartridge", region_code: "unknown", region_unknown_confirmed: false, packaging_code: "unclassified", edition_name: null, edition_kind: null, media_count: null, product_code: null, barcode: null };
const publishable = (code) => FORMATS.some((f) => f.platform === "snes" && f.code === code && f.acceptsNewPublications);

test("a three-field submission lists everything the release still needs, physical evidence included", () => {
  const gaps = publicationGaps(BARE, publishable);
  assert.equal(gaps.length, 6);
  assert.ok(gaps[0].includes("cartridge shell"));
  assert.ok(gaps.some((g) => g.includes("region")));
  assert.ok(gaps.at(-1).includes("which no source provides"));
});

test("a complete release lacks nothing the database requires", () => {
  const full = { ...BARE, media_format_code: "snes-game-pak-na", region_code: "ntsc-uc", packaging_code: "cardboard-box", edition_name: "Standard", edition_kind: "standard", media_count: 1, product_code: "SNS-XX-USA" };
  assert.deepEqual(publicationGaps(full, publishable), []);
  assert.equal(publicationGaps({ ...full, region_code: "unknown", region_unknown_confirmed: true }, publishable).length, 0, "an editor-confirmed unknown region is enough");
});

const stored = (over) => ({ status: "pending", provider: "wikidata", attempts: 0, looking_up: false, looked_up_title: null, looked_up_platform: null, retrieved_at: null, candidates: [], labels: {}, current_title: "Wild Guns", catalog_items: [], title_matches: [], ...over });

test("a stored lookup reads plainly for the editor, for every state", () => {
  assert.match(storedSummary(null, true), /only new games/);
  assert.match(storedSummary(stored({}), false), /WIKIDATA_USER_AGENT/);
  assert.match(storedSummary(stored({}), true), /Looking this up/);
  assert.match(storedSummary(stored({ status: "failed", attempts: 1, retrieved_at: AT }), true), /tried again automatically/);
  assert.match(storedSummary(stored({ status: "failed", attempts: 5, retrieved_at: AT }), true), /after 5 tries/);
  assert.match(storedSummary(stored({ status: "no_match", retrieved_at: AT, looked_up_title: "Wild Guns" }), true), /no video game with this title/);
  assert.match(storedSummary(stored({ status: "no_match", retrieved_at: AT, looked_up_title: "Old Name" }), true), /earlier title/);
  assert.match(storedSummary(stored({ status: "single_match", retrieved_at: AT, candidates: [{}] }), true), /likely match/);
  assert.match(storedSummary(stored({ status: "ambiguous", retrieved_at: AT, candidates: [{}, {}] }), true), /2 possible matches.*None is chosen/);
  assert.match(storedSummary(stored({ status: "unsupported_platform", retrieved_at: AT }), true), /don't cover this platform/);
});

test("the collector is told what happens, never asked for more", () => {
  assert.match(collectorLookupText("pending", false), /Nothing is needed from you/);
  assert.match(collectorLookupText("failed", false), /try again/);
  assert.match(collectorLookupText("ambiguous", true), /prepared it for the editors/);
  assert.match(collectorLookupText("no_match", false), /editors will research it/);
  assert.equal(collectorLookupText(undefined, false), null);
});
