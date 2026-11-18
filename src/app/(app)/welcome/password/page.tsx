import { UserRoundX } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { PasswordForm } from "@/components/auth/password-form";
import { AccountPageSkeleton } from "@/components/auth/require-account";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { requireViewer } from "@/features/account/queries";
import { getMyOnboarding } from "@/features/invitations/queries";

export const metadata: Metadata = {
  title: "Set your password",
  robots: { index: false },
};

/** The invitee's first step after accepting (M11a-1); anyone else is sent on. */
async function PasswordContent() {
  const viewer = await requireViewer("/welcome/password");
  const onboarding = await getMyOnboarding();
  if (onboarding?.revoked) {
    return (
      <EmptyState icon={UserRoundX} title="This invitation was revoked" action={<SignOutButton />}>
        The account can&apos;t be set up. If you think this is a mistake, contact the person who invited you.
      </EmptyState>
    );
  }
  if (!onboarding?.invited || onboarding.password_set) redirect(viewer.handle ? "/home" : "/welcome");
  return (
    <>
      <p className="mb-6 text-sm text-muted-foreground">You&apos;ll use it with your email address to sign in. Next, you&apos;ll choose your handle.</p>
      <PasswordForm />
    </>
  );
}

export default function PasswordPage() {
  return (
    <PageLayout>
      <div className="mx-auto w-full max-w-sm p-4 md:p-0 md:pt-6">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Set your password</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <PasswordContent />
        </Suspense>
      </div>
    </PageLayout>
  );
}
