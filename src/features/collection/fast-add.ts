/**
 * M12b: the fast add on a game's page. Platform, then region, then edition, then add.
 *
 * Each step offers what the published catalog has first, then "Another …" and "Not
 * sure". The choices are in the address (platform, region, edition, release), so the
 * page works without JavaScript and a step can be linked or reloaded.
 *
 * What gets added:
 * - A published release, when the platform, region and edition the owner chose are all
 *   the catalog's and only one release matches (or they picked one of several).
 * - Otherwise an unidentified copy (M12a), with what they know: the platform, and the
 *   region and edition, each of which may be "not sure". It never creates or implies a
 *   catalog release, pairing or edition.
 * Several releases matching is never settled by picking one: the owner chooses, or adds
 * the copy unidentified.
 *
 * Pure: the page passes in the public picker and the reference lists, so this is
 * tested on its own.
 */

/** A choice the owner can make at the region and edition steps besides the catalog's. */
export const UNSURE = "unsure";
/** "Another platform / region / edition": one the catalog doesn't have for this game. */
export const OTHER = "other";

export type FastAddRelease = {
  id: string;
  platform: { slug: string };
  region: { code: string; label: string };
  edition: { kind: string | null; name: string | null } | null;
};

export type FastAddPicker<R extends FastAddRelease = FastAddRelease> = {
  platforms: { slug: string; name: string; releaseCount: number }[];
  regions: { code: string; label: string; releaseCount: number }[];
  selection: { platform: string | null; region: string | null; releaseId: string | null };
  releases: R[];
};

export type FastAddSelection = { platform: string | null; region: string | null; edition: string | null; release: string | null };

export type FastAddReference = {
  platforms: { slug: string; name: string }[];
  /** The region codes a claim may name: every code but the catalog's "unknown". */
  regions: { code: string; label: string }[];
};

export type CatalogEdition = { key: string; kind: string | null; name: string | null; count: number };

export type ClaimChoice = {
  platform: string;
  /** Null: not sure. */
  region: string | null;
  /**
   * The edition: one the catalog names (kind and name, either possibly null), the owner's
   * own ("other": the form asks for it), or not sure (null).
   */
  edition: { kind: string | null; name: string | null } | "other" | null;
};

export type FastAddPlan<R extends FastAddRelease = FastAddRelease> = {
  platform: { slug: string; inCatalog: boolean } | null;
  /** "other" while the owner is choosing another platform or region from the full list. */
  choosingPlatform: boolean;
  region: { code: string; inCatalog: boolean } | "unsure" | null;
  choosingRegion: boolean;
  /** The catalog's editions for the platform and region chosen (any region when not sure). */
  editions: CatalogEdition[];
  edition: CatalogEdition | "other" | "unsure" | null;
  outcome: { kind: "release"; release: R } | { kind: "choose"; releases: R[] } | { kind: "claim"; claim: ClaimChoice } | null;
};

/** An edition's key in the address: its kind and name, either possibly empty. */
export function editionKey(edition: { kind: string | null; name: string | null } | null): string {
  return `${edition?.kind ?? ""}~${edition?.name ?? ""}`;
}

function editionsOf<R extends FastAddRelease>(releases: R[]): CatalogEdition[] {
  const byKey = new Map<string, CatalogEdition>();
  for (const r of releases) {
    const key = editionKey(r.edition);
    const seen = byKey.get(key);
    if (seen) seen.count += 1;
    else byKey.set(key, { key, kind: r.edition?.kind ?? null, name: r.edition?.name ?? null, count: 1 });
  }
  return [...byKey.values()];
}

/** The catalog's "unknown" region is a catalog fact, not something a claim can name. */
const claimRegion = (code: string) => (code === "unknown" ? null : code);

export function planFastAdd<R extends FastAddRelease>(picker: FastAddPicker<R>, selection: FastAddSelection, reference: FastAddReference): FastAddPlan<R> {
  const plan: FastAddPlan<R> = { platform: null, choosingPlatform: false, region: null, choosingRegion: false, editions: [], edition: null, outcome: null };

  // A release named in the address (a search result, a shared link) is what's added.
  const named = picker.selection.releaseId ? picker.releases.find((r) => r.id === picker.selection.releaseId) ?? null : null;
  if (named) {
    plan.platform = { slug: named.platform.slug, inCatalog: true };
    plan.region = { code: named.region.code, inCatalog: true };
    plan.editions = editionsOf(picker.releases.filter((r) => r.platform.slug === named.platform.slug && r.region.code === named.region.code));
    plan.edition = plan.editions.find((e) => e.key === editionKey(named.edition)) ?? null;
    plan.outcome = { kind: "release", release: named };
    return plan;
  }

  // 1. Platform: the catalog's, or any other platform as a private claim.
  const asked = selection.platform;
  if (asked === OTHER) plan.choosingPlatform = true;
  else if (asked && picker.platforms.some((p) => p.slug === asked)) plan.platform = { slug: asked, inCatalog: true };
  else if (asked && reference.platforms.some((p) => p.slug === asked)) plan.platform = { slug: asked, inCatalog: false };
  else if (!asked && picker.platforms.length === 1) plan.platform = { slug: picker.platforms[0].slug, inCatalog: true };
  if (!plan.platform) return plan;
  const platform = plan.platform;

  // The catalog's releases on that platform. The picker narrows to the platform it was
  // asked for, but filtering again keeps this right for any picker it's given.
  const onPlatform = platform.inCatalog ? picker.releases.filter((r) => r.platform.slug === platform.slug) : [];

  // 2. Region: the catalog's for that platform, another, or not sure.
  const region = selection.region;
  if (region === UNSURE) plan.region = "unsure";
  else if (region === OTHER) plan.choosingRegion = true;
  else if (region && onPlatform.some((r) => r.region.code === region)) plan.region = { code: region, inCatalog: true };
  else if (region && reference.regions.some((r) => r.code === region)) plan.region = { code: region, inCatalog: false };
  if (!plan.region) return plan;
  const chosenRegion = plan.region;

  // 3. Edition: the catalog's for that platform and region, another, or not sure. When the
  // region isn't sure, the platform's editions in any region are offered as names.
  const matching = chosenRegion === "unsure" ? onPlatform : chosenRegion.inCatalog ? onPlatform.filter((r) => r.region.code === chosenRegion.code) : [];
  plan.editions = editionsOf(matching);
  const edition = selection.edition;
  if (edition === UNSURE) plan.edition = "unsure";
  else if (edition === OTHER) plan.edition = "other";
  else if (edition !== null) plan.edition = plan.editions.find((e) => e.key === edition) ?? null;
  if (!plan.edition) return plan;
  const chosenEdition = plan.edition;

  // 4. What's added.
  if (chosenRegion !== "unsure" && chosenRegion.inCatalog && typeof chosenEdition === "object") {
    const releases = matching.filter((r) => editionKey(r.edition) === chosenEdition.key);
    const picked = selection.release ? releases.find((r) => r.id === selection.release) ?? null : null;
    if (picked) plan.outcome = { kind: "release", release: picked };
    else if (releases.length === 1) plan.outcome = { kind: "release", release: releases[0] };
    else if (releases.length > 1) plan.outcome = { kind: "choose", releases };
    return plan;
  }
  plan.outcome = {
    kind: "claim",
    claim: {
      platform: platform.slug,
      region: chosenRegion === "unsure" ? null : claimRegion(chosenRegion.code),
      edition: chosenEdition === "unsure" ? null : chosenEdition === "other" ? "other" : { kind: chosenEdition.kind, name: chosenEdition.name },
    },
  };
  return plan;
}

/** The game page's address for a fast-add selection. */
export function fastAddHref(slug: string, { platform, region, edition, release }: Partial<FastAddSelection>) {
  const params = new URLSearchParams();
  if (platform) params.set("platform", platform);
  if (region) params.set("region", region);
  if (edition) params.set("edition", edition);
  if (release) params.set("release", release);
  const search = params.toString();
  return search ? `/games/${slug}?${search}` : `/games/${slug}`;
}
