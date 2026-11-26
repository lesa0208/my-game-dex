import { ArrowLeft, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { Suspense } from "react";

import { ReleasePickerView } from "@/components/catalog/release-picker";
import { AddClaimToCollection, AddToCollection, AddToCollectionSkeleton } from "@/components/collection/add-to-collection";
import { GameCopies, GameCopiesSkeleton } from "@/components/collection/game-copies";
import { ExcludeReleaseLink } from "@/components/exclusion/exclude-release-link";
import { GameDetailsSkeleton } from "@/components/games/game-details";
import { MergeReleaseLink } from "@/components/merge/merge-release-link";
import { EmptyState } from "@/components/shared/empty-state";
import { Breadcrumbs } from "@/components/shelf/shelf-parts";
import { WantRelease } from "@/components/wishlist/game-wishlist";
import { getReleasePicker, resolveMergedRelease } from "@/features/catalog/queries";
import { type FastAddReference, fastAddHref, planFastAdd } from "@/features/collection/fast-add";
import { getSubmissionOptions } from "@/features/submissions/queries";

export const metadata: Metadata = {
  title: "Add a copy",
};

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() || null;
}

/**
 * M17b: the step-by-step add (M12b's fast add: platform, region, edition, release), on its
 * own page now that the game page adds through its quick add dialog. Every choice is in
 * the address, so it works without JavaScript and a step can be linked or reloaded; the
 * game page's old step addresses are redirected here (src/proxy.ts). Unchanged otherwise.
 */
async function AddContent({ params, searchParams }: PageProps<"/games/[slug]/add">) {
  const { slug } = await params;
  const query = await searchParams;
  const selection = { platform: first(query.platform), region: first(query.region), release: first(query.release) };
  const edition = first(query.edition);

  const [outcome, options] = await Promise.all([getReleasePicker(slug, selection.platform, selection.region, selection.release), getSubmissionOptions()]);
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
  // A release merged while published goes to the release it was merged into (M7b-2c D14).
  if (selection.release && !picker.selection.releaseId) {
    const merged = await resolveMergedRelease(selection.release);
    if (merged) permanentRedirect(fastAddHref(merged.gameSlug, { platform: null, region: null, edition: null, release: merged.releaseId }));
  }
  // A merged game, or a link by id, goes to the game's own address.
  if (picker.game.slug !== slug) redirect(fastAddHref(picker.game.slug, { ...selection, edition }));

  const reference: FastAddReference = {
    platforms: options?.platforms.map((p) => ({ slug: p.slug, name: p.name })) ?? [],
    regions: options?.regions.filter((r) => r.code !== "unknown") ?? [],
  };
  const plan = planFastAdd(picker, { ...selection, edition }, reference);
  const here = fastAddHref(picker.game.slug, { ...selection, edition });
  const platformIds = new Map(options?.platforms.map((p) => [p.slug, { id: p.id, shortName: p.shortName }]) ?? []);
  const gamePage = selection.platform ? `/games/${picker.game.slug}?platform=${encodeURIComponent(selection.platform)}` : `/games/${picker.game.slug}`;

  return (
    <>
      <Breadcrumbs items={[{ label: "Explore", href: "/explore" }, { label: picker.game.title, href: gamePage }, { label: "Add a copy" }]} />
      <div className="mt-4 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 rounded-2xl border border-white/10 bg-card/60 p-5 sm:p-6">
          <p className="mb-1 text-sm text-muted-foreground">Step by step</p>
          <h1 className="mb-4 text-2xl font-semibold tracking-tight text-balance">{picker.game.title}</h1>
          <ReleasePickerView
            picker={picker}
            plan={plan}
            reference={reference}
            requestedRelease={selection.release !== null}
            showHeader={false}
            collapseReleases={!(selection.platform || selection.region || selection.release)}
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
              const platform = platformIds.get(claim.platform);
              return platform ? (
                <Suspense fallback={<AddToCollectionSkeleton />}>
                  <AddClaimToCollection gameId={picker.game.id} platformId={platform.id} platformName={platform.shortName} claim={claim} returnPath={here} />
                </Suspense>
              ) : (
                <p className="text-sm text-muted-foreground">Adding isn&apos;t available right now. Try again later.</p>
              );
            }}
          />
          <Link href={gamePage} className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary-text underline-offset-4 hover:underline">
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back to {picker.game.title}
          </Link>
        </div>
        <aside aria-label="Your collection" className="min-w-0 empty:hidden lg:sticky lg:top-22">
          <Suspense fallback={<GameCopiesSkeleton />}>
            <GameCopies gameId={picker.game.id} title={picker.game.title} />
          </Suspense>
        </aside>
      </div>
    </>
  );
}

export default function AddPage(props: PageProps<"/games/[slug]/add">) {
  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-4 md:px-6 md:py-6">
      <Suspense fallback={<GameDetailsSkeleton />}>
        <AddContent {...props} />
      </Suspense>
    </div>
  );
}
