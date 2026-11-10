import type { CatalogDate, CatalogGame } from "./types";

/**
 * Labels for catalog values. Nothing here fills in a value the catalog doesn't have:
 * callers leave an unknown field out rather than show a placeholder.
 */

const dayFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });

/** To the precision the catalog records: "19 November 1993", "August 1993" or "1994". */
export function formatCatalogDate(date: CatalogDate) {
  if (date.precision === "year") return date.value;
  const [year, month, day = "1"] = date.value.split("-");
  const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.precision === "month" ? monthFormat.format(value) : dayFormat.format(value);
}

export function firstReleaseYear(game: CatalogGame) {
  return game.firstRelease ? game.firstRelease.value.slice(0, 4) : null;
}

const GAME_KINDS: Record<CatalogGame["kind"], string | null> = { game: null, compilation: "Compilation", expansion: "Expansion" };

/** Null for an ordinary game, which needs no label. */
export function gameKindLabel(kind: CatalogGame["kind"]) {
  return GAME_KINDS[kind];
}

const EDITION_KINDS: Record<string, string> = {
  standard: "Standard",
  limited: "Limited",
  collector: "Collector's",
  reprint: "Reprint",
  bundle: "Bundle",
  promotional: "Promotional",
  other: "Other",
};

export function editionKindLabel(kind: string) {
  return EDITION_KINDS[kind] ?? kind;
}

const COMPONENT_KINDS: Record<string, string> = {
  insert: "Insert",
  map: "Map",
  artwork: "Artwork",
  other: "Other",
  game_media: "Game media",
};

export function componentLabel(component: { kind: string; label: string | null; quantity: number }) {
  const name = component.label ?? COMPONENT_KINDS[component.kind] ?? component.kind;
  return component.quantity > 1 ? `${component.quantity} × ${name}` : name;
}

const ALIAS_KINDS: Record<string, string> = {
  alternate: "Also known as",
  regional: "Regional title",
  romanized: "Romanized",
  translated: "Translated",
  abbreviation: "Abbreviation",
};

export function aliasKindLabel(kind: string) {
  return ALIAS_KINDS[kind] ?? kind;
}

const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "code" });

/** "ja-Latn" reads as "Japanese (Latin)"; a code the runtime doesn't know stays a code. */
export function languageName(code: string) {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export function regionLabel(region: { code: string; label: string }) {
  return region.code === "unknown" ? "Region unknown" : region.label;
}

export function releaseCountLabel(count: number) {
  return `${count} ${count === 1 ? "release" : "releases"}`;
}
