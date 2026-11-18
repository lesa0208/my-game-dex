import { KeyRound, MailCheck, MailX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AccountPageSkeleton } from "@/components/auth/require-account";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { getCurrentViewer } from "@/features/account/queries";
import { acceptInvitation } from "@/features/invitations/onboarding";
import { verifyRecovery } from "@/features/password/actions";
import { TOKEN_HASH } from "@/features/password/form";

export const metadata: Metadata = {
  title: "Confirm",
  robots: { index: false, follow: false },
  // The link carries a single-use token: never send it to another site.
  referrer: "no-referrer",
};

type Search = Awaited<PageProps<"/auth/confirm">["searchParams"]>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * Where an invitation's (M11a-1) or a password reset's (M11a-2) email link lands. Opening
 * it spends nothing: it shows a button, and only that button's POST verifies the token, so
 * a mail scanner that fetches the link can't use it. Any problem with a link gets the same
 * message, whatever the cause, and the token never goes anywhere but that form.
 */
async function ConfirmContent({ search }: { search: Search }) {
  const tokenHash = one(search.token_hash);
  const type = one(search.type);
  const status = one(search.status);
  if (type === "recovery") return <RecoveryContent tokenHash={tokenHash} status={status} />;

  if (status === "unavailable") {
    return (
      <EmptyState icon={MailX} title="Invitations can't be accepted right now">
        Try the link again later. It stays valid for an hour after it was sent.
      </EmptyState>
    );
  }
  if (status === "invalid" || type !== "invite" || !TOKEN_HASH.test(tokenHash)) {
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
  const viewer = await getCurrentViewer();
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <MailCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary-text" />
        <p className="text-sm text-muted-foreground">
          You&apos;ve been invited to the My Game Dex private beta. Accept to set a password and choose your handle. The link works once, for an hour after it was sent.
        </p>
      </div>
      {viewer ? (
        <p className="rounded-lg border px-3 py-2.5 text-sm">
          You&apos;re signed in{viewer.handle ? ` as @${viewer.handle}` : ""}. Accepting signs you out of that account on this device first.
        </p>
      ) : null}
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

async function RecoveryContent({ tokenHash, status }: { tokenHash: string; status: string }) {
  if (status === "unavailable") {
    return (
      <EmptyState icon={MailX} title="Passwords can't be reset right now">
        Try the link again later. It stays valid for an hour after it was sent.
      </EmptyState>
    );
  }
  if (status === "invalid" || !TOKEN_HASH.test(tokenHash)) {
    return (
      <EmptyState
        icon={MailX}
        title="This link can't be used"
        action={
          <Button asChild variant="outline" size="lg" className="h-10 px-4">
            <Link href="/forgot-password">Ask for a new link</Link>
          </Button>
        }
      >
        It may have expired (links work for an hour), been used already, or been replaced by a newer one.
      </EmptyState>
    );
  }
  const viewer = await getCurrentViewer();
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <KeyRound aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary-text" />
        <p className="text-sm text-muted-foreground">
          Continue to choose a new password for the account this link was sent to. The link works once, for an hour after it was sent.
        </p>
      </div>
      {viewer ? (
        <p className="rounded-lg border px-3 py-2.5 text-sm">
          You&apos;re signed in{viewer.handle ? ` as @${viewer.handle}` : ""}. Continuing signs you out of that account on this device first.
        </p>
      ) : null}
      <form action={verifyRecovery}>
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value="recovery" />
        <Button type="submit" size="lg" className="h-10 px-4">
          Continue to reset your password
        </Button>
      </form>
    </div>
  );
}

async function Confirm({ searchParams }: { searchParams: PageProps<"/auth/confirm">["searchParams"] }) {
  const search = await searchParams;
  const recovery = one(search.type) === "recovery";
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold tracking-tight">{recovery ? "Reset your password" : "Accept your invitation"}</h1>
      <ConfirmContent search={search} />
    </>
  );
}

export default function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  return (
    <PageLayout>
      <div className="mx-auto w-full max-w-sm p-4 md:p-0 md:pt-6">
        <Suspense fallback={<AccountPageSkeleton />}>
          <Confirm searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
