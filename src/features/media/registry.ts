import "server-only";

import registry from "@/assets/game-images/registry.json";

import { type GameImage, imageFor, imageProblems, type ImageQuery } from "./game-images";

/** The approved image for a game's page (see game-images.ts), or null: never a stand-in. */
export function approvedImageFor(query: ImageQuery): GameImage | null {
  return imageFor(registry.images as GameImage[], query);
}

/** Every approved image of a game, for a gallery: shown only when there are some. */
export function approvedImagesOf(game: string): GameImage[] {
  return (registry.images as GameImage[]).filter((i) => i.game === game && imageProblems(i).length === 0);
}
