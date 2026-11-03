"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <EmptyState
          icon={TriangleAlert}
          title="Something went wrong"
          action={
            <Button variant="secondary" size="lg" onClick={retry}>
              Try again
            </Button>
          }
        >
          This page couldn&apos;t be loaded.
        </EmptyState>
      </div>
    </PageLayout>
  );
}
