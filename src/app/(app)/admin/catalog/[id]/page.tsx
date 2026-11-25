import { ArrowLeft, CircleCheck, PlugZap, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { packagingStaffLabel } from "@/features/catalog/packaging";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AdminFrame, AdminShell, linkClass } from "@/components/admin/admin-frame";
import { HistoryPanel } from "@/components/admin/records";
import { CorrectionForm, PiecesForm } from "@/components/review/correction-form";
import { DecisionForm } from "@/components/review/decision-form";
import { PreparedReview } from "@/components/review/prepared-review";
import { EmptyState } from "@/components/shared/empty-state";
import { requireAdminSection } from "@/features/admin/queries";
import { componentLabel, editionKindLabel } from "@/features/catalog/format";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { catalogStatusLabel, piecesEditable, requestStatusLabel, submitterLabel } from "@/features/review/form";
import { LookupNudge } from "@/components/enrichment/lookup-nudge";
import { wikidataConfigured } from "@/features/enrichment/server";
import { runDueLookups } from "@/features/review/actions";
import { getSubmissionEnrichment, getSubmissionReview } from "@/features/review/queries";
import { formatWhen } from "@/features/submissions/display";
import { GAME_KINDS, PIECE_KINDS } from "@/features/submissions/form";
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
  lookup: "Looking it up again. Reload in a moment to see the answer.",
  source_confirmed: "The Wikidata match is confirmed: it is now the game's source, still a claim to check before verification.",
  source_rejected: "The Wikidata match is rejected.",
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

async function ReviewView({ params, searchParams }: { params: PageProps<"/admin/catalog/[id]">["params"]; searchParams: PageProps<"/admin/catalog/[id]">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  const notice = typeof search.notice === "string" ? (NOTICES[search.notice] ?? null) : null;
  // Catalog editors only (D8); staff signed in without their authenticator verify first.
  const { access } = await requireAdminSection(UUID.test(id) ? `/admin/catalog/${id}` : "/admin/catalog", "editor");

  const item = await getSubmissionReview(id);
  if (item === undefined) {
    return (
      <AdminFrame narrow access={access} current="catalog" title="Review a submission">
        <EmptyState icon={PlugZap} title="This submission isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      </AdminFrame>
    );
  }
  if (!item) notFound();

  const { request, release, game, submitter } = item;
  const details = request.details;
  const deleted = submitter.deleted;
  const inReview = request.status === "in_review";
  const [options, enrichment] = await Promise.all([getSubmissionOptions(), request.kind === "new_game" ? getSubmissionEnrichment(request.id) : Promise.resolve(null)]);
  const configured = wikidataConfigured();
  const waiting = ["open", "in_review", "changes_requested"].includes(request.status);
  // A lookup still waiting (it failed, or never ran) is tried again once this page is open.
  const nudge = configured && waiting && enrichment && ["pending", "failed"].includes(enrichment.status) && !enrichment.looking_up && enrichment.attempts < 5;
  const formatName = (code: string) => options?.formats.find((f) => f.code === code)?.name ?? code;
  const submittedFormat = options?.formats.some((f) => f.platform === details.platform.slug && f.code === details.format.code && !f.acceptsNewPublications)
    ? "Not sure: the cartridge shell isn't identified yet"
    : details.format.name;
  const publishable = (code: string) => Boolean(release && options?.formats.some((f) => f.platform === release.platform.slug && f.code === code && f.acceptsNewPublications));
  const regionLabel = (code: string) => (code === "unknown" ? "Region unknown" : (options?.regions.find((r) => r.code === code)?.label ?? code));
  const regionText = (code: string, confirmed: boolean) =>
    code === "unknown" ? (confirmed ? "Unknown, confirmed by an editor" : "Unknown, not confirmed") : (options?.regions.find((r) => r.code === code)?.label ?? code);

  return (
    <AdminFrame narrow access={access} current="catalog" title={game?.title ?? details.title} titleId="review-title">
      <article aria-labelledby="review-title" className="flex flex-col gap-4">
        <p>
          <Link href="/admin/catalog" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring">
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
          <p className="text-sm text-muted-foreground">
            {[details.platform.short_name, details.region.code === "unknown" ? "Region unknown" : details.region.label, submittedFormat].join(" · ")}
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{requestStatusLabel(request.status)}</span>
            {request.kind === "new_game" ? "New game" : "Missing release"} · From {submitterLabel(submitter)} · {formatDay(request.created_at)}
          </p>
          {release || game ? (
            <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
              {release ? (
                <Link href={`/admin/catalog/releases/${release.id}`} className={linkClass}>
                  Release record
                </Link>
              ) : null}
              {game ? (
                <Link href={`/admin/catalog/games/${game.id}`} className={linkClass}>
                  Game record
                </Link>
              ) : null}
            </p>
          ) : null}
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
              { label: "Physical format", value: submittedFormat },
              { label: "Region", value: details.region.code === "unknown" ? "Unknown" : details.region.label },
              { label: "Edition", value: details.edition_name },
              { label: "Edition type", value: details.edition_kind ? editionKindLabel(details.edition_kind) : null },
              { label: "Variant", value: details.variant_name },
              { label: "Packaging", value: packagingStaffLabel(details.packaging_code, details.packaging) },
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

        {request.kind === "new_game" ? (
          <Section id="review-prepared" title="Prepared for review">
            {nudge ? <LookupNudge run={runDueLookups.bind(null, request.id)} refreshAfterMs={5000} /> : null}
            <PreparedReview
              requestId={request.id}
              waiting={waiting}
              enrichment={enrichment}
              configured={configured}
              release={release}
              formatName={formatName}
              publishable={publishable}
              canDecide={!["withdrawn", "rejected", "excluded", "merged"].includes(request.status)}
            />
          </Section>
        ) : null}

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
                { label: "Packaging", value: packagingStaffLabel(release.packaging_code, release.packaging) },
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
                      <Link href={`/admin/catalog/${d.request_id}`} className="text-primary-text underline underline-offset-4">
                        {label}
                      </Link>
                    ) : (
                      <span>{label}</span>
                    )}{" "}
                    <span className="text-muted-foreground">
                      ({catalogStatusLabel(d.status)}
                      {why ? `, ${why}` : ""})
                    </span>
                    {inReview && !request.own && release && d.status === "published" ? (
                      <>
                        {" · "}
                        <Link href={`/admin/catalog/merge/${release.id}?into=${d.id}`} className="text-primary-text underline underline-offset-4">
                          Compare and merge
                        </Link>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No release of this game on this platform, and nothing with the same product code or barcode.</p>
          )}
        </Section>


        {release ? <HistoryPanel id="review-record-history" entity="release" recordId={release.id} title="Release history" admin={access.admin} /> : null}

        {item.history.length > 1 ? (
          <Section id="review-history" title="Earlier rounds">
            <ol className="flex flex-col gap-2 text-sm">
              {item.history.map((h) => (
                <li key={h.id}>
                  {h.id === request.id ? (
                    <span className="font-medium">This round</span>
                  ) : (
                    <Link href={`/admin/catalog/${h.id}`} className="text-primary-text underline underline-offset-4">
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
            <Disclosure title="Correct the listed pieces">
              {piecesEditable(release.components) ? (
                <PiecesForm requestId={request.id} revision={release.revision} pieces={release.components} kinds={PIECE_KINDS} />
              ) : (
                <p className="text-sm text-muted-foreground">This release lists pieces this form can&apos;t show, so it can&apos;t change them here.</p>
              )}
            </Disclosure>
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

        {!request.own && release && inReview ? (
          <Disclosure title="Merge into an existing release">
            <p className="text-sm text-muted-foreground">
              If this is a physical product the catalog already has, merge it into that release instead of approving a duplicate. The submitter&apos;s copies move with
              everything recorded, and they see where it went. You&apos;ll compare every field before confirming.
            </p>
            <p className="mt-3">
              <Link href={`/admin/catalog/merge/${release.id}`} className="text-sm font-medium text-primary-text underline underline-offset-4">
                Choose the release to merge into
              </Link>
            </p>
          </Disclosure>
        ) : null}

        {!request.own && release && ["open", "in_review", "changes_requested", "rejected"].includes(request.status) ? (
          <Disclosure title="Exclude from the catalog" destructive>
            <p className="text-sm text-muted-foreground">
              For a product outside the catalog&apos;s physical-only scope, such as a download code or a game-key card. The submission is closed for good, and the submitter&apos;s
              copies are kept privately. You&apos;ll see every effect before confirming.
            </p>
            <p className="mt-3">
              <Link href={`/admin/catalog/exclude/${release.id}`} className="text-sm font-medium text-destructive underline underline-offset-4">
                Review the effects of excluding it
              </Link>
            </p>
          </Disclosure>
        ) : null}
      </article>
    </AdminFrame>
  );
}

export default function ReviewPage({ params, searchParams }: PageProps<"/admin/catalog/[id]">) {
  return (
    <AdminShell>
      <ReviewView params={params} searchParams={searchParams} />
    </AdminShell>
  );
}
