"use client";

import { CircleAlert, ImageUp, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { adminHint, adminLabel, FormActions } from "@/components/admin/form-controls";
import { PendingButton } from "@/components/auth/pending-button";
import { UserAvatar } from "@/components/shared/user-avatar";
import { deleteAvatar, uploadAvatar } from "@/features/avatars/actions";
import { AVATAR_ACCEPT, AVATAR_MAX_BYTES, AVATAR_OUTPUT_SIZE, avatarError } from "@/features/avatars/form";
import { cn } from "@/lib/utils";

/**
 * The photo (M11a-3): the current one or the fallback initial, a file to upload in its
 * place, and removing it. Without JavaScript it's a plain file input and two buttons;
 * the server checks everything. With it, a chosen file is previewed and one that's
 * plainly too big is caught before it's sent (a request over the limit would otherwise
 * be refused by Next.js before the action could say why).
 */
export function AvatarSection({
  avatarUrl,
  displayName,
  disabled,
  serverErrorCode,
}: {
  avatarUrl: string | null;
  displayName: string;
  disabled: boolean;
  /** An avatar error code from the page's URL, already shown at the top as "page-error". */
  serverErrorCode: string | null;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setPreview(file && file.size <= AVATAR_MAX_BYTES ? URL.createObjectURL(file) : null);
    setClientError(file && file.size > AVATAR_MAX_BYTES ? "avatar_too_large" : null);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const file = inputRef.current?.files?.[0];
    const problem = !file ? "avatar_missing" : file.size > AVATAR_MAX_BYTES ? "avatar_too_large" : null;
    setClientError(problem);
    if (problem) {
      event.preventDefault();
      inputRef.current?.focus();
    }
  }

  const invalid = Boolean(clientError) || Boolean(serverErrorCode);
  const describedBy = cn(`${id}-hint`, clientError && `${id}-error`, !clientError && serverErrorCode && "page-error");

  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
      <div className="flex shrink-0 flex-col items-center gap-2">
        {preview ? (
          // A local preview of the chosen file: a blob URL, never sent anywhere.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="The chosen photo, before uploading" width={96} height={96} className="size-24 rounded-full object-cover ring-2 ring-primary/60" />
        ) : (
          <UserAvatar collector={{ displayName, avatarUrl: avatarUrl ?? undefined }} size={96} alt={avatarUrl ? "Your current photo" : "No photo yet: your initial is shown"} className="size-24" />
        )}
        <span className="text-xs text-muted-foreground">{preview ? "Preview" : avatarUrl ? "Current photo" : "No photo yet"}</span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <form action={uploadAvatar} onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${id}-file`} className={adminLabel}>
              {avatarUrl ? "Replace photo" : "Upload a photo"}
            </label>
            <input
              ref={inputRef}
              id={`${id}-file`}
              name="avatar"
              type="file"
              accept={AVATAR_ACCEPT}
              required
              disabled={disabled}
              onChange={onChange}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={describedBy}
              className={cn(
                "block w-full min-w-0 rounded-lg border border-input bg-input/30 text-sm text-muted-foreground outline-none transition-[border-color,box-shadow]",
                "file:mr-3 file:h-10 file:cursor-pointer file:border-0 file:border-r file:border-input file:bg-secondary file:px-3 file:text-sm file:font-medium file:text-secondary-foreground",
                "hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/30",
              )}
            />
            {clientError ? (
              <p id={`${id}-error`} className="flex gap-1.5 text-xs leading-5 text-destructive">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {avatarError(clientError)}
              </p>
            ) : null}
            <p id={`${id}-hint`} className={adminHint}>
              JPEG, PNG or WebP, up to 2 MB and between 32 and 4,096 pixels on each side. It&apos;s cropped to a square and saved as a {AVATAR_OUTPUT_SIZE}-pixel
              image, without the camera details or location a photo can carry.
            </p>
          </div>
          <FormActions>
            <PendingButton size="lg" className="h-10 px-4" pendingLabel="Uploading…" disabled={disabled}>
              <ImageUp aria-hidden="true" />
              {avatarUrl ? "Upload new photo" : "Upload photo"}
            </PendingButton>
          </FormActions>
        </form>

        {avatarUrl ? (
          <form action={deleteAvatar} className="flex flex-col gap-2 border-t pt-4">
            <p className={adminHint}>Removing it shows your initial instead. Anyone whose browser already loaded the photo may keep seeing it for a while.</p>
            <FormActions>
              <PendingButton variant="outline" size="lg" className="h-10 px-4" pendingLabel="Removing…" disabled={disabled}>
                <Trash2 aria-hidden="true" />
                Remove photo
              </PendingButton>
            </FormActions>
          </form>
        ) : null}
      </div>
    </div>
  );
}
