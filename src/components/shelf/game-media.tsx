import Image from "next/image";

import { labelArt, type LabelMotif, type MediaKind, type Region } from "@/features/shelf/browse";
import { cn } from "@/lib/utils";

import { shellFor } from "./media-shells";

// A game's physical media in two layers: the system's shell, from the owner's reference
// art (see media-shells.ts), and the game's own label laid over the shell's label recess.
// The label is original, generated artwork for now; real cover art can replace it later
// without touching the shell.

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
 * A copy's physical media, sized by its parent's width. `title` is printed on the label
 * and `systemLabel` on its bottom band. Decorative: callers give the accessible name.
 * `sizes` is the rendered width, for the image's responsive sources.
 */
export function GameMedia({
  kind,
  region,
  slug,
  title,
  systemLabel,
  sizes = "160px",
  priority = false,
  className,
}: {
  kind: MediaKind;
  region: Region;
  slug: string;
  title: string;
  systemLabel: string;
  sizes?: string;
  priority?: boolean;
  className?: string;
}) {
  const shell = shellFor(kind, region);
  const art = labelArt(slug);
  const { label } = shell;

  return (
    <div aria-hidden="true" className={cn("relative w-full select-none", className)}>
      <Image
        src={shell.image}
        alt=""
        sizes={sizes}
        priority={priority}
        draggable={false}
        className="block h-auto w-full drop-shadow-[0_8px_8px_rgb(0_0_0/0.55)]"
      />
      <div
        className="@container absolute overflow-hidden shadow-[inset_0_0_0_1px_rgb(0_0_0/0.55),inset_0_2px_6px_rgb(0_0_0/0.45)]"
        style={{
          left: `${label.left}%`,
          top: `${label.top}%`,
          width: `${label.width}%`,
          height: `${label.height}%`,
          borderRadius: label.radius,
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
        {/* Gloss across the label, as on a printed sticker or behind a case's plastic. */}
        <div className="pointer-events-none absolute inset-0 bg-linear-to-br from-white/18 via-transparent to-transparent" />
      </div>
    </div>
  );
}
