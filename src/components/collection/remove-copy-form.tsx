"use client";

import { CircleAlert, Trash2 } from "lucide-react";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { removeCopy } from "@/features/collection/actions";
import { type CollectionParams, collectionQuery } from "@/features/collection/list-params";

/**
 * Removes this one copy, after a confirmation that names it. The confirmation is a
 * disclosure on the page rather than a dialog: opening it is the first step, the
 * button inside the second. Works without JavaScript, because success is a redirect
 * back to the list as the owner left it.
 */
export function RemoveCopyForm({ itemId, name, added, back }: { itemId: string; name: string; added: string; back: CollectionParams }) {
  const [state, action, pending] = useActionState(removeCopy, { status: "idle", message: null });
  const backFields = [...new URLSearchParams(collectionQuery(back)).entries()];

  return (
    <details className="rounded-lg border">
      <summary className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm font-medium text-destructive outline-none select-none focus-visible:ring-3 focus-visible:ring-ring">
        <Trash2 aria-hidden="true" className="size-4" />
        Remove this copy
      </summary>
      <form
        id="remove-copy"
        action={action}
        onSubmit={(event) => {
          if (pending) event.preventDefault();
        }}
        className="flex flex-col gap-3 border-t p-3"
      >
        <input type="hidden" name="item_id" value={itemId} />
        {backFields.map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <p id="remove-copy-description" className="text-sm">
          This removes <strong className="font-semibold">{name}</strong>, added {added}, from your collection, along with its details and notes. Your
          other copies stay. You can&apos;t undo this.
        </p>
        <div>
          <Button type="submit" variant="destructive" size="lg" className="h-10 px-4" aria-describedby="remove-copy-description" aria-disabled={pending || undefined}>
            {pending ? "Removing…" : "Remove this copy"}
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
