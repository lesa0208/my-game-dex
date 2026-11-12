"use client";

import { CircleAlert, Undo2 } from "lucide-react";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { withdrawMySubmission } from "@/features/submissions/actions";

/**
 * Withdraws an unreviewed submission, after a confirmation that names it. A disclosure
 * on the page, not a dialog. Works without JavaScript: success redirects.
 */
export function WithdrawSubmissionForm({ submissionId, name }: { submissionId: string; name: string }) {
  const [state, action, pending] = useActionState(withdrawMySubmission, { status: "idle", message: null });
  return (
    <details className="rounded-lg border">
      <summary className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm font-medium text-destructive outline-none select-none focus-visible:ring-3 focus-visible:ring-ring">
        <Undo2 aria-hidden="true" className="size-4" />
        Withdraw this submission
      </summary>
      <form
        id="withdraw-submission"
        action={action}
        onSubmit={(event) => {
          if (pending) event.preventDefault();
        }}
        className="flex flex-col gap-3 border-t p-3"
      >
        <input type="hidden" name="submission_id" value={submissionId} />
        <p id="withdraw-description" className="text-sm">
          This withdraws <strong className="font-semibold">{name}</strong> before review. It&apos;s removed from the catalog&apos;s queue, but stays in your list of
          submissions. You can&apos;t undo this, and it still counts toward today&apos;s limit.
        </p>
        <div>
          <Button type="submit" variant="destructive" size="lg" className="h-10 px-4" aria-describedby="withdraw-description" aria-disabled={pending || undefined}>
            {pending ? "Withdrawing…" : "Withdraw this submission"}
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
    </details>
  );
}
