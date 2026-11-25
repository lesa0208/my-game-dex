# Submission enrichment (M15)

A collector names a game, its platform and its region; My Game Dex does the research and prepares the review. Nothing is decided or published automatically.

## The collector

1. **Three fields:** title, platform, region (Unknown allowed), then the physical-only confirmation.
2. **The cartridge shell can stay "Not sure".** On NES and SNES, the existing generic `rom-cartridge` is the documented "shape not classified" format (M11b-1b): a submission may use it, and `accepts_new_publications = false` refuses publication until an editor names the shell. No false format, and no schema change. Platforms without such a format (PlayStation 2, Master System, SG-1000) still ask which format, because none can record "unknown" there.
3. **The catalog is searched first.** Before a new game is created, the published catalog is searched on that platform (titles, aliases, local titles). If it may already be there, nothing is submitted. The collector opens the game to add their copy or submit the missing release, or confirms "My game isn't one of these". Without JavaScript the page shows the same choice.
4. **Lookup notice.** The form says the title and platform are looked up in Wikidata, and nothing else is sent.
5. **Status only.** The collector's own page says whether the lookup is waiting, found something, found nothing or will be retried. Never the candidates.

## The lookup

- **Queued in the database.** `private.submission_enrichments` gets a `pending` row in the same transaction as every new-game submission (a trigger). A changed title puts it back to `pending`.
- **When it runs.** The server runs the lookup in a server action's `after()`: right after submitting or editing, and whenever a collector's submission page, an editor's review or the review queue is opened while one is due (a client component asks once). A page render's `after()` proved unreliable for this: the claim's request reached the database, but its answer never came back.
- **Only the server writes.** `claim_submission_enrichments` and `record_submission_enrichment` are executable by `service_role` only (the server's secret key, as `set_avatar_path`). Collectors can't write or forge a source claim.
- **Claims and retries.** A claim carries a token, and a result is recorded only for the current claim. So retries, two servers or a late answer for an old title never record twice. A failed lookup waits 15 minutes; after 5 attempts it stops until an editor presses "Look up again".
- **Provider limits.** One request at a time per server, `maxlag=5`, a 5-second timeout and the operator's User-Agent (`WIKIDATA_USER_AGENT`; with none, nothing is requested and lookups wait). Search and entity requests are fresh: the stored result is the cache. Labels are cached for 7 days.
- **What is stored.** Wikidata candidates on the platform, with their id, revision, licence scope and retrieval time, plus developer and publisher labels. CC0 structured data only: no images, descriptions or other providers.

## The editor

The review page's **Prepared for review** section, right after what was submitted. Each part is labelled as one of these kinds:

| Label | What it holds |
| --- | --- |
| Source claim | Wikidata: one likely match, or several, none chosen. Developer, publisher, dates, other titles, warnings and provenance |
| In the catalog | Catalog games already using a candidate's Wikidata item, or having the submitted title as their title, alias or a source title: likely duplicates |
| Suggested | The cartridge shell the region usually means (NES and SNES), only when the collector wasn't sure. An inference to check |
| Missing | What the database still requires before publication, including physical evidence (a product code or barcode), which no source provides |

Editors read it through `get_submission_enrichment` (catalog editor with MFA). Approval, MFA, audit and the independent-review rules are unchanged.

## Also fixed

`guard_submitted_record` read `new.region_unknown_confirmed` on game rows too. As a result, collectors could not change the title of their own new-game submission: every edit of one failed. The check now runs on releases only.

## Tests

- **Database test 59:** permissions, claims, stale answers, back-off, the attempt limit, a title change, duplicates, and that the catalog is left unchanged.
- **App check:** `app:enrichment-checks`, collector to editor, with a local stand-in for Wikidata: a match, two matches, no match, and an outage that recovers. It uses a real browser for the JavaScript form and the automatic retry. The stand-in address (`MGD_WIKIDATA_API_URL`) is honoured only on loopback.

## Regional titles and the editor's confirmation (M15, second step)

The first real submission, "Joe & Mac 3" (SNES, PAL), showed four gaps. Wikidata had the game: Q4677160, *Joe & Mac 2: Lost in the Tropics*, whose European title "Joe & Mac 3: Lost in the Tropics" is an alias, with Data East as developer and dated releases per region (Japan 1994-02-18, North America 1994-04, Europe 1995-11). The lookup found and stored it. But:

1. **It was graded "ambiguous, different title".** Only an exact title counted, and the collector typed the box title without its subtitle.
2. **The regional dates were dropped.** Only the earliest date was kept.
3. **It appeared only on the submission's review.** The game's record read imported sources only, so it said "Added by hand".
4. **An editor couldn't accept it.** Nothing could make it the game's source.

What changed:

- **Matching (`match.ts`).** Each candidate says how it matches:

  | Match | Meaning | Example |
  | --- | --- | --- |
  | `exact` | the item's title | "Mega Man X" |
  | `regional_title` | another of its titles: an alias, a regional or a Japanese title | "Rockman X", "ロックマンX", "Super Probotector: Alien Rebels" |
  | `main_title` | the main part of a title, before its subtitle | "Joe & Mac 3", "Super Probotector" |
  | `partial` | found by Wikidata's search only | |

  The first three are *likely*. One likely candidate is "single_match", even with weaker ones listed beside it; two likely ones are the editor's choice. "&" and "and" compare equal.
- **Search.** English always: Wikidata keeps most regional titles as English aliases. Japanese is added for a Japanese title or an NTSC-J copy, and German and French for a PAL copy, whose box title is often a European label. That is at most three searches, one at a time. When nothing is found, the title's main part is searched as well.
- **Regional releases.** Each candidate keeps its release dates on the platform, with their places (P577 with P291). The review shows the date for the copy's region: PAL covers Europe and its countries and Australia, NTSC-U/C covers North America, NTSC-J covers Japan.
- **The game's record.** It shows the undecided candidates under **Automatically discovered — awaiting review**, in a dashed box above the record's own fields. Those fields stay "Not known" until a match is confirmed.
- **Confirm or reject (`decide_submission_enrichment`).** Catalog editors only, with MFA and their own reason, from the review or the game's record.

  Confirming stores the candidate's record exactly as the editor saw it (the importer's own parsed payload, kept with the candidate) as the game's Wikidata source, the way an import does:
  - an import run named `submission-lookup:<submission>:<item>`;
  - a promoted provider record;
  - title keys;
  - the external reference.

  It is audited as `catalog_source_confirmed` and shown in the record's history. It is refused while Wikidata isn't cleared for use, when the game already has a Wikidata source, and when the item is already another game's source (a duplicate, to merge instead).

  Rejecting is audited as `catalog_source_rejected` and stores nothing. Neither changes the game's title, verification, releases, pairings or publication.
- **Duplicates.** The catalog check covers unpublished identities too, and it also matches the likely candidate's other titles. A catalog *Joe & Mac 2* is found for a submitted "Joe & Mac 3".
- **Existing lookups.** The migration looks up again any stored lookup for a submission still waiting whose candidates lack the new fields. The earlier answer stays until the new one arrives.

**Known gap.** Wikidata states no publisher for Q4677160, so Elite Systems (the European publisher) can't come from it. The record says "Not stated by the source". Nothing is taken from other sites without cleared rights; adding the fact to Wikidata, or recording it by hand with evidence, are the editor's options.

### What a confirmation stores, and what it doesn't

| | After an editor confirms a match |
| --- | --- |
| **Source identity** | **Linked.** The game gets a Wikidata external reference (the item's id) and an import run naming the submission and the item. It's an editor's decision that this item is the game, audited (`catalog_source_confirmed`, with the editor's reason). It isn't a verification of the game. |
| **Developer, publisher, regional dates, other titles** | **Kept as the source's claims.** They're in the promoted provider record's payload, exactly as Wikidata stated them when looked up. The game's record *displays* them from that source record (get_game_source_facts), as it does for imported games. The other titles also become the game's matching keys (game_title_keys), so searches and duplicate checks find the game by them. |
| **Normalized game fields** | **Unchanged.** Title, kind, first-release date, aliases, verification and revision stay as they were. No developer, publisher or release-date column is written. An editor who wants a claim in the record edits the field as usual. |
| **Physical releases** | **Unchanged.** Region, format, packaging, dates, codes and verification are untouched. Nothing is verified or published, and a source is never evidence of a physical release. |
| **The submission** | **Unchanged.** It still waits for its review, and approval, changes and rejection work as before. |

**Who decides.** A catalog editor with MFA, who isn't the submitter: a catalog editor's own submitted game is decided by another editor, as with reviewing a submission (`own submission`). On the pilot today the only catalog editor is the submitter of "Joe & Mac 3", so that match waits for a second editor.
