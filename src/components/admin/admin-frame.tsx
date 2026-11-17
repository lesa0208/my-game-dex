import { CircleAlert, CircleCheck, ShieldAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminAccess } from "@/features/admin/queries";
import { cn } from "@/lib/utils";
import { CurrentTabIntoView } from "@/components/admin/current-tab-into-view";
import { adminControl, AdminField } from "@/components/admin/form-controls";

export type AdminSection = "overview" | "catalog" | "reference" | "imports" | "accounts" | "staff" | "audit" | "ownership" | "system";

const SECTIONS: { id: AdminSection; label: string; href: string; allowed: (a: AdminAccess) => boolean }[] = [
  { id: "overview", label: "Overview", href: "/admin", allowed: (a) => a.staff },
  { id: "catalog", label: "Catalog", href: "/admin/catalog", allowed: (a) => a.editor },
  { id: "reference", label: "Reference", href: "/admin/reference", allowed: (a) => a.editor },
  { id: "imports", label: "Imports", href: "/admin/imports", allowed: (a) => a.admin },
  { id: "accounts", label: "Accounts", href: "/admin/accounts", allowed: (a) => a.moderator },
  { id: "staff", label: "Staff", href: "/admin/staff", allowed: (a) => a.admin },
  { id: "audit", label: "Audit log", href: "/admin/audit", allowed: (a) => a.admin },
  { id: "ownership", label: "Ownership", href: "/admin/ownership", allowed: (a) => a.admin },
  { id: "system", label: "System", href: "/admin/system", allowed: (a) => a.admin },
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
  narrow = false,
  children,
}: {
  access: AdminAccess;
  current: AdminSection;
  title: string;
  /** An id for the heading, for a page whose sections are labelled by it. */
  titleId?: string;
  /** Forms and reviews: the content keeps a readable width while the sections use the column. */
  narrow?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Admin</p>
          <h1 id={titleId} className="text-2xl font-semibold tracking-tight text-pretty">
            {title}
          </h1>
        </div>
        <TabNav label="Admin sections" items={SECTIONS.filter((s) => s.allowed(access)).map((s) => ({ href: s.href, label: s.label, current: s.id === current }))} />
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
      {/* Running text stays at a readable measure in the wide column; tables and cards use it all. */}
      <div className={cn("flex min-w-0 flex-col gap-5 [&>p]:max-w-3xl", narrow && "max-w-3xl")}>{children}</div>
    </div>
  );
}

/**
 * A row of section links, the current one marked. One scrolling row on a phone, so
 * the sections never push the page down; wrapped rows from 640px. The links take
 * keyboard focus, and the row scrolls to whichever has it.
 */
export function TabNav({ label, items }: { label: string; items: { href: string; label: string; current: boolean }[] }) {
  return (
    <div className="relative -mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:overflow-visible sm:px-0">
      <nav aria-label={label}>
        <ul className="flex w-max gap-1 rounded-xl border bg-card/60 p-1 sm:w-auto sm:flex-wrap">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={item.current ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center rounded-lg px-3 text-sm whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/60",
                  item.current
                    ? "bg-primary/15 font-medium text-foreground ring-1 ring-primary/60 ring-inset"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <CurrentTabIntoView />
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
      {/* Always present, so an error is announced; while empty it takes back the gap above it. */}
      <div role="alert" aria-live="assertive" className="empty:-mt-5">
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

/** A titled panel: the same padding, radius and heading on every admin page. */
export function AdminCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
      <h2 id={id} className="mb-4 text-base font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A required reason for the audit log, as every staff action needs. */
export function ReasonInput({
  id,
  label = "Reason, for the record",
  hint = "Kept in the audit log. Only staff see it.",
}: {
  id: string;
  label?: string;
  hint?: string;
}) {
  return (
    <AdminField id={id} label={label} hint={hint}>
      <Input id={id} name="reason" required maxLength={500} autoComplete="off" aria-describedby={`${id}-hint`} className={adminControl} />
    </AdminField>
  );
}

export const linkClass = "text-primary-text underline underline-offset-4";

/** The page around every /admin view: the layout, and a placeholder while access is read. */
export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <PageLayout wide>
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
