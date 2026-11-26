import { BookOpen, Check, ChevronDown, Eye, Library, LogIn, Pencil, UserPlus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { ResultActions } from "@/components/explore/result-actions";
import { ConsoleArt } from "@/components/shelf/console-art";
import { shellFor } from "@/components/shelf/media-shells";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentViewer } from "@/features/account/queries";
import { signInHref, welcomeHref } from "@/features/auth/redirect";
import { selfRegistrationOpen } from "@/features/auth/registration";
import { aliasKindLabel, languageName, regionLabel, releaseCountLabel } from "@/features/catalog/format";
import type { ProviderMetadata } from "@/features/catalog/provider-metadata";
import type { ReleasePicker } from "@/features/catalog/types";
import { ownershipHeadline } from "@/features/collection/details";
import { getMyGameOwnership } from "@/features/collection/queries";
import { getExploreContext } from "@/features/explore/context";
import type { MediaKind, ShelfItem } from "@/features/shelf/browse";
import { getMyCopiesOfGame } from "@/features/shelf/collection";
import { consoleFor, type gameOverview } from "@/features/shelf/copies";
import { cn } from "@/lib/utils";

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

const MEDIA_NOUN: Record<MediaKind, string> = {
  "snes-cart": "cartridge",
  "nes-cart": "cartridge",
  "n64-cart": "cartridge",
  "gb-cart": "cartridge",
  "gba-cart": "cartridge",
  "md-cart": "cartridge",
  "ps1-case": "case",
  "saturn-case": "case",
};

/**
 * The copy's kind of item, drawn with the approved generic shell for its platform and
 * region (the label recess left blank) and captioned as an illustration: never the
 * game's label, never a picture of this collector's copy.
 */
function CopyIllustration({ item, platformShort }: { item: ShelfItem; platformShort: string | null }) {
  if (!item.media) return null;
  const shell = shellFor(item.media.kind, item.media.region);
  return (
    <figure className="flex w-[6.5rem] shrink-0 flex-col items-center gap-1.5" data-copy-illustration="">
      <div className="relative flex h-[5.5rem] w-full items-center justify-center rounded-xl bg-[radial-gradient(closest-side,rgb(196_181_253/0.18),transparent)]">
        <span aria-hidden="true" className="absolute inset-x-[18%] bottom-1 h-2 rounded-[50%] bg-black/60 blur-md" />
        <div className="relative w-[92%] drop-shadow-[0_10px_14px_rgb(0_0_0/0.6)]">
          <Image src={shell.image} alt="" sizes="104px" className="block h-auto w-full opacity-90 grayscale-[30%]" />
          {/* The label recess, blank: no game's label and no printed frame. */}
          <span
            aria-hidden="true"
            className="absolute bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.05)_0_3px,transparent_3px_6px),linear-gradient(160deg,#2a2536,#17141f)] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.5)]"
            style={{ left: `${shell.label.left}%`, top: `${shell.label.top}%`, width: `${shell.label.width}%`, height: `${shell.label.height}%`, borderRadius: shell.radius }}
          />
        </div>
      </div>
      <figcaption className="text-center text-[11px] leading-tight text-muted-foreground">
        Illustration{platformShort ? `: ${platformShort} ${MEDIA_NOUN[item.media.kind]}` : ""}
      </figcaption>
    </figure>
  );
}

/** A recorded condition or completeness, as a badge; what wasn't recorded is said once, quietly. */
function CopyBadges({ item }: { item: ShelfItem }) {
  const badges = [
    item.completeness ? { label: "Completeness", value: item.completeness.label } : null,
    item.condition ? { label: "Condition", value: item.condition.label } : null,
  ].filter((b) => b !== null);
  if (!badges.length) return <p className="text-xs text-muted-foreground">Condition not recorded</p>;
  return (
    <dl className="flex flex-wrap gap-1.5">
      {badges.map((b) => (
        <div key={b.label} className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs">
          <dt className="sr-only">{b.label}</dt>
          <dd className="font-medium text-white">{b.value}</dd>
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
export async function MyCopyPanel({
  game,
  platform,
  platforms,
  returnPath,
}: {
  game: { id: string; slug: string; title: string };
  platform: string | null;
  /** The game's systems, for the copy's platform's short name. */
  platforms: readonly { name: string; shortName: string }[];
  returnPath: string;
}) {
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

  // The first copy as a card, then the rest as short lines.
  const first = items[0];
  const rest = items.filter((i) => i !== first);
  const platformShort = platforms.find((p) => p.name === first.platformName)?.shortName ?? null;
  // Platform, region and edition, as recorded: the copy's identity under its picture.
  const identity = [
    first.platformName ? { label: "Platform", value: platformShort ?? first.platformName } : null,
    first.region ? { label: "Region", value: first.region } : null,
    first.edition ? { label: "Edition", value: first.edition } : null,
  ].filter((row) => row !== null);
  return (
    <section aria-labelledby="my-copy" className={panelClass} data-my-copy-panel="owned">
      <h2 id="my-copy" className="text-lg font-semibold text-white">
        {items.length === 1 ? "My Copy" : `My Copies (${ownership.copies})`}
      </h2>
      <div className="mt-4 flex gap-4" data-my-copy="">
        <CopyIllustration item={first} platformShort={platformShort} />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <dl className="flex flex-col gap-1.5">
            {identity.map((row) => (
              <div key={row.label} className="leading-tight">
                <dt className="text-[11px] tracking-wide text-muted-foreground uppercase">{row.label}</dt>
                <dd className="text-sm font-medium text-pretty text-white">{row.value}</dd>
              </div>
            ))}
          </dl>
          <CopyBadges item={first} />
          {first.note ? <p className="w-fit rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs">{first.note}</p> : null}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
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
      {rest.length ? (
        <ul aria-label="Your other copies" className="mt-3 flex flex-col gap-1 border-t border-white/[0.07] pt-3">
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

/**
 * The detail behind the hero's facts, never repeating them: each system by its full name
 * with its own verified releases, and the regions of those releases. What the catalog
 * records, never a guess.
 */
export function GameFactsCard({ game, overview, provider = null }: { game: ReleasePicker["game"]; overview: Overview; provider?: ProviderMetadata | null }) {
  return (
    <section aria-labelledby="game-facts" className="rounded-2xl border border-white/10 bg-[#141319] p-5" data-game-facts={game.slug}>
      <h2 id="game-facts" className="text-lg font-semibold text-white">
        Game Details
      </h2>
      <dl className="mt-3 divide-y divide-white/[0.06]">
        <div className="py-2.5 text-sm">
          <dt className="text-muted-foreground">{overview.platforms.length === 1 ? "System" : "Systems"}</dt>
          <dd className="mt-2">
            {overview.platforms.length ? (
              <ul className="flex flex-col gap-2">
                {overview.platforms.map((p) => {
                  const kind = consoleFor(p.slug);
                  const verified = overview.groups.find((g) => g.platform.slug === p.slug)?.releases.length ?? 0;
                  return (
                    <li key={p.slug} className="flex items-center gap-2.5">
                      {kind ? <ConsoleArt kind={kind} sizes="40px" className="h-6 w-8 shrink-0" /> : <span aria-hidden="true" className="w-8 shrink-0" />}
                      <span className="min-w-0 leading-tight">
                        <span className="block text-pretty text-white">{p.name}</span>
                        <span className="text-xs text-muted-foreground">{verified ? releaseCountLabel(verified) : "No verified release yet"}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <span className="text-muted-foreground">Not recorded</span>
            )}
          </dd>
        </div>
        {overview.regions.length ? (
          <div className="grid grid-cols-[7rem_1fr] gap-3 py-2.5 text-sm">
            <dt className="text-muted-foreground">{overview.regions.length === 1 ? "Region" : "Regions"}</dt>
            <dd className="text-pretty text-white">{overview.regions.map((r) => regionLabel(r)).join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      {provider ? <ProviderFacts provider={provider} /> : null}
    </section>
  );
}

/**
 * M18a: what IGDB says about the game (developers, publishers, genres, themes), under its own
 * heading and credit: the provider's metadata, not the catalog's verified facts. Only what IGDB
 * records; an empty field is left out.
 */
function ProviderFacts({ provider }: { provider: ProviderMetadata }) {
  const rows = [
    provider.developers.length ? { label: provider.developers.length === 1 ? "Developer" : "Developers", value: provider.developers.join(", ") } : null,
    provider.publishers.length ? { label: provider.publishers.length === 1 ? "Publisher" : "Publishers", value: provider.publishers.join(", ") } : null,
    provider.genres.length ? { label: provider.genres.length === 1 ? "Genre" : "Genres", value: provider.genres.join(", ") } : null,
    provider.themes.length ? { label: provider.themes.length === 1 ? "Theme" : "Themes", value: provider.themes.join(", ") } : null,
  ].filter((row) => row !== null);
  return (
    <div className="mt-3 border-t border-white/[0.08] pt-3" data-provider-facts={provider.provider}>
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">From IGDB</h3>
      {rows.length ? (
        <dl className="mt-1 divide-y divide-white/[0.06]">
          {rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[7rem_1fr] gap-3 py-2.5 text-sm">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-pretty text-white">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">No further details recorded.</p>
      )}
      <IgdbCredit url={provider.url} className="mt-2" />
    </div>
  );
}

/** The visible credit wherever IGDB's data or images are shown. */
export function IgdbCredit({ url, className }: { url: string | null; className?: string }) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)} data-igdb-credit="">
      Game data from{" "}
      <a href={url ?? "https://www.igdb.com"} className="underline underline-offset-2 hover:text-foreground" rel="noopener noreferrer" target="_blank">
        IGDB.com
      </a>
    </p>
  );
}

/**
 * Overview: about the game, and its other titles folded away. The release facts are in
 * the hero and Game Details, said once. The catalog's own summary first; else (M18a) IGDB's,
 * credited; with neither, a quiet line, never invented.
 */
export function OverviewTab({ game, summary, provider = null }: { game: ReleasePicker["game"]; summary: string | null; provider?: ProviderMetadata | null }) {
  const fromIgdb = !summary && provider?.summary ? provider.summary : null;
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="about-game" data-summary={summary ? "yes" : fromIgdb ? "igdb" : "none"}>
        <h2 id="about-game" className="text-xl font-semibold text-white">
          About the Game
        </h2>
        {summary ? (
          <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-pretty text-foreground/90">{summary}</p>
        ) : fromIgdb ? (
          <>
            <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-pretty whitespace-pre-line text-foreground/90">{fromIgdb}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Description from{" "}
              <a href={provider?.url ?? "https://www.igdb.com"} className="underline underline-offset-2 hover:text-foreground" rel="noopener noreferrer" target="_blank">
                IGDB.com
              </a>
              .
            </p>
          </>
        ) : (
          <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <BookOpen aria-hidden="true" className="size-4 shrink-0" />
            No description yet.
          </p>
        )}
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
