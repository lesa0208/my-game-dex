import type { StaticImageData } from "next/image";

import manifest from "@/assets/collection/manifest.json";
import gameBoy from "@/assets/collection/media/game-boy.webp";
import megaDrive from "@/assets/collection/media/mega-drive.webp";
import n64 from "@/assets/collection/media/n64.webp";
import nes from "@/assets/collection/media/nes.webp";
import playstation from "@/assets/collection/media/playstation.webp";
import saturn from "@/assets/collection/media/saturn.webp";
import snesNtscU from "@/assets/collection/media/snes-ntsc-u.webp";
import snesPal from "@/assets/collection/media/snes-pal.webp";
import type { MediaKind, Region } from "@/features/shelf/browse";

// The physical shells, made by scripts/derive-collection-art.mjs: cartridges derived
// from the owner's references, disc cases drawn as exact front-view geometry around
// their references' printed spine bands. The script also writes each label recess (or
// case cover) to manifest.json as percentages of the image. A game's own artwork is a
// separate layer laid over that recess.

type ShellKey = keyof typeof manifest.media;

export type Shell = {
  image: StaticImageData;
  label: { left: number; top: number; width: number; height: number };
  /** The recess's corner rounding, in CSS. */
  radius: string;
  /** A disc case: the insert sits behind clear plastic, so it gets a stronger sheen. */
  isCase: boolean;
};

const IMAGES: Record<ShellKey, StaticImageData> = {
  "snes-ntsc-u": snesNtscU,
  "snes-pal": snesPal,
  nes,
  n64,
  "game-boy": gameBoy,
  "mega-drive": megaDrive,
  playstation,
  saturn,
};

const RADIUS: Record<ShellKey, string> = {
  "snes-ntsc-u": "2% / 3%",
  "snes-pal": "3% / 7%",
  nes: "2%",
  n64: "9% 9% 4% 4% / 6% 6% 3% 3%",
  "game-boy": "3%",
  "mega-drive": "2%",
  playstation: "0.5%",
  saturn: "0.5%",
};

const CASE_KEYS: ReadonlySet<ShellKey> = new Set(["playstation", "saturn"]);

function shell(key: ShellKey): Shell {
  return { image: IMAGES[key], label: manifest.media[key].label, radius: RADIUS[key], isCase: CASE_KEYS.has(key) };
}

const KEYS: Record<MediaKind, readonly ShellKey[]> = {
  "snes-cart": ["snes-ntsc-u", "snes-pal"],
  "nes-cart": ["nes"],
  "n64-cart": ["n64"],
  "gb-cart": ["game-boy"],
  "md-cart": ["mega-drive"],
  "ps1-case": ["playstation"],
  "saturn-case": ["saturn"],
};

/**
 * The shell a copy is drawn in. Regional shells differ only for the 16-bit Nintendo
 * cartridge: North America's is angular; PAL and Japanese copies share the rounded shell
 * (the Japanese one is approximated by the PAL reference).
 */
export function shellFor(kind: MediaKind, region: Region): Shell {
  if (kind === "snes-cart") return shell(region === "NTSC-U" ? "snes-ntsc-u" : "snes-pal");
  return shell(KEYS[kind][0]);
}

/** Disc media in a jewel case, as opposed to a cartridge. */
export function isDiscCase(kind: MediaKind) {
  return kind === "ps1-case" || kind === "saturn-case";
}

/**
 * Width over height of a box that holds every shell of this kind at full width, so mixed
 * regional shells stand on one baseline and their captions line up.
 */
export function frameAspect(kind: MediaKind) {
  return Math.min(...KEYS[kind].map((key) => manifest.media[key].width / manifest.media[key].height));
}
