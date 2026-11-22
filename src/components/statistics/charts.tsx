import { cn } from "@/lib/utils";

// Collection statistics (M13): small server-rendered figures in plain HTML and CSS (no
// charting library). Every figure has its numbers as text beside it, so nothing depends
// on colour or on hovering; the hover titles only repeat them.
//
// Colours (validated as an ordinal ramp on the dark card, #191b24): completeness is an
// ordered scale, one violet hue from loose (darkest) to sealed (lightest); "not
// recorded" is neutral grey. Unordered lists (regions, formats) use one violet.

export type Part = { key: string; label: string; copies: number };

export const COMPLETENESS_COLOURS: Record<string, { fill: string; ink: string }> = {
  sealed: { fill: "#ddd6fe", ink: "#16171d" },
  complete: { fill: "#a78bfa", ink: "#16171d" },
  incomplete: { fill: "#8b5cf6", ink: "#ffffff" },
  loose: { fill: "#6d28d9", ink: "#ffffff" },
  not_recorded: { fill: "#4b4f5e", ink: "#ffffff" },
};
const BAR = "#8b5cf6";
const MUTED_BAR = "#4b4f5e";

const count = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "copy" : "copies"}`;

/**
 * One whole split into its parts, in the given order: tall (28px, the share printed in
 * a block wide enough for it) or thin (8px, no text). A part with no copies draws
 * nothing. The surrounding text carries every figure.
 */
export function SegmentedBar({
  parts,
  total,
  share,
  size = "tall",
  label,
}: {
  parts: Part[];
  total: number;
  share: (copies: number) => string;
  size?: "tall" | "thin";
  label: string;
}) {
  const shown = parts.filter((p) => p.copies > 0);
  if (total <= 0 || shown.length === 0) {
    return <div role="img" aria-label={`${label}: no copies`} className={cn("rounded-full bg-white/[0.06]", size === "tall" ? "h-7" : "h-2")} />;
  }
  return (
    <div
      role="img"
      aria-label={`${label}: ${shown.map((p) => `${p.label} ${count(p.copies)} (${share(p.copies)})`).join(", ")}`}
      className={cn("flex w-full gap-0.5", size === "tall" ? "h-7" : "h-2")}
    >
      {shown.map((part) => {
        const colour = COMPLETENESS_COLOURS[part.key] ?? COMPLETENESS_COLOURS.not_recorded;
        const width = (part.copies / total) * 100;
        return (
          <span
            key={part.key}
            title={`${part.label}: ${count(part.copies)} (${share(part.copies)})`}
            className={cn("flex min-w-[3px] items-center overflow-visible", size === "tall" ? "rounded px-2" : "rounded-full")}
            style={{ width: `${width}%`, backgroundColor: colour.fill, color: colour.ink }}
          >
            {/* Printed only where the block is wide enough for it (about 10% of the bar). */}
            {size === "tall" && width >= 10 ? <span className="text-xs font-semibold tabular-nums">{share(part.copies)}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

/** The legend of a segmented bar: every part in bar order, with its copies and share. */
export function PartLegend({ parts, share, className }: { parts: Part[]; share: (copies: number) => string; className?: string }) {
  return (
    <ul className={cn("grid gap-x-6 gap-y-2 sm:grid-cols-2", className)}>
      {parts.map((part) => (
        <li key={part.key} className="flex items-center gap-2.5 text-sm">
          <span aria-hidden="true" className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: (COMPLETENESS_COLOURS[part.key] ?? COMPLETENESS_COLOURS.not_recorded).fill }} />
          <span className="min-w-0 flex-1 truncate">{part.label}</span>
          <span className="tabular-nums text-muted-foreground">{part.copies.toLocaleString("en")}</span>
          <span className="w-11 text-right font-medium tabular-nums">{share(part.copies)}</span>
        </li>
      ))}
    </ul>
  );
}

/** A key to the thin completeness bars: names only (each row gives its own figures). */
export function PartKey({ parts }: { parts: Pick<Part, "key" | "label">[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {parts.map((part) => (
        <li key={part.key} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-sm" style={{ backgroundColor: (COMPLETENESS_COLOURS[part.key] ?? COMPLETENESS_COLOURS.not_recorded).fill }} />
          {part.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Ranked horizontal bars, one per part, on one baseline scaled to the largest part.
 * "Not recorded" and "not in the catalog" are grey, and listed last.
 */
export function RankedBars({ items, total, share, muted }: { items: Part[]; total: number; share: (copies: number) => string; muted: (key: string) => boolean }) {
  const max = Math.max(1, ...items.map((i) => i.copies));
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <span className="truncate text-sm">{item.label}</span>
          <span className="text-sm tabular-nums">
            <span className="text-muted-foreground">{item.copies.toLocaleString("en")}</span>
            <span className="ml-2 inline-block w-11 text-right font-medium">{share(item.copies)}</span>
          </span>
          <span className="col-span-2 block h-2 rounded-full bg-white/[0.05]" title={`${item.label}: ${count(item.copies)} (${share(item.copies)} of ${count(total)})`}>
            <span
              className="block h-2 min-w-[3px] rounded-full"
              style={{ width: `${(item.copies / max) * 100}%`, backgroundColor: muted(item.key) ? MUTED_BAR : BAR }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One row of a stacked bar chart: the bar's length is this whole against the largest
 * one on the chart (one shared scale), split into its parts.
 */
export function ScaledSegmentedBar({ parts, copies, largest, share, label }: { parts: Part[]; copies: number; largest: number; share: (copies: number) => string; label: string }) {
  const length = largest > 0 ? Math.max((copies / largest) * 100, 2) : 0;
  return (
    <div className="w-full">
      <div style={{ width: `${length}%` }}>
        <SegmentedBar size="thin" parts={parts} total={copies} share={share} label={label} />
      </div>
    </div>
  );
}
