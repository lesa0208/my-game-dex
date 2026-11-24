// Run with: npm run records:test. What the sources said about a game, in plain words (M15 catalog UX).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CRITICAL_TEXT, FLAG_TEXT, alternativeTitles, formatLines, missingFacts, platformDates, sourceDate, sourceIds, warningsOf } from "./source-facts.ts";

const importer = readFileSync(new URL("../../../scripts/wikidata-entities.mjs", import.meta.url), "utf8");
const zelda = {
  sources: [
    {
      provider: "wikidata", provider_name: "Wikidata", external_id: "Q370055", record_status: "promoted", imported_at: null, source_name: null,
      source_sha256: null, source_fetched_at: null, terms_sha256: null, licence: { cleared: true, terms_url: null, rights_survive_withdrawal: true },
      title: "The Legend of Zelda: A Link to the Past",
      titles: ["The Legend of Zelda: A Link to the Past", "Zelda no Densetsu: Kamigami no Triforce", "A Link to the Past"],
      ja_titles: ["ゼルダの伝説 神々のトライフォース"],
      first_release_date: "1991-11-21", first_release_precision: "day",
      source: {
        developers: ["Q170420"], publishers: [],
        release_dates: [
          { value: "1992-04-13", precision: "day", platforms: ["Q183259"], places: ["Q49"] },
          { value: "1991-11-21", precision: "day", platforms: ["Q183259"], places: ["Q17"] },
          { value: "2006-12-02", precision: "day", platforms: ["Q8079"], places: ["Q17"] },
        ],
        distribution: [
          { format: "Q633454", platforms: [], distributors: [] },
          { format: "Q54820071", platforms: [], distributors: [] },
          { format: "Q7982", platforms: ["Q10677"], distributors: [] },
        ],
      },
      flags: ["external_ids_multiple", "many_platforms"],
      critical: ["conflicting_identifiers"],
    },
  ],
  held_lookalikes: [{ provider: "wikidata", external_id: "Q9", title: "A Link to the Past", reason: "held" }],
};

test("every flag and critical signal the importer can raise has plain words", () => {
  const flags = [...importer.matchAll(/^ {2}([a-z_]+): "(exception|info)",$/gm)].map((m) => m[1]);
  assert.ok(flags.length >= 19, `${flags.length} flags`);
  for (const f of flags) assert.ok(FLAG_TEXT[f], `no text for ${f}`);
  const critical = /export const CRITICAL_ERRORS = \{([\s\S]*?)\};/.exec(importer)[1];
  for (const c of [...critical.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1])) assert.ok(CRITICAL_TEXT[c], `no text for ${c}`);
});

test("warnings come critical first, then checks (with held look-alikes), then notes", () => {
  const w = warningsOf(zelda);
  assert.equal(w[0].level, "critical");
  assert.match(w[0].text, /more than one game/);
  assert.ok(w.some((x) => x.level === "check" && /Q9 "A Link to the Past"/.test(x.text)));
  assert.equal(w.at(-1).level, "note");
  assert.deepEqual(warningsOf(null), []);
});

test("alternative titles are distinct and never repeat the title itself", () => {
  const t = alternativeTitles("The Legend of Zelda: A Link to the Past", zelda, [{ title: "a link to the past" }]);
  assert.deepEqual(t.latin, ["a link to the past", "Zelda no Densetsu: Kamigami no Triforce"]);
  assert.deepEqual(t.japanese, ["ゼルダの伝説 神々のトライフォース"]);
});

test("dates on this platform only, earliest first, as precise as the source", () => {
  assert.deepEqual(platformDates(zelda, "snes").map((d) => d.value), ["1991-11-21", "1992-04-13"]);
  assert.deepEqual(platformDates(zelda, "unknown"), []);
  assert.equal(sourceDate("1991-11-21", "day"), "21 Nov 1991");
  assert.equal(sourceDate("1991-11-01", "month"), "Nov 1991");
  assert.equal(sourceDate("1991-01-01", "year"), "1991");
  assert.equal(sourceDate(null, "day"), null);
});

test("formats mark digital ones and other platforms' versions; unknown values stay missing", () => {
  const f = formatLines(zelda, "snes");
  assert.deepEqual(f.map((x) => [x.label, x.physical, x.otherPlatform]), [["ROM cartridge", true, false], ["digital download", false, false], ["CD-ROM", true, true]]);
  assert.deepEqual(sourceIds(zelda, "developers"), ["Q170420"]);
  assert.deepEqual(sourceIds(zelda, "publishers"), []);
  assert.deepEqual(missingFacts(zelda, { first_release: { value: "1991-11-21" }, release_count: 0 }, "snes"), ["Publisher", "Physical release (product code, region, packaging)"]);
  assert.deepEqual(missingFacts(null, { first_release: null, release_count: 0 }, "snes"), [
    "Release date", "Release date on this platform", "Developer", "Publisher", "Physical release (product code, region, packaging)",
  ]);
});
