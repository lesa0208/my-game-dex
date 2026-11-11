"use client";

import { useActionState } from "react";

import { FormError } from "@/components/auth/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type FormState, signIn } from "@/features/auth/actions";

const initial: FormState = { error: null };

export function SignInForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signIn, initial);

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <FormError id="sign-in-error" message={state.error} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          required
          maxLength={254}
          className="h-10"
          aria-describedby={state.error ? "sign-in-error" : undefined}
          aria-invalid={state.error ? true : undefined}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={1024}
          className="h-10"
          aria-describedby={state.error ? "sign-in-error" : undefined}
          aria-invalid={state.error ? true : undefined}
        />
      </div>
      <Button type="submit" size="lg" className="h-10" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
