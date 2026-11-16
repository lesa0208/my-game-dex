import { ArrowLeft, CircleCheck, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AdminFrame, AdminShell } from "@/components/admin/admin-frame";
import { EmptyState } from "@/components/shared/empty-state";
import { requireAdminSection } from "@/features/admin/queries";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { catalogStatusLabel, releaseLabelLine } from "@/features/exclusion/form";
import { fieldLabel, fieldValue } from "@/features/merge/form";
import { getMerge } from "@/features/merge/queries";

export const metadata: Metadata = {
  title: "Merge",
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

const KIND: Record<string, string> = {
  published: "A published duplicate",
  submission: "A submission, merged from review",
  unpublished: "An unpublished record",
};

async function MergeDetailView({ params, searchParams }: { params: PageProps<"/admin/catalog/merges/[id]">["params"]; searchParams: PageProps<"/admin/catalog/merges/[id]">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  // Catalog editors only (D8); staff signed in without their authenticator verify first.
  const { access } = await requireAdminSection(UUID.test(id) ? `/admin/catalog/merges/${id}` : "/admin/catalog/merges", "editor");
  const frame = (title: string, body: ReactNode, titleId?: string) => (
    <AdminFrame access={access} current="catalog" title={title} titleId={titleId}>
      {body}
    </AdminFrame>
  );
  const outcome = await getMerge(id);
  if (!outcome.ok) {
    if (outcome.reason === "refused") notFound();
    return frame(
      "Merge",
      <EmptyState icon={PlugZap} title="This merge isn't available">
        It can&apos;t be loaded right now. Try again later.
      </EmptyState>,
    );
  }
  const m = outcome.data;
  if (!m) notFound();

  return frame(
    `${m.source.game.title} merged`,
    <article aria-labelledby="merge-detail-title" className="flex flex-col gap-4">
      <p>
        <Link
          href="/admin/catalog/merges"
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All merges
        </Link>
      </p>
      {search.notice === "merged" ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
          Merged. {m.copies_moved === 1 ? "1 copy moved" : `${m.copies_moved.toLocaleString("en")} copies moved`}
          {m.owners_affected ? ", and their owners have been told." : "."}
        </p>
      ) : null}
      <header>
        <p className="text-sm text-muted-foreground">
          {KIND[m.kind] ?? m.kind} · {formatDay(m.merged_at)}
          {m.merged_by ? ` · by @${m.merged_by}` : ""}
        </p>
      </header>

      <Section id="merge-detail-pair" title="The releases">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Merged</dt>
            <dd>
              <span className="font-medium">{m.source.game.title}</span>
              <span className="block text-muted-foreground">{releaseLabelLine(m.source)}</span>
              <span className="mt-1 block text-xs text-muted-foreground">Was {catalogStatusLabel(m.previous_status).toLowerCase()}</span>
            </dd>
          </div>
          <div>
            <dt className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Kept</dt>
            <dd>
              {m.target.game.slug && m.target.status === "published" ? (
                <Link href={`/games/${m.target.game.slug}?release=${m.target.id}`} className="font-medium text-primary-text underline underline-offset-4">
                  {m.target.game.title}
                </Link>
              ) : (
                <span className="font-medium">{m.target.game.title}</span>
              )}
              <span className="block text-muted-foreground">{releaseLabelLine(m.target)}</span>
            </dd>
          </div>
        </dl>
      </Section>

      <Section id="merge-detail-record" title="The record">
        <dl className="grid gap-2 text-sm">
          <div>
            <dt className="font-medium">Reason</dt>
            <dd className="text-pretty">{m.staff_reason}</dd>
          </div>
          {m.owner_note ? (
            <div>
              <dt className="font-medium">Note to owners</dt>
              <dd className="text-pretty">{m.owner_note}</dd>
            </div>
          ) : null}
          <div>
            <dt className="font-medium">Moved</dt>
            <dd>
              {m.copies_moved === 1 ? "1 copy" : `${m.copies_moved.toLocaleString("en")} copies`} of {m.owners_affected === 1 ? "1 collector" : `${m.owners_affected.toLocaleString("en")} collectors`}
              {m.references_moved ? `, ${m.references_moved === 1 ? "1 external reference" : `${m.references_moved} external references`}` : ""}
              {m.repointed_releases.length ? `, ${m.repointed_releases.length === 1 ? "1 earlier merge repointed" : `${m.repointed_releases.length} earlier merges repointed`}` : ""}
            </dd>
          </div>
          {m.retired_game ? (
            <div>
              <dt className="font-medium">Game retired</dt>
              <dd>The game the submission created, unused elsewhere, is now {catalogStatusLabel(m.retired_game.status).toLowerCase()}.</dd>
            </div>
          ) : null}
          {m.request_id ? (
            <div>
              <dt className="font-medium">Submission</dt>
              <dd>
                <Link href={`/admin/catalog/${m.request_id}`} className="text-primary-text underline underline-offset-4">
                  See the submission
                </Link>
              </dd>
            </div>
          ) : null}
        </dl>
      </Section>

      <Section id="merge-detail-differences" title="Differences acknowledged">
        {m.differences.length ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {m.differences.map((d) => (
              <li key={d.field}>
                <span className="font-medium">{fieldLabel(d.field)}:</span> {fieldValue(d.field, d.source)} → {fieldValue(d.field, d.target)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Every compared field was the same.</p>
        )}
      </Section>

      {m.references.length ? (
        <Section id="merge-detail-references" title="External references moved">
          <ul className="flex flex-col gap-1.5 text-sm">
            {m.references.map((r) => (
              <li key={`${r.provider_code}-${r.external_id}`}>
                {r.provider_code} {r.external_id}
                {r.target_had_provider ? " (the kept release already had one from this source, and keeps both)" : ""}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>,
    "merge-detail-title",
  );
}

export default function MergeDetailPage({ params, searchParams }: PageProps<"/admin/catalog/merges/[id]">) {
  return (
    <AdminShell>
      <MergeDetailView params={params} searchParams={searchParams} />
    </AdminShell>
  );
}
