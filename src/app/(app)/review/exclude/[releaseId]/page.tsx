import { ArrowLeft, CircleCheck, PlugZap, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { ExcludeForm } from "@/components/exclusion/exclude-form";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";
import { UUID } from "@/features/collection/uuid";
import { catalogStatusLabel, releaseLabelLine } from "@/features/exclusion/form";
import { type CascadeEntry, getExclusionPreview } from "@/features/exclusion/queries";
import { canReview } from "@/features/review/queries";

export const metadata: Metadata = {
  title: "Exclude a release",
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border bg-card p-4">
      <h2 id={id} className="mb-3 text-sm font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function cascadeText(entry: CascadeEntry) {
  if (entry.entity === "pairing") return `${entry.title} on ${entry.platform}`;
  return entry.contained ? `${entry.title}, cataloged only through this compilation` : `the game ${entry.title}`;
}

async function ExcludeView({ params, searchParams }: { params: PageProps<"/review/exclude/[releaseId]">["params"]; searchParams: PageProps<"/review/exclude/[releaseId]">["searchParams"] }) {
  const { releaseId } = await params;
  const search = await searchParams;
  await requireViewerWithHandle(UUID.test(releaseId) ? `/review/exclude/${releaseId}` : "/review");
  // Anyone who can't review gets the same page as for an address that doesn't exist.
  if (!(await canReview())) notFound();

  if (search.notice === "excluded") {
    const copies = typeof search.copies === "string" && /^\d{1,7}$/.test(search.copies) ? Number(search.copies) : null;
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
          Excluded.{copies !== null ? ` ${copies === 1 ? "1 copy is" : `${copies.toLocaleString("en")} copies are`} kept privately for their owners, who have been told.` : ""}
        </p>
        <p>
          <Link href="/review" className="text-sm text-primary-text underline underline-offset-4">
            Back to the review queue
          </Link>
        </p>
      </div>
    );
  }

  const outcome = await getExclusionPreview(releaseId);
  if (!outcome.ok) {
    if (outcome.reason === "refused" && outcome.message === "release unavailable") notFound();
    return (
      <EmptyState icon={PlugZap} title="This release isn't available">
        It can&apos;t be loaded right now. Try again later.
      </EmptyState>
    );
  }
  const preview = outcome.data;
  const { release } = preview;
  const blocked = preview.blocking.length > 0;

  return (
    <article aria-labelledby="exclude-title" className="flex flex-col gap-4">
      <p>
        <Link
          href={preview.request_id ? `/review/${preview.request_id}` : release.game.slug && release.game.status === "published" ? `/games/${release.game.slug}?release=${release.id}` : "/review"}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {preview.request_id ? "Back to the submission" : release.game.status === "published" ? "Back to the game" : "Review queue"}
        </Link>
      </p>
      <header>
        <h1 id="exclude-title" className="text-xl font-semibold tracking-tight text-pretty">
          Exclude {release.game.title} from the catalog
        </h1>
        <p className="text-sm text-muted-foreground">{releaseLabelLine(release)}</p>
        <p className="mt-2 text-sm">
          <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{catalogStatusLabel(release.status)}</span>
        </p>
      </header>

      <p className="text-sm">
        For a product outside the catalog&apos;s physical-only scope, such as a download code or a game-key card. For a real physical product with a problem, reject it instead. Nothing
        is deleted, and an administrator can restore it.
      </p>

      <Section id="exclude-effects" title="What excluding it does">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
          <li>The release leaves the catalog. No copy can be added to it or moved to it.</li>
          <li>
            {preview.copies
              ? `${preview.copies === 1 ? "1 copy" : `${preview.copies.toLocaleString("en")} copies`} of ${preview.owners === 1 ? "1 collector" : `${preview.owners.toLocaleString("en")} collectors`} will be kept privately, with everything recorded, and no longer counted. Each collector is told once, without your name.`
              : "No collector has a copy of it."}
          </li>
          {preview.request_id ? <li>Its submission is closed for good: the submitter can&apos;t change or resubmit it.</li> : null}
          {preview.cascade.map((entry) => (
            <li key={entry.entity === "game" ? entry.id : `${entry.game_id}-${entry.platform_id}`}>Also excluded: {cascadeText(entry)}, because nothing else would keep it in the catalog.</li>
          ))}
        </ul>
      </Section>

      {preview.own_submission ? (
        <p className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          You submitted this, so another editor has to decide.
        </p>
      ) : blocked ? (
        <Section id="exclude-blocked" title="It can't be excluded yet">
          <p className="mb-2 text-sm">Excluding it would leave these without a game, or pointing at an excluded record. Resolve them first.</p>
          <ul className="flex flex-col gap-1.5 text-sm">
            {preview.blocking.map((b) => (
              <li key={`${b.kind}-${b.id}`}>
                {b.kind === "merged_game" ? (
                  `A game merged into it: ${b.label ?? "a game"}`
                ) : (
                  <>
                    {b.kind === "submission" ? "A submission of the same game: " : "A release merged into it: "}
                    {b.label ? `${b.label.game.title} (${releaseLabelLine(b.label)})` : "a release"}
                    {b.request_id ? (
                      <>
                        {" · "}
                        <Link href={`/review/${b.request_id}`} className="text-primary-text underline underline-offset-4">
                          Review it
                        </Link>
                      </>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        <Section id="exclude-confirm" title="Exclude it">
          <ExcludeForm releaseId={release.id} token={preview.token} copies={preview.copies} owners={preview.owners} cascade={preview.cascade.map(cascadeText)} />
        </Section>
      )}
    </article>
  );
}

export default function ExcludePage({ params, searchParams }: PageProps<"/review/exclude/[releaseId]">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <Suspense
          fallback={
            <div aria-hidden="true" className="flex flex-col gap-4">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          }
        >
          <ExcludeView params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
