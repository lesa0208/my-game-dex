# M12c-B0: metadata providers, licensing and bulk catalog acquisition

**Written for:** the product owner deciding how My Game Dex gets a large, legally usable catalog, and the engineers who will build it.

**Status: research and proposal, 2026-11-20. The product owner's decisions are recorded in [section 8](#8-decisions-recorded-2026-11-20), and the next milestone is proposed in [catalog-ingestion-m12c-b1.md](catalog-ingestion-m12c-b1.md).** Revised the same day: the IGDB findings now record the conflict between IGDB's partnership FAQ and the Twitch agreement.
- Baseline `main` at `f3eea87` (PR #17).
- Nothing was integrated, registered, downloaded in bulk or imported.
- No message was sent, and no terms were accepted.
- Development and the test pilot are unchanged.

**Not legal advice.** Every conclusion below is a reading of public terms. Anything commercial is confirmed in writing by the provider, and reviewed by a lawyer before launch.

Related: [ADR-015](architecture-decisions.md#adr-015-metadata-providers-are-replaceable-adapters) (providers are adapters), [physical-catalog-m11b.md](physical-catalog-m11b.md), [catalog-discovery-m12.md](catalog-discovery-m12.md), [catalog-pilot-m12c.md](catalog-pilot-m12c.md), [security-rls.md § Catalog import](security-rls.md#catalog-import).

## Summary

1. **Primary game-level source: Wikidata (decided, D-1).**
   - It is the only source whose terms already allow everything we need: commercial use, bulk import, indefinite storage, public serving and keeping the data forever. Its structured data is CC0, with official weekly JSON dumps.
   - It is already cleared for game identity (M11b-D1), and the importer already reads it.
   - Its weakness is coverage and consistency per platform, not licensing.
2. **IGDB: a strong candidate, pending written confirmation of the partnership terms.**
   - **IGDB's own FAQ** in its API docs allows storing and keeping the data. It says:
     - "Am I allowed to store/cache the data locally? Yes. In fact, we prefer if you store and serve the data to your end users";
     - on partnership termination, "You are allowed to keep all data you retrieve from the API and we will not ask you to remove the data".
   - **The Twitch Developer Services Agreement** points the other way. The IGDB docs place the API under it, and it limits caching to 24 hours without written authorization, requires deleting data on termination, and prohibits redistribution.
   - **The two conflict.** Which governs a partner is exactly what the partnership must confirm in writing. IGDB is not unsuitable; it is unconfirmed.
   - The product owner has written to partner@igdb.com. No credentials are requested and no data is taken until the terms are confirmed in writing and reviewed (D-8).
3. **MobyGames: the most promising commercial source for regional releases.** It documents releases by country with product codes. Its terms couldn't be read (the site blocks automated access), so it is a written enquiry, not a plan.
4. **Physical releases have no ready-made licensed bulk source.**
   - No-Intro's data licence is explicitly commercial and needs no attribution, but its data describes ROM dumps, not retail packages.
   - Redump, GameTDB and VGCollect have the best retail fields, and none publishes reuse terms for a commercial product.
   - Physical releases keep coming from human editors citing item-level sources, collector submissions, and written permissions as they arrive.
5. **TheGamesDB stays held** (no published terms). **ScreenScraper stays out** of commercial use (CC BY-NC-SA 4.0, API for free apps only). **RAWG and Giant Bomb don't fit** a stored catalog.
6. **The importer can do a controlled bulk import of game identities,** with three gaps to close first: an entity parser and fetch for selected Wikidata items (which also reads the dump later), publishing game identities at scale, and update handling (below).
7. **First volume (decided, D-5):** a controlled SNES pilot of about 100 to 200 game identities (150 proposed), reviewed in full. The larger SNES set (about 1,430 items in the November snapshot) follows only after the pilot's quality review. Nothing is imported into development. The exact scope is in [catalog-ingestion-m12c-b1.md](catalog-ingestion-m12c-b1.md#3-the-first-snes-import-exact-scope-d-5).

## 1. Two catalog layers

| Layer | What it is | Who can supply it | Never inferred from |
| --- | --- | --- | --- |
| **A. Game identity** | Title, aliases and localized titles, kind (game, compilation, expansion), platforms, first release date, developer and publisher | Wikidata (CC0). IGDB or MobyGames, under a written licence | — |
| **B. Physical release** | Region (PAL, NTSC-U/C, NTSC-J…), edition and reprint line, variant, printed product code, barcode, cartridge shell or disc format, media count, packaging, markets | Human editors citing item-level sources. Collector submissions, reviewed. Licensed per-source data where written permission exists | A game's platform list, a release date by region, a ROM dump name, a code pattern, a cover image |

**A platform-level game entry is never evidence of a retail release.**
- That Wikidata or IGDB lists a game on the SNES says the game exists there.
- It doesn't say which packages exist, in which regions, or with which codes (M11b-0 § 8, ADR-015 rule 7).

**Layer A today supplies only the title, kind, summary and first date.** The `games` table has no developer, publisher or genre columns. Adding them is a separate design decision.

## 2. Provider comparison

Evidence was read on 2026-11-19 and 2026-11-20. Pages fetched directly are saved outside the repository in `~/.my-game-dex/source-evidence/2026-11-20/` with their SHA-256. Where a site blocked automated access (HTTP 403), the finding is marked **unverified**: it is based only on search-engine extracts, and needs a person to read the page in a browser.

Verdicts: **Confirmed** (the terms allow it), **Prohibited**, **Unclear**, **Written** (needs written permission).

### Game identity (layer A)

| Question | Wikidata | IGDB | MobyGames *(unverified)* | TheGamesDB | ScreenScraper | RAWG | Giant Bomb *(unverified)* |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Commercial use | **Confirmed**: dumps "can be used for personal or commercial use" | **Written**: the docs say the API "is free for both non-commercial and commercial projects", and that monetized products take a partnership | **Written**: paid commercial tiers reported, not seen | **Unclear**: no terms published | **Prohibited**: API only in "applications entièrement gratuites" (completely free applications), site under CC BY-NC-SA 4.0 | **Confirmed within limits**, but contradictory: terms say free commercial use within 20,000 requests a month, while the plan table says "Non-commercial projects only" | **Prohibited** (reported) |
| Import into our database | **Confirmed** | **Conflict, written confirmation needed**: the FAQ says "Yes … we prefer if you store and serve the data to your end users"; the Twitch agreement says "cache such information for only a twenty-four hour time period" unless authorized in writing | **Written**: storage reportedly recommended | **Unclear** | **Prohibited** | **Written**: no copying "without our prior express written consent" | **Unclear** |
| Bulk dump | **Confirmed**: weekly JSON (`latest-all.json.gz`, about 157 GB) | **Written**: daily CSV dumps "exclusively available to our Data Partners" | None found | **Unclear**: a "private key" for mirroring is reported | **Prohibited** | **Written**: enterprise "Downloadable file api" | None found |
| Store indefinitely | **Confirmed** (CC0) | **Conflict, written confirmation needed** (as above) | **Unclear** | **Unclear** | **Prohibited** | **Unclear** | **Unclear** |
| Serve publicly | **Confirmed** | **Conflict, written confirmation needed**: the FAQ prefers that you "store and serve the data to your end users", with fair, static attribution; the Twitch agreement prohibits "re-syndication and re-distribution" | **Written**: "cannot compete … cannot repackage" reported | **Unclear** | **Prohibited** | **Prohibited** beyond the project's own pages: "No data redistribution" | **Unclear** |
| Keep after the relationship ends | **Confirmed** | **Conflict, written confirmation needed**: the FAQ says "You are allowed to keep all data you retrieve … in case of partnership termination"; the Twitch agreement says "delete all Twitch Data collected upon termination" | **Unclear** | **Unclear** | **Prohibited** | **Unclear** | **Unclear** |
| Attribution | Requested, not required ("we would greatly appreciate it") | **Required**: "user facing attribution to IGDB.com" for partners | **Required** (reported): "Data by MobyGames.com" | **Unclear** | Required by the licence | **Required**: a link on every page using the data | **Unclear** |
| Keys, contract, price | None for dumps. A User-Agent with contact information for the APIs | A Twitch developer app with 2FA. A partner agreement for commercial use and dumps; price not published | API key and a paid plan, reported at $99.99 to $4,999.99 a month | Signed-in API key. A paid allowance increase | Developer credentials through its forum, plus quotas | API key; Business plan $149 a month; Enterprise by contact | A free key, non-commercial |
| Limits and updates | Query Service: 60 s per query, 5 parallel queries. API limits are new in 2026. Weekly dumps, daily incremental XML, a recent-changes stream | 4 requests a second, 8 open requests. Webhooks for added, updated and deleted records. `updated_at` on every record | Rate by plan (reported) | Monthly allowance | Per-user quotas; 429 and 430 errors | 20,000 to 1,000,000 requests a month, changeable at will. An `updated` filter | Reportedly 400 requests per 15 minutes |
| Text and images | Structured data CC0. Commons media is licensed per file, not CC0 | No licence granted for summaries or images. "Twitch, its licensors, and its end users retain all … rights" | Images need written permission (reported) | Unclear | Media credited to third parties | "We do not claim ownership of any of the images or data" | Unclear |
| Evidence | [Database download](https://www.wikidata.org/wiki/Wikidata:Database_download), [Data access](https://www.wikidata.org/wiki/Wikidata:Data_access), [Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing) | [API docs](https://api-docs.igdb.com/), [Twitch Developer Services Agreement](https://legal.twitch.com/legal/developer-agreement/) | [API](https://www.mobygames.com/info/api/), [terms](https://www.mobygames.com/info/terms/) (403) | [Site](https://thegamesdb.net/), [API](https://api.thegamesdb.net/) | [webapi2](https://www.screenscraper.fr/webapi2.php) | [Terms](https://rawg.io/tos_api), [plans](https://rawg.io/apidocs) | [API](https://www.giantbomb.com/api/) (403) |

**IGDB in detail.**
- **The FAQ** is in the commercial-partnership part of the [API docs](https://api-docs.igdb.com/), saved 2026-11-20 (SHA-256 `18579023…07178d2`). It allows storing and serving data, and keeping it after partnership termination. It asks for "fair attribution … visible to your users and located in a static location".
- **The Twitch Developer Services Agreement** ([legal.twitch.com](https://legal.twitch.com/legal/developer-agreement/), saved rendered copy `8fbde374…a13332d`) says otherwise:
  - its Schedule 1 allows a 24-hour cache without written authorization, and prohibits re-syndication;
  - its §VI requires deleting Twitch Data on termination.
  - Whether Schedule 1, which defines Twitch APIs by dev.twitch.tv, applies to IGDB is itself unclear.
- **The earlier B0 reading** marked storage and retention "prohibited by default". That overstated it: the provider's own FAQ says the opposite for partners, so the accurate status is a conflict to resolve in writing.
- A partnership must state, in writing, which terms govern, and confirm:
  - indefinite storage;
  - public display;
  - keeping data after termination;
  - the attribution wording;
  - what applies to summaries and images.
- IGDB also has `release_dates` with a release region, `game_localizations` and `game_versions`, but no barcode or product code field. That is useful context for layer B, not proof of a package.

**Wikidata in detail.**
- The Query Service split into a main graph and a scholarly graph on 9 May 2025, and video games are in the main graph.
- It was rate-limiting clients to one request a minute during an outage on 2026-11-19.
- For more than a few thousand items, Wikidata's own guidance is to use the dumps, not the Query Service.
- Wikimedia Enterprise offers free and paid tiers if higher volumes or a service-level agreement are ever needed.

### Physical-release evidence (layer B)

| Source | Physical fields it documents | Terms for our use | Status |
| --- | --- | --- | --- |
| **No-Intro DAT-o-MATIC** | ROM dump per entry: region and language tags, a serial where stated. Not packages | Data Usage License: commercial use and "projects that are sold", "No permission, attribution, citation, backlink … required", to the extent the operator controls the rights. Unchanged since 2026-11-18 (same hash). The site gate and download access still need a person to accept and check | Usable for **supporting** facts (serial, language) only, never as a release (M11b-D2) |
| **Redump** | Disc serial, edition, version, region, languages, verified status. Discs only | No licence on redump.info. robots.txt disallows bulk paths. redump.org was unreachable | **Written** permission needed (GitHub issues, forum, Discord). Human citation meanwhile |
| **GameTDB** | Disc IDs by region for Nintendo and some Sony systems | FAQ: "anyone to use in any game-related project", and "please add a link". But for a website: "Please do not use without permission" | **Written** permission needed. Its artwork is third-party |
| **VGCollect** | Region suffix, printed item number, barcode | No terms page (404) and no API. Contact: "matt at vgcollect.com" | **Written** permission needed |
| **MobyGames releases** *(unverified)* | Countries, publishers and product codes per platform release | As layer A | **Written** |
| **Specialist sites** (SNES Central, PSXDataCenter, NesCartDB, MarioWiki) | Item-level: label codes, scans, disc serials, back-cover barcodes | No reuse licence. NesCartDB refuses AI agents | **Human citation only**, one fact at a time (M12c-A) |
| **PriceCharting** *(unverified)* | UPC for some items; regions as separate categories; price-focused | Data "licensed for internal use only"; "purged after your subscription has ended" (reported) | **Not viable** without a commercial agreement |
| **UPCitemdb** | Generic barcode lookup, no region or edition | "solely for Customer's operations". Free 100 lookups a day; $99 or $699 a month | Confirms a barcode only. Storage and redistribution unclear |
| **GS1 (Verified by GS1)** | Brand owner's barcode records; old games often missing | Through a national GS1 member organization; terms permit only what they state | Not a catalog source |
| **LaunchBox Games DB** | Dates and ratings; no codes | "All rights reserved"; no data licence found | No |

**Images.** No source grants rights to cover art, box scans, label images or screenshots that would let us store or show them. Artwork stays blocked until D15 is decided.

## 3. Blockers

| Blocker | Kind | What clears it |
| --- | --- | --- |
| IGDB's FAQ allows storing and keeping data, but the Twitch agreement it points to limits caching to 24 hours and requires deletion on termination | Legal | Written confirmation from IGDB of the partnership terms that govern (requested by the product owner), then legal review (D-8) |
| MobyGames, PriceCharting and Giant Bomb terms couldn't be read (403 to automated clients) | Evidence | The product owner reads them in a browser, and writes to the provider |
| No commercial licence for any retail-package dataset (Redump, GameTDB, VGCollect) | Legal | Written permission, per source |
| TheGamesDB publishes no terms | Legal | Written terms from its staff (Discord) |
| A game is public only with a published, verified release | Product and technical | A decision on publishing game identities at scale (decision D-3) |
| Editors verify one record at a time | Process | A sampling policy for layer A (decision D-4); layer B stays per item |
| The Wikidata path reads one Query Service result per platform, with only a few fields | Technical | An entity parser and targeted `wbgetentities` fetch; the same parser streams the dump if ever needed (B1 steps 1 and 2) |
| No developer, publisher or genre fields; no image provenance (`images_cleared` is described in ADR-015 but doesn't exist) | Technical | Separate designs, only if wanted |

## 4. The existing importer, against bulk ingestion

**What already supports it (M5b, M10d, M11b, M12c-A):**
- **A restricted role.** `catalog_importer` can call eight audited functions and nothing else. It never verifies or publishes.
- **Clearance gates.** Each run is bound to a cleared provider and the hash of the reviewed terms. Withdrawing clearance stops runs.
- **Snapshots and resumable runs.** One run per snapshot, with its hash. Batches of 200 entries (the database takes up to 500). Leases, checkpoints and resume after a stop.
- **Provenance.**
  - Every source record is kept, unchanged, with its hash.
  - `external_references` maps provider ids to our ids, and "our IDs are ours" (ADR-015).
  - Release evidence is recorded per field. Audit rows carry the run and the reason.
- **Matching and duplicates.**
  - Source ids are resolved first.
  - Normalized title keys cover articles, Roman numerals and word breaks, giving tiers A, B and C.
  - Possible duplicates are held as `needs_review`.
  - Private submissions are invisible to matching.
- **Protecting verified facts.** An import fills only empty, unlocked fields of records nobody verified, and never touches a published, merged, excluded or rejected record. Field locks hold.
- **Held and ignored entries,** and reclassification when a later snapshot changes its mind.
- **Reports and admin pages** for runs and their records (M10d).
- **Proven at pilot scale:**
  - 8 games through the full flow (M12c-A);
  - three platform snapshots of 1,216 to 2,446 items parsed.

**Gaps for a large catalog:**

| Gap | Why it matters | Proposed fix |
| --- | --- | --- |
| Wikidata comes from one Query Service result per platform | Large results time out or hit limits, and the service had an outage. It also returns only a few fields | An entity parser and a fetch of selected items with `wbgetentities` (50 per request), producing the same entry shape as today. The same parser can stream the weekly JSON dump (157 GB compressed) if targeted fetching ever proves insufficient ([B1 § 5](catalog-ingestion-m12c-b1.md#5-storage-and-resources)) |
| Four platforms have Wikidata items | The catalog has 59 | Map and check each platform's Wikidata item, as M12c-A did for four |
| Game fields are title, aliases, Japanese titles and first date only | Developer and publisher are often what tells same-titled games apart | Optionally stage them in the source record payload (no schema change), and decide later whether the catalog stores them |
| A game is public only through a published, verified release | Thousands of game identities would be invisible to collectors. Unidentified copies need a published game | Decision D-3. If approved, a later milestone lets an editor publish a verified game identity with its pairing, with no release, labelled as having no verified physical release yet |
| Verification is per record | Verifying 10,000 games one at a time isn't practical | Decision D-4: for layer A only, an editor verifies a statistically sampled batch with a recorded acceptance threshold, rather than each record. It needs a design for batch verification with an audit trail, and keeps the no-self-review rule. Layer B stays per item |
| Re-imports only fill empty fields | A source correction to an unverified field is never picked up | Report the differences per run for an editor to apply, rather than overwrite. Verified, locked and published fields never change |
| Throughput is untested at scale | `apply_record` runs once per entry over the connection | Measure on the scratch stack (phase 2), and batch if needed |
| Cross-provider matching | Wikidata already carries external ids such as the IGDB game ID (P5794) and the MobyGames game ID (P11688; P1933 is its former scheme) | Use those CC0 identifiers to match a later licensed provider to our games, without copying the provider's data |
| Release evidence from several sources | MIG-5 isn't implemented, so staff evidence is free text | Keep the M12c-A editor evidence note. Revisit MIG-5 only if licensed release data arrives |

## 5. Staged acquisition plan

Each phase ends in a checkpoint for the product owner. Nothing runs on development until the test-stack phase is approved, and then only behind a backup and restore check.

| Phase | What | Exit criteria |
| --- | --- | --- |
| **0. Authorized access** | Wikidata's clearance stands (M11b-D1). Send the outreach below; record every answer and saved terms in this document. No other provider is cleared without its written terms | Written answers, or a decision to proceed on Wikidata alone |
| **1. Entity parser, fetch command and platform map** | A parser for Wikidata entity JSON (the shape of both `wbgetentities` and the weekly dump), and a fetch command for selected items. Map the Wikidata items of the pilot platforms first (`nes`, `snes`, `playstation`, `famicom-disk-system`), then the rest. The dump itself isn't downloaded ([B1 § 5](catalog-ingestion-m12c-b1.md#5-storage-and-resources)) | Parser output identical to the existing parser's for the same items |
| **2. Controlled SNES pilot** | About 100 to 200 identities (150 proposed), selected as in [B1 § 3](catalog-ingestion-m12c-b1.md#3-the-first-snes-import-exact-scope-d-5), all unpublished candidates, reviewed in full (a census). Then the larger SNES set, by exception review and sampling | The quality checks below, and B1's sampling plan for larger batches |
| **3. Duplicates and provenance** | Review the run report: `needs_review` duplicates, word-break and main-title suggestions, ignored and held entries. Resolve duplicates through the existing merge and reject tools | Duplicate rate and held reasons are understood, and each fix is recorded |
| **4. Editorial review** | A sampled audit of game identities (decision D-4); physical releases keep per-item review | The acceptance threshold is met, and the sample is recorded |
| **5. Larger incremental imports** | Platform by platform: the pilot platforms, then the rest. Each run is a reviewed checkpoint | Each run meets the same checks |
| **6. Periodic updates** | A weekly or monthly dump. New items arrive as candidates. Changes to unverified fields are reported, not applied. Verified, locked and published facts never change | A clean diff report per update |

**Quality checks for the first import.** Thresholds are proposals for the product owner:

| Check | Target |
| --- | --- |
| Entries with a title (English or `mul`) | ≥ 99% |
| Entries with a first release date at year precision or better | ≥ 90% (a gap, not a failure) |
| Exact or word-break duplicates within the run, and with the existing catalog | < 1%, every one listed for review |
| Non-games or wrong kinds (DLC, ports wrongly split, compilations) | Every one found in the pilot's census is excluded, and traced to a validator |
| Identity correct: title, platform and date checked against a second source | Pilot: counted exactly (census). Larger batches: by the acceptance plan in [B1 § 4](catalog-ingestion-m12c-b1.md#4-validation-and-sampling). A sample's observed rate is never reported as the batch's accuracy: 98 correct of 100 shows at least 93.8% at 95% confidence |
| Entries that create a release | 0 (game identity only) |
| Published or verified by the import | 0 |
| Run completes, and resumes after a forced stop | Yes, with each entry once |
| Time per entry | Recorded, to size later runs |

## 6. Provider outreach

**Contacts:**

| Provider | Channel | Source |
| --- | --- | --- |
| IGDB | partner@igdb.com | [IGDB API docs, Partnership](https://api-docs.igdb.com/#partnership) |
| MobyGames | Not confirmed: the official pages blocked automated access | A person opens https://www.mobygames.com/info/api/ and the site's contact page in a browser |
| TheGamesDB | Discord, https://discord.gg/2gxeAURxmA (the site's "Contact us") | [thegamesdb.net](https://thegamesdb.net/) |
| ScreenScraper | Discord, https://discord.gg/fpAAgN4FFF (#support), or the forum | [screenscraper.fr](https://www.screenscraper.fr/) |
| RAWG | api@rawg.io | RAWG's OpenAPI description (https://api.rawg.io/docs/?format=openapi) |
| Redump | GitHub issues (https://github.com/superg/vgindex/issues), forum.redump.info, Discord | [redump.info](https://redump.info/) |
| GameTDB | The site's contact page ("Please contact us to let us know about your project") | [GameTDB FAQ](https://www.gametdb.com/Main/FAQ) |
| VGCollect | matt at vgcollect.com | [VGCollect privacy page](https://www.vgcollect.com/privacy) |
| Wikimedia Enterprise | Web form, only if volume or a service-level agreement is ever needed | https://enterprise.wikimedia.com/contact/ |

**Not to send yet.** These are drafts for the product owner to send from their own address, with the bracketed parts filled in.

### IGDB (priority)

> **Subject:** Commercial data partnership enquiry: physical game collection app
>
> Hello IGDB team,
>
> We are building [product name], a collection manager for physical video games (cartridges and discs), which may become a commercial product. We would like to discuss a data partnership.
>
> Our model: we keep our own normalized catalog in our database, with our own identifiers. Users never trigger live API calls, and every record is reviewed by our editors before it is shown.
>
> Could you tell us:
> 1. Whether a partnership would allow us to import IGDB game metadata (titles, alternative names, platforms, release dates, companies) into our database, store it indefinitely, and show it publicly in our app and website.
> 2. Whether we may keep data already imported if the partnership ends, and what would have to be deleted.
> 3. Access to the daily CSV data dumps, and how often schemas change.
> 4. Pricing or eligibility criteria, and the attribution wording you require.
> 5. Rate limits for partners, and whether webhooks are available to partners.
> 6. Whether summaries, cover art and screenshots are covered, or licensed separately or not at all. We do not plan to use images without explicit rights.
> 7. Any restriction on combining IGDB data with CC0 data from Wikidata.
>
> We can share more about expected volume (initially about [N] games on [platforms]) and our attribution design.
>
> Kind regards,
> [name], [role], [company]

### MobyGames

> **Subject:** Commercial licence enquiry: game and release data for a physical collection app
>
> Hello,
>
> We are building [product name], a collection manager for physical video games, which may become a commercial product. MobyGames' release data (countries, publishers and product codes per platform) is the closest match to what our collectors need.
>
> Could you tell us:
> 1. Which plan, or a separate licence, permits commercial use where the data is stored in our own database and shown publicly in our app.
> 2. Whether stored data may be kept indefinitely, including after a subscription ends.
> 3. Whether a bulk export or dataset licence is available, instead of per-request API access.
> 4. Which release fields are available through the API (countries, product codes, barcode types, edition or packaging notes).
> 5. Attribution requirements, and how "competing with MobyGames" is interpreted for a collection manager.
> 6. Whether cover art or screenshots are ever licensable, or excluded.
> 7. Pricing and rate limits for the relevant tier.
>
> Kind regards,
> [name], [role], [company]

### Physical-release databases (Redump, GameTDB, VGCollect)

> **Subject:** Permission request: using [source] release data in a physical game collection app
>
> Hello,
>
> We are building [product name], a collection manager for physical video games, which may become a commercial product. Our editors document each retail release (region, edition, printed product code, barcode, media count) and cite their sources.
>
> We would like to ask whether you would permit:
> 1. our editors citing individual [source] entries, with a link, as evidence for a release record;
> 2. importing specific fields ([serial, region, edition, barcode]) for [platforms] into our database, kept indefinitely and shown publicly, with attribution of your choosing;
> 3. if so, a preferred way to obtain the data (export, API), and any rate or volume limits.
>
> We would not use any images, hashes or dump files, only the descriptive fields above. We are happy to credit [source] in the way you prefer, and to report corrections back.
>
> Kind regards,
> [name], [role], [company]

TheGamesDB, ScreenScraper and RAWG get the same questions as the MobyGames letter, if the product owner wants to pursue them. ScreenScraper's terms make a commercial licence unlikely, and RAWG has no physical-release data.

## 7. Recommendation

1. **Primary game-identity source: Wikidata (decided, D-1),** by targeted extraction of selected items. The dump is kept for later, if needed. Proceed with B1 on Wikidata alone: it needs no new licence, and it proves the path end to end.
2. **Pursue IGDB in parallel** (the product owner has written to partner@igdb.com), as the candidate second source for coverage and structure. Wait for written partnership terms that resolve the FAQ and agreement conflict. Our ids stay ours, and Wikidata's IGDB ids can match the two.
3. **Physical releases:**
   - **Editors first.** Keep editor-built releases from item-level sources, reviewed one at a time.
   - **Collectors.** Collector submissions add more, through review.
   - **Per-source permission.** Ask MobyGames, Redump, GameTDB and VGCollect, and import nothing until one answers in writing.
   - **No-Intro.** Its data may add serial and language facts, never a release.
4. **No artwork** from any source until D15.

## 8. Decisions recorded (2026-11-20)

| # | Decision | Recorded |
| --- | --- | --- |
| D-1 | Primary game-level source | **Wikidata (CC0)** for initial game identities. IGDB is a high-priority potential partner; the product owner emailed partner@igdb.com and awaits a reply |
| D-2 | Outreach | **Prepared, not sent,** for MobyGames and selected physical-release providers (section 6) |
| D-3 | Identity without a physical release | **Design approved:** a reviewed game identity can be published without a published release, and never implies a verified retail edition. Designed in [catalog-ingestion-m12c-b1.md § 1](catalog-ingestion-m12c-b1.md#1-game-identities-and-physical-releases-published-separately) |
| D-4 | Scalable identity review | **Design approved:** automated validation, random sampling, risk-based exception review and explicit human approval. Physical releases are never approved automatically. [B1 § 2 and § 4](catalog-ingestion-m12c-b1.md#2-reviewing-identities-at-scale-d-4) |
| D-5 | First import | **A controlled SNES pilot of about 100 to 200 identities,** then the larger SNES set after quality review. No bulk import into development |
| D-6 | Developer, publisher, genre | **Planned as optional metadata with provenance,** not a prerequisite. Staged in source records first |
| D-7 | Wikimedia contact | **No invented contact and no personal information.** The project contact is configured in `WIKIDATA_USER_AGENT` by the product owner ([B1 § 5](catalog-ingestion-m12c-b1.md#configuration-the-wikimedia-contact-d-7)) |
| D-8 | Legal review | **Required** before a commercial launch, or before accepting any data provider's contractual terms |
