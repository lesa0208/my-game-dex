import { Disc3 } from "lucide-react";

import type { Release } from "@/types/game";

export function formatReleaseMeta(release: Release) {
  return `${release.platform.name} · ${release.region} · ${release.year}`;
}

/** Compact reference to the game and platform a post relates to. */
export function ReleaseTag({ release }: { release: Release }) {
  return (
    <p className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground">
      <Disc3 aria-hidden="true" className="size-3.5 shrink-0 text-highlight" />
      <span className="truncate">
        <span className="font-medium text-foreground">{release.game.title}</span>
        {" · "}
        {release.platform.shortName}
      </span>
    </p>
  );
}
