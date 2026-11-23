import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { BatchStatusPill, Callout, CategoryPill, CriticalErrorText, FlagList, Hash, OutcomePill, personText } from "@/components/admin/batch-review";
import { EditForm } from "@/components/admin/edit-form";
import { OutcomeFields } from "@/components/admin/outcome-fields";
import { Facts, RecordSection, StatusBadge } from "@/components/admin/records";
import { StepUpNotice } from "@/components/admin/review-panel";
import { EmptyState } from "@/components/shared/empty-state";
import { requireAdminSection } from "@/features/admin/queries";
import { recordOutcome, recordOutcomeFromForm } from "@/features/batches/actions";
import { CATEGORY_DETAILS, distributionFormatLabel, itemLink, OUTCOME_LABELS, outcomeMessage, RECORD_BLOCKS, sourceLinks } from "@/features/batches/form";
import type { MemberContext } from "@/features/batches/queries";
import { getReviewBatchMember } from "@/features/batches/queries";
import { formatCatalogDate } from "@/features/catalog/format";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { formatWhen } from "@/features/submissions/display";

export const metadata: Metadata = {
  title: "Batch member",
};

const NOTICES: Record<string, string> = { recorded: "Outcome recorded." };

function ExternalLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : (
    <>{children}</>
  );
}

/** The game's first release as the catalog records it: a date, shown to its precision. */
function catalogDate(d: { value: string; precision: string } | null): string {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.value)) return "Not recorded";
  if (d.precision === "year") return formatCatalogDate({ value: d.value.slice(0, 4), precision: "year" });
  if (d.precision === "month") return formatCatalogDate({ value: d.value.slice(0, 7), precision: "month" });
  return d.precision === "day" ? formatCatalogDate({ value: d.value, precision: "day" }) : "Not recorded";
}

function sourceDate(d: { value: string; precision: string | null } | null) {
  if (!d) return null;
  return `${d.value}${d.precision ? ` (${d.precision})` : ""}`;
}

function IdentityEvidence({ m }: { m: MemberContext }) {
  const s = m.source;
  const links = s ? sourceLinks(s.provider, s.external_id, s.record.revision) : { item: null, revision: null };
  const r = s?.record;
  return (
    <RecordSection id="identity" title="Game identity evidence">
      <p className="mb-3 text-sm text-muted-foreground">What supports the title and its platform. It says nothing about whether a physical copy exists.</p>
      {!s || !r ? (
        <p className="text-sm">This member has no source record.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <Facts
            label="Source record"
            rows={[
              {
                label: "Source record",
                value: (
                  <>
                    {s.provider_name ?? s.provider} <ExternalLink href={links.item}>{s.external_id}</ExternalLink>
                  </>
                ),
              },
              { label: "Revision staged", value: r.revision ? <ExternalLink href={links.revision}>{r.revision.toString()}</ExternalLink> : null },
              { label: "Title in the source", value: r.title },
              { label: "Other titles", value: r.titles.length ? r.titles.join(" · ") : null },
              { label: "Japanese titles", value: r.ja_titles.length ? <span lang="ja">{r.ja_titles.join(" · ")}</span> : null },
              { label: "First release (source)", value: sourceDate(r.first_release) ?? "Not stated" },
              { label: `Release on ${m.batch.platform.short_name} (source)`, value: sourceDate(r.platform_first_release) ?? "Not stated" },
              {
                label: "Typed as",
                value: r.instance_of.length
                  ? r.instance_of.map((q, i) => (
                      <span key={q}>
                        {i ? ", " : ""}
                        <ExternalLink href={itemLink(q)}>{q}</ExternalLink>
                      </span>
                    ))
                  : null,
              },
              { label: "Platforms stated", value: r.platforms !== null ? r.platforms.toLocaleString("en") : null },
              { label: "IGDB", value: r.external_ids.igdb.length ? r.external_ids.igdb.join(", ") : null },
              { label: "MobyGames", value: r.external_ids.mobygames.length ? r.external_ids.mobygames.join(", ") : null },
              { label: "Full entity record", value: r.detail ? "Staged" : "Missing: only query-snapshot fields" },
              {
                label: "Risk assessment",
                value: `${s.assessment.assessor ?? "Unknown assessor"} ${s.assessment.assessor_version ?? ""}`.trim() + (s.assessment.problems.length ? `: ${s.assessment.problems.join("; ")}` : ": valid"),
              },
              { label: "Record hash", value: <Hash value={s.payload_sha256} /> },
              { label: "Source snapshot", value: <Hash value={s.snapshot_sha256} /> },
            ]}
          />
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Possible duplicates and conflicts</h3>
            {!m.conflicts.same_title.length && !m.conflicts.shared_ids.length && !m.conflicts.linked_elsewhere.length ? (
              <p className="text-sm text-muted-foreground">None found: no catalog game with the same title, no member sharing an IGDB or MobyGames id, and no other game linked to this source id.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {m.conflicts.same_title.map((c) => (
                  <li key={`t-${c.id}`}>
                    Same title:{" "}
                    <Link href={`/admin/catalog/games/${c.id}`} className={linkClass}>
                      {c.title}
                    </Link>{" "}
                    <StatusBadge status={c.status} /> {c.on_platform ? `on ${m.batch.platform.short_name}` : "on another platform"}
                    {c.in_batch ? ", in this batch" : ""}
                  </li>
                ))}
                {m.conflicts.shared_ids.map((c) => (
                  <li key={`s-${c.id}`}>
                    Shares an IGDB or MobyGames id:{" "}
                    <Link href={`/admin/catalog/batches/${m.batch.id}/members/${c.id}`} className={linkClass}>
                      {c.title}
                    </Link>{" "}
                    (in this batch)
                  </li>
                ))}
                {m.conflicts.linked_elsewhere.map((c) => (
                  <li key={`l-${c.id}`}>
                    Its source id is linked to:{" "}
                    <Link href={`/admin/catalog/games/${c.id}`} className={linkClass}>
                      {c.title}
                    </Link>{" "}
                    <StatusBadge status={c.status} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </RecordSection>
  );
}

function PhysicalEvidence({ m }: { m: MemberContext }) {
  const formats = m.source?.record.distribution_formats ?? [];
  const confirmed = m.pairing?.physical_confirmed ?? false;
  return (
    <RecordSection id="physical" title="Physical existence evidence">
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          <span className="font-medium">{confirmed ? "Confirmed with evidence." : "Not confirmed."}</span>{" "}
          <span className="text-muted-foreground">
            {confirmed
              ? "An editor recorded evidence that a physical copy exists on this platform."
              : "No editor has recorded evidence that a physical copy exists on this platform. A platform listing or a stated format is not that evidence."}
          </span>
        </p>
        <Facts
          label="Physical existence"
          rows={[
            {
              label: "Formats in the source",
              value: formats.length ? formats.map(distributionFormatLabel).join("; ") : "None stated",
            },
            {
              label: "Evidence in this batch",
              value:
                m.member.outcome === "correct" && m.member.note ? (
                  <span>
                    <span className="whitespace-pre-line">“{m.member.note}”</span>
                    <span className="block text-xs text-muted-foreground">
                      {personText(m.member.reviewer)}. It becomes the pairing&apos;s evidence when the batch is approved.
                    </span>
                  </span>
                ) : m.member.requires_outcome ? (
                  "None recorded yet"
                ) : (
                  "None: this member isn't reviewed individually, so the batch never confirms its physical existence"
                ),
            },
          ]}
        />
        <p className="text-xs text-muted-foreground">A stated physical medium may describe another platform&apos;s version, a reissue or a prototype.</p>
      </div>
    </RecordSection>
  );
}

function ReleaseEvidence({ m }: { m: MemberContext }) {
  const r = m.pairing?.releases;
  return (
    <RecordSection id="releases" title="Physical release evidence">
      <div className="flex flex-col gap-2 text-sm">
        <p>
          {!r || r.total === 0
            ? "No physical release is recorded for this game on this platform."
            : `${r.total.toLocaleString("en")} recorded, ${r.published.toLocaleString("en")} verified and published.`}{" "}
          <span className="text-muted-foreground">A batch never creates or verifies a release: an exact region, edition, format or packaging is verified on the release itself.</span>
        </p>
        <p>
          <Link href={`/admin/catalog/games/${m.game.id}#game-platforms`} className={linkClass}>
            The game record, with its releases and platform evidence
          </Link>
        </p>
      </div>
    </RecordSection>
  );
}

function History({ m }: { m: MemberContext }) {
  return (
    <RecordSection id="history" title="Review history">
      <div className="flex flex-col gap-3">
        {m.trail.length ? (
          <ol aria-label="Outcomes in this batch" className="flex flex-col gap-2">
            {m.trail.map((t, i) => (
              <li key={`${t.at}-${i}`} className="flex flex-col gap-0.5 border-l-2 border-border pl-3 text-sm">
                <span>
                  <span className="font-medium">{personText(t.person)}</span> · {OUTCOME_LABELS[t.outcome] ?? t.outcome}
                  {t.critical_error ? (
                    <>
                      {" "}
                      · <CriticalErrorText code={t.critical_error} />
                    </>
                  ) : null}
                </span>
                <time dateTime={t.at} className="text-xs text-muted-foreground">
                  {formatWhen(t.at)}
                </time>
                {t.note ? <span className="whitespace-pre-line text-muted-foreground">“{t.note}”</span> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No outcome recorded in this batch.</p>
        )}
        <h3 className="text-sm font-semibold">Batches with this game on {m.batch.platform.short_name}</h3>
        <ul className="flex flex-col gap-1 text-sm">
          {m.batches.map((b) => (
            <li key={b.id}>
              {b.id === m.batch.id ? (
                <span className="font-medium">This batch</span>
              ) : (
                <Link href={`/admin/catalog/batches/${b.id}`} className={linkClass}>
                  Batch <code className="font-mono">{b.id.slice(0, 8)}</code>
                </Link>
              )}{" "}
              · <BatchStatusPill status={b.status} /> · created {formatDay(b.created_at)}
              {" · "}
              {b.outcome ? `found ${OUTCOME_LABELS[b.outcome].toLowerCase()}` : b.sampled || b.flagged ? "not reviewed" : "not sampled"}
            </li>
          ))}
        </ul>
      </div>
    </RecordSection>
  );
}

function Decision({ m, recentMfa, path }: { m: MemberContext; recentMfa: boolean; path: string }) {
  let body: React.ReactNode;
  if (m.you.record) {
    body = <p className="text-sm">{RECORD_BLOCKS[m.you.record] ?? "You can't record an outcome for this member."}</p>;
  } else if (m.member.stale) {
    body = (
      <Callout tone="problem">
        This member changed since the batch was frozen, or left review, so the batch can&apos;t be approved. Recording an outcome won&apos;t change that: the batch
        has to be rejected.
      </Callout>
    );
  } else if (!recentMfa) {
    body = <StepUpNotice path={path}>Recording an outcome needs a recent verification.</StepUpNotice>;
  } else {
    const links = m.source ? sourceLinks(m.source.provider, m.source.external_id, m.source.record.revision) : null;
    body = (
      <div className="flex flex-col gap-3">
        {m.source ? (
          <p className="text-sm">
            Reviewing against {m.source.provider_name ?? m.source.provider} <ExternalLink href={links?.item ?? null}>{m.source.external_id}</ExternalLink>
            {m.source.record.revision ? (
              <>
                {" "}
                (staged revision <ExternalLink href={links?.revision ?? null}>{m.source.record.revision.toString()}</ExternalLink>)
              </>
            ) : null}
            . On approval, a correct outcome records this source and reference beside your evidence.
          </p>
        ) : null}
        <EditForm id="record-outcome" recordId={`${m.batch.id}:${m.game.id}`} action={recordOutcome} plain={recordOutcomeFromForm} submit="Record the outcome" pending="Recording…" variant="default">
          <input type="hidden" name="batch_id" value={m.batch.id} />
          <input type="hidden" name="game_id" value={m.game.id} />
          <input type="hidden" name="seen_revision" value={m.game.revision} />
          <input type="hidden" name="seen_outcome" value={m.member.outcome ?? ""} />
          <OutcomeFields options={m.you.options} keepCriticalError={m.you.keep_critical_error} platform={m.batch.platform.name} />
        </EditForm>
      </div>
    );
  }
  return (
    <RecordSection id="decision" title="Your outcome">
      <div className="flex flex-col gap-3">
        {m.member.outcome ? (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            Recorded: <OutcomePill outcome={m.member.outcome} requiresOutcome status={m.batch.status} /> by {personText(m.member.reviewer)}
            {m.member.recorded_at ? `, ${formatWhen(m.member.recorded_at)}` : ""}
          </p>
        ) : null}
        {body}
      </div>
    </RecordSection>
  );
}

async function MemberView({ params, searchParams }: { params: PageProps<"/admin/catalog/batches/[id]/members/[game]">["params"]; searchParams: PageProps<"/admin/catalog/batches/[id]/members/[game]">["searchParams"] }) {
  const { id, game } = await params;
  const search = await searchParams;
  const path = UUID.test(id) && UUID.test(game) ? `/admin/catalog/batches/${id}/members/${game}` : "/admin/catalog/batches";
  const { access } = await requireAdminSection(path, "editor");
  const outcome = await getReviewBatchMember(id, game);
  if (!outcome.ok) {
    return (
      <AdminFrame access={access} current="catalog" title="Batch member">
        <EmptyState icon={PlugZap} title="This member isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      </AdminFrame>
    );
  }
  const m = outcome.data;
  if (!m) notFound();
  const notice = param(search.notice);
  // Without JavaScript, a refusal comes back here as a fixed message's code; unknown codes show nothing.
  const error = outcomeMessage(param(search.error));

  return (
    <AdminFrame access={access} current="catalog" title={m.game.title} titleId="member-title">
      <article aria-labelledby="member-title" className="flex flex-col gap-4">
        {/* Separate targets of at least 24px, so they stay easy to tap when they wrap on a phone. */}
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href={`/admin/catalog/batches/${m.batch.id}`} className={`${linkClass} inline-flex min-h-6 items-center`}>
            Batch {m.batch.id.slice(0, 8)}
          </Link>
          <Link href={`/admin/catalog/batches/${m.batch.id}?filter=needs_review`} className={`${linkClass} inline-flex min-h-6 items-center`}>
            Members awaiting review
          </Link>
          <Link href={`/admin/catalog/games/${m.game.id}`} className={`${linkClass} inline-flex min-h-6 items-center`}>
            Game record
          </Link>
        </p>
        {notice && NOTICES[notice] ? (
          <p role="status" className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
            {NOTICES[notice]}
          </p>
        ) : null}
        <div role="alert" aria-live="assertive">
          {error ? <Callout tone="problem" title="The outcome wasn't recorded">{error}</Callout> : null}
        </div>
        <header className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Batch member · {m.batch.platform.name} · <BatchStatusPill status={m.batch.status} />
          </p>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <CategoryPill category={m.member.category} />
            <OutcomePill outcome={m.member.outcome} requiresOutcome={m.member.requires_outcome} status={m.batch.status} />
            Game <StatusBadge status={m.game.status} />
            {m.pairing ? (
              <>
                Pairing <StatusBadge status={m.pairing.status} />
              </>
            ) : (
              "No pairing"
            )}
          </p>
          <p className="text-sm text-muted-foreground">{CATEGORY_DETAILS[m.member.category]}</p>
        </header>
        {m.member.stale ? (
          <Callout tone="problem" title="Changed since the batch was frozen">
            The game changed after the batch froze it at revision {m.member.frozen_game_revision} (it&apos;s at {m.game.revision} now), or it or its pairing left review.
          </Callout>
        ) : null}

        <RecordSection id="flags" title="Review flags and risk">
          <FlagList flags={m.member.flags} infoFlags={m.member.info_flags} criticalFlags={m.member.critical_flags} />
        </RecordSection>

        <RecordSection id="catalog" title="The catalog record">
          <Facts
            label="Catalog record"
            rows={[
              { label: "Title", value: m.game.title },
              { label: "First release", value: catalogDate(m.game.first_release) },
              { label: "Identity", value: m.game.identity_verified ? "Verified" : "Not verified" },
              { label: "Revision", value: `${m.game.revision} (frozen at ${m.member.frozen_game_revision})` },
            ]}
          />
        </RecordSection>

        <IdentityEvidence m={m} />
        <PhysicalEvidence m={m} />
        <ReleaseEvidence m={m} />
        <Decision m={m} recentMfa={access.recentMfa} path={path} />
        <History m={m} />
      </article>
    </AdminFrame>
  );
}

export default function BatchMemberPage({ params, searchParams }: PageProps<"/admin/catalog/batches/[id]/members/[game]">) {
  return (
    <AdminShell>
      <MemberView params={params} searchParams={searchParams} />
    </AdminShell>
  );
}
