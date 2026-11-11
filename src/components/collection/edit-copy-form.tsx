"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState } from "react";

import { CopyFields, type CopyFieldValues, type PieceField } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { type EditCopyState, updateCopy, updateCopyFromForm } from "@/features/collection/actions";

/** Keeps the form as typed when the request fails on the way, instead of the page's error boundary. */
async function saveFromPage(state: EditCopyState, formData: FormData): Promise<EditCopyState> {
  try {
    return await updateCopy(state, formData);
  } catch {
    return { status: "error", message: "We couldn't confirm your changes were saved. Check your connection and save again." };
  }
}

/**
 * Edits one copy. Every field shows what's recorded and can be set back to "Not
 * recorded" to clear it. With JavaScript the submit handler runs the action, so a
 * refusal keeps what was typed and a second submit while one is in flight is ignored.
 * Without it the form posts to the same action and the page shows the saved details.
 */
export function EditCopyForm({
  itemId,
  values,
  pieces,
  unlistedPieces,
  mediumLabel,
  currencies,
  maxDate,
}: {
  itemId: string;
  values: CopyFieldValues;
  pieces: PieceField[];
  unlistedPieces: string[];
  mediumLabel: string;
  currencies: { code: string; name: string }[];
  maxDate: string;
}) {
  const [state, action, pending] = useActionState(saveFromPage, { status: "idle", message: null });

  return (
    <form
      id="edit-copy"
      action={updateCopyFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col gap-5"
    >
      <input type="hidden" name="item_id" value={itemId} />
      <input type="hidden" name="components" value={JSON.stringify(pieces.map(({ kind, label }) => ({ kind, label })))} />
      <CopyFields values={values} mediumLabel={mediumLabel} pieces={pieces} currencies={currencies} maxDate={maxDate} />
      {unlistedPieces.length ? (
        <p className="text-xs text-muted-foreground">
          The release no longer lists {unlistedPieces.join(", ")}. Saving keeps what you recorded for {unlistedPieces.length === 1 ? "it" : "them"}. To
          remove a record, use “Remove this record” under the copy&apos;s pieces.
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <div>
          <Button type="submit" size="lg" className="h-10 px-4" aria-disabled={pending || undefined}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
        <div role="status" aria-live="polite" aria-atomic="true">
          {state.status === "saved" ? (
            <p className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
              <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
              {state.message}
            </p>
          ) : null}
        </div>
        <div role="alert" aria-live="assertive">
          {state.status === "error" || state.status === "signed_out" ? (
            <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                {state.message}
                {state.status === "signed_out" ? (
                  <>
                    {" "}
                    <Link href="/sign-in" className="underline underline-offset-4">
                      Sign in
                    </Link>
                  </>
                ) : null}
              </span>
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
