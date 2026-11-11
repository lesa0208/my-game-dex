/**
 * The My Collection list's filters, sort and page, as URL parameters. Every value is
 * checked against what `get_my_collection` (M6b) accepts, so a hand-edited URL falls
 * back to the default instead of reaching the database as an invalid filter. Pure, so
 * it can be tested alone.
 */

export const SORTS = [
  { value: "added", label: "Recently added" },
  { value: "title", label: "Title" },
  { value: "platform", label: "Platform" },
  { value: "acquired", label: "Recently acquired" },
] as const;

/** A copy's status (M6b): whether its release is still in the catalog. */
export const STATUSES = [
  { value: "owned", label: "In the catalog" },
  { value: "pending", label: "Awaiting review" },
  { value: "not_approved", label: "Not approved" },
  { value: "invalid", label: "No longer in the catalog" },
] as const;

export const COMPLETENESS_FILTERS = [
  { value: "loose", label: "Loose (medium only)" },
  { value: "incomplete", label: "Incomplete" },
  { value: "complete", label: "Complete in box" },
  { value: "sealed", label: "Sealed" },
  { value: "not_recorded", label: "Not recorded" },
] as const;

export type CollectionSort = (typeof SORTS)[number]["value"];

export type CollectionParams = {
  query: string;
  platform: string | null;
  completeness: string | null;
  status: string | null;
  sort: CollectionSort;
  cursor: string | null;
};

export const DEFAULT_PARAMS: CollectionParams = { query: "", platform: null, completeness: null, status: null, sort: "added", cursor: null };

type Search = Record<string, string | string[] | undefined> | URLSearchParams;

function first(search: Search, name: string): string {
  const value = search instanceof URLSearchParams ? search.get(name) : search[name];
  return ((Array.isArray(value) ? value[0] : value) ?? "").trim();
}

const oneOf = <T extends string>(values: readonly { value: T }[], value: string): T | null =>
  values.find((v) => v.value === value)?.value ?? null;

export function readCollectionParams(search: Search): CollectionParams {
  const platform = first(search, "platform");
  const cursor = first(search, "after");
  return {
    query: first(search, "q").slice(0, 100),
    platform: /^[a-z0-9-]{1,64}$/.test(platform) ? platform : null,
    completeness: oneOf(COMPLETENESS_FILTERS, first(search, "completeness")),
    status: oneOf(STATUSES, first(search, "status")),
    sort: oneOf(SORTS, first(search, "sort")) ?? "added",
    cursor: /^[A-Za-z0-9_-]{1,2000}$/.test(cursor) ? cursor : null,
  };
}

/** The parameters as a query string, without defaults, so a plain list is `/collection`. */
export function collectionQuery(params: CollectionParams): string {
  const search = new URLSearchParams();
  if (params.query) search.set("q", params.query);
  if (params.platform) search.set("platform", params.platform);
  if (params.completeness) search.set("completeness", params.completeness);
  if (params.status) search.set("status", params.status);
  if (params.sort !== "added") search.set("sort", params.sort);
  if (params.cursor) search.set("after", params.cursor);
  return search.toString();
}

export function collectionHref(params: CollectionParams, notice?: "removed" | "already_removed"): string {
  const search = new URLSearchParams(collectionQuery(params));
  if (notice) search.set("notice", notice);
  const query = search.toString();
  return query ? `/collection?${query}` : "/collection";
}

/** A copy's page, carrying the list's parameters so "Back" returns to the same view. */
export function copyHref(itemId: string, params: CollectionParams): string {
  const query = collectionQuery(params);
  return query ? `/collection/${itemId}?${query}` : `/collection/${itemId}`;
}

export function hasFilters(params: CollectionParams): boolean {
  return Boolean(params.query || params.platform || params.completeness || params.status);
}

export function readNotice(search: Search): "removed" | "already_removed" | null {
  const notice = first(search, "notice");
  return notice === "removed" || notice === "already_removed" ? notice : null;
}
