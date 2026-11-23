import { ShieldAlert } from "lucide-react";
import Link from "next/link";

import { linkClass } from "@/components/admin/admin-frame";
import { Callout } from "@/components/admin/batch-review";
import { EditForm } from "@/components/admin/edit-form";
import { adminControl, adminHint, AdminField, adminTextarea } from "@/components/admin/form-controls";
import { RecordSection } from "@/components/admin/records";
import { StepUpNotice } from "@/components/admin/review-panel";
import { Input } from "@/components/ui/input";
import { decideBatch, decideBatchFromForm } from "@/features/batches/actions";
import { APPROVE_BLOCKS, EFFECT_DETAILS, EFFECT_LABELS } from "@/features/batches/form";
import type { ApprovalEffect, ApprovalPreview, BatchOverview } from "@/features/batches/queries";

/**
 * Approving and rejecting a batch (M14c-3). The preview is the database's prediction of what an
 * approval by this editor would do now; approval rechecks everything when it runs and decides.
 * Both forms ask for a reason, the batch's first 8 characters and an acknowledgement, with
 * nothing preselected, and both need a recent authenticator check.
 */

const ORDER: ApprovalEffect[] = ["publish", "await_publication", "reviewer_gone", "confirm", "identity_only", "not_accepted", "pending"];

/** `eligible`: whether the viewer may approve. If not, the effects are those of an approval by someone who may. */
export function ApprovalPreviewView({ preview, eligible }: { preview: ApprovalPreview; eligible: boolean }) {
  const shown = ORDER.filter((e) => preview.counts[e] > 0);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        <span className="font-medium">
          {preview.approvals.recorded} of {preview.approvals.required} {preview.approvals.required === 1 ? "approval" : "approvals"} recorded.
        </span>{" "}
        {!eligible
          ? "You can't approve it (below). This is what the next approval would do."
          : preview.final
            ? "Your approval would be the final one: it is the approval that verifies, and publishes what can be published."
            : `Your approval would be recorded and the batch would stay open: nothing is verified or published until the ${preview.approvals.required === 2 ? "second" : "last"} approval.`}
      </p>
      <p className="text-xs text-muted-foreground">
        A prediction, as the database assesses it now. Approval checks everything again when it runs (your recent verification, every member&apos;s revision, the evidence, the
        right to publish, and who you are), and decides.
      </p>
      <ul aria-label="What approving would do" className="flex flex-col gap-2">
        {shown.map((e) => (
          <li key={e} className="rounded-lg border p-3 text-sm">
            <p className="font-medium">
              {EFFECT_LABELS[e]}: <span className="tabular-nums">{preview.counts[e].toLocaleString("en")}</span>
            </p>
            <p className="text-muted-foreground">{EFFECT_DETAILS[e]}</p>
            {preview.members.some((m) => m.effect === e) ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-primary-text underline underline-offset-4">Which members</summary>
                <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                  {preview.members
                    .filter((m) => m.effect === e)
                    .map((m) => (
                      <li key={m.game.id}>
                        <Link href={`/admin/catalog/batches/${preview.batch.id}/members/${m.game.id}`} className={linkClass}>
                          {m.game.title}
                        </Link>
                        {m.evidence_missing ? <span className="text-destructive"> · no qualifying evidence note</span> : null}
                      </li>
                    ))}
                  {preview.counts[e] > preview.members.filter((m) => m.effect === e).length ? <li className="text-muted-foreground">… and more</li> : null}
                </ul>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-sm">
        <span className="font-medium">Right to publish:</span>{" "}
        {preview.sources.length
          ? preview.sources.map((s) => `${s.provider_name ?? s.provider} ${s.cleared ? "cleared" : "NOT cleared"}`).join("; ")
          : "no source would be published from"}
        .{preview.evidence_missing ? <span className="text-destructive"> {preview.evidence_missing.toLocaleString("en")} found correct without qualifying evidence.</span> : null}
      </p>
      <p className="text-xs text-muted-foreground">No approval creates, verifies or publishes a physical release: no edition, region, format, box, cartridge, disc or product code.</p>
    </div>
  );
}

function ConfirmFields({ id, batchId, acknowledge }: { id: string; batchId: string; acknowledge: string }) {
  return (
    <>
      <AdminField id={`${id}-reason`} label="Reason, for the record" hint="Kept in the audit log. Visible to other catalog staff.">
        <textarea id={`${id}-reason`} name="reason" required maxLength={500} rows={2} autoComplete="off" aria-describedby={`${id}-reason-hint`} className={adminTextarea} />
      </AdminField>
      <AdminField id={`${id}-confirm-id`} label={`Type the batch's first 8 characters (${batchId.slice(0, 8)}) to confirm`}>
        <Input
          id={`${id}-confirm-id`}
          name="confirm_id"
          required
          maxLength={8}
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          pattern={batchId.slice(0, 8)}
          className={`${adminControl} max-w-48 font-mono`}
        />
      </AdminField>
      <div className="flex gap-3 rounded-lg border bg-muted/40 p-3">
        <input id={`${id}-acknowledge`} name="acknowledge" type="checkbox" required className="mt-0.5 size-5 shrink-0 accent-primary-solid" />
        <label htmlFor={`${id}-acknowledge`} className="text-sm">
          {acknowledge}
        </label>
      </div>
    </>
  );
}

export function BatchDecisions({ overview, preview, recentMfa, path }: { overview: BatchOverview; preview: ApprovalPreview | null; recentMfa: boolean; path: string }) {
  if (overview.status !== "open") return null;
  const hidden = (decision: "approve" | "reject") => (
    <>
      <input type="hidden" name="batch_id" value={overview.id} />
      <input type="hidden" name="decision" value={decision} />
      {/* For an approval, the count the preview above was computed from: what the editor was told. */}
      <input type="hidden" name="seen_approvals" value={decision === "approve" && preview ? preview.approvals.recorded : overview.approvals.recorded} />
      <input type="hidden" name="seen_recorded" value={overview.counts.recorded} />
    </>
  );
  const blocked = overview.blockers.length > 0;
  return (
    <>
      <RecordSection id="approve" title="Approve the batch">
        <div className="flex flex-col gap-4">
          {preview ? <ApprovalPreviewView preview={preview} eligible={!overview.you.approve} /> : null}
          {!preview ? (
            // Never an approval form without its preview: the editor must see what it would do.
            <Callout tone="warning">What approving would do can&apos;t be loaded right now, so it can&apos;t be approved from this page. Reload it.</Callout>
          ) : overview.you.approve ? (
            <p className="text-sm">{APPROVE_BLOCKS[overview.you.approve]}</p>
          ) : blocked ? (
            <Callout tone="warning">The database would refuse an approval now (see Approval readiness above), so no approval form is shown.</Callout>
          ) : !recentMfa ? (
            <StepUpNotice path={path}>Approving needs a recent verification.</StepUpNotice>
          ) : (
            <EditForm id="approve-batch" recordId={overview.id} action={decideBatch} plain={decideBatchFromForm} submit={!preview.final ? "Record my approval" : preview.counts.publish > 0 ? "Approve and publish" : "Approve"} pending="Approving…" variant="default">
              {hidden("approve")}
              <ConfirmFields
                id="approve-batch"
                batchId={overview.id}
                acknowledge={
                  preview.final
                    ? "I have read what this approval does. It is final: the members above are verified, and published where shown, once the database checks them again."
                    : "I have read what this approval does. It records my approval; the batch stays open for the next approver."
                }
              />
            </EditForm>
          )}
        </div>
      </RecordSection>

      <section aria-labelledby="reject-title" className="scroll-mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <h2 id="reject-title" className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert aria-hidden="true" className="size-4" />
          Reject the batch
        </h2>
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Rejection is final for this batch: it is closed and can&apos;t be approved, reviewed or reopened. Its outcomes, approvals and audit history are kept, and nothing is
            deleted: its games and source records stay as they are, unpublished. Its members can join a new batch only after a real change (an audited edit or a new source
            record); a new sample alone never brings them back.
          </p>
          {!recentMfa ? (
            <StepUpNotice path={path}>Rejecting needs a recent verification.</StepUpNotice>
          ) : (
            <EditForm id="reject-batch" recordId={overview.id} action={decideBatch} plain={decideBatchFromForm} submit="Reject the batch" pending="Rejecting…" variant="destructive">
              {hidden("reject")}
              <ConfirmFields id="reject-batch" batchId={overview.id} acknowledge="I understand that rejecting is final for this batch, and that nothing in it is published." />
            </EditForm>
          )}
          <p className={adminHint}>Any catalog editor may reject an open batch, including after an approval was recorded.</p>
        </div>
      </section>
    </>
  );
}
