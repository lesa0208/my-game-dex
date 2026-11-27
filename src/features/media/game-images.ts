// M17b: approved images of a game's physical items (a cartridge, a case, a box), each with
// where it came from and on what terms. Pure, with no "@/" imports, so `npm run media:test`
// loads it directly.
//
// ADR-017's rule applies: every image records its source and licence, nothing is hotlinked,
// and only images we may show are listed. Until the cover-art question (D15) is settled
// with legal advice, the registry (src/assets/game-images/registry.json) is a reviewed,
// checked-in list rather than a database table; its fields are ADR-017's, so it can move
// into catalog_images unchanged. An image is only ever added by scripts/game-image-add.mjs,
// which refuses one without these fields.
//
// It never says an image is the collector's own copy: an image shows the release, or an
// example of the item on that platform and region.

/** On what terms we may show it (ADR-017's public statuses). */
export const LICENSES = ["licensed", "user_contributed", "public_domain"] as const;
export type License = (typeof LICENSES)[number];

export const KINDS = ["cartridge", "case", "box", "disc", "card"] as const;
export type ImageKind = (typeof KINDS)[number];

export type GameImage = {
  id: string;
  /** The game's catalog slug. */
  game: string;
  /** The platform's catalog slug: an image is never shown for another platform. */
  platform: string;
  /** The region code it shows, or null when it's the same in every region. */
  region: string | null;
  /** The catalog release it shows, when known; otherwise it's an example for the platform and region. */
  release: string | null;
  kind: ImageKind;
  /** Under /public, e.g. "game-images/chrono-trigger/snes-ntsc-uc-cartridge.webp". */
  file: string;
  width: number;
  height: number;
  alt: string;
  source: { name: string; url: string | null };
  license: License;
  /** The terms in words: "CC BY 4.0", "Written permission from …, 2026-12-01", "Photographed by the owner". */
  licenseDetail: string;
  /** The credit to show beside it, when the terms ask for one. */
  attribution: string | null;
  /** Who reviewed it, and when (YYYY-MM-DD). */
  approvedBy: string;
  approvedOn: string;
};

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FILE = /^game-images\/[a-z0-9-]+\/[a-z0-9-]+\.(webp|png|jpg)$/;

/** Why an entry may not be listed; empty when it may. */
export function imageProblems(entry: GameImage): string[] {
  const problems: string[] = [];
  const text = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (!text(entry.id) || !SLUG.test(entry.id)) problems.push("id");
  if (!SLUG.test(entry.game ?? "")) problems.push("game");
  if (!SLUG.test(entry.platform ?? "")) problems.push("platform");
  if (entry.region !== null && !/^[a-z]+(-[a-z]+)*$/.test(entry.region ?? "")) problems.push("region");
  if (entry.release !== null && !UUID.test(entry.release ?? "")) problems.push("release");
  if (!KINDS.includes(entry.kind)) problems.push("kind");
  if (!FILE.test(entry.file ?? "")) problems.push("file");
  if (!(entry.width > 0 && entry.height > 0)) problems.push("size");
  if (!text(entry.alt)) problems.push("alt");
  if (!text(entry.source?.name)) problems.push("source");
  if (entry.source?.url !== null && !/^https:\/\//.test(entry.source?.url ?? "")) problems.push("source url");
  if (!LICENSES.includes(entry.license)) problems.push("license");
  if (!text(entry.licenseDetail)) problems.push("license detail");
  if (!text(entry.approvedBy)) problems.push("approved by");
  if (!DAY.test(entry.approvedOn ?? "")) problems.push("approved on");
  return problems;
}

export type ImageQuery = { game: string; platform: string | null; region: string | null; release: string | null };

/**
 * The best image for what the page shows, or null. In order: the exact release; then the
 * platform and region; then the platform in any region (an image that's the same in every
 * region). With no platform chosen, a game with images on only one platform shows that
 * one. Never an image of another platform, and never another region's when the region is
 * known.
 */
export function imageFor(images: readonly GameImage[], query: ImageQuery): GameImage | null {
  const mine = images.filter((i) => i.game === query.game && imageProblems(i).length === 0);
  if (!mine.length) return null;
  if (query.release) {
    const exact = mine.find((i) => i.release === query.release);
    if (exact) return exact;
  }
  let platform = query.platform;
  if (!platform) {
    const platforms = new Set(mine.map((i) => i.platform));
    if (platforms.size !== 1) return null;
    platform = [...platforms][0];
  }
  const on = mine.filter((i) => i.platform === platform);
  if (query.region) {
    return on.find((i) => i.region === query.region && i.release === null) ?? on.find((i) => i.region === query.region) ?? on.find((i) => i.region === null) ?? null;
  }
  return on.find((i) => i.region === null) ?? (new Set(on.map((i) => i.region)).size === 1 ? on[0] : null) ?? null;
}

/**
 * Physical Releases 2.0: the approved photo of exactly this release, or null. Unlike imageFor,
 * never an example of the platform or region: a release card only shows the release itself.
 */
export function releaseImageFor(images: readonly GameImage[], query: { game: string; platform: string; release: string }): GameImage | null {
  return images.find((i) => i.game === query.game && i.platform === query.platform && i.release === query.release && imageProblems(i).length === 0) ?? null;
}

/** What the caption says it shows: the release itself, or an example. */
export function imageCaption(image: GameImage, regionLabel: string | null): string {
  const what = image.release ? "This release" : `An example ${image.kind}${regionLabel ? ` (${regionLabel})` : ""}`;
  return `${what}, not necessarily your copy.`;
}

export const LICENSE_LABELS: Record<License, string> = {
  licensed: "Licensed",
  user_contributed: "Contributed by its owner",
  public_domain: "Public domain",
};
