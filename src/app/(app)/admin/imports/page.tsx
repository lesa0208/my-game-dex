import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AdminCard, AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { Cell, DataTable, StatusPill, when } from "@/components/admin/data-table";
import { Facts } from "@/components/admin/records";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { requireAdminSection } from "@/features/admin/queries";
import { RUN_STATUSES, readId, readProvider, readRunStatus, runStatusLabel, runTone, shortHash } from "@/features/imports/form";
import { getImportProviders, getImportRuns } from "@/features/imports/queries";
import { adminSelect } from "@/components/admin/form-controls";

export const metadata: Metadata = {
  title: "Imports",
};

async function ImportsView({ searchParams }: { searchParams: PageProps<"/admin/imports">["searchParams"] }) {
  const search = await searchParams;
  // Administrators only (D8); staff signed in without their authenticator verify first.
  const { access } = await requireAdminSection("/admin/imports", "admin");
  const rawProvider = param(search.provider);
  const rawStatus = param(search.status);
  const rawBefore = param(search.before);
  const provider = readProvider(rawProvider);
  const status = readRunStatus(rawStatus);
  const before = readId(rawBefore);
  const invalid = (rawProvider !== null && !provider) || (rawStatus !== null && !status) || (rawBefore !== null && !before);
  const [providers, runs] = await Promise.all([getImportProviders(), invalid ? null : getImportRuns({ provider, status, before })]);
  const query = new URLSearchParams();
  if (provider) query.set("provider", provider);
  if (status) query.set("status", status);
  const runList = runs && !("error" in runs) ? runs : null;
  const last = runList && runList.length === 25 ? runList[runList.length - 1].id : null;

  return (
    <AdminFrame access={access} current="imports" title="Imports">
      <p className="text-sm text-muted-foreground">
        What the catalog importer has done, read-only. An operator runs imports from the command line, as the restricted importer role, and only from cleared
        sources. Nothing here starts, changes or stops an import, and an import never verifies or publishes anything. Import items that need an editor are in
        the{" "}
        <Link href="/admin/catalog/reclassifications" className={linkClass}>
          reclassification queue
        </Link>
        .
      </p>
      <section aria-labelledby="providers-heading" className="flex flex-col gap-3">
        <h2 id="providers-heading" className="text-sm font-semibold">
          Sources
        </h2>
        {"error" in providers ? (
          <p className="text-sm text-muted-foreground">The sources can&apos;t be loaded right now. Try again later.</p>
        ) : !providers.length ? (
          <p className="text-sm text-muted-foreground">No source is recorded.</p>
        ) : (
          <div className="grid items-start gap-4 sm:grid-cols-2">
            {providers.map((p) => (
              <AdminCard key={p.code} id={`provider-${p.code}`} title={p.name}>
                <p className="mb-3">
                  {p.commercial_use_cleared ? <StatusPill tone="good">Cleared for use</StatusPill> : <StatusPill tone="warning">Not cleared: imports refused</StatusPill>}
                </p>
                <Facts
                  rows={[
                    { label: "Code", value: <code className="font-mono text-xs">{p.code}</code> },
                    {
                      label: "Terms",
                      value: p.terms_url ? (
                        <a href={p.terms_url} rel="noreferrer noopener" target="_blank" className={`${linkClass} break-all`}>
                          {p.terms_url}
                        </a>
                      ) : (
                        "Not recorded"
                      ),
                    },
                    { label: "Terms reviewed", value: when(p.terms_reviewed_at) ?? "Never" },
                    { label: "Reviewed copy", value: p.terms_sha256 ? <code title={p.terms_sha256} className="font-mono text-xs">{shortHash(p.terms_sha256)}</code> : null },
                    { label: "Clearance note", value: p.cleared_note },
                    { label: "Runs", value: `${p.runs}${p.runs_running ? `, ${p.runs_running} running` : ""}` },
                    { label: "Last run", value: when(p.last_run_at) ?? "Never" },
                    { label: "Source entries", value: p.source_records },
                  ]}
                />
              </AdminCard>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="runs-heading" className="flex flex-col gap-3">
        <h2 id="runs-heading" className="text-sm font-semibold">
          Runs, newest first
        </h2>
        <form method="get" action="/admin/imports" className="grid items-end gap-x-4 gap-y-4 rounded-xl border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:p-5">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="runs-provider" className="text-sm font-medium">
              Source
            </label>
            <select id="runs-provider" name="provider" defaultValue={provider ?? ""} className={adminSelect}>
              <option value="">Any source</option>
              {!("error" in providers)
                ? providers.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.name}
                    </option>
                  ))
                : null}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="runs-status" className="text-sm font-medium">
              Status
            </label>
            <select id="runs-status" name="status" defaultValue={status ?? ""} className={adminSelect}>
              <option value="">Any status</option>
              {RUN_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="secondary" size="control">
              Show
            </Button>
            <Button asChild variant="ghost" size="control">
              <Link href="/admin/imports">Clear</Link>
            </Button>
          </div>
        </form>
        <div role="alert" aria-live="assertive">
          {invalid || (runs && "error" in runs && runs.error === "invalid_filter") ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">Check the filters: a source and a status from the lists.</p>
          ) : null}
        </div>
        {runs && "error" in runs && runs.error !== "invalid_filter" ? (
          <EmptyState icon={PlugZap} title="Runs aren't available">
            They can&apos;t be loaded right now. Try again later.
          </EmptyState>
        ) : runList && !runList.length ? (
          <p className="text-sm text-muted-foreground">{provider || status || before ? "No run matches." : "No import has run yet."}</p>
        ) : runList ? (
          <>
            <DataTable id="runs-table" caption="Import runs, newest first" head={["Started", "Source", "Platform", "Status", "Snapshot", "Finished"]}>
              {runList.map((r) => (
                <tr key={r.id}>
                  <Cell header>
                    <Link href={`/admin/imports/runs/${r.id}`} className={linkClass}>
                      {when(r.started_at)}
                    </Link>
                  </Cell>
                  <Cell>{r.provider_name ?? r.provider_code}</Cell>
                  <Cell>{r.platform?.name ?? "—"}</Cell>
                  <Cell>
                    <StatusPill tone={runTone(r)}>{r.status === "running" && !r.lease_live ? "Running, lease expired" : runStatusLabel(r.status)}</StatusPill>
                  </Cell>
                  <Cell className="break-all">{r.source_name}</Cell>
                  <Cell>{when(r.finished_at) ?? "—"}</Cell>
                </tr>
              ))}
            </DataTable>
            {before || last ? (
              <nav aria-label="Pages of runs" className="flex flex-wrap items-center justify-between gap-2">
                {before ? (
                  <Button asChild variant="ghost" size="control">
                    <Link href={`/admin/imports${query.size ? `?${query}` : ""}`}>Newest</Link>
                  </Button>
                ) : (
                  <span />
                )}
                {last ? (
                  <Button asChild variant="secondary" size="control">
                    <Link href={`/admin/imports?${new URLSearchParams([...query, ["before", last]])}`}>Older</Link>
                  </Button>
                ) : null}
              </nav>
            ) : null}
          </>
        ) : null}
      </section>
    </AdminFrame>
  );
}

export default function ImportsPage({ searchParams }: PageProps<"/admin/imports">) {
  return (
    <AdminShell>
      <ImportsView searchParams={searchParams} />
    </AdminShell>
  );
}
