/**
 * The wishlist page's search, filters, sort and page, as URL parameters. Each value is
 * checked against what get_my_wishlist (W1) accepts, so a hand-edited URL falls back to
 * the default instead of reaching the database as an invalid filter. Pure.
 */

export const WISHLIST_SORTS = [
  { value: "priority", label: "Priority" },
  { value: "added", label: "Recently added" },
  { value: "title", label: "Title" },
] as const;

export type WishlistSort = (typeof WISHLIST_SORTS)[number]["value"];

export type WishlistParams = {
  query: string;
  platform: string | null;
  region: string | null;
  priority: 1 | 2 | 3 | null;
  sort: WishlistSort;
  cursor: string | null;
};

export const DEFAULT_WISHLIST_PARAMS: WishlistParams = { query: "", platform: null, region: null, priority: null, sort: "priority", cursor: null };

type Search = Record<string, string | string[] | undefined> | URLSearchParams;

function first(search: Search, name: string): string {
  const value = search instanceof URLSearchParams ? search.get(name) : search[name];
  return ((Array.isArray(value) ? value[0] : value) ?? "").trim();
}

export function readWishlistParams(search: Search): WishlistParams {
  const platform = first(search, "platform");
  const region = first(search, "region");
  const priority = Number(first(search, "priority"));
  const sort = first(search, "sort");
  const cursor = first(search, "after");
  return {
    query: first(search, "q").slice(0, 100),
    platform: /^[a-z0-9-]{1,64}$/.test(platform) ? platform : null,
    region: /^[a-z0-9-]{1,32}$/.test(region) && region !== "unknown" ? region : null,
    priority: priority === 1 || priority === 2 || priority === 3 ? priority : null,
    sort: WISHLIST_SORTS.find((s) => s.value === sort)?.value ?? "priority",
    cursor: /^[A-Za-z0-9_-]{1,2000}$/.test(cursor) ? cursor : null,
  };
}

/** The parameters as a query string, without defaults, so the plain list is /collection/wishlist. */
export function wishlistQuery(params: WishlistParams): string {
  const search = new URLSearchParams();
  if (params.query) search.set("q", params.query);
  if (params.platform) search.set("platform", params.platform);
  if (params.region) search.set("region", params.region);
  if (params.priority) search.set("priority", String(params.priority));
  if (params.sort !== "priority") search.set("sort", params.sort);
  if (params.cursor) search.set("after", params.cursor);
  return search.toString();
}

export type WishlistNotice = "removed" | "already_removed";

export function wishlistHref(params: WishlistParams, notice?: WishlistNotice): string {
  const search = new URLSearchParams(wishlistQuery(params));
  if (notice) search.set("notice", notice);
  const query = search.toString();
  return query ? `/collection/wishlist?${query}` : "/collection/wishlist";
}

/** An entry's page, carrying the list's parameters so "Back" returns to the same view. */
export function wishHref(id: string, params: WishlistParams = DEFAULT_WISHLIST_PARAMS): string {
  const query = wishlistQuery(params);
  return query ? `/collection/wishlist/${id}?${query}` : `/collection/wishlist/${id}`;
}

export function hasWishlistFilters(params: WishlistParams): boolean {
  return Boolean(params.query || params.platform || params.region || params.priority);
}

export function readWishlistNotice(search: Search): WishlistNotice | null {
  const notice = first(search, "notice");
  return notice === "removed" || notice === "already_removed" ? notice : null;
}
