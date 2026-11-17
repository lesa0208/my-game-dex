"use client";

import { CircleAlert } from "lucide-react";
import { startTransition, useActionState, useEffect, useMemo, useRef, type ReactNode } from "react";

import { Field } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EditState } from "@/features/editing/actions";
import { draftKey } from "@/features/editing/form";

type Action = (state: EditState, formData: FormData) => Promise<EditState>;

function keepOnFailure(action: Action): Action {
  return async (state, formData) => {
    try {
      return await action(state, formData);
    } catch (error) {
      if (error && typeof error === "object" && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw error;
      return { status: "error", message: "We couldn't confirm it was saved. Check your connection and try again." };
    }
  };
}

/** Only what an editor typed in words: the reason and any note. Never ids, revisions or values the page supplies. */
const DRAFT_FIELDS = ["reason", "note"] as const;

function saveDraft(form: HTMLFormElement, key: string) {
  const draft: Record<string, string> = {};
  for (const name of DRAFT_FIELDS) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) draft[name] = input.value;
  }
  try {
    sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage can be unavailable (a private window, blocked site data): the editor types it again.
  }
}

function restoreDraft(form: HTMLFormElement, key: string) {
  let draft: unknown = null;
  try {
    draft = JSON.parse(sessionStorage.getItem(key) ?? "null");
    sessionStorage.removeItem(key);
  } catch {
    return;
  }
  if (!draft || typeof draft !== "object") return;
  for (const name of DRAFT_FIELDS) {
    const value = (draft as Record<string, unknown>)[name];
    const input = form.elements.namedItem(name);
    if (typeof value === "string" && (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) && !input.value) input.value = value.slice(0, 2000);
  }
}

/**
 * A catalog editing form (M10c). Submits through its action without a page load, so a
 * refusal keeps everything typed. When the database asks for a fresh TOTP
 * verification, the reason is kept in this tab while the editor verifies, and comes
 * back with the form; they check the record and submit again. Nothing is replayed.
 * Works without JavaScript through `plain`, which goes to verification directly.
 */
export function EditForm({
  id,
  recordId,
  action,
  plain,
  submit,
  pending: pendingLabel,
  variant = "outline",
  children,
}: {
  id: string;
  recordId: string;
  action: Action;
  plain: (formData: FormData) => Promise<void>;
  submit: string;
  pending: string;
  variant?: "default" | "outline" | "destructive";
  children: ReactNode;
}) {
  const guarded = useMemo(() => keepOnFailure(action), [action]);
  const [state, run, pending] = useActionState(guarded, { status: "idle", message: null });
  const form = useRef<HTMLFormElement>(null);
  const key = draftKey(id, recordId);

  useEffect(() => {
    if (form.current) restoreDraft(form.current, key);
  }, [key]);

  useEffect(() => {
    if (state.status === "stepup" && state.href && form.current) {
      saveDraft(form.current, key);
      window.location.assign(state.href);
    }
  }, [state, key]);

  return (
    <form
      ref={form}
      id={id}
      action={plain}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => run(data));
      }}
      className="flex flex-col gap-3"
    >
      {children}
      <div>
        <Button type="submit" variant={variant} size="lg" className="h-10 px-4" aria-disabled={pending || undefined}>
          {pending ? pendingLabel : submit}
        </Button>
      </div>
      <div role="alert" aria-live="assertive">
        {state.status === "error" || state.status === "stepup" ? (
          <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** The staff reason every catalog change needs. Other catalog staff see it in the record's history (M10b, D4). */
export function ReasonField({ id }: { id: string }) {
  return (
    <Field id={`${id}-reason`} label="Reason, for the record" hint="Kept in the audit log. Visible to other catalog staff.">
      <Input id={`${id}-reason`} name="reason" required maxLength={500} autoComplete="off" aria-describedby={`${id}-reason-hint`} className="h-10" />
    </Field>
  );
}
