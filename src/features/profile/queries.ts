import "server-only";

import { cache } from "react";

import { createSupabaseServerClient } from "@/features/auth/server";
import { avatarPublicUrl } from "@/features/avatars/url";

/**
 * The signed-in person's own profile, for editing it (M11a-3): read through the M2
 * `get_my_account()` function, as that person, so nobody else's row can come back.
 * Includes the stored display name (null when unset, unlike Viewer.displayName, which
 * falls back to the handle) and the collection's visibility, which isn't public.
 */
export type MyProfile = {
  id: string;
  handle: string | null;
  displayName: string | null;
  bio: string | null;
  countryCode: string | null;
  avatarPath: string | null;
  avatarUrl: string | null;
  collectionVisibility: string | null;
  accountStatus: string;
};

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export const getMyProfile = cache(async (): Promise<MyProfile | null> => {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getClaims();
  const userId = auth?.claims?.sub;
  if (typeof userId !== "string") return null;
  const { data, error } = await supabase.rpc("get_my_account");
  if (error) throw new Error("The profile couldn't be loaded.");
  const row = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null;
  if (!row || row.id !== userId) return null;
  const avatarPath = text(row.avatar_path);
  return {
    id: userId,
    handle: text(row.handle),
    displayName: text(row.display_name),
    bio: text(row.bio),
    countryCode: text(row.country_code),
    avatarPath,
    avatarUrl: avatarPublicUrl(avatarPath, userId),
    collectionVisibility: text(row.collection_visibility),
    accountStatus: text(row.account_status) ?? "unknown",
  };
});
