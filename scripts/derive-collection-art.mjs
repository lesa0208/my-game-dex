// Derives the visual shelf's console and media art from the owner's reference set
// (design-references/, kept outside Git). Each reference is an SVG wrapping one
// 1024 × 1024 PNG on a transparent background.
//
// Consoles keep their stylized look: only clean cropping, speck removal and mild
// sharpening. Media shells are made more physical: cut-off edges rebuilt by symmetry, the
// soft glow hardened into a clean silhouette, the purple and orange rim tint neutralized
// into the shell's plastic colour, then sharpened. Every image is framed with the same
// padding, and the label recesses (measured in source pixels) are written to
// src/assets/collection/manifest.json as percentages of the final image.
//
//   node scripts/derive-collection-art.mjs <path to design-references>
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

const source = process.argv[2];
if (!source) {
  console.error("Usage: node scripts/derive-collection-art.mjs <path to design-references>");
  process.exit(1);
}

const OUT = join(import.meta.dirname, "..", "src", "assets", "collection");
const SIZE = 1024;
/** Transparent padding around every object, as a share of its larger side. */
const PAD = 0.03;

const CONSOLES = [
  ["SNES", "snes"],
  ["NES", "nes"],
  ["Nintendo_64", "n64"],
  ["Game_Boy", "game-boy"],
  ["Sega_Mega_Drive", "mega-drive"],
  ["PlayStation_1", "playstation"],
  ["Sega_Saturn", "saturn"],
];

/**
 * Media shells. `label` is the label recess (or case insert) in source pixels.
 * `plastic` is the shell's real colour, applied as a tint over its neutral luminance;
 * `keep` are regions whose own colours stay, such as a case spine's printed logos.
 * `mirror` rebuilds a strip cut off at the right edge from the shell's left edge, about
 * the vertical axis `axis`, between `from` and `to`; `notch` keeps a stepped top edge.
 * `straighten` removes a slight shear so the shell faces front (see rectify).
 * Disc cases are not derived from their references; see CASES.
 */
const MEDIA = [
  {
    file: "SNES_NTSC_U_Cartridge",
    name: "snes-ntsc-u",
    label: [241, 246, 517, 261],
    plastic: "#bdbac4",
    lift: 1.12,
    straighten: { k: 0.0295, cx: 511 },
  },
  {
    file: "SNES_PAL_Cartridge",
    name: "snes-pal",
    label: [186, 293, 701, 240],
    plastic: "#c2c0c6",
    lift: 1.1,
    mirror: { axis: 536.6, from: 976, to: 1000 },
  },
  { file: "NES_Cartridge", name: "nes", label: [440, 120, 402, 594], plastic: "#b0aeb2", lift: 1.08 },
  { file: "Nintendo_64_Cartridge", name: "n64", label: [312, 303, 435, 464], plastic: "#6c6d74", lift: 0.86 },
  {
    file: "Game_Boy_Cartridge",
    name: "game-boy",
    label: [323, 379, 487, 441],
    plastic: "#c4c2c7",
    lift: 1.1,
    mirror: { axis: 566.3, from: 878, to: 947, notch: true },
  },
  { file: "Sega_Mega_Drive_Genesis_Cartridge", name: "mega-drive", label: [235, 258, 609, 480], plastic: "#3a3a40", lift: 0.95, mirror: { axis: 539, from: 976, to: 1014 } },
];

/**
 * Straightens a cartridge drawn with a slight shear (top and bottom edges sloping
 * equally, sides vertical): each column shifts by k × (x − cx), so the shell stands
 * upright and front-facing. Returns the straightened buffer and a function mapping a
 * source point into it.
 */
function rectify(data, { k, cx }) {
  const toSource = (x, y) => [x, y + k * (x - cx)];
  const forward = (x, y) => [x, y - k * (x - cx)];
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [sx, sy] = toSource(x, y);
      const yA = Math.floor(sy);
      const f = sy - yA;
      if (yA < 0 || yA + 1 >= SIZE) continue;
      // Vertical-only resampling (x never moves), premultiplied so edges don't fringe.
      const a0 = (yA * SIZE + Math.round(sx)) * 4;
      const a1 = a0 + SIZE * 4;
      const alpha0 = data[a0 + 3] * (1 - f);
      const alpha1 = data[a1 + 3] * f;
      const alpha = alpha0 + alpha1;
      const d = (y * SIZE + x) * 4;
      out[d + 3] = Math.round(alpha);
      if (alpha > 0) for (let c = 0; c < 3; c++) out[d + c] = Math.round((data[a0 + c] * alpha0 + data[a1 + c] * alpha1) / alpha);
    }
  }
  return { data: out, forward };
}

/** A label rectangle measured on the slanted art, as the inner rectangle once straightened. */
function straightenRect([x, y, w, h], forward) {
  const [, tl] = forward(x, y);
  const [, tr] = forward(x + w, y);
  const [, bl] = forward(x, y + h);
  const [, br] = forward(x + w, y + h);
  const top = Math.max(tl, tr);
  return [x, top, w, Math.min(bl, br) - top];
}


function readReference(dir, file) {
  const svg = readFileSync(join(source, dir, `${file}.svg`), "utf8");
  const match = /href="data:image\/png;base64,([^"]+)"/.exec(svg);
  if (!match) throw new Error(`${dir}/${file}.svg has no embedded PNG`);
  return Buffer.from(match[1], "base64");
}

async function rgba(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== SIZE || info.height !== SIZE) throw new Error("expected a 1024 × 1024 reference");
  return data;
}

const raw = (data) => sharp(data, { raw: { width: SIZE, height: SIZE, channels: 4 } });

/** Rebuilds a strip cut off at the right edge from its mirror image on the left. */
function mirrorFill(data, { axis, from, to, notch }) {
  const alphaAt = (x, y) => data[(y * SIZE + x) * 4 + 3];
  // The top edge just before the cut, kept across the rebuilt strip.
  let top = 0;
  if (notch) while (top < SIZE && alphaAt(from - 2, top) < 128) top++;
  const blend = 8;
  for (let x = from; x <= to && x < SIZE; x++) {
    const sx = Math.round(2 * axis - x);
    const t = Math.min(1, (x - from) / blend);
    for (let y = 0; y < SIZE; y++) {
      const d = (y * SIZE + x) * 4;
      const s = (y * SIZE + sx) * 4;
      const sa = notch && y < top ? 0 : data[s + 3];
      for (let c = 0; c < 3; c++) data[d + c] = Math.round(data[d + c] * (1 - t) + data[s + c] * t);
      data[d + 3] = Math.round(data[d + 3] * (1 - t) + sa * t);
    }
  }
}

/** Hard silhouette: the soft outer glow goes, the edge keeps a one-pixel antialias. */
function hardenAlpha(data, low, high) {
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    data[i] = a <= low ? 0 : a >= high ? 255 : Math.round(((a - low) / (high - low)) * 255);
  }
}

function bbox(data, threshold) {
  let x0 = SIZE, y0 = SIZE, x1 = -1, y1 = -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (data[(y * SIZE + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Crops to the object and adds the same padding on every side. */
async function frame(data, box) {
  const pad = Math.round(Math.max(box.width, box.height) * PAD);
  const cropped = await raw(data).extract(box).png().toBuffer();
  const framed = await sharp(cropped)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return { framed, pad };
}

async function write(buffer, target, fit) {
  await sharp(buffer)
    .resize({ width: fit, height: fit, fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
    .sharpen({ sigma: fit > 600 ? 0.6 : 0.8, m1: 0.6, m2: 1.4 })
    .webp({ quality: 90, alphaQuality: 100, effort: 6, smartSubsample: true })
    .toFile(target);
  const { width, height } = await sharp(target).metadata();
  return { width, height, kb: Math.round(statSync(target).size / 1024) };
}

const hex = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

async function deriveConsole(file, name) {
  const data = await rgba(readReference("consoles", file));
  hardenAlpha(data, 24, 40); // drops faint specks, keeps the art's own soft edges
  const box = bbox(data, 24);
  const { framed } = await frame(data, box);
  const out = await write(framed, join(OUT, "consoles", `${name}.webp`), 720);
  const edges = [box.left <= 62 && "left", box.top <= 62 && "top", box.left + box.width >= 962 && "right", box.top + box.height >= 962 && "bottom"].filter(Boolean);
  console.log(`consoles/${name}.webp\t${out.width}x${out.height}\t${out.kb} KB${edges.length ? `\ttouches the reference frame: ${edges.join(", ")}` : ""}`);
}

async function deriveMedia(spec) {
  const original = await rgba(readReference("cartridges", spec.file));
  // Straighten first, so the shell stands upright and the label recess is square to it.
  const straight = spec.straighten ? rectify(original, spec.straighten) : null;
  const data = straight ? straight.data : Buffer.from(original);
  const labelRect = straight ? straightenRect(spec.label, straight.forward) : spec.label;
  if (spec.mirror) mirrorFill(data, spec.mirror);
  hardenAlpha(data, 110, 210);
  const box = bbox(data, 0);

  // Plastic: neutral luminance, a little contrast, then the shell's own colour.
  const neutral = await raw(data).greyscale().linear(spec.lift, -(spec.lift - 1) * 40).tint(hex(spec.plastic)).png().toBuffer();
  let shell = neutral;
  if (spec.keep?.length) {
    const muted = await raw(data).modulate({ saturation: 0.8 }).png().toBuffer();
    const patches = await Promise.all(
      spec.keep.map(async ([left, top, width, height]) => ({ input: await sharp(muted).extract({ left, top, width, height }).png().toBuffer(), left, top })),
    );
    shell = await sharp(neutral).composite(patches).png().toBuffer();
  }
  // Restore the hardened alpha (greyscale and tint keep it, the patches may not).
  const shellData = await rgba(shell);
  for (let i = 3; i < shellData.length; i += 4) shellData[i] = data[i];

  const { framed, pad } = await frame(shellData, box);
  const target = join(OUT, "media", `${spec.name}.webp`);
  const out = await write(framed, target, 600);

  // The label recess, inset slightly so the shell's lip shows around it.
  const fullW = box.width + 2 * pad;
  const fullH = box.height + 2 * pad;
  const inset = 4;
  const [lx, ly, lw, lh] = labelRect;
  const pct = (v, total) => Math.round((v / total) * 10000) / 100;
  const label = {
    left: pct(lx + inset - box.left + pad, fullW),
    top: pct(ly + inset - box.top + pad, fullH),
    width: pct(lw - 2 * inset, fullW),
    height: pct(lh - 2 * inset, fullH),
  };
  console.log(`media/${spec.name}.webp\t${out.width}x${out.height}\t${out.kb} KB${spec.mirror ? "\tright edge rebuilt" : ""}${spec.straighten ? "\tstraightened" : ""}`);
  return [spec.name, { width: out.width, height: out.height, label }];
}

/**
 * Disc cases. Both references draw the case in three-quarter view (a side face, the top
 * of the case, an angled hinge), which no pixel warp can undo without inventing detail.
 * So the case itself is drawn here as exact front-view geometry: a clear jewel case, its
 * hinge strip on the left and the cover insert behind the lid, every edge horizontal or
 * vertical. Only the printed spine band of each reference's cover is reused, and it is
 * drawn flat in the original, so it is scaled uniformly, never stretched.
 *
 * `aspect` is the case's front, width over height: 142 × 125 mm for a PlayStation jewel
 * case; the Saturn case keeps its reference's proportions. `band` is the printed band in
 * source pixels.
 */
const CASES = [
  { file: "PlayStation_1_Case", name: "playstation", aspect: 142 / 125, band: [124, 136, 97, 820] },
  { file: "Sega_Saturn_Case", name: "saturn", aspect: 0.94, band: [237, 106, 144, 818] },
];

/** The case's geometry in pixels, for a front `width` px wide. */
function caseLayout(width, aspect, [, , bw, bh]) {
  const W = width;
  const H = Math.round(W / aspect);
  const r = Math.round(W * 0.012); // corner rounding
  const hinge = Math.round(W * 0.05); // the hinge strip on the left
  const rim = Math.round(W * 0.024); // clear lid around the insert
  const insert = { x: hinge + Math.round(W * 0.012), y: rim, w: 0, h: H - 2 * rim };
  insert.w = W - rim - insert.x;
  const bandW = Math.round((insert.h * bw) / bh);
  const label = { x: insert.x + bandW, y: insert.y, w: insert.w - bandW, h: insert.h };
  return { W, H, r, hinge, rim, insert, bandW, label };
}

function caseSvg({ W, H, r, hinge, rim, insert }) {
  const lid = W - hinge;
  const knuckle = Math.round(H * 0.075);
  const ribs = [];
  for (let x = Math.round(W * 0.008); x < hinge - 2; x += Math.max(3, Math.round(W * 0.0065))) {
    ribs.push(`<rect x="${x}" y="${knuckle}" width="1.4" height="${H - 2 * knuckle}" fill="#fff" fill-opacity="0.07"/>`);
  }
  // Tray tabs on the lid's top and bottom rims, and the clip marks on its right edge.
  const tab = (cx, y, flip) =>
    `<path d="M ${cx - rim * 1.5} ${y} A ${rim * 1.5} ${rim * 1.15} 0 0 ${flip ? 1 : 0} ${cx + rim * 1.5} ${y}" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="1.8"/>`;
  const tabs = [0.3, 0.78].flatMap((t) => [tab(hinge + lid * t, rim * 0.15, false), tab(hinge + lid * t, H - rim * 0.15, true)]);
  const clip = (y) => `<rect x="${W - rim * 0.62}" y="${y}" width="${rim * 0.22}" height="${H * 0.1}" rx="1" fill="#fff" fill-opacity="0.28"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="lid" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#dfe1e8" stop-opacity="0.5"/>
      <stop offset="0.5" stop-color="#9c9ea8" stop-opacity="0.30"/>
      <stop offset="1" stop-color="#8a8c96" stop-opacity="0.36"/>
    </linearGradient>
    <linearGradient id="hinge" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2c2c33"/>
      <stop offset="0.45" stop-color="#1b1b20"/>
      <stop offset="1" stop-color="#111114"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.75"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.18"/>
    </linearGradient>
    <clipPath id="body"><rect width="${W}" height="${H}" rx="${r}"/></clipPath>
  </defs>
  <g clip-path="url(#body)">
    <rect width="${W}" height="${H}" fill="#121216"/>
    <rect x="${hinge}" width="${lid}" height="${H}" fill="url(#lid)"/>
    <rect x="${insert.x}" y="${insert.y}" width="${insert.w}" height="${insert.h}" fill="#141418"/>
    <rect x="${insert.x}" y="${insert.y}" width="${insert.w}" height="${insert.h}" fill="none" stroke="#000" stroke-opacity="0.55" stroke-width="2"/>
    <rect width="${hinge}" height="${H}" fill="url(#hinge)"/>
    ${ribs.join("\n    ")}
    <rect width="${hinge}" height="${knuckle}" fill="#b4b6c0" fill-opacity="0.35"/>
    <rect y="${H - knuckle}" width="${hinge}" height="${knuckle}" fill="#b4b6c0" fill-opacity="0.35"/>
    <rect x="${hinge - 1.5}" width="1.5" height="${H}" fill="#fff" fill-opacity="0.4"/>
    ${tabs.join("\n    ")}
    ${clip(H * 0.28)}
    ${clip(H * 0.62)}
    <!-- The lid's moulded inner edge: a thin light line where the clear rim meets the cover. -->
    <rect x="${insert.x - 2.5}" y="${insert.y - 2.5}" width="${insert.w + 5}" height="${insert.h + 5}" rx="2" fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="1.2"/>
    <!-- Light catching the top rim of the lid. -->
    <rect x="${hinge}" y="3" width="${lid - r}" height="1.6" fill="#fff" fill-opacity="0.45"/>
    <rect y="${H - Math.round(H * 0.012)}" width="${W}" height="${Math.round(H * 0.012)}" fill="#000" fill-opacity="0.35"/>
  </g>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="${r}" fill="none" stroke="url(#edge)" stroke-width="2"/>
</svg>`;
}

async function deriveCase(spec) {
  const width = 1200;
  const layout = caseLayout(width, spec.aspect, spec.band);
  const { W, H, insert, bandW, label } = layout;
  const [left, top, bw, bh] = spec.band;
  // The band's own colours, slightly muted like the other kept print.
  const band = await sharp(readReference("cartridges", spec.file))
    .extract({ left, top, width: bw, height: bh })
    .modulate({ saturation: 0.8 })
    .resize({ width: bandW, height: insert.h, fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const svg = Buffer.from(caseSvg(layout));
  const drawn = await sharp(svg).composite([{ input: band, left: insert.x, top: insert.y }]).png().toBuffer();
  // The lid's clear rim over the band's edges, so the print sits behind the plastic.
  const lidOver = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${insert.x}" y="${insert.y}" width="${bandW}" height="${insert.h}" fill="none" stroke="#000" stroke-opacity="0.5" stroke-width="2"/></svg>`,
  );
  const shell = await sharp(drawn).composite([{ input: lidOver }]).png().toBuffer();

  const pad = Math.round(Math.max(W, H) * PAD);
  const framed = await sharp(shell).extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const target = join(OUT, "media", `${spec.name}.webp`);
  const out = await write(framed, target, 600);
  const pct = (v, total) => Math.round((v / total) * 10000) / 100;
  const fullW = W + 2 * pad;
  const fullH = H + 2 * pad;
  const entry = {
    width: out.width,
    height: out.height,
    label: { left: pct(label.x + pad, fullW), top: pct(label.y + pad, fullH), width: pct(label.w, fullW), height: pct(label.h, fullH) },
  };
  console.log(`media/${spec.name}.webp\t${out.width}x${out.height}\t${out.kb} KB\tfront-view case, band ${bandW}×${insert.h} from ${bw}×${bh} (scale ${(bandW / bw).toFixed(3)} × ${(insert.h / bh).toFixed(3)})`);
  return [spec.name, entry];
}

mkdirSync(join(OUT, "consoles"), { recursive: true });
mkdirSync(join(OUT, "media"), { recursive: true });
for (const [file, name] of CONSOLES) await deriveConsole(file, name);
const manifest = {};
for (const spec of MEDIA) {
  const [name, entry] = await deriveMedia(spec);
  manifest[name] = entry;
}
for (const spec of CASES) {
  const [name, entry] = await deriveCase(spec);
  manifest[name] = entry;
}
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify({ media: manifest }, null, 2)}\n`);
console.log("manifest.json written");
