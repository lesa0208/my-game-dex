import { ArrowLeft, BadgeCheck, CalendarDays, Building2, Globe, Star, Tag } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ConsoleArt } from "@/components/shelf/console-art";
import { GameMedia } from "@/components/shelf/game-media";
import { Breadcrumbs, ShelfBoard, ShelfLight, ShelfPreviewNotice, ShelfSkeleton } from "@/components/shelf/shelf-parts";
import { Button } from "@/components/ui/button";
import { completenessLabel, conditionLabel } from "@/features/shelf/browse";
import { getPreviewGame, previewParams } from "@/features/shelf/queries";

export function generateStaticParams() {
  return previewParams().flatMap(({ platform, games }) => games.map((game) => ({ platform, game })));
}

export async function generateMetadata({ params }: PageProps<"/collection/systems/[platform]/[game]">): Promise<Metadata> {
  const { platform, game } = await params;
  return { title: getPreviewGame(platform, game)?.game.title ?? "Game" };
}

const dateFormat = new Intl.DateTimeFormat("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

async function ShelfGame({ params }: PageProps<"/collection/systems/[platform]/[game]">) {
  const { platform, game: gameSlug } = await params;
  const found = getPreviewGame(platform, gameSlug);
  if (!found) notFound();
  const { system, game } = found;
  const shelfHref = `/collection/systems/${system.slug}`;

  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-4 md:px-6 md:py-6">
      <Breadcrumbs
        items={[
          { label: "My Collection", href: "/collection" },
          { label: "Systems", href: "/collection/systems" },
          { label: system.shortName, href: shelfHref },
          { label: game.title },
        ]}
      />

      <div className="mt-4 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <article className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#141319]">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[radial-gradient(50%_90%_at_20%_0%,rgb(255_176_96/0.16),transparent_70%),radial-gradient(50%_90%_at_100%_100%,rgb(139_92_246/0.18),transparent_70%)]"
          />
          <div className="relative grid gap-6 p-5 sm:grid-cols-[minmax(0,17rem)_1fr] sm:p-6">
            {/* The copy itself, standing on a lit shelf. */}
            <div className="relative mx-auto w-full max-w-64 sm:max-w-none">
              <ShelfLight className="-top-2" />
              <div className="relative px-5 pt-8 pb-2">
                <GameMedia kind={system.media} region={game.region} slug={game.slug} title={game.title} systemLabel={system.shortName} sizes="(min-width: 640px) 230px, 60vw" priority />
              </div>
              <ShelfBoard />
            </div>

            <div className="min-w-0">
              <h1 className="text-2xl leading-tight font-semibold tracking-tight text-balance sm:text-3xl">{game.title}</h1>
              <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <span className="inline-block w-8">
                  <ConsoleArt kind={system.console} sizes="40px" className="h-6 w-8" />
                </span>
                {system.name}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-primary-solid px-3 py-1.5 text-sm font-medium text-primary-solid-foreground">
                  <BadgeCheck aria-hidden="true" className="size-4" />
                  In my collection
                </span>
                {game.favorite ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/40 bg-amber-300/10 px-3 py-1.5 text-sm font-medium">
                    <Star aria-hidden="true" className="size-4 fill-amber-300 text-amber-300" />
                    Favorite
                  </span>
                ) : null}
              </div>
              <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-5 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                {[
                  { icon: CalendarDays, label: "Released", value: game.year.toString() },
                  { icon: Building2, label: "Publisher", value: game.publisher },
                  { icon: Tag, label: "Genre", value: game.genre },
                  { icon: Globe, label: "Region", value: game.region },
                ].map(({ icon: Icon, label, value }) => (
                  <div key={label} className="flex gap-2.5">
                    <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary-text" />
                    <div>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="text-sm font-medium">{value}</dd>
                    </div>
                  </div>
                ))}
              </dl>
              <Button asChild variant="secondary" size="lg" className="mt-6">
                <Link href={shelfHref}>
                  <ArrowLeft aria-hidden="true" />
                  Back to the {system.shortName} shelf
                </Link>
              </Button>
            </div>
          </div>
        </article>

        <aside aria-labelledby="my-copy" className="flex flex-col gap-4">
          <section className="rounded-2xl border border-white/10 bg-card p-5">
            <h2 id="my-copy" className="font-semibold">
              My copy{game.copies > 1 ? ` (1 of ${game.copies})` : ""}
            </h2>
            <dl className="mt-4 space-y-3 text-sm">
              {[
                ["Condition", conditionLabel(game.condition)],
                ["Completeness", completenessLabel(game.completeness)],
                ["Region", game.region],
                ["Acquired", dateFormat.format(new Date(`${game.acquired}T00:00:00Z`))],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 border-b border-white/5 pb-3 last:border-0 last:pb-0">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            {game.notes ? <p className="mt-4 rounded-lg bg-secondary/70 p-3 text-sm leading-relaxed text-muted-foreground">{game.notes}</p> : null}
          </section>
          <ShelfPreviewNotice />
        </aside>
      </div>
    </div>
  );
}

export default function ShelfGamePage(props: PageProps<"/collection/systems/[platform]/[game]">) {
  return (
    <Suspense fallback={<ShelfSkeleton />}>
      <ShelfGame {...props} />
    </Suspense>
  );
}
