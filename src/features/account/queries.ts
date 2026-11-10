import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { parseAccount } from "@/features/auth/account";
import { signInHref, welcomeHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";
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
  return parseAccount(Array.isArray(data) ? data[0] : null, userId);
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
