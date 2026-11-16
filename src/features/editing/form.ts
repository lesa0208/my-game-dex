/**
 * Catalog editing (M10c): the editing forms' rules, read against the record as it is
 * now so only what an editor changed is sent, and the fixed messages for the
 * database's errors. Nothing is filled in on the editor's behalf: a reason is always
 * typed. Pure, so it can be tested alone; the release fields are read with
 * features/review/form.ts, as in review.
 */

type Read = (name: string) => string;
type Result<T> = { value: T } | { error: string };

/** The same lists as features/review/form.ts and the database's enums; a unit test keeps them the same. */
export const GAME_KINDS = [
  { value: "game", label: "Game" },
  { value: "compilation", label: "Compilation" },
  { value: "expansion", label: "Expansion" },
] as const;

export const ALIAS_KINDS = [
  { value: "alternate", label: "Another title" },
  { value: "regional", label: "A regional title" },
  { value: "romanized", label: "A romanization" },
  { value: "translated", label: "A translation" },
  { value: "abbreviation", label: "A short form" },
] as const;

export const RELATIONS = [
  { value: "remake_of", label: "Is a remake of" },
  { value: "remaster_of", label: "Is a remaster of" },
  { value: "contains", label: "Contains (compilations only)" },
] as const;

export const REQUIREMENT_LEVELS = [
  { value: "required", label: "Required" },
  { value: "partial", label: "Works in part" },
  { value: "compatible", label: "Compatible" },
  { value: "not_compatible", label: "Not compatible" },
] as const;

/** The fields the database lets an editor lock against imports (private.lockable_field). */
export const LOCKABLE_FIELDS = {
  game: ["first_release_date", "first_release_precision", "kind", "sort_title", "summary", "title"],
  release: [
    "barcode", "components", "edition_kind", "edition_name", "languages", "local_title", "markets", "media_count",
    "media_format_code", "media_playability", "packaging", "product_code", "publisher_name", "rating_labels",
    "region_code", "release_date", "release_date_precision", "requirements", "variant_name",
  ],
} as const;

export type Entity = keyof typeof LOCKABLE_FIELDS;

/** As many hardware requirements as a release may list (set_release_requirements). */
export const REQUIREMENT_LIMIT = 20;
/** As many markets as a release may list (set_release_markets). */
export const MARKET_LIMIT = 250;

const oneOf = (list: readonly { value: string }[], value: string) => list.some((x) => x.value === value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function year(text: string, currentYear: number): number | null | undefined {
  if (!text) return null;
  if (!/^\d{4}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= 1950 && value <= currentYear + 1 ? value : undefined;
}

export type GameFields = { title: string; sort_title: string; kind: string; summary: string | null; first_release_year: number | null };

/**
 * A game's fields, for create_game (with no current record) or update_game (only what
 * differs from the record). An empty sort title is the title. The first release year
 * is compared by year, so a more precise date isn't lost unless the year changes.
 */
export function readGameFields(read: Read, current: GameFields | null, currentYear: number): Result<Record<string, unknown>> {
  const title = read("title").replace(/\s+/g, " ").trim();
  if (!title) return { error: "Enter the game's title." };
  if (title.length > 200) return { error: "The title can be up to 200 characters." };
  const sortTitle = read("sort_title").replace(/\s+/g, " ").trim() || title;
  if (sortTitle.length > 200) return { error: "The sort title can be up to 200 characters." };
  const kind = read("kind").trim();
  if (!oneOf(GAME_KINDS, kind)) return { error: "Choose game, compilation or expansion." };
  const summary = read("summary").replace(/\r\n/g, "\n").trim() || null;
  if (summary && summary.length > 2000) return { error: "The summary can be up to 2,000 characters." };
  const first = year(read("first_release_year").trim(), currentYear);
  if (first === undefined) return { error: `Enter the first release year as four digits, from 1950 to ${currentYear + 1}.` };

  const changes: Record<string, unknown> = {};
  if (!current || title !== current.title) changes.title = title;
  if (!current || sortTitle !== current.sort_title) changes.sort_title = sortTitle;
  if (!current || kind !== current.kind) changes.kind = kind;
  if (!current ? summary !== null : summary !== current.summary) changes.summary = summary;
  if (!current ? first !== null : first !== current.first_release_year) {
    changes.first_release_date = first === null ? null : `${first}-01-01`;
    changes.first_release_precision = first === null ? "unknown" : "year";
  }
  return { value: changes };
}

/** The markets a release is sold in, as two-letter codes from the list, each once. Null when unchanged. */
export function readMarkets(text: string, known: readonly string[], current: readonly string[]): Result<string[] | null> {
  const codes = [...new Set(text.toUpperCase().split(/[\s,;]+/).filter(Boolean))].sort();
  if (codes.length > MARKET_LIMIT) return { error: `A release can list up to ${MARKET_LIMIT} markets.` };
  const unknown = codes.filter((c) => !known.includes(c));
  if (unknown.length) return { error: `${unknown.join(", ")} ${unknown.length === 1 ? "isn't a market code" : "aren't market codes"}. Use two-letter codes, such as US or JP.` };
  return { value: codes.join(",") === [...current].sort().join(",") ? null : codes };
}

export type Requirement = { requirement_code: string; level: string; note: string | null };

const requirementKey = (r: Requirement) => `${r.requirement_code}\u0000${r.level}\u0000${r.note ?? ""}`;

/**
 * The hardware a release lists, for set_release_requirements: each from the release's
 * platform's list, once, with a level and an optional note of up to 300 characters.
 * An unselected row is skipped. Null when nothing changed.
 */
export function readRequirements(read: Read, rows: number, allowed: readonly string[], current: readonly Requirement[]): Result<Requirement[] | null> {
  const list: Requirement[] = [];
  for (let i = 0; i < Math.min(Math.max(rows, 0), REQUIREMENT_LIMIT); i += 1) {
    const code = read(`requirement_${i}`).trim();
    if (!code) continue;
    if (!allowed.includes(code)) return { error: "Choose hardware from the list for this release's platform." };
    const level = read(`requirement_level_${i}`).trim();
    if (!oneOf(REQUIREMENT_LEVELS, level)) return { error: "Choose how each piece of hardware is needed." };
    const note = read(`requirement_note_${i}`).replace(/\s+/g, " ").trim() || null;
    if (note && note.length > 300) return { error: "A hardware note can be up to 300 characters." };
    if (list.some((r) => r.requirement_code === code)) return { error: "Each piece of hardware is listed once." };
    list.push({ requirement_code: code, level, note });
  }
  const same = list.length === current.length && list.map(requirementKey).sort().join("\n") === current.map(requirementKey).sort().join("\n");
  return { value: same ? null : list };
}

/** A new alias: a title other than the game's, of a kind, with an optional language and a known region. */
export function readAlias(read: Read, regions: readonly string[]): Result<{ title: string; kind: string; language: string | null; region: string | null }> {
  const title = read("alias_title").replace(/\s+/g, " ").trim();
  if (!title) return { error: "Enter the other title." };
  if (title.length > 200) return { error: "A title can be up to 200 characters." };
  const kind = read("alias_kind").trim();
  if (!oneOf(ALIAS_KINDS, kind)) return { error: "Choose what kind of title it is." };
  const language = read("alias_language").trim().toLowerCase() || null;
  if (language && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(language)) return { error: "Enter the language as a code, such as ja or pt-br, or leave it empty." };
  const region = read("alias_region").trim() || null;
  if (region && (region === "unknown" || !regions.includes(region))) return { error: "Choose the region from the list, or leave it empty." };
  return { value: { title, kind, language, region } };
}

/** A relation to another game, named by its record's id. A position orders a compilation's contents. */
export function readRelation(read: Read, self: string): Result<{ target: string; relation: string; position: number | null; note: string | null }> {
  const target = read("target_id").trim().toLowerCase();
  if (!UUID.test(target)) return { error: "Enter the other game's record id, as shown on its record." };
  if (target === self) return { error: "A game can't be related to itself." };
  const relation = read("relation").trim();
  if (!oneOf(RELATIONS, relation)) return { error: "Choose how the games are related." };
  const positionText = read("position").trim();
  if (positionText && relation !== "contains") return { error: "Only a compilation's contents have a position." };
  const position = positionText ? Number(positionText) : null;
  if (positionText && (!/^\d+$/.test(positionText) || position! < 1 || position! > 999)) return { error: "The position is a number from 1 to 999." };
  const note = read("relation_note").replace(/\s+/g, " ").trim() || null;
  if (note && note.length > 500) return { error: "The note can be up to 500 characters." };
  return { value: { target, relation, position, note } };
}

/** Locking or unlocking one field against imports. */
export function readLock(read: Read): Result<{ entity: Entity; field: string; locked: boolean }> {
  const entity = read("entity") === "game" ? "game" : read("entity") === "release" ? "release" : null;
  if (!entity) return { error: "This field can't be locked." };
  const field = read("field").trim();
  if (!(LOCKABLE_FIELDS[entity] as readonly string[]).includes(field)) return { error: "This field can't be locked." };
  return { value: { entity, field, locked: read("locked") === "yes" } };
}

/**
 * Whether changing this record needs a TOTP verification in the last 10 minutes (D3):
 * verifying and publishing always do, and editing a published record does.
 */
export function needsRecentVerification(action: "edit" | "verify" | "publish", status: string): boolean {
  return action !== "edit" || status === "published";
}

/**
 * Where an editing form keeps its typed reason while the editor verifies again, in
 * this tab only, for one record and form.
 */
export function draftKey(form: string, id: string): string {
  return `catalog-draft:${form}:${id}`;
}

/** The database's fixed errors, as messages for editors. Nothing else from the database is shown. */
export function editErrorMessage(message: unknown): string {
  switch (message) {
    case "not permitted":
      return "Only active catalog editors can do this.";
    case "own record":
      return "You created this record, so another editor has to verify, publish, merge or exclude it.";
    case "own submission":
      return "You submitted this, so another editor has to review it.";
    case "provenance unknown":
      return "Nobody knows who created this record, so only an administrator can verify or publish it.";
    case "independent review required":
      return "You verified this record, and nobody knows who created it, so another administrator has to publish it.";
    case "verification required":
      return "This record has to be verified by someone other than its creator before it's published.";
    case "verification stale":
      return "The record changed after it was verified. Verify it again, as it is now, before publishing.";
    case "release not verified":
      return "Verify the release before publishing it.";
    case "game not verified":
      return "This release's game hasn't been verified yet. Verify the game first.";
    case "release incomplete":
      return "To verify, the release needs an edition name, an edition type and the number of discs or cartridges, and an unknown region must be confirmed.";
    case "review required":
      return "This record is part of a submission, so it's published by approving the submission.";
    case "submission not in review":
      return "This record is part of a submission. Start its review before changing it.";
    case "submission locked":
      return "This record is part of a submission that can't change right now.";
    case "record changed":
      return "This record changed since you opened it. Reload the page and check it again.";
    case "record unavailable":
      return "This record can't be changed any more.";
    case "reason required":
      return "Give a reason for the record.";
    case "invalid changes":
      return "Some values aren't valid. Check them and try again.";
    case "alias repeats the title":
      return "That's already the game's title.";
    case "only a compilation can contain other games":
      return "Only a compilation can contain other games.";
    case "a game that contains others must stay a compilation":
      return "This game contains others, so it stays a compilation.";
    case "already published":
      return "An identical release is already in the catalog.";
    case "reauthentication required":
      return "Verify with your authenticator again to continue.";
    default:
      return "The change couldn't be saved. Try again.";
  }
}
