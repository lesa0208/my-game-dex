import type { StaticImageData } from "next/image";

import gameBoy from "@/assets/collection/media/game-boy.webp";
import megaDrive from "@/assets/collection/media/mega-drive.webp";
import n64 from "@/assets/collection/media/n64.webp";
import nes from "@/assets/collection/media/nes.webp";
import playstation from "@/assets/collection/media/playstation.webp";
import saturn from "@/assets/collection/media/saturn.webp";
import snesNtscU from "@/assets/collection/media/snes-ntsc-u.webp";
import snesPal from "@/assets/collection/media/snes-pal.webp";
import type { MediaKind, Region } from "@/features/shelf/browse";

// The physical shells, derived from the owner's references by
// scripts/derive-collection-art.mjs. Each records where its label (or case insert) sits,
// as percentages of the trimmed image, so a game's own artwork is a separate layer laid
// over the shell's placeholder label.

export type Shell = {
  image: StaticImageData;
  /** What the shell is, for the reference inventory and tests. */
  name: string;
  label: { left: number; top: number; width: number; height: number; radius: string };
};

const SHELLS = {
  "snes-ntsc-u": {
    image: snesNtscU,
    name: "16-bit cartridge, North American shell",
    label: { left: 19.8, top: 2, width: 57.6, height: 46.8, radius: "3% / 5%" },
  },
  "snes-pal": {
    image: snesPal,
    name: "16-bit cartridge, PAL and Japanese shell",
    label: { left: 12.6, top: 10.8, width: 76.8, height: 40, radius: "3% / 7%" },
  },
  nes: {
    image: nes,
    name: "8-bit cartridge",
    label: { left: 40.2, top: 5.4, width: 47, height: 65, radius: "2%" },
  },
  n64: {
    image: n64,
    name: "64-bit cartridge",
    label: { left: 26.2, top: 15.2, width: 47.8, height: 73.6, radius: "9% 9% 4% 4% / 6% 6% 3% 3%" },
  },
  "game-boy": {
    image: gameBoy,
    name: "Handheld cartridge",
    label: { left: 20.8, top: 32.8, width: 68.6, height: 49, radius: "3%" },
  },
  "mega-drive": {
    image: megaDrive,
    name: "16-bit cartridge, black shell",
    label: { left: 18.8, top: 3.5, width: 66, height: 84.5, radius: "2%" },
  },
  playstation: {
    image: playstation,
    name: "CD jewel case, spine insert",
    label: { left: 21, top: 4, width: 75, height: 92, radius: "0.5%" },
  },
  saturn: {
    image: saturn,
    name: "CD case, white spine band",
    label: { left: 35, top: 4, width: 61, height: 92, radius: "0.5%" },
  },
} satisfies Record<string, Shell>;

export type ShellKey = keyof typeof SHELLS;

/**
 * The shell a copy is drawn in. Regional shells differ only for the 16-bit Nintendo
 * cartridge: North America's is angular; PAL and Japanese copies share the rounded shell
 * (the Japanese one is approximated by the PAL reference).
 */
export function shellFor(kind: MediaKind, region: Region): Shell {
  switch (kind) {
    case "snes-cart":
      return SHELLS[region === "NTSC-U" ? "snes-ntsc-u" : "snes-pal"];
    case "nes-cart":
      return SHELLS.nes;
    case "n64-cart":
      return SHELLS.n64;
    case "gb-cart":
      return SHELLS["game-boy"];
    case "md-cart":
      return SHELLS["mega-drive"];
    case "ps1-case":
      return SHELLS.playstation;
    default:
      return SHELLS.saturn;
  }
}
