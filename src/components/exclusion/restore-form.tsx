"use client";

import { CircleAlert } from "lucide-react";
import { startTransition, useActionState } from "react";

import { Field } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { restoreExclusion, restoreExclusionFromForm, type ExclusionState } from "@/features/exclusion/actions";
import { STAFF_REASON_MAX } from "@/features/exclusion/form";

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
const restore = keepOnFailure(restoreExclusion);

/**
 * Restoring an exclusion (M7b-2b), for an administrator. The version they read goes
 * with it, so a stale page is refused. Works without JavaScript: success redirects.
 */
export function RestoreForm({ exclusionId, version, description }: { exclusionId: string; version: number; description: string }) {
  const [state, action, pending] = useActionState(restore, { status: "idle", message: null });
  return (
    <form
      id="restore-exclusion"
      action={restoreExclusionFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        startTransition(() => action(new FormData(event.currentTarget)));
      }}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="exclusion_id" value={exclusionId} />
      <input type="hidden" name="version" value={version} />
      <p id="restore-description" className="text-sm text-muted-foreground">
        {description}
      </p>
      <Field id="restore-reason" label="Reason, for the record" hint="Kept in the audit log. Only staff see it.">
        <Input id="restore-reason" name="reason" required maxLength={STAFF_REASON_MAX} autoComplete="off" aria-describedby="restore-reason-hint" className="h-10" />
      </Field>
      <div>
        <Button type="submit" size="lg" className="h-10 px-4" aria-describedby="restore-description" aria-disabled={pending || undefined}>
          {pending ? "Restoring…" : "Restore"}
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
