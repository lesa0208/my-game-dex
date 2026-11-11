"use client";

import { CircleAlert } from "lucide-react";
import { startTransition, useActionState } from "react";

import { Button } from "@/components/ui/button";
import { removePieceRecord, removePieceRecordFromForm } from "@/features/collection/actions";

/**
 * Removes the owner's record of one piece the release no longer lists. Nothing else
 * removes these records: editing the listed pieces keeps them.
 */
export function RemovePieceRecordForm({ itemId, kind, label, name }: { itemId: string; kind: string; label: string; name: string }) {
  const [state, action, pending] = useActionState(removePieceRecord, { status: "idle", message: null });
  return (
    <form
      action={removePieceRecordFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col items-start gap-1.5"
    >
      <input type="hidden" name="item_id" value={itemId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="label" value={label} />
      <Button type="submit" variant="ghost" className="-ml-2.5 text-destructive hover:text-destructive" aria-label={`Remove this record: ${name}`} aria-disabled={pending || undefined}>
        {pending ? "Removing…" : "Remove this record"}
      </Button>
      <div role="alert" aria-live="assertive">
        {state.status === "error" ? (
          <p className="flex gap-2 text-sm text-destructive">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
