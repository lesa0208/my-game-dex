"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

/** A form's submit button that says it's working while the form is sent. A plain button without JavaScript. */
export function PendingButton({ pendingLabel, children, ...props }: ComponentProps<typeof Button> & { pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} aria-disabled={pending} {...props}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
