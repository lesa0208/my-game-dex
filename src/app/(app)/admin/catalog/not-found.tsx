import { FileX } from "lucide-react";
import Link from "next/link";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

/** The same for someone who can't review and for a submission that doesn't exist. */
export default function ReviewNotFound() {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <EmptyState
          icon={FileX}
          title="This page isn't available"
          action={
            <Button asChild variant="secondary" size="lg">
              <Link href="/">Go home</Link>
            </Button>
          }
        >
          The link may be wrong, or the page isn&apos;t available to your account.
        </EmptyState>
      </div>
    </PageLayout>
  );
}
