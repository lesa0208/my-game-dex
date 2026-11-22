import "server-only";

import { cache } from "react";

import { createSupabaseServerClient } from "@/features/auth/server";
import { rowsById } from "@/features/export/paging";

import { computeStatistics, type StatCopy, type Statistics } from "./compute";

// Collection statistics (M13), read with the collector's own session and the publishable
// key: their copies through collection_items' owner-only, live-session RLS (and the owner
// named, on top), each with its release as the catalog lets them read it. Only the
// columns the counts need: never collection_item_private (prices, dates, notes). Counted
// on the server, a page of 1,000 copies at a time by id; the browser receives only the
// totals. Per user and per request: never cached across requests.

/** The collection's own limit (get_my_collection_summary's "limit"). */
export const STATISTICS_MAX_COPIES = 100_000;
const PAGE = 1000;
const COPY_COLUMNS =
  "id,release_id,claimed_game_id,claimed_platform_id,claimed_region_code,completeness,record_status,release:releases(game_id,platform_id,region_code,media_format_code,status)";

export type Lookups = {
  platforms: Map<string, { slug: string; name: string; shortName: string }>;
  regions: Map<string, string>;
  formats: Map<string, string>;
  games: Map<string, { title: string; slug: string | null }>;
};

export type StatisticsOutcome = { ok: true; data: Statistics; lookups: Lookups } | { ok: false; reason: "unavailable" | "too_large" };

class TooLarge extends Error {}

export const getMyCollectionStatistics = cache(async (): Promise<StatisticsOutcome> => {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data: auth } = await supabase.auth.getClaims();
  const me = auth?.claims?.sub;
  if (typeof me !== "string") return { ok: false, reason: "unavailable" };

  try {
    const [copies, platforms, regions, formats] = await Promise.all([
      rowsById<StatCopy>(
        async (after, size) => {
          let query = supabase.from("collection_items").select(COPY_COLUMNS).eq("owner_id", me).order("id").limit(size);
          if (after) query = query.gt("id", after);
          const { data, error } = await query;
          if (error || !Array.isArray(data)) throw new Error("statistics read failed");
          return data as unknown as StatCopy[];
        },
        PAGE,
        STATISTICS_MAX_COPIES,
        () => new TooLarge(),
      ),
      supabase.from("platforms").select("id,slug,name,short_name"),
      supabase.from("region_codes").select("code,label"),
      supabase.from("media_formats").select("code,name"),
    ]);
    if (platforms.error || regions.error || formats.error) return { ok: false, reason: "unavailable" };

    const data = computeStatistics(copies);
    // Titles only for the games named in "several copies": published or merged games
    // the collector can read; any other stays unnamed.
    const topIds = data.several.top.map((g) => g.gameId);
    const games = topIds.length ? await supabase.from("games").select("id,title,slug,status").in("id", topIds) : { data: [], error: null };
    if (games.error) return { ok: false, reason: "unavailable" };

    return {
      ok: true,
      data,
      lookups: {
        platforms: new Map((platforms.data ?? []).map((p) => [String(p.id), { slug: String(p.slug), name: String(p.name), shortName: String(p.short_name) }])),
        regions: new Map((regions.data ?? []).map((r) => [String(r.code), String(r.label)])),
        formats: new Map((formats.data ?? []).map((f) => [String(f.code), String(f.name)])),
        games: new Map(
          ((games.data ?? []) as { id: string; title: string; slug: string; status: string }[]).map((g) => [g.id, { title: g.title, slug: g.status === "published" ? g.slug : null }]),
        ),
      },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof TooLarge ? "too_large" : "unavailable" };
  }
});
