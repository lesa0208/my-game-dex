// Unit tests for the import snapshot parsers (M5b). Synthetic data only.
import assert from "node:assert/strict";
import test from "node:test";
import { compactTitleKey, displayTitle, extendSelection, legacyTitleKey, mainTitleKey, parseNoIntro, parseWikidata, pilotSelection, pilotSlice, titleKey } from "./catalog-import-sources.mjs";

const dat = (...names) => `<?xml version="1.0"?><datafile><header><name>SNES</name></header>${names
  .map((n) => (Array.isArray(n) ? n : [n]))
  .map(([n, extra = ""]) => `<game name="${n}"><description>${n}</description><rom name="${n}.sfc" size="4" crc="00000000" sha1="${"0".repeat(40)}"${extra}/></game>`)
  .join("")}</datafile>`;

test("No-Intro: revisions and alternate dumps are one release", () => {
  const entries = parseNoIntro(dat("Super Metroid (Japan, USA) (En,Ja)", "Super Metroid (Japan, USA) (En,Ja) (Rev 1)", "Super Metroid (Japan, USA) (En,Ja) (Alt)"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].external_id, "Super Metroid (Japan, USA) (En,Ja)");
  assert.equal(entries[0].payload.roms.length, 3);
});

test("No-Intro: regions map only when they agree, and nothing else is invented", () => {
  const [eu, ju, odd] = parseNoIntro(dat("A Game (Europe) (En,Fr,De)", "B Game (Japan, USA)", "C Game (Brazil)"));
  assert.deepEqual(eu.payload.region_codes, ["pal"]);
  assert.deepEqual(eu.payload.languages, ["en", "fr", "de"]);
  assert.deepEqual(ju.payload.region_codes, ["ntsc-j", "ntsc-uc"]);
  assert.deepEqual(odd.payload.region_codes, ["unknown"]);
  for (const e of [eu, ju, odd]) for (const k of ["edition_name", "edition_kind", "media_count", "packaging", "serial"]) assert.equal(e.payload[k], undefined);
});

test("No-Intro: a serial is kept only when the DAT states it", () => {
  const [entry, none] = parseNoIntro(dat(["Super Metroid (USA)", ' serial="SNS-RI-USA"'], ["Z Game (USA)", ' serial="!none"']));
  assert.equal(entry.payload.serial, "SNS-RI-USA");
  assert.equal(none.payload.serial, undefined);
});

test("No-Intro: BIOS entries and non-game categories are ignored", () => {
  const text = '<datafile><game name="[BIOS] Boot ROM (Japan)"><rom name="a"/></game><game name="Tool (USA)"><category>Applications</category><rom name="b"/></game>'
    + '<game name="Early (USA)"><category>Preproduction</category><rom name="c"/></game><game name="Real (USA)"><category>Games</category><rom name="d"/></game></datafile>';
  const byTitle = Object.fromEntries(parseNoIntro(text).map((e) => [e.payload.title, e]));
  assert.equal(byTitle["Boot ROM"].ignore_reason, "not a game");
  assert.equal(byTitle.Tool.ignore_reason, "not a game");
  assert.equal(byTitle.Early.ignore_reason, "prototype");
  assert.equal(byTitle.Real.ignore_reason, undefined);
  assert.equal(byTitle.Real.payload.category, "Games");
});

test("No-Intro: prototypes, pirate copies, hacks and bad dumps are ignored; review candidates are flagged", () => {
  const byName = Object.fromEntries(parseNoIntro(dat("P (USA) (Proto)", "Q (USA) (Beta 2)", "R (Asia) (Pirate)", "S (USA) [b]", "T (USA) (Unl)", "U (World) (Aftermarket)", "V (USA) (Demo)")).map((e) => [e.payload.title, e]));
  assert.equal(byName.P.ignore_reason, "prototype");
  assert.equal(byName.Q.ignore_reason, "prototype");
  assert.equal(byName.R.ignore_reason, "pirate copy");
  assert.equal(byName.S.ignore_reason, "bad dump");
  for (const k of ["T", "U", "V"]) assert.equal(byName[k].ignore_reason, undefined);
  assert.deepEqual(byName.T.payload.flags, ["Unl"]);
  assert.deepEqual(byName.U.payload.flags, ["Aftermarket"]);
});

test("No-Intro: a trailing article is moved back, and entities are decoded", () => {
  assert.equal(displayTitle("Legend of Zelda, The - A Link to the Past"), "The Legend of Zelda - A Link to the Past");
  const [entry] = parseNoIntro(dat("Tom &amp; Jerry (USA)"));
  assert.equal(entry.payload.title, "Tom & Jerry");
});

test("No-Intro: rejects a file that isn't a DAT", () => {
  assert.throws(() => parseNoIntro("<html></html>"), /not a Logiqx DAT/);
});

const sparql = (rows) => JSON.stringify({ results: { bindings: rows } });
const row = (qid, label, date, precision, aliases = "") => ({
  item: { value: `http://www.wikidata.org/entity/${qid}` },
  itemLabel: { value: label },
  ...(date ? { date: { value: date }, precision: { value: String(precision) } } : {}),
  aliases: { value: aliases },
});

test("Wikidata: one game per item, with the earliest stated date at its precision", () => {
  const [entry] = parseWikidata(sparql([row("Q1", "Super Metroid", "1994-04-18T00:00:00Z", 11, "Metroid 3|Super Metroid"), row("Q1", "Super Metroid", "1994-03-19T00:00:00Z", 11)]));
  assert.equal(entry.external_id, "Q1");
  assert.deepEqual(entry.payload, { title: "Super Metroid", titles: ["Metroid 3", "Super Metroid"], first_release_date: "1994-03-19", first_release_precision: "day" });
});

test("Wikidata: a year-only date stays a year, and an item without an English label is ignored", () => {
  const [year, unlabelled] = parseWikidata(sparql([row("Q2", "Pilotwings", "1990-01-01T00:00:00Z", 9), row("Q3", "Q3", null)]));
  assert.equal(year.payload.first_release_precision, "year");
  assert.equal(unlabelled.ignore_reason, "no English label");
});

test("Pilot selection is deterministic, bounded and keeps title groups whole", () => {
  const games = parseWikidata(sparql([row("Q1", "Alpha", null), row("Q2", "Twin", null), row("Q3", "Twin", null), row("Q4", "Gamma", null)]));
  const releases = parseNoIntro(dat("Alpha (USA)", "Alpha (Japan)", "Twin (USA)", "Gamma (Europe)", "Nobody (USA)"));
  const a = pilotSelection(games, releases, { maxGames: 3, maxReleases: 4 });
  assert.deepEqual(a, pilotSelection(games, releases, { maxGames: 3, maxReleases: 4 }));
  assert.ok(a.releases.length <= 4 && a.games.length <= 3);
  assert.ok(a.releases.includes("Twin (USA)") && a.games.includes("Q2") && a.games.includes("Q3"), "the ambiguous title is taken first");
  assert.equal(a.releases.includes("Alpha (USA)"), a.releases.includes("Alpha (Japan)"), "regional variants stay together");
});

test("Pilot slice and title keys", () => {
  const entries = parseNoIntro(dat("Super Metroid (USA)", "The Lost Vikings (USA)", "Axelay (USA)"));
  assert.deepEqual(pilotSlice(entries, "S").map((e) => e.payload.title), ["Super Metroid"]);
  assert.equal(titleKey("Super Metroid: Rêve"), "super-metroid-reve");
});

test("No-Intro: digital and other-platform re-releases are never cartridge candidates", () => {
  const byId = Object.fromEntries(parseNoIntro(dat(
    "Super Mario RPG - Legend of the Seven Stars (USA, Europe) (Virtual Console)",
    "Soccer Kid (World) (En,Fr,De,Es,It) (GOG)",
    "Soccer Kid (World) (En,Fr,De,Es,It) (Evercade)",
    "David Crane's Amazing Tennis (USA) (Arcade)",
    "Super Mario Collection (Japan) (Switch Online)",
    "Super Mario Collection (Japan) (Super Mario Collection - 25th Anniversary)",
    "Game (USA) (Virtual Console, Classic Mini, Switch Online)",
  )).map((e) => [e.external_id, e]));
  assert.equal(byId["Super Mario RPG - Legend of the Seven Stars (USA, Europe) (Virtual Console)"].ignore_reason, "digital release");
  assert.equal(byId["Soccer Kid (World) (En,Fr,De,Es,It) (GOG)"].ignore_reason, "digital release");
  assert.equal(byId["Soccer Kid (World) (En,Fr,De,Es,It) (Evercade)"].ignore_reason, "release for another platform");
  assert.equal(byId["David Crane's Amazing Tennis (USA) (Arcade)"].ignore_reason, "release for another platform");
  assert.equal(byId["Super Mario Collection (Japan) (Switch Online)"].ignore_reason, "digital release");
  assert.equal(byId["Super Mario Collection (Japan) (Super Mario Collection - 25th Anniversary)"].ignore_reason, undefined, "a compilation name alone never rejects");
  assert.equal(byId["Super Mario Collection (Japan) (Super Mario Collection - 25th Anniversary)"].review_reason,
    "dumped from a later compilation, platform unconfirmed: Super Mario Collection - 25th Anniversary");
  assert.equal(byId["Game (USA) (Virtual Console, Classic Mini, Switch Online)"].ignore_reason, "digital release");
});

test("No-Intro: Nintendo Power and unrecognised tags are held for an editor; physical re-releases are flagged", () => {
  const byId = Object.fromEntries(parseNoIntro(dat("Super Mario Collection (Japan) (NP)", "Odd Game (USA) (Mystery Edition)", "Reprint (USA) (Limited Run Games)", "Plain (Japan)", "Promo (USA) (Competition Cart, Nintendo Power mail-order)"))
    .map((e) => [e.external_id, e]));
  assert.equal(byId["Super Mario Collection (Japan) (NP)"].review_reason, "Nintendo Power flash release");
  assert.equal(byId["Odd Game (USA) (Mystery Edition)"].review_reason, "unrecognised tag: Mystery Edition");
  assert.equal(byId["Reprint (USA) (Limited Run Games)"].payload.release_type, "re-release");
  assert.deepEqual(byId["Reprint (USA) (Limited Run Games)"].payload.flags, ["Limited Run Games"]);
  assert.equal(byId["Reprint (USA) (Limited Run Games)"].review_reason, undefined);
  assert.equal(byId["Plain (Japan)"].payload.release_type, "original");
  assert.deepEqual(byId["Promo (USA) (Competition Cart, Nintendo Power mail-order)"].payload.flags, ["Competition Cart", "Nintendo Power mail-order"]);
  for (const e of Object.values(byId)) for (const k of ["edition_name", "edition_kind", "media_count", "packaging"]) assert.equal(e.payload[k], undefined);
});

test("Title keys: punctuation, separators, articles and numbers, conservatively", () => {
  const same = [
    ["Clay Fighter 2: Judgment Clay", "Clay Fighter 2 - Judgment Clay"],
    ["Mask, The", "The Mask"],
    ["The Irem Skins Game", "Irem Skins Game"],
    ["Breath of Fire II", "Breath of Fire 2"],
    ["Jurassic Park Part 2: The Chaos Continues", "Jurassic Park 2 - The Chaos Continues"],
    ["David Crane’s Amazing Tennis", "David Crane's Amazing Tennis"],
    ["Tom & Jerry", "Tom and Jerry"],
    ["Pokémon", "Pokemon"],
  ];
  for (const [a, b] of same) assert.equal(titleKey(a), titleKey(b), `${a} = ${b}`);
  const different = [
    ["Mega Man X", "Mega Man 10"],
    ["Ultima V", "Ultima 5"],
    ["A.S.P. Air Strike Patrol", "S.P. Air Strike Patrol"],
    ["Final Fantasy III", "Final Fantasy VI"],
  ];
  for (const [a, b] of different) assert.notEqual(titleKey(a), titleKey(b), `${a} != ${b}`);
  assert.equal(titleKey("スーパーメトロイド"), null);
  assert.equal(mainTitleKey("Breath of Fire II - Shimei no Ko"), "breath-of-fire-2");
  assert.equal(mainTitleKey("Super Metroid"), null);
});

test("Wikidata: romanized and other Latin-script titles are alternate titles; Japanese labels are kept", () => {
  const [entry] = parseWikidata(sparql([{ ...row("Q9", "Bike Daisuki!", null), romanized: { value: "Baiku Daisuki! Hashiriya Tamashii" }, otherLabels: { value: "Bike Daisuki (de)" }, jaLabels: { value: "バイク大好き!走り屋魂" } }]));
  assert.ok(entry.payload.titles.includes("Baiku Daisuki! Hashiriya Tamashii"));
  assert.ok(entry.payload.titles.includes("Bike Daisuki (de)"));
  assert.deepEqual(entry.payload.ja_titles, ["バイク大好き!走り屋魂"]);
});

test("Extending a selection keeps its release entries and adds only newly matching games", () => {
  const games = parseWikidata(sparql([row("Q1", "Alpha", null), row("Q2", "Clay Fighter 2: Judgment Clay", null), row("Q3", "Breath of Fire II", null)]));
  const releases = parseNoIntro(dat("Alpha (USA)", "Clay Fighter 2 - Judgment Clay (USA)", "Breath of Fire II - Shimei no Ko (Japan)"));
  const original = { seed: "s", games: ["Q1"], releases: releases.map((r) => r.external_id) };
  const extended = extendSelection(original, games, releases);
  assert.deepEqual(extended.releases, original.releases);
  assert.deepEqual(extended.added, { matched: ["Q2"], suggested: ["Q3"] });
  assert.deepEqual(original.games, ["Q1"], "the earlier selection is unchanged");
});

test("No-Intro: only a named digital service or platform rejects; generic words and later publishers hold", () => {
  const byId = Object.fromEntries(parseNoIntro(dat(
    "Mega Man X (USA) (Mega Man X Legacy Collection)", "Aladdin (USA) (Disney Classic Games)", "Game (USA) (QUByte Classics)",
    "Game (Japan) (Switch)", "Anniversary Edition (USA)", "Game Collection (Europe)",
  )).map((e) => [e.external_id, e]));
  assert.match(byId["Mega Man X (USA) (Mega Man X Legacy Collection)"].review_reason, /^dumped from a later compilation/);
  assert.equal(byId["Mega Man X (USA) (Mega Man X Legacy Collection)"].ignore_reason, undefined);
  assert.equal(byId["Aladdin (USA) (Disney Classic Games)"].review_reason, "unrecognised tag: Disney Classic Games");
  assert.match(byId["Game (USA) (QUByte Classics)"].review_reason, /^later publisher/);
  assert.equal(byId["Game (Japan) (Switch)"].ignore_reason, "release for another platform");
  for (const id of ["Anniversary Edition (USA)", "Game Collection (Europe)"]) {
    assert.equal(byId[id].ignore_reason, undefined, `a title word never classifies: ${id}`);
    assert.equal(byId[id].review_reason, undefined, `a title word never holds: ${id}`);
  }
});

test("No-Intro: HOT B and Activision are publisher variants, and the classification is part of the entry", () => {
  const [activision, hot] = parseNoIntro(dat("Super Shanghai - Dragon's Eye (Japan) (Activision)", "Super Shanghai - Dragon's Eye (Japan) (HOT B)"));
  assert.deepEqual(activision.payload.flags, ["publisher: Activision"]);
  assert.deepEqual(hot.payload.flags, ["publisher: HOT B"]);
  assert.equal(hot.review_reason, undefined);
  assert.equal(hot.payload.publisher_name, undefined, "a publisher tag isn't stored as the release's publisher");
  assert.equal(hot.payload.classification, "candidate");
  const [vc] = parseNoIntro(dat("Game (USA) (Virtual Console)"));
  assert.equal(vc.payload.classification, "ignored: digital release");
});

test("Compact title keys ignore word breaks only", () => {
  assert.equal(compactTitleKey("ClayFighter 2: Judgment Clay"), compactTitleKey("Clay Fighter 2 - Judgment Clay"));
  assert.equal(compactTitleKey("Super B.C. Kid"), compactTitleKey("Super BC Kid"));
  assert.notEqual(compactTitleKey("Ultima VI: The False Prophet"), compactTitleKey("Ultima - The False Prophet"));
  assert.notEqual(compactTitleKey("Ballz 3D"), compactTitleKey("Ballz"));
  assert.notEqual(compactTitleKey("Mega Man X"), compactTitleKey("Mega Man 10"));
});

test("Selections record their selector, and version 1 keeps the pilot's title key", () => {
  const games = parseWikidata(sparql([row("Q1", "Alpha", null)]));
  const releases = parseNoIntro(dat("Alpha (USA)"));
  assert.equal(pilotSelection(games, releases).selector.version, 2);
  assert.equal(pilotSelection(games, releases, { selectorVersion: 1 }).selector.version, 1);
  assert.equal(legacyTitleKey("Breath of Fire II"), "breath-of-fire-ii");
  assert.throws(() => pilotSelection(games, releases, { selectorVersion: 9 }), /unknown selector version/);
});
