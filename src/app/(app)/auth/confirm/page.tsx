import { MailCheck, MailX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AccountPageSkeleton } from "@/components/auth/require-account";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { acceptInvitation } from "@/features/invitations/onboarding";

export const metadata: Metadata = {
  title: "Accept your invitation",
  robots: { index: false, follow: false },
  // The link carries a single-use token: never send it to another site.
  referrer: "no-referrer",
};

const TOKEN = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * Where an invitation email's link lands (M11a-1). Opening it uses nothing: it shows a
 * button, and only that button's POST verifies the token, so a mail scanner that fetches
 * the link can't spend it. Any problem gets the same message, whatever the cause.
 */
async function ConfirmContent({ searchParams }: { searchParams: PageProps<"/auth/confirm">["searchParams"] }) {
  const search = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const tokenHash = one(search.token_hash);
  const type = one(search.type);
  const status = one(search.status);

  if (status === "unavailable") {
    return (
      <EmptyState icon={MailX} title="Invitations can't be accepted right now">
        Try the link again later. It stays valid for an hour after it was sent.
      </EmptyState>
    );
  }
  if (status === "invalid" || type !== "invite" || !TOKEN.test(tokenHash)) {
    return (
      <EmptyState
        icon={MailX}
        title="This link can't be used"
        action={
          <Button asChild variant="outline" size="lg" className="h-10 px-4">
            <Link href="/sign-in">Go to sign in</Link>
          </Button>
        }
      >
        It may have expired (links work for an hour), been used already, or been replaced by a newer invitation. Ask the person who invited you to send a new one.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <MailCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary-text" />
        <p className="text-sm text-muted-foreground">
          You&apos;ve been invited to the My Game Dex private beta. Accept to set a password and choose your handle. The link works once, for an hour after it was sent.
        </p>
      </div>
      <form action={acceptInvitation}>
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value="invite" />
        <Button type="submit" size="lg" className="h-10 px-4">
          Accept the invitation
        </Button>
      </form>
    </div>
  );
}

export default function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  return (
    <PageLayout>
      <div className="mx-auto w-full max-w-sm p-4 md:p-0 md:pt-6">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Accept your invitation</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <ConfirmContent searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
