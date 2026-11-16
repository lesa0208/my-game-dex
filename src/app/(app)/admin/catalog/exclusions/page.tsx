import { History, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell } from "@/components/admin/admin-frame";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { requireAdminSection } from "@/features/admin/queries";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { exclusionReasonLabel, releaseLabelLine } from "@/features/exclusion/form";
import { getExclusions } from "@/features/exclusion/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Exclusions",
};

const FILTERS = [
  { value: "active", label: "Excluded" },
  { value: "restored", label: "Restored" },
] as const;

async function ExclusionsView({ searchParams }: { searchParams: PageProps<"/admin/catalog/exclusions">["searchParams"] }) {
  const search = await searchParams;
  const status = search.status === "restored" ? "restored" : "active";
  const rawAfter = Array.isArray(search.after) ? search.after[0] : search.after;
  const after = rawAfter && UUID.test(rawAfter) ? rawAfter : null;
  // Administrators only (D8); staff signed in without their authenticator verify first.
  const { access } = await requireAdminSection("/admin/catalog/exclusions", "admin");

  const outcome = await getExclusions(status, after);
  // Anyone but an administrator gets the same page as for an address that doesn't exist.
  if (!outcome.ok && outcome.reason === "refused") notFound();
  const filterHref = (value: string) => (value === "active" ? "/admin/catalog/exclusions" : `/admin/catalog/exclusions?status=${value}`);

  return (
    <AdminFrame access={access} current="catalog" title="Exclusions">
      <p className="text-sm text-muted-foreground">Releases excluded from the catalog, newest first. Only administrators can restore one, and not their own.</p>
      <nav aria-label="Filter exclusions">
        <ul className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <li key={f.value}>
              <Link
                href={filterHref(f.value)}
                aria-current={f.value === status ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-10 items-center rounded-lg border px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring",
                  f.value === status ? "border-primary bg-primary/10 font-medium" : "hover:bg-muted",
                )}
              >
                {f.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {!outcome.ok ? (
        <EmptyState icon={PlugZap} title="Exclusions aren't available">
          They can&apos;t be loaded right now. Try again later.
        </EmptyState>
      ) : !outcome.data.items.length ? (
        <EmptyState icon={History} title="Nothing here">
          {status === "active" ? "No releases are excluded." : "No exclusions have been restored."}
        </EmptyState>
      ) : (
        <section aria-labelledby="exclusions-list">
          <h2 id="exclusions-list" className="sr-only">
            Exclusions, newest first
          </h2>
          <ol className="flex flex-col gap-2">
            {outcome.data.items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/admin/catalog/exclusions/${item.id}`}
                  className="flex flex-col gap-1 rounded-lg border bg-card p-3 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring"
                >
                  <span className="font-medium text-pretty">{item.release.game.title}</span>
                  <span className="text-sm text-muted-foreground">{releaseLabelLine(item.release)}</span>
                  <span className="text-xs text-muted-foreground">
                    {exclusionReasonLabel(item.reason_code)} · Excluded {formatDay(item.excluded_at)} ·{" "}
                    {item.copies_preserved === 1 ? "1 copy" : `${item.copies_preserved.toLocaleString("en")} copies`} preserved
                    {item.restored_at ? ` · Restored ${formatDay(item.restored_at)}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
          {after || outcome.data.next ? (
            <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
              {after ? (
                <Button asChild variant="ghost" size="lg">
                  <Link href={filterHref(status)}>First page</Link>
                </Button>
              ) : (
                <span />
              )}
              {outcome.data.next ? (
                <Button asChild variant="secondary" size="lg">
                  <Link href={`/admin/catalog/exclusions?status=${status}&after=${outcome.data.next}`}>Next page</Link>
                </Button>
              ) : null}
            </nav>
          ) : null}
        </section>
      )}
    </AdminFrame>
  );
}

export default function ExclusionsPage({ searchParams }: PageProps<"/admin/catalog/exclusions">) {
  return (
    <AdminShell>
      <ExclusionsView searchParams={searchParams} />
    </AdminShell>
  );
}
