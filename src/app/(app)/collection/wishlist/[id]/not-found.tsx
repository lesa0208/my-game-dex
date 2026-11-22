import { HeartOff } from "lucide-react";
import Link from "next/link";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

/** The same for a wish that was removed, never existed or belongs to someone else. */
export default function WishNotFound() {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <EmptyState
          icon={HeartOff}
          title="This wish isn't available"
          action={
            <Button asChild variant="secondary" size="lg">
              <Link href="/collection/wishlist">Go to your wishlist</Link>
            </Button>
          }
        >
          It isn&apos;t on your wishlist. It may have been removed, or the link may be wrong.
        </EmptyState>
      </div>
    </PageLayout>
  );
}
