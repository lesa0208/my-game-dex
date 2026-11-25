import { Library } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { CatalogCover } from "@/components/games/catalog-cover";
import { Skeleton } from "@/components/ui/skeleton";
import { firstReleaseYear, gameKindLabel, NO_VERIFIED_RELEASE, platformReleaseLabel, regionLabel } from "@/features/catalog/format";
import type { GameResult, ReleaseResult, SearchResult } from "@/features/catalog/types";

/** M12b: the signed-in user's copies per game for this page of results, read once for the page. */
export type OwnedGames = Promise<Map<string, number> | null>;

/**
 * "Owned: 2 copies" on a result, from the one read for the whole page (never one per
 * result). Streams in after the results; nothing when signed out or not owned.
 */
async function OwnedBadge({ owned, gameId }: { owned: OwnedGames; gameId: string }) {
  const copies = (await owned.catch(() => null))?.get(gameId) ?? 0;
  if (!copies) return null;
  return (
    <p className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary-text">
      <Library aria-hidden="true" className="size-3.5" />
      {copies === 1 ? "Owned: Yes" : `Owned: ${copies.toLocaleString("en")} copies`}
    </p>
  );
}

function Owned({ owned, gameId }: { owned?: OwnedGames; gameId: string }) {
  if (!owned) return null;
  return (
    <Suspense fallback={null}>
      <OwnedBadge owned={owned} gameId={gameId} />
    </Suspense>
  );
}

const cardClassName =
  "flex gap-3 rounded-lg border bg-card p-3 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring";

function GameMeta({ game }: { game: GameResult["game"] }) {
  const parts = [firstReleaseYear(game), gameKindLabel(game.kind)].filter(Boolean);
  return parts.length ? <p className="text-xs text-muted-foreground">{parts.join(" · ")}</p> : null;
}

/**
 * A game's page, with the platform the search was filtered by already chosen there when
 * the game is on it: a collector adding their SNES games goes straight to the SNES steps.
 */
function gameResultHref(item: GameResult, platform: string | null) {
  const on = platform && item.platforms.some((p) => p.slug === platform);
  return on ? `/games/${item.game.slug}?platform=${encodeURIComponent(platform)}` : `/games/${item.game.slug}`;
}

function GameResultCard({ item, owned, platform }: { item: GameResult; owned?: OwnedGames; platform: string | null }) {
  return (
    <Link href={gameResultHref(item, platform)} className={cardClassName}>
      <CatalogCover className="w-12" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-pretty">{item.game.title}</p>
        <GameMeta game={item.game} />
        {item.matched ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {item.matched.source === "alias" ? "Also known as" : "Released as"} <span className="text-foreground">{item.matched.title}</span>
          </p>
        ) : null}
        {/* M14a: a game confirmed to exist physically, with no verified release catalogued yet. */}
        {item.platforms.length > 0 && item.platforms.every((platform) => platform.releaseCount === 0) ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{NO_VERIFIED_RELEASE}.</p>
        ) : null}
        <ul aria-label="Platforms" className="mt-2 flex flex-wrap gap-1.5">
          {item.platforms.map((platform) => (
            <li key={platform.slug} className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
              <span title={platform.name}>{platform.shortName}</span>
              <span className="text-muted-foreground"> · {platformReleaseLabel(platform.releaseCount)}</span>
            </li>
          ))}
        </ul>
        <Owned owned={owned} gameId={item.game.id} />
      </div>
    </Link>
  );
}

function ReleaseResultCard({ item, owned }: { item: ReleaseResult; owned?: OwnedGames }) {
  const { release } = item;
  const identifier = item.matchedIdentifier === "barcode" ? `Barcode ${release.identifiers.barcode}` : `Product code ${release.identifiers.productCode}`;
  return (
    <Link href={`/games/${item.game.slug}?release=${release.id}`} className={cardClassName}>
      <CatalogCover className="w-12" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-pretty">{item.game.title}</p>
        <GameMeta game={item.game} />
        <p className="mt-0.5 text-xs text-muted-foreground">
          {identifier} is this release:
        </p>
        <p className="mt-1 text-sm">
          {[release.platform.shortName, regionLabel(release.region), release.editionName, release.variantName].filter(Boolean).join(" · ")}
        </p>
        <Owned owned={owned} gameId={item.game.id} />
      </div>
    </Link>
  );
}

/** `platform`: the platform the search was filtered by, which each game's link keeps. */
export function SearchResultList({ items, owned, platform = null }: { items: SearchResult[]; owned?: OwnedGames; platform?: string | null }) {
  return (
    <ol className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.kind === "release" ? `release-${item.release.id}` : `game-${item.game.id}`}>
          {item.kind === "release" ? <ReleaseResultCard item={item} owned={owned} /> : <GameResultCard item={item} owned={owned} platform={platform} />}
        </li>
      ))}
    </ol>
  );
}

export function SearchResultsSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex gap-3 rounded-lg border p-3">
          <Skeleton className="aspect-3/4 w-12" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
