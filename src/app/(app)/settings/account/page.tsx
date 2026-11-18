import { Download, LogOut } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageMessage, param } from "@/components/admin/admin-frame";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { AccountPageSkeleton } from "@/components/auth/require-account";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { PageLayout } from "@/components/layout/page-layout";
import { Button } from "@/components/ui/button";
import { requireViewerWithHandle } from "@/features/account/queries";
import { createSupabaseServerClient } from "@/features/auth/server";
import { signOutEverywhere } from "@/features/password/actions";
import { exportError } from "@/features/export/format";
import { passwordError, passwordNotice } from "@/features/password/form";

export const metadata: Metadata = {
  title: "Account and password",
};

const PATH = "/settings/account";

/** Settings → Account and password (M11a-2; renamed in M11a-3): change the password, sign out here or everywhere. */
async function AccountView({ searchParams }: { searchParams: PageProps<"/settings/account">["searchParams"] }) {
  const search = await searchParams;
  const viewer = await requireViewerWithHandle(PATH);
  const supabase = await createSupabaseServerClient();
  const { data: level } = supabase ? await supabase.auth.mfa.getAuthenticatorAssuranceLevel() : { data: null };
  const mustVerify = !level || (level.nextLevel === "aal2" && level.currentLevel !== "aal2");
  const error = passwordError(param(search.error));
  const dataError = exportError(param(search.error));

  return (
    <div className="flex flex-col gap-6">
      <PageMessage notice={passwordNotice(param(search.notice))} error={error ?? dataError} errorId="page-error" />

      <section aria-labelledby="password-heading" className="rounded-lg border p-4">
        <h2 id="password-heading" className="font-medium">
          Password
        </h2>
        <p className="mt-1 mb-4 text-sm text-muted-foreground">
          Signed in as @{viewer.handle}. Changing the password signs out your other devices.
        </p>
        {mustVerify ? (
          <p className="text-sm">
            Your account uses an authenticator, so verify a code before changing the password.{" "}
            <Link href={`/settings/security/verify?next=${encodeURIComponent(PATH)}`} className="text-primary-text underline underline-offset-4">
              Verify now
            </Link>
          </p>
        ) : (
          <ChangePasswordForm invalid={Boolean(error) && !dataError} reauthenticate={param(search.error) === "reauthenticate"} />
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          Forgot your current password? Sign out, then use &ldquo;Forgot your password?&rdquo; on the sign-in page.
        </p>
      </section>

      <section aria-labelledby="data-heading" className="rounded-lg border p-4">
        <h2 id="data-heading" className="font-medium">
          Your data
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Download a copy of what your account holds, as a JSON file: your profile and preferences, every copy in your collection with its
          release, condition, pieces and notes, what you paid and where you keep it, and your catalog submissions. It&apos;s for you: keep it
          somewhere private. Follows, notifications and security records aren&apos;t in it yet, and it isn&apos;t a complete answer to a legal
          request for your data.
        </p>
        {mustVerify ? (
          <p className="mt-3 text-sm">
            Your account uses an authenticator, so verify a code before downloading your data.{" "}
            <Link href={`/settings/security/verify?next=${encodeURIComponent(PATH)}`} className="text-primary-text underline underline-offset-4">
              Verify now
            </Link>
          </p>
        ) : (
          <form action="/settings/account/export" method="post" className="mt-3">
            <Button type="submit" variant="outline" size="lg" className="h-10 px-4">
              <Download aria-hidden="true" />
              Download my data
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">Up to three downloads an hour. A large collection can take a minute.</p>
          </form>
        )}
      </section>

      <section aria-labelledby="sessions-heading" className="rounded-lg border p-4">
        <h2 id="sessions-heading" className="font-medium">
          Sessions
        </h2>
        <div className="mt-3 flex flex-col gap-4">
          <div>
            <p className="mb-2 text-sm text-muted-foreground">Sign out on this device only. Your other devices stay signed in.</p>
            <SignOutButton />
          </div>
          <div>
            <p className="mb-2 text-sm text-muted-foreground">
              Sign out on every device, this one included, if you think someone else is signed in to your account. No device can renew its sign-in afterwards; one that&apos;s in use right now can keep working for up to an hour. Change your password too if it may be known.
            </p>
            <form action={signOutEverywhere}>
              <Button type="submit" variant="destructive" size="lg">
                <LogOut aria-hidden="true" />
                Sign out on all devices
              </Button>
            </form>
          </div>
        </div>
      </section>

      <p className="text-sm">
        <Link href="/settings" className="text-primary-text underline underline-offset-4">
          Back to settings
        </Link>
      </p>
    </div>
  );
}

export default function AccountSecurityPage({ searchParams }: PageProps<"/settings/account">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Account and password</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <AccountView searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
