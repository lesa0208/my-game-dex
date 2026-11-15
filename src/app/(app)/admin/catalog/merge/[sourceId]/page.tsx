import { ArrowLeft, PlugZap, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { MergeForm } from "@/components/merge/merge-form";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";
import { UUID } from "@/features/collection/uuid";
import { catalogStatusLabel, releaseLabelLine } from "@/features/exclusion/form";
import { isAdministrator, type ReleaseLabel } from "@/features/exclusion/queries";
import { blockerText, fieldLabel, fieldValue } from "@/features/merge/form";
import { getMergeCandidates, getMergePreview } from "@/features/merge/queries";
import { canReview } from "@/features/review/queries";

export const metadata: Metadata = {
  title: "Merge a release",
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

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {children}
    </p>
  );
}

function Label({ release }: { release: ReleaseLabel }) {
  return (
    <>
      <span className="font-medium">{release.game.title}</span>
      <span className="block text-muted-foreground">{releaseLabelLine(release)}</span>
      <span className="mt-1 inline-block rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{catalogStatusLabel(release.status)}</span>
    </>
  );
}

const backLink =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring";

async function Candidates({ sourceId }: { sourceId: string }) {
  const outcome = await getMergeCandidates(sourceId);
  if (!outcome.ok) {
    if (outcome.reason === "refused") notFound();
    return (
      <EmptyState icon={PlugZap} title="This release isn't available">
        It can&apos;t be loaded right now. Try again later.
      </EmptyState>
    );
  }
  return (
    <Section id="merge-candidates" title="Choose the release to keep">
      <p className="mb-3 text-sm">Published releases of the same platform and physical format: its own game first, then the same product code or barcode, then similar titles.</p>
      {outcome.data.length ? (
        <ul className="flex flex-col divide-y text-sm">
          {outcome.data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span>
                <span className="font-medium">{c.game.title}</span>
                <span className="block text-muted-foreground">
                  {releaseLabelLine(c)}
                  {c.same_code ? " · same code" : ""}
                </span>
              </span>
              <Link href={`/admin/catalog/merge/${sourceId}?into=${c.id}`} className="text-primary-text underline underline-offset-4">
                Compare
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No published release of the same platform and format matches.</p>
      )}
    </Section>
  );
}

async function MergeView({ params, searchParams }: { params: PageProps<"/admin/catalog/merge/[sourceId]">["params"]; searchParams: PageProps<"/admin/catalog/merge/[sourceId]">["searchParams"] }) {
  const { sourceId } = await params;
  const search = await searchParams;
  await requireViewerWithHandle(UUID.test(sourceId) ? `/admin/catalog/merge/${sourceId}` : "/admin/catalog");
  // Anyone who can't review gets the same page as for an address that doesn't exist.
  if (!(await canReview()) || !UUID.test(sourceId)) notFound();

  const into = typeof search.into === "string" && UUID.test(search.into) ? search.into : null;
  if (!into) {
    return (
      <div className="flex flex-col gap-4">
        <p>
          <Link href="/admin/catalog" className={backLink}>
            <ArrowLeft aria-hidden="true" className="size-4" />
            Review queue
          </Link>
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-pretty">Merge a duplicate release</h1>
        <p className="text-sm">
          Merging keeps one record for the same physical product. This release&apos;s copies move to the one you keep, with everything their owners recorded. Nothing is deleted,
          and this record stays as history.
        </p>
        <Candidates sourceId={sourceId} />
      </div>
    );
  }

  const outcome = await getMergePreview(sourceId, into);
  if (!outcome.ok) {
    if (outcome.reason === "refused" && outcome.message === "release unavailable") notFound();
    if (outcome.reason === "refused" && outcome.message === "target unavailable") {
      return (
        <EmptyState icon={PlugZap} title="That release can't take a merge">
          It isn&apos;t published, or it&apos;s this release.{" "}
          <Link href={`/admin/catalog/merge/${sourceId}`} className="text-primary-text underline underline-offset-4">
            Choose another
          </Link>
        </EmptyState>
      );
    }
    return (
      <EmptyState icon={PlugZap} title="This merge isn't available">
        It can&apos;t be loaded right now. Try again later.
      </EmptyState>
    );
  }
  const p = outcome.data;
  const blocked = p.blocking.length > 0;
  const needsAdmin = p.requires_admin && !(await isAdministrator());

  return (
    <article aria-labelledby="merge-title" className="flex flex-col gap-4">
      <p>
        <Link href={`/admin/catalog/merge/${sourceId}`} className={backLink}>
          <ArrowLeft aria-hidden="true" className="size-4" />
          Choose another release
        </Link>
      </p>
      <h1 id="merge-title" className="text-xl font-semibold tracking-tight text-pretty">
        Merge {p.source.game.title} into another release
      </h1>

      <Section id="merge-pair" title="The releases">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Merged</dt>
            <dd>
              <Label release={p.source} />
            </dd>
          </div>
          <div>
            <dt className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Kept</dt>
            <dd>
              <Label release={p.target} />
            </dd>
          </div>
        </dl>
      </Section>

      <Section id="merge-differences" title={p.differences.length ? `What differs (${p.differences.length})` : "What differs"}>
        {p.differences.length ? (
          <div>
            <table className="w-full table-fixed text-left text-sm">
              <caption className="sr-only">Each field that differs between the merged release and the one kept</caption>
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Field
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Merged
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Kept
                  </th>
                </tr>
              </thead>
              <tbody>
                {p.differences.map((d) => (
                  <tr key={d.field} className="border-b align-top last:border-0">
                    <th scope="row" className="py-2 pr-3 font-medium">
                      {fieldLabel(d.field)}
                      {d.critical ? <span className="mt-0.5 block text-xs font-normal text-amber-800 dark:text-amber-300">Check carefully</span> : null}
                    </th>
                    <td className="py-2 pr-3 wrap-break-word">{fieldValue(d.field, d.source)}</td>
                    <td className="py-2 wrap-break-word">{fieldValue(d.field, d.target)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Every compared field is the same.</p>
        )}
        {p.differences.some((d) => d.field === "product_code" || d.field === "barcode") ? (
          <p className="mt-3 text-sm">A different product code or barcode usually means a different physical product. Merge only if one of them is wrong.</p>
        ) : null}
      </Section>

      <Section id="merge-effects" title="What merging does">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
          <li>The kept release doesn&apos;t change. To keep a value from the merged one, edit the kept release first.</li>
          <li>
            {p.copies
              ? `${p.copies === 1 ? "1 copy" : `${p.copies.toLocaleString("en")} copies`} of ${p.owners === 1 ? "1 collector" : `${p.owners.toLocaleString("en")} collectors`} move to the kept release, with their conditions, private details and every piece record. Pieces the kept release doesn't list stay, as no longer listed. Each collector is told once, without your name.`
              : "No collector has a copy of it."}
          </li>
          {p.kind === "published" ? <li>Links to the merged release go to the kept one.</li> : <li>The merged release stays private. Links to it lead nowhere, as for a record that doesn&apos;t exist.</li>}
          {p.kind === "submission" ? <li>Its submission is closed as merged. The submitter sees where it went.</li> : null}
          {p.retire ? <li>The game this submission created isn&apos;t used by anything else, so it&apos;s retired, as a rejection would.</li> : null}
          {p.repoint_releases.length ? <li>{p.repoint_releases.length === 1 ? "1 release merged into it now points" : `${p.repoint_releases.length} releases merged into it now point`} at the kept one.</li> : null}
          {p.references.map((r) => (
            <li key={r.id}>
              Its {r.provider_code} reference {r.external_id} moves to the kept release{r.target_had_provider ? ", which keeps its own reference from that source too" : ""}. The move is recorded.
            </li>
          ))}
        </ul>
      </Section>

      {p.own_submission ? (
        <Warning>You submitted one of these, so another editor has to decide.</Warning>
      ) : blocked ? (
        <Section id="merge-blocked" title="It can't be merged">
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
            {p.blocking.map((b) => (
              <li key={b.kind}>{blockerText(b.kind)}</li>
            ))}
          </ul>
        </Section>
      ) : needsAdmin ? (
        <Warning>Merging a published release needs an administrator. Ask one to review this page.</Warning>
      ) : (
        <Section id="merge-confirm" title="Merge it">
          <MergeForm sourceId={p.source_id} targetId={p.target_id} token={p.token} fields={p.differences.map((d) => ({ field: d.field, critical: d.critical }))} copies={p.copies} owners={p.owners} />
        </Section>
      )}
    </article>
  );
}

export default function MergePage({ params, searchParams }: PageProps<"/admin/catalog/merge/[sourceId]">) {
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
          <MergeView params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
