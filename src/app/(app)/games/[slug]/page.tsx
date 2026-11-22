import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { Suspense } from "react";

import { gameHref, ReleasePickerView } from "@/components/catalog/release-picker";
import { AddClaimToCollection, AddToCollection, AddToCollectionSkeleton } from "@/components/collection/add-to-collection";
import { GameCopies, GameCopiesSkeleton } from "@/components/collection/game-copies";
import { ExcludeReleaseLink } from "@/components/exclusion/exclude-release-link";
import { GameDetailsSkeleton, GameHero, PhysicalReleases } from "@/components/games/game-details";
import { MergeReleaseLink } from "@/components/merge/merge-release-link";
import { EmptyState } from "@/components/shared/empty-state";
import { GameWishlist, GameWishlistSkeleton, WantRelease } from "@/components/wishlist/game-wishlist";
import { Breadcrumbs } from "@/components/shelf/shelf-parts";
import { getGameSummary, getReleasePicker, resolveMergedRelease } from "@/features/catalog/queries";
import { type FastAddReference, fastAddHref, planFastAdd } from "@/features/collection/fast-add";
import { gameOverview } from "@/features/shelf/copies";
import { getSubmissionOptions } from "@/features/submissions/queries";

export const metadata: Metadata = {
  title: "Game",
};

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() || null;
}

async function GameContent({ params, searchParams }: PageProps<"/games/[slug]">) {
  const { slug } = await params;
  const query = await searchParams;
  const selection = { platform: first(query.platform), region: first(query.region), release: first(query.release) };
  const edition = first(query.edition);

  // The picker is public and cached; it ignores a platform or region it doesn't have
  // for the game ("not sure", another one), which the fast add then handles. The same
  // read with nothing selected lists every release, for the page's overview.
  const hasSelection = selection.platform || selection.region || selection.release;
  const [outcome, everything, options] = await Promise.all([
    getReleasePicker(slug, selection.platform, selection.region, selection.release),
    hasSelection ? getReleasePicker(slug, null, null, null) : null,
    getSubmissionOptions(),
  ]);
  if (!outcome.ok) {
    if (outcome.reason === "unavailable") {
      return (
        <EmptyState icon={PlugZap} title="The catalog isn't available">
          The game catalog isn&apos;t connected right now. Try again later.
        </EmptyState>
      );
    }
    throw new Error("The catalog refused the request.");
  }
  const picker = outcome.data;
  if (!picker) notFound();
  // A link to a release merged while published goes to the release it was merged into
  // (M7b-2c D14). Checked only when the release asked for isn't shown, and uncached, so
  // it answers as of now. Any other id, a release merged while unpublished included,
  // gets the same page as an unknown one. Inside this streamed boundary the redirect is
  // sent as the client-side redirect Next.js emits there, as for a merged game.
  if (selection.release && !picker.selection.releaseId) {
    const merged = await resolveMergedRelease(selection.release);
    if (merged) permanentRedirect(gameHref(merged.gameSlug, { platform: null, region: null, release: merged.releaseId }));
  }
  // A merged game, or a link by id, goes to the game's own address.
  if (picker.game.slug !== slug) redirect(fastAddHref(picker.game.slug, { ...selection, edition }));

  const all = everything?.ok && everything.data ? everything.data : picker;
  const overview = gameOverview(all);
  const summary = await getGameSummary(picker.game.id);

  const reference: FastAddReference = {
    platforms: options?.platforms.map((p) => ({ slug: p.slug, name: p.name })) ?? [],
    regions: options?.regions.filter((r) => r.code !== "unknown") ?? [],
  };
  const plan = planFastAdd(picker, { ...selection, edition }, reference);
  const here = fastAddHref(picker.game.slug, { ...selection, edition });
  const platformIds = new Map(options?.platforms.map((p) => [p.slug, p.id]) ?? []);

  // The catalog is public and cached. The collector's copies and adding read the
  // session, so they stream in on their own, and return here after signing in.
  return (
    <>
      <Breadcrumbs items={[{ label: "Explore", href: "/explore" }, { label: picker.game.title }]} />
      {/* One grid: on narrow screens the collector's copies come straight after the game;
          on wide ones they stand in a column beside everything else. */}
      <div className="mt-4 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 lg:col-start-1">
          <GameHero game={picker.game} summary={summary} overview={overview} />
        </div>
        <aside aria-label="Your collection" className="min-w-0 empty:hidden lg:sticky lg:top-22 lg:col-start-2 lg:row-span-3 lg:row-start-1">
          <div className="flex flex-col gap-6">
            <Suspense fallback={<GameCopiesSkeleton />}>
              <GameCopies gameId={picker.game.id} title={picker.game.title} />
            </Suspense>
            {/* M12 W2: the collector's wishes for this game, apart from their copies. */}
            <Suspense fallback={<GameWishlistSkeleton />}>
              <GameWishlist gameId={picker.game.id} title={picker.game.title} releases={all.releases} returnPath={here} />
            </Suspense>
          </div>
        </aside>
        <div className="min-w-0 lg:col-start-1">
          <PhysicalReleases
            slug={picker.game.slug}
            title={picker.game.title}
            overview={overview}
            renderAction={(release) => (
              <Suspense fallback={null}>
                <WantRelease gameId={picker.game.id} release={release} title={picker.game.title} />
              </Suspense>
            )}
          />
        </div>
        <div className="min-w-0 rounded-2xl border border-white/10 bg-card/60 p-5 sm:p-6 lg:col-start-1">
            <ReleasePickerView
              picker={picker}
              plan={plan}
              reference={reference}
              requestedRelease={selection.release !== null}
              showHeader={false}
              collapseReleases={!hasSelection}
              renderAdd={(release) => (
                <>
                  <Suspense fallback={<AddToCollectionSkeleton />}>
                    <AddToCollection release={release} returnPath={fastAddHref(picker.game.slug, { ...selection, edition, release: release.id })} />
                  </Suspense>
                  {/* M12 W2: wanting this release, kept apart from adding a copy. */}
                  <Suspense fallback={null}>
                    <WantRelease gameId={picker.game.id} release={release} title={picker.game.title} />
                  </Suspense>
                  <Suspense fallback={null}>
                    <ExcludeReleaseLink releaseId={release.id} />
                  </Suspense>
                  <Suspense fallback={null}>
                    <MergeReleaseLink releaseId={release.id} />
                  </Suspense>
                </>
              )}
              renderClaim={(claim) => {
                const platformId = platformIds.get(claim.platform);
                return platformId ? (
                  <Suspense fallback={<AddToCollectionSkeleton />}>
                    <AddClaimToCollection gameId={picker.game.id} platformId={platformId} claim={claim} returnPath={here} />
                  </Suspense>
                ) : (
                  <p className="text-sm text-muted-foreground">Adding isn&apos;t available right now. Try again later.</p>
                );
              }}
            />
        </div>
      </div>
    </>
  );
}

export default function GamePage(props: PageProps<"/games/[slug]">) {
  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-4 md:px-6 md:py-6">
      <Suspense fallback={<GameDetailsSkeleton />}>
        <GameContent {...props} />
      </Suspense>
    </div>
  );
}
