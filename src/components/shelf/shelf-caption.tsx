"use client";

import { Star } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * A title under an item on the shelf: centred, at most two lines, always two lines tall
 * so every item on a shelf lines up. A title cut short shows in full on hover and
 * keyboard focus of its link (the `group`); screen readers and touch users get the full
 * title from the link's text and the game page it opens.
 */
export function ShelfCaption({ title, favorite }: { title: string; favorite: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [title]);

  const text = (
    <>
      {favorite ? <Star aria-hidden="true" className="mr-1 inline size-3 shrink-0 -translate-y-px fill-amber-300 text-amber-300" /> : null}
      {title}
    </>
  );

  return (
    <span className="relative mt-2.5 block w-full">
      <span
        ref={ref}
        className="line-clamp-2 min-h-[2lh] w-full text-center text-[0.72rem] leading-snug font-medium text-balance break-words text-stone-200 transition-colors group-hover:text-white sm:text-xs"
      >
        {text}
        {favorite ? <span className="sr-only"> (favorite)</span> : null}
      </span>
      {cut ? (
        // The full title, laid over the clipped one; decorative, as the text above is complete.
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute -inset-x-1 top-[-0.25rem] z-20 hidden rounded-md border border-white/10 bg-[#141218]/95 px-1.5 py-1 text-center text-[0.72rem] leading-snug font-medium text-balance break-words text-white shadow-[0_8px_20px_-6px_rgb(0_0_0/0.9)] sm:text-xs",
            "group-hover:block group-focus-visible:block",
          )}
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}
