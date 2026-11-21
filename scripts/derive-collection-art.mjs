// Derives the visual shelf's console and media art from the owner's reference set
// (design-references/, kept outside Git). Each reference is an SVG wrapping one
// 1024 × 1024 PNG on a transparent background. This extracts it, trims the empty margin,
// resizes it and writes an optimized WebP to src/assets/collection/, which the app imports.
// The label areas in src/components/shelf/media-shells.ts are measured on these trimmed
// images, so keep the trim when re-deriving.
//
//   node scripts/derive-collection-art.mjs <path to design-references>
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

const source = process.argv[2];
if (!source) {
  console.error("Usage: node scripts/derive-collection-art.mjs <path to design-references>");
  process.exit(1);
}

const OUT = join(import.meta.dirname, "..", "src", "assets", "collection");

// [reference file, output name, width]. Only the systems the preview shows.
const CONSOLES = [
  ["SNES", "snes"],
  ["NES", "nes"],
  ["Nintendo_64", "n64"],
  ["Game_Boy", "game-boy"],
  ["Sega_Mega_Drive", "mega-drive"],
  ["PlayStation_1", "playstation"],
  ["Sega_Saturn", "saturn"],
];
const MEDIA = [
  ["SNES_NTSC_U_Cartridge", "snes-ntsc-u"],
  ["SNES_PAL_Cartridge", "snes-pal"],
  ["NES_Cartridge", "nes"],
  ["Nintendo_64_Cartridge", "n64"],
  ["Game_Boy_Cartridge", "game-boy"],
  ["Sega_Mega_Drive_Genesis_Cartridge", "mega-drive"],
  ["PlayStation_1_Case", "playstation"],
  ["Sega_Saturn_Case", "saturn"],
];

async function derive(dir, file, name, width) {
  const svg = readFileSync(join(source, dir, `${file}.svg`), "utf8");
  const match = /href="data:image\/png;base64,([^"]+)"/.exec(svg);
  if (!match) throw new Error(`${dir}/${file}.svg has no embedded PNG`);
  const trimmed = await sharp(Buffer.from(match[1], "base64")).trim().toBuffer();
  const target = join(OUT, dir === "consoles" ? "consoles" : "media", `${name}.webp`);
  await sharp(trimmed).resize({ width, withoutEnlargement: true }).webp({ quality: 86, alphaQuality: 100, effort: 6 }).toFile(target);
  const { width: w, height: h } = await sharp(target).metadata();
  console.log(`${target.slice(OUT.length + 1)}\t${w}x${h}\t${(statSync(target).size / 1024).toFixed(0)} KB`);
}

mkdirSync(join(OUT, "consoles"), { recursive: true });
mkdirSync(join(OUT, "media"), { recursive: true });
for (const [file, name] of CONSOLES) await derive("consoles", file, name, 720);
for (const [file, name] of MEDIA) await derive("cartridges", file, name, 560);
