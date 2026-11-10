import { SearchX } from "lucide-react";
import Link from "next/link";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

export default function GameNotFound() {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <EmptyState
          icon={SearchX}
          title="Game not found"
          action={
            <Button asChild variant="secondary" size="lg">
              <Link href="/explore">Search the catalog</Link>
            </Button>
          }
        >
          This game isn&apos;t in the published catalog. It may have moved, or not be published yet.
        </EmptyState>
      </div>
    </PageLayout>
  );
}
