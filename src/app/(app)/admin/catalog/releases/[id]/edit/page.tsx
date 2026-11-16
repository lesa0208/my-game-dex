import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { PieceRows, ReleaseInputs, RequirementRows } from "@/components/admin/edit-fields";
import { EditForm, ReasonField } from "@/components/admin/edit-form";
import { RecordSection, StatusBadge } from "@/components/admin/records";
import { editable, EditNotice, StepUpNotice } from "@/components/admin/review-panel";
import { Field, selectClassName } from "@/components/collection/copy-fields";
import { EmptyState } from "@/components/shared/empty-state";
import { Input } from "@/components/ui/input";
import { requireAdminSection } from "@/features/admin/queries";
import { UUID } from "@/features/collection/uuid";
import {
  editRelease,
  editReleaseFromForm,
  setLock,
  setLockFromForm,
  setMarkets,
  setMarketsFromForm,
  setPieces,
  setPiecesFromForm,
  setRequirements,
  setRequirementsFromForm,
} from "@/features/editing/actions";
import { LOCKABLE_FIELDS, needsRecentVerification } from "@/features/editing/form";
import { getEditingOptions } from "@/features/editing/queries";
import { recordFieldLabel } from "@/features/records/form";
import { getReleaseRecord } from "@/features/records/queries";
import { piecesEditable } from "@/features/review/form";

export const metadata: Metadata = {
  title: "Edit release",
};

function Hidden({ id, revision }: { id: string; revision: number }) {
  return (
    <>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="revision" value={revision} />
    </>
  );
}

async function EditReleaseView({ params, searchParams }: { params: PageProps<"/admin/catalog/releases/[id]/edit">["params"]; searchParams: PageProps<"/admin/catalog/releases/[id]/edit">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  const path = UUID.test(id) ? `/admin/catalog/releases/${id}/edit` : "/admin/catalog/search";
  const { access } = await requireAdminSection(path, "editor");
  const [outcome, options] = await Promise.all([getReleaseRecord(id), getEditingOptions()]);
  if (!outcome.ok || !options) {
    if (!outcome.ok && outcome.reason === "refused") notFound();
    return (
      <AdminFrame access={access} current="catalog" title="Edit release">
        <EmptyState icon={PlugZap} title="This record isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      </AdminFrame>
    );
  }
  const r = outcome.data;
  if (!r) notFound();
  const record = `/admin/catalog/releases/${r.id}`;
  // D3: changing a published release needs a recent TOTP verification, asked for first.
  const gated = needsRecentVerification("edit", r.status) && !access.recentMfa;
  const hardware = options.requirements.filter((h) => h.platform === r.platform?.slug);
  const locked = new Set(r.field_locks.map((l) => l.field));
  const label = [r.game?.title, r.platform?.short_name, r.region?.code === "unknown" ? "Region unknown" : r.region?.label, r.edition?.name].filter(Boolean).join(" · ");

  return (
    <AdminFrame access={access} current="catalog" title={`Edit ${label || "release"}`} titleId="edit-release-heading">
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          <Link href={record} className={linkClass}>
            Back to the release record
          </Link>
        </p>
        <EditNotice notice={param(search.notice)} />
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge status={r.status} />
          {r.status === "published"
            ? "Published: changes are public at once, and need a recent verification."
            : r.verified_at
              ? "Verified. Any change ends the verification, and the release is verified again as it then is."
              : "Not verified yet."}
        </p>

        {!editable(r.status) ? (
          <p className="rounded-lg border px-4 py-3 text-sm">A release in this state can&apos;t be changed.</p>
        ) : (
          <>
            {gated ? (
              <StepUpNotice path={path}>Changing a published release needs a recent verification.</StepUpNotice>
            ) : (
              <>
            <RecordSection id="edit-release-details" title="Physical details">
              <p className="mb-3 text-sm text-muted-foreground">
                {r.platform?.name} · {r.format?.name}. The platform and format identify the release, so they aren&apos;t changed here.
              </p>
              <EditForm id="edit-release" recordId={r.id} action={editRelease} plain={editReleaseFromForm} submit="Save the details" pending="Saving…">
                <Hidden id={r.id} revision={r.revision} />
                <ReleaseInputs
                  id="edit-release"
                  release={{
                    edition_name: r.edition?.name ?? null,
                    edition_kind: r.edition?.kind ?? null,
                    variant_name: r.variant_name,
                    product_code: r.identifiers.product_code,
                    barcode: r.identifiers.barcode,
                    local_title: r.local_title,
                    publisher_name: r.publisher_name,
                    media_count: r.media_count,
                    packaging: r.packaging,
                    region_code: r.region?.code ?? "unknown",
                    region_unknown_confirmed: r.region_unknown_confirmed,
                    release_date: r.release_date?.value ?? null,
                    release_date_precision: r.release_date?.precision ?? "unknown",
                  }}
                  regions={options.regions}
                />
                <ReasonField id="edit-release" />
              </EditForm>
            </RecordSection>

            <RecordSection id="edit-release-pieces" title="In the box">
              {piecesEditable(r.components) ? (
                <EditForm id="set-pieces" recordId={r.id} action={setPieces} plain={setPiecesFromForm} submit="Save the pieces" pending="Saving…">
                  <Hidden id={r.id} revision={r.revision} />
                  <PieceRows id="set-pieces" pieces={r.components} />
                  <ReasonField id="set-pieces" />
                </EditForm>
              ) : (
                <p className="text-sm text-muted-foreground">This release lists pieces this form can&apos;t show, so they aren&apos;t changed here.</p>
              )}
            </RecordSection>

            <RecordSection id="edit-release-markets" title="Sold in">
              <EditForm id="set-markets" recordId={r.id} action={setMarkets} plain={setMarketsFromForm} submit="Save the markets" pending="Saving…">
                <Hidden id={r.id} revision={r.revision} />
                <Field id="set-markets-codes" label="Market codes" hint="Two-letter codes, separated by commas, such as US, CA. Empty means none are known.">
                  <Input
                    id="set-markets-codes"
                    name="markets"
                    maxLength={1000}
                    defaultValue={r.markets.map((m) => m.code).join(", ")}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="set-markets-codes-hint"
                    className="h-10 font-mono"
                  />
                </Field>
                <ReasonField id="set-markets" />
              </EditForm>
            </RecordSection>

            <RecordSection id="edit-release-hardware" title="Hardware">
              {hardware.length ? (
                <EditForm id="set-hardware" recordId={r.id} action={setRequirements} plain={setRequirementsFromForm} submit="Save the hardware" pending="Saving…">
                  <Hidden id={r.id} revision={r.revision} />
                  <RequirementRows id="set-hardware" current={r.requirements} choices={hardware} />
                  <ReasonField id="set-hardware" />
                </EditForm>
              ) : (
                <p className="text-sm text-muted-foreground">No hardware is listed for this release&apos;s platform.</p>
              )}
            </RecordSection>
              </>
            )}

            <RecordSection id="edit-release-locks" title="Locks against imports">
              <p className="mb-3 text-sm text-muted-foreground">
                {locked.size ? `Locked: ${[...locked].map(recordFieldLabel).join(", ")}.` : "No field is locked."} A locked field keeps its value when an import has another.
              </p>
              <EditForm id="set-release-lock" recordId={r.id} action={setLock} plain={setLockFromForm} submit="Save the lock" pending="Saving…">
                <Hidden id={r.id} revision={r.revision} />
                <input type="hidden" name="entity" value="release" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="set-release-lock-field" label="Field">
                    <select id="set-release-lock-field" name="field" className={selectClassName}>
                      {LOCKABLE_FIELDS.release.map((f) => (
                        <option key={f} value={f}>
                          {recordFieldLabel(f)}
                          {locked.has(f) ? " (locked)" : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id="set-release-lock-locked" label="Lock">
                    <select id="set-release-lock-locked" name="locked" defaultValue="yes" className={selectClassName}>
                      <option value="yes">Lock it</option>
                      <option value="no">Unlock it</option>
                    </select>
                  </Field>
                </div>
                <ReasonField id="set-release-lock" />
              </EditForm>
            </RecordSection>
          </>
        )}
      </div>
    </AdminFrame>
  );
}

export default function EditReleasePage({ params, searchParams }: PageProps<"/admin/catalog/releases/[id]/edit">) {
  return (
    <AdminShell>
      <EditReleaseView params={params} searchParams={searchParams} />
    </AdminShell>
  );
}
