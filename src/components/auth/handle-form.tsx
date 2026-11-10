"use client";

import { useActionState } from "react";

import { FormError } from "@/components/auth/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { claimHandle, type FormState } from "@/features/auth/actions";

const initial: FormState = { error: null };

/** Claims a first handle, or changes one, through the M2 `claim_handle` rules. */
export function HandleForm({
  next,
  current,
  submitLabel,
}: {
  next: string;
  current: string | null;
  submitLabel: string;
}) {
  const [state, action, pending] = useActionState(claimHandle, initial);

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <FormError id="handle-error" message={state.error} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="handle" className="text-sm font-medium">
          Handle
        </label>
        <div className="flex items-center gap-1.5">
          <span aria-hidden="true" className="text-muted-foreground">
            @
          </span>
          <Input
            id="handle"
            name="handle"
            defaultValue={current ?? ""}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            minLength={3}
            maxLength={24}
            pattern="[A-Za-z0-9_]{3,24}"
            className="h-10"
            aria-describedby={state.error ? "handle-error handle-hint" : "handle-hint"}
            aria-invalid={state.error ? true : undefined}
          />
        </div>
        <p id="handle-hint" className="text-xs text-muted-foreground">
          3 to 24 letters, numbers or underscores. It&apos;s saved in lowercase.
        </p>
      </div>
      <Button type="submit" size="lg" className="h-10 self-start" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
