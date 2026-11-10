import { Library } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { AccountPageSkeleton, RequireAccount } from "@/components/auth/require-account";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata: Metadata = {
  title: "My Collection",
};

export default function CollectionPage() {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">My Collection</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <RequireAccount path="/collection">
            <EmptyState icon={Library} title="Your collection isn't available yet">
              Physical copy tracking arrives in the next update.
            </EmptyState>
          </RequireAccount>
        </Suspense>
      </div>
    </PageLayout>
  );
}
