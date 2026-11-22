import { Flag, Info, Library, TriangleAlert } from "lucide-react";

import { GameMedia } from "@/components/shelf/game-media";
import { physicalMedia } from "@/features/shelf/copies";
import { levelLabel, levelOf, minimumLabel, ownedLine, priorityLabel, releaseFacts, stateNotice, targetLine } from "@/features/wishlist/format";
import type { WishlistItem } from "@/features/wishlist/types";
import { cn } from "@/lib/utils";

// How one wishlist entry is shown, on the wishlist, the game's page and the entry's own
// page. Only an exact release is drawn as its physical media, and only when the catalog
// decides its shell (the shelf's rules); every other wish is a neutral placeholder, so a
// preference is never drawn as a release that may not exist.

/** The entry's media: the exact release's shell, or the neutral placeholder. */
export function WishMedia({ item, sizes = "64px", className }: { item: WishlistItem; sizes?: string; className?: string }) {
  const media =
    item.kind === "release" && item.platform
      ? physicalMedia(item.platform.slug, item.release?.format?.code ?? null, item.region && item.region.code !== "unknown" ? item.region.code : null)
      : null;
  return (
    <div className={cn("shrink-0", className)}>
      <GameMedia media={media} seed={item.game.id} title={item.release?.local_title ?? item.game.title} systemLabel={item.platform?.short_name ?? ""} sizes={sizes} />
    </div>
  );
}

const PRIORITY_TONES: Record<number, string> = {
  1: "border-primary/50 bg-primary/15 text-foreground",
  2: "border-white/10 bg-white/[0.04] text-muted-foreground",
  3: "border-white/10 bg-transparent text-muted-foreground",
};

export function PriorityChip({ priority }: { priority: number }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium", PRIORITY_TONES[priority])}>
      <Flag aria-hidden="true" className={cn("size-3", priority === 1 && "text-primary-text")} />
      {priorityLabel(priority)} priority
    </span>
  );
}

/** "Exact release", "Any version": what kind of wish this is, before what it names. */
export function LevelChip({ item }: { item: WishlistItem }) {
  const level = levelOf(item);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium",
        level === "release" ? "border-primary/40 text-primary-text" : "border-dashed border-white/20 text-muted-foreground",
      )}
    >
      {levelLabel(level)}
    </span>
  );
}

/** The wanted target, the minimum, ownership and anything the catalog changed. */
export function WishFacts({ item, showNote = true }: { item: WishlistItem; showNote?: boolean }) {
  const owned = ownedLine(item);
  const notice = stateNotice(item);
  const facts = releaseFacts(item.release);
  return (
    <>
      <p className="text-sm text-pretty">{targetLine(item)}</p>
      {item.release?.local_title && item.release.local_title !== item.game.title ? <p className="text-xs text-muted-foreground">Title on the box: {item.release.local_title}</p> : null}
      {facts.length ? <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <LevelChip item={item} />
        <PriorityChip priority={item.priority} />
        <span className="inline-flex items-center rounded-md border border-white/10 px-1.5 py-0.5 text-xs text-muted-foreground">
          <span className="sr-only">Minimum completeness: </span>
          {minimumLabel(item.completeness)}
        </span>
      </div>
      <p className="mt-2 flex items-start gap-1.5 text-xs">
        <Library aria-hidden="true" className="mt-px size-3.5 shrink-0 text-muted-foreground" />
        <span>
          <span className={item.owned.copies ? "font-medium" : "text-muted-foreground"}>{owned.headline}</span>
          {owned.detail ? <span className="text-muted-foreground">. {owned.detail}</span> : null}
        </span>
      </p>
      {showNote && item.note ? (
        <p className="mt-2 line-clamp-3 rounded-md border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-xs break-words whitespace-pre-wrap text-foreground/90">
          <span className="sr-only">Your private note: </span>
          {item.note}
        </p>
      ) : null}
      {notice ? (
        <p
          className={cn(
            "mt-2 flex gap-1.5 rounded-md border px-2 py-1.5 text-xs",
            notice.tone === "warning" ? "border-amber-500/40 bg-amber-500/10" : "border-primary/30 bg-primary/5",
          )}
        >
          {notice.tone === "warning" ? <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" /> : <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />}
          {notice.text}
        </p>
      ) : null}
    </>
  );
}
