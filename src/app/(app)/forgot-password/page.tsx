import { MailCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageMessage, param } from "@/components/admin/admin-frame";
import { AccountPageSkeleton } from "@/components/auth/require-account";
import { PageLayout } from "@/components/layout/page-layout";
import { PendingButton } from "@/components/auth/pending-button";
import { Input } from "@/components/ui/input";
import { requestPasswordReset } from "@/features/password/actions";
import { passwordError, RESET_REQUESTED } from "@/features/password/form";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

/**
 * Asks for a password reset email (M11a-2). Every address gets the same answer, so the
 * page can't be used to learn who has an account. Works without JavaScript.
 */
async function ForgotContent({ searchParams }: { searchParams: PageProps<"/forgot-password">["searchParams"] }) {
  const search = await searchParams;
  if (param(search.status) === "sent") {
    return (
      <div className="flex flex-col gap-5">
        <p role="status" className="flex gap-3 text-sm text-muted-foreground">
          <MailCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary-text" />
          <span>{RESET_REQUESTED}</span>
        </p>
        <p className="text-sm">
          <Link href="/sign-in" className="text-primary-text underline underline-offset-4">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }
  const error = passwordError(param(search.error));
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Enter the email address you sign in with. We&apos;ll send a link to choose a new password.</p>
      <PageMessage notice={null} error={error} />
      <form action={requestPasswordReset} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            maxLength={254}
            className="h-10"
            aria-invalid={error ? true : undefined}
          />
        </div>
        <PendingButton size="lg" className="h-10" pendingLabel="Sending…">
          Send the reset link
        </PendingButton>
      </form>
      <p className="text-xs text-muted-foreground">
        If your account uses an authenticator app, you&apos;ll need it to finish. Lost it? Contact the operator who runs My Game Dex; a reset can&apos;t remove it.
      </p>
      <p className="text-sm">
        <Link href="/sign-in" className="text-primary-text underline underline-offset-4">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

export default function ForgotPasswordPage({ searchParams }: PageProps<"/forgot-password">) {
  return (
    <PageLayout>
      <div className="mx-auto w-full max-w-sm p-4 md:p-0 md:pt-6">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Reset your password</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <ForgotContent searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
