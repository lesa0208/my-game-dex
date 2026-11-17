/**
 * Reference data (M10d, D5): labels and filters for the read-only /admin/reference
 * pages. The data itself is public and managed by migrations; nothing here edits it.
 */

export type Platform = {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  manufacturer: string | null;
  family: string | null;
  kind: string;
  base_platform_id: string | null;
  released_year: number | null;
  notes: string | null;
};

export type PlatformName = { platform_id: string; name: string; region_code: string | null };
export type MediaFormat = { code: string; category: string; name: string; description: string | null; position: number };
export type PlatformFormat = { platform_id: string; media_format_code: string };
export type RegionCode = { code: string; label: string; description: string | null; position: number };
export type Market = { code: string; name: string };
export type HardwareRequirement = { code: string; platform_id: string; label: string; kind: string; description: string | null };

export type ReferenceData = {
  platforms: Platform[];
  names: PlatformName[];
  formats: MediaFormat[];
  platformFormats: PlatformFormat[];
  regions: RegionCode[];
  markets: Market[];
  requirements: HardwareRequirement[];
};

const PLATFORM_KINDS: Record<string, string> = {
  console: "Home console",
  handheld: "Handheld",
  hybrid: "Hybrid",
  computer: "Computer",
  other: "Other",
};

const MEDIA_CATEGORIES: Record<string, string> = {
  cartridge: "Cartridge",
  optical_disc: "Optical disc",
  solid_state_card: "Solid-state card",
  magnetic_disk: "Magnetic disk",
  magnetic_tape: "Magnetic tape",
};

const REQUIREMENT_KINDS: Record<string, string> = {
  revision: "Hardware revision",
  add_on: "Add-on",
  compatibility_mode: "Compatibility mode",
};

export const platformKindLabel = (kind: string) => PLATFORM_KINDS[kind] ?? kind;
export const mediaCategoryLabel = (category: string) => MEDIA_CATEGORIES[category] ?? category;
export const requirementKindLabel = (kind: string) => REQUIREMENT_KINDS[kind] ?? kind;
export const PLATFORM_KIND_OPTIONS = Object.entries(PLATFORM_KINDS).map(([value, label]) => ({ value, label }));

/** A search box's text: trimmed, spaces collapsed, at most 60 characters; null when empty. */
export function readQuery(value: string | null): string | null {
  if (!value) return null;
  const q = value.replace(/\s+/g, " ").trim().slice(0, 60);
  return q.length ? q : null;
}

/** Whether a text matches a query, ignoring case and accents. */
export function matchesQuery(query: string | null, ...texts: (string | null | undefined)[]): boolean {
  if (!query) return true;
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const q = fold(query);
  return texts.some((t) => typeof t === "string" && fold(t).includes(q));
}

/** Platforms filtered by kind, family and a text query, sorted by family, then year, then name. */
export function filterPlatforms(platforms: Platform[], filters: { kind: string | null; family: string | null; query: string | null }): Platform[] {
  return platforms
    .filter((p) => (!filters.kind || p.kind === filters.kind) && (!filters.family || p.family === filters.family))
    .filter((p) => matchesQuery(filters.query, p.name, p.short_name, p.manufacturer, p.family, p.slug))
    .sort(
      (a, b) =>
        (a.family ?? "").localeCompare(b.family ?? "") || (a.released_year ?? 9999) - (b.released_year ?? 9999) || a.name.localeCompare(b.name),
    );
}

/** Every family, in order, once. */
export function platformFamilies(platforms: Platform[]): string[] {
  return [...new Set(platforms.map((p) => p.family).filter((f): f is string => typeof f === "string" && f.length > 0))].sort((a, b) => a.localeCompare(b));
}

/** A kind from the list, or null. */
export function readPlatformKind(value: string | null): string | null {
  return value && value in PLATFORM_KINDS ? value : null;
}
