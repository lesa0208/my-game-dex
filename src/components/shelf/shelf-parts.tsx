import { ChevronRight, FlaskConical, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A shelf board seen slightly from above: its lit top, then its front edge. */
export function ShelfBoard({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("relative", className)}>
      <div className="wood-top h-2" />
      <div className="wood-front h-3.5" />
    </div>
  );
}

type Breakpoint = "base" | "sm" | "md" | "lg" | "xl";
const SHOW: Record<Breakpoint, [string, string]> = {
  base: ["flex", "hidden"],
  sm: ["sm:flex", "sm:hidden"],
  md: ["md:flex", "md:hidden"],
  lg: ["lg:flex", "lg:hidden"],
  xl: ["xl:flex", "xl:hidden"],
};

/**
 * Empty bays that complete a shelf's last row, so every board spans the cabinet. `columns`
 * is the grid's column count from each breakpoint up, matching its grid-cols classes.
 */
export function ShelfFillers({ count, columns }: { count: number; columns: Partial<Record<Breakpoint, number>> }) {
  const order: Breakpoint[] = ["base", "sm", "md", "lg", "xl"];
  const most = Math.max(...Object.values(columns));
  const slots = Array.from({ length: most - 1 }, (_, i) => {
    let current = 1;
    const classes = order.map((bp) => {
      current = columns[bp] ?? current;
      const missing = count === 0 ? 0 : (current - (count % current)) % current;
      return SHOW[bp][i < missing ? 0 : 1];
    });
    return classes.join(" ");
  });
  return (
    <>
      {slots.map((classes, i) => (
        <li key={i} aria-hidden="true" className={cn("relative flex-col", classes)}>
          <ShelfLight />
          <div className="flex-1" />
          <ShelfBoard />
        </li>
      ))}
    </>
  );
}

/** The strip light mounted under the shelf above, with its glow. */
export function ShelfLight({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-x-0 top-0 h-full shelf-light", className)}>
      <div className="h-[2px] w-full bg-amber-100/80 shadow-[0_0_8px_2px_rgb(255_190_120/0.4),0_0_22px_6px_rgb(255_170_90/0.12)]" />
    </div>
  );
}

/** A wooden cabinet: side frame, back wall and its content. */
export function Cabinet({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("wood-frame rounded-xl p-1.5 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.8)] sm:p-2.5", className)}>
      <div className="shelf-wall overflow-hidden rounded-lg shadow-[inset_0_10px_24px_rgb(0_0_0/0.65)]">{children}</div>
    </div>
  );
}

/** Holds the shelf page's shape while its address is read. */
export function ShelfSkeleton() {
  return (
    <div aria-hidden="true" className="mx-auto w-full max-w-[1320px] animate-pulse px-4 py-4 motion-reduce:animate-none md:px-6 md:py-6">
      <div className="h-5 w-56 rounded bg-secondary" />
      <div className="mt-4 h-52 rounded-2xl bg-secondary/70" />
      <div className="mt-6 h-96 rounded-xl bg-secondary/50" />
    </div>
  );
}

/** Mock data must never be mistaken for a real collection. */
export function ShelfPreviewNotice() {
  return (
    <p className="flex items-start gap-2.5 rounded-lg border border-highlight/25 bg-highlight/5 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
      <FlaskConical aria-hidden="true" className="mt-px size-4 shrink-0 text-highlight" />
      <span>
        <strong className="font-medium text-foreground">Visual preview.</strong> Sample games and copies on reference console and media art, with placeholder game
        labels. Not your collection, not catalog records, and nothing here is saved.
      </span>
    </p>
  );
}

export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {items.map((item, i) => (
          <li key={item.label} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight aria-hidden="true" className="size-3.5 opacity-60" /> : null}
            {item.href ? (
              <Link href={item.href} className="rounded-sm transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="font-medium text-foreground">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Stat({ icon: Icon, value, label, className }: { icon: LucideIcon; value: string; label: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <Icon aria-hidden="true" className="size-5 shrink-0 text-primary-text" />
      <div className="leading-tight">
        <p className="text-lg font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
