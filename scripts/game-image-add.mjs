// Adds one approved image of a game's physical item to the registry (M17b, ADR-017).
//
//   npm run media:add -- --file=<photo> --game=<slug> --platform=<slug> [--region=<code>] \
//     [--release=<uuid>] --kind=cartridge|case|box|disc|card --alt="…" \
//     --source-name="…" [--source-url=https://…] --license=licensed|user_contributed|public_domain \
//     --license-detail="…" [--attribution="…"] --approved-by="…"
//
// Only for an image we have the right to show: one we're licensed to use, one its owner
// photographed and agreed to, or one in the public domain. Being publicly reachable is
// not permission, and neither is a metadata licence (No-Intro, Redump) or a provider's
// API access. The image is decoded and re-encoded with sharp (which drops location and
// other metadata), sized to at most 1600 pixels, and saved under public/game-images/; the
// entry is checked with the same rules as the registry test before it's written.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import sharp from "sharp";

import { imageProblems } from "../src/features/media/game-images.ts";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const at = a.indexOf("=");
      return at < 0 ? [a.slice(2), ""] : [a.slice(2, at), a.slice(at + 1)];
    }),
);
const need = ["file", "game", "platform", "kind", "alt", "source-name", "license", "license-detail", "approved-by"];
const missing = need.filter((k) => !args[k]?.trim());
if (missing.length) {
  console.error(`Missing: ${missing.map((k) => `--${k}`).join(", ")}. See the comment at the top of this script.`);
  process.exit(1);
}

const ROOT = join(import.meta.dirname, "..");
const REGISTRY = join(ROOT, "src", "assets", "game-images", "registry.json");
const region = args.region?.trim() || null;
const id = [args.platform, region ?? "any", args.kind, args.release ? args.release.slice(0, 8) : null].filter(Boolean).join("-");
const file = `game-images/${args.game}/${id}.webp`;

const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
if (registry.images.some((i) => i.id === id && i.game === args.game)) {
  console.error(`The registry already has ${args.game} / ${id}. Remove it first to replace it.`);
  process.exit(1);
}

const target = join(ROOT, "public", file);
mkdirSync(dirname(target), { recursive: true });
const { width, height } = await sharp(args.file).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 88, effort: 6 }).toFile(target);

const entry = {
  id,
  game: args.game,
  platform: args.platform,
  region,
  release: args.release?.trim() || null,
  kind: args.kind,
  file,
  width,
  height,
  alt: args.alt.trim(),
  source: { name: args["source-name"].trim(), url: args["source-url"]?.trim() || null },
  license: args.license,
  licenseDetail: args["license-detail"].trim(),
  attribution: args.attribution?.trim() || null,
  approvedBy: args["approved-by"].trim(),
  approvedOn: new Date().toISOString().slice(0, 10),
};
const problems = imageProblems(entry);
if (problems.length) {
  console.error(`Not added: ${problems.join(", ")}.`);
  process.exit(1);
}
registry.images.push(entry);
writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Added ${args.game} / ${id} (${width}×${height}). Review the registry diff before committing.`);
