import "server-only";

import { createHash } from "node:crypto";

import { IGDB_IMAGE_SIZES, type IgdbImageSize } from "./provider-images";

/**
 * M18a security fix: IGDB images are served by the app's own route
 * (src/app/media/igdb/[size]/[image]/route.ts), never by the image optimizer, and only while
 * the asset is authorized. Every request asks the database (public.provider_image_allowed, the
 * server's secret key only): the image must be the cover or a screenshot of the latest attached
 * record of a published game, with the provider and its media cleared now. The deployment must
 * also allow provider media (MGD_PROVIDER_MEDIA): a second gate, never the only one.
 *
 * Nothing is written to disk. A small in-memory store keeps fetched bytes so a page of
 * screenshots doesn't refetch them from IGDB, but it is read only after the authorization check
 * passes, so a withdrawal takes effect on the next request; it doesn't survive a restart.
 */

const IMAGE_ID = /^[a-z0-9]{1,40}$/;
const UPSTREAM = "https://images.igdb.com/igdb/image/upload";
const MAX_BYTES = 5 * 1024 * 1024;
const STORE_LIMIT = 300;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

type Stored = { bytes: ArrayBuffer; type: string; etag: string };
const store = new Map<string, Stored>();

export function parseImageRequest(size: string, file: string): { size: IgdbImageSize; imageId: string } | null {
  const imageId = file.endsWith(".jpg") ? file.slice(0, -4) : null;
  if (!imageId || !IMAGE_ID.test(imageId) || !(IGDB_IMAGE_SIZES as readonly string[]).includes(size)) return null;
  return { size: size as IgdbImageSize, imageId };
}

function mediaAllowedHere() {
  return (process.env.MGD_PROVIDER_MEDIA ?? "").split(",").map((s) => s.trim()).includes("igdb");
}

/** Asks the database whether this image may be served now. Any failure is a no. */
export async function imageAuthorized(imageId: string): Promise<boolean> {
  if (!mediaAllowedHere()) return false;
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return false;
  const response = await fetch(`${url}/rest/v1/rpc/provider_image_allowed`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_provider: "igdb", p_image_id: imageId }),
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!response?.ok) return false;
  return (await response.json().catch(() => false)) === true;
}

/** Where IGDB's images come from: IGDB, or a local stand-in for the checks (loopback only). */
function upstreamBase() {
  const override = process.env.MGD_IGDB_IMAGE_ORIGIN;
  if (!override) return UPSTREAM;
  try {
    return LOOPBACK.has(new URL(override).hostname) ? override.replace(/\/$/, "") : UPSTREAM;
  } catch {
    return UPSTREAM;
  }
}

/** The image's bytes, from the store or IGDB. Call only after imageAuthorized. */
export async function authorizedImage(size: IgdbImageSize, imageId: string): Promise<Stored | null> {
  const key = `${size}/${imageId}`;
  const hit = store.get(key);
  if (hit) {
    store.delete(key);
    store.set(key, hit);
    return hit;
  }
  const response = await fetch(`${upstreamBase()}/t_${size}/${imageId}.jpg`, { cache: "no-store", signal: AbortSignal.timeout(10000) }).catch(() => null);
  const type = response?.headers.get("content-type") ?? "";
  if (!response?.ok || !/^image\/(jpeg|png|webp)$/.test(type.split(";")[0].trim())) return null;
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) return null;
  const stored = { bytes, type: type.split(";")[0].trim(), etag: `"${createHash("sha256").update(Buffer.from(bytes)).digest("base64url").slice(0, 27)}"` };
  store.set(key, stored);
  while (store.size > STORE_LIMIT) store.delete(store.keys().next().value as string);
  return stored;
}
