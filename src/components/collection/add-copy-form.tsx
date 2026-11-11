"use client";

import { CircleAlert, CircleCheck, Plus } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useRef } from "react";

import { CopyFields, EMPTY_COPY } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { addCopy, addCopyFromForm, type AddCopyState } from "@/features/collection/actions";
import { keepingIdOnFailure } from "@/features/collection/retry";

type Component = { kind: string; label: string; quantity: number };

function countText(count: number | null) {
  if (count === null) return null;
  if (count === 0) return "Not in your collection yet";
  return `You have ${count} ${count === 1 ? "copy" : "copies"} of this release`;
}

const addCopyFromPage = keepingIdOnFailure(addCopy);

/**
 * The add action for one release, with optional details collapsed underneath.
 *
 * The copy's id comes from the server render and is reused for any repeat of the same
 * submission, so a double click or retry can't add two copies. With JavaScript the
 * submit handler runs the action itself: a second submit while one is in flight is
 * ignored, and a refusal keeps what was typed (React's automatic form reset is only
 * for native submissions). The form is cleared after an addition.
 *
 * Without JavaScript (or before it loads) the form posts to the same server action and
 * the copy is added, but the page rendered afterwards shows no message: Next.js
 * renders it by resuming the prerendered shell, and React's resume can't carry an
 * action's result. JavaScript is required for the form's feedback.
 */
export function AddCopyForm({
  releaseId,
  initialItemId,
  initialCount,
  defaultCurrency,
  currencies,
  maxDate,
  mediumLabel,
  components,
}: {
  releaseId: string;
  initialItemId: string;
  initialCount: number | null;
  defaultCurrency: string | null;
  currencies: { code: string; name: string }[];
  maxDate: string;
  mediumLabel: string;
  components: Component[];
}) {
  const initial: AddCopyState = { status: "idle", message: null, itemId: initialItemId, count: initialCount };
  const [state, action, pending] = useActionState(addCopyFromPage, initial);
  const form = useRef<HTMLFormElement>(null);

  const added = state.status === "added" || state.status === "already_added";
  useEffect(() => {
    if (added) form.current?.reset();
  }, [added, state]);

  return (
    <form
      ref={form}
      action={addCopyFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col gap-3"
      aria-describedby="add-copy-count"
    >
      <input type="hidden" name="item_id" value={state.itemId} />
      <input type="hidden" name="release_id" value={releaseId} />
      <input type="hidden" name="components" value={JSON.stringify(components.map(({ kind, label }) => ({ kind, label })))} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" size="lg" className="h-10" aria-disabled={pending || undefined}>
          <Plus aria-hidden="true" />
          {pending ? "Adding…" : added ? "Add another copy" : "Add to collection"}
        </Button>
        <p id="add-copy-count" className="text-sm text-muted-foreground">
          {countText(state.count)}
        </p>
      </div>

      <div role="status" aria-live="polite" aria-atomic="true">
        {added && state.message ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm">
            <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
            <span className="font-medium">{state.message}</span>
            <Link href="/collection" className="text-primary-text underline underline-offset-4">
              View your collection
            </Link>
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

      <details className="rounded-lg border">
        <summary className="flex min-h-10 cursor-pointer items-center rounded-lg px-3 text-sm font-medium outline-none select-none focus-visible:ring-3 focus-visible:ring-ring">
          More details <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
        </summary>
        <div className="flex flex-col gap-5 border-t p-3">
          <CopyFields
            values={{ ...EMPTY_COPY, currency: defaultCurrency }}
            mediumLabel={mediumLabel}
            pieces={components.map((c) => ({ ...c, value: "" }))}
            currencies={currencies}
            maxDate={maxDate}
          />
        </div>
      </details>
    </form>
  );
}
