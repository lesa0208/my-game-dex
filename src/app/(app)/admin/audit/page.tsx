import type { Metadata } from "next";
import Link from "next/link";

import { AdminCard, AdminFrame, AdminShell, param } from "@/components/admin/admin-frame";
import { AuditEntryItem } from "@/components/admin/audit-entry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_OUTCOMES, isAuditAction, isAuditCategory, isAuditOutcome, readDay, readHandle } from "@/features/admin/form";
import { type AuditFilters, getAuditLog, requireAdminSection } from "@/features/admin/queries";
import { UUID } from "@/features/collection/uuid";
import { adminControl, adminDate, AdminField, adminHint, adminSelect, FieldGrid, FormActions } from "@/components/admin/form-controls";

export const metadata: Metadata = {
  title: "Audit log",
};

const DAY = 24 * 60 * 60 * 1000;

async function AuditView({ searchParams }: { searchParams: PageProps<"/admin/audit">["searchParams"] }) {
  const search = await searchParams;
  const { access } = await requireAdminSection("/admin/audit", "admin");

  // Every filter is checked here and again by the database; anything unreadable is refused.
  const action = param(search.action);
  const kind = param(search.kind);
  const outcomeFilter = param(search.outcome);
  const actor = param(search.actor);
  const target = param(search.target);
  const from = param(search.from);
  const to = param(search.to);
  const before = param(search.before);
  const fromDay = from ? readDay(from) : null;
  const toDay = to ? readDay(to) : null;
  const invalid =
    (action !== null && !isAuditAction(action)) ||
    (kind !== null && !isAuditCategory(kind)) ||
    (outcomeFilter !== null && !isAuditOutcome(outcomeFilter)) ||
    (actor !== null && !readHandle(actor)) ||
    (target !== null && !readHandle(target)) ||
    (from !== null && !fromDay) ||
    (to !== null && !toDay) ||
    (before !== null && !UUID.test(before));
  const filters: AuditFilters = {
    action: action && isAuditAction(action) ? action : null,
    category: kind && isAuditCategory(kind) ? kind : null,
    outcome: outcomeFilter && isAuditOutcome(outcomeFilter) ? outcomeFilter : null,
    actor: actor ? readHandle(actor) : null,
    target: target ? readHandle(target) : null,
    since: fromDay ? fromDay.toISOString() : null,
    until: toDay ? new Date(toDay.getTime() + DAY).toISOString() : null,
    before: before && UUID.test(before) ? before : null,
  };
  const outcome = invalid ? null : await getAuditLog(filters);
  const query = new URLSearchParams();
  if (filters.action) query.set("action", filters.action);
  if (filters.category) query.set("kind", filters.category);
  if (filters.outcome) query.set("outcome", filters.outcome);
  if (filters.actor) query.set("actor", filters.actor);
  if (filters.target) query.set("target", filters.target);
  if (from && fromDay) query.set("from", from);
  if (to && toDay) query.set("to", to);
  const events = outcome && "events" in outcome ? outcome.events : null;
  const last = events && events.length === 50 ? events[events.length - 1].id : null;
  const filtered = query.size > 0;

  return (
    <AdminFrame access={access} current="audit" title="Audit log">
      <p className="text-sm text-muted-foreground">
        Every staff and operator action, and every refused one, newest first. Read-only: nothing here can be changed or removed. Details are limited to plain values;
        account ids, fingerprints and anything else recorded stay out of the page.
      </p>
      <AdminCard id="audit-filters" title="Filter">
        <form method="get" action="/admin/audit" className="flex flex-col gap-4">
          <FieldGrid columns={3}>
            <AdminField id="audit-kind" label="Kind">
              <select id="audit-kind" name="kind" defaultValue={filters.category ?? ""} className={adminSelect}>
                <option value="">Any kind</option>
                {AUDIT_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </AdminField>
            <AdminField id="audit-action" label="Action">
              <select id="audit-action" name="action" defaultValue={filters.action ?? ""} className={adminSelect}>
                <option value="">Any action</option>
                {AUDIT_ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </AdminField>
            <AdminField id="audit-outcome" label="Outcome">
              <select id="audit-outcome" name="outcome" defaultValue={filters.outcome ?? ""} className={adminSelect}>
                <option value="">Any outcome</option>
                {AUDIT_OUTCOMES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </AdminField>
            <AdminField id="audit-actor" label="By handle">
              <Input id="audit-actor" name="actor" maxLength={25} defaultValue={filters.actor ?? ""} autoComplete="off" spellCheck={false} className={adminControl} />
            </AdminField>
            <AdminField id="audit-target" label="About handle">
              <Input id="audit-target" name="target" maxLength={25} defaultValue={filters.target ?? ""} autoComplete="off" spellCheck={false} className={adminControl} />
            </AdminField>
            {/* Tab moves between a date field's parts, so its ring follows focus-within (adminDate). */}
            <fieldset className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-1.5">
              <legend className="sr-only">Dates, in UTC, at most a year apart</legend>
              <AdminField id="audit-from" label="From">
                <Input id="audit-from" name="from" type="date" defaultValue={fromDay ? from ?? "" : ""} aria-describedby="audit-dates-hint" className={adminDate} />
              </AdminField>
              <AdminField id="audit-to" label="To">
                <Input id="audit-to" name="to" type="date" defaultValue={toDay ? to ?? "" : ""} aria-describedby="audit-dates-hint" className={adminDate} />
              </AdminField>
              <p id="audit-dates-hint" className={`col-span-2 ${adminHint}`}>
                In UTC, at most a year apart. One date alone covers the year after or before it.
              </p>
            </fieldset>
          </FieldGrid>
          <FormActions>
            <Button type="submit" variant="secondary" size="control">
              Show
            </Button>
            <Button asChild variant="ghost" size="control">
              <Link href="/admin/audit">Clear</Link>
            </Button>
          </FormActions>
        </form>
      </AdminCard>
      <div role="alert" aria-live="assertive" className="empty:-mt-5">
        {invalid || (outcome && "error" in outcome && outcome.error === "invalid_filter") ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            Check the filters: a kind, action and outcome from the lists, handles of 3 to 24 letters, numbers or underscores, and a range of at most a year.
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
              {events.map((e) => (
                <AuditEntryItem key={e.id} entry={e} auditLinks />
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">{filtered ? "No events match." : "Nothing has been recorded yet."}</p>
          )}
          {before || last ? (
            <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
              {before ? (
                <Button asChild variant="ghost" size="control">
                  <Link href={`/admin/audit${query.size ? `?${query}` : ""}`}>Newest</Link>
                </Button>
              ) : (
                <span />
              )}
              {last ? (
                <Button asChild variant="secondary" size="control">
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
