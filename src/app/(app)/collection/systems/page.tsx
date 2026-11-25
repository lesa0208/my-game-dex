import { Copy, Gamepad2, Info, Layers, Library, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { Breadcrumbs, Cabinet, ShelfBoard, ShelfFillers, ShelfLight, ShelfSkeleton, Stat } from "@/components/shelf/shelf-parts";
import { SystemTile } from "@/components/shelf/system-tile";
import { Button } from "@/components/ui/button";
import { requireViewerWithHandle } from "@/features/account/queries";
import { getMySystems } from "@/features/shelf/collection";

export const metadata: Metadata = {
  title: "Systems",
};

const copies = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "copy" : "copies"}`;

/** The signed-in collector's systems: one tile per platform they have copies on. */
async function SystemsView() {
  await requireViewerWithHandle("/collection/systems");
  const result = await getMySystems();
  if (!result.ok) {
    return (
      <div className="mt-6">
        <EmptyState icon={PlugZap} title="Your systems aren't available">
          They can&apos;t be loaded right now. Try again later.
        </EmptyState>
      </div>
    );
  }

  const { systems, total } = result.data;
  if (total === 0) {
    return (
      <div className="mt-6">
        <EmptyState
          icon={Library}
          title="Your collection is empty"
          action={
            <Button asChild size="lg">
              <Link href="/explore">Find a game to add</Link>
            </Button>
          }
        >
          Find a game in Explore, choose the release you own and add it. Each system you collect for gets its own shelf here.
        </EmptyState>
      </div>
    );
  }

  // Copies whose platform the collector can't read (a release kept privately after it
  // left the catalog) have no shelf; the list still shows them.
  const shelved = systems.reduce((sum, s) => sum + s.copies, 0);
  const unshelved = total - shelved;

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
              <Gamepad2 aria-hidden="true" className="size-7 text-primary-text" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Systems</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Your game systems collection · {systems.length} {systems.length === 1 ? "system" : "systems"} · {copies(total)}
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 lg:flex lg:gap-8">
            {[
              { icon: Layers, value: systems.length.toLocaleString("en"), label: "Systems" },
              { icon: Copy, value: total.toLocaleString("en"), label: "Copies" },
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

      {unshelved > 0 ? (
        <p className="mt-4 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {unshelved === 1 ? "1 copy has" : `${unshelved.toLocaleString("en")} copies have`} no system shelf, because {unshelved === 1 ? "its release" : "their releases"} left the catalog.{" "}
            <Link href="/collection?status=invalid" className="font-medium text-primary-text underline underline-offset-4">
              See {unshelved === 1 ? "it" : "them"} in the list
            </Link>
          </span>
        </p>
      ) : null}

      <section aria-labelledby="systems-shelf" className="mt-6">
        <h2 id="systems-shelf" className="sr-only">
          Your systems
        </h2>
        <Cabinet>
          <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
            {systems.map((system) => (
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
            <ShelfFillers count={systems.length} columns={{ base: 1, sm: 2, xl: 3 }} />
          </ul>
        </Cabinet>
      </section>
    </>
  );
}

export default function SystemsPage() {
  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-4 md:px-6 md:py-6">
      <Breadcrumbs items={[{ label: "My Collection", href: "/collection" }, { label: "Systems" }]} />
      <Suspense fallback={<ShelfSkeleton />}>
        <SystemsView />
      </Suspense>
    </div>
  );
}
