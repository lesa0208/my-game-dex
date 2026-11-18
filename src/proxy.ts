import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { AUTH_COOKIE_OPTIONS, supabaseConfig } from "@/features/auth/cookies";
import { isProtectedPath, signInHref } from "@/features/auth/redirect";
import { bodyTooLarge } from "@/lib/body-limit";

/**
 * Refreshes the Supabase session before anything renders, following the
 * @supabase/ssr pattern: Server Components can only read cookies, so this is where
 * an expired access token is exchanged and the new cookies are written, both to the
 * request (for this render) and to the response (for the browser).
 *
 * It also sends signed-out visitors on protected pages to sign in. That's an early,
 * optimistic check only: each page and Server Action verifies the session itself.
 */
export async function proxy(request: NextRequest) {
  if (bodyTooLarge(request.method, request.nextUrl.pathname, request.headers.get("content-length"))) {
    return new NextResponse("Payload Too Large", { status: 413, headers: { "Cache-Control": "no-store" } });
  }
  const config = supabaseConfig();
  if (!config) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.key, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        // No-store headers, so a shared cache never serves one user's cookies to another.
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  // Nothing may run between creating the client and this call. It verifies the
  // access token and refreshes the session when needed.
  const { data } = await supabase.auth.getClaims();

  // Page loads only (M11a-5): a POST (a Server Action, or the data export) checks the
  // session itself and sends a signed-out request to sign in with a page it can come back
  // to. Redirecting it here would make `next` a POST-only address, which a GET after
  // signing in can't open, and a 307 would re-send the form to the sign-in page.
  const pageLoad = request.method === "GET" || request.method === "HEAD";
  if (pageLoad && !data?.claims?.sub && isProtectedPath(request.nextUrl.pathname)) {
    const target = new URL(signInHref(`${request.nextUrl.pathname}${request.nextUrl.search}`), request.url);
    const redirect = NextResponse.redirect(target);
    // Keep any cookie changes, such as clearing an expired session.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    for (const header of ["cache-control", "expires", "pragma"]) {
      const value = response.headers.get(header);
      if (value) redirect.headers.set(header, value);
    }
    return redirect;
  }

  // Must be the response setAll last built, or the refreshed cookies are lost.
  return response;
}

export const config = {
  // Every page and Server Action, but not static files or images.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)"],
};
