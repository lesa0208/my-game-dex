"use client";

import { ArrowRightLeft, CircleAlert } from "lucide-react";
import { startTransition, useActionState } from "react";

import { Button } from "@/components/ui/button";
import { moveCopy, moveCopyFromForm } from "@/features/collection/actions";
import { type CollectionParams, collectionQuery } from "@/features/collection/list-params";

/**
 * The last step of moving a copy: confirms the move from one release to another,
 * naming both. Works without JavaScript: success redirects to the copy's page.
 */
export function MoveCopyForm({ itemId, releaseId, from, to, back }: { itemId: string; releaseId: string; from: string; to: string; back: CollectionParams }) {
  const [state, action, pending] = useActionState(moveCopy, { status: "idle", message: null });
  const backFields = [...new URLSearchParams(collectionQuery(back)).entries()];
  return (
    <form
      id="move-copy"
      action={moveCopyFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3"
    >
      <input type="hidden" name="item_id" value={itemId} />
      <input type="hidden" name="release_id" value={releaseId} />
      {backFields.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <h3 className="text-sm font-semibold">Confirm the move</h3>
      <dl id="move-copy-description" className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,6rem)_minmax(0,1fr)]">
        <dt className="text-muted-foreground">From</dt>
        <dd className="break-words">{from}</dd>
        <dt className="text-muted-foreground">To</dt>
        <dd className="font-medium break-words">{to}</dd>
      </dl>
      <p className="text-sm text-muted-foreground">
        Your copy keeps its conditions, private details and every piece you recorded. Pieces the new release doesn&apos;t list are kept as no longer listed, until you remove them.
      </p>
      <div>
        <Button type="submit" size="lg" className="h-10 px-4" aria-describedby="move-copy-description" aria-disabled={pending || undefined}>
          <ArrowRightLeft aria-hidden="true" />
          {pending ? "Moving…" : "Move this copy"}
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
