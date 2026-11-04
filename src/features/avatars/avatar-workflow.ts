/**
 * Server-only avatar workflow. Import it through ./server, which enforces that.
 *
 * Clients have no write access to the avatars bucket. A future route handler
 * passes the user's access token and the uploaded bytes here. This file verifies
 * the session on every mutation, validates and re-encodes the image, and writes
 * with the secret key, which never leaves the server.
 *
 * Errors carry a code only. Upstream responses are never passed back to a client.
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_DIMENSION = 4096;
export const MIN_DIMENSION = 32;
export const OUTPUT_SIZE = 512;
// Refused from the header, before decoding. Set below MAX_DIMENSION squared so each
// limit does its own job: this one bounds total memory, and the other bounds each side.
export const MAX_INPUT_PIXELS = 16_000_000;
const BUCKET = "avatars";

export type AvatarErrorCode =
  | "file_too_large"
  | "unsupported_type"
  | "invalid_image"
  | "dimensions_out_of_range"
  | "not_authenticated"
  | "not_eligible"
  | "storage_failed";

export class AvatarError extends Error {
  readonly code: AvatarErrorCode;

  constructor(code: AvatarErrorCode) {
    super(code);
    this.code = code;
    this.name = "AvatarError";
  }
}

export type AvatarConfig = {
  supabaseUrl: string;
  /** Public key, sent with the user's own token. */
  publishableKey: string;
  /** Never expose this. It must not use a NEXT_PUBLIC_ variable. */
  secretKey: string;
};

type AllowedFormat = "jpeg" | "png" | "webp";

/** Identifies a file by its bytes. The declared type and file name are never trusted. */
export function sniffImageFormat(bytes: Uint8Array): AllowedFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/**
 * Validates by decoding the image, then re-encodes to a fixed-size WebP. Metadata,
 * including location data, isn't carried over.
 */
export async function processAvatarImage(input: Uint8Array): Promise<Buffer> {
  if (input.length > MAX_UPLOAD_BYTES) throw new AvatarError("file_too_large");

  const sniffed = sniffImageFormat(input);
  if (!sniffed) throw new AvatarError("unsupported_type");

  const options = { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, animated: false } as const;

  try {
    const metadata = await sharp(input, options).metadata();
    if (metadata.format !== sniffed) throw new AvatarError("unsupported_type");
    if ((metadata.pages ?? 1) > 1) throw new AvatarError("unsupported_type");

    const { width, height } = metadata;
    if (
      !width ||
      !height ||
      width < MIN_DIMENSION ||
      height < MIN_DIMENSION ||
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION
    ) {
      throw new AvatarError("dimensions_out_of_range");
    }

    return await sharp(input, options)
      .rotate()
      .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "cover" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (error) {
    if (error instanceof AvatarError) throw error;
    // Includes images over the pixel limit, truncated data and undecodable files.
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      throw new AvatarError("dimensions_out_of_range");
    }
    throw new AvatarError("invalid_image");
  }
}

function serviceHeaders(config: AvatarConfig): Record<string, string> {
  return { apikey: config.secretKey, Authorization: `Bearer ${config.secretKey}` };
}

/** Verifies with the Auth server on every mutation, and checks the account is active. */
async function verifyActiveUser(config: AvatarConfig, accessToken: string): Promise<string> {
  const userHeaders = { apikey: config.publishableKey, Authorization: `Bearer ${accessToken}` };

  const userResponse = await fetch(`${config.supabaseUrl}/auth/v1/user`, { headers: userHeaders });
  if (!userResponse.ok) throw new AvatarError("not_authenticated");
  const user = (await userResponse.json()) as { id?: string };
  if (!user.id) throw new AvatarError("not_authenticated");

  const accountResponse = await fetch(`${config.supabaseUrl}/rest/v1/rpc/get_my_account`, {
    method: "POST",
    headers: { ...userHeaders, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!accountResponse.ok) throw new AvatarError("not_eligible");
  const [account] = (await accountResponse.json()) as { id: string; is_active: boolean }[];
  if (!account || account.id !== user.id || !account.is_active) throw new AvatarError("not_eligible");

  return user.id;
}

async function uploadObject(config: AvatarConfig, path: string, body: Buffer): Promise<void> {
  const response = await fetch(`${config.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      ...serviceHeaders(config),
      "Content-Type": "image/webp",
      // A new random name each time, so a file can be cached indefinitely.
      "Cache-Control": "max-age=31536000, immutable",
      "x-upsert": "false",
    },
    body: new Uint8Array(body),
  });
  if (!response.ok) throw new AvatarError("storage_failed");
}

async function removeObjects(config: AvatarConfig, paths: string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  const response = await fetch(`${config.supabaseUrl}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: { ...serviceHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: paths }),
  });
  return response.ok;
}

async function setAvatarPath(config: AvatarConfig, userId: string, path: string | null): Promise<string | null> {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/set_avatar_path`, {
    method: "POST",
    headers: { ...serviceHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify({ p_user_id: userId, p_path: path }),
  });
  if (!response.ok) throw new AvatarError("storage_failed");
  return (await response.json()) as string | null;
}

/**
 * Validates, stores and activates a new avatar, then removes the old file. A failed
 * activation removes the new file, so the current avatar keeps working.
 */
export async function replaceAvatar(
  config: AvatarConfig,
  accessToken: string,
  input: Uint8Array,
): Promise<{ path: string; previousRemoved: boolean }> {
  const userId = await verifyActiveUser(config, accessToken);
  const image = await processAvatarImage(input);
  const path = `${userId}/${randomUUID()}.webp`;

  await uploadObject(config, path, image);

  let previous: string | null;
  try {
    previous = await setAvatarPath(config, userId, path);
  } catch (error) {
    await removeObjects(config, [path]);
    throw error;
  }

  const previousRemoved = previous ? await removeObjects(config, [previous]) : true;
  return { path, previousRemoved };
}

export async function removeAvatar(
  config: AvatarConfig,
  accessToken: string,
): Promise<{ previousRemoved: boolean }> {
  const userId = await verifyActiveUser(config, accessToken);
  const previous = await setAvatarPath(config, userId, null);
  return { previousRemoved: previous ? await removeObjects(config, [previous]) : true };
}

/**
 * Removes a user's files, then the user, which cascades to their account records.
 * Storage files don't cascade from the database. Callers must have authorized this:
 * it takes a user ID, not a session, and is never exposed directly to clients.
 */
export async function deleteAccountWithAvatars(config: AvatarConfig, userId: string): Promise<void> {
  const listResponse = await fetch(`${config.supabaseUrl}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { ...serviceHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: `${userId}/`, limit: 1000 }),
  });
  if (!listResponse.ok) throw new AvatarError("storage_failed");

  // A retry after a partial failure must not leave a profile pointing at a removed file.
  await setAvatarPath(config, userId, null);

  const objects = (await listResponse.json()) as { name: string }[];
  const removed = await removeObjects(
    config,
    objects.map((object) => `${userId}/${object.name}`),
  );
  if (!removed) throw new AvatarError("storage_failed");

  const deleteResponse = await fetch(`${config.supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: serviceHeaders(config),
  });
  if (!deleteResponse.ok) throw new AvatarError("storage_failed");
}
