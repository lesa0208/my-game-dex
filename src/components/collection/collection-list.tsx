import Link from "next/link";

import { CatalogCover } from "@/components/games/catalog-cover";
import { Skeleton } from "@/components/ui/skeleton";
import { completenessLabel, conditionLabel, copyStatusLabel, formatDay, releaseLine } from "@/features/collection/details";
import { type CollectionParams, copyHref } from "@/features/collection/list-params";
import type { CopyNumber } from "@/features/collection/queries";
import type { CollectionEntry } from "@/features/collection/types";
import type { PreservedTitle } from "@/features/exclusion/queries";

const cardClassName =
  "flex gap-3 rounded-lg border bg-card p-3 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring";

/** What tells this copy apart: its number among copies of the release, and what was recorded. */
function copyFacts(item: CollectionEntry, number: CopyNumber | undefined, sort: CollectionParams["sort"]) {
  const facts: string[] = [];
  // Both numbers come from one read, so they agree. Unnumbered, the count alone is shown.
  if (number && number.total > 1) facts.push(`Copy ${number.number} of ${number.total}`);
  else if (!number && item.copies_of_release > 1) facts.push(`${item.copies_of_release} copies of this release`);
  if (item.completeness) facts.push(completenessLabel(item.completeness));
  if (item.conditions.overall) facts.push(`${conditionLabel(item.conditions.overall)} overall`);
  if (item.storage_location) facts.push(item.storage_location);
  facts.push(sort === "acquired" && item.acquired_on ? `Acquired ${formatDay(item.acquired_on)}` : `Added ${formatDay(item.added_at)}`);
  return facts;
}

function CopyRow({ item, number, preserved, params }: { item: CollectionEntry; number: CopyNumber | undefined; preserved: PreservedTitle | undefined; params: CollectionParams }) {
  const status = copyStatusLabel(item.status);
  // A preserved copy's excluded release, as its owner may read it (M7b-2b).
  const release = item.release ?? preserved ?? null;
  return (
    <Link href={copyHref(item.id, params)} className={cardClassName}>
      <CatalogCover className="w-12" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-pretty">{item.game?.title ?? preserved?.title ?? "Release no longer available"}</p>
        {release ? <p className="text-sm text-muted-foreground">{releaseLine(release)}</p> : null}
        {release?.local_title ? <p className="text-xs text-muted-foreground">{release.local_title}</p> : null}
        <p className="mt-1.5 text-xs text-muted-foreground">{copyFacts(item, number, params.sort).join(" · ")}</p>
        {status ? <p className="mt-1.5 inline-flex rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{status}</p> : null}
      </div>
    </Link>
  );
}

export function CollectionList({
  items,
  numbers,
  preserved = new Map(),
  params,
}: {
  items: CollectionEntry[];
  numbers: Map<string, CopyNumber>;
  preserved?: Map<string, PreservedTitle>;
  params: CollectionParams;
}) {
  return (
    <ol className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.id}>
          <CopyRow item={item} number={numbers.get(item.id)} preserved={preserved.get(item.id)} params={params} />
        </li>
      ))}
    </ol>
  );
}

export function CollectionListSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex gap-3 rounded-lg border p-3">
          <Skeleton className="aspect-3/4 w-12" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
