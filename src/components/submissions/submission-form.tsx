"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState, useState } from "react";

import { Field, selectClassName } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type SubmissionState,
  submitToCatalog,
  submitToCatalogFromForm,
  updateMySubmission,
  updateMySubmissionFromForm,
} from "@/features/submissions/actions";
import { EDITION_KINDS, GAME_KINDS, PIECE_KINDS, PIECE_ROWS, REGION_UNKNOWN } from "@/features/submissions/form";
import type { SubmissionOptions } from "@/features/submissions/queries";
import { cn } from "@/lib/utils";

export type SubmissionValues = {
  title: string;
  gameKind: string;
  firstReleaseYear: string;
  platform: string;
  mediaFormat: string;
  region: string;
  editionName: string;
  editionKind: string;
  variantName: string;
  productCode: string;
  barcode: string;
  localTitle: string;
  publisherName: string;
  mediaCount: string;
  packaging: string;
  releaseYear: string;
  pieces: { kind: string; label: string; quantity: string }[];
  note: string;
};

export const EMPTY_SUBMISSION: SubmissionValues = {
  title: "",
  gameKind: "game",
  firstReleaseYear: "",
  platform: "",
  mediaFormat: "",
  region: "",
  editionName: "",
  editionKind: "",
  variantName: "",
  productCode: "",
  barcode: "",
  localTitle: "",
  publisherName: "",
  mediaCount: "",
  packaging: "",
  releaseYear: "",
  pieces: [],
  note: "",
};

/** Keeps the form as typed when the request fails on the way, instead of the error boundary. */
function keepOnFailure(action: (state: SubmissionState, formData: FormData) => Promise<SubmissionState>) {
  return async (state: SubmissionState, formData: FormData): Promise<SubmissionState> => {
    try {
      return await action(state, formData);
    } catch (error) {
      // A redirect after success is how Next.js navigates; it must pass through.
      if (error && typeof error === "object" && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw error;
      return { status: "error", message: "We couldn't confirm it was saved. Check your connection and try again." };
    }
  };
}
const submitFromPage = keepOnFailure(submitToCatalog);
const updateFromPage = keepOnFailure(updateMySubmission);

/**
 * Submits a missing physical release (`release`, of `game`), a new game with its first
 * release (`game`), or changes to an unreviewed submission (`edit`). Required fields
 * first; the rest is optional and collapsed. With JavaScript the format list follows
 * the platform, and a refusal keeps what was typed. Without it every platform's formats
 * are listed, grouped, and the database checks the pair; a submission still lands on
 * its page.
 */
export function SubmissionForm({
  mode,
  game,
  submissionId,
  createdGame = false,
  options,
  values,
}: {
  mode: "release" | "game" | "edit";
  game: { id: string; title: string } | null;
  submissionId?: string;
  createdGame?: boolean;
  options: SubmissionOptions;
  values: SubmissionValues;
}) {
  const editing = mode === "edit";
  const [state, action, pending] = useActionState(editing ? updateFromPage : submitFromPage, { status: "idle", message: null });
  const [platform, setPlatform] = useState(values.platform);
  const formats = platform ? options.formats.filter((f) => f.platform === platform) : options.formats;
  const platformName = (slug: string) => options.platforms.find((p) => p.slug === slug)?.name ?? slug;
  const families = [...new Set(options.platforms.map((p) => p.family))].sort((a, b) => a.localeCompare(b));
  const showGameFields = mode === "game" || (editing && createdGame);

  return (
    <form
      id={editing ? "edit-submission" : "new-submission"}
      action={editing ? updateMySubmissionFromForm : submitToCatalogFromForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col gap-6"
    >
      {editing ? <input type="hidden" name="submission_id" value={submissionId} /> : <input type="hidden" name="mode" value={mode} />}
      {mode === "release" && game ? <input type="hidden" name="game_id" value={game.id} /> : null}

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">The game</legend>
        {showGameFields ? (
          <>
            <Field id="title" label="Title">
              <Input id="title" name="title" required maxLength={200} defaultValue={values.title} autoComplete="off" className="h-10" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="game_kind" label="Type">
                <select id="game_kind" name="game_kind" defaultValue={values.gameKind || "game"} className={selectClassName}>
                  {GAME_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="first_release_year" label="First released (optional)" hint="Leave empty if you don't know.">
                <Input id="first_release_year" name="first_release_year" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} placeholder="YYYY"
                  aria-describedby="first_release_year-hint" defaultValue={values.firstReleaseYear} autoComplete="off" className="h-10" />
              </Field>
            </div>
          </>
        ) : (
          <p className="text-sm">
            <span className="font-medium">{game?.title ?? values.title}</span>
          </p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">The physical release</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {editing ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-sm font-medium">Platform</span>
              <span className="flex h-10 items-center text-sm">{platformName(values.platform)}</span>
            </div>
          ) : (
            <Field id="platform" label="Platform">
              <select id="platform" name="platform" required value={platform} onChange={(e) => setPlatform(e.target.value)} className={selectClassName}>
                <option value="">Choose a platform</option>
                {families.map((family) => (
                  <optgroup key={family} label={family}>
                    {options.platforms.filter((p) => p.family === family).map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>
          )}
          <Field id="media_format" label="Physical format">
            <select key={platform || "all"} id="media_format" name="media_format" required defaultValue={formats.some((f) => f.code === values.mediaFormat) ? values.mediaFormat : formats.length === 1 ? formats[0].code : ""} className={selectClassName}>
              <option value="">Choose a format</option>
              {platform
                ? formats.map((f) => (
                    <option key={f.code} value={f.code}>
                      {f.name}
                    </option>
                  ))
                : options.platforms
                    .filter((p) => options.formats.some((f) => f.platform === p.slug))
                    .map((p) => (
                      <optgroup key={p.slug} label={p.name}>
                        {options.formats.filter((f) => f.platform === p.slug).map((f) => (
                          <option key={`${p.slug}-${f.code}`} value={f.code}>
                            {f.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
            </select>
          </Field>
          <Field id="region" label="Region">
            <select id="region" name="region" required defaultValue={values.region} className={selectClassName}>
              <option value="">Choose a region</option>
              {options.regions.filter((r) => r.code !== REGION_UNKNOWN).map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
              <option value={REGION_UNKNOWN}>Unknown, not confirmed</option>
            </select>
          </Field>
        </div>
      </fieldset>

      <details className="rounded-lg border" open={editing || undefined}>
        <summary className="flex min-h-10 cursor-pointer items-center rounded-lg px-3 text-sm font-medium outline-none select-none focus-visible:ring-3 focus-visible:ring-ring">
          More about this release <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
        </summary>
        <div className="flex flex-col gap-5 border-t p-3">
          <p className="text-xs text-muted-foreground">Only add what&apos;s printed on the package or what you&apos;re sure of. Editors check everything before it&apos;s published.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="edition_name" label="Edition">
              <Input id="edition_name" name="edition_name" maxLength={120} defaultValue={values.editionName} placeholder="Standard, Greatest Hits…" autoComplete="off" className="h-10" />
            </Field>
            <Field id="edition_kind" label="Edition type">
              <select id="edition_kind" name="edition_kind" defaultValue={values.editionKind} className={selectClassName}>
                <option value="">Not sure</option>
                {EDITION_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="variant_name" label="Variant">
              <Input id="variant_name" name="variant_name" maxLength={120} defaultValue={values.variantName} autoComplete="off" className="h-10" />
            </Field>
            <Field id="packaging" label="Packaging">
              <Input id="packaging" name="packaging" maxLength={80} defaultValue={values.packaging} placeholder="Jewel case, big box…" autoComplete="off" className="h-10" />
            </Field>
            <Field id="product_code" label="Product code">
              <Input id="product_code" name="product_code" maxLength={40} defaultValue={values.productCode} autoComplete="off" className="h-10" />
            </Field>
            <Field id="barcode" label="Barcode">
              <Input id="barcode" name="barcode" inputMode="numeric" maxLength={20} defaultValue={values.barcode} autoComplete="off" className="h-10" />
            </Field>
            <Field id="local_title" label="Title on the package">
              <Input id="local_title" name="local_title" maxLength={200} defaultValue={values.localTitle} autoComplete="off" className="h-10" />
            </Field>
            <Field id="publisher_name" label="Publisher">
              <Input id="publisher_name" name="publisher_name" maxLength={120} defaultValue={values.publisherName} autoComplete="off" className="h-10" />
            </Field>
            <Field id="media_count" label="Discs or cartridges">
              <Input id="media_count" name="media_count" inputMode="numeric" maxLength={2} defaultValue={values.mediaCount} autoComplete="off" className="h-10" />
            </Field>
            <Field id="release_year" label="Release year">
              <Input id="release_year" name="release_year" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} placeholder="YYYY" defaultValue={values.releaseYear} autoComplete="off" className="h-10" />
            </Field>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">What came in the box</legend>
            <p className="text-xs text-muted-foreground">Manuals, maps, posters and other original materials. Leave rows empty if you&apos;re not sure.</p>
            {Array.from({ length: PIECE_ROWS }, (_, i) => {
              const piece = values.pieces[i];
              return (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_4.5rem] gap-2">
                  <label className="sr-only" htmlFor={`piece_kind_${i}`}>Piece {i + 1} type</label>
                  <select id={`piece_kind_${i}`} name={`piece_kind_${i}`} defaultValue={piece?.kind ?? "insert"} className={selectClassName}>
                    {PIECE_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <label className="sr-only" htmlFor={`piece_label_${i}`}>Piece {i + 1} name</label>
                  <Input id={`piece_label_${i}`} name={`piece_label_${i}`} maxLength={120} defaultValue={piece?.label ?? ""} placeholder={i === 0 ? "Instruction manual" : ""} autoComplete="off" className="h-10" />
                  <label className="sr-only" htmlFor={`piece_quantity_${i}`}>Piece {i + 1} quantity</label>
                  <Input id={`piece_quantity_${i}`} name={`piece_quantity_${i}`} inputMode="numeric" maxLength={2} defaultValue={piece?.quantity ?? ""} placeholder="1" autoComplete="off" className="h-10" />
                </div>
              );
            })}
          </fieldset>
        </div>
      </details>

      <Field id="note" label="Note for the editors (optional)" hint="Where you saw this release, or anything that helps check it.">
        <textarea id="note" name="note" maxLength={1000} rows={3} defaultValue={values.note} aria-describedby="note-hint" className={cn(selectClassName, "h-auto py-2")} />
      </Field>

      {editing ? null : (
        <div className="flex gap-3 rounded-lg border bg-muted/40 p-3">
          <input id="physical" name="physical" type="checkbox" required className="mt-0.5 size-5 shrink-0 accent-primary-solid" />
          <label htmlFor="physical" className="text-sm">
            This is a physical game release: a cartridge, disc or card with the game on it. Not a download code, an empty box or a manual on its own.
          </label>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="submit" size="lg" className="h-10 px-4" aria-disabled={pending || undefined}>
            {pending ? (editing ? "Saving…" : "Submitting…") : editing ? "Save changes" : "Submit to the catalog"}
          </Button>
          {editing ? null : <p className="text-xs text-muted-foreground">Only you and catalog editors can see it until it&apos;s published. Up to 10 a day.</p>}
        </div>
        <div role="status" aria-live="polite" aria-atomic="true">
          {state.status === "saved" || state.status === "duplicate" ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm">
              <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
              <span className="font-medium">{state.message}</span>
              {state.href ? (
                <Link href={state.href} className="text-primary-text underline underline-offset-4">
                  Open the release
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>
        <div role="alert" aria-live="assertive">
          {state.status === "error" ? (
            <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {state.message}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}

