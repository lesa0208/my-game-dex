import type { Metadata } from "next";
import { Suspense } from "react";

import { HandleForm } from "@/components/auth/handle-form";
import { AccountPageSkeleton } from "@/components/auth/require-account";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { PageLayout } from "@/components/layout/page-layout";
import { requireViewerWithHandle } from "@/features/account/queries";
import { nextHandleChange } from "@/features/auth/account";

export const metadata: Metadata = {
  title: "Settings",
};

async function AccountSettings() {
  const viewer = await requireViewerWithHandle("/settings");
  const waitUntil = nextHandleChange(viewer);

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="account-heading" className="rounded-lg border p-4">
        <h2 id="account-heading" className="font-medium">
          Account
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{viewer.displayName}</span> (@{viewer.handle})
        </p>
        {viewer.accountStatus !== "active" ? (
          <p className="mt-3 text-sm text-destructive">
            This account isn&apos;t active. You can still view your settings and sign out.
          </p>
        ) : null}
        <div className="mt-4">
          <SignOutButton />
        </div>
      </section>

      <section aria-labelledby="handle-heading" className="rounded-lg border p-4">
        <h2 id="handle-heading" className="mb-3 font-medium">
          Handle
        </h2>
        {viewer.accountStatus !== "active" ? (
          <p className="text-sm text-muted-foreground">Your handle can&apos;t be changed while the account isn&apos;t active.</p>
        ) : waitUntil ? (
          <p className="text-sm text-muted-foreground">
            Your handle is @{viewer.handle}. You can change it again on{" "}
            {waitUntil.toLocaleDateString("en", { dateStyle: "long", timeZone: "UTC" })}.
          </p>
        ) : (
          <HandleForm next="/settings" current={viewer.handle} submitLabel="Change handle" />
        )}
      </section>

      <p className="text-sm text-muted-foreground">Privacy and appearance settings arrive in a later update.</p>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Settings</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <AccountSettings />
        </Suspense>
      </div>
    </PageLayout>
  );
}
