import { ChevronDown, Library, LogIn, UserPlus } from "lucide-react";
import Link from "next/link";

import { ResultActions } from "@/components/explore/result-actions";
import { Button } from "@/components/ui/button";
import { getCurrentViewer } from "@/features/account/queries";
import { signInHref } from "@/features/auth/redirect";
import { selfRegistrationOpen } from "@/features/auth/registration";
import { aliasKindLabel, languageName } from "@/features/catalog/format";
import type { ReleasePicker } from "@/features/catalog/types";
import { getExploreContext } from "@/features/explore/context";
import { cn } from "@/lib/utils";

/**
 * M17b: the hero's actions, Add to Collection and Wishlist, the same controls as on an
 * Explore result (quick add with the page's platform chosen; a game-level wish), with
 * the collector's ownership above them. Reads the session, so it streams in on its own.
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
    <div className="flex flex-col gap-2">
      {copies ? (
        <p className="inline-flex w-fit items-center gap-1.5 rounded-full bg-primary/12 px-3 py-1 text-sm font-medium text-primary-text" data-owned="">
          <Library aria-hidden="true" className="size-4" />
          In your collection · {copies === 1 ? "Owned: Yes" : `Owned: ${copies.toLocaleString("en")} copies`}
        </p>
      ) : null}
      <ResultActions game={game} viewer={viewer} presetPlatform={platform} owned={copies} wishId={wished.get(game.id) ?? null} returnPath={returnPath} autoOpen={autoOpen} />
    </div>
  );
}

export function HeroActionsSkeleton() {
  return <div aria-hidden="true" className="h-10 w-full max-w-md animate-pulse rounded-lg bg-white/[0.06] motion-reduce:animate-none" />;
}

/** What the game is: the catalog's summary, then its other titles, folded away. */
export function GameOverview({ game, summary }: { game: ReleasePicker["game"]; summary: string | null }) {
  const aliases = game.aliases;
  return (
    <section id="overview" aria-labelledby="overview-title" className="scroll-mt-32">
      <h2 id="overview-title" className="text-xl font-semibold tracking-tight">
        Overview
      </h2>
      {summary ? (
        <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-pretty text-foreground/90">{summary}</p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">The catalog has no summary of this game yet.</p>
      )}
      {aliases.length ? (
        <details className="group mt-5 rounded-xl border border-white/[0.08] [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring">
            Other titles <span className="font-normal text-muted-foreground">({aliases.length})</span>
            <ChevronDown aria-hidden="true" className="ml-auto size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <ul aria-label="Other titles" className="flex flex-col gap-1 border-t border-white/[0.07] px-4 py-3 text-sm">
            {aliases.map((alias) => (
              <li key={`${alias.title}-${alias.languageCode}-${alias.regionCode}`}>
                <span className="text-muted-foreground">{aliasKindLabel(alias.kind)}: </span>
                {alias.title}
                {alias.languageCode ? <span className="text-muted-foreground"> · {languageName(alias.languageCode)}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** For a visitor, in place of their copies: what an account adds here. Nothing for a signed-in collector. */
export async function VisitorPanel({ title, returnPath }: { title: string; returnPath: string }) {
  const viewer = await getCurrentViewer().catch(() => null);
  if (viewer) return null;
  return (
    <section aria-labelledby="visitor-panel" className="rounded-2xl border border-white/10 bg-card p-5 sm:p-6">
      <h2 id="visitor-panel" className="flex items-center gap-2 font-semibold">
        <Library aria-hidden="true" className="size-4 text-muted-foreground" />
        Do you own {title}?
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">Keep track of your physical copy, its condition and completeness, on your own shelf.</p>
      <div className={cn("mt-4 flex flex-wrap gap-2")}>
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
