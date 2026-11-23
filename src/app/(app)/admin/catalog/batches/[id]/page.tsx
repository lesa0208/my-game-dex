import { ClipboardList, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { BatchStatusPill, Callout, CategoryPill, CriticalErrorText, FilterLinks, Hash, OutcomePill, Pager, personText, ReviewProgress } from "@/components/admin/batch-review";
import { Facts, RecordSection, StatusBadge } from "@/components/admin/records";
import { EmptyState } from "@/components/shared/empty-state";
import { requireAdminSection } from "@/features/admin/queries";
import { APPROVE_BLOCKS, blockerText, flagLabel, MEMBER_FILTERS, memberFilter, type MemberFilter, percent, REVIEW_BLOCKS } from "@/features/batches/form";
import { getReviewBatchOverview, listReviewBatchMembers, type BatchOverview, type MemberSummary } from "@/features/batches/queries";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { formatWhen } from "@/features/submissions/display";

/** A title per batch, from its id alone, so tabs and history tell batches apart without another read. */
export async function generateMetadata({ params }: PageProps<"/admin/catalog/batches/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: UUID.test(id) ? `Review batch ${id.slice(0, 8)}` : "Review batch" };
}

function filterCount(o: BatchOverview, f: MemberFilter): number {
  const c = o.counts;
  switch (f) {
    case "needs_review":
      return c.pending;
    case "critical":
      return c.critical;
    case "flagged":
      return c.flagged;
    case "sampled":
      return c.sampled;
    case "reviewed":
      return c.recorded;
    case "unsampled":
      return c.unsampled;
    default:
      return c.items;
  }
}

function MemberCard({ batch, member, status }: { batch: string; member: MemberSummary; status: string }) {
  const flags = [...member.flags, ...member.info_flags];
  return (
    <li>
      <article aria-labelledby={`member-${member.game.id}`} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <h3 id={`member-${member.game.id}`} className="text-sm font-semibold text-pretty">
            <Link
              href={`/admin/catalog/batches/${batch}/members/${member.game.id}`}
              className="rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
            >
              {member.game.title}
            </Link>
          </h3>
          <span className="flex flex-wrap items-center gap-1.5">
            <CategoryPill category={member.category} />
            <OutcomePill outcome={member.outcome} requiresOutcome={member.requires_outcome} status={status} />
          </span>
        </header>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {member.source ? (
            <span>
              {member.source.provider} <code className="font-mono">{member.source.external_id}</code>
            </span>
          ) : (
            <span>No source record</span>
          )}
          <span>
            Game <StatusBadge status={member.game.status} />
          </span>
          {member.pairing_status ? (
            <span>
              Pairing <StatusBadge status={member.pairing_status} />
            </span>
          ) : (
            <span>No pairing</span>
          )}
          {member.sampled ? <span>Sampled</span> : null}
        </p>
        {flags.length ? (
          <p className="text-xs">
            <span className="sr-only">Flags: </span>
            {flags.map((f) => flagLabel(f)).join(" · ")}
          </p>
        ) : null}
        {member.stale ? (
          <p className="text-xs font-medium text-destructive">Changed since the batch was frozen, or left review: the batch can&apos;t be approved.</p>
        ) : null}
        {member.outcome ? (
          <p className="text-xs text-muted-foreground">
            {personText(member.reviewer)}
            {member.recorded_at ? `, ${formatDay(member.recorded_at)}` : ""}
            {member.critical_error ? (
              <>
                {" "}
                · <CriticalErrorText code={member.critical_error} />
              </>
            ) : null}
            {member.note ? <span className="mt-1 line-clamp-2 block whitespace-pre-line text-foreground/90">“{member.note}”</span> : null}
          </p>
        ) : null}
      </article>
    </li>
  );
}

async function BatchView({ params, searchParams }: { params: PageProps<"/admin/catalog/batches/[id]">["params"]; searchParams: PageProps<"/admin/catalog/batches/[id]">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  const { access } = await requireAdminSection(UUID.test(id) ? `/admin/catalog/batches/${id}` : "/admin/catalog/batches", "editor");
  const overview = await getReviewBatchOverview(id);
  if (!overview.ok) {
    return (
      <AdminFrame access={access} current="catalog" title="Review batch">
        <EmptyState icon={PlugZap} title="This batch isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      </AdminFrame>
    );
  }
  const o = overview.data;
  if (!o) notFound();
  const rawFilter = param(search.filter);
  const filter = rawFilter ? memberFilter(rawFilter) : o.status === "open" && o.counts.pending ? "needs_review" : "all";
  const after = param(search.after);
  const members = await listReviewBatchMembers(o.id, filter, after);
  const path = `/admin/catalog/batches/${o.id}`;
  const filterHref = (f: MemberFilter, a?: string | null) => `${path}?filter=${f}${a ? `&after=${a}` : ""}`;
  const short = o.id.slice(0, 8);

  return (
    <AdminFrame access={access} current="catalog" title={`Review batch ${short}`} titleId="batch-title">
      <article aria-labelledby="batch-title" className="flex flex-col gap-4">
        <p className="text-sm">
          <Link href="/admin/catalog/batches" className={linkClass}>
            Review batches
          </Link>
        </p>
        <header className="flex flex-col gap-2">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <BatchStatusPill status={o.status} />
            {o.platform.name} · {o.counts.items.toLocaleString("en")} members · created {formatWhen(o.created_at)} by {personText(o.creator)}
          </p>
        </header>
        <Callout title="An accepted identity isn't a physical game">
          Accepting a member&apos;s identity from {o.source.provider_name ?? o.source.provider} is not proof that a physical copy exists. Members you find
          correct carry your evidence of physical existence; unsampled members are never confirmed physically by this batch, and no member gets a
          physical release from it.
        </Callout>

        <div className="grid gap-4 lg:grid-cols-2">
          <RecordSection id="readiness" title="Approval readiness">
            <div className="flex flex-col gap-3">
              {o.status !== "open" ? (
                <p className="text-sm">
                  {o.status === "approved" ? "Approved" : "Rejected"}
                  {o.decided_at ? ` ${formatWhen(o.decided_at)}` : ""}
                  {o.decision_reason ? <span className="text-muted-foreground"> · “{o.decision_reason}”</span> : null}
                </p>
              ) : o.blockers.length ? (
                <>
                  <p className="text-sm">The database would refuse its approval now:</p>
                  <ul className="flex flex-col gap-2">
                    {o.blockers.map((b) => (
                      <li key={b.code}>
                        <Callout tone={b.code === "pending_outcomes" ? "warning" : "problem"}>{blockerText(b.code, b.count)}</Callout>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <Callout tone="info">Nothing holds its approval as the database assesses it now. Approval rechecks everything, with a fresh authenticator check.</Callout>
              )}
              <p className="text-sm">
                Approvals {o.approvals.recorded} of {o.approvals.required}
                {o.approvals.by.length ? ` · ${o.approvals.by.map((a) => `${personText(a.person)} ${formatDay(a.at)}`).join(", ")}` : ""}
              </p>
              {o.you.approve && o.status === "open" ? <p className="text-sm text-muted-foreground">{APPROVE_BLOCKS[o.you.approve]}</p> : null}
              <p className="text-xs text-muted-foreground">Approving and rejecting batches will be done here in a later release.</p>
            </div>
          </RecordSection>

          <RecordSection id="progress" title="Review progress">
            <div className="flex flex-col gap-3">
              <ReviewProgress recorded={o.counts.required - o.counts.pending} required={o.counts.required} />
              <Facts
                label="Outcomes"
                rows={[
                  { label: "Found correct", value: o.counts.correct.toLocaleString("en") },
                  { label: "Found incorrect", value: o.counts.incorrect.toLocaleString("en") },
                  { label: "Excluded", value: o.counts.excluded.toLocaleString("en") },
                  { label: "Critical errors", value: o.counts.critical_errors.toLocaleString("en") },
                  {
                    label: "Sample errors",
                    value: `${o.counts.sample_errors.toLocaleString("en")} (the sample fails above ${o.sampling.acceptance_number.toLocaleString("en")})`,
                  },
                ]}
              />
            </div>
          </RecordSection>
        </div>

        <RecordSection id="provenance" title="Provenance and sampling">
          <Facts
            label="Provenance and sampling"
            rows={[
              { label: "Source", value: `${o.source.provider_name ?? o.source.provider}: ${o.source.name}` },
              { label: "Source fetched", value: o.source.fetched_at ? formatWhen(o.source.fetched_at) : null },
              { label: "Import finished", value: o.source.finished_at ? formatWhen(o.source.finished_at) : null },
              { label: "Source snapshot", value: <Hash value={o.source.snapshot_sha256} /> },
              { label: "Terms reviewed", value: <Hash value={o.source.terms_sha256} /> },
              { label: "Frozen content", value: <Hash value={o.content_sha256} /> },
              { label: "Sampling seed", value: <Hash value={o.seed} /> },
              {
                label: "Members",
                value: `${o.counts.critical} critical risk, ${o.counts.flagged - o.counts.critical} flagged, ${o.counts.sampled} sampled, ${o.counts.unsampled} not sampled${o.counts.with_info_flags ? ` (${o.counts.with_info_flags} with information flags)` : ""}`,
              },
              { label: "Sample size", value: `${o.sampling.sample_size.toLocaleString("en")} of ${o.counts.unsampled + o.counts.sampled} unflagged members` },
              { label: "Policy", value: `${percent(o.sampling.tolerable_error)} tolerable error at ${percent(o.sampling.confidence)} confidence; acceptance number ${o.sampling.acceptance_number}` },
              { label: "Required reviews", value: `${o.counts.required.toLocaleString("en")} (every flagged and sampled member)` },
              { label: "Reason", value: o.reason },
            ]}
          />
        </RecordSection>

        <section aria-labelledby="members-title" className="flex flex-col gap-3">
          <h2 id="members-title" className="text-base font-semibold">
            Members
          </h2>
          {o.you.review ? <Callout tone="warning">{REVIEW_BLOCKS[o.you.review]}</Callout> : null}
          <FilterLinks
            label="Filter members"
            items={MEMBER_FILTERS.map((f) => ({ href: filterHref(f.value), label: f.label, count: filterCount(o, f.value), current: f.value === filter }))}
          />
          {!members.ok ? (
            <EmptyState icon={PlugZap} title="The members aren't available">
              {members.reason === "refused" ? "This page of members can't be shown. Go back to the first page." : "They can't be loaded right now. Try again later."}
            </EmptyState>
          ) : !members.data?.items.length ? (
            <EmptyState icon={ClipboardList} title={after ? "No more members" : "No members here"}>
              {filter === "needs_review" ? "No member is awaiting review." : "No member matches this filter."}
            </EmptyState>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Critical risk first, then flagged, sampled and the rest, each by title.</p>
              <ol aria-label="Batch members" className="flex flex-col gap-2">
                {members.data.items.map((m) => (
                  <MemberCard key={m.game.id} batch={o.id} member={m} status={o.status} />
                ))}
              </ol>
              <Pager first={after ? filterHref(filter) : null} next={members.data.next_after ? filterHref(filter, members.data.next_after) : null} />
            </>
          )}
        </section>
      </article>
    </AdminFrame>
  );
}

export default function ReviewBatchPage({ params, searchParams }: PageProps<"/admin/catalog/batches/[id]">) {
  return (
    <AdminShell>
      <BatchView params={params} searchParams={searchParams} />
    </AdminShell>
  );
}
