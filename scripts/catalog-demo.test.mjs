// M16: the demo catalog's pure rules: which games are selected, and which may be published there.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEMO_NOTE, DEMO_PLATFORMS, MAX_DEMO_ALIASES, demoAliases, demoIneligibility, demoSelection, reissuedDigitally, sitelinkQuery } from "./catalog-demo.mjs";
import { WIKIDATA_PLATFORMS } from "./catalog-import-sources.mjs";
import { PLATFORM_ERAS, PLATFORM_MEDIA } from "./wikidata-entities.mjs";

const N64 = "Q184839";
const row = (id, links) => ({ item: { value: `http://www.wikidata.org/entity/${id}` }, links: { value: String(links) } });
const entry = ({ flags = [], date = "1996-12-14", distribution = [], ids = { igdb: ["a"], mobygames: ["1"], mobygames_former: [] }, ignore } = {}) => ({
  entity_type: "game",
  external_id: "Q1",
  flags,
  ...(ignore ? { ignore_reason: ignore } : {}),
  payload: { title: "T", first_release_date: date, source: { distribution, external_ids: ids } },
});

test("every demo platform has a Wikidata item, an era and its physical media", () => {
  assert.equal(DEMO_PLATFORMS.length, 9);
  for (const slug of DEMO_PLATFORMS) {
    const qid = WIKIDATA_PLATFORMS[slug];
    assert.match(qid, /^Q[0-9]+$/, slug);
    assert.equal(PLATFORM_ERAS[qid]?.slug, slug);
    assert.ok(PLATFORM_MEDIA[qid]?.length, `${slug} has its physical media`);
  }
  assert.match(sitelinkQuery(N64), /wdt:P31 wd:Q7889 ; wdt:P400 wd:Q184839 ; wikibase:sitelinks \?links/);
});

test("the selection is each platform's best-known games, deterministic", () => {
  const rows = [row("Q30", 40), row("Q10", 90), row("Q20", 90), row("Q10", 12), row("Q40", 5), { item: { value: "bad" }, links: { value: "1" } }];
  assert.deepEqual(demoSelection(rows, 3), ["Q10", "Q20", "Q30"], "most sitelinks first, then the lower Q-id; a repeat counts once");
  assert.deepEqual(demoSelection([...rows].reverse(), 3), ["Q10", "Q20", "Q30"], "whatever order the query service returns");
});

test("demo publication refuses every critical signal, with two narrow readings", () => {
  assert.equal(demoIneligibility(entry(), N64), null, "a clean entry");
  assert.deepEqual(demoIneligibility(entry({ ignore: "not a video game" }), N64), ["ignored: not a video game"]);
  assert.deepEqual(demoIneligibility(entry({ flags: ["other_instance_of"] }), N64), ["wrong_identity_or_type"]);
  assert.deepEqual(demoIneligibility(entry({ flags: ["distribution_format_unclassified"] }), N64), ["physical_eligibility_unsupported"]);
  assert.deepEqual(demoIneligibility(entry({ flags: ["platform_date_after_era"], date: "2019-01-01" }), N64), ["physical_eligibility_unsupported"]);
  // Several MobyGames ids, or IGDB slug variants: one game. Two named IGDB entries: a person decides.
  assert.equal(demoIneligibility(entry({ flags: ["external_ids_multiple"], ids: { igdb: ["a"], mobygames: ["1", "2"], mobygames_former: [] } }), N64), null);
  assert.equal(demoIneligibility(entry({ flags: ["external_ids_multiple"], ids: { igdb: ["mario", "mario--2"], mobygames: [], mobygames_former: [] } }), N64), null);
  assert.deepEqual(demoIneligibility(entry({ flags: ["external_ids_multiple"], ids: { igdb: ["mario", "luigi"], mobygames: [], mobygames_former: [] } }), N64), ["conflicting_identifiers"]);
});

test("a game from the platform's era stated only as a later digital download is a reissue; nothing else is", () => {
  const download = [{ format: "Q54820071", platforms: [], distributors: [] }];
  const reissue = entry({ flags: ["distribution_non_physical"], distribution: download });
  assert.equal(reissuedDigitally(reissue, N64), true, "Mario Kart 64: an unqualified digital download");
  assert.equal(demoIneligibility(reissue, N64), null);
  assert.deepEqual(demoIneligibility(entry({ flags: ["distribution_non_physical"], distribution: [{ format: "Q54820071", platforms: [N64], distributors: [] }] }), N64), ["physical_eligibility_unsupported"], "a download stated for this platform");
  assert.deepEqual(demoIneligibility(entry({ flags: ["distribution_non_physical"], distribution: download, date: "2021-05-01" }), N64), ["physical_eligibility_unsupported"], "a game from after the platform's era (homebrew, a modern release)");
  assert.deepEqual(demoIneligibility(entry({ flags: ["distribution_non_physical"], distribution: download, date: null }), N64), ["physical_eligibility_unsupported"], "no date");
  assert.deepEqual(demoIneligibility(entry({ flags: ["distribution_non_physical", "distribution_format_unclassified"], distribution: download }), N64), ["physical_eligibility_unsupported"], "another doubt");
  assert.equal(reissuedDigitally(reissue, "Q999"), false, "a platform without an era");
});

test("a game's other titles are the source's own, each with its kind and language", () => {
  const entity = {
    labels: { en: { value: "Mega Man X" }, fr: { value: "Megaman X" }, de: { value: "Mega Man X" }, ja: { value: "ロックマンX" } },
    aliases: { en: [{ value: "Rockman X" }, { value: "mega man x" }], ja: [{ value: "ロックマンエックス" }] },
    claims: { P2125: [{ rank: "normal", mainsnak: { datavalue: { value: "Rokkuman Ekkusu" } } }, { rank: "deprecated", mainsnak: { datavalue: { value: "Old" } } }] },
  };
  assert.deepEqual(demoAliases(entity), [
    { title: "Rockman X", kind: "alternate", language: null },
    { title: "Megaman X", kind: "regional", language: "fr" },
    { title: "ロックマンX", kind: "regional", language: "ja" },
    { title: "ロックマンエックス", kind: "regional", language: "ja" },
    { title: "Rokkuman Ekkusu", kind: "romanized", language: "ja-Latn" },
  ], "the title itself, case repeats and deprecated statements are left out");
  const many = { labels: { en: { value: "T" } }, aliases: { en: Array.from({ length: 30 }, (_, i) => ({ value: `T ${i}` })) } };
  assert.equal(demoAliases(many).length, MAX_DEMO_ALIASES);
});

test("every demo pairing says it is a demo, not physical evidence, and passes the database's note rule", () => {
  assert.match(DEMO_NOTE, /^DEMO CATALOG ONLY, not physical evidence/);
  assert.match(DEMO_NOTE, /No person checked a physical copy\./);
  assert.ok(DEMO_NOTE.length >= 20 && DEMO_NOTE.length <= 500);
});
