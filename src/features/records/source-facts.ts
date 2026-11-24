/**
 * What the sources said about a game (M15 catalog UX), from get_game_source_facts: the pure
 * parts, for the game page and its tests. Everything here is a source's claim, shown as such:
 * never a verified fact, and never evidence of a physical release. An unknown value stays
 * unknown: nothing is filled in.
 */

export type SourceRecord = {
  provider: string;
  provider_name: string | null;
  external_id: string;
  record_status: string;
  imported_at: string | null;
  source_name: string | null;
  source_sha256: string | null;
  source_fetched_at: string | null;
  terms_sha256: string | null;
  licence: { cleared: boolean; terms_url: string | null; rights_survive_withdrawal: boolean };
  title: string | null;
  titles: string[];
  ja_titles: string[];
  first_release_date: string | null;
  first_release_precision: string | null;
  source: {
    revision?: number | null;
    platforms?: string[];
    developers?: string[];
    publishers?: string[];
    genres?: string[];
    instance_of?: string[];
    distribution?: { format: string; platforms: string[]; distributors: string[] }[];
    release_dates?: { value: string; precision: string; platforms: string[]; places: string[] }[];
    platform_first_release?: { value: string; precision: string } | null;
    external_ids?: { igdb?: string[]; mobygames?: string[]; mobygames_former?: string[] };
  };
  flags: string[];
  critical: string[];
};

export type HeldLookalike = { provider: string; external_id: string; title: string | null; reason: string | null };
export type SourceFacts = { sources: SourceRecord[]; held_lookalikes: HeldLookalike[] };

/** Wikidata's items for the platforms this catalog pairs (scripts/catalog-import-sources.mjs). */
export const WIKIDATA_PLATFORM_ITEMS: Record<string, string> = { snes: "Q183259", nes: "Q172742", "famicom-disk-system": "Q135321", playstation: "Q10677" };

/** Wikidata distribution formats the importer classified (DISTRIBUTION_FORMAT_TABLE): label and kind only. */
export const WIKIDATA_FORMATS: Record<string, { label: string; physical: boolean }> = {
  Q5293: { label: "floppy disk", physical: true },
  Q7982: { label: "CD-ROM", physical: true },
  Q34467: { label: "compact disc", physical: true },
  Q47770: { label: "Blu-ray Disc", physical: true },
  Q149757: { label: "compact cassette", physical: true },
  Q160710: { label: "read-only memory", physical: true },
  Q234870: { label: "optical disc", physical: true },
  Q269415: { label: "digital distribution", physical: false },
  Q633454: { label: "ROM cartridge", physical: true },
  Q849572: { label: "GD-ROM", physical: true },
  Q17048824: { label: "SNES Game Pak", physical: true },
  Q54820071: { label: "digital download", physical: false },
};

/** Each import flag in plain words, and how much it matters. */
export const FLAG_TEXT: Record<string, { text: string; level: "check" | "note" }> = {
  mul_label_only: { text: "Wikidata has no English title for it, only a language-neutral one.", level: "check" },
  no_release_date: { text: "No release date is known.", level: "check" },
  year_precision_only: { text: "Only the release year is known, not the day.", level: "check" },
  platform_date_before_launch: { text: "Its date on this platform is before the platform launched.", level: "check" },
  platform_date_after_era: { text: "Its date on this platform is long after the platform's era (a re-release, homebrew or aftermarket game?).", level: "check" },
  other_instance_of: { text: "Wikidata also describes it as something other than a video game (a compilation, edition or other type?).", level: "check" },
  distribution_format_unclassified: { text: "Wikidata names a distribution format nobody has classified yet.", level: "check" },
  distribution_non_physical: { text: "Wikidata lists only digital releases for this platform. Check that a physical copy exists.", level: "check" },
  external_ids_multiple: { text: "Wikidata links it to several IGDB or MobyGames entries: it may cover more than one game or version.", level: "check" },
  entity_detail_pending: { text: "The full source record wasn't fetched.", level: "check" },
  title_collision_in_batch: { text: "Another imported game has the same title: a possible duplicate.", level: "check" },
  external_id_shared_in_batch: { text: "Another imported game shares one of its external ids.", level: "check" },
  catalog_title_match_same_platform: { text: "The catalog already has a game with this title on this platform.", level: "check" },
  catalog_title_match_other_platform: { text: "The catalog has a game with this title on another platform.", level: "note" },
  title_collision_unicode_artifact: { text: "A game with a nearly identical title exists (they differ only by a numeral).", level: "note" },
  catalog_source_id_linked: { text: "Its source id is already linked to a catalog game.", level: "note" },
  many_platforms: { text: "Wikidata lists it on many platforms: check which version this record is about.", level: "note" },
  distribution_also_non_physical: { text: "Wikidata lists digital re-releases as well as physical ones.", level: "note" },
  distribution_medium_not_platform: { text: "Wikidata lists a medium this platform doesn't use (another platform's version).", level: "note" },
};

/** The possible critical errors a flag points to, in plain words. */
export const CRITICAL_TEXT: Record<string, string> = {
  wrong_identity_or_type: "It may not be a single game (a compilation, an edition, or two games in one record).",
  wrong_platform: "It may not belong on this platform.",
  physical_eligibility_unsupported: "It may not have a physical release (digital-only, prototype, homebrew or unreleased).",
  distinct_games_merged: "It may merge distinct games.",
  conflicting_duplicate_identities: "It may duplicate another game.",
  conflicting_identifiers: "Its external ids disagree: it may be more than one game.",
  missing_provenance: "A required fact has no source.",
};

export function flagText(flag: string): { text: string; level: "check" | "note" } {
  return FLAG_TEXT[flag] ?? { text: `Flag "${flag.replace(/_/g, " ")}".`, level: "check" };
}

/** A game's warnings, most important first: critical signals, then checks, then notes. */
export function warningsOf(facts: SourceFacts | null): { level: "critical" | "check" | "note"; text: string }[] {
  if (!facts) return [];
  const out: { level: "critical" | "check" | "note"; text: string }[] = [];
  const seen = new Set<string>();
  const add = (level: "critical" | "check" | "note", text: string) => {
    if (!seen.has(text)) {
      seen.add(text);
      out.push({ level, text });
    }
  };
  for (const s of facts.sources) for (const c of s.critical) add("critical", CRITICAL_TEXT[c] ?? `Possible error: ${c.replace(/_/g, " ")}.`);
  for (const h of facts.held_lookalikes) {
    add("check", `A second source record, ${h.external_id}${h.title ? ` "${h.title}"` : ""}, was held back as a possible duplicate of this game.`);
  }
  for (const s of facts.sources) for (const f of s.flags) add(flagText(f).level, flagText(f).text);
  const order = { critical: 0, check: 1, note: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/** Alternative titles from every source and the record's own aliases: distinct, without the title itself. */
export function alternativeTitles(title: string, facts: SourceFacts | null, aliases: { title: string }[] = []): { latin: string[]; japanese: string[] } {
  const key = (t: string) => t.normalize("NFKC").trim().toLowerCase();
  const own = key(title);
  const pick = (list: string[]) => {
    const seen = new Set([own]);
    const out: string[] = [];
    for (const t of list) {
      const k = key(t);
      if (t.trim() && !seen.has(k)) {
        seen.add(k);
        out.push(t.trim());
      }
    }
    return out;
  };
  const sources = facts?.sources ?? [];
  return {
    latin: pick([...aliases.map((a) => a.title), ...sources.flatMap((s) => s.titles ?? [])]),
    japanese: pick(sources.flatMap((s) => s.ja_titles ?? [])),
  };
}

/** The ids a source names for one field (developers, publishers), distinct, in source order. */
export function sourceIds(facts: SourceFacts | null, field: "developers" | "publishers"): string[] {
  return [...new Set((facts?.sources ?? []).flatMap((s) => s.source?.[field] ?? []))];
}

/** Release dates the source qualifies with this platform, earliest first, with their markets (place ids). */
export function platformDates(facts: SourceFacts | null, platformSlug: string): { value: string; precision: string; places: string[] }[] {
  const item = WIKIDATA_PLATFORM_ITEMS[platformSlug];
  if (!item) return [];
  const rows = (facts?.sources ?? []).flatMap((s) => (s.source?.release_dates ?? []).filter((d) => d.platforms?.includes(item)));
  return rows.map(({ value, precision, places }) => ({ value, precision, places: places ?? [] })).sort((a, b) => a.value.localeCompare(b.value));
}

/** "1991", "Nov 1991" or "21 Nov 1991": only as precise as the source is. */
export function sourceDate(value: string | null | undefined, precision: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en", { month: "short", timeZone: "UTC" });
  if (precision === "day") return `${d} ${month} ${y}`;
  if (precision === "month") return `${month} ${y}`;
  return String(y);
}

/** What the source says about formats for this platform: "ROM cartridge, SNES Game Pak", digital ones marked. */
export function formatLines(facts: SourceFacts | null, platformSlug: string): { label: string; physical: boolean | null; otherPlatform: boolean }[] {
  const item = WIKIDATA_PLATFORM_ITEMS[platformSlug];
  const out = new Map<string, { label: string; physical: boolean | null; otherPlatform: boolean }>();
  for (const s of facts?.sources ?? []) {
    for (const d of s.source?.distribution ?? []) {
      const known = WIKIDATA_FORMATS[d.format];
      const otherPlatform = Boolean(item && d.platforms?.length && !d.platforms.includes(item));
      const k = `${d.format}|${otherPlatform}`;
      if (!out.has(k)) out.set(k, { label: known?.label ?? d.format, physical: known ? known.physical : null, otherPlatform });
    }
  }
  return [...out.values()];
}

/** What an editor still has to find: the facts no source supplies. Missing is never filled in. */
export function missingFacts(facts: SourceFacts | null, game: { first_release: unknown; release_count: number }, platformSlug: string | null): string[] {
  const missing: string[] = [];
  if (!game.first_release) missing.push("Release date");
  if (platformSlug && !platformDates(facts, platformSlug).length) missing.push("Release date on this platform");
  if (!sourceIds(facts, "developers").length) missing.push("Developer");
  if (!sourceIds(facts, "publishers").length) missing.push("Publisher");
  if (game.release_count === 0) missing.push("Physical release (product code, region, packaging)");
  return missing;
}
