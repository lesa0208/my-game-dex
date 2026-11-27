import { Library } from "lucide-react";
import { cache } from "react";

import { getCurrentViewer } from "@/features/account/queries";
import { getMyGameOwnership } from "@/features/collection/queries";

// Physical Releases 2.0 (Phase 4A): the signed-in collector's relation to each release, read
// only. Streamed on its own beside the public, cached cards; empty for a visitor. Nothing here
// changes a copy: linking a copy to a release keeps to the copy's own page (its Move section)
// until the linking workflow is reviewed.

/** One read of the collector's ownership per request, however many cards ask. */
const ownershipOf = cache(async (gameId: string) => {
  const viewer = await getCurrentViewer().catch(() => null);
  if (!viewer?.handle) return null;
  return getMyGameOwnership(gameId);
});

/** "You own 2 of this release": the collector's copies linked to exactly this release, never a claim. */
export async function ReleaseOwned({ gameId, releaseId }: { gameId: string; releaseId: string }) {
  const ownership = await ownershipOf(gameId);
  const count = ownership?.entries.filter((e) => e.release_id === releaseId).reduce((sum, e) => sum + e.count, 0) ?? 0;
  if (!count) return null;
  return (
    // A plain link: the tabs follow the address hash (game-tabs.tsx), as Overview links do.
    <a
      href="#my-copies"
      className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-xs font-medium text-emerald-200 outline-none hover:bg-emerald-400/15 focus-visible:ring-3 focus-visible:ring-ring"
      data-release-owned={count}
    >
      <Library aria-hidden="true" className="size-3.5" />
      You own {count} of this release
      <span className="sr-only">: {count === 1 ? "a copy" : "copies"} linked to this exact release. See My Copies</span>
    </a>
  );
}

/**
 * Under a platform's releases: the collector's copies on it whose exact release isn't
 * identified yet, which one of these releases may be. Said, never assumed.
 */
export async function PlatformUnidentified({ gameId, platform, platformName }: { gameId: string; platform: string; platformName: string }) {
  const ownership = await ownershipOf(gameId);
  const count = ownership?.entries.filter((e) => e.release_id === null && e.status === "unidentified" && e.platform.slug === platform).reduce((sum, e) => sum + e.count, 0) ?? 0;
  if (!count) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed border-white/12 bg-white/[0.02] px-3 py-2 text-sm" data-platform-unidentified={count}>
      <span>
        {count === 1 ? "1 of your copies" : `${count} of your copies`} on {platformName} {count === 1 ? "isn't" : "aren't"} linked to a release yet (exact release not identified), so no card below counts {count === 1 ? "it" : "them"}.
      </span>
      <a href="#my-copies" className="inline-flex min-h-6 items-center font-medium text-primary-text underline-offset-4 hover:underline">
        Review in My Copies
      </a>
    </p>
  );
}
