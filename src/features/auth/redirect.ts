/**
 * Where to send someone after signing in or claiming a handle. Only a path on this
 * site is accepted, so a crafted `?next=` can't send anyone elsewhere (an open
 * redirect). Anything else falls back to a fixed page.
 */

export const DEFAULT_AFTER_SIGN_IN = "/home";

/** Pages that need a signed-in account. The proxy and each page both check. */
export const PROTECTED_PATHS = ["/collection", "/profile", "/settings", "/welcome"] as const;

const BASE = "http://next.invalid";

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function safeNextPath(value: unknown, fallback: string = DEFAULT_AFTER_SIGN_IN): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return fallback;
  // A single leading slash only: "//host" and "/\host" are read by browsers as
  // another site. Control characters and backslashes are never part of our paths.
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;

  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;

  const path = `${url.pathname}${url.search}`;
  // Sending someone back to sign in after signing in would loop.
  if (url.pathname === "/sign-in" || url.pathname.startsWith("/sign-in/")) return fallback;
  return path;
}

export function signInHref(next: string): string {
  const path = safeNextPath(next, "");
  return path ? `/sign-in?next=${encodeURIComponent(path)}` : "/sign-in";
}

export function welcomeHref(next: string): string {
  const path = safeNextPath(next, "");
  return path && path !== "/welcome" ? `/welcome?next=${encodeURIComponent(path)}` : "/welcome";
}
