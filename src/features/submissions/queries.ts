import "server-only";

import { cacheLife } from "next/cache";

import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";

/**
 * Catalog submissions (M7a). The form's choices are public reference data, read as
 * anon and cached. Everything about a submission is the signed-in user's own, read
 * with their session through the M7a functions and never cached.
 */

export type SubmissionOptions = {
  platforms: { slug: string; name: string; shortName: string; family: string }[];
  formats: { platform: string; code: string; name: string; category: string }[];
  regions: { code: string; label: string }[];
};

export type SubmissionSummary = {
  id: string;
  kind: "new_release" | "new_game";
  status: string;
  created_at: string;
  updated_at: string;
  release_id: string | null;
  game_slug: string | null;
  title: string | null;
  platform: { slug: string; name: string; short_name: string } | null;
  region: { code: string; label: string } | null;
  format: { code: string; name: string } | null;
  edition_name: string | null;
};

export type Allowance = { limit: number; used: number; next_available_at: string | null };

export type SubmissionDetails = {
  title: string;
  game_kind: string;
  first_release_year: number | null;
  platform: { slug: string; name: string; short_name: string };
  region: { code: string; label: string };
  format: { code: string; name: string; category: string };
  edition_name: string | null;
  edition_kind: string | null;
  variant_name: string | null;
  product_code: string | null;
  barcode: string | null;
  local_title: string | null;
  publisher_name: string | null;
  media_count: number | null;
  packaging: string | null;
  release_date: string | null;
  release_date_precision: string;
  components: { kind: string; label: string; quantity: number }[];
};

export type Submission = {
  id: string;
  kind: "new_release" | "new_game";
  status: string;
  created_at: string;
  updated_at: string;
  note: string | null;
  /** From the editor who reviewed it (M7b). The reviewer is never shown. */
  reviewer_note: string | null;
  created_game: boolean;
  details: SubmissionDetails;
  release_id: string | null;
  game_id: string | null;
  game_slug: string | null;
  editable: boolean;
  my_copies: number;
};

async function publicGet(path: string): Promise<unknown> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`The catalog request failed with status ${response.status}.`);
  return response.json();
}

/** Platforms, each one's physical formats, and regions, for the form. Null when the catalog isn't connected. */
export async function getSubmissionOptions(): Promise<SubmissionOptions | null> {
  "use cache";
  cacheLife("hours");
  const [platforms, formats, regions] = await Promise.all([
    publicGet("platforms?select=slug,name,short_name,family&order=name"),
    publicGet("platform_media_formats?select=platform:platforms(slug),format:media_formats(code,name,category,position)"),
    publicGet("region_codes?select=code,label,position&order=position"),
  ]);
  if (!Array.isArray(platforms) || !Array.isArray(formats) || !Array.isArray(regions)) return null;
  return {
    platforms: platforms.map((p: { slug: string; name: string; short_name: string; family: string }) => ({ slug: p.slug, name: p.name, shortName: p.short_name, family: p.family })),
    formats: (formats as { platform: { slug: string }; format: { code: string; name: string; category: string; position: number } }[])
      .sort((a, b) => a.format.position - b.format.position)
      .map((f) => ({ platform: f.platform.slug, code: f.format.code, name: f.format.name, category: f.format.category })),
    regions: (regions as { code: string; label: string }[]).map((r) => ({ code: r.code, label: r.label })),
  };
}

/** A published game, by its public address. */
export async function getPublishedGame(slug: string): Promise<{ id: string; title: string; slug: string } | null> {
  "use cache";
  cacheLife("minutes");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 120) return null;
  const rows = await publicGet(`games?slug=eq.${slug}&status=eq.published&select=id,title,slug`);
  return Array.isArray(rows) && rows[0] ? (rows[0] as { id: string; title: string; slug: string }) : null;
}

/** The caller's own pending game, through its read policy, so they can add another release of it. */
export async function getMyPendingGame(id: string): Promise<{ id: string; title: string } | null> {
  if (!UUID.test(id)) return null;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.from("games").select("id, title, status").eq("id", id).eq("status", "unverified").maybeSingle();
  return data ? { id: data.id as string, title: data.title as string } : null;
}

export async function getMySubmissions(before: string | null): Promise<{ items: SubmissionSummary[]; next_before: string | null; allowance: Allowance } | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("my_catalog_submissions", { p_before: before && UUID.test(before) ? before : null, p_limit: 50 });
  if (error || typeof data !== "object" || data === null) return null;
  return data as { items: SubmissionSummary[]; next_before: string | null; allowance: Allowance };
}

export async function getMySubmission(id: string): Promise<Submission | null | undefined> {
  if (!UUID.test(id)) return null;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return undefined;
  const { data, error } = await supabase.rpc("get_my_submission", { p_submission: id });
  if (error) return undefined;
  return typeof data === "object" && data !== null ? (data as Submission) : null;
}

/** The caller's submission of a release they hold a copy of, for a link from the copy's page. */
export async function getMySubmissionForRelease(releaseId: string): Promise<string | null> {
  if (!UUID.test(releaseId)) return null;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.rpc("my_submission_for_release", { p_release: releaseId });
  return typeof data === "string" ? data : null;
}
