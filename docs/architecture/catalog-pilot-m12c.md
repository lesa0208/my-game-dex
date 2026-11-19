# M12c-A: the first real physical game catalog (pilot)

**Written for:** the product owner, catalog editors and the reviewer who publishes the pilot, and the engineers planning M12c-B.

**Status, 2026-11-19: on the isolated test stack, three releases are published after a human review by the product owner (editor B). The collector checks pass against them. The rest stays staged or held.**

**Baseline:**
- `main` at `1ac0eb8` (PR #16: M11b, M12a and M12b).
- Development has 72 migrations and wasn't touched by M12c-A.
- M12c-A adds no migration.

Related: [physical-catalog-m11b.md](physical-catalog-m11b.md) (the M11b-0 design and shortlist), [catalog-discovery-m12.md](catalog-discovery-m12.md) (the collecting journey), [ADR-015](architecture-decisions.md#adr-015-metadata-providers-are-replaceable-adapters) (providers), [security-rls.md § Catalog import](security-rls.md#catalog-import).

## Outcome

| | Count | Where |
| --- | --- | --- |
| Games imported from Wikidata | 8 | 3 published with their reviewed release, 5 in review |
| Releases published after human review | **3** | S4, P1 and P11 (below) |
| Class A candidates still in review | 17 | Not reviewed yet |
| Class B candidates (a gap to close first) | 9 | In review, not to be verified until the gap is closed |
| Held entries (class H) | 9 | Not entered |

The pilot keeps M11b-0's scope: 8 games and 38 release candidates. Every candidate was revalidated against sources read and saved on 2026-11-19, and several moved class (see [Changes from the M11b-0 table](#changes-from-the-m11b-0-table)).

## Human review result (2026-11-19)

The product owner reviewed as editor B, signed in to their own test account (`@salebea`) with their own authenticator. They chose the releases to publish. The guide had proposed S1, S2 and P11; they published S4 instead of S1 and S2, and added P1.

| # | Game | Platform, format | Region | Edition | Code or barcode | Release id |
| --- | --- | --- | --- | --- | --- | --- |
| S4 | Super Mario World | SNES, Super Famicom / PAL SNES Cartridge | PAL (sold in Germany) | Standard | SNSP-MW-NOE | `01a1f558-7072-77ed-b0f8-42fee81734c5` |
| P1 | Final Fantasy VII | PlayStation, CD-ROM, 3 discs | NTSC-J | Standard | barcode 4961012967056 | `01a1f558-70f9-7c62-abe0-bf1d81c48a52` |
| P11 | Crash Bandicoot | PlayStation, CD-ROM, 1 disc | NTSC-J | Standard | barcode 4948872100311 | `01a1f558-7114-7097-9eb6-c4c4a0c3cb25` |

**Read from the database afterwards, without changing anything:**
- Each game (Super Mario World, Final Fantasy VII, Crash Bandicoot) and its platform pairing is published.
- Each release was created by editor A (`@m12c_a_298ed9`) and verified by editor B. Each game was verified by editor B.
- The audit log has, by editor B, 3 game verifications, 3 release verifications and 3 publications of each.
- No release was verified by its creator. The review guard and MFA were in force throughout. No script signed in as editor B, completed their MFA, or verified or published anything.

**The review reasons were recorded as short placeholders** ("moze", "sdada" and similar), not as what was checked. The reasons are kept as recorded. A review on development should name the evidence checked (for example "SNES Central 0000: Germany, SNSP-MW-NOE, regular release"), so the audit log explains the decision.

**Verified physical releases versus game metadata.**
- **The three releases are verified physical releases:** a human checked them against item-level sources.
- **The games' titles and first-release dates are Wikidata game metadata,** verified by the same reviewer as game identity. They are not evidence of any particular package.

**The reviewer also used the collector side.** Their account submitted Super Mario World, PAL, edition not given, through the missing-game form, and added a copy. That submission is pending review and private to them and editors, and the copy is "Awaiting catalog approval". It is the 30th release on the stack and isn't part of the pilot. The no-self-review rule means another editor must review it. It shows finding 1 in practice: a collector's PAL copy, while a reviewed PAL release (S4) exists, goes to review rather than being matched to it, because a submission with the edition not given never matches a classified release.

## Collector checks after review

`MGD_STACK=test node scripts/app-catalog-pilot-checks.mjs` ran against the three published releases, in the built app over HTTP on the isolated test stack. The harness starts its own instance of the same build, on a private port, against the same stack as the 3002 preview.

**Result: 62 passed, 0 failed, and one unmet prerequisite.**

| # | Check | Result |
| --- | --- | --- |
| 1 | Internal search finds each published game; the five still in review link to no game page | Pass |
| 2 | Each game page loads, titled | Pass |
| 3 | Platform: only the published release's platform | Pass |
| 4 | Region: only the published regions. PAL only for Super Mario World, though four other Super Mario World candidates are in review | Pass |
| 5 | Edition: only the published editions | Pass |
| 6 | Each published release is added as itself, once, though its form is sent twice | Pass |
| 7 | Two published releases of one game stay separate | **Unmet prerequisite:** no game has two published releases. Three releases of three games stay three separate copies (pass). The same-game case needs, for example, S8 and S9 (A Link to the Past Standard and Player's Choice) published |
| 8 | "Not sure" adds an unidentified copy, with the platform and region, and nothing in the catalog | Pass |
| 9 | Ownership on the game page and in search (Final Fantasy VII "Owned: 2 copies", the others 1), and the summary ("4 copies", "2 platforms"); another collector sees none | Pass |
| 10 | No duplicate games; the held entries were never entered; every published release has two different editors; every other collection, including the reviewer's own copy, is unchanged; the pilot is unchanged | Pass |

**One check was wrong at first, and was fixed.** It looked for a game still in review by its title in the search page's text, but the no-results page repeats the query, and "Super Mario Bros." rightly finds the published Super Mario World. The check now judges results by the game pages they link to: every one must be a published game.

## Outstanding evidence gaps and limitations

- **17 A releases** still wait for a reviewer, including both A Link to the Past editions needed for check 7.
- **Packaging is `unknown`** on every published release. **No SNES release date**, and no PlayStation package code.
- **NES has nothing publishable** until a person re-reads the NesCartDB profiles.
- **The four PAL Final Fantasy VII packages** need package codes.
- **The `Player's Choice` spelling** is unconfirmed against the printed logo.
- **pgTAP assumes an empty database.** On the staged stack, 22 assertions in 9 of the 47 files fail on what the stack already holds: 5 accounts where 3 are expected, the two pilot editors among staff and factors, audit rows, published records, Wikidata cleared. `30_owner` also stops at test 29, when a subquery meets the two extra accounts. They passed on the clean stack before staging (3,715 tests, 47 files), and M12c-A changes no migration or database function. Running pgTAP again needs a clean stack, which would remove the human-reviewed pilot, so it's left for review on a fresh stack or a copy of this one.
- **Review reasons:** see the review result above.

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

## Publication: by a human reviewer only

No script reviews. Each release needs a second catalog editor who re-reads its saved evidence and verifies it. A script acting as that editor would fabricate the verification the review guard exists to require.

**On the test stack:**
- Editor A's own attempt to verify was refused (`own record`).
- Editor A's attempt to publish was refused (`release not verified`).
- The admin release page tells editor A: "You created this record, so another editor verifies and publishes it."

**Who reviews.** The product owner is editor B, on the isolated test stack only (decided 2026-11-19). They create, sign in to and verify with their own test account. No script signs in as editor B, completes their MFA, or verifies or publishes in their name.

### Human review guide: the first batch

**1. The reviewer's account.** Run this yourself in an interactive terminal, only when you choose to:

```text
MGD_STACK=test node scripts/catalog-pilot-m12c.mjs reviewer-account --email <you>-review@example.test
```

- It asks twice, without echo, for a password you choose (12+ characters).
- The password goes only to the local test Auth server, and is never stored or printed.
- The account has no staff role yet.

**2. Your authenticator.** On http://127.0.0.1:3002:
1. Sign in and choose a handle.
2. Under **Settings → Security**, add an authenticator by scanning the code with your own app.

Nobody else sees the secret.

**3. The catalog editor role.** Then run:

```text
MGD_STACK=test node scripts/catalog-pilot-m12c.mjs grant-reviewer --email <you>-review@example.test
```

It refuses any account that:
- is editor A;
- created any catalog record;
- has no handle;
- has no verified authenticator of its own.

Sign out and in again so the session carries the role. `revoke-reviewer` removes the role afterwards.

**4. Review three releases, one at a time.** These are the strongest independently checkable candidates. That editor A classed them as item-level evidence proves nothing: judge each one yourself against the source. If one doesn't hold up, leave it unpublished and pick another from **Admin → Catalog → Releases in review**.

| | Super Mario World, NTSC-J | Super Mario World, NTSC-U/C | Crash Bandicoot, NTSC-J |
| --- | --- | --- | --- |
| Admin record | [S1](http://127.0.0.1:3002/admin/catalog/releases/01a1f558-7030-7bf8-920e-4144e32320f7) | [S2](http://127.0.0.1:3002/admin/catalog/releases/01a1f558-704c-76d9-95bf-38419a28679f) | [P11](http://127.0.0.1:3002/admin/catalog/releases/01a1f558-7114-7097-9eb6-c4c4a0c3cb25) |
| Game record | [Super Mario World](http://127.0.0.1:3002/admin/catalog/games/24f7b33f-a991-46bf-aa4a-ec374fe9c75b), Wikidata [Q853143](https://www.wikidata.org/wiki/Q853143), first released 1990-11-21 | Same game | [Crash Bandicoot](http://127.0.0.1:3002/admin/catalog/games/d0ce5968-d1c3-4e88-af0e-d2aadb6264d0), Wikidata [Q719176](https://www.wikidata.org/wiki/Q719176), first released 1996-09-09 |
| Platform, format | SNES, Super Famicom / PAL SNES Cartridge | SNES, North American SNES Game Pak | PlayStation, CD-ROM, 1 disc |
| Region, edition | NTSC-J, Standard | NTSC-U/C, Standard | NTSC-J, Standard |
| Evidence | [SNES Central 0000](https://snescentral.com/article.php?id=0000), "Cartridge label information": Asia, Japan, `SHVC-MW`, "regular release", with a label scan | Same page: Americas, USA, `SNS-MW-USA`, "regular release", with a label scan | [PSXDataCenter SCPS-10031](https://psxdatacenter.com/games/J/C/SCPS-10031.html): "Crash Bandicoot", NTSC-J, serial SCPS-10031, released 6 December 1996, barcode 4948872100311 "From the back cover". The PlayStation the Best reprint has its own serial and page (SCPS-91057) |
| Shell | [Wikipedia, SNES](https://en.wikipedia.org/wiki/Super_Nintendo_Entertainment_System): non-North-American cartridges "are narrower with a smooth curve on the front" | Same page: "North American cartridges have a rectangular bottom with inset grooves" | Not applicable |
| Missing or uncertain | No release date (SNES Central gives manufacturing codes). Packaging `unknown`. The Japanese printed title isn't recorded. Publisher "Nintendo" is SNES Central's "Japan Publisher". Sold in: Japan | No release date. Packaging `unknown`. A second US label (`SNS-MW-USA-1`, two-line logo) is a separate candidate, S3 | No package code (the disc serial isn't assumed to be one). Packaging, publisher and languages aren't recorded. No markets |

**5. For each release, in the admin pages:**
1. **Inspect.** Open the release record. Under **Sources and locks**, the *Editor's evidence note* is editor A's free text: a pointer, not proof. Open the source page it names and check every field:
   - platform and format;
   - region;
   - edition and its type;
   - code or barcode;
   - disc or cartridge count;
   - packaging;
   - markets.

   Correct anything wrong with **Edit the release**, giving a reason. Any change ends an earlier verification of the record.
2. **Verify the release** in **Verification and publication**, with a reason naming what you checked (for example "Checked SNES Central 0000 label table: Japan, SHVC-MW, regular release"). The app asks for your authenticator if you last verified more than 10 minutes ago.
3. **Verify the game** from its game record (the first time only): the title, and the first release date against its Wikidata item.
4. **Publish the release.** This publishes the game and its platform pairing with it.
5. **If it doesn't hold up,** leave it in review and note why. Nothing is published by default.

**6. After you've published,** tell me, and I'll run the collector checks against what you published, never against what's still in review: `MGD_STACK=test node scripts/app-catalog-pilot-checks.mjs`. Until then they report nothing as passed.

**On 3002:**
- Editor A's record page shows the evidence note and "You created this record, so another editor verifies and publishes it". To editor B the same page offers verification.
- The B rows stay in review until their gap is closed.

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
- **`scripts/app-catalog-pilot-checks.mjs`:** the ten collector checks, run against whatever a human has published and against nothing still in review. With nothing published they stop and report nothing as passed. They also compare every other collection on the stack before and after.
- **Reviewer commands** in the runner (`reviewer-account`, `grant-reviewer`, `revoke-reviewer`), which the product owner runs. The password is typed at a hidden prompt. The role goes only to an account that isn't editor A, created no records, has a handle and has its own verified authenticator.
- **Two admin fixes:** a **Releases in review** link, and the release record's *Editor's evidence note* beside *Structured source evidence* (findings 2 and 3).
- **`scripts/lib/footprint.mjs`:** thirteen more suites (fast add, review, submission, collection, My Collection, merge, relink, exclusion, and the database review, search, submission, collection and relink checks) and the a11y suite end with a fingerprint of the tables they used, taken before they start and compared after. It replaces requiring those tables to be empty, so deliberate records on the stack are neither a failure nor at risk, and a suite that changed them would fail. On a clean stack it means empty, as before. The historical mutation runner is unchanged.
- **`scripts/db-import-checks.mjs`** now leaves records that were on the stack before it exactly as they were, and never deletes them. It restores each provider's clearance as it found it, and compares the stack's runs, source records and games before and after, instead of requiring an empty catalog. With the pilot staged it passes 45 of 45, and the pilot's releases, games, markets and clearance hash the same before and after.

**postgres** recorded the clearance, gave the disposable test editor its role (as the review checks do), and read. It wrote no catalog row.

## Findings for review (investigated 2026-11-19)

1. **Duplicates of unpublished staff candidates.**
   - **Collector side:** a collector searching a game that's only in review sees "No games found" and can submit it. Their submission stays private to them and editors.
   - **Already caught in review:** when an editor reviews that submission, **Possible duplicates** lists unpublished records too. `get_submission_review` matches any status but merged: similar game titles, and releases on the same game and platform or with the same code or barcode.
   - **Correction: no code.** Review practice: when a submission duplicates a staff candidate, publish the reviewed candidate first, then merge the collector's release into it (M7b-2c), which moves their copy with its history. Collectors never see staff candidates.
   - **M12c-B:** it should also check staff candidates before creating a discovery candidate.
2. **Finding staff-created candidates.**
   - The submission queue lists collectors' submissions only.
   - Catalog records already lists every release in review: the search accepts an empty query with a status filter (`/admin/catalog/search?kind=releases&status=under_review`), showing each row as verified or not.
   - **Correction (done):** a **Releases in review** link on the review queue page. No new queue or database change.
3. **"Evidence: None".**
   - That row shows `release_evidence`: structured, per-field evidence an import recorded. Editor-built releases have none, and MIG-5 isn't implemented.
   - **Correction (done):** the row is now **Structured source evidence** ("None from an import").
   - Next to it is a new **Editor's evidence note**: the creating editor's reason, from the audit history, labelled as their free text and "A note, not structured evidence: check it against the source before verifying".
   - No migration. The note is reviewer-facing only, and admin pages are staff-only.
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
