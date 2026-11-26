import { authorizedImage, imageAuthorized, parseImageRequest } from "@/features/catalog/provider-image-server";

/**
 * M18a: an IGDB image, served only while it is authorized (see provider-image-server.ts).
 * Anything else, an unknown, unattached, withdrawn or malformed image alike, is a 404, so the
 * route says nothing about what exists. Browsers must ask again every time (no-cache, with an
 * ETag), so a withdrawal reaches them on their next request.
 */
export async function GET(request: Request, ctx: RouteContext<"/media/igdb/[size]/[image]">) {
  const { size, image } = await ctx.params;
  const parsed = parseImageRequest(size, image);
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!parsed || !(await imageAuthorized(parsed.imageId))) return notFound();
  const stored = await authorizedImage(parsed.size, parsed.imageId);
  if (!stored) return notFound();
  const headers = {
    "Content-Type": stored.type,
    "Cache-Control": "private, no-cache",
    ETag: stored.etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
  };
  if (request.headers.get("if-none-match") === stored.etag) return new Response(null, { status: 304, headers });
  return new Response(stored.bytes, { status: 200, headers });
}
