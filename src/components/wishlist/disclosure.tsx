"use client";

import { type ReactNode, useState } from "react";

/**
 * A <details> that starts open or closed as the server says, then stays as the person
 * left it: a refresh after adding a wish mustn't fold the form away mid-use, as a
 * server-set `open` would.
 */
export function Disclosure({ initialOpen, summary, className, summaryClassName, children }: { initialOpen: boolean; summary: ReactNode; className?: string; summaryClassName?: string; children: ReactNode }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className={className}>
      <summary className={summaryClassName}>{summary}</summary>
      {children}
    </details>
  );
}
