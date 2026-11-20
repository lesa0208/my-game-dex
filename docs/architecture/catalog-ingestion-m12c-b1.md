# M12c-B1 (proposal): game identities from Wikidata, reviewed at scale

**Written for:** the product owner approving M12c-B1, and the engineers who will build it.

**Status, 2026-11-20: proposal, not implemented.**
- No migration, import or download beyond what is listed under [Measured](#measured).
- Development and the human-reviewed test pilot are unchanged.

Related: [catalog-acquisition-m12c-b0.md](catalog-acquisition-m12c-b0.md) (providers and licensing), [catalog-pilot-m12c.md](catalog-pilot-m12c.md) (M12c-A), [ADR-015](architecture-decisions.md#adr-015-metadata-providers-are-replaceable-adapters), [security-rls.md § Catalog import](security-rls.md#catalog-import).

## The product owner's decisions (2026-11-20)

| # | Decision |
| --- | --- |
| D-1 | **Wikidata (CC0) is the initial source of game identities.** IGDB stays a high-priority potential partner: the product owner has written to partner@igdb.com and awaits a reply |
| D-2 | **Outreach is prepared, not sent,** for MobyGames and selected physical-release providers |
| D-3 | **Design publishing a reviewed game identity without a published physical release.** An identity never implies that any retail edition is verified |
| D-4 | **Design scalable identity review:** automated validation, random sampling, risk-based exception review and an explicit human approval. Physical releases are never approved automatically |
| D-5 | **A controlled SNES pilot of about 100 to 200 identities first,** then the larger SNES set after quality review. No bulk import into development |
| D-6 | **Plan optional developer, publisher and genre metadata with provenance.** Not needed for the first import |
| D-7 | **No invented Wikimedia contact,** and no personal information. Document where the project contact is configured |
| D-8 | **Legal review** before a commercial launch, or before accepting any provider's contractual terms |

## 1. Game identities and physical releases, published separately

### Why

Today a game becomes public only through `publish_release`, which publishes the game and its platform pairing together with the release. Search (`search_catalog`) shows a game only with at least one published, verified release. A large catalog of game identities would therefore stay invisible, even though the M12a unidentified copy (`can_claim`) only needs a published game.

### The two kinds of public fact

| | Game identity | Physical release |
| --- | --- | --- |
| **Says** | "This game exists, by this title, on this platform" | "This retail product exists: this region, edition, code, shell, media count and packaging" |
| **Evidence** | Wikidata (or a licensed provider), checked by validators and by a human, by sample and exception | An item-level source, checked by a human, item by item (M12c-A) |
| **Approval** | A batch approval by an editor who didn't create or import it (D-4) | `verify_release` and `publish_release`, one at a time, never automated |
| **Records** | `games`, `game_platforms` | `releases` |

### What collectors see

| Situation | Search | Game page | Fast add | Unidentified copy |
| --- | --- | --- | --- | --- |
| Identity published, no published release on that platform | Shown, labelled **"No verified physical release yet"** | Title, platform, first release; the label; no region or edition choices from the catalog | Goes straight to "Your own record": platform known, region and edition chosen or "Not sure" (M12a) | Allowed, as today |
| Identity published, with published releases | As today | As today, with the catalog's regions and editions | As today | As today |
| Not published | Never shown | Not found | — | — |

**The guarantee.** Nothing about a published identity names a region, edition, code, barcode, shell or packaging. Those come only from published releases. A release date from Wikidata is the game's first release, never a retail edition's date. Regional dates stay in the source record as context for editors.

### Proposed data model (one forward migration, B1-M1)

**`game_platforms` gains verification:**
- `verified_at`, `verified_by`, `revision`, as games and releases have.
- A pairing is published only after a verification of its current revision by someone other than whoever created it.
- Today a pairing has only a status, and is published as a side effect of its first release.

**The game's own status carries identity publication.**
- `games.status = 'published'` keeps its meaning.
- Whether a game or pairing has verified physical releases is derived (`exists` a published, verified release), never stored, so it can't drift.

**New editor functions**, each `SECURITY DEFINER`, with a reason, recent MFA, no self-review, the M7b-1 guard and audit rows:

| Function | Purpose |
| --- | --- |
| `verify_game_platform(game, platform, reason, expected_revision)` | Verify a pairing |
| `publish_game_identity(game, platforms[], reason, expected_revision)` | Publish a verified game and the verified pairings named. It never touches a release |

**Read functions replaced** with their exact signatures:
- `search_catalog` and `get_release_picker` include published identities with published pairings, and return `verified_release_count` per platform.
- Their response fields stay a fixed list, as M5c requires.

**Staff pages.** The game record shows the identity's status, its pairings' verification, and "No verified physical release yet" where it applies.

**Nothing changes for releases:**
- the identity key;
- the packaging and shell rules;
- `verify_release` and `publish_release`;
- merge and exclusion.

The existing path, publishing a release that publishes its game, stays.

## 2. Reviewing identities at scale (D-4)

### Batches (B1-M2)

**Tables,** private and reachable only through functions:
- `private.catalog_review_batches`: id, import run, platform, created by, created at, item count, a frozen content hash, sample seed, sample plan (size, acceptance number), status (`open`, `approved`, `rejected`), approver, decision time and reason.
- `private.catalog_review_batch_items`: batch, game, validator flags, sampled or not, outcome (`correct`, `incorrect`, `excluded`), reviewer, note.

**Functions:**

| Function | What it does |
| --- | --- |
| `create_review_batch` | Takes the run's unverified candidates on one platform, freezes the list and its hash, runs the validators, then draws the random sample with a seed generated after the list is frozen. Nobody can choose the sample |
| `record_batch_outcome` | Records a reviewer's verdict on an item |
| `approve_review_batch` | Allowed only when every flagged item and every sampled item has an outcome, and the sample is within its acceptance number. It verifies and identity-publishes the batch's correct and unflagged items, one audited verification per game, citing the batch. Excluded and incorrect items stay unpublished |
| `reject_review_batch` | Closes the batch. Its items stay candidates for a new batch, with a new sample |

**Rules:**
- **Who may approve.** The approver didn't create the batch and didn't create any of its games. Imported games have no human creator, so the rule is about the batch's creator.
- **What a batch may contain.** Only identities: a release in a batch is refused.
- **No resampling a failed batch.** A rejected batch is never sampled again until it passes. Its defects are fixed, the validator that missed them is improved, and a new batch is drawn.

## 3. The first SNES import: exact scope (D-5)

| | |
| --- | --- |
| **Where** | Built and tested on the scratch stack. The human review pilot runs on the isolated test stack (port 3002), where the reviewer account exists. New unpublished candidates there don't touch the M12c-A records. Never development |
| **Selection source** | The SNES Wikidata Query Service snapshot the importer fetched on 2026-11-19 (1,429 items, SHA-256 `ff4836552cf03f0b92c7908f67a281d12c0221b7223a1a02eb80755743e7bd6e`). It is already taken, under the existing clearance |
| **Selection (150 items)** | All 14 items in the snapshot's 7 title-key collisions (duplicate risk). The 3 SNES games already in the pilot (Super Mario World, A Link to the Past, Super Metroid), to prove they are matched, not duplicated. 133 more drawn at random with a recorded seed |
| **Detail fetch** | `wbgetentities` for the 150 items, 3 requests of 50, with `props=labels\|aliases\|claims` (no sitelinks), saved as one entity snapshot with its hash. This is the same JSON shape as the weekly dump, so the parser written for it also reads the dump later |
| **Into the catalog** | Title (`en`, else `mul`), sort title, kind (`game`), first release date at its precision, and the SNES pairing only (a game's other platforms are noted, not paired) |
| **Into the source record only** | All platforms (P400), dates with qualifiers (P577 with P400, P291, P750), developer (P178), publisher (P123), genre (P136), Japanese labels and romanization (P2125), IGDB game id (P5794) and MobyGames game id (P11688; P1933 is the former scheme). These are CC0 values: storing an IGDB or MobyGames id isn't using that provider's data |
| **Created** | Game candidates and SNES pairings, unpublished and unverified. **No releases** |
| **Reviewed** | All 150 by a human (a census, not a sample): every item is checked, which calibrates the validators before any sampling is relied on |
| **Published** | Only through `approve_review_batch` (after B1-M1 and B1-M2), by the product owner as editor B |

**Excluded from publication in the pilot, held for an editor:**
- Satellaview broadcasts and other non-cartridge distribution;
- unreleased or cancelled games;
- unlicensed and homebrew items;
- items whose kind isn't plainly a game.

The validators flag each of these.

## 4. Validation and sampling

### Automated validators

They run in the import and again when a batch is created.

| Kind | Check | Effect |
| --- | --- | --- |
| Hard | No title in `en` or `mul`; not an instance of video game; not on the run's platform | The entry is ignored, never a candidate |
| Hard | The source id is already linked to another game | Resolved to that game (existing rule 6) |
| Flag | Title-key, word-break or main-title collision with the run or the catalog | Exception review |
| Flag | No date, or year precision only | Exception review |
| Flag | First date earlier than the platform's launch, or much later than its active years | Exception review (a port, re-release, homebrew or bad data) |
| Flag | More than one P31, or a P31 suggesting a compilation, expansion, edition or cancelled game | Exception review |
| Flag | Satellaview, unlicensed or homebrew indicators | Exception review, excluded from the pilot |
| Flag | `mul` label only, no English label | Exception review of the title's language |

### Census for the pilot, sampling after

- **Pilot (150):** every item is reviewed. The result is the pilot's exact error count, not an estimate. Each error is traced to a validator that should have caught it.
- **A larger batch** (the remaining SNES set, about 1,280):
  - **Exceptions:** 100% of flagged items are reviewed.
  - **Sample:** a random sample of the unflagged items is checked against the acceptance plan.
  - **Approval:** a human approves the batch only on that evidence.

### What a sample proves

**An observed rate is not a guarantee.** 98 correct out of 100 is an observed 98%. With 95% confidence (one-sided, exact Clopper–Pearson), it only shows the true accuracy is **at least 93.8%**. Computed for this plan:

| Sample result | Observed | True accuracy is at least (95% confidence) |
| --- | --- | --- |
| 98 / 100 | 98.0% | 93.8% |
| 100 / 100 | 100% | 97.0% |
| 147 / 150 | 98.0% | 94.9% |
| 149 / 150 | 99.3% | 96.9% |
| 150 / 150 | 100% | 98.0% |
| 234 / 236 | 99.2% | 97.4% |

**Acceptance plan (proposed).** The goal: a batch whose unflagged items contain 2% or more errors is rejected, with at least 95% probability. Computed exactly with the hypergeometric distribution for the lot size:

| Unflagged lot | Allowed errors in sample (c) | Sample size |
| --- | --- | --- |
| 1,279 | 0 | 138 |
| 1,279 | 1 | 216 |
| 10,000 | 0 | 148 |
| 10,000 | 1 | 234 |

- **The statement on an approved batch:** "rejects a lot with ≥2% errors with ≥95% probability". Never "the batch is 98% accurate".
- **What it covers.** Flagged items are reviewed fully, so the statement covers only the unflagged remainder.
- **The tolerable error rate (2%) and the confidence (95%)** are proposals for the product owner (decision R-3).

### When a sample fails

1. The batch is rejected (`reject_review_batch`), and nothing in it is published.
2. Every incorrect item is corrected, excluded or merged, with its cause recorded.
3. A validator is added or tightened for the cause, and re-run over the whole lot.
4. A new batch is created, with a new seed. The failed batch's sample is never reused, and a batch is never resampled until it passes.
5. Two consecutive failures on a platform stop that platform for a design review.

### Duplicates and provenance

**Duplicates.** Before anything is published, each candidate is checked:
- by its own source id (`external_references`);
- by title key, word-break key, main title and aliases, against the run and the catalog, unpublished staff candidates included (finding 1 of M12c-A);
- by shared external ids (two items with the same IGDB or MobyGames id are probably one game).

A collision is never merged automatically: it is an exception for an editor, resolved with the existing merge and reject tools.

**Provenance**, kept for every identity:
- the provider and source id;
- the snapshot file, its hash and fetch time;
- the clearance and its terms hash;
- the run and the entry's position;
- the source record (immutable, hashed);
- which fields the import filled;
- the batch, its sample and its approver.

For developer, publisher and genre (D-6), a later design adds per-field sources before they become catalog fields.

## 5. Storage and resources

### Measured

Measured 2026-11-20, from saved files and single requests:

| Item | Value |
| --- | --- |
| Official JSON dump, `latest-all.json.gz` (17 Nov 2026) | **157.2 GB** compressed, from the dump index. `.bz2`: 103.9 GB. Truthy N-Triples: 43.7 GB (`.bz2`) and 71.9 GB (`.gz`). Weekly; JSON is Wikidata's recommended format |
| SNES Query Service snapshot (2026-11-19) | 1,429 items, 2.8 MB |
| SNES snapshot profile | All 1,429 titled. 1,379 dated (915 by day, 218 by month, 246 by year), 50 undated. 859 with a Japanese label. 7 title-key collisions involving 14 items |
| One full entity (Super Mario World, `Special:EntityData`) | 150.8 KB: 14 labels, 46 sitelinks, 113 properties, 16 release-date statements. Keeping only the fields we use: 40.3 KB. A flagship game, so likely larger than typical |

### Estimated

Not measured; each is to be measured before it is relied on.

| Path | Estimate |
| --- | --- |
| **Pilot, 150 entities** by `wbgetentities` without sitelinks | 3 requests. Probably a few MB in total. Seconds to parse. Negligible database growth (150 games and pairings, source records of a few KB each) |
| **Whole SNES set,** about 1,430 entities | About 29 requests. Probably tens of MB. Under a minute of processing |
| **Many platforms by targeted extraction** (per-platform query, then `wbgetentities`) | For a catalog of the order of 50,000 to 100,000 games: 1,000 to 2,000 requests. At a polite one request a second, about 20 to 35 minutes of fetching, within the 2026 bot limits (200 a minute for an identified client). Source records of a few KB each: hundreds of MB at most |
| **Full dump** | **Download:** 157 GB (or 104 GB `.bz2`), at least 4 hours at an assumed 10 MB/s, or about 1 hour at 50 MB/s; the dump servers' per-client limits apply. **Disk:** the compressed file only (never stored uncompressed, which is likely to exceed 1 TB). **Memory:** under 1 GB, streaming line by line with a cheap text pre-filter before parsing. **Time:** likely several hours single-threaded, dominated by decompression. To be measured on a 1 GB slice first |

**Recommendation.** Don't download the dump for B1. Targeted extraction covers the pilot, the SNES set and probably every platform the catalog has. The dump is worth it only if targeted extraction proves unreliable or too slow, and only after a measured slice. The entity parser works on both.

### Configuration: the Wikimedia contact (D-7)

**Where it's set.** Wikimedia requires automated clients to identify themselves with contact information (User-Agent policy). The importer reads it from the `WIKIDATA_USER_AGENT` environment variable (`scripts/catalog-import.mjs fetch-wikidata`), and the B1 entity fetch will read the same variable.

**What it must contain.** A tool name and version, and a project contact the product owner chooses: a role mailbox or a project web page. It must not be a personal address, nor anything an agent invents.

**Until then.** The fetch commands refuse to run without it, as `fetch-wikidata` already does. The research requests in M12c-A and B0 used a generic tool name without a contact, kept to a few single requests.

## 6. M12c-B1 implementation plan

Each step ends at a checkpoint for review. Every database change is forward-only, replaces functions by exact signature, and leaves Supabase-managed schemas alone.

| Step | Work | Migration | Tests |
| --- | --- | --- | --- |
| 1 | **Entity parser:** `parseWikidataEntities` for `wbgetentities` and dump-line JSON. Same entry shape as today's parser, plus the source-only fields in section 3 | None | Unit tests on synthetic entities: `mul` fallback, qualifiers, multi-platform, hard and flag validators, and the same output as `parseWikidata` for the same items |
| 2 | **Fetch command:** `fetch-wikidata-entities --ids <selection> --out <dir>`. 50 per request, `maxlag`, backs off on 429, and requires `WIKIDATA_USER_AGENT` | None | Refuses without the user agent; batches and retries tested against a local stub |
| 3 | **Pairing verification and identity publication** | **B1-M1:** `game_platforms` gains `verified_at`, `verified_by` and `revision`; `verify_game_platform`; `publish_game_identity`; `search_catalog` and `get_release_picker` replaced | pgTAP: no self-review, MFA, revision checks, never touches releases, visibility for anon, user, submitter and editor, response fields, and that "no verified physical release" is derived. Database checks through the API. Security mutations for each guard |
| 4 | **Review batches** | **B1-M2:** the two batch tables, their functions, new audit actions and grants | pgTAP: frozen content and seeded sample (the same seed gives the same sample), refusal until every flagged and sampled item has an outcome, acceptance number, approver rules, no releases in a batch, a rejected batch not resampled, audit per game. Mutations |
| 5 | **Collector and staff pages:** the "No verified physical release yet" label; the fast add's direct claim path for identity-only games; a staff batch page (exceptions, sample, outcomes, approve or reject) | None | App checks for search, the game page, the fast add and an unidentified copy on an identity-only game, and the batch page flow with two editors. a11y over every new page state |
| 6 | **The SNES pilot (150)** on the test stack: import as candidates, then a census review and approval by the product owner as editor B | None | The M12c-A collector checks extended to identity-only games. Duplicate checks: the 3 existing games are matched, the 14 collision items are flagged. Pilot data intact |
| 7 | **Report and quality review,** then a decision on the remaining SNES set with the sampling plan | None | — |

**Not in B1:**
- developer, publisher and genre catalog fields (D-6, later);
- IGDB or any other provider;
- physical-release automation;
- wishlists and new collector discovery;
- anything on development.

## 7. Decisions still needed

| # | Decision | Proposal |
| --- | --- | --- |
| R-1 | The collector-facing label for an identity without releases | "No verified physical release yet" |
| R-2 | Whether identity-only games appear in search by default, or behind a filter | By default, with the label |
| R-3 | Sampling parameters | 2% tolerable error, 95% confidence, c = 0 (sample 138 for about 1,280 unflagged SNES items) |
| R-4 | Who approves batches | A catalog editor who didn't create the batch. Optionally a second approver for batches over a size the product owner sets |
| R-5 | Storing IGDB and MobyGames ids from Wikidata | In source records now (CC0 values), as external references only once that provider is cleared |
| R-6 | Pilot location | Scratch stack for building, test stack for the human review |
| R-7 | The project contact for `WIKIDATA_USER_AGENT` | Chosen by the product owner (D-7) |
| R-8 | Whether pairing verification is a separate step, or part of identity approval | Part of batch approval for imported identities, separate for editor-made ones |
| D-8 | Legal review | Before a commercial launch, or before accepting any provider's contractual terms (recorded) |
