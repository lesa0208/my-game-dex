/**
 * M12c-B1 checkpoint one: Wikidata entity records as import entries. Pure functions: no
 * network and no database.
 *
 * Input is Wikidata entity JSON, in any of the shapes it comes in:
 *   - a `wbgetentities` or `Special:EntityData` response: { entities: { Q1: {...}, ... } };
 *   - this project's entity snapshot: { format: "mgd-wikidata-entities", responses: [ <response>, ... ] };
 *   - the weekly JSON dump, one entity per line inside "[" and "]", lines ending in ",".
 *
 * Each entity becomes one entry in the shape the M5b importer already stages
 * ({ entity_type: "game", external_id, payload, ignore_reason?, flags }). The importer's
 * game functions read only payload.title, payload.titles and the first-release date, so
 * everything else sits under payload.source for editors and later milestones: every
 * platform, the dated releases with their platform and place qualifiers, developers,
 * publishers, genres and the IGDB and MobyGames ids Wikidata supplies (CC0 values; no
 * provider is contacted).
 *
 * Nothing here decides that a physical release exists. A platform statement (P400) says
 * the game exists on a platform; a release date with a place qualifier is still only a
 * date. Physical releases are editors' work (M11b-0, M12c-A).
 */
import { createHash } from "node:crypto";

import { compactTitleKey, mainTitleKey, titleKey } from "./catalog-import-sources.mjs";

/** Wikidata items and properties used here. */
export const WD = {
  videoGame: "Q7889",
  instanceOf: "P31",
  platform: "P400",
  publicationDate: "P577",
  placeOfPublication: "P291",
  distributedBy: "P750",
  developer: "P178",
  publisher: "P123",
  genre: "P136",
  romanizedJapanese: "P2125",
  distributionFormat: "P437",
  igdbGameId: "P5794",
  mobyGamesGameId: "P11688",
  mobyGamesGameIdFormer: "P1933",
};

/** Latin-script label languages kept as alternate titles, as the query-based parser does. */
const LATIN_LABELS = ["de", "fr", "es", "it", "nl", "pt", "sv"];

/**
 * Plausible years for a platform's own releases, for flags only. Launch dates are the
 * first launch anywhere (Super Famicom 1990-11-21, Famicom 1983-07-15, Famicom Disk
 * System 1986-02-21, PlayStation 1994-12-03). The end is a generous heuristic, not a
 * fact: a later date is flagged for a person to look at, never rejected.
 */
export const PLATFORM_ERAS = {
  Q183259: { slug: "snes", launch: "1990-11-21", lateAfter: "2000-12-31" },
  Q172742: { slug: "nes", launch: "1983-07-15", lateAfter: "1995-12-31" },
  Q135321: { slug: "famicom-disk-system", launch: "1986-02-21", lateAfter: "1993-12-31" },
  Q10677: { slug: "playstation", launch: "1994-12-03", lateAfter: "2006-12-31" },
};

/**
 * How much a flag matters for review (M12c-B1 § 4). "exception" sends the entry to full
 * human review; "info" is shown, nothing more.
 */
export const FLAGS = {
  mul_label_only: "exception",
  no_release_date: "exception",
  year_precision_only: "exception",
  platform_date_before_launch: "exception",
  platform_date_after_era: "exception",
  other_instance_of: "exception",
  distribution_format_unclassified: "exception",
  distribution_non_physical: "exception",
  external_ids_multiple: "exception",
  entity_detail_pending: "exception",
  title_collision_in_batch: "exception",
  external_id_shared_in_batch: "exception",
  catalog_title_match_same_platform: "exception",
  catalog_title_match_other_platform: "info",
  title_collision_unicode_artifact: "info",
  catalog_source_id_linked: "info",
  many_platforms: "info",
  distribution_also_non_physical: "info",
  distribution_medium_not_platform: "info",
};

/**
 * Why a flag holds or marks a record, in words an editor can act on. Every hold in a dry run
 * is one or more of these (or an editorial-review note), never a bare status.
 */
export const FLAG_REASONS = {
  mul_label_only: "Title comes only from Wikidata's language-neutral label; an English title needs confirming.",
  no_release_date: "No release date stated; the release (and that it happened at all) needs evidence.",
  year_precision_only: "Release date is only a year; the date needs a precise source.",
  platform_date_before_launch: "The platform release date is before the platform launched: possibly the wrong platform.",
  platform_date_after_era: "The platform release date is long after the platform's era: an aftermarket or late release, a reissue or a data error; the specific physical release needs evidence.",
  other_instance_of: "Wikidata also types it as something other than a video game (for example an unlicensed or pirate game, software or a compilation).",
  distribution_format_unclassified: "States a distribution format nobody has classified yet.",
  distribution_non_physical: "Every distribution format stated for this platform is non-physical (digital): possibly a digital-only title on this platform.",
  external_ids_multiple: "Carries several IGDB or MobyGames ids: possibly provider duplicates, per-platform or regional records, or distinct games merged into one item.",
  entity_detail_pending: "Only query-snapshot fields are available; the full entity record is missing.",
  title_collision_in_batch: "Another record in this batch has the same title key: a possible duplicate or a distinct game with the same name.",
  external_id_shared_in_batch: "Shares an IGDB or MobyGames id with another record in this batch.",
  catalog_title_match_same_platform: "A catalog game on the same platform has the same title.",
  catalog_title_match_other_platform: "A catalog game on another platform has the same title.",
  title_collision_unicode_artifact: "Collided only under the old key, which dropped a character such as \"Ⅱ\"; the titles differ.",
  catalog_source_id_linked: "Its Wikidata id is already linked to a catalog game.",
  many_platforms: "Stated on more than four platforms: the item may describe a franchise entry with several distinct versions.",
  distribution_also_non_physical: "Also states a digital distribution format; that alone doesn't rule out a physical release.",
  distribution_medium_not_platform: "States a physical medium this platform doesn't use (for example a disc for a cartridge system): the statement is about another platform's version.",
};

/**
 * Critical errors (M12c-B1, A-4 and § 4 of the checkpoint-two brief). A batch can't be
 * approved while any is unresolved, whatever its sample says. They are decided by a person;
 * the flags below only point to where one may be.
 */
export const CRITICAL_ERRORS = {
  wrong_identity_or_type: "Incorrect game identity or game type (not a game, a compilation or edition taken for a game, two games as one)",
  wrong_platform: "Wrong platform association",
  physical_eligibility_unsupported: "Physical-catalog eligibility not supported (digital-only, broadcast, prototype, homebrew, unreleased)",
  distinct_games_merged: "Distinct games merged into one identity",
  conflicting_duplicate_identities: "Duplicate identities that would create conflicting canonical games",
  conflicting_identifiers: "Conflicting authoritative identifiers",
  missing_provenance: "Missing provenance for a required validation fact",
};

/**
 * Wikidata distribution formats (P437), classified once per format, never guessed. The labels
 * and descriptions are the ones Wikidata returned on 2026-11-20 for the 12 formats the SNES
 * pilot's entities state (wikidata-formats-2026-11-20T18-32-38-232Z.json, sha256 93797a67…ff1c7).
 * A format not in this table is flagged "distribution_format_unclassified".
 *
 * What a classification means, and doesn't:
 *   - "physical" says the format is a physical medium. It is not proof that this game had a
 *     physical retail release on this platform (R-2, R-8): a statement may describe another
 *     platform's version, a reissue or a prototype, and every specific physical release still
 *     needs independent human evidence. It only clears the "unclassified" flag.
 *   - "non_physical" says the format is digital. A game that also states a physical format
 *     isn't held for it (only "distribution_also_non_physical", info): a digital re-release
 *     says nothing against an older physical one.
 * `media` is the medium kind, compared with the platform's own media (PLATFORM_MEDIA) only to
 * point out statements about other platforms' versions.
 */
export const DISTRIBUTION_FORMAT_TABLE = Object.freeze({
  Q5293: Object.freeze({ label: "floppy disk", class: "physical", media: "floppy_disk" }),
  Q7982: Object.freeze({ label: "CD-ROM", class: "physical", media: "optical_disc" }),
  Q34467: Object.freeze({ label: "compact disc", class: "physical", media: "optical_disc" }),
  Q47770: Object.freeze({ label: "Blu-ray Disc", class: "physical", media: "optical_disc" }),
  Q149757: Object.freeze({ label: "compact cassette", class: "physical", media: "tape" }),
  Q160710: Object.freeze({ label: "read-only memory", class: "physical", media: "rom_unspecified" }),
  Q234870: Object.freeze({ label: "optical disc", class: "physical", media: "optical_disc" }),
  Q269415: Object.freeze({ label: "digital distribution", class: "non_physical", media: "digital" }),
  Q633454: Object.freeze({ label: "ROM cartridge", class: "physical", media: "cartridge" }),
  Q849572: Object.freeze({ label: "GD-ROM", class: "physical", media: "optical_disc" }),
  Q17048824: Object.freeze({ label: "Super Nintendo Entertainment System Game Pak", class: "physical", media: "cartridge" }),
  Q54820071: Object.freeze({ label: "digital download", class: "non_physical", media: "digital" }),
});

const formatsOfClass = (c) => Object.freeze(Object.keys(DISTRIBUTION_FORMAT_TABLE).filter((q) => DISTRIBUTION_FORMAT_TABLE[q].class === c));
export const DISTRIBUTION_FORMATS = Object.freeze({ physical: formatsOfClass("physical"), non_physical: formatsOfClass("non_physical") });

/** The physical media a platform's own retail games use ("rom_unspecified" is compatible with a cartridge system). */
export const PLATFORM_MEDIA = {
  Q183259: ["cartridge", "rom_unspecified"],
  Q172742: ["cartridge", "rom_unspecified"],
  Q135321: ["floppy_disk"],
  Q10677: ["optical_disc"],
};

/** Flags that may indicate a critical error: an item carrying one can't be ready until a person resolves it. */
export const CRITICAL_SIGNALS = {
  entity_detail_pending: "missing_provenance",
  title_collision_in_batch: "conflicting_duplicate_identities",
  external_id_shared_in_batch: "conflicting_identifiers",
  external_ids_multiple: "conflicting_identifiers",
  catalog_title_match_same_platform: "conflicting_duplicate_identities",
  other_instance_of: "wrong_identity_or_type",
  distribution_format_unclassified: "physical_eligibility_unsupported",
  distribution_non_physical: "physical_eligibility_unsupported",
  platform_date_before_launch: "wrong_platform",
  platform_date_after_era: "physical_eligibility_unsupported",
};

/**
 * The title key for identity checks: compatibility-normalized first (NFKC), so "Ⅱ" is "II"
 * and no longer vanishes. "™" and "℠" become a space first, since NFKC would turn "Tetris™"
 * into "TetrisTM". B1-M0 proposes exactly the same for the database keys.
 */
export const identityTitleKey = (title) => titleKey(String(title ?? "").replace(/[™℠]/gu, " ").normalize("NFKC"));

const PRECISION = { 9: "year", 10: "month", 11: "day" };
const RANK = { day: 3, month: 2, year: 1 };
const MAX_DATES = 40;

/** Every entity object in the input, whatever its shape. */
export function entityObjects(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    const data = JSON.parse(text);
    const responses = data.format === "mgd-wikidata-entities" ? data.responses ?? [] : [data];
    return responses.flatMap((r) => Object.entries(r?.entities ?? {}).map(([key, e]) => ({ key, ...e })));
  }
  // The dump: an array with one entity per line.
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (!line || line === "[" || line === "]") continue;
    out.push(JSON.parse(line));
  }
  return out;
}

const statements = (entity, property) => (entity.claims?.[property] ?? []).filter((s) => s.rank !== "deprecated");
const itemIds = (entity, property) => [...new Set(statements(entity, property).map((s) => s.mainsnak?.datavalue?.value?.id).filter(Boolean))];
const strings = (entity, property) => [...new Set(statements(entity, property).map((s) => s.mainsnak?.datavalue?.value).filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()))];
const qualifierIds = (statement, property) => (statement.qualifiers?.[property] ?? []).map((q) => q.datavalue?.value?.id).filter(Boolean);

/** A Wikidata time value as { value, precision }, at its stated precision; null if unusable. */
export function timeValue(value) {
  const precision = PRECISION[value?.precision];
  const m = /^\+(\d{4})-(\d{2})-(\d{2})T/.exec(value?.time ?? "");
  if (!precision || !m || Number(m[1]) < 1950) return null;
  const date = precision === "day" ? `${m[1]}-${m[2]}-${m[3]}` : precision === "month" ? `${m[1]}-${m[2]}-01` : `${m[1]}-01-01`;
  return { value: date, precision };
}

/**
 * The earliest date, preferring the most precise one on that day; a year or month that
 * contains a more precise date gives way to it (the M12c-A rule, as in parseWikidata).
 */
export function earliestDate(dates) {
  const sorted = [...dates].sort((a, b) => a.value.localeCompare(b.value) || (RANK[b.precision] ?? 0) - (RANK[a.precision] ?? 0));
  let earliest = sorted[0] ?? null;
  if (earliest && earliest.precision !== "day") {
    const prefix = earliest.value.slice(0, earliest.precision === "year" ? 4 : 7);
    const finer = sorted.filter((d) => (RANK[d.precision] ?? 0) > (RANK[earliest.precision] ?? 0) && d.value.startsWith(prefix));
    if (finer.length) earliest = finer.sort((a, b) => a.value.localeCompare(b.value) || (RANK[b.precision] ?? 0) - (RANK[a.precision] ?? 0))[0];
  }
  return earliest;
}

/**
 * One entity as an import entry for one platform's run. Hard problems set ignore_reason
 * (the importer stages the entry and ignores it); suspicious ones add flags.
 */
export function entityToEntry(entity, platformQid) {
  const qid = entity.id ?? entity.key;
  const entry = { entity_type: "game", external_id: qid, payload: {}, flags: [] };
  if (!/^Q[0-9]+$/.test(qid ?? "") || "missing" in entity) {
    entry.ignore_reason = "missing entity";
    return entry;
  }
  const label = entity.labels?.en?.value?.trim() || null;
  const mul = entity.labels?.mul?.value?.trim() || null;
  const title = label ?? mul;
  const aliases = (entity.aliases?.en ?? []).map((a) => a.value?.trim()).filter(Boolean);
  const latin = LATIN_LABELS.map((l) => entity.labels?.[l]?.value?.trim()).filter(Boolean);
  const romanized = strings(entity, WD.romanizedJapanese);
  const ja = [entity.labels?.ja?.value?.trim(), ...(entity.aliases?.ja ?? []).map((a) => a.value?.trim())].filter(Boolean);
  const instanceOf = itemIds(entity, WD.instanceOf);
  const platforms = itemIds(entity, WD.platform);

  const dates = statements(entity, WD.publicationDate)
    .map((s) => ({ ...timeValue(s.mainsnak?.datavalue?.value), platforms: qualifierIds(s, WD.platform), places: qualifierIds(s, WD.placeOfPublication) }))
    .filter((d) => d.value);
  const first = earliestDate(dates);
  const onPlatform = earliestDate(dates.filter((d) => d.platforms.includes(platformQid)));

  entry.payload = {
    title,
    titles: [...new Set([title, ...aliases, mul, ...latin, ...romanized].filter(Boolean))].sort(),
    ...(ja.length ? { ja_titles: [...new Set(ja)].sort() } : {}),
    ...(first ? { first_release_date: first.value, first_release_precision: first.precision } : {}),
    // Source-only: kept with the source record for editors; never a catalog field here.
    source: {
      revision: entity.lastrevid ?? null,
      label_language: label ? "en" : mul ? "mul" : null,
      instance_of: instanceOf,
      platforms,
      ...(onPlatform ? { platform_first_release: { value: onPlatform.value, precision: onPlatform.precision } } : {}),
      release_dates: dates
        .sort((a, b) => a.value.localeCompare(b.value))
        .slice(0, MAX_DATES)
        .map(({ value, precision, platforms: p, places }) => ({ value, precision, platforms: p, places })),
      developers: itemIds(entity, WD.developer),
      publishers: itemIds(entity, WD.publisher),
      genres: itemIds(entity, WD.genre),
      distribution_formats: itemIds(entity, WD.distributionFormat),
      // Each statement with its platform (P400) and distributor (P750) qualifiers, as stated.
      distribution: statements(entity, WD.distributionFormat)
        .map((s) => ({ format: s.mainsnak?.datavalue?.value?.id, platforms: qualifierIds(s, WD.platform), distributors: qualifierIds(s, WD.distributedBy) }))
        .filter((d) => d.format),
      external_ids: {
        igdb: strings(entity, WD.igdbGameId),
        mobygames: strings(entity, WD.mobyGamesGameId),
        mobygames_former: strings(entity, WD.mobyGamesGameIdFormer),
      },
    },
  };

  // Hard: never a candidate.
  if (!title) entry.ignore_reason = "no English label";
  else if (!instanceOf.includes(WD.videoGame)) entry.ignore_reason = "not a video game";
  else if (!platforms.includes(platformQid)) entry.ignore_reason = "not on this platform";
  if (entry.ignore_reason) return entry;

  // Flags: a person looks at the entry before it can be approved.
  const era = PLATFORM_ERAS[platformQid];
  if (!label && mul) entry.flags.push("mul_label_only");
  if (!first) entry.flags.push("no_release_date");
  else if (first.precision === "year") entry.flags.push("year_precision_only");
  if (era && onPlatform && onPlatform.value < era.launch) entry.flags.push("platform_date_before_launch");
  if (era && onPlatform && onPlatform.value > era.lateAfter) entry.flags.push("platform_date_after_era");
  if (instanceOf.some((q) => q !== WD.videoGame)) entry.flags.push("other_instance_of");
  if (platforms.length > 4) entry.flags.push("many_platforms");
  entry.flags.push(...distributionFlags(entry.payload.source.distribution, platformQid));
  const x = entry.payload.source.external_ids;
  if (x.igdb.length > 1 || x.mobygames.length > 1) entry.flags.push("external_ids_multiple");
  return entry;
}

/**
 * Distribution flags for one platform. A statement qualified with other platforms only is
 * about their versions and is ignored here; an unqualified one may be about any platform.
 *   - distribution_format_unclassified: any stated format isn't in the table.
 *   - distribution_non_physical: every format that may apply to this platform is digital.
 *   - distribution_also_non_physical (info): digital alongside a physical format.
 *   - distribution_medium_not_platform (info): a physical medium this platform doesn't use.
 * Nothing here makes a record eligible: a physical format only clears the "unclassified" flag.
 */
export function distributionFlags(distribution, platformQid) {
  const flags = [];
  const all = distribution ?? [];
  if (all.some((d) => !DISTRIBUTION_FORMAT_TABLE[d.format])) flags.push("distribution_format_unclassified");
  const here = all.filter((d) => !d.platforms?.length || d.platforms.includes(platformQid)).map((d) => DISTRIBUTION_FORMAT_TABLE[d.format]).filter(Boolean);
  const physical = here.filter((f) => f.class === "physical");
  const digital = here.filter((f) => f.class === "non_physical");
  if (digital.length && !physical.length) flags.push("distribution_non_physical");
  if (digital.length && physical.length) flags.push("distribution_also_non_physical");
  const media = PLATFORM_MEDIA[platformQid];
  if (media && physical.some((f) => !media.includes(f.media))) flags.push("distribution_medium_not_platform");
  return flags;
}

/**
 * Multiple IGDB or MobyGames ids on one item, with hints for the editor. The hints describe
 * the identifiers only; they never split, merge or clear anything.
 *   igdb_slug_variants   IGDB slugs that differ only by a "--N" suffix: likely IGDB-side duplicates.
 *   igdb_distinct_slugs  IGDB slugs with different names: a regional title, an edition or another game.
 *   mobygames_several    several MobyGames game ids: MobyGames often keeps per-platform or
 *                        distinct same-name games as separate entries.
 */
export function externalIdConflict(externalIds) {
  const igdb = externalIds?.igdb ?? [];
  const moby = externalIds?.mobygames ?? [];
  if (igdb.length < 2 && moby.length < 2) return null;
  const hints = [];
  if (igdb.length > 1) hints.push(new Set(igdb.map((s) => s.replace(/--\d+$/, ""))).size === 1 ? "igdb_slug_variants" : "igdb_distinct_slugs");
  if (moby.length > 1) hints.push("mobygames_several");
  return { igdb, mobygames: moby, hints };
}

/** The distinct distribution formats (P437, non-deprecated) the entities state, in numeric id order. */
export function distributionFormatIds(text) {
  return [...new Set(entityObjects(text).flatMap((e) => itemIds(e, WD.distributionFormat)))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** Every entity in the input as entries for one platform, in numeric id order. */
export function parseWikidataEntities(text, platformQid) {
  return entityObjects(text)
    .map((e) => entityToEntry(e, platformQid))
    .sort((a, b) => Number(a.external_id.slice(1)) - Number(b.external_id.slice(1)));
}

// ---------------------------------------------------------------------------
// The 150-game SNES selection (M12c-B1 § 3)
// ---------------------------------------------------------------------------

const seededRank = (seed, key) => createHash("sha256").update(`${seed}\n${key}`).digest("hex");

export const B1_SELECTION_ALGORITHM =
  "From the platform snapshot's titled entries: every member of a title-key group with more than one member (duplicate risk); then the fixed ids (games already in the catalog, to prove they are matched); then the rest in sha256(seed + newline + external_id) order until the size is reached. The result is listed in numeric id order.";

/**
 * A deterministic selection: the same snapshot, seed, size and fixed ids always give the
 * same ids. `entries` are the query-based parser's entries for one platform.
 */
export function b1Selection(entries, { seed = "mgd-m12c-b1-snes-1", size = 150, fixed = [] } = {}) {
  const titled = entries.filter((e) => !e.ignore_reason && e.payload?.title);
  const byId = new Map(titled.map((e) => [e.external_id, e]));
  const groups = new Map();
  for (const e of titled) {
    const key = titleKey(e.payload.title);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), e.external_id]);
  }
  const collisions = [...groups.values()].filter((ids) => ids.length > 1).flat();
  const chosen = new Set(collisions);
  const fixedFound = fixed.filter((id) => byId.has(id) && !chosen.has(id));
  for (const id of fixedFound) chosen.add(id);
  const random = [];
  for (const e of [...titled].sort((a, b) => seededRank(seed, a.external_id).localeCompare(seededRank(seed, b.external_id)))) {
    if (chosen.size >= size) break;
    if (chosen.has(e.external_id)) continue;
    chosen.add(e.external_id);
    random.push(e.external_id);
  }
  const numeric = (a, b) => Number(a.slice(1)) - Number(b.slice(1));
  return {
    selector: "m12c-b1 SNES identity pilot",
    selector_version: 1,
    algorithm: B1_SELECTION_ALGORITHM,
    seed,
    size,
    ids: [...chosen].sort(numeric),
    strata: {
      title_collisions: [...new Set(collisions)].sort(numeric),
      fixed: fixedFound.sort(numeric),
      fixed_missing: fixed.filter((id) => !byId.has(id)).sort(numeric),
      random: random.sort(numeric),
    },
  };
}

// ---------------------------------------------------------------------------
// The dry run: what an import would do, against existing catalog identifiers
// ---------------------------------------------------------------------------

/**
 * catalog: { games: [{ id, title, status, platforms: [slug], titles: [string], wikidata: [qid] }] },
 * read from a stack without writing (catalog-b1.mjs export-catalog) or from a fixture.
 *
 * Outcomes mirror the importer (M5b), without touching a database:
 *   held      the entry is ignored (a hard problem);
 *   matched   its Wikidata id is already linked to a catalog game, which it resolves to;
 *   duplicate a catalog game on the same platform has the same title key, word-break key or
 *             main title: the importer holds it as a possible duplicate (needs_review);
 *   create    a new, unpublished game candidate with its platform pairing.
 * Flags are added for batch collisions, shared external ids and other-platform matches.
 */
export function dryRun({ selection, platformQid, entries, catalog, review = null }) {
  const notes = review?.records ?? {};
  const unknownNotes = Object.keys(notes).filter((id) => !selection.ids.includes(id));
  if (unknownNotes.length) throw new Error(`Editorial-review notes name records outside the selection: ${unknownNotes.join(", ")}`);
  // A note must say what it is and why; "hold" must be a boolean (a missing hold never clears anything).
  const badNotes = Object.entries(notes).filter(([, n]) => typeof n?.category !== "string" || typeof n?.hold !== "boolean" || !String(n?.reason ?? "").trim());
  if (badNotes.length) throw new Error(`Editorial-review notes need a category, a boolean hold and a reason: ${badNotes.map(([id]) => id).join(", ")}`);
  const platformSlug = PLATFORM_ERAS[platformQid]?.slug ?? null;
  const byId = new Map(entries.map((e) => [e.external_id, e]));
  const linked = new Map();
  const keyIndex = { title: new Map(), identity: new Map(), compact: new Map(), main: new Map() };
  for (const g of catalog?.games ?? []) {
    for (const q of g.wikidata ?? []) linked.set(q, g);
    for (const t of new Set([g.title, ...(g.titles ?? [])].filter(Boolean))) {
      for (const [kind, fn] of [["title", titleKey], ["identity", identityTitleKey], ["compact", compactTitleKey], ["main", mainTitleKey]]) {
        const k = fn(t);
        if (k) keyIndex[kind].set(k, [...(keyIndex[kind].get(k) ?? []), g]);
      }
    }
  }
  const items = selection.ids.map((id) => {
    const entry = byId.get(id) ?? { external_id: id, payload: {}, flags: [], ignore_reason: "not in the snapshot" };
    return { id, entry, flags: [...(entry.flags ?? [])], outcome: null, catalog: null };
  });

  // Batch collisions: the same title key, or the same IGDB or MobyGames id, on two items.
  const tally = (keyOf) => {
    const m = new Map();
    for (const it of items) for (const k of keyOf(it)) m.set(k, [...(m.get(k) ?? []), it]);
    return [...m.values()].filter((group) => group.length > 1);
  };
  // Real collisions share the Unicode-aware key ("Ⅱ" and "II" alike). Items that share
  // only the plain key collided because a character such as "Ⅱ" was dropped from it.
  const collisionGroups = [];
  const titled = (it) => !it.entry.ignore_reason && it.entry.payload?.title;
  const summary = (it) => ({
    id: it.id,
    title: it.entry.payload.title,
    identity_key: identityTitleKey(it.entry.payload.title),
    first_release: it.entry.payload.first_release_date ?? null,
    precision: it.entry.payload.first_release_precision ?? null,
  });
  const real = new Set();
  for (const group of tally((it) => (titled(it) ? [identityTitleKey(it.entry.payload.title)].filter(Boolean) : []))) {
    for (const it of group) {
      it.flags.push("title_collision_in_batch");
      real.add(it);
    }
    collisionGroups.push({ key: identityTitleKey(group[0].entry.payload.title), verdict: "same_title_needs_review", members: group.map(summary) });
  }
  for (const group of tally((it) => (titled(it) ? [titleKey(it.entry.payload.title)].filter(Boolean) : []))) {
    const artifacts = group.filter((it) => !real.has(it));
    if (new Set(group.map((it) => identityTitleKey(it.entry.payload.title))).size === 1) continue;
    for (const it of artifacts) it.flags.push("title_collision_unicode_artifact");
    collisionGroups.push({ key: titleKey(group[0].entry.payload.title), verdict: "unicode_artifact_distinct_titles", members: group.map(summary) });
  }
  const ext = (it) => {
    const x = it.entry.payload?.source?.external_ids ?? {};
    return [...(x.igdb ?? []).map((v) => `igdb:${v}`), ...(x.mobygames ?? []).map((v) => `mobygames:${v}`)];
  };
  for (const group of tally(ext)) for (const it of group) it.flags.push("external_id_shared_in_batch");

  for (const it of items) {
    const e = it.entry;
    if (e.ignore_reason) {
      it.outcome = "held";
      continue;
    }
    if (!e.payload?.source) {
      // Query-snapshot fields only: the date flags can still be computed; the rest waits for the entity.
      it.flags.push("entity_detail_pending");
      if (!e.payload.first_release_date) it.flags.push("no_release_date");
      else if (e.payload.first_release_precision === "year") it.flags.push("year_precision_only");
    }
    const known = linked.get(it.id);
    if (known) {
      it.outcome = "matched";
      it.catalog = { id: known.id, title: known.title, status: known.status, platforms: known.platforms };
      it.flags.push("catalog_source_id_linked");
      continue;
    }
    const titles = [...new Set([e.payload.title, ...(e.payload.titles ?? [])].filter(Boolean))];
    const hits = new Map();
    for (const t of titles) {
      for (const [kind, fn] of [["title", titleKey], ["identity", identityTitleKey], ["compact", compactTitleKey], ["main", mainTitleKey]]) {
        for (const g of keyIndex[kind].get(fn(t)) ?? []) hits.set(g.id, g);
      }
    }
    const same = [...hits.values()].filter((g) => platformSlug && (g.platforms ?? []).includes(platformSlug));
    const other = [...hits.values()].filter((g) => !same.includes(g));
    if (other.length) it.flags.push("catalog_title_match_other_platform");
    if (same.length) {
      it.outcome = "duplicate";
      it.flags.push("catalog_title_match_same_platform");
      it.catalog = same.map((g) => ({ id: g.id, title: g.title, status: g.status }));
    } else it.outcome = "create";
  }
  for (const it of items) {
    it.flags = [...new Set(it.flags)].sort();
    it.note = notes[it.id] ?? null;
    // A record whose full source details are pending can never be ready (checkpoint two § 4).
    it.critical = [...new Set(it.flags.map((f) => CRITICAL_SIGNALS[f]).filter(Boolean))].sort();
    // An editorial-review note can only add a hold; it never clears a flag or a critical signal.
    it.readiness =
      it.outcome === "held"
        ? "held"
        : it.note?.hold
          ? "held_for_editor"
          : it.flags.includes("entity_detail_pending")
          ? "pending_detail"
          : it.critical.length || it.flags.some((f) => FLAGS[f] === "exception")
            ? "needs_review"
            : "ready_for_editorial_consideration";
  }

  const count = (pred) => items.filter(pred).length;
  const flagCounts = {};
  for (const it of items) for (const f of it.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  return {
    selection: { selector: selection.selector, seed: selection.seed, size: selection.ids.length },
    platform: { qid: platformQid, slug: platformSlug },
    totals: {
      items: items.length,
      create: count((it) => it.outcome === "create"),
      matched: count((it) => it.outcome === "matched"),
      duplicate: count((it) => it.outcome === "duplicate"),
      held: count((it) => it.outcome === "held"),
      exception_review: count((it) => it.flags.some((f) => FLAGS[f] === "exception")),
      clean: count((it) => it.outcome !== "held" && !it.flags.some((f) => FLAGS[f] === "exception")),
      readiness: {
        held: count((it) => it.readiness === "held"),
        held_for_editor: count((it) => it.readiness === "held_for_editor"),
        pending_detail: count((it) => it.readiness === "pending_detail"),
        needs_review: count((it) => it.readiness === "needs_review"),
        ready_for_editorial_consideration: count((it) => it.readiness === "ready_for_editorial_consideration"),
      },
      possible_critical: count((it) => it.critical.length > 0),
      external_id_conflicts: count((it) => it.flags.includes("external_ids_multiple")),
      // Nothing here establishes a physical release: every record needs independent human evidence.
      physical_release_evidence_required: count((it) => it.outcome !== "held"),
      releases_created: 0,
      published: 0,
    },
    flags: Object.fromEntries(Object.entries(flagCounts).sort()),
    // Each distinct distribution format stated by the items, with its classification (or null).
    distribution_formats: Object.fromEntries(
      Object.entries(
        items.reduce((acc, it) => {
          for (const q of it.entry.payload?.source?.distribution_formats ?? []) acc[q] = (acc[q] ?? 0) + 1;
          return acc;
        }, {}),
      )
        .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
        .map(([q, n]) => [q, { items: n, ...(DISTRIBUTION_FORMAT_TABLE[q] ?? { label: null, class: "unclassified", media: null }) }]),
    ),
    collision_groups: collisionGroups,
    editorial_groups: review?.groups ?? [],
    external_id_conflicts: items
      .map((it) => ({ it, c: externalIdConflict(it.entry.payload?.source?.external_ids) }))
      .filter(({ c }) => c)
      .map(({ it, c }) => ({ id: it.id, title: it.entry.payload?.title ?? null, readiness: it.readiness, ...c, ...(it.note ? { editorial: it.note.category } : {}) })),
    items: items.map((it) => ({
      id: it.id,
      title: it.entry.payload?.title ?? null,
      first_release: it.entry.payload?.first_release_date ? `${it.entry.payload.first_release_date} (${it.entry.payload.first_release_precision})` : null,
      outcome: it.outcome,
      readiness: it.readiness,
      ...(it.critical.length ? { possible_critical: it.critical } : {}),
      ...(it.entry.ignore_reason ? { reason: it.entry.ignore_reason } : {}),
      flags: it.flags,
      // Why the record isn't ready: every exception flag's reason, then the editorial note's.
      reasons: [
        ...(it.entry.ignore_reason ? [`Ignored: ${it.entry.ignore_reason}.`] : []),
        ...it.flags.filter((f) => FLAGS[f] === "exception").map((f) => FLAG_REASONS[f] ?? f),
        ...(it.note?.reason ? [`Editorial review (${it.note.category}): ${it.note.reason}`] : []),
      ],
      ...(it.note ? { editorial: it.note } : {}),
      ...(it.entry.payload?.source?.distribution?.length
        ? { distribution: it.entry.payload.source.distribution.map((d) => ({ ...d, label: DISTRIBUTION_FORMAT_TABLE[d.format]?.label ?? null, class: DISTRIBUTION_FORMAT_TABLE[d.format]?.class ?? "unclassified" })) }
        : {}),
      ...(it.catalog ? { catalog: it.catalog } : {}),
      ...(it.entry.payload?.source?.external_ids ? { external_ids: it.entry.payload.source.external_ids } : {}),
    })),
  };
}
