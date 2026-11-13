import { ArrowLeft, CircleCheck, PlugZap, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { RestoreForm } from "@/components/exclusion/restore-form";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { catalogStatusLabel, exclusionErrorMessage, exclusionReasonLabel, releaseLabelLine } from "@/features/exclusion/form";
import { type CascadeEntry, getExclusion } from "@/features/exclusion/queries";

export const metadata: Metadata = {
  title: "Exclusion",
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

function Facts({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-y-2">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-0.5 sm:contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="break-words whitespace-pre-wrap">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const copies = (n: number) => (n === 1 ? "1 copy" : `${n.toLocaleString("en")} copies`);
const cascadeText = (entry: CascadeEntry) =>
  entry.entity === "pairing" ? `${entry.title} on ${entry.platform}` : entry.contained ? `${entry.title} (cataloged through the compilation)` : `The game ${entry.title}`;

async function ExclusionView({ params, searchParams }: { params: PageProps<"/review/exclusions/[id]">["params"]; searchParams: PageProps<"/review/exclusions/[id]">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  await requireViewerWithHandle(UUID.test(id) ? `/review/exclusions/${id}` : "/review/exclusions");
  const outcome = await getExclusion(id);
  if (!outcome.ok) {
    if (outcome.reason === "refused") notFound();
    return (
      <EmptyState icon={PlugZap} title="This exclusion isn't available">
        It can&apos;t be loaded right now. Try again later.
      </EmptyState>
    );
  }
  const ex = outcome.data;
  if (!ex) notFound();
  const restored = ex.restored_at !== null;
  const cannot = ex.own_exclusion ? "You excluded this, so another administrator has to restore it." : ex.own_submission ? "You submitted this, so another administrator has to restore it." : ex.blocker ? exclusionErrorMessage(ex.blocker) : null;

  return (
    <article aria-labelledby="exclusion-title" className="flex flex-col gap-4">
      <p>
        <Link href="/review/exclusions" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring">
          <ArrowLeft aria-hidden="true" className="size-4" />
          Exclusions
        </Link>
      </p>
      {search.notice === "restored" ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
          Restored. {copies(ex.copies_restored ?? 0)} came back for their owners, who have been told.
        </p>
      ) : null}
      <header>
        <h1 id="exclusion-title" className="text-xl font-semibold tracking-tight text-pretty">
          {ex.release.game.title}
        </h1>
        <p className="text-sm text-muted-foreground">{releaseLabelLine(ex.release)}</p>
        <p className="mt-2 text-sm">
          <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{restored ? "Restored" : "Excluded"}</span>
        </p>
      </header>

      <Section id="exclusion-facts" title="The exclusion">
        <Facts
          rows={[
            { label: "Excluded", value: `${formatDay(ex.excluded_at)}${ex.own_exclusion ? ", by you" : ""}` },
            { label: "Reason shown to owners", value: exclusionReasonLabel(ex.reason_code) },
            { label: "Note to owners", value: ex.owner_note ?? "None" },
            { label: "Staff reason", value: ex.staff_reason },
            { label: "Status before", value: catalogStatusLabel(ex.previous_status) },
            { label: "Copies preserved", value: `${copies(ex.copies_preserved)} of ${ex.owners_affected === 1 ? "1 collector" : `${ex.owners_affected.toLocaleString("en")} collectors`}` },
            { label: "Also excluded", value: ex.cascade.length ? ex.cascade.map(cascadeText).join("; ") : "Nothing else" },
            ...(ex.request_id ? [{ label: "Submission", value: <Link href={`/review/${ex.request_id}`} className="text-primary-text underline underline-offset-4">See the submission</Link> }] : []),
            ...(restored ? [{ label: "Restored", value: `${formatDay(ex.restored_at!)}: ${ex.restore_reason ?? ""}` }, { label: "Copies restored", value: copies(ex.copies_restored ?? 0) }] : []),
          ]}
        />
      </Section>

      {restored ? null : (
        <Section id="exclusion-restore" title="Restore">
          <ul className="mb-3 flex list-disc flex-col gap-1.5 pl-5 text-sm">
            <li>
              The release goes back to {catalogStatusLabel(ex.previous_status).toLowerCase()}
              {ex.cascade.length ? ", with everything excluded alongside it" : ""}.
            </li>
            <li>{copies(ex.copies.still_preserved)} still preserved by this exclusion will count again. Nothing else about them changes.</li>
            {ex.copies.moved ? <li>{copies(ex.copies.moved)} their owners have since moved to another release stay where they are.</li> : null}
            {ex.copies.removed ? <li>{copies(ex.copies.removed)} their owners have removed stay removed.</li> : null}
          </ul>
          {cannot ? (
            <p className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {cannot}
            </p>
          ) : (
            <RestoreForm
              exclusionId={ex.id}
              version={ex.version}
              description="Only for a wrong exclusion. Owners whose copies come back are told once, without your name."
            />
          )}
        </Section>
      )}
    </article>
  );
}

export default function ExclusionPage({ params, searchParams }: PageProps<"/review/exclusions/[id]">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <Suspense
          fallback={
            <div aria-hidden="true" className="flex flex-col gap-4">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-48 w-full" />
            </div>
          }
        >
          <ExclusionView params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
