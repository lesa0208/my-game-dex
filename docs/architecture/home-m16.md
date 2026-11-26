# Home: the collector's collection first (M16)

Home (`src/app/(app)/home/page.tsx`) shows one of three states, decided on the server for each request:

| Who | What Home shows |
| --- | --- |
| Signed out | The landing: what My Game Dex is for, an example shelf (consoles and blank media, marked "Example", no counts or titles), Create Account (only where self-registration is open; elsewhere Sign In), Explore Games, and three benefits. |
| Signed in, no copies | "Your collection starts here": Find Your First Game and Explore Games, a row of example consoles captioned as systems you *could* collect for, and three steps. No zero statistics. |
| Signed in, with copies | Your Collection (with Add a Game), the overview (systems, games, copies), My Systems (up to six, most copies first), Recently Added (six newest copies) and Continue Collecting. |

A signed-in account without a handle is sent to `/welcome`, then back to Home. The social feed isn't on Home; its components (`src/components/feed/`) and data are kept for Community.

## Data

Everything personal is read with the collector's own session through existing owner-only functions (`src/features/home/queries.ts`); nothing is cached across requests or users, and no global catalog total is used.

- **Systems and copies:** `getMySystems()` (`get_my_collection_summary`). The system count is the number of tiles there would be on the Systems page.
- **Games:** distinct games from `getMyCollectionStatistics()` (the M13 statistics read of the collector's own `collection_items`, no private columns). If it fails, the count shows "—" and says it couldn't be counted.
- **Recently Added:** `getMyRecentCopies()` in `src/features/shelf/collection.ts`, which is `get_my_collection` with its `added` sort (copies' creation dates, newest first), mapped to shelf items as the shelves do.
- **Failures:** if the summary can't be read, Home says the collection isn't available: never an empty collection. If only the recent copies fail, that section says so.

No migration.

## Components

Reused unchanged: `SystemTile`, `ConsoleArt`, `GameMedia`, `Cabinet`, `ShelfLight`, `ShelfBoard`, `ShelfFillers`, `Button`, `EmptyState`. My Systems uses the Systems page's own cabinet and grid (one tile a row on phones, two from 640px, three from 1280px).

New, in `src/components/home/`: `collection-home.tsx`, `recently-added.tsx`, `first-collection.tsx`, `home-landing.tsx`, `example-shelf.tsx` and `home-parts.tsx` (container, section heading, panel, shortcuts).

## Checks

`MGD_STACK=demo npm run app:home-checks` runs on the running demo preview. It registers disposable collectors through the sign-up page and Mailpit, adds real demo games on seven systems, and checks:

- each state's content;
- the counts against the database, the tile links and the recent order;
- isolation from another collector;
- no sideways scrolling at 390, 768 and 1440 pixels, and the tiles per row;
- keyboard use, and axe.

It saves screenshots to `~/.my-game-dex/demo/home-screens`, then removes the accounts and confirms the demo catalog is unchanged.
