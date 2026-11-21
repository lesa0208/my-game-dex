import Image, { type StaticImageData } from "next/image";

import gameBoy from "@/assets/collection/consoles/game-boy.webp";
import megaDrive from "@/assets/collection/consoles/mega-drive.webp";
import n64 from "@/assets/collection/consoles/n64.webp";
import nes from "@/assets/collection/consoles/nes.webp";
import playstation from "@/assets/collection/consoles/playstation.webp";
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
  megadrive: megaDrive,
  playstation,
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
  sizes = "320px",
  priority = false,
}: {
  kind: ConsoleKind;
  className?: string;
  sizes?: string;
  priority?: boolean;
}) {
  return (
    // A span, so it can sit inside text such as a paragraph.
    <span aria-hidden="true" className={cn("relative block", className)}>
      <Image src={CONSOLES[kind]} alt="" fill sizes={sizes} priority={priority} draggable={false} className="object-contain object-bottom" />
    </span>
  );
}
