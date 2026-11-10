import { Disc3 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The cover frame GameCover uses, with a placeholder in place of artwork: the
 * catalog stores no cover images (M5 doesn't ingest artwork).
 */
export function CatalogCover({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative flex aspect-3/4 shrink-0 items-center justify-center overflow-hidden rounded-md bg-secondary shadow-sm ring-1 ring-white/10",
        className,
      )}
    >
      <Disc3 className="size-1/3 text-muted-foreground/60" />
    </div>
  );
}
