import "server-only";

import type { ProviderImage } from "./provider-images";

export { igdbImageUrl, type ProviderImage } from "./provider-images";

/**
 * M18a: provider metadata (IGDB) for published games, read through
 * public.get_game_provider_metadata with the server's SUPABASE_SECRET_KEY: only service_role may
 * call it (migration 20261222100000), so no browser or public Supabase client can fetch IGDB's
 * records as stored (IGDB's terms rule out redistributing its data through our own API). It is
 * the provider's, labelled as such wherever it's shown: never the catalog's own verified facts.
 *
 * Images have two gates: the database returns them only while the provider's media are cleared
 * (private.record_provider_media), and this deployment shows them only when MGD_PROVIDER_MEDIA
 * names the provider (the local demo preview sets it; nothing else does). They are served by the
 * app's own route, which checks each image's authorization on every request
 * (provider-image-server.ts), so a browser never contacts IGDB.
 */

export type ProviderMetadata = {
  gameId: string;
  provider: "igdb";
  providerName: string;
  externalId: string;
  url: string | null;
  name: string | null;
  summary: string | null;
  genres: string[];
  themes: string[];
  developers: string[];
  publishers: string[];
  firstReleaseDate: string | null;
  platforms: string[];
  /** The IGDB platform ids IGDB lists for the game: a game-level cover is shown only on these. */
  platformIds: number[];
  cover: ProviderImage | null;
  screenshots: ProviderImage[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_ID = /^[a-z0-9]{1,40}$/;

function mediaAllowed(provider: string) {
  return (process.env.MGD_PROVIDER_MEDIA ?? "").split(",").map((s) => s.trim()).includes(provider);
}

function image(value: unknown): ProviderImage | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.image_id !== "string" || !IMAGE_ID.test(v.image_id)) return null;
  const size = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);
  return { imageId: v.image_id, width: size(v.width), height: size(v.height) };
}

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && s.trim() !== "") : []);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Parses the read's rows; anything unexpected is dropped, never guessed. */
export function parseProviderMetadata(rows: unknown, allowMedia: (provider: string) => boolean = mediaAllowed): ProviderMetadata[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): ProviderMetadata[] => {
    if (typeof row !== "object" || row === null) return [];
    const r = row as Record<string, unknown>;
    if (r.provider !== "igdb" || typeof r.game_id !== "string" || typeof r.external_id !== "string") return [];
    const media = allowMedia(r.provider);
    return [
      {
        gameId: r.game_id,
        provider: "igdb",
        providerName: text(r.provider_name) ?? "IGDB",
        externalId: r.external_id,
        url: typeof r.url === "string" && r.url.startsWith("https://www.igdb.com/games/") ? r.url : null,
        name: text(r.name),
        summary: text(r.summary),
        genres: strings(r.genres),
        themes: strings(r.themes),
        developers: strings(r.developers),
        publishers: strings(r.publishers),
        firstReleaseDate: typeof r.first_release_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.first_release_date) ? r.first_release_date : null,
        platforms: strings(r.platforms),
        platformIds: Array.isArray(r.platform_ids) ? r.platform_ids.filter((n): n is number => Number.isInteger(n) && n > 0) : [],
        cover: media ? image(r.cover) : null,
        screenshots: media && Array.isArray(r.screenshots) ? r.screenshots.map(image).filter((i): i is ProviderImage => i !== null) : [],
      },
    ];
  });
}

/**
 * Provider metadata for these games (up to 200), by game id. Empty when the catalog isn't
 * connected. Deliberately not cached (M18a security fix): every request asks the database, so
 * withdrawing the provider's clearance or media hides its data from the next page request on,
 * with no server cache, router cache or prerendered shell keeping a copy.
 */
export async function getProviderMetadata(gameIds: readonly string[]): Promise<Map<string, ProviderMetadata>> {
  const ids = [...new Set(gameIds.filter((id) => UUID.test(id)))].slice(0, 200);
  const url = process.env.SUPABASE_URL;
  // The server's secret key: read here, on the server, and sent only to the database.
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!ids.length || !url || !key) return new Map();
  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/get_game_provider_metadata`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_games: ids }),
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!response?.ok) return new Map();
  const rows: unknown = await response.json().catch(() => null);
  return new Map(parseProviderMetadata(rows).map((m) => [m.gameId, m]));
}
