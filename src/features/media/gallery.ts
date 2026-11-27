// Game Details 2.0, Phase 3: the Gallery's items, from the sources the page already has and no
// others: the reviewed registry's approved photos (src/assets/game-images/registry.json) and IGDB's
// screenshots of the game. Pure, with no "@/" imports, so `npm run media:test` loads it directly.
//
// Each item keeps where it came from and on what terms: a registry photo its source, licence and
// credit; an IGDB screenshot IGDB's credit, as game-level media that verifies no physical release.
// IGDB images are only ever addressed through the app's authorization-checked route
// (/media/igdb/...), never IGDB itself, and at IGDB's "720p" or "1080p" size: the only sizes that
// keep an image's own proportions ("screenshot_big" is a fixed 16:9 crop).

import type { GameImage, License } from "./game-images";
import type { ProviderImage } from "../catalog/provider-images";

export type GalleryCredit = {
  /** Who it's from: "IGDB.com", or the registry entry's source. */
  name: string;
  url: string | null;
  /** A registry photo's licence, in words; null for IGDB's screenshots. */
  license: string | null;
  /** The credit its terms ask for, when they do. */
  attribution: string | null;
};

export type GalleryItem = {
  id: string;
  source: "registry" | "igdb";
  /** The image's address: a public file, or the authorization-checked IGDB route. */
  src: string;
  /** The original's size, when recorded: what the frame and the viewer keep the proportions of. */
  width: number | null;
  height: number | null;
  alt: string;
  /** A short name for it: "Screenshot 3", or what a photo shows ("SNES · NTSC-U/C · Cartridge"). */
  label: string;
  credit: GalleryCredit;
};

const KIND_NAMES: Record<string, string> = { cartridge: "Cartridge", case: "Case", box: "Box", disc: "Disc", card: "Card" };

/** IGDB's size for a screenshot: proportional, from the largest that isn't mostly upscaling. */
export function screenshotSize(image: ProviderImage): "720p" | "1080p" {
  return (image.height ?? 0) >= 1080 ? "1080p" : "720p";
}

export function galleryItems(input: {
  title: string;
  photos: readonly GameImage[];
  licenseLabels: Record<License, string>;
  platformName: (slug: string) => string | null;
  regionName: (code: string) => string | null;
  screenshots: readonly ProviderImage[];
  igdbUrl: string | null;
}): GalleryItem[] {
  const photos = input.photos.map((p): GalleryItem => ({
    id: `photo-${p.id}`,
    source: "registry",
    src: `/${p.file}`,
    width: p.width,
    height: p.height,
    alt: p.alt,
    label: [input.platformName(p.platform) ?? p.platform, p.region ? (input.regionName(p.region) ?? p.region) : null, KIND_NAMES[p.kind] ?? p.kind].filter(Boolean).join(" · "),
    credit: { name: p.source.name, url: p.source.url, license: `${input.licenseLabels[p.license]} · ${p.licenseDetail}`, attribution: p.attribution },
  }));
  const shots = input.screenshots.map((s, i): GalleryItem => ({
    id: `igdb-${s.imageId}`,
    source: "igdb",
    src: `/media/igdb/${screenshotSize(s)}/${s.imageId}.jpg`,
    width: s.width,
    height: s.height,
    alt: `Screenshot ${i + 1} of ${input.screenshots.length} from ${input.title}`,
    label: `Screenshot ${i + 1}`,
    credit: { name: "IGDB.com", url: input.igdbUrl, license: null, attribution: null },
  }));
  return [...photos, ...shots];
}

/**
 * The largest width the viewer shows an image at, in CSS pixels: never far beyond the original.
 * A small original (a 256-pixel console frame) may be shown up to three times its size, a medium
 * one twice, a large one at its own size; never wider than 1280. Unknown sizes get 1280.
 */
export function viewerMaxWidth(width: number | null): number {
  if (!width) return 1280;
  const scale = width <= 400 ? 3 : width <= 700 ? 2 : 1;
  return Math.min(1280, width * scale);
}
