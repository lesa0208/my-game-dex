import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { Suspense } from "react";

import { gameHref, ReleasePickerView } from "@/components/catalog/release-picker";
import { AddClaimToCollection, AddToCollection, AddToCollectionSkeleton } from "@/components/collection/add-to-collection";
import { GameCopies, GameCopiesSkeleton } from "@/components/collection/game-copies";
import { ExcludeReleaseLink } from "@/components/exclusion/exclude-release-link";
import { GameDetailsSkeleton, PhysicalReleases } from "@/components/games/game-details";
import { GameHero } from "@/components/games/game-hero";
import { GameOverview, HeroActions, HeroActionsSkeleton, VisitorPanel } from "@/components/games/game-sections";
import { SectionNav } from "@/components/games/section-nav";
import { MergeReleaseLink } from "@/components/merge/merge-release-link";
import { EmptyState } from "@/components/shared/empty-state";
import { GameWishlist, GameWishlistSkeleton, WantRelease } from "@/components/wishlist/game-wishlist";
import { Breadcrumbs } from "@/components/shelf/shelf-parts";
import { getGameSummary, getReleasePicker, resolveMergedRelease } from "@/features/catalog/queries";
import { type FastAddReference, fastAddHref, planFastAdd } from "@/features/collection/fast-add";
import { gameOverview } from "@/features/shelf/copies";
import { LICENSE_LABELS } from "@/features/media/game-images";
import { approvedImageFor, approvedImagesOf } from "@/features/media/registry";
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
  const platformIds = new Map(options?.platforms.map((p) => [p.slug, { id: p.id, shortName: p.shortName }]) ?? []);

  // M17b: the platform the page shows (chosen, or the game's only one), its region's
  // label, the approved image for them (never a stand-in), and the publisher only when
  // every verified release names the same one.
  const platform = overview.platforms.some((p) => p.slug === picker.selection.platform)
    ? picker.selection.platform
    : overview.platforms.length === 1
      ? overview.platforms[0].slug
      : null;
  const regionName = options?.regions.find((r) => r.code === picker.selection.region)?.label ?? null;
  const image = approvedImageFor({ game: picker.game.slug, platform, region: picker.selection.region, release: picker.selection.releaseId });
  const publishers = new Set(all.releases.map((r) => r.publisherName));
  const publisher = publishers.size === 1 ? ([...publishers][0] ?? null) : null;
  const gallery = approvedImagesOf(picker.game.slug);
  const intent = first(query.add) === picker.game.slug ? "add" : first(query.wish) === picker.game.slug ? "wish" : null;

  // The catalog is public and cached. The collector's copies, adding and wishing read the
  // session, so they stream in on their own, and return here after signing in.
  return (
    <>
      <Breadcrumbs items={[{ label: "Explore", href: "/explore" }, { label: picker.game.title }]} />
      <div className="mt-4">
        <GameHero
          game={picker.game}
          overview={overview}
          platform={platform}
          region={regionName}
          image={image}
          publisher={publisher}
          actions={
            <Suspense fallback={<HeroActionsSkeleton />}>
              <HeroActions game={{ id: picker.game.id, slug: picker.game.slug, title: picker.game.title }} platform={platform} returnPath={here} autoOpen={intent} />
            </Suspense>
          }
        />
      </div>
      {/* One grid: on narrow screens the game's parts come first, then the collector's
          copies; on wide ones the copies stand in a column beside them. Adding a specific
          copy comes before the full list of releases, so a collector adding a pile of
          games reaches it without scrolling past what they already know. */}
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-8 lg:col-start-1">
          <SectionNav
            items={[
              { id: "overview", label: "Overview" },
              { id: "add-copy", label: "Add a copy" },
              { id: "releases", label: "Physical releases", count: overview.releaseCount },
              ...(gallery.length ? [{ id: "gallery", label: "Gallery", count: gallery.length }] : []),
              { id: "your-copies", label: "Your collection" },
            ]}
          />
          <GameOverview game={picker.game} summary={summary} />
        </div>
        <div id="add-copy" className="min-w-0 scroll-mt-32 rounded-2xl border border-white/10 bg-card/60 p-5 sm:p-6 lg:col-start-1">
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
        </div>
        <aside id="your-copies" aria-label="Your collection" className="min-w-0 scroll-mt-32 lg:sticky lg:top-22 lg:col-start-2 lg:row-span-4 lg:row-start-1">
          <div className="flex flex-col gap-6">
            <Suspense fallback={<GameCopiesSkeleton />}>
              <GameCopies gameId={picker.game.id} title={picker.game.title} />
            </Suspense>
            <Suspense fallback={null}>
              <VisitorPanel title={picker.game.title} returnPath={here} />
            </Suspense>
            {/* M12 W2: the collector's wishes for this game, apart from their copies. */}
            <Suspense fallback={<GameWishlistSkeleton />}>
              <GameWishlist gameId={picker.game.id} title={picker.game.title} releases={all.releases} returnPath={here} />
            </Suspense>
          </div>
        </aside>
        <div id="releases" className="min-w-0 scroll-mt-32 lg:col-start-1">
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
        {/* Only approved images, and only when there are some: never an empty gallery. */}
        {gallery.length ? (
          <section id="gallery" aria-labelledby="gallery-title" className="min-w-0 scroll-mt-32 lg:col-start-1">
            <h2 id="gallery-title" className="text-xl font-semibold tracking-tight">
              Gallery
            </h2>
            <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {gallery.map((g) => (
                <li key={g.id} className="flex flex-col gap-1.5">
                  <div className="flex aspect-square items-center justify-center rounded-xl border border-white/[0.08] bg-black/20 p-3">
                    <Image src={`/${g.file}`} alt={g.alt} width={g.width} height={g.height} sizes="(min-width: 640px) 220px, 45vw" className="h-auto max-h-full w-auto max-w-full object-contain" />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {g.source.name} · {LICENSE_LABELS[g.license]}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
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
