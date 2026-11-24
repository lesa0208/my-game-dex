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
