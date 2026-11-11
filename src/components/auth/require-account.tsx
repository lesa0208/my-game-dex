import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";

/**
 * Renders a protected page's content only for a signed-in account with a handle.
 * Signed-out visitors go to sign in, and accounts without a handle go to claim one,
 * each coming back to `path`. Wrap it in Suspense, because it reads the session.
 */
export async function RequireAccount({ path, children }: { path: string; children: ReactNode }) {
  await requireViewerWithHandle(path);
  return children;
}

export function AccountPageSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
