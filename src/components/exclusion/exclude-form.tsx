"use client";

import { CircleAlert } from "lucide-react";
import { startTransition, useActionState } from "react";

import { Field, selectClassName } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { excludeRelease, excludeReleaseFromForm, type ExclusionState } from "@/features/exclusion/actions";
import { EXCLUSION_REASONS, OWNER_NOTE_MAX, STAFF_REASON_MAX } from "@/features/exclusion/form";
import { cn } from "@/lib/utils";

function keepOnFailure(action: (state: ExclusionState, formData: FormData) => Promise<ExclusionState>) {
  return async (state: ExclusionState, formData: FormData): Promise<ExclusionState> => {
    try {
      return await action(state, formData);
    } catch (error) {
      if (error && typeof error === "object" && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw error;
      return { status: "error", message: "We couldn't confirm it was saved. Check your connection and try again." };
    }
  };
}
const exclude = keepOnFailure(excludeRelease);

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
 * Excluding a release (M7b-2b), for an editor who has read the preview. The preview's
 * token goes with it, so the database refuses if anything it showed has changed. Every
 * effect must be confirmed. Works without JavaScript: success redirects.
 */
export function ExcludeForm({
  releaseId,
  token,
  copies,
  owners,
  cascade,
}: {
  releaseId: string;
  token: string;
  copies: number;
  owners: number;
  cascade: string[];
}) {
  const [state, action, pending] = useActionState(exclude, { status: "idle", message: null });
  return (
    <form
      id="exclude-release"
      action={excludeReleaseFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        startTransition(() => action(new FormData(event.currentTarget)));
      }}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="release_id" value={releaseId} />
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="needs_cascade" value={cascade.length ? "yes" : "no"} />
      <input type="hidden" name="needs_copies" value={copies ? "yes" : "no"} />
      <Field id="exclude-reason-code" label="Why it's outside the catalog's scope" hint="Owners of preserved copies see this.">
        <select id="exclude-reason-code" name="reason_code" required defaultValue="" aria-describedby="exclude-reason-code-hint" className={selectClassName}>
          <option value="" disabled>
            Choose a reason
          </option>
          {EXCLUSION_REASONS.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>
      <Field id="exclude-owner-note" label="Note to owners (optional)" hint={`Shown with their preserved copies, and to the submitter. Up to ${OWNER_NOTE_MAX.toLocaleString("en")} characters.`}>
        <textarea
          id="exclude-owner-note"
          name="owner_note"
          maxLength={OWNER_NOTE_MAX}
          rows={3}
          aria-describedby="exclude-owner-note-hint"
          className={cn(selectClassName, "h-auto py-2")}
        />
      </Field>
      <Field id="exclude-reason" label="Reason, for the record" hint="Kept in the audit log. Only staff see it.">
        <Input id="exclude-reason" name="reason" required maxLength={STAFF_REASON_MAX} autoComplete="off" aria-describedby="exclude-reason-hint" className="h-10" />
      </Field>
      <fieldset className="flex flex-col gap-3 rounded-lg border border-destructive/30 p-3">
        <legend className="px-1 text-sm font-medium">Confirm the effects</legend>
        {copies ? (
          <Acknowledge id="exclude-ack-copies" name="acknowledge_copies">
            {copies === 1 ? "1 copy" : `${copies.toLocaleString("en")} copies`} of {owners === 1 ? "1 collector" : `${owners.toLocaleString("en")} collectors`} will be kept privately, no longer
            counted as owned. Nothing is deleted, and each collector is told once.
          </Acknowledge>
        ) : null}
        {cascade.length ? (
          <Acknowledge id="exclude-ack-cascade" name="acknowledge_cascade">
            Also excluded, because nothing else would keep them in the catalog: {cascade.join("; ")}.
          </Acknowledge>
        ) : null}
        {!copies && !cascade.length ? <p className="text-sm text-muted-foreground">Only this release is excluded. No copies or other records are affected.</p> : null}
      </fieldset>
      <div>
        <Button type="submit" variant="destructive" size="lg" className="h-10 px-4" aria-disabled={pending || undefined}>
          {pending ? "Excluding…" : "Exclude from the catalog"}
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
