# Game Details: a collector's dashboard (M17b)

The game page (`src/app/(app)/games/[slug]/page.tsx`) follows the product owner's Chrono Trigger reference: a hero in three columns, then the game's content as tabs with the catalog's facts beside them. Nothing is invented: no ratings, rankings, genres, screenshots or community counts.

## Layout

| Where | What |
| --- | --- |
| Hero, left | **Artwork** (`GameArtwork`): the real cartridge or case from an approved image, with its source and terms. Until one exists, the chosen system's own cartridge or case shape, with its label area plainly marked "Artwork not available" and a caption saying it's the system's shape, not the game's label. A spotlight, no shelf |
| Hero, centre | **The game** (`GameIdentity`): title, the chosen system with its console, ownership, **Add to Collection** and **Wishlist**, a "More" menu, the facts the catalog has (first release, systems, verified releases, the publisher when every release agrees), and the game's other systems to switch to |
| Hero, right | **My Copy** (`MyCopyPanel`): see below |
| Below | **Tabs** (`GameTabs`) beside a **Game Details** card (`GameFactsCard`): systems, first release, publisher, verified releases, regions, other titles |

Behind the hero, violet and lamp-warm light, and the chosen system's console blurred far behind (`HeroBackdrop`): the system's approved art as scenery, never the game's.

The system shown is the one in the address (`?platform=`), else the game's earliest system by the platform's own release year (Super Mario World opens on the SNES, not the Game Boy Advance).

On a phone everything stacks: artwork, the game and its actions, My Copy, the tabs, Game Details.

## My Copy

- **Owned:** the first copy's recorded platform, region, edition, condition and completeness (only what was recorded), with **Edit** (the copy's edit form, opened) and **View copy**. Other copies follow as short lines, with "See all N copies" opening the My Copies tab.
- **Not owned:** "Not in your collection yet" and **Add your copy** (the same quick add).
- **Visitor:** **Create Account** and **Sign In**.

Nothing private (purchase, price, location, notes) is shown here, and never another collector's copies.

## Tabs

Real tabs (Radix: tablist, tab and tabpanel roles; the arrow keys, Home and End), each showing only its own content. The address's hash names the tab (`#overview`, `#releases`, `#my-copies`, `#gallery`), so a tab can be linked and back and forward move between them. Every panel is in the HTML (inactive ones hidden), so links and find-in-page work; without JavaScript, Overview shows.

| Tab | What |
| --- | --- |
| Overview | About the Game (the catalog's summary, or that it has none), Release Information (first release, publisher when known, the systems with their verified releases), and Other titles folded away |
| Physical Releases | The verified releases by platform, each with "Add this release" (the step-by-step add with it chosen) and "Want this release"; said once when there are none |
| My Copies | The collector's copies, each with View copy and Edit; then the wishlist's options (any version, a platform, a region or one release, priority and note) |
| Gallery | Only when approved images exist |

## Adding

Adding goes through one interface, the **quick add** dialog, opened from the hero (or My Copy's invitation): platform (or another one), region (or not sure), edition (the catalog's, another one, or not sure), a verified release only when the collector picks one, and optional condition, completeness and purchase. It uses the existing `addCopy` and `addClaim` actions unchanged.

The **step-by-step add** (M12b's fast add, unchanged) has its own page, `/games/<slug>/add`, linked from the hero's "More" menu, the quick add's "Step by step", and each release's "Add this release". It works without JavaScript. The game page's old step addresses (a region or an edition chosen) are redirected there by `src/proxy.ts`, with the same choices.

## Wishlist

The hero's **Wishlist** adds the game at any version at once. Its options open on demand: "More → Wishlist options…" opens the My Copies tab at the wishlist panel. The large form is no longer beside the game.

## Images and their provenance

No authorized game image exists yet: ADR-017 designed `catalog_images`, and D15 (cover art) still needs legal advice. Images are a reviewed, checked-in registry with ADR-017's fields:

- `src/assets/game-images/registry.json`: game, platform, region, release, kind, file, alt, source, licence and terms, attribution, approval.
- `src/features/media/game-images.ts` (`imageFor`): the exact release first, then platform and region, then the platform in any region; never another platform's image.
- `npm run media:add` (the only way in, refusing an image without its rights) and `npm run media:test` (in CI).

The registry is empty until images with permission exist. No migration.

## Against the reference

| Reference | Here |
| --- | --- |
| Three-column hero: box art, identity, My Copy | Built: artwork (fallback until approved images exist), identity, My Copy |
| Large real box and cartridge art | The approved image when one exists; until then the system's shape, marked "Artwork not available" |
| Title, platform with console | Built, with the other systems as chips |
| In My Collection, Wishlist, "…" | In your collection, Add to Collection / Add another, Wishlist, More |
| Rating, "#12 Top SNES" | Not shown: no ratings or rankings exist |
| Release date, publisher stats | First release, systems, verified releases, publisher when known |
| Genre chips | The game's systems instead; the catalog has no genres |
| Tabs: Overview, Releases, My Copies, Gallery, Community | Overview, Physical Releases, My Copies, Gallery (only with images); no Community (no data) |
| About the Game, screenshot carousel | About the Game; no screenshots (none sourced) |
| My Copy card with cartridge photo, Edit | My Copy with recorded facts, Edit and View copy; no photo (collector photos aren't a feature yet) |
| Game Details table (developer, regional dates) | Game Details with the catalog's facts; no developer (not recorded), regional dates per verified release |
| Scene backdrop (room, lamp, figure) | Violet and lamp light with the system's console blurred behind; no scene imagery |

## Checks

`MGD_STACK=demo npm run app:game-page-checks` runs on the demo preview with collectors registered through the sign-up page and Mailpit:

- **Layout:** the three columns at 1440 and the default system.
- **Artwork and content:** the honest artwork fallback; the tabs (choosing, the arrow keys, linking by hash); Overview; and that there are no add steps or wishlist form on the page.
- **Adding:** adding from the hero with an edition, the My Copy panel with Edit and View, the My Copies tab with the wishlist, and Wishlist and its options.
- **Systems and old links:** a multi-platform game, and the redirect of old step addresses.
- **Privacy and quality:** another collector seeing nothing of the first's; a phone; axe.

Screenshots go to `~/.my-game-dex/demo/m17b-screens`.
