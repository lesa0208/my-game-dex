# IGDB enrichment (M18a)

IGDB adds metadata and artwork to the catalog's **existing** game identities. It doesn't create, merge, verify or publish games, and it never writes a game's own fields. IGDB's answers are source claims, attached to an identity and shown labelled as IGDB's.

Depends on M17b (PR #38, `m17b-game-details`), which depends on M17a (PR #37). Branch `m18a-igdb` starts at 825d371.

## The pieces

| Piece | Where | What |
| --- | --- | --- |
| API client | `scripts/lib/igdb-client.mjs` | Twitch OAuth client credentials. The token is cached in memory and renewed a minute before it expires, or once on a 401. At most 4 requests start in any second and 8 are open at once (IGDB's documented limits; the defaults are 3 and 4). Retries 429 (honouring `Retry-After`), 5xx, timeouts and network failures with back-off; a refused query (400) isn't retried. Errors never carry a credential or token, and the credentials go in the token request's body, not its URL. Another API URL is accepted only on loopback (a local stand-in) |
| Credentials | `scripts/lib/igdb-config.mjs` | `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET`, from the environment or a file outside the repository (default `~/.my-game-dex/secrets/igdb.env`). A file inside the repository is refused. Nothing prints a value |
| Matcher | `scripts/lib/igdb-match.mjs` | Pure decisions; see Matching |
| Tool | `scripts/igdb.mjs` (`npm run igdb -- …`) | `check`, `platforms`, `clear`, `enrich`, `resume`, `report` |
| Database | migration `20261221100000_m18a_igdb_provider_metadata.sql` | Provider row, media gate, enrichment runs, attaching, the public read |
| App | `src/features/catalog/provider-metadata.ts`, `provider-images.ts` | The cached public read; IGDB image addresses |

The app never calls IGDB. Covers and screenshots go through the app's image optimizer (`next.config.ts` `images.remotePatterns`: `images.igdb.com/igdb/image/upload/**` only, no query strings). The server fetches and caches them, and the browser only ever loads `/_next/image` from the app.

## Credentials (local setup)

In your own terminal. Never paste them in a chat, an issue or a commit.

1. In the Twitch developer console (https://dev.twitch.tv/console/apps), register an application with client type **Confidential**, and create a Client Secret.
2. Create `%USERPROFILE%\.my-game-dex\secrets\igdb.env` with two lines:
   ```
   IGDB_CLIENT_ID=<Client ID>
   IGDB_CLIENT_SECRET=<Client Secret>
   ```
3. Restrict it to your account. In PowerShell: `icacls "$env:USERPROFILE\.my-game-dex\secrets\igdb.env" /inheritance:r /grant:r "$($env:USERNAME):(R)"`.
4. Check it: `node scripts/igdb.mjs check --live`. It says whether each value is set and whether Twitch issued a token, never the values.

The secret scan (`npm run secrets:check`) runs before every demo build. The file is outside the repository, so it can't be committed.

## The database

- **The provider.** `igdb` is a row in `private.external_providers`, uncleared. An operator records clearance against the saved basis (`record_provider_clearance`, with the basis file's hash), as for Wikidata.
- **The media gate.** IGDB's images have a gate of their own: `private.record_provider_media`, with new columns `media_cleared`, `media_note` and `media_recorded_at`. It needs the provider cleared. Text metadata can be shown while images stay off. Withdrawing either hides the data at once.
- **Enrichment runs.**
  - `catalog_import.start_enrichment_run` starts an import run with no platform; the `import_runs_platform` check now allows that for enrichment providers.
  - Records are staged by the existing `stage_records`, as immutable source claims in `private.provider_records`.
  - `catalog_import.apply_record` now refuses enrichment records: it would match by title or create a game.
- **Reading candidates.** `catalog_import.enrichment_candidates(provider, slugs)` is a read-only function for `catalog_importer`. For published games only, it returns:
  - title, aliases, platforms and first release;
  - the Wikidata id and the IGDB slugs Wikidata states (P5794, from the stored Wikidata record);
  - an existing IGDB link.
- **Attaching.** `catalog_import.attach_game_record(run, lease, igdb_id, game, tier, notes, checkpoint)` attaches the run's unheld record to a published game:
  - It links the IGDB id in `private.external_references` beside the game's Wikidata id, and marks the record matched with the matcher's tier and notes.
  - It allows one IGDB id per game and one game per IGDB id, and refuses a held record or an unpublished game.
  - It writes nothing on the game. Run again, it reports the record as skipped.
- **Display.** `public.get_game_provider_metadata(uuid[])` is the only read, and **only the app server may call it** (service_role, with `SUPABASE_SECRET_KEY`; migration `20261222100000`): no public Supabase client, signed in or not, can fetch IGDB's records as stored, because IGDB's terms rule out redistributing its data as-is through our own API. It returns data only for published games, while the provider is cleared, from the latest attached record for the game's linked id. Images come only while media are cleared, image ids are validated, arrays are bounded, and the IGDB URL must be an `igdb.com/games/…` address.

Held records (needing review) stay in `provider_records` as `needs_review` with their reason, unapplied. The editor review queue reads release reclassifications only, so they can't be resolved into games there.

## Matching

A match is accepted (tier A, "high") only when it is **anchored** and **every check agrees**:

| Check | Rule |
| --- | --- |
| Anchor | The IGDB game is one Wikidata states for this identity (P5794) |
| Title | IGDB's name, or an alternative or localized name, equals the game's title or an alias (ignoring case, accents, punctuation and a leading "The") |
| Platforms | At least one platform in common (our slugs mapped to IGDB ids, checked against IGDB's names before every fetch) |
| Date | First release years at most one apart, when both are known |
| Type | IGDB's `game_type` is a main game (or an expanded game): not a remake, remaster, port, bundle, expansion, DLC, mod, episode, season, pack, update or fork |

Anything else stays **unresolved, for review**, with its reasons:

- **No anchor.** IGDB's search runs on the game's platforms for the report, and its best candidate is noted as "probable", but it is never matched on title, platform and date alone.
- **Unknown anchor.** IGDB doesn't know the slug Wikidata states.
- **Several anchors.** Several anchors pass every check, or another anchor can't be told apart (same platforms, not a remake or port), or one isn't found.
- **A failed check.**
- **An existing link.** The game is already linked to another IGDB id.

Platforms the catalog lists but IGDB doesn't are noted (for example a later port or compilation that Wikidata pairs with the original), not hidden.

## What is stored, and shown

The record stores what IGDB returns, bounded:

- id, slug, name, URL, summary (4,000 characters at most) and game type;
- first release date and platforms;
- genres, themes, developers and publishers (from involved companies by role);
- alternative names;
- the cover, up to 8 screenshots and up to 4 artworks, each as an image id and size;
- the time it was fetched.

| Where | What | Rule |
| --- | --- | --- |
| Game page, artwork | IGDB's cover, framed as artwork, captioned "Game artwork from IGDB.com. General game artwork, not verified for a specific platform, region or edition." | An approved physical-item image (the M17b registry) comes first. **Only on a platform IGDB lists for the game** (`platform_ids`; never the SNES cover on the GBA page); elsewhere, and with no cover, the honest fallback stays. Never laid on a cartridge or presented as a release |
| Overview | IGDB's summary, "Description from IGDB.com" | Only when the catalog has no summary of its own |
| Game Details | "From IGDB": developers, publishers, genres, themes, and the credit | Labelled as IGDB's. The hero's publisher stays the catalog's (only when every verified release agrees) |
| Gallery | IGDB's screenshots, "Game screenshots from IGDB.com, not tied to a platform or release" | Same platform rule as the cover. The tab appears when there are approved images or IGDB screenshots |
| Explore cards | The cover on the card's stage, instead of the console art | With a platform chosen, only on a platform IGDB lists. One credit under the grid: "Cover art: IGDB.com. General game artwork, not a specific platform, region or release." |

**Not written.** IGDB's alternative names don't become catalog aliases, and its first release date doesn't replace the catalog's. Its platforms don't add pairings, and nothing becomes a physical release. Differences are in the report.

IGDB's answers stay **outside the repository**, in the snapshot directory (default `~/.my-game-dex/igdb/<date>-<batch>/`: `candidates.json`, `igdb.json`, `decisions.json`, `report.md`). The repository is public, and IGDB's content isn't ours to publish there.

## Rights

- **Text metadata.** Shown on a stack only after `clear` records IGDB's clearance against the saved basis.
- **Images.** Shown only after `clear --media`, and only where the deployment sets `MGD_PROVIDER_MEDIA=igdb`. Only the local demo preview does.
- **Public distribution isn't cleared.** IGDB doesn't sublicense third parties' intellectual property: a cover's rights belong to its publisher. The product owner has stated a written interim authorization from IGDB for development, a public beta and commercial use with attribution, with formal partnership onboarding pending. Before any public deployment shows images, decide and record how that authorization applies to storing and showing media.
- **Storage and termination.** IGDB's FAQ allows storing and keeping data; the Twitch Developer Services Agreement it points to limits caching to 24 hours and requires deletion on termination unless authorized in writing (see catalog-acquisition-m12c-b0.md). Long-term storage here rests on the written authorization the product owner reports, which should be filed as the clearance basis. On termination: withdraw clearance (everything disappears from the app at once), then an operator deletes the provider's rows in SQL (`import_run_records`, `provider_records` and `external_references` where the provider is `igdb`, then its `import_runs`), and the snapshot directories. No deletion command exists yet.
- **Attribution.** Visible wherever IGDB's data or images appear: the cover caption, the description, Game Details and the Gallery each link to IGDB.com (the game's IGDB page where known), and Explore credits covers under the grid.

## Running it on the demo

```
MGD_STACK=demo node scripts/igdb.mjs clear --basis-file <saved basis, outside the repo> --note "<what it is>" [--media --media-note "<scope>"]
MGD_STACK=demo node scripts/igdb.mjs enrich --batch m18a-first-20 --dry-run          # report only
MGD_STACK=demo node scripts/igdb.mjs enrich --batch m18a-first-20 --basis-file <same> --reason "M18a first batch"
```

`enrich` enables `catalog_importer` with a one-off password for the command, and disables it after. It refuses the pilot, B1, rehearsal and development stacks. If a run stops, `resume --run <id> --out <dir> --basis-file <same>` stages again (idempotent) and attaches only what isn't attached.

## Checks

| Check | What it covers |
| --- | --- |
| `npm run igdb:test` (CI) | 22 tests on synthetic data: the token cache, renewal and 401 retry; 429 with `Retry-After`; 5xx, timeouts and network failures; a refused query; the per-second and open-request limits; loopback-only stand-ins; the credentials loader; every matching rule; the stored payload |
| `supabase/tests/database/64_m18a_igdb_enrichment.test.sql` | 34 tests: the provider and media gates; enrichment runs; candidates; staging; `apply_record` refusing; attaching and its refusals; no game field or alias changed; the public read and its gates; access |
| `MGD_STACK=scratch npm run app:igdb-checks` (after `npm run build`) | 23 end to end, with a local stand-in for IGDB and Twitch: clearance; the tool as `catalog_importer`; requests within the limit; decisions; held records; nothing created or changed; resuming; the game page, Explore and the Gallery; the catalog's own summary first; a held game showing nothing; the browser never contacting IGDB or Twitch; axe |
