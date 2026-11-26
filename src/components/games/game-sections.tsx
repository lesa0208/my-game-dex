import { Check, ChevronDown, Library, LogIn, Pencil, UserPlus } from "lucide-react";
import Link from "next/link";

import { ResultActions } from "@/components/explore/result-actions";
import { ConsoleArt } from "@/components/shelf/console-art";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentViewer } from "@/features/account/queries";
import { signInHref, welcomeHref } from "@/features/auth/redirect";
import { selfRegistrationOpen } from "@/features/auth/registration";
import { aliasKindLabel, formatCatalogDate, gameKindLabel, languageName, regionLabel, releaseCountLabel } from "@/features/catalog/format";
import type { ReleasePicker } from "@/features/catalog/types";
import { ownershipHeadline } from "@/features/collection/details";
import { getMyGameOwnership } from "@/features/collection/queries";
import { getExploreContext } from "@/features/explore/context";
import type { ShelfItem } from "@/features/shelf/browse";
import { getMyCopiesOfGame } from "@/features/shelf/collection";
import { consoleFor, type gameOverview } from "@/features/shelf/copies";

import { AddCopyButton } from "./add-copy-button";
import { HeroMore } from "./hero-more";

type Overview = ReturnType<typeof gameOverview>;

// M17b: the game page's dashboard parts. The catalog's facts are public; everything about
// the collector reads their session and streams in on its own. Only what the catalog or
// the collector recorded is shown: nothing is filled in.

const panelClass = "rounded-2xl border border-white/10 bg-[#17141f]/85 p-5 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.9)] backdrop-blur-md";

/**
 * The hero's actions: ownership, then Add to Collection and Wishlist (the controls on an
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
      {copies ? (
        <p className="inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/40 bg-primary/15 px-3 py-1 text-sm font-medium text-white" data-owned="">
          <Check aria-hidden="true" className="size-4 text-primary-text" />
          In your collection · {copies === 1 ? "Owned: Yes" : `Owned: ${copies.toLocaleString("en")} copies`}
        </p>
      ) : null}
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

/** "Complete in box", "Very good": only what the collector recorded, as label and value. */
function CopyFacts({ item, className }: { item: ShelfItem; className?: string }) {
  const rows = [
    item.platformName ? { label: "Platform", value: item.platformName } : null,
    item.region ? { label: "Region", value: item.region } : null,
    item.edition ? { label: "Edition", value: item.edition } : null,
    item.condition ? { label: "Condition", value: item.condition.label } : null,
    item.completeness ? { label: "Completeness", value: item.completeness.label } : null,
  ].filter((row) => row !== null);
  return (
    <dl className={className}>
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="text-sm text-muted-foreground">{row.label}</dt>
          <dd className="text-right text-sm font-medium text-white">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The right-hand panel: the collector's copy (or copies) at a glance, with View copy and
 * Edit; a short invitation to add when they have none; Sign In and Create Account for a
 * visitor. Never another collector's copies, and nothing private (purchase, price,
 * location, notes): those stay on the copy's own page.
 */
export async function MyCopyPanel({ game, platform, returnPath }: { game: { id: string; slug: string; title: string }; platform: string | null; returnPath: string }) {
  const viewer = await getCurrentViewer().catch(() => null);
  if (!viewer) {
    return (
      <section aria-labelledby="my-copy" className={panelClass} data-my-copy-panel="visitor">
        <h2 id="my-copy" className="text-lg font-semibold text-white">
          My Copy
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">Own {game.title}? Keep track of your physical copy, its condition and completeness, on your own shelf.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {selfRegistrationOpen() ? (
            <Button asChild size="lg" className="h-10">
              <Link href="/sign-up">
                <UserPlus aria-hidden="true" />
                Create Account
              </Link>
            </Button>
          ) : null}
          <Button asChild variant="outline" size="lg" className="h-10">
            <Link href={signInHref(returnPath)}>
              <LogIn aria-hidden="true" />
              Sign In
            </Link>
          </Button>
        </div>
      </section>
    );
  }
  if (!viewer.handle) {
    return (
      <section aria-labelledby="my-copy" className={panelClass}>
        <h2 id="my-copy" className="text-lg font-semibold text-white">
          My Copy
        </h2>
        <p className="mt-2 text-sm">
          <Link href={welcomeHref(returnPath)} className="font-medium text-primary-text underline underline-offset-4">
            Choose your handle
          </Link>{" "}
          to start your collection.
        </p>
      </section>
    );
  }

  const [ownership, copies] = await Promise.all([getMyGameOwnership(game.id), getMyCopiesOfGame(game.id, game.title)]);
  const items = copies?.items ?? [];
  if (!ownership || ownership.copies === 0 || !items.length) {
    return (
      <section aria-labelledby="my-copy" className={panelClass} data-my-copy-panel="none">
        <h2 id="my-copy" className="text-lg font-semibold text-white">
          My Copy
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{ownership && ownership.copies > 0 ? ownershipHeadline(ownership.copies) : "Not in your collection yet."}</p>
        {viewer.isActive ? (
          <div className="mt-4">
            <AddCopyButton game={game} platform={platform} />
          </div>
        ) : null}
      </section>
    );
  }

  // The first copy in full, then the rest as short lines.
  const first = items[0];
  const rest = items.filter((i) => i !== first);
  return (
    <section aria-labelledby="my-copy" className={panelClass} data-my-copy-panel="owned">
      <div className="flex items-center justify-between gap-3">
        <h2 id="my-copy" className="text-lg font-semibold text-white">
          {items.length === 1 ? "My Copy" : `My Copies (${ownership.copies})`}
        </h2>
        <Button asChild size="sm" className="h-8 gap-1.5 px-3">
          <Link href={`${first.href}?edit=1#edit`} aria-label={`Edit, ${first.details || first.title}`}>
            <Pencil aria-hidden="true" className="size-3.5" />
            Edit
          </Link>
        </Button>
      </div>
      <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2" data-my-copy="">
        <CopyFacts item={first} className="divide-y divide-white/[0.06]" />
        {!first.condition && !first.completeness ? <p className="mt-1 text-xs text-muted-foreground">No condition or completeness recorded yet.</p> : null}
        {first.note ? <p className="mt-2 inline-flex rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs">{first.note}</p> : null}
        <p className="mt-2 flex gap-3 text-xs font-medium">
          <Link href={first.href} className="text-primary-text underline-offset-4 hover:underline" aria-label={`View copy, ${first.details || first.title}`}>
            View copy
          </Link>
        </p>
      </div>
      {rest.length ? (
        <ul aria-label="Your other copies" className="mt-3 flex flex-col gap-1">
          {rest.slice(0, 3).map((item) => (
            <li key={item.key}>
              <Link href={item.href} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm outline-none hover:bg-white/5 focus-visible:ring-3 focus-visible:ring-ring">
                <span className="truncate">{item.details || item.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{item.completeness?.short ?? ""}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {items.length > 1 ? (
        <a href="#my-copies" className="mt-3 inline-flex text-sm font-medium text-primary-text underline-offset-4 hover:underline">
          See all {ownership.copies.toLocaleString("en")} copies
        </a>
      ) : null}
      {copies?.truncated ? <p className="mt-1 text-xs text-muted-foreground">Showing the first {items.length} copies.</p> : null}
    </section>
  );
}

export function MyCopyPanelSkeleton() {
  return <Skeleton aria-hidden="true" className="h-56 w-full rounded-2xl" />;
}

/** The catalog's facts about the game, as a table: what it records, never a guess. */
export function GameFactsCard({ game, overview, publisher }: { game: ReleasePicker["game"]; overview: Overview; publisher: string | null }) {
  const rows = [
    { label: overview.platforms.length === 1 ? "System" : "Systems", value: overview.platforms.map((p) => p.name).join(", ") || "Not recorded" },
    game.firstRelease ? { label: "First released", value: formatCatalogDate(game.firstRelease) } : null,
    publisher ? { label: "Publisher", value: publisher } : null,
    { label: "Verified releases", value: overview.releaseCount ? releaseCountLabel(overview.releaseCount) : "None yet" },
    overview.regions.length ? { label: overview.regions.length === 1 ? "Region" : "Regions", value: overview.regions.map((r) => regionLabel(r)).join(", ") } : null,
    game.kind !== "game" ? { label: "Kind", value: gameKindLabel(game.kind) ?? game.kind } : null,
    game.aliases.length ? { label: "Other titles", value: String(game.aliases.length) } : null,
  ].filter((row) => row !== null);
  return (
    <section aria-labelledby="game-facts" className="rounded-2xl border border-white/10 bg-[#141319] p-5">
      <h2 id="game-facts" className="text-lg font-semibold text-white">
        Game Details
      </h2>
      <dl className="mt-3 divide-y divide-white/[0.06]">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[7rem_1fr] gap-3 py-2.5 text-sm">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-pretty text-white">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Overview: about the game, its release information, and its other titles folded away. */
export function OverviewTab({ game, summary, overview, publisher }: { game: ReleasePicker["game"]; summary: string | null; overview: Overview; publisher: string | null }) {
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="about-game">
        <h2 id="about-game" className="text-xl font-semibold text-white">
          About the Game
        </h2>
        {summary ? (
          <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-pretty text-foreground/90">{summary}</p>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">The catalog has no summary of this game yet.</p>
        )}
      </section>

      <section aria-labelledby="release-info">
        <h2 id="release-info" className="text-xl font-semibold text-white">
          Release Information
        </h2>
        <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {game.firstRelease ? (
            <div>
              <dt className="text-xs text-muted-foreground">First released</dt>
              <dd className="mt-0.5 text-sm font-medium text-white">{formatCatalogDate(game.firstRelease)}</dd>
            </div>
          ) : null}
          {publisher ? (
            <div>
              <dt className="text-xs text-muted-foreground">Publisher</dt>
              <dd className="mt-0.5 text-sm font-medium text-white">{publisher}</dd>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">{overview.platforms.length === 1 ? "System" : "Systems"}</dt>
            <dd className="mt-1.5">
              <ul className="flex flex-wrap gap-2">
                {overview.platforms.map((p) => {
                  const kind = consoleFor(p.slug);
                  const verified = overview.groups.find((g) => g.platform.slug === p.slug)?.releases.length ?? 0;
                  return (
                    <li key={p.slug} className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-sm">
                      {kind ? <ConsoleArt kind={kind} sizes="36px" className="h-5 w-7 shrink-0" /> : null}
                      {p.name}
                      {verified ? <span className="text-xs text-muted-foreground">· {releaseCountLabel(verified)}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </dd>
          </div>
        </dl>
      </section>

      {game.aliases.length ? (
        <details className="group rounded-xl border border-white/[0.08] [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring">
            Other titles <span className="font-normal text-muted-foreground">({game.aliases.length})</span>
            <ChevronDown aria-hidden="true" className="ml-auto size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <ul aria-label="Other titles" className="flex flex-col gap-1 border-t border-white/[0.07] px-4 py-3 text-sm">
            {game.aliases.map((alias) => (
              <li key={`${alias.title}-${alias.languageCode}-${alias.regionCode}`}>
                <span className="text-muted-foreground">{aliasKindLabel(alias.kind)}: </span>
                {alias.title}
                {alias.languageCode ? <span className="text-muted-foreground"> · {languageName(alias.languageCode)}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
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
