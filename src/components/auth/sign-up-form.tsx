"use client";

import { useActionState } from "react";

import { FormError } from "@/components/auth/form-error";
import { PasswordFields } from "@/components/auth/password-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/features/auth/actions";
import { signUp } from "@/features/auth/sign-up";

const initial: FormState = { error: null };

/** Creates a collector account (M16), where this server allows it. Its errors keep what was typed. */
export function SignUpForm() {
  const [state, action, pending] = useActionState(signUp, initial);
  const describedBy = state.error ? "sign-up-error password-hint" : "password-hint";

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <FormError id="sign-up-error" message={state.error} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          maxLength={254}
          className="h-10"
          aria-describedby={state.error ? "sign-up-error" : undefined}
          aria-invalid={state.error ? true : undefined}
        />
      </div>
      <PasswordFields describedBy={describedBy} invalid={Boolean(state.error)} label="Password" />
      <Button type="submit" size="lg" className="h-10" disabled={pending}>
        {pending ? "Creating your account…" : "Create account"}
      </Button>
    </form>
  );
}
