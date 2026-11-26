"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * A shelf that scrolls sideways when its games don't all fit, without ever widening the
 * page. Swipe, the scrollbar, Tab through the games (each scrolls into view), or the
 * arrow buttons, which appear only while there is more to see that way; the edge fades
 * show the same.
 */
export function ShelfScroller({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setMore({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [measure]);

  const page = (direction: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <div className="relative">
      <div
        ref={ref}
        role="region"
        aria-label={label}
        data-shelf-scroller=""
        className="snap-x snap-proximity overflow-x-auto overscroll-x-contain [scrollbar-color:rgb(255_255_255/0.25)_transparent] [scrollbar-width:thin]"
      >
        {children}
      </div>
      <Fade side="left" visible={more.left} />
      <Fade side="right" visible={more.right} />
      <Arrow side="left" visible={more.left} onClick={() => page(-1)} />
      <Arrow side="right" visible={more.right} onClick={() => page(1)} />
    </div>
  );
}

function Fade({ side, visible }: { side: "left" | "right"; visible: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 w-10 from-black/70 to-transparent transition-opacity duration-200 motion-reduce:transition-none",
        side === "left" ? "left-0 bg-linear-to-r" : "right-0 bg-linear-to-l",
        visible ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

function Arrow({ side, visible, onClick }: { side: "left" | "right"; visible: boolean; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Show earlier games on the shelf" : "Show more games on the shelf"}
      data-shelf-arrow={side}
      className={cn(
        "absolute top-[calc(1.75rem+var(--stage,6rem)/2)] flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/70 text-foreground shadow-lg backdrop-blur-sm outline-none hover:bg-black/85 focus-visible:ring-3 focus-visible:ring-ring",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      <Icon aria-hidden="true" className="size-5" />
    </button>
  );
}
