import Link from "next/link";
import type { ReactNode } from "react";

import { linkClass } from "@/components/admin/admin-frame";
import { actorLabel, eventSummary, recordStatusLabel } from "@/features/records/form";
import type { HistoryEvent } from "@/features/records/form";
import { getRecordHistory } from "@/features/records/queries";
import type { RecordHistory } from "@/features/records/queries";
import { formatWhen } from "@/features/submissions/display";

/** A record's status, in words, with what it means for the public catalog. */
export function StatusBadge({ status }: { status: string }) {
  return <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{recordStatusLabel(status)}</span>;
}

/** Labelled values; rows without a value are left out, never shown as a placeholder. */
export function Facts({ label, rows }: { label?: string; rows: { label: string; value: ReactNode | null }[] }) {
  const shown = rows.filter((r) => r.value !== null && r.value !== undefined && r.value !== "");
  return (
    <dl aria-label={label} className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-y-2">
      {shown.map((row) => (
        <div key={row.label} className="flex flex-col gap-0.5 sm:contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RecordSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-4 rounded-lg border bg-card p-4">
      <h2 id={`${id}-title`} className="mb-3 text-sm font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Links an event's details lead to: its submission, merge, exclusion or other record. */
function eventLinks(event: HistoryEvent, recordId: string, admin: boolean): { href: string; label: string }[] {
  const d = event.details;
  const links: { href: string; label: string }[] = [];
  const request = str(d.request_id);
  if (request) links.push({ href: `/admin/catalog/${request}`, label: "Submission" });
  const merge = str(d.merge_id);
  if (merge) links.push({ href: `/admin/catalog/merges/${merge}`, label: "Merge" });
  const exclusion = str(d.exclusion_id);
  if (exclusion && admin) links.push({ href: `/admin/catalog/exclusions/${exclusion}`, label: "Exclusion" });
  if (event.action === "catalog_release_merged") {
    const other = str(d.record_id) === recordId ? str(d.target_id) : str(d.record_id);
    if (other) links.push({ href: `/admin/catalog/releases/${other}`, label: str(d.record_id) === recordId ? "Merged into" : "Merged release" });
  }
  if (d.entity === "game_relation") {
    const other = str(d.record_id) === recordId ? str(d.target_id) : str(d.record_id);
    if (other) links.push({ href: `/admin/catalog/games/${other}`, label: "Related game" });
  }
  return links;
}

/** A record's events, newest first. */
export function HistoryList({ history, recordId, admin }: { history: RecordHistory; recordId: string; admin: boolean }) {
  if (!history.items.length) return <p className="text-sm text-muted-foreground">Nothing has been recorded for it yet.</p>;
  return (
    <ol className="flex flex-col gap-3">
      {history.items.map((event) => {
        const links = eventLinks(event, recordId, admin);
        return (
          <li key={event.id} className="flex flex-col gap-0.5 border-l-2 border-border pl-3 text-sm">
            <span>
              <span className="font-medium">{actorLabel(event.actor)}</span> · {eventSummary(event, recordId)}
            </span>
            <span className="text-xs text-muted-foreground">
              <time dateTime={event.occurred_at}>{formatWhen(event.occurred_at)}</time>
            </span>
            {event.reason ? <span className="text-muted-foreground break-words">“{event.reason}”</span> : null}
            {links.length ? (
              <span className="flex flex-wrap gap-x-3">
                {links.map((l) => (
                  <Link key={l.href} href={l.href} className={linkClass}>
                    {l.label}
                  </Link>
                ))}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The latest few events of a record, for the review and merge pages, with a link to
 * the record's full history. Renders nothing when the record has none to show.
 */
export async function HistoryPanel({ id, entity, recordId, title, admin }: { id: string; entity: "game" | "release"; recordId: string; title: string; admin: boolean }) {
  const outcome = await getRecordHistory(entity, recordId, null, 5);
  const href = `/admin/catalog/${entity === "game" ? "games" : "releases"}/${recordId}#history`;
  return (
    <RecordSection id={id} title={title}>
      {!outcome.ok ? (
        <p className="text-sm text-muted-foreground">The history can&apos;t be loaded right now.</p>
      ) : !outcome.data ? (
        <p className="text-sm text-muted-foreground">This record no longer exists.</p>
      ) : (
        <>
          <HistoryList history={outcome.data} recordId={recordId} admin={admin} />
          <p className="mt-3 text-sm">
            <Link href={href} className={linkClass}>
              {outcome.data.next_before ? "Full history and record" : "The full record"}
            </Link>
          </p>
        </>
      )}
    </RecordSection>
  );
}
