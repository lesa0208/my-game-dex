/** M18a: an IGDB image as the catalog keeps it: its id (which builds its address) and its size. */
export type ProviderImage = { imageId: string; width: number | null; height: number | null };

/** IGDB's image sizes the app uses: the only sizes its image route serves. */
export const IGDB_IMAGE_SIZES = ["cover_big", "cover_big_2x", "screenshot_big", "720p"] as const;
export type IgdbImageSize = (typeof IGDB_IMAGE_SIZES)[number];

/**
 * Our platform slugs to IGDB platform ids: the same map as scripts/lib/igdb-match.mjs
 * (scripts/igdb.test.mjs checks they agree), checked against IGDB by `node scripts/igdb.mjs platforms`.
 */
export const IGDB_PLATFORM_IDS: Readonly<Record<string, number>> = {
  nes: 18,
  snes: 19,
  "mega-drive": 29,
  "game-boy": 33,
  "game-boy-color": 22,
  "game-boy-advance": 24,
  "nintendo-64": 4,
  playstation: 7,
  "playstation-2": 8,
  "sega-saturn": 32,
};

/**
 * Whether IGDB's game-level cover may stand for the game on this platform: only when IGDB lists
 * the game on it. Never the SNES cover on the GBA page: where IGDB doesn't list the platform, the
 * page keeps its honest fallback. Even then the cover is general game artwork, not verified for a
 * platform, region or edition, and is captioned so.
 */
export function coverFitsPlatform(platformIds: readonly number[], platformSlug: string | null) {
  if (!platformSlug) return false;
  const id = IGDB_PLATFORM_IDS[platformSlug];
  return id !== undefined && platformIds.includes(id);
}

/**
 * An IGDB image's address in the app: its own route, which serves it only while it is authorized
 * (src/app/media/igdb/[size]/[image]/route.ts). Render it with `unoptimized`: the image optimizer
 * would keep a copy on disk, and is not allowed to fetch IGDB at all (next.config.ts).
 */
export function igdbImageUrl(image: ProviderImage, size: IgdbImageSize) {
  return `/media/igdb/${size}/${image.imageId}.jpg`;
}
