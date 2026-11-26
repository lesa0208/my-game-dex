import { Gamepad2, Library } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { ConsoleArt } from "@/components/shelf/console-art";
import { firstReleaseYear, gameKindLabel, regionLabel } from "@/features/catalog/format";
import { igdbImageUrl, type ProviderImage } from "@/features/catalog/provider-images";
import type { CatalogPlatformCount, SearchResult } from "@/features/catalog/types";
import type { ConsoleKind } from "@/features/shelf/browse";
import { consoleFor } from "@/features/shelf/copies";
import { cn } from "@/lib/utils";

import { type ExploreViewer, ResultActions } from "./result-actions";

/** At most this many platform chips; the rest are counted. */
const CHIPS = 4;

export type CardContext = {
  viewer: ExploreViewer;
  /** The collector's copies per game; empty when signed out or not owned. */
  owned: Map<string, number>;
  /** One of the collector's wishlist entries per wanted game. */
  wished: Map<string, string>;
  /** The platform Explore is filtered to, when any. */
  platform: string | null;
  returnPath: string;
  /** A return from signing in: the game and what to open. */
  intent: { slug: string; action: "add" | "wish" } | null;
  /** M18a: each game's cover from IGDB, where its media are cleared. */
  covers: Map<string, ProviderImage>;
};

function hrefFor(item: SearchResult, platform: string | null) {
  if (item.kind === "release") return `/games/${item.game.slug}?release=${item.release.id}`;
  const on = platform && item.platforms.some((p) => p.slug === platform);
  return on ? `/games/${item.game.slug}?platform=${encodeURIComponent(platform)}` : `/games/${item.game.slug}`;
}

/** The console shown on the card: Explore's platform when it has one, else the first with art. */
function stageConsoles(platforms: { slug: string }[], platform: string | null): ConsoleKind[] {
  const preferred = platform ? consoleFor(platform) : null;
  if (preferred && platforms.some((p) => p.slug === platform)) return [preferred];
  // Up to three of its systems, so a game on several looks like one, not like a Game Boy game.
  return platforms
    .map((p) => consoleFor(p.slug))
    .filter((kind): kind is ConsoleKind => kind !== null)
    .slice(0, 3);
}

/** Where each console stands on the stage: one centred, or two or three side by side. */
const STAGE_LAYOUT: Record<number, string[]> = {
  1: ["inset-x-[18%] top-[14%] bottom-[10%]"],
  2: ["left-[8%] right-[50%] top-[22%] bottom-[12%]", "left-[50%] right-[8%] top-[22%] bottom-[12%]"],
  3: ["left-[4%] right-[64%] top-[30%] bottom-[14%]", "left-[30%] right-[30%] top-[16%] bottom-[10%] z-10", "left-[64%] right-[4%] top-[30%] bottom-[14%]"],
};

/**
 * M17a: one game in Explore's results. A stage with the console of its system (the
 * approved console art: it shows the system, never claims to be the game's own cover;
 * game artwork joins it when a properly sourced image exists, M17b), the title and year,
 * its platforms, whether the collector owns it, and the two actions. The stage and the
 * title link to the game; the actions are separate controls beside them.
 *
 * Verified releases are mentioned only when there are some: a game with none is simply
 * a game, without a repeated notice on every card and chip.
 */
export function GameCard({ item, context }: { item: SearchResult; context: CardContext }) {
  const href = hrefFor(item, context.platform);
  const platforms: CatalogPlatformCount[] =
    item.kind === "release" ? [{ ...item.release.platform, releaseCount: 1 }] : item.platforms;
  const owned = context.owned.get(item.game.id) ?? 0;
  const consoles = stageConsoles(platforms, context.platform);
  const year = firstReleaseYear(item.game);
  const kind = gameKindLabel(item.game.kind);
  const verified = item.kind === "game" ? item.platforms.reduce((sum, p) => sum + p.releaseCount, 0) : 0;
  const presetPlatform = item.kind === "release" ? item.release.platform.slug : context.platform && platforms.some((p) => p.slug === context.platform) ? context.platform : null;
  const intent = context.intent?.slug === item.game.slug ? context.intent.action : null;
  const cover = context.covers.get(item.game.id) ?? null;

  return (
    <article className="group/card flex w-full flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#141319] transition-colors hover:border-primary/40 motion-reduce:transition-none" data-game-card={item.game.title}>
      <Link href={href} tabIndex={-1} aria-hidden="true" className="relative block aspect-[16/9] overflow-hidden shelf-wall max-[479px]:aspect-[2/1]">
        <span aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(70%_80%_at_50%_100%,rgb(139_92_246/0.28),transparent_70%)]" />
        <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-amber-100/40 shadow-[0_0_10px_2px_rgb(255_190_120/0.2)]" />
        {cover ? (
          // M18a: the game's cover art from IGDB: game artwork, not a photo of any release.
          <span className="absolute inset-y-[7%] left-1/2 aspect-[264/374] -translate-x-1/2 overflow-hidden rounded-md shadow-[0_14px_22px_rgb(0_0_0/0.7)] ring-1 ring-white/10 transition-transform duration-300 group-hover/card:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover/card:translate-y-0" data-cover="igdb">
            <Image src={igdbImageUrl(cover, "cover_big")} alt="" fill sizes="(min-width: 1280px) 150px, (min-width: 480px) 22vw, 40vw" className="object-cover" />
          </span>
        ) : consoles.length ? (
          consoles.map((kind, i) => (
            <ConsoleArt
              key={kind}
              kind={kind}
              sizes={consoles.length === 1 ? "(min-width: 1280px) 220px, (min-width: 640px) 30vw, 60vw" : "(min-width: 1280px) 120px, 30vw"}
              className={cn(
                "absolute drop-shadow-[0_14px_18px_rgb(0_0_0/0.7)] transition-transform duration-300 group-hover/card:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover/card:translate-y-0",
                STAGE_LAYOUT[consoles.length][i],
              )}
            />
          ))
        ) : (
          <Gamepad2 aria-hidden="true" className="absolute top-1/2 left-1/2 size-12 -translate-x-1/2 -translate-y-1/2 text-white/20" />
        )}
        {owned ? (
          <span className="absolute top-2.5 left-2.5 inline-flex items-center gap-1 rounded-full bg-black/70 px-2.5 py-1 text-xs font-medium text-primary-text backdrop-blur-sm">
            <Library aria-hidden="true" className="size-3.5" />
            In your collection
          </span>
        ) : null}
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div>
          <h3 className="text-base leading-snug font-semibold text-pretty">
            <Link href={href} className="rounded-sm outline-none hover:text-primary-text focus-visible:ring-3 focus-visible:ring-ring">
              {item.game.title}
            </Link>
          </h3>
          {year || kind ? <p className="mt-0.5 text-sm text-muted-foreground">{[year, kind].filter(Boolean).join(" · ")}</p> : null}
          {item.kind === "game" && item.matched ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {item.matched.source === "alias" ? "Also known as" : "Released as"} <span className="text-foreground">{item.matched.title}</span>
            </p>
          ) : null}
          {item.kind === "release" ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {item.matchedIdentifier === "barcode" ? `Barcode ${item.release.identifiers.barcode}` : `Product code ${item.release.identifiers.productCode}`}:{" "}
              <span className="text-foreground">{[item.release.platform.shortName, regionLabel(item.release.region), item.release.editionName].filter(Boolean).join(" · ")}</span>
            </p>
          ) : null}
        </div>

        <ul aria-label="Platforms" className="flex flex-wrap gap-1.5">
          {platforms.slice(0, CHIPS).map((p) => (
            <li key={p.slug} title={p.name} className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-xs font-medium text-secondary-foreground">
              <span aria-hidden="true">{p.shortName}</span>
              <span className="sr-only">{p.name}</span>
            </li>
          ))}
          {platforms.length > CHIPS ? (
            <li className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground" title={platforms.slice(CHIPS).map((p) => p.name).join(", ")}>
              +{platforms.length - CHIPS} more
            </li>
          ) : null}
        </ul>

        {owned || verified ? (
          <p className="text-xs text-muted-foreground">
            {/* The game page's own words for ownership (M12b). */}
            {[owned ? (owned === 1 ? "Owned: Yes" : `Owned: ${owned.toLocaleString("en")} copies`) : null, verified ? `${verified} verified ${verified === 1 ? "release" : "releases"} to choose from` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}

        <div className="mt-auto pt-1">
          <ResultActions
            game={{ id: item.game.id, slug: item.game.slug, title: item.game.title }}
            viewer={context.viewer}
            presetPlatform={presetPlatform}
            owned={owned}
            wishId={context.wished.get(item.game.id) ?? null}
            returnPath={context.returnPath}
            autoOpen={intent}
          />
        </div>
      </div>
    </article>
  );
}

export function GameGrid({ items, context, label }: { items: SearchResult[]; context: CardContext; label: string }) {
  const credited = items.some((item) => context.covers.has(item.game.id));
  return (
    <>
    <ul aria-label={label} className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" data-game-grid="">
      {items.map((item) => (
        <li key={item.kind === "release" ? `release-${item.release.id}` : `game-${item.game.id}`} className="flex">
          <div className="flex w-full">
            <GameCard item={item} context={context} />
          </div>
        </li>
      ))}
    </ul>
    {/* M18a: IGDB's covers are credited wherever they're shown. */}
    {credited ? (
      <p className="mt-3 text-xs text-muted-foreground" data-igdb-credit="">
        Cover art:{" "}
        <a href="https://www.igdb.com" className="underline underline-offset-2 hover:text-foreground" rel="noopener noreferrer" target="_blank">
          IGDB.com
        </a>
        . General game artwork, not a specific platform, region or release.
      </p>
    ) : null}
    </>
  );
}
