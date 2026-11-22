import { ChevronRight, Pencil } from "lucide-react";
import Link from "next/link";

import { Skeleton } from "@/components/ui/skeleton";
import { formatDay } from "@/features/collection/details";
import { type WishlistParams, wishHref } from "@/features/wishlist/params";
import type { WishlistItem } from "@/features/wishlist/types";

import { RemoveWishForm } from "./wish-forms";
import { WishFacts, WishMedia } from "./wish-parts";

/**
 * One wish on the wishlist: what it wants, how much, the lowest completeness it accepts,
 * the collector's note and what they already own that matches, with Edit, Remove and
 * the game's page. An article rather than one link, since it holds a form.
 */
function WishEntry({ item, params }: { item: WishlistItem; params: WishlistParams }) {
  const headingId = `wish-${item.id}`;
  return (
    <article aria-labelledby={headingId} className="flex gap-3 rounded-xl border border-white/10 bg-card p-3 sm:gap-4 sm:p-4">
      <WishMedia item={item} className="w-14 sm:w-16" />
      <div className="min-w-0 flex-1">
        <h3 id={headingId} className="font-medium text-pretty">
          {item.game.title}
        </h3>
        <WishFacts item={item} />
        <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-1">
          <Link
            href={wishHref(item.id, params)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary-text outline-none hover:bg-primary/10 focus-visible:ring-3 focus-visible:ring-ring"
          >
            <Pencil aria-hidden="true" className="size-4" />
            Edit<span className="sr-only"> your wish for {item.game.title}</span>
          </Link>
          {item.game.slug ? (
            <Link
              href={`/games/${item.game.slug}`}
              className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground outline-none hover:bg-white/[0.04] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
            >
              Game details<span className="sr-only">: {item.game.title}</span>
              <ChevronRight aria-hidden="true" className="size-3.5" />
            </Link>
          ) : null}
          <RemoveWishForm wishId={item.id} name={item.game.title} back={params} compact />
          <span className="ml-auto text-xs text-muted-foreground">Added {formatDay(item.added_at)}</span>
        </div>
      </div>
    </article>
  );
}

export function WishlistList({ items, params }: { items: WishlistItem[]; params: WishlistParams }) {
  return (
    <ol className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.id}>
          <WishEntry item={item} params={params} />
        </li>
      ))}
    </ol>
  );
}

export function WishlistListSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex gap-3 rounded-xl border p-3">
          <Skeleton className="aspect-3/4 w-14" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
