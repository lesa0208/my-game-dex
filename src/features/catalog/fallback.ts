/**
 * Collector fast add: other ways to read a search that found nothing, tried in order,
 * only after the search as typed found no games.
 *
 * - A product code typed with a space where the box prints a hyphen: "slus 00999" is
 *   tried as "SLUS-00999". Only a run of letters, then digits (with an optional letter
 *   suffix), so a title is never read as a code.
 * - A title with its words split where the catalog's are joined: "star fall" is tried as
 *   "starfall", "clay boxr" as "clayboxr" (whose spelling mistake the catalog's own
 *   search forgives). Only for two to four short words, since a longer query split by a
 *   space is a real phrase.
 *
 * Pure, so it's tested on its own. The page says which reading it showed.
 */
export function searchFallbacks(query: string): string[] {
  const q = query.trim().replace(/\s+/g, " ");
  const out: string[] = [];
  const code = /^([A-Za-z]{2,6}) ?-? ?(\d{3,6}[A-Za-z]{0,2})$/.exec(q);
  if (code && q.includes(" ")) out.push(`${code[1].toUpperCase()}-${code[2].toUpperCase()}`);
  const words = q.split(" ");
  if (!code && words.length >= 2 && words.length <= 4 && words.every((w) => w.length <= 12)) out.push(words.join(""));
  return out.filter((f) => f.toLowerCase() !== q.toLowerCase());
}
