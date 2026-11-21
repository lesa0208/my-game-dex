import { ArrowLeft, Compass, Copy, Gamepad2, PackageCheck, Star } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ConsoleArt } from "@/components/shelf/console-art";
import { ShelfBrowser } from "@/components/shelf/shelf-browser";
import { Breadcrumbs, Cabinet, ShelfBoard, ShelfLight, ShelfPreviewNotice, ShelfSkeleton, Stat } from "@/components/shelf/shelf-parts";
import { Button } from "@/components/ui/button";
import { getPreviewShelf, previewParams } from "@/features/shelf/queries";

export function generateStaticParams() {
  return previewParams().map(({ platform }) => ({ platform }));
}

export async function generateMetadata({ params }: PageProps<"/collection/systems/[platform]">): Promise<Metadata> {
  const { platform } = await params;
  return { title: getPreviewShelf(platform)?.system.shortName ?? "System" };
}

function EmptyShelf({ name, shortName }: { name: string; shortName: string }) {
  return (
    <Cabinet>
      <div className="relative">
        <ShelfLight />
        <div className="relative flex flex-col items-center px-6 pt-14 pb-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-lg border border-white/10 bg-black/40">
            <Gamepad2 aria-hidden="true" className="size-6 text-primary-text" />
          </span>
          <h2 className="mt-4 font-medium">This shelf is waiting for its first game</h2>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
            You haven&apos;t added any {name} games yet. Find one in the catalog, choose the release you own, and it will stand here.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button asChild size="lg">
              <Link href="/explore">
                <Compass aria-hidden="true" />
                Find {shortName} games
              </Link>
            </Button>
            <Button asChild variant="secondary" size="lg">
              <Link href="/collection/systems">
                <ArrowLeft aria-hidden="true" />
                All systems
              </Link>
            </Button>
          </div>
        </div>
        <ShelfBoard />
        <div className="h-24" />
        <ShelfBoard />
      </div>
    </Cabinet>
  );
}

async function SystemShelf({ params }: PageProps<"/collection/systems/[platform]">) {
  const { platform } = await params;
  const shelf = getPreviewShelf(platform);
  if (!shelf) notFound();
  const { system, games } = shelf;
  const [accent] = system.accent;

  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-4 md:px-6 md:py-6">
      <Breadcrumbs
        items={[
          { label: "My Collection", href: "/collection" },
          { label: "Systems", href: "/collection/systems" },
          { label: system.shortName },
        ]}
      />

      <header className="relative mt-4 overflow-hidden rounded-2xl border border-white/10 bg-[#141319]">
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background: `radial-gradient(45% 110% at 12% 10%, rgb(255 176 96 / 0.16), transparent 70%), radial-gradient(50% 120% at 100% 0%, ${accent}33, transparent 70%)`,
          }}
        />
        <div className="relative grid items-end gap-4 p-5 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-6 sm:p-6">
          {/* The console on its own small shelf, under a warm lamp. */}
          <div className="relative mx-auto w-48 sm:mx-0 sm:w-full">
            <ConsoleArt kind={system.console} className="relative drop-shadow-[0_12px_16px_rgb(0_0_0/0.7)]" />
            <ShelfBoard className="-mt-2" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
              {system.maker} · {system.released}
            </p>
            <h1 className="mt-1 text-2xl leading-tight font-semibold tracking-tight text-balance sm:text-3xl">{system.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">My Collection</p>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-8">
              {[
                { icon: Gamepad2, value: system.stats.games.toString(), label: "Games" },
                { icon: Copy, value: system.stats.copies.toString(), label: "Copies" },
                { icon: Star, value: system.stats.favorites.toString(), label: "Favorites" },
                { icon: PackageCheck, value: `${system.stats.completeShare}%`, label: "Complete in box" },
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
        </div>
      </header>

      <div className="mt-4">
        <ShelfPreviewNotice />
      </div>

      <div className="mt-6">
        {games.length === 0 ? (
          <EmptyShelf name={system.name} shortName={system.shortName} />
        ) : (
          <ShelfBrowser systemSlug={system.slug} systemLabel={system.shortName} media={system.media} games={games} />
        )}
      </div>
    </div>
  );
}

/** The shelf's address is only known per request outside the prerendered systems. */
export default function SystemShelfPage(props: PageProps<"/collection/systems/[platform]">) {
  return (
    <Suspense fallback={<ShelfSkeleton />}>
      <SystemShelf {...props} />
    </Suspense>
  );
}
