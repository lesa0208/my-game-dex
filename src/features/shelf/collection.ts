import "server-only";

import { createSupabaseServerClient } from "@/features/auth/server";
import { claimLine, completenessLabel, conditionLabel, copyStatusLabel, releaseLine } from "@/features/collection/details";
import { getCopyNumbers, getMyCollectionSummary } from "@/features/collection/queries";
import type { CollectionEntry, CollectionPage } from "@/features/collection/types";
import { getMyPreservedTitles } from "@/features/exclusion/queries";

import type { ConsoleKind, MediaKind, ShelfItem } from "./browse";
import { consoleFor, copyItem, type CopyLabels, copyPlatform, shelfFrame } from "./copies";

// The signed-in collector's own shelves, read with their session through the existing
// collection functions (M6b, M12a: get_my_collection_summary, get_my_collection), which
// return only the caller's copies. Per user and per request: never cached. The visual
// preview's sample data (queries.ts) is never read here.

const LABELS: CopyLabels = { completeness: completenessLabel, condition: conditionLabel, status: copyStatusLabel, releaseLine, claimLine };

/** At most this many copies are put on one shelf; past that the shelf says so and links to the list. */
export const SHELF_LIMIT = 2000;
const PAGE = 100;

const PLATFORM_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Accent colours for a system's tile and shelf, as hex. Systems without their own get the app's violet. */
const ACCENTS: Record<string, [string, string]> = {
  snes: ["#8b5cf6", "#c4b5fd"],
  nes: ["#ef4444", "#fca5a5"],
  "nintendo-64": ["#22c55e", "#facc15"],
  "game-boy": ["#a3e635", "#d9f99d"],
  "mega-drive": ["#3b82f6", "#93c5fd"],
  playstation: ["#38bdf8", "#e879f9"],
  "sega-saturn": ["#64748b", "#cbd5e1"],
};
const DEFAULT_ACCENT: [string, string] = ["#8b5cf6", "#c4b5fd"];

export type MySystem = {
  slug: string;
  name: string;
  shortName: string;
  /** From the catalog's platform record; null if it couldn't be read. */
  maker: string | null;
  released: number | null;
  console: ConsoleKind | null;
  frame: MediaKind | null;
  accent: [string, string];
  /** Copies on this platform, in every catalog standing (the summary's count). */
  copies: number;
};

export type Outcome<T> = { ok: true; data: T } | { ok: false };

type PlatformRow = { slug: string; name: string; short_name: string; manufacturer: string | null; released_year: number | null };

async function readPlatforms(slugs: string[]): Promise<Map<string, PlatformRow>> {
  if (!slugs.length) return new Map();
  const supabase = await createSupabaseServerClient();
  if (!supabase) return new Map();
  const { data } = await supabase.from("platforms").select("slug, name, short_name, manufacturer, released_year").in("slug", slugs);
  return new Map(((data as PlatformRow[] | null) ?? []).map((row) => [row.slug, row]));
}

function system(base: { slug: string; name: string; short_name: string }, row: PlatformRow | undefined, copies: number): MySystem {
  return {
    slug: base.slug,
    name: base.name,
    shortName: base.short_name,
    maker: row?.manufacturer ?? null,
    released: row?.released_year ?? null,
    console: consoleFor(base.slug),
    frame: shelfFrame(base.slug),
    accent: ACCENTS[base.slug] ?? DEFAULT_ACCENT,
    copies,
  };
}

export type MySystems = {
  systems: MySystem[];
  total: number;
  /** Copies not linked to a release, counted apart from confirmed ones. */
  unidentified: number;
};

/** The systems the collector has copies on, with how many, from their collection summary. */
export async function getMySystems(): Promise<Outcome<MySystems>> {
  const summary = await getMyCollectionSummary();
  if (!summary.ok) return { ok: false };
  const platforms = await readPlatforms(summary.data.platforms.map((p) => p.slug));
  return {
    ok: true,
    data: {
      systems: summary.data.platforms.map((p) => system(p, platforms.get(p.slug), p.count)),
      total: summary.data.total,
      unidentified: summary.data.unidentified,
    },
  };
}

export type MyShelf = {
  system: MySystem;
  items: ShelfItem[];
  /** More copies than SHELF_LIMIT: only the first are on the shelf. */
  truncated: boolean;
  stats: { copies: number; games: number; complete: number };
};

/**
 * One system's shelf: every copy the collector has on it (up to SHELF_LIMIT), in title
 * order. Null when there's no such platform. A platform they have no copies on yet is
 * an empty shelf.
 */
export async function getMyShelf(slug: string): Promise<Outcome<MyShelf> | null> {
  if (!PLATFORM_SLUG.test(slug) || slug.length > 64) return null;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false };

  const platform = (await readPlatforms([slug])).get(slug);
  if (!platform) return null;

  const entries: CollectionEntry[] = [];
  let cursor: string | null = null;
  let truncated = false;
  do {
    const { data, error } = await supabase.rpc("get_my_collection", { p_platform: slug, p_sort: "title", p_limit: PAGE, p_cursor: cursor });
    if (error || typeof data !== "object" || data === null || !Array.isArray((data as CollectionPage).items)) return { ok: false };
    const page = data as CollectionPage;
    entries.push(...page.items);
    cursor = page.next_cursor;
    if (cursor && entries.length >= SHELF_LIMIT) truncated = true;
  } while (cursor && !truncated);

  const items = await toItems(entries);
  const games = new Set(entries.map((e) => e.game?.id ?? `copy:${e.id}`));
  return {
    ok: true,
    data: {
      system: system(platform, platform, entries.length),
      items,
      truncated,
      stats: {
        copies: entries.length,
        games: games.size,
        complete: entries.filter((e) => e.completeness === "complete" || e.completeness === "sealed").length,
      },
    },
  };
}

/**
 * Copies as shelf items: "Copy 2 of 3" for releases with several copies, and the title
 * the owner recorded for a copy kept after its game left the catalog.
 */
async function toItems(entries: CollectionEntry[]): Promise<ShelfItem[]> {
  // Copies kept privately after their game left the catalog carry the title the owner recorded.
  const preservedIds = entries.filter((e) => e.status === "invalid" && !e.game).map((e) => e.id);
  const preservedChunks = [];
  for (let i = 0; i < preservedIds.length; i += 100) preservedChunks.push(getMyPreservedTitles(preservedIds.slice(i, i + 100)));
  // "Copy 2 of 3" for releases with several copies, a batch of releases at a time so each
  // read stays a short request; every copy of a release is in the same batch.
  const shared = [...new Set(entries.filter((e) => e.release && e.copies_of_release > 1).map((e) => e.release!.id))];
  const numberBatches = [];
  for (let i = 0; i < shared.length; i += 50) {
    const batch = new Set(shared.slice(i, i + 50));
    numberBatches.push(getCopyNumbers(entries.filter((e) => e.release && batch.has(e.release.id))));
  }
  const [numberMaps, preserved] = await Promise.all([Promise.all(numberBatches), Promise.all(preservedChunks)]);
  const numbers = new Map(numberMaps.flatMap((map) => [...map]));
  const titles = new Map(preserved.flatMap((map) => [...map]));

  return entries.map((entry) => copyItem(entry, { labels: LABELS, preservedTitle: titles.get(entry.id)?.title ?? null, copyNumber: numbers.get(entry.id) ?? null }));
}

/** At most this many of a game's copies are listed on its page. */
export const GAME_COPIES_LIMIT = 500;

/**
 * The signed-in collector's copies of one game, each its own item, in the collection's
 * title order. Read through get_my_collection, which returns only the caller's copies:
 * found by the game's title, then kept only when they are copies of this game (a search
 * for "Starfall Odyssey" also finds "Starfall Odyssey II"). A copy kept after its game
 * left the catalog has no game to match and isn't listed here; the collection list
 * still shows it. Null when it can't be read.
 */
export async function getMyCopiesOfGame(gameId: string, title: string): Promise<{ items: ShelfItem[]; platforms: string[]; truncated: boolean } | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const entries: CollectionEntry[] = [];
  let cursor: string | null = null;
  let truncated = false;
  do {
    const { data, error } = await supabase.rpc("get_my_collection", { p_query: title.slice(0, 100), p_sort: "title", p_limit: PAGE, p_cursor: cursor });
    if (error || typeof data !== "object" || data === null || !Array.isArray((data as CollectionPage).items)) return null;
    const page = data as CollectionPage;
    entries.push(...page.items.filter((entry) => entry.game?.id === gameId));
    cursor = page.next_cursor;
    if (cursor && entries.length >= GAME_COPIES_LIMIT) truncated = true;
  } while (cursor && !truncated);
  const platforms = [...new Set(entries.map((e) => copyPlatform(e)?.slug).filter((slug): slug is string => Boolean(slug)))];
  return { items: await toItems(entries), platforms, truncated };
}
