import { MailCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { SignUpForm } from "@/components/auth/sign-up-form";
import { AccountPageSkeleton } from "@/components/auth/require-account";
import { PageLayout } from "@/components/layout/page-layout";
import { getCurrentViewer } from "@/features/account/queries";
import { welcomeHref } from "@/features/auth/redirect";
import { selfRegistrationOpen } from "@/features/auth/registration";

export const metadata: Metadata = {
  title: "Create an account",
  robots: { index: false },
};

/**
 * M16: creating a collector account, where this server allows self-registration
 * (features/auth/registration.ts). Everywhere else this page doesn't exist, and the action
 * refuses on its own. After a request it says the same thing whatever the address: check your
 * email.
 */
async function SignUpContent({ searchParams }: { searchParams: PageProps<"/sign-up">["searchParams"] }) {
  // Read at request time, from this server's own environment.
  await connection();
  if (!selfRegistrationOpen()) notFound();
  const viewer = await getCurrentViewer();
  if (viewer) redirect(viewer.handle ? "/home" : welcomeHref("/home"));

  const status = (await searchParams).status;
  if (status === "sent") {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-lg border px-3 py-3">
          <MailCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary-text" />
          <div className="flex flex-col gap-1 text-sm" role="status">
            <p className="font-medium">Check your email</p>
            <p className="text-muted-foreground">
              If this address can be used for a new account, we&apos;ve sent it a link to confirm it. The link works once, for an hour, and can take a minute to arrive.
              Already have an account? Sign in instead.
            </p>
          </div>
        </div>
        <p className="text-sm">
          <Link href="/sign-in" className="text-primary-text underline underline-offset-4">
            Go to sign in
          </Link>
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <SignUpForm />
      <p className="text-sm">
        Already have an account?{" "}
        <Link href="/sign-in" className="text-primary-text underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  );
}

export default function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  return (
    <PageLayout>
      <div className="mx-auto w-full max-w-sm p-4 md:p-0 md:pt-6">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Create an account</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          A collector account, to keep your games, shelves and wishlist. You&apos;ll confirm your email, then choose your handle.
        </p>
        <Suspense fallback={<AccountPageSkeleton />}>
          <SignUpContent searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
