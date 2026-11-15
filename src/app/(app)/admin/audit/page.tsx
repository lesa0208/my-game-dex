import type { Metadata } from "next";
import Link from "next/link";

import { AdminCard, AdminFrame, AdminShell, param } from "@/components/admin/admin-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AUDIT_ACTIONS, auditActionLabel, auditDetails, isAuditAction, readDay, readHandle } from "@/features/admin/form";
import { type AuditFilters, getAuditEvents, requireAdminSection } from "@/features/admin/queries";
import { UUID } from "@/features/collection/uuid";

export const metadata: Metadata = {
  title: "Audit log",
};

const selectClass =
  "h-10 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring md:text-sm dark:bg-input/30";
const DAY = 24 * 60 * 60 * 1000;
const OUTCOMES: Record<string, string> = { succeeded: "Done", refused: "Refused", operator: "Operator" };

function when(at: string): string {
  return new Date(at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

async function AuditView({ searchParams }: { searchParams: PageProps<"/admin/audit">["searchParams"] }) {
  const search = await searchParams;
  const { access } = await requireAdminSection("/admin/audit", "admin");

  // Every filter is checked here and again by the database; anything unreadable is dropped.
  const action = param(search.action);
  const actor = param(search.actor);
  const target = param(search.target);
  const from = param(search.from);
  const to = param(search.to);
  const before = param(search.before);
  const fromDay = from ? readDay(from) : null;
  const toDay = to ? readDay(to) : null;
  const invalid =
    (action !== null && !isAuditAction(action)) ||
    (actor !== null && !readHandle(actor)) ||
    (target !== null && !readHandle(target)) ||
    (from !== null && !fromDay) ||
    (to !== null && !toDay) ||
    (before !== null && !UUID.test(before));
  const filters: AuditFilters = {
    action: action && isAuditAction(action) ? action : null,
    actor: actor ? readHandle(actor) : null,
    target: target ? readHandle(target) : null,
    since: fromDay ? fromDay.toISOString() : null,
    until: toDay ? new Date(toDay.getTime() + DAY).toISOString() : null,
    before: before && UUID.test(before) ? before : null,
  };
  const outcome = invalid ? null : await getAuditEvents(filters);
  const query = new URLSearchParams();
  if (filters.action) query.set("action", filters.action);
  if (filters.actor) query.set("actor", filters.actor);
  if (filters.target) query.set("target", filters.target);
  if (from && fromDay) query.set("from", from);
  if (to && toDay) query.set("to", to);
  const events = outcome && "events" in outcome ? outcome.events : null;
  const last = events && events.length === 50 ? events[events.length - 1].id : null;

  return (
    <AdminFrame access={access} current="audit" title="Audit log">
      <AdminCard id="audit-filters" title="Filter">
        <form method="get" action="/admin/audit" className="grid gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="audit-action" className="text-sm font-medium">
              Action
            </label>
            <select id="audit-action" name="action" defaultValue={filters.action ?? ""} className={selectClass}>
              <option value="">Any action</option>
              {AUDIT_ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="audit-actor" className="text-sm font-medium">
              By handle
            </label>
            <Input id="audit-actor" name="actor" maxLength={25} defaultValue={filters.actor ?? ""} autoComplete="off" spellCheck={false} className="h-10" />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="audit-target" className="text-sm font-medium">
              About handle
            </label>
            <Input id="audit-target" name="target" maxLength={25} defaultValue={filters.target ?? ""} autoComplete="off" spellCheck={false} className="h-10" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="audit-from" className="text-sm font-medium">
                From
              </label>
              <Input id="audit-from" name="from" type="date" defaultValue={fromDay ? from ?? "" : ""} className="h-10" />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="audit-to" className="text-sm font-medium">
                To
              </label>
              <Input id="audit-to" name="to" type="date" defaultValue={toDay ? to ?? "" : ""} className="h-10" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" variant="secondary" size="lg" className="h-10 px-4">
              Show
            </Button>
            <Button asChild variant="ghost" size="lg" className="h-10 px-4">
              <Link href="/admin/audit">Clear</Link>
            </Button>
          </div>
        </form>
      </AdminCard>
      <div role="alert" aria-live="assertive">
        {invalid || (outcome && "error" in outcome && outcome.error === "invalid_filter") ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            Check the filters: an action from the list, handles of 3 to 24 letters, numbers or underscores, and a range of at most a year.
          </p>
        ) : null}
      </div>
      {outcome && "error" in outcome && outcome.error !== "invalid_filter" ? <p className="text-sm text-muted-foreground">The audit log isn&apos;t available right now. Try again later.</p> : null}
      {events ? (
        <section aria-labelledby="audit-events">
          <h2 id="audit-events" className="sr-only">
            Audit events, newest first
          </h2>
          {events.length ? (
            <ol className="flex flex-col gap-2">
              {events.map((e) => {
                const details = auditDetails(e.metadata);
                return (
                  <li key={e.id} className="rounded-lg border bg-card p-3 text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{auditActionLabel(e.action)}</span>
                      <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{OUTCOMES[e.outcome] ?? e.outcome}</span>
                      <span className="text-xs text-muted-foreground">{when(e.occurred_at)}</span>
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      By {e.actor_handle ? `@${e.actor_handle}` : e.actor_id ? "an account without a handle" : "an operator or the system"}
                      {e.target_handle ? ` · about @${e.target_handle}` : e.target_profile_id ? " · about an account without a handle" : ""}
                    </p>
                    <p className="mt-1 wrap-break-word">{e.reason}</p>
                    {details.length ? (
                      <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {details.map((d) => (
                          <div key={d.label} className="flex gap-1">
                            <dt>{d.label}:</dt>
                            <dd>{d.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">No events match.</p>
          )}
          {before || last ? (
            <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
              {before ? (
                <Button asChild variant="ghost" size="lg">
                  <Link href={`/admin/audit${query.size ? `?${query}` : ""}`}>Newest</Link>
                </Button>
              ) : (
                <span />
              )}
              {last ? (
                <Button asChild variant="secondary" size="lg">
                  <Link href={`/admin/audit?${new URLSearchParams([...query, ["before", last]])}`}>Older</Link>
                </Button>
              ) : null}
            </nav>
          ) : null}
        </section>
      ) : null}
    </AdminFrame>
  );
}

export default function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  return (
    <AdminShell>
      <AuditView searchParams={searchParams} />
    </AdminShell>
  );
}
