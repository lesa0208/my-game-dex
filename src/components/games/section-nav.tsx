"use client";

import { useRef, useState } from "react";

/**
 * M17b: the game page's parts, as tabs that jump to each (every part stays on the page,
 * for the keyboard, find-in-page, printing and the add steps that work without
 * JavaScript). One stop for the Tab key; the arrow keys, Home and End move along it, so
 * a collector tabbing to the add steps isn't held up by every tab.
 */
export function SectionNav({ items }: { items: { id: string; label: string; count?: number | null }[] }) {
  const list = useRef<HTMLUListElement>(null);
  const [focus, setFocus] = useState(0);

  function move(event: React.KeyboardEvent<HTMLUListElement>) {
    const links = [...(list.current?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at < 0) return;
    const next =
      event.key === "ArrowRight" ? Math.min(at + 1, links.length - 1) : event.key === "ArrowLeft" ? Math.max(at - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setFocus(next);
    links[next].focus();
  }

  return (
    <nav aria-label="On this page" className="sticky top-14 z-10 -mx-4 border-b border-white/[0.08] bg-background/90 px-4 backdrop-blur md:top-16 md:mx-0 md:px-0">
      <ul ref={list} onKeyDown={move} className="flex gap-1 overflow-x-auto [scrollbar-width:none]" aria-describedby="section-nav-hint">
        {items.map((item, i) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              tabIndex={i === focus ? 0 : -1}
              className="inline-flex h-12 items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:border-white/20 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset"
            >
              {item.label}
              {typeof item.count === "number" ? <span className="text-xs text-muted-foreground tabular-nums">({item.count})</span> : null}
            </a>
          </li>
        ))}
      </ul>
      <p id="section-nav-hint" className="sr-only">
        Use the arrow keys to move between the parts of this page.
      </p>
    </nav>
  );
}
