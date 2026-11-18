"use client";

import { CircleAlert } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { adminControl, adminHint, adminLabel, adminTextarea, FormActions } from "@/components/admin/form-controls";
import { PendingButton } from "@/components/auth/pending-button";
import { Input } from "@/components/ui/input";
import { updateProfile } from "@/features/profile/actions";
import {
  BIO_MAX,
  characterCount,
  DISPLAY_NAME_MAX,
  normalizeBio,
  normalizeDisplayName,
  profileError,
  profileErrorField,
  profileProblem,
} from "@/features/profile/form";
import { cn } from "@/lib/utils";

/**
 * The display name and bio (M11a-3). Works without JavaScript: the server checks
 * everything and answers in the page's URL. With it, the counters follow what's typed
 * and a value over a limit is caught before sending, with the same rules and words.
 * Limits count characters as the database does, so there's no maxLength (which counts
 * UTF-16 units and would cut an emoji-heavy name short).
 */
export function ProfileForm({
  displayName,
  bio,
  handle,
  serverErrorCode,
  disabled,
}: {
  displayName: string | null;
  bio: string | null;
  handle: string;
  /** The error code in the page's URL, already shown at the top of the page as "page-error". */
  serverErrorCode: string | null;
  disabled: boolean;
}) {
  const id = useId();
  const [name, setName] = useState(displayName ?? "");
  const [about, setAbout] = useState(bio ?? "");
  const [clientError, setClientError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const bioRef = useRef<HTMLTextAreaElement>(null);

  const clientField = profileErrorField(clientError);
  const serverField = clientError ? null : profileErrorField(serverErrorCode);
  const nameInvalid = clientField === "display_name" || serverField === "display_name";
  const bioInvalid = clientField === "bio" || serverField === "bio";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const problem = profileProblem(normalizeDisplayName(name), normalizeBio(about));
    setClientError(problem);
    if (problem) {
      event.preventDefault();
      (profileErrorField(problem) === "bio" ? bioRef : nameRef).current?.focus();
    }
  }

  const describe = (field: "display_name" | "bio", base: string) =>
    cn(base, clientField === field && `${id}-${field}-error`, serverField === field && "page-error") || undefined;

  return (
    <form action={updateProfile} onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={`${id}-display-name`} className={adminLabel}>
            Display name <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Counter count={characterCount(name.normalize("NFKC").trim())} max={DISPLAY_NAME_MAX} />
        </div>
        <Input
          ref={nameRef}
          id={`${id}-display-name`}
          name="display_name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="nickname"
          spellCheck={false}
          disabled={disabled}
          aria-invalid={nameInvalid ? true : undefined}
          aria-describedby={describe("display_name", `${id}-display-name-hint`)}
          className={adminControl}
        />
        <FieldError id={`${id}-display_name-error`} message={clientField === "display_name" ? profileError(clientError) : null} />
        <p id={`${id}-display-name-hint`} className={adminHint}>
          Up to {DISPLAY_NAME_MAX} characters. Leave it empty to show your handle, @{handle}, instead.
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={`${id}-bio`} className={adminLabel}>
            Bio <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Counter count={characterCount(about.replace(/\r\n?/g, "\n").trim())} max={BIO_MAX} />
        </div>
        <textarea
          ref={bioRef}
          id={`${id}-bio`}
          name="bio"
          value={about}
          onChange={(event) => setAbout(event.target.value)}
          rows={5}
          disabled={disabled}
          aria-invalid={bioInvalid ? true : undefined}
          aria-describedby={describe("bio", `${id}-bio-hint`)}
          className={cn(adminTextarea, "min-h-32 resize-y")}
        />
        <FieldError id={`${id}-bio-error`} message={clientField === "bio" ? profileError(clientError) : null} />
        <p id={`${id}-bio-hint`} className={adminHint}>
          Up to {BIO_MAX} characters, with line breaks if you like. Leave it empty for no bio.
        </p>
      </div>

      <FormActions>
        <PendingButton size="lg" className="h-10 px-4" pendingLabel="Saving…" disabled={disabled}>
          Save profile
        </PendingButton>
      </FormActions>
    </form>
  );
}

/**
 * "12 / 50", shown, and silent while typing. Near the limit (the last tenth) and over
 * it, a polite live region says how many are left, once per change of that state.
 */
function Counter({ count, max }: { count: number; max: number }) {
  const left = max - count;
  const over = left < 0;
  const near = !over && left <= Math.max(5, Math.floor(max / 10));
  const spoken = over ? `${-left} characters over the limit of ${max}.` : near ? `${left} characters left.` : "";
  return (
    <>
      <span aria-hidden="true" className={cn("text-xs tabular-nums", over ? "font-medium text-destructive" : near ? "text-foreground" : "text-muted-foreground")}>
        {count} / {max}
      </span>
      <span className="sr-only" aria-live="polite">
        {spoken}
      </span>
    </>
  );
}

function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <p id={id} className="flex gap-1.5 text-xs leading-5 text-destructive">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      {message}
    </p>
  );
}
