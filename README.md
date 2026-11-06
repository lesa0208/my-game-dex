# My Game Dex

_Your collection. Your gaming identity._

My Game Dex is a social network and collection manager for physical video game collectors. It combines a community feed, a game catalog and virtual shelves, so that a collection becomes part of a collector's identity online.

**Status:** Phase 1 (frontend foundation) is complete. There is no backend, authentication or database yet.

## Requirements

- **Node.js 22 or newer.** The `cn` class-merging package used by shadcn/ui requires it (`engines: >=22`), and it is the strictest requirement of any direct dependency. Next.js itself needs only 20.9. The requirement is declared in `package.json`. The project is tested on Node 22.23.
- npm, which comes with Node.js.
- Docker Desktop, only for the [local database](#local-database).

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
| `npm run db:test` | Run database tests against the running stack |
| `npm run db:verify` | Start, reset, migrate and test, in one command |
| `npm run secrets:check` | Scan files for secrets |
| `npm run secrets:bundle` | Scan browser bundles for secrets, after a build |
| `npm run secrets:test` | Test the secret scanner |
| `npm run hooks:install` | Enable the pre-commit secret check |

Run `typecheck`, `lint` and `build` before committing, plus `db:verify` for database changes. The frontend has no automated tests yet.

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

`npm run db:mutation` separately proves the tests detect real violations, by applying each one in `scripts/security-mutations.mjs` in turn. It takes a few hours, so run it for security changes, not every commit. `supabase/benchmarks/` holds repeatable measurements, and always rolls back.

It stops at the first failed stage and prints a summary. A failing test names the check that failed.

To add a migration, run `npx supabase migration new <name>`, then `npm run db:verify`. A new table needs RLS, explicit grants and policies in the same migration, plus an entry in the approved lists in `03_schema_guards.test.sql`. See [Explicit grants](docs/architecture/security-rls.md#explicit-grants).

### Configuration

No environment variables are needed for local development. Local URLs and development keys come from `npx supabase status`. **That command prints keys, so use `npm run db:status`, which redacts them.**

Real secrets never go in the repository, or in `NEXT_PUBLIC_` variables. To block commits containing them, run `npm run hooks:install` once per clone.

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
    shared/         Avatar, empty state, placeholder page
  config/           Site details, navigation, feature flags
  dev/seed/         Development-only seed data
  features/         Data access and feature logic
  lib/              Utilities
  types/            Domain types
```

## How it fits together

**Seed data is isolated.** Everything fake lives in `src/dev/seed/` and `public/seed/`. UI code reads data only through `src/features/*/queries.ts`, and an ESLint rule rejects seed imports from `src/app` and `src/components`. When the backend arrives, the query functions change and the components calling them don't.

**Seed data is off in production.** It is on under `next dev`. A production build shows real empty states unless `ENABLE_SEED_DATA=true` is set for both the build and the server.

**Nothing pretends to be connected.** While seed data is on, the feed shows a preview notice. Likes and bookmarks live in browser memory and clear on reload. Comments, search and following say they aren't available yet, and share copies a link to the post's place in the feed.

**Game, Release and Collection Item are separate types.** A game is the underlying title, a release is a specific platform and physical edition, and a collection item is one copy owned by one collector. The database schema must keep this separation.

**Artwork is original.** Everything in `public/seed/` is drawn by `scripts/generate-seed-art.mjs`. Game titles in the seed data refer to real games, but the covers are not their real box art. Check licensing and attribution terms before integrating any cover art provider.

**Feed filters live in the URL.** `/home?feed=following` is read by a server component inside `<Suspense>`, so filters are linkable and the rest of the page is prerendered. Reading the request or the clock outside `<Suspense>` fails under Cache Components.

### Color tokens

All colors are CSS variables in `src/app/globals.css`, with light and dark sets defined. The app renders dark through `class="dark"` on `<html>`.

Purple is split into three tokens, because neither white nor dark text reaches the 4.5:1 AA minimum on the brand accent:

| Token | Dark value | Use it for | Contrast |
| --- | --- | --- | --- |
| `primary` | `#8B5CF6` | Icons, borders, indicators, focus rings | 3.6 to 4.5:1 on surfaces (needs 3:1) |
| `primary-solid` | `#7C3AED` | Filled controls with text, such as buttons | 5.7:1 with white text (needs 4.5:1) |
| `primary-text` | `#A78BFA` | Purple text, such as links | 5.7 to 6.9:1 on surfaces (needs 4.5:1) |

The default `Button` variant already uses `primary-solid`. shadcn components added later may default to `bg-primary text-primary-foreground`, so switch those to the solid tokens.

## Phase 1: completed

- Design tokens, with a dark theme by default and light tokens prepared
- Responsive shell: bottom navigation on mobile, icon rail on tablet, full sidebar on desktop, and a contextual right sidebar from 1280px
- Header with global search form and account menu
- Home feed with For You, Following and Latest filters
- Six post types: General, New Pickup, Collection Showcase, Game Review, Discussion, Achievement
- Trending Games, Suggested Collectors and Popular Posts
- Loading, empty and error states
- Keyboard operation with visible focus, checked with axe-core against WCAG 2.2 AA rules

## Current limitations

- Explore, My Collection, Community, Notifications, Messages, My Profile and Settings are placeholder pages
- Global search reports that it isn't available
- Likes and bookmarks aren't saved; comments, following and post creation don't exist
- Light mode has tokens but no switcher, and hasn't had a visual review
- There are no automated tests in the repository
- Seed artwork in `public/seed/` is still served by production builds, although nothing links to it while seed data is off
- `npm audit` reports low and moderate advisories in `deepmerge` and `minimatch`, through the shadcn CLI's own dependencies. The app doesn't run that code at runtime; only the CLI uses it. Don't run `npm audit fix --force`, which proposes downgrading to `shadcn@1.0.0`

## Phase 2 roadmap (proposed)

Phase 2 replaces the seed viewer with real accounts:

1. **Supabase setup:** project, environment variables and typed clients
2. **Authentication:** sign up, sign in, sign out, and protected routes
3. **Profiles:** schema with Row Level Security, profile page and profile editing
4. **Account UI:** connect the account menu and Settings, and replace `getCurrentViewer()`
5. **Light mode:** add the switcher and review the light theme

Later phases:

- **Collections:** game catalog, platforms, releases, collection items, virtual shelves, wantlist
- **Social:** real feed, posts, likes, comments, following, reviews
- **Discovery:** Explore, global search, collector recommendations, trending games
- **Advanced:** notifications, messaging, statistics, collection valuation, marketplace
