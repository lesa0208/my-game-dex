import "server-only";

import { cacheLife } from "next/cache";

/**
 * Catalog editing (M10c): the editing forms' choices. They're public reference data,
 * read as anon and cached, as the submission form's are. The records themselves are
 * read with the editor's own session (features/records/queries.ts).
 */

export type EditingOptions = {
  platforms: { id: string; slug: string; name: string }[];
  formats: { platform: string; code: string; name: string }[];
  regions: { code: string; label: string }[];
  markets: { code: string; name: string }[];
  requirements: { code: string; platform: string; label: string }[];
};

async function publicGet(path: string): Promise<unknown> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`The catalog request failed with status ${response.status}.`);
  return response.json();
}

/** Every choice the editing forms offer. Null when the catalog isn't connected. */
export async function getEditingOptions(): Promise<EditingOptions | null> {
  "use cache";
  cacheLife("hours");
  const [platforms, formats, regions, markets, requirements] = await Promise.all([
    publicGet("platforms?select=id,slug,name&order=name"),
    publicGet("platform_media_formats?select=platform:platforms(slug),format:media_formats(code,name,position)"),
    publicGet("region_codes?select=code,label,position&order=position"),
    publicGet("markets?select=code,name&order=name"),
    publicGet("hardware_requirements?select=code,label,platform:platforms(slug)&order=label"),
  ]);
  if (![platforms, formats, regions, markets, requirements].every(Array.isArray)) return null;
  return {
    platforms: platforms as EditingOptions["platforms"],
    formats: (formats as { platform: { slug: string }; format: { code: string; name: string; position: number } }[])
      .sort((a, b) => a.format.position - b.format.position)
      .map((f) => ({ platform: f.platform.slug, code: f.format.code, name: f.format.name })),
    regions: (regions as { code: string; label: string }[]).map((r) => ({ code: r.code, label: r.label })),
    markets: markets as EditingOptions["markets"],
    requirements: (requirements as { code: string; label: string; platform: { slug: string } }[]).map((h) => ({ code: h.code, platform: h.platform.slug, label: h.label })),
  };
}
