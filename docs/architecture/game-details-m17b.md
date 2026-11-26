# Game Details: the game as a collectible (M17b)

The game page (`src/app/(app)/games/[slug]/page.tsx`) leads with the game and the collector's actions, then the game's parts as tabs, with the collector's own copies beside them.

## Hero

`GameHero` (`src/components/games/game-hero.tsx`), no shelf:

- **Left:** the real item's image, when an approved one matches the chosen platform (and region), with its source and terms underneath. Otherwise an honest panel: "No artwork for … yet", with the chosen system's console faintly behind ("for the system only"). Never a generated label on a generic shell.
- **Right:**
  - **Platform choice.** A choice of platforms when the game has several, none assumed; choosing one keeps the page's address (`?platform=`).
  - **Title.** The title, with the platform, year and kind under it.
  - **Actions.** Ownership when signed in, then Add to Collection and Wishlist, the same controls as on an Explore result. The quick add opens with the page's platform chosen; the wish is game-level.
  - **Facts the catalog has.** First released, platforms, verified releases, and the publisher only when every verified release names the same one. No developer or genre: the catalog doesn't record them yet.

## Tabs and sections

A tab bar (`SectionNav`) jumps to each part; every part stays on the page, so the keyboard, find-in-page, the existing step-by-step add (which works without JavaScript) and the checks keep working. No tab is shown for something that isn't there.

| Tab | What |
| --- | --- |
| Overview | The catalog's summary (or that it has none), and **Other titles (N)** folded away, instead of ten regional titles between the title and the facts |
| Add a copy | The existing step-by-step add (platform, region, edition, release), unchanged |
| Physical releases | The verified releases, by platform, unchanged |
| Gallery | Only when approved images exist |
| Your copies | The side panel |

## Your copies

`GameCopies` lists each of the collector's copies with its platform, region and edition as recorded, then only the completeness and condition they recorded (nothing filled in), and **View copy** and **Edit** (the copy's page with its edit form open, `?edit=1#edit`). Nothing private (purchase, price, location, notes) is shown here; those stay on the copy's own page. A visitor gets "Do you own …?" with Create Account and Sign In instead; another collector sees none of it.

## Images and their provenance

No authorized game image exists yet: ADR-017 designed `catalog_images`, and D15 (cover art) still needs legal advice. So images are a **reviewed, checked-in registry** for now, with ADR-017's fields, rather than a table:

- `src/assets/game-images/registry.json`: each entry has the game, platform, region and release (when known), the kind of item, the file under `public/game-images/`, the alt text, the source (name and URL), the licence (`licensed`, `user_contributed` or `public_domain`) with the terms in words, the attribution, and who approved it and when.
- `src/features/media/game-images.ts`: `imageFor` picks the exact release first, then the platform and region, then the platform in any region. It never shows another platform's image, nor another region's when the region is known. The caption says "This release" or "An example cartridge (NTSC-U/C)", always "not necessarily your copy".
- `npm run media:add -- …` (`scripts/game-image-add.mjs`) is the only way in: it refuses an image without its source, licence and approval, re-encodes it with sharp (dropping metadata), and checks the entry with the same rules.
- `npm run media:test` (now in CI) fails if any entry lacks them or its file.

Publicly reachable isn't permission, and neither are No-Intro or Redump metadata or a provider's API access. The registry is empty until images with permission exist. When D15 is settled, its entries move into `catalog_images` unchanged.

No migration.

## Against the reference (Chrono Trigger dashboard)

| Reference | Here |
| --- | --- |
| Large real box and cartridge art, left | Built (approved image with source and terms); shows "No artwork yet" until one exists |
| Title, platform with console, In My Collection, Wishlist, menu | Title, platform choice with consoles, ownership, Add to Collection / Add another, Wishlist |
| Release date, publisher | First release; publisher when every verified release agrees |
| User rating, "#12 Top SNES" | Not shown: no ratings or rankings exist |
| Genre tags (RPG, Adventure…) | Not shown: the catalog has no genres yet |
| Tabs: Overview, Releases, My Copies, Gallery, Community | Overview, Add a copy, Physical releases, Gallery (only with images), Your copies; no Community tab (no community data) |
| About the game | The catalog's summary, when it has one |
| Screenshot carousel | Not shown: no sourced screenshots |
| My Copy card (condition, completeness, region, edition, notes, Edit) | Your copies: platform, region, edition, recorded condition and completeness, View copy and Edit; notes stay on the copy's page |
| Game details table (developer, regional dates) | Facts the catalog has; regional dates appear per release when verified releases record them |

## Checks

`MGD_STACK=demo npm run app:game-page-checks` runs on the demo preview:

- a visitor on Super Mario World, a multi-platform game and the no-artwork state;
- a collector registered through the sign-up page and Mailpit, who adds the game from the hero and sees it owned, with View and Edit opening the right places, then wishes for it;
- another collector seeing none of it;
- a phone, and axe.

Screenshots go to `~/.my-game-dex/demo/m17b-screens`.
