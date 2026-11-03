const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const absoluteDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Formats a timestamp relative to `now`; dates older than a week are absolute. */
export function formatRelativeTime(isoDate: string, now: number) {
  const date = new Date(isoDate);
  const elapsed = now - date.getTime();

  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`;
  return absoluteDate.format(date);
}

/** For read-only summaries, where "1.3K" is enough. */
export function formatCount(value: number) {
  return compactNumber.format(value);
}

const exactNumber = new Intl.NumberFormat("en");

/** For counts that change on interaction: rounding would hide the change. */
export function formatExactCount(value: number) {
  return exactNumber.format(value);
}
