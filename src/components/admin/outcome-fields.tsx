"use client";

import { useEffect, useId, useRef, useState } from "react";

import { adminHint, adminLabel, adminSelect, adminTextarea } from "@/components/admin/form-controls";
import { CRITICAL_ERRORS, EVIDENCE_GUIDANCE, evidenceNoteOk, OUTCOME_DETAILS, OUTCOME_LABELS, type Outcome } from "@/features/batches/form";

/**
 * The fields of a batch member's outcome (M14c-2), inside the shared EditForm. Nothing is
 * chosen or written for the editor: no outcome is preselected (unless only one is possible), and
 * the note is never filled in. The live check on the note only tells them what the database will
 * refuse; it decides.
 *
 * Every field is in the page as served, so the form works without JavaScript: the critical error,
 * the note and the confirmation, with wording that covers whichever outcome is chosen. With
 * JavaScript the wording follows the choice, the critical error is switched off for "correct",
 * and the confirmation is cleared whenever the outcome changes, so it is always given for the
 * outcome it names.
 */
export function OutcomeFields({ options, keepCriticalError, platform }: { options: Outcome[]; keepCriticalError: string | null; platform: string }) {
  const id = useId();
  const [outcome, setOutcome] = useState<Outcome | null>(options.length === 1 ? options[0] : null);
  const [note, setNote] = useState("");
  const noteField = useRef<HTMLTextAreaElement>(null);
  // EditForm puts back a note kept across a step-up after this mounts; pick it up for the check.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setNote(noteField.current?.value ?? ""));
    return () => cancelAnimationFrame(frame);
  }, []);
  const correct = outcome === "correct";
  const ok = evidenceNoteOk(note.trim() ? note : null);
  const length = [...note].length;
  const canBeCorrect = options.includes("correct");

  const confirmText = correct
    ? `I checked this evidence myself, and it shows a physical copy of this game exists on ${platform}. The outcome is final.`
    : outcome === "incorrect"
      ? "I understand this is final: a member found incorrect can later only be excluded, and nothing here undoes it except rejecting the batch."
      : outcome === "excluded"
        ? "I understand this is final: an excluded member's outcome can't change, except by rejecting the batch."
        : `I checked the evidence for the outcome I chose myself (for Correct: evidence that a physical copy exists on ${platform}), and I understand the outcome is final.`;

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className={`${adminLabel} mb-1`}>Outcome</legend>
        {options.map((o) => (
          <div key={o} className="flex gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/10">
            <input
              id={`${id}-${o}`}
              type="radio"
              name="outcome"
              value={o}
              required
              checked={outcome === o}
              onChange={() => setOutcome(o)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <label htmlFor={`${id}-${o}`} className="flex flex-col gap-0.5 text-sm">
              <span className="font-medium">{OUTCOME_LABELS[o]}</span>
              <span className="text-muted-foreground">{OUTCOME_DETAILS[o]}</span>
            </label>
          </div>
        ))}
      </fieldset>

      {keepCriticalError ? (
        <div className="flex flex-col gap-1.5">
          <input type="hidden" name="critical_error" value={keepCriticalError} />
          <p className={adminLabel}>Critical error</p>
          <p className="text-sm">{(CRITICAL_ERRORS as Record<string, string>)[keepCriticalError] ?? keepCriticalError}</p>
          <p className={adminHint}>Recorded with the earlier finding. A critical error is never cleared or replaced.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-critical`} className={adminLabel}>
            Critical error (optional{canBeCorrect ? ", not with Correct" : ""})
          </label>
          {/* Switched off (and so not sent) for "correct", which takes none. */}
          <select id={`${id}-critical`} name="critical_error" defaultValue="" disabled={correct} aria-describedby={`${id}-critical-hint`} className={adminSelect}>
            <option value="">None</option>
            {Object.entries(CRITICAL_ERRORS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
          <p id={`${id}-critical-hint`} className={adminHint}>
            {correct
              ? "A member found correct has no critical error."
              : "For Incorrect or Excluded: choose one if the error would make the catalog wrong. A batch with a critical error marked incorrect can't be approved until it is excluded or the batch is rejected."}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-note`} className={adminLabel}>
          {correct ? "Physical evidence (required)" : outcome ? "Note (optional)" : canBeCorrect ? "Physical evidence, or a note" : "Note (optional)"}
        </label>
        {canBeCorrect && (correct || !outcome) ? (
          <p id={`${id}-note-guidance`} className={adminHint}>
            {correct ? "" : "Required for Correct, optional otherwise. "}
            {EVIDENCE_GUIDANCE}
          </p>
        ) : null}
        <textarea
          ref={noteField}
          id={`${id}-note`}
          name="note"
          required={correct}
          maxLength={correct ? 500 : 1000}
          rows={4}
          defaultValue=""
          onChange={(e) => setNote(e.target.value)}
          autoComplete="off"
          spellCheck
          aria-describedby={[canBeCorrect && (correct || !outcome) ? `${id}-note-guidance` : null, `${id}-note-check`].filter(Boolean).join(" ")}
          aria-invalid={correct && note.length > 0 && !ok ? true : undefined}
          className={adminTextarea}
        />
        <p id={`${id}-note-check`} className={adminHint}>
          {correct
            ? ok
              ? `${length} characters. This is kept exactly as written, with your handle, and becomes the pairing's evidence when the batch is approved.`
              : `${length} of at least 20 characters, with at least 10 letters or digits (500 at most).`
            : `${length} of 1,000 characters. Other catalog staff can read it.`}
        </p>
        {/* Announced only when the evidence becomes enough, or stops being enough: not on every keystroke. */}
        <p aria-live="polite" className="sr-only">
          {correct && note.length > 0 ? (ok ? "The evidence note is long enough." : "The evidence note isn't long enough yet.") : ""}
        </p>
      </div>

      <div className="flex gap-3 rounded-lg border bg-muted/40 p-3">
        <input key={outcome ?? "none"} id={`${id}-confirm`} name="confirm" type="checkbox" required className="mt-0.5 size-5 shrink-0 accent-primary-solid" />
        <label htmlFor={`${id}-confirm`} className="text-sm">
          {confirmText}
        </label>
      </div>
    </div>
  );
}
