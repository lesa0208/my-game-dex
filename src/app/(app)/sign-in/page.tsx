import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AccountPageSkeleton } from "@/components/auth/require-account";
import { SignInForm } from "@/components/auth/sign-in-form";
import { PageLayout } from "@/components/layout/page-layout";
import { getCurrentViewer } from "@/features/account/queries";
import { safeNextPath, welcomeHref } from "@/features/auth/redirect";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false },
};

async function SignInContent({ searchParams }: { searchParams: PageProps<"/sign-in">["searchParams"] }) {
  const raw = (await searchParams).next;
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);

  const viewer = await getCurrentViewer();
  if (viewer) redirect(viewer.handle ? next : welcomeHref(next));

  return <SignInForm next={next} />;
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
