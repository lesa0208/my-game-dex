"use client";

import Form from "next/form";
import { useRef } from "react";

import { SearchAutocomplete } from "@/components/catalog/search-autocomplete";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { CatalogPlatform } from "@/features/catalog/types";
import { cn } from "@/lib/utils";

const selectClassName =
  "select-chevron h-12 w-full min-w-0 appearance-none rounded-xl border border-input bg-card pr-9 pl-3.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring md:w-64 md:text-sm dark:bg-input/30";

/**
 * Explore's search (M17a): suggestions while typing, and a platform list of the systems
 * that have games, with their counts, which applies as soon as one is chosen. Search
 * runs the full results page. Submits to /explore, so it works without JavaScript too
 * (the platform then applies with Search).
 */
export function CatalogSearchForm({ query, platform, platforms, large = false }: { query: string; platform: string | null; platforms: CatalogPlatform[]; large?: boolean }) {
  const form = useRef<HTMLFormElement>(null);
  // Systems with games to browse; one chosen by its address stays listed even without.
  const listed = platforms.filter((p) => p.gameCount > 0 || p.slug === platform).sort((a, b) => a.name.localeCompare(b.name, "en"));
  return (
    <Form ref={form} action="/explore" role="search" aria-label="Catalog" className={cn("flex flex-col gap-2 md:flex-row", large && "md:gap-3")} data-explore-search="">
      <SearchAutocomplete
        className="min-w-0 flex-1"
        label="Search by title, other title, product code or barcode"
        placeholder="Search games by title, product code or barcode"
        defaultValue={query}
        large
        inputClassName="rounded-xl bg-card dark:bg-card"
      />
      <label className="sr-only" htmlFor="catalog-platform">
        Platform
      </label>
      <select
        id="catalog-platform"
        name="platform"
        defaultValue={platform ?? ""}
        key={platform ?? ""}
        className={selectClassName}
        onChange={() => form.current?.requestSubmit()}
      >
        <option value="">All systems</option>
        {listed.map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.name} ({p.gameCount.toLocaleString("en")})
          </option>
        ))}
      </select>
      <Button type="submit" size="lg" className="h-12 rounded-xl px-6">
        Search
      </Button>
    </Form>
  );
}

export function CatalogSearchFormSkeleton() {
  return (
    <div className="flex flex-col gap-2 md:flex-row" aria-hidden="true">
      <Skeleton className="h-12 flex-1 rounded-xl" />
      <Skeleton className="h-12 rounded-xl md:w-64" />
      <Skeleton className="h-12 rounded-xl md:w-24" />
    </div>
  );
}
