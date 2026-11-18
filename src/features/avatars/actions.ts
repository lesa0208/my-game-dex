"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { withParam } from "@/features/admin/form";
import { signInHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";

import { AVATAR_MAX_BYTES, avatarErrorCode } from "./form";
import { AvatarError, avatarConfig, removeAvatar, replaceAvatar } from "./server";

/**
 * Uploading, replacing and removing your avatar (M11a-3), through the M2 workflow
 * unchanged in its checks: it verifies the session with Auth and that the account is
 * active, reads the image's bytes (never its name or declared type), re-encodes it to a
 * 512×512 WebP without metadata, and writes it with the secret key to the verified
 * user's own folder. The browser never writes to Storage.
 *
 * Next.js refuses a request from another site, and one over the body limit in
 * next.config.ts, before these run. Errors come back as fixed codes in the page's URL.
 */

const PROFILE = "/settings/profile";

/** The signed-in person's verified id and their session's access token, or a redirect to sign in. */
async function session(): Promise<{ token: string }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect(withParam(PROFILE, "error", "avatar_unavailable"));
  // The token's signature is verified first; the workflow then asks Auth whether its
  // session is still live, which a token from a signed-out session isn't.
  const { data: auth } = await supabase.auth.getClaims();
  if (typeof auth?.claims?.sub !== "string") redirect(signInHref(PROFILE));
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect(signInHref(PROFILE));
  return { token };
}

function fail(error: unknown): never {
  if (error instanceof AvatarError && error.code === "not_authenticated") redirect(signInHref(PROFILE));
  redirect(withParam(PROFILE, "error", avatarErrorCode(error instanceof AvatarError ? error.code : null)));
}

/** Only that an old file stayed behind, never whose: the next change removes it (removeLeftovers). */
function noteLeftovers(result: { previousRemoved: boolean; leftoversRemoved: boolean }) {
  if (!result.previousRemoved || !result.leftoversRemoved) console.error("avatar: a previous file couldn't be removed yet; the next change retries");
}

export async function uploadAvatar(formData: FormData): Promise<void> {
  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) redirect(withParam(PROFILE, "error", "avatar_missing"));
  // Before reading it: the workflow checks the bytes' length again.
  if (file.size > AVATAR_MAX_BYTES) redirect(withParam(PROFILE, "error", "avatar_too_large"));
  const config = avatarConfig();
  if (!config) redirect(withParam(PROFILE, "error", "avatar_unavailable"));
  const { token } = await session();

  let result: Awaited<ReturnType<typeof replaceAvatar>>;
  try {
    result = await replaceAvatar(config, token, new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    fail(error);
  }
  noteLeftovers(result);
  refresh();
  redirect(withParam(PROFILE, "notice", "avatar_saved"));
}

export async function deleteAvatar(): Promise<void> {
  const config = avatarConfig();
  if (!config) redirect(withParam(PROFILE, "error", "avatar_unavailable"));
  const { token } = await session();

  let result: Awaited<ReturnType<typeof removeAvatar>>;
  try {
    result = await removeAvatar(config, token);
  } catch (error) {
    fail(error);
  }
  noteLeftovers(result);
  refresh();
  redirect(withParam(PROFILE, "notice", "avatar_removed"));
}
