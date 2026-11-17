import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { Cell, DataTable, StatusPill, SubNav, when } from "@/components/admin/data-table";
import { Facts, RecordSection } from "@/components/admin/records";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { requireAdminSection } from "@/features/admin/queries";
import { UUID } from "@/features/collection/uuid";
import { RECORD_STATUSES, readPosition, readRecordStatus, recordStatusLabel, reportKeyLabel, runStatusLabel, runTone, shortHash, statLabel } from "@/features/imports/form";
import { getImportRun, getImportRunRecords } from "@/features/imports/queries";

export const metadata: Metadata = {
  title: "Import run",
};

const num = (v: unknown) => (typeof v === "number" ? v : null);
const counts = (v: unknown): [string, number][] =>
  v && typeof v === "object" ? Object.entries(v as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === "number").sort((a, b) => a[0].localeCompare(b[0])) : [];
const MISSING: Record<string, string> = {
  region: "Region unknown",
  product_code: "No serial",
  languages: "No languages",
  edition: "No edition",
  media_count: "No medium count",
  packaging: "No packaging",
  release_date: "No release date",
};

function CountList({ label, rows }: { label: string; rows: [string, number][] }) {
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      <ul className="flex flex-col gap-0.5 text-sm">
        {rows.map(([k, n]) => (
          <li key={k} className="flex justify-between gap-3">
            <span className="min-w-0 break-words">{k}</span>
            <span className="tabular-nums">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function RunView({ params, searchParams }: { params: PageProps<"/admin/imports/runs/[id]">["params"]; searchParams: PageProps<"/admin/imports/runs/[id]">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  const valid = UUID.test(id);
  // Administrators only (D8).
  const { access } = await requireAdminSection(valid ? `/admin/imports/runs/${id}` : "/admin/imports", "admin");
  if (!valid) notFound();
  const rawStatus = param(search.status);
  const rawAfter = param(search.after);
  const status = readRecordStatus(rawStatus);
  const after = readPosition(rawAfter);
  const detail = await getImportRun(id);
  if (detail === null) notFound();
  if ("error" in detail) {
    return (
      <AdminFrame access={access} current="imports" title="Import run">
        <EmptyState icon={PlugZap} title="The run isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      </AdminFrame>
    );
  }
  const invalid = (rawStatus !== null && !status) || (rawAfter !== null && after === null);
  const records = invalid ? null : await getImportRunRecords(id, status, after);
  const r = detail.run;
  const report = detail.report;
  const base = `/admin/imports/runs/${id}`;
  const recordList = records && !("error" in records) ? records : null;
  const next = recordList && recordList.length === 50 ? recordList[recordList.length - 1].position : null;
  const filterHref = (value: string | null) => (value ? `${base}?status=${value}#run-records` : `${base}#run-records`);
  const missing = report.releases_missing && typeof report.releases_missing === "object" ? (report.releases_missing as Record<string, unknown>) : {};

  return (
    <AdminFrame access={access} current="imports" title={`${r.provider_name ?? r.provider_code} import`}>
      <p className="text-sm">
        <Link href="/admin/imports" className={linkClass}>
          All imports
        </Link>
      </p>
      <RecordSection id="run-summary" title="Run">
        <p className="mb-3">
          <StatusPill tone={runTone(r)}>{r.status === "running" && !r.lease_live ? "Running, lease expired" : runStatusLabel(r.status)}</StatusPill>
        </p>
        <Facts
          rows={[
            { label: "Source", value: `${r.provider_name ?? r.provider_code} (${r.provider_code})` },
            { label: "Platform", value: r.platform?.name ?? "Any" },
            { label: "Snapshot", value: <span className="break-all">{r.source_name}</span> },
            { label: "Snapshot hash", value: <code title={r.source_sha256} className="font-mono text-xs">{shortHash(r.source_sha256)}</code> },
            { label: "Snapshot fetched", value: when(r.source_fetched_at) },
            { label: "Terms cited", value: r.terms_sha256 ? <code title={r.terms_sha256} className="font-mono text-xs">{shortHash(r.terms_sha256)}</code> : "None" },
            { label: "Operator's reason", value: r.reason },
            { label: "Started", value: when(r.started_at) },
            { label: "Finished", value: when(r.finished_at) ?? "Not yet" },
            { label: "Lease", value: r.status === "running" ? (r.lease_live ? `Held until ${when(r.lease_expires_at)}` : "Expired: the run can be resumed by the operator") : null },
          ]}
        />
      </RecordSection>
      <RecordSection id="run-report" title="Results">
        <div className="grid gap-4 sm:grid-cols-2">
          <CountList
            label="Totals"
            rows={(
              [
                ["Source entries", num(report.source_records)],
                ["Games created", num(report.games_created)],
                ["Releases created", num(report.releases_created)],
                ["Waiting for review", detail.needs_review],
                ["Failed", detail.failed],
                ["Possible duplicates", num(report.possible_duplicates)],
                ["Shared serials", num(report.shared_serials)],
                ["Suggested by main title", num(report.suggested)],
                ["Matched ignoring word breaks", num(report.word_break_matches)],
                ["Candidates withdrawn", num(report.withdrawn)],
                ["Candidates queued for review", num(report.queued_for_review)],
                ["Created releases now published or verified", num(report.published_or_verified)],
              ] as [string, number | null][]
            ).filter((e): e is [string, number] => e[1] !== null)}
          />
          <CountList label="Staging" rows={Object.entries(r.stats).map(([k, n]) => [statLabel(k), n] as [string, number])} />
          <CountList label="By status" rows={counts(report.by_status).map(([k, n]) => [reportKeyLabel(k), n])} />
          <CountList label="By match tier" rows={counts(report.by_tier).map(([k, n]) => [reportKeyLabel(k), n])} />
          <CountList label="Ignored, by reason" rows={counts(report.ignored_reasons)} />
          <CountList label="Held, by reason" rows={counts(report.held_reasons)} />
          <CountList
            label="Created releases missing a detail"
            rows={Object.entries(MISSING)
              .map(([k, label]) => [label, num(missing[k])] as [string, number | null])
              .filter((e): e is [string, number] => e[1] !== null && e[1] > 0)}
          />
        </div>
      </RecordSection>
      <RecordSection id="run-reclassifications" title="Reclassifications">
        {detail.reclassifications.length ? (
          <>
            <DataTable id="reclassifications-table" caption="Candidates this run reconsidered" head={["Release", "Outcome", "Reason", "Resolution"]}>
              {detail.reclassifications.map((c) => (
                <tr key={c.id}>
                  <Cell header>
                    <Link href={`/admin/catalog/releases/${c.release_id}`} className={linkClass}>
                      Release record
                    </Link>
                  </Cell>
                  <Cell>
                    {c.action === "withdrawn" ? (
                      <StatusPill>Withdrawn</StatusPill>
                    ) : c.resolved_at ? (
                      <StatusPill tone="good">Resolved</StatusPill>
                    ) : (
                      <StatusPill tone="warning">Waiting in the queue</StatusPill>
                    )}
                  </Cell>
                  <Cell className="break-words">{c.reason}</Cell>
                  <Cell className="break-words">{c.resolution ? `${c.resolution} (${when(c.resolved_at)})` : "—"}</Cell>
                </tr>
              ))}
            </DataTable>
            {detail.reclassifications_total > detail.reclassifications.length ? (
              <p className="mt-2 text-sm text-muted-foreground">
                The first {detail.reclassifications.length} of {detail.reclassifications_total}.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">This run reconsidered no earlier candidate.</p>
        )}
      </RecordSection>
      <RecordSection id="run-records" title="Staged entries">
        <p className="mb-3 text-sm text-muted-foreground">Each entry as the source stated it, in source order, and what the import did with it.</p>
        <SubNav
          label="Filter staged entries"
          current={filterHref(status)}
          items={[{ href: filterHref(null), label: "All" }, ...RECORD_STATUSES.map((s) => ({ href: filterHref(s.value), label: s.label }))]}
        />
        <div role="alert" aria-live="assertive" className="mt-3">
          {invalid ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">Check the filter: a status from the list.</p> : null}
        </div>
        {records && "error" in records ? (
          <p className="text-sm text-muted-foreground">The entries can&apos;t be loaded right now. Try again later.</p>
        ) : recordList && !recordList.length ? (
          <p className="text-sm text-muted-foreground">{status || after !== null ? "No entry matches." : "This run staged no entries."}</p>
        ) : recordList ? (
          <div className="mt-3 flex flex-col gap-3">
            <DataTable id="records-table" caption="Staged entries, in source order" head={["#", "Entry", "Status", "Notes", "Result"]}>
              {recordList.map((e) => (
                <tr key={e.id}>
                  <Cell className="tabular-nums">{e.position}</Cell>
                  <Cell header>
                    {e.title ?? "Untitled"}
                    <span className="block text-xs font-normal break-all text-muted-foreground">
                      {e.entity_type === "game" ? "Game" : "Release"} · <code className="font-mono">{e.external_id}</code>
                    </span>
                  </Cell>
                  <Cell>
                    <StatusPill tone={e.status === "failed" ? "problem" : e.status === "needs_review" ? "warning" : "neutral"}>{recordStatusLabel(e.status)}</StatusPill>
                    {e.match_tier ? <span className="block text-xs text-muted-foreground">Tier {e.match_tier}</span> : null}
                  </Cell>
                  <Cell className="break-words">
                    {[
                      // The importer's error message is a database diagnostic, so it isn't shown:
                      // the operator's log has it (M10e).
                      e.status === "failed" ? "Couldn't be applied; the importer's log has the detail" : null,
                      e.review_reason ? `Held: ${e.review_reason}` : null,
                      e.ignored ? `Ignored: ${e.ignored}` : null,
                      e.possible_duplicate ? "Possible duplicate" : null,
                      e.shared_serial ? "Shared serial" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </Cell>
                  <Cell>
                    {e.matched_release_id ? (
                      <Link href={`/admin/catalog/releases/${e.matched_release_id}`} className={linkClass}>
                        Release
                      </Link>
                    ) : e.matched_game_id ? (
                      <Link href={`/admin/catalog/games/${e.matched_game_id}`} className={linkClass}>
                        Game
                      </Link>
                    ) : (
                      "—"
                    )}
                  </Cell>
                </tr>
              ))}
            </DataTable>
            {after !== null || next !== null ? (
              <nav aria-label="Pages of entries" className="flex flex-wrap items-center justify-between gap-2">
                {after !== null ? (
                  <Button asChild variant="ghost" size="lg">
                    <Link href={filterHref(status)}>First entries</Link>
                  </Button>
                ) : (
                  <span />
                )}
                {next !== null ? (
                  <Button asChild variant="secondary" size="lg">
                    <Link href={`${base}?${new URLSearchParams([...(status ? [["status", status]] : []), ["after", String(next)]])}#run-records`}>Next entries</Link>
                  </Button>
                ) : null}
              </nav>
            ) : null}
          </div>
        ) : null}
      </RecordSection>
    </AdminFrame>
  );
}

export default function RunPage({ params, searchParams }: PageProps<"/admin/imports/runs/[id]">) {
  return (
    <AdminShell>
      <RunView params={params} searchParams={searchParams} />
    </AdminShell>
  );
}
