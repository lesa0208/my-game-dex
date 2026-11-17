"use client";

import { useEffect, useRef } from "react";

/**
 * On a phone the admin section links are one scrolling row; this brings the current
 * one into view when the page opens. It moves only that row, never the page, and
 * does nothing where the row isn't scrollable.
 */
export function CurrentTabIntoView() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const row = marker.current?.parentElement;
    const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !current || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = Math.max(0, current.offsetLeft - (row.clientWidth - current.offsetWidth) / 2);
  }, []);
  return <span ref={marker} hidden />;
}
