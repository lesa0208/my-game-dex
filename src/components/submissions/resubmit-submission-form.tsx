"use client";

import { CircleAlert, Send } from "lucide-react";
import { useActionState } from "react";

import { Field, selectClassName } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { resubmitMySubmission } from "@/features/submissions/actions";
import { cn } from "@/lib/utils";

/**
 * Sends a submission back for review: after changes were requested, the same one;
 * after a rejection, a new one, which counts toward today's limit. An optional note
 * replaces the earlier one. Works without JavaScript: success redirects.
 */
export function ResubmitSubmissionForm({ submissionId, rejected }: { submissionId: string; rejected: boolean }) {
  const [state, action, pending] = useActionState(resubmitMySubmission, { status: "idle", message: null });
  return (
    <form
      id="resubmit-submission"
      action={action}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col gap-3 rounded-lg border bg-card p-4"
    >
      <h2 className="text-sm font-semibold">{rejected ? "Resubmit for review" : "Send it back for review"}</h2>
      <input type="hidden" name="submission_id" value={submissionId} />
      <p id="resubmit-description" className="text-sm text-muted-foreground">
        {rejected
          ? "This sends it to the editors again, as a new submission linked to this one. It counts toward today's limit of 10. Change it first if you can, after resubmitting it."
          : "When you've made the changes the editors asked for, send it back. It isn't counted again toward today's limit."}
      </p>
      <Field id="resubmit-note" label="Note for the editors (optional)" hint="Replaces your earlier note. Leave it empty to keep that one.">
        <textarea id="resubmit-note" name="note" maxLength={1000} rows={3} aria-describedby="resubmit-note-hint" className={cn(selectClassName, "h-auto py-2")} />
      </Field>
      <div>
        <Button type="submit" size="lg" className="h-10 px-4" aria-describedby="resubmit-description" aria-disabled={pending || undefined}>
          <Send aria-hidden="true" />
          {pending ? "Sending…" : rejected ? "Resubmit for review" : "Send it back for review"}
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
