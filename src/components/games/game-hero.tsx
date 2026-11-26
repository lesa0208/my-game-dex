import { Building2, CalendarDays, Disc3, Layers } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { ConsoleArt } from "@/components/shelf/console-art";
import { shellFor } from "@/components/shelf/media-shells";
import { formatCatalogDate, gameKindLabel, releaseCountLabel } from "@/features/catalog/format";
import type { ReleasePicker } from "@/features/catalog/types";
import { type GameImage, imageCaption, LICENSE_LABELS } from "@/features/media/game-images";
import type { Region } from "@/features/shelf/browse";
import { consoleFor, type gameOverview, shelfFrame } from "@/features/shelf/copies";
import { cn } from "@/lib/utils";

type Overview = ReturnType<typeof gameOverview>;
type Platform = { slug: string; name: string; shortName: string };

const SHELL_REGION: Record<string, Region> = { "ntsc-uc": "NTSC-U", pal: "PAL", "ntsc-j": "NTSC-J" };

/**
 * M17b: the dashboard's atmosphere behind the hero: violet and lamp-warm light, and the
 * chosen system's console, large and blurred far behind (the system's approved art, as
 * scenery only: never the game's own).
 */
export function HeroBackdrop({ platform }: { platform: string | null }) {
  const kind = platform ? consoleFor(platform) : null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(55%_75%_at_8%_0%,rgb(255_176_96/0.20),transparent_65%),radial-gradient(60%_90%_at_72%_10%,rgb(139_92_246/0.30),transparent_70%),radial-gradient(70%_80%_at_100%_100%,rgb(91_33_182/0.35),transparent_70%)]" />
      {kind ? <ConsoleArt kind={kind} sizes="900px" className="absolute top-[-10%] right-[-6%] h-[120%] w-[60%] opacity-[0.07] blur-2xl" /> : null}
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-t from-[#0f0d15] to-transparent" />
    </div>
  );
}

/**
 * The large artwork on the left: the real item from an approved image, with its source and
 * terms; or, until one exists, the system's own cartridge or case shape with its label
 * area plainly marked "Artwork not available": a shape, never a made-up label or title.
 */
export function GameArtwork({ image, platform, region, regionName, title }: { image: GameImage | null; platform: Platform | null; region: string | null; regionName: string | null; title: string }) {
  if (image) {
    return (
      <figure className="flex flex-col items-center" data-game-image={image.id}>
        <div className="relative flex aspect-[4/3.4] w-full items-center justify-center">
          <span aria-hidden="true" className="absolute inset-x-[12%] bottom-[4%] h-6 rounded-[50%] bg-black/70 blur-xl" />
          <Image
            src={`/${image.file}`}
            alt={image.alt}
            width={image.width}
            height={image.height}
            sizes="(min-width: 1280px) 26rem, (min-width: 768px) 20rem, 80vw"
            priority
            className="relative h-auto max-h-full w-auto max-w-full object-contain drop-shadow-[0_28px_36px_rgb(0_0_0/0.7)]"
          />
        </div>
        <figcaption className="mt-3 max-w-[22rem] text-center text-xs text-muted-foreground">
          {imageCaption(image, regionName)} {image.attribution ? `${image.attribution}. ` : ""}
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

  const frame = platform ? shelfFrame(platform.slug) : null;
  const shell = frame ? shellFor(frame, SHELL_REGION[region ?? ""] ?? "NTSC-U") : null;
  return (
    <figure className="flex flex-col items-center" data-game-image="none">
      <div className="relative flex aspect-[4/3] w-full items-center justify-center">
        {/* A soft spotlight and the item's shadow: a stage, not a shelf. */}
        <span aria-hidden="true" className="absolute inset-[6%] rounded-full bg-[radial-gradient(closest-side,rgb(196_181_253/0.16),transparent)]" />
        <span aria-hidden="true" className="absolute inset-x-[16%] bottom-[5%] h-5 rounded-[50%] bg-black/70 blur-xl" />
        {shell ? (
          <div className="relative w-[92%] max-w-[24rem] drop-shadow-[0_28px_36px_rgb(0_0_0/0.65)]" style={{ containerType: "inline-size" }}>
            <Image src={shell.image} alt="" sizes="(min-width: 1280px) 22rem, (min-width: 768px) 17rem, 70vw" priority className="block h-auto w-full opacity-90 grayscale-[30%]" />
            <div
              className="absolute flex flex-col items-center justify-center overflow-hidden bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.05)_0_6px,transparent_6px_12px),linear-gradient(160deg,#2a2536,#17141f)] text-center shadow-[inset_0_0_0_1px_rgb(0_0_0/0.5)]"
              style={{ left: `${shell.label.left}%`, top: `${shell.label.top}%`, width: `${shell.label.width}%`, height: `${shell.label.height}%`, borderRadius: shell.radius }}
            >
              <span className="px-[4cqi] text-[max(10px,4.2cqi)] leading-tight font-semibold text-white/80">Artwork not available</span>
            </div>
          </div>
        ) : (
          <div className="relative flex aspect-[3/4] w-[52%] max-w-[15rem] flex-col items-center justify-center rounded-lg border border-white/10 bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.04)_0_6px,transparent_6px_12px),linear-gradient(160deg,#2a2536,#17141f)] px-4 text-center shadow-[0_28px_36px_rgb(0_0_0/0.6)]">
            <span className="text-sm font-semibold text-white/80">Artwork not available</span>
          </div>
        )}
      </div>
      <figcaption className="mt-1 max-w-[20rem] text-center text-xs leading-relaxed text-muted-foreground">
        No approved artwork for {title} yet{platform && shell ? `. The shape is a ${platform.shortName} ${frame?.endsWith("case") ? "case" : "cartridge"}, not this game's label` : ""}.
      </figcaption>
    </figure>
  );
}

/**
 * The centre: the title, the chosen system, the collector's actions (`actions`, streamed
 * on their own), the facts the catalog has, and the game's other systems to switch to.
 */
export function GameIdentity({ game, overview, platform, publisher, actions }: { game: ReleasePicker["game"]; overview: Overview; platform: Platform | null; publisher: string | null; actions: ReactNode }) {
  const platforms = overview.platforms;
  const kind = platform ? consoleFor(platform.slug) : null;
  const facts = [
    game.firstRelease ? { icon: CalendarDays, label: game.firstRelease.precision === "year" ? "First released" : "First release date", value: formatCatalogDate(game.firstRelease) } : null,
    platforms.length ? { icon: Layers, label: platforms.length === 1 ? "System" : "Systems", value: String(platforms.length) } : null,
    { icon: Disc3, label: "Verified releases", value: overview.releaseCount ? releaseCountLabel(overview.releaseCount).replace(/ releases?$/, "") : "None yet" },
    publisher ? { icon: Building2, label: "Publisher", value: publisher } : null,
  ].filter((fact) => fact !== null);

  return (
    <div className="min-w-0">
      <h1 id="game-title" className="text-4xl leading-[1.05] font-bold tracking-tight text-balance text-white sm:text-5xl lg:text-[2.6rem] 2xl:text-5xl">
        {game.title}
      </h1>
      {platform ? (
        <p className="mt-3 flex items-center gap-2.5 text-base text-foreground/85 sm:text-lg">
          {kind ? <ConsoleArt kind={kind} sizes="48px" className="h-7 w-10 shrink-0" /> : null}
          <span>
            {platform.name} <span className="text-muted-foreground">({platform.shortName})</span>
          </span>
        </p>
      ) : null}
      {game.kind !== "game" ? <p className="mt-1 text-sm text-muted-foreground">{gameKindLabel(game.kind)}</p> : null}

      <div className="mt-6">{actions}</div>

      {facts.length ? (
        <dl className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-x-6 gap-y-4 border-y border-white/[0.08] py-4">
          {facts.map(({ icon: Icon, label, value }) => (
            // The label is read first; the value is shown above it, the icon beside both.
            <div key={label} className="relative flex flex-col-reverse justify-center pl-9 leading-tight">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-base font-semibold text-white">
                <Icon aria-hidden="true" className="absolute top-1/2 left-0 size-6 -translate-y-1/2 text-primary-text" />
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {platforms.length > 1 ? (
        <nav aria-label="Game platform" className="mt-5">
          <ul className="flex flex-wrap gap-2">
            {platforms.map((p) => {
              const active = p.slug === platform?.slug;
              return (
                <li key={p.slug}>
                  <Link
                    href={`/games/${game.slug}?platform=${encodeURIComponent(p.slug)}`}
                    scroll={false}
                    aria-current={active ? "true" : undefined}
                    title={p.name}
                    className={cn(
                      "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none",
                      active ? "border-primary/70 bg-primary/20 font-medium text-white" : "border-white/12 bg-white/[0.04] text-foreground/80 hover:border-white/25 hover:text-white",
                    )}
                  >
                    {p.shortName}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
