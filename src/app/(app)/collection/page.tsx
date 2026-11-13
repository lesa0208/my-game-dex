import { CircleCheck, Library, Plus, PlugZap, SearchX, TimerReset, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { CollectionFilters, CollectionFiltersSkeleton } from "@/components/collection/collection-filters";
import { CollectionList, CollectionListSkeleton } from "@/components/collection/collection-list";
import { CollectionSummaryView } from "@/components/collection/collection-summary";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";
import { completenessLabel } from "@/features/collection/details";
import {
  collectionHref,
  type CollectionParams,
  DEFAULT_PARAMS,
  readCollectionParams,
  readNotice,
  STATUSES,
} from "@/features/collection/list-params";
import { getCopyNumbers, getMyCollection, getMyCollectionSummary } from "@/features/collection/queries";
import type { CollectionSummary } from "@/features/collection/types";
import { getMyPreservedTitles } from "@/features/exclusion/queries";

export const metadata: Metadata = {
  title: "My Collection",
};

const SORT_DESCRIPTIONS: Record<CollectionParams["sort"], string> = {
  added: "most recently added first",
  title: "by title",
  platform: "by platform, then title",
  acquired: "most recently acquired first, then copies without a date",
};

function describe(params: CollectionParams, summary: CollectionSummary) {
  const platform = summary.platforms.find((p) => p.slug === params.platform)?.name ?? params.platform;
  const filters = [
    params.query ? `matching “${params.query}”` : null,
    platform ? `on ${platform}` : null,
    params.completeness ? (params.completeness === "not_recorded" ? "with completeness not recorded" : `that are ${completenessLabel(params.completeness).toLowerCase()}`) : null,
    params.status ? `${STATUSES.find((s) => s.value === params.status)?.label.toLowerCase()}` : null,
  ].filter(Boolean);
  return `Copies${filters.length ? ` ${filters.join(", ")}` : ""}, ${SORT_DESCRIPTIONS[params.sort]}`;
}

function Unavailable() {
  return (
    <EmptyState icon={PlugZap} title="Your collection isn't available">
      It can&apos;t be loaded right now. Try again later.
    </EmptyState>
  );
}

async function CollectionResults({ params, summary }: { params: CollectionParams; summary: CollectionSummary }) {
  const page = await getMyCollection(params);
  if (!page.ok) {
    if (page.reason === "unavailable") return <Unavailable />;
    return (
      <EmptyState
        icon={TimerReset}
        title="This page has moved on"
        action={
          <Button asChild variant="secondary" size="lg">
            <Link href={collectionHref({ ...params, cursor: null })}>Go to the first page</Link>
          </Button>
        }
      >
        This page belongs to a different search or sort. Start again from the first page.
      </EmptyState>
    );
  }

  const { items, next_cursor: nextCursor } = page.data;
  if (items.length === 0) {
    return params.cursor ? (
      <EmptyState
        icon={Library}
        title="No more copies"
        action={
          <Button asChild variant="secondary" size="lg">
            <Link href={collectionHref({ ...params, cursor: null })}>Go to the first page</Link>
          </Button>
        }
      >
        You&apos;ve reached the end of this list.
      </EmptyState>
    ) : (
      <EmptyState
        icon={SearchX}
        title="No copies match"
        action={
          <Button asChild variant="secondary" size="lg">
            <Link href={collectionHref({ ...params, query: "", platform: null, completeness: null, status: null })}>Clear search and filters</Link>
          </Button>
        }
      >
        Nothing in your collection matches this search and these filters.
      </EmptyState>
    );
  }

  const [numbers, preserved] = await Promise.all([
    getCopyNumbers(items),
    getMyPreservedTitles(items.filter((item) => item.status === "invalid" && !item.release).map((item) => item.id)),
  ]);
  return (
    <section aria-labelledby="collection-results">
      <h2 id="collection-results" className="mb-3 text-sm font-medium text-muted-foreground">
        {describe(params, summary)}
      </h2>
      <CollectionList items={items} numbers={numbers} preserved={preserved} params={params} />
      {params.cursor || nextCursor ? (
        <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
          {params.cursor ? (
            <Button asChild variant="ghost" size="lg">
              <Link href={collectionHref({ ...params, cursor: null })}>First page</Link>
            </Button>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <Button asChild variant="secondary" size="lg">
              <Link href={collectionHref({ ...params, cursor: nextCursor })}>Next page</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}

function Notice({ notice }: { notice: "removed" | "already_removed" }) {
  return (
    <p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
      <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
      {notice === "removed" ? "The copy was removed from your collection." : "That copy had already been removed."}
    </p>
  );
}

async function CollectionView({ searchParams }: { searchParams: PageProps<"/collection">["searchParams"] }) {
  const search = await searchParams;
  const params = readCollectionParams(search);
  const notice = readNotice(search);
  await requireViewerWithHandle(collectionHref(params));

  const summary = await getMyCollectionSummary();
  if (!summary.ok) return <Unavailable />;

  if (summary.data.total === 0) {
    return (
      <>
        {notice ? <Notice notice={notice} /> : null}
        <EmptyState
          icon={Library}
          title="Your collection is empty"
          action={
            <Button asChild size="lg">
              <Link href="/explore">Find a game to add</Link>
            </Button>
          }
        >
          Find a game in Explore, choose the release you own and add it. Each physical copy you add appears here.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      {notice ? <Notice notice={notice} /> : null}
      {summary.data.invalid > 0 && params.status !== "invalid" ? (
        <p className="mb-4 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {summary.data.invalid === 1 ? "1 copy is" : `${summary.data.invalid.toLocaleString("en")} copies are`} kept privately because {summary.data.invalid === 1 ? "its release" : "their releases"}{" "}
            left the catalog. Everything you recorded is kept.{" "}
            <Link href={collectionHref({ ...DEFAULT_PARAMS, sort: params.sort, status: "invalid" })} className="font-medium text-primary-text underline underline-offset-4">
              See {summary.data.invalid === 1 ? "it" : "them"}
            </Link>
          </span>
        </p>
      ) : null}
      <CollectionSummaryView summary={summary.data} params={params} />
      <CollectionFilters params={params} summary={summary.data} />
      <Suspense key={collectionHref(params)} fallback={<CollectionListSkeleton />}>
        <CollectionResults params={params} summary={summary.data} />
      </Suspense>
    </>
  );
}

export default function CollectionPage({ searchParams }: PageProps<"/collection">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">My Collection</h1>
          <Button asChild variant="secondary" size="lg">
            <Link href="/explore">
              <Plus aria-hidden="true" />
              Add games
            </Link>
          </Button>
        </div>
        <Suspense
          fallback={
            <div aria-hidden="true">
              <Skeleton className="mb-6 h-24 w-full" />
              <CollectionFiltersSkeleton />
              <CollectionListSkeleton />
            </div>
          }
        >
          <CollectionView searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
