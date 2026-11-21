import { ArrowLeft, Compass, Gamepad2, type LucideIcon } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { ConsoleKind } from "@/features/shelf/browse";

import { ConsoleArt } from "./console-art";
import { Cabinet, ShelfBoard, ShelfLight, Stat } from "./shelf-parts";

/**
 * The top of a system's shelf: its console on a small shelf under a warm lamp, its
 * name, and the shelf's numbers. `console` is null for a system without console art.
 */
export function SystemHeader({
  name,
  maker,
  released,
  console: consoleKind,
  accent,
  stats,
}: {
  name: string;
  maker: string | null;
  released: number | null;
  console: ConsoleKind | null;
  accent: string;
  stats: { icon: LucideIcon; value: string; label: string }[];
}) {
  const eyebrow = [maker, released].filter(Boolean).join(" · ");
  return (
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
          {consoleKind ? (
            <ConsoleArt kind={consoleKind} sizes="(min-width: 640px) 240px, 192px" priority className="aspect-[5/3] w-full drop-shadow-[0_12px_16px_rgb(0_0_0/0.7)]" />
          ) : (
            <span aria-hidden="true" className="flex aspect-[5/3] w-full items-end justify-center pb-2">
              <Gamepad2 strokeWidth={1.25} className="size-[62%] text-white/15" />
            </span>
          )}
          <ShelfBoard className="-mt-2" />
        </div>
        <div className="min-w-0">
          {eyebrow ? <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">{eyebrow}</p> : null}
          <h1 className="mt-1 text-2xl leading-tight font-semibold tracking-tight text-balance sm:text-3xl">{name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">My Collection</p>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-8">
            {stats.map((stat) => (
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
  );
}

/** A shelf with nothing on it yet, inviting the collector to add the first game. */
export function EmptyShelf({ name, shortName, allHref }: { name: string; shortName: string; allHref: string }) {
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
              <Link href={allHref}>
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
