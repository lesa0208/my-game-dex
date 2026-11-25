# Collector fast add (M15)

A collector with hundreds of physical games finds each one, adds it and moves on. My Game Dex does the narrowing; the collector confirms. Nothing about a physical release is invented, and nothing is added to the catalog.

## The flow

1. **Find.** Explore, or the header search on wide screens. Titles, other titles (aliases, local and source titles), spelling mistakes, product codes and barcodes all find a game. A search filtered by platform keeps the platform in each game's link, so the game opens on that platform's steps.
2. **Narrow.** The game page offers adding straight after the game's header, before the full list of releases. On a phone it no longer sits below the copies, the wishlist and every release. The steps are platform, region and edition; a product code or barcode result goes straight to its release.
3. **Add.** One click adds one physical copy. Every detail (completeness, condition, pieces, date, price, storage, notes) is optional, stays collapsed, and can be filled in later.
4. **Next.** The confirmation says how many copies the collector now has ("You now have 2 copies of this release"). It links to the platform's shelf and the collection, and offers a search for the next game on the same platform. "Add another copy" is one more click.

## Suggestions, never inventions

A step the collector hasn't answered is filled in only when the published catalog has exactly one choice there:

- **Region:** the platform's releases of the game are all of one region.
- **Edition:** the chosen region's releases are all of one edition.

The step says so ("Chosen for you: the catalog's only region for … Yours is from elsewhere? Choose another region or not sure."), and its other choices stay one click away. An answer always wins: "Not sure" stays not sure, "Another region" stays the collector's own, and a region the catalog lacks is never paired with a catalog edition. With the region not sure, nothing is suggested. So a game with one release on a platform is ready to add as soon as it opens, and several releases are never settled by picking one (`planFastAdd`, `src/features/collection/fast-add.ts`).

## The page updates at once

Adding refreshes the page (`refresh()` in the server action, as editing, moving and removing a copy already did), so the game's own "Your copies" panel and the counts show the new copy without a reload. The form keeps its state: it is keyed by the release. Before this, the panel said "Not in your collection yet" next to "Added to your collection".

## Search read another way

When a search finds nothing as typed, the explore page tries once more, and says so ("Nothing matches "slus 01999" as typed, so these are the games matching "SLUS-01999""):

- a product code typed with a space where the box prints a hyphen (letters, then digits);
- a title's two to four short words joined ("star fall" as "starfall"), whose spelling the catalog's own fuzzy search then forgives.

Nothing else is reinterpreted (`searchFallbacks`, `src/features/catalog/fallback.ts`). The extra request is made only for an empty result.

## Fixed: the second search on a connection

`public.search_catalog` saves the two `pg_trgm` thresholds, sets its own and sets the saved ones back. On a database connection whose searches so far needed no fuzzy matching (a platform browse, a short query), `pg_trgm`'s library isn't loaded, and a threshold set locally leaves an empty placeholder when its transaction ends. The next search saved that `''`; with the library loaded by then, setting it back failed with `invalid value for parameter "pg_trgm.similarity_threshold": ""`, and the collector saw an error page. Browsing a platform and then searching a title on the same pooled connection was enough.

Migration `20261218100000_m15_search_threshold_restore.sql` reads an empty saved value as unset. The function is otherwise exactly its current definition (migration `20261210100100`): signature, security definer, search path and grants unchanged. pgTAP `61` runs a browse and then a title search in separate transactions on one connection, which fails before the fix.

## What stays as it was

- Only physical copies: a copy is of a published release, or the collector's own unidentified record (platform, region and edition as they know them). No digital entries, no box or manual without the game.
- Purchase data (date, price, currency, storage, notes) stays in `collection_item_private`, readable by the owner only.
- Catalog, RLS, ownership, editorial and publication rules are untouched. The search reads published records only.

## Tests

- `npm run collection:test`: the suggestion rules, including every answer that overrides one.
- `npm run catalog:test`: `searchFallbacks`.
- pgTAP `61_m15_search_threshold_restore.test.sql`.
- `app:collector-fast-add-checks` (browser, scratch or test stack). Fictional NES, SNES and PlayStation games (`scripts/fixtures/collector-fast-add-fixture.sql`), each scenario counted and timed:

  | Scenario | Actions |
  | --- | --- |
  | NES, one release, platform-filtered search | 4 (type, Enter, result, Add) |
  | The next NES game, a region to choose, from the confirmation | 5 (type, Enter, result, PAL, Add) |
  | SNES, a region and an edition, from the header search | 6 |
  | A second copy | 1 |
  | A game on two platforms, platform-filtered search | 4 |
  | PlayStation by barcode, on a phone | 4 or 5 (a scroll) |

  The check also covers keyboard use, a phone and a desktop width (axe-core, no sideways scrolling), "not sure", optional details added later, purchase data hidden from another collector, and the shelf and collection after each addition.
