"use client";

import { useActionState } from "react";

import { FormError } from "@/components/auth/form-error";
import { PasswordFields } from "@/components/auth/password-fields";
import { Button } from "@/components/ui/button";
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
      <PasswordFields describedBy={described} invalid={Boolean(state.error)} />
      <Button type="submit" size="lg" className="h-10 self-start px-4" disabled={pending}>
        {pending ? "Saving…" : "Set password"}
      </Button>
    </form>
  );
}
