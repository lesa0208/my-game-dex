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
