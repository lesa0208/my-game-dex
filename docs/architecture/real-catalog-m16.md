# M16: a real catalog, and the route to a public one

My Game Dex needs games in it before it can be judged. M16 gives a local demo catalog of real games on nine platforms now, through the existing acquisition tools, and sets out the shortest legitimate route from sourced candidates to a reviewed public catalog.

## The demo catalog

A separate local stack, `my-game-dex-demo` (`MGD_STACK=demo`), served by its own preview at **http://127.0.0.6:3006**. Every page shows "Demo catalog. Real games from Wikidata, published for this local demo without editorial review. Not the real catalog."

### What's in it (built 2026-11-25)

| | Count |
| --- | --- |
| Distinct real games imported (Wikidata items, CC0) | **789** |
| Published and discoverable | **703** games, **910** game-platform pairings, 138 on more than one of these platforms |
| Not published (left for a person) | 86 games, 131 pairings |
| Other titles kept as aliases (alternate, regional, Japanese) | 2,096 |
| Releases, barcodes, editions, packaging | **0**: none is invented |

Discoverable per platform:

| NES | SNES | Mega Drive | Nintendo 64 | Game Boy | Game Boy Color | Game Boy Advance | PlayStation | PlayStation 2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 108 | 109 | 110 | 110 | 107 | 101 | 76 | 103 | 86 |

Of the 1,080 selected game-platform listings (120 per platform), the 170 not published carry a critical signal from the parser (a few carry two):

| Why not published | Listings with it |
| --- | --- |
| Possibly not physical on this platform: a digital statement for it, an unclassified format, or a date outside its era | 70 |
| Wikidata classes the item as something besides a video game (a compilation, an expansion, a series) | 69 |
| Two differently named IGDB entries: possibly two games in one item | 37 |

No item was ignored by the importer, and none was held as a possible duplicate. A game is one identity across platforms: a later platform's run finds its Wikidata id and adds the pairing.

### How it's built

Everything runs through the existing tools; `scripts/catalog-demo.mjs` only orders them:

1. `fetch`: one SPARQL snapshot per platform (video games stating it, with their Wikipedia sitelink count), and the selection: each platform's 120 best-known games by sitelinks.
2. `fetch-entities`: the selected items' entity records (the M12c-B1 fetch, rate-limited, with the operator's User-Agent).
3. `clear`: Wikidata clearance and CC0 rights on the demo stack, against the saved licensing page.
4. `stage`: the M5b importer as `catalog_importer`, one run per platform, each candidate with its risk assessment.
5. `publish`: three demo-only staff accounts, made in SQL and unable to sign in, use the real editor functions:
   - the demo editor adds the source's other titles (`add_game_alias`) and any pairing the importer skipped (`set_game_platform`);
   - the demo reviewer verifies the game and each eligible pairing (`verify_game`, `verify_game_platform`);
   - the demo publisher publishes (`publish_game_identity`). Whoever creates a pairing never verifies it, and whoever verifies never publishes, as in production.

Each pairing's basis says: "DEMO CATALOG ONLY, not physical evidence: published for the local demo from the Wikidata item's platform statement. No person checked a physical copy." Nothing is verified or published in any other stack, and no production rule was relaxed: the demo staff go through the same functions, checks and audit as people.

**Demo eligibility** (`demoIneligibility`): every critical signal blocks publication, with two narrow readings, both unit-tested:
- Several MobyGames ids, or IGDB slugs differing only by `--N`, are one game (MobyGames keeps one entry per platform). Two differently named IGDB entries still block.
- A game first published within the platform's retail era, whose only digital statements name no platform, was reissued digitally later (Virtual Console, Switch Online and PlayStation Network state "digital download" with no platform). Mario Kart 64, Super Mario Kart, Chrono Trigger and Link's Awakening are like this. A digital statement for this platform, or a date after the platform's era (homebrew, a modern release), still blocks it.

The real catalog keeps both for a person.

### Collectors

Games without a release are added as the collector's own unidentified copies (M12a): the platform, the region they say (every region is one click when the catalog has none) and the edition as "not sure" until they name it. They stand on the system shelves like any copy.

### Isolation

- **Own stack and data.** Its own project, volumes and database. `test-stack.mjs run` refuses it, as it does the pilot, so no suite runs on it through the test tooling; it is meant for `catalog-demo.mjs`, the demo preview and `app:demo-catalog-checks` only (which removes everything it makes). Every write in `catalog-demo.mjs` checks the project name and the API port.
- **Ports.** It uses the rehearsal stack's ports (59320–59329), which the `MGD-Rehearsal-Block-In` firewall rule already blocks from the network. The two never run at once: each refuses to start while the other runs. A dedicated rule would let it move (below).
- **Own preview and build.** Its own preview address (cookies are per host), and its own build folder (`.next-demo`) made with its URL and the banner.
- **Nothing flows out.** No tool reads the demo to write elsewhere. Its demo staff and their verifications exist only in its database.

### Using it

```bash
MGD_TEST_STACK=demo node scripts/test-stack.mjs start     # if it isn't running
npm run demo:preview                                       # build and serve http://127.0.0.6:3006
```

Sign up with any email address at the preview. The confirmation email arrives in the demo's Mailpit at http://127.0.0.1:59324.

To rebuild it from fresh snapshots (outside the repository):

```bash
D=~/.my-game-dex/demo/<date>
node scripts/catalog-demo.mjs fetch --out $D --per-platform 120
node scripts/catalog-demo.mjs fetch-entities --dir $D
MGD_STACK=demo node scripts/catalog-demo.mjs clear --terms-file ~/.my-game-dex/source-evidence/2026-11-19/wikidata-licensing.html
MGD_STACK=demo node scripts/catalog-demo.mjs stage --dir $D --terms-file ~/.my-game-dex/source-evidence/2026-11-19/wikidata-licensing.html
MGD_STACK=demo node scripts/catalog-demo.mjs publish --dir $D
MGD_STACK=demo node scripts/catalog-demo.mjs report
```

## The route to a public catalog

The existing batch review already scales for game identities. What does not scale yet is physical evidence.

1. **Acquire.** The same fetch and staging, into an editorial stack (the pilot, later production), per platform. The parser's flags go with each candidate.
2. **Batch review** (M12c-B1, M14c). `create_review_batch` per import run and platform. A person records an outcome for every flagged member and for a random sample. The sample barely grows with the batch (policy: 2 % tolerable error, 95 % confidence, acceptance 0):

   | Batch | Sample to check |
   | --- | --- |
   | 100 | 78 |
   | 500 | 129 |
   | 1,000 | 138 |
   | 3,000 | 145 |

   One or two approvals (a second above 1,000 members) then verify **every accepted member's game identity at once**. That is how thousands of identities get verified without one-by-one entry.
3. **Physical evidence: the blocker.** A game is public on a platform only with a published release or a pairing verified with a person's evidence note (M14a, M14c-1). Batch approval verifies the pairings of the sampled members found correct. Every other accepted member stays "Awaiting physical evidence", and a Wikidata platform statement is, rightly, not evidence. A legitimate route to thousands needs one of these product decisions:
   - **A physical-release source with usage rights.** Preservation datasets that list dumps of physical cartridges and discs (No-Intro, Redump; the importer already parses No-Intro) evidence that a physical copy existed, release by release. Their terms aren't cleared. Cleared, each pairing's basis cites the dataset's record, and the batch sample checks those citations.
   - **Batch-level evidence.** Let an approved batch carry its sample's checked evidence to the unsampled members whose source states a physical format for that platform. This changes `approve_review_batch` and the evidence rule, so it is a policy and legal decision before it is a migration.
   - **Collectors' evidence.** Copies collectors add, with their photos, as evidence an editor accepts. A larger feature, later.

   The recommendation: clear a physical-release dataset first. Its records are evidence a person can check by sample, it gives real releases (with product codes and regions) instead of identity-only games, and the import and batch tools already handle it.
4. **Publication.** `publish_game_identity` by an editor who didn't verify the evidence, per game. A batch publication path is the next tool to build once evidence scales.

### Found and fixed on the way

- **Platform game counts** (migration `20261219100000`). `list_catalog_platforms` counted games through releases only, so an identity-only catalog said "Nintendo 64 (0)". It now counts published games with a published pairing. pgTAP `62`.
- **Distribution formats.** The new platforms' physical formats (the Game Paks, DVD, UMD and others) and digital channels (Virtual Console, PlayStation Network) are classified, from their own Wikidata labels. The SNES pilot's twelve are unchanged.
- **Systems shelf accessibility.** A system tile's accessible name replaced its visible text ("Game Boy: 1 copy" for "NINTENDO GB 1 copy"), which fails WCAG 2.5.3. It now reads the visible text, then the full name.

### Found, not fixed here

- **The importer skips a platform's pairing when the record is unchanged.** It keeps one source record per Wikidata item. When an item's record is identical for two platforms, the second platform's run finds it "unchanged" and adds no pairing (116 of the demo's listings). The demo editor added the eligible ones through `set_game_platform`. A real multi-platform import needs the importer to pair on a matched-but-unchanged record (a `catalog_import` change and migration) before step 1 runs on several platforms.
