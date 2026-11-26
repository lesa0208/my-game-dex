import { CalendarDays, Check, Disc3, ImageOff, Layers } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { ConsoleArt } from "@/components/shelf/console-art";
import { formatCatalogDate, gameKindLabel, releaseCountLabel } from "@/features/catalog/format";
import type { ReleasePicker } from "@/features/catalog/types";
import { fastAddHref } from "@/features/collection/fast-add";
import { type GameImage, imageCaption, LICENSE_LABELS } from "@/features/media/game-images";
import { consoleFor, type gameOverview } from "@/features/shelf/copies";
import { cn } from "@/lib/utils";

type Overview = ReturnType<typeof gameOverview>;

/**
 * M17b: the game as a collectible. Left, a large image of its real cartridge or case when
 * an approved one matches the chosen platform (and region), with its source and terms;
 * otherwise an honest "no artwork yet" panel, never a made-up label. Right, the title,
 * the platform choice, what the catalog records about it, and the collector's actions
 * (`actions`, which read the session and stream in on their own).
 *
 * Only facts the catalog has are shown; a missing one is left out.
 */
export function GameHero({
  game,
  overview,
  platform,
  region,
  image,
  publisher,
  actions,
}: {
  game: ReleasePicker["game"];
  overview: Overview;
  /** The chosen platform's slug, when one is chosen (or the game has only one). */
  platform: string | null;
  /** The chosen region's label (for the image caption), when one is chosen. */
  region: string | null;
  image: GameImage | null;
  /** The publisher every verified release names, when they all agree. */
  publisher: string | null;
  actions: ReactNode;
}) {
  const platforms = overview.platforms;
  const chosen = platforms.find((p) => p.slug === platform) ?? null;
  const facts = [
    game.firstRelease ? { icon: CalendarDays, label: "First released", value: formatCatalogDate(game.firstRelease) } : null,
    platforms.length ? { icon: Layers, label: platforms.length === 1 ? "Platform" : "Platforms", value: platforms.length === 1 ? platforms[0].name : `${platforms.length} systems` } : null,
    { icon: Disc3, label: "Verified releases", value: overview.releaseCount ? releaseCountLabel(overview.releaseCount) : "None yet" },
    publisher ? { icon: Check, label: "Publisher", value: publisher } : null,
  ].filter((fact) => fact !== null);

  return (
    <article aria-labelledby="game-title" className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#141319]">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(55%_90%_at_12%_10%,rgb(255_176_96/0.16),transparent_70%),radial-gradient(60%_100%_at_100%_100%,rgb(139_92_246/0.24),transparent_70%)]"
      />
      <div className="relative grid gap-6 p-5 sm:p-8 md:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] md:items-center md:gap-10 lg:gap-14">
        <GameImagePanel image={image} platform={chosen} region={region} title={game.title} />

        <div className="min-w-0">
          {platforms.length > 1 ? (
            <nav aria-label="Game platform" className="mb-4">
              <ul className="flex flex-wrap gap-1.5">
                {platforms.map((p) => {
                  const kind = consoleFor(p.slug);
                  const active = p.slug === platform;
                  return (
                    <li key={p.slug}>
                      <Link
                        href={`${fastAddHref(game.slug, { platform: p.slug, region: null, edition: null, release: null })}`}
                        scroll={false}
                        aria-current={active ? "true" : undefined}
                        title={p.name}
                        className={cn(
                          "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none",
                          active ? "border-primary bg-primary/15 font-medium text-foreground" : "border-white/10 text-muted-foreground hover:border-white/25 hover:text-foreground",
                        )}
                      >
                        {kind ? <ConsoleArt kind={kind} sizes="32px" className="h-5 w-7 shrink-0" /> : null}
                        {p.shortName}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ) : chosen ? (
            <p className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
              {consoleFor(chosen.slug) ? <ConsoleArt kind={consoleFor(chosen.slug)!} sizes="40px" className="h-6 w-8 shrink-0" /> : null}
              {chosen.name}
            </p>
          ) : null}

          <h1 id="game-title" className="text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl lg:text-5xl">
            {game.title}
          </h1>
          <p className="mt-2 text-base text-muted-foreground">
            {[chosen && platforms.length > 1 ? chosen.name : null, game.firstRelease ? game.firstRelease.value.slice(0, 4) : null, gameKindLabel(game.kind)].filter(Boolean).join(" · ")}
          </p>

          <div className="mt-6 max-w-md">{actions}</div>

          {facts.length ? (
            <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-white/[0.08] pt-5 sm:grid-cols-4 md:grid-cols-2 xl:grid-cols-4">
              {facts.map(({ icon: Icon, label, value }) => (
                <div key={label} className="flex flex-col-reverse gap-0.5">
                  <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Icon aria-hidden="true" className="size-3.5 shrink-0 text-primary-text" />
                    {label}
                  </dt>
                  <dd className="text-sm font-semibold text-pretty">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** The real item's image with its source and terms, or an honest panel saying there's none yet. */
function GameImagePanel({ image, platform, region, title }: { image: GameImage | null; platform: { slug: string; name: string; shortName: string } | null; region: string | null; title: string }) {
  if (image) {
    return (
      <figure className="flex flex-col items-center" data-game-image={image.id}>
        <div className="relative flex w-full items-center justify-center rounded-2xl bg-black/20 p-4 sm:p-6">
          <Image
            src={`/${image.file}`}
            alt={image.alt}
            width={image.width}
            height={image.height}
            sizes="(min-width: 768px) 26rem, 90vw"
            priority
            className="h-auto max-h-[22rem] w-auto max-w-full object-contain drop-shadow-[0_24px_32px_rgb(0_0_0/0.65)]"
          />
        </div>
        <figcaption className="mt-2.5 text-center text-xs text-muted-foreground">
          {imageCaption(image, region)} {image.attribution ? `${image.attribution}. ` : ""}
          {image.source.url ? (
            <a href={image.source.url} className="underline underline-offset-2 hover:text-foreground" rel="noopener noreferrer" target="_blank">
              {image.source.name}
            </a>
          ) : (
            image.source.name
          )}
          {" · "}
          {LICENSE_LABELS[image.license]}: {image.licenseDetail}
        </figcaption>
      </figure>
    );
  }

  const kind = platform ? consoleFor(platform.slug) : null;
  return (
    <figure className="flex flex-col items-center" data-game-image="none">
      {/* A lit, empty stage: the system's console (approved art of the system, never of the
          game) above the note, which says plainly that there's no game artwork yet. */}
      <div className="relative flex aspect-[5/4] w-full max-w-[24rem] flex-col items-center justify-end overflow-hidden rounded-2xl border border-white/[0.08] bg-[radial-gradient(70%_60%_at_50%_35%,rgb(139_92_246/0.16),transparent_70%)] px-6 pb-6 text-center">
        <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-amber-100/40 shadow-[0_0_14px_3px_rgb(255_190_120/0.18)]" />
        {kind ? (
          <ConsoleArt kind={kind} sizes="240px" className="absolute inset-x-[20%] top-[10%] bottom-[46%] opacity-45 grayscale-[35%]" />
        ) : (
          <span className="absolute top-[22%] flex size-14 items-center justify-center rounded-2xl bg-white/[0.05]">
            <ImageOff aria-hidden="true" className="size-6 text-muted-foreground" />
          </span>
        )}
        <p className="relative flex items-center gap-1.5 text-sm font-medium">
          {kind ? <ImageOff aria-hidden="true" className="size-4 text-muted-foreground" /> : null}
          No artwork for {title} yet
        </p>
        <p className="relative mt-1 max-w-[17rem] text-xs leading-relaxed text-muted-foreground">
          We show a game&apos;s own cartridge or case only from an approved image we have permission to use.
        </p>
      </div>
      {kind && platform ? <figcaption className="mt-2 text-xs text-muted-foreground">The {platform.name} console, for the system only.</figcaption> : null}
    </figure>
  );
}
