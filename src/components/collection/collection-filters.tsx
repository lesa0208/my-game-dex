"use client";

import { Search } from "lucide-react";
import Form from "next/form";
import Link from "next/link";

import { selectClassName } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { collectionQuery, COMPLETENESS_FILTERS, type CollectionParams, hasFilters, SORTS, STATUSES } from "@/features/collection/list-params";
import type { CollectionSummary } from "@/features/collection/types";

function Choice({ id, name, label, value, children }: { id: string; name: string; label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <select id={id} name={name} defaultValue={value} className={selectClassName}>
        {children}
      </select>
    </div>
  );
}

/**
 * Search, filters and sort for the list. A plain GET form to /collection, so it works
 * without JavaScript and every view has its own URL. The database does the filtering,
 * sorting and paging; the browser never holds more than one page.
 *
 * A client component only so the form can be keyed to the view: when a link (a
 * platform, or "Clear") changes the view, the fields start again from it instead of
 * keeping what they showed before. (Keying the element from the server page instead
 * duplicated the form after hydration.)
 */
export function CollectionFilters({ params, summary }: { params: CollectionParams; summary: CollectionSummary }) {
  const showStatus = summary.total > summary.owned || params.status !== null;
  return (
    <Form key={collectionQuery({ ...params, cursor: null })} action="/collection" role="search" aria-label="Your collection" className="mb-4 flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            name="q"
            defaultValue={params.query}
            maxLength={100}
            aria-label="Search your collection by title"
            placeholder="Search your collection by title"
            className="h-10 bg-card pl-9 dark:bg-card"
          />
        </div>
        <Button type="submit" size="lg" className="h-10 px-4">
          Show copies
        </Button>
      </div>
      <div className={`grid grid-cols-2 gap-2 ${showStatus ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
        <Choice id="collection-platform" name="platform" label="Platform" value={params.platform ?? ""}>
          <option value="">All platforms</option>
          {summary.platforms.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name} ({p.count})
            </option>
          ))}
        </Choice>
        <Choice id="collection-completeness" name="completeness" label="Completeness" value={params.completeness ?? ""}>
          <option value="">Any</option>
          {COMPLETENESS_FILTERS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Choice>
        {showStatus ? (
          <Choice id="collection-status" name="status" label="Catalog status" value={params.status ?? ""}>
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Choice>
        ) : null}
        <Choice id="collection-sort" name="sort" label="Sort by" value={params.sort}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Choice>
      </div>
      {hasFilters(params) ? (
        <p className="text-sm">
          <Link href={params.sort === "added" ? "/collection" : `/collection?sort=${params.sort}`} className="text-primary-text underline underline-offset-4">
            Clear search and filters
          </Link>
        </p>
      ) : null}
    </Form>
  );
}

export function CollectionFiltersSkeleton() {
  return (
    <div aria-hidden="true" className="mb-4 flex flex-col gap-3">
      <Skeleton className="h-10 w-full" />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    </div>
  );
}
