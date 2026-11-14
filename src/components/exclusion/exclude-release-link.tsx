import Link from "next/link";

import { getCurrentViewer } from "@/features/account/queries";
import { canReview } from "@/features/review/queries";

/**
 * "Exclude from the catalog", on a published release's panel, for catalog editors
 * only. Reads the session, so it renders inside its own Suspense boundary, apart from
 * the cached public catalog. Everyone else gets nothing.
 */
export async function ExcludeReleaseLink({ releaseId }: { releaseId: string }) {
  const viewer = await getCurrentViewer().catch(() => null);
  if (!viewer?.handle || !(await canReview())) return null;
  return (
    <p className="mt-3 text-sm">
      <Link href={`/review/exclude/${releaseId}`} className="text-destructive underline underline-offset-4">
        Exclude from the catalog
      </Link>
    </p>
  );
}
