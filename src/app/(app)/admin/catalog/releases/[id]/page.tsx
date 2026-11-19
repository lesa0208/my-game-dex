import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { packagingStaffLabel } from "@/features/catalog/packaging";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { Facts, HistoryList, RecordSection, StatusBadge } from "@/components/admin/records";
import { EditNotice, ReviewPanel } from "@/components/admin/review-panel";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { requireAdminSection } from "@/features/admin/queries";
import { componentLabel, editionKindLabel, formatCatalogDate, languageName } from "@/features/catalog/format";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { exclusionReasonLabel } from "@/features/exclusion/form";
import { actorLabel, creationNote, recordFieldLabel, recordStatusLabel } from "@/features/records/form";
import { getRecordHistory, getReleaseRecord } from "@/features/records/queries";
import type { ReleaseSummary } from "@/features/records/queries";
import { requestStatusLabel } from "@/features/review/form";
import { formatWhen } from "@/features/submissions/display";

export const metadata: Metadata = {
  title: "Release record",
};

const MERGE_KINDS: Record<string, string> = { published: "a published duplicate", submission: "a submission", unpublished: "an unpublished record" };
const PLAYABILITY: Record<string, string> = { playable_from_media: "Plays from the disc or cartridge", download_required: "Needs a download to play" };
const LEVELS: Record<string, string> = { required: "Required", partial: "Works in part", not_compatible: "Not compatible", compatible: "Compatible" };

function summaryLine(r: ReleaseSummary) {
  const region = r.region ? (r.region.code === "unknown" ? "Region unknown" : r.region.label) : null;
  return [r.game?.title, r.platform?.short_name, region, r.edition_name, r.variant_name, r.product_code].filter(Boolean).join(" · ") || "Release";
}

async function ReleaseRecordView({ params, searchParams }: { params: PageProps<"/admin/catalog/releases/[id]">["params"]; searchParams: PageProps<"/admin/catalog/releases/[id]">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  // Catalog editors only (D8); staff signed in without their authenticator verify first.
  const { access } = await requireAdminSection(UUID.test(id) ? `/admin/catalog/releases/${id}` : "/admin/catalog/search", "editor");
  const before = param(search.before);
  const [outcome, history] = await Promise.all([getReleaseRecord(id), getRecordHistory("release", id, before)]);
  if (!outcome.ok) {
    if (outcome.reason === "refused") notFound();
    return (
      <AdminFrame access={access} current="catalog" title="Release record">
        <EmptyState icon={PlugZap} title="This record isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      </AdminFrame>
    );
  }
  const r = outcome.data;
  if (!r) notFound();
  const note = history.ok && history.data ? creationNote(history.data.items, "release") : null;
  const region = r.region
    ? r.region.code === "unknown"
      ? r.region_unknown_confirmed
        ? "Unknown, confirmed by an editor"
        : "Unknown, not confirmed"
      : r.region.label
    : null;
  const title = r.game?.title ?? "Release record";
  const editable = ["unverified", "under_review", "published"].includes(r.status);
  const path = `/admin/catalog/releases/${r.id}`;

  return (
    <AdminFrame access={access} current="catalog" title={title} titleId="release-record-title">
      <article aria-labelledby="release-record-title" className="flex flex-col gap-4">
        <p className="text-sm">
          <Link href="/admin/catalog/search?kind=releases" className={linkClass}>
            Catalog records
          </Link>
        </p>
        <EditNotice notice={param(search.notice)} />
        <header className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Release record · {[r.platform?.name, r.region?.code === "unknown" ? "Region unknown" : r.region?.label, r.format?.name].filter(Boolean).join(" · ")}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={r.status} />
            {r.verified_at ? `Verified ${formatDay(r.verified_at)}` : "Not verified"}
            {r.game ? (
              <Link href={`/admin/catalog/games/${r.game.id}`} className={linkClass}>
                Game record
              </Link>
            ) : null}
          </p>
          {r.merged_into ? (
            <p className="rounded-lg border px-4 py-3 text-sm">
              Merged into{" "}
              <Link href={`/admin/catalog/releases/${r.merged_into.id}`} className={linkClass}>
                {summaryLine(r.merged_into)}
              </Link>
              {r.merged_publicly ? ". Its old address leads there." : "."}
            </p>
          ) : null}
          {editable ? (
            <p className="flex flex-wrap gap-x-4 gap-y-3 text-sm">
              <Link href={`${path}/edit`} className={linkClass}>
                Edit the release
              </Link>
              <Link href={`/admin/catalog/merge/${r.id}`} className={linkClass}>
                Merge into another release
              </Link>
              <Link href={`/admin/catalog/exclude/${r.id}`} className={linkClass}>
                Exclude from the catalog
              </Link>
            </p>
          ) : null}
        </header>

        <ReviewPanel
          entity="release"
          id={r.id}
          status={r.status}
          revision={r.revision}
          verified={Boolean(r.verified_at)}
          review={r.review}
          submissions={r.submissions}
          recentMfa={access.recentMfa}
          admin={access.admin}
          path={path}
        />

        <RecordSection id="release-details" title="Physical release">
          <Facts
            label="Physical release"
            rows={[
              { label: "Game", value: r.game ? `${r.game.title} (${recordStatusLabel(r.game.status)})` : null },
              { label: "Platform", value: r.platform?.name ?? null },
              { label: "Platform pairing", value: r.pairing_status ? recordStatusLabel(r.pairing_status) : null },
              { label: "Region", value: region },
              { label: "Edition", value: r.edition?.name ?? "Not recorded" },
              { label: "Edition type", value: r.edition?.kind ? editionKindLabel(r.edition.kind) : "Not recorded" },
              { label: "Variant", value: r.variant_name },
              { label: "Physical format", value: r.format?.name ?? null },
              { label: "Discs or cartridges", value: r.media_count ? String(r.media_count) : "Not recorded" },
              { label: "Playability", value: r.media_playability ? (PLAYABILITY[r.media_playability] ?? r.media_playability) : null },
              { label: "Packaging", value: packagingStaffLabel(r.packaging_code, r.packaging) },
              { label: "Product code", value: r.identifiers.product_code },
              { label: "Barcode", value: r.identifiers.barcode },
              { label: "Title on the package", value: r.local_title },
              { label: "Publisher", value: r.publisher_name },
              { label: "Released", value: r.release_date ? formatCatalogDate(r.release_date) : null },
              { label: "Languages", value: r.languages?.length ? r.languages.map(languageName).join(", ") : null },
              { label: "Rating labels", value: r.rating_labels?.length ? r.rating_labels.join(", ") : null },
              { label: "Sold in", value: r.markets.length ? r.markets.map((m) => m.name).join(", ") : null },
              { label: "Revision", value: String(r.revision) },
              { label: "Added", value: formatWhen(r.created_at) },
              { label: "Last changed", value: formatWhen(r.updated_at) },
              { label: "Id", value: <code className="text-xs break-all">{r.id}</code> },
            ]}
          />
        </RecordSection>

        <RecordSection id="release-contents" title="In the box">
          {r.components.length ? (
            <ul className="flex flex-col gap-1.5 text-sm">
              {r.components.map((c) => (
                <li key={`${c.kind}-${c.label}`}>
                  {componentLabel(c)}
                  {c.format ? <span className="text-muted-foreground"> · {c.format}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing beyond the game itself is recorded.</p>
          )}
        </RecordSection>

        {r.requirements.length ? (
          <RecordSection id="release-requirements" title="Hardware">
            <ul className="flex flex-col gap-1.5 text-sm">
              {r.requirements.map((h) => (
                <li key={h.code}>
                  {h.label} <span className="text-muted-foreground">· {LEVELS[h.level] ?? h.level}</span>
                  {h.note ? <span className="block text-muted-foreground">{h.note}</span> : null}
                </li>
              ))}
            </ul>
          </RecordSection>
        ) : null}

        <RecordSection id="release-sources" title="Sources and locks">
          <Facts
            label="Sources and locks"
            rows={[
              {
                label: "External references",
                value: r.external_references.length ? r.external_references.map((x) => `${x.provider}: ${x.external_id}`).join(", ") : "None",
              },
              {
                // Structured: what an import recorded per field (release_evidence).
                label: "Structured source evidence",
                value: r.evidence.length
                  ? r.evidence.map((e) => `${recordFieldLabel(e.field)} from ${e.provider}${e.sources > 1 ? ` (${e.sources} entries)` : ""}`).join(", ")
                  : "None from an import",
              },
              {
                // M12c-A: the creating editor's reason, as written. Free text for the reviewer.
                label: "Editor's evidence note",
                value: note ? (
                  <>
                    <span className="break-words whitespace-pre-wrap">{note.reason}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Written by {actorLabel(note.actor)} when creating the release, {formatWhen(note.occurred_at)}. A note, not structured evidence: check it against the source
                      before verifying.
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">{before ? "On the first page of the history" : "None. See the history below"}</span>
                ),
              },
              {
                label: "Locked against imports",
                value: r.field_locks.length ? r.field_locks.map((l) => `${recordFieldLabel(l.field)} (${formatDay(l.locked_at)})`).join(", ") : "Nothing",
              },
            ]}
          />
        </RecordSection>

        {r.merges.length ? (
          <RecordSection id="release-merges" title="Merges">
            <ul className="flex flex-col gap-1.5 text-sm">
              {r.merges.map((m) => (
                <li key={m.id}>
                  <Link href={`/admin/catalog/merges/${m.id}`} className={linkClass}>
                    {m.role === "source" ? "Merged into" : "Merged here from"} {m.other ? summaryLine(m.other) : "another release"}
                  </Link>{" "}
                  <span className="text-muted-foreground">
                    · {MERGE_KINDS[m.kind] ?? m.kind}, {formatDay(m.merged_at)}
                  </span>
                </li>
              ))}
            </ul>
          </RecordSection>
        ) : null}

        {r.submissions.length ? (
          <RecordSection id="release-submissions" title="Submissions">
            <ul className="flex flex-col gap-1.5 text-sm">
              {r.submissions.map((s) => (
                <li key={s.id}>
                  <Link href={`/admin/catalog/${s.id}`} className={linkClass}>
                    {s.kind === "new_game" ? "New game" : "Missing release"}, {formatDay(s.created_at)}
                  </Link>{" "}
                  <span className="text-muted-foreground">· {requestStatusLabel(s.status)}</span>
                </li>
              ))}
            </ul>
          </RecordSection>
        ) : null}

        {r.exclusions?.length ? (
          <RecordSection id="release-exclusions" title="Exclusions">
            <ul className="flex flex-col gap-1.5 text-sm">
              {r.exclusions.map((x) => (
                <li key={x.id}>
                  <Link href={`/admin/catalog/exclusions/${x.id}`} className={linkClass}>
                    {exclusionReasonLabel(x.reason_code)}, {formatDay(x.excluded_at)}
                  </Link>{" "}
                  <span className="text-muted-foreground">· {x.restored_at ? `Restored ${formatDay(x.restored_at)}` : "In force"}</span>
                </li>
              ))}
            </ul>
          </RecordSection>
        ) : null}

        <RecordSection id="history" title="History">
          {!history.ok || !history.data ? (
            <p className="text-sm text-muted-foreground">The history can&apos;t be loaded right now.</p>
          ) : (
            <>
              <HistoryList history={history.data} recordId={r.id} admin={access.admin} />
              {before || history.data.next_before ? (
                <nav aria-label="History pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  {before ? (
                    <Button asChild variant="ghost" size="control">
                      <Link href={`/admin/catalog/releases/${r.id}#history`}>Latest</Link>
                    </Button>
                  ) : (
                    <span />
                  )}
                  {history.data.next_before ? (
                    <Button asChild variant="secondary" size="control">
                      <Link href={`/admin/catalog/releases/${r.id}?before=${history.data.next_before}#history`}>Older</Link>
                    </Button>
                  ) : null}
                </nav>
              ) : null}
            </>
          )}
        </RecordSection>
      </article>
    </AdminFrame>
  );
}

export default function ReleaseRecordPage({ params, searchParams }: PageProps<"/admin/catalog/releases/[id]">) {
  return (
    <AdminShell>
      <ReleaseRecordView params={params} searchParams={searchParams} />
    </AdminShell>
  );
}
