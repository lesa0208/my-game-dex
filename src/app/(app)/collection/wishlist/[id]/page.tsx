import { ArrowLeft, ChevronRight, Heart, PlugZap, UserRoundX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { releaseChoices, wishRegions } from "@/components/wishlist/game-wishlist";
import type { PlatformChoice, ReleaseChoice } from "@/components/wishlist/wish-fields";
import { EditWishForm, RemoveWishForm } from "@/components/wishlist/wish-forms";
import { WishFacts, WishMedia } from "@/components/wishlist/wish-parts";
import { requireViewerWithHandle } from "@/features/account/queries";
import { getReleasePicker } from "@/features/catalog/queries";
import { formatDay } from "@/features/collection/details";
import { getSubmissionOptions } from "@/features/submissions/queries";
import { levelOf, targetLine } from "@/features/wishlist/format";
import { readWishlistParams, wishHref, wishlistHref } from "@/features/wishlist/params";
import { getGameWishPlatforms, getMyWishlistItem } from "@/features/wishlist/queries";

export const metadata: Metadata = {
  title: "Wish",
};

async function WishView({ params, searchParams }: PageProps<"/collection/wishlist/[id]">) {
  const { id } = await params;
  const back = readWishlistParams(await searchParams);
  const viewer = await requireViewerWithHandle(wishHref(id, back));

  const outcome = await getMyWishlistItem(id);
  if (!outcome.ok) {
    return (
      <EmptyState icon={PlugZap} title="Your wishlist isn't available">
        It can&apos;t be loaded right now. Try again later.
      </EmptyState>
    );
  }
  const item = outcome.data;
  if (!item) notFound();

  // What the wish can be changed to: the game's published platforms and releases, and
  // the catalog's regions. Only while the game is published; otherwise only the details.
  const gamePublished = item.game.slug !== null;
  const [picker, gamePlatforms, regions, options] = await Promise.all([
    gamePublished ? getReleasePicker(item.game.slug!, null, null, null) : null,
    gamePublished ? getGameWishPlatforms(item.game.id) : null,
    wishRegions(),
    getSubmissionOptions(),
  ]);
  const releases: ReleaseChoice[] = picker?.ok && picker.data ? releaseChoices(picker.data.releases) : [];
  const platforms: PlatformChoice[] = (gamePlatforms ?? []).map((p) => ({ id: p.id, name: p.name }));
  const level = levelOf(item);
  const platformId = item.platform ? (options?.platforms.find((p) => p.slug === item.platform!.slug)?.id ?? null) : null;

  // The wish as it was made stays a choice even when the catalog no longer offers it, so
  // saving other changes never replaces it.
  if (item.kind === "game" && platformId && !platforms.some((p) => p.id === platformId)) {
    platforms.unshift({ id: platformId, name: item.platform!.name, note: "no longer listed for this game" });
  }
  if (item.kind === "release" && item.release && !releases.some((r) => r.id === item.release!.id)) {
    releases.unshift({ id: item.release.id, group: "Your wish", label: targetLine(item), note: "no longer in the catalog" });
  }
  const regionChoices = item.region && !regions.some((r) => r.code === item.region!.code) ? [{ code: item.region.code, label: item.region.label ?? item.region.code }, ...regions] : regions;

  return (
    <>
      <p className="mb-4">
        <Link href={wishlistHref(back)} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline">
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to your wishlist
        </Link>
      </p>
      <article aria-labelledby="wish-title" className="flex gap-4 rounded-xl border border-white/10 bg-card p-4">
        <WishMedia item={item} className="w-20 sm:w-24" sizes="96px" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Your wish</p>
          <h1 id="wish-title" className="mt-1 text-xl font-semibold tracking-tight text-pretty">
            {item.game.title}
          </h1>
          <WishFacts item={item} />
          <p className="mt-2 text-xs text-muted-foreground">
            Added {formatDay(item.added_at)}
            {item.updated_at !== item.added_at ? ` · Changed ${formatDay(item.updated_at)}` : ""}
          </p>
          {item.game.slug ? (
            <Link href={`/games/${item.game.slug}`} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary-text underline-offset-4 hover:underline">
              Game details and releases
              <ChevronRight aria-hidden="true" className="size-3.5" />
            </Link>
          ) : null}
        </div>
      </article>

      <section aria-labelledby="edit-wish-title" className="mt-4 rounded-xl border border-white/10 bg-card p-4">
        <h2 id="edit-wish-title" className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Heart aria-hidden="true" className="size-4 text-muted-foreground" />
          Change this wish
        </h2>
        {!viewer.isActive ? (
          <p className="flex gap-2 text-sm text-muted-foreground">
            <UserRoundX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            Your account can&apos;t change its wishlist right now. You can still remove this wish.
          </p>
        ) : (
          <>
            {!gamePublished ? (
              <p className="mb-3 text-sm text-muted-foreground">This game is no longer in the catalog, so what you want can&apos;t be changed. You can still change its priority, completeness and note.</p>
            ) : null}
            <EditWishForm
              key={item.updated_at}
              wishId={item.id}
              gameId={item.game.id}
              platforms={platforms}
              regions={regionChoices}
              releases={releases}
              canChangeTarget={gamePublished}
              initial={{
                level,
                platformId,
                regionCode: item.kind === "game" ? (item.region?.code ?? null) : null,
                releaseId: item.release?.id ?? null,
                priority: item.priority,
                completeness: item.completeness,
                note: item.note,
              }}
            />
          </>
        )}
      </section>

      <div className="mt-4">
        <RemoveWishForm wishId={item.id} name={item.game.title} back={back} />
      </div>
    </>
  );
}

export default function WishPage(props: PageProps<"/collection/wishlist/[id]">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <Suspense
          fallback={
            <div aria-hidden="true" className="flex flex-col gap-4">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-40 w-full rounded-xl" />
              <Skeleton className="h-80 w-full rounded-xl" />
            </div>
          }
        >
          <WishView {...props} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
