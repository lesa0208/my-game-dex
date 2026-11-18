import "server-only";

import type { AvatarConfig } from "./avatar-workflow";

export {
  AvatarError,
  deleteAccountWithAvatars,
  processAvatarImage,
  removeAvatar,
  replaceAvatar,
  type AvatarConfig,
  type AvatarErrorCode,
} from "./avatar-workflow";

/**
 * The workflow's configuration from server-only variables (M11a-3), or null when any is
 * missing. SUPABASE_SECRET_KEY is never a NEXT_PUBLIC_ variable and never leaves the
 * server: the workflow uses it only for the avatars bucket and set_avatar_path, in the
 * verified user's own folder, never for Auth.
 */
export function avatarConfig(): AvatarConfig | null {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  return supabaseUrl && publishableKey && secretKey ? { supabaseUrl, publishableKey, secretKey } : null;
}
