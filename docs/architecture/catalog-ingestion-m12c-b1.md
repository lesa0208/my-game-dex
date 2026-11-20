# M12c-B1 (proposal): game identities from Wikidata, reviewed at scale

**Written for:** the product owner approving M12c-B1, and the engineers who will build it.

**Status, 2026-11-20: approved with corrections (R-1 to R-8).** Done so far:
- **Checkpoint one:** the parser and tooling.
- **Checkpoint two** (accepted with conditions): the isolated B1 stack, source revalidation, critical errors, and migration drafts validated on scratch.
- **Checkpoint three:** pairing withdrawal, the Unicode recheck, and the final migration drafts with their security review.
- **Checkpoint four:** the 150 records fetched and classified, multiple-id detection, editorial notes, and two B1-M2 fixes.

The migrations are final drafts awaiting approval, applied nowhere persistent. The 150 entity records and their 12 distribution formats were fetched in checkpoint four.
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

## Approved decisions (2026-11-20, second review)

| # | Decision |
| --- | --- |
| R-1 | The label is **"No verified physical release yet"** |
| R-2 | **Published identities appear in search by default,** once their eligibility for the physical-only catalog and their platform pairing are reviewed. A digital-only game is never treated as a physical release |
| R-3 | **Risk-based review and statistically justified sampling.** 2% at 95% confidence is acceptable for initial evaluation, not automatically for production. Sample sizes are calculated for each actual batch, and critical errors are defined separately |
| R-4 | **Batch approval** needs an authorized human reviewer who didn't create or import the records, with MFA, independent review and immutable audit history |
| R-5 | **Keep the Wikidata ids,** and the IGDB and MobyGames ids Wikidata supplies, with provenance. Nothing is fetched from an unapproved provider |
| R-6 | **A separate, persistent B1 ingestion-test environment,** isolated from development, the M12c-A test stack (port 3002) and the disposable scratch stack. The M12c-A test stack is not populated |
| R-7 | **Live Wikimedia requests need an operator-configured project contact.** None is ever invented |
| R-8 | **Pairings need independently reviewed provenance.** A Wikidata platform statement is never evidence of a retail edition |

**M12c-A stays as it is.** Its pilot checks assume its eight games, and its review history must stay complete, so B1 data never goes into its database.

## Checkpoint one: parser and acquisition tooling (implemented)

Implemented on the local B0 branch: no migration, publication function, staff page or collector page. No import, and no live Wikimedia request.

| Piece | Where |
| --- | --- |
| **Entity parser.** `parseWikidataEntities` reads a `wbgetentities` response, this project's entity snapshot, or dump lines (the same JSON). It turns each entity into the importer's entry shape, so the M5b importer can stage it unchanged | `scripts/wikidata-entities.mjs` |
| **Extraction.** Into the catalog fields: title (`en`, else `mul`), titles (English aliases, Latin-script labels, romanization), Japanese titles, first release (earliest, at its precision). Into `payload.source`: every platform, the SNES-specific first date, dated statements with platform and place qualifiers (at most 40), developers, publishers, genres, instance-of values, the entity revision, and the IGDB (P5794), MobyGames (P11688) and former MobyGames (P1933) ids | Same |
| **Hard problems** (the entry is ignored): missing entity, no title, not an instance of video game, not on the run's platform. Deprecated statements are skipped | Same |
| **Flags,** each marked `exception` or `info` | Same (`FLAGS`) |
| **The deterministic selection.** Every title-key collision, then fixed ids, then seeded random, listed in numeric id order | `b1Selection` |
| **The dry run.** For each selected item: create, matched (Wikidata id already linked), duplicate (same-platform title match: the importer would hold it) or held, with batch flags (title collision, shared IGDB or MobyGames id) and catalog flags. It always reports 0 releases created and 0 published | `dryRun` |
| **The CLI:** `select`; `export-catalog` (read-only transaction); `dry-run` (JSON and Markdown); `fetch-entities` (live, below). Outputs are refused inside the repository | `scripts/catalog-b1.mjs` |
| **The live fetch.** `fetch-entities` refuses unless `WIKIDATA_USER_AGENT` has a tool, a version and a project contact (an email address or URL).<br>- **Requests:** 50 ids each, one at a time, at least 1 s apart, `maxlag=5`, labels only in the languages the parser reads.<br>- **On HTTP 429 or 503, or a maxlag error:** waits for `Retry-After`, otherwise 2, 4, 8 and 16 s, up to 5 attempts.<br>- **On final failure:** stops without writing anything | `fetchEntities` |
| **Tests:** 10 tests in `scripts/catalog-b1.test.mjs`, part of `npm run catalog:test`. They cover the parser on three input shapes, extraction, hard problems and flags, dates, one real record, selection determinism, the dry-run outcomes, the query-snapshot fallback, the CLI end to end on fixture files, and the fetch policy against a stub (refusal, batching, interval, `Retry-After`, giving up) | Synthetic fixtures (fictional titles) and a trimmed real record of Super Mario World (Q853143, CC0, no references) in `scripts/fixtures/wikidata-b1/` |

### The real 150-game SNES selection

- **Source:** the importer's SNES Query Service snapshot of 2026-11-19 (1,429 items, SHA-256 `ff4836552cf03f0b92c7908f67a281d12c0221b7223a1a02eb80755743e7bd6e`).
- **Seed and size:** `mgd-m12c-b1-snes-1`, size 150.
- **Fixed ids:** the three SNES games of M12c-A (Q853143, Q370055, Q1194825).
- **Saved** outside the repository, in `~/.my-game-dex/catalog-pilot/m12c-b1/selection-snes-150.json` (SHA-256 `a3774c7b4772ede12d80acb551875c8bef430d1e203ff22af1ccbff2d8961f9c`). Running it again gave a byte-identical file.

| Stratum | Items |
| --- | --- |
| Title-key collisions (7 groups) | 14 |
| Fixed: already in a catalog | 3 |
| Seeded random | 133 |
| **Total** | **150** |

### The dry run

**What it compared against.** The identifiers of the M12c-A test catalog, exported read-only (8 games; SHA-256 `de69e9dc…f73ea0`). The test stack's games, external references and audit count hashed the same before and after the export.

**What it used.** Without entity records it used the query snapshot's fields: no live fetch is allowed until the project contact is configured. Every item therefore carries `entity_detail_pending`, so all 150 count as exception review for now.

**Saved** as `dry-run-2026-11-20/dry-run.json` (`058c1c6a…af7e`) and `dry-run.md` (`8d4e1ef5…6d6d`).

| Outcome | Count |
| --- | --- |
| Create (new, unpublished candidate) | 147 |
| Matched (Super Mario World, A Link to the Past, Super Metroid) | 3 |
| Possible duplicate of a catalog game | 0 |
| Held | 0 |
| Releases created / published | 0 / 0 |

| Flag | Count |
| --- | --- |
| `title_collision_in_batch` | 14 |
| `year_precision_only` | 21 |
| `no_release_date` | 6 |
| `catalog_source_id_linked` (info) | 3 |
| `entity_detail_pending` (until the fetch) | 150 |

**What the collisions found.** Real duplicate risk in Wikidata, not noise:
- **Probably the same game twice:** Tower Dream, Action Pachio, and Rocky & Bullwinkle each appear as two items, the newer one often undated.
- **The same game with two numeral spellings:** Albert Odyssey II and Albert Odyssey 2.
- **To check:** Space Ace (1984, the arcade original, against 1994 on the SNES) may be a split. The two Scooby-Doo Mystery items may be one SNES game and the Genesis game wrongly listed on the SNES.
- **One false collision:** Super Momotaro Dentetsu Ⅱ and Ⅲ. The title key drops the single-character Unicode numerals "Ⅱ" and "Ⅲ".

**Finding: title keys and Unicode numerals.** Single-character Unicode numerals (U+2160 to U+217F) should be compatibility-normalized ("Ⅱ" to "II") before keys are made. The database's search and import keys need the same check. The collision is only an exception for review, so nothing is merged wrongly. But the key is used for matching, so the fix belongs in B1 step 3, with tests, since it changes stored keys.

### Ingestion footprint

**Measured on one real record** (Super Mario World, a flagship game):

| Item | Size |
| --- | --- |
| Full entity | 150.8 KB |
| Without sitelinks | 136.7 KB |
| Parsed payload stored with the source record | 2.1 KB |
| Catalog fields (title, titles, date) | 81 bytes |

**Estimated** from that one record, an upper bound, since typical games are smaller:

| Scope | Requests | Snapshot | Stored source records |
| --- | --- | --- | --- |
| 150-game pilot | 3 | at most about 20 MB | about 0.3 MB |
| All of SNES (1,429) | 29 | at most about 200 MB | about 3 MB |
| Every platform (50,000 to 100,000 games) | 1,000 to 2,000 | gigabytes, kept outside the repository (or trimmed after parsing) | about 100 to 200 MB |

Processing is in seconds for the pilot. Database growth for the pilot is negligible. These are estimates until measured with the real snapshot.

## Checkpoint two: isolation, source revalidation and migration drafts (2026-11-20)

**Approvals recorded.**
- **A-1:** the architecture is approved in principle. The exact SQL is under review.
- **A-2:** create the B1 stack.
- **A-3:** an operator-provided `WIKIDATA_USER_AGENT` only.
- **A-4:** unresolved critical errors block approval. One approver suffices for the pilot; a configurable second approver applies above 1,000.
- **A-5:** B1-M0 is a separate migration.

### The B1 stack (created)

| | Value |
| --- | --- |
| Project | `my-game-dex-b1`, in `.supabase-b1/` (git-ignored) |
| Ports | API 57321, database 57322, shadow 57320, pooler 57329, Mailpit 57324, inspector 11083 (studio 57323 and analytics 57327 configured, disabled) |
| Containers and volumes | `supabase_*_my-game-dex-b1`; volumes `supabase_db_my-game-dex-b1`, `supabase_storage_my-game-dex-b1` |
| State | The 72 current migrations, no catalog data, no accounts, no provider cleared |
| Selector | `MGD_STACK=b1`. `MGD_TEST_STACK=b1 node scripts/test-stack.mjs start\|stop\|status` |

**Guards added:**
- **One table of stacks.** `scripts/lib/stack.mjs` keeps one table of the four stacks (development, test, scratch, b1). An unknown selector is refused, and each config must name its own project.
- **`requireStack(name)`** refuses any other stack. B1 tooling uses it to stay off development and the M12c-A test stack.
- **Reset and destroy** of the B1 stack refuse unless `MGD_ALLOW_B1_RESET=1` is set, because it will hold review history.

**Verified on 2026-11-20:**
- **Ports:** before the start, nothing listened on B1's ports. Port blocks don't overlap: development 543xx and 8083, test 553xx and 9083, scratch 563xx and 10083, B1 573xx and 11083.
- **Development unchanged:** 72 migrations, 19 games, 30 releases and 5 copies, the same before and after.
- **M12c-A test stack unchanged:** its releases, collections and audit count hash the same.
- **Volumes:** exactly two new (B1's), none removed, all 9 `mgd_demo` backups present. Ports 3000 and 3002 still serve.

**Not caused by B1:** in development, the auxiliary `edge_runtime` container had exited and `vector` (log shipping) was restarting. Neither was touched, and development's database, API and auth are healthy.

### Full Wikidata records: not fetched

**No `WIKIDATA_USER_AGENT` is configured** (not in the environment or in project files), so no request was sent.

**What's needed:** the operator sets it to a tool name, a version and a project contact (a role address or a project URL). Then:

```text
WIKIDATA_USER_AGENT="<tool>/<version> (<project contact>) node/22" \
  node scripts/catalog-b1.mjs fetch-entities --selection ~/.my-game-dex/catalog-pilot/m12c-b1/selection-snes-150.json --out ~/.my-game-dex/catalog-snapshots/<date>/
```

That makes 3 requests (50 entities each, at least 1 s apart, `maxlag=5`, honouring `Retry-After`). Then rerun `dry-run` with `--entities`.

### Revalidating the 150

**The selection is unchanged** (SHA-256 `a3774c7b4772ede12d80acb551875c8bef430d1e203ff22af1ccbff2d8961f9c`; source snapshot `ff483655…7bd6e`).

**Changes to the dry run:**
- Real collisions are now detected on the Unicode-aware key, so "Ⅱ" and "II" collide.
- Items colliding only on the plain key are reported as artifacts.
- Each item gets a readiness state and its possible critical errors.
- A record still pending detail can never be ready.

**The dry run of the query snapshot** (`dry-run-2026-11-20-cp2/`; JSON `6e65c9c6…6f10`, Markdown `26f47d40…1217`):

| | Count |
| --- | --- |
| New candidates (create) | 147 |
| Existing matches (the three M12c-A SNES games) | 3 |
| Duplicates of catalog games | 0 |
| Held | 0 |
| Real collisions: same title after normalization | 12 items in 6 groups |
| Unicode artifacts (distinct games) | 2 items in 1 group |
| Pending detail: missing critical evidence, can't be ready | **150** |
| Ready for editorial consideration | **0** (until the entity records are fetched) |
| Year-only dates / no date | 21 / 6 |

**The seven collision groups**, from the query snapshot's labels, aliases, Japanese labels and dates:

| Group | Items | Finding | Status |
| --- | --- | --- | --- |
| Super Momotaro Dentetsu Ⅱ / Ⅲ | Q11313984, Q11313985 | **False collision.** Separate games (1991-12-20, 1994-12-09) whose numerals the plain key dropped. Normalized, their keys differ | Continue (pending detail) |
| Space Ace | Q1081894 (1984, year only), Q117865047 (1994-03-25) | Probably the original game's item and a separate item for the SNES version. Our catalog keeps a port under one game, so both would create **conflicting canonical identities** | **Held** |
| Rocky & Bullwinkle | Q2473951, Q16144658 | The second item's aliases include the first's exact title. Probably a **duplicate item**, or an NES/SNES split | **Held** |
| Scooby-Doo Mystery | Q3476003, Q65146861 | Identical title and month (1995-11). **Different SNES and Genesis games** share this title, so these may be distinct; or one item is mis-tagged with the SNES | **Held** |
| Action Pachio | Q4677134, Q135194451 | Same day-precise date. The newer item adds only a Japanese alias. Probably a **duplicate item** | **Held** |
| Tower Dream | Q7829649, Q132527560 | The newer item is undated, with a Japanese label. Probably a **duplicate item** | **Held** |
| Albert Odyssey II | Q17192216, Q128221862 | "II" and "2"; the newer item undated. Probably a **duplicate item** | **Held** |

**So the 150 items are probably about 143 or 144 distinct games, not 150.** The held groups need a person: choose the canonical item, and record the other as a duplicate, or confirm two games.

**Eligibility and identifiers can't be assessed** from the query snapshot. These wait for the entity records: other instance-of values (compilations, cancelled or homebrew games), distribution formats (now captured), every platform, and the IGDB and MobyGames ids (two items sharing one is flagged). Physical-catalog eligibility is never inferred from Wikidata: a reviewer confirms it (R-2, R-8).

### Critical errors

**Defined in code** (`CRITICAL_ERRORS` in `scripts/wikidata-entities.mjs`) **and in B1-M2's item check:**
- `wrong_identity_or_type`: incorrect game identity or type;
- `wrong_platform`: wrong platform association;
- `physical_eligibility_unsupported`: physical-catalog eligibility not supported;
- `distinct_games_merged`: distinct games merged into one;
- `conflicting_duplicate_identities`: duplicates that would create conflicting canonical games;
- `conflicting_identifiers`: conflicting authoritative identifiers;
- `missing_provenance`: missing provenance for a required validation fact.

**Not critical by themselves:** genre, developer, publisher or an exact date.

**How flags relate to them.** Flags point to possible critical errors (`CRITICAL_SIGNALS`). A flagged item is reviewed in full, and in B1-M2 an unresolved critical error blocks the whole batch. **Pending detail always counts as `missing_provenance`.**

### Migration drafts

Complete SQL and pgTAP drafts are in [`docs/proposals/m12c-b1/`](../proposals/m12c-b1/README.md), with invariants, RLS, no-self-review, MFA, revision invalidation and rollbacks. They were validated on a disposable scratch stack, then destroyed:
- the full pgTAP suite with the drafts passes **3,786 / 3,786** (the existing 3,715, plus 14, 25 and 32 new);
- 13 database check suites pass **786 / 786**;
- both rollbacks apply.

They are **not** applied to development, the M12c-A stack or the B1 stack.

### Remaining critical errors (pilot data)

| # | Item | Possible critical error |
| --- | --- | --- |
| 1 | All 150 | `missing_provenance` until the entity records are fetched |
| 2 | Space Ace (2 items) | `conflicting_duplicate_identities` |
| 3 | Rocky & Bullwinkle (2) | `conflicting_duplicate_identities` |
| 4 | Scooby-Doo Mystery (2) | `conflicting_duplicate_identities`, or `wrong_platform` if one is the Genesis game |
| 5 | Action Pachio (2) | `conflicting_duplicate_identities` |
| 6 | Tower Dream (2) | `conflicting_duplicate_identities` |
| 7 | Albert Odyssey II (2) | `conflicting_duplicate_identities` |

### Recommended next checkpoint

1. The operator configures `WIKIDATA_USER_AGENT`. Then fetch the 150 entity records and rerun the full-detail dry run.
2. Review of the migration drafts. Once approved, they move to `supabase/migrations/` and are applied to the B1 stack only.
3. The importer step: entity snapshots through the M5b importer, with the parser's flags in `payload.review_flags`, as candidates on the B1 stack.
4. Then the batch, the census review by the product owner as editor B, approval, and the collector checks generalized to identity-only games.

## Checkpoint four: source classification and identity quality gate (2026-11-20)

Nothing was imported, published or applied to a persistent stack.

### Sources (all outside the repository)

| File | SHA-256 |
| --- | --- |
| Selection `selection-snes-150.json` (unchanged) | `a3774c7b4772ede12d80acb551875c8bef430d1e203ff22af1ccbff2d8961f9c` |
| Query snapshot `wikidata-snes-2026-11-19T19-30-13-272Z.json` | `ff4836552cf03f0b92c7908f67a281d12c0221b7223a1a02eb80755743e7bd6e` |
| Entity records `wikidata-entities-snes-2026-11-20T14-11-04-475Z.json`: 150 entities in 3 requests | `4e87b22e5abb962349b4774431d3f895132ae2fb17fb2e8af164b569f656d8cd` |
| Format records `wikidata-formats-2026-11-20T18-32-38-232Z.json`: the 12 formats, labels and descriptions only (en, mul), 1 request | `93797a673e7717d1269c0766d748d682533d83bc10c3d61b4cadfecbb0bff1c7` |
| M12c-A catalog export (read-only) | `89493b6aa7c8f72409d7e10249a304027eb2eae0ba2d1746c3cfd3f5a069ee3c` |
| Editorial notes [`editorial-review-snes-150.json`](../proposals/m12c-b1/editorial-review-snes-150.json) | `c24d2a0a72e0ae2d423edafa672375a3aca12bc8491056108af8fab31e2f1c68` |
| Dry run `dry-run-2026-11-20-cp4/dry-run.json` | `b66d7c1a3ba489fc90221b585659efaa5064ed64189a01e660b15a2252aa13f6` |

### What changed in the tooling

- **Distribution formats are classified** in `DISTRIBUTION_FORMAT_TABLE`, from the fetched labels:
  - 10 are physical: ROM cartridge, SNES Game Pak, read-only memory, floppy disk, compact cassette, CD-ROM, compact disc, optical disc, GD-ROM and Blu-ray;
  - 2 are digital: digital distribution and digital download.
- **What a physical class does.** It only clears the "unclassified" flag. It never establishes a physical release.
- **Qualifiers are kept.** Each P437 statement keeps its platform (P400) and distributor (P750) qualifiers. A statement qualified only with another platform is ignored for this one.
- **When a record is held for digital formats.** Only when every format stated for the platform is digital (`distribution_non_physical`). Digital alongside physical is information only, and so is a medium the platform doesn't use, such as a disc for a cartridge system.
- **Several IGDB or MobyGames ids** raise `external_ids_multiple`, a possible `conflicting_identifiers`. The dry run lists the ids with hints: `igdb_slug_variants`, `igdb_distinct_slugs` or `mobygames_several`. The hints never split, merge or clear anything.
- **Editorial-review notes** are a file of recommendations. A note can only add a hold (`held_for_editor`) with its reason, never clear a flag. Notes are refused if:
  - they name a record outside the selection;
  - they have no reason;
  - their hold value isn't a boolean.
- **Every record lists its reasons.** That covers every exception flag's reason in words and the editorial note.
- **Tests.** 9 new tooling tests; `catalog:test` passes 46 + 9.

### Results (150 items)

| | Count |
| --- | --- |
| New candidates / matched to M12c-A / duplicate of the catalog | 147 / 3 / 0 |
| Ready for editorial consideration | 92 |
| Needs review | 45 |
| Held for an editor, with a stated reason | 13 |
| With a possible critical error | 37 (18 conflicting identifiers, 12 duplicate identities, 10 physical eligibility, 2 identity or type) |
| Need independent physical-release evidence | **150** |

**"Ready" is not approval.** It only means no flag or editorial note stands in the way of an editor's review. Every record, ready or not, still needs evidence of its specific physical release.

**The nine "digital only" holds are mostly well-known cartridges:**
- Wild Guns;
- Super R-Type;
- Pilotwings;
- Super Street Fighter II;
- Fatal Fury Special;
- Ms. Pac-Man;
- Brawl Brothers;
- Vegas Stakes;
- Sonic the Hedgehog 4, the bootleg candidate, which is held anyway.

Wikidata lists only their digital re-releases for these. The hold is correct: a digital statement is a signal, resolved by evidence, not by the tooling.

The recommendations for each duplicate group and each multiple-id record are in the editorial notes and the dry run's Markdown report. Super Momotaro Dentetsu Ⅱ and Ⅲ remain distinct.

### SQL

Two defects in B1-M2 were found and fixed: an unmapped critical flag, and batch-accepted audit rows that didn't say they were batch accepted. See [SQL-REVIEW.md](../proposals/m12c-b1/SQL-REVIEW.md).

Validation on a fresh scratch stack, which was then destroyed:
- pgTAP 3,852 / 3,852;
- 13 database suites, 786 / 786;
- the rollbacks applied in order.

## Checkpoint three: full source validation and migration security review (2026-11-20)

Checkpoint two (`f38ba42`) was accepted with conditions. The B1 environment is approved and stays isolated from development, M12c-A and scratch.

### The 150 Wikidata records: still not fetched

**`WIKIDATA_USER_AGENT` is not configured**: not in the process, user or machine environment, or any `.env` file. No HTTP request was made, and the selection is unchanged (SHA-256 `a3774c7b…61f9c`).

**So the full-detail quality report can't be produced yet.** Here is what each requested category needs:

| Category | From the query snapshot (now) | Needs the entity records |
| --- | --- | --- |
| New game identities | 147 candidates, about 140 or 141 after the held duplicate groups | Confirmation of type, platforms and identifiers |
| Matched existing games | 3 (the M12c-A SNES games) | — |
| Real duplicate Wikidata entities | 6 held groups, 12 items (checkpoint two) | Identifiers and every statement, to choose the canonical item |
| False title collisions | 1 (Super Momotaro Dentetsu Ⅱ / Ⅲ) | — |
| Missing or conflicting identifiers | Not assessable | IGDB and MobyGames ids; two items sharing one is flagged |
| Wrong platform associations | Not assessable | Every platform statement and dated release |
| Digital-only or ineligible candidates | Not assessable | Distribution formats (P437) and other instance-of values |
| Physical-eligibility confirmation | **All 150**, always by a person (R-2, R-8) | — |
| Actually ready for editorial review | **0**: every record is pending detail | The fetch |

**The parser is ready for those categories.** A stated distribution format is now flagged until a person classifies that format once, as physical or not. Wikidata formats are never guessed, and the dry run lists each distinct format with its count. Both flags count as a possible `physical_eligibility_unsupported`, in the parser and in B1-M2, and a test keeps the two mappings identical.

### Withdrawing an incorrect pairing

**`withdraw_game_platform` removes one game-platform pairing without excluding the game.** It's in B1-M1 (W1 to W8), with a preview and a restoration by a different editor.
- **Who:** an editor with a recent second factor, a reason and the reviewed game revision.
- **Refused while it would strand something:** any release on the pairing that isn't closed, or the last listed platform of a published game. A published release is resolved first through the reviewed M7b-2b exclusion, which preserves its copies.
- **Copies are never touched.** A collector's claim of the game on that platform stays exactly as it is.
- **What it does:** the pairing is kept, excluded, with its verification cleared and recorded on an immutable withdrawal row. The game's revision moves on, invalidating verifications and open batches at the earlier revision.
- **Restoration** returns the pairing to review, unverified, so it is published again only through independent verification.

**Excluding the last release of a reviewed identity** no longer takes its verified pairing and the game with it (W9).

### Unicode normalization, rechecked

- **Distinct numerals stay distinct:** "II" and "III", "Ⅱ" and "Ⅲ", "Ⅱ" and "III", and a numeral attached to Japanese text.
- **Equivalent forms match:** "Ⅱ", "ⅱ" and "II".
- **Fixed regression:** NFKC would have turned "Tetris™" into "TetrisTM"; "™" and "℠" now become a space first, in both database functions and the parser.
- **Nothing is merged.** The keys are search and matching keys, and the importer links only by external id; a title match is held as a possible duplicate.
- **Titles and aliases are preserved:** a before-and-after fingerprint of every non-key column is identical.
- **Real uniqueness conflicts:** B1-M0 and its rollback each refuse alias collisions, and a read-only preflight report lists them first. On development, the M12c-A stack and B1 it found **no conflicts and no key changes**, so nothing needs resolving.

### Final migration review

The exact SQL, the tests, the authorization matrix, the invariants and the rollback and data-preservation behaviour are in [docs/proposals/m12c-b1/README.md](../proposals/m12c-b1/README.md).

**Nine defects were found and fixed**, six of them in B1-M2's approval security. The key ones:
- a withdrawn pairing could join a batch;
- a sampled member marked "excluded" escaped the sample;
- findings could be overwritten, including between two approvals;
- the batch claimed individual physical-eligibility confirmation for unsampled members.

**Validated on fresh scratch stacks, then destroyed:**
- **pgTAP:** 3,849 of 3,849.
- **Database checks:** 13 suites, 786 of 786.
- **Rollbacks:** each rollback and refusal behaves as specified.

Nothing is applied to a persistent stack.

### Recommended next checkpoint

1. **Approve or amend the drafts.** The open points are listed in the proposals README.
2. **The operator configures `WIKIDATA_USER_AGENT`.** Then fetch the 150 records (3 requests) and produce the full-detail report, including classifying the distribution formats found.
3. **Once both are done,** the migrations move to `supabase/migrations/` and are applied to B1 only. Then the import step with `payload.review_flags`.

## The B1 ingestion-test environment (R-6): created in checkpoint two

A fourth local stack, persistent like the test stack, built by the same generator (`scripts/test-stack.mjs`) as a third variant:

| | Development | M12c-A test | Scratch (disposable) | **B1 (proposed)** |
| --- | --- | --- | --- | --- |
| Project id | `my-game-dex` | `my-game-dex-test` | `my-game-dex-scratch` | **`my-game-dex-b1`** |
| Directory | `supabase/` | `.supabase-test/` | `.supabase-scratch/` | **`.supabase-b1/`** (git-ignored) |
| Port offset | 0 | +1000 | +2000 | **+3000** |
| API, database, shadow, pooler | 54321, 54322, 54320, 54329 | 55321… | 56321… | **57321, 57322, 57320, 57329** |
| Mailpit, inspector | 54324, 8083 | 55324, 9083 | 56324, 10083 | **57324, 11083** |
| Containers and volumes | `*_my-game-dex` | `*_my-game-dex-test` | `*_my-game-dex-scratch` | **`*_my-game-dex-b1`** |
| App preview | 3000 (main build) | 3002 | none | **3004** |
| Selector | default | `MGD_STACK=test` | `MGD_STACK=scratch` | **`MGD_STACK=b1`** |
| Lifetime | permanent | keeps the M12c-A pilot | destroyed after each run | **keeps B1 batches and their review history** |

**Checked on 2026-11-20:**
- nothing listens on 57320–57329, 11083 or 3004;
- no container or volume named `my-game-dex-b1` exists.

**Rules:**
- **Refusals.** `stack.mjs` checks the project name against the selector, as for the other stacks. The B1 runner refuses any stack but `b1`. The M12c-A scripts keep refusing anything but `test`.
- **Data.** The B1 stack gets its own reviewer account, created by the product owner as before, and its own Wikidata clearance record. Nothing is copied from the M12c-A stack or development.
- **The `db.mjs` suites** run on scratch, never on B1, so B1's records are never in a suite's way.

## After checkpoint one: migration, authorization and test specification (for review)

**Not implemented.** Each migration is forward-only, replaces functions by exact signature, uses no `DROP … CASCADE`, and leaves Supabase-managed schemas alone. Names are proposals.

### B1-M0: title keys and Unicode numerals

- **Change.** `private.catalog_search_key` and the import title keys apply NFKC (or an explicit map of U+2160–217F) before making a key.
- **How.** The key functions used by unique indexes are never replaced in place (M11b-1b), so this checks which functions back indexes first. Those get new functions and new indexes, with a preflight for collisions.
- **Tests:**
  - "Ⅱ" and "II" give the same key, and "Ⅱ" and "Ⅲ" give different keys;
  - existing search and import tests are unchanged.

### B1-M1: verified pairings and identity publication

**Schema.** `public.game_platforms` gains `verified_at timestamptz`, `verified_by uuid` (references profiles, set null on delete), `revision bigint not null default 1` and a revision trigger, as releases have.

**Backfill.** Pairings that are already published, because they have a published release, are marked verified as of their release's verification, with no new audit event. The backfill touches only pairings that have a published, verified release. It changes no published state.

**Functions** (`SECURITY DEFINER`, `search_path = ''`, `begin_catalog_edit()`, recent MFA, a reason, revision checks, the M7b-1 guard):

| Function | Rules | Audit |
| --- | --- | --- |
| `verify_game_platform(p_game, p_platform, p_reason, p_expected_revision)` | Refused for the pairing's creator (`created_by`). Refused unless the game is `under_review` or published | `catalog_record_verified`, entity `game_platform` |
| `publish_game_identity(p_game, p_platforms uuid[], p_reason, p_expected_revision)` | The game must be verified at its current revision by someone other than its creator. Each named pairing must be verified at its current revision. It publishes the game (slug as `publish_release` assigns it) and those pairings. It never reads or writes `releases` | `catalog_record_published`, entity `game` with `identity: true`, and one per pairing |

**Read functions replaced** with exact signatures:
- `search_catalog`: a game is a result when it is published and has at least one published pairing on a platform in the filter. Each result gains `verified_release_count`.
- `get_release_picker`: the same, returning the published pairings with no releases, so the page shows "No verified physical release yet".

The fixed response field lists (M5c) gain only these counts.

**Unchanged:** `publish_release` (it still publishes its game and pairing), `can_claim`, merge, exclusion, and every release rule.

### B1-M2: review batches

**Tables:**
- `private.catalog_review_batches`:
  - id; `import_run_id`; `platform_id`; `created_by`; `created_at`;
  - `item_count`; `content_sha256` (over the sorted game ids and their revisions);
  - `seed` (generated at creation, after the content is frozen); `sample_size`; `acceptance_number`; `tolerable_error`; `confidence`;
  - `status` (`open`, `approved`, `rejected`); `decided_by`; `decided_at`; `decision_reason`.
- `private.catalog_review_batch_items`:
  - batch, game, the game's revision when frozen, its pairing's revision;
  - `flags text[]`, `critical boolean`, `sampled boolean`;
  - `outcome` (`correct`, `incorrect`, `excluded`), `critical_error boolean`, `reviewer`, `note`, `recorded_at`.
  - The primary key is (batch, game).

**Membership is immutable.** A trigger refuses inserts and deletes after creation, and changes to anything but the outcome fields while the batch is `open`. Nothing changes after a decision.

**Functions** (editors; MFA where they change state; audit on every call):

| Function | Rules |
| --- | --- |
| `create_review_batch(p_run, p_platform, p_tolerable_error, p_confidence, p_reason)` | Takes the run's unverified, unpublished game candidates on the platform. Freezes the list with its revisions. Runs the validators (a database copy of the flags that are checkable in SQL, plus the import's recorded flags). Marks critical flags. Computes the sample size for the actual unflagged lot (hypergeometric, as in § 4), then draws the sample with the seed. Refused if any member is in another open batch |
| `record_batch_outcome(p_batch, p_game, p_outcome, p_critical_error, p_note)` | Only for flagged or sampled items, by a catalog editor who didn't create the batch |
| `approve_review_batch(p_batch, p_reason)` | Refused unless all of these hold: the approver didn't create the batch and created none of its games; every flagged and every sampled item has an outcome; the sample's incorrect count is within the acceptance number; no critical error anywhere; every member's current revision equals its frozen revision, so a change after freezing invalidates the batch. Then, for each member that is correct (if it was reviewed) or unreviewed and unflagged, it verifies the game and its pairing and publishes the identity, with the batch id in each audit row. Excluded and incorrect members stay unpublished |
| `reject_review_batch(p_batch, p_reason)` | Closes the batch. Its members can join a new batch with a new seed. A rejected batch is never reopened or resampled |

**New audit actions:** `catalog_batch_created`, `catalog_batch_outcome_recorded`, `catalog_batch_approved`, `catalog_batch_rejected`. Their metadata carries the batch id, the content hash, the source snapshot and run, the sample plan and result, the critical errors and the decision.

**Critical errors (R-3)** block a batch whatever the sample says:
- a wrong game identity (wrong title, or two games merged into one);
- a game that isn't eligible for the physical-only catalog (digital-only, broadcast-only, cancelled or unreleased);
- a wrong platform pairing;
- a duplicate of an existing catalog game.

Non-critical errors count against the acceptance number: an imprecise date, a missing alias.

### Authorization model

| Action | Who |
| --- | --- |
| Import candidates | `catalog_importer` only, as today: no verification or publication |
| Create a batch | A catalog editor, with MFA |
| Record outcomes | A catalog editor who didn't create the batch |
| Approve or reject | A catalog editor who didn't create the batch and created none of its games, with recent MFA. Optionally a second approver above a size the product owner sets |
| Physical releases | Unchanged: created by one editor, verified and published by another, one at a time |

Everything goes through `SECURITY DEFINER` functions in the private schema. No table gets a client grant. Audit rows are written by the functions, and audit history is never edited.

### Integration-test strategy

| Layer | Tests |
| --- | --- |
| pgTAP (scratch stack) | Pairing verification and identity publication: no self-review, MFA, revisions, never touching releases, the backfill. Batch immutability, the seeded sample (same seed, same sample), sample size for the lot, refusal paths, revision invalidation, critical errors, audit metadata. Visibility for anon, user, submitter and editor. Response fields |
| Database checks through the API (scratch) | The same flows as real sessions, with two editors |
| Security mutations | One per guard: self-review, MFA, revision, frozen membership, approver rules, critical-error block, release untouched |
| App checks (scratch) | Search and the game page for an identity-only game ("No verified physical release yet"), the fast add's own-record path, an unidentified copy, and the batch page with two editors. a11y on every new state |
| The full suite | `db.mjs verify` and every app suite on the scratch stack, from this branch's migrations |
| The B1 pilot (B1 stack) | The 150 games: import, batch, a census review by the product owner as editor B, approval. Collector checks generalized from M12c-A to identity-only games. M12c-A's own checks still run unchanged on the test stack |

### Approvals needed before B1-M0 to B1-M2

| # | Approval |
| --- | --- |
| A-1 | The migration specifications above (M0, M1, M2) and the authorization model |
| A-2 | Creating the B1 stack as specified (`my-game-dex-b1`, ports +3000, preview 3004) |
| A-3 | The project contact for `WIKIDATA_USER_AGENT`. Then the live fetch of the 150 entity records (3 requests) and a dry run with full detail |
| A-4 | The critical-error list, and whether a second approver is required above a batch size |
| A-5 | The Unicode-numeral key fix (B1-M0) as part of B1, or separately |

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
| **Where** | Built and tested on the scratch stack. The human review pilot runs on the separate, persistent B1 stack (`my-game-dex-b1`, R-6), never on the M12c-A test stack or development |
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
| 6 | **The SNES pilot (150)** on the B1 stack (R-6): import as candidates, then a census review and approval by the product owner as editor B | None | The M12c-A collector checks generalized to identity-only games, on the B1 stack. Duplicate checks: the 3 games already in a catalog are matched, and the 14 collision items are flagged. M12c-A's own checks still run unchanged on its test stack |
| 7 | **Report and quality review,** then a decision on the remaining SNES set with the sampling plan | None | — |

**Not in B1:**
- developer, publisher and genre catalog fields (D-6, later);
- IGDB or any other provider;
- physical-release automation;
- wishlists and new collector discovery;
- anything on development.

## 7. Decisions as first proposed (see the approved decisions above)

| # | Decision | Proposal |
| --- | --- | --- |
| R-1 | The collector-facing label for an identity without releases | "No verified physical release yet" |
| R-2 | Whether identity-only games appear in search by default, or behind a filter | By default, with the label |
| R-3 | Sampling parameters | 2% tolerable error, 95% confidence, c = 0 (sample 138 for about 1,280 unflagged SNES items) |
| R-4 | Who approves batches | A catalog editor who didn't create the batch. Optionally a second approver for batches over a size the product owner sets |
| R-5 | Storing IGDB and MobyGames ids from Wikidata | In source records now (CC0 values), as external references only once that provider is cleared |
| R-6 | Pilot location | **Decided:** a separate, persistent B1 stack, not the M12c-A test stack (see [the B1 environment](#the-b1-ingestion-test-environment-r-6-created-in-checkpoint-two)) |
| R-7 | The project contact for `WIKIDATA_USER_AGENT` | Chosen by the product owner (D-7) |
| R-8 | Whether pairing verification is a separate step, or part of identity approval | Part of batch approval for imported identities, separate for editor-made ones |
| D-8 | Legal review | Before a commercial launch, or before accepting any provider's contractual terms (recorded) |

## Appendix: the 150 selected SNES items

From the dry run of 2026-11-20 (query-snapshot fields; entity details pending). Titles are as Wikidata gives them, and nothing here is reviewed. "Selected as" is the stratum. Flags: collision, year only, no date and linked (already in the M12c-A test catalog).

| Id | Title (as in Wikidata) | First release | Selected as | Dry run | Flags |
| --- | --- | --- | --- | --- | --- |
| Q44346 | James Pond 2: Codename: RoboCod | 1991-01-01 (year) | random | create | year only |
| Q257469 | Another World | 1991-01-01 (year) | random | create | year only |
| Q370055 | The Legend of Zelda: A Link to the Past | 1991-11-21 (day) | fixed | matched (M12c-A game) | linked |
| Q428548 | NBA Live 97 | 1996-11-01 (month) | random | create |  |
| Q610138 | SimAnt | 1991-01-01 (year) | random | create | year only |
| Q610749 | Mega Man 7 | 1995-03-24 (day) | random | create |  |
| Q633461 | FIFA Soccer 96 | 1995-09-01 (month) | random | create |  |
| Q682463 | Wild Guns | 1994-08-12 (day) | random | create |  |
| Q720440 | Darius Twin | 1991-03-29 (day) | random | create |  |
| Q846203 | Super R-Type | 1991-07-13 (day) | random | create |  |
| Q853143 | Super Mario World | 1990-11-21 (day) | fixed | matched (M12c-A game) | linked |
| Q953511 | Clock Tower | 1995-09-14 (day) | random | create |  |
| Q969588 | Old Testament Megami-Tensei | 1995-03-31 (day) | random | create |  |
| Q1001925 | Flashback | 1992-01-01 (year) | random | create | year only |
| Q1074369 | Fatal Fury Special | 1993-09-16 (day) | random | create |  |
| Q1081894 | Space Ace | 1984-01-01 (year) | collision | create | collision, year only |
| Q1108679 | Waku Waku 7 | 1996-11-21 (day) | random | create |  |
| Q1194825 | Super Metroid | 1994-03-19 (day) | fixed | matched (M12c-A game) | linked |
| Q1197149 | Terranigma | 1995-10-20 (day) | random | create |  |
| Q1305295 | Pilotwings | 1990-12-21 (day) | random | create |  |
| Q1724425 | Super Soccer | 1991-12-13 (day) | random | create |  |
| Q1773728 | Super Double Dragon | 1992-10-16 (day) | random | create |  |
| Q1851017 | International Superstar Soccer | 1994-11-11 (day) | random | create |  |
| Q1987042 | 3 Ninjas Kick Back | 1994-06-01 (day) | random | create |  |
| Q2091435 | Q*bert 3 | 1992-10-01 (month) | random | create |  |
| Q2141683 | Ms. Pac-Man | 1982-01-13 (day) | random | create |  |
| Q2249639 | Kidō Keisatsu Patlabor | 1994-04-22 (day) | random | create |  |
| Q2297364 | Teenage Mutant Ninja Turtles: Turtles in Time | 1991-03-01 (month) | random | create |  |
| Q2312762 | Dragon Quest II | 1987-01-26 (day) | random | create |  |
| Q2457059 | Sengoku | 1991-02-12 (day) | random | create |  |
| Q2473951 | The Adventures of Rocky and Bullwinkle and Friends | 1992-12-01 (month) | collision | create | collision |
| Q2601047 | Final Fight 3 | 1995-12-21 (day) | random | create |  |
| Q2742518 | Daisenryaku | 1991-06-17 (day) | random | create |  |
| Q2748662 | Mighty Morphin Power Rangers: The Movie | 1995-06-01 (month) | random | create |  |
| Q2816655 | 3×3 Eyes: Seima Kōrinden | 1992-07-28 (day) | random | create |  |
| Q2881009 | Ball Bullet Gun: Survival Game Simulation | 1995-12-01 (day) | random | create |  |
| Q2887292 | Bass Masters Classic | 1994-01-01 (year) | random | create | year only |
| Q2913706 | Super Street Fighter II: The New Challengers | 1993-09-10 (day) | random | create |  |
| Q2927096 | Brutal: Paws of Fury | 1994-10-01 (day) | random | create |  |
| Q2927402 | Bubsy 2 | 1994-10-28 (day) | random | create |  |
| Q2986962 | Kirby's Avalanche | 1995-02-01 (day) | random | create |  |
| Q3036891 | Doom Troopers: Mutant Chronicles | 1995-11-01 (month) | random | create |  |
| Q3064872 | Famicom Tantei Club Part II: Ushiro ni Tatsu Shōjo | 1989-05-23 (day) | random | create |  |
| Q3107876 | World Cup USA '94 | 1994-01-01 (year) | random | create | year only |
| Q3155973 | Itoi Shigesato no Bass Tsuri No. 1 | 1997-02-21 (day) | random | create |  |
| Q3196442 | Imperium | 1992-02-01 (month) | random | create |  |
| Q3276899 | Magic Sword: Heroic Fantasy | 1990-01-01 (year) | random | create | year only |
| Q3279162 | Super Bomberman 5 | 1997-02-28 (day) | random | create |  |
| Q3334424 | NHL 97 | 1996-08-31 (day) | random | create |  |
| Q3341362 | Nigel Mansell's World Championship Racing | 1993-03-19 (day) | random | create |  |
| Q3342399 | No Escape | 1994-08-01 (month) | random | create |  |
| Q3459429 | SD Gundam Generation: Zanscare Senki | 1996-01-01 (year) | random | create | year only |
| Q3476003 | Scooby-Doo Mystery | 1995-11-01 (month) | collision | create | collision |
| Q3490467 | Sonic the Hedgehog 4 | 1996-01-01 (year) | random | create | year only |
| Q3521126 | The Great Circus Mystery Starring Mickey & Minnie | 1994-10-01 (month) | random | create |  |
| Q3529116 | Tin Star | 1994-11-01 (month) | random | create |  |
| Q3529218 | Tintin in Tibet | 1995-01-01 (year) | random | create | year only |
| Q3534834 | Socks the Cat Rocks the Hill | 1993-10-01 (day) | random | create |  |
| Q3536083 | Toys | 1993-01-01 (year) | random | create | year only |
| Q3658045 | Captain Tsubasa 4: Pro no Rival Tachi | 1993-04-03 (day) | random | create |  |
| Q3699821 | Cyber Spin | 1992-03-19 (day) | random | create |  |
| Q3777241 | Brawl Brothers | 1992-12-22 (day) | random | create |  |
| Q3944964 | Sailor Moon S: Jōgai rantō!? Shuyaku sōdatsusen | 1994-12-14 (day) | random | create |  |
| Q3977565 | Super Formation Soccer 95: della Serie A | 1995-03-31 (day) | random | create |  |
| Q4009249 | Vegas Stakes | 1993-09-10 (day) | random | create |  |
| Q4051520 | Tiny Toon Adventures: Wacky Sports Challenge | 1994-09-30 (day) | random | create |  |
| Q4384620 | Mega Man Soccer | 1994-02-17 (day) | random | create |  |
| Q4677134 | Action Pachio | 1993-04-09 (day) | collision | create | collision |
| Q4783378 | Arabian Nights: Sabaku no Seirei-ō | 1996-06-14 (day) | random | create |  |
| Q4811332 | Astral Bout | 1992-06-26 (day) | random | create |  |
| Q4849608 | Bakushou!! Kinsey Gekijou | 1989-03-17 (day) | random | create |  |
| Q4870115 | Battle Soccer: Field no Hasha | 1992-12-11 (day) | random | create |  |
| Q5197717 | Cyber Knight II: Chikyū Teikoku no Yabō | 1994-08-26 (day) | random | create |  |
| Q5236894 | Banshee's Last Cry | 1994-11-25 (day) | random | create |  |
| Q5376904 | Energy Breaker | 1996-07-26 (day) | random | create |  |
| Q5463439 | Flying Hero | 1992-12-18 (day) | random | create |  |
| Q5517684 | Gakkou de atta Kowai Hanashi | 1995-08-04 (day) | random | create |  |
| Q5521476 | Ganpuru: Gunman's Proof | 1997-01-31 (day) | random | create |  |
| Q5575485 | Street Fighter II: Champion Edition | 1992-01-01 (year) | random | create | year only |
| Q5618284 | GunForce | 1992-11-11 (day) | random | create |  |
| Q5695731 | Hebereke's Popoitto | 1995-03-03 (day) | random | create |  |
| Q6014096 | Incantation | 1996-11-01 (month) | random | create |  |
| Q6120028 | Sonic Blast Man | 1992-09-25 (day) | random | create |  |
| Q6197587 | Jim Power: The Lost Dimension in 3-D | 1993-12-10 (day) | random | create |  |
| Q6319542 | Jyutei Senki | 1993-08-27 (day) | random | create |  |
| Q6411248 | King Arthur & the Knights of Justice | 1995-04-01 (month) | random | create |  |
| Q6472552 | Lagoon | 1990-09-12 (day) | random | create |  |
| Q6767287 | Mark Davis' The Fishing Master | 1995-06-30 (day) | random | create |  |
| Q6822591 | Metal Combat: Falcon's Revenge | 1993-12-01 (month) | random | create |  |
| Q6893746 | Mohawk & Headphone Jack | 1996-08-01 (month) | random | create |  |
| Q6954066 | NHL Stanley Cup | 1993-11-01 (month) | random | create |  |
| Q6980285 | Natsuki Crisis Battle | 1995-04-21 (day) | random | create |  |
| Q7081758 | Okamoto Ayako to Match Play Golf | 1994-09-23 (day) | random | create |  |
| Q7332377 | Riddick Bowe Boxing | 1994-12-18 (day) | random | create |  |
| Q7642178 | Super Birdie Rush | 1992-03-06 (day) | random | create |  |
| Q7642237 | Super Casino 2 | 1994-10-28 (day) | random | create |  |
| Q7642250 | Super Chinese Fighter | 1995-01-03 (day) | random | create |  |
| Q7642329 | Super F-1 Hero | 1992-12-18 (day) | random | create |  |
| Q7642334 | Super Family Gerende | 1998-02-01 (day) | random | create |  |
| Q7642463 | Super International Cricket | 1994-01-01 (year) | random | create | year only |
| Q7642468 | Super Jinsei Game | 1994-03-18 (day) | random | create |  |
| Q7642490 | Super Kyotei | 1995-06-30 (day) | random | create |  |
| Q7642875 | Super Troll Islands | 1994-03-25 (day) | random | create |  |
| Q7650082 | Sutobasu Yarō Shō | 1994-02-25 (day) | random | create |  |
| Q7829649 | Tower Dream | 1996-10-25 (day) | collision | create | collision |
| Q7935040 | Virtual Soccer | 1994-03-18 (day) | random | create |  |
| Q7968365 | War 2410 | 1995-12-01 (month) | random | create |  |
| Q7998722 | Widget | 1992-11-01 (month) | random | create |  |
| Q8041457 | X-Kaliber 2097 | 1994-02-11 (day) | random | create |  |
| Q8069493 | Zero4 Champ: RR | 1994-07-22 (day) | random | create |  |
| Q8071476 | Zico Soccer | 1994-03-04 (day) | random | create |  |
| Q9299894 | King Arthur's World | 1993-03-01 (month) | random | create |  |
| Q11113131 | Crayon Shin-chan 2 - Dai maō no gyakushū | 1994-01-01 (year) | random | create | year only |
| Q11234889 | New Yatterman: Nandai Kandai Yajirobee | 1996-03-29 (day) | random | create |  |
| Q11265438 | Kunio-kun no Dodge Ball da yo: Zenin Shūgo | 1993-08-06 (day) | random | create |  |
| Q11288029 | Wizap!: King of Darkness | 1994-01-01 (year) | random | create | year only |
| Q11297975 | Kinnikuman: Dirty Challenger | 1992-08-21 (day) | random | create |  |
| Q11313782 | Super Trump Collection 2 | none | random | create | no date |
| Q11313984 | Super Momotaro Dentetsu Ⅱ | 1991-12-20 (day) | collision | create | collision |
| Q11313985 | Super Momotaro Dentetsu Ⅲ | 1994-12-09 (day) | collision | create | collision |
| Q11321807 | Traverse: Starlight & Prairie | 1996-06-28 (day) | random | create |  |
| Q11338860 | Bomberman B-Daman | 1996-12-20 (day) | random | create |  |
| Q11378401 | Kamen Rider SD: Sortie!! Rider Machines | 1993-07-09 (day) | random | create |  |
| Q11439204 | Daikaijū Monogatari II | 1996-08-02 (day) | random | create |  |
| Q11673681 | Majo-tachi no Nemuri | 1995-11-24 (day) | random | create |  |
| Q15623299 | Super Genjin 2 | 1995-07-28 (day) | random | create |  |
| Q15650127 | Dragon Slayer: The Legend of Heroes II | 1992-03-19 (day) | random | create |  |
| Q16144658 | Adventures of Rocky & Bullwinkle and Friends | 1992-01-01 (year) | collision | create | collision, year only |
| Q16258851 | The Wizard of Oz | 1993-10-05 (day) | random | create |  |
| Q16267786 | Power Drive | 1994-01-01 (year) | random | create | year only |
| Q16382836 | Bonkers | 1994-10-01 (month) | random | create |  |
| Q16736412 | Super Drift Out: World Rally Championships | 1995-02-24 (day) | random | create |  |
| Q17190580 | Earth Light | 1992-07-24 (day) | random | create |  |
| Q17192216 | Albert Odyssey II: Jashin no Taidou | 1996-01-01 (year) | collision | create | collision, year only |
| Q25377234 | Nightmare Busters | 2013-12-23 (day) | random | create |  |
| Q55849113 | Gdleen | 1991-01-01 (year) | random | create | year only |
| Q60754687 | Beethoven: The Ultimate Canine Caper | 1993-12-01 (month) | random | create |  |
| Q63870141 | Elite Soccer | 1994-01-01 (year) | random | create | year only |
| Q65146861 | Scooby-Doo Mystery | 1995-11-01 (month) | collision | create | collision |
| Q107300728 | Kakinoki Shogi | 1994-10-21 (day) | random | create |  |
| Q107369236 | Thoroughbred Breeder III | 1996-10-18 (day) | random | create |  |
| Q108662228 | Military Multipurpose Arcade Combat Simulator | none | random | create | no date |
| Q113462786 | Nickelodeon GUTS | none | random | create | no date |
| Q117865047 | Space Ace | 1994-03-25 (day) | collision | create | collision |
| Q120335973 | Supapoon | none | random | create | no date |
| Q124805737 | Kishin Dōji Zenki: Tenchi Meidō | 1995-09-29 (day) | random | create |  |
| Q128221862 | Albert Odyssey 2: Jashin no Taidou | none | collision | create | no date, collision |
| Q132527560 | Tower Dream | none | collision | create | no date, collision |
| Q135194451 | Action Pachio | 1993-04-09 (day) | collision | create | collision |
| Q140384896 | Ginga Sengoku Gun'yūden Rai | 1996-03-29 (day) | random | create |  |
