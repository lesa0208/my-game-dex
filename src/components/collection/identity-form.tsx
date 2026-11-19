"use client";

import { CircleAlert } from "lucide-react";
import { startTransition, useActionState, useId } from "react";

import { selectClassName } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { changeIdentity, changeIdentityFromForm, type IdentityState } from "@/features/collection/claim-actions";
import { EDITION_KIND_OPTIONS, EDITION_NAME_SUGGESTIONS } from "@/features/collection/details";

/**
 * M12b: what a copy is, as its owner says, when it isn't linked to a release: its
 * region and edition, each of which can be "not sure". For a copy of a release, the
 * same form leaves it unidentified, starting from the release's region and edition.
 * The game and platform stay as they are. The change is saved through
 * set_my_copy_identity (M12a), which keeps everything else about the copy and records
 * the change in its private history; success returns to the copy's page.
 */
export function IdentityForm({
  itemId,
  gameId,
  platformId,
  regions,
  values,
  unlink,
  back,
}: {
  itemId: string;
  gameId: string;
  platformId: string;
  regions: { code: string; label: string }[];
  values: { region: string | null; editionKind: string | null; editionName: string | null };
  /** A copy of a release: saving leaves it without one. */
  unlink: boolean;
  back: [string, string][];
}) {
  const [state, action, pending] = useActionState<IdentityState, FormData>(changeIdentity, { status: "idle", message: null });
  const id = useId();
  return (
    <form
      action={changeIdentityFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="item_id" value={itemId} />
      <input type="hidden" name="game_id" value={gameId} />
      <input type="hidden" name="platform_id" value={platformId} />
      {back.map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-region`} className="text-sm font-medium">
            Region
          </label>
          <select id={`${id}-region`} name="region" defaultValue={values.region ?? ""} className={selectClassName}>
            <option value="">Not sure</option>
            {regions.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-edition-name`} className="text-sm font-medium">
            Edition name
          </label>
          <Input
            id={`${id}-edition-name`}
            name="edition_name"
            maxLength={80}
            defaultValue={values.editionName ?? ""}
            list={`${id}-edition-names`}
            placeholder="Not sure"
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
            Edition type
          </label>
          <select id={`${id}-edition-kind`} name="edition_kind" defaultValue={values.editionKind ?? ""} className={selectClassName}>
            <option value="">Not sure</option>
            {EDITION_KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" size="lg" variant={unlink ? "secondary" : "default"} className="h-10" aria-disabled={pending || undefined}>
          {pending ? "Saving…" : unlink ? "Keep it without a release" : "Save"}
        </Button>
        <p className="text-xs text-muted-foreground">Everything else you recorded stays as it is. The change is kept in this copy&apos;s private history.</p>
      </div>
      <div role="alert" aria-live="assertive">
        {state.status === "error" ? (
          <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
