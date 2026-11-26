import { ChevronRight, Disc3 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { editionText } from "@/components/catalog/release-picker";
import { ConsoleArt } from "@/components/shelf/console-art";
import { GameMedia } from "@/components/shelf/game-media";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCatalogDate, languageName, NO_VERIFIED_RELEASE, regionLabel, releaseCountLabel } from "@/features/catalog/format";
import { packagingLabel } from "@/features/catalog/packaging";
import type { PickerRelease } from "@/features/catalog/types";
import { editionKey, fastAddHref } from "@/features/collection/fast-add";
import { consoleFor, type gameOverview, releaseMedia } from "@/features/shelf/copies";

// A game's page, as the catalog records it: each of its physical releases (the hero is
// in game-hero.tsx). Public and cached: nothing here reads the session. Only what the
// catalog records is shown; a missing detail is left out, never filled in.

type Overview = ReturnType<typeof gameOverview>;

/** "Disc 2 × CD-ROM · SLUS-00594 · 1997 · Sony": what the catalog records, in a fixed order. */
function releaseFacts(release: PickerRelease) {
  return [
    release.format ? (release.mediaCount && release.mediaCount > 1 ? `${release.mediaCount} × ${release.format.name}` : release.format.name) : null,
    packagingLabel(release.packagingCode, release.packaging),
    release.identifiers.productCode,
    release.releaseDate ? formatCatalogDate(release.releaseDate) : null,
    release.publisherName,
    release.languages?.length ? release.languages.map(languageName).join(", ") : null,
  ].filter((fact): fact is string => Boolean(fact));
}

/**
 * Every published release of the game, grouped by platform, each kept on its own: a
 * regional release, an edition and a variant are separate rows. Choosing one opens it
 * in the add steps below, with platform, region and edition already chosen.
 */
export function PhysicalReleases({
  slug,
  title,
  overview,
  renderAction,
  emptyAction,
}: {
  slug: string;
  title: string;
  overview: Overview;
  renderAction?: (release: PickerRelease) => ReactNode;
  /** With no verified release: how the viewer can still add their copy (streamed on its own). */
  emptyAction?: ReactNode;
}) {
  return (
    <section aria-labelledby="physical-releases" className="rounded-2xl border border-white/10 bg-card/60 p-5 sm:p-6">
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
        <div className="mt-4 flex flex-col gap-5">
          {overview.groups.map(({ platform, releases }) => {
            const consoleKind = consoleFor(platform.slug);
            return (
              <section key={platform.slug} aria-labelledby={`releases-${platform.slug}`}>
                <h3 id={`releases-${platform.slug}`} className="flex items-center gap-2 text-sm font-medium">
                  {consoleKind ? <ConsoleArt kind={consoleKind} sizes="40px" className="h-6 w-8 shrink-0" /> : null}
                  {platform.name}
                  <span className="text-xs font-normal text-muted-foreground">{releaseCountLabel(releases.length)}</span>
                </h3>
                <ul className="mt-2 divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.07]">
                  {releases.map((release) => {
                    const edition = editionText(release.edition);
                    const facts = releaseFacts(release);
                    return (
                      <li key={release.id} className="flex flex-col sm:flex-row sm:items-center">
                        <Link
                          href={`${fastAddHref(slug, { platform: release.platform.slug, region: release.region.code, edition: editionKey(release.edition), release: release.id })}#choose-release`}
                          scroll={false}
                          className="group flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-white/[0.03] focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:gap-4"
                        >
                          <div className="w-12 shrink-0 sm:w-14">
                            <GameMedia media={releaseMedia(release)} seed={release.id} title={release.localTitle ?? title} systemLabel={release.platform.shortName} sizes="56px" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium">
                              {regionLabel(release.region)}
                              {edition ? <span className="text-muted-foreground"> · {edition}</span> : null}
                              {release.variantName ? <span className="text-muted-foreground"> · {release.variantName}</span> : null}
                            </p>
                            {release.localTitle ? <p className="truncate text-xs text-muted-foreground">Title on the box: {release.localTitle}</p> : null}
                            <p className="mt-0.5 text-xs text-pretty text-muted-foreground">{facts.length ? facts.join(" · ") : "No further details recorded"}</p>
                          </div>
                          <span className="hidden shrink-0 items-center gap-1 text-xs text-primary-text sm:inline-flex">
                            Add this release
                            <ChevronRight aria-hidden="true" className="size-3.5" />
                          </span>
                        </Link>
                        {renderAction ? <div className="flex shrink-0 justify-end px-3 pb-2.5 empty:hidden sm:py-2.5 sm:pl-0">{renderAction(release)}</div> : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function GameDetailsSkeleton() {
  return (
    <div aria-hidden="true" className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-6">
        <Skeleton className="h-80 w-full rounded-2xl" />
        <Skeleton className="h-56 w-full rounded-2xl" />
      </div>
      <Skeleton className="h-48 w-full rounded-2xl" />
    </div>
  );
}
