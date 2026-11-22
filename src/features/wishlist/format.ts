/**
 * M12 W2: how the physical wishlist is worded, and how its forms are read. Pure, with
 * no "@/" imports, so `npm run wishlist:test` can load it alone.
 *
 * An entry wants one of four things (W1): any physical version of a game, the game on
 * one platform, on one platform from one region, or one exact catalog release. Only an
 * exact release is a catalog edition; the others are preferences, and are never worded
 * or drawn as if a matching release were known.
 *
 * Completeness here is the lowest the collector would accept, not what a copy is: a
 * copy meets it when it's at least as complete (loose < incomplete < complete in box <
 * sealed), and a copy whose completeness isn't recorded meets no minimum.
 */

import type { WishlistItem, WishlistLevel, WishlistTarget } from "./types";

export const WISHLIST_PATH = "/collection/wishlist";
export const NOTE_MAX = 500;

export const PRIORITIES = [
  { value: 1, label: "High" },
  { value: 2, label: "Normal" },
  { value: 3, label: "Low" },
] as const;

export function priorityLabel(value: number) {
  return PRIORITIES.find((p) => p.value === value)?.label ?? "Normal";
}

/** Lowest first, as the database ranks them (private.completeness_rank). */
export const MINIMUMS = [
  { value: "loose", label: "Loose or better", short: "Loose" },
  { value: "incomplete", label: "Incomplete or better", short: "Incomplete" },
  { value: "complete", label: "Complete in box or better", short: "Complete in box" },
  { value: "sealed", label: "Sealed only", short: "Sealed" },
] as const;

/** The minimum an entry asks for. Null: any copy will do, whatever its completeness. */
export function minimumLabel(value: string | null) {
  return MINIMUMS.find((m) => m.value === value)?.label ?? "Any completeness";
}

export const LEVELS: { value: WishlistLevel; label: string; hint: string }[] = [
  { value: "game", label: "Any version", hint: "Any physical release of this game, on any platform" },
  { value: "platform", label: "On a platform", hint: "Any release on the platform you choose" },
  { value: "region", label: "Platform and region", hint: "Any release on that platform from that region, even one the catalog doesn't list yet" },
  { value: "release", label: "One exact release", hint: "One physical release from the catalog" },
];

/** Which of the four an entry wants. */
export function levelOf(item: Pick<WishlistItem, "kind" | "platform" | "region">): WishlistLevel {
  if (item.kind === "release") return "release";
  if (item.platform && item.region) return "region";
  if (item.platform) return "platform";
  return "game";
}

export function levelLabel(level: WishlistLevel) {
  return { game: "Any version", platform: "Platform", region: "Platform and region", release: "Exact release" }[level];
}

const EDITION_KINDS: Record<string, string> = {
  limited: "Limited edition",
  collector: "Collector's edition",
  reprint: "Reprint",
  bundle: "Bundle",
  promotional: "Promotional",
  other: "Other edition",
};

/** "Collector's Edition", "Platinum (Reprint)": only what the catalog records. */
export function editionLine(release: { edition_kind: string | null; edition_name: string | null } | null) {
  if (!release) return null;
  const kind = release.edition_kind ? (EDITION_KINDS[release.edition_kind] ?? null) : null;
  if (!release.edition_name) return kind;
  return kind && !release.edition_name.toLowerCase().includes(kind.toLowerCase()) ? `${release.edition_name} (${kind})` : release.edition_name;
}

/**
 * What the entry wants, in words: "Any physical version", "SNES · any region",
 * "SNES · PAL · any edition", "SNES · PAL · Collector's Edition · Red". A preference
 * says what it leaves open, so it isn't read as a known release.
 */
export function targetLine(item: Pick<WishlistItem, "kind" | "platform" | "region" | "release">) {
  const platform = item.platform?.short_name ?? item.platform?.name ?? null;
  const region = item.region ? (item.region.code === "unknown" ? "Region unknown" : (item.region.label ?? item.region.code)) : null;
  switch (levelOf(item)) {
    case "game":
      return "Any physical version";
    case "platform":
      return `${platform} · any region`;
    case "region":
      return `${platform} · ${region} · any edition`;
    case "release":
      return [platform, region, editionLine(item.release), item.release?.variant_name].filter(Boolean).join(" · ") || "One exact release";
  }
}

/** The exact release's catalog facts: format, packaging and product code, when recorded. */
export function releaseFacts(release: WishlistItem["release"]) {
  if (!release) return [];
  const format = release.format?.name ? (release.media_count && release.media_count > 1 ? `${release.media_count} × ${release.format.name}` : release.format.name) : null;
  return [format, release.product_code].filter((fact): fact is string => Boolean(fact));
}

const copies = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "copy" : "copies"}`;

/**
 * What the collector already owns that matches the entry (W1's "owned"): copies of the
 * exact release, or of any release of the game (and unidentified copies of it) on the
 * platform and in the region it names. Owning the game isn't owning the wanted edition,
 * so a release entry counts only that release.
 */
export function ownedLine(item: Pick<WishlistItem, "kind" | "owned" | "completeness">) {
  const { copies: n, meeting_completeness: meeting } = item.owned;
  const what = item.kind === "release" ? "of this release" : "that match";
  if (n === 0) return { headline: item.kind === "release" ? "You don't own this release yet" : "You don't own a matching copy yet", detail: null };
  const headline = `You own ${copies(n)} ${what}`;
  if (!item.completeness) return { headline, detail: null };
  const minimum = MINIMUMS.find((m) => m.value === item.completeness)?.short ?? "";
  const detail =
    meeting === n
      ? `${n === 1 ? "It meets" : "All of them meet"} your minimum (${minimum})`
      : `${meeting.toLocaleString("en")} of them ${meeting === 1 ? "meets" : "meet"} your minimum (${minimum}). Copies with no completeness recorded don't count.`;
  return { headline, detail };
}

/** Why an entry needs attention, if it does: the catalog changed under it. */
export function stateNotice(item: Pick<WishlistItem, "kind" | "state" | "merged" | "duplicate" | "platform">): { tone: "warning" | "info"; text: string } | null {
  if (item.state === "unavailable") {
    return {
      tone: "warning",
      text:
        item.kind === "release"
          ? "This release is no longer in the catalog. Your wish is kept as you made it: choose another release, or remove it."
          : "This game is no longer in the catalog. Your wish is kept as you made it.",
    };
  }
  if (item.state === "platform_unavailable") {
    return {
      tone: "warning",
      text: `The catalog no longer lists this game on ${item.platform?.name ?? "this platform"}. Your wish is kept: choose another platform, or any version.`,
    };
  }
  if (item.duplicate) return { tone: "info", text: "After a catalog merge, another of your wishes wants the same thing. You may want to remove one." };
  if (item.merged) return { tone: "info", text: "The catalog merged a duplicate record into this one, so your wish now points to it." };
  return null;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGION = /^[a-z0-9-]{1,32}$/;

type Read = (name: string) => string;

/**
 * The target a form names, by its level: the fields of the other levels are ignored, so
 * a form that shows them all (before JavaScript, or after switching level) sends only
 * what its level uses. The database checks the catalog again.
 */
export function readTarget(read: Read): { target: WishlistTarget } | { error: string } {
  const level = read("level");
  const game = read("game_id");
  const platform = read("platform_id");
  const region = read("region_code");
  const release = read("release_id");
  switch (level) {
    case "release":
      return UUID.test(release) ? { target: { release_id: release } } : { error: "Choose a release from the list." };
    case "game":
    case "platform":
    case "region": {
      if (!UUID.test(game)) return { error: "This game can't be added to your wishlist. Try again." };
      if (level === "game") return { target: { game_id: game } };
      if (!UUID.test(platform)) return { error: "Choose a platform from the list." };
      if (level === "platform") return { target: { game_id: game, platform_id: platform } };
      if (!REGION.test(region) || region === "unknown") return { error: "Choose a region from the list." };
      return { target: { game_id: game, platform_id: platform, region_code: region } };
    }
    default:
      return { error: "Choose what you want: any version, a platform, a platform and region, or one release." };
  }
}

export function sameTarget(a: WishlistTarget, b: WishlistTarget) {
  return (a.release_id ?? null) === (b.release_id ?? null) && (a.game_id ?? null) === (b.game_id ?? null) && (a.platform_id ?? null) === (b.platform_id ?? null) && (a.region_code ?? null) === (b.region_code ?? null);
}

export type WishDetails = { priority: 1 | 2 | 3; completeness: string | null; note: string | null };

/** The note as the database keeps it: NFC, line breaks as \n, trimmed; empty is none. */
export function tidyNote(value: string) {
  const tidy = value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/^[ \n]+|[ \n]+$/g, "");
  return tidy === "" ? null : tidy;
}

/** Priority, minimum completeness and note. The database checks them again. */
export function readDetails(read: Read): { details: WishDetails } | { error: string } {
  const priority = Number(read("priority") || "2");
  if (priority !== 1 && priority !== 2 && priority !== 3) return { error: "Choose a priority from the list." };
  const completeness = read("completeness") || null;
  if (completeness !== null && !MINIMUMS.some((m) => m.value === completeness)) return { error: "Choose a completeness from the list." };
  const note = tidyNote(read("note"));
  if (note !== null && [...note].length > NOTE_MAX) return { error: `Keep the note to ${NOTE_MAX} characters.` };
  if (note !== null && /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(note)) return { error: "The note can't contain control characters." };
  return { details: { priority, completeness, note } };
}

/**
 * A fixed message for each refusal W1's functions give, never the database's own text.
 * renewId: the request id can't be retried, so the form takes a fresh one.
 */
export function wishErrorMessage(message: unknown): { text: string; renewId: boolean; signedOut?: boolean } {
  switch (message) {
    case "not permitted":
      return { text: "Sign in to change your wishlist.", renewId: false, signedOut: true };
    case "account not active":
      return { text: "Your account can't change its wishlist right now.", renewId: false };
    case "release unavailable":
      return { text: "That release isn't in the catalog any more. Choose another.", renewId: false };
    case "game unavailable":
      return { text: "This game isn't in the catalog any more, so it can't be wanted again.", renewId: false };
    case "platform unavailable":
      return { text: "The catalog doesn't list this game on that platform. Choose another.", renewId: false };
    case "invalid region":
      return { text: "Choose a region from the list.", renewId: false };
    case "invalid target":
      return { text: "Choose what you want from the list.", renewId: false };
    case "invalid details":
      return { text: "Check the priority, completeness and note.", renewId: false };
    case "wishlist limit reached":
      return { text: "Your wishlist is full (10,000 wishes). Remove one to add another.", renewId: false };
    case "already on wishlist":
      return { text: "Another of your wishes already wants exactly that. Edit that one instead.", renewId: false };
    case "item unavailable":
      return { text: "This wish isn't on your wishlist any more.", renewId: false };
    case "request conflict":
    case "invalid item id":
      return { text: "This wish changed while it was being saved. Check it and try again.", renewId: true };
    default:
      return { text: "Your wishlist couldn't be changed. Try again.", renewId: false };
  }
}
