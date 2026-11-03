export const FEED_FILTERS = [
  { value: "for-you", label: "For You", href: "/home" },
  { value: "following", label: "Following", href: "/home?feed=following" },
  { value: "latest", label: "Latest", href: "/home?feed=latest" },
] as const;

export type FeedFilter = (typeof FEED_FILTERS)[number]["value"];

export function parseFeedFilter(value: string | string[] | undefined): FeedFilter {
  return FEED_FILTERS.find((filter) => filter.value === value)?.value ?? "for-you";
}
