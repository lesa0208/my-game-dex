/**
 * The avatar form's limits and messages (M11a-3). Pure, and free of `sharp`, so the
 * browser can use it too. The limits repeat avatar-workflow.ts's, which decides
 * (profile.test.mjs checks they're equal); here they only let a person hear about a
 * file that's too big before sending it.
 */

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MIN_DIMENSION = 32;
export const AVATAR_MAX_DIMENSION = 4096;
export const AVATAR_OUTPUT_SIZE = 512;
/** What the file picker offers. Advisory only: the workflow reads the bytes, never the type or name. */
export const AVATAR_ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * The most a Server Action request may carry (next.config.ts): the largest image plus
 * room for the multipart framing and the action's own fields. Next.js refuses a bigger
 * body before the action runs.
 */
export const ACTION_BODY_LIMIT_BYTES = AVATAR_MAX_BYTES + 64 * 1024;

/** The workflow's error codes, and this form's own, as they appear in the page's URL. */
const MESSAGES: Record<string, string> = {
  avatar_missing: "Choose an image to upload.",
  avatar_too_large: "That file is over 2 MB. Choose a smaller one.",
  avatar_type: "Use a JPEG, PNG or WebP image. Other kinds of file, including GIF, SVG and HEIC, aren't accepted.",
  avatar_invalid: "That file couldn't be read as an image. It may be damaged. Try another.",
  avatar_dimensions: "Use an image between 32 and 4,096 pixels on each side, and no more than 16 megapixels.",
  avatar_not_eligible: "Your photo can't be changed while your account isn't active.",
  avatar_failed: "Your photo couldn't be saved, and your current one is unchanged. Try again.",
  avatar_unavailable: "Photos can't be changed right now. Try again later.",
  avatar_too_many: "You've uploaded ten photos in the last hour. Try again later.",
};

const FROM_WORKFLOW: Record<string, string> = {
  file_too_large: "avatar_too_large",
  unsupported_type: "avatar_type",
  invalid_image: "avatar_invalid",
  dimensions_out_of_range: "avatar_dimensions",
  not_eligible: "avatar_not_eligible",
  storage_failed: "avatar_failed",
};

/** The page's code for one of the workflow's errors; anything unexpected is a generic failure. */
export function avatarErrorCode(workflowCode: string | null | undefined): string {
  return (workflowCode && Object.hasOwn(FROM_WORKFLOW, workflowCode) && FROM_WORKFLOW[workflowCode]) || "avatar_failed";
}

export function avatarError(code: string | null): string | null {
  return code && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : null;
}

const NOTICES: Record<string, string> = {
  avatar_saved: "Your photo is updated.",
  avatar_removed: "Your photo is removed. Anyone whose browser already loaded it may keep seeing it for a while.",
};

export function avatarNotice(code: string | null): string | null {
  return code && Object.hasOwn(NOTICES, code) ? NOTICES[code] : null;
}
