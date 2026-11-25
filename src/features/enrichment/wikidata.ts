import "server-only";

// The importer's own parser (scripts/wikidata-entities.mjs): the same fields, flags and rules.
import { entityToEntry } from "../../../scripts/wikidata-entities.mjs";

import { WIKIDATA_PLATFORM_ITEMS } from "@/features/records/source-facts";

import { candidateFromEntry, isValidUserAgent, lookupStatus, rankCandidates, searchLanguages, type EnrichmentCandidate, type EnrichmentResult } from "./match";

/**
 * Wikidata, read server-side (M15 catalog UX): human-readable labels for the ids a game's source
 * names, and the candidate items for a collector's submission. Wikidata's structured data is CC0
 * (the cleared terms: docs/architecture/catalog-pilot-m15.md). Descriptions, images and
 * sitelinks are never requested.
 *
 * Every request needs WIKIDATA_USER_AGENT: a tool, a version and the project's contact (an email
 * address or a URL), chosen by the operator, as the Wikimedia User-Agent policy requires. Without
 * it nothing is requested (no contact is ever invented: M12c-B1 D-7), labels stay ids, and a
 * submission is simply "not looked up yet". One request at a time, maxlag=5, a short timeout, and
 * every failure is soft: the caller always gets an answer.
 */
// The app checks' local stand-in for Wikidata (scripts/app-enrichment-checks.mjs): honoured only for
// a loopback address, so no setting can send lookups anywhere else.
const STAND_IN = process.env.MGD_WIKIDATA_API_URL;
const API = STAND_IN && /^http:\/\/127\.0\.0\.1:\d{2,5}\/w\/api\.php$/.test(STAND_IN) ? STAND_IN : "https://www.wikidata.org/w/api.php";
const TIMEOUT_MS = 5000;
const DAY = 86400;

export function wikidataConfigured(): boolean {
  return isValidUserAgent(process.env.WIKIDATA_USER_AGENT);
}

/** `revalidate`: seconds Next.js may reuse the answer, or 0 for a fresh request every time. */
async function call(params: Record<string, string>, revalidate: number): Promise<unknown | null> {
  const agent = process.env.WIKIDATA_USER_AGENT;
  if (!isValidUserAgent(agent)) return null;
  const url = `${API}?${new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params })}`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": agent!.trim(), "Api-User-Agent": agent!.trim(), Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(revalidate > 0 ? { next: { revalidate } } : { cache: "no-store" as const }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { error?: unknown };
    return body?.error ? null : body;
  } catch {
    return null;
  }
}

/** English (or language-neutral) labels for up to 50 Wikidata ids. Unknown ids are left out, never guessed. */
export async function wikidataLabels(ids: string[]): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((id) => /^Q[0-9]+$/.test(id)))].slice(0, 50);
  if (!wanted.length) return {};
  const body = (await call({ action: "wbgetentities", ids: wanted.join("|"), props: "labels", languages: "en|mul" }, 7 * DAY)) as {
    entities?: Record<string, { labels?: Record<string, { value?: string }> }>;
  } | null;
  const out: Record<string, string> = {};
  for (const [id, e] of Object.entries(body?.entities ?? {})) {
    const label = e.labels?.en?.value ?? e.labels?.mul?.value;
    if (label) out[id] = label;
  }
  return out;
}

/**
 * The Wikidata items that may be this game on this platform: a title search, then the items'
 * labels, aliases and statements, parsed with the importer's own rules. Only items that are video
 * games on the requested platform are candidates; nothing is chosen here. Several candidates, or
 * one whose title differs, is "ambiguous": an editor picks.
 */
export async function lookUpWikidataGame(title: string, platformSlug: string, region?: string | null): Promise<EnrichmentResult> {
  const at = new Date().toISOString();
  const platformItem = WIKIDATA_PLATFORM_ITEMS[platformSlug];
  if (!wikidataConfigured()) return { status: "not_configured", provider: "wikidata", at, candidates: [] };
  if (!platformItem) return { status: "unsupported_platform", provider: "wikidata", at, candidates: [] };
  // Fresh each time: the stored lookup is the cache (private.submission_enrichments), and it asks
  // again only after an outage (with back-off, at most 5 times) or when an editor asks.
  // A regional title may be an English alias (Europe's "Super Probotector"), a label in the
  // region's language, or Japanese: search the languages the copy suggests, one request each.
  const ids: string[] = [];
  let answered = false;
  for (const language of searchLanguages(title, region)) {
    const search = (await call({ action: "wbsearchentities", search: title.slice(0, 200), language, uselang: language, type: "item", limit: "10" }, 0)) as {
      search?: { id?: string }[];
    } | null;
    if (!search) continue;
    answered = true;
    for (const s of search.search ?? []) if (s.id && /^Q[0-9]+$/.test(s.id) && !ids.includes(s.id)) ids.push(s.id);
  }
  // A box title with a subtitle the source doesn't list ("Joe & Mac 3: Caveman Ninja"): the main title.
  const main = title.split(/\s*[:：]\s*|\s+[-–—]\s+/)[0]?.trim();
  if (answered && !ids.length && main && main !== title.trim() && main.length >= 3) {
    const search = (await call({ action: "wbsearchentities", search: main.slice(0, 200), language: "en", uselang: "en", type: "item", limit: "10" }, 0)) as { search?: { id?: string }[] } | null;
    for (const s of search?.search ?? []) if (s.id && /^Q[0-9]+$/.test(s.id) && !ids.includes(s.id)) ids.push(s.id);
  }
  if (!answered) return { status: "failed", provider: "wikidata", at, candidates: [] };
  if (!ids.length) return { status: "no_match", provider: "wikidata", at, candidates: [] };
  const wanted = ids.slice(0, 20);
  const entities = (await call({ action: "wbgetentities", ids: wanted.join("|"), props: "info|labels|aliases|claims", languages: "en|mul|ja|de|fr" }, 0)) as {
    entities?: Record<string, unknown>;
  } | null;
  if (!entities) return { status: "failed", provider: "wikidata", at, candidates: [] };
  const candidates: EnrichmentCandidate[] = [];
  for (const id of wanted) {
    const entity = entities.entities?.[id];
    if (!entity) continue;
    const candidate = candidateFromEntry(entityToEntry(entity, platformItem), title, at, platformItem);
    if (candidate) candidates.push(candidate);
  }
  const ranked = rankCandidates(candidates).slice(0, 10);
  return { status: lookupStatus(ranked), provider: "wikidata", at, candidates: ranked };
}
