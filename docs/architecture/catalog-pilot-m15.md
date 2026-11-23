# M15: the isolated SNES pilot stack

**Written for:** the product owner and the operators of the first real SNES catalog pilot, and
whoever reviews its tooling. **Status, 2026-11-23 (M15 P1a):** tooling only. The pilot stack
**does not exist**. No account, role, rights record, staging, batch, outcome, approval,
publication, backup or snapshot was created for it. Everything below runs only at checkpoint P1
and later, each step with its own authorization.

The pilot is where real people make the first real catalog decisions: which SNES games exist, and
which become public as identities. It doesn't run on development (the product owner's working
data), the test stack (fixtures), scratch (destroyed by every suite) or B1 (the technical pilot,
kept as its record: [catalog-ingestion-m12c-b1.md](catalog-ingestion-m12c-b1.md)). It gets its
own stack, which no test, fixture, suite, benchmark or mutation runner can reach.

## The stack

| | Pilot | B1 (unchanged) |
| --- | --- | --- |
| Selector | `MGD_STACK=pilot` (tools), `MGD_TEST_STACK=pilot` (`test-stack.mjs`) | `MGD_STACK=b1`, `MGD_TEST_STACK=b1` |
| Project and folder | `my-game-dex-pilot` in `.supabase-pilot/` (git-ignored) | `my-game-dex-b1` in `.supabase-b1/` |
| Ports | development's plus 4000: API 58321, database 58322, Mailpit 58324 | plus 3000: 57321, 57322, 57324 |
| Docker volume | `supabase_db_my-game-dex-pilot` (and the stack's own Auth and Storage volumes) | `supabase_db_my-game-dex-b1` |
| Preview | `http://127.0.0.5:3005` (`npm run pilot:preview`) | `http://127.0.0.4:3004` |
| Auth | sign-up off; `site_url` and the only redirect are the preview | as development |
| Seed | never loaded (`[db.seed] enabled = false`) | as development |
| Migrations | every migration on `main` when created (82 today) | its own 72 |
| Working folder | `~/.my-game-dex/catalog-pilot/m15-pilot/` | `~/.my-game-dex/catalog-pilot/m12c-b1/` |
| Backups | `~/.my-game-dex/backups/pilot/`, volumes `mgd_pilot_db_snapshot_*` | none |
| Editors | real people only | a disposable editor A, and reviewers on `@example.test` |

Every endpoint is loopback. The preview's own address keeps the pilot's sign-in cookie apart from
development's on `127.0.0.1:3000`, which nothing here starts, stops or reads. The ports and
project ids are checked to collide with no other stack (`scripts/pilot-stack.test.mjs`).

## Protections

- **Not a test target.** `scripts/lib/stack.mjs` refuses the pilot in `guardDevStack()`, so in
  `stackStatus()` too, unless the caller says it is an editorial tool (`{ editorial: true }`). Only
  four scripts do: `catalog-b1.mjs`, `catalog-b1-review.mjs`, `pilot-preview.mjs` and
  `pilot-backup.mjs` (a test fails if another says so). `db.mjs` allows only its read-only
  `migrations` check: `db:reset`, `db:test`, `db:pgtap`, `db:verify` and the suites refuse it.
  `test-stack.mjs run` refuses it. The mutation runners already accept only scratch.
- **Created only on request.** `test-stack.mjs start` refuses to create the pilot unless
  `MGD_CREATE_PILOT=1`. What counts as existing is its database volume: a config whose volume
  was deleted (by `destroy`, a Docker prune or a lost disk) is refused, not rebuilt, and so is a
  volume without its config. `db.mjs start` refuses the pilot.
- **A restart changes nothing.** A restart doesn't regenerate the pilot's config or copy
  migrations: it is refused if this checkout's `supabase/config.toml` or migrations differ from
  the pilot's. Restart it from the checkout it was created from.
- **The marker.** Creating the pilot writes `~/.my-game-dex/protect-pilot-stack` as soon as it
  starts (`MGD_TEST_STACK=pilot node scripts/test-stack.mjs protect-pilot` writes it again). While it exists, `reset` and `destroy` (which deletes the
  volumes) refuse, whatever the environment says. Without it they still need
  `MGD_ALLOW_PILOT_RESET=1`; B1's `MGD_ALLOW_B1_RESET` doesn't count.
- **Nothing rewrites it.** No tool here runs `db reset`, `migration repair`, `migration up`, a seed,
  a restore or `pg_restore --clean` on the pilot. Migrating an existing pilot is a separate,
  authorized activation, as for development.
- **Explicit stacks.** The editorial tools refuse a missing `MGD_STACK`, development, test, scratch
  and unknown names, check the config's project and the API port against the registry
  (`EDITORIAL_STACKS`), and have no hard-coded endpoints. On B1 they behave as before.
- **Pinned sources.** On the pilot, `stage` accepts only the files verified for it, by SHA-256
  (`scripts/lib/pilot-sources.mjs`), and refuses the superseded first entity fetch by name.
  Clearance and rights need `--decision "<the product owner's decision for this pilot, dated>"`:
  B1's decision D2 isn't assumed to carry over.
- **No automatic people.** On the pilot `editor-a` refuses, and addresses ending in
  `@example.test` are refused. Every decision command needs an interactive terminal, the editor's
  own password and authenticator code, a typed reason and a typed confirmation. Nothing stores or
  types an editor's credentials. On the pilot, `create-batch` doesn't run B1's refused-write
  probes (a self-review and a self-approval attempt) with the real creator's session: only its
  read checks. Staging accepts `--platform snes` only.

## The source files (verified read-only, 2026-11-23)

| Role | File | SHA-256 |
| --- | --- | --- |
| entities | `~/.my-game-dex/catalog-snapshots/2026-11-20/wikidata-entities-snes-2026-11-20T22-45-42-949Z.json` | `96a8ac56…20da92` |
| selection | `~/.my-game-dex/catalog-pilot/m12c-b1/selection-snes-150.json` | `a3774c7b…8961f9c` |
| notes | `docs/proposals/m12c-b1/editorial-review-snes-150.json` | `c24d2a0a…e2f1c68` |
| terms | `~/.my-game-dex/source-evidence/2026-11-19/wikidata-licensing.html` | `dd71f104…f82a5c5` |
| formats | `~/.my-game-dex/catalog-snapshots/2026-11-20/wikidata-formats-2026-11-20T18-32-38-232Z.json` | `93797a67…bff1c7` |
| **refused** | `wikidata-entities-snes-2026-11-20T14-11-04-475Z.json` (the superseded first fetch) | `4e87b22e…6d8cd` |

The full hashes are in `scripts/lib/pilot-sources.mjs`. `stage` checks the entities, selection,
notes and terms; the formats snapshot isn't one of its inputs and is pinned for the record (it is
what the distribution-format table was built from). The 34 editorial notes are a person's
recommendations, not decisions: staging uses them only to hold 13 records out of the batch. Every
outcome is still recorded by a reviewer. An older saved licensing page
(`sources/2026-11-09/terms/`) has a different hash and is refused.

## Editors A and B

The database's separation of duties needs at least two people: the batch's creator can't review
or approve it, and a member's reviewer can't publish it. With 137 candidates (41 flagged, 21 of
them critical, and 75 sampled), one approval is needed.

- **Editor A** creates the batch and later publishes the members B confirmed.
- **Editor B** reviews the 116 members that need an individual outcome and approves the batch.

Each is a real person at this computer with their own address, password and authenticator. They
register themselves; the operator only grants the role:

```sh
# The editor, at the terminal: their own address and a password they type (not shown).
MGD_STACK=pilot node scripts/catalog-b1-review.mjs reviewer-account --email <their address>
# The editor, on http://127.0.0.5:3005: sign in, choose a handle, then
# Settings → Security: add an authenticator with their own app.
# The operator, after both steps:
MGD_STACK=pilot node scripts/catalog-b1-review.mjs grant-editor --email <their address>
```

Grant both editors before the batch exists: `grant-editor` refuses an account that created a
batch or catalog records. The address stays on this computer: accounts are created already
confirmed, and the only mail the pilot can send (a password reset) goes to its own local Mailpit
on port 58324. No agent registers, signs in as or acts for an editor.

**The Owner.** No catalog function checks the Owner record (`private.platform_owner`, M8): review,
approval and publication need `catalog_editor`, a recent second factor and the rights record.
So assigning an Owner is **not** a prerequisite for the pilot. The pilot starts with no Owner and
no administrator, and nothing here assigns one or changes a role on any other stack. Assigning
the platform's Owner (development has none today) is a separate, audited M8 procedure, decided
apart from the pilot.

## Backups and snapshots

At each checkpoint, a dump and a cold snapshot (each refuses a name that exists, and nothing is
overwritten):

| Checkpoint | When |
| --- | --- |
| `empty` | freshly created and migrated, before any account |
| `staged` | after clearance, staging and the rights record |
| `batch` | after editor A created the batch |
| `reviewed` | after editor B recorded every outcome |
| `approved` | after the approval |
| `published` | after editor A's publications |
| `audited` | after the final checks, if anything changed |

```sh
npm run pilot:backup -- dump --checkpoint <name>       # pg_dump -Fc, roles, table of contents,
                                                       # migrations with checksums, inventories, SHA-256 manifest
npm run pilot:backup -- snapshot --checkpoint <name>   # stops the pilot only, checks a clean shutdown and no
                                                       # lock file, copies the volume, compares every file's
                                                       # checksum, owner, mode and time, restarts, re-checks
npm run pilot:backup -- verify --manifest <file.sha256>
```

Dumps go to `~/.my-game-dex/backups/pilot/`, created with mode 600 (owner-only on macOS and
Linux; on Windows the folder inherits the user profile's permissions). `verify` refuses a
manifest that is incomplete, lists a file twice or names a file outside its backup. Stop the
preview before a snapshot: the tool compares the data before the stop and after the restart, and
a sign-in in between shows as a difference. The inventories are the
integrity queries used for every development activation (`scripts/sql/integrity/`).

## Recovery (separately authorized)

There is no restore command. Restoring the pilot replaces real editorial history, so it is done
only with the product owner's explicit authorization for that restore, naming the checkpoint:

1. Record why, and the current state: a fresh `dump --checkpoint audited` of the damaged pilot,
   kept beside the others. Never delete the damaged volume.
2. Restore into a **new, empty** database owned by `postgres` on a throwaway stack (scratch), never
   with `pg_restore --clean` over a running database. Create `catalog_importer`,
   `supabase_functions_admin` and `supabase_realtime_admin` first. Compare its inventories with the
   checkpoint's.
3. Only then, with the pilot stopped: remove the marker, copy the chosen `mgd_pilot_db_snapshot_*`
   volume back over `supabase_db_my-game-dex-pilot` (as the snapshot was taken, in reverse),
   start the pilot, compare the inventories with the checkpoint's, and write the marker again.
4. Report what was lost between the checkpoint and the failure. Every decision taken since is
   recorded again by its editor, never replayed by a tool.

## P1, when authorized

From a clean checkout of `main` (not the development checkout, whose server on port 3000 keeps
running):

1. `MGD_CREATE_PILOT=1 MGD_TEST_STACK=pilot node scripts/test-stack.mjs start` (it writes the
   marker once the stack is up).
2. `MGD_STACK=pilot node scripts/db.mjs migrations`: every migration applied, none pending.
3. `npm run pilot:backup -- dump --checkpoint empty`, then `snapshot --checkpoint empty`.
4. `npm run build`, then `npm run pilot:preview` (it refuses unless the API is the pilot's).

Then, each with its own authorization: the rights decision for the pilot, clearance
(`clear-wikidata --terms-file … --decision …`), staging (`stage` with the pinned files and a reason),
`record-wikidata-rights` and a `staged` checkpoint; the two editors' registration; the batch
(`create-batch --email <editor A>`, typed by A) and a `batch` checkpoint; B's review in
Admin → Catalog and a `reviewed` checkpoint; B's approval and an `approved` checkpoint; A's
publications and a `published` checkpoint.

**Known limits of this tooling (to settle before P1):**

- **Signing keys.** Every local stack uses the Supabase CLI's default JWT secret and default API
  keys, so development's secret key would be accepted by the pilot's API if someone pointed it at
  port 58321. The tools never do (each reads the URL and keys of the stack it checked together),
  but isolation is by address, not by credential. Giving the pilot its own signing keys needs a
  rehearsal on scratch first; until then, the operator keeps `.env.local` pointed at development.
- **Not yet rehearsed:** a real `dump` and `snapshot` (that `pg_dump` runs as `supabase_admin` in
  the container, and `pg_controldata` as the image's entry point). Rehearse both on a disposable
  copy before the `empty` checkpoint.
- `scripts/catalog-import-role.mjs` (the importer login switch `stage` uses) has no stack guard of
  its own; it predates M15 and is reached on the pilot only through `stage`.

**Still open before P1:** the product owner's P0 decisions (where the pilot runs, the rights
decision for it, who editors A and B are, the pilot size), and a second real person with local
access. Pairings are verified through batch approval; there is no admin page for
`verify_game_platform` on its own.
