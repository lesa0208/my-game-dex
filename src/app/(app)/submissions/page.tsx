import { FilePlus2, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";
import { formatDay } from "@/features/collection/details";
import { formatWhen } from "@/features/submissions/display";
import { statusLabel } from "@/features/submissions/form";
import { getMySubmissions } from "@/features/submissions/queries";
import { UUID } from "@/features/collection/uuid";

export const metadata: Metadata = {
  title: "My submissions",
};

async function SubmissionsView({ searchParams }: { searchParams: PageProps<"/submissions">["searchParams"] }) {
  const search = await searchParams;
  const raw = Array.isArray(search.before) ? search.before[0] : search.before;
  const before = raw && UUID.test(raw) ? raw : null;
  await requireViewerWithHandle(before ? `/submissions?before=${before}` : "/submissions");
  const mine = await getMySubmissions(before);
  if (!mine) {
    return (
      <EmptyState icon={PlugZap} title="Your submissions aren't available">
        They can&apos;t be loaded right now. Try again later.
      </EmptyState>
    );
  }
  const { allowance } = mine;
  const allowanceText =
    allowance.used >= allowance.limit
      ? `You've reached today's limit of ${allowance.limit}.${allowance.next_available_at ? ` You can submit again after ${formatWhen(allowance.next_available_at)}.` : ""}`
      : `You can make ${allowance.limit - allowance.used} more today.`;

  if (!mine.items.length && !before) {
    return (
      <EmptyState
        icon={FilePlus2}
        title="You haven't submitted anything yet"
        action={
          <Button asChild size="lg">
            <Link href="/submit">Submit a game</Link>
          </Button>
        }
      >
        If the catalog is missing a physical release you own, submit it. Only you and catalog editors see it until it&apos;s published.
      </EmptyState>
    );
  }

  return (
    <section aria-labelledby="submissions-list">
      <h2 id="submissions-list" className="sr-only">
        Your submissions, newest first
      </h2>
      <p className="mb-3 text-sm text-muted-foreground">{allowanceText}</p>
      <ol className="flex flex-col gap-2">
        {mine.items.map((item) => {
          const region = item.region ? (item.region.code === "unknown" ? "Region unknown" : item.region.label) : null;
          const line = [item.platform?.short_name, region, item.edition_name].filter(Boolean).join(" · ");
          return (
            <li key={item.id}>
              <Link
                href={`/submissions/${item.id}`}
                className="flex flex-col gap-1 rounded-lg border bg-card p-3 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring"
              >
                <span className="font-medium text-pretty">{item.title ?? "Submission"}</span>
                {line ? <span className="text-sm text-muted-foreground">{line}</span> : null}
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-md bg-secondary px-2 py-0.5 text-secondary-foreground">{statusLabel(item.status)}</span>
                  {item.kind === "new_game" ? "New game" : "Missing release"} · Submitted {formatDay(item.created_at)}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      {before || mine.next_before ? (
        <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
          {before ? (
            <Button asChild variant="ghost" size="lg">
              <Link href="/submissions">Newest</Link>
            </Button>
          ) : (
            <span />
          )}
          {mine.next_before ? (
            <Button asChild variant="secondary" size="lg">
              <Link href={`/submissions?before=${mine.next_before}`}>Older submissions</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}

export default function SubmissionsPage({ searchParams }: PageProps<"/submissions">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">My submissions</h1>
          <Button asChild variant="secondary" size="lg">
            <Link href="/submit">
              <FilePlus2 aria-hidden="true" />
              Submit a game
            </Link>
          </Button>
        </div>
        <Suspense
          fallback={
            <div aria-hidden="true" className="flex flex-col gap-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          }
        >
          <SubmissionsView searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
