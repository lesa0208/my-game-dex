import { Disc3 } from "lucide-react";
import type { ReactNode } from "react";

import { ConsoleArt } from "@/components/shelf/console-art";
import { Skeleton } from "@/components/ui/skeleton";
import { NO_VERIFIED_RELEASE, releaseCountLabel } from "@/features/catalog/format";
import type { PickerRelease } from "@/features/catalog/types";
import { editionKey, fastAddHref } from "@/features/collection/fast-add";
import { approvedReleaseImageFor } from "@/features/media/registry";
import { consoleFor, type gameOverview } from "@/features/shelf/copies";

import { ReleaseCard } from "./release-card";

// A game's page, as the catalog records it: each of its physical releases (the hero is
// in game-hero.tsx). Public and cached: nothing here reads the session. Only what the
// catalog records is shown; a missing detail is left out, never filled in.

type Overview = ReturnType<typeof gameOverview>;

/**
 * Physical Releases 2.0 (Phase 4A): every published release of the game, grouped by platform,
 * each its own card: a regional release, an edition and a variant are separate cards, never
 * merged. A card shows only what the catalog records (release-card.tsx). Its add link opens
 * the add steps with platform, region, edition and release already chosen.
 */
export function PhysicalReleases({
  slug,
  overview,
  renderAction,
  renderOwned,
  renderPlatformNote,
  emptyAction,
}: {
  slug: string;
  overview: Overview;
  renderAction?: (release: PickerRelease) => ReactNode;
  /** The collector's copies of a release (streamed on its own; empty for a visitor). */
  renderOwned?: (release: PickerRelease) => ReactNode;
  /** Under a platform's releases: the collector's copies on it whose release isn't identified. */
  renderPlatformNote?: (platform: { slug: string; name: string; shortName: string }) => ReactNode;
  /** With no verified release: how the viewer can still add their copy (streamed on its own). */
  emptyAction?: ReactNode;
}) {
  const images = new Map(overview.groups.flatMap(({ releases }) => releases.map((r) => [r.id, approvedReleaseImageFor({ game: slug, platform: r.platform.slug, release: r.id })] as const)));
  const unpictured = [...images.values()].some((image) => image === null);
  return (
    <section aria-labelledby="physical-releases" className="rounded-2xl border border-white/10 bg-card/60 p-4 sm:p-6" data-physical-releases="">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="physical-releases" className="text-lg font-semibold tracking-tight">
          Physical releases
        </h2>
        {/* Said once: when there's none, the paragraph below says so. */}
        {overview.releaseCount ? <p className="text-sm text-muted-foreground">{releaseCountLabel(overview.releaseCount)}</p> : null}
      </div>
      {overview.groups.length === 0 ? (
        // Said briefly, once: no release is verified yet, and a copy can still be added.
        <div className="mt-4 flex flex-col items-start gap-4 rounded-xl border border-dashed border-white/12 bg-white/[0.02] p-4 sm:flex-row sm:items-center sm:p-5" data-releases-empty="">
          <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary-text">
            <Disc3 className="size-5" />
          </span>
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-foreground">{NO_VERIFIED_RELEASE}</p>
            <p className="mt-0.5 text-muted-foreground">You can still add your copy. It&apos;s kept without a specific release.</p>
          </div>
          {emptyAction ? <div className="shrink-0 empty:hidden">{emptyAction}</div> : null}
        </div>
      ) : (
        <>
          {/* Said once for the whole tab, not on every card. */}
          {unpictured ? (
            <p className="mt-1 text-sm text-muted-foreground" data-releases-media-note="">
              Without an approved photo of the release, its cartridge or case is drawn plain, with no label.
            </p>
          ) : null}
          <div className="mt-5 flex flex-col gap-7">
            {overview.groups.map(({ platform, releases }) => {
              const consoleKind = consoleFor(platform.slug);
              return (
                <section key={platform.slug} aria-labelledby={`releases-${platform.slug}`} data-release-group={platform.slug}>
                  <h3 id={`releases-${platform.slug}`} className="flex items-center gap-2 font-medium">
                    {consoleKind ? <ConsoleArt kind={consoleKind} sizes="40px" className="h-6 w-8 shrink-0" /> : null}
                    {platform.name}
                    <span className="text-sm font-normal text-muted-foreground">{releaseCountLabel(releases.length)}</span>
                  </h3>
                  {renderPlatformNote ? <div className="empty:hidden">{renderPlatformNote(platform)}</div> : null}
                  <ul className="mt-3 grid gap-3 lg:grid-cols-2">
                    {releases.map((release) => (
                      <li key={release.id} className="min-w-0">
                        <ReleaseCard
                          release={release}
                          image={images.get(release.id) ?? null}
                          addHref={`${fastAddHref(slug, { platform: release.platform.slug, region: release.region.code, edition: editionKey(release.edition), release: release.id })}#choose-release`}
                          owned={renderOwned?.(release)}
                          action={renderAction?.(release)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

export function GameDetailsSkeleton() {
  return (
    // The page's shape without a sidebar: the hero, the tab row, then Overview's content.
    <div aria-hidden="true" className="flex flex-col gap-6">
      <Skeleton className="h-80 w-full rounded-3xl" />
      <Skeleton className="h-12 w-full max-w-md rounded-lg" />
      <Skeleton className="h-56 w-full rounded-2xl" />
    </div>
  );
}
