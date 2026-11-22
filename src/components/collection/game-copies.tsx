import { Library, Plus, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { GameMedia } from "@/components/shelf/game-media";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentViewer } from "@/features/account/queries";
import { copyStatusLabel, ownershipEntryLine, ownershipHeadline, ownershipStatusLabel } from "@/features/collection/details";
import { collectionHref, DEFAULT_PARAMS } from "@/features/collection/list-params";
import { getMyGameOwnership } from "@/features/collection/queries";
import { getMyCopiesOfGame } from "@/features/shelf/collection";

const NOT_RECORDED = "Not recorded";

/**
 * What the signed-in collector has of this game, on its page: the headline count
 * (M12b's "Owned", which counts every copy that isn't preserved, whatever its catalog
 * standing), then each copy on its own, linking to its page. Copies of the same release
 * stay separate ("Copy 2 of 3"), and each says its standing when it needs saying. Only
 * the viewer's own copies, read with their session; nothing at all for a visitor. No
 * acquisition, price or storage details: those stay on the copy's own page.
 */
export async function GameCopies({ gameId, title }: { gameId: string; title: string }) {
  const viewer = await getCurrentViewer().catch(() => null);
  if (!viewer?.handle) return null;
  const [ownership, copies] = await Promise.all([getMyGameOwnership(gameId), getMyCopiesOfGame(gameId, title)]);
  if (!ownership) return null;

  if (ownership.entries.length === 0) {
    return (
      <section aria-labelledby="game-copies" className="rounded-2xl border border-white/10 bg-card p-5 sm:p-6">
        <h2 id="game-copies" className="flex items-center gap-2 font-semibold">
          <Library aria-hidden="true" className="size-4 text-muted-foreground" />
          Your copies
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">Not in your collection yet.</p>
        <Link href="#choose-release" className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary-text underline-offset-4 hover:underline">
          <Plus aria-hidden="true" className="size-4" />
          Add your copy
        </Link>
      </section>
    );
  }

  // Copies kept privately after their game left the catalog aren't matched to the game; say so.
  const preserved = ownership.entries.filter((e) => e.status === "invalid").reduce((sum, e) => sum + e.count, 0);
  const listedPreserved = copies?.items.filter((i) => i.note === copyStatusLabel("invalid")).length ?? 0;
  const shelves = new Map(ownership.entries.map((e) => [e.platform.slug, e.platform.short_name]));

  return (
    <section aria-labelledby="game-copies" className="rounded-2xl border border-white/10 bg-card p-5 sm:p-6">
      <h2 id="game-copies" className="flex items-center gap-2 font-semibold">
        <Library aria-hidden="true" className="size-4 text-muted-foreground" />
        {ownershipHeadline(ownership.copies)}
      </h2>
      {/* M12b's summary: by platform, region and edition, each with its standing. */}
      <ul aria-label="What you own, by release" className="mt-2 flex flex-col gap-1 text-sm">
        {ownership.entries.map((entry, index) => (
          <li key={index} className="flex flex-wrap items-baseline gap-x-2">
            <span>
              {ownershipEntryLine(entry)} <span className="text-muted-foreground">×{entry.count}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              {ownershipStatusLabel(entry.status)}
              {entry.release_id === null && !entry.catalog_pairing ? " · platform not in the catalog for this game" : ""}
            </span>
          </li>
        ))}
      </ul>
      {copies ? (
        <h3 className="mt-4 text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Each copy</h3>
      ) : null}
      {copies ? (
        <ul aria-label="Your copies of this game" className="mt-2 flex flex-col gap-2">
          {copies.items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5 outline-none transition-colors hover:border-primary/50 hover:bg-white/[0.04] focus-visible:ring-3 focus-visible:ring-ring"
              >
                <div className="w-12 shrink-0">
                  <GameMedia media={item.media} seed={item.labelSeed} title={item.title} systemLabel={item.details.split(" · ")[0] ?? ""} sizes="48px" />
                </div>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium text-pretty">{item.details || item.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.completeness?.label ?? `Completeness: ${NOT_RECORDED.toLowerCase()}`} · {item.condition?.label ?? `Condition: ${NOT_RECORDED.toLowerCase()}`}
                  </p>
                  {item.note ? <p className="mt-1 inline-flex rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs">{item.note}</p> : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">Your copies can&apos;t be listed right now. They&apos;re all in your collection.</p>
      )}
      {copies?.truncated ? <p className="mt-2 text-xs text-muted-foreground">Showing the first {copies.items.length} copies.</p> : null}
      {preserved > listedPreserved ? (
        <p className="mt-3 flex gap-2 text-xs text-muted-foreground">
          <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {preserved - listedPreserved === 1 ? "1 more copy is" : `${preserved - listedPreserved} more copies are`} kept privately after leaving the catalog.
        </p>
      ) : null}
      <div className="mt-4 flex flex-col gap-1.5 text-sm">
        <Link href={collectionHref({ ...DEFAULT_PARAMS, query: title.slice(0, 100) })} className="text-primary-text underline underline-offset-4">
          See them in your collection
        </Link>
        {[...shelves].map(([slug, name]) => (
          <Link key={slug} href={`/collection/systems/${slug}`} className="text-primary-text underline underline-offset-4">
            Your {name} shelf
          </Link>
        ))}
      </div>
    </section>
  );
}

export function GameCopiesSkeleton() {
  return <Skeleton aria-hidden="true" className="h-40 w-full rounded-2xl" />;
}
