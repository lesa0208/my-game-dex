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
