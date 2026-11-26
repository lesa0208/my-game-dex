import { ConsoleArt } from "@/components/shelf/console-art";
import { GameMedia } from "@/components/shelf/game-media";
import { Cabinet, ShelfBoard, ShelfLight } from "@/components/shelf/shelf-parts";
import type { ConsoleKind, MediaKind, Region } from "@/features/shelf/browse";
import { cn } from "@/lib/utils";

// An illustration of the collection, on the approved console, shelf and media art: never a
// collection of anyone's, so it carries no titles, counts, regions or release details, and
// it says it's an example where it's shown.

const CONSOLES: readonly { kind: ConsoleKind; label: string }[] = [
  { kind: "snes", label: "SNES" },
  { kind: "megadrive", label: "Mega Drive" },
  { kind: "playstation", label: "PlayStation" },
  { kind: "n64", label: "Nintendo 64" },
  { kind: "gameboy", label: "Game Boy" },
];

/** Blank labels: shells only, standing as they would on a shelf. */
const MEDIA: readonly { kind: MediaKind; region: Region; system: string; width: string }[] = [
  { kind: "snes-cart", region: "NTSC-U", system: "SNES", width: "18%" },
  { kind: "md-cart", region: "NTSC-U", system: "Mega Drive", width: "13%" },
  { kind: "ps1-case", region: "NTSC-U", system: "PlayStation", width: "15%" },
  { kind: "n64-cart", region: "NTSC-U", system: "N64", width: "16%" },
  { kind: "gb-cart", region: "NTSC-U", system: "Game Boy", width: "10%" },
];

/** A row of consoles on one shelf board. `count` takes the first few. */
export function ConsoleRow({ count = CONSOLES.length, large = false, className }: { count?: number; large?: boolean; className?: string }) {
  return (
    <div className={cn("relative", className)}>
      <ShelfLight />
      <div className={cn("relative flex items-end justify-around gap-2 px-4", large ? "pt-8" : "pt-6")}>
        {CONSOLES.slice(0, count).map(({ kind }) => (
          <ConsoleArt
            key={kind}
            kind={kind}
            sizes="160px"
            className={cn(large ? "h-24 sm:h-28" : "h-16 sm:h-20", kind === "gameboy" ? "w-[9%]" : large ? "w-[26%]" : "w-[17%]")}
          />
        ))}
      </div>
      <ShelfBoard className="mt-1" />
    </div>
  );
}

/** Two shelves: consoles on top, their games below. */
export function ExampleShelf({ className }: { className?: string }) {
  return (
    <figure className={cn("relative", className)}>
      <Cabinet>
        <ConsoleRow count={3} large />
        <div className="relative">
          <ShelfLight />
          <div className="relative flex items-end justify-center gap-[3%] px-4 pt-7">
            {MEDIA.map((m) => (
              <div key={m.kind} style={{ width: m.width }}>
                <GameMedia media={{ kind: m.kind, region: m.region }} seed={`example-${m.kind}`} title="" systemLabel={m.system} sizes="120px" />
              </div>
            ))}
          </div>
          <ShelfBoard className="mt-1" />
        </div>
      </Cabinet>
      <span className="absolute top-4 left-4 rounded-full border border-white/15 bg-black/60 px-2.5 py-1 text-[0.7rem] font-semibold tracking-[0.14em] text-white/85 uppercase backdrop-blur-sm">
        Example
      </span>
      <figcaption className="mt-2 text-center text-xs text-muted-foreground">An example of collection shelves. Not anyone&apos;s collection.</figcaption>
    </figure>
  );
}
