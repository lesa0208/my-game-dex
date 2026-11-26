import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { Suspense } from "react";

import { gameHref } from "@/components/catalog/release-picker";
import { GameCopies, GameCopiesSkeleton } from "@/components/collection/game-copies";
import { GameDetailsSkeleton, PhysicalReleases } from "@/components/games/game-details";
import { GameArtwork, GameIdentity, HeroBackdrop } from "@/components/games/game-hero";
import { GameFactsCard, HeroActions, HeroActionsSkeleton, MyCopiesVisitor, MyCopyPanel, MyCopyPanelSkeleton, OverviewTab } from "@/components/games/game-sections";
import { type GameTab, GameTabs } from "@/components/games/game-tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { Breadcrumbs } from "@/components/shelf/shelf-parts";
import { GameWishlist, GameWishlistSkeleton, WantRelease } from "@/components/wishlist/game-wishlist";
import { getPlatformYears } from "@/features/catalog/discover";
import { getGameSummary, getReleasePicker, resolveMergedRelease } from "@/features/catalog/queries";
import { LICENSE_LABELS } from "@/features/media/game-images";
import { approvedImageFor, approvedImagesOf } from "@/features/media/registry";
import { gameOverview } from "@/features/shelf/copies";
import { getSubmissionOptions } from "@/features/submissions/queries";

export const metadata: Metadata = {
  title: "Game",
};

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() || null;
}

/**
 * M17b: a game's page as a collector's dashboard. The hero: the artwork on the left, the
 * game and the collector's actions in the centre, their copy on the right. Below it, the
 * game's content as tabs, with the catalog's facts beside them. Adding goes through the
 * quick add (the hero, or the My Copy panel); the step-by-step add has its own page
 * (/games/<slug>/add), linked from the hero's "More" menu and from each release.
 */
async function GameContent({ params, searchParams }: PageProps<"/games/[slug]">) {
  const { slug } = await params;
  const query = await searchParams;
  const requested = { platform: first(query.platform), release: first(query.release) };

  const [outcome, options] = await Promise.all([getReleasePicker(slug, requested.platform, null, requested.release), getSubmissionOptions()]);
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
  // (M7b-2c D14); any other unknown id gets the page as without it.
  if (requested.release && !picker.selection.releaseId) {
    const merged = await resolveMergedRelease(requested.release);
    if (merged) permanentRedirect(gameHref(merged.gameSlug, { platform: null, region: null, release: merged.releaseId }));
  }
  // A merged game, or a link by id, goes to the game's own address.
  if (picker.game.slug !== slug) redirect(gameHref(picker.game.slug, { platform: requested.platform, region: null, release: requested.release }));

  const everything = requested.platform || requested.release ? await getReleasePicker(slug, null, null, null) : null;
  const all = everything?.ok && everything.data ? everything.data : picker;
  const overview = gameOverview(all);
  const [summary, years] = await Promise.all([getGameSummary(picker.game.id), getPlatformYears()]);

  // The system the page shows: the one asked for, else the game's earliest system by the
  // platform's own release year (its other systems are a click away). A release asked for
  // decides its region, for the artwork.
  const earliest = [...overview.platforms].sort((a, b) => (years[a.slug] ?? 9999) - (years[b.slug] ?? 9999))[0]?.slug ?? null;
  const platformSlug = overview.platforms.some((p) => p.slug === picker.selection.platform) ? picker.selection.platform : earliest;
  const platform = overview.platforms.find((p) => p.slug === platformSlug) ?? null;
  const releaseRegion = picker.releases.find((r) => r.id === picker.selection.releaseId)?.region.code ?? null;
  const regionName = options?.regions.find((r) => r.code === releaseRegion)?.label ?? null;
  const image = approvedImageFor({ game: picker.game.slug, platform: platformSlug, region: releaseRegion, release: picker.selection.releaseId });
  const publishers = new Set(all.releases.map((r) => r.publisherName));
  const publisher = publishers.size === 1 ? ([...publishers][0] ?? null) : null;
  const gallery = approvedImagesOf(picker.game.slug);
  const here = gameHref(picker.game.slug, { platform: requested.platform, region: null, release: requested.release });
  const intent = first(query.add) === picker.game.slug ? "add" : first(query.wish) === picker.game.slug ? "wish" : null;
  const game = { id: picker.game.id, slug: picker.game.slug, title: picker.game.title };

  const tabs: GameTab[] = [
    { id: "overview", label: "Overview", content: <OverviewTab game={picker.game} summary={summary} overview={overview} publisher={publisher} /> },
    {
      id: "releases",
      label: "Physical Releases",
      count: overview.releaseCount,
      content: (
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
      ),
    },
    {
      id: "my-copies",
      label: "My Copies",
      content: (
        <div id="your-copies" className="max-w-2xl">
          <Suspense fallback={<GameCopiesSkeleton />}>
            <GameCopies gameId={picker.game.id} title={picker.game.title} />
          </Suspense>
          <Suspense fallback={null}>
            <MyCopiesVisitor returnPath={here} />
          </Suspense>
          {/* M12 W2's wishlist panel: what the collector wants of this game, at any level. */}
          <div className="mt-6">
            <Suspense fallback={<GameWishlistSkeleton />}>
              <GameWishlist gameId={picker.game.id} title={picker.game.title} releases={all.releases} returnPath={here} />
            </Suspense>
          </div>
        </div>
      ),
    },
    ...(gallery.length
      ? [
          {
            id: "gallery",
            label: "Gallery",
            count: gallery.length,
            content: (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: "Explore", href: "/explore" }, { label: picker.game.title }]} />

      <article aria-labelledby="game-title" className="relative mt-4 overflow-hidden rounded-3xl border border-white/10 bg-[#100e16]">
        <HeroBackdrop platform={platformSlug} />
        <div className="relative grid gap-6 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_19rem] xl:gap-8 xl:p-8 2xl:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="grid items-center gap-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:gap-8 xl:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] 2xl:gap-10">
            <div className="mx-auto w-full max-w-[18rem] md:max-w-none">
              <GameArtwork image={image} platform={platform} region={releaseRegion} regionName={regionName} title={picker.game.title} />
            </div>
            <GameIdentity
              game={picker.game}
              overview={overview}
              platform={platform}
              publisher={publisher}
              actions={
                <Suspense fallback={<HeroActionsSkeleton />}>
                  <HeroActions
                    game={game}
                    platform={platformSlug}
                    returnPath={here}
                    autoOpen={intent}
                  />
                </Suspense>
              }
            />
          </div>
          <aside aria-label="Your collection" className="min-w-0 lg:self-start">
            <Suspense fallback={<MyCopyPanelSkeleton />}>
              <MyCopyPanel game={game} platform={platformSlug} returnPath={here} />
            </Suspense>
          </aside>
        </div>
      </article>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem] xl:gap-8 2xl:grid-cols-[minmax(0,1fr)_21rem]">
        <GameTabs tabs={tabs} />
        <div className="min-w-0 lg:sticky lg:top-22">
          <GameFactsCard game={picker.game} overview={overview} publisher={publisher} />
        </div>
      </div>
    </>
  );
}

export default function GamePage(props: PageProps<"/games/[slug]">) {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-4 md:px-6 md:py-6">
      <Suspense fallback={<GameDetailsSkeleton />}>
        <GameContent {...props} />
      </Suspense>
    </div>
  );
}
