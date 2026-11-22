import { ChartColumn, Copy, Gamepad2, Info, Layers, Library, PackageCheck, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { Breadcrumbs, Stat } from "@/components/shelf/shelf-parts";
import { ConsoleArt } from "@/components/shelf/console-art";
import { type Part, PartKey, PartLegend, RankedBars, ScaledSegmentedBar, SegmentedBar } from "@/components/statistics/charts";
import { Button } from "@/components/ui/button";
import { requireViewerWithHandle } from "@/features/account/queries";
import { COMPLETENESS, NOT_RECORDED as NOT_RECORDED_LABEL } from "@/features/collection/details";
import { consoleFor } from "@/features/shelf/copies";
import { type Counted, NOT_IN_CATALOG, NOT_RECORDED, percent } from "@/features/statistics/compute";
import { getMyCollectionStatistics, type Lookups } from "@/features/statistics/queries";

export const metadata: Metadata = {
  title: "Statistics",
};

const copies = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "copy" : "copies"}`;
const games = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "game" : "games"}`;

const NOT_IN_CATALOG_LABEL = "No longer in the catalog";
const special = (key: string) => key === NOT_RECORDED || key === NOT_IN_CATALOG;

function completenessLabel(key: string) {
  if (key === NOT_RECORDED) return NOT_RECORDED_LABEL;
  return COMPLETENESS.find((c) => c.value === key)?.label ?? NOT_RECORDED_LABEL;
}
const completenessParts = (list: Counted[]): Part[] => list.map((c) => ({ key: c.key, label: completenessLabel(c.key), copies: c.copies }));

function regionLabel(key: string, lookups: Lookups) {
  if (key === NOT_RECORDED) return NOT_RECORDED_LABEL;
  if (key === NOT_IN_CATALOG) return NOT_IN_CATALOG_LABEL;
  if (key === "unknown") return "Region unknown in the catalog";
  return lookups.regions.get(key) ?? key;
}
function formatLabel(key: string, lookups: Lookups) {
  if (key === NOT_RECORDED) return NOT_RECORDED_LABEL;
  if (key === NOT_IN_CATALOG) return NOT_IN_CATALOG_LABEL;
  return lookups.formats.get(key) ?? key;
}

function Card({ id, title, description, children, className }: { id: string; title: string; description?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={`rounded-2xl border border-white/10 bg-card p-4 sm:p-5 ${className ?? ""}`}>
      <h2 id={id} className="text-base font-semibold tracking-tight">
        {title}
      </h2>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** The signed-in collector's statistics, counted on the server from their own copies. */
async function StatisticsView() {
  await requireViewerWithHandle("/collection/statistics");
  const result = await getMyCollectionStatistics();
  if (!result.ok) {
    return (
      <div className="mt-6">
        <EmptyState icon={PlugZap} title="Your statistics aren't available">
          {result.reason === "too_large" ? "Your collection is larger than statistics can count." : "They can't be loaded right now. Try again later."}
        </EmptyState>
      </div>
    );
  }

  const { data: s, lookups } = result;
  if (s.copies === 0) {
    return (
      <div className="mt-6">
        <EmptyState
          icon={Library}
          title="No statistics yet"
          action={
            <Button asChild size="lg">
              <Link href="/explore">Find a game to add</Link>
            </Button>
          }
        >
          Your collection is empty. Add the games you own, and their copies, systems, completeness, regions and formats are counted here.
        </EmptyState>
      </div>
    );
  }

  const share = (n: number) => percent(n, s.copies);
  const completeness = completenessParts(s.completeness);
  const boxed = (s.completeness.find((c) => c.key === "complete")?.copies ?? 0) + (s.completeness.find((c) => c.key === "sealed")?.copies ?? 0);

  return (
    <>
      <header className="relative mt-4 overflow-hidden rounded-2xl border border-white/10 bg-[#141319] p-5 sm:p-6">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(60%_120%_at_0%_0%,rgb(139_92_246/0.22),transparent_60%),radial-gradient(50%_90%_at_100%_0%,rgb(255_176_96/0.12),transparent_70%)]"
        />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-center gap-4">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-primary/40 bg-primary/15 shadow-[0_0_24px_-4px_rgb(139_92_246/0.6)]">
              <ChartColumn aria-hidden="true" className="size-7 text-primary-text" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Statistics</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">Your physical collection at a glance</p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 lg:flex lg:gap-8">
            {[
              { icon: Copy, value: s.copies.toLocaleString("en"), label: s.copies === 1 ? "Physical copy" : "Physical copies" },
              { icon: Gamepad2, value: s.games.toLocaleString("en"), label: s.games === 1 ? "Distinct game" : "Distinct games" },
              { icon: Layers, value: s.systems.toLocaleString("en"), label: s.systems === 1 ? "System" : "Systems" },
              { icon: PackageCheck, value: share(boxed), label: "Complete in box or sealed" },
            ].map((stat) => (
              <div key={stat.label}>
                <dt className="sr-only">{stat.label}</dt>
                <dd>
                  <Stat icon={stat.icon} value={stat.value} label={stat.label} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      {s.copiesWithoutGame > 0 ? (
        <p className="mt-4 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {s.copiesWithoutGame === 1 ? "1 copy is" : `${s.copiesWithoutGame.toLocaleString("en")} copies are`} counted as {s.copiesWithoutGame === 1 ? "a copy" : "copies"} but not as {s.copiesWithoutGame === 1 ? "a game" : "games"}, because{" "}
            {s.copiesWithoutGame === 1 ? "its release" : "their releases"} left the catalog.{" "}
            <Link href="/collection?status=invalid" className="font-medium text-primary-text underline underline-offset-4">
              See {s.copiesWithoutGame === 1 ? "it" : "them"} in the list
            </Link>
          </span>
        </p>
      ) : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card id="stats-completeness" title="Completeness" description={`What you've recorded for each copy, as a share of all ${copies(s.copies)}.`} className="lg:col-span-2">
          <SegmentedBar parts={completeness} total={s.copies} share={share} label="Completeness of all copies" />
          <PartLegend parts={completeness} share={share} className="mt-4" />
        </Card>

        <Card
          id="stats-systems"
          title="By system"
          description="Copies and distinct games on each system, with each system's bar split by completeness. A game you own on two systems counts once on each, and once in your total."
          className="lg:col-span-2"
        >
          <PartKey parts={completeness} />
          <ul className="mt-4 divide-y divide-white/[0.06]">
            {s.systemsBreakdown.map((row, _index, rows) => {
              const platform = lookups.platforms.get(row.platformId);
              const kind = platform ? consoleFor(platform.slug) : null;
              const name = platform?.name ?? "Unknown system";
              const rowShare = (n: number) => percent(n, row.copies);
              return (
                <li key={row.platformId} className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2 py-3 sm:grid-cols-[3.5rem_minmax(0,14rem)_minmax(0,1fr)]">
                  <span className="flex h-10 w-14 items-end justify-center">
                    {kind ? <ConsoleArt kind={kind} className="h-10 w-14" sizes="56px" /> : <Gamepad2 aria-hidden="true" className="size-6 text-muted-foreground" />}
                  </span>
                  <div className="min-w-0">
                    {platform ? (
                      <Link href={`/collection/systems/${platform.slug}`} className="block font-medium leading-snug hover:text-primary-text hover:underline hover:underline-offset-4">
                        {name}
                      </Link>
                    ) : (
                      <span className="block font-medium leading-snug">{name}</span>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {copies(row.copies)} · {games(row.games)}
                    </p>
                  </div>
                  <div className="col-span-2 flex items-center gap-3 sm:col-span-1">
                    <ScaledSegmentedBar
                      parts={completenessParts(row.completeness)}
                      copies={row.copies}
                      largest={rows[0]?.copies ?? row.copies}
                      share={rowShare}
                      label={`${name}: ${copies(row.copies)}, ${share(row.copies)} of your copies. Completeness`}
                    />
                    <span className="w-11 shrink-0 text-right text-sm font-medium tabular-nums" title={`${share(row.copies)} of your copies`}>
                      {share(row.copies)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {s.copiesWithoutSystem > 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {s.copiesWithoutSystem === 1 ? "1 copy has" : `${s.copiesWithoutSystem.toLocaleString("en")} copies have`} no known system, so {s.copiesWithoutSystem === 1 ? "it isn't" : "they aren't"} on any row.
            </p>
          ) : null}
        </Card>

        <Card id="stats-regions" title="Regions" description="The region of each copy's release, or the one recorded for a copy not linked to a release.">
          <RankedBars items={s.regions.map((r) => ({ key: r.key, label: regionLabel(r.key, lookups), copies: r.copies }))} total={s.copies} share={share} muted={special} />
        </Card>

        <Card id="stats-formats" title="Physical media" description="The media format of each copy's release. Copies not linked to a release have none recorded.">
          <RankedBars items={s.formats.map((f) => ({ key: f.key, label: formatLabel(f.key, lookups), copies: f.copies }))} total={s.copies} share={share} muted={special} />
        </Card>

        <Card id="stats-several" title="Several copies" description="Games and releases you own more than one copy of." className="lg:col-span-2">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { value: s.several.games, label: s.several.games === 1 ? "Game with several copies" : "Games with several copies" },
              { value: s.several.extraCopies, label: s.several.extraCopies === 1 ? "Copy beyond the first of its game" : "Copies beyond the first of each game" },
              { value: s.several.releases, label: s.several.releases === 1 ? "Release with several copies" : "Releases with several copies" },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                <dt className="text-xs text-muted-foreground">{item.label}</dt>
                <dd className="text-2xl font-semibold">{item.value.toLocaleString("en")}</dd>
              </div>
            ))}
          </dl>
          {s.several.top.length ? (
            <>
              <h3 className="mt-5 text-sm font-medium text-muted-foreground">Most copies</h3>
              <ol className="mt-2 divide-y divide-white/[0.06]">
                {s.several.top.map((g) => {
                  const game = lookups.games.get(g.gameId);
                  const title = game?.title ?? "A game no longer in the catalog";
                  return (
                    <li key={g.gameId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
                      {game?.slug ? (
                        <Link href={`/games/${game.slug}`} className="min-w-0 truncate font-medium hover:text-primary-text hover:underline hover:underline-offset-4">
                          {title}
                        </Link>
                      ) : (
                        <span className="min-w-0 truncate font-medium">{title}</span>
                      )}
                      <span className="text-sm text-muted-foreground">
                        {copies(g.copies)}
                        {g.releases > 1 ? ` · ${g.releases} releases` : null}
                        {g.systems > 1 ? ` · ${g.systems} systems` : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">You own one copy of each game.</p>
          )}
        </Card>
      </div>

      <details className="mt-4 rounded-2xl border border-white/10 bg-card p-4 text-sm sm:p-5">
        <summary className="cursor-pointer font-medium">How these are counted</summary>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-muted-foreground">
          <li>A copy is one physical item you own. Every copy counts, including copies not linked to a release and copies kept after their release left the catalog.</li>
          <li>A distinct game counts once however many copies, releases or systems you own it on. A copy not linked to a release counts as the game you recorded.</li>
          <li>A copy&apos;s system, region and media format come from its catalog release. For a copy not linked to a release, they&apos;re what you recorded, and it has no format.</li>
          <li>Anything not recorded is shown as &ldquo;Not recorded&rdquo;, never guessed. Shares are of all your copies, including those.</li>
          <li>Only you can see these statistics. Purchase prices and dates aren&apos;t used.</li>
        </ul>
      </details>
    </>
  );
}

function StatisticsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your statistics" className="mt-4 flex flex-col gap-4">
      <div className="h-32 animate-pulse rounded-2xl bg-white/[0.04]" />
      <div className="h-40 animate-pulse rounded-2xl bg-white/[0.04]" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-56 animate-pulse rounded-2xl bg-white/[0.04]" />
        <div className="h-56 animate-pulse rounded-2xl bg-white/[0.04]" />
      </div>
    </div>
  );
}

export default function StatisticsPage() {
  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-4 md:px-6 md:py-6">
      <Breadcrumbs items={[{ label: "My Collection", href: "/collection" }, { label: "Statistics" }]} />
      <Suspense fallback={<StatisticsSkeleton />}>
        <StatisticsView />
      </Suspense>
    </div>
  );
}
