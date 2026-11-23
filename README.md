# My Game Dex

_Your collection. Your gaming identity._

My Game Dex is a social network and collection manager for physical video game collectors. It combines a community feed, a game catalog and virtual shelves, so that a collection becomes part of a collector's identity online.

**Status:** Phase 1 (frontend foundation) is complete. The Supabase backend is built on the local stack through M8, the Superadmin Foundation, and M10, the admin panel expansion, is built (M10a to M10e) with its integration review's corrections, and waits for approval of its pull request. No hosted project exists. The application is English-only.

## Requirements

- **Node.js 22 or newer.** The `cn` class-merging package used by shadcn/ui requires it (`engines: >=22`), and it is the strictest requirement of any direct dependency. Next.js itself needs only 20.9. The requirement is declared in `package.json`. The project is tested on Node 22.23.
- npm, which comes with Node.js.
- Docker Desktop, only for the [local database](#local-database).
- Microsoft Edge or Google Chrome, only for `npm run app:a11y-checks`. The checks drive the installed browser through `playwright-core` and download none.

## Getting started

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). No environment variables are needed for development. `.env.example` lists the optional ones.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Create a production build |
| `npm run start` | Serve the production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Generate route types and run the TypeScript compiler |
| `npm run seed:art` | Regenerate the placeholder artwork in `public/seed/` |
| `npm run db:start` / `db:stop` | Start or stop the local Supabase stack |
| `npm run db:reset` | Recreate the local database and apply all migrations |
| `npm run db:test` | Check the migrations, then run pgTAP and the 23 database suites against the running stack |
| `npm run db:pgtap` / `db:suites` | The same in two parts: migrations and every pgTAP file, then the suites (as CI runs them; see [Continuous integration](#continuous-integration-m14b)) |
| `npm run db:report-test` | Offline: test the check that every pgTAP file ran and passed (also in CI) |
| `npm run db:verify` | Start, reset, migrate and test, in one command |
| `npm run test-stack:start` / `test-stack:stop` | Start or stop the isolated test stack (see [The isolated test stack](#the-isolated-test-stack-m11a-0)) |
| `npm run test-stack:run -- <script>` | Run any npm script against the isolated test stack |
| `npm run test-stack:protect-dev` | Make destructive scripts refuse the development stack |
| `npm run db:invitation-checks` | Invitations through the real Auth, API and Mailpit (run with `test-stack:run`) |
| `npm run app:invitation-checks` | After a build, test `/admin/invitations` and an invitee's onboarding in the running app (run with `test-stack:run`) |
| `npm run invitations:test` | Unit tests for the invitation pages' rules and messages |
| `npm run secrets:check` | Scan files for secrets |
| `npm run secrets:bundle` | Scan browser bundles for secrets, after a build |
| `npm run secrets:test` | Test the secret scanner |
| `npm run hooks:install` | Enable the pre-commit secret check |
| `npm run auth:test` | Test the sign-in redirect, account and handle rules |
| `npm run app:auth-checks` | After a build, test sign-in, sessions, the handle claim and sign-out in the running app against the local stack |
| `npm run collection:test` | Test the add form's rules: copy ids and details |
| `npm run app:collection-checks` | After a build, test adding copies from a game page in the running app against the local stack and catalog fixture |
| `npm run app:my-collection-checks` | After a build, test My Collection (listing, filters, details, editing and removing) in the running app against the local stack and catalog fixture |
| `npm run submissions:test` | Test the submission forms' rules |
| `npm run app:submission-checks` | After a build, test catalog submissions (submitting, editing, withdrawing and adding a copy) in the running app against the local stack and catalog fixture |
| `npm run review:test` | Test the review forms' rules |
| `npm run exclusion:test` | Test the exclusion forms' rules, reason codes and messages |
| `npm run app:exclusion-checks` | After a build, test excluding and restoring a release (preview, confirmation, refusals, the owner's preserved copy, restoration) in the running app against the local stack and catalog fixture |
| `npm run merge:test` | Test the merge form's rules, the compared fields and the messages |
| `npm run app:merge-checks` | After a build, test merging a published duplicate and a submission (comparison, per-field confirmation, refusals, redirects, the owner and the submitter) in the running app against the local stack |
| `npm run db:merge-benchmark` | Time merging a release with 2,000 copies of 500 owners on the local stack, and what waits meanwhile |
| `npm run db:exclusion-benchmark` | Time excluding and restoring a release with 2,000 copies of 500 owners on the local stack, and what waits meanwhile |
| `npm run app:relink-checks` | After a build, test moving a copy to another release (choosing, confirming, refusals and preserved copies) in the running app against the local stack and catalog fixture |
| `npm run app:review-checks` | After a build, test catalog review (the queue, starting, correcting, approving, asking for changes, rejecting and resubmitting) in the running app against the local stack and catalog fixture |
| `npm run admin:test` | Test the admin and security forms' rules: return paths, inputs, messages and the audit details shown |
| `npm run records:test` | Test the catalog records' search parameters and how a record's history reads |
| `npm run editing:test` | Test the catalog editing forms' rules, that their lists match the database, and their messages |
| `npm run imports:test` | Test the reference and import pages' filters, labels and messages, and that their lists match the database |
| `npm run app:admin-checks` | After a build, test `/admin` and Settings → Security in the running app against the local stack: access for each role, the catalog pages and the overview's counts (M10a), catalog search, records and history (M10b), the staff matrix, step-up verification, real TOTP enrollment and removal, the audit log, transfer and recovery, and privacy |
| `npm run app:editing-checks` | After a build, test catalog editing in the running app against the local stack: who reaches the pages, creating games and releases, no self-review, a change ending a verification, step-up without replay, catalog metadata, and that no page names a creator (M10c) |
| `npm run app:reference-checks` | After a build, test the Reference, Imports and System sections and the reclassification queue in the running app: who reaches each page, what each shows, that only resolving a queue item writes, and that no page shows a key, address, lease or raw source data (M10d) |
| `npm run app:a11y-checks` | After a build, test `/admin` and Settings → Security in a real browser with JavaScript (Edge, or Chrome; `A11Y_BROWSER=chrome` picks it): access and navigation for each role, TOTP enrollment, step-up without replay, keyboard focus, and axe-core accessibility and sideways scrolling at phone and desktop widths |
| `MGD_MUTATION_TESTING=1 MGD_STACK=scratch npm run db:mutation -- --suite <name>` | Prove the tests detect real violations of one suite, on the disposable scratch stack only (see [Local database](#local-database)). Destructive: it resets the stack it runs on. Without the opt-in, a named suite and `MGD_STACK=scratch` it refuses and changes nothing |
| `MGD_MUTATION_TESTING=1 MGD_STACK=scratch npm run mutation:campaign` | Run several mutation suites unattended, on scratch only. `-- --dry-run` checks readiness and runs nothing, without the opt-in |
| `npm run mutation:guard-test` | Offline: the mutation runners refuse without the opt-in, and no ordinary `*-checks.mjs` suite resets a stack or applies violations (also in CI) |

Run `typecheck`, `lint` and `build` before committing, plus `db:verify` for database changes (CI also runs the database tests on every pull request; see [Continuous integration](#continuous-integration-m14b)), and `app:auth-checks`, `app:collection-checks` or `app:my-collection-checks` for changes to sign-in, sessions or the collection. Changes to staff, MFA or `/admin` also need `app:admin-checks` and `app:a11y-checks`.

## Local database

The database runs locally through Supabase's CLI and Docker. No hosted project exists, and the frontend doesn't use the database yet.

### Prerequisites

- **Docker Desktop**, running. On Windows, use the WSL 2 backend.
- Node.js 22 or newer. The CLI is a pinned dev dependency, installed by `npm ci`, so don't install it globally.

The first start downloads images and can take several minutes.

### Workflow

```bash
npm run db:verify
```

That starts the stack, resets the database, applies `supabase/migrations/`, and runs:

1. **pgTAP tests** in `supabase/tests/database/`, on the real local PostgreSQL.
2. **API checks** in `scripts/db-smoke.mjs`, through the real local API, covering new-object exposure and that auth, REST, storage and realtime work.
3. **Identity checks** in `scripts/db-identity-checks.mjs`, through the real Auth, REST and Storage APIs, with email delivered to the local Mailpit. These cover signup, profile privacy, staff escalation, handles, avatars and account deletion.
4. **Authorization checks** in `scripts/db-authorization-checks.mjs`, through the real API, with transactions held open to force races. These cover follows, blocks, lists, counts and permissions.
5. **Audit checks** in `scripts/db-audit-checks.mjs`, through the real API, with held-open transactions. These cover staff roles, suspension, the audit log and its permissions.
6. **Notification checks** in `scripts/db-notification-checks.mjs`, through the real API and Auth, with held-open transactions. These cover follow, request and moderation notices, preferences, visibility, blocks, account deletion and their permissions.
7. **Catalog checks** in `scripts/db-catalog-checks.mjs`, through the real API and Auth, with held-open transactions. These cover catalog editor permissions, verification and publication, and races with revocation, suspension and account deletion.
8. **Import checks** in `scripts/db-import-checks.mjs`. They log in as the restricted `catalog_importer` role, run the import tool on synthetic snapshots outside the repository, and force races between runs. `npm run catalog:test` covers the snapshot parsers. The import tool and its runbook are in [security-rls.md](docs/architecture/security-rls.md#catalog-import).
9. **Search checks** in `scripts/db-search-checks.mjs`. They install the catalog search fixture, call search, the release picker and the platform list through the API as anon, a user, an editor and `service_role`, and remove the fixture and every test account after. `npm run catalog:test` also covers the app's response parser. See [Catalog search](docs/architecture/security-rls.md#catalog-search).
10. **Collection checks** in `scripts/db-collection-checks.mjs`. Through the API, as the owner, another collector, an editor, a suspended owner, anon and `service_role`, they add, edit, read and remove copies of fixture releases. They also send concurrent repeats and concurrent additions at a lowered limit, and delete an account that has copies. See [Collection system](docs/architecture/security-rls.md#collection-system). `node supabase/benchmarks/m6_collection.mjs` measures a 50,000-copy collection among about a million copies, in a transaction it always rolls back.
11. **Submission, review, relink, exclusion and merge checks** in `scripts/db-submission-checks.mjs`, `db-review-checks.mjs`, `db-relink-checks.mjs`, `db-exclusion-checks.mjs` and `db-merge-checks.mjs`, through the API with forced races. See [security-rls.md](docs/architecture/security-rls.md#catalog-submissions-m7a) from M7a on.
12. **Owner checks** in `scripts/db-owner-checks.mjs`: every path that could delete the Owner, Auth's Admin API included, and concurrent assignments.
13. **MFA checks** in `scripts/db-mfa-checks.mjs`, with real TOTP sessions from the local Auth: live session and factor checks, stale and signed-out tokens, freshness, factor maturity and its ledger.
14. **Ownership checks** in `scripts/db-ownership-checks.mjs`: the staff matrix through the API, transfers, succession and recovery, with forced races and the refusal rate limit.

`npm run db:mutation` separately proves the tests detect real violations, by applying each one in `scripts/security-mutations.mjs` in turn. It takes a few hours, so run it for security changes, not every commit. It is destructive and never part of an ordinary test run: it is named `scripts/mutation-db-runner.mjs` (outside the `*-checks.mjs` pattern) and refuses unless `MGD_MUTATION_TESTING=1`, `--suite <name>` and `MGD_STACK=scratch` are all given. Start scratch first with `MGD_TEST_STACK=scratch npm run test-stack:start`. The app runner (`npm run app:mutation`) needs the opt-in and `--set <name>`. `supabase/benchmarks/` holds repeatable measurements, and always rolls back.

It stops at the first failed stage and prints a summary. A failing test names the check that failed.

To add a migration, run `npx supabase migration new <name>`, then `npm run db:verify`. A new table needs RLS, explicit grants and policies in the same migration, plus an entry in the approved lists in `03_schema_guards.test.sql`. See [Explicit grants](docs/architecture/security-rls.md#explicit-grants).

### Continuous integration (M14b)

Every pull request into `main` runs two jobs in `.github/workflows/ci.yml`. Both must pass before merging.

- **checks:** secret scans, typecheck, lint, the mutation-guard and pgTAP-report unit tests, the build and a bundle scan.
- **database:** on a fresh GitHub-hosted Ubuntu runner, `MGD_TEST_STACK=scratch node scripts/test-stack.mjs start` creates the disposable scratch stack, which replays every migration from an empty database. `db:pgtap` then checks that every migration file was applied, in order, and runs every pgTAP file. `db:suites` runs the 23 database suites (API, identity, authorization and RLS, audit, notifications, catalog, imports, releases, claims, wishlist, search, collection, submissions, review, relink, exclusion, merge, Owner, MFA, ownership, invitations, passwords and sessions). The last step destroys the stack even after a failure, and fails if a container or volume is left.

The database job sets `MGD_EXPECT_STACK=scratch`, so `db.mjs` refuses any other stack, and it checks that the scratch database is the only one running. It uses no repository secrets and no hosted project. Its token is read-only, the CLI's output passes through the redactor, and nothing is uploaded.

**It fails on:**

- a migration that doesn't apply (the stack won't start);
- a migration file that wasn't applied, or was applied out of order;
- a pgTAP file that aborts (for example a syntax error) or fails an assertion;
- a file that didn't run, or a skipped or todo assertion;
- a file in `supabase/tests/database/` not named `NN_name.test.sql`;
- fewer files or assertions than `PGTAP_BASELINE` in `scripts/lib/pgtap-report.mjs` (55 files and 4,326 assertions). Raise it when you add tests; lowering it is a reviewed decision.
- a failing suite.

**To reproduce a failure locally**, run the same commands:

```bash
MGD_TEST_STACK=scratch node scripts/test-stack.mjs start
MGD_TEST_STACK=scratch MGD_EXPECT_STACK=scratch node scripts/test-stack.mjs run db:pgtap
MGD_TEST_STACK=scratch MGD_EXPECT_STACK=scratch node scripts/test-stack.mjs run db:suites
MGD_TEST_STACK=scratch node scripts/test-stack.mjs destroy
```

In PowerShell, set the variables first: `$env:MGD_TEST_STACK = "scratch"; $env:MGD_EXPECT_STACK = "scratch"`. Scratch copies `supabase/migrations/` and `supabase/tests/` only when it starts, so destroy and start it again after changing them.

**Still run locally, not in CI:**

- the browser and HTTP app suites (`app:*-checks`, which need a production build, and Edge or Chrome for accessibility);
- the catalog pilot and shelf suites on the test stack;
- upgrades onto existing data and rollbacks;
- the mutation runners.

A database PR needs both jobs green. Changes to the app or to security also need the relevant app suites from the list above.

### The isolated test stack (M11a-0)

The checks reset the database, install and remove the catalog fixture, and create and delete accounts. To keep data you're using on the development stack, run them on a second, isolated local stack instead:

```bash
npm run test-stack:start                        # project "my-game-dex-test": API 55321, database 55322, Mailpit 55324
npm run test-stack:run -- db:verify             # any npm script, against the test stack
npm run test-stack:run -- app:admin-checks
npm run test-stack:stop                         # keeps its data; test-stack:destroy deletes its volumes
```

- **Separate everything.** `scripts/test-stack.mjs` generates `.supabase-test/` (git-ignored) from `supabase/config.toml` on every start and reset: a different project id, every port moved up by 1000, and Studio, analytics and the edge runtime off. It copies `supabase/migrations/` and `supabase/tests/` there. Its containers, volumes and network are named after the test project, so nothing is shared with the development stack.
- **One selector.** Every script reads the project, container, CLI arguments and status from `scripts/lib/stack.mjs`. `MGD_STACK=test` selects the test stack; without it, scripts use the development stack as before. Each refuses a config that names the wrong project, a status that isn't on a loopback address, or an API port that doesn't belong to the selected stack.
- **A disposable clean stack (M12c-A).** The test stack may hold records worth keeping, such as the human-reviewed catalog pilot. To run every suite on an empty database without resetting it, use a third stack. `MGD_TEST_STACK=scratch node scripts/test-stack.mjs start` creates project `my-game-dex-scratch` in `.supabase-scratch/` (git-ignored), with every port moved up by 2000. Run against it with `MGD_STACK=scratch` (for example `MGD_STACK=scratch node scripts/db.mjs verify`), then remove its containers and volumes with `MGD_TEST_STACK=scratch node scripts/test-stack.mjs destroy`.
- **The persistent B1 ingestion-test stack (M12c-B1).** `MGD_TEST_STACK=b1 node scripts/test-stack.mjs start` creates project `my-game-dex-b1` in `.supabase-b1/` (git-ignored), with every port moved up by 3000 (API 57321, database 57322, Mailpit 57324). Select it with `MGD_STACK=b1`. It keeps B1 import batches and their review history, so `reset` and `destroy` refuse unless `MGD_ALLOW_B1_RESET=1` is set, and B1 tools call `requireStack("b1")` so they can't reach development or the M12c-A test stack.
- **Protecting the development stack.** `npm run test-stack:protect-dev` creates `~/.my-game-dex/protect-dev-stack`. While it exists, every check, fixture, benchmark and mutation script, and `db:reset`, `db:test` and `db:verify`, refuse the development stack unless `MGD_ALLOW_DEV_STACK=1` is set. Starting, stopping and using the development stack in the app aren't affected.
- **The app under test** is the production build, started by each app check on its own port with the test stack's URL, publishable key and secret key (for invitations, M11a-1), so `.env.local` (the development stack's) isn't used.
- **Invitations (M11a-1)** work on the test stack, which uses `supabase/templates/invite.html` for the invitation email (sent to its Mailpit). `MGD_TEST_SIGNUP=off npm run test-stack:reset` (after a `test-stack:stop`) makes it invite-only, as a hosted project will be: `[auth] enable_signup = false`, the email provider left on. The development stack's configuration is unchanged, so `/admin/invitations` there says invitations aren't available unless the server is given `SUPABASE_SECRET_KEY` and the template. Real invitations, SMTP and hosted settings are [pre-beta launch tasks](docs/architecture/security-rls.md#production-launch-prerequisites-m8). A lost authenticator is handled by the [operator runbook](docs/operations/lost-authenticator-runbook.md).

### Configuration

No environment variables are needed for local development. Local URLs and development keys come from `npx supabase status`. **That command prints keys, so use `npm run db:status`, which redacts them.**

To see Explore and game pages with data, set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `.env.local` (see `.env.example`), and install the fictional test catalog with `npm run catalog:fixture -- install` (`remove` takes it out). It runs only against the local stack. `node supabase/benchmarks/m5c_catalog_search.mjs` measures search on a synthetic 50,000-game catalog, in a transaction it always rolls back.

To sign in locally, set the same two variables, then create a user in local Studio (Authentication, Add user, with the email marked as confirmed), sign in at `/sign-in` and choose a handle. There's deliberately no sign-up page: see [Web sessions](docs/architecture/security-rls.md#web-sessions-m6a).

Real secrets never go in the repository, or in `NEXT_PUBLIC_` variables. To block commits containing them, run `npm run hooks:install` once per clone.

### MFA and administration on the local stack

TOTP is enabled for the local stack only, in `[auth.mfa.totp]` of `supabase/config.toml`. Staff need it: every staff privilege requires a session verified with an authenticator, and sensitive actions a verification in the last 10 minutes. See [MFA for staff](docs/architecture/security-rls.md#mfa-for-staff-m8).

**Adding an authenticator.** Sign in, open Settings → Security, choose "Add an authenticator", scan the QR code or type the setup key into an authenticator app, and enter the first code. Showing the code needs JavaScript. Afterwards, signing in asks for a code, and the factor shows when it matures (24 hours, which matters only for the Owner). Use local test accounts only: never put real authenticator secrets in the repository or in scripts.

**Trying `/admin` locally.** Only the Owner can make administrators, and only administrators grant the other roles, so on the local stack give a test account a role in local Studio's SQL editor, which runs as `postgres`:

```sql
insert into public.staff_roles (user_id, role)
select id, 'catalog_editor' from public.profiles where handle = '<local test handle>';
```

Then add an authenticator to that account and sign in again. Admin sections show only to their roles; everyone else sees a page that doesn't exist. **This is for the local stack only.** On any other project, staff come only from the audited functions, and the Owner only from the [runbook](docs/operations/owner-recovery-runbook.md).

**The Owner.** Don't assign one by hand. The record is permanent by design, and only `npm run db:reset` clears it locally. The test suites assign a temporary Owner on the local stack and remove it, and refuse to run if one already exists or if the API isn't on loopback.

**Testing.** `npm run db:verify` runs the Owner, MFA and ownership checks with real TOTP sessions from the local Auth. `npm run app:admin-checks` needs a production build (`npm run build`), and drives the app as a browser without JavaScript would, enrolling and verifying real authenticators through the pages. `npm run app:a11y-checks` also needs the build, plus Edge or Chrome. It signs in through the pages with JavaScript and fails on any critical or serious axe-core finding (WCAG 2.0–2.2 A and AA) in Dark Mode, the only supported appearance. It also runs the same checks on the unsupported light tokens as diagnostics: their results are listed apart, are never counted as passes, aren't a release requirement and say nothing about Light Mode being accessible. `A11Y_LIGHT=enforce` makes them failing checks, for future Light Mode work. If no browser starts, it prints `NOT RUN` and exits with status 2. It takes no screenshots, traces or videos, and redacts keys, codes and emails from what it prints. The design is in [The Owner (M8)](docs/architecture/security-rls.md#the-owner-m8), [Staff authority (M8)](docs/architecture/security-rls.md#staff-authority-m8) and [ADR-055](docs/architecture/architecture-decisions.md#adr-055-the-owner-is-a-protected-record-its-authority-needs-mature-mfa-and-recovery-is-an-audited-operator-procedure).

### Troubleshooting

| Problem | What to do |
| --- | --- |
| "Docker isn't running" | Start Docker Desktop and wait until it's ready |
| Port 54321 to 54324 is in use | Stop the other process, or another project's stack with `npx supabase stop` |
| `supabase_vector` keeps restarting | Known issue on Windows, and harmless. See below |
| "no files matched pattern: supabase/seed.sql" | Expected. There's no seed file yet |
| Stack is in a bad state | Run `npm run db:stop`, then `npm run db:verify` |
| A test fails after adding a table | Check that it has RLS and explicit grants, and is on the approved lists |

**`supabase_vector` restarting.** This container ships container logs to the local analytics service. It reaches Docker through `tcp://host.docker.internal:2375`, which Docker Desktop keeps closed by default, so it exits and restarts. The database, auth, API, migrations and tests aren't affected, as they all pass while it restarts. The only loss is logs in the local Studio log explorer. Enabling Docker's "Expose daemon on tcp://localhost:2375 without TLS" setting would stop the restarts, but it's insecure, so we don't recommend it.

## Technology stack

| Area | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack, Cache Components) |
| UI | React 19, TypeScript in strict mode |
| Styling | Tailwind CSS 4, shadcn/ui (Radix), Lucide icons |
| Planned | Supabase (PostgreSQL, Auth, Storage), Vercel |

## Project structure

```text
scripts/            Placeholder artwork generator
src/
  app/              Routes. (app)/ holds everything inside the application shell
  components/
    ui/             shadcn/ui primitives
    layout/         Sidebar, header, mobile navigation, page layout
    feed/           Post cards, feed filters, feed sidebar
    games/          Cover art and release display
    auth/           Sign-in, handle and sign-out forms, protected-page wrapper
    shared/         Avatar, empty state, placeholder page
  config/           Site details, navigation, feature flags
  dev/seed/         Development-only seed data
  features/         Data access and feature logic
  lib/              Utilities
  types/            Domain types
  proxy.ts          Refreshes the session before each request
```

## How it fits together

**Seed data is isolated.** Everything fake lives in `src/dev/seed/` and `public/seed/`. UI code reads data only through `src/features/*/queries.ts`, and an ESLint rule rejects seed imports from `src/app` and `src/components`. When the backend arrives, the query functions change and the components calling them don't.

**Seed data is off in production.** It is on under `next dev`. A production build shows real empty states unless `ENABLE_SEED_DATA=true` is set for both the build and the server.

**Nothing pretends to be connected.** While seed data is on, the feed shows a preview notice. Likes and bookmarks live in browser memory and clear on reload. Comments, search and following say they aren't available yet, and share copies a link to the post's place in the feed.

**Game, Release and Collection Item are separate types.** A game is the underlying title, a release is a specific platform and physical edition, and a collection item is one copy owned by one collector. The database schema must keep this separation.

**Artwork is original.** Everything in `public/seed/` is drawn by `scripts/generate-seed-art.mjs`. Game titles in the seed data refer to real games, but the covers are not their real box art. Check licensing and attribution terms before integrating any cover art provider.

**Sessions stay on the server.** `src/proxy.ts` refreshes the Supabase session before each request, and server code reads the signed-in account only through `getCurrentViewer()` in `src/features/account/queries.ts`, which verifies the token with `getClaims()`. There's no browser Supabase client, so the session cookies are `httpOnly`. Anything that reads the session sits inside `<Suspense>` and is never cached. See [ADR-048](docs/architecture/architecture-decisions.md#adr-048-web-sessions-are-handled-only-on-the-server).

**Feed filters live in the URL.** `/home?feed=following` is read by a server component inside `<Suspense>`, so filters are linkable and the rest of the page is prerendered. Reading the request or the clock outside `<Suspense>` fails under Cache Components.

### Color tokens

All colors are CSS variables in `src/app/globals.css`. **The app supports Dark Mode only**, a product decision for the initial release ([ADR-056](docs/architecture/architecture-decisions.md#adr-056-dark-mode-is-the-only-supported-appearance-for-the-initial-release)). It renders dark through an unconditional `class="dark"` on `<html>`, with no theme switcher. The light set in `globals.css` is unused and unsupported.

Purple is split into three tokens, because neither white nor dark text reaches the 4.5:1 AA minimum on the brand accent:

| Token | Dark value | Use it for | Contrast |
| --- | --- | --- | --- |
| `primary` | `#8B5CF6` | Icons, borders, indicators, focus rings | 3.6 to 4.5:1 on surfaces (needs 3:1) |
| `primary-solid` | `#7C3AED` | Filled controls with text, such as buttons | 5.7:1 with white text (needs 4.5:1) |
| `primary-text` | `#A78BFA` | Purple text, such as links | 5.7 to 6.9:1 on surfaces (needs 4.5:1) |

The default `Button` variant already uses `primary-solid`. shadcn components added later may default to `bg-primary text-primary-foreground`, so switch those to the solid tokens.

## Phase 1: completed

- Design tokens for the dark theme (an unused light set also exists)
- Responsive shell: bottom navigation on mobile, icon rail on tablet, full sidebar on desktop, and a contextual right sidebar from 1280px
- Header with global search form and account menu
- Home feed with For You, Following and Latest filters
- Six post types: General, New Pickup, Collection Showcase, Game Review, Discussion, Achievement
- Trending Games, Suggested Collectors and Popular Posts
- Loading, empty and error states
- Keyboard operation with visible focus, checked with axe-core against WCAG 2.2 AA rules

## Current limitations

- Sign-in, sign-out and the handle claim work against the local stack only. There are no sign-up or password-reset pages, and avatars aren't shown yet
- Community, Notifications, Messages and My Profile are placeholder pages, and Settings has only the account and handle
- Search covers the published game catalog only, not collectors
- My Collection is private: there are no public collections, shelves, valuation, import or bulk editing yet, and the catalog has no cover artwork
- Missing games and releases can be submitted, and catalog editors review, approve, send back or reject them. Duplicates are merged, out-of-scope releases excluded and restored, and owners relink their own copies (M7b-2), the notifications page isn't built yet, and the review page edits up to 30 listed pieces (the editor function allows 50)
- Staff work in `/admin`: catalog review, account lookup by handle, staff roles, the audit log and ownership (M8), the overview's counts (M10a), a search of every catalog record with game and release records and their history (M10b), and catalog editing: creating, editing, verifying and publishing games and releases, never by the record's own creator, with a recent verification for anything public (M10c), and read-only reference data for editors, and import monitoring and the system's state for administrators, with the reclassification queue for editors (M10d). Accounts are searched by the start of a handle and show a moderation summary and history, the audit log filters by kind and outcome and shows only allow-listed details, and the staff page shows each member's standing and authenticator readiness (M10e). Bulk operations and analytics aren't planned
- JavaScript is required for form feedback. Without it, forms still submit, but their success and error messages don't show. Adding an authenticator needs JavaScript to show the QR code and setup key
- Likes and bookmarks aren't saved; comments, following and post creation don't exist
- Dark Mode only. Light Mode isn't supported or offered, and isn't WCAG-conformant: its unused tokens fail color contrast in places (muted navigation labels, destructive buttons, input text on light fields), which `app:a11y-checks` lists as diagnostics. `user_preferences.theme` (M2) accepts `light`, but nothing reads it
- Frontend tests cover the catalog parser and the sign-in rules, plus HTTP checks of the app. Browser and accessibility checks (`app:a11y-checks`) cover only `/admin` and Settings → Security. There are no component tests
- Seed artwork in `public/seed/` is still served by production builds, although nothing links to it while seed data is off
- `npm audit` reports low and moderate advisories in `deepmerge` and `minimatch`, through the shadcn CLI's own dependencies. The app doesn't run that code at runtime; only the CLI uses it. Don't run `npm audit fix --force`, which proposes downgrading to `shadcn@1.0.0`

## Phase 2 roadmap (proposed)

Phase 2 replaces the seed viewer with real accounts:

1. **Supabase setup:** project, environment variables and typed clients
2. **Authentication:** sign in, sign out and protected routes are done locally (M6a). Sign-up and password reset wait for the public-authentication blockers
3. **Profiles:** schema with Row Level Security, profile page and profile editing
4. **Account UI:** the account menu and `getCurrentViewer()` use the real session (M6a). Profile editing and the remaining settings are still to do
5. **Light mode:** deferred, not planned for the initial release (ADR-056)

Current plan: M10, the admin panel expansion, built in five steps and reviewed together, then its pull request, then the collector-facing milestones the product owner plans: Collection Shelves, Game Details, Wishlist and Discovery. Internationalization was cancelled; the application is English-only.

**Next: the visual collector experience**, starting with My Collection → Systems → Console Collection Shelf, built on mock data.
- **Catalog ingestion (M12c-B1):** the technical pilot is complete.
- **Editorial review and publication of staged catalog identities:** deferred and not yet validated end to end.
- See [Suggested next steps](docs/architecture/architecture-decisions.md#suggested-next-steps).

Later phases:

- **Collections:** game catalog, platforms, releases, collection items, virtual shelves, wantlist
- **Social:** real feed, posts, likes, comments, following, reviews
- **Discovery:** Explore, global search, collector recommendations, trending games
- **Advanced:** notifications, messaging, statistics, collection valuation, marketplace

## Contact
For questions about My Game Dex, API usage, integrations, licensing, or data-provider partnerships, please open a GitHub Issue:
https://github.com/lesa0208/my-game-dex/issues/new
The project maintainer monitors incoming issues and will respond through GitHub.
