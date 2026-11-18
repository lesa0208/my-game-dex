/**
 * M11a-4a: Server Actions accept 2 MB plus 64 KB (next.config.ts) for one reason, a photo
 * upload on Settings → Profile. Any other POST declaring a body over Next.js's default
 * 1 MB is refused here, before anything reads it. A body sent without a length still
 * meets Next.js's own limit.
 */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;
export const LARGE_BODY_PATHS = new Set(["/settings/profile"]);

export function bodyTooLarge(method: string, pathname: string, contentLength: string | null): boolean {
  if (method !== "POST" || LARGE_BODY_PATHS.has(pathname)) return false;
  const length = Number(contentLength);
  return Number.isFinite(length) && length > DEFAULT_BODY_LIMIT;
}
