import { PlugZap } from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";

import { GameMedia } from "@/components/shelf/game-media";
import { frameAspect } from "@/components/shelf/media-shells";
import { Cabinet, ShelfBoard, ShelfLight } from "@/components/shelf/shelf-parts";
import type { MediaKind } from "@/features/shelf/browse";
import type { RecentGame } from "@/features/shelf/collection";
import { shelfFrame } from "@/features/shelf/copies";

import { ShelfScroller } from "./shelf-scroller";

/**
 * Each shell's height on the shelf, relative to the tallest (a Saturn case). The real
 * items' heights, square-root compressed, so a Game Boy cartridge still reads clearly
 * beside a disc case while each keeps its own proportions.
 */
const HEIGHT: Record<MediaKind, number> = {
  "saturn-case": 1,
  "nes-cart": 0.94,
  "ps1-case": 0.91,
  "snes-cart": 0.75,
  "n64-cart": 0.71,
  "md-cart": 0.68,
  "gb-cart": 0.66,
  "gba-cart": 0.48,
};
/** A neutral placeholder (the shell isn't decided by the record): a mid-height box. */
const PLACEHOLDER = { height: 0.72, aspect: 1.3 };

/** The narrowest column, so a short title still has room under a small cartridge. */
const MIN_COLUMN = "6.75rem";

function shape(frame: MediaKind | null) {
  if (!frame) return PLACEHOLDER;
  return { height: HEIGHT[frame], aspect: frameAspect(frame) };
}

/**
 * The collector's most recently added distinct games, newest first, standing side by side
 * on one continuous shelf in the approved shell art (or the neutral placeholder when the
 * record doesn't decide the shell). Mixed media share one baseline. When there are more
 * than fit, the shelf scrolls sideways; the page never does. `recent` null: they couldn't
 * be read, which is said, never shown as nothing.
 */
export function RecentlyAdded({ recent }: { recent: RecentGame[] | null }) {
  if (recent === null) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-dashed border-white/15 px-4 py-6 text-sm text-muted-foreground">
        <PlugZap aria-hidden="true" className="size-4 shrink-0" />
        Your recently added games can&apos;t be shown right now. They&apos;re still in your collection.
      </p>
    );
  }
  return (
    <>
      <Cabinet>
        <div className="relative [--stage:6.25rem] sm:[--stage:7.5rem] xl:[--stage:8.25rem]">
          <ShelfLight />
          <ShelfScroller label="Recently added games">
            {/* One wrapper as wide as the games (at least the shelf), so the board under them is continuous. */}
            <div className="relative w-max min-w-full">
              <ShelfBoard className="absolute inset-x-0 top-[calc(1.75rem+var(--stage))]" />
              <ul className="flex min-w-full justify-evenly gap-x-4 px-4 pt-7 pb-3 sm:gap-x-5 sm:px-6" data-recent-shelf="">
                {recent.map(({ item, platform }) => {
                  const frame = platform ? shelfFrame(platform.slug) : null;
                  const { height, aspect } = shape(frame);
                  const facts = [platform?.shortName ?? null, item.region].filter(Boolean).join(" · ");
                  const width = `calc(var(--stage) * ${(height * aspect).toFixed(3)})`;
                  return (
                    <li key={item.key} className="shrink-0 snap-start scroll-mx-4" style={{ width: `max(${width}, ${MIN_COLUMN})` } as CSSProperties}>
                      <Link
                        href={item.href}
                        className="group flex flex-col items-center rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring"
                        data-recent-game={item.title}
                      >
                        <div className="flex w-full items-end justify-center" style={{ height: "var(--stage)" }}>
                          <div
                            className="transition-transform duration-300 group-hover:-translate-y-1 group-focus-visible:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
                            style={{ width }}
                          >
                            <GameMedia
                              media={item.media}
                              frame={frame}
                              seed={item.labelSeed}
                              title={item.title}
                              systemLabel={platform?.shortName ?? ""}
                              sizes="(min-width: 1280px) 220px, 170px"
                              interactive
                            />
                          </div>
                        </div>
                        {/* Room for the board, which is drawn once across the whole shelf. */}
                        <div aria-hidden="true" className="h-[22px]" />
                        <div className="w-full px-0.5 pt-2.5 text-center">
                          <p className="line-clamp-2 text-[13px] leading-snug font-medium text-pretty group-hover:text-primary-text sm:text-sm">{item.title}</p>
                          {facts ? <p className="mt-0.5 text-xs text-muted-foreground">{facts}</p> : null}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </ShelfScroller>
        </div>
      </Cabinet>
      <p className="mt-2 text-xs text-muted-foreground">
        Illustrative artwork. Actual editions may differ.
      </p>
    </>
  );
}
