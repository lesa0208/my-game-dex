/**
 * Every row of an owner's table in id order, read a page at a time by key (ids after the
 * last one seen) rather than by offset, so a row added or removed while the export runs
 * can't make another row be skipped or repeated. Throws `tooLarge()` once more than `max`
 * rows have been read. `page` must return rows ordered by id, at most `size` of them.
 */
export async function rowsById<T extends Record<string, unknown>>(
  page: (after: string | null, size: number) => PromiseLike<T[]>,
  size: number,
  max: number,
  tooLarge: () => Error,
): Promise<T[]> {
  const out: T[] = [];
  for (let after: string | null = null; ; ) {
    const rows = await page(after, size);
    out.push(...rows);
    if (out.length > max) throw tooLarge();
    if (rows.length < size) return out;
    after = String(rows[rows.length - 1].id);
  }
}
