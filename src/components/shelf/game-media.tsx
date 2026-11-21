import Image from "next/image";

import { labelArt, type LabelMotif, type MediaKind, type Region } from "@/features/shelf/browse";
import { cn } from "@/lib/utils";

import { frameAspect, shellFor } from "./media-shells";

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


/** Text sized by the label's width and height, so wide and tall labels both stay legible. */
const fit = (byWidth: number, byHeight: number) => `min(${byWidth}cqi, ${byHeight}cqb)`;

/**
 * A copy's physical media, sized by its parent's width. `title` is printed on the label
 * and `systemLabel` on its bottom band. Decorative: callers give the accessible name.
 * `sizes` is the rendered width, for the image's responsive sources. `framed` stands it in
 * a box shared by every shell of its kind, so regional shells line up on a shelf.
 * `interactive` gives it a violet glow on its parent link's hover and focus.
 */
export function GameMedia({
  kind,
  region,
  slug,
  title,
  systemLabel,
  sizes = "160px",
  priority = false,
  framed = false,
  interactive = false,
  className,
}: {
  kind: MediaKind;
  region: Region;
  slug: string;
  title: string;
  systemLabel: string;
  sizes?: string;
  priority?: boolean;
  framed?: boolean;
  interactive?: boolean;
  className?: string;
}) {
  const shell = shellFor(kind, region);
  const art = labelArt(slug);
  const { label } = shell;

  const object = (
    <div className={cn("relative w-full media-shadow", interactive && "group-hover:media-glow group-focus-visible:media-glow")}>
      <Image src={shell.image} alt="" sizes={sizes} priority={priority} draggable={false} className="block h-auto w-full" />
      <div
        className="absolute overflow-hidden shadow-[inset_0_0_0_1px_rgb(0_0_0/0.5),inset_0_1px_3px_rgb(0_0_0/0.45)]"
        style={{
          left: `${label.left}%`,
          top: `${label.top}%`,
          width: `${label.width}%`,
          height: `${label.height}%`,
          borderRadius: shell.radius,
          containerType: "size",
          background: `linear-gradient(160deg, ${art.from}, ${art.to})`,
        }}
      >
        <svg viewBox="0 0 100 62" preserveAspectRatio="xMidYMax slice" className="absolute inset-0 size-full opacity-85">
          <Motif motif={art.motif} glow={art.glow} />
        </svg>
        <div
          className="absolute inset-x-0 top-0 bg-linear-to-b from-black/80 via-black/50 to-transparent"
          style={{ padding: `${fit(4, 5)} ${fit(5, 7)} ${fit(8, 10)}` }}
        >
          <p
            className="line-clamp-2 leading-[1.02] font-extrabold tracking-[-0.015em] text-white uppercase [text-shadow:0_1px_1px_rgb(0_0_0/0.7)]"
            style={{ fontSize: fit(14, 27) }}
          >
            {title}
          </p>
        </div>
        <div
          className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/75"
          style={{ padding: `${fit(1.6, 2.4)} ${fit(6, 8)}` }}
        >
          <span className="leading-none font-bold tracking-[0.14em] text-white/80 uppercase" style={{ fontSize: fit(5.5, 10) }}>
            {systemLabel}
          </span>
          <span className="rounded-full" style={{ height: fit(1.6, 3), width: fit(16, 26), background: `linear-gradient(90deg, ${art.glow}, transparent)` }} />
        </div>
        {/* A printed sticker is nearly matte; a case insert sits behind clear plastic. */}
        <div
          className={cn(
            "pointer-events-none absolute inset-0",
            shell.isCase
              ? "bg-[linear-gradient(115deg,rgb(255_255_255/0.16)_0%,rgb(255_255_255/0.04)_28%,transparent_42%,transparent_70%,rgb(255_255_255/0.06)_100%)]"
              : "bg-linear-to-b from-white/8 via-transparent to-black/10",
          )}
        />
      </div>
    </div>
  );

  return (
    <div
      aria-hidden="true"
      className={cn("w-full select-none", framed && "flex items-end", className)}
      style={framed ? { aspectRatio: frameAspect(kind) } : undefined}
    >
      {object}
    </div>
  );
}
