"use client";

import { CircleAlert, CircleCheck, Heart, Trash2 } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState } from "react";

import { Button } from "@/components/ui/button";
import { addWish, addWishFromForm, type AddWishState, type EditWishState, removeWish, updateWish } from "@/features/wishlist/actions";
import { type WishlistParams, wishHref, wishlistQuery } from "@/features/wishlist/params";
import type { WishlistLevel } from "@/features/wishlist/types";

import { type PlatformChoice, type RegionChoice, type ReleaseChoice, WishDetailFields, WishTargetFields } from "./wish-fields";

const UNCONFIRMED = "We couldn't confirm the wish was added. Try again: it won't be added twice.";

/** If the request fails on the way, the form keeps the id it sent, so a retry can't add twice. */
async function addKeepingId(state: AddWishState, formData: FormData): Promise<AddWishState> {
  try {
    return await addWish(state, formData);
  } catch {
    return { ...state, status: "error", message: UNCONFIRMED };
  }
}

function ErrorMessage({ message, signedOut }: { message: string | null; signedOut?: boolean }) {
  return (
    <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        {message}
        {signedOut ? (
          <>
            {" "}
            <Link href="/sign-in" className="underline underline-offset-4">
              Sign in
            </Link>
          </>
        ) : null}
      </span>
    </p>
  );
}

/**
 * Adds the game to the wishlist at the level the collector chooses. The entry's id comes
 * from the server render and is reused for any repeat of the same submission. With
 * JavaScript a second submit while one is in flight is ignored; without it the form
 * posts to the same action (the entry is added, but the page shows no message).
 */
export function AddWishForm({
  gameId,
  platforms,
  regions,
  releases,
  initialItemId,
  initialLevel = "game",
}: {
  gameId: string;
  platforms: PlatformChoice[];
  regions: RegionChoice[];
  releases: ReleaseChoice[];
  initialItemId: string;
  initialLevel?: WishlistLevel;
}) {
  const [state, action, pending] = useActionState(addKeepingId, { status: "idle", message: null, itemId: initialItemId, wishId: null });
  const done = state.status === "added" || state.status === "already";
  return (
    <form
      id="add-wish"
      action={addWishFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="item_id" value={state.itemId} />
      <WishTargetFields gameId={gameId} platforms={platforms} regions={regions} releases={releases} initial={{ level: initialLevel, platformId: null, regionCode: null, releaseId: null }} />
      <details className="rounded-lg border">
        <summary className="flex min-h-10 cursor-pointer items-center rounded-lg px-3 text-sm font-medium outline-none select-none focus-visible:ring-3 focus-visible:ring-ring">
          Priority, completeness and note <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
        </summary>
        <div className="flex flex-col gap-3 border-t p-3">
          <WishDetailFields initial={{ priority: 2, completeness: null, note: null }} />
        </div>
      </details>
      <div>
        <Button type="submit" size="lg" className="h-10" aria-disabled={pending || undefined}>
          <Heart aria-hidden="true" />
          {pending ? "Adding…" : "Add to wishlist"}
        </Button>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        {done && state.message ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm">
            <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
            <span className="font-medium">{state.message}</span>
            {state.wishId ? (
              <Link href={wishHref(state.wishId)} className="text-primary-text underline underline-offset-4">
                {state.status === "already" ? "View or edit it" : "Edit it"}
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>
      <div role="alert" aria-live="assertive">
        {state.status === "error" || state.status === "signed_out" ? <ErrorMessage message={state.message} signedOut={state.status === "signed_out"} /> : null}
      </div>
    </form>
  );
}

/**
 * "Want this release": one exact catalog release, kept apart from adding a copy to the
 * collection. Once wanted, it links to the entry instead.
 */
export function WantReleaseForm({ releaseId, label, initialItemId, wishId }: { releaseId: string; label: string; initialItemId: string; wishId: string | null }) {
  const [state, action, pending] = useActionState(addKeepingId, { status: "idle", message: null, itemId: initialItemId, wishId });
  const wanted = state.wishId;
  if (wanted) {
    return (
      <span role="status" className="inline-flex flex-wrap items-center gap-x-1.5 text-xs">
        <Heart aria-hidden="true" className="size-3.5 fill-primary text-primary" />
        <span className="font-medium">{state.status === "added" ? "Added to your wishlist" : "On your wishlist"}</span>
        <Link href={wishHref(wanted)} className="inline-flex min-h-6 min-w-6 items-center px-1 text-primary-text underline underline-offset-4" aria-label={`View or edit your wish for ${label}`}>
          Edit
        </Link>
      </span>
    );
  }
  return (
    <form
      action={addWishFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col items-end gap-1"
    >
      <input type="hidden" name="item_id" value={state.itemId} />
      <input type="hidden" name="level" value="release" />
      <input type="hidden" name="release_id" value={releaseId} />
      <Button type="submit" variant="outline" size="sm" aria-disabled={pending || undefined} aria-label={`Want this release: ${label}`}>
        <Heart aria-hidden="true" />
        {pending ? "Adding…" : "Want this release"}
      </Button>
      <span role="alert" aria-live="assertive" className="text-right text-xs text-destructive">
        {state.status === "error" || state.status === "signed_out" ? state.message : null}
      </span>
    </form>
  );
}

/** Edits an entry's target, priority, minimum and note. W1 checks every change again. */
export function EditWishForm({
  wishId,
  gameId,
  platforms,
  regions,
  releases,
  initial,
  canChangeTarget,
}: {
  wishId: string;
  gameId: string;
  platforms: PlatformChoice[];
  regions: RegionChoice[];
  releases: ReleaseChoice[];
  initial: { level: WishlistLevel; platformId: string | null; regionCode: string | null; releaseId: string | null; priority: number; completeness: string | null; note: string | null };
  canChangeTarget: boolean;
}) {
  const [state, action, pending] = useActionState<EditWishState, FormData>(updateWish, { status: "idle", message: null });
  return (
    <form
      id="edit-wish"
      action={action}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="wish_id" value={wishId} />
      {canChangeTarget ? (
        <WishTargetFields gameId={gameId} platforms={platforms} regions={regions} releases={releases} initial={initial} />
      ) : (
        <>
          {/* The game left the catalog: its target can't change, only the details. */}
          <input type="hidden" name="game_id" value={gameId} />
          <input type="hidden" name="level" value={initial.level} />
          {initial.platformId ? <input type="hidden" name="platform_id" value={initial.platformId} /> : null}
          {initial.regionCode ? <input type="hidden" name="region_code" value={initial.regionCode} /> : null}
          {initial.releaseId ? <input type="hidden" name="release_id" value={initial.releaseId} /> : null}
        </>
      )}
      <WishDetailFields initial={initial} />
      <div>
        <Button type="submit" size="lg" className="h-10 px-4" aria-disabled={pending || undefined}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        {state.status === "saved" || state.status === "unchanged" ? (
          <p className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
            <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
            {state.message}
          </p>
        ) : null}
      </div>
      <div role="alert" aria-live="assertive">
        {state.status === "error" || state.status === "signed_out" ? <ErrorMessage message={state.message} signedOut={state.status === "signed_out"} /> : null}
      </div>
    </form>
  );
}

/**
 * Removes one entry, after a confirmation that names it: a disclosure, so opening it is
 * the first step and the button inside the second. Works without JavaScript: success is
 * a redirect back to the wishlist as the collector left it.
 */
export function RemoveWishForm({ wishId, name, back, compact = false }: { wishId: string; name: string; back: WishlistParams; compact?: boolean }) {
  const [state, action, pending] = useActionState(removeWish, { status: "idle", message: null });
  const backFields = [...new URLSearchParams(wishlistQuery(back)).entries()];
  const descriptionId = `remove-wish-${wishId}`;
  return (
    <details className={compact ? "group" : "rounded-lg border"}>
      <summary
        className={
          compact
            ? "inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-destructive outline-none select-none hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring"
            : "flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm font-medium text-destructive outline-none select-none focus-visible:ring-3 focus-visible:ring-ring"
        }
      >
        <Trash2 aria-hidden="true" className="size-4" />
        Remove<span className="sr-only"> {name} from your wishlist</span>
      </summary>
      <form
        action={action}
        onSubmit={(event) => {
          if (pending) event.preventDefault();
        }}
        className={compact ? "mt-2 flex flex-col gap-2 rounded-lg border p-3" : "flex flex-col gap-3 border-t p-3"}
      >
        <input type="hidden" name="wish_id" value={wishId} />
        {backFields.map(([field, value]) => (
          <input key={field} type="hidden" name={field} value={value} />
        ))}
        <p id={descriptionId} className="text-sm">
          This removes <strong className="font-semibold">{name}</strong> from your wishlist, with its note. Your collection isn&apos;t changed.
        </p>
        <div>
          <Button type="submit" variant="destructive" size="lg" className="h-9 px-3" aria-describedby={descriptionId} aria-disabled={pending || undefined}>
            {pending ? "Removing…" : "Remove from wishlist"}
          </Button>
        </div>
        <div role="alert" aria-live="assertive">
          {state.status === "error" ? <ErrorMessage message={state.message} /> : null}
        </div>
      </form>
    </details>
  );
}
