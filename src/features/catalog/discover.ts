import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { CATALOG_TAG } from "./queries";
import type { CatalogDate, CatalogPlatformCount, GameResult } from "./types";

/**
 * M17a: games for Explore's landing, chosen by a fact the catalog records, never by an
 * invented popularity: the games published on the most systems. Read as anon (RLS shows
 * only published games and pairings) from the public tables, and cached like the rest
 * of the public catalog.
 */

type Row = { game_id: string; platform: { slug: string; name: string; short_name: string } | null };
type GameRow = { id: string; slug: string; title: string; kind: GameResult["game"]["kind"]; first_release_date: string | null; first_release_precision: CatalogDate["precision"] | null; status: string };

async function publicRows<T>(path: string): Promise<T[] | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  const rows: T[] = [];
  // PostgREST answers at most its row limit at a time; read in ranges until a short page.
  for (let from = 0; from < 20000; from += 1000) {
    const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}`, "Range-Unit": "items" },
    });
    if (!response.ok) return null;
    const page: unknown = await response.json().catch(() => null);
    if (!Array.isArray(page)) return null;
    rows.push(...(page as T[]));
    if (page.length < 1000) return rows;
  }
  return rows;
}

function catalogDate(value: string | null, precision: CatalogDate["precision"] | null): CatalogDate | null {
  if (!value) return null;
  const p = precision ?? "day";
  return { value: p === "year" ? value.slice(0, 4) : p === "month" ? value.slice(0, 7) : value.slice(0, 10), precision: p };
}

/** Each platform's manufacturer, as the catalog's platform record names it, by slug. */
export async function getPlatformMakers(): Promise<Record<string, string>> {
  "use cache";
  cacheLife("hours");
  cacheTag(CATALOG_TAG);
  const rows = await publicRows<{ slug: string; manufacturer: string | null }>("platforms?select=slug,manufacturer");
  return Object.fromEntries((rows ?? []).filter((r) => r.manufacturer).map((r) => [r.slug, r.manufacturer as string]));
}

/** Up to `limit` games published on three systems or more, most systems first, then by title. */
export async function getMostPlatformGames(limit = 12): Promise<GameResult[] | null> {
  "use cache";
  cacheLife("hours");
  cacheTag(CATALOG_TAG);
  const pairings = await publicRows<Row>("game_platforms?select=game_id,platform:platforms(slug,name,short_name)&status=eq.published");
  if (!pairings) return null;
  const byGame = new Map<string, CatalogPlatformCount[]>();
  for (const row of pairings) {
    if (!row.platform) continue;
    const list = byGame.get(row.game_id) ?? [];
    list.push({ slug: row.platform.slug, name: row.platform.name, shortName: row.platform.short_name, releaseCount: 0 });
    byGame.set(row.game_id, list);
  }
  const candidates = [...byGame.entries()].filter(([, list]) => list.length >= 3).sort((a, b) => b[1].length - a[1].length);
  if (!candidates.length) return [];
  // A margin over the limit, so ties at the cut are settled by title, not by read order.
  const cutoff = candidates[Math.min(limit, candidates.length) - 1][1].length;
  const chosen = candidates.filter(([, list]) => list.length >= cutoff).slice(0, 60);
  const games = await publicRows<GameRow>(`games?select=id,slug,title,kind,first_release_date,first_release_precision,status&status=eq.published&id=in.(${chosen.map(([id]) => id).join(",")})`);
  if (!games) return null;
  const byId = new Map(games.map((g) => [g.id, g]));
  return chosen
    .filter(([id]) => byId.has(id))
    .map(([id, platforms]) => {
      const g = byId.get(id)!;
      return {
        kind: "game" as const,
        match: "browse" as const,
        matched: null,
        game: { id: g.id, slug: g.slug, title: g.title, kind: g.kind, firstRelease: catalogDate(g.first_release_date, g.first_release_precision) },
        platforms: platforms.sort((a, b) => a.shortName.localeCompare(b.shortName)),
      };
    })
    .sort((a, b) => b.platforms.length - a.platforms.length || a.game.title.localeCompare(b.game.title, "en"))
    .slice(0, limit);
}
