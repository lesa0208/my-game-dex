/**
 * Submission enrichment (M15 catalog UX): the pure rules, for tests. src/features/enrichment/
 * wikidata.ts asks Wikidata; this decides what an answer means. Nothing is chosen for the editor:
 * a candidate is a source's claim, with its id, revision, licence scope and retrieval time.
 */

export type EnrichmentCandidate = {
  provider: "wikidata";
  external_id: string;
  url: string;
  revision: number | null;
  retrieved_at: string;
  licence: string;
  title: string;
  titles: string[];
  ja_titles: string[];
  /** The submitted title is exactly the item's title or one of its other titles. */
  title_matches: boolean;
  /** How the submitted title relates to the item's titles (best first). */
  match: MatchKind;
  /** The item's title the submitted one matched, when it matched one. */
  matched_title: string | null;
  /** A likely match: exactly a title, a regional title or alias, or a title's main part. */
  likely: boolean;
  /** The item's release dates on this platform, each with the places it names (Wikidata P577 + P291). */
  release_dates: { value: string; precision: string; places: string[] }[];
  /** The importer's own parsed record, kept so an editor's confirmation stores exactly what was shown. */
  payload?: Record<string, unknown>;
  first_release: { value: string; precision: string } | null;
  platform_first_release: { value: string; precision: string } | null;
  developers: string[];
  publishers: string[];
  distribution_formats: string[];
  external_ids: { igdb: string[]; mobygames: string[] };
  flags: string[];
};

export type EnrichmentStatus = "not_configured" | "unsupported_platform" | "failed" | "no_match" | "single_match" | "ambiguous";
export type EnrichmentResult = { status: EnrichmentStatus; provider: "wikidata"; at: string; candidates: EnrichmentCandidate[] };

export const WIKIDATA_LICENCE = "Wikidata structured data, CC0 1.0 (no images, descriptions or other providers' data)";

/** A User-Agent naming a tool, a version and a contact (an email address or a URL): scripts/catalog-b1.mjs's rule. */
export function isValidUserAgent(agent: unknown): boolean {
  return typeof agent === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+ \([^)]*(@|https?:\/\/)[^)]*\)/.test(agent.trim());
}

/** Titles compared as a collector types them: case, accents' width, punctuation and "the" don't matter. */
export function comparableTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[™℠®]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^the /, "")
    .trim();
}

/**
 * How a submitted title relates to an item's titles, best first. Regional releases often carry
 * another name ("Joe & Mac 3: Lost in the Tropics" in Europe for Joe & Mac 2), and collectors type
 * what is on their box, often without the subtitle ("Joe & Mac 3"):
 *   exact           the item's own title
 *   regional_title  one of its other titles: a regional title, an alias, a Japanese title
 *   main_title      the main part of one of its titles, before the subtitle
 *   partial         Wikidata's search found it, but no title matches: an editor's call
 */
export type MatchKind = "exact" | "regional_title" | "main_title" | "partial";
const MATCH_RANK: Record<MatchKind, number> = { exact: 0, regional_title: 1, main_title: 2, partial: 3 };

/** A title's main part: before a subtitle introduced by a colon or a dash. */
export function mainTitle(title: string): string {
  return comparableTitle(title.split(/\s*[:：]\s*|\s+[-–—]\s+/)[0] ?? title);
}

export function titleMatch(query: string, title: string, others: string[]): { match: MatchKind; matched_title: string | null } {
  const wanted = comparableTitle(query);
  if (!wanted) return { match: "partial", matched_title: null };
  if (comparableTitle(title) === wanted) return { match: "exact", matched_title: title };
  const other = others.find((t) => comparableTitle(t) === wanted);
  if (other) return { match: "regional_title", matched_title: other };
  const wantedMain = mainTitle(query);
  const main = [title, ...others].find((t) => mainTitle(t) === wanted || (wantedMain !== wanted && mainTitle(t) === wantedMain && comparableTitle(t).startsWith(wanted)));
  if (main) return { match: "main_title", matched_title: main };
  return { match: "partial", matched_title: null };
}

/**
 * The languages to search Wikidata in for a submitted title: English always (Wikidata keeps most
 * regional titles as English aliases), Japanese for a Japanese title or copy, and German and French
 * for a PAL copy, whose box title is often a European label. At most three requests.
 */
export function searchLanguages(title: string, region?: string | null): string[] {
  const out = ["en"];
  if (/[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(title) || region === "ntsc-j") out.push("ja");
  if (region === "pal") out.push("de", "fr");
  return out.slice(0, 3);
}

/** The status a set of candidates gives: one likely candidate is a match, anything else is the editor's choice. */
export function lookupStatus(candidates: EnrichmentCandidate[]): "no_match" | "single_match" | "ambiguous" {
  if (!candidates.length) return "no_match";
  return candidates.filter((c) => c.likely).length === 1 ? "single_match" : "ambiguous";
}

/** Candidates in the order an editor reads them: likely first, the closest match first. */
export function rankCandidates(candidates: EnrichmentCandidate[]): EnrichmentCandidate[] {
  return candidates.map((c, i) => ({ c, i })).sort((a, b) => MATCH_RANK[a.c.match] - MATCH_RANK[b.c.match] || a.i - b.i).map(({ c }) => c);
}

/** How a candidate's title relates to the submitted one, in words. */
export function matchText(c: Pick<EnrichmentCandidate, "match" | "matched_title" | "title">): string {
  switch (c.match) {
    case "exact":
      return "Same title";
    case "regional_title":
      return `Matches its other title “${c.matched_title}” (a regional title or alias)`;
    case "main_title":
      return `Matches the main part of “${c.matched_title}”`;
    default:
      return "Different title: found by Wikidata's search only";
  }
}

/**
 * Wikidata places (P291) that a release region covers, for picking the release date that applies
 * to a collector's copy. Countries and regions Wikidata commonly uses for game releases.
 */
const REGION_PLACES: Record<string, string[]> = {
  pal: ["Q46", "Q458", "Q145", "Q183", "Q142", "Q38", "Q29", "Q55", "Q31", "Q408", "Q664", "Q34", "Q35", "Q20", "Q33", "Q40", "Q39", "Q45", "Q27", "Q36"],
  "ntsc-uc": ["Q49", "Q30", "Q16", "Q828"],
  "ntsc-j": ["Q17"],
};
export const PLACE_NAMES: Record<string, string> = { Q46: "Europe", Q458: "European Union", Q49: "North America", Q30: "United States", Q16: "Canada", Q17: "Japan", Q145: "United Kingdom", Q183: "Germany", Q142: "France", Q408: "Australia" };

/** The release dates a source names for the region of the collector's copy. */
export function regionalReleases(c: Pick<EnrichmentCandidate, "release_dates">, region: string | null | undefined): EnrichmentCandidate["release_dates"] {
  const places = REGION_PLACES[region ?? ""];
  if (!places) return [];
  return (c.release_dates ?? []).filter((d) => d.places.some((p) => places.includes(p)));
}

type Entry = {
  external_id: string;
  ignore_reason?: string;
  flags?: string[];
  payload?: {
    title?: string;
    titles?: string[];
    ja_titles?: string[];
    first_release_date?: string;
    first_release_precision?: string;
    source?: {
      revision?: number | null;
      developers?: string[];
      publishers?: string[];
      distribution_formats?: string[];
      platform_first_release?: { value: string; precision: string };
      release_dates?: { value: string; precision: string; platforms?: string[]; places?: string[] }[];
      external_ids?: { igdb?: string[]; mobygames?: string[] };
    };
  };
};

/**
 * A candidate from one parsed entity (scripts/wikidata-entities.mjs entityToEntry), or null when
 * the importer would never take it: not a video game, not on this platform, or no usable title.
 */
export function candidateFromEntry(entry: Entry, query: string, retrievedAt: string, platformItem?: string): EnrichmentCandidate | null {
  if (!entry || entry.ignore_reason || !entry.payload?.title) return null;
  const p = entry.payload;
  const s = p.source ?? {};
  const wanted = comparableTitle(query);
  const titles = p.titles ?? [p.title!];
  const { match, matched_title } = titleMatch(query, p.title!, [...titles, ...(p.ja_titles ?? [])].filter((t) => t !== p.title));
  return {
    match,
    matched_title,
    likely: match !== "partial",
    release_dates: (s.release_dates ?? [])
      .filter((d) => d && typeof d.value === "string" && (!platformItem || !d.platforms?.length || d.platforms.includes(platformItem)))
      .map((d) => ({ value: d.value, precision: d.precision ?? "unknown", places: d.places ?? [] })),
    payload: p as Record<string, unknown>,
    provider: "wikidata",
    external_id: entry.external_id,
    url: `https://www.wikidata.org/wiki/${entry.external_id}`,
    revision: typeof s.revision === "number" ? s.revision : null,
    retrieved_at: retrievedAt,
    licence: WIKIDATA_LICENCE,
    title: p.title!,
    titles,
    ja_titles: p.ja_titles ?? [],
    title_matches: Boolean(wanted) && [p.title!, ...titles].some((t) => comparableTitle(t) === wanted),
    first_release: p.first_release_date ? { value: p.first_release_date, precision: p.first_release_precision ?? "unknown" } : null,
    platform_first_release: s.platform_first_release ?? null,
    developers: s.developers ?? [],
    publishers: s.publishers ?? [],
    distribution_formats: s.distribution_formats ?? [],
    external_ids: { igdb: s.external_ids?.igdb ?? [], mobygames: s.external_ids?.mobygames ?? [] },
    flags: entry.flags ?? [],
  };
}

/** The statuses a stored lookup can have (private.submission_enrichments). */
export type StoredStatus = "pending" | "failed" | "unsupported_platform" | "no_match" | "single_match" | "ambiguous";

/** A submission's stored lookup, as get_submission_enrichment returns it to an editor. */
export type StoredEnrichment = {
  status: StoredStatus;
  provider: "wikidata";
  attempts: number;
  looking_up: boolean;
  looked_up_title: string | null;
  looked_up_platform: string | null;
  retrieved_at: string | null;
  candidates: EnrichmentCandidate[];
  labels: Record<string, string>;
  current_title: string | null;
  /** The submission's game, and the region of its release (for the regional release date). */
  game_id: string | null;
  region: string | null;
  /** The reader submitted it: another editor decides its matches. */
  own_submission?: boolean;
  /** The game's own Wikidata item, once linked (by an import or an editor's confirmation). */
  linked_external_id: string | null;
  /** An editor's decision on a candidate, by its Wikidata id. */
  decisions: Record<string, { decision: "confirmed" | "rejected"; at: string }>;
  /** Catalog games whose own source records or references use a candidate's Wikidata item. */
  catalog_items: { external_id: string; game_id: string; title: string; status: string; slug: string | null }[];
  /**
   * Catalog games with the submitted title, or one of the likely match's titles, as their title, an
   * alias or a source title. `via_match`: found only through the match's titles.
   */
  title_matches: { game_id: string; title: string; status: string; slug: string | null; via: "title" | "alias" | "source title"; via_match?: boolean }[];
};

/** The candidates still waiting for an editor's decision (none once one is confirmed). */
export function undecided(e: Pick<StoredEnrichment, "candidates" | "decisions" | "linked_external_id"> | null | undefined): EnrichmentCandidate[] {
  if (!e || e.linked_external_id || Object.values(e.decisions ?? {}).some((d) => d.decision === "confirmed")) return [];
  return e.candidates.filter((c) => !e.decisions?.[c.external_id]);
}

/** What a stored lookup means, for the editor. `configured`: whether this server may ask Wikidata. */
export function storedSummary(e: StoredEnrichment | null, configured: boolean): string {
  if (!e) return "Not looked up: only new games are looked up.";
  const stale = e.retrieved_at && e.looked_up_title && e.current_title && comparableTitle(e.looked_up_title) !== comparableTitle(e.current_title);
  switch (e.status) {
    case "pending":
      if (!configured) return "Waiting: external lookups are off until the operator sets the Wikidata contact (WIKIDATA_USER_AGENT). The submission is unaffected.";
      if (e.attempts >= 5) return "Wikidata didn't answer after 5 tries. Look up again later.";
      return e.retrieved_at ? "Looking up again. The earlier answer is below." : "Looking this up in Wikidata. Reload in a moment.";
    case "failed":
      return e.attempts >= 5 ? "Wikidata didn't answer after 5 tries. Look up again later." : "Wikidata didn't answer. It's tried again automatically; the submission is unaffected.";
    case "unsupported_platform":
      return "Not looked up: Wikidata lookups don't cover this platform yet.";
    case "no_match":
      return stale ? "Wikidata had no match for the earlier title." : "Wikidata has no video game with this title on this platform. Everything below has to come from the editor.";
    case "single_match": {
      const likely = e.candidates.find((c) => c.likely) ?? e.candidates[0];
      const how =
        likely?.match === "regional_title"
          ? `under another of its titles, “${likely.matched_title}”`
          : likely?.match === "main_title"
            ? `whose title “${likely.matched_title}” begins with this one`
            : "with exactly this title";
      const others = e.candidates.length - 1;
      return `Wikidata has one likely match on this platform, ${how}. Check it's the same game, then confirm or reject it.${others ? ` ${others === 1 ? "One weaker possibility is" : `${others} weaker possibilities are`} listed too.` : ""}`;
    }
    case "ambiguous":
      return `Wikidata has ${e.candidates.length === 1 ? "one possible match, with a different title" : `${e.candidates.length} possible matches`}. None is chosen: decide which, if any, is this game.`;
  }
}

/** What has been decided about a stored lookup, for the editor. Null: nothing yet. */
export function decisionSummary(e: Pick<StoredEnrichment, "candidates" | "decisions" | "linked_external_id"> | null | undefined): string | null {
  if (!e) return null;
  const confirmed = Object.entries(e.decisions ?? {}).find(([, d]) => d.decision === "confirmed")?.[0];
  if (confirmed) return `An editor confirmed Wikidata ${confirmed} as this game: it is now the game's source, still to be checked before verification.`;
  if (e.linked_external_id) return `The game is already linked to Wikidata ${e.linked_external_id}.`;
  const rejected = Object.entries(e.decisions ?? {}).filter(([, d]) => d.decision === "rejected").map(([q]) => q);
  if (rejected.length && rejected.length >= e.candidates.length) return `Every candidate was rejected (${rejected.join(", ")}).`;
  return null;
}

/**
 * The cartridge shell a region suggests, on platforms where the shell follows the region
 * (M11b-1b's NES and SNES shells). An inference to check, never a fact: a few releases broke the
 * rule, and "unknown" suggests nothing.
 */
const SHELL_BY_REGION: Record<string, Record<string, string>> = {
  snes: { "ntsc-uc": "snes-game-pak-na", "ntsc-j": "snes-cartridge-jp-pal", pal: "snes-cartridge-jp-pal" },
  nes: { "ntsc-uc": "nes-game-pak", pal: "nes-game-pak", "ntsc-j": "famicom-cartridge" },
};
export function suggestedShell(platform: string, region: string): string | null {
  return SHELL_BY_REGION[platform]?.[region] ?? null;
}

/** The generic format that means "shape not classified" on a platform: one it lists but can't publish. */
export function unclassifiedFormat(formats: { platform: string; code: string; acceptsNewPublications: boolean }[], platform: string): string | null {
  const own = formats.filter((f) => f.platform === platform);
  const open = own.filter((f) => f.acceptsNewPublications);
  const closed = own.filter((f) => !f.acceptsNewPublications);
  return open.length > 1 && closed.length === 1 ? closed[0].code : null;
}

/** What a release still lacks before it can be published, in the database's own terms (M11b-1b, M7b). */
export function publicationGaps(
  release: {
    media_format_code: string;
    region_code: string;
    region_unknown_confirmed: boolean;
    packaging_code: string;
    edition_name: string | null;
    edition_kind: string | null;
    media_count: number | null;
    product_code: string | null;
    barcode: string | null;
  },
  publishable: (format: string) => boolean,
): string[] {
  const gaps: string[] = [];
  if (!publishable(release.media_format_code)) gaps.push("The exact physical format (the cartridge shell): the submitter wasn't sure");
  if (release.region_code === "unknown" && !release.region_unknown_confirmed) gaps.push("The region, or an editor's confirmation that it can't be known");
  if (release.packaging_code === "unclassified") gaps.push("The packaging classification");
  if (!release.edition_name || !release.edition_kind) gaps.push("The edition and its type");
  if (!release.media_count) gaps.push("How many cartridges or discs");
  if (!release.product_code && !release.barcode) gaps.push("A product code or barcode from the physical copy (evidence of the release, which no source provides)");
  return gaps;
}

/** How an enrichment result reads to an editor. */
export function enrichmentSummary(result: EnrichmentResult | null): string {
  if (!result) return "Not looked up.";
  switch (result.status) {
    case "not_configured":
      return "Not looked up: external lookups are off until the operator sets the Wikidata contact (WIKIDATA_USER_AGENT).";
    case "unsupported_platform":
      return "Not looked up: Wikidata lookups don't cover this platform yet.";
    case "failed":
      return "Wikidata didn't answer. The submission is unaffected; look again later.";
    case "no_match":
      return "Wikidata has no video game with this title on this platform.";
    case "single_match":
      return "Wikidata has one likely match on this platform. Check it's the same game before relying on it.";
    case "ambiguous":
      return `Wikidata has ${result.candidates.length === 1 ? "one possible match, with a different title" : `${result.candidates.length} possible matches`}. Choose the right one, if any.`;
  }
}

/** What the collector is told about their submission's lookup (M15). Null: nothing to say. */
export function collectorLookupText(status: string | null | undefined, found: boolean): string | null {
  switch (status) {
    case "pending":
      return "We're looking this game up in Wikidata, an open database, to prepare your submission for the editors. Nothing is needed from you.";
    case "failed":
      return "Wikidata didn't answer this time. We'll try again; nothing is needed from you.";
    case "single_match":
    case "ambiguous":
      return found ? "We found information about this game in Wikidata and prepared it for the editors. They check it before anything is published." : null;
    case "no_match":
      return "Wikidata has nothing on this title, so the editors will research it. Nothing is needed from you.";
    case "unsupported_platform":
      return "Automatic lookups don't cover this platform yet, so the editors will research it.";
    default:
      return null;
  }
}
