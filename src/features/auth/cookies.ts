import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Settings shared by every Supabase client in this app. There's no browser client:
 * the session is read and written only on the server (the proxy, Server Components
 * and Server Actions), so the auth cookies can be `httpOnly` and page scripts can't
 * read the tokens. Adding a browser client later would mean removing `httpOnly`.
 *
 * The URL and publishable key are server-only variables (see .env.example), never
 * NEXT_PUBLIC_, so they don't reach the browser bundle.
 */
export const AUTH_COOKIE_OPTIONS: CookieOptionsWithName = {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
};

export function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}
