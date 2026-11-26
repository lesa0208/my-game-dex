import { Copy, Gamepad2, Layers, PackageCheck, Star } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Breadcrumbs, Cabinet, ShelfBoard, ShelfFillers, ShelfLight, ShelfPreviewNotice, Stat } from "@/components/shelf/shelf-parts";
import { SystemTile } from "@/components/shelf/system-tile";
import { getPreviewSystems } from "@/features/shelf/queries";

export const metadata: Metadata = {
  title: "Systems (preview)",
};

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** The visual preview of the Systems screen, on sample data. The real one is /collection/systems. */
export default function SystemsPreviewPage() {
  const systems = getPreviewSystems();
  if (!systems) notFound();

  const games = systems.reduce((sum, s) => sum + s.stats.games, 0);
  const copies = systems.reduce((sum, s) => sum + s.stats.copies, 0);
  const favorites = systems.reduce((sum, s) => sum + s.stats.favorites, 0);
  const complete = Math.round(systems.reduce((sum, s) => sum + (s.stats.completeShare * s.stats.games) / 100, 0));
  const completeShare = games ? Math.round((complete / games) * 100) : 0;
  // Fullest shelves first, as a collector would arrange their display.
  const ordered = [...systems].sort((a, b) => b.stats.games - a.stats.games || a.name.localeCompare(b.name, "en"));

  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-4 md:px-6 md:py-6">
      <Breadcrumbs items={[{ label: "My Collection", href: "/collection" }, { label: "Systems preview" }]} />

      <header className="relative mt-4 overflow-hidden rounded-2xl border border-white/10 bg-[#141319] p-5 sm:p-6">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(60%_120%_at_0%_0%,rgb(139_92_246/0.22),transparent_60%),radial-gradient(50%_90%_at_100%_0%,rgb(255_176_96/0.12),transparent_70%)]"
        />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-center gap-4">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-primary/40 bg-primary/15 shadow-[0_0_24px_-4px_rgb(139_92_246/0.6)]">
              <Gamepad2 aria-hidden="true" className="size-7 text-primary-text" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Systems</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Your game systems collection · {systems.length} systems · {games.toLocaleString("en")} physical games
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 lg:flex lg:gap-8">
            {[
              { icon: Layers, value: systems.length.toString(), label: "Systems" },
              { icon: Gamepad2, value: games.toLocaleString("en"), label: "Games" },
              { icon: Copy, value: copies.toLocaleString("en"), label: "Copies" },
              { icon: PackageCheck, value: `${completeShare}%`, label: "Complete in box" },
              { icon: Star, value: favorites.toLocaleString("en"), label: "Favorites" },
            ].map((stat) => (
              <div key={stat.label} className={stat.label === "Favorites" ? "hidden lg:block" : undefined}>
                <dt className="sr-only">{stat.label}</dt>
                <dd>
                  <Stat icon={stat.icon} value={stat.value} label={stat.label} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <div className="mt-4">
        <ShelfPreviewNotice />
      </div>

      <section aria-labelledby="systems-shelf" className="mt-6">
        <h2 id="systems-shelf" className="sr-only">
          Your systems
        </h2>
        <Cabinet>
          <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
            {ordered.map((system) => (
              <li key={system.slug} className="relative flex flex-col">
                <ShelfLight />
                <div className="relative px-3 pt-7 pb-3 sm:px-4">
                  <SystemTile
                    href={`/collection/preview/${system.slug}`}
                    shortName={system.shortName}
                    maker={system.maker}
                    console={system.console}
                    accent={system.accent}
                    count={count(system.stats.games, "game")}
                    empty={system.stats.games === 0}
                    fullName={system.stats.games === 0 ? system.name : `${system.name}, ${count(system.stats.copies, "copy", "copies")}`}
                  />
                </div>
                <ShelfBoard />
              </li>
            ))}
            <ShelfFillers count={ordered.length} columns={{ base: 1, sm: 2, xl: 3 }} />
          </ul>
        </Cabinet>
      </section>
    </div>
  );
}
