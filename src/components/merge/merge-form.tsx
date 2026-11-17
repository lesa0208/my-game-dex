"use client";

import { CircleAlert } from "lucide-react";
import { startTransition, useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mergeRelease, mergeReleaseFromForm, type MergeState } from "@/features/merge/actions";
import { fieldLabel, OWNER_NOTE_MAX, STAFF_REASON_MAX } from "@/features/merge/form";
import { AdminField as Field, adminControl, adminTextarea } from "@/components/admin/form-controls";

function keepOnFailure(action: (state: MergeState, formData: FormData) => Promise<MergeState>) {
  return async (state: MergeState, formData: FormData): Promise<MergeState> => {
    try {
      return await action(state, formData);
    } catch (error) {
      if (error && typeof error === "object" && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw error;
      return { status: "error", message: "We couldn't confirm it was saved. Check your connection and try again." };
    }
  };
}
const merge = keepOnFailure(mergeRelease);

function Acknowledge({ id, name, children }: { id: string; name: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <input id={id} name={name} type="checkbox" value="yes" required className="mt-0.5 size-5 shrink-0 accent-destructive" />
      <label htmlFor={id} className="text-sm">
        {children}
      </label>
    </div>
  );
}

/**
 * Merging a release (M7b-2c), for an editor who has read the preview. Every
 * difference is confirmed on its own, and moving copies too. The preview's token goes
 * with it, so the database refuses if anything it showed has changed, field values
 * included. Works without JavaScript: success redirects.
 */
export function MergeForm({
  sourceId,
  targetId,
  token,
  fields,
  copies,
  owners,
}: {
  sourceId: string;
  targetId: string;
  token: string;
  fields: { field: string; critical: boolean }[];
  copies: number;
  owners: number;
}) {
  const [state, action, pending] = useActionState(merge, { status: "idle", message: null });
  return (
    <form
      id="merge-release"
      action={mergeReleaseFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        startTransition(() => action(new FormData(event.currentTarget)));
      }}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="source_id" value={sourceId} />
      <input type="hidden" name="target_id" value={targetId} />
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="fields" value={fields.map((f) => f.field).join(",")} />
      <input type="hidden" name="needs_copies" value={copies ? "yes" : "no"} />
      <fieldset className="flex flex-col gap-3 rounded-lg border border-destructive/30 p-3">
        <legend className="px-1 text-sm font-medium">Confirm each difference</legend>
        {fields.length ? (
          fields.map((f) => (
            <Acknowledge key={f.field} id={`merge-ack-${f.field}`} name={`ack_${f.field}`}>
              {f.critical ? <span className="font-medium">Check carefully: </span> : null}
              {fieldLabel(f.field)} differs, as shown above. The release it&apos;s merged into keeps its own.
            </Acknowledge>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">Every compared field is the same.</p>
        )}
        {copies ? (
          <Acknowledge id="merge-ack-copies" name="acknowledge_copies">
            {copies === 1 ? "1 copy" : `${copies.toLocaleString("en")} copies`} of {owners === 1 ? "1 collector" : `${owners.toLocaleString("en")} collectors`} will move to the release
            it&apos;s merged into, with everything recorded. Each collector is told once.
          </Acknowledge>
        ) : null}
      </fieldset>
      <Field id="merge-owner-note" label="Note to owners (optional)" hint={`Shown to the submitter. Up to ${OWNER_NOTE_MAX.toLocaleString("en")} characters.`}>
        <textarea id="merge-owner-note" name="owner_note" maxLength={OWNER_NOTE_MAX} rows={3} aria-describedby="merge-owner-note-hint" className={adminTextarea} />
      </Field>
      <Field id="merge-reason" label="Reason, for the record" hint="Kept in the audit log. Visible to other catalog staff.">
        <Input id="merge-reason" name="reason" required maxLength={STAFF_REASON_MAX} autoComplete="off" aria-describedby="merge-reason-hint" className={adminControl} />
      </Field>
      <div>
        <Button type="submit" variant="destructive" size="control" aria-disabled={pending || undefined}>
          {pending ? "Merging…" : "Merge into this release"}
        </Button>
      </div>
      <div role="alert" aria-live="assertive">
        {state.status === "error" ? (
          <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
