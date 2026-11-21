// Mock collection for the visual shelf preview (visual-collection-shelf). Development
// placeholders only: not catalog records, not a real collector's copies, and never mixed
// into collection statistics. Read through src/features/shelf/queries.ts, which returns
// nothing unless seed data is enabled.
import type { Completeness, Condition, Region, ShelfGame, ShelfSystem } from "@/features/shelf/browse";

export const shelfSystems: readonly ShelfSystem[] = [
  { slug: "snes", name: "Super Nintendo Entertainment System", shortName: "SNES", maker: "Nintendo", released: 1990, media: "snes-cart", console: "snes", accent: ["#8b5cf6", "#c4b5fd"] },
  { slug: "nes", name: "Nintendo Entertainment System", shortName: "NES", maker: "Nintendo", released: 1983, media: "nes-cart", console: "nes", accent: ["#ef4444", "#fca5a5"] },
  { slug: "n64", name: "Nintendo 64", shortName: "N64", maker: "Nintendo", released: 1996, media: "n64-cart", console: "n64", accent: ["#22c55e", "#facc15"] },
  { slug: "game-boy", name: "Game Boy", shortName: "Game Boy", maker: "Nintendo", released: 1989, media: "gb-cart", console: "gameboy", accent: ["#a3e635", "#d9f99d"] },
  { slug: "mega-drive", name: "Mega Drive / Genesis", shortName: "Mega Drive", maker: "Sega", released: 1988, media: "md-cart", console: "megadrive", accent: ["#3b82f6", "#93c5fd"] },
  { slug: "playstation", name: "PlayStation", shortName: "PlayStation", maker: "Sony", released: 1994, media: "disc-case", console: "playstation", accent: ["#38bdf8", "#e879f9"] },
  { slug: "saturn", name: "Sega Saturn", shortName: "Saturn", maker: "Sega", released: 1994, media: "disc-case", console: "saturn", accent: ["#64748b", "#cbd5e1"] },
];

type Row = [title: string, year: number, genre: string, publisher: string, region: Region, completeness: Completeness, condition: Condition, acquired: string, extra?: { copies?: number; favorite?: boolean; notes?: string }];

function slugify(title: string) {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function games(rows: readonly Row[]): ShelfGame[] {
  return rows.map(([title, year, genre, publisher, region, completeness, condition, acquired, extra]) => ({
    slug: slugify(title),
    title,
    year,
    genre,
    publisher,
    region,
    completeness,
    condition,
    acquired,
    copies: extra?.copies ?? 1,
    favorite: extra?.favorite ?? false,
    notes: extra?.notes,
  }));
}

export const shelfGames: Readonly<Record<string, readonly ShelfGame[]>> = {
  snes: games([
    ["ActRaiser", 1990, "Action / Simulation", "Enix", "NTSC-U", "cib", "very_good", "2023-02-11"],
    ["Breath of Fire II", 1994, "RPG", "Capcom", "NTSC-U", "boxed", "good", "2023-08-19"],
    ["Chrono Trigger", 1995, "RPG", "Square", "NTSC-U", "cib", "very_good", "2022-11-04", { favorite: true, notes: "Original box, manual and map. Box corners lightly worn." }],
    ["Contra III: The Alien Wars", 1992, "Run and gun", "Konami", "NTSC-U", "loose", "good", "2024-01-06"],
    ["Demon's Crest", 1994, "Action", "Capcom", "NTSC-U", "loose", "very_good", "2024-05-21"],
    ["Donkey Kong Country", 1994, "Platformer", "Nintendo", "PAL", "cib", "good", "2021-12-24", { copies: 2 }],
    ["EarthBound", 1995, "RPG", "Nintendo", "NTSC-U", "cib", "mint", "2024-09-02", { favorite: true, notes: "Big box with both strategy guide sleeves." }],
    ["F-Zero", 1990, "Racing", "Nintendo", "PAL", "loose", "fair", "2020-07-15"],
    ["Final Fantasy III", 1994, "RPG", "Square", "NTSC-U", "cib", "good", "2022-03-30", { favorite: true }],
    ["Illusion of Gaia", 1994, "Action RPG", "Nintendo", "PAL", "boxed", "very_good", "2023-06-10"],
    ["Kirby Super Star", 1996, "Platformer", "Nintendo", "NTSC-U", "loose", "good", "2024-02-17"],
    ["The Legend of Zelda: A Link to the Past", 1991, "Action-adventure", "Nintendo", "NTSC-U", "cib", "very_good", "2021-05-08", { favorite: true }],
    ["Mega Man X", 1993, "Action platformer", "Capcom", "NTSC-U", "boxed", "good", "2022-08-27"],
    ["Ogre Battle", 1993, "Strategy RPG", "Enix", "NTSC-U", "loose", "good", "2023-11-12"],
    ["Pilotwings", 1990, "Flight", "Nintendo", "PAL", "cib", "very_good", "2020-10-03"],
    ["Secret of Mana", 1993, "Action RPG", "Square", "PAL", "cib", "good", "2022-01-14", { favorite: true }],
    ["Star Fox", 1993, "Rail shooter", "Nintendo", "PAL", "boxed", "fair", "2019-12-25"],
    ["Street Fighter II Turbo", 1993, "Fighting", "Capcom", "NTSC-U", "loose", "good", "2021-09-18"],
    ["Super Castlevania IV", 1991, "Action platformer", "Konami", "NTSC-U", "cib", "very_good", "2023-04-01", { favorite: true }],
    ["Super Mario All-Stars", 1993, "Platformer", "Nintendo", "PAL", "loose", "good", "2019-12-25"],
    ["Super Mario Kart", 1992, "Racing", "Nintendo", "PAL", "cib", "good", "2020-02-29", { copies: 2 }],
    ["Super Mario RPG", 1996, "RPG", "Nintendo", "NTSC-U", "cib", "very_good", "2023-09-23", { favorite: true }],
    ["Super Mario World", 1990, "Platformer", "Nintendo", "PAL", "loose", "fair", "2019-12-25"],
    ["Super Metroid", 1994, "Action-adventure", "Nintendo", "NTSC-U", "cib", "mint", "2024-10-12", { favorite: true, notes: "Sealed-style reseal noted by seller; inspect before grading." }],
    ["Super Punch-Out!!", 1994, "Sports", "Nintendo", "NTSC-U", "loose", "very_good", "2024-03-09"],
    ["Tactics Ogre", 1995, "Strategy RPG", "Quest", "NTSC-J", "cib", "good", "2024-07-27"],
    ["Terranigma", 1996, "Action RPG", "Enix", "PAL", "cib", "very_good", "2023-12-02", { favorite: true }],
    ["Uniracers", 1994, "Racing", "Nintendo", "NTSC-U", "loose", "good", "2022-05-07"],
    ["Wild Arms", 1996, "RPG", "Media Vision", "NTSC-J", "boxed", "good", "2024-08-15"],
    ["Yoshi's Island", 1995, "Platformer", "Nintendo", "PAL", "cib", "very_good", "2021-03-20", { favorite: true }],
    ["Zombies Ate My Neighbors", 1993, "Run and gun", "Konami", "NTSC-U", "loose", "good", "2022-10-31"],
    ["Seiken Densetsu 3", 1995, "Action RPG", "Square", "NTSC-J", "loose", "very_good", "2024-06-01"],
  ]),
  nes: games([
    ["Castlevania", 1986, "Action platformer", "Konami", "PAL", "loose", "good", "2020-04-11"],
    ["Duck Tales", 1989, "Platformer", "Capcom", "NTSC-U", "cib", "very_good", "2022-06-18", { favorite: true }],
    ["Kirby's Adventure", 1993, "Platformer", "Nintendo", "PAL", "loose", "good", "2021-08-08"],
    ["The Legend of Zelda", 1986, "Action-adventure", "Nintendo", "NTSC-U", "boxed", "good", "2023-01-21", { favorite: true }],
    ["Mega Man 2", 1988, "Action platformer", "Capcom", "NTSC-U", "loose", "fair", "2020-11-27"],
    ["Metroid", 1986, "Action-adventure", "Nintendo", "PAL", "loose", "good", "2022-02-05"],
    ["Punch-Out!!", 1987, "Sports", "Nintendo", "NTSC-U", "loose", "very_good", "2023-07-14"],
    ["Super Mario Bros. 3", 1988, "Platformer", "Nintendo", "PAL", "cib", "good", "2019-12-25", { favorite: true }],
    ["Tetris", 1989, "Puzzle", "Nintendo", "PAL", "loose", "good", "2021-01-09"],
  ]),
  n64: games([
    ["Banjo-Kazooie", 1998, "Platformer", "Rare", "PAL", "cib", "very_good", "2022-12-17", { favorite: true }],
    ["GoldenEye 007", 1997, "Shooter", "Rare", "PAL", "loose", "good", "2021-04-03"],
    ["Mario Kart 64", 1996, "Racing", "Nintendo", "PAL", "loose", "good", "2020-12-25"],
    ["Paper Mario", 2000, "RPG", "Nintendo", "NTSC-U", "boxed", "very_good", "2024-04-20"],
    ["Super Mario 64", 1996, "Platformer", "Nintendo", "PAL", "cib", "good", "2020-12-25", { favorite: true }],
    ["The Legend of Zelda: Ocarina of Time", 1998, "Action-adventure", "Nintendo", "PAL", "cib", "very_good", "2021-11-21", { favorite: true }],
  ]),
  "game-boy": games([
    ["Kirby's Dream Land", 1992, "Platformer", "Nintendo", "PAL", "loose", "good", "2021-06-12"],
    ["The Legend of Zelda: Link's Awakening", 1993, "Action-adventure", "Nintendo", "PAL", "boxed", "good", "2022-09-10", { favorite: true }],
    ["Metroid II", 1991, "Action-adventure", "Nintendo", "NTSC-U", "loose", "fair", "2023-03-04"],
    ["Super Mario Land 2", 1992, "Platformer", "Nintendo", "PAL", "cib", "very_good", "2020-08-22"],
    ["Tetris", 1989, "Puzzle", "Nintendo", "PAL", "loose", "good", "2019-06-01", { copies: 3 }],
    ["Wario Land", 1994, "Platformer", "Nintendo", "PAL", "loose", "good", "2024-01-27"],
  ]),
  "mega-drive": games([
    ["Gunstar Heroes", 1993, "Run and gun", "Sega", "PAL", "cib", "very_good", "2023-05-13", { favorite: true }],
    ["Phantasy Star IV", 1993, "RPG", "Sega", "NTSC-U", "boxed", "good", "2024-02-24"],
    ["Shinobi III", 1993, "Action", "Sega", "PAL", "cib", "good", "2022-07-02"],
    ["Sonic the Hedgehog 2", 1992, "Platformer", "Sega", "PAL", "loose", "good", "2020-03-14", { copies: 2 }],
    ["Streets of Rage 2", 1992, "Beat 'em up", "Sega", "PAL", "cib", "very_good", "2021-10-16", { favorite: true }],
  ]),
  playstation: games([
    ["Castlevania: Symphony of the Night", 1997, "Action-adventure", "Konami", "NTSC-U", "cib", "very_good", "2023-10-28", { favorite: true }],
    ["Crash Bandicoot", 1996, "Platformer", "Sony", "PAL", "cib", "good", "2020-05-30"],
    ["Final Fantasy VII", 1997, "RPG", "Square", "PAL", "cib", "good", "2021-02-13", { favorite: true }],
    ["Metal Gear Solid", 1998, "Stealth", "Konami", "PAL", "cib", "very_good", "2022-04-23"],
    ["Spyro the Dragon", 1998, "Platformer", "Sony", "PAL", "cib", "fair", "2020-09-05"],
  ]),
  saturn: [],
};
