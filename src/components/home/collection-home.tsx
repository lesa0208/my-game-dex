import { Compass, Copy, Disc3, Heart, Info, Layers, Library, Plus } from "lucide-react";
import Link from "next/link";

import { Cabinet, ShelfBoard, ShelfFillers, ShelfLight } from "@/components/shelf/shelf-parts";
import { SystemTile } from "@/components/shelf/system-tile";
import { Button } from "@/components/ui/button";
import { HOME_SYSTEMS, type HomeCollection } from "@/features/home/queries";
import { cn } from "@/lib/utils";

import { GlowPanel, SectionHeading, type Shortcut, Shortcuts } from "./home-parts";
import { RecentlyAdded } from "./recently-added";

const copies = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "copy" : "copies"}`;

const SHORTCUTS: readonly Shortcut[] = [
  { href: "/explore", label: "Find Another Game", description: "Search the catalog and add a copy", icon: Compass },
  { href: "/collection", label: "View My Collection", description: "Every copy, with filters and sorting", icon: Library },
  { href: "/collection/wishlist", label: "My Wishlist", description: "The games you're looking for", icon: Heart },
];

/** Home for a collector with at least one copy: their systems first, then what they added last. */
export function CollectionHome({ data }: { data: HomeCollection }) {
  const shown = data.systems.slice(0, HOME_SYSTEMS);
  const shelved = data.systems.reduce((sum, s) => sum + s.copies, 0);
  const unshelved = data.copies - shelved;
  const stats = [
    { label: "Systems", value: data.systems.length.toLocaleString("en"), icon: Layers },
    { label: "Games", value: data.games === null ? "—" : data.games.toLocaleString("en"), icon: Disc3, note: data.games === null ? "Couldn't be counted right now" : null },
    { label: "Copies", value: data.copies.toLocaleString("en"), icon: Copy },
  ];

  return (
    <>
      <GlowPanel>
        <div className="flex flex-col gap-4 p-4 sm:p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Your Collection</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Your games. Your systems. Your shelves.</p>
          </div>
          <Button asChild size="control" className="w-full md:w-auto">
            <Link href="/explore">
              <Plus aria-hidden="true" data-icon="inline-start" />
              Add a Game
            </Link>
          </Button>
        </div>
        <dl aria-label="Collection overview" className="grid grid-cols-3 border-t border-white/[0.07]">
          {stats.map((stat, i) => (
            // The label is read first; the number is shown above it, the icon beside both.
            <div
              key={stat.label}
              className={cn("relative flex flex-col-reverse justify-center px-4 py-3 leading-tight sm:min-h-[4.25rem] sm:pl-[4.25rem]", i > 0 && "border-l border-white/[0.07]")}
            >
              <dt className="text-xs text-muted-foreground">{stat.label}</dt>
              <dd className="text-xl font-semibold tabular-nums sm:text-2xl">
                <span aria-hidden="true" className="absolute top-1/2 left-5 hidden size-9 -translate-y-1/2 items-center justify-center rounded-lg bg-primary/12 sm:flex">
                  <stat.icon className="size-[18px] text-primary-text" />
                </span>
                {stat.value}
                {stat.note ? <span className="sr-only">: {stat.note}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      </GlowPanel>

      <section aria-labelledby="home-systems" className="mt-6">
        <SectionHeading
          id="home-systems"
          title="My Systems"
          link={{ href: "/collection/systems", label: data.systems.length > HOME_SYSTEMS ? `View All ${data.systems.length} Systems` : "View All Systems" }}
        />
        {shown.length ? (
          <Cabinet>
            <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((system) => (
                <li key={system.slug} className="relative flex flex-col">
                  <ShelfLight />
                  <div className="relative px-3 pt-7 pb-3 sm:px-4">
                    <SystemTile
                      href={`/collection/systems/${system.slug}`}
                      shortName={system.shortName}
                      maker={system.maker}
                      console={system.console}
                      accent={system.accent}
                      count={copies(system.copies)}
                      fullName={system.name}
                    />
                  </div>
                  <ShelfBoard />
                </li>
              ))}
              <ShelfFillers count={shown.length} columns={{ base: 1, sm: 2, xl: 3 }} />
            </ul>
          </Cabinet>
        ) : null}
        {unshelved > 0 ? (
          <p className="mt-3 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              {unshelved === 1 ? "1 copy has" : `${unshelved.toLocaleString("en")} copies have`} no system shelf, because {unshelved === 1 ? "its release" : "their releases"} left
              the catalog.{" "}
              <Link href="/collection?status=invalid" className="font-medium text-primary-text underline underline-offset-4">
                See {unshelved === 1 ? "it" : "them"} in the list
              </Link>
            </span>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="home-recent" className="mt-8">
        <SectionHeading id="home-recent" title="Recently Added" link={{ href: "/collection", label: "View Collection" }} />
        <RecentlyAdded recent={data.recent} />
      </section>

      <section aria-labelledby="home-continue" className="mt-8">
        <SectionHeading id="home-continue" title="Continue Collecting" />
        <Shortcuts items={SHORTCUTS} labelledBy="home-continue" />
      </section>
    </>
  );
}
