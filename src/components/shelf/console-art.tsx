import Image, { type StaticImageData } from "next/image";

import gameBoy from "@/assets/collection/consoles/game-boy.webp";
import gameBoyAdvance from "@/assets/collection/consoles/game-boy-advance.webp";
import gameBoyColor from "@/assets/collection/consoles/game-boy-color.webp";
import megaDrive from "@/assets/collection/consoles/mega-drive.webp";
import n64 from "@/assets/collection/consoles/n64.webp";
import nes from "@/assets/collection/consoles/nes.webp";
import playstation from "@/assets/collection/consoles/playstation.webp";
import playstation2 from "@/assets/collection/consoles/playstation-2.webp";
import saturn from "@/assets/collection/consoles/saturn.webp";
import snes from "@/assets/collection/consoles/snes.webp";
import type { ConsoleKind } from "@/features/shelf/browse";
import { cn } from "@/lib/utils";

// Console art from the owner's reference set (scripts/derive-collection-art.mjs): one
// image per hardware model, trimmed to the object on a transparent background.

const CONSOLES: Record<ConsoleKind, StaticImageData> = {
  snes,
  nes,
  n64,
  gameboy: gameBoy,
  gbc: gameBoyColor,
  gba: gameBoyAdvance,
  megadrive: megaDrive,
  playstation,
  ps2: playstation2,
  saturn,
};

/**
 * Fills the box its className gives it, contained and standing on the box's bottom edge,
 * so portrait handhelds and wide consoles share one scale. Decorative: the system's name
 * is always shown as text beside it.
 */
export function ConsoleArt({
  kind,
  className,
  style,
  sizes = "320px",
  priority = false,
}: {
  kind: ConsoleKind;
  className?: string;
  style?: React.CSSProperties;
  sizes?: string;
  priority?: boolean;
}) {
  return (
    // A span, so it can sit inside text such as a paragraph.
    <span aria-hidden="true" className={cn("relative block", className)} style={style}>
      <Image src={CONSOLES[kind]} alt="" fill sizes={sizes} priority={priority} draggable={false} className="object-contain object-bottom" />
    </span>
  );
}

/** The system tile's shape: width over height (aspect-16/10 in system-tile.tsx). */
const TILE_ASPECT = 16 / 10;

/**
 * The console's box on a system tile, as percentages of the tile, sized so every console
 * has about the same visual area whatever its shape: a wide console isn't shrunk to a
 * sliver, and a tall handheld doesn't tower over the name.
 */
export function consoleTileBox(kind: ConsoleKind) {
  const { width, height } = CONSOLES[kind];
  const aspect = width / height;
  const area = 0.2; // of the tile's width squared
  const maxHeight = 0.72 / TILE_ASPECT;
  const maxWidth = 0.6;
  let w = Math.sqrt(area * aspect);
  let h = Math.sqrt(area / aspect);
  if (h > maxHeight) [h, w] = [maxHeight, maxHeight * aspect];
  if (w > maxWidth) [w, h] = [maxWidth, maxWidth / aspect];
  return { width: `${(w * 100).toFixed(1)}%`, height: `${((h * TILE_ASPECT) * 100).toFixed(1)}%` };
}
