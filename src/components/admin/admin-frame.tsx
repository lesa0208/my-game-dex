import { CircleAlert, CircleCheck, ShieldAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminAccess } from "@/features/admin/queries";
import { cn } from "@/lib/utils";

export type AdminSection = "overview" | "catalog" | "accounts" | "staff" | "audit" | "ownership";

const SECTIONS: { id: AdminSection; label: string; href: string; allowed: (a: AdminAccess) => boolean }[] = [
  { id: "overview", label: "Overview", href: "/admin", allowed: (a) => a.staff },
  { id: "catalog", label: "Catalog", href: "/admin/catalog", allowed: (a) => a.editor },
  { id: "accounts", label: "Accounts", href: "/admin/accounts", allowed: (a) => a.moderator },
  { id: "staff", label: "Staff", href: "/admin/staff", allowed: (a) => a.admin },
  { id: "audit", label: "Audit log", href: "/admin/audit", allowed: (a) => a.admin },
  { id: "ownership", label: "Ownership", href: "/admin/ownership", allowed: (a) => a.admin },
];

/**
 * The /admin heading and its sections, only those the viewer's live roles allow. It's
 * rendered after the access check, so nobody else ever sees what /admin contains.
 */
export function AdminFrame({
  access,
  current,
  title,
  titleId,
  children,
}: {
  access: AdminAccess;
  current: AdminSection;
  title: string;
  /** An id for the heading, for a page whose sections are labelled by it. */
  titleId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Admin</p>
        <h1 id={titleId} className="text-xl font-semibold tracking-tight text-pretty">
          {title}
        </h1>
        <nav aria-label="Admin sections">
          <ul className="flex flex-wrap gap-2">
            {SECTIONS.filter((s) => s.allowed(access)).map((s) => (
              <li key={s.id}>
                <Link
                  href={s.href}
                  aria-current={s.id === current ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-10 items-center rounded-lg border px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring",
                    s.id === current ? "border-primary bg-primary/10 font-medium" : "hover:bg-muted",
                  )}
                >
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      {access.recoveryPending ? (
        <p className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            An ownership recovery is in progress. Owner actions are paused until it ends.{" "}
            {access.admin ? (
              <Link href="/admin/ownership" className="text-primary-text underline underline-offset-4">
                Details
              </Link>
            ) : null}
          </span>
        </p>
      ) : null}
      {children}
    </div>
  );
}

/** The outcome of the last action, from the page's URL: a fixed notice or error, or nothing. */
export function PageMessage({ notice, error }: { notice: string | null; error: string | null }) {
  return (
    <>
      {notice ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
          {notice}
        </p>
      ) : null}
      <div role="alert" aria-live="assertive">
        {error ? (
          <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}

export function AdminCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border bg-card p-4">
      <h2 id={id} className="mb-3 text-sm font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A required reason for the audit log, as every staff action needs. */
export function ReasonInput({ id, label = "Reason, for the record" }: { id: string; label?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input id={id} name="reason" required maxLength={500} autoComplete="off" aria-describedby={`${id}-hint`} className="h-10" />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Kept in the audit log. Only staff see it.
      </p>
    </div>
  );
}

export const linkClass = "text-primary-text underline underline-offset-4";

/** The page around every /admin view: the layout, and a placeholder while access is read. */
export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <Suspense
          fallback={
            <div aria-hidden="true" className="flex flex-col gap-3">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          }
        >
          {children}
        </Suspense>
      </div>
    </PageLayout>
  );
}

/** A search parameter's first value, or null. */
export function param(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && v.length > 0 ? v : null;
}
