/** M18a: an IGDB image as the catalog keeps it: its id (which builds its address) and its size. */
export type ProviderImage = { imageId: string; width: number | null; height: number | null };

/** IGDB's image sizes the app uses. */
export type IgdbImageSize = "cover_big" | "cover_big_2x" | "screenshot_big" | "720p";

/** An IGDB image's address, built from its id: the only form next.config.ts's remotePatterns accepts. */
export function igdbImageUrl(image: ProviderImage, size: IgdbImageSize) {
  return `https://images.igdb.com/igdb/image/upload/t_${size}/${image.imageId}.jpg`;
}
