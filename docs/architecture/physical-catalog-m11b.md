# M11b-0: physical catalog sources and modeling — design document

**Written for:** the product owner and catalog editors deciding how real NES/Famicom, SNES/Super Famicom and PlayStation releases enter the catalog.

**Status: proposed, for decision. Nothing here is implemented.** M11b-0 is analysis and design only. No migration, import, clearance, catalog record or reference row was created, and the development catalog was not changed (it was read, read-only, on 2026-11-18). Every proposal below waits for the product owner's approval. Items marked **Legal** also need legal review. Artwork stays out of scope until D15 is resolved.

Related: [database-schema.md § Gaming catalog](database-schema.md#gaming-catalog), [relationships.md § Physical release examples](relationships.md#physical-release-examples), [security-rls.md § Catalog import](security-rls.md#catalog-import), [architecture-decisions.md § M5 decisions](architecture-decisions.md#m5-decisions-the-catalog-and-its-import), [ADR-031](architecture-decisions.md#adr-031-platform-identity-is-separate-from-its-names), [ADR-032](architecture-decisions.md#adr-032-physical-media-is-a-category-plus-a-reference-format), [reference-data-sources.md](reference-data-sources.md).

## Summary

- **Reuse the existing catalog.** Game, game–platform pairing, Release, release markets, components, field locks, provenance, the M5b importer, the review guard and the merge tooling already express almost everything. No parallel catalog is proposed.
- **Famicom and Super Famicom stay on the `nes` and `snes` platforms** (ADR-031). Their physical difference moves from "implied by platform and region" to an explicit **media format**: four new formats for the cartridge shells. The format is already enforced by foreign key, already an identity field for verification, and already a merge guard.
- **Five small migrations** would eventually be needed: the formats, the format in the published identity key, a packaging vocabulary, additional product codes per release, and a function for an editor to accept a held source record as evidence. None is written yet.
- **Sources:**
  - **Wikidata** (CC0) for game identity on all three platforms.
  - **No-Intro**, whose Data Usage License permits commercial reuse of data it can license, as evidence for NES and SNES cartridge releases. Manual saved downloads only, since its site bans bots.
  - **Redump** has a public-domain statement on one side of a split project, but no named licence, and restricted automated access. It stays **held**, rather than requiring written permission as the M5 decision said.
  - **Specialist reference sites** are cited by editors one fact at a time, never bulk-imported.
- **Pilot:** 8 games and 38 release candidates, of which 30 have confirmed evidence and 8 are held, within the ceiling of 30 games and 45 releases. Every candidate needs human review by someone other than its creator. The product owner approves the final selection before anything reaches the development demo.

## 1. Existing catalog architecture assessment

Read from the migrations as of `20261129100000`.

| Concept | Where | What it already does | Gap for physical collecting |
| --- | --- | --- | --- |
| Game identity | `games` (M5a) | One identity per game. Ports and re-releases share a Game; remakes and remasters are separate Games linked by `game_relations` (D6, ADR-026). Slug fixed on publication | None. Localized titles are aliases or release titles, not Games |
| Localized titles | `game_aliases` (M5c), `releases.local_title`, `private.game_title_keys` | Editor-confirmed aliases with language and region. Import titles stay private until an editor adds them. A release carries its title as printed | None |
| Game on a platform | `game_platforms` | The pairing a release requires (composite foreign key). Own status | None |
| Platform | `platforms`, `platform_names` | `nes` with names Family Computer and Famicom (`ntsc-j`). `snes` with Super Famicom (`ntsc-j`). `famicom-disk-system` as an add-on of `nes`. `playstation` with PS1 and PSX. Notes record that Famicom and NES carts aren't interchangeable (60 vs 72 pins) and that Super Famicom and North American SNES shells differ | **The difference is only a note.** ADR-031 makes them one platform, which is right for search, discussion and pairings, but no field records which shell a release has |
| Physical medium | `media_formats`, `platform_media_formats` | `rom-cartridge` ("Generic. The platform identifies the physical shape, which differs by system and region"), `famicom-disk-card`, `cd-rom`. A release's format must be listed for its platform (composite foreign key) | **Cartridge shape is implied, not recorded.** ADR-032 already allows a specific row "when collectors or manufacturers name that format", as for HuCard and Game Boy Game Pak |
| Physical release | `releases` | Region code, region-unknown confirmation, edition name and kind, variant, product code, barcode, local title, publisher, format, media count, playability, packaging, languages, rating labels, date with precision. Published identity is unique on `(game, platform, region, edition_name, variant_name, packaging, product_code)`, nulls not distinct. Publication needs edition, kind and media count. Serial and barcode are evidence, never identity | **Packaging is free text inside the identity key**, so "Jewel case" and "jewel case" are different identities. **One product code per release**, though a multi-disc PS1 game has a serial per disc. **The format isn't in the identity key** |
| Territory | `region_codes` (11 values, D7), `markets` (ISO 3166-1), `release_markets` | Region code is the collector classification; markets are known distribution. Independent by design (ADR-002) | None. PAL-A/PAL-B and country variants are separated by product code, variant and markets |
| Components | `release_components` | Inserts, maps, artwork and additional game media, per edition. Box, manual and primary medium are tracked per copy | None for the pilot. A bonus disc is `game_media` |
| Hardware needs | `hardware_requirements`, `release_hardware_requirements` | Revision, add-on and compatibility needs per release | None for the pilot |
| Owned copy | `collection_items`, `collection_item_components`, `collection_item_private` | One row per physical copy, linked to a published release (or the owner's own submission), with completeness, conditions and pieces | None. A copy points to the exact release, so a correct release model gives a correct copy |
| Provenance | `private.external_providers`, `import_runs`, `provider_records`, `external_references`, `release_evidence` | Providers carry terms URL, terms hash, review date and commercial clearance. Runs carry the snapshot hash. Every imported field of a release links to the source record that stated it | **No way for an editor to attach a held source record** to the release they create from it (section 6) |
| Field locks | `private.catalog_field_locks` | An editor's lock stops imports changing a field | None |
| Matching | M5b importer, `game_title_keys` | Tier A (own source id, or exactly one title match), B (several matches, or a main-title suggestion), C (no game). Titles normalized; serial matches are noted, never merged | **One release candidate per source entry.** Correct for a source that lists physical releases; wrong for one that lists ROM dumps (section 2) |
| Held and ignored entries | `HELD`, `IGNORED` and `FLAGS` in `scripts/catalog-import-sources.mjs`; `private.catalog_reclassifications` | Prototypes, pirate copies, hacks and digital releases are ignored. Unknown tags and later compilations are held for an editor | None |
| Importer authority | `catalog_importer` role (M5b) | Runs need a cleared provider against the exact terms hash. Can't verify or publish, invent an edition, packaging or media count, or merge on serials | None |
| Review | M7b-1 guard, M10c | Verification bound to the record's revision. **No self-review**: a record's creator can't verify or publish it. Recent MFA for verify, publish and published edits. Every change has a reason and an audit row | The pilot needs at least two staff people |
| Duplicates | Published identity key; M7b-2c merge | Merge only into a published release of the **same platform and media format**, through a token-checked preview. Copies move; the duplicate stays as history | Becomes stronger once the format records the shell |
| Admin | M10b–M10e | Catalog records, editing, history, review queue, import runs and reports | None for the design |

**Development catalog, read-only on 2026-11-18:**
- 19 games and 30 releases;
- 17 SNES releases on `rom-cartridge` (published, under review, unverified, merged and excluded) and 4 published PlayStation releases on `cd-rom`;
- no NES releases;
- no owned copies on these three platforms;
- 27 releases with no packaging, 2 "Jewel case", 1 "Big box";
- `wikidata` and `no-intro` not cleared, and no import runs.

**Importer readiness.** `WIKIDATA_PLATFORMS` maps only `snes` (Q183259). The No-Intro parser is SNES-tested. A platform with more than one format makes every release entry `needs_review` with "format unknown", because the importer never guesses the medium.

## 2. Source and licensing matrix

All pages were checked live on **2026-11-18** with a text-only fetch.
- **Downloaded:** nothing. No DAT, dump, database export, image or scan.
- **Not accepted:** DAT-o-MATIC's "I accept" gate, because accepting it would agree to terms on the product owner's behalf. No-Intro's record and download pages behind it were therefore not seen.
- **Evidence copies:** the decisive pages are saved outside the repository in `~/.my-game-dex/source-evidence/2026-11-18/`, hashed below. They show what was read. A clearance needs its own saved copy and hash at the time (`record_provider_clearance`).

| | Wikidata | No-Intro DAT-o-MATIC | Redump |
| --- | --- | --- | --- |
| **Official terms** | [Wikidata:Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing) (edited 2026-09-24); [Wikimedia Terms of Use](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use); [User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy); [Query Service manual](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual); [Data access](https://www.wikidata.org/wiki/Wikidata:Data_access) | [terms.html](https://datomatic.no-intro.org/terms.html): Terms, User-Uploaded Images Policy and Data Usage License, all dated 2026-09-11; [robots.txt](https://datomatic.no-intro.org/robots.txt) | **The project has split.** [redump.org](http://redump.org/) (HTTP only; HTTPS refused) shows only "© 2005–2026 Redump Team", and its wiki returns 404. [redump.info/about](https://redump.info/about), run by former staff, carries the only reuse statement. Which site speaks for the data is disputed |
| **Decisive wording** | "All structured data (i.e. the main, Property, Lexeme, and EntitySchema namespaces) is released into the public domain under Creative Commons Zero." | "may be freely used, copied, reproduced, modified, adapted, combined, published, distributed, and otherwise reused by anyone for any lawful purpose, to the extent that the website operator owns or controls the applicable rights"; "including projects that are sold or otherwise generate revenue"; "not required to credit this website" | redump.info: "Dumpers only submit metadata and Redump only stores metadata. This information is considered public domain to be used however people see fit". No named licence. redump.org states nothing |
| **Evidence snapshot (SHA-256)** | Not saved: CC0 is stable and stated on the licensing page. Save a copy at clearance | `no-intro-terms.html` `6999229f74e2921623c6e60b682e9971227eff0c7bc6b9244955c1006919aa2f`; `no-intro-robots.txt` `347b47a2…6130c9` | `redump-info-about.html` `0e726523bb6f4102663a70a5c620090897aaf7eb7e4caa7ec234e3fa7d2e1626`; `redump-info-robots.txt` `83e9fd54…c6445`; `redump-org-home.html` `050fd555…c89c2a`; `redump-org-robots.txt` `b1282f72…02558fcf` |
| **Commercial metadata reuse** | **Yes** (CC0) | **Yes**, for data the operator owns or is authorized to license | **Unclear, leaning permissive.** An informal public-domain statement from one side of a split project |
| **Automated retrieval** | **Yes**, within limits:<br>- a policy-compliant User-Agent (`name/version (contact) library/version`);<br>- 60 s query deadline and 60 s of processing per minute per client;<br>- 5 parallel queries per IP and 30 error queries per minute;<br>- back off on 429.<br>Large results should use dumps. The Terms of Use forbid "undue burden on an API" | **Unclear.** Every visit passes a click-through gate. Bots are detected and banned automatically (3 days per IP, 90 days per range). robots.txt allows everything with `Crawl-delay: 5`. Download limits or login aren't stated in the terms and weren't checked | **Restricted on redump.info.** robots.txt disallows `/datfile/`, `/downloads/database`, `/api/`, `/list/` and more. Self-identified bots get a 403 on those paths. The full database export needs a login. redump.org allows everything and states no limits. Neither documents an API |
| **Local retention** | Yes | Yes by implication ("copied, reproduced… distributed"). A later licence change "does not retroactively revoke permissions already granted" | Not addressed |
| **Importable fields** | Game identity and titles: label, aliases, Japanese label, romanization (P2125), other-language labels, first publication date (P577), platform (P400). Publisher (P123), developer (P178) and genre (P136) are available but not used today. Release-level properties (P437 distribution format, P528 catalog code, P3962 GTIN) are sparse | Release-level evidence per ROM entry: title, region and language tags, serial where stated, flags (unlicensed, re-release publisher, Nintendo Power). Never ROM hashes or files. Secondary sources say records also hold box serial, barcode and PCB serial, **not confirmed** | Per disc: title, region, languages, disc serial, edition, version and barcode (only on some systems; none seen on PS1). Never hashes, ring codes, dumper names or images |
| **Accuracy and completeness** | Community-edited. Coverage of individual regional releases is sparse, and some items merge or split games inconsistently | ROM-centred: one entry can stand for several physical packages, and "(Europe)" spans country variants. No warranty | Strong disc-level verification for dumped discs only. Packaging and reprint lines aren't its focus |
| **Third-party exclusions** | Commons media are licensed separately (Terms §7.4). External-id properties point to non-CC0 sites | User-uploaded images are explicitly not licensed. Trademarks, copyright, **database rights** and other third-party rights are the user's responsibility | "All brands, names, images, etc. are copyrighted by their respective owners." Images are "for documentation purposes only" |
| **Uncertainty for legal review** | Contributors may have added data they had no right to. EU database right in imported material | How much of the contributed data the operator "owns or controls". Whether accepting the gate adds contract terms. Database rights | Who can license the data after the split. Whether "considered public domain" is an effective waiver from contributors. Database rights. Whether redump.org's wiki ever stated terms |
| **Proposed status** | **Clear** (M11b-D1) | **Clear for metadata only, after a person accepts the gate and confirms what an NES and SNES record holds.** Manual, saved downloads only: no automated retrieval (M11b-D2) | **Held** (M11b-D3). The M5 rule "blocked until written commercial permission" is replaced by "held until one party's terms and access rules are confirmed and legal review accepts the public-domain statement". No automated access to disallowed paths, and no logged-in export |

**Specialist reference sites** are consulted by editors as evidence, one cited fact at a time, and never scraped or bulk-imported:
- [NesCartDB](https://nescartdb.com/) (its search page refuses automated access, HTTP 403);
- [SNES Central](https://snescentral.com/);
- [PSXDataCenter](https://psxdatacenter.com/);
- [MarioWiki](https://www.mariowiki.com/);
- Wikipedia.

Their own terms weren't reviewed for bulk reuse.

**Nothing in this matrix grants artwork rights.** No covers, logos, screenshots, box scans or label images are read from any source (D15).

## 3. Recommended source per metadata field

| Field | Primary source | Supporting evidence | Never from |
| --- | --- | --- | --- |
| Game identity (`games`), title, sort title | Wikidata item, confirmed by an editor | Wikipedia | No-Intro names (they match, they don't create Games) |
| Game aliases, romanizations, Japanese titles | Wikidata labels, aliases and P2125, added by an editor | Release `local_title` as printed | |
| `first_release_date` | Wikidata P577, at its stated precision | A cited source when Wikidata lacks it | Inference from a release |
| `game_platforms` | Created with the first release candidate | | Wikidata P400 alone (a listed platform doesn't prove a physical release) |
| Platform and media format | **Editor, from the item or a cited specialist page** | No-Intro DAT (which platform's DAT), Redump system | The region tag (section 4) |
| `region_code` | Editor, from the package or a source that states the release's region | No-Intro region tag when it names one region | Product-code prefix alone, a multi-country tag, markets |
| `release_markets` | A source that states distribution | Product-code country suffix, cited | PAL or NTSC labels |
| `product_code` | As printed on the package (editor), or a specialist page for that item | No-Intro `serial` where stated | A pattern or another release's code |
| Disc serials (`release_codes`, MIG-4) | Specialist page for that disc (PSXDataCenter; Redump if cleared) | | |
| `barcode` | Item or specialist page | No-Intro box barcode if confirmed and cleared | |
| `edition_kind`, `edition_name`, `variant_name` | **Editor only** | Specialist page | Any import (M5 decision 2) |
| `packaging` | **Editor only** | Specialist page | Any import |
| `media_count` | Editor, from the item or a specialist page listing each disc | Redump disc list, if cleared | Any import |
| `languages` | No-Intro language tags (they describe the ROM), confirmed by an editor against the package | Specialist page | |
| `publisher_name`, `local_title` | As printed (editor) | Specialist page | |
| `release_date` | A source that states that release's date | Wikipedia for the original release | Wikidata P577 (game-level), manufacturing codes |
| `release_components` | Editor | Specialist page | |
| Images of any kind | **None** until D15 | | Every source |

## 4. NES/Famicom and SNES/Super Famicom modeling decision

### Options considered

| Option | Verdict |
| --- | --- |
| **A. Separate top-level platforms** (`famicom`, `super-famicom`) | **Rejected.** It splits one game's pairings, search, discussion and the platform filter. The `releases → game_platforms` and `platform_media_formats` keys, the importer's one-platform runs, `famicom-disk-system`'s `base_platform_id`, the platform pages and ADR-031 would all change. It also doesn't solve the PAL versus North American SNES shell, which is within one platform either way |
| **B. Region code implies the shell** (today) | **Rejected.** Shell and region don't map one-to-one: Asian and Hong Kong releases exist in both forms, Canadian, Brazilian and Korean releases have their own conventions, and region describes classification, not hardware. It also lets a merge join a Famicom cartridge to an NES one |
| **C. A release attribute** (new `cartridge_shell` column) | **Rejected.** It duplicates what `media_format_code` already means, without the foreign key and merge guard |
| **D. Specific media formats per shell, one platform** | **Recommended.** ADR-032 already provides for it. The format is a foreign key to the platform's valid formats, is a verification identity field (`release_identity_fields()`), and is a merge guard (M7b-2c) |

### Recommendation (D)

| Format code | Category | Name | Platform | Physical facts it records |
| --- | --- | --- | --- | --- |
| `famicom-cartridge` | cartridge | Famicom cartridge | `nes` | 60-pin, no lockout chip in the Japanese console |
| `nes-game-pak` | cartridge | NES Game Pak | `nes` | 72-pin front-loader cartridge with the 10NES lockout chip. NTSC and PAL share the shell; the lockout region is a release fact (region code, product code suffix, markets) |
| `super-famicom-cartridge` | cartridge | Super Famicom and PAL SNES cartridge | `snes` | Narrow shell with a curved front and no grooves, as used in Japan and PAL territories. The CIC region lock is a release fact |
| `snes-game-pak-na` | cartridge | North American SNES Game Pak | `snes` | Rectangular bottom with inset grooves matching the North American console's tabs |
| `famicom-disk-card` (exists) | magnetic disk | Famicom Disk Card | `famicom-disk-system` | Unchanged |
| `cd-rom` (exists) | optical disc | CD-ROM | `playstation` | Unchanged. PlayStation needs no specific format for the pilot |

Evidence for the shells: [NESdev cartridge connector](https://www.nesdev.org/wiki/Cartridge_connector) (60- and 72-pin pinouts), [Wikipedia, NES](https://en.wikipedia.org/wiki/Nintendo_Entertainment_System) ("The Famicom as released in Japan contains no lock-out hardware"), [Wikipedia, SNES](https://en.wikipedia.org/wiki/Super_Nintendo_Entertainment_System) ("North American cartridges have a rectangular bottom with inset grooves matching protruding tabs in the console"). Checked 2026-11-18. Exact names are open for the product owner: the codes, once used, are permanent.

**What stays as it is:**
- `nes` and `snes` remain one platform each, with Famicom and Super Famicom as regional names.
- `rom-cartridge` stays linked to `nes` and `snes`, as "shell not recorded", because existing releases use it and the foreign key restricts removing it.
  - New pilot releases use a specific format.
  - Existing development releases are reclassified by an editor, through `update_release` with a reason. That re-verification is a separate, approved step.

**How each required property is preserved:**

| Property | Where it lives |
| --- | --- |
| Logical console family | `platforms` (`nes`, `snes`, `playstation`), with `famicom-disk-system` as the `nes` add-on |
| Physical cartridge or disc format | `releases.media_format_code` (the four shells, `famicom-disk-card`, `cd-rom`) |
| Market and territory | `release_markets` (ISO countries), independent of region |
| Collector region classification | `releases.region_code` |
| Video standard | **Not a new column.** For these three platforms the approved region codes already carry it (`ntsc-uc`, `ntsc-j`, `pal`, `pal-m`). Add a column only if a pilot record shows a distinction they can't express (decision M11b-D6) |
| Packaging | `releases.packaging`, from a controlled vocabulary (section 6) |
| Edition or reprint | `edition_kind` (`standard`, `reprint` and the rest) and `edition_name` ("Players' Choice", "Greatest Hits", "Platinum", "PlayStation the Best", "Classic Series") |
| Print or label variant | `variant_name` ("Gold cartridge", "Two-line logo label", "German packaging") |
| Product code and barcode | `releases.product_code` (as printed on the package), additional codes in a new child table (section 6), `releases.barcode` |
| Release-specific components | `release_components` |
| The collector's owned copy | `collection_items` on the exact release, with per-copy completeness, conditions and pieces |

**PAL is not a territory.** A PAL release's countries are its `release_markets`, and country packages (UKV, NOE, FAH, FRA, ESP, AUS) are separate releases only when the physical product differs, as in [relationships.md](relationships.md#physical-release-examples). A region label alone never creates a release.

## 5. NES, SNES and PlayStation reference-data plan

### NES / Famicom

- **Cartridge forms:**
  - Famicom cartridge (60-pin), on `nes`;
  - NES Game Pak (72-pin), on `nes`;
  - Famicom Disk Card, on `famicom-disk-system`.
- **Shell differences that are not separate releases.** NES 5-screw versus 3-screw shells and board revisions (for example NES-SNROM-02 and -05) are manufacturing sub-variants. They are not releases unless an editor confirms a distinct package (M5 identity decision).
- **Western variants:**
  - North American `NES-xx-USA` and Canadian `NES-xx-CAN` codes;
  - PAL-A (UK, Italy, Australia) and PAL-B (mainland Europe) lockouts;
  - country codes such as `-UKV`, `-EEC`, `-NOE`, `-FRA` and `-AUS`.
  - All are recorded as the printed product code plus markets, region `ntsc-uc` or `pal`.
- **Japanese variants.** `HVC-xx` Famicom cartridges and `FMC-xxx` disk cards. A game can exist in Japan on both media, such as The Legend of Zelda (disk 1986, cartridge 1994): those are separate releases on different platforms and formats.
- **Packaging and manuals:**
  - NES cardboard boxes, with and without a plastic tray or dust sleeve;
  - smaller Famicom boxes;
  - disk cards in a plastic case or sleeve.
  - Manual differences (language, booklet versus fold-out) are recorded per copy through components, and on the release only when they distinguish a package.

### SNES / Super Famicom

- **Regional cartridge shells:**
  - Super Famicom and PAL shell (`super-famicom-cartridge`);
  - North American shell (`snes-game-pak-na`).
- **Codes:**
  - `SHVC-xx` for Japan;
  - `SNS-xx-USA` and `SNS-xx-CAN` for North America;
  - `SNSP-xx-<country>` for PAL, such as UKV, NOE, FAH, FRA, ESP and AUS.
  - Some PAL carts carry two codes, such as `SNSP-ZL-NOE/SFRG`.
- **Reprints and variants:**
  - Players' Choice reprints share the base code with a suffix (`SNS-ZL-USA-1`, `-2`);
  - a suffix can also mark a label revision (`SNS-MW-USA-1`, two-line logo).
  - **A suffix never implies a reprint line**: the edition comes from the package.
- **Packaging.** Cardboard boxes in each region, sometimes with a cardboard or plastic insert, which is a component. PAL boxes differ by country in rating labels and languages.

### PlayStation

- **Media.** CD-ROM (`cd-rom`), with `media_count` for multi-disc sets. Disc count is the number of game discs. A bonus disc packaged with a reprint is a `game_media` component, if confirmed.
- **Serials:**
  - `SCUS`/`SLUS` (North America, first-party and third-party);
  - `SCES`/`SLES` (PAL);
  - `SCPS`/`SLPS`/`SLPM` (Japan).
  - **Each disc of a set has its own serial.** US sets run sequentially (SCUS-94163, 94164, 94165). PAL sets step the leading digit (SCES-00867, 10867, 20867).
  - **A prefix doesn't prove region, publisher or edition** (section 7).
- **Reprints:**
  - **North American Greatest Hits and PAL Platinum** generally keep the original serial, and differ by packaging and label.
  - **Japanese PlayStation the Best and PSone Books** get new serials (`SCPS-91xxx`, `SLPS-91xxx`).
  - All are `edition_kind = 'reprint'` with the line's name as `edition_name`.
- **Packaging:**
  - standard jewel case;
  - double-width or multi-disc jewel case;
  - Japanese cases with a spine card.
  - Exact vocabulary is decided with section 6. The pilot records only what the evidence states.

## 6. Required reference-data changes and eventual migrations

**Reference data (one forward migration, M11b-1):**

1. The four `media_formats` rows and their `platform_media_formats` links (section 4).
2. A packaging vocabulary, below.
3. No new region codes or markets. No new platforms.

**Eventual migrations.** These are proposals, not written. All are forward-only, with no `DROP ... CASCADE` and no change to Supabase-managed schemas.

| # | Migration | Why | Risk |
| --- | --- | --- | --- |
| MIG-1 | **Cartridge-shell formats.** Insert four `media_formats` rows and four `platform_media_formats` rows | Section 4 | None to existing rows. The importer holds `nes`/`snes` release entries as "format unknown" from then on, which is the intended behavior: an editor chooses the shell |
| MIG-2 | **Format in the published identity.** Replace `releases_published_identity_key` and `releases_pending_submission_key` with the same columns plus `media_format_code` (create the new index, then drop the old one by name) | A Famicom and an NES cartridge with otherwise equal fields are different products | Adding a column only relaxes uniqueness, so no existing row can fail. The merge guard already compares formats |
| MIG-3 | **Packaging vocabulary.** A read-only reference table `packaging_types (code, name, position)` and a foreign key from `releases.packaging`. Added `not valid`, validated after editors map the three existing values | Packaging is part of the identity key, and free text defeats it | Existing values must be mapped first. Alternative: an editorial list without a key (decision M11b-D5) |
| MIG-4 | **Additional product codes.** `release_codes (release_id, code, kind, position)`, with `kind` one of `media` (one per disc) and `alias` (a second printed code, such as `SNSP-ZL-NOE/SFRG`). Same visibility as `release_markets`; written only by editor functions with a reason and audit; `release_evidence` gains `release_codes` | Multi-disc serials, and matching a disc-level source to its release | Not part of the identity key: the package code stays `product_code`. Editor functions and `get_release_record` gain one field |
| MIG-5 | **Accept a held source record.** `accept_import_record(record, release, fields, reason)` for catalog editors with recent MFA: links a `needs_review` provider record to an existing unpublished release, writes the external reference and evidence for the fields the record states, and is audited. It never verifies or publishes, and it refuses a record already linked elsewhere | Today a held record can't support an editor-created release, so editor work would lose its provenance | Must keep the review guard: a release created by the same editor still can't be verified by them |

**Importer code (M11b-1, no migration):**
- add `nes`, `famicom-disk-system` and `playstation` to `WIKIDATA_PLATFORMS`, after confirming their item ids;
- test the No-Intro parser against an NES snapshot.

## 7. Physical-release identity and duplicate-prevention rules

### Game identity versus localized title

- A Game is one game across ports and regions (D6). A different title in a market is a `game_aliases` row or `releases.local_title`, never a new Game.
- **Same name, different game.** US "Super Mario Bros. 2" and Japanese "Super Mario Bros. 2" are different games. US SNES "Final Fantasy III" is the game known as Final Fantasy VI. Identity follows the game's content, not the printed title: such a release has `local_title` set and belongs to the correct Game.
- Wikidata items propose identities. An editor confirms them, and a missing Wikidata item doesn't block a Game (M5 decision).

### Release identity and uniqueness

A Release is one distinguishable manufactured product. After MIG-2, its published identity is game, platform, media format, region code, edition name, variant, packaging and product code.

- Different shell, region classification, edition, packaging or printed product code: separate releases.
- Same package sold in several countries: one release with several markets.
- A difference the key doesn't cover, such as a rating label or language: the reviewer must give each a distinct `variant_name`.
- ROM revisions, board revisions and screw counts are not releases unless the package differs and an editor confirms it.

### Region and edition matching

- `region_code` is set only from the package, or from a source that states the release's region. Never from a product-code prefix alone, a No-Intro region tag covering several countries, or the market.
- `edition_kind` and `edition_name` are never imported or defaulted (M5 decision 2). The editor sets them from the package or a cited source.

### Multiple product codes or aliases

- `product_code` is the package code as printed, in the form printed. Store the source's form only when the item isn't available, and say so in the reason.
- Disc serials and second codes go in `release_codes` (MIG-4).
- Matching codes are evidence, never identity: Greatest Hits and Platinum share serials with their originals.

### Unknown versus verified metadata

- Null or `unknown` means not known. Nothing is filled from inference.
- A date that sources disagree on keeps the precision they agree on. For example, NES Zelda: "July 1987" versus August 22, 1987 becomes 1987, year precision, with the conflict in the reason.
- Release dates are recorded only from a source that states a release date. SNES Central's "Man. Dates" are manufacturing codes.

### Duplicate candidates

Before verifying, the editor checks:
- the release picker for the game and platform;
- `search_catalog_records` by product code and title;
- the importer's `serial_also_on` notes.

A duplicate of a published release is merged through M7b-2c, which already requires the same platform and format. A duplicate of an unpublished candidate is rejected with a reason naming the kept record.

### Conflicting source information

- **Precedence:**
  1. the physical item, as an editor observed it;
  2. the publisher's printed material or official documentation;
  3. a specialist database that documents the specific item (NesCartDB, SNES Central, PSXDataCenter, Redump where cleared);
  4. Wikidata;
  5. No-Intro naming tags.
- A conflict is never resolved automatically. The editor records the chosen value, and the reason cites both sources. Evidence rows for both stay.
- An unresolved conflict on an identity field keeps the candidate in review.

### Provenance and snapshot hashes

- Every import run records the snapshot's SHA-256 and fetch time, and the provider's terms hash (M5b).
- Snapshots and saved terms stay outside the repository, with their hashes in the run and in this document's evidence table.
- An editor's value has an audit row with its reason, citing a URL and check date.

### Corrections

Through the existing admin workflow:
- `update_release` and `update_game` with a reason;
- field locks against later imports;
- exclusion for a non-qualifying release, with copies preserved;
- merge for duplicates.

Verification ends with any identity change (M10c).

## 8. Proposed pilot titles and physical releases

**Within the ceilings:**

| Platform group | Games | Releases (confirmed / held) | Ceiling |
| --- | --- | --- | --- |
| NES / Famicom | 2 | 10 (5 / 5) | 10 games, 15 releases |
| SNES / Super Famicom | 3 | 15 (14 / 1) | 10 games, 15 releases |
| PlayStation | 3 | 13 (11 / 2) | 10 games, 15 releases |
| **Total** | **8** | **38 (30 / 8)** | 30 games, 45 releases |

These are proposals for the product owner's approval.
- **Confirmed** means each identifying fact was read on a page fetched on 2026-11-18, cited below. It is still a candidate until an editor verifies it.
- **Held** means a fact is missing or conflicting. It enters the pilot only as a held entry for an editor, and is published only once the gap is closed.

### NES / Famicom

**What it exercises:**
- the same game as a Famicom cartridge, an NES Game Pak and a disk card;
- a PAL country release;
- the gold cartridge;
- a Classic Series reprint.

| # | Game | Platform, format | Region, market | Product code | Edition, variant | Media | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | Super Mario Bros. | `nes`, `famicom-cartridge` | `ntsc-j`, JP | HVC-SM | Standard | 1 | Confirmed (date 1985-09-13) | [MarioWiki](https://www.mariowiki.com/Super_Mario_Bros.), [Wikipedia](https://en.wikipedia.org/wiki/Super_Mario_Bros.) |
| N2 | Super Mario Bros. | `famicom-disk-system`, `famicom-disk-card` | `ntsc-j`, JP | FMC-SMA | Re-release on disk | 1 | Confirmed (1986-02-21) | MarioWiki, Wikipedia |
| N3 | Super Mario Bros. | `nes`, `nes-game-pak` | `ntsc-uc`, US | NES-SM-USA | Standard | 1 | Confirmed. Date "debated" per Wikipedia, so year only | [NesCartDB 270](https://nescartdb.com/profile/view/270) |
| N4 | Super Mario Bros. | `nes`, `nes-game-pak` | `pal`, Europe | NES-SM-EEC or NES-P-SM | Standard | 1 | **Held**: sources disagree on the printed code | MarioWiki; VGCollect snippet only |
| N5 | Super Mario Bros. | `nes`, `nes-game-pak` | `pal`, AU | NES-SM-AUS | Standard | 1 | Confirmed (July 1987) | MarioWiki |
| N6 | The Legend of Zelda | `famicom-disk-system`, `famicom-disk-card` | `ntsc-j`, JP | FMC-ZEL | Standard | 1 | **Held**: code seen only in a search snippet (date 1986-02-21 confirmed) | [Wikipedia](https://en.wikipedia.org/wiki/The_Legend_of_Zelda_(video_game)) |
| N7 | The Legend of Zelda | `nes`, `nes-game-pak` | `ntsc-uc`, US | NES-ZL-USA | Standard, "Gold cartridge" | 1 | Confirmed. Date conflict (July versus August 22, 1987), so 1987 | [NesCartDB 490](https://nescartdb.com/profile/view/490), Wikipedia |
| N8 | The Legend of Zelda | `nes`, `nes-game-pak` | `ntsc-uc`, US | not confirmed | Reprint, "Classic Series", grey cartridge | 1 | **Held**: code not confirmed (1992 and grey cartridge confirmed) | Wikipedia |
| N9 | The Legend of Zelda | `nes`, `nes-game-pak` | `pal` | not confirmed | Standard | 1 | **Held**: code and country package not confirmed | Wikipedia |
| N10 | The Legend of Zelda | `nes`, `famicom-cartridge` | `ntsc-j`, JP | not confirmed | Cartridge re-release (1994) | 1 | **Held**: code not confirmed | Wikipedia |

### SNES / Super Famicom

**What it exercises:**
- both shells;
- PAL country packages;
- Players' Choice reprints with two ratings;
- a label revision that is not a reprint.

| # | Game | Format | Region, market | Product code | Edition, variant | Media | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Super Mario World | `super-famicom-cartridge` | `ntsc-j`, JP | SHVC-MW | Standard | 1 | Confirmed | [SNES Central 0000](https://snescentral.com/article.php?id=0000) |
| S2 | Super Mario World | `snes-game-pak-na` | `ntsc-uc`, US | SNS-MW-USA | Standard | 1 | Confirmed | SNES Central |
| S3 | Super Mario World | `snes-game-pak-na` | `ntsc-uc`, US | SNS-MW-USA-1 | Standard, "Two-line logo label" | 1 | Confirmed | SNES Central |
| S4 | Super Mario World | `super-famicom-cartridge` | `pal`, DE | SNSP-MW-NOE | Standard, "German packaging" | 1 | Confirmed | SNES Central |
| S5 | Super Mario World | `super-famicom-cartridge` | `pal`, GB | printed "SNS-MW-UKV" on the source | Standard | 1 | **Held**: the missing "P" may be a source error; check an item | SNES Central |
| S6 | Super Mario World | `super-famicom-cartridge` | `pal`, FR, NL | SNSP-MW-FAH-1 | Standard | 1 | Confirmed | SNES Central |
| S7 | The Legend of Zelda: A Link to the Past | `super-famicom-cartridge` | `ntsc-j`, JP | SHVC-ZL | Standard | 1 | Confirmed | [SNES Central 0164](https://snescentral.com/article.php?id=0164) |
| S8 | A Link to the Past | `snes-game-pak-na` | `ntsc-uc`, US | SNS-ZL-USA | Standard | 1 | Confirmed | SNES Central |
| S9 | A Link to the Past | `snes-game-pak-na` | `ntsc-uc`, US | SNS-ZL-USA-1 | Reprint, "Players' Choice", "K-A rating" | 1 | Confirmed | SNES Central |
| S10 | A Link to the Past | `snes-game-pak-na` | `ntsc-uc`, US | SNS-ZL-USA-2 | Reprint, "Players' Choice", "E rating" | 1 | Confirmed | SNES Central |
| S11 | A Link to the Past | `super-famicom-cartridge` | `pal`, GB | SNSP-ZL-UKV | Standard | 1 | Confirmed | SNES Central |
| S12 | A Link to the Past | `super-famicom-cartridge` | `pal`, DE | SNSP-ZL-NOE, alias SFRG | Standard, "German packaging" | 1 | Confirmed | SNES Central |
| S13 | Super Metroid | `snes-game-pak-na` | `ntsc-uc`, US | SNS-RI-USA | Standard | 1 | Confirmed | [SNES Central 0885](https://snescentral.com/article.php?id=0885) |
| S14 | Super Metroid | `super-famicom-cartridge` | `pal`, FR, NL | SNSP-RI-FAH | Standard | 1 | Confirmed | SNES Central |
| S15 | Super Metroid | `super-famicom-cartridge` | `pal`, GB | SNSP-RI-UKV | Standard | 1 | Confirmed | SNES Central |

**SNES dates.** All SNES release dates are unconfirmed: SNES Central gives none. They stay unknown until a source that states the date is cited. The Japanese Super Metroid code wasn't found on SNES Central, so that release isn't proposed.

### PlayStation

**What it exercises:**
- multi-disc sets;
- the per-language PAL releases of one game;
- Greatest Hits and Platinum reprints that share a serial;
- a Japanese reprint with its own serial;
- a third-party SLUS title.

| # | Game | Region, market | Product code (box), disc serials | Edition | Media | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Final Fantasy VII | `ntsc-j`, JP | SLPS-00700; discs 00700–00702 | Standard | 3 | Confirmed (1997-01-31) | [PSXDataCenter SLPS-00700](https://psxdatacenter.com/games/J/F/SLPS-00700.html) |
| P2 | Final Fantasy VII | `ntsc-uc`, US | SCUS-94163; discs 94163–94165 | Standard, "Black label" | 3 | Confirmed (1997-08-15) | [PSXDataCenter SCUS-94163](https://psxdatacenter.com/games/U/F/SCUS-94163.html) |
| P3 | Final Fantasy VII | `ntsc-uc`, US | SCUS-94163 (shared) | Reprint, "Greatest Hits" | 3 | Confirmed as a package; date unknown | Same page |
| P4 | Final Fantasy VII | `pal`, English | SCES-00867; discs 00867, 10867, 20867 | Standard | 3 | Confirmed (1997-11-14) | [PSXDataCenter SCES-00867](https://psxdatacenter.com/games/P/F/SCES-00867.html) |
| P5 | Final Fantasy VII | `pal`, French | SCES-00868; 10868, 20868 | Standard, "French packaging" | 3 | Confirmed | Same, and [PAL list](https://psxdatacenter.com/plist.html) |
| P6 | Final Fantasy VII | `pal`, German | SCES-00869; 10869, 20869 | Standard, "German packaging" | 3 | Confirmed | Same |
| P7 | Final Fantasy VII | `pal`, Spanish | SCES-00900; 10900, 20900 | Standard, "Spanish packaging" | 3 | Confirmed | Same |
| P8 | Final Fantasy VII | `pal`, English | SCES-00867 (shared) | Reprint, "Platinum" | 3 | **Held**: a bonus disc (implied SCED-20062) isn't confirmed | Same |
| P9 | Crash Bandicoot | `ntsc-uc`, US | SCUS-94900 | Standard, "Black label" | 1 | Confirmed (1996-09-09) | [PSXDataCenter SCUS-94900](https://psxdatacenter.com/games/U/C/SCUS-94900.html) |
| P10 | Crash Bandicoot | `pal` | SCES-00344 | Standard | 1 | Confirmed (1996-11-15) | [PSXDataCenter SCES-00344](https://psxdatacenter.com/games/P/C/SCES-00344.html) |
| P11 | Crash Bandicoot | `ntsc-j`, JP | SCPS-10031 | Standard | 1 | Confirmed (1996-12-06) | [PSXDataCenter SCPS-10031](https://psxdatacenter.com/games/J/C/SCPS-10031.html) |
| P12 | Crash Bandicoot | `ntsc-j`, JP | SCPS-91057 | Reprint, "PlayStation the Best for Family" | 1 | Confirmed (1998-05-28) | [PSXDataCenter SCPS-91057](https://psxdatacenter.com/games/J/C/SCPS-91057.html) |
| P13 | Metal Gear Solid | `ntsc-uc`, US | SLUS-00594; discs SLUS-00594, 00776 | Standard | 2 | **Held** for packaging: the 2-disc case type isn't stated (serials and 1998-10-21 confirmed) | [PSXDataCenter SLUS-00594](https://psxdatacenter.com/games/U/M/SLUS-00594.html) |

**Left out on purpose:**
- Final Fantasy VII's second Japanese serial set (SCPS-45007–9), which is unexplained;
- Final Fantasy VII International, whose Ultimate Hits serials conflict within one source;
- Crash Bandicoot's US Greatest Hits, which is not proposed separately until its package is described.

**Markets.** For the PAL rows, markets are recorded only where a source states them.

**Wikidata ids.** No Wikidata item id is claimed here. They are found and checked when games are imported in M11b-2.

## 9. Import, review and publication workflow

1. **Test stack first.** Every step runs on the isolated test stack before anything touches development.
2. **Clear sources.** An operator records clearance with `record_provider_clearance` (code, terms URL, saved-terms hash, reviewer and basis), after the product owner accepts the source matrix. A source that isn't cleared can't run.
3. **Snapshot.** Fetch a Wikidata SPARQL result per platform, and the No-Intro DATs for NES and SNES if cleared. Save the files and their hashes outside the repository. Nothing else is downloaded: no ROMs, images or scans.
4. **Select.** Instead of a seeded random slice, use a fixed `--ids` list made from the approved pilot table, so only those games and entries are staged.
5. **Import.** `catalog_importer` creates game candidates (Wikidata), and stages release entries.
   - Entries for `nes` and `snes` are held as "format unknown", because those platforms have several formats.
   - Nothing is verified or published.
6. **Editor A builds the candidates.** From the held entries and the evidence table, editor A:
   - creates or completes each release (format, region, edition, variant, packaging, product code, markets, components) with a reason citing the evidence;
   - accepts the source record as evidence (MIG-5);
   - locks the fields they set.
7. **Editor B reviews.** A different staff member, with recent MFA, checks each candidate against its evidence and the duplicate checks in section 7. Editor B then verifies and publishes it, or rejects it with a reason. The review guard refuses self-review.
8. **Report.** The run report, the evidence table and the review outcomes go to the product owner.
9. **Development demo.** Only after the product owner approves the result: the same reviewed steps run against development, behind a backup and restore check, preserving the demo. No bulk import, and nothing beyond the approved list.

## 10. Risk register and unresolved decisions

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A source's terms change or are misread | Data reused without permission | Clearance bound to a terms hash, rechecked each run. **Legal** review before any commercial launch |
| EU database right in specialist sites (NesCartDB, SNES Central, PSXDataCenter) | Systematic extraction could infringe | Editors cite individual facts with a URL. No scraping, no bulk import. **Legal** |
| No-Intro entries treated as physical releases | One ROM merges several packages, or invents country variants | Held entries, an editor chooses format and edition, MIG-5 accept function, no automatic release per entry for `nes`/`snes` |
| Product-code traps (shared reprint serials, suffix meanings, combined codes, source typos) | Wrong releases or false merges | Codes are evidence only. Printed form wins. Conflicts held |
| Wrong serial in an automated summary | Wrong release identity | Verify every serial on its own detail page (a summary paired Crash Bandicoot with the Crash 2 serial) |
| Date conflicts | False precision | Keep only the agreed precision |
| Artwork or labels reach the catalog through a source | D15 breach | No image fields are read. No covers, logos, screenshots, scans or label images |
| Only one staff member available | Self-review impossible | Two disposable editors on the test stack. Decide who reviews on development |
| Reclassifying existing SNES releases | Re-verification work, possible conflicts in the new identity key | Separate approved step. MIG-2 only relaxes uniqueness |

### Decisions needed

| # | Decision | Recommendation |
| --- | --- | --- |
| M11b-D1 | Accept the source matrix and clear Wikidata | Clear Wikidata |
| M11b-D2 | No-Intro clearance for NES and SNES evidence | Clear for metadata only, with manual saved downloads, after someone accepts the gate and confirms the record fields (section 2) |
| M11b-D3 | Redump | Held until one party's terms and access rules are confirmed and legal review accepts the public-domain statement (section 2) |
| M11b-D4 | Cartridge shells as media formats, with the four codes and names | Approve option D |
| M11b-D5 | Packaging: a reference table (MIG-3) or an editorial list | Reference table |
| M11b-D6 | Video standard column | Not now |
| M11b-D7 | Additional product codes (MIG-4) | Approve |
| M11b-D8 | Accept-held-record function (MIG-5) | Approve |
| M11b-D9 | Format in the identity key (MIG-2) | Approve |
| M11b-D10 | The pilot list in section 8, including held entries | Product owner's choice |
| M11b-D11 | Who reviews on development, given no self-review | Product owner's choice. No permanent Owner account is created for it |
| M11b-D12 | Whether existing development SNES releases are reclassified to the new formats | Yes, as a separate reviewed step after M11b-1 |

## 11. Recommended implementation sequence

Each step is a checkpoint, stopped for review.

1. **M11b-1, reference data and schema.**
   - Migrations MIG-1 to MIG-5, with tests and mutation checks for the new functions and keys.
   - The importer's Wikidata platform ids.
   - An NES No-Intro parser test.
   - Test stack only. Then development, behind a backup, with approval.
2. **M11b-2, NES / Famicom pilot.**
   - Clearance, snapshots and a fixed-id import on the test stack.
   - Editor A builds the candidates and editor B reviews.
   - A report, then the approved load into development.
3. **M11b-3, SNES / Super Famicom pilot.** The same, plus reclassifying existing development SNES releases if D12 is approved.
4. **M11b-4, PlayStation pilot.** Wikidata games plus editor-entered releases with disc serials (MIG-4), and Redump only if cleared.
5. **M11b-5, quality.**
   - A duplicate audit across the three platforms.
   - Search checks on localized titles and codes.
   - Review of the held entries.
   - The collection paging improvement noted after M11a (about 250 ms per page at 50,000 copies).
