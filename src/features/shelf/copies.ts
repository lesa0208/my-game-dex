// One of the collector's copies (what get_my_collection returns, M6b and M12a) as an item
// on their shelf. Pure, with no "@/" imports, so `npm run shelf:test` can load it; the
// collection's own wording (src/features/collection/details.ts) is passed in.
//
// Nothing missing is filled in: a copy without a recorded region, completeness,
// condition or format shows that as not recorded, and is drawn as a neutral placeholder
// when its shell isn't decided (see physicalMedia below).

import type { PickerRelease, ReleasePicker } from "../catalog/types";
import type { CollectionEntry, CopyClaim, CopyRelease, CopyStatus } from "../collection/types";
import type { ConsoleKind, MediaKind, Region, ShelfItem } from "./browse";

// ---------------------------------------------------------------------------
// Consoles and shells
// ---------------------------------------------------------------------------
//
// A shell is chosen only when the catalog's own record decides it: the release's media
// format, or the platform with the recorded region where the catalog's generic
// `rom-cartridge` format says "the platform identifies the physical shape, which differs
// by system and region" (M1 reference seed). Anything else (a format with no artwork, a
// region whose shell differs from the art, or no region at all where it matters) gets
// the neutral placeholder: never a guessed shell.

/** The catalog's platform slugs (M1 reference seed) with console art. */
const CONSOLES: Record<string, ConsoleKind> = {
  snes: "snes",
  nes: "nes",
  "nintendo-64": "n64",
  "game-boy": "gameboy",
  "mega-drive": "megadrive",
  playstation: "playstation",
  "sega-saturn": "saturn",
  "game-boy-color": "gbc",
  "game-boy-advance": "gba",
  "playstation-2": "ps2",
};

/** The console drawn for a platform, or null when there is no art for it. */
export function consoleFor(platform: string): ConsoleKind | null {
  return CONSOLES[platform] ?? null;
}

/** The shell a platform's shelf is framed for, so its items share a baseline. */
const FRAMES: Record<string, MediaKind> = {
  snes: "snes-cart",
  nes: "nes-cart",
  "nintendo-64": "n64-cart",
  "game-boy": "gb-cart",
  "game-boy-advance": "gba-cart",
  "mega-drive": "md-cart",
  playstation: "ps1-case",
  "sega-saturn": "saturn-case",
};

export function shelfFrame(platform: string): MediaKind | null {
  return FRAMES[platform] ?? null;
}

/** Region codes (M1 region_codes) that decide a shell. */
const NORTH_AMERICA = "ntsc-uc";
const JAPAN = "ntsc-j";
const PAL = "pal";

type Drawn = { kind: MediaKind; region: Region };

/**
 * The shell a copy is drawn in, from its platform, its release's media format (null for
 * an unidentified copy or a release without one) and its region code (null: not known).
 * Null when the record doesn't decide it.
 */
export function physicalMedia(platform: string, format: string | null, region: string | null): Drawn | null {
  const generic = format === null || format === "rom-cartridge";
  switch (platform) {
    case "snes":
      // M11b-1b records the two shells as formats; the generic cartridge follows the region.
      if (format === "snes-game-pak-na") return { kind: "snes-cart", region: "NTSC-U" };
      if (format === "snes-cartridge-jp-pal") return { kind: "snes-cart", region: region === JAPAN ? "NTSC-J" : "PAL" };
      if (!generic) return null;
      if (region === NORTH_AMERICA) return { kind: "snes-cart", region: "NTSC-U" };
      if (region === PAL) return { kind: "snes-cart", region: "PAL" };
      if (region === JAPAN) return { kind: "snes-cart", region: "NTSC-J" };
      return null;
    case "nes":
      // The art is the 72-pin NES Game Pak; a Famicom cartridge (60-pin) looks different.
      if (format === "nes-game-pak") return { kind: "nes-cart", region: "NTSC-U" };
      if (generic && (region === NORTH_AMERICA || region === PAL)) return { kind: "nes-cart", region: "NTSC-U" };
      return null;
    case "nintendo-64":
      // One cartridge shell in every region.
      return generic ? { kind: "n64-cart", region: "NTSC-U" } : null;
    case "game-boy":
      return format === null || format === "game-boy-game-pak" ? { kind: "gb-cart", region: "NTSC-U" } : null;
    case "game-boy-advance":
      // One cartridge shell in every region.
      return format === null || format === "gba-game-pak" ? { kind: "gba-cart", region: "NTSC-U" } : null;
    case "mega-drive":
      // The art is the Genesis and PAL shell; Japanese cartridges have a different one.
      return generic && (region === NORTH_AMERICA || region === PAL) ? { kind: "md-cart", region: "NTSC-U" } : null;
    case "playstation":
      return format === null || format === "cd-rom" ? { kind: "ps1-case", region: "NTSC-U" } : null;
    case "sega-saturn":
      // The art is the Japanese and PAL jewel case; North American copies came in a taller case.
      return (format === null || format === "cd-rom") && (region === JAPAN || region === PAL) ? { kind: "saturn-case", region: "NTSC-J" } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// A game's catalog releases
// ---------------------------------------------------------------------------

/** The shell a catalog release is drawn in, by the same rules as a copy; null when not decided. */
export function releaseMedia(release: Pick<PickerRelease, "platform" | "format" | "region">) {
  return physicalMedia(release.platform.slug, release.format?.code ?? null, release.region.code === "unknown" ? null : release.region.code);
}

/**
 * A game's published releases for its page, from the release picker read with nothing
 * selected: grouped by platform (the catalog's platform order, each release kept on its
 * own, never merged), the regions it was released in, and the release the page's hero
 * is drawn from: the first one whose shell is decided, or none.
 */
export function gameOverview(picker: Pick<ReleasePicker, "platforms" | "regions" | "releases">) {
  const listed = new Set(picker.platforms.map((p) => p.slug));
  const groups = [
    ...picker.platforms.map((platform) => ({ platform, releases: picker.releases.filter((r) => r.platform.slug === platform.slug) })),
    // A release on a platform the summary didn't list still gets shown.
    ...[...new Set(picker.releases.filter((r) => !listed.has(r.platform.slug)).map((r) => r.platform.slug))].map((slug) => {
      const releases = picker.releases.filter((r) => r.platform.slug === slug);
      return { platform: { ...releases[0].platform, releaseCount: releases.length }, releases };
    }),
  ].filter((group) => group.releases.length > 0);
  const heroRelease = picker.releases.find((r) => releaseMedia(r) !== null) ?? null;
  return {
    groups,
    // M14a: every platform the catalog publishes the game on, with or without a verified
    // release on it (a game whose physical existence was confirmed before any release was
    // catalogued), then any platform only a release names.
    platforms: [...picker.platforms, ...groups.map((g) => g.platform).filter((p) => !listed.has(p.slug))],
    regions: picker.regions.filter((r) => r.code !== "unknown" && r.releaseCount > 0),
    releaseCount: picker.releases.length,
    hero: heroRelease ? { release: heroRelease, media: releaseMedia(heroRelease)! } : null,
  };
}

// ---------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------

export type CopyLabels = {
  completeness: (value: string | null) => string;
  condition: (value: string | null) => string;
  status: (status: CopyStatus) => string | null;
  releaseLine: (release: CopyRelease) => string;
  claimLine: (claim: CopyClaim) => string;
};

/** Short names for the filter chips, in the database's completeness values. */
const COMPLETENESS_SHORT: Record<string, string> = { loose: "Loose", incomplete: "Incomplete", complete: "CIB", sealed: "Sealed" };

/** Best first, as in the collection's condition scale. */
const CONDITION_ORDER = ["mint", "near_mint", "very_good", "good", "fair", "poor"];

/** The region a copy records, or null when it isn't known. */
function regionOf(entry: CollectionEntry) {
  const region = entry.release?.region ?? entry.claim?.region ?? null;
  if (!region || region.code === "unknown") return null;
  return { code: region.code, label: region.label ?? region.code.toUpperCase() };
}

/** The platform a copy is on: its release's, or what an unidentified copy claims. */
export function copyPlatform(entry: CollectionEntry) {
  return entry.release?.platform ?? entry.claim?.platform ?? null;
}

export function copyItem(
  entry: CollectionEntry,
  {
    labels,
    preservedTitle = null,
    copyNumber = null,
  }: { labels: CopyLabels; preservedTitle?: string | null; copyNumber?: { number: number; total: number } | null },
): ShelfItem {
  const platform = copyPlatform(entry);
  const region = regionOf(entry);
  const format = entry.release?.format ?? null;
  const overall = entry.conditions.overall;
  const rank = overall ? CONDITION_ORDER.indexOf(overall) : -1;
  const identity = entry.release ? labels.releaseLine(entry.release) : entry.claim ? labels.claimLine(entry.claim) : "";
  return {
    key: entry.id,
    href: `/collection/${entry.id}`,
    // A preserved copy's game may no longer be readable; its owner's own record of the title is used then.
    title: entry.game?.title ?? preservedTitle ?? "Title not available",
    media: platform ? physicalMedia(platform.slug, format?.code ?? null, region?.code ?? null) : null,
    // The same game gets the same placeholder label on every copy.
    labelSeed: entry.game?.id ?? entry.id,
    favorite: false,
    region: region?.label ?? null,
    completeness: entry.completeness
      ? { value: entry.completeness, label: labels.completeness(entry.completeness), short: COMPLETENESS_SHORT[entry.completeness] ?? labels.completeness(entry.completeness) }
      : null,
    condition: rank >= 0 ? { label: labels.condition(overall), rank } : null,
    acquired: entry.acquired_on,
    added: entry.added_at,
    year: null,
    details: [identity, copyNumber ? `Copy ${copyNumber.number} of ${copyNumber.total}` : null].filter(Boolean).join(" · "),
    note: labels.status(entry.status),
    format: format?.name ?? null,
    platformName: platform?.name ?? null,
    edition: entry.release?.edition_name ?? entry.claim?.edition_name ?? null,
  };
}
