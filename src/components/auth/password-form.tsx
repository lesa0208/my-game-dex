"use client";

import { useActionState } from "react";

import { FormError } from "@/components/auth/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/features/auth/actions";
import { setInvitationPassword } from "@/features/invitations/onboarding";

const initial: FormState = { error: null };

/** Sets an invitee's first password (M11a-1). The server checks it again, and so does Auth. */
export function PasswordForm() {
  const [state, action, pending] = useActionState(setInvitationPassword, initial);
  const described = state.error ? "password-error password-hint" : "password-hint";

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <FormError id="password-error" message={state.error} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          New password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          className="h-10"
          aria-describedby={described}
          aria-invalid={state.error ? true : undefined}
        />
        <p id="password-hint" className="text-xs text-muted-foreground">
          At least 12 characters. A few unrelated words make a strong one.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="confirm" className="text-sm font-medium">
          The same password again
        </label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={12} className="h-10" aria-invalid={state.error ? true : undefined} />
      </div>
      <Button type="submit" size="lg" className="h-10 self-start px-4" disabled={pending}>
        {pending ? "Saving…" : "Set password"}
      </Button>
    </form>
  );
}
