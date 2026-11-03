import type { ReactNode } from "react";

/** Central content column with an optional contextual sidebar on wider screens. */
export function PageLayout({
  children,
  aside,
}: {
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1120px] justify-center gap-8 px-0 md:px-6 md:py-6 wide:gap-12">
      <div className="w-full max-w-160 min-w-0">{children}</div>
      {aside ? (
        <aside
          aria-label="Discover"
          // Scrolls on short screens; most of its content has no focusable
          // element, so the region itself must be reachable by keyboard.
          tabIndex={0}
          className="sticky top-22 hidden max-h-[calc(100dvh-6.5rem)] w-80 shrink-0 self-start overflow-y-auto rounded-lg outline-none [scrollbar-width:thin] focus-visible:ring-3 focus-visible:ring-ring xl:block"
        >
          {aside}
        </aside>
      ) : null}
    </div>
  );
}
