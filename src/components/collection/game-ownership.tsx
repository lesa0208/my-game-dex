import { Library } from "lucide-react";
import Link from "next/link";

import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentViewer } from "@/features/account/queries";
import { ownershipEntryLine, ownershipHeadline, ownershipStatusLabel } from "@/features/collection/details";
import { collectionHref, DEFAULT_PARAMS } from "@/features/collection/list-params";
import { getMyGameOwnership } from "@/features/collection/queries";

/**
 * M12b: what the signed-in collector has of this game, on its page. "Owned: Yes" counts
 * every copy that isn't preserved, whatever its catalog standing; each line says which
 * standing it has, so a confirmed release, a copy awaiting approval and one that isn't
 * linked to a release are never mixed up. Preserved copies are listed but not counted.
 * Only ever the viewer's own copies, read with their session; nothing for a visitor.
 */
export async function GameOwnership({ gameId, title }: { gameId: string; title: string }) {
  const viewer = await getCurrentViewer().catch(() => null);
  if (!viewer?.handle) return null;
  const ownership = await getMyGameOwnership(gameId);
  if (!ownership || ownership.entries.length === 0) {
    return ownership ? <p className="mt-4 text-sm text-muted-foreground">Not in your collection yet.</p> : null;
  }
  return (
    <section aria-labelledby="game-ownership" className="mt-4 rounded-lg border bg-card p-3">
      <h2 id="game-ownership" className="flex items-center gap-2 text-sm font-semibold">
        <Library aria-hidden="true" className="size-4 text-muted-foreground" />
        {ownershipHeadline(ownership.copies)}
      </h2>
      <ul aria-label="Your copies of this game" className="mt-2 flex flex-col gap-1 text-sm">
        {ownership.entries.map((entry, index) => (
          <li key={index} className="flex flex-wrap items-baseline gap-x-2">
            <span>
              {ownershipEntryLine(entry)} <span className="text-muted-foreground">×{entry.count}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              {ownershipStatusLabel(entry.status)}
              {entry.release_id === null && !entry.catalog_pairing ? " · platform not in the catalog for this game" : ""}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm">
        <Link href={collectionHref({ ...DEFAULT_PARAMS, query: title.slice(0, 100) })} className="text-primary-text underline underline-offset-4">
          See them in your collection
        </Link>
      </p>
    </section>
  );
}

export function GameOwnershipSkeleton() {
  return <Skeleton aria-hidden="true" className="mt-4 h-5 w-40" />;
}
