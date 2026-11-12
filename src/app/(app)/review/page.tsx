import { ClipboardCheck, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { QUEUE_FILTERS, queueFilter, requestStatusLabel, submitterLabel } from "@/features/review/form";
import { canReview, getSubmissionQueue } from "@/features/review/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Review",
};

async function QueueView({ searchParams }: { searchParams: PageProps<"/review">["searchParams"] }) {
  const search = await searchParams;
  const status = queueFilter(Array.isArray(search.status) ? search.status[0] : search.status);
  const rawAfter = Array.isArray(search.after) ? search.after[0] : search.after;
  const after = rawAfter && UUID.test(rawAfter) ? rawAfter : null;
  await requireViewerWithHandle("/review");
  // Anyone else gets the same page as for an address that doesn't exist.
  if (!(await canReview())) notFound();

  const queue = await getSubmissionQueue(status, after);
  const filterHref = (value: string) => (value === "active" ? "/review" : `/review?status=${value}`);

  return (
    <>
      {/* Here, not in the static shell, so only editors ever see what this page is. */}
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Review submissions</h1>
      <p className="mb-4 text-sm text-muted-foreground">Missing games and releases sent by collectors. Oldest first.</p>
      <nav aria-label="Filter submissions" className="mb-4">
        <ul className="flex flex-wrap gap-2">
          {QUEUE_FILTERS.map((f) => (
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
      {!queue ? (
        <EmptyState icon={PlugZap} title="The queue isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      ) : !queue.items.length ? (
        <EmptyState icon={ClipboardCheck} title="Nothing here">
          {status === "active" ? "No submissions are waiting for review." : "No submissions have this status."}
        </EmptyState>
      ) : (
        <section aria-labelledby="queue-list">
          <h2 id="queue-list" className="sr-only">
            Submissions, oldest first
          </h2>
          <ol className="flex flex-col gap-2">
            {queue.items.map((item) => {
              const region = item.region ? (item.region.code === "unknown" ? "Region unknown" : item.region.label) : null;
              const line = [item.platform?.short_name, region, item.format?.name, item.edition_name].filter(Boolean).join(" · ");
              return (
                <li key={item.id}>
                  <Link
                    href={`/review/${item.id}`}
                    className="flex flex-col gap-1 rounded-lg border bg-card p-3 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring"
                  >
                    <span className="font-medium text-pretty">{item.title ?? "Submission"}</span>
                    {line ? <span className="text-sm text-muted-foreground">{line}</span> : null}
                    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="rounded-md bg-secondary px-2 py-0.5 text-secondary-foreground">{requestStatusLabel(item.status)}</span>
                      {item.kind === "new_game" ? "New game" : "Missing release"}
                      {item.resubmission ? " · Resubmitted" : ""} · {submitterLabel(item.submitter)} · {formatDay(item.created_at)}
                      {item.own ? <span className="rounded-md border px-2 py-0.5">Your submission</span> : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
          {after || queue.next_after ? (
            <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
              {after ? (
                <Button asChild variant="ghost" size="lg">
                  <Link href={filterHref(status)}>First page</Link>
                </Button>
              ) : (
                <span />
              )}
              {queue.next_after ? (
                <Button asChild variant="secondary" size="lg">
                  <Link href={`/review?status=${status}&after=${queue.next_after}`}>Next page</Link>
                </Button>
              ) : null}
            </nav>
          ) : null}
        </section>
      )}
    </>
  );
}

export default function ReviewQueuePage({ searchParams }: PageProps<"/review">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <Suspense
          fallback={
            <div aria-hidden="true" className="flex flex-col gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          }
        >
          <QueueView searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
