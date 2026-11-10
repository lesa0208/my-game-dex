/**
 * Reads the search functions' JSON into the catalog types. Each parser copies only
 * the fields it knows, so anything else in a response never reaches the UI, and
 * throws on a response of the wrong shape rather than showing a guess.
 *
 * No imports but types, so `node --test` can run it directly (see parse.test.mjs).
 */
import type {
  CatalogDate,
  CatalogGame,
  CatalogPlatform,
  CatalogPlatformCount,
  PickerRelease,
  ReleasePicker,
  SearchResponse,
  SearchResult,
} from "./types";

export class CatalogShapeError extends Error {
  constructor(path: string) {
    super(`Unexpected catalog response at ${path}`);
    this.name = "CatalogShapeError";
  }
}

type Json = Record<string, unknown>;

function object(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CatalogShapeError(path);
  return value as Json;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new CatalogShapeError(path);
  return value;
}
function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new CatalogShapeError(path);
  return value;
}
function optionalString(value: unknown, path: string): string | null {
  return value === null || value === undefined ? null : string(value, path);
}
function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new CatalogShapeError(path);
  return value;
}
function optionalInteger(value: unknown, path: string): number | null {
  return value === null || value === undefined ? null : integer(value, path);
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new CatalogShapeError(path);
  return value as T;
}
function stringList(value: unknown, path: string): string[] | null {
  return value === null || value === undefined ? null : array(value, path).map((item, i) => string(item, `${path}[${i}]`));
}

function date(value: unknown, path: string): CatalogDate | null {
  if (value === null || value === undefined) return null;
  const d = object(value, path);
  return { value: string(d.value, `${path}.value`), precision: oneOf(d.precision, ["day", "month", "year"] as const, `${path}.precision`) };
}

function game(value: unknown, path: string): CatalogGame {
  const g = object(value, path);
  return {
    id: string(g.id, `${path}.id`),
    slug: string(g.slug, `${path}.slug`),
    title: string(g.title, `${path}.title`),
    kind: oneOf(g.kind, ["game", "compilation", "expansion"] as const, `${path}.kind`),
    firstRelease: date(g.first_release, `${path}.first_release`),
  };
}

function platformRef(value: unknown, path: string) {
  const p = object(value, path);
  return { slug: string(p.slug, `${path}.slug`), name: string(p.name, `${path}.name`), shortName: string(p.short_name, `${path}.short_name`) };
}

function platformCount(value: unknown, path: string): CatalogPlatformCount {
  const p = object(value, path);
  return { ...platformRef(p, path), releaseCount: integer(p.release_count, `${path}.release_count`) };
}

function region(value: unknown, path: string) {
  const r = object(value, path);
  return { code: string(r.code, `${path}.code`), label: string(r.label, `${path}.label`) };
}

function identifiers(value: unknown, path: string) {
  const i = object(value, path);
  return { productCode: optionalString(i.product_code, `${path}.product_code`), barcode: optionalString(i.barcode, `${path}.barcode`) };
}

function result(value: unknown, path: string): SearchResult {
  const item = object(value, path);
  if (item.kind === "release") {
    const release = object(item.release, `${path}.release`);
    return {
      kind: "release",
      match: "code",
      matchedIdentifier: oneOf(item.matched_identifier, ["product_code", "barcode"] as const, `${path}.matched_identifier`),
      game: game(item.game, `${path}.game`),
      release: {
        id: string(release.id, `${path}.release.id`),
        platform: platformRef(release.platform, `${path}.release.platform`),
        region: region(release.region, `${path}.release.region`),
        editionName: optionalString(release.edition_name, `${path}.release.edition_name`),
        variantName: optionalString(release.variant_name, `${path}.release.variant_name`),
        identifiers: identifiers(release.identifiers, `${path}.release.identifiers`),
      },
    };
  }
  if (item.kind !== "game") throw new CatalogShapeError(`${path}.kind`);
  const matched = item.matched === null || item.matched === undefined ? null : object(item.matched, `${path}.matched`);
  return {
    kind: "game",
    match: oneOf(item.match, ["exact", "prefix", "words", "similar", "browse"] as const, `${path}.match`),
    matched: matched
      ? { title: string(matched.title, `${path}.matched.title`), source: oneOf(matched.source, ["alias", "local_title"] as const, `${path}.matched.source`) }
      : null,
    game: game(item.game, `${path}.game`),
    platforms: array(item.platforms, `${path}.platforms`).map((p, i) => platformCount(p, `${path}.platforms[${i}]`)),
  };
}

export function parseSearchResponse(value: unknown): SearchResponse {
  const body = object(value, "search");
  return {
    status: oneOf(body.status, ["ok", "empty", "too_short"] as const, "search.status"),
    platforms: array(body.platforms, "search.platforms").map((p, i) => string(p, `search.platforms[${i}]`)),
    items: array(body.items, "search.items").map((item, i) => result(item, `search.items[${i}]`)),
    nextCursor: optionalString(body.next_cursor, "search.next_cursor"),
  };
}

export function parsePlatforms(value: unknown): CatalogPlatform[] {
  return array(value, "platforms").map((item, i) => {
    const p = object(item, `platforms[${i}]`);
    return {
      ...platformRef(p, `platforms[${i}]`),
      family: string(p.family, `platforms[${i}].family`),
      gameCount: integer(p.game_count, `platforms[${i}].game_count`),
    };
  });
}

function pickerRelease(value: unknown, path: string): PickerRelease {
  const r = object(value, path);
  const edition = r.edition === null || r.edition === undefined ? null : object(r.edition, `${path}.edition`);
  const format = r.format === null || r.format === undefined ? null : object(r.format, `${path}.format`);
  return {
    id: string(r.id, `${path}.id`),
    platform: platformRef(r.platform, `${path}.platform`),
    region: region(r.region, `${path}.region`),
    markets: array(r.markets, `${path}.markets`).map((m, i) => {
      const market = object(m, `${path}.markets[${i}]`);
      return { code: string(market.code, `${path}.markets[${i}].code`), name: string(market.name, `${path}.markets[${i}].name`) };
    }),
    edition: edition ? { name: optionalString(edition.name, `${path}.edition.name`), kind: optionalString(edition.kind, `${path}.edition.kind`) } : null,
    variantName: optionalString(r.variant_name, `${path}.variant_name`),
    localTitle: optionalString(r.local_title, `${path}.local_title`),
    publisherName: optionalString(r.publisher_name, `${path}.publisher_name`),
    format: format
      ? { code: string(format.code, `${path}.format.code`), name: string(format.name, `${path}.format.name`), category: string(format.category, `${path}.format.category`) }
      : null,
    mediaCount: optionalInteger(r.media_count, `${path}.media_count`),
    mediaPlayability:
      r.media_playability === null || r.media_playability === undefined
        ? null
        : oneOf(r.media_playability, ["playable_from_media", "download_required"] as const, `${path}.media_playability`),
    packaging: optionalString(r.packaging, `${path}.packaging`),
    identifiers: identifiers(r.identifiers, `${path}.identifiers`),
    languages: stringList(r.languages, `${path}.languages`),
    ratingLabels: stringList(r.rating_labels, `${path}.rating_labels`),
    releaseDate: date(r.release_date, `${path}.release_date`),
    components: array(r.components, `${path}.components`).map((c, i) => {
      const component = object(c, `${path}.components[${i}]`);
      return {
        kind: string(component.kind, `${path}.components[${i}].kind`),
        label: optionalString(component.label, `${path}.components[${i}].label`),
        quantity: integer(component.quantity, `${path}.components[${i}].quantity`),
        format: optionalString(component.format, `${path}.components[${i}].format`),
      };
    }),
    requirements: array(r.requirements, `${path}.requirements`).map((h, i) => {
      const requirement = object(h, `${path}.requirements[${i}]`);
      return {
        code: string(requirement.code, `${path}.requirements[${i}].code`),
        label: string(requirement.label, `${path}.requirements[${i}].label`),
        level: string(requirement.level, `${path}.requirements[${i}].level`),
        note: optionalString(requirement.note, `${path}.requirements[${i}].note`),
      };
    }),
  };
}

/** Null means no public game: unknown, unpublished and every other case alike. */
export function parseReleasePicker(value: unknown): ReleasePicker | null {
  if (value === null) return null;
  const body = object(value, "picker");
  const g = object(body.game, "picker.game");
  const selection = object(body.selection, "picker.selection");
  return {
    game: {
      ...game(g, "picker.game"),
      aliases: array(g.aliases, "picker.game.aliases").map((a, i) => {
        const alias = object(a, `picker.game.aliases[${i}]`);
        return {
          title: string(alias.title, `picker.game.aliases[${i}].title`),
          kind: string(alias.kind, `picker.game.aliases[${i}].kind`),
          languageCode: optionalString(alias.language_code, `picker.game.aliases[${i}].language_code`),
          regionCode: optionalString(alias.region_code, `picker.game.aliases[${i}].region_code`),
        };
      }),
    },
    platforms: array(body.platforms, "picker.platforms").map((p, i) => platformCount(p, `picker.platforms[${i}]`)),
    regions: array(body.regions, "picker.regions").map((r, i) => {
      const item = object(r, `picker.regions[${i}]`);
      return { ...region(item, `picker.regions[${i}]`), releaseCount: integer(item.release_count, `picker.regions[${i}].release_count`) };
    }),
    selection: {
      platform: optionalString(selection.platform, "picker.selection.platform"),
      region: optionalString(selection.region, "picker.selection.region"),
      releaseId: optionalString(selection.release_id, "picker.selection.release_id"),
    },
    releases: array(body.releases, "picker.releases").map((r, i) => pickerRelease(r, `picker.releases[${i}]`)),
  };
}
