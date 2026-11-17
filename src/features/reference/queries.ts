import "server-only";

import { cacheLife } from "next/cache";

import type { ReferenceData } from "./form";

/**
 * Reference data (M10d, D5): platforms, their names and media formats, regions,
 * markets and hardware requirements. It's public and changes only with a migration,
 * so it's read as anon and cached, as the editing forms' choices are. The pages that
 * show it check the viewer's staff access first.
 */
async function publicGet(path: string): Promise<unknown> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`The reference request failed with status ${response.status}.`);
  return response.json();
}

/** All reference data, or null when the catalog isn't connected. A failed read throws, so it's never cached. */
async function readReferenceData(): Promise<ReferenceData | null> {
  "use cache";
  cacheLife("hours");
  const [platforms, names, formats, platformFormats, regions, markets, requirements] = await Promise.all([
    publicGet("platforms?select=id,slug,name,short_name,manufacturer,family,kind,base_platform_id,released_year,notes&order=name"),
    publicGet("platform_names?select=platform_id,name,region_code&order=name"),
    publicGet("media_formats?select=code,category,name,description,position&order=position"),
    publicGet("platform_media_formats?select=platform_id,media_format_code"),
    publicGet("region_codes?select=code,label,description,position&order=position"),
    publicGet("markets?select=code,name&order=name"),
    publicGet("hardware_requirements?select=code,platform_id,label,kind,description&order=label"),
  ]);
  if (![platforms, names, formats, platformFormats, regions, markets, requirements].every(Array.isArray)) return null;
  return { platforms, names, formats, platformFormats, regions, markets, requirements } as ReferenceData;
}

/** All reference data, or null when it can't be read right now. */
export async function getReferenceData(): Promise<ReferenceData | null> {
  try {
    return await readReferenceData();
  } catch {
    return null;
  }
}
