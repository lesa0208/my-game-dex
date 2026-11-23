// M12c-B1 checkpoint one: the Wikidata entity parser, the selection, the dry run and the
// fetch policy. Synthetic fixtures (fictional titles) in scripts/fixtures/wikidata-b1/, plus
// one real record (Super Mario World, Q853143, CC0, trimmed and without references). No
// network: the fetch tests use a stub.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dryRunFiles, fetchEntities, reportMarkdown, validUserAgent } from "./catalog-b1.mjs";
import { parseWikidata } from "./catalog-import-sources.mjs";
import {
  b1Selection,
  CRITICAL_SIGNALS,
  DISTRIBUTION_FORMAT_TABLE,
  DISTRIBUTION_FORMATS,
  distributionFlags,
  dryRun,
  earliestDate,
  entityObjects,
  externalIdConflict,
  FLAG_REASONS,
  FLAGS,
  HOLD_REASON_MAX,
  identityTitleKey,
  parseWikidataEntities,
  RISK_ASSESSMENT,
  stagingEntries,
  timeValue,
  withRiskAssessment,
} from "./wikidata-entities.mjs";

const SNES = "Q183259";
const fixture = (name) => readFileSync(new URL(`./fixtures/wikidata-b1/${name}`, import.meta.url), "utf8");
const byId = (entries) => Object.fromEntries(entries.map((e) => [e.external_id, e]));

test("entity input: a wbgetentities response, the snapshot and the dump give the same entries", () => {
  const response = parseWikidataEntities(fixture("entities-response.json"), SNES);
  const snapshot = parseWikidataEntities(fixture("entities-snapshot.json"), SNES);
  const dump = parseWikidataEntities(fixture("entities-dump.json"), SNES);
  assert.deepEqual(snapshot, response);
  // The dump has no "missing" placeholder; every other entity is identical.
  assert.deepEqual(dump, response.filter((e) => e.external_id !== "Q1011"));
  assert.equal(entityObjects(fixture("entities-dump.json")).length, 11);
});

test("titles, aliases, dates and source-only fields", () => {
  const e = byId(parseWikidataEntities(fixture("entities-response.json"), SNES)).Q1001;
  assert.equal(e.ignore_reason, undefined);
  assert.equal(e.payload.title, "Zqx Starfall Saga");
  assert.deepEqual(e.payload.titles, ["Starfall Saga", "Zqx Starfall Saga"]);
  assert.deepEqual(e.payload.ja_titles, ["ズクスの星"]);
  // The game's first release is the earliest anywhere; the SNES date stays in the source.
  assert.deepEqual([e.payload.first_release_date, e.payload.first_release_precision], ["1991-12-01", "month"]);
  assert.deepEqual(e.payload.source.platform_first_release, { value: "1992-03-10", precision: "day" });
  assert.deepEqual(e.payload.source.external_ids, { igdb: ["zqx-starfall-saga"], mobygames: ["9001"], mobygames_former: [] });
  assert.deepEqual([e.payload.source.developers, e.payload.source.publishers], [["Q500001"], ["Q500002"]]);
  assert.equal(e.payload.source.release_dates.length, 2);
  assert.deepEqual(e.flags, []);
  // Never a release field: nothing here names a region, edition, code or packaging.
  for (const k of ["region_codes", "edition_name", "edition_kind", "serial", "packaging", "media_count", "release_type"]) assert.equal(e.payload[k], undefined);
});

test("hard problems hold an entity; suspicious ones flag it", () => {
  const e = byId(parseWikidataEntities(fixture("entities-response.json"), SNES));
  assert.equal(e.Q1003.ignore_reason, "not on this platform");
  assert.equal(e.Q1004.ignore_reason, "not a video game");
  assert.equal(e.Q1011.ignore_reason, "missing entity");
  assert.deepEqual(e.Q1002.flags, ["mul_label_only", "year_precision_only"]);
  assert.deepEqual(e.Q1005.flags, ["platform_date_before_launch", "other_instance_of"]);
  assert.deepEqual(e.Q1012.flags, ["year_precision_only", "platform_date_after_era", "many_platforms"]);
  // A deprecated statement is no date at all.
  assert.deepEqual(e.Q1008.flags, ["no_release_date"]);
  assert.equal(e.Q1008.payload.first_release_date, undefined);
});

test("time values keep their precision; a year containing a precise date gives way to it", () => {
  assert.deepEqual(timeValue({ time: "+1992-03-10T00:00:00Z", precision: 11 }), { value: "1992-03-10", precision: "day" });
  assert.deepEqual(timeValue({ time: "+1992-03-00T00:00:00Z", precision: 10 }), { value: "1992-03-01", precision: "month" });
  assert.equal(timeValue({ time: "+1992-00-00T00:00:00Z", precision: 8 }), null);
  assert.equal(timeValue({ time: "+1940-01-01T00:00:00Z", precision: 11 }), null);
  assert.deepEqual(earliestDate([{ value: "1985-01-01", precision: "year" }, { value: "1985-09-13", precision: "day" }]), { value: "1985-09-13", precision: "day" });
  assert.deepEqual(earliestDate([{ value: "1984-01-01", precision: "year" }, { value: "1985-09-13", precision: "day" }]), { value: "1984-01-01", precision: "year" });
});

test("a real record: Super Mario World (Q853143), labelled only in mul", () => {
  const [e] = parseWikidataEntities(fixture("real-q853143-trimmed.json"), SNES);
  assert.equal(e.ignore_reason, undefined);
  assert.equal(e.payload.title, "Super Mario World");
  assert.equal(e.payload.source.label_language, "mul");
  assert.deepEqual([e.payload.first_release_date, e.payload.first_release_precision], ["1990-11-21", "day"]);
  assert.deepEqual(e.payload.source.platform_first_release, { value: "1990-11-21", precision: "day" });
  assert.ok(e.payload.source.platforms.includes(SNES));
  assert.deepEqual(e.payload.source.external_ids.igdb, ["super-mario-world"]);
  assert.deepEqual(e.payload.source.external_ids.mobygames, ["6591"]);
  assert.ok(e.payload.ja_titles.includes("スーパーマリオワールド"));
  assert.deepEqual(e.flags, ["mul_label_only", "many_platforms"]);
  // Qualifiers are read: some dates name platforms and places.
  assert.ok(e.payload.source.release_dates.some((d) => d.platforms.includes(SNES) && d.places.length));
});

test("the selection is deterministic, takes every collision and the fixed ids, and has the size asked", () => {
  const entries = parseWikidata(fixture("query-snes.json"));
  const a = b1Selection(entries, { seed: "s1", size: 8, fixed: ["Q1009", "Q4040"] });
  const b = b1Selection(entries, { seed: "s1", size: 8, fixed: ["Q1009", "Q4040"] });
  assert.deepEqual(a, b);
  assert.equal(a.ids.length, 8);
  assert.deepEqual(a.strata.title_collisions, ["Q1001", "Q1007"]);
  assert.deepEqual(a.strata.fixed, ["Q1009"]);
  assert.deepEqual(a.strata.fixed_missing, ["Q4040"]);
  assert.equal(a.strata.random.length, 5);
  for (const id of [...a.strata.title_collisions, ...a.strata.fixed]) assert.ok(a.ids.includes(id));
  // Another seed draws other random items, never other collisions or fixed ids.
  const c = b1Selection(entries, { seed: "s2", size: 8, fixed: ["Q1009"] });
  assert.deepEqual(c.strata.title_collisions, a.strata.title_collisions);
  assert.notDeepEqual(c.strata.random, a.strata.random);
  // Sorted by numeric id.
  assert.deepEqual(a.ids, [...a.ids].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))));
});

test("the dry run: create, match, duplicate and hold, with batch and catalog flags", () => {
  const selection = { selector: "fixture", seed: "fixture", ids: ["Q1001", "Q1002", "Q1003", "Q1004", "Q1005", "Q1006", "Q1007", "Q1008", "Q1009", "Q1010", "Q1011", "Q1012"] };
  const report = dryRun({ selection, platformQid: SNES, entries: parseWikidataEntities(fixture("entities-snapshot.json"), SNES), catalog: JSON.parse(fixture("catalog.json")) });
  const it = Object.fromEntries(report.items.map((i) => [i.id, i]));
  assert.equal(it.Q1009.outcome, "matched");
  assert.equal(it.Q1009.catalog.title, "Zqx Linked Legend");
  assert.equal(it.Q1010.outcome, "duplicate");
  assert.ok(it.Q1010.flags.includes("catalog_title_match_same_platform"));
  assert.equal(it.Q1012.outcome, "create");
  assert.ok(it.Q1012.flags.includes("catalog_title_match_other_platform"));
  for (const id of ["Q1003", "Q1004", "Q1011"]) assert.equal(it[id].outcome, "held");
  assert.ok(it.Q1001.flags.includes("title_collision_in_batch") && it.Q1007.flags.includes("title_collision_in_batch"));
  assert.ok(it.Q1001.flags.includes("external_id_shared_in_batch") && it.Q1006.flags.includes("external_id_shared_in_batch"));
  assert.deepEqual(report.totals, {
    items: 12, create: 7, matched: 1, duplicate: 1, held: 3, exception_review: 8, clean: 1,
    readiness: { held: 3, held_for_editor: 0, pending_detail: 0, needs_review: 8, ready_for_editorial_consideration: 1 },
    possible_critical: 6, external_id_conflicts: 0, physical_release_evidence_required: 9, releases_created: 0, published: 0,
  });
  assert.deepEqual(it.Q1001.possible_critical, ["conflicting_duplicate_identities", "conflicting_identifiers"]);
  assert.deepEqual(it.Q1005.possible_critical, ["wrong_identity_or_type", "wrong_platform"]);
  assert.equal(it.Q1009.readiness, "ready_for_editorial_consideration");
  assert.deepEqual(report.collision_groups.map((g) => [g.verdict, g.members.map((m) => m.id)]), [["same_title_needs_review", ["Q1001", "Q1007"]]]);
});

test("without entity records, the query snapshot is used and flagged as pending detail", () => {
  const selection = JSON.stringify({ selector: "fixture", seed: "fixture", ids: ["Q1001", "Q1013", "Q9999"] });
  const report = dryRunFiles({ selectionText: selection, wikidataText: fixture("query-snes.json"), catalogText: fixture("catalog.json") });
  const it = Object.fromEntries(report.items.map((i) => [i.id, i]));
  assert.ok(it.Q1013.flags.includes("entity_detail_pending"));
  // Date flags come from the query snapshot too.
  const dates = dryRunFiles({ selectionText: JSON.stringify({ selector: "f", seed: "f", ids: ["Q1002", "Q1008"] }), wikidataText: fixture("query-snes.json") });
  assert.deepEqual(dates.items.map((i) => i.flags), [["entity_detail_pending", "year_precision_only"], ["entity_detail_pending", "no_release_date"]]);
  assert.equal(it.Q1013.outcome, "create");
  // An id missing from every snapshot is never silently dropped: it is held, with the reason.
  assert.equal(report.items.length, 3);
  assert.deepEqual([it.Q9999.outcome, it.Q9999.reason], ["held", "not in the snapshot"]);
  const withEntities = dryRunFiles({ selectionText: selection, wikidataText: fixture("query-snes.json"), entitiesText: fixture("entities-snapshot.json") });
  assert.ok(!withEntities.items.find((i) => i.id === "Q1001").flags.includes("entity_detail_pending"));
  assert.match(reportMarkdown(report, [{ kind: "selection", file: "s.json", sha256: "0" }]), /\| Q1013 \| Zqx Unselected Garden \|/);
});

test("the CLI end to end on fixtures: select, then dry run, writing outside the repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "mgd-b1-"));
  try {
    const node = (...a) => execFileSync(process.execPath, [new URL("./catalog-b1.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), ...a], { encoding: "utf8" });
    const query = new URL("./fixtures/wikidata-b1/query-snes.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const entities = query.replace("query-snes.json", "entities-snapshot.json");
    const catalog = query.replace("query-snes.json", "catalog.json");
    node("select", "--wikidata", query, "--out", join(dir, "selection.json"), "--size", "10", "--seed", "fixture", "--fixed", "Q1009");
    const selection = JSON.parse(readFileSync(join(dir, "selection.json"), "utf8"));
    assert.equal(selection.ids.length, 10);
    assert.match(selection.snapshot.sha256, /^[0-9a-f]{64}$/);
    node("dry-run", "--selection", join(dir, "selection.json"), "--wikidata", query, "--entities", entities, "--catalog", catalog, "--out", join(dir, "report"));
    const report = JSON.parse(readFileSync(join(dir, "report", "dry-run.json"), "utf8"));
    assert.equal(report.totals.items, 10);
    assert.equal(report.totals.releases_created + report.totals.published, 0);
    assert.equal(report.sources.length, 4);
    assert.ok(readFileSync(join(dir, "report", "dry-run.md"), "utf8").startsWith("# M12c-B1 dry run"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fetch refuses without a project contact, batches by 50, waits between requests and backs off", async () => {
  assert.equal(validUserAgent("CatalogResearch/0.1 curl"), false);
  assert.equal(validUserAgent("MyTool/1.0 (no contact here) node/22"), false);
  assert.equal(validUserAgent(undefined), false);
  assert.equal(validUserAgent("MyTool/1.0 (https://example.test/contact) node/22"), true);
  assert.equal(validUserAgent("MyTool/1.0 (ops@example.test) node/22"), true);
  await assert.rejects(fetchEntities(["Q1"], { userAgent: "CatalogResearch/0.1 curl" }), /project contact/);

  let clock = 0;
  const sleeps = [];
  const calls = [];
  const replies = [{ status: 429, headers: { get: () => "3" } }, { status: 200 }, { status: 200 }, { status: 200 }];
  const fetchImpl = async (url, init) => {
    calls.push({ url, agent: init.headers["User-Agent"] });
    const r = replies.shift();
    const ids = new URL(url).searchParams.get("ids").split("|");
    return { ok: r.status === 200, status: r.status, headers: r.headers ?? { get: () => null }, json: async () => ({ entities: Object.fromEntries(ids.map((id) => [id, { id }])) }) };
  };
  const ids = Array.from({ length: 120 }, (_, i) => `Q${i + 1}`);
  const snapshot = await fetchEntities(ids, { userAgent: "MyTool/1.0 (ops@example.test) node/22", fetchImpl, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  assert.equal(snapshot.requests, 3);
  assert.equal(snapshot.ids.length, 120);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.agent === "MyTool/1.0 (ops@example.test) node/22"));
  assert.ok(calls.every((c) => new URL(c.url).searchParams.get("maxlag") === "5" && new URL(c.url).searchParams.get("props") === "info|labels|aliases|claims" && new URL(c.url).searchParams.get("languages").split("|").includes("mul")));
  assert.equal(new URL(calls[0].url).searchParams.get("ids").split("|").length, 50);
  assert.ok(sleeps.includes(3000), "Retry-After is honoured");
  assert.ok(sleeps.filter((ms) => ms === 1000).length >= 2, "at least 1 s between requests");

  // A request that keeps failing stops the fetch, and nothing is returned.
  const failing = async () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) });
  await assert.rejects(fetchEntities(["Q1"], { userAgent: "MyTool/1.0 (ops@example.test) node/22", fetchImpl: failing, now: () => 0, sleep: async () => {} }), /after 5 attempt/);
});

test("Unicode numerals: Ⅱ and Ⅲ collide on the plain key only, and are reported as an artifact", () => {
  const entry = (id, title) => ({ entity_type: "game", external_id: id, flags: [], payload: { title, titles: [title], first_release_date: "1991-12-20", first_release_precision: "day", source: { external_ids: {} } } });
  const report = dryRun({
    selection: { selector: "f", seed: "f", ids: ["Q1", "Q2", "Q3", "Q4"] },
    platformQid: SNES,
    entries: [entry("Q1", "Zqx Rail Baron Ⅱ"), entry("Q2", "Zqx Rail Baron Ⅲ"), entry("Q3", "Zqx Night Ⅱ"), entry("Q4", "Zqx Night II")],
    catalog: { games: [] },
  });
  const it = Object.fromEntries(report.items.map((i) => [i.id, i]));
  assert.deepEqual([it.Q1.flags, it.Q2.flags], [["title_collision_unicode_artifact"], ["title_collision_unicode_artifact"]]);
  assert.equal(it.Q1.readiness, "ready_for_editorial_consideration");
  // "Ⅱ" and "II" are the same title once normalized: a real collision.
  assert.deepEqual([it.Q3.flags, it.Q4.flags], [["title_collision_in_batch"], ["title_collision_in_batch"]]);
  assert.equal(it.Q3.readiness, "needs_review");
  assert.deepEqual(report.collision_groups.map((g) => g.verdict).sort(), ["same_title_needs_review", "unicode_artifact_distinct_titles"]);
});

test("identity keys: Ⅱ is II, Ⅱ and Ⅲ stay distinct, and a trademark sign adds nothing", () => {
  assert.equal(identityTitleKey("Albert Odyssey Ⅱ"), identityTitleKey("Albert Odyssey II"));
  assert.notEqual(identityTitleKey("Super Momotaro Dentetsu Ⅱ"), identityTitleKey("Super Momotaro Dentetsu Ⅲ"));
  assert.notEqual(identityTitleKey("Breath of Fire II"), identityTitleKey("Breath of Fire III"));
  assert.notEqual(identityTitleKey("Breath of Fire Ⅱ"), identityTitleKey("Breath of Fire III"));
  assert.equal(identityTitleKey("Breath of Fire ⅱ"), identityTitleKey("Breath of Fire II"));
  assert.equal(identityTitleKey("Tetris™"), identityTitleKey("Tetris"));
  assert.equal(identityTitleKey("ＳＵＰＥＲ ＭＥＴＲＯＩＤ"), identityTitleKey("Super Metroid"));
});

test("a stated distribution format is held for a person to classify, and listed once per format", () => {
  const j = JSON.parse(fixture("entities-response.json"));
  const fmt = (id) => ({ mainsnak: { property: "P437", datavalue: { value: { "entity-type": "item", id }, type: "wikibase-entityid" }, snaktype: "value" }, rank: "normal" });
  j.entities.Q1001.claims.P437 = [fmt("Q900001"), fmt("Q900002")];
  const entries = parseWikidataEntities(JSON.stringify(j), SNES);
  const e = entries.find((x) => x.external_id === "Q1001");
  assert.deepEqual(e.payload.source.distribution_formats, ["Q900001", "Q900002"]);
  assert.deepEqual(e.flags, ["distribution_format_unclassified"]);
  const report = dryRun({ selection: { selector: "f", seed: "f", ids: ["Q1001"] }, platformQid: SNES, entries, catalog: { games: [] } });
  const [it] = report.items;
  assert.equal(it.readiness, "needs_review");
  assert.deepEqual(it.possible_critical, ["physical_eligibility_unsupported"]);
  assert.deepEqual(report.distribution_formats, {
    Q900001: { items: 1, label: null, class: "unclassified", media: null },
    Q900002: { items: 1, label: null, class: "unclassified", media: null },
  });
  assert.ok(reportMarkdown(report, []).includes("| Q900001 | ? | unclassified | ? | 1 |"));
});

// ---------------------------------------------------------------------------
// Classified distribution formats (checkpoint four)
// ---------------------------------------------------------------------------

const fmtClaim = (id, platforms = [], distributors = []) => ({
  mainsnak: { property: "P437", datavalue: { value: { "entity-type": "item", id }, type: "wikibase-entityid" }, snaktype: "value" },
  rank: "normal",
  ...(platforms.length || distributors.length
    ? {
        qualifiers: {
          ...(platforms.length ? { P400: platforms.map((p) => ({ datavalue: { value: { id: p } } })) } : {}),
          ...(distributors.length ? { P750: distributors.map((p) => ({ datavalue: { value: { id: p } } })) } : {}),
        },
      }
    : {}),
});
const withFormats = (claims) => {
  const j = JSON.parse(fixture("entities-response.json"));
  j.entities.Q1001.claims.P437 = claims;
  const entries = parseWikidataEntities(JSON.stringify(j), SNES);
  return { entries, e: entries.find((x) => x.external_id === "Q1001") };
};

test("every format the SNES pilot states is classified once, and the two classes don't overlap", () => {
  const pilot = ["Q5293", "Q7982", "Q34467", "Q47770", "Q149757", "Q160710", "Q234870", "Q269415", "Q633454", "Q849572", "Q17048824", "Q54820071"];
  assert.deepEqual(Object.keys(DISTRIBUTION_FORMAT_TABLE).sort(), [...pilot].sort());
  assert.deepEqual([...DISTRIBUTION_FORMATS.non_physical].sort(), ["Q269415", "Q54820071"]);
  assert.equal(DISTRIBUTION_FORMATS.physical.length, 10);
  assert.ok(!DISTRIBUTION_FORMATS.physical.some((q) => DISTRIBUTION_FORMATS.non_physical.includes(q)));
  assert.ok(Object.isFrozen(DISTRIBUTION_FORMAT_TABLE) && Object.isFrozen(DISTRIBUTION_FORMAT_TABLE.Q633454));
});

test("a physical format clears only the unclassified flag: the record still needs human physical-release evidence", () => {
  const { entries, e } = withFormats([fmtClaim("Q633454")]);
  assert.deepEqual(e.flags, []);
  assert.deepEqual(e.payload.source.distribution, [{ format: "Q633454", platforms: [], distributors: [] }]);
  const report = dryRun({ selection: { selector: "f", seed: "f", ids: ["Q1001"] }, platformQid: SNES, entries, catalog: { games: [] } });
  assert.equal(report.items[0].readiness, "ready_for_editorial_consideration");
  assert.equal(report.totals.physical_release_evidence_required, 1);
  assert.ok(!JSON.stringify(report).includes("eligible"));
  assert.ok(reportMarkdown(report, []).includes("still needs independent human evidence"));
});

test("digital alongside a physical format isn't a hold; digital only (for this platform or unqualified) is", () => {
  assert.deepEqual(withFormats([fmtClaim("Q633454"), fmtClaim("Q54820071")]).e.flags, ["distribution_also_non_physical"]);
  const digital = withFormats([fmtClaim("Q54820071")]).e;
  assert.deepEqual(digital.flags, ["distribution_non_physical"]);
  assert.deepEqual(withFormats([fmtClaim("Q269415", [SNES])]).e.flags, ["distribution_non_physical"]);
  const report = dryRun({ selection: { selector: "f", seed: "f", ids: ["Q1001"] }, platformQid: SNES, entries: [digital], catalog: { games: [] } });
  assert.deepEqual(report.items[0].possible_critical, ["physical_eligibility_unsupported"]);
});

test("a format qualified with another platform is about that version, and its qualifiers are kept", () => {
  const { e } = withFormats([fmtClaim("Q54820071", ["Q94"], ["Q821067"])]);
  assert.deepEqual(e.flags, []);
  assert.deepEqual(e.payload.source.distribution, [{ format: "Q54820071", platforms: ["Q94"], distributors: ["Q821067"] }]);
  assert.deepEqual(withFormats([fmtClaim("Q7982")]).e.flags, ["distribution_medium_not_platform"]);
  assert.deepEqual(distributionFlags([{ format: "Q999", platforms: [] }], SNES), ["distribution_format_unclassified"]);
});

// ---------------------------------------------------------------------------
// Multiple external ids (checkpoint four)
// ---------------------------------------------------------------------------

const withIds = ({ igdb = [], moby = [] }) => {
  const j = JSON.parse(fixture("entities-response.json"));
  const str = (property, value) => ({ mainsnak: { property, datavalue: { value, type: "string" }, snaktype: "value" }, rank: "normal" });
  j.entities.Q1001.claims.P5794 = igdb.map((v) => str("P5794", v));
  j.entities.Q1001.claims.P11688 = moby.map((v) => str("P11688", v));
  const entries = parseWikidataEntities(JSON.stringify(j), SNES);
  return { entries, e: entries.find((x) => x.external_id === "Q1001") };
};

test("several IGDB or MobyGames ids flag a possible identity conflict; one of each doesn't", () => {
  assert.ok(!withIds({ igdb: ["a"], moby: ["1"] }).e.flags.includes("external_ids_multiple"));
  for (const ids of [{ igdb: ["a", "a--1"] }, { moby: ["1", "2"] }, { igdb: ["a", "b"], moby: ["1"] }]) {
    assert.ok(withIds(ids).e.flags.includes("external_ids_multiple"), JSON.stringify(ids));
  }
  const { entries } = withIds({ igdb: ["power-rangers", "power-rangers--2"], moby: ["60165", "50692"] });
  const report = dryRun({ selection: { selector: "f", seed: "f", ids: ["Q1001"] }, platformQid: SNES, entries, catalog: { games: [] } });
  const [it] = report.items;
  assert.equal(it.readiness, "needs_review");
  assert.deepEqual(it.possible_critical, ["conflicting_identifiers"]);
  assert.ok(it.reasons.some((r) => r.includes("several IGDB or MobyGames ids")));
  assert.equal(report.totals.external_id_conflicts, 1);
  assert.deepEqual(report.external_id_conflicts[0].hints, ["igdb_slug_variants", "mobygames_several"]);
});

test("external-id hints describe the identifiers only", () => {
  assert.equal(externalIdConflict({ igdb: ["a"], mobygames: ["1"] }), null);
  assert.deepEqual(externalIdConflict({ igdb: ["cyber-spin", "shinseiki-gpx-cyber-formula--1"], mobygames: [] }).hints, ["igdb_distinct_slugs"]);
  assert.deepEqual(externalIdConflict({ igdb: ["x", "x--1", "x--2"], mobygames: [] }).hints, ["igdb_slug_variants"]);
});

// ---------------------------------------------------------------------------
// Editorial-review notes (checkpoint four)
// ---------------------------------------------------------------------------

test("an editorial note can add a hold with its reason, never clear a flag or a critical signal", () => {
  const { entries } = withIds({ igdb: ["a", "b"] });
  const selection = { selector: "f", seed: "f", ids: ["Q1001", "Q1002"] };
  const review = {
    records: {
      Q1001: { category: "provider_duplicate_ids", hold: false, reason: "IGDB lists the same game twice." },
      Q1002: { category: "bootleg_candidate", hold: true, reason: "Typed as an unlicensed game." },
    },
    groups: [{ name: "g", members: ["Q1001", "Q1002"], recommendation: "Keep distinct." }],
  };
  const report = dryRun({ selection, platformQid: SNES, entries, catalog: { games: [] }, review });
  const it = Object.fromEntries(report.items.map((i) => [i.id, i]));
  assert.equal(it.Q1001.readiness, "needs_review");
  assert.deepEqual(it.Q1001.possible_critical, ["conflicting_identifiers"]);
  assert.equal(it.Q1002.readiness, "held_for_editor");
  assert.ok(it.Q1002.reasons.at(-1).includes("bootleg_candidate") && it.Q1002.reasons.at(-1).includes("unlicensed"));
  assert.equal(report.totals.readiness.held_for_editor, 1);
  assert.deepEqual(report.editorial_groups, review.groups);
  assert.ok(reportMarkdown(report, []).includes("**g** (Q1001, Q1002): Keep distinct."));
});

test("editorial notes outside the selection, or without a reason or a boolean hold, are refused", () => {
  const { entries } = withIds({});
  const selection = { selector: "f", seed: "f", ids: ["Q1001"] };
  const run = (records) => dryRun({ selection, platformQid: SNES, entries, catalog: { games: [] }, review: { records } });
  assert.throws(() => run({ Q9: { category: "x", hold: true, reason: "r" } }), /outside the selection/);
  assert.throws(() => run({ Q1001: { category: "x", hold: true, reason: " " } }), /need a category/);
  assert.throws(() => run({ Q1001: { category: "x", hold: "yes", reason: "r" } }), /need a category/);
});

test("every exception flag has a reason an editor can read", () => {
  for (const [flag, kind] of Object.entries(FLAGS)) assert.ok(FLAG_REASONS[flag], `${flag} (${kind}) has no reason`);
});

test("the batch migration maps every flag to the same possible critical error as the parser", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261210100300_m12c_b1_m2_review_batches.sql", import.meta.url), "utf8");
  const body = sql.slice(sql.indexOf("create function private.review_critical_signal"), sql.indexOf("revoke all on function private.review_critical_signal"));
  const mapped = Object.fromEntries([...body.matchAll(/when '([a-z_]+)' then '([a-z_]+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(mapped, CRITICAL_SIGNALS);
});

test("a record whose entity detail is pending is never ready, whatever else it shows", () => {
  const report = dryRunFiles({ selectionText: JSON.stringify({ selector: "f", seed: "f", ids: ["Q1009", "Q1013"] }), wikidataText: fixture("query-snes.json"), catalogText: fixture("catalog.json") });
  for (const i of report.items) {
    assert.equal(i.readiness, "pending_detail");
    assert.ok(i.possible_critical.includes("missing_provenance"));
  }
  assert.equal(report.totals.readiness.ready_for_editorial_consideration, 0);
});

// ---------------------------------------------------------------------------
// The risk-assessment contract with batch creation (SQL review of 62267d6, finding 5)
// ---------------------------------------------------------------------------

const B1_DIR = new URL("../supabase/migrations/", import.meta.url);
const m2Sql = () => readFileSync(new URL("20261210100300_m12c_b1_m2_review_batches.sql", B1_DIR), "utf8");
const SNAP = "5b1e2d0a3c4f69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

test("the batch migration knows every parser flag, with the same kind", () => {
  const sql = m2Sql();
  const body = sql.slice(sql.indexOf("create function private.review_flag_kind"), sql.indexOf("create function private.review_critical_signal"));
  const kinds = {};
  for (const m of body.matchAll(/when p_flag in \(([^)]*)\)\s*then '([a-z]+)'/g)) for (const f of m[1].matchAll(/'([a-z_]+)'/g)) kinds[f[1]] = m[2];
  assert.deepEqual(kinds, FLAGS);
});

test("an entry's risk assessment follows the contract the batch validates", () => {
  const entries = parseWikidataEntities(fixture("entities-response.json"), SNES);
  const e = entries.find((x) => x.external_id === "Q1005");
  const a = withRiskAssessment(e, { snapshotSha256: SNAP }).payload.risk_assessment;
  assert.deepEqual(a, {
    contract: "mgd-risk-assessment", version: 1, assessor: "mgd-wikidata-entities", assessor_version: "1",
    source: { provider: "wikidata", external_id: "Q1005", revision: 2005, snapshot_sha256: SNAP },
    flags: ["other_instance_of", "platform_date_before_launch"],
    critical: ["wrong_identity_or_type", "wrong_platform"],
  });
  const sql = m2Sql();
  assert.ok(sql.includes(`a ->> 'contract' is distinct from '${RISK_ASSESSMENT.contract}'`) && sql.includes(`a -> 'version' is distinct from '${RISK_ASSESSMENT.version}'::jsonb`));
  const ignored = entries.find((x) => x.ignore_reason);
  assert.equal(withRiskAssessment(ignored, { snapshotSha256: SNAP }), ignored, "an ignored entry is never a candidate and isn't assessed");
  assert.throws(() => withRiskAssessment(e, { snapshotSha256: "abc" }), /SHA-256/);
  assert.throws(() => withRiskAssessment({ ...e, payload: { ...e.payload, source: { ...e.payload.source, revision: null } } }, { snapshotSha256: SNAP }), /no source revision/);
  assert.throws(() => withRiskAssessment({ ...e, flags: ["made_up_flag"] }, { snapshotSha256: SNAP }), /unknown flags/);
});

test("the end-to-end pgTAP test stages exactly what the parser produces", () => {
  const sql = readFileSync(new URL("../supabase/tests/database/51_b1_review_hardening.test.sql", import.meta.url), "utf8");
  const block = sql.slice(sql.indexOf("-- BEGIN parser-payload"), sql.indexOf("-- END parser-payload"));
  const literal = JSON.parse(/\$p\$(\{.*\})\$p\$/.exec(block)[1]);
  const e = parseWikidataEntities(fixture("entities-response.json"), SNES).find((x) => x.external_id === "Q1005");
  assert.deepEqual(literal, withRiskAssessment(e, { snapshotSha256: SNAP }).payload);
  // The staging path stages that same payload.
  const staged = stagingEntries({ entries: parseWikidataEntities(fixture("entities-response.json"), SNES), ids: ["Q1005"], snapshotSha256: SNAP });
  assert.deepEqual(staged, [{ entity_type: "game", external_id: "Q1005", payload: literal }]);
});

// The keys catalog_import.stage_records accepts (M5b), and never both reasons.
const STAGE_KEYS = new Set(["entity_type", "external_id", "ignore_reason", "payload", "review_reason"]);
const notesFor = (records) => ({ format: "mgd-editorial-review-notes", version: 1, records });

test("staging entries: exactly the selection, assessed, in the shape stage_records accepts", () => {
  const entries = parseWikidataEntities(fixture("entities-response.json"), SNES);
  const ids = ["Q1012", "Q1001", "Q1003", "Q1005", "Q1008"];
  const staged = stagingEntries({ entries, ids, snapshotSha256: SNAP });
  assert.deepEqual(staged.map((e) => e.external_id), ["Q1001", "Q1003", "Q1005", "Q1008", "Q1012"], "numeric id order, nothing outside the selection");
  for (const e of staged) {
    assert.ok(Object.keys(e).every((k) => STAGE_KEYS.has(k)), `${e.external_id}: only the keys stage_records accepts`);
    assert.ok(!("ignore_reason" in e && "review_reason" in e));
    if (e.ignore_reason) assert.equal(e.payload.risk_assessment, undefined, "an ignored entry isn't a candidate");
    else {
      const source = entries.find((x) => x.external_id === e.external_id);
      assert.deepEqual(e.payload.risk_assessment.flags, [...source.flags].sort(), "the parser's flags travel in the assessment");
      assert.equal(e.payload.risk_assessment.source.snapshot_sha256, SNAP);
    }
  }
  assert.equal(staged.find((e) => e.external_id === "Q1003").ignore_reason, "not on this platform");
});

test("staging entries: an editorial hold stages the record held, with its flags kept", () => {
  const entries = parseWikidataEntities(fixture("entities-response.json"), SNES);
  const notes = notesFor({
    Q1012: { category: "duplicate_item", hold: true, reason: "A second item for the same game; held until an editor chooses the canonical identity." },
    Q1001: { category: "duplicate_canonical_candidate", hold: false, reason: "Proposed canonical identity." },
    Q1003: { category: "out_of_scope", hold: true, reason: "Ignored anyway." },
  });
  const staged = byId(stagingEntries({ entries, ids: ["Q1001", "Q1003", "Q1012"], snapshotSha256: SNAP, notes }));
  assert.equal(staged.Q1012.review_reason, "Editorial hold (duplicate_item): A second item for the same game; held until an editor chooses the canonical identity.");
  assert.deepEqual(staged.Q1012.payload.risk_assessment.flags, ["many_platforms", "platform_date_after_era", "year_precision_only"], "a hold never clears a flag");
  assert.equal(staged.Q1001.review_reason, undefined, "a note without a hold changes nothing");
  assert.deepEqual(staged.Q1001.payload, withRiskAssessment(entries.find((e) => e.external_id === "Q1001"), { snapshotSha256: SNAP }).payload);
  assert.equal(staged.Q1003.review_reason, undefined, "an ignored entry stays ignored and isn't also held");
  const long = stagingEntries({ entries, ids: ["Q1001"], snapshotSha256: SNAP, notes: notesFor({ Q1001: { category: "x", hold: true, reason: "y".repeat(400) } }) });
  assert.equal(long[0].review_reason.length, HOLD_REASON_MAX);
});

test("staging entries: refused when the snapshot, selection or notes don't fit", () => {
  const entries = parseWikidataEntities(fixture("entities-response.json"), SNES);
  assert.throws(() => stagingEntries({ entries, ids: ["Q1001", "Q9999"], snapshotSha256: SNAP }), /lacks 1 selected id\(s\): Q9999/);
  assert.throws(() => stagingEntries({ entries, ids: ["Q1001", "Q1001"], snapshotSha256: SNAP }), /distinct ids/);
  assert.throws(() => stagingEntries({ entries: [...entries, entries[0]], ids: ["Q1001"], snapshotSha256: SNAP }), /appears twice/);
  assert.throws(() => stagingEntries({ entries, ids: ["Q1001"], snapshotSha256: SNAP, notes: notesFor({ Q1002: { hold: true, reason: "x" } }) }), /isn't in the selection/);
  assert.throws(() => stagingEntries({ entries, ids: ["Q1001"], snapshotSha256: SNAP, notes: notesFor({ Q1001: { hold: true, reason: " " } }) }), /needs a reason/);
  assert.throws(() => stagingEntries({ entries, ids: ["Q1001"], snapshotSha256: SNAP, notes: { format: "other", version: 1, records: {} } }), /editorial-notes/);
  assert.throws(() => stagingEntries({ entries, ids: ["Q1001"], snapshotSha256: "abc" }), /SHA-256/);
  const noRevision = entries.map((e) => (e.external_id === "Q1001" ? { ...e, payload: { ...e.payload, source: { ...e.payload.source, revision: null } } } : e));
  assert.throws(() => stagingEntries({ entries: noRevision, ids: ["Q1001"], snapshotSha256: SNAP }), /no source revision/, "the 2026-11-20 14:11 snapshot shape is refused");
});

test("the importer's --entities dry run stages the selection without a database", () => {
  const dir = mkdtempSync(join(tmpdir(), "mgd-b1-stage-"));
  try {
    const snapshot = join(dir, "entities.json");
    const selection = join(dir, "selection.json");
    const notes = join(dir, "notes.json");
    writeFileSync(snapshot, fixture("entities-response.json"));
    writeFileSync(selection, JSON.stringify({ platform: "snes", ids: ["Q1001", "Q1005", "Q1012"] }));
    writeFileSync(notes, JSON.stringify(notesFor({ Q1012: { category: "duplicate_item", hold: true, reason: "Held for the test." } })));
    const run = (extra) => execFileSync(process.execPath, [new URL("./catalog-import.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "import", "--provider", "wikidata", "--platform", "snes", "--entities",
      "--file", snapshot, "--ids", selection, "--terms-file", snapshot, "--reason", "test", "--dry-run", ...extra], { encoding: "utf8", env: { ...process.env, CATALOG_IMPORTER_DATABASE_URL: "" } });
    const out = run(["--notes", notes]);
    const sha = createHash("sha256").update(readFileSync(snapshot)).digest("hex");
    // The run records the file name only, never the operator's local path (B1 run of 2026-11-20).
    assert.match(out, new RegExp(`^entities\\.json: 12 entries, 3 in this import, sha256 ${sha}`));
    assert.ok(snapshot.includes("\\") || snapshot.includes("/"));
    const report = JSON.parse(out.slice(out.indexOf("{")));
    assert.equal(report.entries, 3);
    assert.equal(report.held, 1);
    assert.match(report.slice, /^ids:[0-9a-f]{64};notes:[0-9a-f]{64}$/);
    assert.equal(report.sample[0].payload.risk_assessment.source.snapshot_sha256, sha, "each assessment names the snapshot the run is started with");
    assert.throws(() => execFileSync(process.execPath, [new URL("./catalog-import.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "import", "--provider", "wikidata", "--platform", "snes", "--entities",
      "--file", snapshot, "--terms-file", snapshot, "--reason", "test", "--dry-run"], { stdio: "pipe" }), /needs --ids/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1 staging and its clearance refuse every stack but the editorial ones (B1, and the M15 pilot)", () => {
  for (const command of [["clear-wikidata", "--terms-file", "x"], ["stage", "--entities", "x", "--selection", "x", "--notes", "x", "--terms-file", "x", "--reason", "x"], ["report"]]) {
    for (const stack of ["scratch", "test", "dev"]) {
      assert.throws(() => execFileSync(process.execPath, [new URL("./catalog-b1.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), ...command], { stdio: "pipe", env: { ...process.env, MGD_STACK: stack } }),
        (error) => /writes only to an editorial stack|isn't prepared/.test(error.stderr.toString()), `${command[0]} on ${stack}`);
    }
  }
});
