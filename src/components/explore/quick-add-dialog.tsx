"use client";

import { Check, ChevronDown, CircleAlert, Library, Loader2, Plus, Search } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";

import { CopyFields, EMPTY_COPY } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { addCopy, type AddCopyState } from "@/features/collection/actions";
import { addClaim } from "@/features/collection/claim-actions";
import { loadQuickAdd, type QuickAddOptions } from "@/features/collection/quick-add";
import { keepingIdOnFailure } from "@/features/collection/retry";
import { uuidv7 } from "@/features/collection/uuid";
import { cn } from "@/lib/utils";

/** The regions most copies are from, offered as buttons; the rest are in a list. */
const COMMON_REGIONS = ["ntsc-uc", "pal", "ntsc-j"];
const UNSURE = "";
const NO_RELEASE = "";

/** A verified release when the collector picked one, otherwise an unidentified copy (M12a). */
const submit = keepingIdOnFailure(async (state: AddCopyState, formData: FormData) =>
  formData.get("release_id") ? addCopy(state, formData) : addClaim(state, formData),
);

type Ready = Extract<QuickAddOptions, { status: "ready" }>;

/**
 * M17a: adding a copy straight from an Explore result. Platform (preset when the game has
 * one, or when Explore is filtered to one of its platforms), region (or "Not sure"),
 * and optionally one of the catalog's verified releases for that platform and region:
 * only when the collector picks it. Condition, completeness and purchase details are
 * collapsed. Nothing is added until they press Add.
 *
 * The options are read when it opens (loadQuickAdd); the addition goes through the
 * existing addCopy and addClaim actions, with a UUIDv7 made here as their idempotency
 * key, so a double click or retry can't add two copies.
 */
export function QuickAddDialog({
  open,
  onOpenChange,
  game,
  presetPlatform,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  game: { slug: string; title: string };
  presetPlatform: string | null;
  onAdded: (copies: number | null) => void;
}) {
  const [options, setOptions] = useState<QuickAddOptions | null>(null);

  useEffect(() => {
    if (!open || options) return;
    let live = true;
    loadQuickAdd(game.slug)
      .then((loaded) => live && setOptions(loaded))
      .catch(() => live && setOptions({ status: "unavailable" }));
    return () => {
      live = false;
    };
  }, [open, options, game.slug]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Add ${game.title}`} description="Add your physical copy to your collection." data-quick-add="">
        {!options ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
            Loading…
          </p>
        ) : options.status === "ready" ? (
          <QuickAddForm options={options} presetPlatform={presetPlatform} onAdded={onAdded} onDone={() => onOpenChange(false)} />
        ) : (
          <p className="flex gap-2 py-4 text-sm">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            {options.status === "signed_out"
              ? "Sign in to add copies to your collection."
              : options.status === "needs_handle"
                ? "Choose your handle to start your collection."
                : options.status === "inactive"
                  ? "Your account can't add copies right now."
                  : "Adding isn't available right now. Try again later."}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Chip({ name, value, checked, onChange, children }: { name: string; value: string; checked: boolean; onChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <label
      className={cn(
        "relative flex min-h-10 cursor-pointer items-center rounded-lg border px-3 text-sm transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring motion-reduce:transition-none",
        checked ? "border-primary bg-primary/15 font-medium text-foreground" : "border-white/12 text-muted-foreground hover:border-white/25 hover:text-foreground",
      )}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} className="sr-only" />
      {checked ? <Check aria-hidden="true" className="mr-1.5 size-4 text-primary-text" /> : null}
      {children}
    </label>
  );
}

function QuickAddForm({ options, presetPlatform, onAdded, onDone }: { options: Ready; presetPlatform: string | null; onAdded: (copies: number | null) => void; onDone: () => void }) {
  const id = useId();
  const firstPlatform = options.platforms.find((p) => p.slug === presetPlatform)?.slug ?? (options.platforms.length === 1 ? options.platforms[0].slug : null);
  const [platform, setPlatform] = useState<string | null>(firstPlatform);
  const [region, setRegion] = useState<string>(UNSURE);
  const [release, setRelease] = useState<string>(NO_RELEASE);
  const [state, action, pending] = useActionState(submit, { status: "idle", message: null, itemId: uuidv7(), count: options.copies });
  const form = useRef<HTMLFormElement>(null);
  const platformInfo = options.platforms.find((p) => p.slug === platform) ?? null;
  // The verified releases for the platform (and region, once chosen): offered, never assumed.
  const releases = options.releases.filter((r) => r.platform === platform && (region === UNSURE || r.region.code === region));
  // A release chosen for another platform or region no longer applies: it reads as none.
  const chosen = releases.find((r) => r.id === release) ?? null;
  const selectedRelease = chosen ? chosen.id : NO_RELEASE;
  const added = state.status === "added" || state.status === "already_added";
  const common = options.regions.filter((r) => COMMON_REGIONS.includes(r.code));
  const others = options.regions.filter((r) => !COMMON_REGIONS.includes(r.code));

  useEffect(() => {
    if (added) onAdded(state.count);
  }, [added, state, onAdded]);

  if (added) {
    const where = [platformInfo?.shortName, options.regions.find((r) => r.code === region)?.label ?? (region ? null : "region not sure")].filter(Boolean).join(" · ");
    return (
      <div className="flex flex-col gap-4" data-quick-add-done="">
        <div role="status" className="flex gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5">
          <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-emerald-400" />
          <div className="text-sm">
            <p className="font-medium">{state.status === "added" ? "Added to your collection" : "This copy was already added"}</p>
            <p className="mt-0.5 text-muted-foreground">
              {options.game.title}
              {where ? ` · ${where}` : ""}
              {chosen ? " · linked to the release you chose" : " · not linked to a specific release"}
            </p>
            {typeof state.count === "number" && state.count > 0 && !chosen ? (
              <p className="mt-1 text-muted-foreground">
                You have {state.count} {state.count === 1 ? "copy" : "copies"} of this game.
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {platformInfo ? (
            <Button asChild variant="secondary" size="lg" className="h-10">
              <Link href={`/collection/systems/${platformInfo.slug}`}>
                <Library aria-hidden="true" />
                See it on your {platformInfo.shortName} shelf
              </Link>
            </Button>
          ) : null}
          <Button
            type="button"
            size="lg"
            className="h-10"
            onClick={() => {
              onDone();
              // Back to finding the next game: the page's search field.
              requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-explore-search] input")?.focus());
            }}
          >
            <Search aria-hidden="true" />
            Add another game
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      ref={form}
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || !platformInfo) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="item_id" value={state.itemId} />
      {chosen ? (
        <>
          <input type="hidden" name="release_id" value={chosen.id} />
          <input type="hidden" name="components" value={JSON.stringify(chosen.components)} />
        </>
      ) : (
        <>
          <input type="hidden" name="game_id" value={options.game.id} />
          <input type="hidden" name="platform_id" value={platformInfo?.id ?? ""} />
          <input type="hidden" name="region" value={region} />
        </>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">Platform</legend>
        <div className="flex flex-wrap gap-2">
          {options.platforms.map((p) => (
            <Chip key={p.slug} name={`${id}-platform`} value={p.slug} checked={platform === p.slug} onChange={setPlatform}>
              {p.name}
            </Chip>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2" disabled={!platform}>
        <legend className="mb-2 text-sm font-semibold">Region</legend>
        <div className="flex flex-wrap gap-2">
          {common.map((r) => (
            <Chip key={r.code} name={`${id}-region`} value={r.code} checked={region === r.code} onChange={setRegion}>
              {r.label}
            </Chip>
          ))}
          <Chip name={`${id}-region`} value={UNSURE} checked={region === UNSURE} onChange={setRegion}>
            Not sure
          </Chip>
        </div>
        {others.length ? (
          <label className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            Another region
            <select
              value={others.some((r) => r.code === region) ? region : ""}
              onChange={(event) => setRegion(event.target.value)}
              className="h-9 rounded-lg border border-white/12 bg-transparent px-2 text-foreground"
            >
              <option value="">Choose…</option>
              {others.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </fieldset>

      {platform && releases.length ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Is your copy one of these verified releases?</legend>
          <p className="mb-1 text-xs text-muted-foreground">Optional. Choose one only if it matches your copy.</p>
          <div className="flex flex-col gap-2">
            <Chip name={`${id}-release`} value={NO_RELEASE} checked={selectedRelease === NO_RELEASE} onChange={setRelease}>
              Not sure, or none of these
            </Chip>
            {releases.map((r) => (
              <Chip key={r.id} name={`${id}-release`} value={r.id} checked={selectedRelease === r.id} onChange={setRelease}>
                <span>
                  {r.region.label} · {r.label}
                </span>
              </Chip>
            ))}
          </div>
        </fieldset>
      ) : null}

      <details className="group rounded-xl border border-white/[0.08] [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-xl px-3.5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring">
          Condition, completeness and purchase <span className="font-normal text-muted-foreground">(optional)</span>
          <ChevronDown aria-hidden="true" className="ml-auto size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <div className="flex flex-col gap-4 border-t border-white/[0.07] p-3.5">
          <CopyFields
            values={{ ...EMPTY_COPY, currency: options.defaultCurrency }}
            mediumLabel={chosen?.mediumLabel ?? "Game"}
            pieces={(chosen?.components ?? []).map((c) => ({ ...c, value: "" }))}
            currencies={options.currencies}
            maxDate={options.maxDate}
          />
        </div>
      </details>

      {state.status === "error" || state.status === "signed_out" ? (
        <p role="alert" className="flex gap-2 text-sm text-destructive">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {state.message}
        </p>
      ) : null}

      <div className="sticky bottom-0 -mx-5 -mb-4 flex items-center gap-3 border-t border-white/[0.07] bg-[#16151c] px-5 py-3">
        <Button type="submit" size="lg" className="h-11 flex-1 sm:flex-none" aria-disabled={pending || !platform || undefined} disabled={!platform}>
          {pending ? <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Plus aria-hidden="true" />}
          {pending ? "Adding…" : "Add to collection"}
        </Button>
        {!platform ? <p className="text-xs text-muted-foreground">Choose a platform first.</p> : null}
      </div>
    </form>
  );
}
