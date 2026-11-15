import Link from "next/link";

import { getCurrentViewer } from "@/features/account/queries";
import { canReview } from "@/features/review/queries";

/**
 * "Merge into another release", on a published release's panel, for catalog editors
 * only (merging a published release then needs an administrator). Reads the session,
 * so it renders inside its own Suspense boundary, apart from the cached public catalog.
 */
export async function MergeReleaseLink({ releaseId }: { releaseId: string }) {
  const viewer = await getCurrentViewer().catch(() => null);
  if (!viewer?.handle || !(await canReview())) return null;
  return (
    <p className="mt-1 text-sm">
      <Link href={`/admin/catalog/merge/${releaseId}`} className="text-primary-text underline underline-offset-4">
        Merge into another release
      </Link>
    </p>
  );
}
