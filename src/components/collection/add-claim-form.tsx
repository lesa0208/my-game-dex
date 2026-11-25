"use client";

import { CircleAlert, Plus } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useId, useRef } from "react";

import { AddedConfirmation, addedMessage, type AddedPlatform, NextGameSearch } from "@/components/collection/added-next";
import { CopyFields, EMPTY_COPY, selectClassName } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AddCopyState } from "@/features/collection/actions";
import { addClaim, addClaimFromForm } from "@/features/collection/claim-actions";
import { EDITION_KIND_OPTIONS, EDITION_NAME_SUGGESTIONS } from "@/features/collection/details";
import { keepingIdOnFailure } from "@/features/collection/retry";

function countText(count: number | null) {
  if (count === null) return null;
  if (count === 0) return "Not in your collection yet";
  return `You have ${count} ${count === 1 ? "copy" : "copies"} of this game`;
}

const addClaimFromPage = keepingIdOnFailure(addClaim);

/**
 * M12b: adds a copy that isn't linked to a catalog release (an M12a unidentified copy),
 * with the platform, region and edition chosen in the steps above. With `edition` set
 * to "other", the owner types it here. Optional details are collapsed.
 *
 * As AddCopyForm: the copy's id comes from the server render and is reused for a repeat
 * of the same submission, so a double click or retry can't add two copies, and an
 * addition gets a fresh id for "Add another copy".
 */
export function AddClaimForm({
  gameId,
  platformId,
  region,
  edition,
  initialItemId,
  initialCount,
  defaultCurrency,
  currencies,
  maxDate,
  submitLabel = "Add to collection",
  platform = null,
}: {
  /** The copy's platform, for the shelf link and the next game's search after an addition. */
  platform?: AddedPlatform;
  gameId: string;
  platformId: string;
  /** The region code, or null for not sure. */
  region: string | null;
  /** The catalog's edition (kind and name), the owner's own ("other"), or not sure (null). */
  edition: { kind: string | null; name: string | null } | "other" | null;
  initialItemId: string;
  initialCount: number | null;
  defaultCurrency: string | null;
  currencies: { code: string; name: string }[];
  maxDate: string;
  submitLabel?: string;
}) {
  const initial: AddCopyState = { status: "idle", message: null, itemId: initialItemId, count: initialCount };
  const [state, action, pending] = useActionState(addClaimFromPage, initial);
  const form = useRef<HTMLFormElement>(null);
  const id = useId();

  const added = state.status === "added" || state.status === "already_added";
  useEffect(() => {
    if (added) form.current?.reset();
  }, [added, state]);

  const message = added ? addedMessage(state.message, state.count, "game") : null;
  return (
    <div className="flex flex-col gap-3">
      <form
        ref={form}
        action={addClaimFromForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const data = new FormData(event.currentTarget);
          startTransition(() => action(data));
        }}
        className="flex flex-col gap-3"
        aria-describedby={`${id}-count`}
      >
        <input type="hidden" name="item_id" value={state.itemId} />
        <input type="hidden" name="game_id" value={gameId} />
        <input type="hidden" name="platform_id" value={platformId} />
        <input type="hidden" name="region" value={region ?? ""} />
        {edition && edition !== "other" ? (
          <>
            <input type="hidden" name="edition_kind" value={edition.kind ?? ""} />
            <input type="hidden" name="edition_name" value={edition.name ?? ""} />
          </>
        ) : null}

        {edition === "other" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-edition-name`} className="text-sm font-medium">
                Edition name <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input
                id={`${id}-edition-name`}
                name="edition_name"
                maxLength={80}
                list={`${id}-edition-names`}
                placeholder="Platinum, Greatest Hits…"
                autoComplete="off"
                className="h-10"
              />
              <datalist id={`${id}-edition-names`}>
                {EDITION_NAME_SUGGESTIONS.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-edition-kind`} className="text-sm font-medium">
                Edition type <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <select id={`${id}-edition-kind`} name="edition_kind" defaultValue="" className={selectClassName}>
                <option value="">Not sure</option>
                {EDITION_KIND_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="submit" size="lg" className="h-10" aria-disabled={pending || undefined}>
            <Plus aria-hidden="true" />
            {pending ? "Adding…" : added ? "Add another copy" : submitLabel}
          </Button>
          <p id={`${id}-count`} className="text-sm text-muted-foreground">
            {countText(state.count)}
          </p>
        </div>

        <div role="status" aria-live="polite" aria-atomic="true">
          {message ? <AddedConfirmation message={message} platform={platform} /> : null}
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
            <CopyFields values={{ ...EMPTY_COPY, currency: defaultCurrency }} mediumLabel="Game" pieces={[]} currencies={currencies} maxDate={maxDate} />
          </div>
        </details>
      </form>
      {added && platform ? <NextGameSearch platform={platform} /> : null}
    </div>
  );
}
