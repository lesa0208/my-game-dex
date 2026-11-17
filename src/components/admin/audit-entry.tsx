import Link from "next/link";

import { linkClass } from "@/components/admin/admin-frame";
import { StatusPill, when } from "@/components/admin/data-table";
import { auditActionLabel, auditDetails, auditOutcomeLabel } from "@/features/admin/form";
import type { AuditEntry } from "@/features/admin/queries";

/**
 * One audit event (M10e), as the audit log, an account's history and the staff
 * overview show it: what happened, its outcome, who acted and about whom, the reason
 * and the allow-listed details. Handles link to the account, and to their events when
 * the viewer may read the audit log; a game or release links to its record.
 */
export function AuditEntryItem({ entry, auditLinks }: { entry: AuditEntry; auditLinks: boolean }) {
  const details = auditDetails(entry.details);
  const record = entry.details.record;
  const tone = entry.outcome === "refused" ? "problem" : entry.outcome === "operator" ? "warning" : "good";
  return (
    <li className="rounded-lg border bg-card p-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{auditActionLabel(entry.action)}</span>
        <StatusPill tone={tone}>{auditOutcomeLabel(entry.outcome)}</StatusPill>
        <span className="text-xs text-muted-foreground">{when(entry.occurred_at)}</span>
      </p>
      <p className="mt-1 text-muted-foreground">
        By <Who handle={entry.actor_handle} account={entry.by_account} none="an operator or the system" auditLinks={auditLinks} param="actor" />
        {entry.target_handle || entry.about_account ? (
          <>
            {" · about "}
            <Who handle={entry.target_handle} account={entry.about_account} none="" auditLinks={auditLinks} param="target" />
          </>
        ) : null}
      </p>
      {entry.reason !== null ? <p className="mt-1 wrap-break-word">{entry.reason}</p> : null}
      {details.length || record ? (
        <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {details.map((d) => (
            <div key={d.label} className="flex gap-1">
              <dt>{d.label}:</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
          {record ? (
            <div className="flex gap-1">
              <dt className="sr-only">Record:</dt>
              <dd>
                <Link href={`/admin/catalog/${record.entity === "game" ? "games" : "releases"}/${record.id}`} className={linkClass}>
                  Open the {record.entity}
                </Link>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </li>
  );
}

function Who({ handle, account, none, auditLinks, param }: { handle: string | null; account: boolean; none: string; auditLinks: boolean; param: "actor" | "target" }) {
  if (!handle) return <>{account ? "an account without a handle" : none}</>;
  return (
    <>
      <Link href={`/admin/accounts?handle=${handle}`} className={linkClass}>
        @{handle}
      </Link>
      {auditLinks ? (
        <>
          {" "}
          <Link href={`/admin/audit?${param}=${handle}`} className="text-xs text-muted-foreground underline underline-offset-4">
            ({param === "actor" ? "their actions" : "events about them"})
          </Link>
        </>
      ) : null}
    </>
  );
}
