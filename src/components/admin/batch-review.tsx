import { CircleAlert, Info, ShieldAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { StatusPill } from "@/components/admin/data-table";
import { Button } from "@/components/ui/button";
import {
  BATCH_STATUS_LABELS,
  batchTone,
  CATEGORY_LABELS,
  criticalErrorLabel,
  flagLabel,
  flagReason,
  type MemberCategory,
  OUTCOME_LABELS,
  type Outcome,
} from "@/features/batches/form";
import type { Person } from "@/features/batches/queries";
import { cn } from "@/lib/utils";

/**
 * The review-batch pages' shared pieces (M14c-2). Read-only: every state shown here comes from
 * the database's own assessment. Provider text is always rendered as text, never as markup.
 */

export function BatchStatusPill({ status }: { status: string }) {
  return <StatusPill tone={batchTone(status)}>{BATCH_STATUS_LABELS[status] ?? status}</StatusPill>;
}

const CATEGORY_TONES: Record<MemberCategory, "good" | "warning" | "problem" | "neutral"> = {
  critical: "problem",
  flagged: "warning",
  sampled: "neutral",
  unsampled: "neutral",
};

export function CategoryPill({ category }: { category: MemberCategory }) {
  return (
    <StatusPill tone={CATEGORY_TONES[category]}>
      {category === "critical" ? <ShieldAlert aria-hidden="true" className="mr-1 size-3.5" /> : null}
      {CATEGORY_LABELS[category]}
    </StatusPill>
  );
}

/** A member's outcome, or where it stands without one. */
export function OutcomePill({ outcome, requiresOutcome, status }: { outcome: Outcome | null; requiresOutcome: boolean; status: string }) {
  if (outcome) return <StatusPill tone={outcome === "correct" ? "good" : "problem"}>{OUTCOME_LABELS[outcome]}</StatusPill>;
  if (!requiresOutcome) return <StatusPill>No individual review</StatusPill>;
  return <StatusPill tone="warning">{status === "open" ? "Awaiting review" : "Not reviewed"}</StatusPill>;
}

/** A person by handle, "You", or a deleted account. Never an email address or an id. */
export function personText(person: Person): string {
  if (!person) return "Nobody";
  if (person.you) return "You";
  return person.handle ? `@${person.handle}` : "A former staff member";
}

/** A hash or identifier, wrapped so it never widens the page. */
export function Hash({ value }: { value: string | null }) {
  return value ? <code className="font-mono text-xs break-all">{value}</code> : null;
}

/** A member's validator flags, each with why it matters, and its critical signals. */
export function FlagList({ flags, infoFlags, criticalFlags }: { flags: string[]; infoFlags: string[]; criticalFlags: string[] }) {
  if (!flags.length && !infoFlags.length) return <p className="text-sm text-muted-foreground">No validator flags.</p>;
  return (
    <div className="flex flex-col gap-3">
      {flags.length ? (
        <ul aria-label="Review flags" className="flex flex-col gap-2">
          {flags.map((f) => (
            <li key={f} className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
              <span className="font-medium">{flagLabel(f)}</span> <code className="text-xs text-muted-foreground">{f}</code>
              <span className="block text-muted-foreground">{flagReason(f)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {criticalFlags.length ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
            Possible critical {criticalFlags.length === 1 ? "error" : "errors"}
          </p>
          <ul className="mt-1 list-disc pl-5">
            {criticalFlags.map((c) => (
              <li key={c}>{criticalErrorLabel(c)}</li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">A flag only points to where one may be. You decide; finding it correct needs your evidence.</p>
        </div>
      ) : null}
      {infoFlags.length ? (
        <ul aria-label="Information flags" className="flex flex-col gap-2">
          {infoFlags.map((f) => (
            <li key={f} className="rounded-lg border px-3 py-2 text-sm">
              <span className="font-medium">{flagLabel(f)}</span> <span className="text-xs text-muted-foreground">(shown only)</span>
              <span className="block text-muted-foreground">{flagReason(f)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Progress through the required reviews, in words and as a bar the words describe. */
export function ReviewProgress({ recorded, required }: { recorded: number; required: number }) {
  const share = required ? Math.round((recorded / required) * 100) : 100;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm">
        <span className="font-medium">
          {recorded.toLocaleString("en")} of {required.toLocaleString("en")}
        </span>{" "}
        individual reviews recorded{required ? ` (${share}%)` : ""}
      </p>
      <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

/** A plain callout: information, a warning, or a problem. Never colour alone. */
export function Callout({ tone = "info", title, children }: { tone?: "info" | "warning" | "problem"; title?: string; children: ReactNode }) {
  const Icon = tone === "info" ? Info : tone === "warning" ? ShieldAlert : CircleAlert;
  return (
    <div
      className={cn(
        "flex gap-2 rounded-lg border px-3 py-2.5 text-sm",
        tone === "info" && "border-primary/30 bg-primary/5",
        tone === "warning" && "border-amber-500/40 bg-amber-500/10",
        tone === "problem" && "border-destructive/40 bg-destructive/10",
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        {title ? <p className="font-medium">{title}</p> : null}
        <div className="text-pretty">{children}</div>
      </div>
    </div>
  );
}

/** Filters as links, the current one marked, each with its count when known. */
export function FilterLinks({ label, items }: { label: string; items: { href: string; label: string; count?: number; current: boolean }[] }) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-2">
        {items.map((f) => (
          <li key={f.href}>
            <Link
              href={f.href}
              aria-current={f.current ? "page" : undefined}
              className={cn(
                "inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring",
                f.current ? "border-primary bg-primary/10 font-medium" : "hover:bg-muted",
              )}
            >
              {f.label}
              {f.count !== undefined ? <span className="text-muted-foreground tabular-nums">{f.count.toLocaleString("en")}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** First page and next page links, for keyset pages. */
export function Pager({ first, next }: { first: string | null; next: string | null }) {
  if (!first && !next) return null;
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2">
      {first ? (
        <Button asChild variant="ghost" size="control">
          <Link href={first}>First page</Link>
        </Button>
      ) : (
        <span />
      )}
      {next ? (
        <Button asChild variant="secondary" size="control">
          <Link href={next}>Next page</Link>
        </Button>
      ) : null}
    </nav>
  );
}

/** A critical error recorded with an outcome, in words. */
export function CriticalErrorText({ code }: { code: string | null }) {
  return code ? <span>{criticalErrorLabel(code)}</span> : null;
}
