import { UserRoundX } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HandleForm } from "@/components/auth/handle-form";
import { AccountPageSkeleton } from "@/components/auth/require-account";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { requireViewer } from "@/features/account/queries";
import { safeNextPath } from "@/features/auth/redirect";

export const metadata: Metadata = {
  title: "Choose your handle",
  robots: { index: false },
};

async function WelcomeContent({ searchParams }: { searchParams: PageProps<"/welcome">["searchParams"] }) {
  const raw = (await searchParams).next;
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);
  const viewer = await requireViewer(`/welcome${next === "/home" ? "" : `?next=${encodeURIComponent(next)}`}`);
  if (viewer.handle) redirect(next);

  if (viewer.accountStatus !== "active") {
    return (
      <EmptyState icon={UserRoundX} title="Your account can't claim a handle" action={<SignOutButton />}>
        This account isn&apos;t active, so it can&apos;t choose a handle right now.
      </EmptyState>
    );
  }

  return (
    <>
      <p className="mb-6 text-sm text-muted-foreground">
        Your handle is your public name on My Game Dex. You can correct it once in the first 24 hours, then change it
        every 30 days.
      </p>
      <HandleForm next={next} current={null} submitLabel="Claim handle" />
    </>
  );
}

export default function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  return (
    <PageLayout>
      <div className="mx-auto w-full max-w-sm p-4 md:p-0 md:pt-6">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Choose your handle</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <WelcomeContent searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
