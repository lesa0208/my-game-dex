import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Home's one content column: wide enough to use a large screen, centred beyond that. */
export function HomeContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[1360px] px-4 py-4 md:px-6 md:py-6", className)}>{children}</div>;
}

/** A section heading with its "see everything" link on the right. */
export function SectionHeading({ id, title, link }: { id: string; title: string; link?: { href: string; label: string } }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <h2 id={id} className="text-lg font-semibold tracking-tight sm:text-xl">
        {title}
      </h2>
      {link ? (
        <Link
          href={link.href}
          className="group inline-flex shrink-0 items-center gap-1 rounded-sm text-sm font-medium text-primary-text outline-none hover:underline hover:underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring"
        >
          {link.label}
          <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
        </Link>
      ) : null}
    </div>
  );
}

/** The violet-lit panel behind Home's headers, in the Systems page's lighting. */
export function GlowPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-2xl border border-white/10 bg-[#141319]", className)}>
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(60%_120%_at_0%_0%,rgb(139_92_246/0.22),transparent_60%),radial-gradient(50%_90%_at_100%_0%,rgb(255_176_96/0.12),transparent_70%)]"
      />
      <div className="relative">{children}</div>
    </div>
  );
}

export type Shortcut = { href: string; label: string; description: string; icon: LucideIcon };

/** Practical next steps: lighter than the systems, never a copy of the sidebar. */
export function Shortcuts({ items, labelledBy }: { items: readonly Shortcut[]; labelledBy: string }) {
  return (
    <ul aria-labelledby={labelledBy} className="grid gap-2.5 sm:grid-cols-3">
      {items.map(({ href, label, description, icon: Icon }) => (
        <li key={href}>
          <Link
            href={href}
            className="group flex h-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3.5 outline-none transition-colors hover:border-primary/50 hover:bg-white/[0.045] focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10">
              <Icon aria-hidden="true" className="size-5 text-primary-text" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-muted-foreground">{description}</span>
            </span>
            <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
