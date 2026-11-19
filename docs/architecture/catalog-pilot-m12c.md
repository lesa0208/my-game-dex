# M12c-A: the first real physical game catalog (pilot)

**Written for:** the product owner, catalog editors and the reviewer who publishes the pilot, and the engineers planning M12c-B.

**Status, 2026-11-19: staged on the isolated test stack, publication blocked on a second, human catalog editor.**

**Baseline:**
- `main` at `1ac0eb8` (PR #16: M11b, M12a and M12b).
- Development has 72 migrations and wasn't touched by M12c-A.
- M12c-A adds no migration.

Related: [physical-catalog-m11b.md](physical-catalog-m11b.md) (the M11b-0 design and shortlist), [catalog-discovery-m12.md](catalog-discovery-m12.md) (the collecting journey), [ADR-015](architecture-decisions.md#adr-015-metadata-providers-are-replaceable-adapters) (providers), [security-rls.md § Catalog import](security-rls.md#catalog-import).

## Outcome

| | Count | Where |
| --- | --- | --- |
| Games imported from Wikidata | 8 | In review, unpublished |
| Release candidates, class A (item-level evidence) | 20 | Staged, waiting for a second editor's review |
| Release candidates, class B (a gap to close first) | 9 | Staged, not to be verified until the gap is closed |
| Held entries (class H) | 9 | Not entered |
| **Published** | **0** | Blocked: see [Publication](#publication-blocked-on-a-human-reviewer) |

The pilot keeps M11b-0's scope: 8 games and 38 release candidates. Every candidate was revalidated against sources read and saved on 2026-11-19, and several moved class (see [Changes from the M11b-0 table](#changes-from-the-m11b-0-table)).

**Nothing reached a collector.** With no release published, the games aren't in search, and the ten collector checks (search, game page, fast-add choices, adding, separate editions, unidentified copies, duplicates, ownership and summary) can't run yet. They're written as `scripts/app-catalog-pilot-checks.mjs`, with every expectation taken from the evidence table, and run once a reviewer publishes the A releases.

## Sources and licensing

Pages were read on 2026-11-19, one at a time, within each site's robots rules (SNES Central asks for 10 seconds between requests). The copies are saved outside the repository in `~/.my-game-dex/source-evidence/2026-11-19/`, and each release's creation reason names its page and the copy's SHA-256.

**Nothing was downloaded beyond those pages and three Wikidata query results:** no image, scan, cover, ROM, DAT or database export.

| Source | Use in M12c-A | Licensing and access, as checked | Status |
| --- | --- | --- | --- |
| **Wikidata** | Game identity: title and first release date. Never evidence of a physical release | Structured data "released into the public domain under Creative Commons Zero" ([Wikidata:Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing), saved, sha256 `dd71f104…a5c5`). The Query Service was in an outage and limiting every client to 1 request a minute (`retry-after: 1000`). The importer waited it out and made one request per platform, more than a minute apart. Its User-Agent is generic, with no personal contact. Wikimedia's policy asks for a contact, so the operator decides what to send before a production run | **Cleared on the test stack** (M11b-D1), against that terms hash |
| **SNES Central** | Item-level evidence for SNES cartridges: printed code, country, notes, label scan present or "scan needed" | No reuse licence stated. robots.txt allows the article pages with `Crawl-delay: 10` | Cited one fact at a time. No bulk extraction |
| **PSXDataCenter** | Item-level evidence for PlayStation releases: disc serials, date, back-cover barcode | No reuse licence stated, and no robots.txt (404) | Cited one fact at a time |
| **MarioWiki** | Super Mario Bros. serial code list (B evidence only) | Wiki text, CC BY-SA. robots.txt allows article pages | Cited one fact at a time |
| **Wikipedia** | SNES regional cartridge shapes; game pages for NES context | CC BY-SA text | Cited one fact at a time |
| **NesCartDB** | Item-level NES evidence in M11b-0 (profiles 270, 490, 872) | robots.txt disallows ClaudeBot, anthropic-ai and Claude-Web, sets `ai-train=no, use=reference`, and reserves rights under EU Directive 2019/790 Art. 4 | **Not re-read in M12c-A.** A person re-reads these profiles before the NES rows can be verified |
| **TheGamesDB** | None | No published terms of use, licence or attribution rules. An API key needs a signed-in account. Allowances and their increase aren't readable. The GPL-3.0 on its GitHub covers the site code, not the data | **Held**, pending written permission covering commercial use, storage, attribution and images |
| **ScreenScraper** | None | The API may be built only into "applications entièrement gratuites" (completely free applications), otherwise only with the team's prior authorisation and conditions ([webapi2](https://www.screenscraper.fr/webapi2.php), saved). Developer credentials come through its forum. Per-user quotas depend on level and donations. The site states CC BY-NC-SA 4.0, and its media is credited to third parties | **Not usable** commercially. Even a written licence wouldn't clear third-party images |
| No-Intro, Redump | None | As M11b-0 (D2 conditional, D3 held) | Not cleared |

**Neither TheGamesDB nor ScreenScraper is enabled.** Neither has a row cleared in `private.external_providers`. Integrating either needs the product owner's explicit approval after its terms are confirmed in writing.

## Games

Imported by the M5b importer as `catalog_importer`, from one Wikidata query result per platform, filtered to a fixed list of items. Each game is `under_review`, with its platform pairing and a Wikidata external reference. The first date is Wikidata's earliest P577, at its precision.

| Game | Wikidata | Platform run | First release |
| --- | --- | --- | --- |
| Super Mario Bros. | Q11168 | nes | 1985-09-13 |
| The Legend of Zelda | Q12395 | nes | 1986-02-21 |
| Super Mario World | Q853143 | snes | 1990-11-21 |
| The Legend of Zelda: A Link to the Past | Q370055 | snes | 1991-11-21 |
| Super Metroid | Q1194825 | snes | 1994-03-19 |
| Final Fantasy VII | Q214232 | playstation | 1997-01-31 |
| Crash Bandicoot | Q719176 | playstation | 1996-09-09 |
| Metal Gear Solid | Q6582527 | playstation | 1998-09-03 |

**Snapshots** are in `~/.my-game-dex/catalog-snapshots/2026-11-19/`:

| Platform | Items | SHA-256 |
| --- | --- | --- |
| nes | 1,216 | `091532b4…7ebcef` |
| snes | 1,429 | `ff483655…e7bd6e` |
| playstation | 2,446 | `b5a5b541…4d877d` |

## Physical release candidates

All are created by editor A through `create_release`, and for SNES `set_release_markets` with the countries the source names. Each reason cites its page and saved copy.

The data is in `scripts/catalog-pilot-m12c-data.mjs`.

**Packaging.**
- No source states how a package is built.
- The A rows are classified `unknown`: an editor examined the evidence and the construction can't be established.
- The B rows stay `unclassified`, a visible gap.

**Product codes.**
- SNES codes are the codes printed on the cartridge labels SNES Central documents.
- No PlayStation package code is set: a disc serial isn't the package code (M11b-0).
- The serials are kept in the evidence, and MIG-4 stays cancelled.

### Class A: staged for review (20)

| # | Game | Format | Region | Code or barcode | Edition, variant | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Super Mario World | snes-cartridge-jp-pal | ntsc-j | SHVC-MW | Standard | SNES Central 0000 |
| S2 | Super Mario World | snes-game-pak-na | ntsc-uc | SNS-MW-USA | Standard | SNES Central 0000 |
| S3 | Super Mario World | snes-game-pak-na | ntsc-uc | SNS-MW-USA-1 | Standard, "Two-line logo label" | SNES Central 0000 |
| S4 | Super Mario World | snes-cartridge-jp-pal | pal | SNSP-MW-NOE | Standard | SNES Central 0000 |
| S6 | Super Mario World | snes-cartridge-jp-pal | pal | SNSP-MW-FAH-1 | Standard | SNES Central 0000 |
| S7 | A Link to the Past | snes-cartridge-jp-pal | ntsc-j | SHVC-ZL | Standard | SNES Central 0164 |
| S8 | A Link to the Past | snes-game-pak-na | ntsc-uc | SNS-ZL-USA | Standard | SNES Central 0164 |
| S9 | A Link to the Past | snes-game-pak-na | ntsc-uc | SNS-ZL-USA-1 | Reprint, "Player's Choice" | SNES Central 0164 |
| S11 | A Link to the Past | snes-cartridge-jp-pal | pal | SNSP-ZL-UKV | Standard | SNES Central 0164 |
| S12 | A Link to the Past | snes-cartridge-jp-pal | pal | SNSP-ZL-NOE/SFRG | Standard | SNES Central 0164 |
| S13 | Super Metroid | snes-game-pak-na | ntsc-uc | SNS-RI-USA | Standard | SNES Central 0885 |
| S14 | Super Metroid | snes-cartridge-jp-pal | pal | SNSP-RI-FAH | Standard | SNES Central 0885 |
| S15 | Super Metroid | snes-cartridge-jp-pal | pal | SNSP-RI-UKV | Standard | SNES Central 0885 |
| P1 | Final Fantasy VII | cd-rom, 3 discs | ntsc-j | barcode 4961012967056 | Standard, 1997-01-31 | PSXDataCenter SLPS-00700 |
| P2 | Final Fantasy VII | cd-rom, 3 discs | ntsc-uc | barcode 711719416326 | Standard, 1997-08-15 | PSXDataCenter SCUS-94163 |
| P9 | Crash Bandicoot | cd-rom | ntsc-uc | barcode 711719490029 | Standard, 1996-09-09 | PSXDataCenter SCUS-94900 |
| P10 | Crash Bandicoot | cd-rom | pal | barcode 711719627623 | Standard, 1996-11-15 | PSXDataCenter SCES-00344 |
| P11 | Crash Bandicoot | cd-rom | ntsc-j | barcode 4948872100311 | Standard, 1996-12-06 | PSXDataCenter SCPS-10031 |
| P12 | Crash Bandicoot | cd-rom | ntsc-j | barcode 4948872910576 | Reprint, "PlayStation the Best for Family", 1998-05-28 | PSXDataCenter SCPS-91057 |
| P13 | Metal Gear Solid | cd-rom, 2 discs | ntsc-uc | barcode 083717170310 | Standard, 1998-10-21 | PSXDataCenter SLUS-00594 |

**How the SNES shell is decided.** Wikipedia's SNES page: "North American cartridges have a rectangular bottom with inset grooves… and other regions' cartridges are narrower". The shell follows the country SNES Central lists for the cartridge (USA, or Japan and the PAL countries), not the region label.

**SNES dates** are left unknown: SNES Central gives manufacturing codes, not release dates.

**Several editions stay separate releases:**
- S8 (Standard) and S9 (Player's Choice).
- S2 and S3, the same edition with a different label, separated by variant and code.
- P11 and P12 (Standard and PlayStation the Best).

### Class B: staged with a gap (9)

| # | Release | Gap |
| --- | --- | --- |
| P4–P7 | Final Fantasy VII PAL: UK, French, German and Spanish flags (barcodes 711719694328, 711719694427, 711719694526, 711719694625) | The four packages differ only by language and barcode. Without a confirmed package code they would share one published identity, so none is published until the package codes are confirmed |
| N1 | Super Mario Bros., Famicom cartridge, HVC-SM | Code from a wiki list |
| N2 | Super Mario Bros., Famicom Disk System, FMC-SMA | Code from a wiki list. The edition isn't established |
| N3 | Super Mario Bros., NES Game Pak, NES-SM-USA | A in M11b-0 from NesCartDB 270, which wasn't re-read (its robots.txt refuses AI agents) |
| N5 | Super Mario Bros., NES Game Pak PAL, NES-SM-AUS | Code from a wiki list |
| N7 | The Legend of Zelda, NES Game Pak, NES-ZL-USA, "Gold cartridge" | A in M11b-0 from NesCartDB 490 and 872, not re-read |

### Held: not entered (9)

| # | Release | Why |
| --- | --- | --- |
| N4 | Super Mario Bros., NES PAL | Code conflict: NES-P-SM on MarioWiki, NES-SM-EEC only in a snippet |
| N6 | The Legend of Zelda, Famicom Disk System | FMC-ZEL seen only in a snippet |
| N8 | The Legend of Zelda, NES Classic Series | No code |
| N9 | The Legend of Zelda, NES PAL | No code or country package |
| N10 | The Legend of Zelda, Famicom cartridge (1994) | No code |
| S5 | Super Mario World, PAL UK | Listed as "SNS-MW-UKV": the missing P may be a source error |
| S10 | A Link to the Past, Player's Choice "E" rating (SNS-ZL-USA-2) | **New in M12c-A**: SNES Central lists it with "scan needed" |
| P3 | Final Fantasy VII, US Greatest Hits | Package shown only by cover images filed under the original serial |
| P8 | Final Fantasy VII, PAL Platinum | Package unconfirmed. The bonus disc is SCED-02062 on the German page, where M11b-0 recorded SCED-20062 |

### Changes from the M11b-0 table

**PlayStation P1, P2 and P9 to P13 move from B to A.** M11b-0 held them at B for the package code. M12c-A found that PSXDataCenter gives each package's barcode "From the back cover", which ties the record to the package. None of them needs a package code to be told apart, because none shares its game, region and edition with another release. **The reviewer confirms or reverses this reclassification.**

**Other moves:**
- **P2 and P9 lose the "Black label" variant.** The source doesn't state it.
- **N3 and N7 move from A to B.** Their NesCartDB evidence wasn't re-read (see Sources).
- **S10 moves from A to H** ("scan needed").

**Edition names follow each source's spelling.**
- "Player's Choice" is SNES Central's spelling. The printed logo's punctuation wasn't seen, so the reviewer checks it before publishing.
- "PlayStation the Best for Family" is PSXDataCenter's title, with the brand's capitalisation.

## Publication: blocked on a human reviewer

The pilot stops before review, deliberately. Each release needs a second catalog editor who re-reads its saved evidence and verifies it. A script acting as that editor would fabricate the verification the review guard exists to require.

**On the test stack:**
- Editor A's own attempt to verify was refused (`own record`).
- Editor A's attempt to publish was refused (`release not verified`).
- The admin release page tells editor A: "You created this record, so another editor verifies and publishes it."

**For a reviewer on the test preview (port 3002):**
1. Sign in as a catalog editor who isn't editor A. The test stack needs one more disposable editor for this (M11b-D11: who reviews on development is still open).
2. Open **Admin → Catalog records**, search each title, and filter by status "In review". Staff-created candidates aren't in the submission review queue, which lists collectors' submissions only.
3. For each A release: open it, read its creation reason in **History**, compare it with the saved page named there, then verify it.
4. Verify the game: title and date against its Wikidata item.
5. Publish the release, which publishes the game and its pairing.

Each of verify, publish and verify-game needs a reason and a TOTP verification in the last 10 minutes.

6. Leave B rows in review until their gap is closed.
7. Then run `MGD_STACK=test node scripts/app-catalog-pilot-checks.mjs`.

**Development** gets nothing until the product owner approves the reviewed result (M11b-D10). The same steps then run there, behind a backup and restore check, without a seed or bulk import.

## What was reused

Nothing new was built to stage the pilot:
- **Clearance:** `private.record_provider_clearance`, the operator procedure, bound to the saved terms hash.
- **Import:** the M5b importer (`scripts/catalog-import.mjs`) as `catalog_importer`, with the fixed `--ids` selection. It runs `start_run`, `stage_records`, `apply_record` and `run_report`, and creates `external_references` and title keys.
- **Releases:** `create_release`, `set_release_markets`, the M11b-1a shells and the M11b-1b packaging and identity rules.
- **Review guard and MFA:** the M10c review guard (no self-review), `require_recent_mfa`, `verify_game`, `verify_release` and `publish_release`, all unchanged.
- **Collector side:** the M12b fast add, search, ownership and summary, unchanged.

**New code is small:**
- **Importer fixes** in `scripts/catalog-import-sources.mjs`, with unit tests:
  - Wikidata platform items for `nes` (Q172742), `famicom-disk-system` (Q135321) and `playstation` (Q10677), checked on 2026-11-19.
  - Labels fall back to `mul`. Wikidata now keeps names shared by every language there with no English copy. Super Mario World and the PlayStation item itself are labelled that way, and such items were ignored as "no English label".
  - A year that contains a more precise date gives way to it. Super Mario Bros. was imported as "1985" instead of 1985-09-13.
- **`scripts/catalog-pilot-m12c-data.mjs`:** the evidence and candidates.
- **`scripts/catalog-pilot-m12c.mjs`:** a runner with the commands `clear-wikidata`, `import`, `stage` and `report`. It refuses any stack but the test stack.
- **`scripts/app-catalog-pilot-checks.mjs`:** the collector checks, to run after review.

**postgres** recorded the clearance, gave the disposable test editor its role (as the review checks do), and read. It wrote no catalog row.

## Findings for review

1. **Staged candidates are invisible to collectors, so a collector can submit a duplicate.** While a game is in review, search shows "No games found" and offers "Add it to My Game Dex". The submission duplicate check compares with published releases only. Editors see possible duplicates in review, but the gap is widest exactly while a pilot waits for review. Options: publish promptly, or have the submission check also flag staff candidates to the editor (not to the collector).
2. **Staff-created candidates have no review queue.** A reviewer finds them by title in Catalog records. A "staff candidates awaiting review" view would make the second-editor step practical at scale.
3. **Evidence is recorded only as text.** A release's evidence is its creation reason in the audit history; the record page shows "Evidence: None" under Sources, because `release_evidence` holds importer evidence only and MIG-5 isn't implemented. This works for a pilot of 29 releases, but not for thousands.
4. **Packaging is `unknown` for every A release.** The sources never state construction. A packaging fact needs a person with the item, or a source that states it.

## Artwork: a separate dependency

No artwork was read, downloaded or displayed. The pilot uses the existing placeholders. Cover art, labels and box scans wait on the image-licensing decision (D15), which is a dependency of the later visual catalog, not of this pilot. TheGamesDB and ScreenScraper media wouldn't satisfy it (see Sources).

## M12c-B: external API discovery

**This is a required part of the launch journey, not an optional extra.** It is step 2 of [catalog-discovery-m12.md](catalog-discovery-m12.md#the-requirement): when internal search finds nothing, an approved provider is searched, and the result becomes an internal candidate with provenance.

### Requirements

1. **A cleared provider first.** A provider is used only once its `private.external_providers` row has `commercial_use_cleared`, against a saved terms copy, after the product owner's written approval. The approval covers commercial use, API access and keys, attribution, local storage and redistribution, rate limits and cost, and metadata versus artwork rights.
2. **Discovery never publishes.** A provider result becomes a game candidate (`under_review`) with provenance per field, exactly as the importer creates one, and goes through the same review and no-self-review rules.
3. **Game identity only, unless the provider states release-level facts with evidence.** A provider's platform list never creates a physical release. Region, edition, packaging and codes need release-level evidence (M11b-0 § 3).
4. **Internal search always runs first.** Duplicate detection runs against published games and staff candidates before a candidate is created (closing finding 1).
5. **The collector's copy is tracked at once.** As with the M12b missing-game fallback, it's labelled "Awaiting catalog approval".
6. **No live dependency.** No catalog page calls a provider. Results are stored, so losing a provider removes nothing.
7. **Rate limits and keys stay server-side.** Keys are never sent to the browser. Requests respect the provider's limits and back off on 429. Every request identifies the client as the provider requires, without personal data unless the operator approves it.
8. **No artwork** until D15 is resolved and the provider's image rights are confirmed separately.

### Recommended plan

1. **Wikidata first.** It is the only source already cleared (CC0, M11b-D1), so M12c-B can be built and proven on it.
   - The importer's query and parser already exist.
   - Discovery adds a server-side title search (Wikidata's search API, then the item's claims) for one collector's query, rate-limited and cached.
   - When the collector confirms an item, discovery creates an under-review game candidate through the importer functions.
2. **A provider adapter interface** (ADR-015: one module per provider) with three capabilities: search by title and platform, fetch one record, and map it to the importer's entry shape. Each adapter is gated on its provider's clearance row.
3. **A discovery step in the fallback.** After "No games found", the collector sees "Found elsewhere" candidates, with their source named. Choosing one creates the candidate and adds the copy; "None of these" goes to the manual submission as today.
4. **Editor tooling.** A queue of discovery candidates and staff candidates awaiting a second editor (finding 2), with each candidate's provider record shown beside it.
5. **Provider clearance, in parallel.**
   - TheGamesDB: ask its staff for written terms.
   - ScreenScraper: only with a commercial licence, metadata only.
   - IGDB and MobyGames: confirm partnership and pricing.
   - None is enabled until approved.
6. **Tests.** Adapter contract tests on saved responses, clearance gating (an uncleared provider can't run), duplicate detection against staff candidates, no-self-review on discovery candidates, and the collector flow end to end.

If no commercial provider can be cleared, Wikidata discovery plus the manual submission meets the requirement, and the gap for games Wikidata lacks stays an explicit, tracked launch risk.
