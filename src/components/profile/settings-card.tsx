import type { ReactNode } from "react";

/** A titled panel on a settings page (M11a-3): the admin cards' padding, radius and heading. */
export function SettingsCard({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
      <h2 id={id} className="text-base font-semibold tracking-tight">
        {title}
      </h2>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}
