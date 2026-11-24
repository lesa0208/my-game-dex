# M15: the isolated SNES pilot stack

**Written for:** the product owner and the operators of the first real SNES catalog pilot, and
whoever reviews its tooling. **Status, 2026-11-24 (M15 P1a, with its hardening):** tooling only,
rehearsed on a disposable twin. The pilot stack **does not exist**. No account, role, rights record, staging, batch, outcome, approval,
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
- **The marker, before anything exists.** Creating the pilot writes
  `~/.my-game-dex/protect-pilot-stack` (`"state": "creating"`, with the pilot's own signing key's
  id) *before* `supabase start` creates its database volume, so a volume never exists unprotected.
  A start that fails or is killed half-way leaves a protected, partial pilot: the next start
  resumes it (without `MGD_CREATE_PILOT` if its volume exists; the tool says when the flag is
  needed again). Only when a start has succeeded and the running pilot uses its own keys does the
  marker say `"created"`; from then on a missing volume is never created again, flag or not
  (`scripts/lib/stack-marker.mjs`). While the marker exists, `reset` and `destroy` (which deletes
  the volumes) refuse, whatever the environment says; without it they still need
  `MGD_ALLOW_PILOT_RESET=1` (B1's `MGD_ALLOW_B1_RESET` doesn't count).
- **No marker, no pilot.** A restart refuses while the marker is missing, unreadable, another
  stack's or for other signing keys, and so does every tool (`stackStatus()` checks it for the
  editorial tools, the preview and the backups). The tools also refuse a pilot whose marker still
  says `creating`: one more guarded start checks it and marks it created. `db.mjs start` refuses
  the pilot and its twin. Nothing writes it back automatically: if it is
  missing and no authorized recovery removed it, the operator confirms this is the pilot created
  at P1 and runs `MGD_TEST_STACK=pilot node scripts/test-stack.mjs protect-pilot`.
- **Docker must answer.** Only Docker's own "no such volume" counts as a missing volume; any other
  error (the daemon down, another context) stops the start, so an existing pilot is never taken
  for a missing one.
- **Its own signing keys.** Every other local stack shares the Supabase CLI's built-in
  credentials, which are public: one ES256 signing key, one HS256 JWT secret, one publishable and
  one secret API key, and one pair of Storage S3 keys. So development's secret key or a development
  session would otherwise be valid on the pilot. Creating the pilot generates its own
  (`scripts/lib/stack-keys.mjs`): an ES256 signing key (`.supabase-pilot/supabase/signing_keys.json`),
  and a JWT secret and publishable and secret keys (`.supabase-pilot/supabase/.env`). They are
  random, owner-only, git-ignored, written once and never printed. The generated config names them
  (`env(…)`, `signing_keys_path`), never their values. Storage's S3 protocol, whose keys the CLI
  can't change, is off on the pilot (the app doesn't use it). A restart refuses if the key files
  are missing, empty or malformed (it would fall back to the shared keys), and key variables set
  in the shell are never passed to the CLI. `supabase status` only repeats the config, so after
  every start, and in every tool, the *running* pilot is checked: its Auth must publish only its
  own signing key, and its own secret key (read from the key file) must open its Auth admin API;
  if not, the start stops it again and the tool refuses. Proof: [Rehearsal](#rehearsal-2026-11-24).
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

Dumps go to `~/.my-game-dex/backups/pilot/`. Each file is created with mode 600 (owner-only on
macOS and Linux); on Windows mode bits do nothing and the files inherit the user profile's ACL
(this user, SYSTEM and Administrators: checked by the rehearsal). The manifest is written last:
a dump that fails is labelled `.FAILED.txt` and has no manifest, so it never verifies, and its
name is never reused. `verify` refuses a manifest that is incomplete, lists a file twice or names
a file outside its backup. A snapshot first runs every restart check
(`test-stack.mjs preflight`), so it never stops a pilot this checkout couldn't start again, and it
restarts through `test-stack.mjs` (all its start checks). Stop the preview before a snapshot: the
tool compares the data before the stop and after the restart, and a sign-in in between shows as a
difference. The inventories are the
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
3. Only then, with the pilot stopped (`MGD_TEST_STACK=pilot node scripts/test-stack.mjs stop`),
   and the marker left in place: copy the chosen `mgd_pilot_db_snapshot_*` volume back over
   `supabase_db_my-game-dex-pilot` (as the snapshot was taken, in reverse: empty the volume, then
   `cp -a`), compare the two volumes' checksums, start it with the same command as any restart
   (its guards check the marker, its config and its own keys), and compare the inventories with
   the checkpoint's. The rehearsal does exactly this on the twin.
4. Report what was lost between the checkpoint and the failure. Every decision taken since is
   recorded again by its editor, never replayed by a tool.

The pilot's own key files (`.supabase-pilot/supabase/.env` and `signing_keys.json`) aren't in
the database volume or the backups: keep them with the checkout the pilot was created from. A
snapshot copied back works only with them. If they are lost, the data is intact but the pilot
can't start (a restart refuses rather than fall back to the shared keys). Giving an existing pilot
new keys hasn't been rehearsed: it would end every session, and the database still holds the old
JWT secret (below), so it is its own authorized procedure, rehearsed on the twin first. The volume and the snapshots hold the
JWT secret too (as `app.settings.jwt_secret`, and Realtime's tenant record): treat snapshots and
dumps as secret.

## P1, when authorized

From a clean checkout of `main` (not the development checkout, whose server on port 3000 keeps
running):

0. The rehearsal on the twin, from the same checkout, with nothing else changed since it passed
   (see [Rehearsal](#rehearsal-2026-11-24)); then destroy the twin.
1. `MGD_CREATE_PILOT=1 MGD_TEST_STACK=pilot node scripts/test-stack.mjs start` (it writes the
   marker first, then the pilot's own keys, then starts it). If it fails, run the same command
   without `MGD_CREATE_PILOT` to resume; never `destroy` a partial pilot without authorization.
2. `MGD_STACK=pilot node scripts/db.mjs migrations`: every migration applied, none pending.
3. `npm run pilot:backup -- dump --checkpoint empty`, then `snapshot --checkpoint empty`.
4. `npm run pilot:preview`: it refuses unless the API is the pilot's and the running pilot uses
   its own keys, then builds the app with the pilot's URL and keys into its own folder,
   `.next-pilot/` (`MGD_NEXT_DIST_DIR`, next.config.ts), scans its browser bundles for secrets and
   serves that build. A build made with `.env.local` could carry development's cached catalog into
   the preview, and a pilot build in `.next/` would be served by the app checks and the B1 preview:
   neither happens.

Then, each with its own authorization: the rights decision for the pilot, clearance
(`clear-wikidata --terms-file … --decision …`), staging (`stage` with the pinned files and a reason),
`record-wikidata-rights` and a `staged` checkpoint; the two editors' registration; the batch
(`create-batch --email <editor A>`, typed by A) and a `batch` checkpoint; B's review in
Admin → Catalog and a `reviewed` checkpoint; B's approval and an `approved` checkpoint; A's
publications and a `published` checkpoint.

## Rehearsal (2026-11-24)

On the disposable twin (`MGD_TEST_STACK=rehearsal`: project `my-game-dex-rehearsal`, ports plus
5000, its own keys, marker `~/.my-game-dex/protect-rehearsal-stack`, created with
`MGD_CREATE_REHEARSAL=1`; same image and migrations as the pilot) and the scratch stack, which has
the CLI's shared keys (development's: every key of development's `status` equals scratch's). No
other stack was touched. Repeat it from the P1 checkout before creating the pilot:

```sh
MGD_CREATE_REHEARSAL=1 MGD_TEST_STACK=rehearsal node scripts/test-stack.mjs start
MGD_TEST_STACK=scratch node scripts/test-stack.mjs start
MGD_TEST_STACK=rehearsal node scripts/test-stack.mjs run db:pgtap     # then: run db:suites
MGD_TEST_STACK=rehearsal node scripts/test-stack.mjs reset            # suites leave FK-orphan rows
node scripts/pilot-rehearsal.mjs isolation
node scripts/pilot-rehearsal.mjs backup --dir <an absolute folder outside ~/.my-game-dex/backups/pilot>
node scripts/pilot-rehearsal.mjs cleanup
MGD_TEST_STACK=rehearsal node scripts/test-stack.mjs destroy           # and scratch
```

Results:

- **Credentials (26 of 26).** B (the twin) refuses A's (scratch's) session token on Auth, the
  Data API and Storage, and A refuses B's. A's secret key is refused by B's Auth admin API and
  Storage, and B's Data API treats it, and A's publishable key, exactly as no key at all
  (anonymous: none of the service role's rights). A's legacy `service_role` key, and a
  `service_role` token signed with A's JWT secret, are refused on Auth admin, the Data API and
  Storage. B's own sessions, keys and secret key work. MFA on B: a TOTP factor enrols and
  verifies, the `aal2` session is B's and A refuses it. A's S3 keys work on A and are refused by B
  (S3 off); B's status has no S3 keys.
- **Existing behaviour with its own keys.** Every pgTAP file (56 files, 4432 tests) and every one
  of the 23 database suites (authorization, RLS, staff roles, MFA, sessions, owner, invitations,
  passwords and the rest) pass on the twin, the suites taking its keys from its `status` as the
  tools do.
- **Start and protection.** A start without the flag is refused. A creation killed 1.8 s in, with
  its database volume created, left the marker `creating`; retrying with the flag is refused
  ("already exists"), a plain start resumed it and marked it `created`. With the volume then
  deleted, creating it again is refused, flag or not. On the running twin, a missing marker or a
  marker for other keys makes both the restart check and every tool refuse, and both pass again
  once it is back.
- **Backups (35 of 35).** A complete dump (9 files with its manifest; `pg_restore --list` reads
  2381 entries); a second dump with the same name refused; the files and the key files readable
  only by this user, SYSTEM and Administrators (Windows); a changed byte, a missing line, a file
  outside the backup and a doubled line all refused by `verify`, and a rehearsal manifest by the
  pilot's; a dump failing mid-way (the database paused) marked FAILED with no manifest; a dump
  killed mid-way left no manifest. Restored into a new, empty database (owner `postgres`) in a
  throwaway container from the same image: no error, every table's rows (99) and the migration
  history (82) equal, all 17 roles present, the rights of `anon`, `authenticated` and
  `service_role` on every table and function equal (1356), and the security inventory equal
  apart from 36 owner-only table ACLs restored as the equivalent default. No key value is readable
  in the dump. The snapshot: its restart checks first, a clean shutdown, the copy equal in
  contents, owners, modes and times, the twin restarted unchanged. The manual recovery: a change
  made after the snapshot, the twin stopped, the snapshot copied back (equal), started through its
  checks, the data the snapshot's again and its own keys working.

**Known limits:**

- **The database's own password** is the CLI's fixed local `postgres` on every stack (the CLI has
  no setting for it), so the pilot's database port (58322, loopback only) accepts development's
  database URL with the pilot's port. No tool connects that way (they use `docker exec` into the
  container they checked), and only a local user can reach the port.
- **Re-keying an existing pilot** isn't rehearsed (see Recovery).
- **Suite residue:** the database suites' clean-up deletes under
  `session_replication_role = replica` (`db-release-identity-checks.mjs` deletes games that way),
  which skips foreign-key cascades and leaves orphan rows; a dump of such a stack doesn't restore
  with `--exit-on-error`. The pilot never runs suites; the persistent test stack has.
- `scripts/catalog-import-role.mjs` (the importer login switch `stage` uses) has no stack guard of
  its own; it predates M15 and is reached on the pilot only through `stage`.

**Still open before P1:** the product owner's P0 decisions (where the pilot runs, the rights
decision for it, who editors A and B are, the pilot size), and a second real person with local
access. **Before any real editorial decision**, the audit-ordering fix
([`20261214100000_m15_audit_ordering`](audit-ordering-m15.md)) must be merged, so a pilot created
from `main` has it from the start. Without it, an approval's events and a member's outcome
trail can be listed out of order. A decision on the shared local database password (above) is
also needed before the pilot is created. Pairings are verified through batch approval; there is no admin page for
`verify_game_platform` on its own.
