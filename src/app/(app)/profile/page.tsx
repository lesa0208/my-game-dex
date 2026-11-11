import { UserRound } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { AccountPageSkeleton, RequireAccount } from "@/components/auth/require-account";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata: Metadata = {
  title: "My Profile",
};

export default function ProfilePage() {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">My Profile</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <RequireAccount path="/profile">
            <EmptyState icon={UserRound} title="Profiles aren't available yet">
              Your avatar, public shelves, favorite games and collection stats arrive in a later update.
            </EmptyState>
          </RequireAccount>
        </Suspense>
      </div>
    </PageLayout>
  );
}
