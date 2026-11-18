import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AccountPageSkeleton } from "@/components/auth/require-account";
import { PageLayout } from "@/components/layout/page-layout";
import { requireViewerWithHandle } from "@/features/account/queries";

export const metadata: Metadata = {
  title: "My Profile",
};

/**
 * M11a-3: your own profile is edited in Settings, so this sends you there (after signing
 * in, and choosing a handle, if needed). Public profile pages, at /u/[handle], are M11c.
 */
async function ToProfileSettings(): Promise<never> {
  await requireViewerWithHandle("/profile");
  redirect("/settings/profile");
}

export default function ProfilePage() {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="sr-only">My Profile</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <ToProfileSettings />
        </Suspense>
      </div>
    </PageLayout>
  );
}
