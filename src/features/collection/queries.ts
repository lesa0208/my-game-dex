import "server-only";

import { createSupabaseServerClient } from "@/features/auth/server";

/**
 * The signed-in user's own collection data, read with their session through the M6b
 * functions, which run with the user's rights. Per user and per request: never cached.
 */

/** How many copies of a release the signed-in user has, or null if it can't be read. */
export async function getMyReleaseCopyCount(releaseId: string): Promise<number | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_my_release_copies", { p_release: releaseId });
  if (error || typeof data !== "object" || data === null) return null;
  const count = (data as { count?: unknown }).count;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

/** The currency the user chose as their default in preferences (M2), if any. */
export async function getMyDefaultCurrency(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.from("user_preferences").select("default_currency").maybeSingle();
  const value = (data as { default_currency?: unknown } | null)?.default_currency;
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
}
