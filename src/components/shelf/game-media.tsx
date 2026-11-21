import type { ReactNode } from "react";

import { labelArt, type LabelMotif, type MediaKind } from "@/features/shelf/browse";
import { cn } from "@/lib/utils";

// Physical game media drawn in SVG and CSS: each system's cartridge or case shape, with
// original, generated label artwork. No real cover art, logos or trade dress.

type Shape = {
  w: number;
  h: number;
  body: string;
  /** Body gradient, top to bottom. */
  shell: [string, string];
  /** The label's recess, in viewBox units. */
  label: { x: number; y: number; w: number; h: number; r?: number };
  details: ReactNode;
};

const grooves = (y0: number, count: number, step: number, x1: number, x2: number, opacity = 0.16) =>
  Array.from({ length: count }, (_, i) => (
    <line key={i} x1={x1} x2={x2} y1={y0 + i * step} y2={y0 + i * step} stroke={`rgb(0 0 0 / ${opacity})`} strokeWidth="0.9" strokeLinecap="round" />
  ));

const highlights = (y0: number, count: number, step: number, x1: number, x2: number) =>
  Array.from({ length: count }, (_, i) => (
    <line key={i} x1={x1} x2={x2} y1={y0 + i * step + 0.9} y2={y0 + i * step + 0.9} stroke="rgb(255 255 255 / 0.22)" strokeWidth="0.6" strokeLinecap="round" />
  ));

const SHAPES: Record<MediaKind, Shape> = {
  // A 16-bit cartridge: wider than tall, a ridged top, grip grooves and corner screws.
  "snes-cart": {
    w: 120,
    h: 100,
    body: "M7 0H113Q120 0 120 7V80H117V93Q117 100 110 100H10Q3 100 3 93V80H0V7Q0 0 7 0Z",
    shell: ["#cdcad6", "#9e9aab"],
    label: { x: 14, y: 13, w: 92, h: 56, r: 2 },
    details: (
      <>
        {grooves(3.5, 3, 2.6, 18, 102, 0.14)}
        {highlights(3.5, 3, 2.6, 18, 102)}
        {grooves(78, 3, 3.4, 34, 86)}
        {highlights(78, 3, 3.4, 34, 86)}
        <circle cx="10" cy="92" r="1.6" fill="rgb(0 0 0 / 0.28)" />
        <circle cx="110" cy="92" r="1.6" fill="rgb(0 0 0 / 0.28)" />
      </>
    ),
  },
  // An 8-bit cartridge: taller than wide, label above a deeply ridged grip.
  "nes-cart": {
    w: 100,
    h: 112,
    body: "M3 0H97Q100 0 100 3V109Q100 112 97 112H3Q0 112 0 109V3Q0 0 3 0Z",
    shell: ["#c3c1c5", "#8f8c93"],
    label: { x: 9, y: 7, w: 82, h: 58, r: 1 },
    details: (
      <>
        {grooves(74, 9, 3.8, 6, 94, 0.2)}
        {highlights(74, 9, 3.8, 6, 94)}
      </>
    ),
  },
  // A handheld cartridge: a cut top-right corner and an embossed arrow.
  "gb-cart": {
    w: 90,
    h: 100,
    body: "M4 0H76L90 14V96Q90 100 86 100H4Q0 100 0 96V4Q0 0 4 0Z",
    shell: ["#cfcdd2", "#a09da6"],
    label: { x: 9, y: 22, w: 72, h: 64, r: 2 },
    details: (
      <>
        {grooves(5, 3, 2.6, 10, 60, 0.14)}
        <path d="M45 13l-4 4h8z" fill="rgb(0 0 0 / 0.22)" />
      </>
    ),
  },
  // A 64-bit cartridge: dark shell with rounded shoulders.
  "n64-cart": {
    w: 120,
    h: 96,
    body: "M14 0H106Q120 0 120 14V90Q120 96 114 96H6Q0 96 0 90V14Q0 0 14 0Z",
    shell: ["#5d5f69", "#33343b"],
    label: { x: 17, y: 14, w: 86, h: 56, r: 3 },
    details: (
      <>
        {grooves(78, 4, 3.4, 24, 96, 0.35)}
        {highlights(78, 4, 3.4, 24, 96)}
      </>
    ),
  },
  // A 16-bit cartridge in a black shell with an angled grip.
  "md-cart": {
    w: 110,
    h: 100,
    body: "M5 0H105Q110 0 110 5V88L104 100H6L0 88V5Q0 0 5 0Z",
    shell: ["#34353b", "#151519"],
    label: { x: 10, y: 9, w: 90, h: 64, r: 1 },
    details: (
      <>
        {grooves(80, 4, 3.6, 18, 92, 0.5)}
        {highlights(80, 4, 3.6, 18, 92)}
      </>
    ),
  },
  // A disc in its jewel case, seen from the front, with the hinge on the left.
  "disc-case": {
    w: 104,
    h: 100,
    body: "M2 0H102Q104 0 104 2V98Q104 100 102 100H2Q0 100 0 98V2Q0 0 2 0Z",
    shell: ["#2b2c33", "#14151a"],
    label: { x: 10, y: 2.5, w: 91.5, h: 95, r: 0.5 },
    details: (
      <>
        <rect x="1.5" y="2" width="7" height="96" fill="rgb(255 255 255 / 0.06)" />
        <line x1="8.5" x2="8.5" y1="2" y2="98" stroke="rgb(255 255 255 / 0.18)" strokeWidth="0.6" />
      </>
    ),
  },
};

export const MEDIA_ASPECT: Record<MediaKind, string> = Object.fromEntries(
  Object.entries(SHAPES).map(([kind, shape]) => [kind, `${shape.w} / ${shape.h}`]),
) as Record<MediaKind, string>;

function Motif({ motif, glow }: { motif: LabelMotif; glow: string }) {
  const stroke = { stroke: glow, strokeWidth: 1.2, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (motif) {
    case "peaks":
      return (
        <>
          <path d="M0 60L22 34L34 46L52 22L72 50L84 40L100 60Z" fill="rgb(0 0 0 / 0.35)" />
          <path d="M52 22L58 30L48 31Z" fill={glow} opacity="0.8" />
        </>
      );
    case "sun":
      return (
        <>
          <circle cx="50" cy="44" r="18" fill={glow} opacity="0.75" />
          {[30, 36, 42, 48].map((y) => (
            <rect key={y} x="28" y={y} width="44" height="2" fill="rgb(0 0 0 / 0.35)" />
          ))}
          <path d="M0 60L100 60L100 52Q50 44 0 52Z" fill="rgb(0 0 0 / 0.4)" />
        </>
      );
    case "stars":
      return (
        <>
          {[
            [12, 30, 1.2], [26, 44, 0.8], [40, 26, 1], [60, 38, 1.4], [74, 24, 0.9], [88, 46, 1.1], [18, 52, 0.7], [66, 54, 0.8], [50, 50, 0.6],
          ].map(([x, y, r]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill={glow} />
          ))}
          <path d="M78 34l2 4 4 1-4 1-2 4-2-4-4-1 4-1z" fill={glow} />
        </>
      );
    case "grid":
      return (
        <>
          <path d="M0 40H100" {...stroke} opacity="0.9" />
          {[-60, -30, 0, 30, 60].map((dx) => (
            <path key={dx} d={`M${50 + dx * 0.25} 40L${50 + dx * 1.6} 62`} {...stroke} opacity="0.55" />
          ))}
          {[46, 52, 58].map((y) => (
            <path key={y} d={`M0 ${y}H100`} {...stroke} opacity="0.4" />
          ))}
          <circle cx="50" cy="32" r="8" fill={glow} opacity="0.55" />
        </>
      );
    case "waves":
      return (
        <>
          {[38, 46, 54].map((y, i) => (
            <path key={y} d={`M0 ${y}Q12 ${y - 6} 25 ${y}T50 ${y}T75 ${y}T100 ${y}`} {...stroke} opacity={0.9 - i * 0.2} />
          ))}
        </>
      );
    case "planet":
      return (
        <>
          <circle cx="56" cy="42" r="13" fill={glow} opacity="0.7" />
          <ellipse cx="56" cy="42" rx="24" ry="5" {...stroke} transform="rotate(-14 56 42)" />
          <circle cx="22" cy="30" r="1" fill={glow} />
          <circle cx="84" cy="54" r="1.2" fill={glow} />
        </>
      );
    case "castle":
      return (
        <>
          <path d="M28 60V40H32V36H36V40H40V32H44V28H48V32H52V28H56V32H60V40H64V36H68V40H72V60Z" fill="rgb(0 0 0 / 0.45)" />
          <rect x="47" y="46" width="6" height="14" rx="3" fill={glow} opacity="0.75" />
          <circle cx="78" cy="26" r="5" fill={glow} opacity="0.6" />
        </>
      );
    default:
      return <path d="M56 22L38 46H50L44 62L64 36H52Z" fill={glow} opacity="0.8" />;
  }
}

/**
 * A game's physical media, sized by its parent's width. `title` is shown on the label;
 * `systemLabel` on its bottom band. Decorative: callers give the accessible name.
 */
export function GameMedia({
  kind,
  slug,
  title,
  systemLabel,
  className,
}: {
  kind: MediaKind;
  slug: string;
  title: string;
  systemLabel: string;
  className?: string;
}) {
  const shape = SHAPES[kind];
  const art = labelArt(slug);
  const gradientId = `shell-${kind}`;
  const { label } = shape;
  const pct = (value: number, total: number) => `${(value / total) * 100}%`;

  return (
    <div aria-hidden="true" className={cn("relative w-full select-none", className)} style={{ aspectRatio: MEDIA_ASPECT[kind] }}>
      <svg viewBox={`0 0 ${shape.w} ${shape.h}`} className="absolute inset-0 size-full overflow-visible drop-shadow-[0_6px_6px_rgb(0_0_0/0.55)]">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={shape.shell[0]} />
            <stop offset="1" stopColor={shape.shell[1]} />
          </linearGradient>
        </defs>
        <path d={shape.body} fill={`url(#${gradientId})`} />
        {/* Rim light on the left edge, shade on the right. */}
        <path d={shape.body} fill="none" stroke="rgb(255 255 255 / 0.18)" strokeWidth="0.8" />
        <rect x={label.x - 1.4} y={label.y - 1.4} width={label.w + 2.8} height={label.h + 2.8} rx={(label.r ?? 1) + 1} fill="rgb(0 0 0 / 0.28)" />
        {shape.details}
      </svg>
      <div
        className="@container absolute overflow-hidden"
        style={{
          left: pct(label.x, shape.w),
          top: pct(label.y, shape.h),
          width: pct(label.w, shape.w),
          height: pct(label.h, shape.h),
          borderRadius: `${label.r ?? 1}px`,
          background: `linear-gradient(160deg, ${art.from}, ${art.to})`,
        }}
      >
        <svg viewBox="0 0 100 62" preserveAspectRatio="xMidYMax slice" className="absolute inset-0 size-full">
          <Motif motif={art.motif} glow={art.glow} />
        </svg>
        <div className="absolute inset-x-0 top-0 bg-linear-to-b from-black/70 via-black/35 to-transparent px-[5cqi] pt-[4cqi] pb-[8cqi]">
          <p
            className="line-clamp-2 text-[11cqi] leading-[1.02] font-black tracking-tight text-white uppercase italic"
            style={{ textShadow: `0 0 6px ${art.glow}66, 0 1px 0 rgb(0 0 0 / 0.6)` }}
          >
            {title}
          </p>
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/70 px-[5cqi] py-[1.6cqi]">
          <span className="text-[6.5cqi] leading-none font-bold tracking-[0.12em] text-white/85 uppercase">{systemLabel}</span>
          <span className="h-[2cqi] w-[18cqi] rounded-full" style={{ background: `linear-gradient(90deg, ${art.glow}, transparent)` }} />
        </div>
        {/* Gloss across the label. */}
        <div className="pointer-events-none absolute inset-0 bg-linear-to-br from-white/18 via-transparent to-transparent" />
      </div>
    </div>
  );
}
