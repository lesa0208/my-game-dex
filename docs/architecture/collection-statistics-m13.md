# Collection statistics (M13)

`/collection/statistics` shows a signed-in collector the size and make-up of their own
physical collection. It's private to them. There is no public or shared version, and no
migration: it uses the existing owner-only reads.

## Where the numbers come from

- **Copies:** `collection_items`, read with the collector's own session and the
  publishable key. The table's RLS policy (owner, live session) applies, and the query
  names the owner too. Only the columns the counts need are read: release, claimed game,
  platform and region, completeness and record status.
  `collection_item_private` (purchase price and date, notes, storage) is never read.
- **Each copy's release:** embedded in the same read (`release:releases(...)`), so it
  follows the catalog's normal read rules. A release the collector can no longer read
  (it left the catalog) comes back empty.
- **Names:** `platforms`, `region_codes` and `media_formats` (public reference data), and
  `games` only for the titles in "Most copies".
- **Counting:** on the server, in `src/features/statistics/compute.ts` (pure, unit
  tested). Copies are read 1,000 at a time in id order (`rowsById`, shared with the data
  export). The browser receives only the totals, never the copies.

## Counting rules

| Measure | Rule |
| --- | --- |
| Physical copies | Every copy (row), whatever its catalog standing: the same total as My Collection. |
| Distinct games | Each game once, however many copies, releases or systems. A copy's game is its release's game, or for a copy not linked to a release, the game it's recorded as. A copy whose release left the catalog has no known game: it counts as a copy, not a game, and the page says so. |
| Systems | A copy's system is its release's platform, or its recorded platform: the collection summary's rule, so each system's copies equal its tile on the Systems screen. |
| Games per system | A game counts once on each system it has copies on. The systems' game counts can therefore add up to more than the distinct total. |
| Completeness | The recorded value (loose, incomplete, complete in box, sealed) or "Not recorded". Never inferred. |
| Region | The release's region, or for a copy not linked to a release, the recorded one; "Not recorded" if none; "No longer in the catalog" for a copy whose release left it. The catalog's own `unknown` region is shown as "Region unknown in the catalog". |
| Media format | The release's format. A copy not linked to a release has none ("Not recorded"); nothing is guessed from the platform. |
| Several copies | Games and releases with two or more copies, and the copies beyond the first of each game. |
| Shares | Always of all copies (or all of a system's copies), including those with nothing recorded. |

## Scale

Measured in the built app on the isolated test stack:

| Collection | Time |
| --- | --- |
| 5,000 copies | about 0.14 s |
| 50,000 copies | about 1.1 s |

The cost grows with the collection: one read per 1,000 copies, up to 100 reads at the
collection limit of 100,000 (an estimated 2 s or more).

If collections that large become common, the same counts could come from one
owner-only `security invoker` SQL function, like `get_my_collection_summary`, in a single
round trip. That would be a migration, and isn't needed today.
