"use client";

import { Check, Heart, Loader2, LogIn, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { uuidv7 } from "@/features/collection/uuid";
import { addWish } from "@/features/wishlist/actions";
import { cn } from "@/lib/utils";

import { QuickAddDialog } from "./quick-add-dialog";

/** Who is looking: what the buttons can do for them. */
export type ExploreViewer = "signed_out" | "needs_handle" | "inactive" | "ready";

/**
 * M17a: the two actions on every Explore result, apart from its link to the game (no
 * control is nested in another).
 *
 * - Add to Collection opens the quick add. Signed out, it's a link to sign in that comes
 *   back to this result with the dialog open (`?add=`), where the copy still waits for
 *   the collector to press Add.
 * - Wishlist adds the game at "any version" (W1's game level: no platform, region or
 *   edition assumed). Once wanted at any level it says so and links to the entry, where
 *   it can be narrowed. Signed out, it comes back here asking to confirm (`?wish=`).
 */
export function ResultActions({
  game,
  viewer,
  presetPlatform,
  owned,
  wishId,
  returnPath,
  autoOpen,
}: {
  game: { id: string; slug: string; title: string };
  viewer: ExploreViewer;
  presetPlatform: string | null;
  owned: number;
  wishId: string | null;
  /** This page, to come back to after signing in. */
  returnPath: string;
  /** Opened by a return from signing in. */
  autoOpen: "add" | "wish" | null;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(autoOpen === "add" && viewer === "ready");
  const [confirmWish, setConfirmWish] = useState(autoOpen === "wish" && viewer === "ready" && !wishId);
  const [wish, setWish] = useState<{ id: string | null; status: "none" | "saving" | "saved" | "error"; message: string | null }>({
    id: wishId,
    status: wishId ? "saved" : "none",
    message: null,
  });
  const [, startTransition] = useTransition();

  // A wish the page reads as saved (after a refresh) is shown as saved.
  const [shownWishId, setShownWishId] = useState(wishId);
  if (shownWishId !== wishId) {
    setShownWishId(wishId);
    // The same entry just saved here keeps its confirmation.
    if (wishId) setWish((w) => (w.id === wishId && w.status === "saved" ? w : { id: wishId, status: "saved", message: null }));
  }

  const onAdded = useCallback(() => router.refresh(), [router]);

  function saveWish() {
    setWish((w) => ({ ...w, status: "saving", message: null }));
    const data = new FormData();
    data.set("item_id", uuidv7());
    data.set("level", "game");
    data.set("game_id", game.id);
    startTransition(async () => {
      try {
        const result = await addWish({ status: "idle", message: null, itemId: "", wishId: null }, data);
        if (result.status === "added" || result.status === "already") setWish({ id: result.wishId, status: "saved", message: result.message });
        else setWish({ id: null, status: "error", message: result.message ?? "The game couldn't be added to your wishlist. Try again." });
      } catch {
        setWish({ id: null, status: "error", message: "We couldn't confirm the wish was saved. Try again: it won't be added twice." });
      }
    });
  }

  const back = (intent: "add" | "wish") => {
    const url = new URL(returnPath, "http://next.invalid");
    url.searchParams.set(intent, game.slug);
    return `/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
  };
  const welcome = `/welcome?next=${encodeURIComponent(returnPath)}`;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        {viewer === "ready" ? (
          <Button type="button" size="lg" className="h-10" onClick={() => setAdding(true)} data-action="add">
            <Plus aria-hidden="true" />
            {owned ? "Add another" : "Add to Collection"}
          </Button>
        ) : viewer === "inactive" ? (
          <Button type="button" size="lg" className="h-10" disabled title="Your account can't add copies right now">
            <Plus aria-hidden="true" />
            Add to Collection
          </Button>
        ) : (
          <Button asChild size="lg" className="h-10" data-action="add">
            <Link href={viewer === "signed_out" ? back("add") : welcome}>
              {viewer === "signed_out" ? <LogIn aria-hidden="true" /> : <Plus aria-hidden="true" />}
              Add to Collection
            </Link>
          </Button>
        )}

        {wish.status === "saved" && wish.id ? (
          <Button asChild variant="secondary" size="lg" className="h-10 text-primary-text" data-action="wish" data-wished="">
            <Link href={`/collection/wishlist/${wish.id}`} aria-label={`On your wishlist: ${game.title}. Open the entry to refine it`}>
              <Heart aria-hidden="true" className="fill-current" />
              <span className="max-[359px]:sr-only">Wishlisted</span>
            </Link>
          </Button>
        ) : viewer === "ready" ? (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="h-10"
            onClick={saveWish}
            aria-disabled={wish.status === "saving" || undefined}
            aria-label={`Add ${game.title} to your wishlist`}
            data-action="wish"
          >
            {wish.status === "saving" ? <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Heart aria-hidden="true" />}
            <span className="max-[359px]:sr-only">Wishlist</span>
          </Button>
        ) : viewer === "inactive" ? null : (
          <Button asChild variant="secondary" size="lg" className="h-10" data-action="wish">
            <Link href={viewer === "signed_out" ? back("wish") : welcome} aria-label={`Sign in to add ${game.title} to your wishlist`}>
              <Heart aria-hidden="true" />
              <span className="max-[359px]:sr-only">Wishlist</span>
            </Link>
          </Button>
        )}
      </div>
      <p aria-live="polite" className={cn("min-h-4 text-xs", wish.status === "error" ? "text-destructive" : "text-muted-foreground")}>
        {wish.status === "error" ? wish.message : wish.status === "saved" && wish.message ? `${wish.message} Any version, for now: open it to choose a platform or region.` : ""}
      </p>

      {viewer === "ready" ? (
        <QuickAddDialog open={adding} onOpenChange={setAdding} game={game} presetPlatform={presetPlatform} onAdded={onAdded} />
      ) : null}

      {confirmWish ? (
        <Dialog open onOpenChange={(open) => !open && setConfirmWish(false)}>
          <DialogContent title={`Add ${game.title} to your wishlist?`} description="Any version: you can choose a platform or region afterwards.">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="lg"
                className="h-10"
                onClick={() => {
                  setConfirmWish(false);
                  saveWish();
                }}
              >
                <Check aria-hidden="true" />
                Add to wishlist
              </Button>
              <Button type="button" variant="ghost" size="lg" className="h-10" onClick={() => setConfirmWish(false)}>
                Not now
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
