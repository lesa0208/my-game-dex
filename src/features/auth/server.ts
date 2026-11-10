import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { connection } from "next/server";

import { AUTH_COOKIE_OPTIONS, supabaseConfig } from "./cookies";

/**
 * A Supabase client acting as the signed-in user, for one request. Never shared
 * between requests, and never used inside `'use cache'`.
 *
 * Server Components can't set cookies, so `setAll` fails there and is ignored: the
 * proxy has already refreshed the session for this request. Server Actions can set
 * them, which is how sign-in and sign-out write the session.
 */
export async function createSupabaseServerClient() {
  // Only at request time, even when Supabase isn't configured: a page that checks
  // the session is never prerendered or prefetched, and Auth's token-expiry checks
  // read the clock, which Next.js doesn't allow while prerendering.
  await connection();
  const cookieStore = await cookies();
  const config = supabaseConfig();
  if (!config) return null;

  return createServerClient(config.url, config.key, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component. The proxy keeps the session fresh.
        }
      },
    },
  });
}
