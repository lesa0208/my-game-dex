import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { Suspense } from "react";

import { gameHref } from "@/components/catalog/release-picker";
import { GameCopies, GameCopiesSkeleton } from "@/components/collection/game-copies";
import { GameDetailsSkeleton, PhysicalReleases } from "@/components/games/game-details";
import { GameGallery } from "@/components/games/game-gallery";
import { GameArtwork, GameHeroInfo, GameIdentity, type HeroDescription, HeroBackdrop } from "@/components/games/game-hero";
import { OverviewTab } from "@/components/games/game-overview";
import { PlatformUnidentified, ReleaseOwned } from "@/components/games/release-ownership";
import { HeroActions, HeroActionsSkeleton, MyCopiesVisitor, MyCopyPanel, ReleasesEmptyAction } from "@/components/games/game-sections";
import { type GameTab, GameTabs } from "@/components/games/game-tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { Breadcrumbs } from "@/components/shelf/shelf-parts";
import { GameWishlist, GameWishlistSkeleton, WantRelease } from "@/components/wishlist/game-wishlist";
import { getPlatformYears } from "@/features/catalog/discover";
import { coverFitsPlatform } from "@/features/catalog/provider-images";
import { getProviderMetadata, igdbImageUrl } from "@/features/catalog/provider-metadata";
import { getGameSummary, getReleasePicker, resolveMergedRelease } from "@/features/catalog/queries";
import { LICENSE_LABELS } from "@/features/media/game-images";
import { galleryItems } from "@/features/media/gallery";
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
 * M17b: a game's page as a collector's dashboard. The hero (Game Details 2.0): the artwork on
 * the left, the game and the collector's actions beside it, their copies (owners only). Below it,
 * the game's content as tabs, full width; the game's information in Overview (Phase 2). Adding goes through the
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
  const [summary, years, metadata] = await Promise.all([getGameSummary(picker.game.id), getPlatformYears(), getProviderMetadata([picker.game.id])]);
  // M18a: IGDB's metadata for the game, when it's linked: shown as IGDB's, never as the catalog's.
  const provider = metadata.get(picker.game.id) ?? null;

  // The system the page shows: the one asked for, else the game's earliest system by the
  // platform's own release year (its other systems are a click away). A release asked for
  // decides its region, for the artwork.
  const earliest = [...overview.platforms].sort((a, b) => (years[a.slug] ?? 9999) - (years[b.slug] ?? 9999))[0]?.slug ?? null;
  const platformSlug = overview.platforms.some((p) => p.slug === picker.selection.platform) ? picker.selection.platform : earliest;
  const platform = overview.platforms.find((p) => p.slug === platformSlug) ?? null;
  // M18a: IGDB's images (cover, screenshots) are the game's, not a platform's: shown only on a
  // platform IGDB lists for the game, never the SNES game's on the GBA page. Its text stays.
  const igdbFits = provider ? coverFitsPlatform(provider.platformIds, platformSlug) : false;
  const igdbImages = { cover: igdbFits ? (provider?.cover ?? null) : null, screenshots: igdbFits ? (provider?.screenshots ?? []) : [] };
  const heroCover = igdbImages.cover;
  // The hero's description preview: the catalog's own summary first, else IGDB's, credited.
  const heroDescription: HeroDescription | null = summary ? { text: summary, source: "catalog", url: null } : provider?.summary ? { text: provider.summary, source: "igdb", url: provider.url } : null;
  const releaseRegion = picker.releases.find((r) => r.id === picker.selection.releaseId)?.region.code ?? null;
  const regionName = options?.regions.find((r) => r.code === releaseRegion)?.label ?? null;
  const image = approvedImageFor({ game: picker.game.slug, platform: platformSlug, region: releaseRegion, release: picker.selection.releaseId });
  const publishers = new Set(all.releases.map((r) => r.publisherName));
  const publisher = publishers.size === 1 ? ([...publishers][0] ?? null) : null;
  // Game Details 2.0, Phase 3: the Gallery's items. The registry's approved photos of the page's
  // platform only (an image is never shown for another platform), then IGDB's screenshots where
  // they fit the platform (above); nothing else.
  const galleryList = galleryItems({
    title: picker.game.title,
    photos: approvedImagesOf(picker.game.slug).filter((g) => g.platform === platformSlug),
    licenseLabels: LICENSE_LABELS,
    platformName: (s) => overview.platforms.find((p) => p.slug === s)?.shortName ?? null,
    regionName: (c) => options?.regions.find((r) => r.code === c)?.label ?? null,
    screenshots: igdbImages.screenshots,
    igdbUrl: provider?.url ?? null,
  });
  const here = gameHref(picker.game.slug, { platform: requested.platform, region: null, release: requested.release });
  const intent = first(query.add) === picker.game.slug ? "add" : first(query.wish) === picker.game.slug ? "wish" : null;
  const game = { id: picker.game.id, slug: picker.game.slug, title: picker.game.title };

  const tabs: GameTab[] = [
    { id: "overview", label: "Overview", content: <OverviewTab game={picker.game} overview={overview} summary={summary} provider={provider} /> },
    {
      id: "releases",
      label: "Physical Releases",
      count: overview.releaseCount,
      content: (
        <PhysicalReleases
          slug={picker.game.slug}
          overview={overview}
          emptyAction={
            <Suspense fallback={null}>
              <ReleasesEmptyAction game={game} platform={platformSlug} returnPath={here} />
            </Suspense>
          }
          renderOwned={(release) => (
            <Suspense fallback={null}>
              <ReleaseOwned gameId={picker.game.id} releaseId={release.id} />
            </Suspense>
          )}
          renderPlatformNote={(p) => (
            <Suspense fallback={null}>
              <PlatformUnidentified gameId={picker.game.id} platform={p.slug} platformName={p.shortName} />
            </Suspense>
          )}
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
    ...(galleryList.length
      ? [
          {
            id: "gallery",
            label: "Gallery",
            count: galleryList.length,
            content: <GameGallery title={picker.game.title} items={galleryList} igdbUrl={provider?.url ?? null} />,
          },
        ]
      : []),
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: "Explore", href: "/explore" }, { label: picker.game.title }]} />

      {/* Game Details 2.0, Phase 1: the hero. A phone reads the identity and actions first, then
          the artwork, then the collector's copies (owners only). From md up the artwork stands on
          the left; from xl a third column holds Your copies, only when there is a copy to show:
          the column has no width otherwise, so a visitor's hero is two columns. */}
      <article aria-labelledby="game-title" className="relative mt-4 overflow-hidden rounded-3xl border border-white/10 bg-[#100e16]" data-hero="">
        <HeroBackdrop platform={platformSlug} artwork={heroCover ? igdbImageUrl(heroCover, "cover_big") : null} />
        <div className="relative flex flex-col gap-6 p-5 sm:p-7 md:grid md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:content-center md:gap-x-9 md:gap-y-5 md:[grid-template-areas:'art_head'_'art_info'_'art_copy'] lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,19rem)_minmax(0,1fr)_auto] xl:gap-x-0 xl:gap-y-6 xl:p-9 xl:[grid-template-areas:'art_head_copy'_'art_info_copy'] 2xl:grid-cols-[minmax(0,21rem)_minmax(0,1fr)_auto]">
          <div className="order-1 min-w-0 md:[grid-area:head] md:self-end xl:pl-10">
            <GameIdentity
              game={picker.game}
              overview={overview}
              platform={platform}
              developers={provider?.developers ?? []}
              genre={provider?.genres[0] ?? null}
              actions={
                <Suspense fallback={<HeroActionsSkeleton />}>
                  <HeroActions game={game} platform={platformSlug} returnPath={here} autoOpen={intent} />
                </Suspense>
              }
            />
          </div>
          <div className="order-2 mx-auto w-full max-w-[15rem] min-w-0 md:mx-0 md:max-w-none md:self-start md:[grid-area:art] xl:self-center">
            <GameArtwork
              image={image}
              cover={heroCover && provider ? { image: heroCover, url: provider.url } : null}
              providerKnown={Boolean(provider?.cover)}
              platform={platform}
              region={releaseRegion}
              regionName={regionName}
              title={picker.game.title}
            />
          </div>
          <div className="order-3 min-w-0 empty:hidden md:[grid-area:copy] xl:self-center">
            <Suspense fallback={null}>
              <MyCopyPanel game={game} platform={platformSlug} platforms={overview.platforms} returnPath={here} />
            </Suspense>
          </div>
          <div className="order-4 min-w-0 md:[grid-area:info] md:self-start xl:pl-10">
            <GameHeroInfo overview={overview} publisher={publisher} description={heroDescription} />
          </div>
        </div>
      </article>

      {/* Game Details 2.0, Phase 2: no sidebar; the tabs take the page's width, and the game's
          information lives in Overview, each source on its own. */}
      <div className="mt-6 md:mt-8">
        <GameTabs tabs={tabs} />
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
