import { PlugZap } from "lucide-react";
import Link from "next/link";

import { GameMedia } from "@/components/shelf/game-media";
import { frameAspect } from "@/components/shelf/media-shells";
import { ShelfBoard } from "@/components/shelf/shelf-parts";
import { formatDay } from "@/features/collection/details";
import type { RecentCopy } from "@/features/shelf/collection";
import { shelfFrame } from "@/features/shelf/copies";

/** The height every copy stands in (rem), so mixed shells share one baseline. */
const STAGE_REM = 7;
/** A placeholder with no system frame is a little wider than tall, as on a shelf. */
const PLACEHOLDER_ASPECT = 1.3;

/**
 * The collector's newest copies, each standing on its own small ledge in the approved
 * shell art (or the neutral placeholder when its shell isn't decided by the record).
 * `recent` null: they couldn't be read, which is said, never shown as nothing.
 */
export function RecentlyAdded({ recent }: { recent: RecentCopy[] | null }) {
  if (recent === null) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-dashed border-white/15 px-4 py-6 text-sm text-muted-foreground">
        <PlugZap aria-hidden="true" className="size-4 shrink-0" />
        Your recently added copies can&apos;t be shown right now. They&apos;re still in your collection.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {recent.map(({ item, platform }) => {
        const frame = platform ? shelfFrame(platform.slug) : null;
        const aspect = frame ? frameAspect(frame) : PLACEHOLDER_ASPECT;
        const facts = [platform?.shortName ?? null, item.region].filter(Boolean).join(" · ");
        return (
          <li key={item.key}>
            <Link
              href={item.href}
              className="group flex h-full flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#141319] outline-none transition-colors hover:border-primary/60 focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none"
            >
              <div className="shelf-wall relative px-4 pt-5">
                <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-amber-100/50 shadow-[0_0_10px_2px_rgb(255_190_120/0.25)]" />
                <div className="flex items-end justify-center" style={{ height: `${STAGE_REM}rem` }}>
                  <div
                    className="transition-transform duration-300 group-hover:-translate-y-1 group-focus-visible:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
                    style={{ width: `min(100%, ${(STAGE_REM * aspect).toFixed(2)}rem)` }}
                  >
                    <GameMedia
                      media={item.media}
                      frame={frame}
                      seed={item.labelSeed}
                      title={item.title}
                      systemLabel={platform?.shortName ?? ""}
                      sizes="140px"
                      interactive
                    />
                  </div>
                </div>
              </div>
              <ShelfBoard className="-mx-px" />
              <div className="flex flex-1 flex-col gap-0.5 px-3 pt-2.5 pb-3">
                <p className="line-clamp-2 text-sm leading-snug font-medium text-pretty">{item.title}</p>
                {facts ? <p className="text-xs text-muted-foreground">{facts}</p> : null}
                {item.added ? <p className="mt-auto pt-1 text-xs text-muted-foreground">Added {formatDay(item.added)}</p> : null}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
