/**
 * Generates the original placeholder artwork used by development seed data.
 *
 * Output goes to public/seed/. Run with: npm run seed:art
 *
 * Nothing here is real box art. Commercial cover art has licensing requirements
 * that must be cleared per provider before use, so the preview data ships with
 * artwork drawn entirely by this script.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "seed");

function createRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(value) {
  return [...value].reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) | 0, 7);
}

const rect = (x, y, width, height, fill, extra = "") =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" ${extra}/>`;
const circle = (cx, cy, r, fill, extra = "") =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${extra}/>`;
const polygon = (points, fill, extra = "") =>
  `<polygon points="${points}" fill="${fill}" ${extra}/>`;

function scatter(seed, count, draw) {
  const random = createRandom(seed);
  return Array.from({ length: count }, () => draw(random)).join("");
}

const stars = (seed, count, color = "#ffffff") =>
  scatter(seed, count, (random) => {
    const size = random() > 0.8 ? 3 : 2;
    const x = Math.floor(random() * 300);
    const y = 40 + Math.floor(random() * 240);
    return rect(x, y, size, size, color, `opacity="${(0.3 + random() * 0.6).toFixed(2)}"`);
  });

const motifs = {
  earthbound: () =>
    stars(11, 40, "#fde68a") +
    polygon("120,150 180,150 236,330 64,330", "#fde68a", 'opacity="0.2"') +
    `<ellipse cx="150" cy="140" rx="74" ry="20" fill="#e5e7eb"/>` +
    `<ellipse cx="150" cy="128" rx="32" ry="24" fill="#93c5fd"/>` +
    [100, 125, 150, 175, 200].map((x) => circle(x, 143, 4, "#f59e0b")).join("") +
    polygon("0,330 34,330 34,296 62,296 62,316 92,316 92,284 126,284 126,322 180,322 180,300 214,300 214,316 252,316 252,288 300,288 300,400 0,400", "#450a0a"),
  chrono: () => {
    const ticks = Array.from({ length: 24 }, (_, index) => {
      const angle = (index * Math.PI) / 12;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return `<line x1="${150 + cos * 98}" y1="${170 + sin * 98}" x2="${150 + cos * 114}" y2="${170 + sin * 114}" stroke="#fbbf24" stroke-width="${index % 2 ? 2 : 5}"/>`;
    }).join("");
    return (
      stars(23, 30, "#bfdbfe") +
      circle(150, 170, 118, "none", 'stroke="#fbbf24" stroke-width="3"') +
      circle(150, 170, 92, "#1e3a8a", 'stroke="#fbbf24" stroke-width="2"') +
      ticks +
      `<line x1="150" y1="170" x2="150" y2="96" stroke="#fde68a" stroke-width="5"/>` +
      `<line x1="150" y1="170" x2="202" y2="196" stroke="#fde68a" stroke-width="5"/>` +
      circle(150, 170, 8, "#fbbf24")
    );
  },
  radar: () => {
    const grid = Array.from({ length: 12 }, (_, index) => {
      const offset = 34 + index * 30;
      return `<line x1="0" y1="${offset}" x2="300" y2="${offset}" stroke="#22c55e" opacity="0.14"/><line x1="${index * 30}" y1="34" x2="${index * 30}" y2="400" stroke="#22c55e" opacity="0.14"/>`;
    }).join("");
    return (
      grid +
      [40, 80, 120].map((r) => circle(150, 170, r, "none", 'stroke="#4ade80" opacity="0.55" stroke-width="2"')).join("") +
      polygon("150,170 270,170 240,90", "#4ade80", 'opacity="0.35"') +
      circle(198, 138, 6, "#f87171") +
      circle(110, 214, 5, "#4ade80") +
      circle(150, 170, 5, "#bbf7d0")
    );
  },
  castle: () =>
    circle(150, 142, 92, "#fecaca", 'opacity="0.92"') +
    stars(37, 26, "#fecaca") +
    polygon("0,320 0,244 24,244 24,214 38,186 52,214 52,250 84,250 84,190 100,154 116,190 116,232 138,232 138,120 152,84 166,120 166,232 190,232 190,176 206,144 222,176 222,250 256,250 256,212 270,184 284,212 284,244 300,244 300,320", "#1a0510") +
    rect(0, 320, 300, 80, "#1a0510"),
  dragon: () =>
    circle(214, 112, 46, "#fef3c7", 'opacity="0.85"') +
    polygon("0,300 70,262 150,296 230,250 300,290 300,400 0,400", "#b45309") +
    polygon("0,344 90,306 190,346 300,312 300,400 0,400", "#78350f") +
    polygon("54,202 112,168 146,176 176,132 244,104 202,160 226,158 184,190 152,204 124,226 92,216", "#1c1917"),
  ship: () => {
    const pixel = 9;
    const shape = ["....#....", "...###...", "...#.#...", "..#####..", ".#######.", "###.#.###", "#...#...#"];
    const ship = shape
      .flatMap((row, y) =>
        [...row].map((cell, x) => (cell === "#" ? rect(110 + x * pixel, 212 + y * pixel, pixel, pixel, "#e0f2fe") : "")),
      )
      .join("");
    return (
      stars(53, 60) +
      rect(138, 34, 24, 180, "#38bdf8", 'opacity="0.3"') +
      rect(146, 34, 8, 180, "#e0f2fe") +
      ship +
      circle(70, 104, 16, "#f43f5e") +
      circle(232, 78, 12, "#f43f5e") +
      circle(238, 150, 9, "#f97316")
    );
  },
  street: () =>
    scatter(61, 46, (random) => circle(Math.floor(random() * 300), 36 + Math.floor(random() * 280), 1 + random() * 2, "#e0f2fe", `opacity="${(0.4 + random() * 0.5).toFixed(2)}"`)) +
    polygon("0,84 110,190 110,330 0,400", "#0f172a") +
    polygon("300,84 190,190 190,330 300,400", "#0b1220") +
    polygon("110,330 190,330 300,400 0,400", "#334155") +
    [
      [34, 158],
      [70, 186],
      [262, 158],
      [226, 186],
    ]
      .map(([x, y]) => `<rect x="${x - 9}" y="${y}" width="18" height="26" rx="6" fill="#f87171"/>${rect(x - 2, y - 6, 4, 6, "#fecaca")}`)
      .join("") +
    circle(150, 196, 22, "#fde68a", 'opacity="0.25"'),
  sunburst: () => {
    const rays = Array.from({ length: 16 }, (_, index) => {
      const a = (index * Math.PI) / 8;
      const b = a + Math.PI / 16;
      return polygon(`150,184 ${150 + Math.cos(a) * 340},${184 + Math.sin(a) * 340} ${150 + Math.cos(b) * 340},${184 + Math.sin(b) * 340}`, "#fde68a", 'opacity="0.22"');
    }).join("");
    return (
      rays +
      circle(150, 184, 54, "#fef3c7") +
      polygon("0,292 66,244 136,288 206,232 300,288 300,400 0,400", "#134e4a") +
      polygon("0,340 96,296 200,340 300,308 300,400 0,400", "#042f2e")
    );
  },
  planet: () =>
    stars(71, 40, "#fed7aa") +
    circle(150, 196, 104, "#c2410c") +
    circle(120, 170, 104, "#ea580c", 'opacity="0.55"') +
    `<ellipse cx="150" cy="196" rx="146" ry="24" fill="none" stroke="#5eead4" stroke-width="3" opacity="0.8"/>` +
    polygon("20,296 70,258 230,258 280,296 250,332 50,332", "#0f766e", 'opacity="0.35"') +
    polygon("70,272 230,272 212,286 88,286", "#5eead4", 'opacity="0.8"'),
  colossus: () =>
    polygon("86,330 86,226 62,226 62,164 98,164 98,128 126,128 126,86 174,86 174,128 208,128 208,172 240,172 240,232 214,232 214,330", "#1f2937") +
    rect(110, 60, 80, 34, "#1f2937") +
    rect(128, 102, 12, 8, "#bae6fd") +
    rect(160, 102, 12, 8, "#bae6fd") +
    polygon("0,300 300,286 300,400 0,400", "#475569") +
    rect(244, 277, 12, 10, "#111827") +
    rect(252, 269, 4, 10, "#111827"),
  rings: () =>
    circle(150, 182, 118, "none", 'stroke="#f59e0b" stroke-width="3" stroke-dasharray="460 80" transform="rotate(30 150 182)"') +
    circle(150, 182, 86, "none", 'stroke="#fbbf24" stroke-width="5" stroke-dasharray="320 60" transform="rotate(200 150 182)"') +
    circle(150, 182, 54, "none", 'stroke="#fde68a" stroke-width="2" stroke-dasharray="200 40"') +
    rect(147, 40, 6, 290, "#fde68a") +
    rect(120, 150, 60, 6, "#fde68a"),
};

const covers = [
  { slug: "earthbound-snes", title: ["EarthBound"], platform: "SNES", band: "#374151", top: "#dc2626", bottom: "#7f1d1d", motif: "earthbound" },
  { slug: "chrono-trigger-snes", title: ["Chrono", "Trigger"], platform: "SNES", band: "#374151", top: "#1e40af", bottom: "#0c1445", motif: "chrono" },
  { slug: "metal-gear-solid-ps1", title: ["Metal Gear", "Solid"], platform: "PlayStation", band: "#0a0a0a", top: "#052e16", bottom: "#020d07", motif: "radar" },
  { slug: "symphony-of-the-night-ps1", title: ["Symphony", "of the Night"], platform: "PlayStation", band: "#0a0a0a", top: "#7f1d1d", bottom: "#2e0a1f", motif: "castle" },
  { slug: "panzer-dragoon-saga-saturn", title: ["Panzer Dragoon", "Saga"], platform: "Sega Saturn", band: "#1e293b", top: "#f59e0b", bottom: "#c2410c", motif: "dragon" },
  { slug: "radiant-silvergun-saturn", title: ["Radiant", "Silvergun"], platform: "Sega Saturn", band: "#1e293b", top: "#0f172a", bottom: "#172554", motif: "ship" },
  { slug: "shenmue-dreamcast", title: ["Shenmue"], platform: "Dreamcast", band: "#c2410c", top: "#1e3a5f", bottom: "#0b1a33", motif: "street" },
  { slug: "ocarina-of-time-n64", title: ["Ocarina", "of Time"], platform: "Nintendo 64", band: "#854d0e", top: "#ca8a04", bottom: "#115e59", motif: "sunburst" },
  { slug: "metroid-prime-gamecube", title: ["Metroid", "Prime"], platform: "GameCube", band: "#3730a3", top: "#111827", bottom: "#1c1917", motif: "planet" },
  { slug: "shadow-of-the-colossus-ps2", title: ["Shadow of", "the Colossus"], platform: "PlayStation 2", band: "#1e3a8a", top: "#cbd5e1", bottom: "#94a3b8", motif: "colossus" },
  { slug: "elden-ring-ps5", title: ["Elden Ring"], platform: "PlayStation 5", band: "#1d4ed8", top: "#17120a", bottom: "#050403", motif: "rings" },
];

const FONT = 'font-family="Arial, Helvetica, sans-serif"';

function renderCover({ slug, title, platform, band, top, bottom, motif, titleColor = "#ffffff" }) {
  const size = Math.max(...title.map((line) => line.length)) > 11 ? 28 : 36;
  const titleLines = title
    .map((line, index) => {
      const y = 396 - (title.length - index) * (size + 4);
      return `<text x="20" y="${y}" ${FONT} font-size="${size}" font-weight="700" letter-spacing="-0.5" fill="${titleColor}">${line}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" width="300" height="400">
<defs><linearGradient id="bg-${slug}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
<rect width="300" height="400" fill="url(#bg-${slug})"/>
${motifs[motif]()}
${rect(0, 0, 300, 34, band)}
<text x="20" y="22" ${FONT} font-size="13" font-weight="700" letter-spacing="1.5" fill="#ffffff">${platform.toUpperCase()}</text>
${titleLines}
</svg>
`;
}

const avatars = [
  { slug: "preview", background: "#2a2440", color: "#a78bfa" },
  { slug: "mara", background: "#3b1d2e", color: "#fb7185" },
  { slug: "kenji", background: "#10303d", color: "#38bdf8" },
  { slug: "lucia", background: "#3a2a12", color: "#fbbf24" },
  { slug: "tom", background: "#14332a", color: "#34d399" },
  { slug: "priya", background: "#2b1f47", color: "#c084fc" },
  { slug: "jonas", background: "#232a3b", color: "#93c5fd" },
  { slug: "amara", background: "#3d2216", color: "#fb923c" },
  { slug: "sam", background: "#1c3334", color: "#5eead4" },
];

/** An eight-by-eight mirrored sprite, in the spirit of early console characters. */
function renderAvatar({ slug, background, color }) {
  const random = createRandom(hashString(slug));
  const cells = [];
  for (let y = 1; y < 7; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const isFace = y >= 2 && y <= 4 && x >= 2;
      if (isFace || random() > 0.48) {
        cells.push(rect(8 + x * 10, 10 + y * 10, 10, 10, color));
        cells.push(rect(8 + (7 - x) * 10, 10 + y * 10, 10, 10, color));
      }
    }
  }
  const eyes = rect(38, 40, 6, 10, background) + rect(56, 40, 6, 10, background);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" shape-rendering="crispEdges">
${rect(0, 0, 96, 96, background)}
${cells.join("")}
${eyes}
</svg>
`;
}

const SPINE_COLORS = ["#1f2937", "#374151", "#7f1d1d", "#1e3a8a", "#065f46", "#92400e", "#4c1d95", "#0f172a", "#b45309", "#334155"];

function renderShelfPhoto({ seed, rows, narrow }) {
  const random = createRandom(seed);
  const shelfHeight = 700 / rows;
  let body = "";
  for (let row = 0; row < rows; row += 1) {
    const base = 25 + shelfHeight * (row + 1) - 18;
    let x = 44;
    while (x < 1130) {
      const width = narrow ? 26 + Math.floor(random() * 12) : 70 + Math.floor(random() * 26);
      const height = shelfHeight * (0.62 + random() * 0.18);
      const color = SPINE_COLORS[Math.floor(random() * SPINE_COLORS.length)];
      body += `<rect x="${x}" y="${base - height}" width="${width - 3}" height="${height}" rx="2" fill="${color}"/>`;
      body += rect(x + 4, base - height + 12, width - 11, narrow ? 44 : height * 0.12, "#f8fafc", `opacity="${narrow ? 0.16 : 0.22}"`);
      if (!narrow) {
        body += rect(x + 8, base - height * 0.55, width - 19, height * 0.3, "#f8fafc", 'opacity="0.1"');
      }
      x += width;
      if (random() > 0.92) {
        x += 22;
      }
    }
    body += rect(20, base, 1160, 18, "#3f2d20") + rect(20, base + 18, 1160, 6, "#000000", 'opacity="0.45"');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 750" width="1200" height="750">
<defs><radialGradient id="light-${seed}" cx="0.5" cy="0" r="0.95"><stop offset="0" stop-color="#fde68a" stop-opacity="0.22"/><stop offset="1" stop-color="#000000" stop-opacity="0.4"/></radialGradient></defs>
${rect(0, 0, 1200, 750, "#17171d")}
${body}
${rect(0, 0, 1200, 750, `url(#light-${seed})`)}
</svg>
`;
}

function renderDeskPhoto(seed) {
  const random = createRandom(seed);
  const items = [
    [190, 220, -11, "#b91c1c"],
    [470, 170, 6, "#1e3a8a"],
    [760, 260, -5, "#065f46"],
    [320, 480, 8, "#92400e"],
    [640, 500, -8, "#4c1d95"],
    [950, 470, 12, "#0f172a"],
  ];
  const boxes = items
    .map(([cx, cy, angle, color]) => {
      const width = 200 + Math.floor(random() * 20);
      const height = 260;
      const x = cx - width / 2;
      const y = cy - height / 2;
      return `<g transform="rotate(${angle} ${cx} ${cy})">
${rect(x + 8, y + 10, width, height, "#000000", 'opacity="0.4" rx="6"')}
${rect(x, y, width, height, color, 'rx="6"')}
${rect(x, y, width, 34, "#000000", 'opacity="0.35"')}
${rect(x + 18, y + 54, width - 36, 130, "#f8fafc", 'opacity="0.14"')}
${rect(x + 18, y + 202, width - 70, 14, "#f8fafc", 'opacity="0.6"')}
${rect(x + 18, y + 224, width - 110, 10, "#f8fafc", 'opacity="0.35"')}
</g>`;
    })
    .join("");
  const grain = Array.from({ length: 14 }, (_, index) => rect(0, index * 56, 1200, 2, "#000000", 'opacity="0.22"')).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 750" width="1200" height="750">
<defs><radialGradient id="light-${seed}" cx="0.4" cy="0.3" r="0.9"><stop offset="0" stop-color="#fde68a" stop-opacity="0.16"/><stop offset="1" stop-color="#000000" stop-opacity="0.45"/></radialGradient></defs>
${rect(0, 0, 1200, 750, "#4a3323")}
${grain}
${boxes}
${rect(0, 0, 1200, 750, `url(#light-${seed})`)}
</svg>
`;
}

function write(relativePath, contents) {
  const target = join(OUTPUT_DIR, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

rmSync(OUTPUT_DIR, { recursive: true, force: true });
covers.forEach((cover) => write(`covers/${cover.slug}.svg`, renderCover(cover)));
avatars.forEach((avatar) => write(`avatars/${avatar.slug}.svg`, renderAvatar(avatar)));
write("photos/shelf-saturn.svg", renderShelfPhoto({ seed: 101, rows: 4, narrow: true }));
write("photos/shelf-big-box.svg", renderShelfPhoto({ seed: 202, rows: 2, narrow: false }));
write("photos/desk-haul.svg", renderDeskPhoto(303));

console.log(`Wrote ${covers.length} covers, ${avatars.length} avatars and 3 photos to public/seed/`);
