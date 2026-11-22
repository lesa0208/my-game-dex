"use client";

import { Search } from "lucide-react";
import Form from "next/form";
import Link from "next/link";

import { selectClassName } from "@/components/collection/copy-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PRIORITIES } from "@/features/wishlist/format";
import { hasWishlistFilters, type WishlistParams, wishlistQuery, WISHLIST_SORTS } from "@/features/wishlist/params";

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
 * Search, filters and sort, as a plain GET form to /collection/wishlist: it works
 * without JavaScript and every view has its own URL. The database does the filtering,
 * sorting and paging. Keyed to the view, as the collection's filters are, so a link
 * that changes it starts the fields again from it.
 */
export function WishlistFilters({ params, platforms, regions }: { params: WishlistParams; platforms: { slug: string; name: string }[]; regions: { code: string; label: string }[] }) {
  return (
    <Form key={wishlistQuery({ ...params, cursor: null })} action="/collection/wishlist" role="search" aria-label="Your wishlist" className="mb-4 flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            name="q"
            defaultValue={params.query}
            maxLength={100}
            aria-label="Search your wishlist by title"
            placeholder="Search your wishlist by title"
            className="h-10 bg-card pl-9 dark:bg-card"
          />
        </div>
        <Button type="submit" size="lg" className="h-10 px-4">
          Show wishes
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Choice id="wishlist-platform" name="platform" label="Platform" value={params.platform ?? ""}>
          <option value="">All platforms</option>
          {platforms.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </Choice>
        <Choice id="wishlist-region" name="region" label="Region" value={params.region ?? ""}>
          <option value="">All regions</option>
          {regions.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </Choice>
        <Choice id="wishlist-priority" name="priority" label="Priority" value={params.priority ? String(params.priority) : ""}>
          <option value="">Any</option>
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Choice>
        <Choice id="wishlist-sort" name="sort" label="Sort by" value={params.sort}>
          {WISHLIST_SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Choice>
      </div>
      <p className="text-xs text-muted-foreground">A platform or region filter shows only the wishes that name one.</p>
      {hasWishlistFilters(params) ? (
        <p className="text-sm">
          <Link href={params.sort === "priority" ? "/collection/wishlist" : `/collection/wishlist?sort=${params.sort}`} className="text-primary-text underline underline-offset-4">
            Clear search and filters
          </Link>
        </p>
      ) : null}
    </Form>
  );
}

export function WishlistFiltersSkeleton() {
  return (
    <div aria-hidden="true" className="mb-4 flex flex-col gap-3">
      <Skeleton className="h-10 w-full" />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    </div>
  );
}
