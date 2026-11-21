import { CalendarDays, ChevronRight, Disc3, Globe, Layers } from "lucide-react";
import Link from "next/link";

import { editionText } from "@/components/catalog/release-picker";
import { ConsoleArt } from "@/components/shelf/console-art";
import { GameMedia } from "@/components/shelf/game-media";
import { ShelfBoard, ShelfLight } from "@/components/shelf/shelf-parts";
import { Skeleton } from "@/components/ui/skeleton";
import { aliasKindLabel, formatCatalogDate, gameKindLabel, languageName, regionLabel, releaseCountLabel } from "@/features/catalog/format";
import { packagingLabel } from "@/features/catalog/packaging";
import type { PickerRelease, ReleasePicker } from "@/features/catalog/types";
import { editionKey, fastAddHref } from "@/features/collection/fast-add";
import { consoleFor, type gameOverview, releaseMedia, shelfFrame } from "@/features/shelf/copies";

// A game's page, as the catalog records it: the game itself (its hero), then each of its
// physical releases. Public and cached: nothing here reads the session. Only what the
// catalog records is shown; a missing detail is left out, never filled in.

type Overview = ReturnType<typeof gameOverview>;

/** The game: front-facing media on a lit shelf, its title and the catalog's facts about it. */
export function GameHero({ game, summary, overview }: { game: ReleasePicker["game"]; summary: string | null; overview: Overview }) {
  const hero = overview.hero;
  const platforms = overview.groups.map((g) => g.platform);
  const heroConsole = hero ? consoleFor(hero.release.platform.slug) : null;
  const eyebrow = [platforms.map((p) => p.shortName).join(" · "), game.firstRelease ? game.firstRelease.value.slice(0, 4) : null].filter(Boolean).join(" · ");
  const facts = [
    game.firstRelease ? { icon: CalendarDays, label: "First released", value: formatCatalogDate(game.firstRelease) } : null,
    platforms.length ? { icon: Layers, label: platforms.length === 1 ? "Platform" : "Platforms", value: platforms.map((p) => p.name).join(", ") } : null,
    { icon: Disc3, label: "Physical releases", value: overview.releaseCount ? releaseCountLabel(overview.releaseCount) : "None published yet" },
    overview.regions.length ? { icon: Globe, label: overview.regions.length === 1 ? "Region" : "Regions", value: overview.regions.map((r) => regionLabel(r)).join(", ") } : null,
  ].filter((fact) => fact !== null);

  return (
    <article aria-labelledby="game-title" className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#141319]">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(45%_80%_at_18%_0%,rgb(255_176_96/0.14),transparent_70%),radial-gradient(50%_90%_at_100%_100%,rgb(139_92_246/0.16),transparent_70%)]"
      />
      <div className="relative grid items-center gap-8 p-6 sm:p-8 md:grid-cols-[minmax(0,17rem)_1fr] md:gap-10">
        {/* One of the game's releases, standing on a lit shelf. */}
        <figure className="relative mx-auto w-full max-w-64 md:max-w-none">
          <div className="relative">
            <ShelfLight />
            <div className="relative px-6 pt-10 pb-1">
              <GameMedia
                media={hero?.media ?? null}
                frame={hero ? shelfFrame(hero.release.platform.slug) : null}
                seed={game.id}
                title={game.title}
                systemLabel={hero?.release.platform.shortName ?? ""}
                sizes="(min-width: 768px) 240px, 60vw"
                priority
              />
            </div>
            <ShelfBoard />
          </div>
          <figcaption className="mt-2 text-center text-xs text-muted-foreground">
            {hero ? `Shown as the ${hero.release.platform.shortName} ${regionLabel(hero.release.region)} release. Placeholder label art.` : overview.releaseCount
                ? "Placeholder art: the catalog doesn't record enough to draw this release's shell."
                : "Placeholder art: no physical release to draw yet."}
          </figcaption>
        </figure>

        <div className="min-w-0">
          {eyebrow ? (
            <p className="flex items-center gap-2 text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
              {heroConsole ? <ConsoleArt kind={heroConsole} sizes="40px" className="h-6 w-8 shrink-0" /> : null}
              {eyebrow}
            </p>
          ) : null}
          <h1 id="game-title" className="mt-2 text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
            {game.title}
          </h1>
          {game.kind !== "game" ? <p className="mt-1.5 text-sm text-muted-foreground">{gameKindLabel(game.kind)}</p> : null}
          {game.aliases.length ? (
            <ul aria-label="Other titles" className="mt-2 flex flex-col gap-0.5 text-sm">
              {game.aliases.map((alias) => (
                <li key={`${alias.title}-${alias.languageCode}-${alias.regionCode}`}>
                  <span className="text-muted-foreground">{aliasKindLabel(alias.kind)}: </span>
                  {alias.title}
                  {alias.languageCode ? <span className="text-muted-foreground"> · {languageName(alias.languageCode)}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {summary ? <p className="mt-4 max-w-prose text-sm leading-relaxed text-pretty text-foreground/90">{summary}</p> : null}
          <dl className="mt-6 grid max-w-lg grid-cols-1 gap-2.5 sm:grid-cols-2">
            {facts.map(({ icon: Icon, label, value }) => (
              <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3.5 py-3">
                <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon aria-hidden="true" className="size-3.5 shrink-0 text-primary-text" />
                  {label}
                </dt>
                <dd className="mt-1 text-sm font-medium text-pretty">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </article>
  );
}

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
export function PhysicalReleases({ slug, title, overview }: { slug: string; title: string; overview: Overview }) {
  return (
    <section aria-labelledby="physical-releases" className="rounded-2xl border border-white/10 bg-card/60 p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="physical-releases" className="text-lg font-semibold tracking-tight">
          Physical releases
        </h2>
        <p className="text-sm text-muted-foreground">{overview.releaseCount ? releaseCountLabel(overview.releaseCount) : "None published yet"}</p>
      </div>
      {overview.groups.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">The catalog doesn&apos;t list a physical release of this game yet. You can still add your copy below, as your own record.</p>
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
                      <li key={release.id}>
                        <Link
                          href={`${fastAddHref(slug, { platform: release.platform.slug, region: release.region.code, edition: editionKey(release.edition), release: release.id })}#choose-release`}
                          scroll={false}
                          className="group flex items-center gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-white/[0.03] focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:gap-4"
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
                            Choose
                            <ChevronRight aria-hidden="true" className="size-3.5" />
                          </span>
                        </Link>
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
