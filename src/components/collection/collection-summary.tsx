import Link from "next/link";

import { copiesLabel } from "@/features/collection/details";
import { collectionHref, type CollectionParams, DEFAULT_PARAMS } from "@/features/collection/list-params";
import type { CollectionSummary } from "@/features/collection/types";
import { cn } from "@/lib/utils";

/**
 * What the collection holds, from `get_my_collection_summary` (M6b). It counts
 * physical copies: two copies of one release are two copies. Each platform links to
 * the list filtered to it.
 */
export function CollectionSummaryView({ summary, params }: { summary: CollectionSummary; params: CollectionParams }) {
  const other = [
    { count: summary.pending, label: "awaiting review" },
    { count: summary.not_approved, label: "not approved" },
    { count: summary.invalid, label: "no longer in the catalog" },
  ].filter((s) => s.count > 0);

  return (
    <section aria-labelledby="collection-summary" className="mb-6 rounded-lg border bg-card p-4">
      <h2 id="collection-summary" className="sr-only">
        Summary
      </h2>
      <p className="text-2xl font-semibold tracking-tight">{copiesLabel(summary.total)}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Physical copies on {summary.platforms.length} {summary.platforms.length === 1 ? "platform" : "platforms"}
        {other.length ? `, including ${other.map((o) => `${o.count} ${o.label}`).join(" and ")}` : ""}.
      </p>
      {summary.platforms.length > 1 ? (
        <ul aria-label="Copies by platform" className="mt-3 flex flex-wrap gap-1.5">
          {summary.platforms.map((platform) => {
            const current = params.platform === platform.slug;
            return (
              <li key={platform.slug}>
                <Link
                  href={collectionHref({ ...DEFAULT_PARAMS, sort: params.sort, platform: current ? null : platform.slug })}
                  aria-current={current ? "true" : undefined}
                  title={platform.name}
                  className={cn(
                    "inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring",
                    current ? "border-primary bg-primary/10 font-medium text-foreground" : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {platform.short_name}
                  <span className="text-muted-foreground">{platform.count}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
