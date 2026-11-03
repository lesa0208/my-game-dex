import { FlaskConical } from "lucide-react";

import { isSeedDataEnabled } from "@/config/features";

/** Shown whenever seed data is on, so preview content is never mistaken for real. */
export function PreviewNotice() {
  if (!isSeedDataEnabled) return null;

  return (
    <p className="flex gap-2.5 border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground md:mb-4 md:rounded-lg md:border">
      <FlaskConical aria-hidden="true" className="mt-px size-4 shrink-0 text-highlight" />
      <span>
        <strong className="font-medium text-foreground">Preview data.</strong>{" "}
        Posts, collectors, activity and artwork are development placeholders.
        Likes and bookmarks aren&apos;t saved and clear on reload.
      </span>
    </p>
  );
}
