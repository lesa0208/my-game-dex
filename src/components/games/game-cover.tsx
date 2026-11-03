import Image from "next/image";

import { cn } from "@/lib/utils";
import type { Release } from "@/types/game";

export function GameCover({
  release,
  sizes,
  className,
  isAboveFold = false,
}: {
  release: Release;
  /** Rendered width, for example "(min-width: 768px) 176px, 144px". */
  sizes: string;
  className?: string;
  isAboveFold?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative aspect-3/4 shrink-0 overflow-hidden rounded-md bg-secondary shadow-sm ring-1 ring-white/10",
        className,
      )}
    >
      <Image
        src={release.coverUrl}
        alt={`${release.game.title} cover art`}
        fill
        sizes={sizes}
        loading={isAboveFold ? "eager" : "lazy"}
        className="object-cover"
      />
    </div>
  );
}
