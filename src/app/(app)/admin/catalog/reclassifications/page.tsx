import { ClipboardCheck, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AdminFrame, AdminShell, PageMessage, linkClass, param } from "@/components/admin/admin-frame";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireAdminSection } from "@/features/admin/queries";
import { resolveReclassification } from "@/features/imports/actions";
import { QUEUE_ERRORS, QUEUE_NOTICES } from "@/features/imports/form";
import { getReclassificationQueue } from "@/features/imports/queries";
import { recordStatusLabel } from "@/features/records/form";
import { formatWhen } from "@/features/submissions/display";
import { adminControl, AdminField, FieldAction, InlineFieldRow } from "@/components/admin/form-controls";

export const metadata: Metadata = {
  title: "Reclassification queue",
};

async function QueueView({ searchParams }: { searchParams: PageProps<"/admin/catalog/reclassifications">["searchParams"] }) {
  const search = await searchParams;
  // Catalog editors and administrators, as get_catalog_review_queue and resolve_catalog_review allow (M5b).
  const { access } = await requireAdminSection("/admin/catalog/reclassifications", "editor");
  const notice = param(search.notice);
  const error = param(search.error);
  const queue = await getReclassificationQueue();

  return (
    <AdminFrame access={access} current="catalog" title="Reclassification queue">
      <p className="text-sm text-muted-foreground">
        Candidates a later import reconsidered but couldn&apos;t withdraw on its own: an editor checks each release, changes or excludes it if needed through its
        record, then resolves the item here. Resolving only closes the item. It changes no catalog record, and it&apos;s recorded in the audit log with your
        resolution. Oldest first.{" "}
        <Link href="/admin/catalog" className={linkClass}>
          Review submissions
        </Link>
      </p>
      <PageMessage notice={notice ? (QUEUE_NOTICES[notice] ?? null) : null} error={error ? (QUEUE_ERRORS[error] ?? null) : null} />
      {"error" in queue ? (
        <EmptyState icon={PlugZap} title="The queue isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      ) : !queue.length ? (
        <EmptyState icon={ClipboardCheck} title="Nothing waiting">
          No import item needs an editor.
        </EmptyState>
      ) : (
        <section aria-labelledby="reclassification-list">
          <h2 id="reclassification-list" className="sr-only">
            Items waiting, oldest first
          </h2>
          <ol className="flex flex-col gap-3">
            {queue.map((item, index) => {
              const r = item.release;
              const title = r ? [r.game?.title, r.platform?.name, r.product_code].filter(Boolean).join(" · ") || "Release" : "A release you can't read";
              const formId = `resolve-${index + 1}`;
              return (
                <li key={item.id} className="rounded-lg border bg-card p-4 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/catalog/releases/${item.release_id}`} className={`${linkClass} font-medium`}>
                      {title}
                    </Link>
                    {r ? <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{recordStatusLabel(r.status)}</span> : null}
                    <span className="text-xs text-muted-foreground">Queued {formatWhen(item.created_at)}</span>
                  </p>
                  <p className="mt-1 wrap-break-word">{item.reason}</p>
                  <form action={resolveReclassification} className="mt-3">
                    <input type="hidden" name="item_id" value={item.id} />
                    <InlineFieldRow>
                      <AdminField id={`${formId}-resolution`} label="How it was resolved" hint="Kept in the audit log. Visible to other catalog staff.">
                        <Input id={`${formId}-resolution`} name="resolution" required maxLength={500} autoComplete="off" aria-describedby={`${formId}-resolution-hint`} className={adminControl} />
                      </AdminField>
                      <FieldAction>
                        <Button type="submit" variant="secondary" size="control">
                          Resolve
                        </Button>
                      </FieldAction>
                    </InlineFieldRow>
                  </form>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </AdminFrame>
  );
}

export default function ReclassificationsPage({ searchParams }: PageProps<"/admin/catalog/reclassifications">) {
  return (
    <AdminShell>
      <QueueView searchParams={searchParams} />
    </AdminShell>
  );
}
