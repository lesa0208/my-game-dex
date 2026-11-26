import { ChevronDown, Layers, PlugZap, Search, SearchX, TimerReset } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { CatalogSearchForm, CatalogSearchFormSkeleton } from "@/components/catalog/catalog-search-form";
import { type CardContext, GameGrid } from "@/components/explore/game-card";
import { SystemChips as SystemChipRow } from "@/components/explore/system-chips";
import { HomeContainer, SectionHeading } from "@/components/home/home-parts";
import { ConsoleArt } from "@/components/shelf/console-art";
import { SystemTile } from "@/components/shelf/system-tile";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getMostPlatformGames, getPlatformMakers } from "@/features/catalog/discover";
import { searchFallbacks } from "@/features/catalog/fallback";
import { listCatalogPlatforms, searchCatalog } from "@/features/catalog/queries";
import type { CatalogPlatform, SearchResult } from "@/features/catalog/types";
import { getExploreContext } from "@/features/explore/context";
import { systemAccent } from "@/features/shelf/collection";
import { consoleFor } from "@/features/shelf/copies";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Explore",
};

type ExploreParams = { query: string; platform: string | null; cursor: string | null };
type Intent = { slug: string; action: "add" | "wish" } | null;

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function readParams(searchParams: Record<string, string | string[] | undefined>): ExploreParams {
  return {
    query: first(searchParams.q).trim().slice(0, 100),
    platform: first(searchParams.platform).trim() || null,
    cursor: first(searchParams.after).trim() || null,
  };
}

/** A return from signing in to add or wish for a game (see ResultActions). */
function readIntent(searchParams: Record<string, string | string[] | undefined>): Intent {
  const add = first(searchParams.add).trim();
  const wish = first(searchParams.wish).trim();
  if (SLUG.test(add)) return { slug: add, action: "add" };
  if (SLUG.test(wish)) return { slug: wish, action: "wish" };
  return null;
}

function exploreHref({ query, platform, cursor }: ExploreParams) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (platform) params.set("platform", platform);
  if (cursor) params.set("after", cursor);
  const search = params.toString();
  return search ? `/explore?${search}` : "/explore";
}

/** M12b: the missing-game fallback, with what was searched for as the title to start from. */
function submitHref(query: string) {
  return query ? `/submit?title=${encodeURIComponent(query)}` : "/submit";
}

function MissingGame({ query }: { query: string }) {
  return (
    <p className="mt-8 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-sm">
      <span className="font-medium">Can&apos;t find your game?</span>{" "}
      <Link href={submitHref(query)} className="text-primary-text underline underline-offset-4">
        Add it to My Game Dex
      </Link>
      . Editors check it before it joins the catalog, and you can add your copy to your collection right away.
    </p>
  );
}

function Unavailable() {
  return (
    <EmptyState icon={PlugZap} title="Search isn't available">
      The game catalog isn&apos;t connected right now. Try again later.
    </EmptyState>
  );
}

async function cardContext(items: SearchResult[], params: ExploreParams, intent: Intent): Promise<CardContext> {
  const { viewer, owned, wished } = await getExploreContext(items.map((item) => item.game.id));
  return { viewer, owned, wished, platform: params.platform, returnPath: exploreHref(params), intent };
}

/** Systems with games, as quick filters above the results: one tap, no extra Search. */
function SystemChips({ platforms, params }: { platforms: CatalogPlatform[]; params: ExploreParams }) {
  const systems = platforms.filter((p) => p.gameCount > 0).sort((a, b) => b.gameCount - a.gameCount || a.name.localeCompare(b.name, "en"));
  if (systems.length < 2) return null;
  return (
    <SystemChipRow
      chips={[
        { key: "all", href: exploreHref({ query: params.query, platform: null, cursor: null }), label: "All systems", count: null, current: !params.platform },
        ...systems.map((p) => ({
          key: p.slug,
          href: exploreHref({ query: params.query, platform: p.slug, cursor: null }),
          label: p.shortName,
          count: p.gameCount,
          current: params.platform === p.slug,
        })),
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

/** On a phone, systems as compact rows; from 640px, the Systems page's own tiles. */
function BrowseBySystem({ platforms, makers }: { platforms: CatalogPlatform[]; makers: Record<string, string> }) {
  const systems = platforms.filter((p) => p.gameCount > 0).sort((a, b) => b.gameCount - a.gameCount || a.name.localeCompare(b.name, "en"));
  const games = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "game" : "games"}`;
  return (
    <section aria-labelledby="explore-systems" className="mt-8">
      <SectionHeading id="explore-systems" title="Browse by System" />
      <ul className="flex flex-col gap-2 sm:hidden">
        {systems.map((p) => {
          const kind = consoleFor(p.slug);
          return (
            <li key={p.slug}>
              <Link
                href={`/explore?platform=${p.slug}`}
                className="flex min-h-16 items-center gap-3 rounded-xl border border-white/[0.08] bg-[#141319] px-3 py-2 outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring"
              >
                {kind ? <ConsoleArt kind={kind} sizes="72px" className="h-11 w-16 shrink-0" /> : <Layers aria-hidden="true" className="mx-4 size-6 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">{games(p.gameCount)}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <ul className="hidden gap-4 sm:grid sm:grid-cols-2 xl:grid-cols-3">
        {systems.map((p) => (
          <li key={p.slug}>
            <SystemTile
              href={`/explore?platform=${p.slug}`}
              shortName={p.shortName}
              maker={makers[p.slug] ?? null}
              console={consoleFor(p.slug)}
              accent={systemAccent(p.slug)}
              count={games(p.gameCount)}
              fullName={p.name}
            />
          </li>
        ))}
      </ul>
      <AllPlatforms platforms={platforms} />
    </section>
  );
}

/** Every platform the catalog supports, by family: the systems without games yet included. */
function AllPlatforms({ platforms }: { platforms: CatalogPlatform[] }) {
  const families = [...new Set(platforms.map((p) => p.family))].sort((a, b) => a.localeCompare(b, "en"));
  return (
    <details className="group mt-4 rounded-xl border border-white/[0.08] [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex min-h-12 cursor-pointer items-center gap-2 rounded-xl px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring">
        All supported platforms <span className="font-normal text-muted-foreground">({platforms.length})</span>
        <ChevronDown aria-hidden="true" className="ml-auto size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="grid gap-x-8 gap-y-5 border-t border-white/[0.07] p-4 sm:grid-cols-2 lg:grid-cols-3">
        {families.map((family) => (
          <div key={family}>
            <h3 className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">{family}</h3>
            <ul className="flex flex-col gap-0.5">
              {platforms
                .filter((p) => p.family === family)
                .sort((a, b) => a.name.localeCompare(b.name, "en"))
                .map((p) => (
                  <li key={p.slug}>
                    <Link href={`/explore?platform=${p.slug}`} className="flex items-baseline justify-between gap-3 rounded-md px-1.5 py-1 text-sm outline-none hover:bg-white/5 focus-visible:ring-3 focus-visible:ring-ring">
                      <span>{p.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{p.gameCount ? p.gameCount.toLocaleString("en") : "no games yet"}</span>
                    </Link>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}

async function MostSystems({ intent }: { intent: Intent }) {
  const games = await getMostPlatformGames(8);
  if (!games?.length) return null;
  const params: ExploreParams = { query: "", platform: null, cursor: null };
  const context = await cardContext(games, params, intent);
  return (
    <section aria-labelledby="explore-most" className="mt-10">
      <SectionHeading id="explore-most" title="On the Most Systems" />
      <p className="-mt-1.5 mb-4 text-sm text-muted-foreground">Games the catalog records on the most systems: a good place to start a collection.</p>
      <GameGrid items={games} context={context} label="Games on the most systems" />
    </section>
  );
}

async function Landing({ platforms, intent }: { platforms: CatalogPlatform[]; intent: Intent }) {
  const makers = await getPlatformMakers();
  return (
    <>
      <BrowseBySystem platforms={platforms} makers={makers} />
      <Suspense fallback={<GridSkeleton />}>
        <MostSystems intent={intent} />
      </Suspense>
      <MissingGame query="" />
    </>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

async function ExploreResults({ params, platforms, intent }: { params: ExploreParams; platforms: CatalogPlatform[]; intent: Intent }) {
  const platformName = platforms.find((p) => p.slug === params.platform)?.name ?? null;
  const outcome = await searchCatalog(params.query, params.platform, params.cursor);
  if (!outcome.ok) {
    if (outcome.reason === "unavailable") return <Unavailable />;
    if (outcome.reason === "invalid_cursor") {
      return (
        <EmptyState
          icon={TimerReset}
          title="These results have moved on"
          action={
            <Button asChild variant="secondary" size="lg">
              <Link href={exploreHref({ ...params, cursor: null })}>Start from the first results</Link>
            </Button>
          }
        >
          This page belongs to a different search. Start again from the first results.
        </EmptyState>
      );
    }
    return (
      <EmptyState icon={Search} title="That search is too long">
        Search with up to 100 characters.
      </EmptyState>
    );
  }

  let data = outcome.data;
  // Nothing found as typed: a product code with a space, or a title's words split where
  // the catalog joins them, is tried once more, and the page says which search it shows.
  let shown = params.query;
  if (data.status !== "too_short" && data.items.length === 0 && params.query && !params.cursor) {
    for (const alternative of searchFallbacks(params.query)) {
      const retry = await searchCatalog(alternative, params.platform, null);
      if (retry.ok && retry.data.items.length > 0) {
        data = retry.data;
        shown = alternative;
        break;
      }
    }
  }
  const shownParams = { ...params, query: shown };
  if (data.status === "too_short") {
    return (
      <EmptyState icon={Search} title="Type a little more">
        Search with at least two letters or digits.
      </EmptyState>
    );
  }
  if (data.items.length === 0) {
    const systems = platforms.filter((p) => p.gameCount > 0).sort((a, b) => b.gameCount - a.gameCount).slice(0, 6);
    return (
      <EmptyState
        icon={SearchX}
        title={params.query ? "No games found" : `No games on ${platformName ?? "this platform"} yet`}
        action={
          <div className="flex flex-col items-center gap-4">
            <div className="flex flex-wrap justify-center gap-2">
              {params.query && params.platform ? (
                <Button asChild variant="secondary" size="lg">
                  <Link href={exploreHref({ query: params.query, platform: null, cursor: null })}>Search all systems</Link>
                </Button>
              ) : null}
              <Button asChild size="lg">
                <Link href={submitHref(params.query)}>Add it to My Game Dex</Link>
              </Button>
            </div>
            {systems.length ? (
              <div className="text-sm text-muted-foreground">
                <p className="mb-2">Or browse a system:</p>
                <ul className="flex flex-wrap justify-center gap-2">
                  {systems.map((p) => (
                    <li key={p.slug}>
                      <Link href={`/explore?platform=${p.slug}`} className="inline-flex h-9 items-center rounded-full border border-white/10 px-3.5 text-foreground outline-none hover:border-primary/50 focus-visible:ring-3 focus-visible:ring-ring">
                        {p.shortName}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        }
      >
        {params.query
          ? `Nothing in the catalog matches “${params.query}”${platformName ? ` on ${platformName}` : ""}. Check the spelling, or try another title the game is known by. If it isn't in the catalog yet, add it, and add your copy right away.`
          : "The catalog has no published games for this platform so far."}
      </EmptyState>
    );
  }

  const context = await cardContext(data.items, params, intent);
  const summary = shown ? `Games matching “${shown}”${platformName ? ` on ${platformName}` : ""}` : `${platformName ?? "This platform"}, A to Z`;
  return (
    <section aria-labelledby="explore-results">
      {shown !== params.query ? <p className="mb-2 text-sm">Nothing matches “{params.query}” as typed, so these are the games matching “{shown}”.</p> : null}
      <h2 id="explore-results" className="mb-4 text-lg font-semibold tracking-tight">
        {summary}
      </h2>
      <GameGrid items={data.items} context={context} label={summary} />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        {params.cursor ? (
          <Button asChild variant="ghost" size="lg">
            <Link href={exploreHref({ ...shownParams, cursor: null })}>First results</Link>
          </Button>
        ) : (
          <span />
        )}
        {data.nextCursor ? (
          <Button asChild variant="secondary" size="lg">
            <Link href={exploreHref({ ...shownParams, cursor: data.nextCursor })}>More results</Link>
          </Button>
        ) : null}
      </div>
      <MissingGame query={params.query} />
    </section>
  );
}

function GridSkeleton() {
  return (
    <div aria-hidden="true" className="mt-8 grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-white/[0.06]">
          <Skeleton className="aspect-[16/9] rounded-none" />
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="mt-3 h-10" />
          </div>
        </div>
      ))}
    </div>
  );
}

async function ExploreView({ searchParams }: { searchParams: PageProps<"/explore">["searchParams"] }) {
  await connection();
  const raw = await searchParams;
  const params = readParams(raw);
  const intent = readIntent(raw);
  const platforms = await listCatalogPlatforms();
  if (!platforms.ok) return <Unavailable />;
  const landing = !params.query && !params.platform;

  return (
    <>
      {/* Not clipped itself (the suggestions open over the page below); only its lighting is. */}
      <div className={cn("relative z-20 rounded-2xl border border-white/10 bg-[#141319]", landing ? "p-5 sm:p-7" : "p-4 sm:p-5")}>
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded-[inherit] bg-[radial-gradient(60%_120%_at_0%_0%,rgb(139_92_246/0.22),transparent_60%),radial-gradient(50%_90%_at_100%_0%,rgb(255_176_96/0.12),transparent_70%)]"
        />
        <div className="relative">
          <h1 className={cn("font-semibold tracking-tight", landing ? "text-2xl sm:text-3xl" : "text-xl")}>Explore</h1>
          {landing ? <p className="mt-1 mb-5 text-sm text-muted-foreground sm:text-base">Find a game for your collection, or browse a system.</p> : <div className="mb-3" />}
          <CatalogSearchForm query={params.query} platform={params.platform} platforms={platforms.data} large={landing} />
        </div>
      </div>
      {landing ? (
        <Landing platforms={platforms.data} intent={intent} />
      ) : (
        <>
          <div className="mt-4">
            <SystemChips platforms={platforms.data} params={params} />
          </div>
          <div className="mt-5">
            <Suspense key={exploreHref(params)} fallback={<GridSkeleton />}>
              <ExploreResults params={params} platforms={platforms.data} intent={intent} />
            </Suspense>
          </div>
        </>
      )}
    </>
  );
}

export default function ExplorePage({ searchParams }: PageProps<"/explore">) {
  return (
    <HomeContainer>
      <Suspense
        fallback={
          <>
            <div className="rounded-2xl border border-white/10 p-5">
              <Skeleton className="mb-4 h-7 w-32" />
              <CatalogSearchFormSkeleton />
            </div>
            <GridSkeleton />
          </>
        }
      >
        <ExploreView searchParams={searchParams} />
      </Suspense>
    </HomeContainer>
  );
}
