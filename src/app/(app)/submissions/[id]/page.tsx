import { ArrowLeft, CircleCheck, Lock, MessageSquareText, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { AddCopyForm } from "@/components/collection/add-copy-form";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { ResubmitSubmissionForm } from "@/components/submissions/resubmit-submission-form";
import { SubmissionForm } from "@/components/submissions/submission-form";
import { WithdrawSubmissionForm } from "@/components/submissions/withdraw-submission-form";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";
import { componentLabel, editionKindLabel } from "@/features/catalog/format";
import { CURRENCIES } from "@/features/collection/currencies";
import { formatDay, latestAcquisitionDate, mediumLabel } from "@/features/collection/details";
import { getMyDefaultCurrency } from "@/features/collection/queries";
import { UUID, uuidv7 } from "@/features/collection/uuid";
import { formValues, submissionName } from "@/features/submissions/display";
import { GAME_KINDS, statusLabel } from "@/features/submissions/form";
import { getMySubmission, getSubmissionOptions } from "@/features/submissions/queries";

export const metadata: Metadata = {
  title: "Submission",
};

/** Statuses whose release the submitter may still add a copy of (can_use_release). */
const COPYABLE = new Set(["submitted", "in_review", "changes_requested", "rejected"]);

const NOTICES: Record<string, string> = {
  submitted: "Submitted. Thank you: an editor will review it.",
  withdrawn: "The submission was withdrawn.",
  resubmitted: "Sent for review. An editor will look at it again.",
};

function Section({ id, title, icon, children }: { id: string; title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border bg-card p-4">
      <h2 id={id} className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: { label: string; value: string | null }[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-y-2">
      {rows
        .filter((r) => r.value !== null)
        .map((row) => (
          <div key={row.label} className="flex flex-col gap-0.5 sm:contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="break-words whitespace-pre-wrap">{row.value}</dd>
          </div>
        ))}
    </dl>
  );
}

async function SubmissionView({ params, searchParams }: { params: PageProps<"/submissions/[id]">["params"]; searchParams: PageProps<"/submissions/[id]">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  const notice = typeof search.notice === "string" ? (NOTICES[search.notice] ?? null) : null;
  const viewer = await requireViewerWithHandle(UUID.test(id) ? `/submissions/${id}` : "/submissions");

  const submission = await getMySubmission(id);
  if (submission === undefined) {
    return (
      <EmptyState icon={PlugZap} title="This submission isn't available">
        It can&apos;t be loaded right now. Try again later.
      </EmptyState>
    );
  }
  // Someone else's submission reads exactly like one that doesn't exist.
  if (!submission) notFound();

  const { details } = submission;
  const name = submissionName(details);
  const isPublic = submission.status === "published";
  const canCopy = Boolean(submission.release_id) && COPYABLE.has(submission.status) && viewer.isActive;
  const [options, currency] = await Promise.all([submission.editable ? getSubmissionOptions() : null, canCopy ? getMyDefaultCurrency() : null]);
  const region = details.region.code === "unknown" ? "Unknown, not confirmed" : details.region.label;

  return (
    <article aria-labelledby="submission-title" className="flex flex-col gap-4">
      <p>
        <Link href="/submissions" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring">
          <ArrowLeft aria-hidden="true" className="size-4" />
          Your submissions
        </Link>
      </p>
      {notice ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
          {notice}
        </p>
      ) : null}

      <header>
        <h1 id="submission-title" className="text-xl font-semibold tracking-tight text-pretty">
          {details.title}
        </h1>
        <p className="text-sm text-muted-foreground">{[details.platform.short_name, details.region.code === "unknown" ? "Region unknown" : details.region.label, details.edition_name].filter(Boolean).join(" · ")}</p>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{statusLabel(submission.status)}</span>
          {submission.kind === "new_game" ? "New game" : "Missing release"} · Submitted {formatDay(submission.created_at)}
        </p>
        {isPublic && submission.game_slug && submission.release_id ? (
          <p className="mt-2 text-sm">
            <Link href={`/games/${submission.game_slug}?release=${submission.release_id}`} className="text-primary-text underline underline-offset-4">
              See it in the catalog
            </Link>
          </p>
        ) : null}
      </header>

      {submission.reviewer_note && (submission.status === "changes_requested" || submission.status === "rejected") ? (
        <section aria-labelledby="editor-note" className="rounded-lg border border-primary/40 bg-primary/5 p-4">
          <h2 id="editor-note" className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <MessageSquareText aria-hidden="true" className="size-4" />
            {submission.status === "changes_requested" ? "The editors asked for changes" : "Why it wasn't approved"}
          </h2>
          <p className="text-sm break-words whitespace-pre-wrap">{submission.reviewer_note}</p>
        </section>
      ) : submission.status === "changes_requested" ? (
        <p className="rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 text-sm">The editors asked for changes. Change it below, then send it back for review.</p>
      ) : null}

      {submission.previous_id || submission.next_id ? (
        <p className="text-sm">
          {submission.previous_id ? (
            <Link href={`/submissions/${submission.previous_id}`} className="text-primary-text underline underline-offset-4">
              The earlier, rejected submission
            </Link>
          ) : null}
          {submission.next_id ? (
            <Link href={`/submissions/${submission.next_id}`} className="text-primary-text underline underline-offset-4">
              Its resubmission
            </Link>
          ) : null}
        </p>
      ) : null}

      {!isPublic && submission.status !== "withdrawn" ? (
        <p className="flex gap-2 rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Only you and catalog editors can see this submission. It isn&apos;t in search or on game pages until it&apos;s published.
        </p>
      ) : null}

      <Section id="submission-details" title="What you submitted">
        <Facts
          rows={[
            { label: "Game", value: details.title },
            { label: "Type", value: submission.created_game ? (GAME_KINDS.find((k) => k.value === details.game_kind)?.label ?? null) : null },
            { label: "First released", value: submission.created_game && details.first_release_year ? String(details.first_release_year) : null },
            { label: "Platform", value: details.platform.name },
            { label: "Physical format", value: details.format.name },
            { label: "Region", value: region },
            { label: "Edition", value: details.edition_name },
            { label: "Edition type", value: details.edition_kind ? editionKindLabel(details.edition_kind) : null },
            { label: "Variant", value: details.variant_name },
            { label: "Packaging", value: details.packaging },
            { label: "Product code", value: details.product_code },
            { label: "Barcode", value: details.barcode },
            { label: "Title on the package", value: details.local_title },
            { label: "Publisher", value: details.publisher_name },
            { label: "Discs or cartridges", value: details.media_count ? String(details.media_count) : null },
            { label: "Release year", value: details.release_date ? details.release_date.slice(0, 4) : null },
            { label: "In the box", value: details.components.length ? details.components.map((c) => componentLabel(c)).join(", ") : null },
            { label: "Note for the editors", value: submission.note },
            // Shown above, on its own, while it asks for changes or explains a rejection.
            { label: "Note from the editors", value: submission.status === "changes_requested" || submission.status === "rejected" ? null : submission.reviewer_note },
          ]}
        />
      </Section>

      {canCopy && submission.release_id ? (
        <Section id="submission-copy" title="Your copy">
          <AddCopyForm
            key={submission.release_id}
            releaseId={submission.release_id}
            initialItemId={uuidv7()}
            initialCount={submission.my_copies}
            defaultCurrency={currency}
            currencies={CURRENCIES}
            maxDate={latestAcquisitionDate()}
            mediumLabel={mediumLabel(details.format.category)}
            components={details.components}
          />
        </Section>
      ) : null}

      {submission.editable && options ? (
        <details className="rounded-lg border bg-card">
          <summary className="flex min-h-11 cursor-pointer items-center rounded-lg px-4 text-sm font-semibold outline-none select-none focus-visible:ring-3 focus-visible:ring-ring">
            Change this submission
          </summary>
          <div className="border-t p-4">
            <SubmissionForm mode="edit" game={null} submissionId={submission.id} createdGame={submission.created_game} options={options} values={formValues(details, submission.note)} />
          </div>
        </details>
      ) : null}

      {submission.resubmittable ? <ResubmitSubmissionForm submissionId={submission.id} rejected={submission.status === "rejected"} /> : null}

      {submission.editable && submission.created_game && submission.game_id ? (
        <p className="text-sm">
          <Link href={`/submit?pending=${submission.game_id}`} className="text-primary-text underline underline-offset-4">
            Submit another release of this game
          </Link>
        </p>
      ) : null}

      {submission.editable ? (
        submission.my_copies > 0 ? (
          <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
            To withdraw this submission, first remove your {submission.my_copies === 1 ? "copy" : `${submission.my_copies} copies`} of it from{" "}
            <Link href="/collection" className="text-primary-text underline underline-offset-4">
              your collection
            </Link>
            .
          </p>
        ) : (
          <WithdrawSubmissionForm submissionId={submission.id} name={name} />
        )
      ) : null}
    </article>
  );
}

export default function SubmissionPage({ params, searchParams }: PageProps<"/submissions/[id]">) {
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
          <SubmissionView params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
