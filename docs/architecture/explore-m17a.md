# Explore: suggestions, a game catalog and quick actions (M17a)

Explore (`src/app/(app)/explore/page.tsx`) is where a collector finds a game and adds it. It shows one of two states:

| State | What it shows |
| --- | --- |
| Landing (no search, no system) | A prominent search with a system list, Browse by System (the systems with games, with their counts, on the approved console tiles; compact rows on a phone), every supported platform behind "All supported platforms", and the games the catalog records on the most systems. |
| Results (a search, a system, or both) | The search, the systems as quick filters, and a grid of game cards (one column on a phone, two from 480px, three from 1024px, four from 1536px). |

## Search suggestions

Both the header search and Explore's own use one component, `SearchAutocomplete` (`src/components/catalog/search-autocomplete.tsx`), inside their existing forms: Enter without choosing a suggestion runs the full results page, as before.

- **When:** from two characters, after a 180 ms pause in typing.
- **What:** up to eight games from `search_catalog` (the results page's own function and order: an identifier or exact title, then title and alias prefixes, then words, then similar titles). Within the same strength, a game whose own title matched comes before one found by another title. No popularity: there's no such data.
- **Each:** title (the typed text highlighted), first-release year, platforms, and why it matched when it wasn't the title ("Also known as Mario 2", a product code).
- **Requests:** `GET /api/catalog/suggest?q=`, public and cached a minute (`suggestCatalog`), so the same text typed by anyone reaches the database at most once a minute. Each new request cancels the last, and a ticket check (`latestOnly`) keeps a slow early answer from replacing a newer one. Behind that, the endpoint allows 40 requests per 10 seconds per client.
- **Keyboard and touch:** ARIA 1.2 combobox. Arrow keys move, Enter opens the chosen game, Escape closes, Tab leaves; mouse and touch choose directly. The count is announced politely.

## Result cards

`GameCard` (`src/components/explore/game-card.tsx`) shows the game's systems on a lit stage: the approved console art of one system, or up to three when it's on several (never a fabricated cover; real game artwork joins with M17b's image registry). Then the title and year, "Also known as" when that matched, the platform chips (four, then "+N more"), "Owned: …" for the collector, and verified releases only when there are some. The stage and title link to the game; the two actions sit beside them, never nested.

The repeated "No verified physical release recorded yet" notice is gone from results: the game page still says it, where a collector chooses an edition.

## Quick add

**Add to Collection** opens `QuickAddDialog` (a sheet on a phone):

- Platform: preset when the game has one, or when Explore is filtered to one of its platforms.
- Region: NTSC-U/C, NTSC-J, PAL, **Not sure** (the default), or another from a list.
- A verified release: offered only when the catalog has some for that platform (and region), and used only when the collector picks one.
- Condition, completeness and purchase: collapsed.

Nothing is added until Add. It goes through the existing `addCopy` (a verified release) or `addClaim` (an unidentified copy, M12a) actions, unchanged: the same validation, definer functions and RLS, with a UUIDv7 made in the dialog as the idempotency key. After adding: a confirmation, the system's shelf, and "Add another game" (back to the search). The card then shows the game as owned.

Signed out, Add is a link to sign in that comes back with `?add=<slug>`, opening the dialog for that game; the copy still waits for Add. Without a handle it goes to `/welcome`.

## Quick wishlist

**Wishlist** adds the game at W1's game level ("any version": no platform, region or edition assumed) with the existing `addWish` action. Once the game is wanted at any level, the button says **Wishlisted** and links to the entry, where it can be narrowed. W1 itself refuses duplicates. Signed out, it comes back with `?wish=<slug>` and asks to confirm.

Which games are wanted is read with `getMyWishedGames` (W1's own `get_my_wishlist`, a page at a time, the caller's entries only), and owned with `get_my_owned_games`: per request, never cached, nothing for visitors.

## Systems

The platform list holds only systems with games (and a chosen one), and applies as soon as one is chosen; Search still applies it without JavaScript. Above the results, the same systems are quick filters: one Tab stop, with the arrow keys moving along them.

Landing's "On the most systems" comes from the public `game_platforms` pairings (`getMostPlatformGames`), cached for hours.

## Header

Messages and notifications are for signed-in accounts only; on a phone, Sign in is an icon with its name for assistive technology, and the logo never shrinks. The header fits without overlap at 320, 390 and 768 pixels, signed in and out.

## Data

No migration. Everything reads existing functions: `search_catalog`, `list_catalog_platforms` (with M16's game counts), the public `platforms`, `games` and `game_platforms`, `get_release_picker`, `get_my_owned_games`, `get_my_game_ownership`, `get_my_wishlist`; and writes only through `add_collection_item`, `add_unidentified_copy` (via `addClaim`) and `add_wishlist_item`.

## Checks

`MGD_STACK=demo npm run app:explore-checks` runs the collector workflow on the demo preview with a collector registered through the sign-up page and Mailpit: suggestions, results, systems, the header at three widths, adding from a result, wishing for another, the game page, a phone, signing out, and axe. It saves screenshots to `~/.my-game-dex/demo/m17a-screens`, then removes the account and confirms the catalog is unchanged.
