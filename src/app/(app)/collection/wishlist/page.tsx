import { CircleCheck, Heart, Library, Plus, PlugZap, SearchX, TimerReset } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { wishRegions } from "@/components/wishlist/game-wishlist";
import { WishlistFilters, WishlistFiltersSkeleton } from "@/components/wishlist/wishlist-filters";
import { WishlistList, WishlistListSkeleton } from "@/components/wishlist/wishlist-list";
import { requireViewerWithHandle } from "@/features/account/queries";
import { getSubmissionOptions } from "@/features/submissions/queries";
import { priorityLabel } from "@/features/wishlist/format";
import { DEFAULT_WISHLIST_PARAMS, readWishlistNotice, readWishlistParams, type WishlistNotice, type WishlistParams, wishlistHref } from "@/features/wishlist/params";
import { getMyWishlist } from "@/features/wishlist/queries";

export const metadata: Metadata = {
  title: "Wishlist",
};

const SORT_DESCRIPTIONS: Record<WishlistParams["sort"], string> = {
  priority: "highest priority first, then newest",
  added: "most recently added first",
  title: "by title",
};

function describe(params: WishlistParams, platforms: { slug: string; name: string }[], regions: { code: string; label: string }[]) {
  const filters = [
    params.query ? `matching “${params.query}”` : null,
    params.platform ? `on ${platforms.find((p) => p.slug === params.platform)?.name ?? params.platform}` : null,
    params.region ? `from ${regions.find((r) => r.code === params.region)?.label ?? params.region}` : null,
    params.priority ? `with ${priorityLabel(params.priority).toLowerCase()} priority` : null,
  ].filter(Boolean);
  return `Wishes${filters.length ? ` ${filters.join(", ")}` : ""}, ${SORT_DESCRIPTIONS[params.sort]}`;
}

function Unavailable() {
  return (
    <EmptyState icon={PlugZap} title="Your wishlist isn't available">
      It can&apos;t be loaded right now. Try again later.
    </EmptyState>
  );
}

function FindGames({ label = "Find a game to want" }: { label?: string }) {
  return (
    <Button asChild size="lg">
      <Link href="/explore">{label}</Link>
    </Button>
  );
}

async function WishlistResults({ params, notice }: { params: WishlistParams; notice: WishlistNotice | null }) {
  const [page, options, regions] = await Promise.all([getMyWishlist(params), getSubmissionOptions(), wishRegions()]);
  const platforms = (options?.platforms ?? []).map((p) => ({ slug: p.slug, name: p.name }));
  const noticeBanner = notice ? (
    <p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
      <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
      {notice === "removed" ? "The wish was removed from your wishlist." : "That wish had already been removed."}
    </p>
  ) : null;

  if (!page.ok) {
    if (page.reason !== "invalid_cursor") return <Unavailable />;
    return (
      <EmptyState
        icon={TimerReset}
        title="This page has moved on"
        action={
          <Button asChild variant="secondary" size="lg">
            <Link href={wishlistHref({ ...params, cursor: null })}>Go to the first page</Link>
          </Button>
        }
      >
        This page belongs to a different search or sort. Start again from the first page.
      </EmptyState>
    );
  }

  const { items, next_cursor: nextCursor, total } = page.data;
  if (total === 0) {
    return (
      <>
        {noticeBanner}
        <EmptyState icon={Heart} title="Your wishlist is empty" action={<FindGames />}>
          Find a game in Explore and add it to your wishlist: any version of it, on a platform, from a region, or one exact release.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      {noticeBanner}
      <p className="mb-4 text-sm text-muted-foreground">
        {total === 1 ? "1 wish" : `${total.toLocaleString("en")} wishes`} in all. Private: only you can see your wishlist.
      </p>
      <WishlistFilters params={params} platforms={platforms} regions={regions} />
      {items.length === 0 ? (
        params.cursor ? (
          <EmptyState
            icon={Heart}
            title="No more wishes"
            action={
              <Button asChild variant="secondary" size="lg">
                <Link href={wishlistHref({ ...params, cursor: null })}>Go to the first page</Link>
              </Button>
            }
          >
            You&apos;ve reached the end of this list.
          </EmptyState>
        ) : (
          <EmptyState
            icon={SearchX}
            title="No wishes match"
            action={
              <Button asChild variant="secondary" size="lg">
                <Link href={wishlistHref({ ...DEFAULT_WISHLIST_PARAMS, sort: params.sort })}>Clear search and filters</Link>
              </Button>
            }
          >
            Nothing on your wishlist matches this search and these filters.
          </EmptyState>
        )
      ) : (
        <section aria-labelledby="wishlist-results">
          <h2 id="wishlist-results" className="mb-3 text-sm font-medium text-muted-foreground">
            {describe(params, platforms, regions)}
          </h2>
          <WishlistList items={items} params={params} />
          {params.cursor || nextCursor ? (
            <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
              {params.cursor ? (
                <Button asChild variant="ghost" size="lg">
                  <Link href={wishlistHref({ ...params, cursor: null })}>First page</Link>
                </Button>
              ) : (
                <span />
              )}
              {nextCursor ? (
                <Button asChild variant="secondary" size="lg">
                  <Link href={wishlistHref({ ...params, cursor: nextCursor })}>Next page</Link>
                </Button>
              ) : null}
            </nav>
          ) : null}
        </section>
      )}
    </>
  );
}

async function WishlistView({ searchParams }: { searchParams: PageProps<"/collection/wishlist">["searchParams"] }) {
  const search = await searchParams;
  const params = readWishlistParams(search);
  const notice = readWishlistNotice(search);
  await requireViewerWithHandle(wishlistHref(params));
  return (
    <Suspense
      key={wishlistHref(params)}
      fallback={
        <div aria-hidden="true">
          <Skeleton className="mb-4 h-5 w-48" />
          <WishlistFiltersSkeleton />
          <WishlistListSkeleton />
        </div>
      }
    >
      <WishlistResults params={params} notice={notice} />
    </Suspense>
  );
}

export default function WishlistPage({ searchParams }: PageProps<"/collection/wishlist">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs text-muted-foreground">
              <Link href="/collection" className="hover:text-foreground hover:underline">
                My Collection
              </Link>
            </p>
            <h1 className="text-xl font-semibold tracking-tight">Wishlist</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="lg">
              <Link href="/collection">
                <Library aria-hidden="true" />
                My Collection
              </Link>
            </Button>
            <Button asChild variant="secondary" size="lg">
              <Link href="/explore">
                <Plus aria-hidden="true" />
                Find games
              </Link>
            </Button>
          </div>
        </div>
        <Suspense
          fallback={
            <div aria-hidden="true">
              <Skeleton className="mb-4 h-5 w-48" />
              <WishlistFiltersSkeleton />
              <WishlistListSkeleton />
            </div>
          }
        >
          <WishlistView searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
