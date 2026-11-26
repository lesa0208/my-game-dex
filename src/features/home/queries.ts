import "server-only";

import { getMyRecentGames, getMySystems, type MySystem, type RecentGame } from "@/features/shelf/collection";
import { getMyCollectionStatistics } from "@/features/statistics/queries";

// Home (M16): the signed-in collector's own collection at a glance, read with their session
// through the existing owner-only functions (get_my_collection_summary, get_my_collection,
// and the statistics read of their own collection_items). Nothing here is cached across
// requests or users, and no global catalog total is ever used.

/** How many systems Home shows; the rest are one link away on the Systems page. */
export const HOME_SYSTEMS = 6;
/** On phones (below 640px) only the first few, so Recently Added is reached quickly. */
export const HOME_SYSTEMS_PHONE = 3;
/** How many recently added distinct games stand on Home's shelf. */
export const HOME_RECENT = 7;

export type HomeCollection = {
  /** Every system the collector has copies on, most copies first, ties by name. */
  systems: MySystem[];
  /** Copies in the collection (the summary's total). */
  copies: number;
  /** Distinct games among the copies; null when they couldn't be counted. */
  games: number | null;
  /** Distinct games, newest first; null when they couldn't be read (never shown as "nothing added"). */
  recent: RecentGame[] | null;
};

export type HomeOutcome = { ok: true; data: HomeCollection } | { ok: false };

export async function getHomeCollection(): Promise<HomeOutcome> {
  const systemsResult = await getMySystems();
  if (!systemsResult.ok) return { ok: false };
  const { systems, total } = systemsResult.data;
  // An empty collection needs neither the statistics nor the recent copies.
  if (total === 0) return { ok: true, data: { systems: [], copies: 0, games: 0, recent: [] } };

  const [statistics, recent] = await Promise.all([getMyCollectionStatistics(), getMyRecentGames(HOME_RECENT)]);
  return {
    ok: true,
    data: {
      systems: rankSystems(systems),
      copies: total,
      games: statistics.ok ? statistics.data.games : null,
      recent,
    },
  };
}

export function rankSystems(systems: readonly MySystem[]): MySystem[] {
  return [...systems].sort((a, b) => b.copies - a.copies || a.name.localeCompare(b.name, "en"));
}
