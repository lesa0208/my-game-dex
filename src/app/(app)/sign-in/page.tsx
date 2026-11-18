import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { PageMessage } from "@/components/admin/admin-frame";
import { AccountPageSkeleton } from "@/components/auth/require-account";
import { SignInForm } from "@/components/auth/sign-in-form";
import { PageLayout } from "@/components/layout/page-layout";
import { getCurrentViewer } from "@/features/account/queries";
import { safeNextPath, welcomeHref } from "@/features/auth/redirect";
import { passwordNotice } from "@/features/password/form";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false },
};

async function SignInContent({ searchParams }: { searchParams: PageProps<"/sign-in">["searchParams"] }) {
  const search = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNextPath(first(search.next));

  const viewer = await getCurrentViewer();
  if (viewer) redirect(viewer.handle ? next : welcomeHref(next));

  const notice = passwordNotice(first(search.notice));
  return (
    <div className="flex flex-col gap-6">
      {notice ? <PageMessage notice={notice} error={null} /> : null}
      <SignInForm next={next} />
      <p className="text-sm">
        <Link href="/forgot-password" className="text-primary-text underline underline-offset-4">
          Forgot your password?
        </Link>
      </p>
    </div>
  );
}

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <PageLayout>
      <div className="mx-auto w-full max-w-sm p-4 md:p-0 md:pt-6">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Accounts are invitation only while My Game Dex is in development.
        </p>
        <Suspense fallback={<AccountPageSkeleton />}>
          <SignInContent searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
