"use client";

import { CircleAlert, CircleCheck, Plus } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addCopy, addCopyFromForm, type AddCopyState } from "@/features/collection/actions";
import { COMPLETENESS, componentField, CONDITIONS, NOT_INCLUDED } from "@/features/collection/details";
import { keepingIdOnFailure } from "@/features/collection/retry";
import { cn } from "@/lib/utils";

type Component = { kind: string; label: string; quantity: number };

const selectClassName =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring dark:bg-input/30";

function countText(count: number | null) {
  if (count === null) return null;
  if (count === 0) return "Not in your collection yet";
  return `You have ${count} ${count === 1 ? "copy" : "copies"} of this release`;
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Grade({ id, label, absent }: { id: string; label: string; absent: boolean }) {
  return (
    <Field id={id} label={label}>
      <select id={id} name={id} defaultValue="" className={selectClassName}>
        <option value="">Not assessed</option>
        {CONDITIONS.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
        {absent ? <option value={NOT_INCLUDED.value}>{NOT_INCLUDED.label}</option> : null}
      </select>
    </Field>
  );
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
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-semibold">This copy</legend>
            <Field id="completeness" label="Completeness" hint="Leave as not recorded if you're not sure.">
              <select id="completeness" name="completeness" defaultValue="" aria-describedby="completeness-hint" className={selectClassName}>
                <option value="">Not recorded</option>
                {COMPLETENESS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Grade id="media_condition" label={`${mediumLabel} condition`} absent={false} />
              <Grade id="box_condition" label="Box or case condition" absent />
              <Grade id="manual_condition" label="Manual condition" absent />
              <Grade id="overall_condition" label="Overall condition" absent={false} />
            </div>
          </fieldset>

          {components.length ? (
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-sm font-semibold">Pieces listed for this release</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {components.map((component, index) => (
                  <Field key={`${component.kind}-${component.label}`} id={componentField(index)} label={component.quantity > 1 ? `${component.quantity} × ${component.label}` : component.label}>
                    <select id={componentField(index)} name={componentField(index)} defaultValue="" className={selectClassName}>
                      <option value="">Not recorded</option>
                      <option value="included">Included</option>
                      <option value="missing">Missing</option>
                    </select>
                  </Field>
                ))}
              </div>
            </fieldset>
          ) : null}

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-semibold">Only you can see these</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="acquired_on" label="Acquired on">
                <Input id="acquired_on" name="acquired_on" type="date" min="1970-01-01" max={maxDate} className="h-10" />
              </Field>
              <Field id="storage_location" label="Storage location">
                <Input id="storage_location" name="storage_location" maxLength={120} autoComplete="off" className="h-10" />
              </Field>
              <Field id="purchase_price" label="Price paid">
                <Input id="purchase_price" name="purchase_price" inputMode="decimal" autoComplete="off" placeholder="0.00" className="h-10" />
              </Field>
              <Field id="currency" label="Currency">
                <select id="currency" name="currency" defaultValue={defaultCurrency ?? ""} className={selectClassName}>
                  <option value="">Choose a currency</option>
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} · {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field id="notes" label="Notes">
              <textarea id="notes" name="notes" maxLength={5000} rows={3} className={cn(selectClassName, "h-auto py-2")} />
            </Field>
          </fieldset>
        </div>
      </details>
    </form>
  );
}
