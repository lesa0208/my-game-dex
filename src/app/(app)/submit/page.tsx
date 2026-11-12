import { Clock, PlugZap, SearchX, UserRoundX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { EMPTY_SUBMISSION, SubmissionForm } from "@/components/submissions/submission-form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";
import { formatWhen } from "@/features/submissions/display";
import { getMyPendingGame, getMySubmissions, getPublishedGame, getSubmissionOptions } from "@/features/submissions/queries";

export const metadata: Metadata = {
  title: "Submit to the catalog",
};

function first(value: string | string[] | undefined) {
  return ((Array.isArray(value) ? value[0] : value) ?? "").trim();
}

async function SubmitView({ searchParams }: { searchParams: PageProps<"/submit">["searchParams"] }) {
  const search = await searchParams;
  const slug = first(search.game);
  const pending = first(search.pending);
  const path = slug ? `/submit?game=${encodeURIComponent(slug)}` : pending ? `/submit?pending=${encodeURIComponent(pending)}` : "/submit";
  const viewer = await requireViewerWithHandle(path);
  if (!viewer.isActive) {
    return (
      <EmptyState icon={UserRoundX} title="You can't submit right now">
        Your account can&apos;t submit to the catalog at the moment.
      </EmptyState>
    );
  }

  const [options, mine] = await Promise.all([getSubmissionOptions(), getMySubmissions(null)]);
  if (!options || !mine) {
    return (
      <EmptyState icon={PlugZap} title="Submitting isn't available">
        The catalog isn&apos;t connected right now. Try again later.
      </EmptyState>
    );
  }
  const { allowance } = mine;
  if (allowance.used >= allowance.limit) {
    return (
      <EmptyState
        icon={Clock}
        title="You've reached today's limit"
        action={
          <Button asChild variant="secondary" size="lg">
            <Link href="/submissions">See your submissions</Link>
          </Button>
        }
      >
        You can make up to {allowance.limit} submissions a day.
        {allowance.next_available_at ? ` You can submit again after ${formatWhen(allowance.next_available_at)}.` : ""}
      </EmptyState>
    );
  }

  const game = slug ? await getPublishedGame(slug) : pending ? await getMyPendingGame(pending) : null;
  if ((slug || pending) && !game) {
    return (
      <EmptyState
        icon={SearchX}
        title="That game isn't available"
        action={
          <Button asChild variant="secondary" size="lg">
            <Link href="/submit">Submit a new game instead</Link>
          </Button>
        }
      >
        Find the game in the catalog and submit the missing release from its page, or submit it as a new game.
      </EmptyState>
    );
  }

  const remaining = allowance.limit - allowance.used;
  return (
    <div className="flex flex-col gap-5">
      {game ? (
        <p className="text-sm text-muted-foreground">
          A physical release of <span className="font-medium text-foreground">{game.title}</span> that the catalog doesn&apos;t have yet.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          A game that isn&apos;t in the catalog yet, with the physical release you have. Is the game already in the catalog?{" "}
          <Link href="/explore" className="text-primary-text underline underline-offset-4">
            Find it in Explore
          </Link>
          , then submit the missing release from its page.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        You can make {remaining} more {remaining === 1 ? "submission" : "submissions"} today.
      </p>
      <SubmissionForm mode={game ? "release" : "game"} game={game ? { id: game.id, title: game.title } : null} options={options} values={EMPTY_SUBMISSION} />
    </div>
  );
}

export default function SubmitPage({ searchParams }: PageProps<"/submit">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Submit to the catalog</h1>
        <Suspense
          fallback={
            <div aria-hidden="true" className="flex flex-col gap-3">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          }
        >
          <SubmitView searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
