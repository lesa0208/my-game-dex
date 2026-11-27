import { Eye, Library, LogIn, Pencil } from "lucide-react";
import Link from "next/link";

import { ResultActions } from "@/components/explore/result-actions";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentViewer } from "@/features/account/queries";
import { signInHref } from "@/features/auth/redirect";
import { getMyGameOwnership } from "@/features/collection/queries";
import { getExploreContext } from "@/features/explore/context";
import type { ShelfItem } from "@/features/shelf/browse";
import { getMyCopiesOfGame } from "@/features/shelf/collection";

import { AddCopyButton } from "./add-copy-button";
import { HeroMore } from "./hero-more";

// M17b: the game page's dashboard parts. The catalog's facts are public; everything about
// the collector reads their session and streams in on its own. Only what the catalog or
// the collector recorded is shown: nothing is filled in.

/**
 * The hero's actions: Add to Collection (Add another, once owned) and Wishlist (the controls on an
 * Explore result: a quick add with the page's platform chosen, a game-level wish), and a
 * "More" menu leading to the wishlist's options (the My Copies tab) and the step-by-step add.
 */
export async function HeroActions({
  game,
  platform,
  returnPath,
  autoOpen,
}: {
  game: { id: string; slug: string; title: string };
  platform: string | null;
  returnPath: string;
  autoOpen: "add" | "wish" | null;
}) {
  const { viewer, owned, wished } = await getExploreContext([game.id]);
  const copies = owned.get(game.id) ?? 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-w-lg items-start gap-2">
        <div className="min-w-0 flex-1">
          <ResultActions game={game} viewer={viewer} presetPlatform={platform} owned={copies} wishId={wished.get(game.id) ?? null} returnPath={returnPath} autoOpen={autoOpen} />
        </div>
        <HeroMore stepByStepHref={`/games/${game.slug}/add${platform ? `?platform=${encodeURIComponent(platform)}` : ""}`} title={game.title} />
      </div>
    </div>
  );
}

export function HeroActionsSkeleton() {
  return <Skeleton aria-hidden="true" className="h-10 w-full max-w-lg rounded-lg" />;
}

/** A recorded condition or completeness, as a quiet chip; what wasn't recorded is said once. */
function CopyBadges({ item }: { item: ShelfItem }) {
  const badges = [
    item.completeness ? { label: "Completeness", value: item.completeness.label } : null,
    item.condition ? { label: "Condition", value: item.condition.label } : null,
  ].filter((b) => b !== null);
  if (!badges.length) return <p className="text-xs text-muted-foreground">Condition not recorded</p>;
  return (
    <dl className="flex flex-wrap gap-1.5">
      {badges.map((b) => (
        <div key={b.label} className="rounded-full border border-white/10 bg-white/[0.07] px-2.5 py-0.5 text-xs">
          <dt className="sr-only">{b.label}</dt>
          <dd className="font-medium text-white">{b.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Game Details 2.0: Your copies, in the hero, for a collector who owns the game, and for no one
 * else: a visitor or a collector without a copy already has Add to Collection and Wishlist beside
 * the title. Only what the collector recorded (platform, region, edition, completeness,
 * condition), never a picture: the cover is the game's, not their copy's. The first copy with
 * Edit and View; the others one line each; all of them in the My Copies tab. Nothing private
 * (purchase, price, location, notes), and never another collector's copies.
 */
export async function MyCopyPanel({
  game,
  platforms,
}: {
  game: { id: string; slug: string; title: string };
  platform: string | null;
  /** The game's systems, for each copy's platform's short name. */
  platforms: readonly { name: string; shortName: string }[];
  returnPath: string;
}) {
  const viewer = await getCurrentViewer().catch(() => null);
  if (!viewer?.handle) return null;
  const [ownership, copies] = await Promise.all([getMyGameOwnership(game.id), getMyCopiesOfGame(game.id, game.title)]);
  const items = copies?.items ?? [];
  if (!ownership || ownership.copies === 0 || !items.length) return null;

  const short = (item: ShelfItem) => platforms.find((p) => p.name === item.platformName)?.shortName ?? item.platformName ?? null;
  const first = items[0];
  const rest = items.filter((i) => i !== first);
  // Platform, region and edition, as recorded: the copy's identity, on one line.
  const identity = [
    short(first) ? { label: "Platform", value: short(first) as string } : null,
    first.region ? { label: "Region", value: first.region } : null,
    first.edition ? { label: "Edition", value: first.edition } : null,
  ].filter((row) => row !== null);
  return (
    <section
      aria-labelledby="my-copy"
      className="w-full rounded-2xl border border-[rgb(242_185_122/0.24)] bg-[linear-gradient(170deg,rgb(242_185_122/0.11),rgb(30_24_22/0.94)_55%)] p-4 shadow-[0_24px_50px_-24px_rgb(0_0_0/0.9)] backdrop-blur-md sm:p-5 md:max-w-md xl:ml-8 xl:w-[18.5rem] xl:max-w-none"
      data-my-copy-panel="owned"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="my-copy" className="font-heading text-lg font-semibold text-white">
          {items.length === 1 ? "Your copy" : "Your copies"}
        </h2>
        <span className="shrink-0 text-xs font-medium text-[rgb(242_185_122/0.95)]" data-owned="">{ownership.copies === 1 ? "Owned: Yes" : `Owned: ${ownership.copies.toLocaleString("en")} copies`}</span>
      </div>
      <div className="mt-3 flex flex-col gap-2.5 rounded-xl border border-white/[0.06] bg-black/25 p-3" data-my-copy="">
        <dl className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold text-white">
          {identity.map((row, i) => (
            <div key={row.label} className="inline-flex items-center gap-2">
              {i > 0 ? <span aria-hidden="true" className="font-normal text-muted-foreground/60">·</span> : null}
              <dt className="sr-only">{row.label}</dt>
              <dd className="text-pretty">{row.value}</dd>
            </div>
          ))}
        </dl>
        <CopyBadges item={first} />
        {first.note ? <p className="text-xs text-muted-foreground">{first.note}</p> : null}
        <div className="grid grid-cols-2 gap-2">
          <Button asChild size="sm" className="h-9 gap-1.5">
            <Link href={`${first.href}?edit=1#edit`} aria-label={`Edit, ${first.details || first.title}`}>
              <Pencil aria-hidden="true" className="size-3.5" />
              Edit
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="h-9 gap-1.5">
            <Link href={first.href} aria-label={`View copy, ${first.details || first.title}`}>
              <Eye aria-hidden="true" className="size-3.5" />
              View copy
            </Link>
          </Button>
        </div>
      </div>
      {rest.length ? (
        <ul aria-label="Your other copies" className="mt-2 flex flex-col gap-1">
          {rest.slice(0, 3).map((item) => (
            <li key={item.key}>
              <Link href={item.href} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm outline-none hover:bg-white/5 focus-visible:ring-3 focus-visible:ring-ring">
                <span className="min-w-0 text-pretty">{[short(item), item.region, item.edition].filter(Boolean).join(" · ") || item.details || item.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{item.completeness?.short ?? ""}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {items.length > 1 ? (
        <a href="#my-copies" className="mt-2 inline-flex px-3 text-sm font-medium text-primary-text underline-offset-4 hover:underline">
          Manage all copies
        </a>
      ) : null}
      {copies?.truncated ? <p className="mt-1 px-3 text-xs text-muted-foreground">Showing the first {items.length} copies.</p> : null}
    </section>
  );
}

/** My Copies for a visitor: what an account adds. A signed-in collector sees their copies instead. */
export async function MyCopiesVisitor({ returnPath }: { returnPath: string }) {
  const viewer = await getCurrentViewer().catch(() => null);
  if (viewer) return null;
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Library aria-hidden="true" className="size-4" />
      <span>
        <Link href={signInHref(returnPath)} className="font-medium text-primary-text underline underline-offset-4">
          Sign in
        </Link>{" "}
        to see your copies of this game.
      </span>
    </p>
  );
}

/**
 * Physical Releases with none verified: the way to still add a copy (kept without a
 * release): the quick add for a collector, Sign In for a visitor.
 */
export async function ReleasesEmptyAction({ game, platform, returnPath }: { game: { id: string; slug: string; title: string }; platform: string | null; returnPath: string }) {
  const viewer = await getCurrentViewer().catch(() => null);
  if (!viewer) {
    return (
      <Button asChild variant="outline" size="lg" className="h-10">
        <Link href={signInHref(returnPath)}>
          <LogIn aria-hidden="true" />
          Sign in to add
        </Link>
      </Button>
    );
  }
  if (!viewer.handle || !viewer.isActive) return null;
  return <AddCopyButton game={game} platform={platform} className="w-auto px-4" />;
}
