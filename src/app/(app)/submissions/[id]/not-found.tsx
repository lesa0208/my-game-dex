import { FileX } from "lucide-react";
import Link from "next/link";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

/** The same for a submission that never existed or belongs to someone else. */
export default function SubmissionNotFound() {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <EmptyState
          icon={FileX}
          title="This submission isn't available"
          action={
            <Button asChild variant="secondary" size="lg">
              <Link href="/submissions">Go to your submissions</Link>
            </Button>
          }
        >
          It isn&apos;t one of your submissions, or the link may be wrong.
        </EmptyState>
      </div>
    </PageLayout>
  );
}
