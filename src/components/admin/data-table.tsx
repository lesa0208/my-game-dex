import { PlugZap } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { CurrentTabIntoView } from "@/components/admin/current-tab-into-view";
import { EmptyState } from "@/components/shared/empty-state";
import { cn } from "@/lib/utils";

/**
 * A plain, accessible table for the read-only admin views (M10d). It scrolls inside
 * its own frame on a narrow screen, so the page never does, and the frame can take
 * keyboard focus to scroll.
 */
export function DataTable({ id, caption, head, children }: { id: string; caption: string; head: string[]; children: ReactNode }) {
  return (
    <div role="region" aria-labelledby={`${id}-caption`} tabIndex={0} className="overflow-x-auto rounded-xl border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/60">
      <table id={id} className="w-full min-w-[36rem] border-collapse text-left text-sm">
        <caption id={`${id}-caption`} className="sr-only">
          {caption}
        </caption>
        <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-4 py-2.5 font-medium tracking-wide whitespace-nowrap uppercase">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y [&>tr]:transition-colors [&>tr:hover]:bg-muted/30">{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children, className, header = false }: { children: ReactNode; className?: string; header?: boolean }) {
  return header ? (
    <th scope="row" className={cn("px-4 py-3 align-top font-medium", className)}>
      {children}
    </th>
  ) : (
    <td className={cn("px-4 py-3 align-top", className)}>{children}</td>
  );
}

/** A status in words, with a tone: good, warning, problem or neutral. Never colour alone. */
export function StatusPill({ tone = "neutral", children }: { tone?: "good" | "warning" | "problem" | "neutral"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs leading-5 font-medium whitespace-nowrap",
        tone === "good" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
        tone === "warning" && "border-amber-500/40 bg-amber-500/10 text-amber-200",
        tone === "problem" && "border-destructive/40 bg-destructive/10 text-destructive",
        tone === "neutral" && "border-transparent bg-secondary text-secondary-foreground",
      )}
    >
      {children}
    </span>
  );
}

/**
 * Links between the pages of one section: a lighter, underlined second level under
 * the admin sections. One scrolling row on a phone, wrapped from 640px.
 */
export function SubNav({ label, items, current }: { label: string; items: { href: string; label: string }[]; current: string }) {
  return (
    <nav aria-label={label} className="relative -mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:overflow-visible sm:px-0">
      <ul className="flex w-max gap-1 border-b sm:w-auto sm:flex-wrap">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.href === current ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm whitespace-nowrap outline-none transition-colors focus-visible:rounded-md focus-visible:ring-3 focus-visible:ring-ring/60",
                item.href === current ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
      <CurrentTabIntoView />
    </nav>
  );
}

export const REFERENCE_PAGES = [
  { href: "/admin/reference", label: "Summary" },
  { href: "/admin/reference/platforms", label: "Platforms" },
  { href: "/admin/reference/formats", label: "Media formats" },
  { href: "/admin/reference/regions", label: "Regions and markets" },
  { href: "/admin/reference/requirements", label: "Hardware requirements" },
];

export const selectClass =
  "h-10 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring md:text-sm dark:bg-input/30";

/** A time in UTC, as the audit log shows it. */
export function when(at: string | null): string | null {
  return at ? new Date(at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : null;
}

/** Reference data that's unavailable, as every reference page says it. */
export function ReferenceUnavailable() {
  return (
    <EmptyState icon={PlugZap} title="Reference data isn't available">
      It can&apos;t be loaded right now. Try again later.
    </EmptyState>
  );
}

