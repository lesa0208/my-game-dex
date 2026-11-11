import { PackageX } from "lucide-react";
import Link from "next/link";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

/** The same for a copy that was removed, never existed or belongs to someone else. */
export default function CopyNotFound() {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <EmptyState
          icon={PackageX}
          title="This copy isn't available"
          action={
            <Button asChild variant="secondary" size="lg">
              <Link href="/collection">Go to your collection</Link>
            </Button>
          }
        >
          It isn&apos;t in your collection. It may have been removed, or the link may be wrong.
        </EmptyState>
      </div>
    </PageLayout>
  );
}
