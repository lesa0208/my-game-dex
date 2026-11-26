"use client";

import Link from "next/link";
import { useRef } from "react";

import { cn } from "@/lib/utils";

export type SystemChip = { key: string; href: string; label: string; count: number | null; current: boolean };

/**
 * Explore's systems as quick filters (M17a): one tap, no extra Search. The row is one
 * stop for the Tab key (the current system); the arrow keys, Home and End move along it,
 * so a collector tabbing from the search to the results isn't held up by every system.
 */
export function SystemChips({ chips }: { chips: SystemChip[] }) {
  const list = useRef<HTMLUListElement>(null);
  const current = Math.max(0, chips.findIndex((c) => c.current));

  function move(event: React.KeyboardEvent<HTMLUListElement>) {
    const links = [...(list.current?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at < 0) return;
    const next =
      event.key === "ArrowRight" ? Math.min(at + 1, links.length - 1) : event.key === "ArrowLeft" ? Math.max(at - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    links[next].focus();
    links[next].scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  return (
    <nav aria-label="Systems" className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
      <ul ref={list} onKeyDown={move} className="flex gap-2 pb-1 md:flex-wrap" aria-describedby="system-chips-hint">
        {chips.map((chip, i) => (
          <li key={chip.key}>
            <Link
              href={chip.href}
              tabIndex={i === current ? 0 : -1}
              aria-current={chip.current ? "page" : undefined}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none",
                chip.current ? "border-primary bg-primary/15 font-medium text-foreground" : "border-white/10 text-muted-foreground hover:border-white/25 hover:text-foreground",
              )}
            >
              {chip.label}
              {chip.count !== null ? <span className="text-xs text-muted-foreground tabular-nums">{chip.count}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
      <p id="system-chips-hint" className="sr-only">
        Use the arrow keys to move between systems.
      </p>
    </nav>
  );
}
