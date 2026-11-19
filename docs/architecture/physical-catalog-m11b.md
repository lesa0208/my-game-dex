# M11b-0: physical catalog sources and modeling — design document

**Written for:** the product owner and catalog editors deciding how real NES/Famicom, SNES/Super Famicom and PlayStation releases enter the catalog.

**Status: accepted as the design foundation on 2026-11-18, subject to the corrections now in sections 6 and 8. MIG-1 (the cartridge formats, M11b-1a) and MIG-2 with MIG-3 (identity and packaging, M11b-1b) are implemented, merged into main by PR #16 (`1ac0eb8`, 2026-11-19) and applied to development, which has 72 migrations. MIG-4 (release identifiers) is cancelled, and MIG-5 (source links) is not implemented. The first real pilot is M12c-A ([catalog-pilot-m12c.md](catalog-pilot-m12c.md)), which revalidated section 8 on 2026-11-19.** Decisions are in section 10. M11b-0 itself was analysis and design only. No migration, import, clearance, catalog record or reference row was created, and the development catalog was not changed (it was read, read-only, on 2026-11-18). Every proposal below waits for the product owner's approval. Items marked **Legal** also need legal review. Artwork stays out of scope until D15 is resolved.

Related: [database-schema.md § Gaming catalog](database-schema.md#gaming-catalog), [relationships.md § Physical release examples](relationships.md#physical-release-examples), [security-rls.md § Catalog import](security-rls.md#catalog-import), [architecture-decisions.md § M5 decisions](architecture-decisions.md#m5-decisions-the-catalog-and-its-import), [ADR-031](architecture-decisions.md#adr-031-platform-identity-is-separate-from-its-names), [ADR-032](architecture-decisions.md#adr-032-physical-media-is-a-category-plus-a-reference-format), [reference-data-sources.md](reference-data-sources.md).

## Summary

- **Reuse the existing catalog.** Game, game–platform pairing, Release, release markets, components, field locks, provenance, the M5b importer, the review guard and the merge tooling already express almost everything. No parallel catalog is proposed.
- **Famicom and Super Famicom stay on the `nes` and `snes` platforms** (ADR-031). Their physical difference moves from "implied by platform and region" to an explicit **media format**: four new formats for the cartridge shells. The format is already enforced by foreign key, already an identity field for verification, and already a merge guard.
- **Migrations**, detailed in section 6:
  - The shell formats (MIG-1) are **implemented** (M11b-1a).
  - MIG-2 and MIG-3 are one migration, **implemented** (M11b-1b): identity and packaging, checked against the exact final key, and keeping legacy distinctions.
  - Both are in main (PR #16) and applied to development (72 migrations).
  - MIG-4, release identifiers, is **cancelled**. Disc serials and further codes stay in the evidence, not in the catalog.
  - MIG-5, fact-level source links, is **not implemented**, and isn't part of M12c.
- **Sources:**
  - **Wikidata** (CC0) for game identity on all three platforms.
  - **No-Intro**, whose Data Usage License permits commercial reuse of data it can license, as evidence for NES and SNES cartridge releases. Manual saved downloads only, since its site bans bots.
  - **Redump** has a public-domain statement on one side of a split project, but no named licence, and restricted automated access. It stays **held**, rather than requiring written permission as the M5 decision said.
  - **Specialist reference sites** are cited by editors one fact at a time, never bulk-imported.
- **Pilot:** 8 games and 38 release candidates, within the ceiling of 30 games and 45 releases: 16 with item-level evidence, 14 partial and 8 held. Packaging is a gap for all 38. Every candidate needs human review by someone other than its creator. The product owner approves the final selection before anything reaches the development demo.

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
- 16 SNES releases on `rom-cartridge` (published, under review, unverified, merged and excluded) and 4 published PlayStation releases on `cd-rom`;
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
| Disc serials and other identifiers (`release_identifiers`, MIG-4) | Specialist page for that disc (PSXDataCenter; Redump if cleared) | | |
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

### Recommendation (D), implemented in M11b-1a

**Implemented:** migration `20261130100000_m11b1a_media_formats.sql`, in main and applied to development since PR #16, with the identifiers the product owner approved on 2026-11-18. **These codes are stable catalog identifiers:** once used, they are never renamed, reused or removed.

| Format code | Category | Name | Position | Platform | Physical facts it records |
| --- | --- | --- | --- | --- | --- |
| `famicom-cartridge` | cartridge | Famicom Cartridge | 80 | `nes` | 60-pin Family Computer cartridge. Not interchangeable with the 72-pin NES Game Pak |
| `nes-game-pak` | cartridge | NES Game Pak | 81 | `nes` | 72-pin NES cartridge with a lockout chip. NTSC and PAL share the shell; the lockout region belongs to the release |
| `snes-cartridge-jp-pal` | cartridge | Super Famicom / PAL SNES Cartridge | 82 | `snes` | The narrow Super Famicom and PAL SNES shell with a curved front. The region lock belongs to the release |
| `snes-game-pak-na` | cartridge | North American SNES Game Pak | 83 | `snes` | The North American SNES shell, with a rectangular bottom and grooves for the console's tabs |
| `famicom-disk-card` (exists) | magnetic disk | Famicom Disk Card | 410 | `famicom-disk-system` | Unchanged |
| `cd-rom` (exists) | optical disc | CD-ROM | 110 | `playstation` | Unchanged. PlayStation needs no specific format for the pilot |

Evidence for the shells, checked 2026-11-18:
- [NESdev cartridge connector](https://www.nesdev.org/wiki/Cartridge_connector): the 60- and 72-pin pinouts.
- [Wikipedia, NES](https://en.wikipedia.org/wiki/Nintendo_Entertainment_System): "The Famicom as released in Japan contains no lock-out hardware".
- [Wikipedia, SNES](https://en.wikipedia.org/wiki/Super_Nintendo_Entertainment_System): "North American cartridges have a rectangular bottom with inset grooves matching protruding tabs in the console".

**What stays as it is:**
- `nes` and `snes` remain one platform each, with Famicom and Super Famicom as regional names. No platform was added.
- `rom-cartridge` stays linked to `nes` and `snes` for records whose shape hasn't been classified. The foreign key also prevents unlinking it while records use it.
- **No release was changed.** The migration only inserts four formats and four platform links, then checks the four links exist.
- An existing release moves to a shell only by an individual, verified editor correction (`update_release`, with a reason). The format is an identity field, so the correction ends an unpublished release's verification, and a published one needs recent MFA. The 16 development SNES releases are not touched (M11b-D12). An earlier count of 17 was an arithmetic error.
- **A shell is never derived from a region label.** The key allows an NES Game Pak classified `ntsc-j` if the item is one; the editor decides from the item.

**How each required property is preserved:**

| Property | Where it lives |
| --- | --- |
| Logical console family | `platforms` (`nes`, `snes`, `playstation`), with `famicom-disk-system` as the `nes` add-on |
| Physical cartridge or disc format | `releases.media_format_code` (the four shells, `famicom-disk-card`, `cd-rom`) |
| Market and territory | `release_markets` (ISO countries), independent of region |
| Collector region classification | `releases.region_code` |
| Video standard | **Not a new column.** For these three platforms the approved region codes already carry it (`ntsc-uc`, `ntsc-j`, `pal`, `pal-m`). Add a column only if a pilot record shows a distinction they can't express (decision M11b-D6) |
| Packaging | `releases.packaging_code`, from a controlled vocabulary with an explicit `unclassified` state; the recorded text is kept (MIG-3) |
| Edition or reprint | `edition_kind` (`standard`, `reprint` and the rest) and `edition_name` ("Players' Choice", "Greatest Hits", "Platinum", "PlayStation the Best", "Classic Series") |
| Print or label variant | `variant_name` ("Gold cartridge", "Two-line logo label"), only when the source states the difference |
| Product code and barcode | `releases.product_code` (as printed on the package), further codes, disc serials and aliases in `release_identifiers` (MIG-4), `releases.barcode` |
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
  - Super Famicom and PAL shell (`snes-cartridge-jp-pal`);
  - North American shell (`snes-game-pak-na`).
- **Codes:**
  - `SHVC-xx` for Japan;
  - `SNS-xx-USA` and `SNS-xx-CAN` for North America;
  - `SNSP-xx-<country>` for PAL, such as UKV, NOE, FAH, FRA, ESP and AUS.
  - Some PAL carts print a combined code, such as `SNSP-ZL-NOE/SFRG`, stored whole as printed (MIG-4).
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
  - double-depth jewel case (types are defined by construction, not disc count);
  - Japanese cases with a spine card (the spine card is a component; the case is a jewel case).
  - The vocabulary is in section 6 (MIG-3). The pilot records only what the evidence states, and packaging is a gap for every pilot release.

## 6. Required reference-data changes and eventual migrations

**Reference data (forward migrations, M11b-1):**

1. The four `media_formats` rows and their `platform_media_formats` links (section 4).
2. The packaging vocabulary (MIG-3).
3. No new region codes or markets. No new platforms.

**Migrations.** MIG-1 to MIG-3 are implemented (M11b-1a and M11b-1b) and applied to development. MIG-4 is cancelled and MIG-5 isn't implemented. All are forward-only, with no `DROP ... CASCADE`, no change to Supabase-managed schemas, and exact-signature replacements for functions.

| # | Migration | Detail |
| --- | --- | --- |
| MIG-1 | Cartridge-shell formats: four `media_formats` rows and four `platform_media_formats` rows. **Implemented in M11b-1a** | Section 4, and the importer behavior below |
| MIG-2 and MIG-3 | **One migration**: media format, normalized names and codes, and a packaging key in **both** release identity rules and the submission duplicate check, checked against the exact final key before any index changes; a controlled packaging vocabulary with `unclassified` and `unknown` | [Identity and packaging](#mig-2-and-mig-3-together-release-identity-and-packaging-implemented-in-m11b-1b) |
| MIG-4 | Release identifiers: further printed codes, disc serials, alternate identifiers and staff-only source aliases | [Identifiers](#mig-4-release-identifiers-approved-in-principle-clarified) |
| MIG-5 | Fact-level links from a source record to one or more releases, by an editor | [Source evidence](#mig-5-source-evidence-for-editor-built-releases-revised-after-review) |

**Importer code (M11b-1, no migration):**
- add `nes`, `famicom-disk-system` and `playstation` to `WIKIDATA_PLATFORMS`, after confirming their item ids;
- test the No-Intro parser against an NES snapshot.

### Importer format selection (MIG-1, implemented and tested in M11b-1a)

**Today.** `private.import_apply_release` creates a release candidate only when the run's platform has exactly one format in `platform_media_formats`. Otherwise it sets the source record to `needs_review` with tier A, the matched game, and the note "format unknown", and creates nothing. A source id already linked to a release never changes that release's format.

**After MIG-1.** `nes` has `rom-cartridge`, `famicom-cartridge` and `nes-game-pak`, and `snes` has `rom-cartridge`, `snes-cartridge-jp-pal` and `snes-game-pak-na`. So every new NES and SNES release entry is held as "format unknown". That is the intended behavior, and the importer code stays as it is:

| Rule | How it holds |
| --- | --- |
| Never guess the shape from a title | The importer doesn't read the format from anything: the only automatic path is the single-format rule |
| Never assign a format from a ROM dump name | No-Intro names and region tags are never mapped to a format. A "(Japan)" tag doesn't mean a Famicom cartridge, and one NES DAT holds both Famicom and NES dumps |
| Hold ambiguous records | "Format unknown" entries stay `needs_review`, with the matched game, and appear in the run report and the admin import pages (M10d) |
| Allow verified evidence or an editor to choose | **Editor:** chooses the format when creating the release (`create_release`), or corrects it (`update_release`, an identity field, so verification ends), then links the record to the facts it supports (MIG-5).<br>**Source:** a source may set the format only if a field of that specific record explicitly states the physical form. The mapping must be added to the parser's allowlist with a test, and stored as evidence on `media_format_code`, already an allowed `release_evidence` field. No cleared source provides such a field today, so none is added in M11b-1 |
| Preserve provenance and audit history | The held record stays unchanged: source records are immutable (`guard_provider_record`). The editor's release has origin `staff` and an audit row with its reason. A MIG-5 link adds fact-level evidence and its own audit row |

Single-format platforms, such as PlayStation with `cd-rom`, keep the automatic path unchanged.

**Proof (M11b-1a, test stack):**
- `44_physical_media_formats.test.sql` (53 pgTAP tests) stages synthetic NES and SNES entries. Their region tags (Japan, USA, Europe), serial patterns (HVC, NES, SHVC, SNS, SNSP) and a payload that names a format are all held as "format unknown" with their game. None creates a release, pairing, external reference, evidence or audit row, and no source record changes. A PlayStation entry is still created on `cd-rom`, with only what the source states, and its evidence.
- `db-import-checks.mjs` runs the real tool under the `catalog_importer` login, and gets the same result for NES and SNES snapshots.
- The importer still can call only its eight functions, and no editor, verification or publication function.
- The M5b importer tests (17, 18, 19, 24) and the tool flow now run on `mega-drive`, a cartridge platform with one format, so the automatic candidate path keeps its full coverage.

### MIG-2 and MIG-3 together: release identity and packaging (implemented in M11b-1b)

**Implemented:** migration `20261201100000_m11b1b_release_identity.sql`, in main and applied to development since PR #16.

**Why the design changed after review.** The first design gave every existing release `packaging_code = 'unclassified'` and then put only `packaging_code` in the identity key. Two published releases that differed only in their packaging text would then have collided. The implementation keeps the historical text in the key until an editor classifies the release, and its preflight evaluates the exact final key.

**Principle: one migration, one final key, checked exactly.** The identity indexes change once. The preflight groups existing rows by the **same expressions the new indexes use**, through the same immutable functions, before any index is touched.

#### The final key

Used by both indexes. The pending one starts with `submitted_by` and keeps its partial condition, `status in ('unverified', 'under_review') and submitted_by is not null`. Both are `UNIQUE ... NULLS NOT DISTINCT`.

```text
game_id, platform_id, media_format_code, region_code,
private.release_label_key(edition_name),
private.release_label_key(variant_name),
private.release_packaging_key(packaging_code, packaging),
private.release_code_key(product_code)
```

| Function (immutable SQL, `search_path = ''`, private) | What it compares | What it never does |
| --- | --- | --- |
| `release_label_key(text)` | Unicode NFC, then typographic apostrophes, quotes and dashes made ASCII, other spaces made a space, runs of white space made one, trimmed, `lower()` | Remove letters, digits, accents or punctuation. "Players' Choice" and "Players Choice", or "Edition" and "Édition", stay different |
| `release_code_key(text)` | Unicode NFC, surrounding white space removed, `upper()` | Remove or change hyphens, slashes, dots or inner spaces, or split a combined code. `SNS-ZL-USA` and `SNS ZL USA` stay different |
| `release_packaging_key(code, text)` | The code for a classified release. For `unclassified`, the code plus the **exact** recorded text: `'unclassified' \|\| chr(31) \|\| coalesce(text, '')` | Merge two unclassified releases whose recorded text differs in any way |

**Codes are stricter than designed.** The approved rule normalizes only case and surrounding white space. Dash variants and inner spaces are no longer unified.

**These functions are used by unique indexes.** They must never be replaced in place. A change needs new functions and new indexes.

#### The preflight, before any index changes

In the migration's transaction:
1. Create `packaging_types`, `releases.packaging_code` (not null, default `unclassified`) and the three key functions.
2. Group every **published** release, and every **pending submission**, by the exact final key.
3. If any group has more than one row, raise an exception that lists the release ids. Everything rolls back, the old indexes stay, and **no data is changed to make an index fit**.
4. Create each new index under a temporary name, drop the old one by exact name without `CASCADE`, and rename the new one to the old name.

The index build holds a lock that blocks writes until commit, so no duplicate can be written in between.

#### Transitional strategy for unclassified historical releases

| Situation | Rule |
| --- | --- |
| Existing releases, published or not | Start `unclassified`, with their packaging text exactly as recorded. Nothing is classified. Their identity keeps the exact text, so every earlier distinction survives |
| An editor classifies a legacy release | `update_release` sets `packaging_code`, with a reason and an audit row. The key changes to the code. If that collides with another published release, the update fails, and the app shows the existing "An identical release is already in the catalog" message. Classification never silently merges two releases |
| A newly published release | Must be classified: an editor chooses a type, or `unknown` |
| A new candidate whose packaging isn't known | Stays `unclassified`, visible as a gap, and can't be published until classified |

**Duplicates between an unclassified legacy release and a classified new one** have different keys, so the index doesn't catch them. Review does: the release picker, staff search and the merge candidate list show the legacy release. The gap closes as legacy releases are classified, and classification is where such a duplicate surfaces.

#### `unclassified` versus `unknown`

| State | Meaning | Who sets it | Publishable |
| --- | --- | --- | --- |
| `unclassified` (shown as "Not yet classified", or "Not sure" to a collector) | Nobody has determined the packaging. The default | The default. A collector may choose "Not sure" on their own open submission | **No**, for a release becoming published from M11b-1b onward. Legacy published releases stay published, readable and editable |
| `unknown` | An editor examined the evidence, and the packaging can't be established | **Only a catalog editor**, through `create_release` or `update_release`, which require a reason and record an audit row. Collectors can't choose it | Yes |
| A type | The packaging is established by evidence | An editor, or a collector on a submission that an editor then reviews | Yes |

#### Publication rules, enforced in the database

A `before insert or update` trigger on `releases`, `guard_release_packaging_and_format`, applies to API sessions, including the `SECURITY DEFINER` functions they call. Maintenance sessions are exempt, as in the M7b-1 and M10c review guards.

| Rule | Error | Path covered |
| --- | --- | --- |
| A release becoming published needs a classified packaging code | `packaging classification required` | `publish_release` and `approve_submission` |
| It also needs a (platform, format) pair that accepts new publications. `platform_media_formats.accepts_new_publications` is false only for `nes`/`rom-cartridge` and `snes`/`rom-cartridge` | `physical format unverified` | Both |
| Only a catalog editor may set `unknown` | `not permitted` | Every write. `submission_details` also refuses it |
| Packaging never returns to `unclassified`, except on a collector's own open submission | `packaging already classified` | Every write, all sessions |

**The publication rules apply only to a new publication,** meaning a release published from `unverified` or `under_review`. Grandfathered published releases are never re-verified, changed or blocked from ordinary edits, and restoring an excluded release, which returns a release that was already published, is unaffected.

**No exception for an unknown shell.** A new NES or SNES release whose shell isn't verified stays in review. An exception would need an explicit, audited editorial policy, which doesn't exist.

#### Packaging types, by construction (approved)

Types describe how the package is **built**, never how many discs it holds. Disc count is `media_count`. Inner trays, slipcovers and spine cards are `release_components`.

| Code | Name | Construction |
| --- | --- | --- |
| `unclassified` | Not yet classified | Not a type |
| `unknown` | Unknown | Not a type |
| `cardboard-box` | Cardboard box | A folding paperboard carton. An inner tray, insert or sleeve is a component |
| `jewel-case` | Jewel case | A standard-depth hinged plastic disc case, about 10 mm deep, which may hold a hinged tray for a second disc |
| `double-depth-jewel-case` | Double-depth jewel case | A hinged plastic disc case about twice the standard depth, with internal hinged trays |
| `plastic-case` | Plastic case | A moulded plastic case that isn't a jewel case, such as a clamshell or keep case |
| `paper-sleeve` | Paper sleeve | A paper or card sleeve or envelope, with no rigid case |

- **No multi-disc type.** There is no `multi-disc-jewel-case` type: disc count isn't construction.
- **"Big box" stays text.** It isn't a type yet. The existing development value stays as recorded text on an unclassified release.
- **The vocabulary is extensible.** A row is added by forward migration when a physical format needs one. The app's copy in `src/features/catalog/packaging.ts` is kept in step by a unit test.

#### What else changed, and what was kept

| Item | Change |
| --- | --- |
| Index names | **Kept**: `releases_published_identity_key` and `releases_pending_submission_key`. Functions keep mapping them to "already published" and "already submitted", and the app maps any `23505` from an edit to its duplicate message |
| `submit_release` published-duplicate check | Uses the same key functions, the media format and the packaging key, so it agrees with the index. A "Not sure" submission isn't matched to a classified release; it goes to review |
| `create_release`, `update_release` | Accept `packaging_code`, validated against the vocabulary |
| `submission_details`, `create_submitted_release`, `update_my_submission` | Accept `packaging_code`, refusing `unknown`. Replacing a submission's details replaces it too |
| `release_identity_fields()`, `lockable_field()` | Include `packaging_code`: a change ends an unpublished verification, and imports honour a lock |
| Reads | `catalog_release_json` (release picker and staff record), `merge_fields`, `submission_snapshot`, `get_submission_review`, `get_my_collection_item` and `get_my_preserved_release` include `packaging_code` |
| Grants | `select (packaging_code)` on `releases` for `anon` and `authenticated`. `packaging_types` is read-only for clients. No write grant was added |
| No-self-review, recent MFA, revisions, field locks | Unchanged |
| Merge | Unchanged. It already required the same platform and format, and now also compares `packaging_code` among the fields to acknowledge |
| App | A packaging select in the admin create and edit forms, the review correction form and the collector submission form. The recorded text is kept as a separate note field. Public pages show the type, or only the recorded text for an unclassified release. Staff pages always say whether it is classified. The data export includes `packaging_code` |

**Older tests.** Thirteen pgTAP files written before these rules publish fixtures through the API. Each now opens with a transaction-local block that gives its new releases a classified type, unless the test names one, and re-allows the legacy shell. The rules themselves are covered by `45_release_identity.test.sql`, `db-release-identity-checks.mjs` and the `m11b1b` mutations.

### MIG-4: release identifiers (approved in principle; clarified)

#### Kinds of code

| Where | Meaning | Printed on the item? | Visible to |
| --- | --- | --- | --- |
| `releases.product_code` | **The release's package code**, exactly as printed on the box or package, one per release | Yes | Everyone, when published |
| `release_identifiers.kind = 'release_code'` | Another code printed on the **same package**, beside the package code | Yes | Everyone, when published |
| `media_serial` | The serial printed on **one disc or cartridge** of the release, with its `disc_number` | Yes, on the medium | Everyone, when published |
| `alternate_identifier` | Another official identifier printed on the package, such as a second barcode or a catalog number | Yes | Everyone, when published |
| `code_alias` | A form a source uses that **isn't printed on the item**, such as `NES-P-SM` against a printed `NES-SM-EEC`. Kept for matching and duplicate search only | No | **Catalog editors only** |

**A disc serial isn't the package code.** A PlayStation box code often equals disc 1's serial, but that is a fact to confirm from the package, never a default. Until it is confirmed, the pilot records the disc serials as `media_serial` and leaves `product_code` empty.

**Combined codes stay whole.** `SNSP-ZL-NOE/SFRG` is stored as printed, as one `product_code`. It is split into a `product_code` and a `release_code` only when evidence shows two separately printed codes, and never just because of the slash. The first pilot table wrongly split it, and is corrected in section 8.

#### Exact strings, and safe comparison

- **Storage is exact.** `value`, like `product_code`, keeps the printed case, separators and spacing. The only check is no leading or trailing space, no control characters, and 1 to 40 characters.
- **Comparison uses `release_code_key()`** (MIG-2): upper case, trimmed, white space runs made one space, Unicode dash variants made `-`. Hyphens, slashes, dots and spaces are separators that can carry meaning, so they are **never removed** for uniqueness.
- **Duplicate suggestions** in staff search may also compare a compact form with every separator removed. That form only suggests, never enforces and never merges.

#### Uniqueness: expression indexes, not `UNIQUE` constraints

- PostgreSQL `UNIQUE` constraints can't contain expressions, so uniqueness on the comparison key is a **unique index**: `release_identifiers_key` on `(release_id, kind, private.release_code_key(value))`.
- A second, partial unique index, `release_identifiers_disc_key` on `(release_id, disc_number) where kind = 'media_serial'`, gives one serial per disc.
- **Consequences:**
  - A violation names the index, not a constraint.
  - The writing function catches `unique_violation` and maps the index name to a friendly message, as M7a and M10c do.
  - `ON CONFLICT` would need the expression to infer the index, so the function doesn't use it.
- **Nothing is unique across releases, deliberately:**
  - Greatest Hits and Platinum reprints carry the original's disc serials.
  - A label revision keeps its code.
  - Regional packages can share a disc.
  - A global unique rule would force one of two real releases to lie about its serial. A shared code is evidence for lookup, the importer's `serial_also_on` note and duplicate search, never identity or a reason to merge (M5 identity decision).

#### Disc numbers under concurrent changes

A disc number must stay between 1 and the release's `media_count`. Two triggers keep it there; each locks or reads the other side:

1. **On `release_identifiers` insert or update:** it reads the release with `select media_count ... for share`, then refuses a `disc_number` above it. A media serial needs a known `media_count`.
2. **On a `releases` update of `media_count`:** it refuses a value below the highest `disc_number` recorded.

`FOR SHARE` conflicts with the row lock an update takes. Under read committed, each trigger statement reads after the other transaction commits, so the two sides serialize:
- **Identifier first:** the count update waits, then sees the new serial and refuses.
- **Count first:** the identifier insert waits, then sees the lower count and refuses.

Writes also go through editor functions that lock the release first (`lock_release_for_edit`). The triggers are the backstop. A pgTAP test covers both orders, and `db-review-checks`-style checks hold a transaction open for each race.

#### Writes, visibility and evidence

- **Writes:** only `set_release_identifiers(release, identifiers, reason)`, for catalog editors.
  - It needs a reason, and recent MFA on a published release.
  - Each change records an audit row.
  - It raises the release's revision, so an unpublished verification ends.
- **Visibility:** RLS follows the release, like `release_markets`. The public and authenticated policy also requires `kind <> 'code_alias'`, and editors read all kinds. Column grants never expose who wrote a row.
- **Evidence:** a source can support an identifier through the MIG-5 fact links, field `identifiers`, naming the exact identifier.

### MIG-5: source evidence for editor-built releases (revised after review)

**Correction.** The first design attached one held source record to one release, through `matched_release_id` and `external_references`. A No-Intro entry describes a **ROM dump**: one dump can be the software of several retail packages, such as an original, its Players' Choice reprint and a label revision. Tying it to one release would lose the others, and would imply facts a dump can't establish.

#### What a ROM-level record can and can't establish

| A No-Intro (ROM-level) record **can** support | It **never** establishes |
| --- | --- |
| That the release's medium carries this software (`software`) | A specific box, edition, reprint line or variant |
| The serial it states, when it equals the release's code (`product_code` or an identifier) | The region of retail distribution, or markets |
| The languages of the software it states (`languages`) | Packaging, media format or shell, media count |
| | Release date, publisher, barcode, components |

The allowed facts are a per-provider list in the database:
- **`no-intro`:** `software`, `product_code`, `identifiers`, `languages`.
- **`wikidata`:** game-level only, as today.
- **`redump`:** none while held.

A provider's list is extended only by a reviewed migration. **A No-Intro region tag is never evidence for `region_code`**: it describes the dump, and "(Europe)" spans many packages.

#### The relationship: reuse `release_evidence`, add a small link table

```text
private.source_record_links (
  id, provider_record_id, release_id,
  linked_by, linked_at, reason,          -- the editor and why
  revoked_by, revoked_at, revoke_reason, -- nothing is deleted
  unique (provider_record_id, release_id)
)
private.release_evidence (existing)
  + link_id        -- the link the fact came through; null for the importer's own match
  + stated_value   -- jsonb copy of exactly what the record states for this fact
  + record_sha256  -- the record's payload hash at link time
  field_name gains: 'software', 'identifiers'
```

- **Many releases per record, many records per release.** One record can link to several releases, one link each. A release can have links from several records and providers.
- **The importer's path is unchanged.** `matched_release_id` and `external_references` still mean "the release this source id created or resolved to", one per source id, written only by the importer. Editor links never write them. So a later snapshot never fills fields on an editor-built release: an editor link is never followed automatically.
- **Every evidence row names one fact.** It holds `field_name`, plus `stated_value` copied from the immutable payload, plus the payload hash. Each row says exactly which fact of which record version supports which release field.
- **Gate 5 is generalized.** The existing trigger requires release evidence to come from a record matched to that release. It now accepts either that, or an **active** link between this record and this release, with `field_name` in the provider's allowed list.

#### The editor function

```text
link_source_record(p_record uuid, p_release uuid, p_facts text[], p_reason text, p_expected_revision bigint)
revoke_source_link(p_link uuid, p_reason text)
```

| Check | Rule |
| --- | --- |
| Who | An active catalog editor or administrator, with a live session and recent TOTP. `catalog_importer` gets no grant and no new privilege |
| Record | A release-level provider record, from a run on the release's platform. Any status except `ignored` and `failed`: a held record can support several releases |
| Clearance | The provider is still cleared against the terms hash its run cited, rechecked at link time |
| Release | Unpublished, and not merged, excluded or rejected, at `p_expected_revision`. Linking to a published release is a published edit, needing recent MFA (as above) and a reason |
| Facts | Each fact is in the provider's allowed list, **is present in the record's payload**, and equals the release's current value under the MIG-2 key functions. Anything else is refused: a record can't be used to claim a fact it doesn't contain |
| Values | Never changed. Linking only adds evidence; the editor sets values with `update_release` first |
| Locks | Field locks are unaffected. The importer still honours them |

**What it writes:**
- the link;
- one `release_evidence` row per fact;
- an audit row (`catalog_source_linked`, or `catalog_source_unlinked`), with the editor, the reason, and the record, run, provider and facts;
- a raised release revision: evidence is part of what a verifier attests, so an unpublished verification ends and must be repeated against the current evidence.

The record's status becomes `matched`. Its `match_notes` gain `editor_links`, the number of active links. Its content stays immutable (`guard_provider_record`).

**Concurrency:**
- The function locks the release first (`lock_release_for_edit`, `FOR UPDATE`), then the record (`FOR SHARE`).
- `unique (provider_record_id, release_id)` makes a repeated link idempotent: a unique violation returns the existing link.
- The existing `release_evidence` primary key `(release_id, field_name, provider_record_id)` makes a repeated fact a no-op.
- Two editors linking the same record to two different releases is allowed, by design. Linking it to the same release twice yields one link.

**Review is unchanged:**
- Linking isn't verification.
- The release's origin and creator don't change.
- The creator still can't verify or publish (M10c).
- A verifier sees every link and its stated values in `get_release_record`.
- Revoking a link keeps the row with who revoked it and why, ends the evidence rows' effect, and raises the revision again.

**Tests, when implemented:**
- One record supporting two releases.
- Refusal of a disallowed fact (No-Intro `region_code`), an absent fact, and a mismatched value.
- Idempotent repeats, and concurrent links held open.
- Refusal after clearance is withdrawn.
- No grant to the importer.
- Revision and verification ending, and revocation keeping history.
- Mutations: drop the allowed-facts check, the payload check, the clearance recheck, and gate 5's link condition.

## 7. Physical-release identity and duplicate-prevention rules

### Game identity versus localized title

- A Game is one game across ports and regions (D6). A different title in a market is a `game_aliases` row or `releases.local_title`, never a new Game.
- **Same name, different game.** US "Super Mario Bros. 2" and Japanese "Super Mario Bros. 2" are different games. US SNES "Final Fantasy III" is the game known as Final Fantasy VI. Identity follows the game's content, not the printed title: such a release has `local_title` set and belongs to the correct Game.
- Wikidata items propose identities. An editor confirms them, and a missing Wikidata item doesn't block a Game (M5 decision).

### Release identity and uniqueness

A Release is one distinguishable manufactured product. After MIG-2 and MIG-3, its identity, for published releases and for one submitter's pending submissions, is game, platform, media format, region code, edition name, variant, packaging type and product code, with names and codes compared in normalized form (section 6).

- Different shell, region classification, edition, packaging or printed product code: separate releases.
- Same package sold in several countries: one release with several markets.
- A difference the key doesn't cover, such as a rating label or language: the reviewer must give each a distinct `variant_name`.
- ROM revisions, board revisions and screw counts are not releases unless the package differs and an editor confirms it.

### Region and edition matching

- `region_code` is set only from the package, or from a source that states the release's region. Never from a product-code prefix alone, a No-Intro region tag covering several countries, or the market.
- `edition_kind` and `edition_name` are never imported or defaulted (M5 decision 2). The editor sets them from the package or a cited source.

### Multiple product codes or aliases

- `product_code` is the package code as printed, in the form printed. Store the source's form only when the item isn't available, and say so in the reason.
- A combined code such as `SNSP-ZL-NOE/SFRG` is stored whole. It is split only on evidence of two separately printed codes.
- A disc serial is not the package code unless a source showing the package says so.
- Disc serials, further printed codes, alternate identifiers and source aliases go in `release_identifiers` (MIG-4). A multi-disc game stays one release.
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

**The pilot is unchanged in scope:** 8 games and 38 release candidates, within the ceilings of 30 and 45. It is a review candidate, not an approved import (M11b-D10). Nothing has been imported or published.

### Evidence rules (revised after review)

- **A verified game is not a verified edition.** A game page (Wikipedia, MarioWiki, Wikidata) supports a title, a game identity and often an original release date. It doesn't establish a specific package.
- **A disc serial is not necessarily the package code.** PlayStation package codes are left empty until a source showing the package confirms them, and the serials are recorded per disc (MIG-4).
- **A ROM dump is not a retail package.** No release below rests on a No-Intro entry. No-Intro can later add only `software`, serial and language facts (MIG-5).
- **Missing packaging is a visible gap.** None of the sources cited states the package construction. Every release starts `unclassified` and can't be published until an editor chooses a type or `unknown` (MIG-3).
- **Search snippets confirm nothing.** A fact seen only in a search-engine result is held.
- **Held entries never become published silently.** Publication needs a human verifier who isn't the creator, and a verification that matches the record as it is (M10c).
- **Who read what.** The facts below were read on 2026-11-18 by a research pass with a text-only fetch. Editor A re-reads each cited page and cites it, with the date, in the release's reason before entering anything.

**Evidence classes**, which replace "Confirmed":

| Class | Meaning |
| --- | --- |
| **A: item-level** | A source that documents this specific physical item (its cartridge or package entry) supports the platform, shell, printed code and edition. The listed gaps remain |
| **B: partial** | Some identifying facts come from a general or secondary source, or by inference (a code from a wiki list, or a package code taken from a disc serial). An editor must close the gap from an item-level source before verifying |
| **H: held** | An identifying fact is missing, conflicting or seen only in a snippet. The release isn't entered until it's resolved |

| Platform group | Games | A | B | H | Releases | Ceiling |
| --- | --- | --- | --- | --- | --- | --- |
| NES / Famicom | 2 | 2 | 3 | 5 | 10 | 10 games, 15 releases |
| SNES / Super Famicom | 3 | 14 | 0 | 1 | 15 | 10 games, 15 releases |
| PlayStation | 3 | 0 | 11 | 2 | 13 | 10 games, 15 releases |
| **Total** | **8** | **16** | **14** | **8** | **38** | 30 games, 45 releases |

**Gaps common to every row:**
- packaging (all 38);
- markets, where only a code suffix suggests them;
- release dates for SNES (SNES Central gives none; its "Man. Dates" are manufacturing codes).

They are not repeated in each row.

**Corrections to the first table:**
- **Package codes are no longer taken from disc serials.** PlayStation package codes were taken from disc 1 serials; they are now gaps.
- **No combined code is split.** `SNSP-ZL-NOE/SFRG` was split into a code and an alias; it is now stored as printed.
- **No variant is invented.** "German packaging", "French packaging" and "Spanish packaging" were variant names the sources don't state, and are removed. The printed code and languages already distinguish those releases.
- **Changed classes:**
  - NES rows resting on MarioWiki's code lists move to B.
  - US Greatest Hits FF7 moves to H, because its package is evidenced only by cover images filed under the original serial, which weren't inspected.
  - Metal Gear Solid moves from H to B, because a packaging gap no longer holds a row on its own: it is universal and explicit.

### NES / Famicom

| # | Game | Platform, format | Region | Printed code | Edition, variant | Media | Class and gaps | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | Super Mario Bros. | `nes`, `famicom-cartridge` | `ntsc-j` | HVC-SM | Standard | 1 | **B**: the code is from a wiki list, not an item page. Date 1985-09-13 is the game's | [MarioWiki: Super Mario Bros.](https://www.mariowiki.com/Super_Mario_Bros.), [Wikipedia: Super Mario Bros.](https://en.wikipedia.org/wiki/Super_Mario_Bros.) |
| N2 | Super Mario Bros. | `famicom-disk-system`, `famicom-disk-card` | `ntsc-j` | FMC-SMA | Disk re-release | 1 | **B**: the code is from a wiki list. Date 1986-02-21 | MarioWiki, Wikipedia (as N1) |
| N3 | Super Mario Bros. | `nes`, `nes-game-pak` | `ntsc-uc` | NES-SM-USA | Standard | 1 | **A**. Date year only ("debated") | [NesCartDB 270](https://nescartdb.com/profile/view/270), Wikipedia (as N1) |
| N4 | Super Mario Bros. | `nes`, `nes-game-pak` | `pal` | NES-SM-EEC or NES-P-SM | Standard | 1 | **H**: the code conflicts; NES-SM-EEC only in a snippet | [MarioWiki](https://www.mariowiki.com/Super_Mario_Bros.) (NES-P-SM); VGCollect item 18369 snippet, not fetched |
| N5 | Super Mario Bros. | `nes`, `nes-game-pak` | `pal` | NES-SM-AUS | Standard | 1 | **B**: the code is from a wiki list. July 1987 | MarioWiki (as N1) |
| N6 | The Legend of Zelda | `famicom-disk-system`, `famicom-disk-card` | `ntsc-j` | FMC-ZEL | Standard | 1 | **H**: the code only in a snippet. Date 1986-02-21 from the game page | [Wikipedia: The Legend of Zelda](https://en.wikipedia.org/wiki/The_Legend_of_Zelda_(video_game)) |
| N7 | The Legend of Zelda | `nes`, `nes-game-pak` | `ntsc-uc` | NES-ZL-USA | Standard, "Gold cartridge" | 1 | **A**. Date conflict (July versus August 22, 1987), so 1987 | [NesCartDB 490](https://nescartdb.com/profile/view/490), [NesCartDB 872](https://nescartdb.com/profile/view/872), Wikipedia (as N6) |
| N8 | The Legend of Zelda | `nes`, `nes-game-pak` | `ntsc-uc` | not confirmed | Reprint, "Classic Series", grey cartridge | 1 | **H**: no code | Wikipedia (as N6) |
| N9 | The Legend of Zelda | `nes`, `nes-game-pak` | `pal` | not confirmed | Standard | 1 | **H**: no code or country package | Wikipedia (as N6) |
| N10 | The Legend of Zelda | `nes`, `famicom-cartridge` | `ntsc-j` | not confirmed | Cartridge re-release (1994) | 1 | **H**: no code | Wikipedia (as N6) |

### SNES / Super Famicom

SNES Central documents each cartridge and package by its printed code. The region below is its listing, which editor A confirms from the page, not from the code prefix.

| # | Game | Format | Region | Printed code | Edition, variant | Media | Class and gaps | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Super Mario World | `snes-cartridge-jp-pal` | `ntsc-j` | SHVC-MW | Standard | 1 | **A** | [SNES Central 0000](https://snescentral.com/article.php?id=0000) |
| S2 | Super Mario World | `snes-game-pak-na` | `ntsc-uc` | SNS-MW-USA | Standard | 1 | **A** | SNES Central 0000 |
| S3 | Super Mario World | `snes-game-pak-na` | `ntsc-uc` | SNS-MW-USA-1 | Standard, "Two-line logo label" | 1 | **A**: a label revision, not a reprint | SNES Central 0000 |
| S4 | Super Mario World | `snes-cartridge-jp-pal` | `pal` | SNSP-MW-NOE | Standard | 1 | **A** | SNES Central 0000 |
| S5 | Super Mario World | `snes-cartridge-jp-pal` | `pal` | "SNS-MW-UKV" as listed | Standard | 1 | **H**: the missing "P" may be a source error | SNES Central 0000 |
| S6 | Super Mario World | `snes-cartridge-jp-pal` | `pal` | SNSP-MW-FAH-1 | Standard | 1 | **A** | SNES Central 0000 |
| S7 | The Legend of Zelda: A Link to the Past | `snes-cartridge-jp-pal` | `ntsc-j` | SHVC-ZL | Standard | 1 | **A** | [SNES Central 0164](https://snescentral.com/article.php?id=0164) |
| S8 | A Link to the Past | `snes-game-pak-na` | `ntsc-uc` | SNS-ZL-USA | Standard | 1 | **A** | SNES Central 0164 |
| S9 | A Link to the Past | `snes-game-pak-na` | `ntsc-uc` | SNS-ZL-USA-1 | Reprint, "Players' Choice", "K-A rating" | 1 | **A** | SNES Central 0164 |
| S10 | A Link to the Past | `snes-game-pak-na` | `ntsc-uc` | SNS-ZL-USA-2 | Reprint, "Players' Choice", "E rating" | 1 | **A** | SNES Central 0164 |
| S11 | A Link to the Past | `snes-cartridge-jp-pal` | `pal` | SNSP-ZL-UKV | Standard | 1 | **A** | SNES Central 0164 |
| S12 | A Link to the Past | `snes-cartridge-jp-pal` | `pal` | SNSP-ZL-NOE/SFRG, as printed | Standard | 1 | **A**: stored whole, not split | SNES Central 0164 |
| S13 | Super Metroid | `snes-game-pak-na` | `ntsc-uc` | SNS-RI-USA | Standard | 1 | **A** | [SNES Central 0885](https://snescentral.com/article.php?id=0885) |
| S14 | Super Metroid | `snes-cartridge-jp-pal` | `pal` | SNSP-RI-FAH | Standard | 1 | **A** | SNES Central 0885 |
| S15 | Super Metroid | `snes-cartridge-jp-pal` | `pal` | SNSP-RI-UKV | Standard | 1 | **A** | SNES Central 0885 |

The Japanese Super Metroid code wasn't found on SNES Central, so that release isn't proposed.

### PlayStation

PSXDataCenter documents each disc by serial, with dates and languages. No package code below is confirmed. Each is a gap until a source showing the package confirms it.

| # | Game | Region | Package code | Disc serials (MIG-4) | Edition | Media | Class and gaps | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Final Fantasy VII | `ntsc-j` | gap | SLPS-00700, 00701, 00702 | Standard | 3 | **B**: package code. Date 1997-01-31 | [PSXDataCenter SLPS-00700](https://psxdatacenter.com/games/J/F/SLPS-00700.html) |
| P2 | Final Fantasy VII | `ntsc-uc` | gap | SCUS-94163, 94164, 94165 | Standard, "Black label" | 3 | **B**: package code. Date 1997-08-15 | [PSXDataCenter SCUS-94163](https://psxdatacenter.com/games/U/F/SCUS-94163.html) |
| P3 | Final Fantasy VII | `ntsc-uc` | gap | as P2 | Reprint, "Greatest Hits" | 3 | **H**: the package is evidenced only by cover images filed under P2's serial, not inspected | PSXDataCenter SCUS-94163 |
| P4 | Final Fantasy VII | `pal` (English) | gap | SCES-00867, 10867, 20867 | Standard | 3 | **B**: package code. Date 1997-11-14 | [PSXDataCenter SCES-00867](https://psxdatacenter.com/games/P/F/SCES-00867.html) |
| P5 | Final Fantasy VII | `pal` (French) | gap | SCES-00868, 10868, 20868 | Standard | 3 | **B**: package code, date | PSXDataCenter SCES-00867, [PAL list](https://psxdatacenter.com/plist.html) |
| P6 | Final Fantasy VII | `pal` (German) | gap | SCES-00869, 10869, 20869 | Standard | 3 | **B**: package code, date | As P5 |
| P7 | Final Fantasy VII | `pal` (Spanish) | gap | SCES-00900, 10900, 20900 | Standard | 3 | **B**: package code, date | As P5 |
| P8 | Final Fantasy VII | `pal` (English) | gap | as P4 | Reprint, "Platinum" | 3 | **H**: the package and a possible bonus disc (SCED-20062, implied by an image link) aren't confirmed | PSXDataCenter SCES-00867 |
| P9 | Crash Bandicoot | `ntsc-uc` | gap | SCUS-94900 | Standard, "Black label" | 1 | **B**: package code. Date 1996-09-09 | [PSXDataCenter SCUS-94900](https://psxdatacenter.com/games/U/C/SCUS-94900.html) |
| P10 | Crash Bandicoot | `pal` | gap | SCES-00344 | Standard | 1 | **B**: package code. Date 1996-11-15 | [PSXDataCenter SCES-00344](https://psxdatacenter.com/games/P/C/SCES-00344.html) |
| P11 | Crash Bandicoot | `ntsc-j` | gap | SCPS-10031 | Standard | 1 | **B**: package code. Date 1996-12-06 | [PSXDataCenter SCPS-10031](https://psxdatacenter.com/games/J/C/SCPS-10031.html) |
| P12 | Crash Bandicoot | `ntsc-j` | gap | SCPS-91057 | Reprint, "PlayStation the Best for Family" | 1 | **B**: package code. Date 1998-05-28 | [PSXDataCenter SCPS-91057](https://psxdatacenter.com/games/J/C/SCPS-91057.html) |
| P13 | Metal Gear Solid | `ntsc-uc` | gap | SLUS-00594, SLUS-00776 | Standard | 2 | **B**: package code. Date 1998-10-21 | [PSXDataCenter SLUS-00594](https://psxdatacenter.com/games/U/M/SLUS-00594.html) |

**Left out on purpose:**
- Final Fantasy VII's second Japanese serial set (SCPS-45007–9), which is unexplained.
- Final Fantasy VII International, whose Ultimate Hits serials conflict within one source.
- Crash Bandicoot's US Greatest Hits, for the same reason as P3.

**Wikidata ids.** No Wikidata item id is claimed here. They are found and checked when games are imported in M11b-2.

**Where releases come from.** No release enters the catalog from a No-Intro entry. Editors build every release from the item-level sources above. NES and SNES dumps can then support `software`, serial and language facts through MIG-5 links, once MIG-5 is implemented and No-Intro's conditions (M11b-D2) are met.

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
   - links source records to the exact facts they support (MIG-5), never to a box, edition or retail region;
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
| No-Intro entries treated as physical releases | One ROM merges several packages, or invents country variants | Held entries (proved in M11b-1a). Editors build releases from item-level sources. MIG-5 links a dump only to `software`, serial and language facts, possibly on several releases |
| Product-code traps (shared reprint serials, suffix meanings, combined codes, source typos) | Wrong releases or false merges | Codes are evidence only. Printed form wins. Conflicts held |
| Wrong serial in an automated summary | Wrong release identity | Verify every serial on its own detail page (a summary paired Crash Bandicoot with the Crash 2 serial) |
| Date conflicts | False precision | Keep only the agreed precision |
| Artwork or labels reach the catalog through a source | D15 breach | No image fields are read. No covers, logos, screenshots, scans or label images |
| Only one staff member available | Self-review impossible | Two disposable editors on the test stack. Decide who reviews on development |
| Reclassifying existing SNES releases | Re-verification work, and possible conflicts under the stricter normalized key | Each release individually verified, never in bulk. MIG-2 and MIG-3 abort on any collision instead of changing data. Development has none today |

### Decisions needed

| # | Decision | Status after the M11b-0 review (2026-11-18) |
| --- | --- | --- |
| M11b-D1 | Wikidata for game identity | **Approved.** Clearance is recorded by an operator in M11b-2 with a saved terms copy |
| M11b-D2 | No-Intro metadata | **Conditionally approved**: metadata only, respecting its terms and permitted access (manual saved downloads). Still open: a person accepts the gate and confirms what an NES and SNES record holds |
| M11b-D3 | Redump | **Held** pending clarification of rights and access conditions |
| M11b-D4 | Explicit cartridge differences, one platform per family | **Approved** with the identifiers `famicom-cartridge`, `nes-game-pak`, `snes-cartridge-jp-pal`, `snes-game-pak-na`. Implemented in M11b-1a; on development since PR #16 |
| M11b-D5 | Controlled packaging vocabulary | **Approved and implemented** (M11b-1b) with `cardboard-box`, `jewel-case`, `double-depth-jewel-case`, `plastic-case`, `paper-sleeve`, `unclassified` and `unknown`; no `big-box` or multi-disc type |
| M11b-D6 | Video standard column | **Approved: not now** |
| M11b-D7 | Release identifiers (MIG-4) | **Cancelled.** Not to be revived in M12c |
| M11b-D8 | Source evidence links (MIG-5) | Revised design in section 6, for review. Not to be implemented before that review |
| M11b-D9 | MIG-2 and MIG-3 as one collision-safe migration | **Approved and implemented** (M11b-1b); on development since PR #16 |
| M11b-D10 | The pilot list in section 8 | **Accepted as a review candidate, not an approved import.** The final selection is approved before any development import |
| M11b-D11 | Who reviews on development | Open. No-self-review and every staff publication protection are kept (approved). No permanent Owner account is created for it |
| M11b-D12 | The 16 existing development SNES releases | **Not modified without individual verification** (approved). No bulk reclassification |

## 11. Recommended implementation sequence

Each step is a checkpoint, stopped for review.

1. **M11b-1a, media formats.** MIG-1, importer behavior proof, test updates. **Done** (2026-11-18), and on development since PR #16.
2. **M11b-1b, identity and packaging.** **Done on the test stack** (2026-11-18): MIG-2 and MIG-3 as one migration, the exact-key preflight (proved through the CLI, and on a restored copy of development), the publication trigger, the packaging selects, tests and focused mutations. On development since PR #16.
3. **M11b-1c, identifiers and source links.** MIG-4 is cancelled and MIG-5 isn't implemented. The importer's Wikidata platform ids were added in M12c-A; the NES No-Intro parser test is still open.
4. **M11b-1 on development.** **Done**: M11b-1a and M11b-1b were applied with PR #16, behind a backup and restore check.
Steps 5 to 7 became the M12c-A pilot, on the test stack ([catalog-pilot-m12c.md](catalog-pilot-m12c.md)):

5. **M11b-2, NES / Famicom pilot.**
   - Clearance, snapshots and a fixed-id import on the test stack.
   - Editor A builds the candidates and editor B reviews.
   - A report, then the approved load into development.
6. **M11b-3, SNES / Super Famicom pilot.** The same. Existing development SNES releases change only by individual, verified correction (D12).
7. **M11b-4, PlayStation pilot.** Wikidata games plus editor-entered releases. Disc serials stay in each release's evidence (MIG-4 is cancelled), and Redump only if cleared.
8. **M11b-5, quality.**
   - A duplicate audit across the three platforms.
   - Search checks on localized titles and codes.
   - Review of the held entries.
   - The collection paging improvement noted after M11a (about 250 ms per page at 50,000 copies).
