import type { ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { COMPLETENESS, componentField, CONDITIONS, conditionLabel, NOT_INCLUDED, NOT_RECORDED } from "@/features/collection/details";
import { cn } from "@/lib/utils";

/**
 * The fields of one physical copy, shared by the add form (M6c) and the edit form
 * (M6d). Every field starts at "Not recorded" unless the copy says otherwise, and
 * "Not included" is a separate, deliberate choice, offered only for parts a copy can
 * lack: its box or case and its manual. Pieces come from the release's catalog
 * listing; nothing here assumes a copy has packaging or a manual.
 */

export const selectClassName =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring dark:bg-input/30";

export type CopyFieldValues = {
  completeness: string | null;
  media_condition: string | null;
  box_condition: string | null;
  manual_condition: string | null;
  overall_condition: string | null;
  acquired_on: string | null;
  storage_location: string | null;
  purchase_price: string | null;
  currency: string | null;
  notes: string | null;
};

export const EMPTY_COPY: CopyFieldValues = {
  completeness: null,
  media_condition: null,
  box_condition: null,
  manual_condition: null,
  overall_condition: null,
  acquired_on: null,
  storage_location: null,
  purchase_price: null,
  currency: null,
  notes: null,
};

/** A piece the release lists, with the value its field starts at ("", "included", "missing" or a grade). */
export type PieceField = { kind: string; label: string; quantity: number | null; value: string };

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Grade({ id, label, absent, value }: { id: string; label: string; absent: boolean; value: string | null }) {
  return (
    <Field id={id} label={label}>
      <select id={id} name={id} defaultValue={value ?? ""} className={selectClassName}>
        <option value="">{NOT_RECORDED}</option>
        {CONDITIONS.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
        {absent ? <option value={NOT_INCLUDED.value}>{NOT_INCLUDED.label}</option> : null}
      </select>
    </Field>
  );
}

export function CopyFields({
  values,
  mediumLabel,
  pieces,
  currencies,
  maxDate,
}: {
  values: CopyFieldValues;
  mediumLabel: string;
  pieces: PieceField[];
  currencies: { code: string; name: string }[];
  maxDate: string;
}) {
  return (
    <>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">This copy</legend>
        <Field id="completeness" label="Completeness" hint="Leave as not recorded if you're not sure.">
          <select id="completeness" name="completeness" defaultValue={values.completeness ?? ""} aria-describedby="completeness-hint" className={selectClassName}>
            <option value="">{NOT_RECORDED}</option>
            {COMPLETENESS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Grade id="media_condition" label={`${mediumLabel} condition`} absent={false} value={values.media_condition} />
          <Grade id="box_condition" label="Box or case condition" absent value={values.box_condition} />
          <Grade id="manual_condition" label="Manual condition" absent value={values.manual_condition} />
          <Grade id="overall_condition" label="Overall condition" absent={false} value={values.overall_condition} />
        </div>
      </fieldset>

      {pieces.length ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Pieces listed for this release</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {pieces.map((piece, index) => {
              const graded = CONDITIONS.some((c) => c.value === piece.value);
              return (
                <Field
                  key={`${piece.kind}-${piece.label}`}
                  id={componentField(index)}
                  label={piece.quantity && piece.quantity > 1 ? `${piece.quantity} × ${piece.label}` : piece.label}
                >
                  <select id={componentField(index)} name={componentField(index)} defaultValue={piece.value} className={selectClassName}>
                    <option value="">{NOT_RECORDED}</option>
                    <option value="included">Included</option>
                    {graded ? <option value={piece.value}>Included, {conditionLabel(piece.value).toLowerCase()}</option> : null}
                    <option value="missing">Missing</option>
                  </select>
                </Field>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">Only you can see these</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="acquired_on" label="Acquired on">
            <Input id="acquired_on" name="acquired_on" type="date" min="1970-01-01" max={maxDate} defaultValue={values.acquired_on ?? ""} className="h-10" />
          </Field>
          <Field id="storage_location" label="Storage location">
            <Input id="storage_location" name="storage_location" maxLength={120} autoComplete="off" defaultValue={values.storage_location ?? ""} className="h-10" />
          </Field>
          <Field id="purchase_price" label="Price paid">
            <Input id="purchase_price" name="purchase_price" inputMode="decimal" autoComplete="off" placeholder="0.00" defaultValue={values.purchase_price ?? ""} className="h-10" />
          </Field>
          <Field id="currency" label="Currency">
            <select id="currency" name="currency" defaultValue={values.currency ?? ""} className={selectClassName}>
              <option value="">Choose a currency</option>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field id="notes" label="Notes">
          <textarea id="notes" name="notes" maxLength={5000} rows={3} defaultValue={values.notes ?? ""} className={cn(selectClassName, "h-auto py-2")} />
        </Field>
      </fieldset>
    </>
  );
}
