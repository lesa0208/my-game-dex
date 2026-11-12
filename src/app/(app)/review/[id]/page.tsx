import { ArrowLeft, CircleCheck, PlugZap, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { CorrectionForm } from "@/components/review/correction-form";
import { DecisionForm } from "@/components/review/decision-form";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";
import { componentLabel, editionKindLabel } from "@/features/catalog/format";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { catalogStatusLabel, requestStatusLabel, submitterLabel } from "@/features/review/form";
import { canReview, getSubmissionReview } from "@/features/review/queries";
import { formatWhen } from "@/features/submissions/display";
import { GAME_KINDS } from "@/features/submissions/form";
import { getSubmissionOptions } from "@/features/submissions/queries";

export const metadata: Metadata = {
  title: "Review",
};

const NOTICES: Record<string, string> = {
  started: "The review has started. The submitter can no longer change or withdraw it.",
  corrected: "Your corrections are saved.",
  approved: "Approved and published. The submitter has been told.",
  changes_requested: "Sent back to the submitter with your note.",
  rejected: "Rejected. The submitter has been told.",
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

function Facts({ rows }: { rows: { label: string; value: string | null }[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-y-2">
      {rows
        .filter((r) => r.value !== null && r.value !== "")
        .map((row) => (
          <div key={row.label} className="flex flex-col gap-0.5 sm:contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="break-words whitespace-pre-wrap">{row.value}</dd>
          </div>
        ))}
    </dl>
  );
}

function Disclosure({ title, children, destructive = false }: { title: string; children: ReactNode; destructive?: boolean }) {
  return (
    <details className="rounded-lg border bg-card">
      <summary
        className={`flex min-h-11 cursor-pointer items-center rounded-lg px-4 text-sm font-semibold outline-none select-none focus-visible:ring-3 focus-visible:ring-ring ${destructive ? "text-destructive" : ""}`}
      >
        {title}
      </summary>
      <div className="border-t p-4">{children}</div>
    </details>
  );
}

const yesNo = (value: boolean) => (value ? "Yes" : "No");

async function ReviewView({ params, searchParams }: { params: PageProps<"/review/[id]">["params"]; searchParams: PageProps<"/review/[id]">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  const notice = typeof search.notice === "string" ? (NOTICES[search.notice] ?? null) : null;
  await requireViewerWithHandle(UUID.test(id) ? `/review/${id}` : "/review");
  if (!(await canReview())) notFound();

  const item = await getSubmissionReview(id);
  if (item === undefined) {
    return (
      <EmptyState icon={PlugZap} title="This submission isn't available">
        It can&apos;t be loaded right now. Try again later.
      </EmptyState>
    );
  }
  if (!item) notFound();

  const { request, release, game, submitter } = item;
  const details = request.details;
  const deleted = submitter.deleted;
  const inReview = request.status === "in_review";
  const options = await getSubmissionOptions();
  const regionLabel = (code: string) => (code === "unknown" ? "Region unknown" : (options?.regions.find((r) => r.code === code)?.label ?? code));
  const regionText = (code: string, confirmed: boolean) =>
    code === "unknown" ? (confirmed ? "Unknown, confirmed by an editor" : "Unknown, not confirmed") : (options?.regions.find((r) => r.code === code)?.label ?? code);

  return (
    <article aria-labelledby="review-title" className="flex flex-col gap-4">
      <p>
        <Link href="/review" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring">
          <ArrowLeft aria-hidden="true" className="size-4" />
          Review queue
        </Link>
      </p>
      {notice ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
          {notice}
        </p>
      ) : null}

      <header>
        <h1 id="review-title" className="text-xl font-semibold tracking-tight text-pretty">
          {game?.title ?? details.title}
        </h1>
        <p className="text-sm text-muted-foreground">
          {[details.platform.short_name, details.region.code === "unknown" ? "Region unknown" : details.region.label, details.format.name].join(" · ")}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{requestStatusLabel(request.status)}</span>
          {request.kind === "new_game" ? "New game" : "Missing release"} · From {submitterLabel(submitter)} · {formatDay(request.created_at)}
        </p>
      </header>

      {request.own ? (
        <p className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          You submitted this, so another editor has to review it.
        </p>
      ) : null}
      {deleted && ["open", "in_review"].includes(request.status) ? (
        <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          The submitter&apos;s account was deleted. Changes can&apos;t be requested, because nobody could answer: correct it yourself and approve it, or reject it. Nobody is notified.
        </p>
      ) : null}

      <Section id="review-submitted" title="What was submitted">
        <Facts
          rows={[
            { label: "Game", value: details.title },
            { label: "Type", value: request.created_game ? (GAME_KINDS.find((k) => k.value === details.game_kind)?.label ?? null) : null },
            { label: "First released", value: request.created_game && details.first_release_year ? String(details.first_release_year) : null },
            { label: "Platform", value: details.platform.name },
            { label: "Physical format", value: details.format.name },
            { label: "Region", value: details.region.code === "unknown" ? "Unknown" : details.region.label },
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
            { label: "Submitter's note", value: request.note },
            { label: "Note to the submitter", value: request.reviewer_note },
          ]}
        />
      </Section>

      {release ? (
        <Section id="review-record" title="The record now">
          <Facts
            rows={[
              { label: "Release status", value: catalogStatusLabel(release.status) },
              { label: "Revision", value: String(release.revision) },
              { label: "Edition", value: release.edition_name ?? "Not recorded" },
              { label: "Edition type", value: release.edition_kind ? editionKindLabel(release.edition_kind) : "Not recorded" },
              { label: "Discs or cartridges", value: release.media_count ? String(release.media_count) : "Not recorded" },
              { label: "Region", value: regionText(release.region_code, release.region_unknown_confirmed) },
              { label: "Variant", value: release.variant_name },
              { label: "Packaging", value: release.packaging },
              { label: "Product code", value: release.product_code },
              { label: "Barcode", value: release.barcode },
              { label: "Title on the package", value: release.local_title },
              { label: "Publisher", value: release.publisher_name },
              { label: "Release year", value: release.release_date ? release.release_date.slice(0, 4) : null },
              { label: "In the box", value: release.components.length ? release.components.map((c) => componentLabel(c)).join(", ") : null },
              { label: "Verified", value: yesNo(release.verified) },
              { label: "Game", value: game ? `${game.title} (${catalogStatusLabel(game.status)})` : null },
            ]}
          />
        </Section>
      ) : (
        <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">The submitted release no longer exists: it was withdrawn.</p>
      )}

      <Section id="review-duplicates" title="Possible duplicates">
        {item.duplicates.length || item.similar_games.length ? (
          <ul className="flex flex-col gap-2 text-sm">
            {item.similar_games.map((g) => (
              <li key={`g-${g.id}`}>
                Game with a similar title:{" "}
                {g.slug ? (
                  <Link href={`/games/${g.slug}`} className="text-primary-text underline underline-offset-4">
                    {g.title}
                  </Link>
                ) : (
                  <span className="font-medium">{g.title}</span>
                )}{" "}
                <span className="text-muted-foreground">({catalogStatusLabel(g.status)})</span>
              </li>
            ))}
            {item.duplicates.map((d) => {
              const label = `${d.game_title}: ${[d.platform, regionLabel(d.region), d.edition_name, d.variant_name, d.product_code].filter(Boolean).join(" · ")}`;
              const why = [d.same_product_code ? "same product code" : null, d.same_barcode ? "same barcode" : null].filter(Boolean).join(", ");
              return (
                <li key={`r-${d.id}`}>
                  {d.status === "published" && d.game_slug ? (
                    <Link href={`/games/${d.game_slug}?release=${d.id}`} className="text-primary-text underline underline-offset-4">
                      {label}
                    </Link>
                  ) : d.request_id ? (
                    <Link href={`/review/${d.request_id}`} className="text-primary-text underline underline-offset-4">
                      {label}
                    </Link>
                  ) : (
                    <span>{label}</span>
                  )}{" "}
                  <span className="text-muted-foreground">
                    ({catalogStatusLabel(d.status)}
                    {why ? `, ${why}` : ""})
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No release of this game on this platform, and nothing with the same product code or barcode.</p>
        )}
      </Section>

      {item.history.length > 1 ? (
        <Section id="review-history" title="Earlier rounds">
          <ol className="flex flex-col gap-2 text-sm">
            {item.history.map((h) => (
              <li key={h.id}>
                {h.id === request.id ? (
                  <span className="font-medium">This round</span>
                ) : (
                  <Link href={`/review/${h.id}`} className="text-primary-text underline underline-offset-4">
                    Round of {formatDay(h.created_at)}
                  </Link>
                )}
                : {requestStatusLabel(h.status)}
                {h.reviewer ? ` by @${h.reviewer}` : ""}
                {h.reviewed_at ? `, ${formatWhen(h.reviewed_at)}` : ""}
                {h.reviewer_note ? <span className="block text-muted-foreground">“{h.reviewer_note}”</span> : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {request.reviewer && !inReview ? (
        <p className="text-sm text-muted-foreground">
          Reviewed by @{request.reviewer}
          {request.reviewed_at ? `, ${formatWhen(request.reviewed_at)}` : ""}.
        </p>
      ) : null}

      {request.own ? null : request.status === "open" ? (
        <Section id="review-start" title="Start the review">
          <DecisionForm
            decision="start"
            requestId={request.id}
            version={request.version}
            label="Start the review"
            description="The submitter can't change or withdraw it after this. You can then correct it, approve it, ask for changes or reject it."
          />
        </Section>
      ) : inReview && release ? (
        <>
          {options ? (
            <Disclosure title="Correct the release">
              <CorrectionForm target="release" requestId={request.id} revision={release.revision} release={release} regions={options.regions} />
            </Disclosure>
          ) : null}
          {request.created_game && game && game.status !== "published" ? (
            <Disclosure title="Correct the game">
              <CorrectionForm target="game" requestId={request.id} revision={game.revision} game={game} />
            </Disclosure>
          ) : null}
          <Section id="review-approve" title="Approve and publish">
            <DecisionForm
              decision="approve"
              requestId={request.id}
              version={request.version}
              releaseRevision={release.revision}
              gameRevision={request.created_game && game && game.status !== "published" ? game.revision : null}
              label="Approve and publish"
              description={`Verifies and publishes the record as shown under “The record now”, at revision ${release.revision}${request.created_game ? ", with its game" : ""}. Anyone can then find it, and the submitter's copies count as owned.`}
              note={{ label: "Note to the submitter (optional)", hint: "Shown on their submission's page.", required: false }}
            />
          </Section>
          {deleted ? null : (
            <Disclosure title="Ask for changes">
              <DecisionForm
                decision="changes"
                requestId={request.id}
                version={request.version}
                label="Send it back"
                description="Returns it to the submitter to change, with your note. It comes back to the queue when they send it again."
                note={{ label: "What should they change?", hint: "Shown to the submitter.", required: true }}
              />
            </Disclosure>
          )}
          <Disclosure title="Reject" destructive>
            <DecisionForm
              decision="reject"
              requestId={request.id}
              version={request.version}
              label="Reject the submission"
              description="For a real physical product whose details or evidence aren't good enough. Nothing is deleted: the record stays, not approved, and so do the submitter's copies. They can resubmit it."
              note={{ label: "Note to the submitter (optional)", hint: "Shown on their submission's page.", required: false }}
              destructive
            />
          </Disclosure>
        </>
      ) : null}
    </article>
  );
}

export default function ReviewPage({ params, searchParams }: PageProps<"/review/[id]">) {
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
          <ReviewView params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
