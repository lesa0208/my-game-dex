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
  title_matches: boolean;
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
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^the /, "")
    .trim();
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
      external_ids?: { igdb?: string[]; mobygames?: string[] };
    };
  };
};

/**
 * A candidate from one parsed entity (scripts/wikidata-entities.mjs entityToEntry), or null when
 * the importer would never take it: not a video game, not on this platform, or no usable title.
 */
export function candidateFromEntry(entry: Entry, query: string, retrievedAt: string): EnrichmentCandidate | null {
  if (!entry || entry.ignore_reason || !entry.payload?.title) return null;
  const p = entry.payload;
  const s = p.source ?? {};
  const wanted = comparableTitle(query);
  const titles = p.titles ?? [p.title!];
  return {
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
  /** Catalog games whose own source records or references use a candidate's Wikidata item. */
  catalog_items: { external_id: string; game_id: string; title: string; status: string; slug: string | null }[];
  /** Catalog games with the submitted title as their title, an alias or a source title. */
  title_matches: { game_id: string; title: string; status: string; slug: string | null; via: "title" | "alias" | "source title" }[];
};

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
    case "single_match":
      return "Wikidata has one game with exactly this title on this platform. It's a likely match: check it's the same game before relying on it.";
    case "ambiguous":
      return `Wikidata has ${e.candidates.length === 1 ? "one possible match, with a different title" : `${e.candidates.length} possible matches`}. None is chosen: decide which, if any, is this game.`;
  }
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
      return "Wikidata has one game with exactly this title on this platform. Check it's the same game before relying on it.";
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
