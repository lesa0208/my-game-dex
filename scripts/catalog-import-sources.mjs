/**
 * Parsers for catalog import snapshots (M5b). Pure functions: no network, no
 * database. Each turns a source snapshot into staged entries:
 *   { entity_type, external_id, payload, ignore_reason? }
 * Entries keep only what the source states. Mapping a source's region name to a
 * region code is the only translation, and an unmapped or mixed region stays unknown.
 * An entry can also carry review_reason: staged and reported, but held for an editor.
 */
import { createHash } from "node:crypto";

/** Wikidata items for the platforms the pilot may import. Check before each import. */
export const WIKIDATA_PLATFORMS = { snes: "Q183259" };

// Latin-script label languages, for titles that differ by market.
const LATIN_LABELS = ["de", "fr", "es", "it", "nl", "pt", "sv"];

/**
 * A SPARQL query for video games on one platform, with English labels and aliases,
 * Japanese labels, Revised Hepburn romanizations (P2125), labels in other Latin-script
 * languages, and publication dates. Wikidata data is CC0. Descriptions are never read.
 */
export function wikidataQuery(platform) {
  const qid = WIKIDATA_PLATFORMS[platform];
  if (!qid) throw new Error(`no Wikidata item for platform ${platform}`);
  return `SELECT ?item ?itemLabel ?date ?precision (GROUP_CONCAT(DISTINCT ?alias; separator="|") AS ?aliases)
  (GROUP_CONCAT(DISTINCT ?ja; separator="|") AS ?jaLabels) (GROUP_CONCAT(DISTINCT ?romaji; separator="|") AS ?romanized)
  (GROUP_CONCAT(DISTINCT ?latin; separator="|") AS ?otherLabels) WHERE {
  ?item wdt:P31 wd:Q7889 ; wdt:P400 wd:${qid} .
  OPTIONAL { ?item p:P577/psv:P577 [ wikibase:timeValue ?date ; wikibase:timePrecision ?precision ] . }
  OPTIONAL { ?item skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }
  OPTIONAL { ?item rdfs:label ?ja . FILTER(LANG(?ja) = "ja") }
  OPTIONAL { ?item wdt:P2125 ?romaji . }
  OPTIONAL { ?item rdfs:label ?latin . FILTER(LANG(?latin) IN (${LATIN_LABELS.map((l) => `"${l}"`).join(", ")})) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
GROUP BY ?item ?itemLabel ?date ?precision`;
}

const PRECISION = { 11: "day", 10: "month", 9: "year" };

/** Parses a Wikidata SPARQL JSON snapshot into game entries, one per item. */
export function parseWikidata(text) {
  const data = JSON.parse(text);
  const rows = data?.results?.bindings;
  if (!Array.isArray(rows)) throw new Error("not a SPARQL JSON result");
  const items = new Map();
  for (const row of rows) {
    const uri = row.item?.value ?? "";
    const qid = uri.slice(uri.lastIndexOf("/") + 1);
    if (!/^Q[0-9]+$/.test(qid)) continue;
    const item = items.get(qid) ?? { qid, label: null, aliases: new Set(), ja: new Set(), dates: [] };
    const label = row.itemLabel?.value?.trim();
    if (label && label !== qid) item.label = label;
    // English aliases, romanized Japanese titles and other Latin-script labels are all
    // alternate titles to match on. Japanese-script labels are kept for editors.
    for (const field of ["aliases", "romanized", "otherLabels"]) {
      for (const alias of (row[field]?.value ?? "").split("|")) if (alias.trim()) item.aliases.add(alias.trim());
    }
    for (const ja of (row.jaLabels?.value ?? "").split("|")) if (ja.trim()) item.ja.add(ja.trim());
    const precision = PRECISION[Number(row.precision?.value)];
    const date = /^\+?(\d{4})-(\d{2})-(\d{2})T/.exec(row.date?.value ?? "");
    if (precision && date && Number(date[1]) >= 1950) {
      const value = precision === "day" ? `${date[1]}-${date[2]}-${date[3]}` : precision === "month" ? `${date[1]}-${date[2]}-01` : `${date[1]}-01-01`;
      item.dates.push({ value, precision });
    }
    items.set(qid, item);
  }
  const entries = [];
  for (const item of [...items.values()].sort((a, b) => Number(a.qid.slice(1)) - Number(b.qid.slice(1)))) {
    const titles = [...new Set([item.label, ...item.aliases].filter(Boolean))].sort();
    // The earliest date, preferring the most precise one on that day.
    const earliest = item.dates.sort((a, b) => a.value.localeCompare(b.value) || rank(b.precision) - rank(a.precision))[0];
    const payload = { title: item.label, titles };
    if (item.ja.size) payload.ja_titles = [...item.ja].sort();
    if (earliest) Object.assign(payload, { first_release_date: earliest.value, first_release_precision: earliest.precision });
    const entry = { entity_type: "game", external_id: item.qid, payload };
    if (!item.label) entry.ignore_reason = "no English label";
    entries.push(entry);
  }
  return entries;
}
const rank = (p) => ({ day: 3, month: 2, year: 1 })[p] ?? 0;

// No-Intro region names. Anything else, or several regions, stays unknown.
const REGIONS = {
  USA: "ntsc-uc", Canada: "ntsc-uc", Japan: "ntsc-j", Korea: "ntsc-k",
  Europe: "pal", Australia: "pal", "New Zealand": "pal", Germany: "pal", France: "pal", Spain: "pal", Italy: "pal",
  UK: "pal", Netherlands: "pal", Sweden: "pal", Scandinavia: "pal", Nordic: "pal", Denmark: "pal", Finland: "pal",
  Norway: "pal", Portugal: "pal", Austria: "pal", Switzerland: "pal", Belgium: "pal",
};
// Not physical releases of a game on this platform, or not legitimate copies: kept
// for the record with the reason, never applied.
const IGNORED = [
  [/^(Proto|Beta|Debug|Possible Proto)( \d+)?$/i, "prototype"],
  [/^Pirate$/i, "pirate copy"],
  [/^(Hack|.*Translation)$/i, "hack or fan translation"],
  [/^(Program|Test Program|BIOS|Enhancement Chip)$/i, "not a game"],
  [/^Non-working$/i, "not a working dump"],
  // Only a tag that names a digital service or another platform rejects an entry.
  [/^(Virtual Console|Switch Online|Steam|GOG|Battle\.net)$/i, "digital release"],
  [/^(Switch|Wii|Wii U|GameCube|Evercade|Arcade|Classic Mini|Nintendo Gateway System)$/i, "release for another platform"],
];
// Held for an editor: staged and reported, never turned into a candidate automatically.
// A tag naming a later compilation or publisher says where the dump came from, not
// its platform or medium, so it is held, never rejected on its words alone.
const HELD = [
  [/^NP$/, () => "Nintendo Power flash release"],
  [/(Collection|Anniversary|Retro Roundup)/i, (t) => `dumped from a later compilation, platform unconfirmed: ${t}`],
  [/^(Retro-Bit|QUByte Classics|Ratalaika Games|Capcom Town)$/i, (t) => `later publisher, platform and medium unconfirmed: ${t}`],
];
// Publisher variants of one release, seen in the No-Intro SNES inventory of 2026-11-08.
const PUBLISHER_VARIANTS = /^(HOT B|Activision)$/;
// Physical re-releases of the game on this platform, by a later publisher.
const RE_RELEASE = /^(Limited Run Games|Piko Interactive|Strictly Limited Games|Columbus Circle)$/i;
// Review candidates: kept, and flagged for the editor.
const FLAGS = /^(Unl|Aftermarket|Homebrew|Second Dimension|The Retro Room|Super Fighter Team|Demo|Auto Demo|Tech Demo|Kiosk|Sample|Promo|Competition Cart|Club Nintendo|Keihin Ban|JR Nishi-Nihon Presents|Nintendo Power mail-order|Renkaban|NTSC|PAL|\d+[km] points|'\d+ Tokyo Omocha Show|No\. \d+|\d+-\d+-\d+|[A-Z0-9]{2,4}|[A-Z]{3}-[A-Z]{2})$/;
// ROM revisions and alternate dumps of one physical product.
const REVISION = /^(Rev [0-9A-Z]+|v[0-9.]+[a-z]?|Alt( \d+)?)$/i;
const LANGUAGES = /^[A-Z][a-z](-[A-Z][a-z]+)?(,[A-Z][a-z](-[A-Z][a-z]+)?)*$/;
// DAT categories that are never a physical game release.
const IGNORED_CATEGORIES = { BIOS: "not a game", Applications: "not a game", Preproduction: "prototype" };

const decode = (s) => s.replace(/&(quot|apos|lt|gt|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const named = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" }[e.toLowerCase()];
  if (named) return named;
  return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const attrs = (s) => Object.fromEntries([...s.matchAll(/([a-zA-Z_:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, decode(v)]));

/** Moves a trailing article back: "Legend of Zelda, The - A Link" → "The Legend of Zelda - A Link". */
export function displayTitle(base) {
  const m = /^(.*?), (The|A|An)( - .*)?$/.exec(base);
  return m ? `${m[2]} ${m[1]}${m[3] ?? ""}` : base;
}

/** Splits a No-Intro name into its title and parenthesized or bracketed tags. */
export function parseName(name) {
  const at = name.search(/ [([]/);
  const base = (at < 0 ? name : name.slice(0, at)).trim();
  const tags = [...name.slice(base.length).matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => ({ text: (m[1] ?? m[2]).trim(), bracket: m[2] !== undefined }));
  return { base, title: displayTitle(base), tags };
}

/**
 * Parses a No-Intro (Logiqx XML) DAT into release entries. ROM revisions and
 * alternate dumps of one product are grouped into one entry. The serial is taken
 * only when the DAT states one.
 */
export function parseNoIntro(text) {
  if (!/<datafile[\s>]/.test(text)) throw new Error("not a Logiqx DAT");
  const groups = new Map();
  for (const m of text.matchAll(/<(game|machine)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const game = attrs(m[2]);
    if (!game.name) continue;
    const body = m[3];
    const roms = [...body.matchAll(/<rom\b([^>]*)\/?>/g)].map((r) => attrs(r[1]));
    // "!none" is the DAT's way of saying the product has no serial.
    const stated = decode((/<serial>([^<]*)<\/serial>/.exec(body)?.[1] ?? roms.find((r) => r.serial && r.serial !== "!none")?.serial ?? "").trim());
    const serial = stated && stated !== "!none" ? stated : null;
    const category = decode((/<category>([^<]*)<\/category>/.exec(body)?.[1] ?? "").trim()) || null;
    // A leading [BIOS] marks system software, not a game.
    const bios = /^\[BIOS\]\s*/i.test(game.name);
    const { base, title, tags } = parseName(game.name.replace(/^\[BIOS\]\s*/i, ""));
    const kept = tags.filter((t) => !t.bracket && !REVISION.test(t.text));
    const key = `${base}${kept.map((t) => ` (${t.text})`).join("")}`;
    let ignore = bios ? "not a game" : (IGNORED_CATEGORIES[category] ?? (tags.some((t) => t.bracket && /^b\d*$/i.test(t.text)) ? "bad dump" : null));
    for (const t of tags) for (const [re, why] of IGNORED) if (!ignore && !t.bracket && re.test(t.text)) ignore = why;
    const regionTag = kept[0]?.text ?? "";
    const regionNames = regionTag.split(",").map((r) => r.trim()).filter(Boolean);
    const codes = [...new Set(regionNames.map((r) => REGIONS[r] ?? "unknown"))].sort();
    const languages = kept.find((t) => LANGUAGES.test(t.text))?.text.split(",").map((l) => l.toLowerCase()) ?? [];
    // Every tag after the region and languages is classified. A tag that isn't
    // recognised holds the entry for an editor, so a new kind of re-release can never
    // become a cartridge candidate by default.
    const flags = [];
    let held = null;
    let reRelease = false;
    for (const t of kept.slice(1)) {
      if (LANGUAGES.test(t.text)) continue;
      for (const part of t.text.split(",").map((p) => p.trim()).filter(Boolean)) {
        const ignored = IGNORED.find(([re]) => re.test(part));
        if (ignored) {
          if (!ignore) ignore = ignored[1];
          continue;
        }
        const hold = HELD.find(([re]) => re.test(part));
        if (hold) held ??= hold[1](part).slice(0, 200);
        else if (PUBLISHER_VARIANTS.test(part)) flags.push(`publisher: ${part}`);
        else if (RE_RELEASE.test(part)) {
          reRelease = true;
          flags.push(part);
        } else if (FLAGS.test(part)) flags.push(part);
        else held ??= `unrecognised tag: ${part}`.slice(0, 200);
      }
    }
    const group = groups.get(key) ?? {
      entity_type: "release",
      external_id: key.slice(0, 200),
      payload: { name: key, title, category, region_tag: regionTag, region_codes: codes.length ? codes : ["unknown"], languages, flags,
        release_type: reRelease ? "re-release" : "original", roms: [] },
    };
    if (held && !ignore && !group.review_reason) group.review_reason = held;
    if (serial && !group.payload.serial) group.payload.serial = serial;
    if (ignore && !group.ignore_reason) group.ignore_reason = ignore;
    for (const r of roms) group.payload.roms.push({ name: game.name, size: r.size ? Number(r.size) : null, crc: r.crc ?? null, sha1: r.sha1 ?? null });
    groups.set(key, group);
  }
  const entries = [...groups.values()].sort((a, b) => a.external_id.localeCompare(b.external_id));
  for (const e of entries) {
    if (e.ignore_reason) delete e.review_reason;
    // The classification is part of what the source entry says, so a change of
    // classification is a changed entry, which a later import reconsiders.
    e.payload.classification = e.ignore_reason ? `ignored: ${e.ignore_reason}` : e.review_reason ? `held: ${e.review_reason}` : "candidate";
    e.payload.roms.sort((a, b) => a.name.localeCompare(b.name));
    if (!e.payload.languages.length) delete e.payload.languages;
    if (!e.payload.flags.length) delete e.payload.flags;
  }
  return entries;
}

const ACCENTS_FROM = "àáâãäåāçćčèéêëēěìíîïīñńòóôõöøōùúûüūýÿžšß";
const ACCENTS_TO = "aaaaaaaccceeeeeeiiiiinnooooooouuuuuyyzss";
const ROMAN = { ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9" };

/**
 * Comparable title. The same algorithm as private.import_title_key in the database;
 * keep them equal. Case, accents, apostrophes, "&", punctuation, separators and a
 * leading or trailing article are normalized, and roman numerals II to IX and "Part N"
 * become numbers. I, V and X stay, because they are often letters.
 */
export function titleKey(title) {
  if (title == null) return null;
  let v = [...title.toLowerCase()].map((c) => {
    const i = ACCENTS_FROM.indexOf(c);
    return i < 0 ? c : ACCENTS_TO[i];
  }).join("");
  v = v.replaceAll("&", " and ").replace(/['`´‘’]/g, "");
  v = v.replace(/^(.*), (the|a|an)( - .*)?$/, (m, a, b, c) => `${b} ${a}${c ?? ""}`);
  v = v.replace(/[^a-z0-9]+/g, " ").trim();
  if (!v) return null;
  let tokens = v.split(" ");
  if (tokens.length > 1 && (tokens[0] === "the" || tokens[0] === "an" || (tokens[0] === "a" && tokens[1].length >= 3))) tokens = tokens.slice(1);
  tokens = tokens.map((t) => ROMAN[t] ?? t);
  const out = tokens.filter((t, i) => !(t === "part" && i < tokens.length - 1 && /^[0-9]+$/.test(tokens[i + 1])));
  return out.join("-").slice(0, 200);
}

/** A title key without word breaks, so "ClayFighter" compares with "Clay Fighter". */
export function compactTitleKey(title) {
  return titleKey(title)?.replaceAll("-", "") || null;
}

/** The title key of selector version 1, used by the SNES pilot selection of 2026-11-09. */
export function legacyTitleKey(title) {
  return (title ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Selector versions, recorded in every selection so it can be reproduced. */
export const SELECTORS = {
  1: { title_key: "legacy slug: NFKD accents removed, lowercase, non-alphanumerics to hyphens", key: legacyTitleKey },
  2: { title_key: "titleKey: the database's private.import_title_key", key: (t) => titleKey(t) ?? "" },
};
export const SELECTION_ALGORITHM = "Group release entries by title key; order groups by sha256(seed + newline + key); take an ambiguous group first if any; take each group whole with every game matching it in the full game snapshot while within maxGames and maxReleases; then top up games in sha256(seed + newline + external_id) order.";

/** The comparable form of a title's main part, before its first subtitle separator, or null. */
export function mainTitleKey(title) {
  const t = (title ?? "").replaceAll(" – ", " - ");
  if (!t.includes(" - ") && !t.includes(": ")) return null;
  return titleKey(t.replaceAll(": ", " - ").split(" - ")[0]);
}

const seededRank = (seed, key) => createHash("sha256").update(`${seed}\n${key}`).digest("hex");

/**
 * A deterministic pilot selection. Release entries are grouped by title, and groups
 * are taken in an order fixed by the seed. Each group brings every game whose title
 * or alias matches it in the FULL game snapshot, so regional variants, ambiguous
 * titles and genuinely unmatched entries appear as they would in a full import. An
 * ambiguous title is taken first when the snapshot has one. Selection stops at
 * about maxGames games and never exceeds maxReleases release entries. If release
 * entries run out first, games are topped up in the same seeded order.
 */
export function pilotSelection(games, releases, { seed = "mgd-snes-pilot-1", maxGames = 50, maxReleases = 100, selectorVersion = 2 } = {}) {
  const selector = SELECTORS[selectorVersion];
  if (!selector) throw new Error(`unknown selector version ${selectorVersion}`);
  const titleKey = selector.key;
  const gamesByKey = new Map();
  for (const g of games) {
    if (g.ignore_reason) continue;
    for (const t of g.payload.titles?.length ? g.payload.titles : [g.payload.title]) {
      const k = titleKey(t);
      if (!k) continue;
      if (!gamesByKey.has(k)) gamesByKey.set(k, new Set());
      gamesByKey.get(k).add(g.external_id);
    }
  }
  const groups = new Map();
  for (const r of releases) {
    const k = titleKey(r.payload.title);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.external_id);
  }
  const order = [...groups.keys()].sort((a, b) => seededRank(seed, a).localeCompare(seededRank(seed, b)));
  const pickedGames = new Set();
  const pickedReleases = [];
  const taken = [];
  const take = (k) => {
    const ids = groups.get(k);
    const qids = [...(gamesByKey.get(k) ?? [])];
    const newGames = qids.filter((q) => !pickedGames.has(q)).length;
    if (pickedReleases.length + ids.length > maxReleases || pickedGames.size + newGames > maxGames) return;
    pickedReleases.push(...ids);
    for (const q of qids) pickedGames.add(q);
    taken.push({ title_key: k, releases: ids.length, games: qids.length });
  };
  const ambiguous = order.find((k) => (gamesByKey.get(k)?.size ?? 0) > 1);
  if (ambiguous) take(ambiguous);
  for (const k of order) {
    if (pickedGames.size >= maxGames || pickedReleases.length >= maxReleases) break;
    if (k !== ambiguous) take(k);
  }
  // Games without a selected release, in the same seeded order, up to maxGames.
  const topUp = games.filter((g) => !g.ignore_reason && !pickedGames.has(g.external_id))
    .sort((x, y) => seededRank(seed, x.external_id).localeCompare(seededRank(seed, y.external_id)))
    .slice(0, Math.max(0, maxGames - pickedGames.size)).map((g) => g.external_id);
  for (const q of topUp) pickedGames.add(q);
  return {
    selector: { version: selectorVersion, title_key: selector.title_key, algorithm: SELECTION_ALGORITHM, max_games: maxGames, max_releases: maxReleases },
    seed,
    games: [...pickedGames].sort(),
    releases: pickedReleases.sort(),
    groups: taken,
    stats: {
      games: pickedGames.size,
      releases: pickedReleases.length,
      groups: taken.length,
      unmatched_groups: taken.filter((g) => g.games === 0).length,
      ambiguous_groups: taken.filter((g) => g.games > 1).length,
      games_without_selected_releases: topUp.length,
    },
  };
}

/**
 * The same release entries as an earlier selection, with every game that now matches
 * one of them, by title or main title, added. The earlier selection is never changed.
 */
export function extendSelection(selection, games, releases) {
  const wanted = new Map();
  const compact = new Map();
  const add = (map, k, id) => {
    if (!k) return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(id);
  };
  for (const g of games) {
    if (g.ignore_reason) continue;
    for (const t of g.payload.titles?.length ? g.payload.titles : [g.payload.title]) {
      add(wanted, titleKey(t), g.external_id);
      const c = compactTitleKey(t);
      if (c && c.length >= 6) add(compact, c, g.external_id);
    }
  }
  const before = new Set(selection.games);
  const matched = new Set();
  const suggested = new Set();
  const ids = new Set(selection.releases);
  for (const title of releases.filter((r) => ids.has(r.external_id)).map((r) => r.payload.title)) {
    const exact = wanted.get(titleKey(title));
    for (const q of exact ?? []) if (!before.has(q)) matched.add(q);
    // As the importer does: a unique match ignoring word breaks, when nothing matches exactly.
    const loose = !exact && compact.get(compactTitleKey(title));
    if (loose && loose.size === 1) for (const q of loose) if (!before.has(q)) matched.add(q);
    for (const q of wanted.get(mainTitleKey(title)) ?? []) if (!before.has(q) && !matched.has(q)) suggested.add(q);
  }
  return {
    seed: selection.seed,
    releases: selection.releases,
    games: [...new Set([...selection.games, ...matched, ...suggested])].sort(),
    added: { matched: [...matched].sort(), suggested: [...suggested].sort() },
  };
}

/** A reproducible pilot slice: entries whose title starts with one of the letters. */
export function pilotSlice(entries, letters) {
  const set = new Set(letters.toLowerCase().split(""));
  return entries.filter((e) => set.has(titleKey(e.payload.title ?? e.payload.name ?? "").charAt(0)));
}
