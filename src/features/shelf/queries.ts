import "server-only";

import { isSeedDataEnabled } from "@/config/features";
import { shelfGames, shelfSystems } from "@/dev/seed/shelf";

import { type ShelfGame, shelfStats, type ShelfStats, type ShelfSystem } from "./browse";

// The visual shelf preview reads only mock data, and only while seed data is enabled
// (development, or a build with ENABLE_SEED_DATA=true). It never reads or writes the
// catalog or a collector's real copies.

export const isShelfPreviewEnabled = isSeedDataEnabled;

export type SystemWithStats = ShelfSystem & { stats: ShelfStats };

export function getPreviewSystems(): SystemWithStats[] | null {
  if (!isShelfPreviewEnabled) return null;
  return shelfSystems.map((system) => ({ ...system, stats: shelfStats(shelfGames[system.slug] ?? []) }));
}

export function getPreviewShelf(slug: string): { system: SystemWithStats; games: readonly ShelfGame[] } | null {
  if (!isShelfPreviewEnabled) return null;
  const system = shelfSystems.find((s) => s.slug === slug);
  if (!system) return null;
  const games = shelfGames[slug] ?? [];
  return { system: { ...system, stats: shelfStats(games) }, games };
}

export function getPreviewGame(systemSlug: string, gameSlug: string) {
  const shelf = getPreviewShelf(systemSlug);
  const game = shelf?.games.find((g) => g.slug === gameSlug);
  return shelf && game ? { system: shelf.system, game } : null;
}

/** Every system and game page, for generateStaticParams. Mock data only. */
export function previewParams() {
  return shelfSystems.map((system) => ({
    platform: system.slug,
    games: (shelfGames[system.slug] ?? []).map((game) => game.slug),
  }));
}
