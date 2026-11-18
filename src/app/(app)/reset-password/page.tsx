import { KeyRound, MailX, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageMessage, param } from "@/components/admin/admin-frame";
import { AccountPageSkeleton } from "@/components/auth/require-account";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { getCurrentViewer } from "@/features/account/queries";
import { createSupabaseServerClient } from "@/features/auth/server";
import { passwordError } from "@/features/password/form";
import { currentRecovery } from "@/features/password/server";

export const metadata: Metadata = {
  title: "Choose a new password",
  robots: { index: false, follow: false },
};

/**
 * The second half of a password reset (M11a-2), after the link's POST on /auth/confirm
 * signed this browser in with a recovery session. Only that session, within an hour of the
 * link being opened, may choose a new password here. An account with an authenticator
 * verifies it first, on the usual verification page, and comes back here.
 */
async function ResetContent({ searchParams }: { searchParams: PageProps<"/reset-password">["searchParams"] }) {
  const search = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: auth } = supabase ? await supabase.auth.getClaims() : { data: null };
  const state = await currentRecovery(auth?.claims);
  if (!supabase || state !== "ok") {
    return (
      <EmptyState
        icon={MailX}
        title={state === "expired" ? "This reset has expired" : "Open the link from your reset email"}
        action={
          <Button asChild variant="outline" size="lg" className="h-10 px-4">
            <Link href="/forgot-password">Ask for a new link</Link>
          </Button>
        }
      >
        {state === "expired"
          ? "A new password has to be chosen within an hour of opening the link. Ask for a new one."
          : "Choosing a new password here only works in the browser where you opened the reset link, within an hour."}
      </EmptyState>
    );
  }

  const viewer = await getCurrentViewer();
  const error = passwordError(param(search.error));
  const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!level || (level.nextLevel === "aal2" && level.currentLevel !== "aal2")) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary-text" />
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              {viewer?.handle ? `@${viewer.handle} uses` : "This account uses"} an authenticator app. Enter a code from it before choosing a new password: a reset link alone isn&apos;t enough.
            </p>
            <p>Your authenticator stays as it is.</p>
          </div>
        </div>
        <div>
          <Button asChild size="lg" className="h-10 px-4">
            <Link href={`/settings/security/verify?next=${encodeURIComponent("/reset-password")}`}>Verify with your authenticator</Link>
          </Button>
        </div>
        <section aria-labelledby="lost-heading" className="rounded-lg border p-4">
          <h2 id="lost-heading" className="text-sm font-medium">
            Lost your authenticator?
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The password can&apos;t be reset without it, and nothing here can remove it. Contact the operator who runs My Game Dex: they&apos;ll check it&apos;s you through another channel and help you recover the account. It takes a while, on purpose.
          </p>
          <div className="mt-3">
            <SignOutButton />
          </div>
        </section>
      </div>
    );
  }

  return (
    <>
      <p className="mb-6 flex items-start gap-3 text-sm text-muted-foreground">
        <KeyRound aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary-text" />
        <span>
          Choose a new password{viewer?.handle ? ` for @${viewer.handle}` : ""}. Your old password stops working, and other devices are signed out.
        </span>
      </p>
      <div className="mb-4">
        <PageMessage notice={null} error={error} errorId="page-error" />
      </div>
      <ResetPasswordForm invalid={Boolean(error)} />
    </>
  );
}

export default function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  return (
    <PageLayout>
      <div className="mx-auto w-full max-w-sm p-4 md:p-0 md:pt-6">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Choose a new password</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <ResetContent searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
