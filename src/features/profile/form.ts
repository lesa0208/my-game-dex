/**
 * Profile editing (M11a-3): the display name and bio as the M2 `profiles` checks define
 * them, and the page's messages. Pure, so it can be tested without a server.
 *
 * The database decides. These checks mirror its rules only so a person hears what's
 * wrong before saving, and say the same thing when the database refuses. Nothing here
 * accepts what the database would refuse, or refuses what it accepts, except where noted.
 *
 *   display_name: 1–50 characters, NFKC normalized, no control characters, no
 *                 zero-width or bidirectional formatting characters, and not presenting
 *                 as the platform (private.validate_display_name, which only the
 *                 database can check: the reserved terms are in a private table).
 *   bio:          up to 500 characters, no zero-width or bidirectional formatting
 *                 characters. Line breaks are allowed.
 *
 * "Characters" are Unicode code points, as Postgres's char_length counts them, not
 * JavaScript's UTF-16 units: an emoji outside the Basic Multilingual Plane is one.
 */

export const DISPLAY_NAME_MAX = 50;
export const BIO_MAX = 500;

/** The zero-width and bidirectional formatting characters both columns refuse. */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/u;
/** Control characters, which the display name refuses. The bio allows line breaks and tabs. */
const CONTROL = /\p{Cc}/u;

export const characterCount = (value: string): number => [...value].length;

/**
 * As saved: surrounding spaces trimmed and NFKC normalized, which the database requires
 * (so a ligature like "ﬁ" is saved as "fi" rather than refused). Empty means none, and
 * the profile then shows the handle.
 */
export function normalizeDisplayName(raw: string): string | null {
  const value = raw.normalize("NFKC").trim();
  return value === "" ? null : value;
}

/**
 * As saved: a browser sends a textarea's line breaks as CRLF, which would count twice
 * against the limit, so they become LF; surrounding whitespace is trimmed. Empty means none.
 */
export function normalizeBio(raw: string): string | null {
  const value = raw.replace(/\r\n?/g, "\n").trim();
  return value === "" ? null : value;
}

export type ProfileProblem =
  | "display_name_too_long"
  | "display_name_characters"
  | "display_name_invisible"
  | "bio_too_long"
  | "bio_invisible";

/** The first rule the normalized values break, or null. */
export function profileProblem(displayName: string | null, bio: string | null): ProfileProblem | null {
  if (displayName !== null) {
    if (characterCount(displayName) > DISPLAY_NAME_MAX) return "display_name_too_long";
    if (INVISIBLE.test(displayName)) return "display_name_invisible";
    if (CONTROL.test(displayName)) return "display_name_characters";
  }
  if (bio !== null) {
    if (characterCount(bio) > BIO_MAX) return "bio_too_long";
    if (INVISIBLE.test(bio)) return "bio_invisible";
  }
  return null;
}

export type ProfileError = ProfileProblem | "display_name_reserved" | "display_name_invalid" | "bio_invalid" | "not_active" | "failed";

/**
 * The database's refusals of a profile update, by their fixed messages: the trigger's
 * own, or the name of the CHECK constraint. Anything else is a generic failure.
 */
export function profileErrorFrom(error: { code?: string; message?: string } | null | undefined): ProfileError {
  const message = error?.message ?? "";
  if (message === "display name not allowed") return "display_name_reserved";
  if (error?.code === "23514" && message.includes("profiles_display_name_check")) return "display_name_invalid";
  if (error?.code === "23514" && message.includes("profiles_bio_check")) return "bio_invalid";
  return "failed";
}

const MESSAGES: Record<ProfileError, string> = {
  display_name_too_long: `Use up to ${DISPLAY_NAME_MAX} characters for your display name.`,
  display_name_characters: "Your display name can't contain control characters. Use letters, numbers, spaces and punctuation.",
  display_name_invisible:
    "Your display name contains an invisible formatting character, such as the joiner inside some emoji. Remove it and try again.",
  display_name_reserved: "That display name isn't allowed: it could be mistaken for My Game Dex itself. Choose another.",
  display_name_invalid: "That display name can't be saved. Use up to 50 letters, numbers, spaces and punctuation.",
  bio_too_long: `Use up to ${BIO_MAX} characters for your bio.`,
  bio_invisible: "Your bio contains an invisible formatting character, such as the joiner inside some emoji. Remove it and try again.",
  bio_invalid: `That bio can't be saved. Use up to ${BIO_MAX} characters.`,
  not_active: "Your profile can't be changed while your account isn't active.",
  failed: "Your profile couldn't be saved. Try again.",
};

/** Which field an error is about, so the page can mark that field. */
export function profileErrorField(code: string | null): "display_name" | "bio" | null {
  if (!code) return null;
  if (code.startsWith("display_name")) return "display_name";
  if (code.startsWith("bio")) return "bio";
  return null;
}

/** A fixed message for a code in the page's URL; anything else shows nothing. */
export function profileError(code: string | null): string | null {
  return code && Object.hasOwn(MESSAGES, code) ? MESSAGES[code as ProfileError] : null;
}

const NOTICES: Record<string, string> = {
  profile_saved: "Your profile is saved.",
};

export function profileNotice(code: string | null): string | null {
  return code && Object.hasOwn(NOTICES, code) ? NOTICES[code] : null;
}

/** The collection's visibility, as `get_my_account` reports it, in words. */
export function collectionVisibilityText(level: string | null): string {
  switch (level) {
    case "private":
      return "Private. Only you can see your collection.";
    case "followers":
      return "Followers. People you've approved as followers can see your collection.";
    case "public":
      return "Public. Anyone can see your collection, apart from accounts you've blocked.";
    default:
      return "Unknown. Your collection's visibility couldn't be read.";
  }
}
