import { Compass, PlugZap, Search, SearchX, TimerReset } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { CatalogSearchForm, CatalogSearchFormSkeleton } from "@/components/catalog/catalog-search-form";
import { SearchResultList, SearchResultsSkeleton } from "@/components/catalog/search-results";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { listCatalogPlatforms, searchCatalog } from "@/features/catalog/queries";
import type { CatalogPlatform } from "@/features/catalog/types";

export const metadata: Metadata = {
  title: "Explore",
};

type ExploreParams = { query: string; platform: string | null; cursor: string | null };

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

function exploreHref({ query, platform, cursor }: ExploreParams) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (platform) params.set("platform", platform);
  if (cursor) params.set("after", cursor);
  const search = params.toString();
  return search ? `/explore?${search}` : "/explore";
}

function Unavailable() {
  return (
    <EmptyState icon={PlugZap} title="Search isn't available">
      The game catalog isn&apos;t connected right now. Try again later.
    </EmptyState>
  );
}

async function ExploreResults({ params, platforms }: { params: ExploreParams; platforms: CatalogPlatform[] }) {
  const platformName = platforms.find((p) => p.slug === params.platform)?.name ?? null;

  if (!params.query && !params.platform) {
    return (
      <EmptyState icon={Compass} title="Search the game catalog">
        Find a game by its title, another title it&apos;s known by, or a release&apos;s product code or barcode. Or choose a platform to browse its games.
      </EmptyState>
    );
  }

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

  const { data } = outcome;
  if (data.status === "too_short") {
    return (
      <EmptyState icon={Search} title="Type a little more">
        Search with at least two letters or digits.
      </EmptyState>
    );
  }
  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title={params.query ? "No games found" : `No games on ${platformName ?? "this platform"} yet`}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {params.query && params.platform ? (
              <Button asChild variant="secondary" size="lg">
                <Link href={exploreHref({ query: params.query, platform: null, cursor: null })}>Search all platforms</Link>
              </Button>
            ) : null}
            <Button asChild variant="secondary" size="lg">
              <Link href="/submit">Submit a missing game</Link>
            </Button>
          </div>
        }
      >
        {params.query
          ? `Nothing in the catalog matches “${params.query}”${platformName ? ` on ${platformName}` : ""}. Check the spelling, or try another title the game is known by.`
          : "The catalog has no published games for this platform so far."}
      </EmptyState>
    );
  }

  const summary = params.query
    ? `Games matching “${params.query}”${platformName ? ` on ${platformName}` : ""}`
    : `Games on ${platformName ?? "this platform"}, by title`;
  return (
    <section aria-labelledby="explore-results">
      <h2 id="explore-results" className="mb-3 text-sm font-medium text-muted-foreground">
        {summary}
      </h2>
      <SearchResultList items={data.items} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        {params.cursor ? (
          <Button asChild variant="ghost" size="lg">
            <Link href={exploreHref({ ...params, cursor: null })}>First results</Link>
          </Button>
        ) : (
          <span />
        )}
        {data.nextCursor ? (
          <Button asChild variant="secondary" size="lg">
            <Link href={exploreHref({ ...params, cursor: data.nextCursor })}>More results</Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

async function ExploreSearch({ searchParams }: { searchParams: PageProps<"/explore">["searchParams"] }) {
  const params = readParams(await searchParams);
  const platforms = await listCatalogPlatforms();
  if (!platforms.ok) return <Unavailable />;
  return (
    <>
      <CatalogSearchForm query={params.query} platform={params.platform} platforms={platforms.data} />
      <Suspense key={exploreHref(params)} fallback={<SearchResultsSkeleton />}>
        <ExploreResults params={params} platforms={platforms.data} />
      </Suspense>
    </>
  );
}

export default function ExplorePage({ searchParams }: PageProps<"/explore">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Explore</h1>
        <Suspense
          fallback={
            <>
              <CatalogSearchFormSkeleton />
              <SearchResultsSkeleton />
            </>
          }
        >
          <ExploreSearch searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
