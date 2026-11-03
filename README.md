# My Game Dex

_Your collection. Your gaming identity._

My Game Dex is a social network and collection manager for physical video game collectors. It combines a community feed, a game catalog and virtual shelves, so that a collection becomes part of a collector's identity online.

**Status:** Phase 1 (frontend foundation) is complete. There is no backend, authentication or database yet.

## Requirements

- **Node.js 22 or newer.** The `cn` class-merging package used by shadcn/ui requires it (`engines: >=22`), and it is the strictest requirement of any direct dependency. Next.js itself needs only 20.9. The requirement is declared in `package.json`. The project is tested on Node 22.23.
- npm, which comes with Node.js.

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

Run `typecheck`, `lint` and `build` before committing. There is no automated test suite yet.

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
