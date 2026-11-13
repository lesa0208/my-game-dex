"use client";

import { CircleAlert } from "lucide-react";
import { startTransition, useActionState } from "react";

import { Field, selectClassName } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { decideSubmission, decideSubmissionFromForm, type ReviewState } from "@/features/review/actions";
import { cn } from "@/lib/utils";

function keepOnFailure(action: (state: ReviewState, formData: FormData) => Promise<ReviewState>) {
  return async (state: ReviewState, formData: FormData): Promise<ReviewState> => {
    try {
      return await action(state, formData);
    } catch (error) {
      if (error && typeof error === "object" && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw error;
      return { status: "error", message: "We couldn't confirm it was saved. Check your connection and try again." };
    }
  };
}
const decide = keepOnFailure(decideSubmission);

export type Decision = "start" | "approve" | "changes" | "reject";

/**
 * One review decision: starting a review, approving, asking for changes or rejecting.
 * Each needs the editor's reason, which only editors see; a note, where offered, is
 * shown to the submitter. The page's version and revisions go with it, so a stale page
 * is refused. Works without JavaScript: success redirects to the review page.
 */
export function DecisionForm({
  decision,
  requestId,
  version,
  releaseRevision,
  gameRevision,
  label,
  description,
  note,
  destructive = false,
}: {
  decision: Decision;
  requestId: string;
  version: number;
  releaseRevision?: number;
  gameRevision?: number | null;
  label: string;
  description: string;
  note?: { label: string; hint: string; required: boolean };
  destructive?: boolean;
}) {
  const [state, action, pending] = useActionState(decide, { status: "idle", message: null });
  const id = `decision-${decision}`;
  return (
    <form
      id={id}
      action={decideSubmissionFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="decision" value={decision} />
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="version" value={version} />
      {releaseRevision !== undefined ? <input type="hidden" name="release_revision" value={releaseRevision} /> : null}
      {gameRevision !== undefined && gameRevision !== null ? <input type="hidden" name="game_revision" value={gameRevision} /> : null}
      <p id={`${id}-description`} className="text-sm text-muted-foreground">
        {description}
      </p>
      {note ? (
        <Field id={`${id}-note`} label={note.label} hint={note.hint}>
          <textarea
            id={`${id}-note`}
            name="note"
            required={note.required}
            maxLength={2000}
            rows={3}
            aria-describedby={`${id}-note-hint`}
            className={cn(selectClassName, "h-auto py-2")}
          />
        </Field>
      ) : null}
      <Field id={`${id}-reason`} label="Reason, for the record" hint="Kept in the audit log. Only editors see it.">
        <Input id={`${id}-reason`} name="reason" required maxLength={500} autoComplete="off" aria-describedby={`${id}-reason-hint`} className="h-10" />
      </Field>
      <div>
        <Button
          type="submit"
          variant={destructive ? "destructive" : "default"}
          size="lg"
          className="h-10 px-4"
          aria-describedby={`${id}-description`}
          aria-disabled={pending || undefined}
        >
          {pending ? "Saving…" : label}
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
