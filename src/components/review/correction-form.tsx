"use client";

import { CircleAlert } from "lucide-react";
import { startTransition, useActionState, useState } from "react";

import { Field, selectClassName } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { correctSubmission, correctSubmissionFromForm, type ReviewState } from "@/features/review/actions";
import { type GameRecord, type Piece, PIECE_LIMIT, pieceRows, type ReleaseRecord } from "@/features/review/form";
import { EDITION_KINDS, GAME_KINDS } from "@/features/submissions/form";

function keepOnFailure(action: (state: ReviewState, formData: FormData) => Promise<ReviewState>) {
  return async (state: ReviewState, formData: FormData): Promise<ReviewState> => {
    try {
      return await action(state, formData);
    } catch (error) {
      if (error && typeof error === "object" && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw error;
      return { status: "error", message: "We couldn't confirm it was saved. Check your connection and try again." };
    }
  };
}
const correct = keepOnFailure(correctSubmission);

function Errors({ state }: { state: ReviewState }) {
  return (
    <div role="alert" aria-live="assertive">
      {state.status === "error" ? (
        <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

function Reason({ id }: { id: string }) {
  return (
    <Field id={`${id}-reason`} label="Reason, for the record" hint="Kept in the audit log. Only editors see it.">
      <Input id={`${id}-reason`} name="reason" required maxLength={500} autoComplete="off" aria-describedby={`${id}-reason-hint`} className="h-10" />
    </Field>
  );
}

/**
 * Corrects the pieces a submission's release lists, with the M5a editor function: the
 * same kinds, names, quantities and limit as the submission form. Starts from the list
 * as it is now; clearing a name removes that piece from the release. Copies keep their
 * records of it, as no longer listed. Works without JavaScript.
 */
export function PiecesForm({ requestId, revision, pieces, kinds }: { requestId: string; revision: number; pieces: Piece[]; kinds: readonly { value: string; label: string }[] }) {
  const [state, action, pending] = useActionState(correct, { status: "idle", message: null });
  const id = "correct-pieces";
  const rows = pieceRows(pieces.length);
  return (
    <form
      id={id}
      action={correctSubmissionFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="target" value="pieces" />
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="revision" value={revision} />
      <input type="hidden" name="piece_rows" value={rows} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Pieces in the box</legend>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          Manuals, maps, posters and other original materials, up to {PIECE_LIMIT}. Clear a name to remove that piece; collectors&apos; copies keep their record of it.
        </p>
        {Array.from({ length: rows }, (_, i) => {
          const piece = pieces[i];
          return (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_4.5rem] gap-2">
              <label className="sr-only" htmlFor={`${id}-kind-${i}`}>
                Piece {i + 1} type
              </label>
              <select id={`${id}-kind-${i}`} name={`piece_kind_${i}`} defaultValue={piece?.kind ?? "insert"} className={selectClassName}>
                {kinds.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor={`${id}-label-${i}`}>
                Piece {i + 1} name
              </label>
              <Input id={`${id}-label-${i}`} name={`piece_label_${i}`} maxLength={120} defaultValue={piece?.label ?? ""} autoComplete="off" aria-describedby={`${id}-hint`} className="h-10" />
              <label className="sr-only" htmlFor={`${id}-quantity-${i}`}>
                Piece {i + 1} quantity
              </label>
              <Input
                id={`${id}-quantity-${i}`}
                name={`piece_quantity_${i}`}
                inputMode="numeric"
                maxLength={2}
                defaultValue={piece ? String(piece.quantity) : ""}
                placeholder="1"
                autoComplete="off"
                className="h-10"
              />
            </div>
          );
        })}
      </fieldset>
      <Reason id={id} />
      <div>
        <Button type="submit" variant="outline" size="lg" className="h-10 px-4" aria-disabled={pending || undefined}>
          {pending ? "Saving…" : "Save the pieces"}
        </Button>
      </div>
      <Errors state={state} />
    </form>
  );
}

/**
 * Corrects a submission in review, with the M5a editor functions: the release's
 * details, or a new game's title, type and year. Starts from the record as it is now;
 * only what changes is saved. Works without JavaScript.
 */
export function CorrectionForm(
  props:
    | { target: "release"; requestId: string; revision: number; release: ReleaseRecord; regions: { code: string; label: string }[] }
    | { target: "game"; requestId: string; revision: number; game: GameRecord },
) {
  const [state, action, pending] = useActionState(correct, { status: "idle", message: null });
  const id = `correct-${props.target}`;
  const [region, setRegion] = useState(props.target === "release" ? props.release.region_code : "");
  return (
    <form
      id={id}
      action={correctSubmissionFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="target" value={props.target} />
      <input type="hidden" name="request_id" value={props.requestId} />
      <input type="hidden" name="revision" value={props.revision} />
      {props.target === "game" ? (
        <>
          <Field id={`${id}-title`} label="Title">
            <Input id={`${id}-title`} name="title" required maxLength={200} defaultValue={props.game.title} autoComplete="off" className="h-10" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={`${id}-kind`} label="Type">
              <select id={`${id}-kind`} name="kind" defaultValue={props.game.kind} className={selectClassName}>
                {GAME_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={`${id}-year`} label="First released (optional)">
              <Input
                id={`${id}-year`}
                name="first_release_year"
                inputMode="numeric"
                maxLength={4}
                defaultValue={props.game.first_release_year ? String(props.game.first_release_year) : ""}
                autoComplete="off"
                className="h-10"
              />
            </Field>
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={`${id}-edition_name`} label="Edition">
              <Input id={`${id}-edition_name`} name="edition_name" maxLength={120} defaultValue={props.release.edition_name ?? ""} autoComplete="off" className="h-10" />
            </Field>
            <Field id={`${id}-edition_kind`} label="Edition type">
              <select id={`${id}-edition_kind`} name="edition_kind" defaultValue={props.release.edition_kind ?? ""} className={selectClassName}>
                <option value="">Not recorded</option>
                {EDITION_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={`${id}-media_count`} label="Discs or cartridges">
              <Input
                id={`${id}-media_count`}
                name="media_count"
                inputMode="numeric"
                maxLength={2}
                defaultValue={props.release.media_count ? String(props.release.media_count) : ""}
                autoComplete="off"
                className="h-10"
              />
            </Field>
            <Field id={`${id}-region_code`} label="Region">
              <select id={`${id}-region_code`} name="region_code" value={region} onChange={(e) => setRegion(e.target.value)} className={selectClassName}>
                {props.regions.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.code === "unknown" ? "Unknown" : r.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {region === "unknown" ? (
            <div className="flex gap-3 rounded-lg border bg-muted/40 p-3">
              <input
                id={`${id}-confirm`}
                name="region_unknown_confirmed"
                type="checkbox"
                defaultChecked={props.release.region_unknown_confirmed}
                className="mt-0.5 size-5 shrink-0 accent-primary-solid"
              />
              <label htmlFor={`${id}-confirm`} className="text-sm">
                I confirm the region can&apos;t be determined from the evidence. An unknown region is published only with this confirmation.
              </label>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={`${id}-variant_name`} label="Variant">
              <Input id={`${id}-variant_name`} name="variant_name" maxLength={120} defaultValue={props.release.variant_name ?? ""} autoComplete="off" className="h-10" />
            </Field>
            <Field id={`${id}-packaging`} label="Packaging">
              <Input id={`${id}-packaging`} name="packaging" maxLength={80} defaultValue={props.release.packaging ?? ""} autoComplete="off" className="h-10" />
            </Field>
            <Field id={`${id}-product_code`} label="Product code">
              <Input id={`${id}-product_code`} name="product_code" maxLength={40} defaultValue={props.release.product_code ?? ""} autoComplete="off" className="h-10" />
            </Field>
            <Field id={`${id}-barcode`} label="Barcode">
              <Input id={`${id}-barcode`} name="barcode" inputMode="numeric" maxLength={20} defaultValue={props.release.barcode ?? ""} autoComplete="off" className="h-10" />
            </Field>
            <Field id={`${id}-local_title`} label="Title on the package">
              <Input id={`${id}-local_title`} name="local_title" maxLength={200} defaultValue={props.release.local_title ?? ""} autoComplete="off" className="h-10" />
            </Field>
            <Field id={`${id}-publisher_name`} label="Publisher">
              <Input id={`${id}-publisher_name`} name="publisher_name" maxLength={120} defaultValue={props.release.publisher_name ?? ""} autoComplete="off" className="h-10" />
            </Field>
            <Field id={`${id}-release_year`} label="Release year">
              <Input
                id={`${id}-release_year`}
                name="release_year"
                inputMode="numeric"
                maxLength={4}
                defaultValue={props.release.release_date ? props.release.release_date.slice(0, 4) : ""}
                autoComplete="off"
                className="h-10"
              />
            </Field>
          </div>
        </>
      )}
      <Reason id={id} />
      <div>
        <Button type="submit" variant="outline" size="lg" className="h-10 px-4" aria-disabled={pending || undefined}>
          {pending ? "Saving…" : props.target === "game" ? "Save the game's corrections" : "Save the release's corrections"}
        </Button>
      </div>
      <Errors state={state} />
    </form>
  );
}
