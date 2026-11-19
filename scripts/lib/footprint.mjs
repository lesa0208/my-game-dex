/**
 * M12c-A: a fingerprint of whole tables, for the checks' "nothing is left behind".
 *
 * The isolated test stack can hold deliberate records between runs: the staged catalog
 * pilot, the games and releases a human editor reviewed and published, and that editor's
 * own collection. A check that required these tables to be empty would fail on them, or
 * tempt someone to delete them. Instead a check takes the fingerprint before it starts
 * and requires the same one after cleaning up: nothing of its own is left, and nothing
 * that was there before was changed or removed. On a clean stack that's the old
 * "everything is empty".
 *
 * Each table's fingerprint is its row count and the md5 of its rows' text, in a stable
 * order. Table names are the checks' own constants, never input.
 */
export function footprint(psql, tables) {
  for (const table of tables) if (!/^(public|private)\.[a-z_]+$/.test(table)) throw new Error(`not a table name: ${table}`);
  return psql(`select ${tables.map((t) => `'${t}=' || (select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') from ${t} x)`).join(" || ' ' || ")};`);
}
