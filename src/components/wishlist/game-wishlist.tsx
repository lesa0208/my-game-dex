import { Heart, LogIn, UserRoundX } from "lucide-react";
import Link from "next/link";

import { editionText } from "@/components/catalog/release-picker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentViewer } from "@/features/account/queries";
import { signInHref, welcomeHref } from "@/features/auth/redirect";
import { regionLabel } from "@/features/catalog/format";
import type { PickerRelease } from "@/features/catalog/types";
import { uuidv7 } from "@/features/collection/uuid";
import { getSubmissionOptions } from "@/features/submissions/queries";
import { targetLine, WISHLIST_PATH } from "@/features/wishlist/format";
import { wishHref } from "@/features/wishlist/params";
import { getGameWishPlatforms, getMyWishlistForGame } from "@/features/wishlist/queries";

import { Disclosure } from "./disclosure";
import type { ReleaseChoice } from "./wish-fields";
import { AddWishForm, WantReleaseForm } from "./wish-forms";
import { LevelChip, PriorityChip } from "./wish-parts";

/** A release as a choice in a form: "PAL · Collector's Edition · Red · SNS-XXXX-EUR". */
export function releaseChoices(releases: PickerRelease[]): ReleaseChoice[] {
  return releases.map((r) => ({
    id: r.id,
    group: r.platform.name,
    label: [regionLabel(r.region), editionText(r.edition), r.variantName, r.identifiers.productCode].filter(Boolean).join(" · "),
  }));
}

/** The catalog's regions a wish can name: all of them but "unknown". */
export async function wishRegions() {
  return ((await getSubmissionOptions())?.regions ?? []).filter((r) => r.code !== "unknown");
}

/**
 * The collector's wishes for this game, on its page, and adding another: any version,
 * a platform, a platform and region, or one exact release. Reads the session, so it
 * streams in on its own beside the public catalog. Visitors see only a way to sign in:
 * nothing of anyone's wishlist is ever shown to them.
 */
export async function GameWishlist({ gameId, title, releases, returnPath }: { gameId: string; title: string; releases: PickerRelease[]; returnPath: string }) {
  const viewer = await getCurrentViewer().catch(() => null);
  const heading = (
    <h2 id="game-wishlist" className="flex items-center gap-2 font-semibold">
      <Heart aria-hidden="true" className="size-4 text-muted-foreground" />
      Your wishlist
    </h2>
  );
  if (!viewer) {
    return (
      <section aria-labelledby="game-wishlist" className="rounded-2xl border border-white/10 bg-card p-5 sm:p-6">
        {heading}
        <p className="mt-2 text-sm text-muted-foreground">Keep track of the games and editions you&apos;re looking for.</p>
        <Button asChild variant="outline" size="lg" className="mt-3 h-10">
          <Link href={signInHref(returnPath)}>
            <LogIn aria-hidden="true" />
            Sign in to add to your wishlist
          </Link>
        </Button>
      </section>
    );
  }
  if (!viewer.handle) {
    return (
      <section aria-labelledby="game-wishlist" className="rounded-2xl border border-white/10 bg-card p-5 sm:p-6">
        {heading}
        <p className="mt-2 text-sm">
          <Link href={welcomeHref(returnPath)} className="font-medium text-primary-text underline underline-offset-4">
            Choose your handle
          </Link>{" "}
          to start your wishlist.
        </p>
      </section>
    );
  }

  const [wishes, platforms, regions] = await Promise.all([getMyWishlistForGame(gameId), getGameWishPlatforms(gameId), wishRegions()]);
  return (
    <section aria-labelledby="game-wishlist" className="rounded-2xl border border-white/10 bg-card p-5 sm:p-6">
      {heading}
      {wishes === null ? (
        <p className="mt-2 text-sm text-muted-foreground">Your wishlist can&apos;t be read right now. Try again later.</p>
      ) : wishes.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">This game isn&apos;t on your wishlist.</p>
      ) : (
        <ul aria-label="Your wishes for this game" className="mt-3 flex flex-col gap-2">
          {wishes.map((wish) => (
            <li key={wish.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5 text-sm">
              <p className="font-medium text-pretty">{targetLine(wish)}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <LevelChip item={wish} />
                <PriorityChip priority={wish.priority} />
              </div>
              {wish.state !== "available" ? <p className="mt-1.5 text-xs text-amber-200">Needs attention: the catalog changed.</p> : null}
              <Link href={wishHref(wish.id)} className="mt-1.5 inline-block text-xs font-medium text-primary-text underline underline-offset-4" aria-label={`View or edit your wish: ${targetLine(wish)}`}>
                View or edit
              </Link>
            </li>
          ))}
        </ul>
      )}
      {!viewer.isActive ? (
        <p className="mt-3 flex gap-2 text-sm text-muted-foreground">
          <UserRoundX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Your account can&apos;t add wishes right now.
        </p>
      ) : (
        <Disclosure
          initialOpen={wishes?.length === 0}
          className="mt-4 rounded-xl border border-white/10"
          summaryClassName="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl px-3 text-sm font-medium outline-none select-none focus-visible:ring-3 focus-visible:ring-ring"
          summary={
            <>
              <Heart aria-hidden="true" className="size-4 text-primary-text" />
              {wishes?.length ? "Want another version" : "Add to wishlist"}
            </>
          }
        >
          <div className="border-t border-white/10 p-3">
            <AddWishForm
              gameId={gameId}
              platforms={(platforms ?? []).map((p) => ({ id: p.id, name: p.name }))}
              regions={regions}
              releases={releaseChoices(releases)}
              initialItemId={uuidv7()}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Wanting {title} doesn&apos;t change your collection, and owning it doesn&apos;t remove it from your wishlist.
            </p>
          </div>
        </Disclosure>
      )}
      <Link href={WISHLIST_PATH} className="mt-4 inline-block text-sm text-primary-text underline underline-offset-4">
        See your whole wishlist
      </Link>
    </section>
  );
}

export function GameWishlistSkeleton() {
  return <Skeleton aria-hidden="true" className="h-32 w-full rounded-2xl" />;
}

/**
 * "Want this release" for one published release, beside the release in the list. Every
 * one on the page shares one read of the collector's wishes for the game. Nothing for a
 * visitor, an account without a handle, or one that can't add.
 */
export async function WantRelease({ gameId, release, title }: { gameId: string; release: PickerRelease; title: string }) {
  const viewer = await getCurrentViewer().catch(() => null);
  if (!viewer?.handle || !viewer.isActive) return null;
  const wishes = await getMyWishlistForGame(gameId);
  if (wishes === null) return null;
  const wish = wishes.find((w) => w.kind === "release" && w.state === "available" && w.release?.id === release.id);
  const label = [title, release.platform.shortName, regionLabel(release.region), editionText(release.edition), release.variantName].filter(Boolean).join(", ");
  return <WantReleaseForm releaseId={release.id} label={label} initialItemId={uuidv7()} wishId={wish?.id ?? null} />;
}
