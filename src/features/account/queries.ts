import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { parseAccount } from "@/features/auth/account";
import { signInHref, welcomeHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";
import { avatarPublicUrl } from "@/features/avatars/url";
import type { Viewer } from "@/types/user";

/**
 * The signed-in account for this request, or null when signed out.
 *
 * Identity comes only from `getClaims()`, which verifies the access token's
 * signature, never from the unverified session in the cookie. The account itself is
 * read through the M2 `get_my_account()` function, as that user. Cached per request
 * with React's `cache`, never across requests or users.
 */
export const getCurrentViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const { data: auth, error: authError } = await supabase.auth.getClaims();
  const userId = auth?.claims?.sub;
  if (authError || typeof userId !== "string") return null;

  const { data, error } = await supabase.rpc("get_my_account");
  if (error) throw new Error("The account couldn't be loaded.");
  const row = Array.isArray(data) ? data[0] : null;
  const viewer = parseAccount(row, userId);
  // M11a-3: the avatar, for the account menu. Only a path in this account's own folder.
  const avatarUrl = viewer ? avatarPublicUrl((row as { avatar_path?: string | null }).avatar_path, userId) : null;
  return viewer && avatarUrl ? { ...viewer, avatarUrl } : viewer;
});

/** For a protected page: the viewer, or a redirect to sign in and back to `path`. */
export async function requireViewer(path: string): Promise<Viewer> {
  const viewer = await getCurrentViewer();
  if (!viewer) redirect(signInHref(path));
  return viewer;
}

/** As `requireViewer`, and the account must also have claimed a handle. */
export async function requireViewerWithHandle(path: string): Promise<Viewer> {
  const viewer = await requireViewer(path);
  if (!viewer.handle) redirect(welcomeHref(path));
  return viewer;
}
