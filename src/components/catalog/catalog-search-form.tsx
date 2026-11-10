import { Search } from "lucide-react";
import Form from "next/form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { CatalogPlatform } from "@/features/catalog/types";

const selectClassName =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-card px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring md:w-56 md:text-sm dark:bg-input/30";

/**
 * Submits to /explore, without JavaScript too. Every platform in the catalog is a
 * choice, grouped by family, with how many games it has so far.
 */
export function CatalogSearchForm({
  query,
  platform,
  platforms,
}: {
  query: string;
  platform: string | null;
  platforms: CatalogPlatform[];
}) {
  const families = [...new Set(platforms.map((p) => p.family))].sort((a, b) => a.localeCompare(b));
  return (
    <Form action="/explore" role="search" aria-label="Catalog" className="mb-6 flex flex-col gap-2 md:flex-row">
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          name="q"
          defaultValue={query}
          maxLength={100}
          aria-label="Title, alias, product code or barcode"
          placeholder="Title, alias, product code or barcode"
          className="h-10 bg-card pl-9 dark:bg-card"
        />
      </div>
      <label className="sr-only" htmlFor="catalog-platform">
        Platform
      </label>
      <select id="catalog-platform" name="platform" defaultValue={platform ?? ""} className={selectClassName}>
        <option value="">All platforms</option>
        {families.map((family) => (
          <optgroup key={family} label={family}>
            {platforms
              .filter((p) => p.family === family)
              .map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name} ({p.gameCount})
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <Button type="submit" size="lg" className="h-10 px-4">
        Search
      </Button>
    </Form>
  );
}

export function CatalogSearchFormSkeleton() {
  return (
    <div className="mb-6 flex flex-col gap-2 md:flex-row" aria-hidden="true">
      <Skeleton className="h-10 flex-1" />
      <Skeleton className="h-10 md:w-56" />
      <Skeleton className="h-10 md:w-20" />
    </div>
  );
}
