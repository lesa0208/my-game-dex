import type { Platform, Release, ReleaseRegion } from "@/types/game";

const platforms = {
  snes: { id: "snes", name: "Super Nintendo", shortName: "SNES" },
  ps1: { id: "ps1", name: "PlayStation", shortName: "PS1" },
  saturn: { id: "saturn", name: "Sega Saturn", shortName: "Saturn" },
  dreamcast: { id: "dreamcast", name: "Dreamcast", shortName: "DC" },
  n64: { id: "n64", name: "Nintendo 64", shortName: "N64" },
  gamecube: { id: "gamecube", name: "GameCube", shortName: "GCN" },
  ps2: { id: "ps2", name: "PlayStation 2", shortName: "PS2" },
  ps5: { id: "ps5", name: "PlayStation 5", shortName: "PS5" },
} satisfies Record<string, Platform>;

function release(
  slug: string,
  title: string,
  platform: Platform,
  region: ReleaseRegion,
  year: number,
  edition?: string,
): Release {
  return {
    id: slug,
    game: { id: slug.replace(`-${platform.id}`, ""), title },
    platform,
    region,
    year,
    edition,
    coverUrl: `/seed/covers/${slug}.svg`,
  };
}

export const releases = {
  earthbound: release("earthbound-snes", "EarthBound", platforms.snes, "NA", 1995, "Big box"),
  chronoTrigger: release("chrono-trigger-snes", "Chrono Trigger", platforms.snes, "NA", 1995),
  metalGearSolid: release("metal-gear-solid-ps1", "Metal Gear Solid", platforms.ps1, "NA", 1998, "Greatest Hits"),
  symphonyOfTheNight: release("symphony-of-the-night-ps1", "Castlevania: Symphony of the Night", platforms.ps1, "NA", 1997),
  panzerDragoonSaga: release("panzer-dragoon-saga-saturn", "Panzer Dragoon Saga", platforms.saturn, "NA", 1998),
  radiantSilvergun: release("radiant-silvergun-saturn", "Radiant Silvergun", platforms.saturn, "JP", 1998),
  shenmue: release("shenmue-dreamcast", "Shenmue", platforms.dreamcast, "NA", 2000),
  ocarinaOfTime: release("ocarina-of-time-n64", "The Legend of Zelda: Ocarina of Time", platforms.n64, "NA", 1998, "Collector's Edition"),
  metroidPrime: release("metroid-prime-gamecube", "Metroid Prime", platforms.gamecube, "NA", 2002),
  shadowOfTheColossus: release("shadow-of-the-colossus-ps2", "Shadow of the Colossus", platforms.ps2, "NA", 2005),
  eldenRing: release("elden-ring-ps5", "Elden Ring", platforms.ps5, "NA", 2022),
};
