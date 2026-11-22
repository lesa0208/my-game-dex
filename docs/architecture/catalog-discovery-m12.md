# M12: fast collecting and catalog discovery

**Written for:** the product owner, catalog editors and the engineers building M12b and M12c.

**Status: requirement accepted on 2026-11-19. M12b (the fast add, internal search and the missing-game fallback) is merged into main by PR #16 (`1ac0eb8`, 2026-11-19) and applied to development, which has 72 migrations. M12c-A, the first real NES, SNES and PlayStation catalog, is staged on the isolated test stack, with four releases published after a human review (two of them editions of one game) and all ten collector checks passing against them ([catalog-pilot-m12c.md](catalog-pilot-m12c.md)). External discovery is M12c-B: a required launch feature, not built, with no provider approved.**

Related: [database-schema.md § Collection system](database-schema.md#collection-system), [ADR-015: metadata providers are replaceable adapters](architecture-decisions.md#adr-015-metadata-providers-are-replaceable-adapters), [D14: metadata provider and budget](architecture-decisions.md#needed-before-catalog-work), [ADR-025: physical-only](architecture-decisions.md#adr-025-the-product-is-permanently-physical-only), [ADR-068](architecture-decisions.md#adr-068-collecting-never-waits-for-the-catalog), [physical-catalog-m11b.md](physical-catalog-m11b.md).

## The requirement

**Every physical game a collector owns must be trackable, even when the catalog is incomplete.**

The main journey is **search game → platform → region → edition → add**, in a few seconds. A collector never needs a product code, barcode, serial or any other technical identifier. When the game isn't in the catalog, they can still submit it and track their copy at once. The catalog stays accurate and moderated; personal tracking stays fast.

The workflow, end to end:

1. **Internal search** first.
2. **External discovery** when the game isn't found, only through approved providers.
3. **Confirm** the game and platform.
4. **Catalog candidate** created with provenance.
5. **Duplicate detection** before anything is published.
6. **Manual submission** when no source has the game.
7. **Track the physical copy immediately.**
8. **Editorial review**, as for every catalog change.
9. **Approval, rejection and merge** keep the copy.

Steps 1, 3 and 5 to 9 work today. Steps 2 and 4 from external sources are **M12c-B**, and wait on licensing.

## 1. Internal search

Explore searches the published catalog: titles, other known titles and product codes or barcodes (M5c). It's always the first step: a game is never created or imported when the catalog has it. Each result shows the signed-in collector's ownership ("Owned: Yes", "Owned: 3 copies"), read once per results page by `get_my_owned_games`, never once per result.

Every results page, and the no-results page, ends with **"Can't find your game? Add it to My Game Dex."** It opens the submission form with the search as the title to start from.

## 2. External discovery, when available and licensed (M12c-B)

When the internal search finds nothing suitable, an approved external provider may be searched to find the game. TheGamesDB and ScreenScraper are the pending candidate providers, not approved integrations; others may suit.

**Not approved yet.** Before any provider is integrated, the product owner confirms, in writing where possible:

- its current licence terms, and that commercial use is allowed;
- API access requirements (keys, accounts, cost);
- attribution obligations;
- data-retention permissions: whether its data may be kept in our catalog;
- rate limits.

A provider is used only once its row in `private.external_providers` has `commercial_use_cleared` set (ADR-015, D14). The licence findings so far are in the [provider table](architecture-decisions.md#adr-015-metadata-providers-are-replaceable-adapters): none of these terms could be confirmed from public sources.

**External data is for discovery and enrichment only.** My Game Dex keeps its own normalized catalog. What a provider returns becomes an internal candidate, so no catalog page depends on a live request to a provider, and losing one removes nothing.

**If no provider can be cleared for M12c-B,** discovery stays an explicit, unresolved launch requirement, not a dropped one:

- **Dependency:** a cleared provider (D14).
- **Meanwhile:** internal search plus the manual submission (section 5), which covers every game with or without a provider. Collectors still track their copies immediately (section 6).
- **Alternative source:** Wikidata (CC0, chosen in M11b-0 for game identity) as a discovery source for game titles, which needs no licence clearance beyond attribution good practice.

## 3. Catalog candidates

A game or release from outside the catalog enters as a candidate:

- an **external candidate** through the M5b importer: provenance per field (`catalog_import_records`), never published by the import;
- a **submission** by a collector (M7a): `unverified`, private to them and the editors.

Either way it carries where it came from and goes through the same review (ADR-016). No user, and no import, publishes anything directly.

## 4. Duplicate detection

Before a candidate is published:

- **Submissions** are checked against published releases when they're made (`submit_game`, `submit_release`): an exact match returns the published release instead ("You can add your copy from its page"). Editors see possible duplicates in review.
- **Imports** match source records to existing games and releases, and never create a second copy of one (M5b).
- **Merges** (M7b-2c) resolve duplicates found later, moving collectors' copies with everything recorded.

The release identity keys (M11b-1b) decide what counts as the same physical release.

## 5. Manual submission fallback

When neither the catalog nor an approved source has the game, the collector submits it from **Submit to the catalog**:

- the game's title (and, optionally, its type and first year);
- the platform and its physical format (chosen automatically when the platform has only one);
- the region, or "Unknown";
- the edition and everything else, optional and collapsed.

They confirm it's a physical game: a cartridge, disc or card with the game on it, not a download code, an empty box or a manual on its own (ADR-025, ADR-030). The submission is validated as before and enters editorial review. Submitting never gives anyone the ability to publish.

## 6. Immediate tracking of a pending copy

M12b reuses what M7a already provides: the submitter may add a copy of their own pending release (`can_use_release` allows it). The form adds it **at once by default** ("Add my copy to my collection now").

**Sending the form again makes nothing twice.** The form carries an id made when it was rendered and kept on a failure. It names both the submission request and the copy:

- `submit_game_once` and `submit_release_once` record which submission a request made. A double click, a retry after a lost response or a reload returns that submission, even with a field changed, instead of making a second game or release. Concurrent sends wait for each other. The submission functions themselves are unchanged and still check everything.
- The copy is added under the same id, so `add_collection_item` adds it once. A retry adds it if the first send didn't.
- Signed out or with an ended session, nothing is submitted. Another user sending the same form is refused.

**If the submission is made but the copy can't be added,** the collector is taken to the submission, which says "Your copy couldn't be added to your collection: you can add it below" and offers the add, itself retry-safe. Sending the original form again still makes no second submission.

The copy is in the collection straight away, labelled **Awaiting catalog approval**. It counts towards the collector's own "Owned" for the game, and never as a confirmed release.

No new ownership model was needed: an M12a unidentified copy (a private claim) is for a game the catalog *has*; a game it doesn't have is submitted, and the copy points at the submitted release.

## 7. Editorial review

Editors review submissions as before (M7b-1): staff only, a verified second factor, and never their own submission (no self-review). The collector's copy changes nothing about the review.

## 8. Approval, rejection and merge: the copy is kept

| Outcome | The collector's copy |
| --- | --- |
| **Approved and published** | Becomes a confirmed copy of a catalog release |
| **Changes requested** | Stays, awaiting catalog approval; the collector can still edit the submission |
| **Rejected: a release of a game the catalog has** | Stays in the collection as "Not approved", with everything recorded; the collector can keep it unidentified (with the region and edition they know), move it to another release, or remove it |
| **Rejected: a new game** | The game is rejected with its release, so it isn't in the catalog, and an unidentified copy needs a published game (`can_claim` isn't loosened for this). The copy stays as "Not approved", with everything recorded and counted on the owner's own view. Its page doesn't offer to drop the release, says why, and offers to move it to a release the catalog has, if the game is there under another title, or to remove it |
| **Merged into an existing release** | Moves to that release with everything recorded (M7b-2c), and is confirmed if that release is published |
| **Withdrawn** | Not possible while the collector has copies of it: they're asked to remove them first, so no copy is left on a withdrawn release |
| **Excluded** | Preserved privately with everything recorded, not counted (M7b-2b); restoring brings it back |

No outcome deletes a copy or quietly changes what it is. A copy is only ever moved by a merge, which records it.

## 9. Game metadata is not a verified physical edition

General game metadata says a game exists on a platform. It doesn't prove a physical release. From metadata alone, the catalog never infers or publishes:

- a retail region (PAL, NTSC-U/C, NTSC-J…);
- an edition (Platinum, Greatest Hits, Player's Choice, PlayStation the Best…);
- packaging, a cartridge shell, or a barcode or product code.

Those need release-level evidence and review (M11b-0, sections 3 and 7). A collector's own region or edition for their copy is theirs: an unidentified copy (M12a) records it privately and adds nothing to the catalog.

## The fast add (M12b)

On a game's page, four steps, each driven by the address so it works without JavaScript:

1. **Platform.** The catalog's platforms for the game first, with their release counts, then **Another platform**. A copy on a platform the catalog doesn't list for the game is the collector's own claim, labelled "not in the catalog"; no pairing is created.
2. **Region.** The catalog's regions for that platform first, then **Another region** (any region code) and **Not sure**.
3. **Edition.** The catalog's editions for that platform and region first, then **Another edition** (the collector names it, with suggestions) and **Not sure**.
4. **Add.**
   - If the choices name exactly **one published release**, it's added through the ordinary add (`add_collection_item`).
   - If **several** match, the collector picks one, or adds the copy without one. One is never picked for them.
   - Otherwise (a region or edition not sure, or not in the catalog) the copy is added **unidentified** (`add_unidentified_copy`, M12a) with what they know.
   - **"Not sure" stays not sure.** A region or edition left not sure is never filled in from the catalog, even when only one published release could match, and a release named in the address (a stale or edited link) isn't added over a not-sure or different choice: the page says it doesn't match and lists it to choose explicitly. The collector confirms an exact release only by choosing its region and edition, or the release itself, and pressing Add.

Both adds are safe to retry: the copy's id is made when the page renders, so a double click gets the same copy back, and "Add another copy" gets a new id, so owning several copies works as before. Optional details (completeness, condition, purchase, notes) are collapsed.

The page also shows what the collector already has of the game, by platform, region and edition, with each copy's standing:

| Standing | Counts towards "Owned" |
| --- | --- |
| Confirmed | Yes |
| Awaiting catalog approval | Yes |
| Not approved | Yes |
| Not linked to a release | Yes |
| Preserved, not counted | No |

On a copy's own page, its owner can later set or correct an unidentified copy's region and edition, link it to a catalog release, leave a copy of a release unidentified, and read its private history of changes. Purchase details, completeness, conditions, notes and dates are kept through every change.

## Roadmap

- **M12b:** the fast add, internal search with ownership, the missing-game fallback with immediate tracking, and this document. *Merged (PR #16) and on development.*
- **M12c-A:** the first real NES, SNES and PlayStation catalog, from the M11b-0 shortlist revalidated against current evidence, through the existing importer and review. *On the test stack: 29 candidates staged, 4 published after human review.*
- **M12c-B0: providers, licensing and bulk acquisition.** Research and decisions (2026-11-20): Wikidata as the initial game-identity source (D-1), IGDB pending written partnership terms, physical releases from editors and per-source permissions ([catalog-acquisition-m12c-b0.md](catalog-acquisition-m12c-b0.md)).
- **M12c-B1 (proposed):** game identities published separately from physical releases, batch review with validation and sampling, and a 150-identity SNES pilot ([catalog-ingestion-m12c-b1.md](catalog-ingestion-m12c-b1.md)). *Awaiting approval.*
- **M12c-B: external API discovery.** A required part of the launch journey (step 2), not an optional extra. Requirements and the implementation plan are in [catalog-pilot-m12c.md § M12c-B](catalog-pilot-m12c.md#m12c-b-external-api-discovery). If no provider can be cleared, discovery stays the open launch requirement in section 2, with its dependency and the alternative plan.

## Review notes (M12b)

**Accessibility.** Every M12b page state passes the supported checks: Dark Mode axe (WCAG 2.0–2.2 A and AA, no critical or serious findings), one h1 and named fields, keyboard use and no sideways scrolling. The states covered are the fast-add steps (including a linked release that doesn't match), the claim and identity forms, a copy's history, ownership on the game page and search results, and the missing-game form. The Light Mode diagnostics list 186 findings, one per page state across the app, all `color-contrast`. With `A11Y_LIGHT_DETAIL=<file>`, which lists every failing element, none is particular to M12b: each M12b element in the list fails for the same reason as the rest of the app. The unused light token set leaves dark-theme colours on light surfaces, such as `#f5f5f7` text on white (about 1,000 elements app-wide) and dark cards (`#191b24`) on the light background. That is the pre-existing Light Mode gap recorded in ADR-056 (Dark Mode is the only supported appearance). Light Mode isn't offered, and making it supported is a release blocker of its own.

**Pre-existing, separate cleanup.** The invitation app suite (`app-invitation-checks.mjs`) leaves 4 `released` handle holds (`ai_…`) in `private.handle_holds` after it runs. No check counts them and they block nothing, but the suite should remove them as the fast-add suite removes its own (`fa_…`). This predates M12b and isn't changed here.
