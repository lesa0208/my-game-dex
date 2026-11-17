import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The admin panel's form controls and form layouts (post-M10 polish). One height
 * (40px), radius, padding, border, surface and focus ring for every text input,
 * select, date and textarea, so controls in a row line up whatever their kind.
 * Native elements throughout: keyboard behaviour, labels and validation are the
 * browser's own. Collector pages keep their own controls.
 */

const base =
  "w-full min-w-0 rounded-lg border border-input bg-input/30 text-sm text-foreground shadow-none outline-none transition-[border-color,box-shadow,background-color] " +
  "placeholder:text-muted-foreground hover:border-foreground/25 " +
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 " +
  "disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-transparent read-only:hover:border-input " +
  "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/30";

/** A text, search, number or date input. Pass it to `<Input className>`. */
export const adminControl = cn(base, "h-10 px-3 py-0 md:text-sm");

/**
 * A native select at the same height as an input, with its own chevron so its text
 * sits at the same inset as an input's in every browser.
 */
export const adminSelect = cn(
  base,
  "h-10 cursor-pointer appearance-none select-chevron pr-9 pl-3",
  "[&>option]:bg-card [&>option]:text-foreground",
);

/** A date input: the native picker's parts take focus inside it, so the ring follows focus-within. */
export const adminDate = cn(adminControl, "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 [color-scheme:dark]");

/** A multi-line text field, at the same inset and radius as an input. */
export const adminTextarea = cn(base, "min-h-24 px-3 py-2 leading-relaxed");

/** A field's label: always text-sm on one 20px line, which FieldAction counts on. */
export const adminLabel = "text-sm leading-5 font-medium";

/** Helper text under a control. */
export const adminHint = "text-xs leading-5 text-muted-foreground";

/** Label, then the control, then its helper text: the order every admin field uses. */
export function AdminField({
  id,
  label,
  hint,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  /** Shown under the control; give the control aria-describedby={`${id}-hint`}. */
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className={adminLabel}>
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className={adminHint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Fields in a responsive grid: one column on a phone, two from 640px, and up to
 * `columns` on a wide screen. Fields start at the same top, so a helper line under
 * one never pushes its neighbour's control out of line.
 */
export function FieldGrid({ columns = 2, className, children }: { columns?: 2 | 3 | 4; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid items-start gap-x-4 gap-y-4 sm:grid-cols-2",
        columns === 3 && "lg:grid-cols-3",
        columns === 4 && "lg:grid-cols-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A form's buttons, in one row that wraps: the primary action first. */
export function FormActions({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

/**
 * One field and its button side by side from 640px, stacked on a phone. The button
 * lines up with the control, not with the label above it or the helper text below.
 */
export function InlineFieldRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3", className)}>{children}</div>;
}

/** The button half of an InlineFieldRow: offset by one label line (20px) and the 6px gap. */
export function FieldAction({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-wrap gap-2 sm:pt-6.5", className)}>{children}</div>;
}
