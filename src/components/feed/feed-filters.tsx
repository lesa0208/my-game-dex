import Link from "next/link";

import { FEED_FILTERS, type FeedFilter } from "@/features/feed/filters";
import { cn } from "@/lib/utils";

/** With `active` omitted it renders the loading state, with nothing selected. */
export function FeedFilters({ active }: { active?: FeedFilter }) {
  return (
    <nav
      aria-label="Feed filters"
      className="sticky top-14 z-20 border-b bg-background/90 backdrop-blur md:top-16"
    >
      <ul className="flex">
        {FEED_FILTERS.map(({ value, label, href }) => {
          const isActive = value === active;
          return (
            <li key={value} className="flex-1 md:flex-none">
              <Link
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex h-12 items-center justify-center px-4 text-sm font-medium transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset md:px-5",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
                {isActive ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 -bottom-px h-0.5 bg-primary"
                  />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
