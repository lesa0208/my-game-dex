import { Info } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { ConsoleArt } from "@/components/shelf/console-art";
import { shellFor } from "@/components/shelf/media-shells";
import { gameKindLabel, releaseCountLabel } from "@/features/catalog/format";
import { coverSize, igdbImageUrl, type ProviderImage } from "@/features/catalog/provider-images";
import type { ReleasePicker } from "@/features/catalog/types";
import { type GameImage, imageCaption, LICENSE_LABELS } from "@/features/media/game-images";
import type { Region } from "@/features/shelf/browse";
import { consoleFor, type gameOverview, shelfFrame } from "@/features/shelf/copies";
import { cn } from "@/lib/utils";

type Overview = ReturnType<typeof gameOverview>;
type Platform = { slug: string; name: string; shortName: string };

const SHELL_REGION: Record<string, Region> = { "ntsc-uc": "NTSC-U", pal: "PAL", "ntsc-j": "NTSC-J" };

/**
 * Game Details 2.0: the hero's atmosphere. With the game's cover authorized for this platform
 * (the same gate as the cover itself), a heavily blurred, darkened wash of it, under gradients
 * that keep the text on the right legible. Without, the M17b violet and lamp-warm light and the
 * system's console blurred far behind.
 */
export function HeroBackdrop({ platform, artwork }: { platform: string | null; artwork: string | null }) {
  const kind = platform ? consoleFor(platform) : null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden" data-hero-backdrop={artwork ? "artwork" : "generic"}>
      {artwork ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- decorative, served by the authorized image route, never optimized */}
          <img src={artwork} alt="" className="absolute inset-[-12%] h-[124%] w-[124%] scale-110 object-cover opacity-45 blur-3xl saturate-[1.15]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgb(15_13_21/0.35)_0%,rgb(15_13_21/0.78)_38%,rgb(15_13_21/0.9)_70%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(60%_90%_at_85%_0%,rgb(139_92_246/0.22),transparent_70%)]" />
        </>
      ) : (
        <>
          <div className="absolute inset-0 bg-[radial-gradient(55%_75%_at_8%_0%,rgb(255_176_96/0.20),transparent_65%),radial-gradient(60%_90%_at_72%_10%,rgb(139_92_246/0.30),transparent_70%),radial-gradient(70%_80%_at_100%_100%,rgb(91_33_182/0.35),transparent_70%)]" />
          {kind ? <ConsoleArt kind={kind} sizes="900px" className="absolute top-[-10%] right-[-6%] h-[120%] w-[60%] opacity-[0.07] blur-2xl" /> : null}
        </>
      )}
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-linear-to-t from-[#0f0d15] to-transparent" />
    </div>
  );
}

/** The artwork's source, on one line; the full wording one tap away. */
function ArtworkCredit({ url }: { url: string | null }) {
  return (
    <figcaption className="mt-3 flex flex-col items-center gap-1 text-xs text-muted-foreground" data-artwork-caption="">
      <span className="flex items-center gap-1.5">
        Game artwork ·{" "}
        <a href={url ?? "https://www.igdb.com"} className="underline underline-offset-2 hover:text-foreground" rel="noopener noreferrer" target="_blank">
          IGDB.com
        </a>
      </span>
      <details className="group text-center [&_summary::-webkit-details-marker]:hidden">
        <summary className="mx-auto flex w-fit cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring">
          <Info aria-hidden="true" className="size-3.5" />
          About this artwork
        </summary>
        <p className="mt-1 max-w-[18rem] leading-relaxed">General game artwork, not verified for a specific platform, region or edition.</p>
      </details>
    </figcaption>
  );
}

/**
 * The artwork: the real item from an approved, release-specific image, with its source and
 * terms; else the game's IGDB cover, standalone and credited, at its own proportions and never
 * upscaled from a smaller original; else the system's neutral shell with a blank label: no title,
 * no generated art and no words on it. The words are under it, as ordinary text.
 */
export function GameArtwork({
  image,
  cover,
  platform,
  region,
  regionName,
  title,
  providerKnown,
}: {
  image: GameImage | null;
  cover: { image: ProviderImage; url: string | null } | null;
  platform: Platform | null;
  region: string | null;
  regionName: string | null;
  title: string;
  /** The game has IGDB artwork, but not for this platform. */
  providerKnown: boolean;
}) {
  if (!image && cover) {
    const width = cover.image.width ?? 264;
    const height = cover.image.height ?? 374;
    return (
      <figure className="flex flex-col items-center" data-game-image="igdb-cover">
        <div className="relative w-full">
          <span aria-hidden="true" className="absolute inset-x-[10%] -bottom-3 h-8 rounded-[50%] bg-black/70 blur-2xl" />
          <Image
            src={igdbImageUrl(cover.image, coverSize(cover.image))}
            unoptimized
            alt={`Cover art for ${title}`}
            width={width}
            height={height}
            priority
            className="relative block h-auto w-full rounded-xl shadow-[0_32px_60px_-18px_rgb(0_0_0/0.85)] ring-1 ring-white/10"
          />
        </div>
        <ArtworkCredit url={cover.url} />
      </figure>
    );
  }
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
  const noun = frame?.endsWith("case") ? "case" : "cartridge";
  return (
    <figure className="flex flex-col items-center" data-game-image="none">
      <div className="relative flex aspect-[4/3] w-full items-center justify-center">
        <span aria-hidden="true" className="absolute inset-[6%] rounded-full bg-[radial-gradient(closest-side,rgb(196_181_253/0.14),transparent)]" />
        <span aria-hidden="true" className="absolute inset-x-[16%] bottom-[5%] h-5 rounded-[50%] bg-black/70 blur-xl" />
        {shell ? (
          <div className="relative w-[92%] max-w-[22rem] drop-shadow-[0_28px_36px_rgb(0_0_0/0.65)]" data-neutral-shell="">
            <Image src={shell.image} alt="" sizes="(min-width: 1280px) 22rem, (min-width: 768px) 17rem, 70vw" priority className="block h-auto w-full opacity-90 grayscale-[30%]" />
            {/* The label recess, blank: no title, no generated art, no words. */}
            <div
              aria-hidden="true"
              className="absolute bg-[linear-gradient(160deg,#2a2536,#1a1722)] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.5)]"
              style={{ left: `${shell.label.left}%`, top: `${shell.label.top}%`, width: `${shell.label.width}%`, height: `${shell.label.height}%`, borderRadius: shell.radius }}
            />
          </div>
        ) : (
          <div aria-hidden="true" className="relative aspect-[3/4] w-[52%] max-w-[14rem] rounded-lg border border-white/10 bg-[linear-gradient(160deg,#2a2536,#17141f)] shadow-[0_28px_36px_rgb(0_0_0/0.6)]" data-neutral-shell="" />
        )}
      </div>
      <figcaption className="mt-1 max-w-[20rem] text-center text-xs leading-relaxed text-muted-foreground" data-artwork-caption="">
        <span className="sr-only">{title}: </span>
        {providerKnown && platform ? `No authorized artwork for ${platform.shortName} yet.` : "No artwork for this game yet."}
        {shell && platform ? <span className="block">Shown: a neutral {platform.shortName} {noun}, without a label.</span> : null}
      </figcaption>
    </figure>
  );
}

/** The game's systems as a segmented switcher (links that change the page's platform), or the one system. */
function PlatformSwitcher({ slug, platforms, current }: { slug: string; platforms: Platform[]; current: Platform | null }) {
  if (platforms.length <= 1) {
    const kind = current ? consoleFor(current.slug) : null;
    return current ? (
      <p className="flex items-center gap-2 text-sm text-foreground/80" data-platform-label="">
        {kind ? <ConsoleArt kind={kind} sizes="40px" className="h-5 w-7 shrink-0" /> : null}
        {current.name}
      </p>
    ) : null;
  }
  return (
    <nav aria-label="Game platform">
      <ul className="flex w-fit max-w-full flex-wrap gap-1 rounded-full border border-white/10 bg-white/[0.05] p-1">
        {platforms.map((p) => {
          const active = p.slug === current?.slug;
          return (
            <li key={p.slug}>
              <Link
                href={`/games/${slug}?platform=${encodeURIComponent(p.slug)}`}
                scroll={false}
                aria-current={active ? "true" : undefined}
                title={p.name}
                className={cn(
                  "inline-flex h-8 items-center rounded-full px-3.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none",
                  active ? "bg-primary/30 font-medium text-white shadow-[inset_0_0_0_1px_rgb(167_139_250/0.6)]" : "text-foreground/75 hover:bg-white/[0.06] hover:text-white",
                )}
              >
                <span aria-hidden="true">{p.shortName}</span>
                <span className="sr-only">{p.name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export type HeroDescription = { text: string; source: "catalog" | "igdb"; url: string | null };

/**
 * The game's identity: platform, title, a meta line (the catalog's first-release year, IGDB's
 * developers and first genre, each marked as IGDB's) and the actions (streamed on their own).
 * On a phone this comes first, then the artwork, then Your copies, then GameHeroInfo.
 */
export function GameIdentity({
  game,
  overview,
  platform,
  developers,
  genre,
  actions,
}: {
  game: ReleasePicker["game"];
  overview: Overview;
  platform: Platform | null;
  developers: string[];
  genre: string | null;
  actions: ReactNode;
}) {
  const year = game.firstRelease?.value.slice(0, 4) ?? null;
  const meta = [
    year ? { key: "year", text: year, igdb: false } : null,
    game.kind !== "game" ? { key: "kind", text: gameKindLabel(game.kind) ?? game.kind, igdb: false } : null,
    developers.length ? { key: "developer", text: developers.slice(0, 2).join(", "), igdb: true } : null,
    genre ? { key: "genre", text: genre, igdb: true } : null,
  ].filter((m) => m !== null);

  return (
    <div className="flex min-w-0 flex-col gap-4 sm:gap-5">
      <PlatformSwitcher slug={game.slug} platforms={overview.platforms} current={platform} />
      <div className="flex flex-col gap-2.5">
        <h1 id="game-title" className="font-heading text-[2.15rem] leading-[1.02] font-bold tracking-[-0.025em] text-balance text-white sm:text-5xl xl:text-[3.4rem]">
          {game.title}
        </h1>
        {meta.length ? (
          // No separators to strand at a line's start: items are spaced; IGDB's carry its dot, and
          // the key to the dot stays on the last item's line.
          <p className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[15px] text-foreground/85" data-hero-meta="">
            {meta.map((m, i) => (
              <span key={m.key} className="inline-flex items-center gap-1.5">
                {m.igdb ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary-text" /> : null}
                {m.text}
                {m.igdb ? <span className="sr-only"> (from IGDB)</span> : null}
                {i === meta.length - 1 && meta.some((x) => x.igdb) ? (
                  <span aria-hidden="true" className="ml-2 inline-flex items-center gap-1 rounded-full border border-white/10 px-1.5 py-px text-[11px] text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-primary-text" />
                    IGDB
                  </span>
                ) : null}
              </span>
            ))}
          </p>
        ) : null}
      </div>
      <div>{actions}</div>
    </div>
  );
}

/**
 * The hero's remaining information, after the identity (and, on a phone, after the artwork and
 * Your copies): a short description preview where a real description exists, with its source,
 * and the facts a collector looks for first. The full first-release date and the rest are in
 * Overview, said once. Only what the catalog or IGDB records.
 */
export function GameHeroInfo({ overview, publisher, description }: { overview: Overview; publisher: string | null; description: HeroDescription | null }) {
  const facts = [
    publisher ? { label: "Publisher", value: publisher } : null,
    // Only a real count: a game with none says so in Physical Releases, not as a lone "None yet".
    overview.releaseCount ? { label: "Verified releases", value: releaseCountLabel(overview.releaseCount).replace(/ releases?$/, "") } : null,
  ].filter((f) => f !== null);
  return (
    <div className="flex min-w-0 flex-col gap-4 sm:gap-5">
      {description ? (
        <div className="max-w-[60ch]" data-hero-description={description.source}>
          <p className="line-clamp-3 text-[15px] leading-relaxed text-pretty text-foreground/80">{description.text}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {description.source === "igdb" ? (
              <>
                Description from{" "}
                <a href={description.url ?? "https://www.igdb.com"} className="underline underline-offset-2 hover:text-foreground" rel="noopener noreferrer" target="_blank">
                  IGDB.com
                </a>
                {" · "}
              </>
            ) : null}
            <a href="#overview" className="font-medium text-primary-text underline-offset-4 hover:underline">
              Read more
            </a>
          </p>
        </div>
      ) : null}
      {facts.length ? (
        <dl className="flex flex-wrap gap-x-7 gap-y-3 border-t border-white/[0.08] pt-4" data-hero-facts="">
          {facts.map(({ label, value }) => (
            <div key={label} className="flex flex-col-reverse leading-tight">
              <dt className="mt-1 text-xs text-muted-foreground">{label}</dt>
              <dd className="font-heading text-[15px] font-semibold text-white">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
