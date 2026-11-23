import { ClipboardList, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { BatchStatusPill, Callout, FilterLinks, Pager, personText } from "@/components/admin/batch-review";
import { adminSelect, AdminField, FormActions } from "@/components/admin/form-controls";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { requireAdminSection } from "@/features/admin/queries";
import { BATCH_STATUS_FILTERS, batchStatusFilter, type BatchStatusFilter } from "@/features/batches/form";
import { listReviewBatches, type BatchSummary } from "@/features/batches/queries";
import { formatDay } from "@/features/collection/details";
import { getSubmissionOptions } from "@/features/submissions/queries";

export const metadata: Metadata = {
  title: "Review batches",
};

const PLATFORM = /^[a-z0-9-]{1,40}$/;

function href(status: BatchStatusFilter, platform: string | null, after?: string | null) {
  const q = new URLSearchParams();
  if (status !== "open") q.set("status", status);
  if (platform) q.set("platform", platform);
  if (after) q.set("after", after);
  const s = q.toString();
  return `/admin/catalog/batches${s ? `?${s}` : ""}`;
}

function BatchCard({ batch }: { batch: BatchSummary }) {
  const short = batch.id.slice(0, 8);
  return (
    <li>
      <article aria-labelledby={`batch-${batch.id}`} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`batch-${batch.id}`} className="text-sm font-semibold">
            <Link href={`/admin/catalog/batches/${batch.id}`} className="rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring">
              Batch <code className="font-mono">{short}</code> · {batch.platform.name}
            </Link>
          </h3>
          <BatchStatusPill status={batch.status} />
        </header>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Members</dt>
            <dd className="tabular-nums">{batch.items.toLocaleString("en")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Flagged · sampled</dt>
            <dd className="tabular-nums">
              {batch.flagged.toLocaleString("en")} · {batch.sampled.toLocaleString("en")}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Reviews recorded</dt>
            <dd className="tabular-nums">
              {batch.recorded.toLocaleString("en")} of {batch.required.toLocaleString("en")}
              {batch.status === "open" && batch.pending ? <span className="text-muted-foreground"> · {batch.pending.toLocaleString("en")} pending</span> : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Critical</dt>
            <dd className="tabular-nums">
              {batch.critical_signals.toLocaleString("en")} {batch.critical_signals === 1 ? "signal" : "signals"}
              {batch.critical_errors ? <span className="text-destructive"> · {batch.critical_errors.toLocaleString("en")} recorded</span> : null}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          {batch.source.provider_name ?? batch.source.provider} · {batch.source.name} · created {formatDay(batch.created_at)} by {personText(batch.creator)} · approvals{" "}
          {batch.approvals.recorded} of {batch.approvals.required}
          {batch.decided_at ? ` · decided ${formatDay(batch.decided_at)}` : ""}
        </p>
      </article>
    </li>
  );
}

async function BatchesView({ searchParams }: { searchParams: PageProps<"/admin/catalog/batches">["searchParams"] }) {
  const search = await searchParams;
  const status = batchStatusFilter(param(search.status));
  const rawPlatform = param(search.platform);
  const platform = rawPlatform && PLATFORM.test(rawPlatform) ? rawPlatform : null;
  const after = param(search.after);
  // Catalog editors only; staff signed in without their authenticator verify first.
  const { access } = await requireAdminSection("/admin/catalog/batches", "editor");
  const [list, options] = await Promise.all([listReviewBatches(status, platform, after), getSubmissionOptions()]);

  return (
    <AdminFrame access={access} current="catalog" title="Review batches">
      <p className="text-sm">
        <Link href="/admin/catalog" className={linkClass}>
          Review submissions
        </Link>{" "}
        <Link href="/admin/catalog/search" className={linkClass}>
          Catalog records
        </Link>
      </p>
      <p className="text-sm text-muted-foreground">
        Frozen batches of imported game identities. Flagged and sampled members are reviewed one by one; the rest are accepted with the batch only if
        its sample passes. Newest first.
      </p>
      <Callout title="An accepted identity isn't a physical game">
        A source listing a game on a platform is not proof that a physical copy exists. A member is published only after an editor confirms its
        physical existence with evidence, and another editor publishes it. Approving and rejecting batches isn&apos;t done on these pages yet.
      </Callout>
      <FilterLinks
        label="Filter batches by status"
        items={BATCH_STATUS_FILTERS.map((f) => ({ href: href(f.value, platform), label: f.label, current: f.value === status }))}
      />
      <form method="get" action="/admin/catalog/batches" className="flex flex-wrap items-end gap-3">
        {status !== "open" ? <input type="hidden" name="status" value={status} /> : null}
        <AdminField id="batches-platform" label="Platform" className="w-full sm:w-72">
          <select id="batches-platform" name="platform" defaultValue={platform ?? ""} className={adminSelect}>
            <option value="">Any platform</option>
            {(options?.platforms ?? []).map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </AdminField>
        <FormActions>
          <Button type="submit" variant="secondary" size="control">
            Show
          </Button>
          {platform ? (
            <Button asChild variant="ghost" size="control">
              <Link href={href(status, null)}>Any platform</Link>
            </Button>
          ) : null}
        </FormActions>
      </form>
      {!list.ok ? (
        <EmptyState icon={PlugZap} title="Review batches aren't available">
          {list.reason === "refused" ? "This page can't be shown with these filters." : "They can't be loaded right now. Try again later."}
        </EmptyState>
      ) : !list.data || list.data.status === "unknown_platform" ? (
        <EmptyState icon={ClipboardList} title="No such platform">
          Choose a platform from the list.
        </EmptyState>
      ) : !list.data.items.length ? (
        <EmptyState icon={ClipboardList} title={after ? "No more batches" : "No review batches"}>
          {status === "open" && !platform && !after
            ? "No batch is waiting for review. Batches are created from a staged import run, outside these pages."
            : "No batch matches these filters."}
        </EmptyState>
      ) : (
        <section aria-labelledby="batch-list" className="flex flex-col gap-4">
          <h2 id="batch-list" className="sr-only">
            Review batches, newest first
          </h2>
          <ol className="flex flex-col gap-3">
            {list.data.items.map((b) => (
              <BatchCard key={b.id} batch={b} />
            ))}
          </ol>
          <Pager first={after ? href(status, platform) : null} next={list.data.next_after ? href(status, platform, list.data.next_after) : null} />
        </section>
      )}
    </AdminFrame>
  );
}

export default function ReviewBatchesPage({ searchParams }: PageProps<"/admin/catalog/batches">) {
  return (
    <AdminShell>
      <BatchesView searchParams={searchParams} />
    </AdminShell>
  );
}
