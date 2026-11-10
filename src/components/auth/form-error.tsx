import { CircleAlert } from "lucide-react";

/** A form's error, announced when it appears. Always rendered, so the live region exists first. */
export function FormError({ id, message }: { id: string; message: string | null }) {
  return (
    <div id={id} role="alert" aria-live="assertive">
      {message ? (
        <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{message}</span>
        </p>
      ) : null}
    </div>
  );
}
